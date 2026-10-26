/**
 * Patient-origin detection (IGD vs Poliklinik) — ported from `ranap_v3.py`.
 *
 * An inpatient stay almost always starts somewhere else: the emergency room
 * (`IGD` / `UGD`) or an outpatient clinic (`Poliklinik`). That entry visit
 * carries its own charges, and the inpatient bill is only complete once they are
 * pulled across. Getting this wrong either strands charges on a visit nobody
 * will verify, or drags in charges from an unrelated episode — so the port keeps
 * the Python's signal precedence exactly.
 *
 * Two Python functions are folded together here, because they are one decision
 * split across a fetch boundary:
 *  - `detect_group_origin_from_inap` — reads the inpatient charge list and looks
 *    for the tell-tale pass-through charges (`BIAYA POLIKLINIK`, `BIAYA UGD…`,
 *    hemodialysis);
 *  - `_infer_origin_from_history_for_group` — the fallback when the charge list
 *    is silent: scan the visit history for a plausible entry visit.
 *
 * Every fetch is hoisted into an explicit parameter:
 *
 *  - `_collect_group_listtindakan` → `listTindakanRows`
 *    (`poliklinik/penatajasa_inap/getlisttindakan`, one call per room row)
 *  - `ambil_datakunjungan` (`poliklinik/penatajasa_inap/getdatakunjungan`)
 *    → `dataKunjunganByTrx`
 *  - `ambil_datakunjungan_poli` (`poliklinik/poliklinik/getdatakunjungan`)
 *    → `poliDetailByTrx`
 *  - `_get_igd_source_signal_info` (`poliklinik/poliklinik/getlisttindakan`
 *    for the IGD transaction) → `igdSignalByTrx`, or build it with
 *    {@link deriveIgdSourceSignal}
 *  - `ambil_datatransaksi` (`kasir/kasir/getdatatransaksi`) → the
 *    `dataTransaksi` source of {@link resolveKunjunganSepKey}
 *
 * The Python memoizes several of these in module-level dicts
 * (`_KUNJUNGAN_SEP_CACHE`, `_IGD_SOURCE_SIGNAL_CACHE`). Caching is the caller's
 * business now; nothing here holds mutable state.
 */

import type { LegacyRow } from './types.js';
import { upper } from './types.js';
import { clampToleranceDays, datePart, parseDateFlexible, parseDateTimeFlexible } from './dates.js';
import {
  isIgdHemodialysisName,
  isIgdOriginChargeName,
  isUnpaidKunjunganStatus,
} from './names.js';
import { normalizeTextKey } from './scalars.js';

/**
 * The inferred entry visit — mirrors the dict
 * `_infer_origin_from_history_for_group` returns, and the stub
 * `_build_skipped_origin_info` produces.
 *
 * Python key → field: `type`, `trx`, `reg`, `unit`, `reason`, `sep_match` →
 * `sepMatch`, `doctor_match` → `doctorMatch`, `exact_date` → `exactDate`,
 * `unpaid_hint` → `unpaidHint`, `has_hemodialisa_signal` →
 * `hasHemodialisaSignal`, `matched_names` → `matchedNames`, `diff_days` →
 * `diffDays`.
 */
export interface InferredOrigin {
  /** `type` — `"poli"`, `"igd"`, or the skip marker (`"skip"`, `"langsung_byny"`). */
  type: string;
  /** `trx` — `no_transaksi` of the entry visit. */
  trx?: string;
  /** `reg` — `no_registrasikunjungan` of the entry visit. */
  reg?: string;
  /** `unit` — `nama_unit` of the entry visit, for the operator log. */
  unit?: string;
  /** `reason` — set only on the skipped stub. */
  reason?: string;
  /** `sep_match` — the entry visit's SJP/SEP is one of the inpatient SEPs. Strongest signal. */
  sepMatch?: boolean;
  /** `doctor_match` — same `kd_paramedis` as the inpatient admission. */
  doctorMatch?: boolean;
  /** `exact_date` — the entry visit is dated the same day as the admission. */
  exactDate?: boolean;
  /** `unpaid_hint` — the entry visit is still unpaid, so it is plausibly ours. */
  unpaidHint?: boolean;
  /** `has_hemodialisa_signal` — the IGD visit billed hemodialysis, which must follow the patient. */
  hasHemodialisaSignal?: boolean;
  /** `matched_names` — the hemodialysis charge names that raised the signal. */
  matchedNames?: string[];
  /** `diff_days` — signed day offset from the admission date; `999` when either date is unparseable. */
  diffDays?: number;
}

