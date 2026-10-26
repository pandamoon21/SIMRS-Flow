/**
 * Visit-candidate selection ported from `ranap_v3.py`.
 *
 * `selectKunjunganPaymentCandidates` is the gate that decides which rows of a
 * patient's visit history belong to the inpatient episode being processed —
 * everything downstream (tampung bayar, verification, mutations) only ever
 * sees rows this function returns, so its filters are a safety control, not a
 * convenience. The three `find*Candidates` helpers are the negative checks
 * that stop a run when an episode has already been verified or paid, or when
 * it contains a unit that must never be batch-paid.
 *
 * Hoisted fetches (the Python calls these mid-function; here they are
 * parameters, so this module stays pure and offline):
 *  - `_resolve_kunjungan_sep_key` → `resolveSepKey`. The Python reads
 *    `row["no_sep"]` and, when absent, falls back to
 *    `pendaftaran/.../getdatatransaksi` then `.../getdatakunjungan`. The
 *    default here is the row field only; pass a resolver to reproduce the
 *    fallback with data the caller has already fetched.
 *  - `kasir/kasir_rawatinap/cekstatus_verifikasi` (`cekstatus_verifikasi_kasir`)
 *    → `verificationStatus(trx)` in `findVerifiedPaymentCandidates`.
 *  - `kasir/kasir_rawatinap/gethistory_pembayaran` (`gethistory_pembayaran_kasir`)
 *    → `paymentHistory(row)` in `findPaidPaymentCandidates`.
 */

import type { LegacyRow } from './types.js';
import { str } from './types.js';
import { clampToleranceDays, datePart, daysBetweenDates, parseDateFlexible, parseDateTimeFlexible } from './dates.js';
import {
  isAcceptedPenjamin,
  isExcludedTampungBayarUnit,
  isPremiumRoomForPaymentGuard,
  isUnpaidKunjunganStatus,
  looksLikeManualFollowupTransaction,
} from './names.js';
import { normalizeTextKey } from './scalars.js';

/** Inpatient transactions are the episode anchors. */
const INAP_PREFIX = '03-';

/** Outpatient transactions are never auto-selected into a payment episode. */
const RAWAT_JALAN_PREFIX = '01-';

/** Arguments of `_select_kunjungan_payment_candidates`. */
export interface SelectKunjunganPaymentCandidatesArgs {
  /** `gethistorykunjungan` rows, in backend order. */
  rows: readonly LegacyRow[];
  /** Target admission date (any format `parseDateFlexible` understands). */
  tanggal: string;
  /** Clamped to 0..7 exactly like the Python; defaults to `main()`'s 3. */
  toleranceDays?: number;
  /** Only used by the hoisted SEP resolver. */
  noRm?: string;
  /** `null`/omitted keeps the default BPJS keywords; `[]` accepts every penjamin. */
  acceptedPenjaminKeywords?: readonly string[] | null;
  /** Hoisted `_resolve_kunjungan_sep_key`; defaults to the row's `no_sep`. */
  resolveSepKey?: (row: LegacyRow, noRm: string) => string;
}

/** Stand-in for Python's tuple keys — unambiguous for any field content. */
function tupleKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

/** `(no_transaksi, no_registrasikunjungan)` — the Python's row identity tuple. */
function rowKey(row: LegacyRow): string {
  return tupleKey(str(row, 'no_transaksi'), str(row, 'no_registrasikunjungan'));
}

/** Python's tuple compare on `(datetime, str)`, descending, ties left in place. */
function compareAnchorDesc(a: LegacyRow, b: LegacyRow): number {
  const aDt = parseDateTimeFlexible(a['tgl_masuk'])?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bDt = parseDateTimeFlexible(b['tgl_masuk'])?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aDt !== bDt) return bDt - aDt;
  const aTrx = str(a, 'no_transaksi');
  const bTrx = str(b, 'no_transaksi');
  if (aTrx === bTrx) return 0;
  return aTrx < bTrx ? 1 : -1;
}

