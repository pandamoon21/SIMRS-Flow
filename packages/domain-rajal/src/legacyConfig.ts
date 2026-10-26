import { normalizeDate } from '@simrs-flow/evomedis-client';

export const RAJAL_CLINIC_MAPPING = {
  ANAK: 'ANAK',
  BEDAH: 'BEDAH',
  'BEDAH ANAK': 'BEDAH ANAK',
  'BEDAH DIGESTIVE': 'BEDAH DIGESTIF',
  'BEDAH ONKOLOGI': 'BEDAH ONKOLOGI',
  'BEDAH ORTOPEDI': 'ORTHOPEDI',
  'BEDAH SYARAF': 'BEDAH SARAF',
  DALAM: 'PENYAKIT DALAM',
  'DALAM, GINJAL DAN HIPERTENSI': 'GINJAL-HIPERTENSI',
  // Unit "POLI PENYAKIT DALAM GASTROENTEROHEPATOLOGI" (kd_unit_bpjs 005); SEP
  // poli_tujuan seen live as "GASTROENTEROLOGI-HEPATOLOGI ". Keyed without
  // "PENYAKIT DALAM" so a same-day PENYAKIT DALAM SEP can't substring-match it.
  GASTROENTEROHEPATOLOGI: 'GASTROENTEROLOGI-HEPATOLOGI',
  'POLI DALAM, GINJAL DAN HIPERTENSI': 'GINJAL-HIPERTENSI',
  GIGI: 'GIGI ENDODONSI',
  'GIGI ANAK PEDODONTIS': 'GIGI PEDODONTIS',
  'GIGI ENDODONSI': 'GIGI ENDODONSI',
  'GIGI ORTODONTIST': 'GIGI ORTODONTIST',
  'GIGI SPESIALIS BEDAH MULUT': 'GIGI BEDAH MULUT',
  HAEMODIALISA: 'HEMODIALISA',
  HEMODIALISA: 'HEMODIALISA',
  HAEMODIALISIS: 'HEMODIALISA',
  HEMODIALISIS: 'HEMODIALISA',
  'HEMATO-ONKOLOGI': 'HEMATOLOGI - ONKOLOGI MEDIK',
  'HEMATOLOGI ONKOLOGI ANAK': 'ANAK HEMATOLOGI ONKOLOGI',
  JANTUNG: 'JANTUNG DAN PEMBULUH DARAH',
  'JANTUNG ANAK': 'ANAK KARDIOLOGI',
  'JANTUNG INTERVENSI': 'Pelayanan vaskular',
  JIWA: 'JIWA',
  'KEBIDANAN DAN KANDUNGAN': 'OBGYN',
  KEMOTERAPI: 'SARANA KEMOTERAPI',
  'KULIT DAN KELAMIN': 'KULIT KELAMIN',
  MATA: 'MATA',
  'MEDICAL CHECK UP': 'MEDICAL CHECK UP',
  'ONKOLOGI GINEKOLOGI': 'ONKOLOGI GINEKOLOGI',
  PARU: 'PARU',
  PSIKOLOGI: 'JIWA',
  RADIOTERAPI: 'SARANA RADIOTERAPI',
  // Unit "TB RO" shares kd_unit_bpjs PAR with POLI PARU.
  'TB RO': 'PARU',
  'REHAB MEDIK': 'REHABILITASI MEDIK',
  SYARAF: 'SARAF',
  THT: 'THT-KL',
  'THT ONKOLOGI': 'ONKOLOGI KEPALA LEHER',
  UROLOGI: 'UROLOGI',
} as const;

/**
 * Clinics that must never borrow another poli's mapping. Each is a real EvoMedis
 * unit whose BPJS `poli_tujuan` is still unknown — POLI JANTUNG ARITMIA
 * (kd_unit 251), POLI HEMOFILIA (245), POLI BEDAH VASKULAR (261) — yet whose
 * name contains a mapped key (`JANTUNG`, `BEDAH`). The substring fallback in
 * {@link rajalClinicMappingKey} would map ARITMIA to `JANTUNG DAN PEMBULUH
 * DARAH` and BEDAH VASKULAR to `BEDAH`; a wrong poli also *matches* the wrong
 * same-day SEP (see {@link sepPoliMatches}), so `validate_sep` would plan a
 * high-risk `rekamMedis.simpanSep` correction. These units therefore fail
 * closed: raw-name candidates only, which normally yields `needs_review`.
 * Normalized with {@link normalizeClinicLabel}, so a trailing kd_unit
 * ("POLI JANTUNG ARITMIA (251)") becomes "JANTUNG ARITMIA 251" and is matched
 * by prefix.
 */
export const RAJAL_UNMAPPED_CLINIC_UNITS = ['JANTUNG ARITMIA', 'HEMOFILIA', 'BEDAH VASKULAR'] as const;

export const RAJAL_TREATMENT_TEMPLATES = [
  { id: 'obat', label: 'Pendaftaran + Obat', rows: ['A|registration|PENDAFTARAN PASIEN', 'B|obat|BIAYA OBAT'] },
  { id: 'hd', label: 'Pendaftaran + HD', rows: ['A|registration|PENDAFTARAN PASIEN', 'B|hd|HAEMODIALISA'] },
  { id: 'radio', label: 'Pendaftaran + Eksterna/Radio', rows: ['A|registration|PENDAFTARAN PASIEN', 'B|eksterna|EKSTERNA'] },
  {
    id: 'obat_or_hd',
    label: 'Pendaftaran + Obat OR HD',
    rows: ['A|registration|PENDAFTARAN PASIEN', 'B|obat|BIAYA OBAT', 'B|hd|HAEMODIALISA'],
  },
] as const;

export const RAJAL_DEFAULT_SKIP_TREATMENTS = ['ODC'] as const;