/**
 * What `main()` needs to know about how the patient got in — mirrors the dict
 * `detect_group_origin_from_inap` / `_build_skipped_origin_info` return.
 *
 * Python key → field: `requires_poli_source` → {@link requiresPoliSource},
 * `requires_igd_source` → {@link requiresIgdSource}, `skip_origin_check` →
 * {@link skipOriginCheck}, `skip_reason` → {@link skipReason},
 * `inferred_origin` → {@link inferredOrigin}.
 *
 * The Python dict also carries `list_rows` (the fetched inpatient charge list).
 * That is an input here, not an output, so it is not repeated.
 */
export interface OriginInfo {
  /** `requires_poli_source` — pull the outpatient-clinic source transaction. */
  requiresPoliSource: boolean;
  /** `requires_igd_source` — pull the emergency-room source transaction. */
  requiresIgdSource: boolean;
  /**
   * `skip_origin_check` — origin detection was deliberately not run. Absent from
   * the `detect_group_origin_from_inap` dict, where Python's `.get` yields
   * `None`; represented here as `false`.
   */
  skipOriginCheck: boolean;
  /** `skip_reason` — why detection was skipped, shown to the operator. */
  skipReason?: string;
  /**
   * `inferred_origin` — the entry visit the history scan settled on. Python
   * returns `{}` when nothing was inferred; that becomes `undefined` here.
   */
  inferredOrigin?: InferredOrigin;
}

/** The hemodialysis signal for one IGD transaction — `_get_igd_source_signal_info`'s dict. */
export interface IgdSourceSignal {
  /** `has_hemodialisa_signal` */
  hasHemodialisaSignal: boolean;
  /** `matched_names` */
  matchedNames: readonly string[];
}

const NO_IGD_SIGNAL: IgdSourceSignal = { hasHemodialisaSignal: false, matchedNames: [] };

/** `str(x or "").strip()` on a bare value (the row-aware form lives in `types.ts`). */
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return (typeof value === 'string' ? value : String(value)).trim();
}

/**
 * Signed calendar-day difference, matching Python's `(a - b).days` for the
 * date-only `datetime`s `_parse_date_flexible` produces. Normalizing through
 * `Date.UTC` keeps the arithmetic DST-proof, which a raw millisecond subtract
 * is not.
 */
function calendarDiffDays(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ua - ub) / 86_400_000);
}

/** Element-wise descending tuple compare — Python's `sort(key=score, reverse=True)`. */
function compareScoreDesc(
  a: readonly (number | string)[],
  b: readonly (number | string)[],
): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined || bv === undefined) continue;
    if (typeof av === 'number' && typeof bv === 'number') {
      if (av !== bv) return bv - av;
      continue;
    }
    const as = String(av);
    const bs = String(bv);
    if (as !== bs) return bs < as ? -1 : 1;
  }
  return 0;
}

/**
 * `_build_skipped_origin_info` — the "do not even look" result.
 *
 * `main()` uses it for BYNY (newborn) patients: a baby can be admitted straight
 * to the nursery with no IGD or clinic visit of its own, so hunting for an entry
 * visit would only find the mother's.
 *
 * @param opts.reason `reason` — operator-facing note, also copied to `skipReason`.
 * @param opts.inferredType `inferred_type` — defaults to `"skip"`; `main()` passes `"langsung_byny"`.
 */
export function buildSkippedOriginInfo(opts?: { reason?: string; inferredType?: string }): OriginInfo {
  const reason = text(opts?.reason);
  return {
    requiresPoliSource: false,
    requiresIgdSource: false,
    skipOriginCheck: true,
    skipReason: reason,
    inferredOrigin: {
      type: text(opts?.inferredType) || 'skip',
      reason,
    },
  };
}

