/**
 * Penunjang (diagnostic-support) result validation ported from `ranap_v3.py`.
 *
 * Before a rawat-inap registration may be verified, every lab / PA / radiology /
 * electromedical order attached to the stay must actually carry a *result*: a
 * detail line, a readable value, a printable document, and — where the module
 * supports it — an approval flag. The legacy script answers that question with
 * four `validate_hasil_*` functions that each fire eight to twelve HTTP calls
 * and then print an operator log.
 *
 * This port keeps only the decision. Every remote read is an explicit
 * parameter, so a validator is a pure fold over already-fetched payloads and can
 * be replayed from the ledger.
 *
 * Hoisted fetches (endpoint → parameter):
 *
 * `validateHasilLaboratoriumPk`
 *  - `poliklinik/penatajasa_inap/getdetail_historyilab` → `detailRows`
 *  - `laboratorium/hasil_pemeriksaan/getdetailtransaksi` → `detailHasilRows`
 *  - `laboratorium/hasil_pemeriksaan/gethasilpemeriksaan` → `hasilRows`
 *  - `laboratorium/hasil_pemeriksaan/cetak_lis` (text) → `lisUrl`
 *  - `laboratorium/registrasi_pemeriksaan/view_raw` (text) → `rawResult`
 *  - the LIS PDF (external `lis_new/pdf.php`, through `_build_pdf_info`) → `pdfInfo`
 *  - `laboratorium/hasil_pemeriksaan/getdatatransaksi` → `hasilData`. The Python
 *    first walks `laboratorium/hasil_pemeriksaan/getdatakunjungan` with
 *    {@link findHasilRowByNoTransaksi} and passes that row's
 *    `tgl_masuk`/`tgl_transaksi` as the query date; the caller does the same
 *    (see {@link buildHasilLookupWindow}) before calling this validator.
 *
 * `validateHasilPa`
 *  - `kemoterapi/registrasi_pemeriksaan/getdetail_history_orderpa` → `detailRows`
 *  - `pa/hasil_pemeriksaan/hasilcetak` → `pdfInfo`
 *
 * `validateHasilRadiologi`
 *  - `poliklinik/penatajasa_inap/getdetail_historyirad` → `detailRows`
 *  - `radiologi/hasil_pemeriksaan/gethasilpemeriksaan` → `hasilRows`
 *  - `radiologi/hasil_pemeriksaan/getberkas` → `berkasRows`
 *  - `radiologi/hasil_pemeriksaan/getdatakunjungan` → `hasilRowMeta`
 *    (via {@link findHasilRowByNoTransaksi})
 *  - `radiologi/hasil_pemeriksaan/getdatatransaksi` → `hasilData`
 *  - `radiologi/hasil_pemeriksaan/cetak_a4` → `pdfInfo`
 *  - `radiologi/hasil_pemeriksaan/getdata_studyiud`, once per detail row that
 *    carries an `acc_number` → `studyUidByAccNumber`
 *
 * `validateHasilElektromedik`
 *  - `elektromedik/registrasi_pemeriksaan/get_listtindakan` → `detailRows`
 *  - `elektromedik/hasil_pemeriksaan/getListHasilPemeriksaan` → `hasilRows`
 *  - `elektromedik/registrasi_pemeriksaan/cek_statusbayar` → `statusBayar`
 *    (audit detail only; the Python prints it and never branches on it)
 *  - `elektromedik/hasil_pemeriksaan/cetakHasilPemeriksaan` → `pdfInfo`
 *  - `elektromedik/hasil_pemeriksaan/getHasilPemeriksaan`, once per accepted
 *    hasil row → `detailHtmlByItem`, keyed by {@link elektromedikDetailKey}
 *
 * `collectPenunjangHistories`
 *  - `poliklinik/penatajasa_inap/gethistoryilab` → `lab`
 *  - `kemoterapi/registrasi_pemeriksaan/gethistory_orderpa` → `pa`
 *  - `poliklinik/poliklinik/gethistoryirad` → `rad`
 *  - `poliklinik/penatajasa_inap/gethistoryiok` → `ok`
 *
 * `collectDirectHasilRowsForGroup` / `findHasilRowByNoTransaksi`
 *  - `laboratorium/hasil_pemeriksaan/getdatakunjungan` or
 *    `radiologi/hasil_pemeriksaan/getdatakunjungan`, one payload per page → `pages`
 *
 * `validatePenunjangResultsForGroup`
 *  - `laboratorium/registrasi_pemeriksaan/gethistorykunjungan`, filtered by
 *    `_collect_related_lab_pk` → `relatedLabPk`
 *  - the two `getdatakunjungan` sweeps above → `directLabRows` / `directRadRows`
 *  - the four per-transaction validators → the `validate` callback
 *
 * `_register_penunjang_validation_alert` becomes
 * {@link buildPenunjangValidationAlert}, which *returns* the alert instead of
 * mutating a module-level registry (see `RunAlerts` in `./alerts.ts`).
 */

import type { AlertLevel } from './alerts.js';
import { parseDateFlexible, parseDateTimeFlexible, startOfDay } from './dates.js';
import { getRoomGroupDateRange } from './rooms.js';
import { extractTextareaText, stripHtmlText } from './scalars.js';
import type { LegacyRow } from './types.js';
import { flag, str } from './types.js';

// ── the shared result shape ──────────────────────────────────────

/**
 * `result["approve"]` — the module's approval flag as the legacy script reports
 * it. `'unknown'` means the endpoint gave nothing usable (PA never reports one);
 * `'n/a'` is this port's addition for a validator with no approval concept at
 * all (IBS, in `./ibs.ts`), so it is never treated as an outstanding approval.
 */
export type PenunjangApproveState = '1' | '0' | 'unknown' | 'n/a';

/** One `label: value` pair of the operator-facing detail block. */
export interface PenunjangValidationDetail {
  label: string;
  value: string;
}

/**
 * The single result shape every validator in this package returns — the port of
 * the `{"module", "trx", "status", "has_result", "approve", "summary", "issues"}`
 * dict that `_register_penunjang_validation_alert` and
 * `validate_penunjang_results_for_group` both consume.
 */
