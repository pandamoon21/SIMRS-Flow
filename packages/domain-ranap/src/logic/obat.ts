/**
 * Take-home-medicine (obat pulang) matching ported from `ranap_v3.py`.
 *
 * The problem this solves: the pharmacy's order history (`gethistoryobat_inap`)
 * and the billing rows (`BIAYA OBAT` on the inpatient charge list) are two
 * separate records of the same drugs, joined by nothing but the item names,
 * quantities and money. `matchHistoryObatToBiayaRows` is the join: it pairs
 * each billing row with at most one pharmacy order, exact signatures first,
 * then a fuzzy pass, so the pipeline can decide which billing row is the
 * discharge medication and re-date it.
 *
 * Entries are plain `LegacyRow` dicts keyed exactly like the Python's, because
 * the history side is assembled by the caller (`_get_history_obat_entries`
 * pages through two endpoints) and both sides have to agree on the field names.
 * The keys used here are: `no_order`, `order_dt`, `order_date`, `ruang`,
 * `signature_exact`, `signature_names`, `item_count`, `total_amount`,
 * `take_home_names`, `is_take_home`, `detail_names`, plus `row`, `no_referensi`,
 * `reference_date`, `current_dt` and `current_date` on the billing side.
 *
 * Hoisted fetches (endpoint → parameter):
 *  - `poliklinik/verifikator/getdetail_transaksi`
 *    (`verifikator_getdetail_transaksi(no_referensi, kd_tindakan)`, called by
 *    `_build_biaya_obat_detail_entry`) → `buildBiayaObatDetailEntry`'s
 *    `detailRows`.
 *  - `poliklinik/penatajasa_inap/getdetail_historyobat`
 *    (`getdetail_historyobat_inap(no_order)`, called by
 *    `_get_history_obat_entries`) → `buildHistoryObatEntry`'s `detailRows`.
 *  - `_biaya_entry_is_on_discharge` closes over the group's discharge date →
 *    the `dischargeDate` parameter.
 */

import type { LegacyRow } from './types.js';
import { flag, str } from './types.js';
import { datePart, daysBetweenDates, extractDateFromNoTransaksi, parseDateTimeFlexible } from './dates.js';
import { extractRoomSegments, looksLikeTakeHomeMedName } from './names.js';
import { normalizeTextKey, parseCurrencyInt, safeInt } from './scalars.js';

/** `_preview_obat_detail_names(detail_rows, limit=12)`. */
const DETAIL_NAME_PREVIEW_LIMIT = 12;

/** `_preview_unique_log_items(values, limit=8)`. */
const LOG_ITEM_PREVIEW_LIMIT = 8;

/** `_build_biaya_obat_detail_entry` previews 20 names, not 12. */
const ENTRY_DETAIL_NAME_LIMIT = 20;

/**
 * `kd_tindakan` the Python falls back to when a `BIAYA OBAT` row has none —
 * exported because the caller now performs the hoisted detail fetch
 * (`verifikator_getdetail_transaksi(no_referensi, kd_tindakan)`).
 */
export const DEFAULT_OBAT_KD_TINDAKAN = '16';

/** Loose matching needs 80% name coverage on *both* sides. */
const LOOSE_COVERAGE_MIN = 0.8;

/** ...and the two totals may differ by at most Rp 30.000. */
const LOOSE_TOTAL_TOLERANCE = 30_000;

/** `_build_obat_detail_signature` result. Keys are the Python's. */
export type ObatDetailSignature = {
  /** `"NAMA::qty||NAMA::qty"`, sorted — the exact-match fingerprint. */
  signature_exact: string;
  /** `"NAMA||NAMA"`, sorted — the loose-match fingerprint. */
  signature_names: string;
  item_count: number;
  total_amount: number;
  /** Original (un-normalized) names that look like discharge medication. */
  take_home_names: string[];
};

/** One pairing produced by {@link matchHistoryObatToBiayaRows}. */
export interface ObatMatch {
  /** The pharmacy order entry. */
  history: LegacyRow;
  /** The `BIAYA OBAT` entry it was paired with. */
  biaya: LegacyRow;
  /** `"exact"` or `"loose"` — which pass produced the pairing. */
  mode: string;
  /**
   * Whole days between the order date and the date encoded in the billing
   * row's `no_referensi` — the first component of the Python's sort key
   * `(ref_delta, |order_dt - current_dt| seconds, no_order)`. Lower is better;
   * the remaining components only break ties and are not surfaced.
   */
  score: number;
}

/** Python's `str(value or "").strip()` on a bare value. */
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return (typeof value === 'string' ? value : String(value)).trim();
}

