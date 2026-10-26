/**
 * Care-class ("kelas perawatan") normalisation and *pasien titipan* detection.
 *
 * Ported from `ranap_v3.py`: `_normalize_care_class_key`,
 * `_extract_sep_class_key`, `_resolve_sep_class_key`,
 * `_extract_room_class_key`, `_care_class_rank`,
 * `_evaluate_titipan_for_room_row` and `_get_titipan_keterangan_for_group`.
 *
 * A *pasien titipan* ("lodged patient") is a BPJS patient whose SEP entitles
 * them to one care class but who physically occupies a higher-class room. The
 * higher class cannot be billed to BPJS, so the pipeline flags the group for
 * manual review instead of staging payment.
 *
 * The legacy script reached the network inside `_resolve_sep_class_key`
 * (`getdata_sep_bpjs`, `getdatapenjamin_tab_pendaftaran`). This port keeps the
 * same fallback chain but takes those two reads as injected lookups so the
 * module stays pure; with no lookups supplied only the in-hand `sepItem` is
 * inspected — exactly what the legacy code does when both fallbacks are empty.
 */

import type { LegacyRow } from './types.js';
import { flag, str } from './types.js';
import { compactTextKey, normalizeTextKey } from './scalars.js';
/**
 * `_CARE_CLASS_BY_KD` (SIMRS `kd_kelasperawatan` → canonical class key, gaps at
 * "5" and "7" included) and `_care_class_rank` both live in `./names.js`, which
 * is the single source of truth for them and is pinned by `names.test.ts`.
 * Importing rather than re-declaring is deliberate: a divergence between two
 * copies of the rank ladder is a billing bug. The dependency only ever points
 * this way — `names.ts` imports nothing but `./types.js`, so there is no cycle.
 */
import { CARE_CLASS_BY_KD, CARE_CLASS_RANK, isBynyPatient } from './names.js';

/** Compact spellings that map straight onto "KELAS 3". */
const COMPACT_KELAS_3 = ['3', 'III', 'KELAS3', 'KELASIII', 'KELAS_3', 'KELASIIIA'];
/** Compact spellings that map straight onto "KELAS 2". */
const COMPACT_KELAS_2 = ['2', 'II', 'KELAS2', 'KELASII', 'KELAS_2'];
/** Compact spellings that map straight onto "KELAS 1". */
const COMPACT_KELAS_1 = ['1', 'I', 'KELAS1', 'KELASI', 'KELAS_1'];
/** Compact spellings that are already canonical (bar `NONKELAS`). */
const COMPACT_PASSTHROUGH = [
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
];

/**
 * Field names (normalised) whose value is treated as an explicit SEP class.
 *
 * Kept verbatim from the Python set — several entries (`HAK_KELAS`,
 * `KD_KELAS_BPJS`, …) can never match because `normalizeTextKey` folds `_`
 * into a space, but removing them would be a behavioural guess.
 */
const SEP_CLASS_KEY_ALIASES: ReadonlySet<string> = new Set([
  'HAK KELAS',
  'HAKKELAS',
  'HAK_KELAS',
  'KELAS HAK',
  'KELASHAK',
  'KELAS_HAK',
  'KELAS RAWAT',
  'KELASRAWAT',
  'KELAS_RAWAT',
  'KELAS SEP',
  'KELASSEP',
  'KELAS_SEP',
  'KELAS PELAYANAN',
  'KELASPELAYANAN',
  'KELAS_PELAYANAN',
  'KELAS PERAWATAN',
  'KELASPERAWATAN',
  'KELAS_PERAWATAN',
  'NAMA HAK KELAS',
  'NAMAHAKKELAS',
  'NAMA_HAK_KELAS',
  'NAMA KELAS',
  'NAMAKELAS',
  'NAMA_KELAS',
  'NMKELAS',
  'KDKELAS',
  'KDKELASBPJS',
  'KD_KELAS_BPJS',
  'KLS RAWAT HAK',
  'KLSRAWATHAK',
  'KLS_RAWAT_HAK',
  'HAKKELAS BPJS',
  'HAKKELASBPJS',
  'KELAS',
]);

/** Room-class keys that a "KELAS 3" SEP may never be billed against. */
const CLASSES_ABOVE_KELAS_3 = ['KELAS 2', 'KELAS 1', 'VIP', 'VVIP'];

/** Outcome of a titipan evaluation — the legacy `result` field. */
export type TitipanResult = 'NORMAL' | 'TITIPAN' | 'PERLU CEK MANUAL' | 'TIDAK DAPAT DIEVALUASI';

