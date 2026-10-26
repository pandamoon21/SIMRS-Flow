/**
 * Payment-staging ("tampung bayar") payload builder ported from `ranap_v3.py`.
 *
 * `kasir/kasir/tampung_bayar` is the one financially critical write in the
 * inpatient flow: it stages a real payment batch against a real registration.
 * Everything in this module is the *shape* of that write plus the guards that
 * decide whether it may happen at all. Nothing here writes, prints or fetches —
 * `proses_tampung_bayar_group`'s write call, its `_log_sync_detail_block` output
 * and its `DRY_RUN` print are deliberately left to the caller.
 *
 * **The field names, their order and the row serialization are load-bearing.**
 * `fields` mirrors `tampung_bayar_kasir`'s `data` dict key for key, `dt_bayar`
 * is a nested URL-encoded form exactly as the legacy UI submits it, and
 * `tindakan` is `json.dumps(rows, ensure_ascii=True, separators=(",", ":"))` —
 * compact, ASCII-escaped, in row order. All three are pinned in
 * `tampungBayar.test.ts`; changing them changes what the cashier receives.
 *
 * Hoisted fetches (endpoint id → parameter). The Python calls these inline:
 *  - `penatajasaInap.getListTindakan` (`ambil_listtindakan(trx, reg, kd_kamar)`,
 *    once per room row) → `listTindakanByTrx`, keyed by `no_transaksi`.
 *  - `kasir.getListTindakan` (`get_listtindakan_kasir(reg, trx, kd_unit, True)`)
 *    → `listTindakanKasir` in {@link buildTampungBayarPayload}; the preferred
 *    row source, with `listTindakanByTrx` as the fallback.
 *  - `kasir.getJumlahBayar` (`get_jumlah_bayar_kasir(reg, trx, kd_unit, False)`)
 *    → `jumlahBayarKasir`.
 *  - `kasir.getShiftBayar` (`getshift_bayar_kasir()`) → `shiftBayarKasir`, used
 *    only when the caller passes no `shiftPembayaran` override.
 *  - `kasir.getJenisBayar` (`getjenis_bayar_kasir(kd_penjamin)`) →
 *    `jenisPembayaran`.
 *  - `penatajasaInap.getDataKunjungan` (`ambil_datakunjungan(no_rm, trx)`) →
 *    `datakunjungan`; only its `kd_unit` and `kd_detkelpenjamin` are read.
 *  - `kasir.cekOrderBelumTerlayani` → `orderBelumTerlayani`,
 *    `kasir.cekOrderBelumTransfer` → `orderBelumTransfer`,
 *    `kasir.getHistoryPembayaran` → `historyPembayaran`, all in
 *    {@link evaluateTampungBayarEligibility}.
 *
 * Two reads the Python performs are dropped as dead weight rather than hoisted:
 * `penatajasaInap.getDataKunjunganTab` existed only to derive the
 * `kd_kamarperawatan` argument of `ambil_listtindakan`, and
 * `kasir.cekStatusVerifikasi` was fetched inside
 * `proses_tampung_bayar_group` but never gated anything — it was logged only.
 */

import type { LegacyRow } from './types.js';
import { str } from './types.js';
import { datePart } from './dates.js';
import { normalizeTextKey, parseCurrencyInt, safeInt } from './scalars.js';
import { isBynyPatient, isMultazamPlatinumRoomName, isUnpaidKunjunganStatus } from './names.js';
import { findExcludedTampungBayarCandidates } from './selection.js';
import { normalizeRoomStays } from './rooms.js';
import type { RoomStayOptions } from './rooms.js';

/**
 * `_serialize_tampung_bayar_row`'s key tuple, in order.
 *
 * A row staged for payment is projected onto exactly these twenty fields —
 * anything else the tindakan endpoint returned is dropped, and a field the row
 * does not have becomes `""`. The order is the JSON key order the cashier
 * receives, so it is part of the wire format.
 */
export const TAMPUNG_BAYAR_ROW_KEYS: readonly string[] = [
  'kd_tindakan',
  'tgl_transaksi',
  'nama_tindakan',
  'harga',
  'qty',
  'jumlah',
  'jenis_bayar',
  'status_bayar',
  'urut_tindakan',
  'flag',
  'no_transaksi',
  'kd_detjenispembayaran',
  't_harga',
  't_jumlah',
  't_qty',
  't_urut_tindakan',
  'kd_unit',
  'diskon_rp',
  'diskon_persen',
  'racik',
];

/** `_build_tampung_bayar_dt_bayar`'s default cashier shift. */
export const DEFAULT_SHIFT_PEMBAYARAN = '1';

