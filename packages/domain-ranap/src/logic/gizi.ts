/**
 * Order gizi (diet order) sending and recovery, ported from `ranap_v3.py`.
 *
 * A rawat-inap stay cannot be verified while the verifikator still reports an
 * outstanding penunjang transaction, and the most common one is a diet order
 * that was created but never sent — or one that was sent and then left in an
 * error state. The legacy script handles both itself rather than asking the
 * operator: `ensure_ordergizi_terkirim` sends what is sendable, and
 * `recover_ordergizi_error` tears a broken order down detail line by detail line
 * until the blocker clears.
 *
 * This port keeps the decisions and returns them as *plans*. Nothing here writes:
 * `kirim_ordergizi`, `batalkirim_ordergizi` and `hapus_detailordergizi` appear
 * only as {@link GiziAction}s for the caller to execute (and, in preview mode, to
 * surface as a `MutationPlan`).
 *
 * Hoisted fetches (endpoint → parameter):
 *  - `poliklinik/penatajasa_inap/gethistory_ordergizi` (`gethistory_ordergizi`,
 *    once per room stay) → `historyByNoTransaksi`, keyed by the stay's
 *    `no_transaksi`
 *  - `poliklinik/penatajasa_inap/getdatakunjungan` (`ambil_datakunjungan`, the
 *    `kd_unit` fallback for a room row that has none) → `kdUnitByNoTransaksi`
 *  - `poliklinik/penatajasa_inap/getdataordergizi` (`getdataordergizi`) →
 *    `detailByOrder`, keyed by `no_transaksi_ordergizi`
 *  - `poliklinik/penatajasa_inap/cek_order_gizi` (`cek_order_gizi`) →
 *    `cekOrderGiziResponse`
 *  - `poliklinik/penatajasa_inap/cek_jadwal_gizi` (`cek_jadwal_gizi`) →
 *    `jadwalByOrder`, keyed by `no_transaksi_ordergizi`
 *  - `poliklinik/verifikator/cektransaksi_penunjang`
 *    (`cektransaksi_penunjang_verifikator`) → `blockers`, each normalised with
 *    `normalizePenunjangBlocker` from `./blockers.js`
 */

import type { PenunjangBlocker } from './blockers.js';
import { isGiziPenunjangBlocker, penunjangBlockerLabel } from './blockers.js';
import { normalizeRoomStays } from './rooms.js';
import { safeInt, sortedRows } from './scalars.js';
import type { LegacyRow } from './types.js';
import { str } from './types.js';

/** `_recover_gizi_blocker_until_clear(max_attempts=5)`. */
export const GIZI_RECOVERY_MAX_ATTEMPTS = 5;

/** `cek_jadwal_gizi` values that allow a send; anything else defers the order. */
const JADWAL_SEND_ALLOWED_VALUES: readonly string[] = ['', '1'];

/** `status_kirim` value that means a detail line has already gone to the kitchen. */
const STATUS_KIRIM_SENT = 'sudah';

/** Python's `str(value or "").strip()`. */
function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** `detail.get("rows", []) if isinstance(detail, dict) else []`. */
function detailRowsOf(payload: unknown): LegacyRow[] {
  if (Array.isArray(payload)) return payload.filter(isRecordLike);
  if (isRecordLike(payload)) {
    const rows = payload['rows'];
    if (Array.isArray(rows)) return rows.filter(isRecordLike);
  }
  return [];
}

function isRecordLike(value: unknown): value is LegacyRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── candidate collection ─────────────────────────────────────────

/** One diet order attached to a stay — `_collect_ordergizi_transactions_for_group`. */
export interface OrderGiziTransaction {
  /** The order's own transaction number (`18-…`). */
  noTransaksiOrderGizi: string;
  /** The room stay's `no_transaksi` the order was found under. */
  sourceNoTransaksi: string;
  /** That stay's `nama_unit`, for the audit trail. */
  sourceRoom: string;
  /** The order's `tgl_order`, verbatim. */
  tglOrder: string;
}