export interface PenunjangValidation {
  /**
   * `status === 'ok'` — the modality's own verdict: the result exists and is
   * complete. Note this is *not* the same as "no alert due": see
   * {@link needsAttention}.
   */
  ok: boolean;
  /** `result["module"]` — `'Lab PK' | 'PA' | 'Radiologi' | 'Elektromedik' | 'IBS'`. */
  modality: string;
  /**
   * `result["trx"]` — the penunjang transaction validated. `./ibs.ts` validates a
   * whole registration rather than one transaction and puts the
   * `no_registrasikunjungan` here.
   */
  noTransaksi: string;
  /** `result["status"]`, verbatim. */
  status: 'ok' | 'warn';
  /**
   * The composite gate `_register_penunjang_validation_alert` and the group
   * roll-up both apply: `status !== 'ok'` **or** `approve` is `'0'`/`'unknown'`.
   *
   * Faithful quirk: PA never reports an approval state, so a perfectly clean PA
   * result still needs attention and still raises a WARN. That is the legacy
   * behaviour — do not "fix" it here.
   */
  needsAttention: boolean;
  /** `result["has_result"]`. */
  hasResult: boolean;
  /** `result["approve"]`. */
  approve: PenunjangApproveState;
  /**
   * What is outstanding, as the legacy log renders it: `issues.join('; ')`, or
   * `'perlu cek manual'` when something is wrong but the validator could not
   * name it, or `''` when nothing is outstanding.
   */
  reason: string;
  /** `result["issues"]`, in the Python's order. */
  issues: string[];
  /** `result["summary"]` — the one-line audit form. */
  summary: string;
  /** The level of the alert this result would raise; `'info'` when none is due. */
  severity: 'info' | 'warn' | 'error';
  /** The summary broken out for the inspector / ledger. */
  details: PenunjangValidationDetail[];
  /** PA only: the result PDF answered "DATA TIDAK ADA". */
  noData?: boolean;
}

/** The alert `_register_penunjang_validation_alert` would have registered. */
export interface PenunjangValidationAlert {
  /** `no_registrasikunjungan` the alert is filed under. */
  reg: string;
  level: AlertLevel;
  message: string;
}

/** `_build_pdf_info` output. Both `is_pdf` and `isPdf` spellings are accepted. */
export interface PenunjangPdfInfo {
  is_pdf?: unknown;
  isPdf?: unknown;
  /** The PDF's extracted text fragments, newline-joined. */
  text?: unknown;
  /** Response byte length; carried into the audit detail, never branched on. */
  size?: unknown;
  [key: string]: unknown;
}

// ── constants ────────────────────────────────────────────────────

/** `_bool_approved_flag` accepted values — case-sensitive, as in the Python. */
export const APPROVED_FLAG_VALUES: readonly string[] = ['1', 'true', 'True', 'APPROVE', 'APPROVED'];

/** `_has_meaningful_hasil_value` rejects these (upper-case only, as written). */
export const EMPTY_HASIL_VALUES: readonly string[] = ['-', 'NULL', 'NONE'];

/** `_find_hasil_row_by_no_transaksi(window_days=14)`. */
export const HASIL_LOOKUP_WINDOW_DAYS = 14;

/** `_find_hasil_row_by_no_transaksi(max_pages=3)`. */
export const HASIL_LOOKUP_MAX_PAGES = 3;

/** `_find_hasil_row_by_no_transaksi(rows=50)`. */
export const HASIL_LOOKUP_ROWS_PER_PAGE = 50;

/** `_collect_direct_hasil_rows_for_group(max_pages=4)`. */
export const DIRECT_HASIL_MAX_PAGES = 4;

/** `_collect_direct_hasil_rows_for_group(rows=100)`. */
export const DIRECT_HASIL_ROWS_PER_PAGE = 100;

/** PHP notices that mean the radiology result PDF rendered an error page. */
export const RADIOLOGI_PDF_ERROR_MARKERS: readonly string[] = [
  'A PHP ERROR WAS ENCOUNTERED',
  'UNDEFINED VARIABLE',
  'TRYING TO GET PROPERTY',
  'SEVERITY: NOTICE',
];

/** The same, for the electromedical result PDF (one extra marker). */
export const ELEKTROMEDIK_PDF_ERROR_MARKERS: readonly string[] = [
  'A PHP ERROR WAS ENCOUNTERED',
  'TRYING TO GET PROPERTY',
  'SEVERITY: NOTICE',
  'UNDEFINED VARIABLE',
  'NON-OBJECT',
];

/**
 * Markers that mean the LIS PDF is a blank template rather than a real result.
 * `'-- \\(::\\'` is the Python literal `"-- \\(::\\"` — a *non*-raw string, so
 * the text actually searched for is `-- \(::\`.
 */
export const LAB_PDF_PLACEHOLDER_MARKERS: readonly string[] = [
  '0 TH, 0 BL, 0 HR',
  '-- \\(::\\',
  'PRINT DATE : :',
];

/** The `<textarea>` the electromedical result HTML keeps its narrative in. */
export const ELEKTROMEDIK_HASIL_TEXTAREA_ID = 'txtDefaultHtmlArea_hslelm';

/** The electromedical detail HTML says this once a result is approved. */
export const ELEKTROMEDIK_APPROVED_MARKER = 'DATA HASIL PEMERIKSAAN SUDAH APPROVE';

/** Modules whose missing approval is called out by name in the alert detail. */
const APPROVE_REPORTING_MODULES: readonly string[] = ['Lab PK', 'Radiologi', 'Elektromedik'];

// ── primitives ───────────────────────────────────────────────────

/** Python's `str(value or "").strip()`. */
function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isRecordLike(value: unknown): value is LegacyRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Python's `isinstance(x, dict) and x` — a dict with at least one key. */
function isNonEmptyRecord(value: unknown): value is LegacyRow {
  return isRecordLike(value) && Object.keys(value).length > 0;
}

function detail(label: string, value: unknown): PenunjangValidationDetail {
  return { label, value: text(value) || '-' };
}

/** `re.sub(r"\D", "", str(value or ""))`. */
function digitsOnly(value: unknown): string {
  return text(value).replace(/\D/g, '');
}

/** `'ya'`/`'tidak'` — the legacy summary's boolean rendering. */
function yaTidak(value: boolean): string {
  return value ? 'ya' : 'tidak';
}

/** `bool(pdf_info.get("is_pdf"))`, tolerating the camelCase spelling. */
function pdfIsPdf(pdfInfo: PenunjangPdfInfo | undefined): boolean {
  if (!pdfInfo) return false;
  const value = pdfInfo['is_pdf'] === undefined ? pdfInfo['isPdf'] : pdfInfo['is_pdf'];
  return flag(value);
}

/** `str(pdf_info.get("text") or "")` — not trimmed; substring tests need it raw. */
function pdfText(pdfInfo: PenunjangPdfInfo | undefined): string {
  const value = pdfInfo?.['text'];
  return value === undefined || value === null ? '' : String(value);
}