/**
 * `_resolve_kunjungan_sep_key` — find the SEP number attached to a visit row,
 * falling back through the two places the backend hides it.
 *
 * @param row the visit row; its own `no_sep` wins when present.
 * @param noRm the patient's medical-record number. The Python only attempts the
 *   fallbacks when it (plus the row's own identifiers) is available.
 * @param sources.dataTransaksi caller supplies the result of
 *   `kasir.getdatatransaksi` for `(noRm, no_transaksi, kd_unit, no_registrasikunjungan)`.
 * @param sources.dataKunjungan caller supplies the result of
 *   `penatajasa_inap.getdatakunjungan` for `(noRm, no_transaksi)`.
 */
export function resolveKunjunganSepKey(
  row: LegacyRow,
  noRm?: string,
  sources?: { dataTransaksi?: LegacyRow; dataKunjungan?: LegacyRow },
): string {
  const trx = text(row['no_transaksi']);
  const reg = text(row['no_registrasikunjungan']);
  const kdUnit = text(row['kd_unit']);
  const rm = text(noRm);

  let sepKey = text(row['no_sep']);
  if (!sepKey && rm && trx && kdUnit && reg) {
    sepKey = text(sources?.dataTransaksi?.['no_sep']);
  }
  if (!sepKey && rm && trx) {
    sepKey = text(sources?.dataKunjungan?.['no_sep']);
  }
  return sepKey;
}

/**
 * `_extract_sep_keys_from_room_rows` — every SEP/SJP number the inpatient room
 * rows can be tied to. These are the keys an entry visit's own SJP is matched
 * against, which is the strongest origin signal there is.
 *
 * @param roomRows the inpatient room rows for one registration group.
 * @param noRm the patient's medical-record number; without it the Python's
 *   `getdatakunjungan` fallback yields nothing, so it is skipped.
 * @param dataKunjunganByTrx caller supplies the result of
 *   `penatajasa_inap.getdatakunjungan`, keyed by `no_transaksi`.
 */
export function extractSepKeysFromRoomRows(
  roomRows: readonly LegacyRow[],
  noRm?: string,
  dataKunjunganByTrx?: Readonly<Record<string, LegacyRow>>,
): string[] {
  const rm = text(noRm);
  const sepKeys = new Set<string>();
  for (const row of roomRows) {
    const candidates: unknown[] = [row['no_sjp'], row['no_sep']];
    const noTransaksi = text(row['no_transaksi']);
    if (noTransaksi && rm) {
      const dataInap = dataKunjunganByTrx?.[noTransaksi];
      candidates.push(dataInap?.['no_sjp'], dataInap?.['no_sep']);
    }
    for (const item of candidates) {
      const value = text(item);
      if (value) sepKeys.add(value);
    }
  }
  return [...sepKeys];
}

/**
 * The decision half of `_get_igd_source_signal_info`: which of an IGD visit's
 * charges are hemodialysis, deduplicated in first-seen order.
 *
 * @param listTindakanRows caller supplies the `rows` of
 *   `poliklinik.getlisttindakan` for the IGD transaction.
 */
export function deriveIgdSourceSignal(listTindakanRows: readonly LegacyRow[]): IgdSourceSignal {
  const matchedNames: string[] = [];
  for (const row of listTindakanRows) {
    const namaTindakan = text(row['nama_tindakan']);
    if (!namaTindakan) continue;
    if (isIgdHemodialysisName(namaTindakan) && !matchedNames.includes(namaTindakan)) {
      matchedNames.push(namaTindakan);
    }
  }
  return { hasHemodialisaSignal: matchedNames.length > 0, matchedNames };
}

