/**
 * Room stays and room-day ownership — which hospital day is billed to which
 * room.
 *
 * Ported from `ranap_v3.py`: `_get_room_activity_window`,
 * `_enrich_room_rows_with_activity_windows`, `_normalize_room_stays`,
 * `_build_room_day_assignments`, `_get_room_group_date_range`,
 * `_get_room_rows_date_bounds`, `_pick_room_row_for_date`,
 * `_build_room_owner_by_date`, `_group_rows_by_date`,
 * `_group_rows_by_date_and_pelaksana` and `_group_rows_by_pelaksana`.
 *
 * This is the spine of the inpatient billing pipeline: a `rawat inap` group is
 * a list of room rows (one per ward the patient passed through) whose
 * `tgl_masuk`/`tgl_keluar` are routinely wrong — dates without a time, a
 * discharge stamp before the admission stamp, no discharge at all, or two rows
 * whose `urut_masuk_ruang` contradicts their dates. `normalizeRoomStays`
 * repairs those windows and `buildRoomDayAssignments` then hands every calendar
 * day of the group to exactly one room, which is what every later step (room
 * charges, visite, jasa) bills against.
 *
 * Two departures from the Python, both forced and both behaviour-preserving:
 *
 *  1. **Rows are never mutated.** Where the legacy code writes `_activity`-style
 *     keys into the caller's dict, these helpers return new row objects that
 *     carry the same field names (`_actual_tgl_masuk`, `_actual_tgl_keluar`,
 *     `_start_dt`, `_end_dt`, `_urut_masuk_ruang`, `_shifted_start_days`).
 *  2. **No network, no cache.** `_get_room_activity_window` called
 *     `ambil_listtindakan` and memoised it in a module-level dict. Here the
 *     tindakan rows come from an injected {@link RoomActivityRowsProvider} (or
 *     from a `_list_tindakan` field already on the row), so the module is pure
 *     and every caller with the same input gets the same answer.
 */

import type { LegacyRow } from './types.js';
import { rowsOf, str } from './types.js';
import { safeInt, sortedRows } from './scalars.js';
import {
  datePart,
  endOfDay,
  iterDateParts,
  iterDatePartsFromDateTimes,
  parseDateFlexible,
  parseDateTimeFlexible,
  secondsOverlapInDate,
} from './dates.js';
import {
  getOverlapRoomPriorityRank,
  isDpjbName,
  isJasaName,
  isPriorityOverlapRoomName,
  isRoomChargeName,
} from './names.js';

/**
 * `ROOM_ASSIGN_PRIORITY_MARGIN_SECONDS` — when no room on a shared day is a
 * priority room, stays within three hours of the longest occupancy are
 * considered tied.
 */
export const ROOM_ASSIGN_PRIORITY_MARGIN_SECONDS = 3 * 60 * 60;

/** Action keys that count as evidence the patient was really in the room. */
const PREFERRED_ACTIVITY_ACTION_KEYS = ['jasa', 'dpjb', 'room'];

/** The observed first/last activity of a room row; `null` when unknown. */
export interface RoomActivityWindow {
  start: Date | null;
  end: Date | null;
}

/**
 * Supplies the `ambil_listtindakan(no_transaksi, no_reg, kd_kamar)` rows for a
 * room row — the one read the legacy window scan performed. Return `undefined`
 * (or an empty array) when nothing is known.
 */
export type RoomActivityRowsProvider = (row: LegacyRow) => readonly LegacyRow[] | undefined;

/** Injection points shared by every stay-shaping helper here. */
export interface RoomStayOptions {
  /**
   * Where the per-room tindakan rows come from. Defaults to reading a
   * `_list_tindakan` field off the room row itself (array or `{rows: […]}`
   * envelope), so a caller that has already fetched them can just attach them.
   */
  activityRows?: RoomActivityRowsProvider;
  /**
   * `_match_action_key` with no `room_meta` — classifies a tindakan row as
   * `jasa`, `dpjb`, `room` or `''`. Overridable for callers that resolve the
   * room charge against master metadata.
   */
  actionKey?: (row: LegacyRow) => string;
}

