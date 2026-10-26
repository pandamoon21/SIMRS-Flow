/**
 * Cashier-vs-rekapitulasi balance check ported from `ranap_v3.py`.
 *
 * `cek_balance_total_tagihan` is the last read-only gate before an inpatient
 * episode may be verified or staged for payment: the kasir's grand total must
 * agree, to the rupiah, with both totals printed on the rekapitulasi
 * ("entitlement detail") page. A mismatch means a billing line was added,
 * removed or re-dated on only one side, so the run must stop and a human must
 * look. There is **no tolerance** — the Python compares with `==`.
 *
 * Hoisted fetches (endpoint id → parameter). The Python performs these inline;
 * here they are parameters so this module stays pure and offline:
 *  - `penatajasaInap.getDataKunjungan` (`ambil_datakunjungan(no_rm, trx)`) →
 *    `datakunjungan` in {@link buildRekapitulasiDetailHakParams}. Only its
 *    `kd_unit` and `kd_detkelpenjamin` are read.
 *  - `poliklinik.getDataKunjunganTab2` (`ambil_datakunjungan_tab2_inap(reg,
 *    kd_unit)`) → `datakunjunganTab2` in
 *    {@link buildRekapitulasiDetailHakParams}. The Python only issues this call
 *    when `kd_unit` resolves non-empty, and this port keeps that gate: with an
 *    empty `kd_unit` every tab2-derived field comes back `''` even if a row was
 *    supplied.
 *  - `rekapitulasi.detailHak` (`fetch_rekapitulasi_detail_hak`) → `rekapHtml`
 *    in {@link checkBalanceTotalTagihan}. Caller supplies the result of
 *    `rekapitulasi.detailHak` (or, for the printable variant,
 *    `rekapitulasi.detailHakHtml`) called with the params
 *    {@link buildRekapitulasiDetailHakParams} returns — the Python passes
 *    `params_state="belum_verif"` and `status_obat=""`, which are the defaults
 *    here.
 *  - `kasir.getJumlahBayar` (`get_jumlah_bayar_kasir(no_registrasikunjungan=reg)`)
 *    → `kasirTotals` in {@link checkBalanceTotalTagihan}. The Python passes the
 *    registration number only, leaving `no_transaksi`/`kd_unit` empty, so the
 *    response is the episode-wide total.
 *
 * The two `fetch_*` wrappers themselves are not ported: they are one `_get_text`
 * each, and their only logic ("empty params → empty string") is the caller's
 * `if (Object.keys(params).length === 0)` check.
 */

import type { LegacyRow } from './types.js';
import { str } from './types.js';
import { datePart, parseDateTimeFlexible } from './dates.js';
import { parseCurrencyInt } from './scalars.js';

/**
 * The two labels `cek_balance_total_tagihan` looks up on the rekapitulasi page,
 * in the Python's order. Both must equal the kasir grand total.
 *
 * The order matters to {@link BalanceCheck.rekapTotal}, which reports the *last*
 * label's value — "TOTAL TAGIHAN", the page's headline number.
 */
export const REKAP_TOTAL_LABELS: readonly string[] = ['TOTAL BIAYA', 'TOTAL TAGIHAN'];

/** Every `reason` {@link checkBalanceTotalTagihan} can report. */
export type BalanceReason =
  /** `if not room_rows: return False` — refused before any read. */
  | 'room_rows_kosong'
  /** `bool(grand_total)` is false: the kasir reports nothing payable. */
  | 'grand_total_kasir_nol'
  /** At least one rekapitulasi total differs from the kasir grand total. */
  | 'total_belum_balance'
  /** All totals agree. */
  | 'balance';

/** One rekapitulasi label, its scraped value, and its gap to the kasir total. */
export interface BalanceDetail {
  /** The label as searched for, e.g. `"TOTAL TAGIHAN"`. */
  label: string;
  /** `_extract_rekap_total` — `0` when the label is not on the page at all. */
  value: number;
  /** `kasirTotal - value`; `0` means this label agrees. */
  difference: number;
}