/** `dict.fromkeys(...)` — de-duplicate, first occurrence wins. */
function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * Read a datetime field off an entry.
 *
 * The Python stores real `datetime` objects on its entry dicts; an entry that
 * has been through JSON (a replayed run, a fixture) carries the string form
 * instead, so both are accepted.
 */
function entryDateTime(entry: LegacyRow, key: string, ...fallbackKeys: string[]): Date | null {
  const value = entry[key];
  if (value instanceof Date) return value;
  return parseDateTimeFlexible(str(entry, key, ...fallbackKeys));
}

/**
 * `_normalize_obat_detail_name` — the comparison form of a drug name:
 * uppercased, punctuation folded to single spaces, trimmed.
 */
export function normalizeObatDetailName(value: unknown): string {
  return normalizeTextKey(value).split(/\s+/).filter(Boolean).join(' ');
}

/**
 * `_build_obat_detail_signature` — fingerprint a set of detail rows.
 *
 * `qty` floors at 1 and a missing `jumlah` is recomputed as `harga * qty`, so a
 * backend that only fills one of the two money columns still produces a
 * comparable total. Rows with no readable name are ignored entirely.
 */
export function buildObatDetailSignature(detailRows: readonly LegacyRow[]): ObatDetailSignature {
  const exactParts: string[] = [];
  const namesOnlyParts: string[] = [];
  const takeHomeNames: string[] = [];
  let totalAmount = 0;

  for (const item of detailRows ?? []) {
    const nama = normalizeObatDetailName(str(item, 'nama_obat', 'nama_tindakan'));
    if (!nama) continue;
    const qty = Math.max(1, safeInt(item['qty'], 1));
    exactParts.push(`${nama}::${qty}`);
    namesOnlyParts.push(nama);
    let jumlah = parseCurrencyInt(item['jumlah'], 0);
    if (jumlah <= 0) jumlah = parseCurrencyInt(item['harga'], 0) * qty;
    totalAmount += Math.max(0, jumlah);
    const namaAsli = str(item, 'nama_obat', 'nama_tindakan');
    if (namaAsli && looksLikeTakeHomeMedName(namaAsli)) takeHomeNames.push(namaAsli);
  }

  exactParts.sort();
  namesOnlyParts.sort();
  return {
    signature_exact: exactParts.join('||'),
    signature_names: namesOnlyParts.join('||'),
    item_count: exactParts.length,
    total_amount: totalAmount,
    take_home_names: uniqueInOrder(takeHomeNames),
  };
}

/**
 * `_preview_obat_detail_names` — the first `limit` distinct original names, for
 * the operator log. De-duplicated on the normalized key, printed as received.
 */
export function previewObatDetailNames(
  detailRows: readonly LegacyRow[],
  limit: number = DETAIL_NAME_PREVIEW_LIMIT,
): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  const maxItems = Math.max(1, Math.trunc(limit || DETAIL_NAME_PREVIEW_LIMIT));
  for (const item of detailRows ?? []) {
    const nama = str(item, 'nama_obat', 'nama_tindakan');
    if (!nama) continue;
    const key = normalizeTextKey(nama);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(nama);
    if (items.length >= maxItems) break;
  }
  return items;
}

/**
 * `_preview_unique_log_items` — de-duplicate, cap at `limit`, and (unless
 * `overflowSuffix` is off) append `"+N item lagi"`.
 */
export function previewUniqueLogItems(
  values: readonly unknown[],
  limit: number = LOG_ITEM_PREVIEW_LIMIT,
  overflowSuffix = true,
): string[] {
  const uniqueItems: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const itemText = text(value);
    if (!itemText) continue;
    const key = normalizeTextKey(itemText);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniqueItems.push(itemText);
  }
  const maxItems = Math.max(1, Math.trunc(limit || LOG_ITEM_PREVIEW_LIMIT));
  if (uniqueItems.length <= maxItems) return uniqueItems;
  const preview = uniqueItems.slice(0, maxItems);
  if (overflowSuffix) preview.push(`+${uniqueItems.length - maxItems} item lagi`);
  return preview;
}

/**
 * `_build_biaya_obat_detail_entry` — wrap one `BIAYA OBAT` charge row with its
 * detail fingerprint so it can be matched against the pharmacy history.
 *
 * `detailRows` is the hoisted `verifikator_getdetail_transaksi(no_referensi,
 * kd_tindakan)` result (`kd_tindakan` defaults to `"16"` in the Python, kept
 * here as {@link DEFAULT_OBAT_KD_TINDAKAN} for callers doing the fetch).
 *
 * Deviation: the Python keeps `reference_dt` as a `datetime`; this port keeps
 * `reference_date` as the `YYYY-MM-DD` string, because the only two consumers
 * (`_score` and `_biaya_entry_is_on_discharge`) immediately reduce it to a date.
 */