/**
 * A room row after {@link normalizeRoomStays}: the repaired stay window, both
 * as `Date`s and as the `%Y-%m-%d %H:%M:%S` strings the legacy code wrote back.
 */
export interface RoomStayRow extends LegacyRow {
  /** Resolved admission instant. */
  readonly _start_dt: Date;
  /** Resolved discharge instant — never null once normalised. */
  readonly _end_dt: Date;
  /** `urut_masuk_ruang` as an int, 0 when absent. */
  readonly _urut_masuk_ruang: number;
  readonly _actual_tgl_masuk: string;
  readonly _actual_tgl_keluar: string;
  /** Days the admission was pushed forward to break a start-order tie. */
  readonly _shifted_start_days?: number;
}

/** A `YYYY-MM-DD` inclusive range; both ends `''` when nothing is parseable. */
export interface DateRange {
  start: string;
  end: string;
}

/** Working copy of a stay while its window is being repaired. */
interface StayRecord {
  row: Record<string, unknown>;
  startDt: Date;
  endDt: Date | null;
  urut: number;
  shiftedStartDays: number;
  trx: string;
}

/** A stay whose window is final. */
interface NormalizedStay {
  row: RoomStayRow;
  startDt: Date;
  endDt: Date;
  urut: number;
  trx: string;
}

/** One room competing for one calendar day. */
interface DayCandidate {
  overlapSeconds: number;
  startTs: number;
  stay: NormalizedStay;
  priorityRank: number;
  isPriorityRoom: boolean;
}

/** `strftime("%Y-%m-%d %H:%M:%S")` on a local-time (naive) instant. */
function formatDateTimeValue(dt: Date): string {
  return `${formatDateValue(dt)} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}:${pad2(dt.getSeconds())}`;
}

