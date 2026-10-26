/**
 * IBS (bedah sentral / operating-theatre) consistency checks ported from
 * `ranap_v3.py`.
 *
 * Two things must agree before a surgical stay may be verified:
 *
 *  1. the pharmacy side and the billing side. A `DEPO IBS` line in the
 *     rekapitulasi means drugs were dispensed for surgery, and a `BIAYA … IBS` /
 *     `BEDAH SENTRAL` / `BIAYA … CATHLAB` charge means the surgery itself was
 *     billed. One without the other is a mismatch, and a mismatch blocks
 *     verification (`validate_ibs_consistency`).
 *  2. the OK order history must not be littered with orders that were created
 *     and never attached to a transaction (`_cleanup_dangling_order_ok`).
 *
 * Only the decisions are ported. Every remote read is a parameter, and the
 * cleanup half returns the rows that *would* be cleaned plus the reason for each
 * — it issues no deletes.
 *
 * Hoisted fetches (endpoint → parameter):
 *  - `poliklinik/rekapitulasi/rekapitulasi_detail_hak_html`
 *    (`fetch_rekapitulasi_detail_hak_html`) → `rekapitulasiHtml`
 *  - `poliklinik/penatajasa_inap/get_listtindakan` (`ambil_listtindakan`, once per
 *    room row) → `listTindakanRows`, the concatenation of those calls' rows
 *  - `poliklinik/penatajasa_inap/gethistoryiok` (`gethistoryiok`) → `okHistoryRows`
 *  - `poliklinik/penatajasa_inap/get_listtindakan_ok` → `listTindakanOkByOrder`
 *  - `poliklinik/penatajasa_inap/cekok_terlayani` → `statusTerlayaniByOrder`
 *  - `poliklinik/penatajasa_inap/cekok_kirim` → `statusKirimByOrder`
 *
 * The three per-order maps are keyed by `no_order`. The room transaction each
 * `get_listtindakan_ok` call needs is derived here from
 * `pickRoomRowForDate`, so run {@link findDanglingOrderOkCandidates} once with
 * the maps omitted to learn the `(noOrder, roomNoTransaksi)` pairs, fetch, then
 * run it again with them.
 *
 * The writes `_cleanup_dangling_order_ok` performs — `batal_kirim_ok` and
 * `hapus_order_ok` — appear only as planned {@link DanglingOrderOkAction}s.
 */

import type { AlertLevel } from './alerts.js';
import { datePart } from './dates.js';
import { isBiayaIbsName, isDanglingOkHistoryRow } from './names.js';
import type { PenunjangValidation } from './penunjangResults.js';
import type { DateRange } from './rooms.js';
import { getRoomRowsDateBounds, pickRoomRowForDate } from './rooms.js';
import { normalizeTextKey } from './scalars.js';
import type { LegacyRow } from './types.js';
import { str } from './types.js';

/** `re.search(r"DEPO\s+IBS", html, re.I)` — the rekapitulasi's pharmacy marker. */
const DEPO_IBS_HTML_PATTERN = /DEPO\s+IBS/i;

/**
 * The ward whose IBS mismatches are downgraded to a manual review instead of a
 * hard error: AL AFIYAT bills its surgeries through a separate flow.
 */
export const IBS_MANUAL_REVIEW_ROOM_TOKEN = 'AL AFIYAT';

/** `cekok_terlayani` / `cekok_kirim` values that mean "not yet". */
const OK_STATUS_CLEAR_VALUES: readonly string[] = ['0', '', 'DRY_RUN'];

/** Python's `str(value or "").strip()`. */
function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

// ── the mismatch check ───────────────────────────────────────────

/** A `_register_reg_alert` (and possibly `_register_verification_blocker`) call. */
export interface IbsAlert {
  reg: string;
  level: AlertLevel;
  message: string;
  /**
   * True when the legacy code also called `_register_verification_blocker` with
   * the same detail, i.e. the alert blocks verification outright.
   */
  blocking: boolean;
}

