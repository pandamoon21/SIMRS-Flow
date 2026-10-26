/**
 * Date/time helpers ported from `ranap_v3.py`.
 *
 * The legacy endpoints hand back dates in at least eight shapes
 * ("2026-03-10", "10-03-2026 08:15:00", "10 Mar 2026", "03-100326-000123", …)
 * and the whole pipeline — room-day splitting, tindakan/visite date sync,
 * overlap detection — rests on the tolerant parsers below. They are ported
 * field-for-field instead of being replaced by a date library, because the
 * accepted-format list and the fallbacks *are* the behaviour.
 *
 * Conventions carried over from the Python:
 *  - a parsed value is a naive wall-clock instant (no timezone). It is modelled
 *    as a local-time `Date` and every formatter here reads it back with local
 *    getters, so parse → format round-trips exactly like `strptime`/`strftime`.
 *  - unparseable input yields `null` (Python `None`) or `''` — never a throw.
 *  - `%d`/`%m`/`%H`/`%M`/`%S` accept one *or* two digits and `%Y` exactly four,
 *    which is what `datetime.strptime` accepts.
 *  - calendar validity is enforced (2026-02-30 is rejected) because the Python
 *    `datetime` constructor rejects it.
 *  - nothing reads the clock implicitly: `buildUpdateDateTime` takes `now`.
 */

import type { LegacyRow } from './types.js';
import { str } from './types.js';

/** Milliseconds in a day — safe for whole-day distance because both ends are start-of-day. */
const MS_PER_DAY = 86_400_000;

/** `%b` in the C/English locale, which is what the legacy script runs under. */
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Which capture group holds what, so one matcher can serve every format. */
type FieldShape = 'ymd' | 'dmy' | 'dby';

interface DateFormat {
  readonly re: RegExp;
  readonly shape: FieldShape;
  /**
   * `len(datetime.now().strftime(fmt))` — `_parse_date_flexible` slices the
   * input to the rendered width of each format before parsing, which is how
   * "2026-03-10 08:15:00" gets accepted by the bare `%Y-%m-%d` pattern.
   */
  readonly width: number;
}

const YEAR = String.raw`(\d{4})`;
const NUM2 = String.raw`(\d{1,2})`;
const ABBR = String.raw`([A-Za-z]{3})`;
const TIME = String.raw`(\d{1,2}):(\d{1,2}):(\d{1,2})`;

/** `_parse_date_flexible` format list, in order, with its prefix widths. */
const DATE_FORMATS: readonly DateFormat[] = [
  { re: new RegExp(`^${YEAR}-${NUM2}-${NUM2}$`), shape: 'ymd', width: 10 }, // %Y-%m-%d
  { re: new RegExp(`^${NUM2}-${NUM2}-${YEAR}$`), shape: 'dmy', width: 10 }, // %d-%m-%Y
  { re: new RegExp(`^${YEAR}/${NUM2}/${NUM2}$`), shape: 'ymd', width: 10 }, // %Y/%m/%d
  { re: new RegExp(`^${NUM2}-${ABBR}-${YEAR}$`), shape: 'dby', width: 11 }, // %d-%b-%Y
  { re: new RegExp(`^${NUM2}\\s+${ABBR}\\s+${YEAR}$`), shape: 'dby', width: 11 }, // %d %b %Y
];

/** `%Y-%m-%d %H:%M:%S`, also used for the `txt[:19]` retry below. */
const ISO_SECONDS: Omit<DateFormat, 'width'> = {
  re: new RegExp(`^${YEAR}-${NUM2}-${NUM2}\\s+${TIME}$`),
  shape: 'ymd',
};

/** `_parse_datetime_flexible` format list, in order. These match the whole string. */
const DATETIME_FORMATS: readonly Omit<DateFormat, 'width'>[] = [
  ISO_SECONDS,
  { re: new RegExp(`^${YEAR}-${NUM2}-${NUM2}$`), shape: 'ymd' },
  { re: new RegExp(`^${NUM2}\\s+${ABBR}\\s+${YEAR}\\s+${TIME}$`), shape: 'dby' },
  { re: new RegExp(`^${NUM2}\\s+${ABBR}\\s+${YEAR}$`), shape: 'dby' },
  { re: new RegExp(`^${NUM2}-${ABBR}-${YEAR}\\s+${TIME}$`), shape: 'dby' },
  { re: new RegExp(`^${NUM2}-${ABBR}-${YEAR}$`), shape: 'dby' },
  { re: new RegExp(`^${NUM2}-${NUM2}-${YEAR}\\s+${TIME}$`), shape: 'dmy' },
  { re: new RegExp(`^${NUM2}-${NUM2}-${YEAR}$`), shape: 'dmy' },
];

