/**
 * Reads a claim bundle PDF into "which document is on which page".
 *
 * Text pages are classified from their own text layer (no OCR). Pages without
 * text are photos: their largest image is OCR'd (Tesseract, offline data) only
 * to read the title; an untitled page with ECG-paper grid is flagged as a
 * probable ECG. Results are cached on disk per caller key (No. RM + admission
 * + discharge dates): an unchanged PDF is answered from the cache, and in a
 * changed one only photos never seen before are OCR'd (per-image hash).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { classifyOcrText, classifyTextPage, DOC_LABELS, type DocType } from './classify.js';
import { downscale, ECG_GRID_THRESHOLD, encodePng, gridScore, rotate, toGray, type Gray } from './image.js';

export interface BerkasProgress {
  phase: 'teks' | 'ocr' | 'selesai';
  done: number;
  total: number;
  label: string;
}

export interface BerkasPage {
  page: number;
  source: 'teks' | 'foto' | 'kosong';
  docTypes: DocType[];
  /** Operator-facing names of `docTypes` (callers need not know the ids' labels). */
  labels: string[];
  /** Photo pages: Tesseract's mean confidence (0–100) for the chosen rotation. */
  ocrConfidence?: number;
  rotation?: number;
  /** Photo page with no readable title but an ECG-paper grid. */
  ecgLike?: boolean;
}

export interface BerkasReport {
  pageCount: number;
  pages: BerkasPage[];
  photoPages: number;
  /** Photo pages actually OCR'd this time (the rest came from the cache). */
  ocrRun: number;
  fromCache: boolean;
}

export interface BerkasReadOptions {
  /** Cache identity, e.g. `${noRm}_${tglMasuk}_${tglPulang}`. */
  cacheKey: string;
  onProgress?: (progress: BerkasProgress) => void;
  signal?: AbortSignal;
}

export interface BerkasReader {
  read(pdf: Uint8Array, options: BerkasReadOptions): Promise<BerkasReport>;
  close(): Promise<void>;
}

export interface OcrResult {
  text: string;
  confidence: number;
  /** Words recognised with confidence > 60. */
  confidentWords: number;
}

export interface OcrEngine {
  recognize(png: Buffer): Promise<OcrResult>;
  close(): Promise<void>;
}

/** Below this, a page's text layer is treated as absent (a photo with a caption line). */
const MIN_TEXT_WORDS = 15;
/** Smaller images are logos/signatures, not a photographed document. */
const MIN_PHOTO_PIXELS = 300_000;
/** A rotation is accepted once it yields this many confident words. */
const GOOD_ENOUGH_WORDS = 8;
const CACHE_VERSION = 2;

interface CacheFile {
  v: number;
  pdfSha: string;
  report: Omit<BerkasReport, 'fromCache' | 'ocrRun'>;
  images: Record<string, Pick<BerkasPage, 'docTypes' | 'ocrConfidence' | 'rotation' | 'ecgLike'>>;
}

const withLabels = (page: Omit<BerkasPage, 'labels'>): BerkasPage => ({ ...page, labels: page.docTypes.map((t) => DOC_LABELS[t]) });
const sha = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex');
export const cacheFileName = (key: string) => `${key.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120) || 'berkas'}.json`;

/** Tesseract (WASM) with the bundled ind+eng data copied into one langPath; started on first use. */
export function createTesseractEngine(dataDir: string): OcrEngine {
  let worker: Promise<{ recognize: (...args: any[]) => Promise<any>; terminate: () => Promise<unknown> }> | undefined;
  const start = async () => {
    mkdirSync(dataDir, { recursive: true });
    const require = createRequire(import.meta.url);
    for (const lang of ['ind', 'eng']) {
      const target = join(dataDir, `${lang}.traineddata.gz`);
      if (!existsSync(target)) {
        const pack = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
        copyFileSync(join(pack, '4.0.0_best_int', `${lang}.traineddata.gz`), target);
      }
    }
    const { createWorker } = await import('tesseract.js');
    return createWorker(['ind', 'eng'], 1, { langPath: dataDir, cacheMethod: 'none', gzip: true }) as never;
  };
  return {
    async recognize(png) {
      worker ??= start();
      const { data } = await (await worker).recognize(png, {}, { blocks: true });
      const words = (data.blocks ?? []).flatMap((b: any) => b.paragraphs.flatMap((p: any) => p.lines.flatMap((l: any) => l.words)));
      return { text: data.text ?? '', confidence: Math.round(data.confidence ?? 0), confidentWords: words.filter((w: any) => w.confidence > 60).length };
    },
    async close() {
      if (worker) await (await worker).terminate();
      worker = undefined;
    },
  };
}