/** {@link detectIbsBedahContext} output. */
export interface IbsBedahContext {
  /** `room_rows[0].no_registrasikunjungan`. */
  reg: string;
  /** A `DEPO IBS` line appears in the rekapitulasi HTML. */
  hasDepoIbs: boolean;
  /** A surgical charge appears in the group's tindakan lines. */
  hasBiayaIbs: boolean;
  /**
   * `has_depo_ibs or has_biaya_ibs` — the group really did go to theatre, which
   * is what makes a dangling OK order safe to clean up.
   */
  hasBedahContext: boolean;
  /** Any room of the group is AL AFIYAT, which softens a mismatch to a WARN. */
  isAlAfiyatCase: boolean;
}

/** Named arguments for {@link detectIbsBedahContext} and {@link validateIbsConsistency}. */
export interface IbsConsistencyArgs {
  /** The room rows of the group; `[0]` supplies the registration. */
  roomRows: readonly LegacyRow[];
  /** `fetch_rekapitulasi_detail_hak_html` output; `''` when it could not be built. */
  rekapitulasiHtml?: string;
  /** `ambil_listtindakan` rows for every room row of the group, concatenated. */
  listTindakanRows?: readonly LegacyRow[];
  /** Operator override from the Rules page; absent keeps {@link IBS_MANUAL_REVIEW_ROOM_TOKEN}. */
  manualReviewRooms?: readonly string[];
}

/**
 * The two flags `validate_ibs_consistency` derives before it decides anything,
 * split out because {@link findDanglingOrderOkCandidates} needs
 * `hasBedahContext` and the caller would otherwise have to recompute it.
 */
export function detectIbsBedahContext(args: IbsConsistencyArgs): IbsBedahContext {
  const roomRows = args.roomRows ?? [];
  const reviewRooms = (args.manualReviewRooms ?? [IBS_MANUAL_REVIEW_ROOM_TOKEN])
    .map((room) => normalizeTextKey(room))
    .filter((room) => room.length > 0);
  const hasDepoIbs = DEPO_IBS_HTML_PATTERN.test(args.rekapitulasiHtml ?? '');
  const hasBiayaIbs = (args.listTindakanRows ?? []).some((item) =>
    isBiayaIbsName(item['nama_tindakan']),
  );
  return {
    reg: str(roomRows[0], 'no_registrasikunjungan'),
    hasDepoIbs,
    hasBiayaIbs,
    hasBedahContext: hasDepoIbs || hasBiayaIbs,
    isAlAfiyatCase: roomRows.some((row) => {
      const unit = normalizeTextKey(row['nama_unit']);
      return reviewRooms.some((room) => unit.includes(room));
    }),
  };
}

/**
 * `validate_ibs_consistency` — the pharmacy and billing sides of a surgical stay
 * must both be present or both be absent.
 *
 * Returns the shared {@link PenunjangValidation} shape with `modality: 'IBS'`.
 * Because IBS validates a whole registration rather than one order,
 * `noTransaksi` carries the `no_registrasikunjungan`, and `approve` is `'n/a'`
 * (there is no approval step to report).
 *
 * A mismatch is an ERROR that blocks verification, except in AL AFIYAT wards
 * where a dispensed-but-unbilled surgery is normal enough to be a WARN — it
 * still blocks, it is just not treated as a defect. `severity` carries that
 * distinction; see {@link buildIbsConsistencyAlert} for the alert itself.
 *
 * The Python also runs the dangling-OK cleanup from inside this function; here
 * that is {@link findDanglingOrderOkCandidates}, driven by the caller with
 * `hasBedahContext` from {@link detectIbsBedahContext}.
 */