/**
 * The verdict of `cek_balance_total_tagihan`, which the Python collapsed to a
 * bool after printing the numbers. Every number it printed is kept here so the
 * caller can put the same line in the audit trail.
 *
 * `rekapTotal`/`difference` describe the last label in {@link REKAP_TOTAL_LABELS}
 * ("TOTAL TAGIHAN"); `details` carries every label, because a run can be out of
 * balance on "TOTAL BIAYA" while "TOTAL TAGIHAN" happens to match.
 */
export interface BalanceCheck {
  /** `bool(grand_total) and grand_total == total_biaya == total_tagihan`. */
  balanced: boolean;
  /** The kasir grand total (`getJumlahBayar.grand_total`), in rupiah. */
  kasirTotal: number;
  /** The rekapitulasi "TOTAL TAGIHAN". */
  rekapTotal: number;
  /** `kasirTotal - rekapTotal`. */
  difference: number;
  /** Why the run is (not) balanced. */
  reason: BalanceReason;
  /** Per-label scrape results, in {@link REKAP_TOTAL_LABELS} order. */
  details: BalanceDetail[];
  /** `no_registrasikunjungan` of the first room row — the Python's log key. */
  reg: string;
}

/** Arguments of {@link buildRekapitulasiDetailHakParams}. */
export interface BuildRekapitulasiDetailHakParamsArgs {
  /** Medrec, already normalised (`0-12-34-56`); goes into `nomedrec` verbatim. */
  noRm: string;
  /** Raw `gethistorykamar`-style room rows — *not* normalised stays. */
  roomRows: readonly LegacyRow[];
  /** `params` field; the Python's default is `"belum_verif"`. */
  paramsState?: string;
  /** `status_obat` field; the Python's default is `""`. */
  statusObat?: string;
  /** Hoisted `penatajasaInap.getDataKunjungan` for the earliest room row. */
  datakunjungan?: LegacyRow;
  /** Hoisted `poliklinik.getDataKunjunganTab2`; ignored when `kd_unit` is blank. */
  datakunjunganTab2?: LegacyRow;
}

/**
 * `_build_rekapitulasi_detail_hak_params` — the POST/GET field map the
 * rekapitulasi endpoints expect.
 *
 * The transaction identity comes from the *earliest* room row by `tgl_masuk`
 * (unparseable dates sort last, Python's `or datetime.max`), and the period
 * covers the whole group: `periode1` is the earliest admission date, `periode2`
 * the latest discharge date, falling back per row to that row's admission when
 * it has no discharge. `kd_klasifikasi` is always empty and `selisih_biaya`,
 * `pelaksana` and `tanpa_tgl` are always `"0"` — the Python hard-codes them.
 *
 * Returns `{}` for an empty `roomRows`, which is the Python's signal to skip
 * the fetch entirely.
 *
 * @throws when `roomRows` is non-empty but no row has a readable `tgl_masuk`.
 * The Python raises `ValueError: min() arg is an empty sequence` at exactly this
 * point; it is a data fault, not a normal outcome, so it is not swallowed.
 * (`datePart` only returns `''` for genuinely blank input — unparseable text
 * comes back as its first ten characters — so this needs a group whose rows all
 * lack `tgl_masuk`.)
 */
