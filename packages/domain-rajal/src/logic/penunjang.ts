/**
 * Penunjang (lab, lab PA, radiology, elektromedik) verdicts for rawat jalan.
 *
 * Everything here is a pure function: no network, no clock, no module state.
 * Each one is the *decision* half of a legacy guard, with every remote read
 * hoisted into a parameter and the supplying endpoint named. `executors.ts`
 * is the I/O shell that fetches, calls, and turns the verdict into a
 * `StepResult`.
 */
import {
  RAJAL_ELEKTROMEDIK_TREATMENT_KEYWORDS,
  RAJAL_LAB_EMPTY_PDF_SIZE,
  RAJAL_LAB_PA_TREATMENT_KEYWORDS,
  RAJAL_LAB_TREATMENT_KEYWORD,
  RAJAL_LEGACY_LIS_PDF_PATTERN,
  RAJAL_RADIOLOGY_BILLING_PREFIX,
  RAJAL_RADIOLOGY_TREATMENT_EXACT,
  RAJAL_RADIOLOGY_TREATMENT_KEYWORDS,
} from '../rules.js';
import type { RajalHasilResponse } from '../types.js';

/** Legacy `isRadiologyTreatmentName`: exact "usg", or a CT/rontgen/MRI substring. */
export function isRadiologyTreatmentName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return RAJAL_RADIOLOGY_TREATMENT_EXACT.includes(n)
    || RAJAL_RADIOLOGY_TREATMENT_KEYWORDS.some((k) => n.includes(k))
    || n.startsWith(RAJAL_RADIOLOGY_BILLING_PREFIX);
}

/** Legacy `isElektromedikTreatmentName`. */
export function isElektromedikTreatmentName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return RAJAL_ELEKTROMEDIK_TREATMENT_KEYWORDS.some((k) => n.includes(k));
}

/** Legacy `isLabPATreatmentName`. */
export function isLabPaTreatmentName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return RAJAL_LAB_PA_TREATMENT_KEYWORDS.some((k) => n.includes(k));
}

/** Legacy `isRegularLabTreatmentName`: "laboratorium" but not "laboratorium pa". */
export function isRegularLabTreatmentName(name: string): boolean {
  const n = name.trim().toLowerCase();
  return n.includes(RAJAL_LAB_TREATMENT_KEYWORD) && !isLabPaTreatmentName(n);
}

export function isUnknownPenunjangTreatmentName(name: string): boolean {
  const value = name.trim().toLowerCase();
  return ['penunjang', 'radiologi', 'laboratorium', 'lab ', 'elektromedik', 'usg', 'rontgen', 'ct scan', 'mri'].some((marker) => value.includes(marker))
    && !isRadiologyTreatmentName(name)
    && !isElektromedikTreatmentName(name)
    && !isLabPaTreatmentName(name)
    && !isRegularLabTreatmentName(name);
}

export type RajalLisPdfTarget = { kind: 'old-lis' } | { kind: 'pdf'; noTransaksi: string };
export interface RajalLabPdfVerdict {
  readonly hasResult: boolean;
  readonly reason: string;
  readonly method: string;
  readonly size?: number;
}

/** Legacy `validateLabResult`: extract the result PDF target, or use the direct URL fallback. */
export function resolveRajalLisPdfTarget(markup: string, fallbackNoTransaksi: string): RajalLisPdfTarget {
  if (RAJAL_LEGACY_LIS_PDF_PATTERN.test(markup)) return { kind: 'old-lis' };
  const match = markup.match(/pdf\.php\?[^"'\s<>]*no_transaksi=([^"'\s&<>]+)/i);
  const raw = match?.[1] ?? fallbackNoTransaksi;
  try {
    return { kind: 'pdf', noTransaksi: decodeURIComponent(raw) };
  } catch {
    return { kind: 'pdf', noTransaksi: raw };
  }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

/** Legacy HEAD verdict for `/lis_new/pdf.php`: content-length ≤ 7407 means empty, chunked means resulted. */
export function evaluateRajalLabPdfHead(
  headers: Record<string, string>,
  threshold = RAJAL_LAB_EMPTY_PDF_SIZE,
): RajalLabPdfVerdict | null {
  const contentType = (headerValue(headers, 'content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/pdf')) {
    return { hasResult: false, reason: `Not PDF (${contentType})`, method: 'head-content-type' };
  }
  const contentLength = headerValue(headers, 'content-length');
  if (contentLength !== undefined) {
    const size = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(size)) return null;
    return size <= threshold
      ? { hasResult: false, reason: `Empty PDF (Content-Length: ${size} ≤ ${threshold})`, method: 'head-content-length', size }
      : { hasResult: true, reason: `PDF with data (Content-Length: ${size} > ${threshold})`, method: 'head-content-length', size };
  }
  if ((headerValue(headers, 'transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
    return { hasResult: true, reason: 'PDF streamed (Transfer-Encoding: chunked)', method: 'head-chunked' };
  }
  return null;
}

/** Legacy GET fallback for `/lis_new/pdf.php`: require PDF magic and size above the empty-report threshold. */
export function evaluateRajalLabPdfGet(
  status: number,
  bodyBytes: Uint8Array | undefined,
  threshold = RAJAL_LAB_EMPTY_PDF_SIZE,
): RajalLabPdfVerdict {
  if (status < 200 || status >= 300) return { hasResult: false, reason: `HTTP ${status}`, method: 'get-status' };
  const bytes = bodyBytes ?? new Uint8Array();
  const size = bytes.byteLength;
  if (size >= 4 && (bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46)) {
    return { hasResult: false, reason: 'Not a valid PDF', method: 'get-magic' };
  }
  return size <= threshold
    ? { hasResult: false, reason: `Empty PDF (${size} ≤ ${threshold} bytes)`, method: 'get-size', size }
    : { hasResult: true, reason: `Valid PDF (${size} > ${threshold} bytes)`, method: 'get-size', size };
}

const RAJAL_LEGACY_MONTHS: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * Legacy `formatDateToDDMonYYYY` (source line 244). The penunjang order
 * history endpoints echo dates in `10-Jun-2026` form, not ISO.
 */
export function formatRajalLegacyDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  const label = RAJAL_LEGACY_MONTHS[Number.parseInt(month ?? '', 10) - 1] ?? month ?? '';
  return `${(day ?? '').padStart(2, '0')}-${label}-${year ?? ''}`;
}

/**
 * Row count of a `hasil pemeriksaan` response. Legacy treated `total === 0` as
 * "no result" but let an absent `total` through; we fail closed instead and
 * fall back to the row count, so a shapeless response never reads as resulted.
 */
export function resultCount(res: RajalHasilResponse | null | undefined): number {
  if (!res) return 0;
  if (typeof res.total === 'number') return res.total;
  if (typeof res.total === 'string') {
    const parsed = Number.parseInt(res.total, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return res.rows?.length ?? 0;
}