/** `_build_tampung_bayar_dt_bayar`'s default payment type. */
export const DEFAULT_JENIS_PEMBAYARAN = '14';

/** `_build_tampung_bayar_payload`'s fallback payer when no row declares one. */
export const DEFAULT_KD_PENJAMIN = '15';

/**
 * Every refusal `proses_tampung_bayar_group` can log, verbatim — these strings
 * reach the operator, so they stay in Indonesian and are pinned in the tests.
 */
export const TAMPUNG_BAYAR_REFUSAL_REASONS = {
  premiumRoom: 'room MULTAZAM PLATINUM memerlukan penjamin/deposit/manual billing di kasir',
  excludedUnit: 'ada transaksi terpilih yang tidak boleh ikut tampung bayar',
  payloadKosong: 'payload tidak dapat dibentuk',
  orderBelumTerlayani: 'masih ada order belum terlayani',
  orderBelumTransfer: 'masih ada order belum transfer',
  riwayatPembayaran: 'riwayat pembayaran sudah ada',
  dryRun: 'dry_run aktif',
  debug: 'debug_tampung_bayar aktif',
  disabled: 'enable_tampung_bayar nonaktif',
} as const;

/** One of {@link TAMPUNG_BAYAR_REFUSAL_REASONS}, or `''` when eligible. */
export type TampungBayarRefusalReason =
  | (typeof TAMPUNG_BAYAR_REFUSAL_REASONS)[keyof typeof TAMPUNG_BAYAR_REFUSAL_REASONS]
  | '';

/**
 * `_is_unpaid_tindakan_row` — may this billing line be swept into a payment
 * batch?
 *
 * Two independent signals, and both must say "unpaid": `flag` is the backend's
 * "already settled" marker (`"1"`/`"true"` disqualifies the row outright), and
 * `status_bayar` must be one of the unpaid statuses (`""`, `BELUM`,
 * `BELUM BAYAR`, `OPEN` — see `isUnpaidKunjunganStatus`). The Python's trailing
 * `or not status_bayar` is redundant, since a blank status is already unpaid,
 * but it is kept so the two implementations read the same.
 */
export function isUnpaidTindakanRow(row: LegacyRow): boolean {
  const flagText = str(row, 'flag').toLowerCase();
  if (flagText === '1' || flagText === 'true') return false;
  const statusBayar = str(row, 'status_bayar');
  return isUnpaidKunjunganStatus(statusBayar) || !statusBayar;
}

/**
 * `_serialize_tampung_bayar_row` — project a tindakan row onto
 * {@link TAMPUNG_BAYAR_ROW_KEYS}.
 *
 * Values pass through untouched (a number stays a number, an explicit `null`
 * stays `null` — Python's `row.get(key, "")` only substitutes `""` for a *missing*
 * key), because their JSON types are part of what the cashier receives.
 */
export function projectTampungBayarRow(row: LegacyRow): LegacyRow {
  const projected: Record<string, unknown> = {};
  for (const key of TAMPUNG_BAYAR_ROW_KEYS) {
    projected[key] = row && key in row ? row[key] : '';
  }
  return projected;
}

/**
 * The wire form of one staged row: `projectTampungBayarRow` then Python's
 * `json.dumps(..., ensure_ascii=True, separators=(",", ":"))`.
 *
 * This is the exact text that appears inside the `tindakan` field's array, one
 * element per row. Use {@link serializeTampungBayarRows} for the field itself.
 */
export function serializeTampungBayarRow(row: LegacyRow): string {
  return jsonDumpsAscii(projectTampungBayarRow(row));
}

/**
 * The `tindakan` form field: `json.dumps(tindakan_rows, ensure_ascii=True,
 * separators=(",", ":"))` over the rows *as they stand in the payload*.
 *
 * Note that `_build_tampung_bayar_payload` only projects rows onto
 * {@link TAMPUNG_BAYAR_ROW_KEYS} on the `penatajasa_inap` fallback path; rows
 * that came from the kasir endpoint are serialized whole. That asymmetry is the
 * Python's and is preserved.
 */
export function serializeTampungBayarRows(rows: readonly LegacyRow[]): string {
  return jsonDumpsAscii(rows);
}

/**
 * `_normalize_tampung_bayar_row` — force a row into the "unpaid, to be settled
 * by this batch" state before staging it.
 *
 * Four fields are overwritten regardless of what the endpoint returned:
 * `jenis_bayar="-"`, `status_bayar="Belum"`, `flag="0"`,
 * `kd_detjenispembayaran="0"`. A field the row already had keeps its position in
 * the key order; the others are appended in that order, matching Python's
 * `dict(row)`-then-assign.
 */