/** Every `reason` string `_evaluate_titipan_for_room_row` can produce. */
export type TitipanReason =
  | 'kelas_sep_tidak_terbaca'
  | 'kelas_ruang_tidak_terbaca'
  | 'byny_scn_beda_kelas'
  | 'sep_kelas_3_dirawat_di_kelas_lebih_tinggi'
  | 'kelas_rawat_di_atas_kelas_sep'
  | 'bayi_sehat_mengikuti_sep_orang_tua'
  | 'sesuai';

/**
 * The verdict for one room row, mirroring the dict the Python returns.
 *
 * `sepClass`, `sepClassSource`, `roomClass` and `roomName` carry the legacy
 * `'-'` placeholder when the underlying value is blank, because the operator
 * log prints them verbatim. `isTitipan` is a convenience for
 * `result === 'TITIPAN'`.
 */
export interface TitipanEvaluation {
  isTitipan: boolean;
  result: TitipanResult;
  reason: TitipanReason;
  sepClass: string;
  sepClassSource: string;
  roomClass: string;
  roomName: string;
}

/** Where a resolved SEP class came from — the legacy `sep_class_source`. */
export type SepClassSource = '' | 'sep_item' | 'getdata_sep_bpjs' | 'getdatapenjamin_tab' | 'provided';

/**
 * The two network reads `_resolve_sep_class_key` falls back to, injected so
 * this module stays pure. Omit them and only `sepItem` is consulted.
 */
export interface SepClassLookups {
  /** `getdata_sep_bpjs(no_sep)`. */
  sepDetail?: (noSep: string) => LegacyRow | undefined;
  /** `getdatapenjamin_tab_pendaftaran(no_registrasikunjungan)`. */
  penjaminTab?: (noReg: string) => LegacyRow | undefined;
}

/** Named arguments for {@link evaluateTitipanForRoomRow}. */
export interface TitipanEvaluationArgs {
  /** The room row under evaluation (`nama_unit`, `kd_kelasperawatan`, …). */
  roomRow: LegacyRow;
  /** The SEP payload to read the entitled class from. */
  sepItem?: LegacyRow;
  /**
   * Pre-resolved SEP class key, for callers that already ran
   * {@link resolveSepClassKey} for the group. When set (and it normalises to a
   * known class) no resolution is attempted.
   */
  sepClassKey?: string;
  /** Source label to report alongside `sepClassKey`; defaults to `provided`. */
  sepClassSource?: string;
  /** Patient name — only used to detect a BYNY (newborn) record. */
  namaPasien?: string;
  fallbackNoSep?: string;
  fallbackNoReg?: string;
  /** `byny_rme_status` for this registration; `is_healthy` softens the reason. */
  bynyRmeStatus?: LegacyRow;
  lookups?: SepClassLookups;
}

/** `str(value or "").strip()` for a bare scalar (not a row field). */
function legacyText(value: unknown): string {
  if (value === undefined || value === null || value === false || value === '') return '';
  if (typeof value === 'number' && (value === 0 || Number.isNaN(value))) return '';
  return String(value).trim();
}

/**
 * `_normalize_care_class_key` — fold any spelling of a care class onto one of
 * the canonical keys (`KELAS 3`, `KELAS 2`, `KELAS 1`, `VIP`, `VVIP`, `ICU`,
 * `NICU`, `PICU`, `ICCU`, `HCU`, `SCN`, `ISOLASI`, `DELUXE`, `BERSALIN`,
 * `NON KELAS`), or `''` when nothing is recognisable.
 *
 * Order matters: the compact exact-match table runs first, then substring
 * probes in a fixed precedence (VVIP before VIP, SCN/NICU/PICU/ICCU before the
 * bare `ICU` probe so that "PICU" is not swallowed by it).
 */
export function normalizeCareClassKey(value: unknown): string {
  const raw = legacyText(value);
  if (!raw) return '';

  const compact = compactTextKey(raw);
  if (compact.startsWith('ISO')) return 'ISOLASI';
  if (COMPACT_KELAS_3.includes(compact)) return 'KELAS 3';
  if (COMPACT_KELAS_2.includes(compact)) return 'KELAS 2';
  if (COMPACT_KELAS_1.includes(compact)) return 'KELAS 1';
  if (compact === 'VIP') return 'VIP';
  if (compact === 'VVIP' || compact === 'VVP') return 'VVIP';
  if (COMPACT_PASSTHROUGH.includes(compact)) {
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

function isSequenceLike(value: unknown): value is Iterable<unknown> {
  return Array.isArray(value) || value instanceof Set;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Set) &&
    !(value instanceof Date)
  );
}

/**
 * `_iter_nested_values` — walk a SEP payload up to 5 levels deep, yielding
 * every scalar it reaches plus, *ahead of its own subtree*, the value of any
 * field whose name is a known class alias.
 *
 * The consequence is deliberate and load-bearing: because plain scalars are
 * yielded too, the first field in insertion order whose value looks like a care
 * class wins even if its name is not an alias. Aliases only buy priority
 * within their own position, not over earlier fields.
 */
