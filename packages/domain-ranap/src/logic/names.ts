/**
 * Deterministic charge-name / unit-name / person-name classifiers.
 *
 * Ported one-for-one from the legacy `ranap_v3.py`. Every predicate here
 * encodes hospital billing knowledge as a literal Indonesian keyword list:
 * the lists decide whether a charge is a room charge, whether it may be
 * deleted, whether a room outranks another when two stays overlap a day, and
 * which units must never be swept into `tampung bayar`. A dropped or
 * re-spelled keyword is a real billing bug, so every list is hoisted to an
 * exported SCREAMING_SNAKE_CASE constant and pinned by tests instead of being
 * retyped at each call site.
 *
 * Two things about this port are load-bearing:
 *
 *  1. **Normalisation is part of each contract.** The Python mixes three
 *     forms — a raw `str(x or "").upper()`, `_normalize_text_key` (punctuation
 *     collapsed to single spaces), and `_compact_text_key` (punctuation and
 *     whitespace removed). Which one a predicate uses is observable, so the
 *     three forms are reproduced privately below and applied exactly where the
 *     Python applies them.
 *  2. **Check order is preserved** wherever an early return changes the
 *     answer — most visibly in `isRoomChargeName`, where the
 *     "BIAYA KAMAR"/"SEWA KAMAR"/"AKOMODASI" hit wins *before* the blocked
 *     token sweep can veto it.
 *
 * Everything here is pure: no network, no clock, no mutable module state.
 * Rows are read through the coercing accessors in `./types.js`.
 */

import type { LegacyRow } from './types.js';
import { str } from './types.js';

// ---------------------------------------------------------------------------
// Keyword lists and lookup tables (module-level so tests can pin them)
// ---------------------------------------------------------------------------

/**
 * `BIAYA …` prefixes that are *not* room charges. `_is_room_charge_name` only
 * consults this list after the name already starts with `BIAYA `.
 */
export const ROOM_CHARGE_BLOCKED_TOKENS: readonly string[] = [
  'POLIKLINIK',
  'UGD',
  'IGD',
  'LABORATORIUM',
  'RADIOLOGI',
  'HEMODIALISA',
  'HEMODIALISIS',
  'HAEMODIALISA',
  'HAEMODIALISIS',
  'DIALISIS',
  'ELEKTROMEDIK',
  'OBAT',
  'ADMINISTRASI',
  'BANK DARAH',
  'CATHLAB',
  'DOKTER',
  'JASA',
  'TINDAKAN',
  'GIZI',
  'DIIT',
  'IBS',
  'BEDAH SENTRAL',
  'PENUNJANG',
  'OPERASI',
];

/** Exact (whitespace-collapsed, uppercased) jasa-pelayanan name → care class. */
export const JASA_CATEGORY_CLASS_BY_NAME: Readonly<Record<string, string>> = {
  'JASA PELAYANAN KAT 1': 'KELAS 1',
  'JASA PELAYANAN KAT 2': 'KELAS 2',
  'JASA PELAYANAN KAT 3': 'KELAS 3',
};

/** Name prefixes that mark a charge as originating in IGD/UGD. */
export const IGD_ORIGIN_CHARGE_PREFIXES: readonly string[] = ['BIAYA UGD', 'BIAYA IGD KEBIDANAN'];

/** Hemodialysis charge spellings that flag an IGD source transaction. */
export const IGD_HEMODIALYSIS_TOKENS: readonly string[] = [
  'BIAYA HEMODIALISA',
  'BIAYA HEMODIALISIS',
  'BIAYA HAEMODIALISA',
  'BIAYA HAEMODIALISIS',
  'HAEMODIALISA CITO',
  'HEMODIALISA CITO',
];

/** Name prefixes for an IGD/UGD doctor fee line. */
export const IGD_DOCTOR_PREFIXES: readonly string[] = ['DOKTER IGD', 'DOKTER UGD'];

/** Substrings that put a "jasa pelayanan/pelawatan" line in an IGD context. */
export const IGD_JASA_CONTEXT_TOKENS: readonly string[] = [
  'PERAWAT IGD',
  'PERAWAT UGD',
  'BIDAN IGD',
  'BIDAN UGD',
  ' IGD',
  ' UGD',
];

/** Charges the pipeline must never delete (checked as substrings). */
export const PROTECTED_NON_DELETABLE_CHARGE_NAMES: readonly string[] = [
  'BIAYA CATHLAB',
  'BIAYA BEDAH SENTRAL',
  'BIAYA POLIKLINIK',
  'BIAYA RADIOLOGI',
  'BIAYA PENUNJANG ELEKTROMEDIK',
  'BIAYA LABORATORIUM',
  'BIAYA LABORATORIUM PA',
  'BIAYA HEMODIALISA',
  'BIAYA HEMODIALISIS',
  'BIAYA HAEMODIALISA',
  'BIAYA HAEMODIALISIS',
  'BIAYA OBAT',
];

/** Name prefixes for a partus (delivery) doctor action. */
export const PARTUS_DOCTOR_ACTION_PREFIXES: readonly string[] = ['PARTUS', 'TINDAKAN PARTUS'];

/** Critical-care room classes — rank 3 when resolving an overlapping day. */
export const CRITICAL_CARE_ROOM_CLASSES: readonly string[] = [
  'ICU',
  'ICCU',
  'HCU',
  'NICU',
  'PICU',
  'SCN',
];

/** Room classes that trip the premium-room payment guard. */
export const PREMIUM_ROOM_PAYMENT_GUARD_CLASSES: readonly string[] = ['VIP', 'VVIP'];

/** Units that must never be swept into `tampung bayar`. */
export const EXCLUDED_TAMPUNG_BAYAR_TOKENS: readonly string[] = [
  'AMBULANCE',
  'INSTALASI KAMAR JENAZAH',
  'INSTALASI JENAZAH',
];