export function normalizeTampungBayarRow(row: LegacyRow): LegacyRow {
  return {
    ...(row ?? {}),
    jenis_bayar: '-',
    status_bayar: 'Belum',
    flag: '0',
    kd_detjenispembayaran: '0',
  };
}

/** Arguments of {@link collectTindakanTampungBayar}. */
export interface CollectTindakanTampungBayarArgs {
  /**
   * Medrec. Unused by the decision logic — in the Python it only fed the
   * `ambil_datakunjungan`/`ambil_datakunjungan_tab_inap` reads whose sole
   * product was the `kd_kamarperawatan` argument of the now-hoisted
   * `ambil_listtindakan`. Kept so call sites match the Python's signature.
   */
  noRm: string;
  /** Raw room rows; normalised here, exactly as the Python re-normalises them. */
  roomRows: readonly LegacyRow[];
  /** Hoisted `ambil_listtindakan` results, keyed by `no_transaksi`. */
  listTindakanByTrx: Record<string, readonly LegacyRow[]>;
  /** Passed to `normalizeRoomStays`. */
  stayOptions?: RoomStayOptions;
}

/**
 * `_collect_tindakan_tampung_bayar` — the fallback row set, gathered per room
 * stay from `penatajasa_inap/get_listtindakan`.
 *
 * Walks the normalised stays in order, skipping any stay missing either
 * `no_transaksi` or `no_registrasikunjungan` (the Python cannot fetch for those),
 * keeps the rows {@link isUnpaidTindakanRow} accepts, then projects and
 * normalises each one.
 *
 * The result is sorted by `(tgl_transaksi date, no_transaksi, urut_tindakan)`
 * with the Python's sentinels — an unreadable date sorts last as `"9999-99-99"`
 * and a missing `urut_tindakan` as `999999` — and ties stay in input order.
 * That ordering is the JSON array order the cashier receives.
 */
export function collectTindakanTampungBayar(
  args: CollectTindakanTampungBayarArgs,
): LegacyRow[] {
  const byTrx = args.listTindakanByTrx ?? {};
  const combined: LegacyRow[] = [];
  for (const roomRow of normalizeRoomStays(args.roomRows ?? [], args.stayOptions ?? {})) {
    const noTransaksi = str(roomRow, 'no_transaksi');
    const noReg = str(roomRow, 'no_registrasikunjungan');
    if (!noTransaksi || !noReg) continue;
    for (const row of byTrx[noTransaksi] ?? []) {
      if (!isUnpaidTindakanRow(row)) continue;
      combined.push(normalizeTampungBayarRow(projectTampungBayarRow(row)));
    }
  }

  return combined
    .map((row, index) => ({
      row,
      index,
      tanggal: datePart(row['tgl_transaksi']) || '9999-99-99',
      trx: str(row, 'no_transaksi'),
      urut: safeInt(row['urut_tindakan'], 999999),
    }))
    .sort(
      (left, right) =>
        compareText(left.tanggal, right.tanggal) ||
        compareText(left.trx, right.trx) ||
        left.urut - right.urut ||
        left.index - right.index,
    )
    .map((entry) => entry.row);
}

/** Arguments of {@link buildTampungBayarDtBayar}. */
export interface BuildTampungBayarDtBayarArgs {
  /**
   * The kasir grand total. Passed through **verbatim**: the Python takes the raw
   * `getJumlahBayar` string, so whatever formatting that endpoint used
   * (`"1250000"`, `"1.250.000"`) is what the cashier sees. A falsy value —
   * including numeric `0` — becomes `"0"`.
   */
  grandTotal: number | string;
  /** `cmbshift_pembayaran`; blank falls back to `"1"`. */
  shiftPembayaran?: string;
  /** `cmbjenis_pembayaran`; blank falls back to `"14"`. */
  jenisPembayaran?: string;
}

/**
 * `_build_tampung_bayar_dt_bayar` — the nested URL-encoded payment form that
 * rides inside the `dt_bayar` field.
 *
 * Nine fields, in this order and no other:
 * `cmbshift_pembayaran`, `cmbjenis_pembayaran`, `txtdiskonpn_pembayaran`,
 * `txtdiskonrp_pembayaran`, `txtpembulatan_pembayaran`, `cmbkartu_pembayaran`,
 * `txtjumlah_pembayaran`, `txtjmltagihan_pembayaran`, `txtjmldibayar_pembayaran`.
 *
 * The three discount/rounding fields and the card field are always empty (they
 * still appear as `key=`, because that is what `urlencode` emits);
 * `txtjumlah_pembayaran` and `txtjmltagihan_pembayaran` both carry the grand
 * total, and `txtjmldibayar_pembayaran` is always `"0"` — the batch is *staged*,
 * not settled. Encoding is Python's `urlencode`/`quote_plus`: space becomes `+`
 * and `!'()*` are escaped, unlike `encodeURIComponent`.
 */