// ── ported primitives ────────────────────────────────────────────

/**
 * `_rows_from_payload` — the rows of a penunjang payload.
 *
 * Narrower than `rowsOf` in `./types.js` on purpose: only a `rows` key or a bare
 * array counts here, because that is all these endpoints return. Non-object
 * members are dropped so the result is typed, which the Python did not bother
 * with; no endpoint mixes scalars into `rows`.
 */
export function rowsFromPayload(data: unknown): LegacyRow[] {
  if (isRecordLike(data)) {
    const rows = data['rows'];
    if (Array.isArray(rows)) return rows.filter(isRecordLike);
  }
  if (Array.isArray(data)) return data.filter(isRecordLike);
  return [];
}

/**
 * `_parse_no_transaksi_date` — the admission date encoded in a penunjang
 * transaction number (`"03-100326-000123"` → 2026-03-10).
 *
 * Stricter than `extractDateFromNoTransaksi` in `./dates.js`: the prefix must be
 * exactly two digits, and the resulting date must be a real calendar date
 * (`strptime` raises otherwise), so `"03-320326-1"` gives `null`.
 */
export function parseNoTransaksiDate(noTransaksi: unknown): Date | null {
  const match = /^\d{2}-(\d{2})(\d{2})(\d{2})-/.exec(text(noTransaksi));
  if (!match) return null;
  const [, day, month, year] = match;
  return parseDateFlexible(`20${year}-${month}-${day}`);
}

/**
 * `_bool_approved_flag` — is this the SIMRS "approved" marker?
 *
 * The accepted set is case-sensitive exactly as the Python wrote it, so `'true'`
 * and `'True'` pass but `'TRUE'` does not, and `'APPROVE'` passes but
 * `'approve'` does not.
 */
export function boolApprovedFlag(value: unknown): boolean {
  return APPROVED_FLAG_VALUES.includes(text(value));
}

/**
 * `_has_meaningful_hasil_value` — does this field hold a real result?
 *
 * The value is stripped of markup first, then compared against the placeholder
 * set. The comparison is case-sensitive against the upper-case forms, which is
 * what the Python wrote: `'none'` in lower case counts as a real result.
 */
export function hasMeaningfulHasilValue(value: unknown): boolean {
  const stripped = stripHtmlText(value);
  return Boolean(stripped) && !EMPTY_HASIL_VALUES.includes(stripped);
}

/**
 * `_filter_history_rows_for_date_range` — visit/order rows whose
 * transaction, order, or admission date falls inside an inclusive
 * `YYYY-MM-DD` range.
 *
 * Rows with no parseable date are dropped; an unparseable bound is simply not
 * applied. (`./blockers.ts` keeps a private copy for its own IGD check; this is
 * the exported one.)
 */