/** Named arguments for {@link collectOrderGiziTransactionsForGroup}. */
export interface CollectOrderGiziTransactionsForGroupArgs {
  /** The room rows of the group; normalised into stays before iterating. */
  roomRows: readonly LegacyRow[];
  /** `gethistory_ordergizi` payload keyed by the room stay's `no_transaksi`. */
  historyByNoTransaksi?: Readonly<Record<string, unknown>>;
  /**
   * `ambil_datakunjungan(...).kd_unit` keyed by the room stay's `no_transaksi`,
   * used only for a stay whose own row carries no `kd_unit`. A stay with no
   * `kd_unit` from either source is skipped, exactly as in the Python — the
   * history query cannot be built without it.
   */
  kdUnitByNoTransaksi?: Readonly<Record<string, unknown>>;
}

/**
 * `_collect_ordergizi_transactions_for_group` — every distinct diet order the
 * group's stays point at.
 *
 * Stays are walked in `normalizeRoomStays` order and orders are de-duplicated
 * across the whole group, so the first stay that mentions an order owns it.
 */
export function collectOrderGiziTransactionsForGroup(
  args: CollectOrderGiziTransactionsForGroupArgs,
): OrderGiziTransaction[] {
  const hasil: OrderGiziTransaction[] = [];
  const seenOrder = new Set<string>();
  for (const roomRow of normalizeRoomStays(args.roomRows ?? [])) {
    const noTransaksi = str(roomRow, 'no_transaksi');
    if (!noTransaksi) continue;
    const kdUnit =
      str(roomRow, 'kd_unit') || text(args.kdUnitByNoTransaksi?.[noTransaksi]);
    if (!kdUnit) continue;
    for (const row of detailRowsOf(args.historyByNoTransaksi?.[noTransaksi])) {
      const orderTrx = str(row, 'no_transaksi');
      if (!orderTrx || seenOrder.has(orderTrx)) continue;
      seenOrder.add(orderTrx);
      hasil.push({
        noTransaksiOrderGizi: orderTrx,
        sourceNoTransaksi: noTransaksi,
        sourceRoom: str(roomRow, 'nama_unit'),
        tglOrder: str(row, 'tgl_order'),
      });
    }
  }
  return hasil;
}

// ── the shared action shape ──────────────────────────────────────

/** The three writes the legacy gizi flow performs, plus "leave it alone". */
export type GiziActionName = 'kirim' | 'batalKirim' | 'hapusDetail' | 'none';

/**
 * One planned operation on one diet order.
 *
 * `'kirim'` → `poliklinik/penatajasa_inap/kirim_ordergizi`,
 * `'batalKirim'` → `…/batalkirim_ordergizi`,
 * `'hapusDetail'` → `…/hapus_detailordergizi` (needs `urutOrder`),
 * `'none'` → nothing to do; `reason` says why.
 */
export interface GiziAction {
  action: GiziActionName;
  /** The order the action targets. */
  noTransaksiOrderGizi: string;
  /** `urut_order` — set for `'hapusDetail'` only. */
  urutOrder?: string;
  /** Why this action (or non-action), in the wording the legacy log used. */
  reason: string;
}

// ── sending ──────────────────────────────────────────────────────

/** {@link planOrderGiziSend} output. */
export interface OrderGiziSendPlan {
  /** `room_rows[0].no_registrasikunjungan`. */
  reg: string;
  /** `cek_order_gizi` read as an integer — what SIMRS thinks is outstanding. */
  cekOrderGizi: number;
  /**
   * `cek_order_gizi > 0` but no order history was found. The Python logs this
   * and gives up; it means the blocker cannot be resolved from the history and a
   * human has to look.
   */
  historyMissing: boolean;
  /** One entry per candidate order, in candidate order. */
  actions: GiziAction[];
  /** The `'kirim'` subset — what actually needs sending. */
  toSend: GiziAction[];
  /** Orders whose every detail line already reads `status_kirim=sudah`. */
  alreadySent: GiziAction[];
  /** Orders that cannot be sent right now: empty detail, or `cek_jadwal_gizi` refused. */
  blocked: GiziAction[];
  /** The Python's return value: at least one send is planned. */
  willSend: boolean;
}