export function buildTampungBayarDtBayar(args: BuildTampungBayarDtBayarArgs): string {
  const grandTotal = pyOrText(args.grandTotal, '0').trim() || '0';
  return urlencode([
    ['cmbshift_pembayaran', pyOrText(args.shiftPembayaran, DEFAULT_SHIFT_PEMBAYARAN).trim() || DEFAULT_SHIFT_PEMBAYARAN],
    ['cmbjenis_pembayaran', pyOrText(args.jenisPembayaran, DEFAULT_JENIS_PEMBAYARAN).trim() || DEFAULT_JENIS_PEMBAYARAN],
    ['txtdiskonpn_pembayaran', ''],
    ['txtdiskonrp_pembayaran', ''],
    ['txtpembulatan_pembayaran', ''],
    ['cmbkartu_pembayaran', ''],
    ['txtjumlah_pembayaran', grandTotal],
    ['txtjmltagihan_pembayaran', grandTotal],
    ['txtjmldibayar_pembayaran', '0'],
  ]);
}

/** Where {@link TampungBayarPayload.rows} came from. */
export type TampungBayarRowSource = 'kasir' | 'penatajasa_inap' | 'none';

/** `_build_tampung_bayar_payload`'s summary block — what the Python logged. */
export interface TampungBayarSummary {
  /** `no_registrasikunjungan` of the first normalised stay. */
  reg: string;
  /** `no_transaksi` of the first normalised stay. */
  trx: string;
  kdUnit: string;
  kdPenjamin: string;
  shiftPembayaran: string;
  jenisPembayaran: string;
  /** The raw grand-total text, as it appears in `dt_bayar`. */
  grandTotal: string;
  /** `len(tindakan_rows)`. */
  count: number;
}

/**
 * Everything `kasir/kasir/tampung_bayar` needs, plus what the caller must show
 * an approver before letting it fire.
 *
 * When `_normalize_room_stays` yields nothing the Python returned `({}, {})`;
 * here that is `buildable: false` with an empty `fields` — do not POST.
 */
export interface TampungBayarPayload {
  /**
   * The POST body, in `tampung_bayar_kasir`'s key order:
   * `no_reg`, `no_transaksi`, `kd_unit`, `ck_retur`, `kd_penjamin`, `dt_bayar`,
   * `tindakan`. `ck_retur` is always the string `"false"`. Empty when
   * `buildable` is false.
   */
  fields: Record<string, string>;
  /** `_parse_currency_int` of the kasir grand total — for display and gates. */
  grandTotal: number;
  /**
   * The grand total exactly as the kasir returned it. This, not `grandTotal`, is
   * what `dt_bayar` carries, so any thousands separators survive into the write.
   */
  grandTotalText: string;
  /** The rows `fields.tindakan` serializes, in wire order. */
  rows: LegacyRow[];
  /** `rows.length`. */
  rowCount: number;
  /** Which endpoint the rows came from. */
  rowSource: TampungBayarRowSource;
  /** False when no stay could be normalised — the Python's `({}, {})`. */
  buildable: boolean;
  /** The Python's `summary` dict. */
  summary: TampungBayarSummary;
}

/** Arguments of {@link buildTampungBayarPayload}. */
export interface BuildTampungBayarPayloadArgs {
  /** Medrec; forwarded to {@link collectTindakanTampungBayar}. */
  noRm: string;
  /** Raw room rows for the episode. */
  roomRows: readonly LegacyRow[];
  /** Hoisted `penatajasaInap.getListTindakan`, keyed by `no_transaksi`. */
  listTindakanByTrx: Record<string, readonly LegacyRow[]>;
  /**
   * Operator override for the cashier shift. When absent the Python falls back
   * to `shiftBayarKasir`, then to `"1"`.
   */
  shiftPembayaran?: string;
  /**
   * Hoisted `kasir.getJenisBayar` response for `kd_penjamin`, passed through
   * verbatim (the Python does no parsing here); `"14"` when blank.
   */
  jenisPembayaran?: string;
  /** Hoisted `kasir.getShiftBayar` response. */
  shiftBayarKasir?: string;
  /** Hoisted `penatajasaInap.getDataKunjungan` for the primary transaction. */
  datakunjungan?: LegacyRow;
  /** Hoisted `kasir.getJumlahBayar` response. */
  jumlahBayarKasir?: LegacyRow;
  /**
   * Hoisted `kasir.getListTindakan` response — a `{rows: […]}` envelope, or a
   * bare array (which the Python discarded; accepted here for callers that have
   * already unwrapped it).
   */
  listTindakanKasir?: unknown;
  /** Passed to `normalizeRoomStays`. */
  stayOptions?: RoomStayOptions;
}