function* iterNestedValues(value: unknown, depth = 0): Generator<unknown> {
  if (depth > 5) return;
  if (isSequenceLike(value)) {
    for (const item of value) yield* iterNestedValues(item, depth + 1);
    return;
  }
  if (isRecordLike(value)) {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      if (SEP_CLASS_KEY_ALIASES.has(normalizeTextKey(nestedKey))) yield nestedValue;
      yield* iterNestedValues(nestedValue, depth + 1);
    }
    return;
  }
  yield value;
}

/**
 * `_extract_sep_class_key` — first value anywhere in `sepItem` (depth <= 5)
 * that normalises to a care class, or `''`.
 */
export function extractSepClassKey(sepItem: LegacyRow): string {
  if (!isRecordLike(sepItem)) return '';
  for (const value of iterNestedValues(sepItem)) {
    const kelasKey = normalizeCareClassKey(value);
    if (kelasKey) return kelasKey;
  }
  return '';
}

/**
 * `_resolve_sep_class_key` — the SEP class plus the source it came from.
 *
 * Chain: the in-hand `sepItem`, then `getdata_sep_bpjs(fallbackNoSep)`, then
 * `getdatapenjamin_tab_pendaftaran(fallbackNoReg)`. The last two are only
 * attempted when the matching lookup is supplied; without them the result is
 * `{ key: '', source: '' }`, which callers read as "class unreadable".
 */
export function resolveSepClassKey(
  sepItem: LegacyRow,
  fallbackNoSep = '',
  fallbackNoReg = '',
  lookups: SepClassLookups = {},
): { key: string; source: SepClassSource } {
  const fromItem = extractSepClassKey(sepItem);
  if (fromItem) return { key: fromItem, source: 'sep_item' };

  const noSep = legacyText(fallbackNoSep);
  if (noSep && lookups.sepDetail) {
    const fromSep = extractSepClassKey(lookups.sepDetail(noSep) ?? {});
    if (fromSep) return { key: fromSep, source: 'getdata_sep_bpjs' };
  }

  const noReg = legacyText(fallbackNoReg);
  if (noReg && lookups.penjaminTab) {
    const fromPenjamin = extractSepClassKey(lookups.penjaminTab(noReg) ?? {});
    if (fromPenjamin) return { key: fromPenjamin, source: 'getdatapenjamin_tab' };
  }

  return { key: '', source: '' };
}

/**
 * `_extract_room_class_key` — the class of a room row. `kd_kelasperawatan`
 * wins outright; otherwise the room's names are sniffed in a fixed order.
 */
export function extractRoomClassKey(roomRow: LegacyRow): string {
  if (!isRecordLike(roomRow)) return '';
  const kdKelasperawatan = str(roomRow, 'kd_kelasperawatan');
  const byKd = CARE_CLASS_BY_KD[kdKelasperawatan];
  if (byKd) return byKd;
  for (const key of ['nama_unit', 'nama_ruangperawatan', 'nama_ruangpendek', 'kd_kelas_bpjs']) {
    const kelasKey = normalizeCareClassKey(roomRow[key]);
    if (kelasKey) return kelasKey;
  }
  return '';
}

/**
 * `_care_class_rank` — position on the billable ladder (KELAS 3 = 1 … VVIP =
 * 5). Everything else, including the critical-care classes, ranks 0 and is
 * therefore never compared as "higher" or "lower" than a SEP class.
 */
export function careClassRank(kelasKey: unknown): number {
  return CARE_CLASS_RANK[legacyText(kelasKey)] ?? 0;
}

/**
 * `_evaluate_titipan_for_room_row` — classify one room row against the SEP.
 *
 * Precedence, top to bottom:
 *  1. SEP class unreadable        → `TIDAK DAPAT DIEVALUASI` / `kelas_sep_tidak_terbaca`
 *  2. room class unreadable       → `TIDAK DAPAT DIEVALUASI` / `kelas_ruang_tidak_terbaca`
 *  3. BYNY in an SCN room whose class differs from the SEP
 *                                 → `TITIPAN` / `byny_scn_beda_kelas`
 *  4. SEP KELAS 3 in KELAS 2/1/VIP/VVIP
 *                                 → `TITIPAN` / `sep_kelas_3_dirawat_di_kelas_lebih_tinggi`
 *  5. both ranked and room rank > SEP rank
 *                                 → `PERLU CEK MANUAL` / `kelas_rawat_di_atas_kelas_sep`
 *  6. otherwise `NORMAL`, reason `bayi_sehat_mengikuti_sep_orang_tua` for a
 *     healthy newborn riding the parent's SEP, else `sesuai`.
 *
 * Step 3 fires before step 4, so a BYNY in "SCN VIP" is reported as
 * `byny_scn_beda_kelas`, not as a class-3 upgrade. Step 5 never triggers for
 * ICU/HCU/SCN/ISOLASI rooms because those rank 0.
 */