export function buildBiayaObatDetailEntry(
  row: LegacyRow,
  detailRows: readonly LegacyRow[] = [],
): LegacyRow {
  const noReferensi = str(row, 'no_referensi');
  const signature = buildObatDetailSignature(detailRows);
  const tglSource = str(row, 'tgl_jam', 'tgl_transaksi');
  return {
    row,
    no_referensi: noReferensi,
    reference_date: noReferensi ? extractDateFromNoTransaksi(noReferensi) : '',
    current_dt: parseDateTimeFlexible(tglSource),
    current_date: datePart(tglSource),
    detail_rows: [...(detailRows ?? [])],
    ...signature,
    is_take_home: signature.take_home_names.length > 0,
    detail_names: previewObatDetailNames(detailRows, ENTRY_DETAIL_NAME_LIMIT),
  };
}

/**
 * One enriched pharmacy-order entry, as `_get_history_obat_entries`
 * (ranap_v3.py:5833) builds it.
 *
 * `orderRow` is a `gethistoryobat_inap` row; `detailRows` is that order's
 * `getdetail_historyobat` answer, keyed by the row's `no_order`. The caller
 * performs both reads (this module never touches the network) and is
 * responsible for the Python's de-duplication on `no_order` — see
 * {@link sortHistoryObatEntries} for the ordering it then applies.
 *
 * Without the detail read an entry has no `signature_exact` at all, so
 * {@link matchHistoryObatToBiayaRows}'s exact pass can never fire and its loose
 * pass has an empty name set to work with: the match degrades to nothing. That
 * is the difference this function exists to remove.
 *
 * Deviation from the Python, mirroring {@link buildBiayaObatDetailEntry}:
 * `order_dt` is kept as the parsed `Date` (or `null`) and `order_date` as the
 * `YYYY-MM-DD` string, because the scorer reduces both to exactly that.
 */
export function buildHistoryObatEntry(
  orderRow: LegacyRow,
  detailRows: readonly LegacyRow[] = [],
): LegacyRow {
  const signature = buildObatDetailSignature(detailRows);
  const tglOrder = str(orderRow, 'tgl_order');
  return {
    no_order: str(orderRow, 'no_order'),
    tgl_order: tglOrder,
    order_dt: parseDateTimeFlexible(tglOrder),
    order_date: datePart(tglOrder),
    ruang: str(orderRow, 'ruang'),
    detail_rows: [...(detailRows ?? [])],
    ...signature,
    is_take_home: signature.take_home_names.length > 0,
    detail_names: previewObatDetailNames(detailRows, ENTRY_DETAIL_NAME_LIMIT),
  };
}

/**
 * `entries.sort(key=lambda item: ((order_dt or datetime.min), str(no_order)))`
 * (ranap_v3.py:5875) — oldest order first, `no_order` breaking ties. An
 * unparseable `tgl_order` sorts first, as `datetime.min` does.
 */
export function sortHistoryObatEntries(entries: readonly LegacyRow[]): LegacyRow[] {
  return [...entries].sort((a, b) => {
    const left = entryDateTime(a, 'order_dt', 'tgl_order')?.getTime() ?? Number.NEGATIVE_INFINITY;
    const right = entryDateTime(b, 'order_dt', 'tgl_order')?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (left !== right) return left - right;
    const leftOrder = str(a, 'no_order');
    const rightOrder = str(b, 'no_order');
    if (leftOrder === rightOrder) return 0;
    return leftOrder < rightOrder ? -1 : 1;
  });
}

/** The name set behind a `signature_names` string. */
function nameSet(entry: LegacyRow): Set<string> {
  const raw = text(entry['signature_names']);
  const names = new Set<string>();
  for (const part of raw.split('||')) {
    if (part.trim()) names.add(part);
  }
  return names;
}

/** `_compatible` — may this pharmacy order be the source of this charge row? */
function compatible(history: LegacyRow, biaya: LegacyRow, mode: string): boolean {
  if (mode === 'exact') {
    const historySignature = text(history['signature_exact']);
    return Boolean(historySignature) && historySignature === text(biaya['signature_exact']);
  }
  const historyNames = nameSet(history);
  const biayaNames = nameSet(biaya);
  if (historyNames.size === 0 || biayaNames.size === 0) return false;
  let overlap = 0;
  for (const name of historyNames) {
    if (biayaNames.has(name)) overlap += 1;
  }
  if (overlap <= 0) return false;
  const historyCoverage = overlap / Math.max(1, historyNames.size);
  const biayaCoverage = overlap / Math.max(1, biayaNames.size);
  if (historyCoverage < LOOSE_COVERAGE_MIN || biayaCoverage < LOOSE_COVERAGE_MIN) return false;
  const historyTotal = safeInt(history['total_amount'], 0);
  const biayaTotal = safeInt(biaya['total_amount'], 0);
  if (historyTotal && biayaTotal && Math.abs(historyTotal - biayaTotal) > LOOSE_TOTAL_TOLERANCE) {
    return false;
  }
  return true;
}