/** Role prefixes stripped off a room paramedis label before matching. */
export const ROOM_ROLE_PREFIXES: readonly string[] = ['PERAWAT ', 'BIDAN ', 'RUANG '];

/** Consumables/parenterals that are never "take home" medication. */
export const TAKE_HOME_MED_BLOCKED_TOKENS: readonly string[] = [
  'INFUS',
  'INJ',
  'INJEKSI',
  'CATHETER',
  'KATETER',
  'DRESSING',
  'SWAB',
  'PLESTER',
  'SARUNG TANGAN',
  'SET ',
  ' BLOOD ',
  'TRITON',
  'IODINE',
  'AQUABIDES',
  'OXYTOCIN',
  'METHYLERGOMETRIN',
  'ONDANSETRON',
  'CEFAZOLIN',
  'GENTAMYCIN INJ',
  'PARACETAMOL 1000MG/100ML INFUS',
  'METRONIDAZOL 500MG/100ML INFUS',
  'ASAM TRANEKSAMAT 500MG INJ',
  'BUPIVACAIN',
  'SPINAL INJ',
  'LIQUID',
  'PLAIN',
  'CHROMIC',
  'VIO ',
  'VOLULYTE',
];

/**
 * Dosage forms that mark a medication as "take home". Matched against the
 * name padded with a leading and trailing space, so a form at either end of
 * the name still hits its leading-space token.
 */
export const TAKE_HOME_MED_INCLUDE_TOKENS: readonly string[] = [
  ' TAB',
  ' TABLET',
  ' CAPS',
  ' CAP ',
  ' KAPLET',
  ' SYRUP',
  ' SIRUP',
  ' SUSP',
  ' DROP',
  ' DROPS',
  ' PUYER',
  ' CREAM',
  ' SALEP',
  ' OINTMENT',
  ' SUPPOS',
  ' SUPP',
];

/**
 * A visit row that can be the IGD admission source: a `02-` transaction, or a
 * unit named IGD that is not a drug depot. "DEPO IGD" (`21-…`) shares the IGD
 * registration and used to win the score tie-break on its higher transaction
 * number, so the pipeline treated the depot order as the IGD bill — reporting
 * "IGD sudah tertransfer" and hiding the still-hanging depot order
 * (live 2026-10-21, 0-90-00-06 and 0-90-00-07).
 */
export function isIgdSourceCandidate(row: LegacyRow): boolean {
  const trx = str(row, 'no_transaksi');
  if (!trx) return false;
  if (trx.startsWith('02-')) return true;
  const unit = normalizeTextKey(str(row, 'nama_unit'));
  return unit.includes('IGD') && !unit.includes('DEPO') && !unit.includes('FARMASI');
}

/** Unit-name tokens that mark a transaction as needing manual follow-up. */
export const MANUAL_FOLLOWUP_UNIT_TOKENS: readonly string[] = [
  'DEPO',
  'FARMASI',
  'BANK DARAH',
  'CATHLAB',
  'RADIOLOGI',
  'LAB',
  'AMBULANCE',
  'JENAZAH',
  'HEMODIALISA',
  'HEMODIALISIS',
  'HAEMODIALISA',
  'HAEMODIALISIS',
  'DIALISIS',
  'PATOLOGI',
  'PA',
  'GIZI',
  'ELEKTROMEDIK',
  'PENUNJANG',
  'IBS',
  'OK',
];

/** `no_transaksi` prefixes that mark a transaction as needing manual follow-up. */
export const MANUAL_FOLLOWUP_TRANSAKSI_PREFIXES: readonly string[] = [
  '04-',
  '13-',
  '18-',
  '19-',
  '51-',
  '52-',
  '53-',
  '54-',
  '55-',
];

/**
 * Diagnoses that mean "healthy newborn". Compared for **exact** equality
 * against the normalised key, not as substrings.
 */
export const BYNY_HEALTHY_DIAGNOSIS_TOKENS: readonly string[] = [
  'SEHAT',
  'BAYI SEHAT',
  'NEONATUS SEHAT',
  'BAYI BARU LAHIR NORMAL',
  'BAYI BARU LAHIR SEHAT',
  'NEONATUS ATERM',
  'RAWAT GABUNG',
];

/** Diagnosis substrings that mean the newborn is sick (billed separately). */
export const BYNY_SICK_DIAGNOSIS_TOKENS: readonly string[] = [
  'ASFIKSIA',
  'SEPSIS',
  'IKTERUS',
  'HIPERBILIRUBIN',
  'PREMATUR',
  'PREMATURITAS',
  'BBLR',
  'RDS',
  'PNEUMONIA',
  'FEBRIS',
  'FEEDING PROBLEM',
  'FEEDING',
  'VOMITUS',
  'VOMITING',
  'MUNTAH',
  'REGURGITASI',
  'ASPIRASI',
  'INTOLERANSI',
  'INTOLERANCE',
  'GANGGUAN MINUM',
  'SULIT MINUM',
  'HIPOKSIA',
  'RESPIRATORY',
  'KONVULSI',
  'KEJANG',
  'INFEKSI',
  'SAKIT',
  'KELAINAN',
  'DISTRESS',
  'SYNDROME',
  'GANGGUAN',
  'ANOMALI',
  'HERNIA',
  'ATRESIA',
  'NEKROSIS',
  'OMFALOKEL',
  'MENINGITIS',
];

/** Compact `status_bayar` keys that mean the visit is still unpaid. */
export const UNPAID_KUNJUNGAN_STATUS_KEYS: readonly string[] = [
  '',
  'BELUM',
  'BELUMBAYAR',
  'OPEN',
];

/** Default penjamin (payer) filter for the ranap sweep. */
export const DEFAULT_ACCEPTED_PENJAMIN_KEYWORDS: readonly string[] = ['BPJS PBI', 'BPJS NON PBI'];