export function evaluateTitipanForRoomRow(args: TitipanEvaluationArgs): TitipanEvaluation {
  const roomRow = isRecordLike(args.roomRow) ? args.roomRow : {};

  const preResolved = normalizeCareClassKey(args.sepClassKey);
  let sepClass = preResolved;
  let sepSource: string = preResolved ? legacyText(args.sepClassSource) || 'provided' : '';
  if (!sepClass) {
    const resolved = resolveSepClassKey(
      args.sepItem ?? {},
      args.fallbackNoSep ?? '',
      legacyText(args.fallbackNoReg) || str(roomRow, 'no_registrasikunjungan'),
      args.lookups ?? {},
    );
    sepClass = resolved.key;
    sepSource = resolved.source;
  }

  const roomClass = extractRoomClassKey(roomRow);
  const roomName = str(roomRow, 'nama_unit');
  const base = {
    sepClass: sepClass || '-',
    sepClassSource: sepSource || '-',
    roomClass: roomClass || '-',
    roomName: roomName || '-',
  };

  if (!sepClass) {
    return { ...base, result: 'TIDAK DAPAT DIEVALUASI', reason: 'kelas_sep_tidak_terbaca', isTitipan: false };
  }
  if (!roomClass) {
    return { ...base, result: 'TIDAK DAPAT DIEVALUASI', reason: 'kelas_ruang_tidak_terbaca', isTitipan: false };
  }

  if (isBynyPatient(args.namaPasien ?? '') && normalizeTextKey(roomName).includes('SCN') && roomClass !== sepClass) {
    return { ...base, result: 'TITIPAN', reason: 'byny_scn_beda_kelas', isTitipan: true };
  }

  if (sepClass === 'KELAS 3' && CLASSES_ABOVE_KELAS_3.includes(roomClass)) {
    return {
      ...base,
      result: 'TITIPAN',
      reason: 'sep_kelas_3_dirawat_di_kelas_lebih_tinggi',
      isTitipan: true,
    };
  }

  const roomRank = careClassRank(roomClass);
  const sepRank = careClassRank(sepClass);
  if (sepRank && roomRank && roomRank > sepRank) {
    return { ...base, result: 'PERLU CEK MANUAL', reason: 'kelas_rawat_di_atas_kelas_sep', isTitipan: false };
  }

  const healthyNewborn = isRecordLike(args.bynyRmeStatus) && flag(args.bynyRmeStatus['is_healthy']);
  return {
    ...base,
    result: 'NORMAL',
    reason: healthyNewborn ? 'bayi_sehat_mengikuti_sep_orang_tua' : 'sesuai',
    isTitipan: false,
  };
}

/**
 * `_get_titipan_keterangan_for_group` — the `keterangan` stamped on a whole
 * room group: `'TITIPAN'` as soon as one distinct (room name, room class) pair
 * trips the BYNY/SCN or the KELAS-3-upgrade rule, else `''`.
 *
 * Deliberately narrower than {@link evaluateTitipanForRoomRow}: the
 * rank-comparison branch (`PERLU CEK MANUAL`) does *not* produce a keterangan,
 * and an unreadable SEP class yields `''` rather than a warning.
 */
export function getTitipanKeteranganForGroup(
  roomRows: readonly LegacyRow[],
  sepItem: LegacyRow,
  opts: {
    namaPasien?: string;
    fallbackNoSep?: string;
    fallbackNoReg?: string;
    lookups?: SepClassLookups;
  } = {},
): string {
  const rows = roomRows ?? [];
  const { key: sepClass } = resolveSepClassKey(
    sepItem,
    opts.fallbackNoSep ?? '',
    legacyText(opts.fallbackNoReg) || str(rows[0], 'no_registrasikunjungan'),
    opts.lookups ?? {},
  );
  if (!sepClass) return '';

  const isByny = isBynyPatient(opts.namaPasien ?? '');
  const seen = new Set<string>();
  for (const row of rows) {
    const roomName = str(row, 'nama_unit');
    const roomClass = extractRoomClassKey(row ?? {});
    if (!roomName || !roomClass) continue;
    const roomKey = `${roomName} | ${roomClass}`;
    if (seen.has(roomKey)) continue;
    seen.add(roomKey);
    if (isByny && normalizeTextKey(roomName).includes('SCN') && roomClass !== sepClass) return 'TITIPAN';
    if (sepClass === 'KELAS 3' && CLASSES_ABOVE_KELAS_3.includes(roomClass)) return 'TITIPAN';
  }
  return '';
}
