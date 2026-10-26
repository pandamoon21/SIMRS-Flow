/**
 * Verification blockers ported from `ranap_v3.py`.
 *
 * A blocker is a row (or a penunjang response) that means "a human has to look
 * at this before the run may verify or pay anything". None of these functions
 * decide *what to do* about the blocker — they only find it — which is why they
 * are pure and take every remote read as a parameter.
 *
 * Hoisted fetches (endpoint → parameter):
 *  - `rawatinap/verifikator_rawatinap/getlisttindakan` (`ambil_listtindakan`,
 *    called once per room row inside
 *    `_check_missing_igd_depo_or_obat_for_verification`) →
 *    `listTindakanRows`: the concatenation of those calls' rows.
 *  - the penunjang preflight POSTs (`_normalize_penunjang_blocker` is handed
 *    the raw `_post_json` result) → `response: unknown`, unchanged.
 *
 * `findHangingRelatedTransactions` is the selection core of
 * `log_transaksi_terkait_menggantung` with the printing and the
 * `_register_reg_alert` side effects stripped out; the caller decides how to
 * report the rows (see `RunAlerts` in `./alerts.ts`).
 */

import type { LegacyRow } from './types.js';
import { str, upper } from './types.js';
import {
  clampToleranceDays,
  datePart,
  parseDateFlexible,
  parseDateTimeFlexible,
  startOfDay,
} from './dates.js';
import { isUnpaidKunjunganStatus, looksLikeManualFollowupTransaction } from './names.js';
import { normalizeTextKey, safeInt } from './scalars.js';
import { getRoomGroupDateRange } from './rooms.js';
import { cleanNoticeText } from './alerts.js';

/** `_collect_bank_darah_blockers` unit keyword. */
export const BANK_DARAH_UNIT_KEYWORDS: readonly string[] = ['BANK DARAH'];

/** `_collect_cathlab_blockers` unit keyword. */
export const CATHLAB_UNIT_KEYWORDS: readonly string[] = ['CATHLAB'];

/** The normalized form of a penunjang preflight response. */
export interface PenunjangBlocker {
  /** True when the response carries any of the four fields below. */
  hasBlocker: boolean;
  namaUnit: string;
  noTransaksi: string;
  /** The response's `data` field, or the cleaned notice text for a non-object. */
  data: string;
  total: number;
  /** The untouched response, kept for the audit trail. */
  raw?: unknown;
}

/** Named arguments for {@link collectNamedManualUnitBlockers}. */
export interface CollectNamedManualUnitBlockersArgs {
  /** `gethistorykunjungan` rows for the patient. */
  kunjunganRows: readonly LegacyRow[];
  /** The room rows of the group being processed; `[0]` supplies the reg. */
  roomRows: readonly LegacyRow[];
  /** Unit name fragments that make a row a blocker, e.g. `['BANK DARAH']`. */
  unitKeywords: readonly string[];
  /** Transactions the pipeline already dealt with; never blockers. */
  handledTransactions?: ReadonlySet<string> | readonly string[];
  /** Clamped to 0..7; the Python default is 7. */
  toleranceDays?: number;
}

/** Named arguments for the two pre-set unit collectors. */
export interface CollectUnitBlockersArgs {
  kunjunganRows: readonly LegacyRow[];
  roomRows: readonly LegacyRow[];
  handledTransactions?: ReadonlySet<string> | readonly string[];
  toleranceDays?: number;
  /** Operator override from the Rules page; absent keeps the legacy keyword. */
  unitKeywords?: readonly string[];
}

/** Named arguments for {@link findHangingRelatedTransactions}. */
export interface FindHangingRelatedTransactionsArgs {
  kunjunganRows: readonly LegacyRow[];
  /** Room rows grouped by `no_registrasikunjungan`, as the Python's dict. */
  roomRowsByReg: Readonly<Record<string, readonly LegacyRow[]>>;
  handledTransactions?: ReadonlySet<string> | readonly string[];
  toleranceDays?: number;
}

/** Named arguments for {@link checkMissingIgdDepoOrObatForVerification}. */
export interface CheckMissingIgdDepoOrObatArgs {
  kunjunganRows: readonly LegacyRow[];
  roomRows: readonly LegacyRow[];
  /**
   * `detect_group_origin_from_inap` output. Only the IGD flag is read, under
   * either the legacy `requires_igd_source` key or `OriginInfo`'s
   * `requiresIgdSource`.
   */
  originInfo?: unknown;
  /** Hoisted `ambil_listtindakan` rows for every room row of the group. */
  listTindakanRows?: readonly LegacyRow[];
}