/**
 * `_build_tampung_bayar_payload` — assemble the staging write.
 *
 * The transaction identity is the *first* normalised stay (`normalizeRoomStays`
 * orders by `urut_masuk_ruang`, then admission, then `no_transaksi`), and its
 * own fields win over the hoisted `getdatakunjungan` for both `kd_unit` and
 * `kd_detkelpenjamin`; the payer falls back to `"15"`.
 *
 * Rows come from the kasir endpoint when it returns any, normalised but **not**
 * projected and **not** filtered for unpaid status — the kasir list is already
 * the set it intends to bill. Only when that list is empty does the Python fall
 * back to sweeping `penatajasa_inap/get_listtindakan` per stay through
 * {@link collectTindakanTampungBayar}, which does filter and project.
 *
 * The grand total is read as `grand_total`, else `total`, else `"0"`, and is
 * never re-parsed before it enters `dt_bayar`.
 */
export function buildTampungBayarPayload(
  args: BuildTampungBayarPayloadArgs,
): TampungBayarPayload {
  const normalizedRows = normalizeRoomStays(args.roomRows ?? [], args.stayOptions ?? {});
  if (normalizedRows.length === 0) return emptyPayload();

  const primaryRow = normalizedRows[0] as LegacyRow;
  const noReg = str(primaryRow, 'no_registrasikunjungan');
  const noTransaksi = str(primaryRow, 'no_transaksi');
  // `ambil_datakunjungan(...) if no_transaksi else {}`
  const dataInap: LegacyRow = noTransaksi ? (args.datakunjungan ?? {}) : {};
  const kdUnit = pyOrText(primaryRow['kd_unit'], dataInap['kd_unit'], '').trim();
  const kdPenjamin =
    pyOrText(
      primaryRow['kd_detkelpenjamin'],
      dataInap['kd_detkelpenjamin'],
      DEFAULT_KD_PENJAMIN,
    ).trim();

  const jumlahBayar = args.jumlahBayarKasir ?? {};
  const grandTotalText =
    pyOrText(jumlahBayar['grand_total'], jumlahBayar['total'], '0').trim() || '0';
  const resolvedShift =
    pyOrText(args.shiftPembayaran, args.shiftBayarKasir, DEFAULT_SHIFT_PEMBAYARAN).trim() ||
    DEFAULT_SHIFT_PEMBAYARAN;
  const jenisPembayaran =
    pyOrText(args.jenisPembayaran, DEFAULT_JENIS_PEMBAYARAN).trim() || DEFAULT_JENIS_PEMBAYARAN;

  const kasirRows = rowsOfEnvelope(args.listTindakanKasir);
  let rows: LegacyRow[] = kasirRows.map((row) => normalizeTampungBayarRow({ ...row }));
  let rowSource: TampungBayarRowSource = rows.length > 0 ? 'kasir' : 'none';
  if (rows.length === 0) {
    rows = collectTindakanTampungBayar({
      noRm: args.noRm,
      roomRows: normalizedRows,
      listTindakanByTrx: args.listTindakanByTrx ?? {},
      stayOptions: args.stayOptions,
    });
    rowSource = rows.length > 0 ? 'penatajasa_inap' : 'none';
  }

  const dtBayar = buildTampungBayarDtBayar({
    grandTotal: grandTotalText,
    shiftPembayaran: resolvedShift,
    jenisPembayaran,
  });

  return {
    fields: {
      no_reg: noReg,
      no_transaksi: noTransaksi,
      kd_unit: kdUnit,
      ck_retur: 'false',
      kd_penjamin: kdPenjamin,
      dt_bayar: dtBayar,
      tindakan: serializeTampungBayarRows(rows),
    },
    grandTotal: parseCurrencyInt(grandTotalText, 0),
    grandTotalText,
    rows,
    rowCount: rows.length,
    rowSource,
    buildable: true,
    summary: {
      reg: noReg,
      trx: noTransaksi,
      kdUnit,
      kdPenjamin,
      shiftPembayaran: resolvedShift,
      jenisPembayaran,
      grandTotal: grandTotalText,
      count: rows.length,
    },
  };
}