export function createBerkasReader(options: { cacheDir: string; ocr?: OcrEngine }): BerkasReader {
  const ocr = options.ocr ?? createTesseractEngine(join(options.cacheDir, 'tessdata'));
  mkdirSync(options.cacheDir, { recursive: true });

  const loadCache = (key: string): CacheFile | undefined => {
    try {
      const cached = JSON.parse(readFileSync(join(options.cacheDir, cacheFileName(key)), 'utf8')) as CacheFile;
      return cached.v === CACHE_VERSION ? cached : undefined;
    } catch {
      return undefined;
    }
  };

  const ocrPhoto = async (img: Gray): Promise<Pick<BerkasPage, 'docTypes' | 'ocrConfidence' | 'rotation' | 'ecgLike'>> => {
    let best: { rotation: number; result: OcrResult } | undefined;
    for (const rotation of [0, 90, 270] as const) {
      const result = await ocr.recognize(encodePng(rotate(img, rotation)));
      if (!best || result.confidentWords > best.result.confidentWords) best = { rotation, result };
      if (result.confidentWords >= GOOD_ENOUGH_WORDS) break;
    }
    const docTypes = classifyOcrText(best!.result.text);
    if (docTypes.length === 0 && gridScore(img) >= ECG_GRID_THRESHOLD) {
      return { docTypes: ['ekg'], ecgLike: true, ocrConfidence: best!.result.confidence, rotation: best!.rotation };
    }
    return { docTypes, ocrConfidence: best!.result.confidence, rotation: best!.rotation };
  };

  return {
    async read(pdf, { cacheKey, onProgress, signal }) {
      const pdfSha = sha(pdf);
      const cached = loadCache(cacheKey);
      if (cached?.pdfSha === pdfSha) {
        onProgress?.({ phase: 'selesai', done: cached.report.pageCount, total: cached.report.pageCount, label: 'dari cache' });
        return { ...cached.report, ocrRun: 0, fromCache: true };
      }
      const { getDocumentProxy, extractText, extractImages } = await import('unpdf');
      // unpdf may take ownership of the buffer; hand it a copy so the hash above stays valid.
      const doc = await getDocumentProxy(new Uint8Array(pdf));
      const { text } = await extractText(doc, { mergePages: false });
      onProgress?.({ phase: 'teks', done: text.length, total: text.length, label: `${text.length} halaman dibaca` });

      const pages: BerkasPage[] = text.map((pageText, i) => {
        const words = pageText.split(/\s+/).filter(Boolean).length;
        return words >= MIN_TEXT_WORDS
          ? withLabels({ page: i + 1, source: 'teks', docTypes: classifyTextPage(pageText) })
          : { page: i + 1, source: 'kosong', docTypes: [], labels: [] };
      });
      const photoCandidates = pages.filter((p) => p.source === 'kosong');
      const images: CacheFile['images'] = {};
      let ocrRun = 0;
      let photoPages = 0;
      for (const [index, page] of photoCandidates.entries()) {
        if (signal?.aborted) throw new Error('aborted');
        onProgress?.({ phase: 'ocr', done: index, total: photoCandidates.length, label: `OCR foto ${index + 1}/${photoCandidates.length} (hal. ${page.page})` });
        const found = await extractImages(doc, page.page);
        const largest = found.sort((a, b) => b.width * b.height - a.width * a.height)[0];
        if (!largest || largest.width * largest.height < MIN_PHOTO_PIXELS) continue;
        photoPages += 1;
        const img = downscale(toGray(largest.data, largest.width, largest.height, largest.channels), 2400);
        const hash = sha(img.data);
        const result = cached?.images[hash] ?? (ocrRun += 1, await ocrPhoto(img));
        images[hash] = result;
        Object.assign(page, { source: 'foto' as const }, result, { labels: result.docTypes.map((t) => DOC_LABELS[t]) });
      }
      const report = { pageCount: pages.length, pages, photoPages };
      onProgress?.({ phase: 'selesai', done: pages.length, total: pages.length, label: `${pages.length} halaman · ${photoPages} foto` });
      const file: CacheFile = { v: CACHE_VERSION, pdfSha, report, images };
      try { writeFileSync(join(options.cacheDir, cacheFileName(cacheKey)), JSON.stringify(file)); } catch { /* cache is an optimisation */ }
      return { ...report, ocrRun, fromCache: false };
    },
    close: () => ocr.close(),
  };
}