/** `strftime("%Y-%m-%d")` on a local-time (naive) instant. */
function formatDateValue(dt: Date): string {
  return `${String(dt.getFullYear()).padStart(4, '0')}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `dt + timedelta(days=n)` on a naive instant: the wall clock is preserved, so
 * a DST boundary cannot shift the time of day (Python naive arithmetic has no
 * DST to apply either).
 */
function addDays(dt: Date, days: number): Date {
  return new Date(
    dt.getFullYear(),
    dt.getMonth(),
    dt.getDate() + days,
    dt.getHours(),
    dt.getMinutes(),
    dt.getSeconds(),
    dt.getMilliseconds(),
  );
}

/** `text.count(":")` — used to tell "2026-03-01" from "2026-03-01 08:00:00". */
function colonCount(text: string): number {
  return text.split(':').length - 1;
}

/** `_match_action_key(row)` with no `room_meta`. */
function defaultActionKey(row: LegacyRow): string {
  const nama = str(row, 'nama_tindakan');
  if (isJasaName(nama)) return 'jasa';
  if (isDpjbName(nama)) return 'dpjb';
  if (isRoomChargeName(nama)) return 'room';
  return '';
}

function pushGrouped(grouped: Record<string, LegacyRow[]>, key: string, row: LegacyRow): void {
  const bucket = grouped[key];
  if (bucket) bucket.push(row);
  else grouped[key] = [row];
}

/** Lexicographic min/max, matching Python's `min`/`max` over date strings. */
function minText(values: readonly string[]): string {
  return values.reduce((lowest, value) => (value < lowest ? value : lowest));
}

function maxText(values: readonly string[]): string {
  return values.reduce((highest, value) => (value > highest ? value : highest));
}

/**
 * `_get_room_activity_window` — first and last tindakan timestamp seen for a
 * room row, which is the only trustworthy evidence of when the patient was
 * actually in that room.
 *
 * Rows whose action key is `jasa`, `dpjb` or `room` are preferred: if any exist
 * they alone define *both* ends, and everything else is ignored. Only when
 * there are none does the window fall back to every timestamped row. As in the
 * legacy code, a row missing `no_transaksi` or `no_registrasikunjungan` has no
 * window at all — those ids were the arguments to the tindakan read.
 */
export function getRoomActivityWindow(row: LegacyRow, options: RoomStayOptions = {}): RoomActivityWindow {
  const empty: RoomActivityWindow = { start: null, end: null };
  const noTransaksi = str(row, 'no_transaksi');
  const noReg = str(row, 'no_registrasikunjungan');
  if (!noTransaksi || !noReg) return empty;

  const listRows = options.activityRows ? options.activityRows(row) : rowsOf(row['_list_tindakan']);
  if (!listRows || listRows.length === 0) return empty;

  const resolveActionKey = options.actionKey ?? defaultActionKey;
  const preferred: Date[] = [];
  const fallback: Date[] = [];
  for (const item of listRows) {
    const dt = parseDateTimeFlexible(str(item, 'tgl_jam', 'tgl_transaksi'));
    if (!dt) continue;
    fallback.push(dt);
    let actionKey = '';
    try {
      actionKey = resolveActionKey(item);
    } catch {
      actionKey = '';
    }
    if (PREFERRED_ACTIVITY_ACTION_KEYS.includes(actionKey)) preferred.push(dt);
  }

  const candidates = preferred.length > 0 ? preferred : fallback;
  if (candidates.length === 0) return empty;
  let start = candidates[0] as Date;
  let end = start;
  for (const dt of candidates) {
    if (dt.getTime() < start.getTime()) start = dt;
    if (dt.getTime() > end.getTime()) end = dt;
  }
  return { start, end };
}

/**
 * `_enrich_room_rows_with_activity_windows` — reconcile the declared stay
 * window with the observed one, returning new rows.
 *
 * The observed start replaces the declared one when the declared start is
 * unparseable, carries no time-of-day (fewer than two colons, i.e. a bare
 * date), or is later than the first observed activity. The observed end
 * replaces the declared one under the mirror conditions plus one more: a
 * declared discharge at or before the declared admission is discarded as
 * corrupt. When there is no observed window at all, a parseable declared value
 * is still copied into `_actual_*` — but only if that key is absent, so an
 * `_actual_*` already set by an earlier pass is never overwritten.
 */
export function enrichRoomRowsWithActivityWindows(
  roomRows: readonly LegacyRow[],
  options: RoomStayOptions = {},
): LegacyRow[] {
  const enriched: LegacyRow[] = [];
  for (const row of roomRows ?? []) {
    const copy: Record<string, unknown> = { ...(row ?? {}) };
    const startText = str(copy, '_actual_tgl_masuk', 'tgl_masuk');
    const endText = str(copy, '_actual_tgl_keluar', 'tgl_keluar');
    const explicitStart = parseDateTimeFlexible(startText);
    const explicitEnd = parseDateTimeFlexible(endText);
    const window = getRoomActivityWindow(copy, options);
    const observedStart = window.start;
    const observedEnd = window.end;

    if (
      observedStart &&
      (explicitStart === null ||
        colonCount(startText) < 2 ||
        observedStart.getTime() < explicitStart.getTime())
    ) {
      copy['_actual_tgl_masuk'] = formatDateTimeValue(observedStart);
    } else if (explicitStart !== null && !('_actual_tgl_masuk' in copy)) {
      copy['_actual_tgl_masuk'] = formatDateTimeValue(explicitStart);
    }

    if (
      observedEnd &&
      (explicitEnd === null ||
        colonCount(endText) < 2 ||
        (explicitStart !== null && explicitEnd.getTime() <= explicitStart.getTime()) ||
        observedEnd.getTime() > explicitEnd.getTime())
    ) {
      copy['_actual_tgl_keluar'] = formatDateTimeValue(observedEnd);
    } else if (explicitEnd !== null && !('_actual_tgl_keluar' in copy)) {
      copy['_actual_tgl_keluar'] = formatDateTimeValue(explicitEnd);
    }

    enriched.push(copy);
  }
  return enriched;
}

/**
 * `_normalize_room_stays` — turn raw room rows into a strictly ordered list of
 * repaired stays.
 *
 * Steps, in order, because each one feeds the next:
 *
 *  1. Enrich the windows, then drop every row with no parseable admission.
 *  2. Order by `urut_masuk_ruang` (rows that declare one come first, ascending;
 *     rows that do not are parked behind them at 999999), then by admission
 *     instant, then by `no_transaksi`. `urut_masuk_ruang` outranks the dates:
 *     a group whose sequence numbers contradict its dates is ordered by the
 *     sequence.
 *  3. Force the admissions strictly increasing in that order by pushing each
 *     stay forward whole days until it starts after its predecessor, recording
 *     the number of days in `_shifted_start_days`. Discharges are *not* shifted.
 *  4. Repair each discharge: clamp it down to the next stay's admission when it
 *     runs past it (so two stays never truly overlap in time — a shared day is
 *     resolved later, by {@link buildRoomDayAssignments}); fill in a missing or
 *     inverted discharge from the next admission; bridge a same-day stay
 *     forward to a next admission that step 3 pushed away; and fall back to
 *     end-of-day for the last stay.
 */
export function normalizeRoomStays(
  roomRows: readonly LegacyRow[],
  options: RoomStayOptions = {},
): RoomStayRow[] {
  return computeNormalizedStays(roomRows, options).map((stay) => stay.row);
}

function computeNormalizedStays(
  roomRows: readonly LegacyRow[],
  options: RoomStayOptions,
): NormalizedStay[] {
  const stays: StayRecord[] = [];
  for (const row of enrichRoomRowsWithActivityWindows(roomRows, options)) {
    const startDt = parseDateTimeFlexible(str(row, '_actual_tgl_masuk', 'tgl_masuk'));
    const endDt = parseDateTimeFlexible(str(row, '_actual_tgl_keluar', 'tgl_keluar'));
    if (!startDt) continue;
    stays.push({
      row: { ...row },
      startDt,
      endDt,
      urut: safeInt(row['urut_masuk_ruang'], 0),
      // A row re-normalised a second time keeps the flag from the first pass,
      // exactly as the legacy `{**row}` copy did — the bridge rule below reads it.
      shiftedStartDays: safeInt(row['_shifted_start_days'], 0),
      trx: str(row, 'no_transaksi'),
    });
  }

  stays.sort(compareStays);

  for (let idx = 1; idx < stays.length; idx += 1) {
    const prev = stays[idx - 1];
    const stay = stays[idx];
    if (!prev || !stay) continue;
    let shiftedDays = 0;
    while (stay.startDt.getTime() <= prev.startDt.getTime()) {
      stay.startDt = addDays(stay.startDt, 1);
      shiftedDays += 1;
    }
    if (shiftedDays > 0) stay.shiftedStartDays = shiftedDays;
  }

  for (let idx = 0; idx < stays.length; idx += 1) {
    const stay = stays[idx];
    if (!stay) continue;
    const startDt = stay.startDt;
    let endDt = stay.endDt;
    const nextStay = stays[idx + 1];
    const nextStart = nextStay ? nextStay.startDt : null;
    if (nextStart) {
      const shouldBridgeShiftedNext =
        (nextStay?.shiftedStartDays ?? 0) > 0 &&
        endDt !== null &&
        endDt.getTime() > startDt.getTime() &&
        endDt.getTime() < nextStart.getTime() &&
        formatDateValue(endDt) === formatDateValue(startDt);
      if (
        endDt === null ||
        endDt.getTime() <= startDt.getTime() ||
        endDt.getTime() > nextStart.getTime() ||
        shouldBridgeShiftedNext
      ) {
        endDt = nextStart;
      }
    }
    if (endDt === null || endDt.getTime() <= startDt.getTime()) {
      endDt = endOfDay(startDt);
    }
    stay.endDt = endDt;
  }

  return stays.map((stay) => {
    const endDt = stay.endDt ?? endOfDay(stay.startDt);
    const row: Record<string, unknown> = { ...stay.row };
    row['_start_dt'] = stay.startDt;
    row['_end_dt'] = endDt;
    row['_urut_masuk_ruang'] = stay.urut;
    row['_actual_tgl_masuk'] = formatDateTimeValue(stay.startDt);
    row['_actual_tgl_keluar'] = formatDateTimeValue(endDt);
    if (stay.shiftedStartDays > 0) row['_shifted_start_days'] = stay.shiftedStartDays;
    return {
      row: row as RoomStayRow,
      startDt: stay.startDt,
      endDt,
      urut: stay.urut,
      trx: stay.trx,
    };
  });
}

/**
 * Stay order: declared `urut_masuk_ruang` first (ascending), then admission
 * instant, then `no_transaksi` — a stable ascending sort, as in the Python.
 */
function compareStays(a: StayRecord, b: StayRecord): number {
  const aHasUrut = a.urut > 0 ? 0 : 1;
  const bHasUrut = b.urut > 0 ? 0 : 1;
  if (aHasUrut !== bHasUrut) return aHasUrut - bHasUrut;
  const aUrut = a.urut > 0 ? a.urut : 999999;
  const bUrut = b.urut > 0 ? b.urut : 999999;
  if (aUrut !== bUrut) return aUrut - bUrut;
  const aStart = a.startDt.getTime();
  const bStart = b.startDt.getTime();
  if (aStart !== bStart) return aStart - bStart;
  if (a.trx < b.trx) return -1;
  if (a.trx > b.trx) return 1;
  return 0;
}

/**
 * `_build_room_day_assignments` — hand every calendar day of the group to
 * exactly one room, keyed by `no_transaksi` with the dates sorted ascending.
 *
 * The scan runs from the first stay's admission to the latest discharge. For
 * each day, every stay that occupies at least one second of it becomes a
 * candidate, and the winner is the maximum of
 * `(priority_rank, overlap_seconds, earliest admission, urut_masuk_ruang)` —
 * that is:
 *
 *  - **Priority rank decides first, and it is absolute.** Critical care
 *    (ICU/ICCU/HCU/NICU/PICU/SCN) ranks 3, isolation ranks 2, an ordinary ward
 *    ranks 0 (see `getOverlapRoomPriorityRank`). One hour of ICU therefore beats
 *    twenty-three hours of ward on the same day: the day is billed as ICU.
 *  - **Then the longer occupancy** of that day wins.
 *  - **Then the earlier admission**, then the higher `urut_masuk_ruang`.
 *  - Ties fall back to stay order, because the sort is stable.
 *
 * The three-hour {@link ROOM_ASSIGN_PRIORITY_MARGIN_SECONDS} band the Python
 * applies afterwards is reproduced below but cannot change the winner (the
 * filter always keeps the leader and re-sorts with the same comparator); it is
 * kept so the code still reads like the original.
 *
 * Two fixups follow the scan:
 *
 *  - a stay whose own admission or discharge date somehow went unclaimed keeps
 *    that boundary day, but never one another room already owns;
 *  - `anchorStartDate` (the SEP/registration date) earlier than the first stay's
 *    admission prepends the missing lead-in days to the first stay and strips
 *    them from every other room.
 */
export function buildRoomDayAssignments(
  roomRows: readonly LegacyRow[],
  anchorStartDate = '',
  options: RoomStayOptions = {},
): Record<string, string[]> {
  return assignDaysToStays(computeNormalizedStays(roomRows, options), anchorStartDate);
}

function assignDaysToStays(
  stays: readonly NormalizedStay[],
  anchorStartDate: string,
): Record<string, string[]> {
  const assignments: Record<string, string[]> = {};
  for (const stay of stays) {
    if (stay.trx && !(stay.trx in assignments)) assignments[stay.trx] = [];
  }
  const firstStay = stays[0];
  if (!firstStay) return assignments;

  let latestEnd = firstStay.endDt;
  for (const stay of stays) {
    if (stay.endDt.getTime() > latestEnd.getTime()) latestEnd = stay.endDt;
  }

  for (const date of iterDatePartsFromDateTimes(firstStay.startDt, latestEnd)) {
    const candidates: DayCandidate[] = [];
    for (const stay of stays) {
      const overlapSeconds = secondsOverlapInDate(stay.startDt, stay.endDt, date);
      if (overlapSeconds <= 0) continue;
      const namaUnit = str(stay.row, 'nama_unit');
      candidates.push({
        overlapSeconds,
        startTs: Math.trunc(stay.startDt.getTime() / 1000),
        stay,
        priorityRank: getOverlapRoomPriorityRank(namaUnit),
        isPriorityRoom: isPriorityOverlapRoomName(namaUnit),
      });
    }
    if (candidates.length === 0) continue;

    candidates.sort(compareDayCandidates);
    let ownerCandidate = candidates[0] as DayCandidate;
    const topPriorityRank = ownerCandidate.priorityRank;
    const maxOverlap = ownerCandidate.overlapSeconds;
    const priorityCandidates = candidates.filter(
      (item) =>
        item.priorityRank === topPriorityRank &&
        (topPriorityRank > 0 ||
          maxOverlap - item.overlapSeconds <= ROOM_ASSIGN_PRIORITY_MARGIN_SECONDS),
    );
    if (priorityCandidates.length > 0) {
      priorityCandidates.sort(compareDayCandidates);
      ownerCandidate = priorityCandidates[0] as DayCandidate;
    }

    const ownerTrx = ownerCandidate.stay.trx;
    if (!ownerTrx) continue;
    const bucket = assignments[ownerTrx];
    if (bucket) bucket.push(date);
    else assignments[ownerTrx] = [date];
  }

  const assignedDates = new Set<string>();
  for (const dates of Object.values(assignments)) {
    for (const date of dates) {
      const trimmed = date.trim();
      if (trimmed) assignedDates.add(trimmed);
    }
  }

  for (const stay of stays) {
    if (!stay.trx) continue;
    const boundaryDates = [formatDateValue(stay.startDt), formatDateValue(stay.endDt)];
    for (const boundaryDate of new Set(boundaryDates)) {
      if (!boundaryDate) continue;
      if (secondsOverlapInDate(stay.startDt, stay.endDt, boundaryDate) <= 0) continue;
      // Fallback only. Never duplicate ownership of a day the scorer above
      // already awarded to some room.
      if (assignedDates.has(boundaryDate)) continue;
      const bucket = assignments[stay.trx] ?? [];
      assignments[stay.trx] = bucket;
      if (!bucket.includes(boundaryDate)) {
        bucket.push(boundaryDate);
        assignedDates.add(boundaryDate);
      }
    }
  }

  const anchorDate = datePart(anchorStartDate);
  const firstTrx = firstStay.trx;
  const firstActualDate = datePart(str(firstStay.row, '_actual_tgl_masuk', 'tgl_masuk'));
  if (firstTrx && anchorDate && firstActualDate) {
    const anchorDt = parseDateFlexible(anchorDate);
    const firstDt = parseDateFlexible(firstActualDate);
    if (anchorDt && firstDt && anchorDt.getTime() < firstDt.getTime()) {
      const prependDates = iterDateParts(anchorDate, formatDateValue(addDays(firstDt, -1)));
      const prepended = new Set(prependDates);
      const existing = assignments[firstTrx] ?? [];
      assignments[firstTrx] = [...prependDates, ...existing.filter((date) => !prepended.has(date))];
      for (const [trx, dates] of Object.entries(assignments)) {
        if (trx === firstTrx) continue;
        assignments[trx] = dates.filter((date) => !prepended.has(date));
      }
    }
  }

  for (const [trx, dates] of Object.entries(assignments)) {
    const unique = new Set<string>();
    for (const date of dates) {
      const trimmed = String(date).trim();
      if (trimmed) unique.add(trimmed);
    }
    assignments[trx] = [...unique].sort();
  }

  return assignments;
}

/**
 * Descending comparator for `(priority_rank, overlap_seconds, -start_ts, urut)`
 * — Python's `sorted(key=…, reverse=True)`, which reverses the comparison but
 * keeps equal elements in their original order.
 */
function compareDayCandidates(a: DayCandidate, b: DayCandidate): number {
  if (a.priorityRank !== b.priorityRank) return b.priorityRank - a.priorityRank;
  if (a.overlapSeconds !== b.overlapSeconds) return b.overlapSeconds - a.overlapSeconds;
  // Descending on the negated timestamp == ascending on the timestamp.
  if (a.startTs !== b.startTs) return a.startTs - b.startTs;
  if (a.stay.urut !== b.stay.urut) return b.stay.urut - a.stay.urut;
  return 0;
}

/**
 * `_get_room_group_date_range` — the declared span of a group, read straight
 * off `tgl_masuk`/`tgl_keluar` with no window repair (each row falls back to
 * the other field when one is missing). Used to bound history queries, which is
 * why it stays deliberately naive.
 */
export function getRoomGroupDateRange(roomRows: readonly LegacyRow[]): DateRange {
  const startCandidates: string[] = [];
  const endCandidates: string[] = [];
  for (const row of roomRows ?? []) {
    const startValue = datePart(str(row, 'tgl_masuk')) || datePart(str(row, 'tgl_keluar'));
    const endValue = datePart(str(row, 'tgl_keluar')) || datePart(str(row, 'tgl_masuk'));
    if (startValue) startCandidates.push(startValue);
    if (endValue) endCandidates.push(endValue);
  }
  if (startCandidates.length === 0) return { start: '', end: '' };
  return {
    start: minText(startCandidates),
    end: maxText(endCandidates.length > 0 ? endCandidates : startCandidates),
  };
}

/**
 * `_get_room_rows_date_bounds` — the *repaired* span of a group: earliest
 * normalised admission date to latest normalised discharge date.
 */
export function getRoomRowsDateBounds(
  roomRows: readonly LegacyRow[],
  options: RoomStayOptions = {},
): DateRange {
  const stays = computeNormalizedStays(roomRows, options);
  if (stays.length === 0) return { start: '', end: '' };
  return {
    start: minText(stays.map((stay) => formatDateValue(stay.startDt))),
    end: maxText(stays.map((stay) => formatDateValue(stay.endDt))),
  };
}

/**
 * `_pick_room_row_for_date` — the room row that owns `targetDate`.
 *
 * Prefers the day-assignment map, falls back to the first stay that merely
 * overlaps the date, and finally to the first stay of the group, so a caller
 * always gets a room to bill against. `undefined` only when the group has no
 * usable stay at all (the legacy `{}`).
 */
export function pickRoomRowForDate(
  roomRows: readonly LegacyRow[],
  targetDate: string,
  options: RoomStayOptions = {},
): RoomStayRow | undefined {
  const stays = computeNormalizedStays(roomRows, options);
  const firstStay = stays[0];
  if (!firstStay) return undefined;
  const target = datePart(targetDate);
  // The legacy code re-ran `_normalize_room_stays` over already-normalised
  // rows here; that pass is a no-op (starts are already strictly increasing and
  // every end is already clamped), so the stays are reused directly.
  const assignments = assignDaysToStays(stays, '');
  if (target) {
    const trxRow = new Map<string, RoomStayRow>();
    for (const stay of stays) {
      if (stay.trx) trxRow.set(stay.trx, stay.row);
    }
    const visited = new Set<string>();
    for (const stay of stays) {
      if (!stay.trx || visited.has(stay.trx)) continue;
      visited.add(stay.trx);
      if (assignments[stay.trx]?.includes(target)) return trxRow.get(stay.trx);
    }
    for (const stay of stays) {
      if (secondsOverlapInDate(stay.startDt, stay.endDt, target) > 0) return stay.row;
    }
  }
  return firstStay.row;
}

/**
 * `_build_room_owner_by_date` — invert a day-assignment map into
 * `date → room row`, reading the rows exactly as supplied (no normalisation).
 * Duplicate `no_transaksi` values resolve to the last row, as in the Python.
 */
export function buildRoomOwnerByDate(
  roomRows: readonly LegacyRow[],
  roomDayAssignments: Record<string, readonly string[]>,
): Record<string, LegacyRow> {
  const trxToRow = new Map<string, LegacyRow>();
  for (const row of roomRows ?? []) {
    const trx = str(row, 'no_transaksi');
    if (trx) trxToRow.set(trx, row);
  }
  const ownerByDate: Record<string, LegacyRow> = {};
  for (const [trx, dates] of Object.entries(roomDayAssignments ?? {})) {
    const roomRow = trxToRow.get(String(trx).trim());
    if (!roomRow) continue;
    for (const date of dates ?? []) ownerByDate[date] = roomRow;
  }
  return ownerByDate;
}

/**
 * `_group_rows_by_date` — tindakan rows bucketed by their own date
 * (`tgl_jam`, else `tgl_transaksi`), each bucket in {@link sortedRows} order.
 * Rows with no readable date land under the `''` key rather than being dropped.
 */
export function groupRowsByDate(rows: readonly LegacyRow[]): Record<string, LegacyRow[]> {
  const grouped: Record<string, LegacyRow[]> = {};
  for (const row of sortedRows(rows)) {
    pushGrouped(grouped, datePart(str(row, 'tgl_jam', 'tgl_transaksi')), row);
  }
  return grouped;
}

/**
 * `_group_rows_by_date_and_pelaksana` — bucketed by date *and* performer.
 *
 * The Python keys this map on the `(date, pelaksana)` tuple; here the two are
 * joined as `` `${date}|${pelaksana}` `` (the date is a fixed-width
 * `YYYY-MM-DD` or `''`, so splitting on the first `|` recovers both). A
 * pre-computed `_row_date` / `_pelaksana_key` on the row wins over the raw
 * fields, which is how upstream steps re-date a row before grouping it.
 */
export function groupRowsByDateAndPelaksana(rows: readonly LegacyRow[]): Record<string, LegacyRow[]> {
  const grouped: Record<string, LegacyRow[]> = {};
  for (const row of sortedRows(rows)) {
    const rowDate = str(row, '_row_date') || datePart(str(row, 'tgl_jam', 'tgl_transaksi'));
    const pelaksanaKey = str(row, '_pelaksana_key');
    pushGrouped(grouped, `${rowDate}|${pelaksanaKey}`, row);
  }
  return grouped;
}

/**
 * `_group_rows_by_pelaksana` — bucketed by the pre-computed `_pelaksana_key`
 * alone; rows without one share the `''` bucket.
 */
export function groupRowsByPelaksana(rows: readonly LegacyRow[]): Record<string, LegacyRow[]> {
  const grouped: Record<string, LegacyRow[]> = {};
  for (const row of sortedRows(rows)) {
    pushGrouped(grouped, str(row, '_pelaksana_key'), row);
  }
  return grouped;
}