/** Arguments of {@link evaluateTampungBayarEligibility}. */
export interface EvaluateTampungBayarEligibilityArgs {
  /** The visit rows selected for this episode (`selectKunjunganPaymentCandidates`). */
  kunjunganRows: readonly LegacyRow[];
  /** The episode's room rows. */
  roomRows: readonly LegacyRow[];
  /**
   * The payload, when already built — supply it to reproduce the Python's
   * "payload tidak dapat dibentuk" refusal. Omitted, that gate is skipped.
   */
  payload?: TampungBayarPayload;
  /** Hoisted `kasir.cekOrderBelumTerlayani`; only an object is inspected. */
  orderBelumTerlayani?: unknown;
  /** Hoisted `kasir.cekOrderBelumTransfer`; only an object is inspected. */
  orderBelumTransfer?: unknown;
  /** Hoisted `kasir.getHistoryPembayaran`; a non-empty array refuses. */
  historyPembayaran?: readonly LegacyRow[] | null;
  /** The legacy global `DRY_RUN`. Defaults to `false` — see the note below. */
  dryRun?: boolean;
  /** The legacy `debug_tampung_bayar` flag. Defaults to `false`. */
  debugTampungBayar?: boolean;
  /**
   * The legacy `enable_tampung_bayar` flag. **Defaults to `true` here**, where
   * the Python defaulted it to `False`: in this port the preview/write decision
   * belongs to the run's execution mode, not to a function default, so leaving
   * it out asks "would the data allow this?" rather than always answering no.
   * Pass `false` to reproduce the Python's default.
   */
  enableTampungBayar?: boolean;
}

/** The verdict of the guard half of `proses_tampung_bayar_group`. */
export interface TampungBayarEligibility {
  /** True only when every guard passed. */
  eligible: boolean;
  /** The refusal text, verbatim from the Python's log; `''` when eligible. */
  reason: TampungBayarRefusalReason;
  /** The Python's accompanying `Room`/`Detail`/`Total`/`Count` line; `''` when none. */
  detail: string;
  /** The visit rows whose unit may never join a batch (ambulance, jenazah). */
  excludedRows: LegacyRow[];
  /** Distinct MULTAZAM PLATINUM room names found, sorted — the Python's `Room` line. */
  premiumRooms: string[];
}

/**
 * The guard half of `proses_tampung_bayar_group` — may this episode be staged
 * for payment at all?
 *
 * The gates, in the Python's order (the first to fire wins, and its text is
 * returned verbatim):
 *
 *  1. **Premium room** — any room named MULTAZAM PLATINUM. Those stays need a
 *     penjamin/deposit or manual billing at the cashier, so the batch is never
 *     automated. (VIP/VVIP are handled by a different control, the
 *     `_is_premium_room_guard` marker in `./selection.ts`; this function mirrors
 *     the Python and checks MULTAZAM PLATINUM only.)
 *  2. **Excluded unit** — any selected visit in an ambulance or mortuary unit
 *     (`findExcludedTampungBayarCandidates`). Those are billed separately.
 *  3. **Unbuildable payload** — no normalisable room stay.
 *  4. **Unserved orders** — `cek_order_belum_terlayani.total > 0`.
 *  5. **Untransferred orders** — `cek_order_belum_transfer.total > 0`.
 *  6. **Existing payment history** — a non-empty `gethistory_pembayaran`, i.e.
 *     the visit already has a receipt.
 *  7. **Mode flags** — `dry_run`, then `debug_tampung_bayar`, then
 *     `enable_tampung_bayar`.
 *
 * The Python also read `cekstatus_verifikasi` here, but only to print it; it
 * gates nothing and is therefore not a parameter.
 */