export function buildRekapitulasiDetailHakParams(
  args: BuildRekapitulasiDetailHakParamsArgs,
): Record<string, string> {
  const roomRows = args.roomRows ?? [];
  if (roomRows.length === 0) return {};

  const firstRow = earliestByAdmission(roomRows);
  const noTransaksi = str(firstRow, 'no_transaksi');
  const noRegistrasikunjungan = str(firstRow, 'no_registrasikunjungan');

  const datakunjungan = args.datakunjungan ?? {};
  // `str(datakunjungan.get("kd_unit") or first_row.get("kd_unit") or "").strip()`
  const kdUnit = firstTruthyText(datakunjungan['kd_unit'], firstRow['kd_unit']).trim();
  // The Python: `ambil_datakunjungan_tab2_inap(...) if kd_unit else {}`.
  const tab2: LegacyRow = kdUnit ? (args.datakunjunganTab2 ?? {}) : {};

  const admissionDates: string[] = [];
  const dischargeDates: string[] = [];
  for (const row of roomRows) {
    const masuk = datePart(row['tgl_masuk']);
    if (masuk) admissionDates.push(masuk);
    // `_date_part(row.get("tgl_keluar") or row.get("tgl_masuk"))`
    const keluar = datePart(firstTruthyValue(row['tgl_keluar'], row['tgl_masuk']));
    if (keluar) dischargeDates.push(keluar);
  }
  if (admissionDates.length === 0 || dischargeDates.length === 0) {
    throw new Error(
      'Tidak ada tgl_masuk yang dapat dibaca pada room_rows: params rekapitulasi detail hak tidak dapat dibentuk.',
    );
  }
  // ISO dates compare lexicographically, so min/max on the strings is Python's.
  const period1 = admissionDates.reduce((min, item) => (item < min ? item : min));
  const period2 = dischargeDates.reduce((max, item) => (item > max ? item : max));

  return {
    nomedrec: args.noRm,
    no_transaksi: noTransaksi,
    no_registrasikunjungan: noRegistrasikunjungan,
    kd_spesialisasi: firstTruthyText(tab2['kd_spesialisasi']),
    kd_ruangperawatan: firstTruthyText(tab2['kd_ruangperawatan']),
    kd_kamarperawatan: firstTruthyText(tab2['kd_kamarperawatan']),
    kd_detkelpenjamin: firstTruthyText(
      tab2['kd_detkelpenjamin'],
      datakunjungan['kd_detkelpenjamin'],
    ),
    kd_klasifikasi: '',
    periode1: period1,
    periode2: period2,
    selisih_biaya: '0',
    pelaksana: '0',
    tanpa_tgl: '0',
    kd_kelasperawatan: firstTruthyText(tab2['kd_kelasperawatan']),
    params: args.paramsState ?? 'belum_verif',
    status_obat: args.statusObat ?? '',
  };
}

/**
 * `_extract_rekap_total` — scrape one bolded total off the rekapitulasi page.
 *
 * The page renders each total as a bolded label cell followed (eventually) by a
 * bolded value cell, so the Python matches
 * `<b>LABEL</b> … <td…><b>VALUE</b>` non-greedily, case-insensitively, across
 * newlines. Ported as the same single regex — no DOM, no new dependency.
 *
 * A label that is not on the page gives `0` (the Python's `if not match:
 * return 0`), and so does markup where the value cell is not a `<b>` directly
 * inside a `<td>`. The value goes through `_parse_currency_int`, so the page's
 * Indonesian thousands separators ("Rp 12.500.000") simply vanish.
 */
export function extractRekapTotal(html: string, label: string): number {
  if (!html) return 0;
  const pattern = new RegExp(
    `<b>\\s*${escapeRegExp(label)}\\s*</b>[\\s\\S]*?<td[^>]*><b>([^<]+)</b>`,
    'i',
  );
  const match = pattern.exec(html);
  if (!match) return 0;
  return parseCurrencyInt(match[1], 0);
}

/**
 * The kasir side of the comparison.
 *
 * The Python always passes one `getJumlahBayar` response and reads
 * `grand_total` off it. The other shapes are accepted for callers that hold the
 * number already or that fetched a total per transaction; an array is **summed**,
 * which is this port's own extension and not something the Python ever did —
 * prefer the single episode-wide response the Python used.
 */
export type KasirTotalsInput =
  | LegacyRow
  | readonly LegacyRow[]
  | readonly number[]
  | number
  | string
  | null
  | undefined;

/** Arguments of {@link checkBalanceTotalTagihan}. */
export interface CheckBalanceTotalTagihanArgs {
  /** Hoisted `rekapitulasi.detailHak` HTML. */
  rekapHtml: string;
  /** Hoisted `kasir.getJumlahBayar` response (or the total itself). */
  kasirTotals: KasirTotalsInput;
  /**
   * The episode's room rows. Supply them to reproduce the Python's
   * `if not room_rows: return False` guard and to report `reg`; omit them when
   * the caller has already refused an empty group.
   */
  roomRows?: readonly LegacyRow[];
  /** Override the labels compared; defaults to {@link REKAP_TOTAL_LABELS}. */
  labels?: readonly string[];
}