/** Arguments for {@link detectGroupOriginFromRows}. */
export interface DetectGroupOriginArgs {
  /** `room_rows` — the inpatient room rows of one registration group. */
  roomRows: readonly LegacyRow[];
  /**
   * caller supplies `_collect_group_listtindakan(room_rows)`: the inpatient
   * charge rows for every room row, each already carrying `no_transaksi` and
   * `no_registrasikunjungan`.
   */
  listTindakanRows: readonly LegacyRow[];
  /** `no_rm` — required before the history fallback will run at all. */
  noRm?: string;
  /** `kunjungan_rows` — the patient's full visit history; the fallback's search space. */
  kunjunganRows?: readonly LegacyRow[];
  /** `tolerance_days` — clamped to 0..7. Default `7`, as in the Python. */
  toleranceDays?: number;
  /** caller supplies `penatajasa_inap.getdatakunjungan`, keyed by `no_transaksi`. */
  dataKunjunganByTrx?: Readonly<Record<string, LegacyRow>>;
  /** caller supplies `poliklinik.getdatakunjungan` (the poli/IGD detail), keyed by `no_transaksi`. */
  poliDetailByTrx?: Readonly<Record<string, LegacyRow>>;
  /**
   * caller supplies `_get_igd_source_signal_info` per candidate IGD
   * `no_transaksi`. Build entries with {@link deriveIgdSourceSignal}. Missing
   * entries read as "no signal", matching the Python's empty-response default.
   */
  igdSignalByTrx?: Readonly<Record<string, IgdSourceSignal>>;
}

/**
 * `detect_group_origin_from_inap` — decide whether this inpatient group needs
 * its Poliklinik and/or IGD source transaction pulled in.
 *
 * First pass is the cheap one: the inpatient charge list itself. A
 * `BIAYA POLIKLINIK` line proves clinic entry; a `BIAYA UGD…` /
 * `BIAYA IGD KEBIDANAN` line, or any hemodialysis charge, proves emergency
 * entry. Note the Poliklinik test is a plain uppercase substring match, not the
 * normalized-key match used elsewhere — kept as the Python has it.
 *
 * Only when the charge list says nothing (and `noRm` plus a visit history are
 * available) does it fall back to `_infer_origin_from_history_for_group`, whose
 * inferred `type` then sets the corresponding flag.
 */
export function detectGroupOriginFromRows(args: DetectGroupOriginArgs): OriginInfo {
  let hasPoli = args.listTindakanRows.some((row) =>
    upper(row, 'nama_tindakan').includes('BIAYA POLIKLINIK'),
  );
  let hasUgd = args.listTindakanRows.some(
    (row) =>
      isIgdOriginChargeName(row['nama_tindakan']) || isIgdHemodialysisName(row['nama_tindakan']),
  );

  let inferredOrigin: InferredOrigin | undefined;
  if (!hasPoli && !hasUgd && text(args.noRm) && (args.kunjunganRows?.length ?? 0) > 0) {
    inferredOrigin = inferOriginFromHistoryForGroup(args);
    if (inferredOrigin?.type === 'poli') hasPoli = true;
    else if (inferredOrigin?.type === 'igd') hasUgd = true;
  }

  return {
    requiresPoliSource: hasPoli,
    requiresIgdSource: hasUgd,
    skipOriginCheck: false,
    inferredOrigin,
  };
}

/**
 * `_infer_origin_from_history_for_group` — the fallback scan, minus its fetches.
 *
 * A history row is a candidate only if it is not one of the group's own room
 * transactions, it looks like an entry visit (`01-` = poli; `02-` or an `IGD`
 * unit name = igd), it is dated on or before the admission and within tolerance,
 * and it carries at least one of the three hard signals: SEP match, doctor
 * match, or exact date. Candidates are then ranked by the Python's tuple score,
 * in this order of importance:
 *
 *   sepMatch → doctorMatch → exactDate → unpaidHint → hasHemodialisaSignal →
 *   poli-over-igd → smallest absolute day gap → later date → larger `no_transaksi`
 *
 * (the last two are the Python's descending string compares, which act as
 * deterministic tie-breaks rather than real preferences).
 *
 * Returns `undefined` where the Python returns `{}`.
 */