/** `kd_kelasperawatan` → care class label. */
export const CARE_CLASS_BY_KD: Readonly<Record<string, string>> = {
  '1': 'VIP',
  '2': 'KELAS 1',
  '3': 'KELAS 2',
  '4': 'KELAS 3',
  '6': 'NICU',
  '8': 'ICU',
  '9': 'VVIP',
  '10': 'HCU',
  '11': 'ISOLASI',
  '12': 'DELUXE',
  '13': 'NON KELAS',
  '14': 'PICU',
  '15': 'BERSALIN',
  '16': 'ICCU',
};

/** Care-class ordering used as the last tiebreak when picking a jasa class. */
export const CARE_CLASS_RANK: Readonly<Record<string, number>> = {
  'KELAS 3': 1,
  'KELAS 2': 2,
  'KELAS 1': 3,
  VIP: 4,
  VVIP: 5,
};

// ---------------------------------------------------------------------------
// Private text normalisation — the three Python forms, reproduced
// ---------------------------------------------------------------------------

/**
 * `str(value or "")`. Python treats `0`, `False`, `""`, `[]` and `{}` as
 * falsy, so all of them collapse to the empty string before comparison.
 */
function pyStr(value: unknown): string {
  if (value === undefined || value === null || value === false || value === '') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value === 0 || Number.isNaN(value) ? '' : String(value);
  if (value === true) return 'True';
  if (Array.isArray(value)) return value.length === 0 ? '' : String(value);
  if (typeof value === 'object' && Object.keys(value as object).length === 0) return '';
  return String(value);
}

/** `str(x or "").upper()` — no punctuation handling at all. */
function rawUpper(value: unknown): string {
  return pyStr(value).toUpperCase();
}

/** `_normalize_text_key`: uppercase, non-alphanumerics → single space, trim. */
function normalizeTextKey(value: unknown): string {
  return pyStr(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** `_compact_text_key`: uppercase, drop every non-alphanumeric. */
function compactTextKey(value: unknown): string {
  return pyStr(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

/** `" ".join(str(x or "").upper().split())` — collapse whitespace runs only. */
function collapseUpper(value: unknown): string {
  return rawUpper(value)
    .split(/\s+/)
    .filter((part) => part !== '')
    .join(' ');
}

/** `_safe_int`: `int(str(value).strip())` or the fallback. */
function safeInt(value: unknown, fallback: number): number {
  const text = String(value ?? '').trim();
  if (!/^[+-]?\d+$/.test(text)) return fallback;
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// ---------------------------------------------------------------------------
// Private date helpers (only `resolveExistingJasaCategoryClass` needs them)
// ---------------------------------------------------------------------------

/**
 * `datetime.min` / `datetime.max` stand-ins. The Python uses them purely as
 * sort sentinels, so ±Infinity reproduces every comparison it makes.
 */
const DATETIME_MIN = Number.NEGATIVE_INFINITY;
const DATETIME_MAX = Number.POSITIVE_INFINITY;

const MONTH_ABBREVIATIONS: readonly string[] = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

/**
 * Build an epoch-ms timestamp, rejecting anything `datetime()` would reject
 * (bad month, bad day-of-month, hour > 23, minute/second > 59, year < 1).
 * UTC throughout so `formatDatePart` round-trips without a timezone shift.
 */
function utcEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date.getTime();
}

function monthFromAbbreviation(text: string): number {
  return MONTH_ABBREVIATIONS.indexOf(text.toUpperCase()) + 1;
}

/** `%Y-%m-%d` with an optional ` %H:%M:%S` tail. */
const RE_YMD = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}):(\d{1,2}))?$/;
/** `%Y/%m/%d` (date only — `_parse_date_flexible` is the only user). */
const RE_YMD_SLASH = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
/** `%d %b %Y` with an optional ` %H:%M:%S` tail. */
const RE_DMY_ABBR_SPACE =
  /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:\s+(\d{1,2}):(\d{1,2}):(\d{1,2}))?$/;
/** `%d-%b-%Y` with an optional ` %H:%M:%S` tail. */
const RE_DMY_ABBR_DASH = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{1,2}):(\d{1,2}):(\d{1,2}))?$/;
/** `%d-%m-%Y` with an optional ` %H:%M:%S` tail. */
const RE_DMY = /^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2}):(\d{1,2}):(\d{1,2}))?$/;

function fromYmdMatch(match: RegExpMatchArray): number | undefined {
  return utcEpoch(
    safeInt(match[1], -1),
    safeInt(match[2], -1),
    safeInt(match[3], -1),
    safeInt(match[4] ?? '0', -1),
    safeInt(match[5] ?? '0', -1),
    safeInt(match[6] ?? '0', -1),
  );
}

function fromDmyMatch(match: RegExpMatchArray, monthIsAbbreviation: boolean): number | undefined {
  const month = monthIsAbbreviation
    ? monthFromAbbreviation(match[2] ?? '')
    : safeInt(match[2], -1);
  return utcEpoch(
    safeInt(match[3], -1),
    month,
    safeInt(match[1], -1),
    safeInt(match[4] ?? '0', -1),
    safeInt(match[5] ?? '0', -1),
    safeInt(match[6] ?? '0', -1),
  );
}

