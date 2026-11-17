/**
 * Payment verdicts for rawat jalan: the pre-payment blockers, the cashier's
 * payment config, and the `tampung_bayar` body.
 *
 * Everything here is a pure function: no network, no clock, no module state.
 * Each one is the *decision* half of a legacy guard, with every remote read
 * hoisted into a parameter and the supplying endpoint named. `executors.ts`
 * is the I/O shell that fetches, calls, and turns the verdict into a
 * `StepResult`.
 */
import { RAJAL_DEFAULT_PAYMENT_CONFIG, RAJAL_PAYMENT_TYPE_OPTIONS, RAJAL_SHIFT_OPTIONS, type RajalPaymentConfig } from '../rules.js';

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

export interface RajalBillTally {
  /** Sum of every line's `jumlah`. */
  total: number;
  /** Sum of the lines flagged settled (`SUDAH` / `LUNAS` / `PIUTANG`). */
  sudah: number;
  /** False when no line carried a payment flag at all — the state was not read. */
  sawFlag: boolean;
}

/**
 * Payment state from the billed lines `validate_treatment` read via
 * `poliklinik.getListTindakan` (the kasir `getJumlahBayar` is dead on this
 * backend). A line's `flag` is `"Belum"`/`"Sudah"`; the payable total is the
 * sum of `jumlah`, and `sudah` the sum already settled. Unpaid means nothing
 * marked paid yet (legacy `tunai==="0" && piutang==="0"`).
 */
export function tallyRajalBillLines(rows: readonly { readonly jumlah?: string | undefined; readonly flag?: string | undefined }[]): RajalBillTally {
  let total = 0;
  let sudah = 0;
  let sawFlag = false;
  for (const row of rows) {
    const amount = Number(row.jumlah ?? '0') || 0;
    total += amount;
    const lineFlag = (row.flag ?? '').trim().toUpperCase();
    if (lineFlag) sawFlag = true;
    if (lineFlag === 'SUDAH' || lineFlag === 'LUNAS' || lineFlag === 'PIUTANG') sudah += amount;
  }
  return { total, sudah, sawFlag };
}