function inferOriginFromHistoryForGroup(args: DetectGroupOriginArgs): InferredOrigin | undefined {
  const roomRows = [...args.roomRows];
  const kunjunganRows = [...(args.kunjunganRows ?? [])];
  const toleranceDays = clampToleranceDays(args.toleranceDays ?? 7);
  if (roomRows.length === 0 || kunjunganRows.length === 0) return undefined;

  // Earliest admission wins; unparseable dates sort last (Python's `datetime.max`).
  roomRows.sort((a, b) => {
    const ra = admissionRank(a);
    const rb = admissionRank(b);
    if (ra === rb) return 0;
    return ra < rb ? -1 : 1;
  });
  const firstRow = roomRows[0] as LegacyRow;

  const refDate = datePart(firstRow['tgl_masuk']);
  const refDt = parseDateFlexible(refDate);
  const targetSepKeys = extractSepKeysFromRoomRows(roomRows, args.noRm, args.dataKunjunganByTrx);
  const roomTrx = new Set(
    roomRows.map((row) => text(row['no_transaksi'])).filter((value) => value !== ''),
  );

  const firstTrx = text(firstRow['no_transaksi']);
  const dataInap = firstTrx ? args.dataKunjunganByTrx?.[firstTrx] : undefined;
  const targetKdParamedis =
    text(dataInap?.['kd_paramedis']) || text(firstRow['kd_paramedis']);

  interface Candidate {
    origin: InferredOrigin;
    score: readonly (number | string)[];
  }
  const candidates: Candidate[] = [];

  for (const row of kunjunganRows) {
    const noTransaksi = text(row['no_transaksi']);
    const noReg = text(row['no_registrasikunjungan']);
    if (!noTransaksi || roomTrx.has(noTransaksi) || !noReg) continue;

    let originType = '';
    if (noTransaksi.startsWith('01-')) {
      originType = 'poli';
    } else if (noTransaksi.startsWith('02-') || normalizeTextKey(row['nama_unit']).includes('IGD')) {
      originType = 'igd';
    }
    if (!originType) continue;

    const rowDate = datePart(row['tgl_masuk']);
    const rowDt = parseDateFlexible(rowDate);
    let diffDays: number;
    if (refDt !== null && rowDt !== null) {
      diffDays = calendarDiffDays(rowDt, refDt);
      // An entry visit cannot postdate the admission, and cannot be too far before it.
      if (diffDays > 0 || Math.abs(diffDays) > toleranceDays) continue;
    } else {
      diffDays = 999;
    }

    const detail = args.poliDetailByTrx?.[noTransaksi] ?? {};
    const igdSignalInfo =
      originType === 'igd' ? args.igdSignalByTrx?.[noTransaksi] ?? NO_IGD_SIGNAL : NO_IGD_SIGNAL;

    const sourceSep = text(detail['no_sjp']) || text(detail['no_sep']);
    const kdParamedis = text(detail['kd_paramedis']);
    const sepMatch = targetSepKeys.length > 0 && sourceSep !== '' && targetSepKeys.includes(sourceSep);
    const doctorMatch =
      targetKdParamedis !== '' && kdParamedis !== '' && kdParamedis === targetKdParamedis;
    const exactDate = refDate !== '' && rowDate !== '' && rowDate === refDate;
    const hasHemodialisaSignal = igdSignalInfo.hasHemodialisaSignal;
    const unpaidHint = isUnpaidKunjunganStatus(row['status_bayar']);

    if (!sepMatch && !doctorMatch && !exactDate) continue;

    candidates.push({
      origin: {
        type: originType,
        trx: noTransaksi,
        reg: noReg,
        unit: text(row['nama_unit']),
        sepMatch,
        doctorMatch,
        exactDate,
        unpaidHint,
        hasHemodialisaSignal,
        matchedNames: [...igdSignalInfo.matchedNames],
        diffDays,
      },
      score: [
        sepMatch ? 1 : 0,
        doctorMatch ? 1 : 0,
        exactDate ? 1 : 0,
        unpaidHint ? 1 : 0,
        hasHemodialisaSignal ? 1 : 0,
        originType === 'poli' ? 1 : 0,
        -Math.abs(diffDays),
        rowDate,
        noTransaksi,
      ],
    });
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => compareScoreDesc(a.score, b.score));
  return (candidates[0] as Candidate).origin;
}

/** Sort key for room rows: admission timestamp, unparseable last. */
function admissionRank(row: LegacyRow): number {
  const dt = parseDateTimeFlexible(row['tgl_masuk']);
  return dt === null ? Number.POSITIVE_INFINITY : dt.getTime();
}
