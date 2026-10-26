import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyOcrText, classifyTextPage, titleLines } from './classify.js';
import { ECG_GRID_THRESHOLD, encodePng, gridScore, rotate, toGray, type Gray } from './image.js';
import { cacheFileName, createBerkasReader, type OcrEngine } from './reader.js';

describe('classify', () => {
  const header = 'RUMAH SAKIT PKU MUHAMMADIYAH GOMBONG\nJl. Yos Sudarso No. 461 Gombong 54412\n';
  it('names a page by a title line, not by rows deeper in the body', () => {
    expect(classifyTextPage(`${header}SURAT ELEGIBILITAS PESERTA\nNo. SEP : X\n${'isi\n'.repeat(20)}`)).toEqual(['sep']);
    expect(classifyTextPage('RM 12.1 RINGKASAN PULANG\nRevisi 03 / 09 / 2022')).toEqual(['resume']);
    expect(classifyTextPage(`${header}SURAT KETERANGAN KAMAR PENUH\nDengan ini diterangkan`)).toEqual(['kamar_penuh']);
    expect(classifyTextPage(`${header}SURAT KETERANGAN DIRAWAT\nNO 123/SKD/X/2026`)).toEqual(['ket_dirawat']);
    // Rajal bundle sheets.
    expect(classifyTextPage('RS PKU MUHAMMADIYAH GOMBONG\nLEMBAR VERIFIKASI RAWAT JALAN\nNo RM : X')).toEqual(['verifikasi_rajal']);
    expect(classifyTextPage('KEMENTERIAN KESEHATAN REPUBLIK INDONESIA JKN\nKELAS PERAWATAN REGULAR BERAT LAHIR\nTarif 123')).toEqual(['eklaim']);
  });

  it('ignores continuation pages whose rows only mention an exam', () => {
    // Live shapes: a resume continuation and a charge list continuation.
    expect(classifyTextPage('DIAGNOSIS SEKUNDER\nTINDAKAN PROSEDUR USG\nKEADAAN PASIEN PADA SAAT PULANG')).toEqual([]);
    expect(classifyTextPage('SPUIT 5 CC 3 3,200\nEKG ELEKTRODA DEWASA OPR 42 3 7,400\nNACL 500ML INFUS 3 23,000')).toEqual([]);
    // Bill continuation: category lines look like titles, SUB TOTAL says otherwise.
    expect(classifyTextPage('RADIOLOGI\n1 2026-10-02 THORAX AP 1 150,000\nRADIOGRAFER\nSub Total 150,000 0 150,000')).toEqual([]);
    expect(classifyTextPage('PERINCIAN BIAYA RAWAT INAP\nKAMAR PERAWATAN\nSub Total 1,200,000')).toEqual(['rincian_biaya']);
  });

  it('reads untitled penunjang result pages from the exam table', () => {
    const result = (exam: string) => `${header}MEDREC : 0-00-00-00\nTGL PERIKSA 02-10-2026\nNO NAMA PEMERIKSAAN HASIL PEMERIKSAAN\n1 ${exam}\nKesan : normal`;
    expect(classifyTextPage(result('EKG'))).toEqual(['ekg']);
    expect(classifyTextPage(result('USG FAST IGD'))).toEqual(['radiologi']);
    expect(titleLines(result('EKG'))).not.toContain('EKG');
  });

  it('reads one type from noisy OCR text', () => {
    expect(classifyOcrText('= Crossmatch dilakukan pada tanggal : ...\nKomponen Darah : WB / PRC')).toEqual(['crossmatch']);
    expect(classifyOcrText('KEPOLISIAN NEGARA REPUBLIK INDONESIA\nPENGANTAR LAPORAN POLISI')).toEqual(['laporan_polisi']);
    expect(classifyOcrText('HH ee mE LIT TT')).toEqual([]);
  });
});

const solid = (w: number, h: number, f: (x: number, y: number) => number): Gray => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y);
  return { width: w, height: h, data };
};