/** Named arguments for {@link planOrderGiziSend}. */
export interface PlanOrderGiziSendArgs {
  /** The room rows of the group; `[0]` supplies the registration. */
  roomRows: readonly LegacyRow[];
  /** {@link collectOrderGiziTransactionsForGroup} output. */
  orderItems?: readonly OrderGiziTransaction[];
  /** `cek_order_gizi` response text for the group's registration. */
  cekOrderGiziResponse?: unknown;
  /** `getdataordergizi` payload keyed by `no_transaksi_ordergizi`. */
  detailByOrder?: Readonly<Record<string, unknown>>;
  /** `cek_jadwal_gizi` response text keyed by `no_transaksi_ordergizi`. */
  jadwalByOrder?: Readonly<Record<string, unknown>>;
}

/**
 * The decision core of `ensure_ordergizi_terkirim` — which diet orders need
 * sending, which are already sent, and which cannot be sent yet.
 *
 * Per order:
 *  - no detail lines → nothing to send ("detail order gizi kosong").
 *  - every line reads `status_kirim=sudah` → already sent.
 *  - `cek_jadwal_gizi` answers anything other than `''` or `'1'` → deferred; the
 *    kitchen schedule refuses it and forcing the send would fail.
 *  - otherwise → `'kirim'`.
 *
 * An empty `roomRows` yields an empty plan, matching the Python's early
 * `return False`.
 */
export function planOrderGiziSend(args: PlanOrderGiziSendArgs): OrderGiziSendPlan {
  const roomRows = args.roomRows ?? [];
  const reg = str(roomRows[0], 'no_registrasikunjungan');
  const cekOrderGizi = safeInt(args.cekOrderGiziResponse, 0);
  const orderItems = roomRows.length === 0 ? [] : (args.orderItems ?? []);

  const plan: OrderGiziSendPlan = {
    reg,
    cekOrderGizi,
    historyMissing: roomRows.length > 0 && orderItems.length === 0 && cekOrderGizi > 0,
    actions: [],
    toSend: [],
    alreadySent: [],
    blocked: [],
    willSend: false,
  };
  if (orderItems.length === 0) return plan;

  for (const item of orderItems) {
    const orderTrx = text(item.noTransaksiOrderGizi);
    if (!orderTrx) continue;
    const rows = detailRowsOf(args.detailByOrder?.[orderTrx]);
    if (rows.length === 0) {
      pushAction(plan, 'blocked', {
        action: 'none',
        noTransaksiOrderGizi: orderTrx,
        reason: 'detail order gizi kosong',
      });
      continue;
    }

    const pendingRows = rows.filter(
      (row) => str(row, 'status_kirim').toLowerCase() !== STATUS_KIRIM_SENT,
    );
    if (pendingRows.length === 0) {
      pushAction(plan, 'alreadySent', {
        action: 'none',
        noTransaksiOrderGizi: orderTrx,
        reason: `order gizi sudah terkirim | detail=${rows.length}`,
      });
      continue;
    }

    const jadwalStatus = text(args.jadwalByOrder?.[orderTrx]);
    if (!JADWAL_SEND_ALLOWED_VALUES.includes(jadwalStatus)) {
      pushAction(plan, 'blocked', {
        action: 'none',
        noTransaksiOrderGizi: orderTrx,
        reason: `cek_jadwal=${jadwalStatus}`,
      });
      continue;
    }

    pushAction(plan, 'toSend', {
      action: 'kirim',
      noTransaksiOrderGizi: orderTrx,
      reason: `pending=${pendingRows.length} | cek_jadwal=${jadwalStatus || '-'}`,
    });
  }

  plan.willSend = plan.toSend.length > 0;
  return plan;
}

// ── recovery ─────────────────────────────────────────────────────

/** {@link planOrderGiziRecovery} output. */
export interface OrderGiziRecoveryPlan {
  /** `kunjungan_inap.no_transaksi`. */
  noTransaksi: string;
  /** `kunjungan_inap.no_registrasikunjungan`. */
  reg: string;
  /** The order the blocker named, tried first. */
  preferredOrder: string;
  /** Candidate orders in the sequence the Python evaluates them. */
  candidateOrders: string[];
  /** The order this pass acts on; `''` when none qualified. */
  targetOrder: string;
  /** The write sequence, in order: an optional `batalKirim` then the `hapusDetail`s. */
  actions: GiziAction[];
  /** Orders passed over before `targetOrder`, with the reason. */
  skipped: GiziAction[];
  /** The Python's return value: at least one delete is planned. */
  willRecover: boolean;
}