// ── parsing ──────────────────────────────────────────────────────

/**
 * `_parse_date_flexible` — date-first parser.
 *
 * Tries `%Y-%m-%d`, `%d-%m-%Y`, `%Y/%m/%d`, `%d-%b-%Y`, `%d %b %Y` against the
 * input truncated to each format's rendered width, then falls back to the
 * datetime parser. `null` when nothing matches.
 */
export function parseDateFlexible(s: unknown): Date | null {
  const txt = pyText(s);
  if (!txt) return null;
  for (const format of DATE_FORMATS) {
    const parsed = applyFormat(txt.slice(0, format.width), format);
    if (parsed) return parsed;
  }
  return parseDateTimeFlexible(txt);
}

/**
 * `_parse_datetime_flexible` — datetime-first parser.
 *
 * Whole-string match against the eight accepted formats (ISO, `%d %b %Y`,
 * `%d-%b-%Y`, `%d-%m-%Y`, each with and without `HH:MM:SS`), then one last
 * attempt at `%Y-%m-%d %H:%M:%S` on the first 19 characters — the escape hatch
 * that lets trailing milliseconds/timezone junk through.
 */
export function parseDateTimeFlexible(s: unknown): Date | null {
  const txt = pyText(s);
  if (!txt) return null;
  for (const format of DATETIME_FORMATS) {
    const parsed = applyFormat(txt, format);
    if (parsed) return parsed;
  }
  if (txt.length >= 19) {
    return applyFormat(txt.slice(0, 19), ISO_SECONDS);
  }
  return null;
}

/**
 * `_date_part` — the `YYYY-MM-DD` of anything date-ish.
 *
 * Falsy input gives `''`. Note the Python fallback, kept here: when neither
 * parser recognises the text it returns the raw first ten characters rather
 * than `''`, so genuinely non-date text comes back mangled rather than empty.
 */
export function datePart(s: unknown): string {
  const txt = pyText(s);
  if (!txt) return '';
  const parsed = parseDateTimeFlexible(s) ?? parseDateFlexible(s);
  if (parsed) return formatDate(parsed);
  return txt.slice(0, 10);
}

/** `_time_part` — the `HH:MM:SS` of a datetime, or `fallback` when there is none. */
export function timePart(s: unknown, fallback = '00:00:00'): string {
  const parsed = parseDateTimeFlexible(s);
  return parsed ? formatTime(parsed) : fallback;
}

// ── composing update payloads ────────────────────────────────────

/**
 * `_combine_date_time` — glue a date and a time into `YYYY-MM-DD HH:MM:SS`.
 *
 * A five-character time ("08:15") is widened to seconds; anything longer is cut
 * to eight characters. An empty date part collapses the whole result to `''`.
 */
export function combineDateTime(date: string, time = '00:00:00'): string {
  const day = datePart(date);
  let clock = time ? String(time).trim() : '00:00:00';
  if (clock.length === 5) clock += ':00';
  return day ? `${day} ${clock.slice(0, 8)}` : '';
}

/**
 * `_normalize_update_time` — the time SIMRS will accept on an update.
 *
 * Midnight is replaced by `fallback` (default `00:00:01`): the legacy backend
 * treats a `00:00:00` timestamp as "no time given" and re-derives it, which is
 * exactly what the date sync is trying to override.
 */
export function normalizeUpdateTime(time = '', fallback = '00:00:01'): string {
  let normalized = time ? String(time).trim() : '';
  if (normalized.length === 5) normalized += ':00';
  normalized = normalized.slice(0, 8);
  if (!normalized || normalized === '00:00' || normalized === '00:00:00') return fallback;
  return normalized;
}

/**
 * `_build_update_datetime` — the timestamp written by `update_tgl`.
 *
 * Faithful quirk: the Python stamps *the current wall-clock time* onto the
 * target date and ignores `sourceDateTime` entirely. `now` is injectable here
 * because nothing in this module is allowed to read the clock implicitly.
 */
export function buildUpdateDateTime(
  date: string,
  sourceDateTime?: string,
  defaultTime = '00:00:01',
  now: Date = new Date(),
): string {
  // sourceDateTime is accepted for call-site parity only — the Python drops it.
  return combineDateTime(date, normalizeUpdateTime(formatTime(now), defaultTime));
}