/** `_parse_datetime_flexible` — epoch ms, or `undefined` for "None". */
function parseDatetimeFlexible(value: unknown): number | undefined {
  const raw = pyStr(value);
  if (!raw) return undefined;
  const text = raw.trim();

  const ymd = RE_YMD.exec(text);
  if (ymd) {
    const parsed = fromYmdMatch(ymd);
    if (parsed !== undefined) return parsed;
  }
  const abbrSpace = RE_DMY_ABBR_SPACE.exec(text);
  if (abbrSpace) {
    const parsed = fromDmyMatch(abbrSpace, true);
    if (parsed !== undefined) return parsed;
  }
  const abbrDash = RE_DMY_ABBR_DASH.exec(text);
  if (abbrDash) {
    const parsed = fromDmyMatch(abbrDash, true);
    if (parsed !== undefined) return parsed;
  }
  const dmy = RE_DMY.exec(text);
  if (dmy) {
    const parsed = fromDmyMatch(dmy, false);
    if (parsed !== undefined) return parsed;
  }
  if (text.length >= 19) {
    const truncated = RE_YMD.exec(text.slice(0, 19));
    if (truncated) return fromYmdMatch(truncated);
  }
  return undefined;
}

/**
 * `_parse_date_flexible`. The Python truncates the input to
 * `len(datetime.now().strftime(fmt))` before parsing; those lengths are
 * constant (10 for the numeric formats, 11 for the `%b` ones) because
 * `%d`/`%m` are zero-padded and `%b` is always three characters — so the
 * clock read is inert and the truncation lengths are inlined here.
 */
function parseDateFlexible(value: unknown): number | undefined {
  const raw = pyStr(value);
  if (!raw) return undefined;
  const text = raw.trim();

  const ymd = RE_YMD.exec(text.slice(0, 10));
  if (ymd) {
    const parsed = fromYmdMatch(ymd);
    if (parsed !== undefined) return parsed;
  }
  const dmy = RE_DMY.exec(text.slice(0, 10));
  if (dmy) {
    const parsed = fromDmyMatch(dmy, false);
    if (parsed !== undefined) return parsed;
  }
  const slash = RE_YMD_SLASH.exec(text.slice(0, 10));
  if (slash) {
    const parsed = fromYmdMatch(slash);
    if (parsed !== undefined) return parsed;
  }
  const abbrDash = RE_DMY_ABBR_DASH.exec(text.slice(0, 11));
  if (abbrDash) {
    const parsed = fromDmyMatch(abbrDash, true);
    if (parsed !== undefined) return parsed;
  }
  const abbrSpace = RE_DMY_ABBR_SPACE.exec(text.slice(0, 11));
  if (abbrSpace) {
    const parsed = fromDmyMatch(abbrSpace, true);
    if (parsed !== undefined) return parsed;
  }
  return parseDatetimeFlexible(text);
}