/** Named arguments for {@link planOrderGiziRecovery}. */
export interface PlanOrderGiziRecoveryArgs {
  /** The inpatient visit row being recovered; supplies `no_transaksi` and the reg. */
  kunjunganInap?: LegacyRow;
  /** {@link collectOrderGiziTransactionsForGroup} output for the group. */
  orderItems?: readonly OrderGiziTransaction[];
  /** `getdataordergizi` payload keyed by `no_transaksi_ordergizi`. */
  detailByOrder?: Readonly<Record<string, unknown>>;
  /**
   * The order the blocker named (`blocker.noTransaksi`). It is tried first; the
   * remaining orders keep their original relative order.
   */
  preferredOrderTrx?: string;
}

/**
 * The decision core of `recover_ordergizi_error` — which recovery action applies
 * to which order, in what order.
 *
 * The Python stops at the **first** order that yields a deletion, so the plan
 * covers exactly one order: the preferred one if it has detail lines, otherwise
 * the first candidate that does. For that order it plans
 *  1. `batalKirim`, when any detail line reads `status_kirim=sudah` — a sent
 *     order cannot have its lines deleted; and
 *  2. one `hapusDetail` per detail line that carries a `urut_order`, in
 *     `sortedRows` order (chronological, then `urut_tindakan`).
 *
 * The Python re-reads `getdataordergizi` after the cancel and after every delete,
 * breaking out early if the order empties. A plan cannot see those reads, so it
 * lists every line of the pre-cancel snapshot — which is what the `DRY_RUN`
 * branch does too. A live executor should re-read and stop early; deleting a
 * line that is already gone is the only cost of not doing so.
 */
export function planOrderGiziRecovery(
  args: PlanOrderGiziRecoveryArgs,
): OrderGiziRecoveryPlan {
  const kunjungan = args.kunjunganInap ?? {};
  const preferredOrder = text(args.preferredOrderTrx);
  const orderItems = args.orderItems ?? [];

  // `sorted(enumerate(items), key=(0 if preferred else 1, index))` — a stable
  // partition, not a reshuffle.
  const ordered = preferredOrder
    ? [
        ...orderItems.filter((item) => text(item.noTransaksiOrderGizi) === preferredOrder),
        ...orderItems.filter((item) => text(item.noTransaksiOrderGizi) !== preferredOrder),
      ]
    : [...orderItems];

  const plan: OrderGiziRecoveryPlan = {
    noTransaksi: str(kunjungan, 'no_transaksi'),
    reg: str(kunjungan, 'no_registrasikunjungan'),
    preferredOrder,
    candidateOrders: ordered.map((item) => text(item.noTransaksiOrderGizi)).filter(Boolean),
    targetOrder: '',
    actions: [],
    skipped: [],
    willRecover: false,
  };

  for (const item of ordered) {
    const orderTrx = text(item.noTransaksiOrderGizi);
    if (!orderTrx) continue;
    const rows = detailRowsOf(args.detailByOrder?.[orderTrx]);
    if (rows.length === 0) {
      plan.skipped.push({
        action: 'none',
        noTransaksiOrderGizi: orderTrx,
        reason: 'detail order gizi kosong',
      });
      continue;
    }

    const actions: GiziAction[] = [];
    if (rows.some((row) => str(row, 'status_kirim').toLowerCase() === STATUS_KIRIM_SENT)) {
      actions.push({
        action: 'batalKirim',
        noTransaksiOrderGizi: orderTrx,
        reason: 'detail order gizi masih berstatus sudah kirim',
      });
    }
    for (const row of sortedRows(rows)) {
      const urutOrder = str(row, 'urut_order');
      if (!urutOrder) continue;
      actions.push({
        action: 'hapusDetail',
        noTransaksiOrderGizi: orderTrx,
        urutOrder,
        reason:
          `jadwal=${str(row, 'nama_jadwal') || '-'} | ` +
          `jenis=${str(row, 'nama_jenismakan') || '-'} | ` +
          `tgl_order=${str(row, 'tgl_order') || '-'}`,
      });
    }

    if (!actions.some((action) => action.action === 'hapusDetail')) {
      // No line carries a `urut_order`, so nothing can be deleted and the Python
      // moves on to the next order with `any_deleted` still false.
      plan.skipped.push({
        action: 'none',
        noTransaksiOrderGizi: orderTrx,
        reason: 'tidak ada detail dengan urut_order',
      });
      continue;
    }

    plan.targetOrder = orderTrx;
    plan.actions = actions;
    plan.willRecover = true;
    return plan;
  }

  return plan;
}