/** `dt +/- timedelta(days=n)`, calendar-safe. */
function shiftDays(value: Date, days: number): Date {
  const shifted = new Date(value.getTime());
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

/**
 * `_select_kunjungan_payment_candidates` — pick the visit rows that belong to
 * one inpatient payment episode.
 *
 * The algorithm, in the Python's order:
 *  1. Keep only BPJS-accepted, still-unpaid `03-` rows admitted within
 *     `toleranceDays` of `tanggal`; the newest of those (by `tgl_masuk`, then
 *     `no_transaksi`, descending) becomes the anchor.
 *  2. Keep the other inpatient candidates that share the anchor's SEP, its
 *     registration number, or its admission date — other inpatient episodes
 *     are dropped, so a patient with two admissions never gets them merged.
 *  3. Sweep the remaining rows: anything sharing an anchored reg or SEP joins
 *     the episode (except `01-` outpatient rows, which are never auto-selected),
 *     and manual-followup units (depo, lab, radiologi, …) join when they fall in
 *     the group window `[earliest admission - tolerance, latest admission + 1]`.
 *
 * Returns the selected rows in the caller's original order.
 */
export function selectKunjunganPaymentCandidates(
  args: SelectKunjunganPaymentCandidatesArgs,
): LegacyRow[] {
  const rows = args.rows ?? [];
  const toleranceDays = clampToleranceDays(args.toleranceDays ?? 3);
  const targetDt = parseDateFlexible(args.tanggal);
  if (targetDt === null) return [];

  const noRm = args.noRm ?? '';
  const accepted = args.acceptedPenjaminKeywords;
  const sepKeyOf = (row: LegacyRow): string =>
    args.resolveSepKey ? args.resolveSepKey(row, noRm) : str(row, 'no_sep');

  const selectedKeys = new Set<string>();
  const inpatientAnchorRegs = new Set<string>();
  const inpatientAnchorSeps = new Set<string>();

  // Step 1 — inpatient rows near the target date.
  const candidateInapRows: LegacyRow[] = [];
  for (const row of rows) {
    const trx = str(row, 'no_transaksi');
    // `daysBetweenDates` returns +Infinity for an unparseable side, which is
    // the Python's `bool(row_dt and ...)` guard.
    const tanggalCocok = daysBetweenDates(str(row, 'tgl_masuk'), args.tanggal) <= toleranceDays;
    if (!isAcceptedPenjamin(row['nama_penjamin'], accepted)) continue;
    if (!trx.startsWith(INAP_PREFIX)) continue;
    if (!isUnpaidKunjunganStatus(row['status_bayar']) || !tanggalCocok) continue;
    candidateInapRows.push(row);
  }
  if (candidateInapRows.length === 0) return [];

  candidateInapRows.sort(compareAnchorDesc);

  const latestAnchor = candidateInapRows[0] as LegacyRow;
  const latestAnchorDate = datePart(latestAnchor['tgl_masuk']);
  const latestAnchorReg = str(latestAnchor, 'no_registrasikunjungan');
  const latestAnchorSep = sepKeyOf(latestAnchor);
  if (latestAnchorReg) inpatientAnchorRegs.add(latestAnchorReg);
  if (latestAnchorSep) inpatientAnchorSeps.add(latestAnchorSep);

  // Step 2 — the anchor's own episode only.
  for (const row of candidateInapRows) {
    const reg = str(row, 'no_registrasikunjungan');
    const rowDate = datePart(row['tgl_masuk']);
    const sepKey = sepKeyOf(row);
    const sameEpisode =
      (Boolean(latestAnchorSep) && Boolean(sepKey) && sepKey === latestAnchorSep) ||
      (Boolean(latestAnchorReg) && Boolean(reg) && reg === latestAnchorReg) ||
      (Boolean(latestAnchorDate) && Boolean(rowDate) && rowDate === latestAnchorDate);
    if (!sameEpisode) continue;
    selectedKeys.add(rowKey(row));
    if (reg) inpatientAnchorRegs.add(reg);
    if (sepKey) inpatientAnchorSeps.add(sepKey);
  }

  const selectedInapDates: Date[] = [];
  for (const row of candidateInapRows) {
    if (!selectedKeys.has(rowKey(row))) continue;
    const rowDt = parseDateFlexible(row['tgl_masuk']);
    if (rowDt !== null) selectedInapDates.push(rowDt);
  }
  const times = selectedInapDates.map((item) => item.getTime());
  const groupStartDt = shiftDays(
    times.length > 0 ? new Date(Math.min(...times)) : targetDt,
    -toleranceDays,
  );
  const groupEndDt = shiftDays(times.length > 0 ? new Date(Math.max(...times)) : targetDt, 1);

  // Step 3 — related transactions inside the episode / group window.
  for (const row of rows) {
    const key = rowKey(row);
    if (selectedKeys.has(key)) continue;
    if (!isAcceptedPenjamin(row['nama_penjamin'], accepted)) continue;
    if (!isUnpaidKunjunganStatus(row['status_bayar'])) continue;
    const trx = str(row, 'no_transaksi');
    const reg = str(row, 'no_registrasikunjungan');
    const rowDt = parseDateFlexible(row['tgl_masuk']);
    const rowSep = sepKeyOf(row);
    const isRawatJalan = trx.startsWith(RAWAT_JALAN_PREFIX);
    if (reg && inpatientAnchorRegs.has(reg)) {
      if (isRawatJalan) continue;
      selectedKeys.add(key);
      continue;
    }
    if (rowSep && inpatientAnchorSeps.has(rowSep)) {
      if (isRawatJalan) continue;
      selectedKeys.add(key);
      continue;
    }
    if (
      rowDt !== null &&
      rowDt.getTime() >= groupStartDt.getTime() &&
      rowDt.getTime() <= groupEndDt.getTime() &&
      looksLikeManualFollowupTransaction(row)
    ) {
      selectedKeys.add(key);
    }
  }

  return rows.filter((row) => selectedKeys.has(rowKey(row)));
}

/**
 * `_find_verified_payment_candidates` — rows the kasir has already verified.
 *
 * `verificationStatus` replaces the per-row `cekstatus_verifikasi_kasir` call.
 * Anything other than empty / `"0"` / `"false"` counts as verified. The marker
 * fields `_status_verifikasi_kasir` and `_is_premium_room_guard` are attached
 * because `main()` prints them when it aborts the run.
 */
export function findVerifiedPaymentCandidates(
  rows: readonly LegacyRow[],
  verificationStatus: (trx: string) => string,
): LegacyRow[] {
  const verified: LegacyRow[] = [];
  const seen = new Set<string>();
  for (const row of rows ?? []) {
    const noTransaksi = str(row, 'no_transaksi');
    if (!noTransaksi || seen.has(noTransaksi)) continue;
    seen.add(noTransaksi);
    const status = (verificationStatus(noTransaksi) ?? '').toString().trim();
    if (status === '' || status === '0' || status === 'false' || status === 'False') continue;
    verified.push({
      ...row,
      _status_verifikasi_kasir: status,
      _is_premium_room_guard: isPremiumRoomForPaymentGuard(row['nama_unit'], row),
    });
  }
  return verified;
}

/**
 * `_find_paid_payment_candidates` — rows that already carry a kasir receipt.
 *
 * `paymentHistory` replaces `gethistory_pembayaran_kasir(reg, trx)`; a
 * non-empty list means the visit was paid. `_payment_history_count`,
 * `_last_kwitansi` and `_is_premium_room_guard` are the marker fields
 * `main()` prints.
 */
export function findPaidPaymentCandidates(
  rows: readonly LegacyRow[],
  paymentHistory: (row: LegacyRow) => readonly LegacyRow[],
): LegacyRow[] {
  const paid: LegacyRow[] = [];
  const seen = new Set<string>();
  for (const row of rows ?? []) {
    const noTransaksi = str(row, 'no_transaksi');
    const reg = str(row, 'no_registrasikunjungan');
    if (!noTransaksi || !reg) continue;
    const key = tupleKey(reg, noTransaksi);
    if (seen.has(key)) continue;
    seen.add(key);
    const history = paymentHistory(row) ?? [];
    if (history.length === 0) continue;
    const lastItem = history[history.length - 1];
    paid.push({
      ...row,
      _payment_history_count: history.length,
      _last_kwitansi: str(lastItem, 'no_kwitansi'),
      _is_premium_room_guard: isPremiumRoomForPaymentGuard(row['nama_unit'], row),
    });
  }
  return paid;
}

/**
 * `_find_excluded_tampung_bayar_candidates` — visit rows inside this episode's
 * registrations whose unit must never be swept into a tampung bayar batch
 * (ambulance, kamar jenazah). De-duplicated on (reg, trx, normalized unit).
 */
export function findExcludedTampungBayarCandidates(
  kunjunganRows: readonly LegacyRow[],
  roomRows: readonly LegacyRow[],
): LegacyRow[] {
  const targetRegs = new Set<string>();
  for (const row of roomRows ?? []) {
    const reg = str(row, 'no_registrasikunjungan');
    if (reg) targetRegs.add(reg);
  }
  if (targetRegs.size === 0) return [];

  const blocked: LegacyRow[] = [];
  const seen = new Set<string>();
  for (const row of kunjunganRows ?? []) {
    const reg = str(row, 'no_registrasikunjungan');
    if (!targetRegs.has(reg)) continue;
    const namaUnit = str(row, 'nama_unit');
    if (!isExcludedTampungBayarUnit(namaUnit)) continue;
    const key = tupleKey(reg, str(row, 'no_transaksi'), normalizeTextKey(namaUnit));
    if (seen.has(key)) continue;
    seen.add(key);
    blocked.push({ ...row });
  }
  return blocked;
}