export function evaluateTampungBayarEligibility(
  args: EvaluateTampungBayarEligibilityArgs,
): TampungBayarEligibility {
  const roomRows = args.roomRows ?? [];
  const kunjunganRows = args.kunjunganRows ?? [];

  const premiumRooms = [
    ...new Set(
      roomRows
        .filter((row) => isMultazamPlatinumRoomName(row?.['nama_unit']))
        .map((row) => str(row, 'nama_unit')),
    ),
  ].sort();
  const excludedRows = findExcludedTampungBayarCandidates(kunjunganRows, roomRows);

  const verdict = (
    reason: TampungBayarRefusalReason,
    detail = '',
  ): TampungBayarEligibility => ({
    eligible: reason === '',
    reason,
    detail,
    excludedRows,
    premiumRooms,
  });

  if (premiumRooms.length > 0) {
    return verdict(TAMPUNG_BAYAR_REFUSAL_REASONS.premiumRoom, premiumRooms.join('; '));
  }
  if (excludedRows.length > 0) {
    // `" ; ".join(f"{nama_unit or '-'} ({no_transaksi or '-'})")`
    const detail = excludedRows
      .map((row) => `${str(row, 'nama_unit') || '-'} (${str(row, 'no_transaksi') || '-'})`)
      .join(' ; ');
    return verdict(TAMPUNG_BAYAR_REFUSAL_REASONS.excludedUnit, detail || '-');
  }
  if (args.payload !== undefined && !args.payload.buildable) {
    return verdict(TAMPUNG_BAYAR_REFUSAL_REASONS.payloadKosong);
  }

  const terlayani = orderBlockerTotal(args.orderBelumTerlayani);
  if (terlayani) {
    return verdict(TAMPUNG_BAYAR_REFUSAL_REASONS.orderBelumTerlayani, terlayani.detail);
  }
  const transfer = orderBlockerTotal(args.orderBelumTransfer);
  if (transfer) {
    return verdict(TAMPUNG_BAYAR_REFUSAL_REASONS.orderBelumTransfer, transfer.detail);
  }

  const history = Array.isArray(args.historyPembayaran) ? args.historyPembayaran : [];
  if (history.length > 0) {
    const lastKwitansi = str(history[history.length - 1], 'no_kwitansi') || '-';
    return verdict(
      TAMPUNG_BAYAR_REFUSAL_REASONS.riwayatPembayaran,
      `${history.length} (${lastKwitansi})`,
    );
  }

  if (args.dryRun === true) return verdict(TAMPUNG_BAYAR_REFUSAL_REASONS.dryRun);
  if (args.debugTampungBayar === true) return verdict(TAMPUNG_BAYAR_REFUSAL_REASONS.debug);
  if (args.enableTampungBayar === false) return verdict(TAMPUNG_BAYAR_REFUSAL_REASONS.disabled);

  return verdict('');
}

/** Every `reason` `_resolve_biaya_administrasi` can report. */
export type BiayaAdministrasiReason =
  | 'default_master'
  | 'byny_icu'
  | 'byny_vvip'
  | 'byny_non_icu'
  | 'icu_vip_or_vvip'
  | 'kelas_1_2_3'
  | 'manual_fallback_zero_master_standard_room';

/** The dict `_resolve_biaya_administrasi` returns, with its room-class flags. */
export interface BiayaAdministrasiResolution {
  /** The resolved price as the Python's string (`"250000"`, or the master value). */
  harga: string;
  reason: BiayaAdministrasiReason;
  isByny: boolean;
  isIcu: boolean;
  /** VIP but not VVIP — the Python excludes VVIP from this flag. */
  isVip: boolean;
  isVvip: boolean;
  /** The room name names KELAS I/1/II/2/III/3. */
  isClass: boolean;
}

/** Arguments of {@link resolveBiayaAdministrasi}. */
export interface ResolveBiayaAdministrasiArgs {
  /** Patient name; only "BY. NY."-style newborn names change the tariff. */
  namaPasien: string;
  /** Room name; classified by substring on its normalised key. */
  namaUnit: string;
  /** The tariff from the tindakan master; `0`/`""` triggers the fallback. */
  defaultHarga: number | string;
}

/**
 * `_resolve_biaya_administrasi` — which administration fee this room and
 * patient owe, with the reason, as the Python returns it.
 *
 * The ladder, first match wins:
 *  - newborn ("BY. NY.") in ICU → 250 000; in VVIP → 250 000; anywhere else →
 *    50 000, overriding the master tariff in every case;
 *  - otherwise ICU, VIP or VVIP → 250 000;
 *  - otherwise a KELAS I/II/III room → 150 000;
 *  - otherwise, if the master tariff is missing or ≤ 0 → 150 000;
 *  - otherwise the master tariff, unchanged.
 *
 * Note that "VIP" is tested as a substring, so VVIP matches it too — hence the
 * Python's explicit `is_vip = "VIP" in key and not is_vvip`, kept here. The last
 * branch's `and not is_byny` is dead (the `elif` chain has already excluded
 * newborns) and is kept only so the two read alike.
 */