// ── row-oriented resolution ──────────────────────────────────────

/**
 * `_extract_date_from_no_transaksi` — mine the date out of a transaction id.
 *
 * Transaction numbers embed `DDMMYY` in their second segment
 * ("03-100326-000123" → 2026-03-10). No calendar validation: the Python trusts
 * the segment, and so does this.
 */
export function extractDateFromNoTransaksi(noTransaksi: unknown): string {
  const raw = pyText(noTransaksi);
  const match = /^[a-z0-9]+-(\d{2})(\d{2})(\d{2})-/i.exec(raw);
  if (!match) return '';
  const [, day, month, year] = match;
  return `20${year}-${month}-${day}`;
}

/**
 * `_resolve_target_datetime_from_history_item` — the datetime a history row
 * should be aligned to: its own transaction date if parseable, otherwise
 * midnight-plus-one-second on the date encoded in `no_transaksi`.
 */
export function resolveTargetDateTimeFromHistoryItem(item: LegacyRow): string {
  const parsed = parseDateTimeFlexible(str(item, 'tgl_transaksi', 'tgl_order', 'tgl_masuk'));
  if (parsed) return `${formatDate(parsed)} ${formatTime(parsed)}`;
  const trxDate = extractDateFromNoTransaksi(str(item, 'no_transaksi'));
  if (trxDate) return `${trxDate} 00:00:01`;
  return '';
}

/**
 * `_expand_target_dates` — the sorted, repeated list of dates a set of target
 * rows covers. `detailCountGetter` repeats a row's date once per detail line
 * (a lab order with three tests contributes its date three times); a throwing
 * or non-numeric count degrades to one, as in the Python.
 */
export function expandTargetDates(
  targetRows: readonly LegacyRow[],
  detailCountGetter?: (row: LegacyRow) => number,
): string[] {
  const dates: string[] = [];
  for (const row of targetRows) {
    const parsed = parseDateTimeFlexible(str(row, 'tgl_transaksi', 'tgl_order', 'tgl_masuk'));
    if (!parsed) continue;
    let repeat = 1;
    if (detailCountGetter) {
      try {
        const count = Math.trunc(detailCountGetter(row));
        repeat = Number.isFinite(count) ? Math.max(1, count) : 1;
      } catch {
        repeat = 1;
      }
    }
    const text = formatDate(parsed);
    for (let i = 0; i < repeat; i += 1) dates.push(text);
  }
  dates.sort(); // ISO dates sort lexicographically == chronologically
  return dates;
}

// ── day ranges and overlap ───────────────────────────────────────

/**
 * `_iter_date_parts` — inclusive `YYYY-MM-DD` list between two dates.
 *
 * One missing end is filled from the other, reversed ends are swapped, and two
 * unparseable ends give `[]`.
 */
export function iterDateParts(startDate: string, endDate: string): string[] {
  let start = parseDateFlexible(startDate);
  let end = parseDateFlexible(endDate);
  if (!start && !end) return [];
  if (!start) start = end;
  if (!end) end = start;
  if (!start || !end) return [];
  if (end.getTime() < start.getTime()) [start, end] = [end, start];
  const out: string[] = [];
  const cursor = new Date(start.getTime());
  const limit = end.getTime();
  while (cursor.getTime() <= limit) {
    out.push(formatDate(cursor));
    cursor.setDate(cursor.getDate() + 1); // calendar step, so DST cannot skew it
  }
  return out;
}

/** `_start_of_day` — same date at 00:00:00.000, as a new instant. */
export function startOfDay(d: Date): Date {
  const out = new Date(d.getTime());
  out.setHours(0, 0, 0, 0);
  return out;
}

/** `_end_of_day` — same date at 23:59:59.000, as a new instant. */
export function endOfDay(d: Date): Date {
  const out = new Date(d.getTime());
  out.setHours(23, 59, 59, 0);
  return out;
}

/** `_iter_date_parts_from_datetimes` — `iterDateParts` for already-parsed ends. */
export function iterDatePartsFromDateTimes(start: Date | null, end: Date | null): string[] {
  if (!start && !end) return [];
  const from = start ?? end;
  const to = end ?? start;
  if (!from || !to) return [];
  return iterDateParts(formatDate(from), formatDate(to));
}