/**
 * `cek_balance_total_tagihan` — is the cashier grand total balanced against the
 * rekapitulasi?
 *
 * The decision, exactly as the Python computes it:
 *
 *  1. An empty `roomRows` is refused outright (`room_rows_kosong`).
 *  2. The kasir grand total must be non-zero — `bool(grand_total)`. A zero
 *     total is *not* "balanced against a zero rekap"; it means the kasir has
 *     nothing staged, so the run stops (`grand_total_kasir_nol`).
 *  3. Every label in {@link REKAP_TOTAL_LABELS} must equal that grand total
 *     exactly. The Python's chained `grand_total == total_biaya ==
 *     total_tagihan` allows **no tolerance**, and a label missing from the page
 *     scrapes as `0`, so a truncated or error page can never read as balanced.
 *
 * The Python printed one line either way and returned a bool; the numbers it
 * printed are returned in {@link BalanceCheck} instead.
 */
export function checkBalanceTotalTagihan(args: CheckBalanceTotalTagihanArgs): BalanceCheck {
  const labels = args.labels ?? REKAP_TOTAL_LABELS;
  const kasirTotal = resolveKasirTotal(args.kasirTotals);
  const reg = args.roomRows && args.roomRows.length > 0 ? str(args.roomRows[0], 'no_registrasikunjungan') : '';

  const details: BalanceDetail[] = labels.map((label) => {
    const value = extractRekapTotal(args.rekapHtml, label);
    return { label, value, difference: kasirTotal - value };
  });
  const last = details[details.length - 1];
  const rekapTotal = last ? last.value : 0;

  let reason: BalanceReason;
  if (args.roomRows !== undefined && args.roomRows.length === 0) {
    reason = 'room_rows_kosong';
  } else if (!kasirTotal) {
    reason = 'grand_total_kasir_nol';
  } else if (details.length === 0 || details.some((detail) => detail.value !== kasirTotal)) {
    reason = 'total_belum_balance';
  } else {
    reason = 'balance';
  }

  return {
    balanced: reason === 'balance',
    kasirTotal,
    rekapTotal,
    difference: kasirTotal - rekapTotal,
    reason,
    details,
    reg,
  };
}

// ── internals ────────────────────────────────────────────────────

/**
 * `sorted(room_rows, key=lambda row: _parse_datetime_flexible(row["tgl_masuk"])
 * or datetime.max)[0]` — the earliest admission, unreadable dates last, ties
 * left in input order (Python's sort is stable).
 */
function earliestByAdmission(roomRows: readonly LegacyRow[]): LegacyRow {
  let best = roomRows[0] as LegacyRow;
  let bestTime = admissionTime(best);
  for (let index = 1; index < roomRows.length; index += 1) {
    const row = roomRows[index] as LegacyRow;
    const time = admissionTime(row);
    if (time < bestTime) {
      best = row;
      bestTime = time;
    }
  }
  return best;
}

function admissionTime(row: LegacyRow): number {
  return parseDateTimeFlexible(row['tgl_masuk'])?.getTime() ?? Number.POSITIVE_INFINITY;
}

/** `str(a or b or "")` — the first Python-truthy value, stringified. */
function firstTruthyText(...values: readonly unknown[]): string {
  const value = firstTruthyValue(...values);
  return value === undefined ? '' : String(value);
}

/** `a or b or None` on Python's truthiness (`0`, `''`, `False`, `[]`, `{}` skip). */
function firstTruthyValue(...values: readonly unknown[]): unknown {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (value === false || value === 0) continue;
    if (typeof value === 'string' && value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return value;
  }
  return undefined;
}

/**
 * The kasir grand total as an integer.
 *
 * Rows and strings go through `_parse_currency_int`. A `number` is truncated
 * toward zero instead of being re-stringified — the one place this differs from
 * the Python, which would read a stray `1250000.5` as `12500005`.
 */
function resolveKasirTotal(input: KasirTotalsInput): number {
  if (input === null || input === undefined) return 0;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.trunc(input) : 0;
  if (typeof input === 'string') return parseCurrencyInt(input, 0);
  if (Array.isArray(input)) {
    let sum = 0;
    for (const item of input as readonly (LegacyRow | number)[]) {
      sum += resolveKasirTotal(item);
    }
    return sum;
  }
  return parseCurrencyInt((input as LegacyRow)['grand_total'], 0);
}

/** `re.escape` for the fragments interpolated into the scrape pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