export function validateIbsConsistency(args: IbsConsistencyArgs): PenunjangValidation {
  const context = detectIbsBedahContext(args);
  const { reg, hasDepoIbs, hasBiayaIbs, isAlAfiyatCase } = context;

  const depoLabel = hasDepoIbs ? 'ada' : 'tidak ada';
  const biayaLabel = hasBiayaIbs ? 'ada' : 'tidak ada';
  const summary = `IBS ${reg || '-'} | depo_ibs=${depoLabel} | biaya_ibs=${biayaLabel}`;
  const details = [
    { label: 'Reg', value: reg || '-' },
    { label: 'Depo ibs', value: depoLabel },
    { label: 'Biaya ibs', value: biayaLabel },
    { label: 'Al afiyat', value: isAlAfiyatCase ? 'ya' : 'tidak' },
  ];

  let reason = '';
  let severity: PenunjangValidation['severity'] = 'info';
  if (hasDepoIbs && !hasBiayaIbs) {
    reason = isAlAfiyatCase
      ? 'IBS mismatch | depo_ibs=ada | biaya_ibs=tidak ada | ruang AL AFIYAT perlu cek manual'
      : 'IBS mismatch | depo_ibs=ada | biaya_ibs=tidak ada';
    severity = isAlAfiyatCase ? 'warn' : 'error';
  } else if (hasBiayaIbs && !hasDepoIbs) {
    reason = 'IBS mismatch | depo_ibs=tidak ada | biaya_ibs=ada';
    severity = 'error';
  }

  const ok = reason === '';
  return {
    ok,
    modality: 'IBS',
    noTransaksi: reg,
    status: ok ? 'ok' : 'warn',
    needsAttention: !ok,
    hasResult: ok,
    approve: 'n/a',
    reason,
    issues: ok ? [] : [reason],
    summary,
    severity,
    details,
  };
}

/**
 * The two registry calls `validate_ibs_consistency` makes on a mismatch, as
 * data: `_register_reg_alert(reg, level, detail)` **and**
 * `_register_verification_blocker(reg, detail)` with the same detail. `null`
 * when the group is consistent (or has no registration, which
 * `_register_reg_alert` would have dropped).
 */
export function buildIbsConsistencyAlert(
  validation: PenunjangValidation | null | undefined,
): IbsAlert | null {
  if (!validation || validation.ok) return null;
  const reg = text(validation.noTransaksi);
  if (!reg) return null;
  return {
    reg,
    level: validation.severity === 'error' ? 'ERROR' : 'WARN',
    message: validation.reason,
    blocking: true,
  };
}

// ── dangling OK orders ───────────────────────────────────────────

/** The writes `_cleanup_dangling_order_ok` would issue, in order. */
export type DanglingOrderOkAction = 'batalKirim' | 'hapusOrder';

/** What the cleanup decided about one dangling OK order. */
export interface DanglingOrderOkCandidate {
  /** `no_order` — the OK order with no transaction behind it. */
  noOrder: string;
  /** `_date_part(tgl_order or tgl_transaksi)` — the day the order belongs to. */
  orderDate: string;
  /** `_pick_room_row_for_date(...).no_transaksi`; `''` when no stay owns the date. */
  roomNoTransaksi: string;
  /** `cekok_kirim` — `'1'` means the order was already sent to theatre. */
  statusKirim: string;
  /** `cekok_terlayani` — anything but `'0'`/`''` means it was already served. */
  statusTerlayani: string;
  /** `get_listtindakan_ok` row count for the order. */
  detailCount: number;
  /**
   * `'cleanup'` — the order qualifies for deletion; `'manual'` — a human must
   * look at it and nothing is deleted.
   */
  verdict: 'cleanup' | 'manual';
  /** Why, in the wording the legacy log used. */
  reason: string;
  /** The writes to issue, in order. Empty for a `'manual'` verdict. */
  actions: DanglingOrderOkAction[];
  /** The history row itself, for the audit trail. */
  row: LegacyRow;
}