// ── the recovery loop ────────────────────────────────────────────

/** How {@link planGiziBlockerRecovery} concluded. */
export type GiziBlockerRecoveryOutcome =
  /** No blocker at all — nothing to do (the Python returns `True`). */
  | 'clear'
  /** Something other than gizi blocks; the pipeline must not touch it. */
  | 'not-gizi'
  /** A later observation showed no blocker: recovery worked. */
  | 'cleared'
  /** A recovery pass found nothing to delete, so the loop cannot progress. */
  | 'no-recovery'
  /** The blocker came back unchanged (or repeated an earlier state). */
  | 'stalled'
  /** Preview / `DRY_RUN`: the first pass changes no state, so the loop stops. */
  | 'dry-run'
  /** {@link GIZI_RECOVERY_MAX_ATTEMPTS} attempts used and the blocker is still there. */
  | 'exhausted'
  /** Ran out of blocker observations: fetch the next one and call again. */
  | 'pending';

/** One attempt of the `_recover_gizi_blocker_until_clear` loop. */
export interface GiziBlockerRecoveryStep {
  /** 1-based, as the Python's `Attempt n/max` log. */
  attempt: number;
  /** The blocker this attempt was planned against. */
  blocker: PenunjangBlocker;
  /** `_penunjang_blocker_label(blocker)` — the one-line log form. */
  blockerLabel: string;
  /** `blocker.noTransaksi` — the order {@link planOrderGiziRecovery} tries first. */
  preferredOrderTrx: string;
  /** The recovery pass for this attempt, when one was supplied. */
  actions: GiziAction[];
}

/** {@link planGiziBlockerRecovery} output. */
export interface GiziBlockerRecoveryPlan {
  /** `kunjungan_inap.no_registrasikunjungan`. */
  reg: string;
  outcome: GiziBlockerRecoveryOutcome;
  /** The attempts to run, in order. */
  steps: GiziBlockerRecoveryStep[];
  /** The cap actually applied. */
  maxAttempts: number;
  /** The Python's return value: the blocker is (or would be) clear. */
  cleared: boolean;
  /** True for `'pending'`: the caller must observe the blocker again. */
  needsMoreObservations: boolean;
  /** The wording the legacy "Stop recovery blocker gizi" block logged. */
  reason: string;
}

/** Named arguments for {@link planGiziBlockerRecovery}. */
export interface PlanGiziBlockerRecoveryArgs {
  /** The inpatient visit row; supplies the registration the blocker is read for. */
  kunjunganInap?: LegacyRow;
  /**
   * `cektransaksi_penunjang_verifikator` observations, oldest first: `[0]` is the
   * state before attempt 1 and `[n]` the state after attempt `n`. Normalise each
   * with `normalizePenunjangBlocker`. One entry is enough to plan the first
   * attempt; the outcome is then `'pending'`.
   */
  blockers: readonly PenunjangBlocker[];
  /**
   * The recovery pass for each attempt, aligned with `blockers`: `[n]` is the
   * plan for attempt `n + 1`, built with
   * `preferredOrderTrx = blockers[n].noTransaksi`. Omit to plan the attempt
   * sequence only; a missing entry is treated as "a pass would find something",
   * so the loop keeps going.
   */
  recoveryPlans?: readonly OrderGiziRecoveryPlan[];
  /** Defaults to {@link GIZI_RECOVERY_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** The Python's `DRY_RUN`: stop after one pass because nothing really changed. */
  dryRun?: boolean;
}