export const RAJAL_LEGACY_CHECKS = [
  { id: 'rencanaOnko', label: 'Rencana onko/kemo' },
  { id: 'sepCheckRequired', label: 'Validasi SEP' },
  { id: 'verificationRequired', label: 'Verifikasi sebelum bayar' },
  { id: 'checkLab', label: 'Lab reguler' },
  { id: 'checkLabPA', label: 'Lab PA' },
  { id: 'checkRadiologi', label: 'Radiologi' },
  { id: 'checkElektromedik', label: 'Elektromedik' },
] as const;

/**
 * Penunjang (diagnostic-support) treatment classifiers.
 *
 * Legacy source lines 336-340. Each of the four penunjang guards only runs
 * when the billed tindakan rows actually contain a matching modality, so these
 * keyword lists decide whether a check applies to a record at all.
 */
export const RAJAL_RADIOLOGY_TREATMENT_EXACT: readonly string[] = ['usg'];
export const RAJAL_RADIOLOGY_TREATMENT_KEYWORDS: readonly string[] = ['ct scan', 'rontgen', 'mri'];
/**
 * The radiology administration charge the billing desk posts per study
 * (`BIAYA RADIOLOGI`, `BIAYA RADIOLOGI THORAX`). The legacy modality keywords
 * only recognise the study name, so this line fell through to
 * `isUnknownPenunjangTreatmentName` and the visit was dropped as unclassified —
 * the exact outcome the fallback exists to prevent for a charge we do know.
 * Anchored (`startsWith`) so a name that merely mentions radiology, such as a
 * non-radiology penunjang row, is not swept in.
 */
export const RAJAL_RADIOLOGY_BILLING_PREFIX = 'biaya radiologi';
export const RAJAL_ELEKTROMEDIK_TREATMENT_KEYWORDS: readonly string[] = ['penunjang elektromedik'];
export const RAJAL_LAB_PA_TREATMENT_KEYWORDS: readonly string[] = ['laboratorium pa'];
export const RAJAL_LAB_TREATMENT_KEYWORD = 'laboratorium';

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

export function evaluateRajalConsultVisit(args: {
  visitDate: string;
  unit: string;
  history: readonly { tgl_masuk?: string; nama_unit?: string }[];
}): 'single_clinic' | 'consult' | 'unknown' {
  const validDate = (raw: string): string | null => {
    const date = normalizeDate(raw);
    if (!date) return null;
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(Date.UTC(year!, month! - 1, day!));
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
  };
  const visitDate = validDate(args.visitDate);
  const unit = args.unit.trim().toUpperCase();
  if (!visitDate || !/^POLI\s+\S/.test(unit)) return 'unknown';
  const units = new Set<string>([unit]);
  let found = false;
  for (const row of args.history) {
    const date = validDate(row.tgl_masuk ?? '');
    if (!date) return 'unknown';
    if (date !== visitDate) continue;
    const other = (row.nama_unit ?? '').trim().toUpperCase();
    if (!other) return 'unknown';
    if (!/^POLI\s+\S/.test(other)) continue;
    units.add(other);
    found = true;
  }
  return found ? units.size >= 2 ? 'consult' : 'single_clinic' : 'unknown';
}

/**
 * Legacy `validateLabResult` (source lines 552-696) markers. An LIS printout
 * containing one of these, or shorter than the minimum markup length, means the
 * lab order has not been resulted yet.
 */