/** {@link findDanglingOrderOkCandidates} output. */
export interface DanglingOrderOkPlan {
  /** `room_rows[0].no_registrasikunjungan`. */
  reg: string;
  /** `_get_room_rows_date_bounds` — the repaired span used to filter the history. */
  dateRange: DateRange;
  /** OK history rows inside the span that have no transaction behind them. */
  danglingRows: LegacyRow[];
  /** At least one in-range OK row *does* have a transaction, so OK is live. */
  hasUsedOkRows: boolean;
  /** `has_depo_ibs or has_biaya_ibs`, as supplied. */
  hasBedahContext: boolean;
  /**
   * True when the whole group is punted to a human without inspecting any order:
   * there is no surgical context *and* no active OK order, so the dangling rows
   * may belong to something this run knows nothing about.
   */
  requiresManualReview: boolean;
  /** Per-order decisions, in history order. Empty when `requiresManualReview`. */
  candidates: DanglingOrderOkCandidate[];
  /** The WARN alerts the legacy code would have registered. */
  alerts: IbsAlert[];
}

/** Named arguments for {@link findDanglingOrderOkCandidates}. */
export interface FindDanglingOrderOkCandidatesArgs {
  /** The room rows of the group; they bound the history and own the order dates. */
  roomRows: readonly LegacyRow[];
  /** `gethistoryiok` rows for the patient. */
  okHistoryRows?: readonly LegacyRow[];
  /** `hasBedahContext` from {@link detectIbsBedahContext}. */
  hasBedahContext?: boolean;
  /** `get_listtindakan_ok` payloads keyed by `no_order` (array or `{rows}`). */
  listTindakanOkByOrder?: Readonly<Record<string, unknown>>;
  /** `cekok_terlayani` response text keyed by `no_order`. */
  statusTerlayaniByOrder?: Readonly<Record<string, unknown>>;
  /** `cekok_kirim` response text keyed by `no_order`. */
  statusKirimByOrder?: Readonly<Record<string, unknown>>;
}

/**
 * The decision half of `_cleanup_dangling_order_ok` — which OK orders with no
 * transaction behind them qualify for deletion, and why.
 *
 * The gate, in the Python's order:
 *  1. OK history rows are filtered to the group's repaired date bounds. Rows
 *     with no date survive the filter.
 *  2. Nothing dangling → an empty plan.
 *  3. No surgical context **and** no in-range OK row that does have a
 *     transaction → the whole group goes to manual review, untouched. This is
 *     the guard that stops the cleanup from deleting another admission's orders.
 *  4. Per dangling order: it needs a room stay for its date, at least one OK
 *     tindakan line, and a `cekok_terlayani` that is still clear. A `'1'` from
 *     `cekok_kirim` adds a `batalKirim` before the `hapusOrder`.
 *
 * The plan follows the Python's `DRY_RUN` branch for step 4's re-read: after
 * `batal_kirim_ok` the send flag is assumed cleared, so `hapusOrder` is planned.
 * A live executor must re-read `cekok_kirim` after the cancel and abort if it is
 * still `'1'` — that is the `status_kirim not in ("0", "", "DRY_RUN")` guard,
 * which cannot be evaluated ahead of the write.
 */