/** Result of {@link checkMissingIgdDepoOrObatForVerification}. */
export interface MissingIgdDepoOrObatCheck {
  hasBlocker: boolean;
  /** `"<start> s/d <end>"`, the wording the legacy log prints. */
  periode: string;
  hasDepoIgd: boolean;
  hasBiayaObat: boolean;
}

/** Stand-in for Python's tuple keys — unambiguous for any field content. */
function tupleKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

/** `{str(item).strip() for item in handled if strip}`. */
function normalizeHandled(
  handled: ReadonlySet<string> | readonly string[] | undefined,
): Set<string> {
  const result = new Set<string>();
  for (const item of handled ?? []) {
    const text = (item ?? '').toString().trim();
    if (text) result.add(text);
  }
  return result;
}

/** Python's `bool(value)` for the loosely-typed `origin_info` flags. */
function pythonTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return Boolean(value);
}

function isRecordLike(value: unknown): value is LegacyRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `_date_part(row.tgl_masuk or row.tgl_keluar)` → parsed, or `null`. */
function groupDate(row: LegacyRow, first: string, second: string): Date | null {
  const part = datePart(str(row, first, second));
  if (!part) return null;
  return parseDateFlexible(part);
}

/** `dt +/- timedelta(days=n)`, calendar-safe. */
function shiftDays(value: Date, days: number): Date {
  const shifted = new Date(value.getTime());
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

function minDate(values: readonly Date[]): Date | null {
  if (values.length === 0) return null;
  return new Date(Math.min(...values.map((item) => item.getTime())));
}

function maxDate(values: readonly Date[]): Date | null {
  if (values.length === 0) return null;
  return new Date(Math.max(...values.map((item) => item.getTime())));
}

function inWindow(value: Date, start: Date, end: Date): boolean {
  return value.getTime() >= start.getTime() && value.getTime() <= end.getTime();
}

/**
 * `_collect_named_manual_unit_blockers` — still-unpaid visit rows whose unit
 * name contains one of `unitKeywords`.
 *
 * A row in the group's own registration always counts; a row from another
 * registration only counts when its `tgl_masuk` falls inside
 * `[earliest group date - tolerance, latest group date + 1]`, which keeps an
 * unrelated admission's bank-darah order from blocking this one.
 * De-duplicated on (trx, reg, normalized unit).
 */
export function collectNamedManualUnitBlockers(
  args: CollectNamedManualUnitBlockersArgs,
): LegacyRow[] {
  const handled = normalizeHandled(args.handledTransactions);
  const normalizedKeywords = (args.unitKeywords ?? [])
    .map((item) => normalizeTextKey(item))
    .filter((item) => item.length > 0);
  const roomRows = args.roomRows ?? [];
  if (roomRows.length === 0 || normalizedKeywords.length === 0) return [];

  const reg = str(roomRows[0], 'no_registrasikunjungan');
  const groupDates: Date[] = [];
  for (const row of roomRows) {
    const parsed = groupDate(row ?? {}, 'tgl_masuk', 'tgl_keluar');
    if (parsed !== null) groupDates.push(parsed);
  }
  const earliest = minDate(groupDates);
  const latest = maxDate(groupDates);
  if (earliest === null || latest === null) return [];
  const startDt = shiftDays(earliest, -clampToleranceDays(args.toleranceDays ?? 7));
  const endDt = shiftDays(latest, 1);

  const blocked: LegacyRow[] = [];
  const seen = new Set<string>();
  for (const row of args.kunjunganRows ?? []) {
    const trx = str(row, 'no_transaksi');
    const rowReg = str(row, 'no_registrasikunjungan');
    const namaUnit = str(row, 'nama_unit');
    const namaUnitKey = normalizeTextKey(namaUnit);
    const rowDate = parseDateFlexible(row['tgl_masuk']);
    if (!trx || handled.has(trx)) continue;
    if (!normalizedKeywords.some((token) => namaUnitKey.includes(token))) continue;
    if (!isUnpaidKunjunganStatus(row['status_bayar'])) continue;
    if (rowReg && rowReg !== reg) {
      if (rowDate === null || !inWindow(rowDate, startDt, endDt)) continue;
    }
    const key = tupleKey(trx, rowReg, normalizeTextKey(namaUnit));
    if (seen.has(key)) continue;
    seen.add(key);
    blocked.push({ ...row });
  }
  return blocked;
}

/** `_collect_bank_darah_blockers` — blood-bank orders need manual settlement. */
export function collectBankDarahBlockers(args: CollectUnitBlockersArgs): LegacyRow[] {
  return collectNamedManualUnitBlockers({ ...args, unitKeywords: args.unitKeywords ?? BANK_DARAH_UNIT_KEYWORDS });
}

/** `_collect_cathlab_blockers` — cathlab orders need manual settlement. */
export function collectCathlabBlockers(args: CollectUnitBlockersArgs): LegacyRow[] {
  return collectNamedManualUnitBlockers({ ...args, unitKeywords: args.unitKeywords ?? CATHLAB_UNIT_KEYWORDS });
}

/**
 * The selection core of `log_transaksi_terkait_menggantung` — per registration
 * group, the still-unpaid visit rows that are left dangling.
 *
 * A row joins the group when it carries the group's own `no_registrasikunjungan`;
 * otherwise it must be a manual-followup unit (depo, lab, radiologi, …) and,
 * when it has a parseable date, fall inside
 * `[earliest group date - tolerance, latest discharge + 1]`. Rows are
 * de-duplicated by `no_transaksi` **within** a group (the Python resets its
 * `seen` set per group) and returned sorted by `tgl_masuk`, groups in the order
 * `roomRowsByReg` iterates.
 *
 * Each returned row carries `_hanging_reg`, the group it was found for — the
 * Python's loop variable, which the caller needs to raise the per-reg WARN.
 */
export function findHangingRelatedTransactions(
  args: FindHangingRelatedTransactionsArgs,
): LegacyRow[] {
  const handled = normalizeHandled(args.handledTransactions);
  const byReg = args.roomRowsByReg ?? {};
  const toleranceDays = clampToleranceDays(args.toleranceDays ?? 7);
  const hanging: LegacyRow[] = [];

  for (const [reg, rows] of Object.entries(byReg)) {
    if (!rows || rows.length === 0) continue;
    const groupDates: Date[] = [];
    const endCandidates: Date[] = [];
    for (const row of rows) {
      const start = groupDate(row ?? {}, 'tgl_masuk', 'tgl_keluar');
      if (start !== null) groupDates.push(start);
      const end = groupDate(row ?? {}, 'tgl_keluar', 'tgl_masuk');
      if (end !== null) endCandidates.push(end);
    }
    const earliest = minDate(groupDates);
    if (earliest === null) continue;
    const startDt = shiftDays(earliest, -toleranceDays);
    const latest = maxDate(endCandidates.length > 0 ? endCandidates : groupDates);
    if (latest === null) continue;
    const endDt = shiftDays(latest, 1);

    const candidates: LegacyRow[] = [];
    for (const row of args.kunjunganRows ?? []) {
      const trx = str(row, 'no_transaksi');
      const rowReg = str(row, 'no_registrasikunjungan');
      const rowDate = parseDateFlexible(row['tgl_masuk']);
      if (!trx || handled.has(trx)) continue;
      if (!isUnpaidKunjunganStatus(row['status_bayar'])) continue;
      if (rowReg && rowReg === reg) {
        candidates.push(row);
        continue;
      }
      // An undated row skips the window test, exactly like the Python.
      if (rowDate !== null && !inWindow(rowDate, startDt, endDt)) continue;
      if (!looksLikeManualFollowupTransaction(row)) continue;
      candidates.push(row);
    }

    const deduped: LegacyRow[] = [];
    const seen = new Set<string>();
    for (const row of candidates) {
      const trx = str(row, 'no_transaksi');
      if (!trx || seen.has(trx)) continue;
      seen.add(trx);
      deduped.push(row);
    }
    if (deduped.length === 0) continue;

    // `sorted(key=_parse_datetime_flexible(tgl_masuk) or datetime.max)`.
    deduped.sort((a, b) => {
      const aDt = parseDateTimeFlexible(a['tgl_masuk'])?.getTime() ?? Number.POSITIVE_INFINITY;
      const bDt = parseDateTimeFlexible(b['tgl_masuk'])?.getTime() ?? Number.POSITIVE_INFINITY;
      return aDt === bDt ? 0 : aDt - bDt;
    });
    for (const row of deduped) hanging.push({ ...row, _hanging_reg: reg });
  }

  return hanging;
}

/**
 * `_normalize_penunjang_blocker` — fold a penunjang preflight response into a
 * decision. An object response blocks when any of `nama_unit`, `no_transaksi`,
 * `data` or a non-zero `total` is present; anything else blocks when its
 * cleaned notice text is non-empty.
 */
export function normalizePenunjangBlocker(response: unknown): PenunjangBlocker {
  if (isRecordLike(response)) {
    const namaUnit = str(response, 'nama_unit');
    const noTransaksi = str(response, 'no_transaksi');
    const data = str(response, 'data');
    const total = safeInt(response['total'], 0);
    return {
      hasBlocker: Boolean(namaUnit || noTransaksi || data || total),
      namaUnit,
      noTransaksi,
      data,
      total,
      raw: response,
    };
  }
  const text = cleanNoticeText(response);
  return {
    hasBlocker: Boolean(text),
    namaUnit: '',
    noTransaksi: '',
    data: text,
    total: 0,
    raw: response,
  };
}

/**
 * `_is_gizi_penunjang_blocker` — a gizi (diet) order, which the pipeline
 * handles itself instead of treating as a manual blocker.
 */
export function isGiziPenunjangBlocker(blocker: PenunjangBlocker): boolean {
  const namaUnit = normalizeTextKey(blocker?.namaUnit);
  const noTransaksi = (blocker?.noTransaksi ?? '').trim();
  const data = normalizeTextKey(blocker?.data);
  return namaUnit.includes('GIZI') || data.includes('GIZI') || noTransaksi.startsWith('18-');
}

/** `_penunjang_blocker_label` — the one-line operator log form. */
export function penunjangBlockerLabel(blocker: PenunjangBlocker | null | undefined): string {
  if (!blocker) return '-';
  const namaUnit = (blocker.namaUnit || '-').trim();
  const noTransaksi = (blocker.noTransaksi || '-').trim();
  const data = (blocker.data || '-').trim();
  const total = blocker.total ?? 0;
  return `nama_unit=${namaUnit} | no_transaksi=${noTransaksi} | data=${data} | total=${total}`;
}

/**
 * `_check_missing_igd_depo_or_obat_for_verification` — for a patient admitted
 * through IGD, verification is blocked when the stay shows neither a DEPO IGD
 * visit nor a BIAYA OBAT charge (the drugs given in IGD were never billed).
 *
 * Only runs when `originInfo.requires_igd_source` is truthy; every early exit
 * reports `hasBlocker: false` with empty details, matching the Python's
 * `{"has_blocker": False}`.
 */
export function checkMissingIgdDepoOrObatForVerification(
  args: CheckMissingIgdDepoOrObatArgs,
): MissingIgdDepoOrObatCheck {
  const noBlocker: MissingIgdDepoOrObatCheck = {
    hasBlocker: false,
    periode: '',
    hasDepoIgd: false,
    hasBiayaObat: false,
  };
  const originInfo = isRecordLike(args.originInfo) ? args.originInfo : {};
  // `requires_igd_source` is the legacy key; `requiresIgdSource` is the shape
  // `OriginInfo` in `./origin.ts` produces. Both are accepted.
  const requiresIgd =
    originInfo['requires_igd_source'] === undefined
      ? originInfo['requiresIgdSource']
      : originInfo['requires_igd_source'];
  if (!pythonTruthy(requiresIgd)) return noBlocker;
  const roomRows = args.roomRows ?? [];
  if (roomRows.length === 0) return noBlocker;

  const { start, end } = getRoomGroupDateRange(roomRows);
  const relatedHistoryRows = filterHistoryRowsForDateRange(args.kunjunganRows ?? [], start, end);
  const hasDepoIgd = relatedHistoryRows.some((row) => upper(row, 'nama_unit').includes('DEPO IGD'));
  const hasBiayaObat = (args.listTindakanRows ?? []).some(
    (item) => upper(item, 'nama_tindakan') === 'BIAYA OBAT',
  );

  return {
    hasBlocker: !hasDepoIgd && !hasBiayaObat,
    periode: `${start || '-'} s/d ${end || '-'}`,
    hasDepoIgd,
    hasBiayaObat,
  };
}

/**
 * `_filter_history_rows_for_date_range` — visit rows whose transaction/order/
 * admission date falls inside an inclusive `YYYY-MM-DD` range. Rows with no
 * parseable date are dropped; an unparseable bound is simply not applied.
 */
function filterHistoryRowsForDateRange(
  rows: readonly LegacyRow[],
  startDate: string,
  endDate: string,
): LegacyRow[] {
  const startDt = parseDateFlexible(startDate);
  const endDt = parseDateFlexible(endDate);
  const hasil: LegacyRow[] = [];
  for (const row of rows ?? []) {
    const rowDt = parseDateTimeFlexible(str(row, 'tgl_transaksi', 'tgl_order', 'tgl_masuk'));
    if (rowDt === null) continue;
    // Python compares `row_dt.date()` against the bounds' dates.
    const rowDay = startOfDay(rowDt).getTime();
    if (startDt !== null && rowDay < startOfDay(startDt).getTime()) continue;
    if (endDt !== null && rowDay > startOfDay(endDt).getTime()) continue;
    hasil.push(row);
  }
  return hasil;
}