export function resolveBiayaAdministrasiDetail(
  args: ResolveBiayaAdministrasiArgs,
): BiayaAdministrasiResolution {
  const roomKey = normalizeTextKey(args.namaUnit);
  const isByny = isBynyPatient(args.namaPasien);
  const isIcu = roomKey.includes('ICU');
  const isVvip = roomKey.includes('VVIP');
  const isVip = roomKey.includes('VIP') && !isVvip;
  const isClass = ['KELAS I', 'KELAS 1', 'KELAS II', 'KELAS 2', 'KELAS III', 'KELAS 3'].some(
    (token) => roomKey.includes(token),
  );

  // `str(default_harga or "").strip()` — numeric 0 collapses to ''.
  const defaultHarga = pyOrText(args.defaultHarga, '').trim();
  let harga = defaultHarga;
  let reason: BiayaAdministrasiReason = 'default_master';

  if (isByny) {
    if (isIcu) {
      harga = '250000';
      reason = 'byny_icu';
    } else if (isVvip) {
      harga = '250000';
      reason = 'byny_vvip';
    } else {
      harga = '50000';
      reason = 'byny_non_icu';
    }
  } else if (isIcu || isVip || isVvip) {
    harga = '250000';
    reason = 'icu_vip_or_vvip';
  } else if (isClass) {
    harga = '150000';
    reason = 'kelas_1_2_3';
  } else if (parseCurrencyInt(defaultHarga, 0) <= 0 && !isByny) {
    harga = '150000';
    reason = 'manual_fallback_zero_master_standard_room';
  }

  return { harga, reason, isByny, isIcu, isVip, isVvip, isClass };
}

/**
 * {@link resolveBiayaAdministrasiDetail}'s price as an integer, via
 * `_parse_currency_int` — the form a billing comparison needs. Use the `Detail`
 * variant when the operator log needs the reason too.
 */
export function resolveBiayaAdministrasi(args: ResolveBiayaAdministrasiArgs): number {
  return parseCurrencyInt(resolveBiayaAdministrasiDetail(args).harga, 0);
}

// ── internals ────────────────────────────────────────────────────

/** The `({}, {})` return of `_build_tampung_bayar_payload`. */
function emptyPayload(): TampungBayarPayload {
  return {
    fields: {},
    grandTotal: 0,
    grandTotalText: '',
    rows: [],
    rowCount: 0,
    rowSource: 'none',
    buildable: false,
    summary: {
      reg: '',
      trx: '',
      kdUnit: '',
      kdPenjamin: '',
      shiftPembayaran: '',
      jenisPembayaran: '',
      grandTotal: '',
      count: 0,
    },
  };
}

/**
 * `int(blocker.get("total") or 0) > 0` on a dict response, with the Python's
 * `Total`/`Unit` log line. `null` when the gate does not fire.
 */
function orderBlockerTotal(response: unknown): { total: number; detail: string } | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const row = response as LegacyRow;
  const total = safeInt(row['total'], 0);
  if (total <= 0) return null;
  return { total, detail: `${total} (${str(row, 'nama_unit') || '-'})` };
}

/** `kasir_list.get("rows", []) if isinstance(kasir_list, dict) else []`, widened. */
function rowsOfEnvelope(payload: unknown): LegacyRow[] {
  if (Array.isArray(payload)) return payload.filter(isPlainRow);
  if (payload && typeof payload === 'object') {
    const rows = (payload as Record<string, unknown>)['rows'];
    if (Array.isArray(rows)) return rows.filter(isPlainRow);
  }
  return [];
}

function isPlainRow(value: unknown): value is LegacyRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `str(a or b or … )` — the first Python-truthy value, stringified. Mirrors the
 * legacy `or` chains, in which `0`, `""`, `False` and empty containers all fall
 * through while the string `"0"` does not.
 */
function pyOrText(...values: readonly unknown[]): string {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (value === false || value === 0) continue;
    if (typeof value === 'string' && value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return String(value);
  }
  return '';
}

/** `str.__lt__` on two strings, for the sort tuples. */
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * `json.dumps(value, ensure_ascii=True, separators=(",", ":"))`.
 *
 * `JSON.stringify` already produces the compact separators; the scan then
 * escapes every code unit from U+007F up as `\uXXXX`, which is what
 * `ensure_ascii` does (astral characters come out as their surrogate pair, again
 * matching Python).
 */
function jsonDumpsAscii(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null';
  let out = '';
  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index);
    if (code < 0x7f) {
      out += json[index];
      continue;
    }
    out += '\\u' + code.toString(16).padStart(4, '0');
  }
  return out;
}

/**
 * `urllib.parse.urlencode` with the default `quote_plus`: space becomes `+`,
 * and `!'()*` are percent-escaped even though `encodeURIComponent` leaves them.
 */
function urlencode(pairs: readonly (readonly [string, string])[]): string {
  return pairs.map(([key, value]) => `${quotePlus(key)}=${quotePlus(value)}`).join('&');
}

function quotePlus(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');
}
