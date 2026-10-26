/**
 * The verification summary row ported from `ranap_v3.py`.
 *
 * `_emit_verifikasi_summary_tsv` prints one tab-separated line per verified
 * registration group; operators paste those lines straight into the daily
 * spreadsheet, so the column order and the placeholder wording (`-`, `TITIPAN`,
 * `BAYI SEHAT`) are the contract. This port returns the row instead of printing
 * it — the caller decides whether it goes to a console event, an export, or a
 * ledger entry.
 *
 * Hoisted fetches (endpoint → parameter):
 *  - `kasir/kasir_rawatinap/get_jumlahbayar` (`get_jumlah_bayar_kasir(reg, trx,
 *    kd_unit, False)`, whose `grand_total`/`total` the Python runs through
 *    `_parse_currency_int`) → `grandTotal`.
 *  - `_get_penunjang_keterangan_for_summary(reg)`, which reads the run's alert
 *    registry rather than the network → `keterangan` (already-rendered items,
 *    e.g. `"HASIL LAB PK tanggal 2026-03-10"`). See `RunAlerts` in
 *    `./alerts.ts` for where those alerts come from.
 */

import type { LegacyRow } from './types.js';
import { flag, str } from './types.js';
import { datePart } from './dates.js';
import { getTitipanKeteranganForGroup } from './careClass.js';
import { normalizePenjaminSummaryLabel } from './names.js';
import { parseCurrencyInt } from './scalars.js';

/**
 * The header `main()` prints once, before the first summary row. The cell order
 * of {@link buildVerifikasiSummaryRow} matches it position for position.
 */
export const VERIFIKASI_SUMMARY_HEADER: readonly string[] = [
  'nama pasien',
  'no rekam medis',
  'PBI/NON PBI',
  'user_proses',
  'grand total',
  'tanggal masuk',
  'tanggal keluar',
  'keterangan',
];

/**
 * `DEFAULT_USER_PROSES` — the Python reads `EVOMEDIS_USER_PROSES` at import
 * time and falls back to this. This module never touches `process.env`; a
 * caller that wants the configured name passes `userProses`.
 */
export const DEFAULT_USER_PROSES = 'naufal a';

/** The keterangan item a healthy-newborn RME record adds. */
export const BAYI_SEHAT_KETERANGAN = 'BAYI SEHAT';

/** Named arguments for {@link buildVerifikasiSummaryRow}. */
export interface BuildVerifikasiSummaryRowArgs {
  /** Patient RM, used only when `noMedicalrecord` is blank. */
  noRm: string;
  /** The room rows of one registration group; `[0]` is the primary row. */
  roomRows: readonly LegacyRow[];
  namaPasien?: string;
  noMedicalrecord?: string;
  namaPenjamin?: string;
  /** The matched SEP payload; drives the TITIPAN keterangan. */
  sepItem?: LegacyRow;
  fallbackNoSep?: string;
  /** `byny_rme_status` for this reg; `is_healthy` adds `BAYI SEHAT`. */
  bynyRmeStatus?: LegacyRow;
  /** Operator name; defaults to {@link DEFAULT_USER_PROSES}, then `-`. */
  userProses?: string;
  /** Hoisted `get_jumlah_bayar_kasir` amount. Rendered as a plain integer. */
  grandTotal?: number | string;
  /**
   * Hoisted `_get_penunjang_keterangan_for_summary(reg)` items. A single string
   * is split on `;` so de-duplication still works item by item.
   */
  keterangan?: string | readonly string[];
}

/** One rendered summary row. */
export interface VerifikasiSummaryRow {
  /** Cells in {@link VERIFIKASI_SUMMARY_HEADER} order. */
  cells: string[];
  /** `cells.join('\t')` — what `main()` prints. */
  tsv: string;
}

/** `min(...)`/`max(...)` over `YYYY-MM-DD` strings, whose order is chronological. */
function minText(values: readonly string[], fallback: string): string {
  if (values.length === 0) return fallback;
  return values.reduce((best, item) => (item < best ? item : best));
}

function maxText(values: readonly string[], fallback: string): string {
  if (values.length === 0) return fallback;
  return values.reduce((best, item) => (item > best ? item : best));
}

/** Accept the hoisted keterangan as one string or as separate items. */
function keteranganItemsOf(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const parts = typeof value === 'string' ? value.split(';') : value;
  return parts.map((item) => (item ?? '').toString().trim()).filter((item) => item.length > 0);
}

/**
 * `_emit_verifikasi_summary_tsv` — build the row for one verified registration
 * group.
 *
 * Blank cells become `-` (name, RM, payer, operator, both dates) exactly as the
 * Python renders them, and the keterangan column is `;`-joined and
 * de-duplicated in this order: TITIPAN (from the SEP class vs the room class),
 * `BAYI SEHAT`, then the hoisted penunjang items.
 *
 * With no room rows the Python prints nothing; here that is an empty
 * `cells`/`tsv` pair, which the caller should skip rather than emit.
 */
export function buildVerifikasiSummaryRow(
  args: BuildVerifikasiSummaryRowArgs,
): VerifikasiSummaryRow {
  const roomRows = args.roomRows ?? [];
  if (roomRows.length === 0) return { cells: [], tsv: '' };

  const primaryRow = roomRows[0] ?? {};
  const noRmValue = (args.noMedicalrecord ?? '').trim() || (args.noRm ?? '').trim() || '-';
  const namaValue = (args.namaPasien ?? '').trim() || str(primaryRow, 'nama_pasien') || '-';
  const penjaminValue = normalizePenjaminSummaryLabel(
    (args.namaPenjamin ?? '').trim() || str(primaryRow, 'nama_penjamin'),
  );
  const grandTotal = parseCurrencyInt(args.grandTotal ?? 0, 0);

  const masukDates: string[] = [];
  const keluarDates: string[] = [];
  for (const row of roomRows) {
    const masuk = datePart(str(row, 'tgl_masuk'));
    if (masuk) masukDates.push(masuk);
    const keluar = datePart(str(row, 'tgl_keluar', 'tgl_masuk'));
    if (keluar) keluarDates.push(keluar);
  }

  const keteranganItems: string[] = [];
  const titipanKeterangan = getTitipanKeteranganForGroup(roomRows, args.sepItem ?? {}, {
    namaPasien: args.namaPasien ?? '',
    fallbackNoSep: args.fallbackNoSep ?? '',
  });
  if (titipanKeterangan) keteranganItems.push(titipanKeterangan);
  if (args.bynyRmeStatus && flag(args.bynyRmeStatus['is_healthy'])) {
    keteranganItems.push(BAYI_SEHAT_KETERANGAN);
  }
  keteranganItems.push(...keteranganItemsOf(args.keterangan));
  const keterangan = [...new Set(keteranganItems.filter((item) => item.length > 0))].join('; ');

  const cells = [
    namaValue,
    noRmValue,
    penjaminValue,
    (args.userProses ?? '').trim() || DEFAULT_USER_PROSES || '-',
    String(grandTotal || 0),
    minText(masukDates, '-'),
    maxText(keluarDates, '-'),
    keterangan,
  ];
  return { cells, tsv: cells.join('\t') };
}