/**
 * `_seconds_overlap_in_date` — how many seconds of `[start, end)` fall inside
 * one calendar day. The day is clamped to `00:00:00 … 23:59:59`, so a stay that
 * fully covers a day scores 86399, not 86400 — that off-by-one is the Python's
 * and the room-day allocator is calibrated to it.
 */
export function secondsOverlapInDate(start: Date, end: Date, datePart: string): number {
  const day = parseDateFlexible(datePart);
  if (!day) return 0;
  const dayStart = startOfDay(day).getTime();
  const dayEnd = endOfDay(day).getTime();
  const effectiveStart = Math.max(start.getTime(), dayStart);
  const effectiveEnd = Math.min(end.getTime(), dayEnd);
  if (effectiveEnd <= effectiveStart) return 0;
  return Math.trunc((effectiveEnd - effectiveStart) / 1000);
}

/**
 * `_clamp_tolerance_days` — the ±days window, forced into 0…7.
 *
 * The Python `int()` raises on junk; here junk clamps to 0 (the tightest, and
 * therefore safest, window) because the signature promises a number.
 */
export function clampToleranceDays(value: unknown): number {
  const truncated = pyInt(value);
  if (truncated === null) return 0;
  return Math.max(0, Math.min(truncated, 7));
}

/**
 * Absolute whole-day distance between two date parts;
 * `Number.POSITIVE_INFINITY` when either side is unparseable, so a
 * `<= tolerance` test fails closed.
 */
export function daysBetweenDates(a: string, b: string): number {
  const left = parseDateFlexible(a);
  const right = parseDateFlexible(b);
  if (!left || !right) return Number.POSITIVE_INFINITY;
  const diff = startOfDay(left).getTime() - startOfDay(right).getTime();
  return Math.abs(Math.round(diff / MS_PER_DAY));
}

// ── internals ────────────────────────────────────────────────────

/** Python's `str(value or "").strip()`: every falsy input collapses to `''`. */
function pyText(value: unknown): string {
  if (!value) return '';
  return String(value).trim();
}

/** Python's `int(value)` on a scalar: whole numbers only, truncated toward zero. */
function pyInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = pyText(value);
  if (!/^[+-]?\d+$/.test(text)) return null;
  return Number(text);
}

/** Run one format against an exact string; `null` on no match or an invalid date. */
function applyFormat(text: string, format: Omit<DateFormat, 'width'>): Date | null {
  const match = format.re.exec(text);
  if (!match) return null;
  const [, first, second, third, hour, minute, sec] = match;
  let year: number;
  let month: number;
  let day: number;
  switch (format.shape) {
    case 'ymd':
      year = toNumber(first);
      month = toNumber(second);
      day = toNumber(third);
      break;
    case 'dmy':
      day = toNumber(first);
      month = toNumber(second);
      year = toNumber(third);
      break;
    default:
      day = toNumber(first);
      month = MONTH_ABBR.indexOf((second ?? '').toLowerCase()) + 1; // 0 => rejected below
      year = toNumber(third);
      break;
  }
  return makeNaiveDate(year, month, day, toNumber(hour, 0), toNumber(minute, 0), toNumber(sec, 0));
}

function toNumber(text: string | undefined, fallback = Number.NaN): number {
  return text === undefined ? fallback : Number(text);
}

/**
 * Build a local-time `Date` from wall-clock fields, rejecting what the Python
 * `datetime` constructor rejects (month 13, 31 April, hour 24, second 60).
 */
function makeNaiveDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): Date | null {
  const fields = [year, month, day, hour, minute, second];
  if (!fields.every((value) => Number.isInteger(value))) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const out = new Date(year, month - 1, day, hour, minute, second, 0);
  // `new Date(26, …)` means 1926; %Y accepts four digits, so restore small years.
  if (year >= 0 && year < 100) out.setFullYear(year);
  if (out.getFullYear() !== year || out.getMonth() !== month - 1 || out.getDate() !== day) {
    return null; // rolled over (e.g. 2026-02-30) — not a real date
  }
  return out;
}

/**
 * `strftime("%Y-%m-%d")` on a naive (local) instant.
 *
 * Every date the pipeline writes back to SIMRS must go through this, never
 * `toISOString()`: an ISO conversion shifts the calendar day backwards for any
 * instant after local midnight in a positive-offset zone, which is exactly the
 * day the penunjang window and the IGD admission date are computed from.
 */
export function formatDate(d: Date): string {
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `strftime("%H:%M:%S")` on a naive (local) instant. */
function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
