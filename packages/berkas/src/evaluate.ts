/**
 * Kelengkapan Berkas — which claim documents a stay/visit needs, against what
 * the bundle reader found (docs/berkas-ocr.md). A notice for the operator, who
 * still checks the bundle by hand: it never blocks and never writes.
 *
 * Pure and dependency-free (subpath `@simrs-flow/berkas/evaluate`): the domain
 * packages import only this file and the structural ports below, so the
 * browser bundle never pulls in the reader's `fs`/`crypto`/WASM.
 */

export interface BerkasPagePort {
  page: number;
  source: 'teks' | 'foto' | 'kosong';
  docTypes: string[];
  labels: string[];
  ecgLike?: boolean;
}

export interface BerkasReportPort {
  pageCount: number;
  pages: BerkasPagePort[];
  photoPages: number;
  ocrRun: number;
  fromCache: boolean;
}

export interface BerkasProgressPort {
  phase: string;
  done: number;
  total: number;
  label: string;
}

export interface BerkasReaderPort {
  read(pdf: Uint8Array, options: { cacheKey: string; onProgress?: (p: BerkasProgressPort) => void; signal?: AbortSignal }): Promise<BerkasReportPort>;
}

/** What the run already knows about the stay that decides which documents are required. */
export interface BerkasFacts {
  /** ranap bundles carry a resume; rajal bundles a "lembar verifikasi rawat jalan" instead. */
  instalasi: 'ranap' | 'rajal';
  titipan: boolean;
  /** Billed charge names that need a matching result document. */
  radiologi: string[];
  ekg: string[];
  darah: string[];
}

const RADIOLOGI_CHARGE = /RONTGEN|THORA[XK]|\bUSG\b|CT ?SCAN|MSCT|\bMRI\b|RADIOLOGI|\bFOTO\b|X ?RAY|\bBNO\b/;
const EKG_CHARGE = /\bEKG\b|\bECG\b|ELE[CK]TROKARDIO/;
/** Consumables named after the test are not the test ("EKG ELEKTRODA", "KERTAS EKG"). */
const CONSUMABLE = /ELEKTRODA|KERTAS|JELLY|GEL\b/;
const DARAH_CHARGE = /\bPRC\b|PACKED RED|WHOLE BLOOD|TRANSFUSI|KANTONG DARAH|\bFFP\b/;

/** Charge names → facts. Each list is de-duplicated, upper-cased names. */
export function berkasFactsOf(chargeNames: readonly string[], titipan: boolean, instalasi: BerkasFacts['instalasi'] = 'ranap'): BerkasFacts {
  const names = [...new Set(chargeNames.map((name) => name.toUpperCase().replace(/\s+/g, ' ').trim()).filter(Boolean))];
  return {
    instalasi,
    titipan,
    radiologi: names.filter((n) => RADIOLOGI_CHARGE.test(n) && !CONSUMABLE.test(n)),
    ekg: names.filter((n) => EKG_CHARGE.test(n) && !CONSUMABLE.test(n)),
    darah: names.filter((n) => DARAH_CHARGE.test(n)),
  };
}

export interface BerkasCheck {
  docType: string;
  label: string;
  /** Why this document is expected for this stay. */
  why: string;
  found: boolean;
  pages: number[];
  /** Found only as an untitled photo with ECG-paper grid. */
  probable?: boolean;
}

export interface BerkasEvaluation {
  checks: BerkasCheck[];
  /** Other documents read in the bundle, for the operator's orientation. */
  others: Array<{ label: string; pages: number[] }>;
  missing: BerkasCheck[];
}

const short = (names: string[]) => names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '');

/** Required documents for the stay, each marked found (with pages) or missing. */
export function evaluateBerkas(report: Pick<BerkasReportPort, 'pages'>, facts: BerkasFacts): BerkasEvaluation {
  const pagesOf = (type: string) => report.pages.filter((p) => p.docTypes.includes(type));
  const required: Array<{ docType: string; label: string; why: string }> = [
    { docType: 'sep', label: 'SEP', why: 'wajib untuk klaim' },
    facts.instalasi === 'rajal'
      ? { docType: 'verifikasi_rajal', label: 'Lembar verifikasi rawat jalan', why: 'wajib untuk klaim' }
      : { docType: 'resume', label: 'Ringkasan pulang / resume medis', why: 'wajib untuk klaim' },
    { docType: 'rincian_biaya', label: 'Perincian biaya', why: 'wajib untuk klaim' },
  ];
  if (facts.titipan) required.push({ docType: 'kamar_penuh', label: 'Surat keterangan kamar penuh', why: 'pasien titipan' });
  if (facts.radiologi.length) required.push({ docType: 'radiologi', label: 'Hasil radiologi', why: `ada tagihan ${short(facts.radiologi)}` });
  if (facts.ekg.length) required.push({ docType: 'ekg', label: 'Hasil EKG', why: `ada tagihan ${short(facts.ekg)}` });
  if (facts.darah.length) required.push({ docType: 'crossmatch', label: 'Formulir bank darah / crossmatch', why: `ada tagihan ${short(facts.darah)}` });

  const checks = required.map(({ docType, label, why }): BerkasCheck => {
    const pages = pagesOf(docType);
    const probable = pages.length > 0 && pages.every((p) => p.ecgLike);
    return { docType, label, why, found: pages.length > 0, pages: pages.map((p) => p.page), ...(probable ? { probable } : {}) };
  });
  const requiredTypes = new Set(required.map((r) => r.docType));
  const others = new Map<string, number[]>();
  for (const page of report.pages) {
    page.docTypes.forEach((type, i) => {
      if (requiredTypes.has(type)) return;
      const label = page.labels[i] ?? type;
      others.set(label, [...(others.get(label) ?? []), page.page]);
    });
  }
  return { checks, others: [...others].map(([label, pages]) => ({ label, pages })), missing: checks.filter((c) => !c.found) };
}

/** "hal. 3, 5–7, 9" */
export function pageList(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return parts.length ? `hal. ${parts.join(', ')}` : '';
}