export const RAJAL_LAB_EMPTY_RESULT_MARKERS: readonly string[] = [
  'data tidak ada',
  'tidak ada data',
  'no result',
  'not found',
  'no data',
  'belum ada hasil',
];
export const RAJAL_LAB_MIN_LIS_MARKUP_LENGTH = 50;
/** Legacy `checkLabPAResult`: a PA printout longer than this carries a result. */
export const RAJAL_LAB_PA_MIN_RESULT_LENGTH = 100;
/** Legacy "old LIS" link — its presence alone means a result exists. */
export const RAJAL_LEGACY_LIS_PDF_PATTERN = /cetak_hasil_pdf\.php\?no_lab=[^"'\s&<>]+/i;
/** Legacy `CONFIG.labEmptyPdfSize`: the known empty regular-lab PDF byte size. */
export const RAJAL_LAB_EMPTY_PDF_SIZE = 7407;

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

/** Legacy `isMatchingRecordPenunjang`: an untransferred penunjang visit unit. */
export const RAJAL_PENUNJANG_UNIT_KEYWORD = 'PENUNJANG';

/** Legacy `checkSep`: only same-day RJTL (outpatient referral) SEPs count. */
export const RAJAL_SEP_SERVICE_TYPE = 'RJTL';
/** Legacy `checkSep` retries the flaky BPJS bridge up to four times. */
export const RAJAL_SEP_HISTORY_ATTEMPTS = 4;

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

export function normalizeSepPoliName(value: string): string {
  return value
    .toUpperCase()
    .replace(/&/g, ' DAN ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Legacy `poliMatches` (source lines 817-824): the SEP's `poli_tujuan` matches
 * a clinic when either side contains the other after normalization.
 */
export function sepPoliMatches(poliTujuan: string, candidates: readonly string[]): boolean {
  const normalized = normalizeSepPoliName(poliTujuan);
  if (!normalized) return false;
  return candidates.some(
    (candidate) =>
      normalized === candidate || normalized.includes(candidate) || candidate.includes(normalized),
  );
}

/**
 * The {@link RAJAL_CLINIC_MAPPING} key for a clinic or report unit name.
 * Exact (after {@link normalizeClinicLabel}) first, then the LONGEST key that
 * substring-matches — legacy took the first hit in insertion order, so a
 * report heading like "POLI JANTUNG ANAK" became ANAK and
 * "POLI PENYAKIT DALAM GASTROENTEROHEPATOLOGI" became DALAM.
 *
 * A unit listed in {@link RAJAL_UNMAPPED_CLINIC_UNITS} is deliberately unmapped
 * (exact or prefix match after normalization) even when its name contains a
 * mapping key: borrowing JANTUNG for ARITMIA would resolve the wrong SEP.
 */
function rajalClinicMappingKey(clinic: string): keyof typeof RAJAL_CLINIC_MAPPING | undefined {
  const label = normalizeClinicLabel(clinic);
  // Guard the substring fallback: `includes('')` is always true, so an unset
  // clinic would silently become a real poli.
  if (!label) return undefined;
  // Prefix catches the raw unit list form "JANTUNG ARITMIA 251".
  if (RAJAL_UNMAPPED_CLINIC_UNITS.some((unit) => { const norm = normalizeClinicLabel(unit); return label === norm || label.startsWith(`${norm} `); })) return undefined;
  const keys = Object.keys(RAJAL_CLINIC_MAPPING) as (keyof typeof RAJAL_CLINIC_MAPPING)[];
  const exact = keys.find((key) => normalizeClinicLabel(key) === label);
  if (exact) return exact;
  return keys
    .map((key) => ({ key, norm: normalizeClinicLabel(key) }))
    .filter(({ norm }) => label.includes(norm) || norm.includes(label))
    .sort((a, b) => b.norm.length - a.norm.length)[0]?.key;
}

export function mapRajalClinicToSepPoli(clinic: string): string {
  const key = rajalClinicMappingKey(clinic);
  return key ? RAJAL_CLINIC_MAPPING[key].toLowerCase() : clinic.toLowerCase().trim();
}

export function rajalClinicCandidates(clinic: string): readonly string[] {
  const source = clinic.trim();
  const mapped = mapRajalClinicToSepPoli(source);
  // A mapped clinic matches on its SEP poli only: the raw unit name can contain
  // another poli ("PENYAKIT DALAM GASTROENTEROHEPATOLOGI" ⊃ "PENYAKIT DALAM")
  // and would accept that clinic's same-day SEP.
  const candidates = rajalClinicMappingKey(source)
    ? [mapped, mapped.replace(/-/g, ' ')]
    : [mapped, source, mapped.replace(/-/g, ' '), source.replace(/^POLI\s+/i, '')];
  return [...new Set(candidates.filter(Boolean).map(normalizeSepPoliName).filter(Boolean))];
}

/* ════════════════════════════════════════════════════════════════
 * Deterministic decisions
 *
 * Everything below is a pure function: no network, no clock, no module
 * state. Each one is the *decision* half of a legacy guard, with every
 * remote read hoisted into a parameter and the supplying endpoint named.
 * `executors.ts` is the I/O shell that fetches, calls, and turns the
 * verdict into a `StepResult`.
 * ════════════════════════════════════════════════════════════════ */

/**
 * Legacy `normalizeClinicLabel` (source line 283). Note this one strips a
 * leading `POLI ` where {@link normalizeSepPoliName} does not — the clinic
 * matcher compares unit names, the SEP matcher compares poli tujuan.
 */
export function normalizeClinicLabel(value: string): string {
  return value
    .toUpperCase()
    .replace(/^POLI\s+/, '')
    .replace(/&/g, ' DAN ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RajalClinicMatch {
  /** The single selected clinic this unit belongs to, or `''`. */
  matchedClinic: string;
  /** Every clinic that scored, best first; the tied winners when ambiguous. */
  matches: readonly string[];
  /** Two clinics tied for best — legacy skips the record rather than guess. */
  ambiguous: boolean;
  /** The normalized unit label, kept for the operator log. */
  unitNorm: string;
}

/**
 * Legacy `resolveClinicMatch` (source lines 293-331).
 *
 * Scores every selected clinic against a visit's `nama_unit` and demands a
 * unique winner. The score tiers are load-bearing: an exact match beats a
 * prefix, which beats a suffix, which beats an interior word, which beats a
 * bare substring, which beats the reverse containment. Ties are broken by
 * longer clinic name then alphabetically — and when the top two are still
 * indistinguishable the match is *ambiguous*, which makes
 * `findMatchingRecords` (source line 734) drop the record entirely rather
 * than bill it against a guessed clinic.
 */
export function resolveRajalClinicMatch(
  unitName: string,
  clinics: readonly string[],
): RajalClinicMatch {
  const unitNorm = normalizeClinicLabel(unitName.trim());
  // Entries that normalize alike ("DALAM", " DALAM", "POLI DALAM") are one poli,
  // not two candidates: counting them twice flagged every such visit ambiguous.
  const seen = new Set<string>();
  const clinicList = clinics.map((item) => item.trim()).filter((item) => {
    const key = normalizeClinicLabel(item);
    if (!item || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unitNorm || clinicList.length === 0) {
    return { matchedClinic: '', matches: [], ambiguous: false, unitNorm };
  }
  const scored = clinicList
    .map((clinic) => {
      const clinicNorm = normalizeClinicLabel(clinic);
      let score = 0;
      if (unitNorm === clinicNorm) score = 3000;
      else if (unitNorm.startsWith(`${clinicNorm} `)) score = 2000 + clinicNorm.length;
      else if (unitNorm.endsWith(` ${clinicNorm}`)) score = 1900 + clinicNorm.length;
      else if (unitNorm.includes(` ${clinicNorm} `)) score = 1800 + clinicNorm.length;
      else if (unitNorm.includes(clinicNorm)) score = 1000 + clinicNorm.length;
      else if (clinicNorm.includes(unitNorm)) score = 500 + unitNorm.length;
      return { clinic, clinicNorm, score };
    })
    .filter((item) => item.score > 0);
  if (scored.length === 0) {
    return { matchedClinic: '', matches: [], ambiguous: false, unitNorm };
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || b.clinicNorm.length - a.clinicNorm.length || a.clinic.localeCompare(b.clinic),
  );
  const best = scored[0]!;
  const topMatches = scored.filter(
    (item) => item.score === best.score && item.clinicNorm.length === best.clinicNorm.length,
  );
  if (topMatches.length > 1) {
    return {
      matchedClinic: '',
      matches: topMatches.map((item) => item.clinic),
      ambiguous: true,
      unitNorm,
    };
  }
  return {
    matchedClinic: best.clinic,
    matches: scored.map((item) => item.clinic),
    ambiguous: false,
    unitNorm,
  };
}

/** One row of the operator's required-treatment table (source line 102). */
export interface RajalTreatmentGroup {
  /** Group letter. Same letter means OR; different letters mean AND. */
  group: string;
  /** Stable key the matched row is reported under. */
  key: string;
  /** Substring the tindakan name must contain — matched case-sensitively. */
  name: string;
}

export type RajalTreatmentVerdict =
  | { ok: true; matched: Readonly<Record<string, string>> }
  | { ok: false; kind: 'skip'; keyword: string; found: string }
  | { ok: false; kind: 'group'; group: string; expected: readonly string[] };

/**
 * Legacy `verifyTreatmentGroups` (source lines 762-782).
 *
 * Hoisted fetch: `kasir/kasir/get_listtindakan` → `names` (each row's
 * `nama_tindakan`, trimmed).
 *
 * Two rules, in order:
 *  1. Any skip treatment present anywhere on the bill rejects the record.
 *     Matched case-*insensitively* (source line 767).
 *  2. Every distinct group letter must be satisfied by at least one of its
 *     rows — so same letter is OR, different letters are AND. Matched
 *     case-*sensitively* (source line 776); that asymmetry is the legacy's,
 *     not a transcription slip.
 *
 * An empty group table passes, matching legacy's `if(!groups.length) return{}`.
 */
/**
 * The same decision as {@link verifyRajalTreatmentGroups}, spelled out per rule
 * for the operator: one line per forbidden treatment and per required group,
 * each marked met or not, instead of only the first failure.
 */
export function rajalTreatmentChecklist(
  names: readonly string[],
  groups: readonly RajalTreatmentGroup[],
  skipTreatments: readonly string[],
): Array<{ label: string; ok: boolean; detail: string }> {
  const trimmed = names.map((name) => name.trim());
  const items: Array<{ label: string; ok: boolean; detail: string }> = [];
  for (const skip of skipTreatments) {
    const keyword = skip.trim();
    if (!keyword) continue;
    const found = trimmed.find((name) => name.toUpperCase().includes(keyword.toUpperCase()));
    items.push({ label: `Tidak ada tindakan "${keyword}"`, ok: found === undefined, detail: found === undefined ? 'tidak ditemukan' : `ditemukan: ${found}` });
  }
  const byGroup = new Map<string, RajalTreatmentGroup[]>();
  for (const group of groups) byGroup.set(group.group, [...(byGroup.get(group.group) ?? []), group]);
  for (const [letter, items_] of byGroup) {
    const hit = items_.map((item) => trimmed.find((name) => name.includes(item.name))).find((found) => found !== undefined);
    items.push({
      label: `Grup ${letter}: ${items_.map((item) => item.name).join(' / ')}`,
      ok: hit !== undefined,
      detail: hit !== undefined ? `ada: ${hit}` : 'tidak ditagihkan',
    });
  }
  return items;
}

export function verifyRajalTreatmentGroups(
  names: readonly string[],
  groups: readonly RajalTreatmentGroup[],
  skipTreatments: readonly string[],
): RajalTreatmentVerdict {
  const trimmed = names.map((name) => name.trim());
  for (const skip of skipTreatments) {
    const keyword = skip.trim();
    if (!keyword) continue;
    const found = trimmed.find((name) => name.toUpperCase().includes(keyword.toUpperCase()));
    if (found !== undefined) return { ok: false, kind: 'skip', keyword, found };
  }
  if (groups.length === 0) return { ok: true, matched: {} };
  const byGroup = new Map<string, RajalTreatmentGroup[]>();
  for (const group of groups) {
    const bucket = byGroup.get(group.group);
    if (bucket) bucket.push(group);
    else byGroup.set(group.group, [group]);
  }
  const matched: Record<string, string> = {};
  for (const [letter, items] of byGroup) {
    const hit = items
      .map((item) => ({ item, found: trimmed.find((name) => name.includes(item.name)) }))
      .find((candidate) => candidate.found !== undefined);
    if (!hit) {
      return { ok: false, kind: 'group', group: letter, expected: items.map((item) => item.name) };
    }
    matched[hit.item.key] = hit.found!;
  }
  return { ok: true, matched };
}

/**
 * Legacy `CONFIG.rencanaOnko` keyword (source line 888). An oncology plan whose
 * `isi_perencanaan` mentions chemotherapy means the visit is part of a chemo
 * course that must not be billed as an ordinary outpatient visit.
 */
export const RAJAL_ONCOLOGY_PLAN_KEYWORD = 'kemo';

export interface RajalOncologyPlanVerdict {
  /** True when the plan text names chemotherapy — legacy skips the record. */
  blocking: boolean;
  /** The `isi_perencanaan` text as read, for the audit trail. */
  plan: string;
  /**
   * False when the response carried no `isi_perencanaan` at all, so the rule
   * could not be evaluated. Legacy treated that as "no chemo" and paid;
   * the port refuses to call an unreadable input clean.
   */
  readable: boolean;
}

/**
 * Legacy source lines 886-889.
 *
 * Hoisted fetch: `kasir.getRencanaOnko` — POST
 * `kasir/kasir/get_rencana_onko` ({no_registrasikunjungan}) → `response`.
 */
export function evaluateRajalOncologyPlan(response: unknown): RajalOncologyPlanVerdict {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { blocking: false, plan: '', readable: false };
  }
  const raw = (response as Record<string, unknown>)['isi_perencanaan'];
  if (typeof raw !== 'string') return { blocking: false, plan: '', readable: false };
  const plan = raw.trim();
  return {
    blocking: plan.toLowerCase().includes(RAJAL_ONCOLOGY_PLAN_KEYWORD),
    plan,
    readable: true,
  };
}

export interface RajalExitDateVerdict {
  /** True when a `tgl_keluar` field was present at all. */
  readable: boolean;
  /** True when that field carried a value — legacy blocks when it does not. */
  present: boolean;
  date: string;
}

/**
 * Field-level half of the exit-date guard: `''` (or whitespace) is a visit the
 * clinic has not closed; `undefined`/`null` means the caller had no field to
 * hand over at all, which is not a decision.
 *
 * Prefer {@link evaluateRajalExitDateResponse}, which applies legacy's own
 * reading to a whole `getdatacarakeluar_tab` reply.
 */
export function evaluateRajalExitDate(tglKeluar: string | undefined | null): RajalExitDateVerdict {
  if (tglKeluar === undefined || tglKeluar === null) {
    return { readable: false, present: false, date: '' };
  }
  const date = tglKeluar.trim();
  return { readable: true, present: date.length > 0, date };
}

/**
 * Legacy source lines 891-892: no exit date on the visit means the clinic has
 * not discharged the patient, and the legacy refuses to bill.
 *
 * Hoisted fetch: `poliklinik.getDataCaraKeluarTab` — POST
 * `poliklinik/poliklinik/getdatacarakeluar_tab` ({no_registrasikunjungan}) →
 * `response`. This is the endpoint legacy itself read; the port used to
 * substitute `tgl_keluar` off the `kasir/kasir/gethistorykunjungan` row, which
 * was never confirmed to carry it for outpatient rows.
 *
 * Legacy's test is `if(!ck?.tgl_keluar)`, so once the discharge tab has
 * answered, an absent field, a null and an empty string all mean the same
 * thing — not discharged — and all block. Only a reply that is not a record at
 * all (null, an array, a bare string) is unreadable, and an unreadable read is
 * never a pass.
 */
export function evaluateRajalExitDateResponse(response: unknown): RajalExitDateVerdict {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { readable: false, present: false, date: '' };
  }
  const raw = (response as Record<string, unknown>)['tgl_keluar'];
  return evaluateRajalExitDate(typeof raw === 'string' ? raw : '');
}

export interface RajalBlockerVerdict {
  blocking: boolean;
  total: number;
  namaUnit: string;
  /** The response's `data` field, or the cleaned text of a non-object reply. */
  data: string;
}

/**
 * A blocker reply can be `{}`, a plain object, a bare string, or a list of
 * offending rows. Anything else is *unreadable*, and unreadable must never be
 * mistaken for clean: the payment guards downstream read `blocking: false` as
 * permission to stage money.
 */
function blockerFields(response: unknown): {
  record: Record<string, unknown> | null;
  text: string;
  blocking: boolean;
} {
  if (typeof response === 'string') return { record: null, text: response.trim(), blocking: response.trim().length > 0 };
  if (Array.isArray(response)) {
    // Legacy `Object.keys(pc).length` is truthy for any element, so a populated
    // list blocks while an empty one is clean.
    if (response.length === 0) return { record: null, text: '', blocking: false };
    const first = response.find((item) => item && typeof item === 'object') as Record<string, unknown> | undefined;
    return { record: first ?? null, text: '', blocking: true };
  }
  if (response === null || response === undefined) {
    // The endpoint answering with nothing at all is not "no blocker": treat it
    // as an unreadable reply and refuse the record.
    return { record: null, text: '', blocking: true };
  }
  if (typeof response !== 'object') return { record: null, text: '', blocking: true };
  const record = response as Record<string, unknown>;
  return { record, text: '', blocking: Object.keys(record).length > 0 };
}

function blockerTotal(record: Record<string, unknown> | null): number {
  const raw = record?.['total'];
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.trunc(raw) : 0;
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function blockerString(record: Record<string, unknown> | null, key: string): string {
  const raw = record?.[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Legacy source line 1009: `cek_order_belum_terlayani` /
 * `cek_order_belum_transfer` report outstanding orders that must be served and
 * transferred onto the bill before it may be paid.
 *
 * Hoisted fetches: `kasir/kasir/cek_order_belum_terlayani` and
 * `kasir/kasir/cek_order_belum_transfer`, both
 * ({no_registrasikunjungan, no_transaksi, kd_unit}) → `response`.
 *
 * Deviation, deliberate: legacy tests `if(o1?.total||o2?.total)`, and because
 * the backend returns `total` as a *string*, `"0"` is truthy in JavaScript — so
 * legacy blocks every clean transaction whose total serialises as a string.
 * `ranap_v3.py:3773` reads the same two endpoints as `int(total or 0) > 0`,
 * which is plainly the intent; the port follows the Python. Reproducing the JS
 * literally would be a permanent false refusal, not parity.
 */
export function evaluateRajalOrderBlocker(response: unknown): RajalBlockerVerdict {
  const { record, text } = blockerFields(response);
  const total = blockerTotal(record);
  return {
    blocking: total > 0,
    total,
    namaUnit: blockerString(record, 'nama_unit'),
    data: blockerString(record, 'data') || text,
  };
}

/**
 * Legacy source lines 1010-1011: an unverified penunjang transaction on the
 * registration blocks payment.
 *
 * Hoisted fetch: `poliklinik/verifikator/cektransaksi_penunjang`
 * ({no_registrasikunjungan}) → `response`.
 *
 * Legacy blocks when the reply object has *any* key
 * (`pc && Object.keys(pc).length`), and a clean registration replies `{}`.
 * That is kept: it is both faithful and the fail-closed reading — and it now
 * covers the bare-list reply the endpoint sometimes returns (`[]` clean, a
 * populated list blocking) as well as an unreadable reply, which must never
 * read as "nothing outstanding".
 * `ranap_v3.py:15023` is narrower — it blocks only on
 * `nama_unit || no_transaksi || data || total` — so a reply carrying nothing
 * but `{"total": 0}` blocks here and would not there. Recorded in the parity
 * doc; the outpatient script is the authority for the outpatient port.
 */
export function evaluateRajalPenunjangBlocker(response: unknown): RajalBlockerVerdict {
  const { record, text, blocking } = blockerFields(response);
  return {
    blocking,
    total: blockerTotal(record),
    namaUnit: blockerString(record, 'nama_unit'),
    data: blockerString(record, 'data') || text,
  };
}

/** Legacy `paymentConfig` (source line 107) — shift, tender type, payer. */
export interface RajalPaymentConfig {
  shift: string;
  type: string;
  payerCode: string;
}

export const RAJAL_DEFAULT_PAYMENT_CONFIG: RajalPaymentConfig = {
  shift: '1',
  type: '14',
  payerCode: '15',
};

/** Legacy `PAYMENT_TYPE_MAPPING` (source line 61) — labels shown, codes stored. */
export const RAJAL_PAYMENT_TYPE_OPTIONS = [
  { label: 'TUNAI', code: '1' },
  { label: 'PIUTANG', code: '2' },
  { label: 'SETOR BSI', code: '3' },
  { label: 'EDC BRI', code: '4' },
  { label: 'EDC BNI', code: '5' },
  { label: 'EDC MANDIRI', code: '6' },
  { label: 'TRANSFER BSI', code: '7' },
  { label: 'TRANSFER BRI', code: '9' },
  { label: 'TRANSFER BNI', code: '10' },
  { label: 'QRIS', code: '11' },
  { label: 'TRANSFER MANDIRI', code: '12' },
  { label: 'Keuangan', code: '13' },
  { label: 'PIUTANG BPJS', code: '14' },
  { label: 'PIUTANG UMUM', code: '15' },
  { label: 'EDC BSI', code: '17' },
] as const;

/** Legacy `SHIFT_MAPPING` (source line 71) — labels shown, codes stored. */
export const RAJAL_SHIFT_OPTIONS = [
  { label: 'Shift 1', code: '1' },
  { label: 'Shift 2', code: '2' },
  { label: 'Shift 3', code: '3' },
] as const;

export function rajalPaymentTypeCode(value: string): string {
  const trimmed = value.trim();
  return RAJAL_PAYMENT_TYPE_OPTIONS.find((option) => option.label === trimmed)?.code ?? trimmed;
}

export function rajalShiftCode(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return RAJAL_DEFAULT_PAYMENT_CONFIG.shift;
  const matched = RAJAL_SHIFT_OPTIONS.find((option) => option.label === trimmed || option.code === trimmed);
  if (matched) return matched.code;
  return trimmed.match(/(\d)/)?.[1] ?? RAJAL_DEFAULT_PAYMENT_CONFIG.shift;
}

export function normalizeRajalPaymentConfig(payment?: Partial<RajalPaymentConfig>): RajalPaymentConfig {
  const type = payment?.type?.trim();
  return {
    shift: rajalShiftCode(payment?.shift ?? RAJAL_DEFAULT_PAYMENT_CONFIG.shift),
    type: type ? rajalPaymentTypeCode(type) : RAJAL_DEFAULT_PAYMENT_CONFIG.type,
    payerCode: payment?.payerCode?.trim() || RAJAL_DEFAULT_PAYMENT_CONFIG.payerCode,
  };
}

export interface RajalTampungBayarArgs {
  noReg: string;
  noTransaksi: string;
  kdUnit: string;
  /** `getJumlahBayar.total` — billed amount, sent as both tender and bill. */
  total: string;
  /** `getJumlahBayar.sudah` — already-settled amount. */
  sudah: string;
  /** The cashier grid's rows (`kasir.getListTindakan`, 20 kasir fields), serialised verbatim. */
  tindakanRows: readonly unknown[];
  payment?: Partial<RajalPaymentConfig>;
}

/**
 * Legacy `tampung_bayar` body (source lines 1021-1032).
 *
 * `dt_bayar` is a *form-encoded string nested inside a form field* — the
 * backend re-parses it — so it is built with `URLSearchParams`, exactly as
 * legacy did, and `tindakan` is the JSON array of every billed row.
 *
 * It carries the cashier form's nine fields in form order, the four
 * discount/rounding/card fields empty — the same set ranap's
 * `buildTampungBayarDtBayar` sends. With only five, the live endpoint answered
 * a PHP "Undefined index" notice and wrote nothing (live run 2026-10-20).
 */
export function buildRajalTampungBayarPayload(args: RajalTampungBayarArgs): Record<string, string> {
  const payment = normalizeRajalPaymentConfig(args.payment);
  const dtBayar = new URLSearchParams({
    cmbshift_pembayaran: payment.shift,
    cmbjenis_pembayaran: payment.type,
    txtdiskonpn_pembayaran: '',
    txtdiskonrp_pembayaran: '',
    txtpembulatan_pembayaran: '',
    cmbkartu_pembayaran: '',
    txtjumlah_pembayaran: args.total,
    txtjmltagihan_pembayaran: args.total,
    txtjmldibayar_pembayaran: args.sudah,
  }).toString();
  return {
    no_reg: args.noReg,
    no_transaksi: args.noTransaksi,
    kd_unit: args.kdUnit,
    ck_retur: 'false',
    kd_penjamin: payment.payerCode,
    dt_bayar: dtBayar,
    tindakan: JSON.stringify(args.tindakanRows),
  };
}

/* ════════════════════════════════════════════════════════════════
 * Batch discovery — `laporan/laporan_belum_bayar/preview`
 *
 * Legacy `doFetch` (source lines 1451-1513) is the only place the userscript
 * decides *which* records a run is about: it GETs the unpaid-bill report,
 * scrapes its HTML table, filters by penjamin and unit, and auto-populates
 * both the patient list and the clinic chips. Everything below is that
 * decision with the fetch hoisted out.
 * ════════════════════════════════════════════════════════════════ */

/** Legacy `INSTALASI_OPTIONS` (source lines 85-88) — the `cmbinstalasi` codes. */
export const RAJAL_INSTALASI_OPTIONS = [
  { code: '1', label: 'Rawat Jalan' },
  { code: '14', label: 'Penunjang' },
  { code: '2', label: 'Rawat Inap' },
  { code: '3', label: 'IGD' },
] as const;

/**
 * Legacy `AUTO_EXCLUDE_SECTIONS` (source lines 91-94). A report section whose
 * name contains one of these is a penunjang/pharmacy grouping, not a clinic —
 * it must never become a clinic chip, and its patients must not be auto-mapped
 * to one.
 */
export const RAJAL_AUTO_EXCLUDE_SECTIONS: readonly string[] = [
  'LABORATORIUM KLINIK',
  'RADIOLOGI',
  'PENUNJANG LAIN',
  'DEPO FARMASI',
  'DEPO KEMOTERAPI',
];

/** Legacy `extractClinicFromSection` (source line 333). */
export function extractRajalClinicFromSection(section: string): string {
  const trimmed = section.trim();
  // `\s+` and the trailing trim: "POLI  DALAM" must give "DALAM", not " DALAM".
  return trimmed.replace(/^POLI\s+/, '').trim();
}

/** Legacy `shouldExcludeSection` (source line 334) — case-insensitive substring. */
export function shouldExcludeRajalSection(section: string): boolean {
  const upper = section.toUpperCase();
  return RAJAL_AUTO_EXCLUDE_SECTIONS.some((excluded) => upper.includes(excluded.toUpperCase()));
}

export interface RajalUnpaidReportQuery {
  /** `cmbinstalasi` — see {@link RAJAL_INSTALASI_OPTIONS}. Legacy defaults '1'. */
  instalasi?: string;
  /** `txtperiode1` — ISO start date. */
  from: string;
  /** `txtperiode2` — ISO end date. */
  to: string;
}

/**
 * Legacy source line 1464 verbatim: every parameter the report URL carries,
 * in the order legacy wrote them. Fourteen of the eighteen are always empty or
 * a fixed flag, but the controller reads them all, so they are sent.
 *
 * This is a **GET**, so the caller must pass the result as `options.query` —
 * the client only form-encodes a body for POSTs, and a GET's body is dropped.
 */
export function buildRajalUnpaidReportQuery(args: RajalUnpaidReportQuery): Record<string, string> {
  return {
    cmbinstalasi: args.instalasi ?? '1',
    cmbunit: '',
    cmbshift: '',
    txtperiode1: args.from,
    txtperiode2: args.to,
    namaunit: '',
    cmbpenjamin: '',
    ckstatus: 'false',
    ckstatustidakbatal: 'true',
    kd_ruangperawatan: '',
    nama_ruangperawatan: '',
    kd_kamarperawatan: '',
    nama_kamarperawatan: '',
    ckbaru: 'false',
    cklama: 'false',
    ckkasusbaru: 'false',
    ckkasuslama: 'false',
    kd_icdx: '',
  };
}

/** One scraped row of the unpaid-bill report. */
export interface RajalUnpaidReportRow {
  /** The report's own sequence number (cell 0). */
  no: number;
  noTransaksi: string;
  noRM: string;
  namaPasien: string;
  penjamin: string;
  /** The unit heading this row sits under. */
  section: string;
}

export interface RajalUnpaidReportStats {
  /** Every data row the table carried, before filtering. */
  total: number;
  /** Rows that survived the penjamin and unit filters. */
  filtered: number;
  bySection: Readonly<Record<string, number>>;
  byPenjamin: Readonly<Record<string, number>>;
}

export interface RajalUnpaidReport {
  /**
   * True when the reply actually contained the report table.
   *
   * Legacy could not tell "the period is empty" from "the request failed": a
   * 500, a login redirect and a genuinely empty period all reach
   * `parseLaporanHTML` as markup with no rows, and `doFetch` reports all three
   * as `⚠️ 0 matched`. The typed client does not surface the HTTP status to a
   * caller either, so the only evidence available is whether the report
   * rendered its `table[border="1"]` at all. No table means "not read", and a
   * batch discovery that could not read its report must never look like a
   * batch with nothing to do.
   */
  readable: boolean;
  /** Rows that passed both filters, in report order. */
  patients: readonly RajalUnpaidReportRow[];
  /** Every section heading seen, in report order, filtered or not. */
  sections: readonly string[];
  stats: RajalUnpaidReportStats;
}

export interface RajalUnpaidReportFilters {
  /** Legacy `cfg-fetch-penjamin`: substring, case-insensitive. */
  penjamin?: string;
  /** Legacy `cfg-fetch-unit`: comma-separated substrings, any may match. */
  unit?: string;
}

/** Legacy `filterUnit.split(/[,]+/)` normalised to upper-case, blanks dropped. */
function unitFilters(unit: string | undefined): string[] {
  return (unit ?? '')
    .split(/[,]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * `Node.textContent` for a fragment of markup, without a DOM. Comments are
 * dropped first — the report ships commented-out `<td>` cells (a real one sits
 * between the discharge time and the sex column), and counting them would
 * shift every column index.
 */
function htmlTextContent(fragment: string): string {
  return fragment
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return HTML_ENTITIES[entity.toLowerCase()] ?? match;
    });
}

/**
 * The `border="1"` table's subtree, matching legacy's
 * `doc.querySelectorAll('table[border="1"]')[0]`. Depth-matched so nested
 * tables are included (a descendant `tr` is still a `tr` to `querySelectorAll`)
 * but a following sibling table is not.
 */
function firstBorderedTable(html: string): string | null {
  const opener = /<table\b[^>]*\bborder\s*=\s*["']?1["']?[^>]*>/i.exec(html);
  if (!opener) return null;
  const start = opener.index + opener[0].length;
  const tags = /<(\/?)table\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index);
  }
  return html.slice(start);
}

/**
 * Legacy `parseLaporanHTML` (source lines 514-538).
 *
 * Hoisted fetch: `laporanBelumBayar.preview` — GET
 * `laporan/laporan_belum_bayar/preview` (see
 * {@link buildRajalUnpaidReportQuery}) → `html`.
 *
 * The table is one flat row list: a `colspan="13"` row carrying a `<b>`/
 * `<strong>` is a unit heading and re-arms `currentSection`; a `colspan="12"`
 * row is a subtotal and is skipped; anything else with at least thirteen cells
 * whose first cell parses as an integer is a patient. Column positions (1 =
 * transaksi, 2 = medrec, 3 = name, 5 = penjamin) are legacy's.
 */
export function parseRajalUnpaidReport(
  html: string,
  filters: RajalUnpaidReportFilters = {},
): RajalUnpaidReport {
  const table = firstBorderedTable(html);
  const stats = {
    total: 0,
    filtered: 0,
    bySection: {} as Record<string, number>,
    byPenjamin: {} as Record<string, number>,
  };
  if (table === null) return { readable: false, patients: [], sections: [], stats };

  const patients: RajalUnpaidReportRow[] = [];
  const sections: string[] = [];
  const penjaminFilter = (filters.penjamin ?? '').trim();
  const unitFilterList = unitFilters(filters.unit);
  let currentSection = '';

  for (const rowMatch of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = (rowMatch[1] ?? '').replace(/<!--[\s\S]*?-->/g, '');

    // `td[colspan="13"] b, td[colspan="13"] strong` — a unit heading.
    const heading = /<td\b[^>]*\bcolspan\s*=\s*["']?13["']?[^>]*>([\s\S]*?)<\/td>/i.exec(rowHtml);
    if (heading) {
      const emphasis = /<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(heading[1] ?? '');
      if (emphasis) {
        currentSection = htmlTextContent(emphasis[2] ?? '').trim();
        if (!sections.includes(currentSection)) sections.push(currentSection);
        continue;
      }
    }
    // A `colspan="12"` subtotal row.
    if (/<td\b[^>]*\bcolspan\s*=\s*["']?12["']?/i.test(rowHtml)) continue;

    const cells = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) =>
      htmlTextContent(cell[1] ?? '').trim(),
    );
    if (cells.length < 13) continue;
    const first = cells[0] ?? '';
    const no = Number.parseInt(first, 10);
    if (!first || Number.isNaN(no)) continue;

    const row: RajalUnpaidReportRow = {
      no,
      noTransaksi: cells[1] ?? '',
      noRM: cells[2] ?? '',
      namaPasien: cells[3] ?? '',
      penjamin: cells[5] ?? '',
      section: currentSection,
    };
    stats.total += 1;
    stats.bySection[currentSection] = (stats.bySection[currentSection] ?? 0) + 1;
    stats.byPenjamin[row.penjamin] = (stats.byPenjamin[row.penjamin] ?? 0) + 1;

    let pass = true;
    if (penjaminFilter) pass = row.penjamin.toUpperCase().includes(penjaminFilter.toUpperCase());
    if (pass && unitFilterList.length > 0) {
      pass = unitFilterList.some((filter) => currentSection.toUpperCase().includes(filter));
    }
    if (pass) {
      patients.push(row);
      stats.filtered += 1;
    }
  }
  return { readable: true, patients, sections, stats };
}

export interface RajalUnpaidBatch {
  /** Carried through from {@link RajalUnpaidReport.readable}. */
  readable: boolean;
  /** `noRM` of every matched row, in report order, duplicates kept. */
  patientIds: readonly string[];
  /** The same list de-duplicated — what legacy counts as the batch size. */
  uniquePatientIds: readonly string[];
  /** Clinic chips derived from the matched, non-excluded section headings. */
  clinics: readonly string[];
  /** Legacy `autoClinicPatientMap`: medrec → the clinics it was seen under. */
  clinicsByPatientId: Readonly<Record<string, readonly string[]>>;
  /** Section headings that were skipped as penunjang/pharmacy groupings. */
  excludedSections: readonly string[];
  stats: RajalUnpaidReportStats;
}

/**
 * Legacy `doFetch` (source lines 1470-1495) — what the operator's batch
 * *becomes* once the report has been read.
 *
 * The patient list is every matched row's medrec, duplicates and all (legacy
 * writes `rmList` into the textarea and only counts `uniqueRM` separately).
 * The clinic chips come from the section headings, re-filtered by `unit`
 * because a heading is not a row, and `mergeAutoClinicPatients` (source line
 * 361) records which clinic each medrec came from so removing a chip can
 * remove exactly its patients again. Excluded sections contribute neither.
 */
export function selectRajalUnpaidBatch(
  report: RajalUnpaidReport,
  filters: RajalUnpaidReportFilters = {},
): RajalUnpaidBatch {
  const patientIds = report.patients.map((row) => row.noRM.trim()).filter(Boolean);
  const unitFilterList = unitFilters(filters.unit);
  const matchedSections = report.sections.filter(
    (section) =>
      unitFilterList.length === 0 ||
      unitFilterList.some((filter) => section.toUpperCase().includes(filter)),
  );
  const excludedSections = matchedSections.filter(shouldExcludeRajalSection);
  const clinics = [
    ...new Set(
      matchedSections
        .filter((section) => !shouldExcludeRajalSection(section))
        .map(extractRajalClinicFromSection)
        .filter(Boolean),
    ),
  ];

  const clinicsByPatientId: Record<string, string[]> = {};
  for (const row of report.patients) {
    if (!row.section || shouldExcludeRajalSection(row.section)) continue;
    const clinic = extractRajalClinicFromSection(row.section);
    const noRM = row.noRM.trim();
    if (!clinic || !noRM) continue;
    const bucket = clinicsByPatientId[noRM] ?? (clinicsByPatientId[noRM] = []);
    if (!bucket.includes(clinic)) bucket.push(clinic);
  }

  return {
    readable: report.readable,
    patientIds,
    uniquePatientIds: [...new Set(patientIds)],
    clinics,
    clinicsByPatientId,
    excludedSections,
    stats: report.stats,
  };
}