export function findDanglingOrderOkCandidates(
  args: FindDanglingOrderOkCandidatesArgs,
): DanglingOrderOkPlan {
  const roomRows = args.roomRows ?? [];
  const reg = str(roomRows[0], 'no_registrasikunjungan');
  const dateRange = getRoomRowsDateBounds(roomRows);
  const hasBedahContext = Boolean(args.hasBedahContext);

  const filteredOkRows: LegacyRow[] = [];
  for (const row of args.okHistoryRows ?? []) {
    const rowDate = datePart(str(row, 'tgl_transaksi', 'tgl_order'));
    // A row with no readable date is kept: the Python's `and row_date` guard
    // makes both bounds inapplicable.
    if (dateRange.start && rowDate && rowDate < dateRange.start) continue;
    if (dateRange.end && rowDate && rowDate > dateRange.end) continue;
    filteredOkRows.push(row);
  }

  const hasUsedOkRows = filteredOkRows.some((row) => Boolean(str(row, 'no_transaksi')));
  const danglingRows = filteredOkRows.filter((row) => isDanglingOkHistoryRow(row));

  const plan: DanglingOrderOkPlan = {
    reg,
    dateRange,
    danglingRows,
    hasUsedOkRows,
    hasBedahContext,
    requiresManualReview: false,
    candidates: [],
    alerts: [],
  };

  if (danglingRows.length === 0) return plan;

  if (!hasBedahContext && !hasUsedOkRows) {
    plan.requiresManualReview = true;
    plan.alerts.push(
      regAlert(
        reg,
        'Order OK menggantung perlu cek manual | tidak ada konteks bedah sentral/OK aktif',
      ),
    );
    return plan;
  }

  for (const row of danglingRows) {
    const noOrder = str(row, 'no_order');
    const orderLabel = noOrder || '-';
    const orderDate = datePart(str(row, 'tgl_order', 'tgl_transaksi'));
    const roomRow = pickRoomRowForDate(roomRows, orderDate);
    const roomNoTransaksi = str(roomRow, 'no_transaksi');
    const detailCount = roomNoTransaksi
      ? okListRowCount(args.listTindakanOkByOrder?.[noOrder])
      : 0;
    const statusTerlayani = text(args.statusTerlayaniByOrder?.[noOrder]);
    const statusKirim = text(args.statusKirimByOrder?.[noOrder]);

    const base = {
      noOrder,
      orderDate,
      roomNoTransaksi,
      statusKirim,
      statusTerlayani,
      detailCount,
      row,
    };

    if (!roomNoTransaksi) {
      plan.candidates.push({
        ...base,
        verdict: 'manual',
        reason: 'transaksi rawat inap untuk tanggal order tidak ditemukan',
        actions: [],
      });
      plan.alerts.push(
        regAlert(
          reg,
          `Order OK menggantung perlu cek manual | no_order=${orderLabel} | transaksi rawat inap tidak ditemukan`,
        ),
      );
      continue;
    }
    if (detailCount === 0) {
      plan.candidates.push({
        ...base,
        verdict: 'manual',
        reason: 'detail tindakan OK kosong',
        actions: [],
      });
      plan.alerts.push(
        regAlert(
          reg,
          `Order OK menggantung perlu cek manual | no_order=${orderLabel} | detail tindakan OK kosong`,
        ),
      );
      continue;
    }
    if (!OK_STATUS_CLEAR_VALUES.includes(statusTerlayani)) {
      plan.candidates.push({
        ...base,
        verdict: 'manual',
        reason: `status terlayani=${statusTerlayani}`,
        actions: [],
      });
      plan.alerts.push(
        regAlert(
          reg,
          `Skip hapus order OK menggantung | no_order=${orderLabel} | status terlayani=${statusTerlayani}`,
        ),
      );
      continue;
    }

    const actions: DanglingOrderOkAction[] = [];
    if (statusKirim === '1') actions.push('batalKirim');
    if (!actions.includes('batalKirim') && !OK_STATUS_CLEAR_VALUES.includes(statusKirim)) {
      // Sent under some other flag value: the cancel does not apply and the
      // delete is refused.
      plan.candidates.push({
        ...base,
        verdict: 'manual',
        reason: `status kirim=${statusKirim}`,
        actions: [],
      });
      plan.alerts.push(
        regAlert(
          reg,
          `Skip hapus order OK menggantung | no_order=${orderLabel} | status kirim=${statusKirim}`,
        ),
      );
      continue;
    }
    actions.push('hapusOrder');
    plan.candidates.push({
      ...base,
      verdict: 'cleanup',
      reason:
        actions.length > 1
          ? 'order OK menggantung, batalkan kirim lalu hapus'
          : 'order OK menggantung, aman dihapus',
      actions,
    });
  }

  return plan;
}

// ── internals ────────────────────────────────────────────────────

function regAlert(reg: string, message: string): IbsAlert {
  return { reg, level: 'WARN', message, blocking: false };
}

/** `list_data.get("rows", []) if isinstance(list_data, dict) else []`. */
function okListRowCount(payload: unknown): number {
  if (Array.isArray(payload)) return payload.length;
  if (typeof payload === 'object' && payload !== null) {
    const rows = (payload as Record<string, unknown>)['rows'];
    if (Array.isArray(rows)) return rows.length;
  }
  return 0;
}