function formatDatePart(epochMs: number): string {
  const date = new Date(epochMs);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** `_date_part`: normalise to `YYYY-MM-DD`, or fall back to the first 10 chars. */
function datePart(value: unknown): string {
  const raw = pyStr(value);
  if (!raw) return '';
  const parsed = parseDatetimeFlexible(value) ?? parseDateFlexible(value);
  if (parsed !== undefined) return formatDatePart(parsed);
  return raw.trim().slice(0, 10);
}

/** `_sorted_rows`: by `tgl_jam`/`tgl_transaksi` then `urut_tindakan`, stable. */
function sortedRows(rows: readonly LegacyRow[]): LegacyRow[] {
  return rows
    .map((row, index) => ({
      row,
      index,
      dt: parseDatetimeFlexible(str(row, 'tgl_jam', 'tgl_transaksi')) ?? DATETIME_MAX,
      urut: safeInt(row['urut_tindakan'], 0),
    }))
    .sort((a, b) => {
      if (a.dt !== b.dt) return a.dt < b.dt ? -1 : 1;
      if (a.urut !== b.urut) return a.urut - b.urut;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

// ---------------------------------------------------------------------------
// Private care-class helpers (inputs to the room predicates)
// ---------------------------------------------------------------------------

/** `_normalize_care_class_key`: any room/class label → a canonical class. */
function normalizeCareClassKey(value: unknown): string {
  const raw = pyStr(value).trim();
  if (!raw) return '';
  const compact = compactTextKey(raw);
  if (compact.startsWith('ISO')) return 'ISOLASI';
  if (['3', 'III', 'KELAS3', 'KELASIII', 'KELAS_3', 'KELASIIIA'].includes(compact)) return 'KELAS 3';
  if (['2', 'II', 'KELAS2', 'KELASII', 'KELAS_2'].includes(compact)) return 'KELAS 2';
  if (['1', 'I', 'KELAS1', 'KELASI', 'KELAS_1'].includes(compact)) return 'KELAS 1';
  if (compact === 'VIP') return 'VIP';
  if (['VVIP', 'VVP'].includes(compact)) return 'VVIP';
  if (
    [
      'ICU',
      'NICU',
      'PICU',
      'HCU',
      'SCN',
      'ISOLASI',
      'DELUXE',
      'BERSALIN',
      'NONKELAS',
      'ICCU',
    ].includes(compact)
  ) {
    return compact === 'NONKELAS' ? 'NON KELAS' : compact;
  }

  const key = normalizeTextKey(raw);
  if (key.includes('VVIP')) return 'VVIP';
  if (key.includes('VIP')) return 'VIP';
  if (key.includes('SCN')) return 'SCN';
  if (key.includes('NICU')) return 'NICU';
  if (key.includes('PICU')) return 'PICU';
  if (key.includes('ICCU')) return 'ICCU';
  if (key.includes('ICU')) return 'ICU';
  if (key.includes('HCU')) return 'HCU';
  if (/(^|\s)ISO($|\s)/.test(key)) return 'ISOLASI';
  if (key.includes('ISOLASI')) return 'ISOLASI';
  if (key.includes('DELUXE')) return 'DELUXE';
  if (key.includes('BERSALIN')) return 'BERSALIN';
  if (key.includes('NON KELAS')) return 'NON KELAS';
  if (key.includes('KELAS III') || key.includes('KELAS 3')) return 'KELAS 3';
  if (key.includes('KELAS II') || key.includes('KELAS 2')) return 'KELAS 2';
  if (
    (key.includes('KELAS I') && !key.includes('KELAS II') && !key.includes('KELAS III')) ||
    key.includes('KELAS 1')
  ) {
    return 'KELAS 1';
  }
  return '';
}

/** `_extract_room_class_key`: `kd_kelasperawatan` first, then name fallbacks. */
function extractRoomClassKey(row: LegacyRow): string {
  const kdKelasperawatan = str(row, 'kd_kelasperawatan');
  const mapped = CARE_CLASS_BY_KD[kdKelasperawatan];
  if (mapped !== undefined) return mapped;
  for (const key of ['nama_unit', 'nama_ruangperawatan', 'nama_ruangpendek', 'kd_kelas_bpjs']) {
    const kelasKey = normalizeCareClassKey(row[key]);
    if (kelasKey) return kelasKey;
  }
  return '';
}

/** `_care_class_rank`. */
function careClassRank(kelasKey: unknown): number {
  return CARE_CLASS_RANK[pyStr(kelasKey).trim()] ?? 0;
}

// ---------------------------------------------------------------------------
// Charge-name classifiers
// ---------------------------------------------------------------------------

/**
 * `_is_room_charge_name` — is this line the daily room/board charge?
 *
 * An explicit "BIAYA KAMAR" / "SEWA KAMAR" / "AKOMODASI …KAMAR|RUANG" hit
 * returns true *before* the blocked-token sweep, so "BIAYA KAMAR IGD" still
 * counts as a room charge even though "IGD" is blocked.
 */
export function isRoomChargeName(name: unknown): boolean {
  const nama = normalizeTextKey(name);
  if (
    nama.includes('BIAYA KAMAR') ||
    nama.includes('SEWA KAMAR') ||
    (nama.includes('AKOMODASI') && (nama.includes('KAMAR') || nama.includes('RUANG')))
  ) {
    return true;
  }
  if (!nama.startsWith('BIAYA ')) return false;
  return !ROOM_CHARGE_BLOCKED_TOKENS.some((token) => nama.includes(token));
}

/**
 * `_is_jasa_name` — a service-fee line. Deliberately checks the *raw*
 * uppercase name, so "JASA  PELAYANAN" (double space) does not match.
 */
export function isJasaName(name: unknown): boolean {
  return rawUpper(name).includes('JASA PELAYANAN');
}

/** `_extract_jasa_category_class` — "JASA PELAYANAN KAT 2" → "KELAS 2". */
export function extractJasaCategoryClass(name: unknown): string {
  return JASA_CATEGORY_CLASS_BY_NAME[collapseUpper(name)] ?? '';
}

/**
 * `_resolve_existing_jasa_category_class` — infer the care class already in
 * use from the jasa-pelayanan lines already on the bill.
 *
 * Two passes: first restricted to `targetDates` (skipped if that leaves
 * nothing), then unrestricted. Within a pass the winner is the class with the
 * most lines, then the latest line, then the highest care-class rank; ties
 * fall back to first-seen order, matching Python's stable `sorted(reverse=True)`.
 */
export function resolveExistingJasaCategoryClass(
  listRows: readonly LegacyRow[],
  targetDates?: readonly string[],
): string {
  interface CategorizedRow {
    classKey: string;
    rowDate: string;
    rowDt: number;
  }

  const categorizedRows: CategorizedRow[] = [];
  for (const row of sortedRows(listRows ?? [])) {
    const namaTindakan = str(row, 'nama_tindakan');
    if (!isJasaName(namaTindakan)) continue;
    const classKey = extractJasaCategoryClass(namaTindakan);
    if (!classKey) continue;
    const rawDate = str(row, 'tgl_jam', 'tgl_transaksi');
    categorizedRows.push({
      classKey,
      rowDate: datePart(rawDate),
      rowDt: parseDatetimeFlexible(rawDate) ?? DATETIME_MIN,
    });
  }
  if (categorizedRows.length === 0) return '';

  const targetDatesSet = new Set(
    (targetDates ?? []).map((item) => String(item ?? '').trim()).filter((item) => item !== ''),
  );

  for (const restrictToTarget of [true, false]) {
    let relevantRows = categorizedRows;
    if (restrictToTarget && targetDatesSet.size > 0) {
      relevantRows = categorizedRows.filter((row) => targetDatesSet.has(row.rowDate.trim()));
      if (relevantRows.length === 0) continue;
    }
    const scoreByClass = new Map<string, { count: number; latestDt: number }>();
    for (const row of relevantRows) {
      const classKey = row.classKey.trim();
      if (!classKey) continue;
      let current = scoreByClass.get(classKey);
      if (!current) {
        current = { count: 0, latestDt: DATETIME_MIN };
        scoreByClass.set(classKey, current);
      }
      current.count += 1;
      if (row.rowDt > current.latestDt) current.latestDt = row.rowDt;
    }
    if (scoreByClass.size > 0) {
      const ranked = [...scoreByClass.entries()].sort((a, b) => {
        if (a[1].count !== b[1].count) return a[1].count < b[1].count ? 1 : -1;
        if (a[1].latestDt !== b[1].latestDt) return a[1].latestDt < b[1].latestDt ? 1 : -1;
        const rankA = careClassRank(a[0]);
        const rankB = careClassRank(b[0]);
        if (rankA !== rankB) return rankA < rankB ? 1 : -1;
        return 0;
      });
      return ranked[0]?.[0] ?? '';
    }
  }
  return '';
}

/** `_is_igd_origin_charge_name` — the charge was raised in IGD/UGD. */
export function isIgdOriginChargeName(name: unknown): boolean {
  const nama = normalizeTextKey(name);
  return IGD_ORIGIN_CHARGE_PREFIXES.some((prefix) => nama.startsWith(prefix));
}

/** `_is_igd_hemodialysis_name` — a hemodialysis line, in any of its spellings. */
export function isIgdHemodialysisName(name: unknown): boolean {
  const nama = normalizeTextKey(name);
  return IGD_HEMODIALYSIS_TOKENS.some((token) => nama.includes(token));
}

/** `_is_igd_doctor_name` — the IGD/UGD doctor fee line. */
export function isIgdDoctorName(name: unknown): boolean {
  const nama = normalizeTextKey(name);
  return IGD_DOCTOR_PREFIXES.some((prefix) => nama.startsWith(prefix));
}

/**
 * `_is_igd_jasa_pelayanan_name` — an IGD service fee.
 *
 * Requires a jasa token ("JASA PELAYANAN" or the legacy misspelling
 * "JASA PELAWATAN"), then either an IGD context token or a triage level.
 * The level is extracted from the *original* name, not the normalised key.
 */
export function isIgdJasaPelayananName(name: unknown): boolean {
  const nama = normalizeTextKey(name);
  if (!nama) return false;
  const hasJasa = nama.includes('JASA PELAYANAN') || nama.includes('JASA PELAWATAN');
  if (!hasJasa) return false;
  const level = extractIgdLevel(name);
  const hasIgdContext = IGD_JASA_CONTEXT_TOKENS.some((token) => nama.includes(token));
  return Boolean(hasIgdContext || level);
}

/** `_extract_igd_level` — the triage level digit out of "… P 2 …", or "". */
export function extractIgdLevel(name: unknown): string {
  const match = /\bP\s*([123])\b/.exec(rawUpper(name));
  return match?.[1] ?? '';
}

/**
 * `_is_protected_non_deletable_charge` — the charge must survive cleanup.
 *
 * Order matters: oksigen and IGD-origin charges short-circuit before the
 * substring sweep over `PROTECTED_NON_DELETABLE_CHARGE_NAMES`.
 */
export function isProtectedNonDeletableCharge(name: unknown): boolean {
  if (isOksigenBhpName(name)) return true;
  if (isIgdOriginChargeName(name)) return true;
  const nama = normalizeTextKey(name);
  return PROTECTED_NON_DELETABLE_CHARGE_NAMES.some((protectedName) => nama.includes(protectedName));
}

/** `_is_biaya_diit_gizi_name` — the nutrition/diet charge. */
export function isBiayaDiitGiziName(name: unknown): boolean {
  return normalizeTextKey(name).includes('BIAYA DIIT GIZI');
}

/** `_is_dpjb_name` — the attending-physician (DPJP/DPJB) fee line. */
export function isDpjbName(name: unknown): boolean {
  const nama = rawUpper(name);
  return nama.includes('DOKTER') && (nama.includes('DPJB') || nama.includes('DPJP'));
}

/** `_is_oksigen_bhp_name` — oxygen consumable. */
export function isOksigenBhpName(name: unknown): boolean {
  return rawUpper(name).includes('OKSIGEN');
}

/** `_is_biaya_administrasi_name` — exactly the administration charge. */
export function isBiayaAdministrasiName(name: unknown): boolean {
  return normalizeTextKey(name) === 'ADMINISTRASI';
}

/** `_is_visite_spesialis_name` — a specialist ward round. */
export function isVisiteSpesialisName(name: unknown): boolean {
  return rawUpper(name).includes('VISITE DOKTER SPESIALIS');
}

/** `_is_visite_dr_anak_scn_name` — the paediatrician SCN ward round. */
export function isVisiteDrAnakScnName(name: unknown): boolean {
  return rawUpper(name).includes('VISITE DR ANAK SCN');
}

/** `_is_konsultasi_telepon_name` — a telephone consultation. */
export function isKonsultasiTeleponName(name: unknown): boolean {
  return rawUpper(name).includes('KONSULTASI DOKTER SPESIALIS LEWAT TELEPON');
}

/** `_is_partus_doctor_action_name` — a delivery action billed to a doctor. */
export function isPartusDoctorActionName(name: unknown): boolean {
  const nama = collapseUpper(name);
  return PARTUS_DOCTOR_ACTION_PREFIXES.some((prefix) => nama.startsWith(prefix));
}

/** `_is_biaya_ibs_name` — a surgical-suite (IBS / bedah sentral / cathlab) charge. */
export function isBiayaIbsName(name: unknown): boolean {
  const nama = rawUpper(name);
  return (
    nama.includes('BEDAH SENTRAL') ||
    (nama.includes('IBS') && nama.includes('BIAYA')) ||
    (nama.includes('CATHLAB') && nama.includes('BIAYA'))
  );
}

/** `_is_depo_ibs_name` — a surgical-suite pharmacy depot line. */
export function isDepoIbsName(name: unknown): boolean {
  return rawUpper(name).includes('DEPO IBS');
}

/**
 * `_looks_like_take_home_med_name` — is this drug plausibly discharge
 * medication (obat pulang) rather than a ward consumable?
 *
 * Blocked tokens are matched against the bare key; include tokens are matched
 * against the key padded with a space on each side, which is how a leading-space
 * token like " TAB" can still fire on a name that starts with the dosage form.
 */
export function looksLikeTakeHomeMedName(name: unknown): boolean {
  const nama = normalizeTextKey(name);
  if (!nama) return false;
  if (TAKE_HOME_MED_BLOCKED_TOKENS.some((token) => nama.includes(token))) return false;
  const padded = ` ${nama} `;
  return TAKE_HOME_MED_INCLUDE_TOKENS.some((token) => padded.includes(token));
}

// ---------------------------------------------------------------------------
// Unit / room classifiers
// ---------------------------------------------------------------------------

/** `_is_icu_room_name`. */
export function isIcuRoomName(unit: unknown): boolean {
  return normalizeTextKey(unit).includes('ICU');
}

/**
 * `_get_overlap_room_priority_rank` — which room wins a day two stays share.
 * 3 = critical care, 2 = isolation, 0 = ordinary ward.
 */
export function getOverlapRoomPriorityRank(unit: unknown): number {
  const roomKey = normalizeTextKey(unit);
  const roomClass = normalizeCareClassKey(unit);
  if (CRITICAL_CARE_ROOM_CLASSES.includes(roomClass)) return 3;
  if (CRITICAL_CARE_ROOM_CLASSES.some((token) => roomKey.includes(token))) return 3;
  if (roomClass === 'ISOLASI' || roomKey.includes('ISOLASI')) return 2;
  return 0;
}

/** `_is_priority_overlap_room_name`. */
export function isPriorityOverlapRoomName(unit: unknown): boolean {
  return getOverlapRoomPriorityRank(unit) > 0;
}

/** `_is_multazam_platinum_room_name`. */
export function isMultazamPlatinumRoomName(unit: unknown): boolean {
  return normalizeTextKey(unit).includes('MULTAZAM PLATINUM');
}

/**
 * `_is_premium_room_for_payment_guard` — block automatic payment for premium
 * rooms. Falls back to a synthetic `{ nama_unit }` row when no row (or an
 * empty one, which Python treats as falsy) is supplied.
 */
export function isPremiumRoomForPaymentGuard(unit: unknown, row?: LegacyRow): boolean {
  const roomName = pyStr(unit).trim();
  if (isMultazamPlatinumRoomName(roomName)) return true;
  const source: LegacyRow =
    row && Object.keys(row).length > 0 ? row : { nama_unit: roomName };
  const roomClass = extractRoomClassKey(source);
  return PREMIUM_ROOM_PAYMENT_GUARD_CLASSES.includes(roomClass);
}

/** `_is_excluded_tampung_bayar_unit`. */
export function isExcludedTampungBayarUnit(unit: unknown): boolean {
  const unitKey = normalizeTextKey(unit);
  if (!unitKey) return false;
  return EXCLUDED_TAMPUNG_BAYAR_TOKENS.some((token) => unitKey.includes(token));
}

/**
 * `_extract_room_segments` — split a compound unit name ("MULTAZAM/ISO-1")
 * into de-duplicated normalised segments.
 *
 * A segment whose compact form starts with "ISO" also yields the "ISOLASI"
 * alias; segments that start with "KELAS " are dropped entirely (the alias is
 * built first but never emitted, exactly as in the Python).
 */
export function extractRoomSegments(unit: unknown): string[] {
  const rawParts = pyStr(unit).split(/[/,-]/);
  const hasil: string[] = [];
  const seen = new Set<string>();
  for (const part of rawParts) {
    const kandidat = normalizeTextKey(part);
    if (!kandidat) continue;
    const aliases = [kandidat];
    const compact = compactTextKey(kandidat);
    if (compact.startsWith('ISO')) aliases.push('ISOLASI');
    if (kandidat.startsWith('KELAS ')) continue;
    for (const alias of aliases) {
      if (!alias || seen.has(alias)) continue;
      seen.add(alias);
      hasil.push(alias);
    }
  }
  return hasil;
}

/** `_normalize_room_pelaksana` — the first room segment, or "". */
export function normalizeRoomPelaksana(unit: unknown): string {
  const segments = extractRoomSegments(unit);
  return segments[0] ?? '';
}

/** `_strip_room_role_prefix` — drop a leading "PERAWAT "/"BIDAN "/"RUANG ". */
export function stripRoomRolePrefix(namaParamedis: unknown): string {
  const namaKey = normalizeTextKey(namaParamedis);
  for (const prefix of ROOM_ROLE_PREFIXES) {
    if (namaKey.startsWith(prefix)) return namaKey.slice(prefix.length).trim();
  }
  return namaKey;
}

/**
 * `_room_label_matches_segment` — does a paramedis label name this room?
 * Exact compact match, or an off-by-one-character prefix match either way
 * (covers "MULTAZAM" vs "MULTAZAMS"-style master-data drift).
 */
export function roomLabelMatchesSegment(namaParamedis: unknown, segment: string): boolean {
  const labelCompact = compactTextKey(stripRoomRolePrefix(namaParamedis));
  const segmentCompact = compactTextKey(segment);
  if (!labelCompact || !segmentCompact) return false;
  if (labelCompact === segmentCompact) return true;
  if (
    Math.abs(labelCompact.length - segmentCompact.length) <= 1 &&
    (labelCompact.startsWith(segmentCompact) || segmentCompact.startsWith(labelCompact))
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Person-name classifiers
// ---------------------------------------------------------------------------

/** `_normalize_paramedis_display`. */
export function normalizeParamedisDisplay(name: unknown): string {
  return normalizeTextKey(name);
}

/** `_is_anesthesiologist_name` — "Sp.An" in any of its spacings. */
export function isAnesthesiologistName(name: unknown): boolean {
  return /SP\s*\.?\s*AN(?:[\s.,]|$)/.test(rawUpper(name));
}

/** `_looks_like_pediatrician_name` — "Sp.A" but not "Sp.An"/"Sp.AK". */
export function looksLikePediatricianName(name: unknown): boolean {
  const nama = pyStr(name).trim();
  if (!nama) return false;
  return /\bSP\.?\s*A\b/i.test(nama);
}

/**
 * `_doctor_name_matches_relaxed` — tolerant doctor-name comparison across
 * SIMRS v1/v2 and CPPT spellings: exact compact match, a >= 10-character
 * compact containment either way, or two shared >= 3-character tokens.
 */
export function doctorNameMatchesRelaxed(left: unknown, right: unknown): boolean {
  const leftCompact = compactTextKey(left);
  const rightCompact = compactTextKey(right);
  if (!leftCompact || !rightCompact) return false;
  if (leftCompact === rightCompact) return true;
  if (leftCompact.length >= 10 && rightCompact.includes(leftCompact)) return true;
  if (rightCompact.length >= 10 && leftCompact.includes(rightCompact)) return true;
  const leftTokens = new Set(
    normalizeTextKey(left)
      .split(' ')
      .filter((token) => token.length >= 3),
  );
  const rightTokens = new Set(
    normalizeTextKey(right)
      .split(' ')
      .filter((token) => token.length >= 3),
  );
  let common = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) common += 1;
  }
  return common >= 2;
}

/** `_is_selfcheckin_generated_row` — the row was created by the kiosk. */
export function isSelfcheckinGeneratedRow(row: LegacyRow): boolean {
  const userKey = normalizeTextKey(str(row, 'nama_user', 'user'));
  return userKey.includes('SELFCHECKIN') || userKey.includes('SELF CHECKIN');
}

// ---------------------------------------------------------------------------
// Newborn (BYNY) / penjamin / visit-status classifiers
// ---------------------------------------------------------------------------

/** `_is_byny_patient` — "By. Ny. <mother>" newborn naming. */
export function isBynyPatient(namaPasien: unknown): boolean {
  return compactTextKey(namaPasien).includes('BYNY');
}

/** `_is_bpjs_penjamin`. */
export function isBpjsPenjamin(namaPenjamin: unknown): boolean {
  return normalizeTextKey(namaPenjamin).includes('BPJS');
}

/**
 * `_looks_like_byny_parent_sep` — the SEP on the newborn row is really the
 * mother's placeholder: blank, all zeros, or the "BAYI SEHAT" marker.
 */
export function looksLikeBynyParentSep(noSep: unknown): boolean {
  const raw = pyStr(noSep).trim();
  const compact = compactTextKey(raw);
  if (!raw) return true;
  if (compact && [...compact].every((char) => char === '0')) return true;
  return compact.includes('BAYISEHAT');
}

/**
 * `_looks_like_byny_sick_diagnosis` — the newborn needs its own billing.
 *
 * The healthy list is an **exact** match against the normalised key; the sick
 * list is a substring sweep. Anything else is "not sick".
 */
export function looksLikeBynySickDiagnosis(text: unknown): boolean {
  const key = normalizeTextKey(text);
  if (!key) return false;
  if (BYNY_HEALTHY_DIAGNOSIS_TOKENS.includes(key)) return false;
  if (BYNY_SICK_DIAGNOSIS_TOKENS.some((token) => key.includes(token))) return true;
  if (key.includes('SEHAT')) return false;
  return false;
}

/** `_is_unpaid_kunjungan_status`. */
export function isUnpaidKunjunganStatus(statusBayar: unknown): boolean {
  return UNPAID_KUNJUNGAN_STATUS_KEYS.includes(compactTextKey(statusBayar));
}

/**
 * `_normalize_penjamin_filters` — normalise the payer allowlist. Only a
 * missing list falls back to the default; an explicitly empty list stays
 * empty (and therefore accepts everything).
 */
export function normalizePenjaminFilters(keywords?: readonly string[] | null): string[] {
  const source = keywords === undefined || keywords === null
    ? DEFAULT_ACCEPTED_PENJAMIN_KEYWORDS
    : keywords;
  const hasil: string[] = [];
  for (const item of source) {
    const text = pyStr(item).trim();
    if (!text) continue;
    hasil.push(normalizeTextKey(text));
  }
  return hasil;
}

/** `_is_accepted_penjamin` — an empty filter list accepts every payer. */
export function isAcceptedPenjamin(
  namaPenjamin: unknown,
  keywords?: readonly string[] | null,
): boolean {
  const filters = normalizePenjaminFilters(keywords);
  if (filters.length === 0) return true;
  const penjaminKey = normalizeTextKey(namaPenjamin);
  return filters.some((filterKey) => Boolean(filterKey) && penjaminKey.includes(filterKey));
}

/** `_normalize_penjamin_summary_label` — short payer label for the TSV summary. */
export function normalizePenjaminSummaryLabel(namaPenjamin: unknown): string {
  const penjaminKey = normalizeTextKey(namaPenjamin);
  if (penjaminKey.includes('BPJS NON PBI')) return 'NON PBI';
  if (penjaminKey.includes('BPJS PBI')) return 'PBI';
  return pyStr(namaPenjamin).trim() || '-';
}

// ---------------------------------------------------------------------------
// Row-shaped classifiers
// ---------------------------------------------------------------------------

/** `_is_transferred_row` — the penunjang order was already transferred. */
export function isTransferredRow(row: LegacyRow): boolean {
  const flagValue = str(row, 'flag').toLowerCase();
  const statusKirim = str(row, 'status_kirim');
  return flagValue === 'transfer' || statusKirim === '1';
}

/** `_is_dangling_ok_history_row` — an OK order with no transaction behind it. */
export function isDanglingOkHistoryRow(row: LegacyRow): boolean {
  const noOrder = str(row, 'no_order');
  const noTransaksi = str(row, 'no_transaksi');
  return Boolean(noOrder) && !noTransaksi;
}

/**
 * `_looks_like_manual_followup_transaction` — the transaction belongs to a
 * unit a human has to reconcile by hand.
 *
 * The token sweep is a plain substring test, so short tokens like "PA" and
 * "OK" intentionally match inside longer unit names — that over-inclusiveness
 * is the legacy behaviour and errs toward flagging for review.
 */
export function looksLikeManualFollowupTransaction(row: LegacyRow): boolean {
  const unitKey = normalizeTextKey(str(row, 'nama_unit'));
  const trx = str(row, 'no_transaksi').toUpperCase();
  if (MANUAL_FOLLOWUP_UNIT_TOKENS.some((token) => unitKey.includes(token))) return true;
  return MANUAL_FOLLOWUP_TRANSAKSI_PREFIXES.some((prefix) => trx.startsWith(prefix));
}