/**
 * `_recover_gizi_blocker_until_clear` — the retry loop's decision rule and its
 * attempt cap, as a plan.
 *
 * The rule, in the Python's order: a blocker that is not a gizi blocker is
 * handed straight back (some other unit must be settled by a human); otherwise
 * each attempt runs a recovery pass against the order the blocker names, then
 * re-reads the blocker. The loop stops when the blocker clears, when a pass finds
 * nothing to delete, when the blocker comes back unchanged or repeats a state
 * already seen (the anti-livelock guard), or when the attempt cap is reached.
 *
 * The signature the loop compares is `(nama_unit, no_transaksi, data, total)` —
 * the same four fields `penunjangBlockerLabel` prints.
 */
export function planGiziBlockerRecovery(
  args: PlanGiziBlockerRecoveryArgs,
): GiziBlockerRecoveryPlan {
  const kunjungan = args.kunjunganInap ?? {};
  const reg = str(kunjungan, 'no_registrasikunjungan');
  const maxAttempts = Math.max(0, args.maxAttempts ?? GIZI_RECOVERY_MAX_ATTEMPTS);
  const blockers = args.blockers ?? [];

  const plan: GiziBlockerRecoveryPlan = {
    reg,
    outcome: 'clear',
    steps: [],
    maxAttempts,
    cleared: true,
    needsMoreObservations: false,
    reason: '',
  };

  const first = blockers[0];
  if (!first || !first.hasBlocker) {
    plan.reason = 'tidak ada blocker penunjang';
    return plan;
  }
  if (!isGiziPenunjangBlocker(first)) {
    return {
      ...plan,
      outcome: 'not-gizi',
      cleared: false,
      reason: `blocker bukan gizi | ${penunjangBlockerLabel(first)}`,
    };
  }

  const seenSignatures = new Set<string>();
  let current: PenunjangBlocker = first;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const signature = blockerSignature(current);
    const recovery = args.recoveryPlans?.[attempt - 1];
    plan.steps.push({
      attempt,
      blocker: current,
      blockerLabel: penunjangBlockerLabel(current),
      preferredOrderTrx: text(current.noTransaksi),
      actions: recovery?.actions ?? [],
    });

    if (recovery && !recovery.willRecover) {
      return {
        ...plan,
        outcome: 'no-recovery',
        cleared: false,
        reason: 'recovery order gizi tidak menemukan detail yang bisa dihapus',
      };
    }
    if (args.dryRun) {
      return {
        ...plan,
        outcome: 'dry-run',
        cleared: false,
        reason: 'dry_run tidak mengubah state',
      };
    }

    const next = blockers[attempt];
    if (next === undefined) {
      return {
        ...plan,
        outcome: 'pending',
        cleared: false,
        needsMoreObservations: true,
        reason: 'butuh pembacaan blocker berikutnya',
      };
    }
    if (!next.hasBlocker) {
      return { ...plan, outcome: 'cleared', cleared: true, reason: 'blocker sudah clear' };
    }
    if (!isGiziPenunjangBlocker(next)) {
      return {
        ...plan,
        outcome: 'not-gizi',
        cleared: false,
        reason: `blocker bukan gizi | ${penunjangBlockerLabel(next)}`,
      };
    }
    const nextSignature = blockerSignature(next);
    if (seenSignatures.has(nextSignature) || nextSignature === signature) {
      return {
        ...plan,
        outcome: 'stalled',
        cleared: false,
        reason: `blocker tidak berubah | ${penunjangBlockerLabel(next)}`,
      };
    }
    seenSignatures.add(signature);
    current = next;
  }

  return {
    ...plan,
    outcome: 'exhausted',
    cleared: false,
    reason: `blocker gizi belum clear setelah ${maxAttempts} attempt`,
  };
}

// ── internals ────────────────────────────────────────────────────

/** `(nama_unit, no_transaksi, data, int(total or 0))` as a comparable key. */
function blockerSignature(blocker: PenunjangBlocker): string {
  return JSON.stringify([
    blocker.namaUnit ?? '',
    blocker.noTransaksi ?? '',
    blocker.data ?? '',
    safeInt(blocker.total, 0),
  ]);
}

/** Push an action into `actions` and into the bucket that classifies it. */
function pushAction(
  plan: OrderGiziSendPlan,
  bucket: 'toSend' | 'alreadySent' | 'blocked',
  action: GiziAction,
): void {
  plan.actions.push(action);
  plan[bucket].push(action);
}