/** `_score` — `(ref_delta days, |order_dt - current_dt| seconds, no_order)`. */
function scoreParts(history: LegacyRow, biaya: LegacyRow): [number, number, string] {
  const orderDt = entryDateTime(history, 'order_dt', 'tgl_order');
  const orderDate = str(history, 'order_date') || (orderDt ? datePart(orderDt) : '');
  const referenceDate = str(biaya, 'reference_date');
  const currentDt = entryDateTime(biaya, 'current_dt', 'tgl_jam', 'tgl_transaksi');

  let refDelta = 0;
  if (referenceDate && orderDate) {
    const diff = daysBetweenDates(orderDate, referenceDate);
    refDelta = Number.isFinite(diff) ? diff : 0;
  }
  let currentDelta = 0;
  if (currentDt !== null && orderDt !== null) {
    currentDelta = Math.abs((orderDt.getTime() - currentDt.getTime()) / 1000);
  }
  return [refDelta, currentDelta, str(history, 'no_order')];
}

/**
 * `_match_history_obat_to_biaya_rows` — pair pharmacy orders with `BIAYA OBAT`
 * charge rows.
 *
 * Two passes: `exact` (identical name+qty fingerprints) then `loose` (≥80% name
 * overlap both ways and totals within Rp 30.000). Each charge row is paired at
 * most once and each order is consumed at most once; among the compatible
 * orders the closest one wins, ranked by
 * `(days from no_referensi date, seconds from the charge timestamp, no_order)`.
 *
 * Unlike the Python this does not stamp `_matched` onto the caller's entries —
 * the bookkeeping is local, so the inputs stay untouched.
 */
export function matchHistoryObatToBiayaRows(
  historyEntries: readonly LegacyRow[],
  biayaEntries: readonly LegacyRow[],
): ObatMatch[] {
  const matches: ObatMatch[] = [];
  const remainingHistory: LegacyRow[] = [...(historyEntries ?? [])];
  const matchedBiaya = new Set<LegacyRow>();

  for (const mode of ['exact', 'loose']) {
    for (const biaya of biayaEntries ?? []) {
      if (matchedBiaya.has(biaya) || flag(biaya['_matched'])) continue;
      const candidates = remainingHistory
        .map((history) => ({ history, score: scoreParts(history, biaya) }))
        .filter((candidate) => compatible(candidate.history, biaya, mode));
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => {
        if (a.score[0] !== b.score[0]) return a.score[0] - b.score[0];
        if (a.score[1] !== b.score[1]) return a.score[1] - b.score[1];
        if (a.score[2] === b.score[2]) return 0;
        return a.score[2] < b.score[2] ? -1 : 1;
      });
      const best = candidates[0] as { history: LegacyRow; score: [number, number, string] };
      remainingHistory.splice(remainingHistory.indexOf(best.history), 1);
      matchedBiaya.add(biaya);
      matches.push({ mode, history: best.history, biaya, score: best.score[0] });
    }
  }
  return matches;
}

/**
 * `_history_obat_matches_room` — did this pharmacy order come from this room?
 *
 * The order's `ruang` and the room's `nama_unit` are compared as substrings in
 * both directions, then against the room's individual segments ("SCN / KELAS 3"
 * → `SCN`), because the two endpoints spell rooms differently.
 */
export function historyObatMatchesRoom(entry: LegacyRow, roomName: string): boolean {
  const roomKey = normalizeTextKey(roomName);
  const orderRoomKey = normalizeTextKey(entry?.['ruang']);
  if (!roomKey || !orderRoomKey) return false;
  if (roomKey.includes(orderRoomKey) || orderRoomKey.includes(roomKey)) return true;
  const roomSegments = new Set(
    extractRoomSegments(roomName)
      .map((item) => normalizeTextKey(item))
      .filter((item) => item.length > 0),
  );
  return roomSegments.has(orderRoomKey);
}

/**
 * `_biaya_entry_is_on_discharge` — is this charge row dated on the discharge
 * day, either by its own timestamp or by the date encoded in its
 * `no_referensi`? The Python closes over `discharge_date`; here it is a
 * parameter. An empty discharge date is never a match.
 */
export function biayaEntryIsOnDischarge(item: LegacyRow, dischargeDate: string): boolean {
  const discharge = text(dischargeDate);
  if (!discharge) return false;
  const currentDate = str(item, 'current_date');
  const referenceDate = str(item, 'reference_date');
  return currentDate === discharge || referenceDate === discharge;
}