export function filterHistoryRowsForDateRange(
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

// ── history collection ───────────────────────────────────────────

/** `_collect_penunjang_histories` output: the four per-patient order histories. */
export interface PenunjangHistories {
  /** `gethistoryilab` — inpatient lab orders. */
  lab: LegacyRow[];
  /** `gethistory_orderpa` — pathology orders. */
  pa: LegacyRow[];
  /** `gethistoryirad` — radiology orders. */
  rad: LegacyRow[];
  /** `gethistoryiok` — operating-theatre orders. */
  ok: LegacyRow[];
}

/**
 * `_collect_penunjang_histories` — shape the four history payloads into row
 * lists. The fetches are the caller's (see the module header); this is the
 * `.get("rows", [])` half.
 */
export function collectPenunjangHistories(payloads: {
  lab?: unknown;
  pa?: unknown;
  rad?: unknown;
  ok?: unknown;
}): PenunjangHistories {
  return {
    lab: rowsFromPayload(payloads?.lab),
    pa: rowsFromPayload(payloads?.pa),
    rad: rowsFromPayload(payloads?.rad),
    ok: rowsFromPayload(payloads?.ok),
  };
}

/** The `getdatakunjungan` query window {@link findHasilRowByNoTransaksi} needs. */
export interface HasilLookupWindow {
  startDate: string;
  endDate: string;
}

/**
 * The `± window_days` window `_find_hasil_row_by_no_transaksi` searches, split
 * out because it is the only part of that function that reads a clock.
 *
 * The reference date comes from the transaction number; `now` is used only when
 * the number carries no date, and is injectable so nothing here reads the clock
 * implicitly.
 */
export function buildHasilLookupWindow(
  noTransaksi: unknown,
  windowDays: number = HASIL_LOOKUP_WINDOW_DAYS,
  now: Date = new Date(),
): HasilLookupWindow {
  const ref = parseNoTransaksiDate(noTransaksi) ?? now;
  return {
    startDate: shiftDateText(ref, -windowDays),
    endDate: shiftDateText(ref, windowDays),
  };
}

/**
 * `_find_hasil_row_by_no_transaksi` — the `getdatakunjungan` row for one
 * transaction.
 *
 * `pages` are the page payloads the caller fetched over
 * {@link buildHasilLookupWindow}, page 1 first and at most
 * {@link HASIL_LOOKUP_MAX_PAGES} of them. Scanning stops at the first page with
 * no rows. Returns `{}` when the transaction is not in the window, exactly like
 * the Python, so callers can keep reading fields off the result.
 */
export function findHasilRowByNoTransaksi(
  pages: readonly unknown[],
  noTransaksi: unknown,
): LegacyRow {
  const wanted = text(noTransaksi);
  for (const payload of (pages ?? []).slice(0, HASIL_LOOKUP_MAX_PAGES)) {
    const rows = rowsFromPayload(payload);
    for (const row of rows) {
      if (str(row, 'no_transaksi') === wanted) return row;
    }
    if (rows.length === 0) break;
  }
  return {};
}

/** Named arguments for {@link collectDirectHasilRowsForGroup}. */
export interface CollectDirectHasilRowsForGroupArgs {
  /** The room rows of the group; their declared span bounds the query. */
  roomRows: readonly LegacyRow[];
  /**
   * `…/hasil_pemeriksaan/getdatakunjungan` payloads, page 1 first, fetched over
   * `getRoomGroupDateRange(roomRows)` — call that first to build the query.
   */
  pages: readonly unknown[];
  /** The `rows` page size used for the fetch; a short page ends the sweep. */
  rowsPerPage?: number;
}

/**
 * `_collect_direct_hasil_rows_for_group` — the result-side transactions that
 * fall inside a stay, read straight from the hasil module instead of the
 * inpatient order history.
 *
 * Pages are consumed in order and the sweep stops on the first empty page or the
 * first short page (`< rowsPerPage`), as the Python's loop did. Rows are
 * filtered to the group's declared date range, de-duplicated on `no_transaksi`,
 * and soft-deleted rows (`status_hapus === '1'`) are dropped.
 */
export function collectDirectHasilRowsForGroup(
  args: CollectDirectHasilRowsForGroupArgs,
): LegacyRow[] {
  const { start, end } = getRoomGroupDateRange(args.roomRows ?? []);
  if (!start) return [];
  const rowsPerPage = args.rowsPerPage ?? DIRECT_HASIL_ROWS_PER_PAGE;
  const collected: LegacyRow[] = [];
  const seen = new Set<string>();
  for (const payload of (args.pages ?? []).slice(0, DIRECT_HASIL_MAX_PAGES)) {
    const pageRows = rowsFromPayload(payload);
    if (pageRows.length === 0) break;
    for (const row of filterHistoryRowsForDateRange(pageRows, start, end)) {
      const noTransaksi = str(row, 'no_transaksi');
      if (!noTransaksi || seen.has(noTransaksi)) continue;
      if (str(row, 'status_hapus') === '1') continue;
      seen.add(noTransaksi);
      collected.push(row);
    }
    if (pageRows.length < rowsPerPage) break;
  }
  return collected;
}

// ── Lab PK ───────────────────────────────────────────────────────

/** Named arguments for {@link validateHasilLaboratoriumPk}. */
export interface ValidateHasilLaboratoriumPkArgs {
  /** The patient's medrec; its digits must appear in the LIS PDF text. */
  noRm: string;
  noTransaksiLab: string;
  /** `getdetail_historyilab` payload. */
  detailRows?: unknown;
  /** `laboratorium/hasil_pemeriksaan/getdetailtransaksi` payload. */
  detailHasilRows?: unknown;
  /** `laboratorium/hasil_pemeriksaan/gethasilpemeriksaan` payload. */
  hasilRows?: unknown;
  /** `cetak_lis` response text — presence alone counts. */
  lisUrl?: unknown;
  /** `view_raw` response text — presence alone counts. */
  rawResult?: unknown;
  /** The LIS PDF, through `_build_pdf_info`. */
  pdfInfo?: PenunjangPdfInfo;
  /** `laboratorium/hasil_pemeriksaan/getdatatransaksi` payload (an object). */
  hasilData?: unknown;
}

/**
 * `validate_hasil_laboratorium_pk` — does this lab order have a usable result?
 *
 * A result counts when the order has detail lines, at least one hasil row with a
 * meaningful `hasil` or `status`, and at least one document channel: the LIS
 * print, the raw viewer, or a PDF that is a real PDF, carries the patient's
 * medrec digits (or any 8+-digit identifier), and shows none of the blank
 * template markers. The approval flag is reported separately: `status` can be
 * `'ok'` while `approve` is still `'0'`/`'unknown'`, and the caller must then
 * still raise a WARN (see {@link buildPenunjangValidationAlert}).
 */
export function validateHasilLaboratoriumPk(
  args: ValidateHasilLaboratoriumPkArgs,
): PenunjangValidation {
  const noTransaksiLab = text(args.noTransaksiLab);
  const detailRows = rowsFromPayload(args.detailRows);
  const detailHasilRows = rowsFromPayload(args.detailHasilRows);
  const hasilRows = rowsFromPayload(args.hasilRows);
  const lisUrl = Boolean(text(args.lisUrl));
  const rawResult = Boolean(text(args.rawResult));
  const hasilData = args.hasilData;

  const approveFlag = boolApprovedFlag(
    isRecordLike(hasilData) ? hasilData['status_approve'] : '',
  );
  const approve = approveState(approveFlag, hasilData);

  const pdfBody = pdfText(args.pdfInfo);
  const pdfUpper = pdfBody.toUpperCase();
  const rmDigits = digitsOnly(args.noRm);
  const pdfDigits = digitsOnly(pdfBody);
  const hasIdentity =
    (Boolean(rmDigits) && pdfDigits.includes(rmDigits)) || /\b\d{8,}\b/.test(pdfBody);
  const hasPlaceholder = LAB_PDF_PLACEHOLDER_MARKERS.some((marker) => pdfUpper.includes(marker));
  const pdfValid = pdfIsPdf(args.pdfInfo) && hasIdentity && !hasPlaceholder;

  const hasilOkRows = hasilRows.filter(
    (row) => hasMeaningfulHasilValue(row['hasil']) || hasMeaningfulHasilValue(row['status']),
  );
  const hasResult =
    detailRows.length > 0 && hasilOkRows.length > 0 && (lisUrl || rawResult || pdfValid);
  const status: 'ok' | 'warn' = detailRows.length > 0 && hasResult ? 'ok' : 'warn';

  const referenceTrx = [
    ...new Set(detailHasilRows.map((row) => str(row, 'no_referensi')).filter(Boolean)),
  ].sort();

  const issues: string[] = [];
  if (detailRows.length === 0) issues.push('detail history kosong');
  if (hasilOkRows.length === 0) issues.push(`hasil_ok=0/${hasilRows.length}`);
  if (!lisUrl && !rawResult && !pdfValid) issues.push('LIS/raw/pdf belum valid');
  if (!approveFlag) issues.push(`approve=${approve}`);

  const summary =
    `Lab PK ${noTransaksiLab} | ref=${referenceTrx.join(',') || '-'} | ` +
    `detail=${detailRows.length} | hasil_ok=${hasilOkRows.length}/${hasilRows.length} | ` +
    `lis_url=${yaTidak(lisUrl)} | raw=${yaTidak(rawResult)} | pdf_valid=${yaTidak(pdfValid)} | ` +
    `approve=${approve}`;

  return buildValidation({
    modality: 'Lab PK',
    noTransaksi: noTransaksiLab,
    status,
    hasResult,
    approve,
    issues,
    summary,
    details: [
      detail('Trx', noTransaksiLab),
      detail('Ref', referenceTrx.join(',')),
      detail('Detail', detailRows.length),
      detail('Hasil ok', `${hasilOkRows.length}/${hasilRows.length}`),
      detail('LIS', yaTidak(lisUrl)),
      detail('Raw', yaTidak(rawResult)),
      detail('Pdf valid', yaTidak(pdfValid)),
      detail('Pdf size', args.pdfInfo?.['size'] ?? 0),
      detail('Approve', approve),
    ],
  });
}

// ── PA ───────────────────────────────────────────────────────────

/** Named arguments for {@link validateHasilPa}. */
export interface ValidateHasilPaArgs {
  noTransaksiPa: string;
  /** `getdetail_history_orderpa` payload. */
  detailRows?: unknown;
  /** `pa/hasil_pemeriksaan/hasilcetak`, through `_build_pdf_info`. */
  pdfInfo?: PenunjangPdfInfo;
}

/**
 * `validate_hasil_pa` — a pathology order needs detail lines and a result PDF.
 *
 * There is no approval endpoint for PA, so `approve` is always `'unknown'` and
 * {@link PenunjangValidation.needsAttention} is therefore always true: the
 * legacy script raises a WARN for every PA transaction it inspects, even a clean
 * one. `noData` records the other failure mode — a PDF that renders but says
 * "DATA TIDAK ADA".
 *
 * `kd_jenis_pemeriksaan` is not an argument: it only selects which PDF to fetch,
 * and the fetch is the caller's (it travels on the candidate, see
 * {@link PenunjangCandidate}).
 */
export function validateHasilPa(args: ValidateHasilPaArgs): PenunjangValidation {
  const noTransaksiPa = text(args.noTransaksiPa);
  const detailRows = rowsFromPayload(args.detailRows);
  const hasPdf = pdfIsPdf(args.pdfInfo);
  const noData = pdfText(args.pdfInfo).toUpperCase().includes('DATA TIDAK ADA');
  const status: 'ok' | 'warn' = detailRows.length > 0 && hasPdf ? 'ok' : 'warn';

  const issues: string[] = [];
  if (detailRows.length === 0) issues.push('detail history kosong');
  if (!hasPdf) issues.push('pdf hasil tidak ada');
  if (noData) issues.push('PDF membalas data tidak ada');

  const summary =
    `PA ${noTransaksiPa} | detail=${detailRows.length} | pdf=${yaTidak(hasPdf)} | ` +
    `no_data=${yaTidak(noData)}`;

  return {
    ...buildValidation({
      modality: 'PA',
      noTransaksi: noTransaksiPa,
      status,
      hasResult: detailRows.length > 0 && hasPdf,
      approve: 'unknown',
      issues,
      summary,
      details: [
        detail('Trx', noTransaksiPa),
        detail('Detail', detailRows.length),
        detail('Pdf', yaTidak(hasPdf)),
        detail('Pdf size', args.pdfInfo?.['size'] ?? 0),
        detail('No data', yaTidak(noData)),
      ],
    }),
    noData,
  };
}

// ── Radiologi ────────────────────────────────────────────────────

/** Named arguments for {@link validateHasilRadiologi}. */
export interface ValidateHasilRadiologiArgs {
  noTransaksiRad: string;
  /** `getdetail_historyirad` payload; its `acc_number`s drive the studyUID reads. */
  detailRows?: unknown;
  /** `radiologi/hasil_pemeriksaan/gethasilpemeriksaan` payload. */
  hasilRows?: unknown;
  /** `radiologi/hasil_pemeriksaan/getberkas` payload. */
  berkasRows?: unknown;
  /** `radiologi/hasil_pemeriksaan/getdatakunjungan` row — the approval fallback. */
  hasilRowMeta?: LegacyRow;
  /** `radiologi/hasil_pemeriksaan/getdatatransaksi` payload (an object). */
  hasilData?: unknown;
  /** `radiologi/hasil_pemeriksaan/cetak_a4`, through `_build_pdf_info`. */
  pdfInfo?: PenunjangPdfInfo;
  /**
   * `getdata_studyiud` responses keyed by the detail row's `acc_number`. Only
   * detail rows that carry an `acc_number` are looked up, in row order, and only
   * a non-empty `studyiud` counts — the Python's loop, hoisted.
   */
  studyUidByAccNumber?: Readonly<Record<string, unknown>>;
}

/**
 * `validate_hasil_radiologi` — a radiology order needs an error-free result PDF
 * plus at least one of: a hasil row with a meaningful `deskripsi`/`hasil`, an
 * attached berkas, or a PACS studyUID.
 *
 * Unlike Lab PK, the approval flag is part of the verdict here: `status` is
 * `'ok'` only when the result exists **and** it is approved. The flag is read
 * from `getdatatransaksi` when that answered with an object, otherwise from the
 * `getdatakunjungan` row.
 */
export function validateHasilRadiologi(args: ValidateHasilRadiologiArgs): PenunjangValidation {
  const noTransaksiRad = text(args.noTransaksiRad);
  const detailRows = rowsFromPayload(args.detailRows);
  const hasilRows = rowsFromPayload(args.hasilRows);
  const berkasRows = rowsFromPayload(args.berkasRows);
  const hasilData = args.hasilData;
  const hasilRowMeta = args.hasilRowMeta ?? {};

  const approveFlag = boolApprovedFlag(
    isRecordLike(hasilData) ? hasilData['status_approve'] : hasilRowMeta['status_approve'],
  );
  const approve = approveState(approveFlag, hasilData);

  const pdfUpper = pdfText(args.pdfInfo).toUpperCase();
  const pdfHasError = RADIOLOGI_PDF_ERROR_MARKERS.some((marker) => pdfUpper.includes(marker));

  const studyUids: string[] = [];
  for (const row of detailRows) {
    const accNumber = str(row, 'acc_number');
    if (!accNumber) continue;
    const study = args.studyUidByAccNumber?.[accNumber];
    const studyUid = isRecordLike(study) ? str(study, 'studyiud') : '';
    if (studyUid) studyUids.push(studyUid);
  }

  const hasilOkRows = hasilRows.filter(
    (row) => hasMeaningfulHasilValue(row['deskripsi']) || hasMeaningfulHasilValue(row['hasil']),
  );
  const hasPdf = pdfIsPdf(args.pdfInfo);
  const hasResult =
    hasPdf &&
    !pdfHasError &&
    (hasilOkRows.length > 0 || berkasRows.length > 0 || studyUids.length > 0);
  const status: 'ok' | 'warn' = hasResult && approveFlag ? 'ok' : 'warn';

  const issues: string[] = [];
  if (hasilOkRows.length === 0 && berkasRows.length === 0 && studyUids.length === 0) {
    issues.push('hasil/berkas/studyuid kosong');
  }
  if (pdfHasError) issues.push('pdf hasil error');
  if (!approveFlag) issues.push(`approve=${approve}`);

  const summary =
    `Radiologi ${noTransaksiRad} | detail=${detailRows.length} | ` +
    `hasil_ok=${hasilOkRows.length}/${hasilRows.length} | berkas=${berkasRows.length} | ` +
    `studyuid=${studyUids.length} | pdf=${yaTidak(hasPdf)} | ` +
    `pdf_error=${yaTidak(pdfHasError)} | approve=${approve}`;

  return buildValidation({
    modality: 'Radiologi',
    noTransaksi: noTransaksiRad,
    status,
    hasResult,
    approve,
    issues,
    summary,
    details: [
      detail('Trx', noTransaksiRad),
      detail('Detail', detailRows.length),
      detail('Hasil ok', `${hasilOkRows.length}/${hasilRows.length}`),
      detail('Berkas', berkasRows.length),
      detail('Studyuid', studyUids.length),
      detail('Pdf', yaTidak(hasPdf)),
      detail('Pdf error', yaTidak(pdfHasError)),
      detail('Pdf size', args.pdfInfo?.['size'] ?? 0),
      detail('Approve', approve),
    ],
  });
}

// ── Elektromedik ─────────────────────────────────────────────────

/** `elektromedik/hasil_pemeriksaan/getHasilPemeriksaan` cache key. */
export function elektromedikDetailKey(kdTindakan: unknown, kdItemPemeriksaan: unknown): string {
  return `${text(kdTindakan)}|${text(kdItemPemeriksaan)}`;
}

/** Named arguments for {@link validateHasilElektromedik}. */
export interface ValidateHasilElektromedikArgs {
  noTransaksiElm: string;
  /** `elektromedik/registrasi_pemeriksaan/get_listtindakan` payload. */
  detailRows?: unknown;
  /** `elektromedik/hasil_pemeriksaan/getListHasilPemeriksaan` payload. */
  hasilRows?: unknown;
  /** `cek_statusbayar` — audit detail only; the Python never branches on it. */
  statusBayar?: boolean;
  /** `cetakHasilPemeriksaan`, through `_build_pdf_info`. */
  pdfInfo?: PenunjangPdfInfo;
  /**
   * `getHasilPemeriksaan` HTML per accepted hasil row, keyed by
   * {@link elektromedikDetailKey}`(kd_tindakan, kd_item_pemeriksaan)`. Run this
   * validator once with the map empty to learn which rows are accepted, then
   * again with their HTML.
   */
  detailHtmlByItem?: Readonly<Record<string, unknown>>;
}

/**
 * `validate_hasil_elektromedik` — an electromedical order needs tindakan lines,
 * at least one hasil row that is either flagged (`hasil === '1'`) or carries a
 * narrative, and an error-free result PDF that is *bound to this transaction*:
 * either the PDF text mentions the transaction number or at least one per-item
 * detail HTML holds a filled narrative textarea. A PDF that renders for the
 * wrong patient is the failure this last rule catches.
 *
 * The approval state is scraped from the per-item HTML: the approved marker wins
 * outright, a filled narrative with no marker means "not yet approved", and no
 * usable HTML at all leaves it `'unknown'`.
 */
export function validateHasilElektromedik(
  args: ValidateHasilElektromedikArgs,
): PenunjangValidation {
  const noTransaksiElm = text(args.noTransaksiElm);
  const detailRows = rowsFromPayload(args.detailRows);
  const hasilRows = rowsFromPayload(args.hasilRows);

  const pdfBody = pdfText(args.pdfInfo);
  const pdfUpper = pdfBody.toUpperCase();
  const pdfHasError = ELEKTROMEDIK_PDF_ERROR_MARKERS.some((marker) => pdfUpper.includes(marker));
  // Faithful quirk: an empty transaction number is "in" every text, so a blank
  // trx trivially satisfies the binding rule — exactly as in the Python.
  const pdfHasTrx = pdfBody.includes(noTransaksiElm);

  const hasilOkRows: LegacyRow[] = [];
  let detailHasilCount = 0;
  let approve: PenunjangApproveState = 'unknown';
  for (const row of hasilRows) {
    const hasilFlag = str(row, 'hasil');
    const deskripsi = stripHtmlText(row['deskripsi']);
    if (hasilFlag !== '1' && !deskripsi) continue;
    hasilOkRows.push(row);
    const key = elektromedikDetailKey(row['kd_tindakan'], row['kd_item_pemeriksaan']);
    const detailHtmlValue = args.detailHtmlByItem?.[key];
    const detailHtml = detailHtmlValue === undefined || detailHtmlValue === null
      ? ''
      : String(detailHtmlValue);
    const detailHasil = extractTextareaText(detailHtml, ELEKTROMEDIK_HASIL_TEXTAREA_ID);
    if (detailHasil) detailHasilCount += 1;
    if (detailHtml.toUpperCase().includes(ELEKTROMEDIK_APPROVED_MARKER)) {
      approve = '1';
    } else if (approve === 'unknown' && detailHasil) {
      approve = '0';
    }
  }

  const hasPdf = pdfIsPdf(args.pdfInfo);
  let hasResult = detailRows.length > 0 && hasilOkRows.length > 0 && hasPdf && !pdfHasError;
  if (hasResult && !(pdfHasTrx || detailHasilCount > 0)) hasResult = false;
  const status: 'ok' | 'warn' = hasResult ? 'ok' : 'warn';

  const issues: string[] = [];
  if (detailRows.length === 0) issues.push('detail tindakan kosong');
  if (hasilOkRows.length === 0) issues.push(`hasil_ok=0/${hasilRows.length}`);
  if (!hasPdf) issues.push('pdf hasil tidak ada');
  if (pdfHasError) issues.push('pdf hasil error');
  if (!pdfHasTrx && detailHasilCount === 0) {
    issues.push('detail hasil/pdf belum mengikat transaksi');
  }
  if (approve === '0' || approve === 'unknown') issues.push(`approve=${approve}`);

  const summary =
    `Elektromedik ${noTransaksiElm} | detail=${detailRows.length} | ` +
    `hasil_ok=${hasilOkRows.length}/${hasilRows.length} | detail_hasil=${detailHasilCount} | ` +
    `pdf=${yaTidak(hasPdf)} | pdf_error=${yaTidak(pdfHasError)} | ` +
    `pdf_match_trx=${yaTidak(pdfHasTrx)} | approve=${approve}`;

  return buildValidation({
    modality: 'Elektromedik',
    noTransaksi: noTransaksiElm,
    status,
    hasResult,
    approve,
    issues,
    summary,
    details: [
      detail('Trx', noTransaksiElm),
      detail('Detail', detailRows.length),
      detail('Hasil ok', `${hasilOkRows.length}/${hasilRows.length}`),
      detail('Detail hasil', detailHasilCount),
      detail('Status bayar', args.statusBayar ? '1' : '0'),
      detail('Pdf', yaTidak(hasPdf)),
      detail('Pdf error', yaTidak(pdfHasError)),
      detail('Pdf match trx', yaTidak(pdfHasTrx)),
      detail('Pdf size', args.pdfInfo?.['size'] ?? 0),
      detail('Approve', approve),
    ],
  });
}

// ── the alert ────────────────────────────────────────────────────

/**
 * `_register_penunjang_validation_alert`, as a pure function: the WARN alert the
 * legacy code would have pushed into `_REG_ALERTS_BY_REG`, or `null` when the
 * result needs no alert.
 *
 * Faithful details worth knowing:
 *  - nothing is raised when `status === 'ok'` **and** `approve` is neither `'0'`
 *    nor `'unknown'`. Because PA always reports `'unknown'`, every PA result
 *    produces an alert.
 *  - the validator's own `issues` win. Only when it produced none does this
 *    synthesise one ("data hasil tidak ada" / "hasil belum lengkap/tidak ada",
 *    plus `approve=…` for Lab PK, Radiologi and Elektromedik).
 *  - the level is always WARN, even for a completely missing result.
 *  - an empty `reg` yields `null`: `_register_reg_alert` drops those, so no
 *    alert would have been recorded.
 */
export function buildPenunjangValidationAlert(
  reg: string,
  result: PenunjangValidation | null | undefined,
): PenunjangValidationAlert | null {
  if (!result || typeof result !== 'object') return null;
  const regText = text(reg);
  if (!regText) return null;

  const modality = text(result.modality) || 'Penunjang';
  const trx = text(result.noTransaksi) || '-';
  const status = text(result.status).toLowerCase();
  const approve = text(result.approve).toLowerCase();
  const hasResult = Boolean(result.hasResult);
  const noData = Boolean(result.noData);
  const summary = text(result.summary);
  const issues = (result.issues ?? []).map((item) => text(item)).filter(Boolean);

  if (status === 'ok' && approve !== '0' && approve !== 'unknown') return null;

  if (issues.length === 0) {
    if (status !== 'ok') {
      if (noData) issues.push('data hasil tidak ada');
      else if (!hasResult) issues.push('hasil belum lengkap/tidak ada');
    }
    if ((approve === '0' || approve === 'unknown') && APPROVE_REPORTING_MODULES.includes(modality)) {
      issues.push(`approve=${approve}`);
    }
  }

  let message = summary || `${modality} ${trx}`;
  if (issues.length > 0) message = `${message} | issue=${issues.join('; ')}`;
  return { reg: regText, level: 'WARN', message };
}

// ── the group orchestration ──────────────────────────────────────

/** The four modalities `validate_penunjang_results_for_group` walks. */
export type PenunjangModality = 'Lab PK' | 'PA' | 'Radiologi' | 'Elektromedik';

/** One transaction to validate, with everything the fetch needs. */
export interface PenunjangCandidate {
  modality: PenunjangModality;
  noTransaksi: string;
  /** PA only: `kd_jenis_pemeriksaan`, defaulted to `'1'` as in the Python. */
  kdJenisPemeriksaan?: string;
  /** The history / direct row the candidate came from, for the audit trail. */
  row?: LegacyRow;
}

/** {@link collectPenunjangValidationCandidates} output. */
export interface PenunjangCandidates {
  /** `room_rows[0].no_registrasikunjungan` — the group the alerts are filed under. */
  reg: string;
  labPk: PenunjangCandidate[];
  pa: PenunjangCandidate[];
  radiologi: PenunjangCandidate[];
  elektromedik: PenunjangCandidate[];
  /** Every candidate in the Python's validation order: Lab PK, PA, Radiologi, Elektromedik. */
  all: PenunjangCandidate[];
}

/** Named arguments for {@link collectPenunjangValidationCandidates}. */
export interface CollectPenunjangValidationCandidatesArgs {
  /** The room rows of the group; `[0]` supplies the registration. */
  roomRows: readonly LegacyRow[];
  /**
   * `_collect_related_lab_pk` rows — `gethistorykunjungan` filtered to the poli
   * source transaction. `[]` (or omitted) when there is no poli source, which is
   * the Python's `if poli_source else []`. Each row's `no_transaksi_lab` is the
   * candidate.
   */
  relatedLabPk?: readonly LegacyRow[];
  /** {@link collectDirectHasilRowsForGroup} over the lab `getdatakunjungan`. */
  directLabRows?: readonly LegacyRow[];
  /** {@link collectPenunjangHistories} output; only `pa` and `rad` are read. */
  penunjangHistories?: Partial<PenunjangHistories> | null;
  /** {@link collectDirectHasilRowsForGroup} over the radiology `getdatakunjungan`. */
  directRadRows?: readonly LegacyRow[];
  /** The elektromedik history rows already narrowed to this stay. */
  elektromedikHistory?: readonly LegacyRow[];
}

/**
 * The candidate-selection half of `validate_penunjang_results_for_group`.
 *
 * Split out so an executor can learn what to fetch before fetching it. Ordering
 * and de-duplication are the Python's: Lab PK takes the poli-related orders
 * first then the direct hasil rows, Radiologi takes the order history first then
 * the direct hasil rows, PA takes the order history only, and each modality
 * de-duplicates on its own transaction number.
 */
export function collectPenunjangValidationCandidates(
  args: CollectPenunjangValidationCandidatesArgs,
): PenunjangCandidates {
  const roomRows = args.roomRows ?? [];
  const reg = str(roomRows[0], 'no_registrasikunjungan');

  const labPk = dedupeCandidates('Lab PK', [
    ...(args.relatedLabPk ?? []).map((row) => ({ row, key: 'no_transaksi_lab' })),
    ...(args.directLabRows ?? []).map((row) => ({ row, key: 'no_transaksi' })),
  ]);
  const pa = dedupeCandidates(
    'PA',
    (args.penunjangHistories?.pa ?? []).map((row) => ({ row, key: 'no_transaksi' })),
  ).map((candidate) => ({
    ...candidate,
    kdJenisPemeriksaan: str(candidate.row, 'kd_jenis_pemeriksaan') || '1',
  }));
  const radiologi = dedupeCandidates('Radiologi', [
    ...(args.penunjangHistories?.rad ?? []).map((row) => ({ row, key: 'no_transaksi' })),
    ...(args.directRadRows ?? []).map((row) => ({ row, key: 'no_transaksi' })),
  ]);
  const elektromedik = dedupeCandidates(
    'Elektromedik',
    (args.elektromedikHistory ?? []).map((row) => ({ row, key: 'no_transaksi' })),
  );

  return {
    reg,
    labPk,
    pa,
    radiologi,
    elektromedik,
    all: [...labPk, ...pa, ...radiologi, ...elektromedik],
  };
}

/** Named arguments for {@link validatePenunjangResultsForGroup}. */
export interface ValidatePenunjangResultsForGroupArgs
  extends CollectPenunjangValidationCandidatesArgs {
  /**
   * The hoisted per-modality validation: given a candidate, return its
   * {@link PenunjangValidation}. In production this wraps the fetches listed in
   * the module header plus the matching `validateHasil*` call; in tests it is a
   * lookup. Call {@link collectPenunjangValidationCandidates} first if the
   * fetches must be batched before this runs.
   */
  validate: (candidate: PenunjangCandidate) => PenunjangValidation;
}

/** {@link validatePenunjangResultsForGroup} output. */
export interface PenunjangGroupValidation {
  /** `'skip'` when there was nothing to validate, else `'warn'`/`'ok'`. */
  status: 'skip' | 'ok' | 'warn';
  reg: string;
  /** What was validated, in candidate order. */
  candidates: PenunjangCandidate[];
  /** One result per candidate, in the same order. */
  results: PenunjangValidation[];
  /** The `warn_results` subset — every result the operator must look at. */
  needsAttention: PenunjangValidation[];
  /** The WARN alerts to register; empty when `reg` is blank. */
  alerts: PenunjangValidationAlert[];
  counts: { labPk: number; pa: number; radiologi: number; elektromedik: number };
  /** The operator-facing block the Python printed, as data. */
  lines: string[];
}

/**
 * `validate_penunjang_results_for_group` — the decision core: pick the group's
 * penunjang transactions, validate each, and roll the results up into one
 * verdict plus the alerts to raise.
 *
 * `'skip'` means the group had no penunjang transaction at all. Otherwise the
 * verdict is `'warn'` as soon as any result needs attention, which — because PA
 * never reports an approval — is guaranteed whenever the group has a PA order.
 */
export function validatePenunjangResultsForGroup(
  args: ValidatePenunjangResultsForGroupArgs,
): PenunjangGroupValidation {
  const candidates = collectPenunjangValidationCandidates(args);
  const counts = {
    labPk: candidates.labPk.length,
    pa: candidates.pa.length,
    radiologi: candidates.radiologi.length,
    elektromedik: candidates.elektromedik.length,
  };
  const lines = [
    '+ Data:',
    `   - Lab PK       : ${counts.labPk} transaksi`,
    `   - PA           : ${counts.pa} transaksi`,
    `   - Radiologi    : ${counts.radiologi} transaksi`,
    `   - Elektromedik : ${counts.elektromedik} transaksi`,
  ];

  const results: PenunjangValidation[] = [];
  const alerts: PenunjangValidationAlert[] = [];
  for (const candidate of candidates.all) {
    const result = args.validate(candidate);
    results.push(result);
    const alert = buildPenunjangValidationAlert(candidates.reg, result);
    if (alert) alerts.push(alert);
  }

  lines.push('+ Status:');
  if (results.length === 0) {
    lines.push('   - Hasil        : tidak ada transaksi penunjang yang perlu divalidasi');
    return {
      status: 'skip',
      reg: candidates.reg,
      candidates: candidates.all,
      results,
      needsAttention: [],
      alerts,
      counts,
      lines,
    };
  }

  const needsAttention = results.filter((result) => result.needsAttention);
  lines.push(
    needsAttention.length > 0
      ? `   - Hasil        : ditemukan ${needsAttention.length} transaksi penunjang yang perlu perhatian`
      : '   - Hasil        : semua hasil penunjang yang terkait sudah sesuai',
  );

  return {
    status: needsAttention.length > 0 ? 'warn' : 'ok',
    reg: candidates.reg,
    candidates: candidates.all,
    results,
    needsAttention,
    alerts,
    counts,
    lines,
  };
}

// ── internals ────────────────────────────────────────────────────

/**
 * `"1" if approve_flag else ("0" if isinstance(hasil_data, dict) and hasil_data
 * else "unknown")` — an unapproved result is only reported as a definite `'0'`
 * when the endpoint actually answered with data.
 */
function approveState(approveFlag: boolean, hasilData: unknown): PenunjangApproveState {
  if (approveFlag) return '1';
  return isNonEmptyRecord(hasilData) ? '0' : 'unknown';
}

/** Assemble the shared result, deriving the fields every validator shares. */
function buildValidation(parts: {
  modality: string;
  noTransaksi: string;
  status: 'ok' | 'warn';
  hasResult: boolean;
  approve: PenunjangApproveState;
  issues: string[];
  summary: string;
  details: PenunjangValidationDetail[];
  severity?: 'info' | 'warn' | 'error';
}): PenunjangValidation {
  const needsAttention =
    parts.status !== 'ok' || parts.approve === '0' || parts.approve === 'unknown';
  const reason = parts.issues.length > 0
    ? parts.issues.join('; ')
    : needsAttention
      ? 'perlu cek manual'
      : '';
  return {
    ok: parts.status === 'ok',
    modality: parts.modality,
    noTransaksi: parts.noTransaksi,
    status: parts.status,
    needsAttention,
    hasResult: parts.hasResult,
    approve: parts.approve,
    reason,
    issues: parts.issues,
    summary: parts.summary,
    severity: parts.severity ?? (needsAttention ? 'warn' : 'info'),
    details: parts.details,
  };
}

/** `strftime("%Y-%m-%d")` on `ref ± days`, calendar-safe. */
function shiftDateText(ref: Date, days: number): string {
  const shifted = new Date(ref.getTime());
  shifted.setDate(shifted.getDate() + days);
  const year = String(shifted.getFullYear()).padStart(4, '0');
  const month = String(shifted.getMonth() + 1).padStart(2, '0');
  const day = String(shifted.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** One `seen`-guarded pass over rows, reading the transaction from `key`. */
function dedupeCandidates(
  modality: PenunjangModality,
  entries: ReadonlyArray<{ row: LegacyRow; key: string }>,
): PenunjangCandidate[] {
  const out: PenunjangCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const noTransaksi = str(entry.row, entry.key);
    if (!noTransaksi || seen.has(noTransaksi)) continue;
    seen.add(noTransaksi);
    out.push({ modality, noTransaksi, row: entry.row });
  }
  return out;
}