describe('image', () => {
  it('converts RGB to grey and rotates a quarter turn clockwise', () => {
    expect(toGray(new Uint8Array([255, 0, 0, 0, 0, 255]), 2, 1, 3).data).toEqual(new Uint8Array([76, 29]));
    // 3×2 → 2×3; the top-left pixel ends up top-right.
    const img = { width: 3, height: 2, data: new Uint8Array([1, 2, 3, 4, 5, 6]) };
    expect(rotate(img, 90)).toEqual({ width: 2, height: 3, data: new Uint8Array([4, 1, 5, 2, 6, 3]) });
    expect(rotate(rotate(img, 90), 270)).toEqual(img);
  });

  it('writes a PNG whose pixels inflate back', () => {
    const img = solid(4, 3, (x, y) => x * 10 + y);
    const png = encodePng(img);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    const idat = png.indexOf('IDAT');
    const len = png.readUInt32BE(idat - 4);
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + len));
    expect(raw[0]).toBe(0);
    expect([...raw.subarray(1, 5)]).toEqual([0, 10, 20, 30]);
  });

  it('scores a two-axis grid high and one-way ruling low', () => {
    const grid = solid(600, 600, (x, y) => (x % 20 === 0 || y % 20 === 0 ? 40 : 230));
    const ruled = solid(600, 600, (_x, y) => (y % 20 === 0 ? 40 : 230));
    expect(gridScore(grid)).toBeGreaterThan(ECG_GRID_THRESHOLD);
    expect(gridScore(ruled)).toBeLessThan(ECG_GRID_THRESHOLD);
  });
});

/** A two-page PDF: page 1 has a text layer, page 2 is one 700×700 grey image (no text). */
function syntheticPdf(title: string, imageShade: number): Uint8Array {
  // Title on its own line, then body text, as in the live bundles.
  const content1 = `BT /F1 10 Tf 40 780 Td (${title}) Tj 0 -14 Td (${'kata '.repeat(20).trim()}) Tj ET`;
  const w = 700;
  const pixels = Buffer.alloc(w * w, imageShade);
  const content2 = `q ${w} 0 0 ${w} 0 0 cm /Im1 Do Q`;
  const objs: Array<string | Buffer> = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /XObject << /Im1 8 0 R >> >> >>',
    `<< /Length ${content1.length} >>\nstream\n${content1}\nendstream`,
    `<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${w} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`), pixels, Buffer.from('\nendstream')]),
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let pos = parts[0]!.length;
  objs.forEach((body, i) => {
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n')]);
    offsets.push(pos);
    parts.push(chunk);
    pos += chunk.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF`;
  parts.push(Buffer.from(xref));
  return new Uint8Array(Buffer.concat(parts));
}

describe('reader', () => {
  it('classifies text pages without OCR, OCRs photo pages, and caches per key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'berkas-'));
    const calls: number[] = [];
    const ocr: OcrEngine = {
      async recognize(png) { calls.push(png.length); return { text: 'UNIT BANK DARAH Crossmatch dilakukan', confidence: 80, confidentWords: 12 }; },
      async close() {},
    };
    try {
      const reader = createBerkasReader({ cacheDir: dir, ocr });
      const progress: string[] = [];
      const pdf = syntheticPdf('SURAT ELEGIBILITAS PESERTA', 200);
      const first = await reader.read(pdf, { cacheKey: '0-12-34-56_2026-10-01_2026-10-05', onProgress: (p) => progress.push(p.phase) });
      expect(first.pages).toEqual([
        { page: 1, source: 'teks', docTypes: ['sep'], labels: ['SEP (Surat Eligibilitas Peserta)'] },
        expect.objectContaining({ page: 2, source: 'foto', docTypes: ['crossmatch'], labels: ['Formulir bank darah / crossmatch'], rotation: 0 }),
      ]);
      expect(first).toMatchObject({ pageCount: 2, photoPages: 1, ocrRun: 1, fromCache: false });
      expect(progress).toEqual(['teks', 'ocr', 'selesai']);
      expect(readdirSync(dir)).toContain(cacheFileName('0-12-34-56_2026-10-01_2026-10-05'));

      // Same PDF, same key: answered from the cache, no OCR.
      const again = await reader.read(pdf, { cacheKey: '0-12-34-56_2026-10-01_2026-10-05' });
      expect(again).toMatchObject({ fromCache: true, ocrRun: 0 });
      // A changed PDF (new text page title) with the same photo: the photo's OCR is reused.
      const changed = await reader.read(syntheticPdf('RESUME MEDIS', 200), { cacheKey: '0-12-34-56_2026-10-01_2026-10-05' });
      expect(changed).toMatchObject({ fromCache: false, ocrRun: 0 });
      expect(changed.pages[0]!.docTypes).toEqual(['resume']);
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
