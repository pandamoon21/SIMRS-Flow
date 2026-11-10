/**
 * Approvals for one run: gate approvals, mutation-plan approvals (two-person
 * rule) and the auto-approve queue.
 *
 * Security-sensitive. What this module guarantees:
 *   - a `critical` gate/plan resolves only after `criticalApprovals` *distinct*
 *     operators approve (the threshold for plans comes from the endpoint
 *     registry, `planApprovalsRequired`);
 *   - an approved plan is applied only through `applyApprovedMutation` (the
 *     mutation gate), which replays preconditions before the write and
 *     read-after-write rules after it; the client still enforces its
 *     allowlist. Auto-approve removes the human click only;
 *   - a plan fires at most once (settled-status check, `applying` latch, and
 *     the auto-approve `swept` claim against re-entrant event delivery);
 *   - auto-approved writes run one at a time per run.
 */

import {
  isTerminalStatus,
  type ExecutionMode,
  type GateDecision,
  type MutationPlan,
  type RunState,
  type WorkflowEventInput,
  type WorkflowNodeDefinition,
} from '@simrs-flow/workflow-core';
import {
  approvalsForRisk,
  endpointLabel,
  planApprovalsRequired,
  type EvoMedisClient,
} from '@simrs-flow/evomedis-client';
import { applyApprovedMutation, type MutationApplyResult } from './mutationGate.js';

/** Outcome of an approval that did not (yet) run the write. */
export type MutationApprovalRefusal =
  | 'run_not_found'
  | 'run_not_active'
  | 'plan_not_found'
  | 'preview_run'
  | 'already_settled'
  | 'apply_in_flight'
  | 'client_unavailable';

export type MutationApprovalResult =
  | { ok: false; error: MutationApprovalRefusal; message: string }
  /** Recorded, but more approvers are required (two-person rule). */
  | { ok: true; resolved: false; approvals: string[]; required: number; remaining: number }
  /** Threshold reached; the gate ran and produced an outcome. */
  | { ok: true; resolved: true; approvals: string[]; required: number; remaining: 0; outcome: MutationApplyResult };

export type GateApprovalResult = { ok: true; resolved: boolean; remaining: number } | { ok: false };

/** Event fields a run approval supplies; the run fills in its own envelope. */
export type RunEventInput = Omit<WorkflowEventInput, 'runId' | 'workflowId' | 'workflowVersion'>;

/**
 * The name recorded as the second approver of a `critical` plan when a run is
 * auto-approved. It is deliberately not a plausible human name: the audit trail
 * must make clear that the second signature was automatic, not a colleague's.
 */
export const AUTO_APPROVER_ID = 'auto-approve';

/** Indonesian names of a settled plan's status, for operator messages. */
const PLAN_STATUS_ID: Record<string, string> = { applied: 'diterapkan', verified: 'terverifikasi', failed: 'gagal', invalidated: 'dibatalkan' };

/** Thrown for caller-mapped HTTP errors. `apiError` (when set) is the API error id. */
export function httpError(statusCode: number, message: string, apiError?: string): Error {
  return Object.assign(new Error(message), { statusCode, ...(apiError ? { apiError } : {}) });
}

/**
 * The single decision on whether a run is auto-approved.
 *
 * Auto-approval is a write-run convenience only: preview never applies a
 * mutation, so asking for it there is a caller mistake, not a silent no-op
 * (400). A write run is auto-approved when the caller asks for it or the host
 * sets `AUTO_APPROVE_WRITES`.
 */
export function resolveAutoApprove(mode: ExecutionMode, requested: boolean | undefined, hostDefault: boolean): boolean {
  if (requested && mode !== 'write') {
    throw httpError(400, 'autoApprove is only supported for write runs', 'autoApprove_requires_write_mode');
  }
  return mode === 'write' && (requested === true || hostDefault);
}

/**
 * Approvals a gate needs: the node's declared risk. Nodes do not name their
 * endpoints statically, so the registry cannot be consulted here; the plans a
 * gate guards are each held to the registry by `planApprovalsRequired`
 * (control #22), so the gate is never the only line.
 */
function gateApprovalsRequired(node: WorkflowNodeDefinition, critical: number): number {
  return approvalsForRisk(node.riskLevel, critical);
}

function isSettledStatus(status: string | undefined): status is 'applied' | 'verified' | 'failed' | 'invalidated' {
  return status === 'applied' || status === 'verified' || status === 'failed' || status === 'invalidated';
}

interface GateWaiter {
  resolve: (decision: GateDecision) => void;
  /** Distinct operators who have approved this gate so far. */
  approvals: Set<string>;
  /** Approvals required before the gate resolves (1, or 2 for critical). */
  required: number;
}

export interface RunApprovalsOptions {
  runId: string;
  mode: ExecutionMode;
  /** Current projected run state (read fresh on every decision). */
  state: () => RunState;
  /** Emit a run event (the run fills in runId/workflowId/workflowVersion). */
  emit: (event: RunEventInput) => void;
  /** Cancels an in-flight apply when the run is cancelled. */
  signal: AbortSignal;
  /** Approvals a `critical` gate/plan needs (two-person rule). */
  criticalApprovals: number;
  /**
   * Set when the run is auto-approved: the operator credited with every
   * approval. Unset means a human approves each gate and plan.
   */
  autoApproveAs?: string;
  /** Workflow node definitions, so a gate's threshold uses the declared risk. */
  nodes?: ReadonlyMap<string, WorkflowNodeDefinition>;
  /** The mutation gate's client (write runs only); can be attached later. */
  client?: EvoMedisClient;
}

export class RunApprovals {
  /** Pending gate approvals keyed by nodeId. */
  private readonly gates = new Map<string, GateWaiter>();
  /** Distinct operators who have approved each mutation plan, keyed by plan id. */
  private readonly mutationApprovals = new Map<string, Set<string>>();
  /** Plan ids whose apply is in flight (guards against a double submit). */
  private readonly applying = new Set<string>();
  /**
   * True while `sweep` is collecting. Approving emits events that re-enter the
   * bus subscriber, so the sweep needs its own latch.
   */
  private autoApproving = false;
  /** Plan ids auto-approve has already fired, so a re-entry cannot repeat one. */
  private readonly swept = new Set<string>();
  /**
   * Auto-approved writes run one at a time per run. Fired in parallel, two
   * tampung bayar hit the cashier at once and one came back as a backend error
   * page; sent alone, the same plan landed (live 2026-10-20).
   */
  private autoQueue: Promise<void> = Promise.resolve();
  private client?: EvoMedisClient;

  constructor(private readonly options: RunApprovalsOptions) {
    this.client = options.client;
  }

  /** Attach the mutation gate's client once the run has built it. */
  attachClient(client: EvoMedisClient): void {
    this.client = client;
  }

  get autoApprove(): boolean {
    return this.options.autoApproveAs !== undefined;
  }

  /** The runner's `gateResolver`. */
  readonly resolveGate = (node: WorkflowNodeDefinition): GateDecision | Promise<GateDecision> => {
    // In preview, gates auto-hold (never approve a real write).
    if (this.options.mode === 'preview') {
      return { approved: false, reason: 'Preview — gate ditahan, tidak ada yang ditulis' };
    }
    const def = this.options.nodes?.get(node.id) ?? node;
    const required = gateApprovalsRequired(def, this.options.criticalApprovals);
    // Auto-approve: resolve at once. A `critical` gate needs two distinct
    // approvers, so the synthetic auto-approver is named alongside the real
    // operator — the audit trail must not read as a two-human sign-off.
    if (this.options.autoApproveAs !== undefined) {
      const operator = this.options.autoApproveAs;
      const approvers = required > 1 ? `${operator}, ${AUTO_APPROVER_ID}` : operator;
      return { approved: true, reason: `Auto-approved by ${approvers} (autoApprove)` };
    }
    // In write mode, await external approval(s) via approveGate/rejectGate.
    // `Promise.withResolvers` needs a newer lib than this project targets.
    return new Promise((resolve) => {
      this.gates.set(node.id, { resolve, approvals: new Set(), required });
    });
  };

  /**
   * Approve a waiting gate. Critical gates need two distinct operators; the
   * first approval is held and the gate resolves only on the second.
   */
  approveGate(nodeId: string, operator: string, reason?: string): GateApprovalResult {
    const waiter = this.gates.get(nodeId);
    if (!waiter) return { ok: false };

    waiter.approvals.add(operator);
    if (waiter.approvals.size >= waiter.required) {
      const approvers = [...waiter.approvals].join(', ');
      waiter.resolve({ approved: true, reason: reason ?? `Approved by ${approvers}` });
      this.gates.delete(nodeId);
      return { ok: true, resolved: true, remaining: 0 };
    }
    // Surface partial approval in the audit/event stream.
    this.options.emit({
      type: 'gate.waiting',
      source: 'api',
      nodeId,
      message: `Approval ${waiter.approvals.size}/${waiter.required} by ${operator} — second approver required`,
    });
    return { ok: true, resolved: false, remaining: waiter.required - waiter.approvals.size };
  }

  rejectGate(nodeId: string, operator: string, reason?: string): boolean {
    const waiter = this.gates.get(nodeId);
    if (!waiter) return false;
    waiter.resolve({ approved: false, reason: reason ?? `Rejected by ${operator}` });
    this.gates.delete(nodeId);
    return true;
  }

  /** Release every pending gate so the runner unwinds (run cancelled). */
  cancel(): void {
    for (const waiter of this.gates.values()) {
      waiter.resolve({ approved: false, reason: 'Run cancelled' });
    }
    this.gates.clear();
  }

  /** Every plan the run has proposed so far, with the node that proposed it. */
  private findPlan(planId: string): { plan: MutationPlan; nodeId: string } | undefined {
    for (const node of Object.values(this.options.state().nodes)) {
      for (const plan of node.proposedMutations) {
        if (plan.id === planId) return { plan, nodeId: node.id };
      }
    }
    return undefined;
  }

  /**
   * Approve a proposed mutation and — once enough distinct operators have
   * approved — apply it through the mutation gate.
   *
   * The gate is the only path that writes: it replays the plan's preconditions
   * immediately before the call and its read-after-write rules immediately
   * after (`mutationGate.ts`). Approval alone never writes, and an approval
   * given minutes ago cannot fire against state that has since changed, because
   * the reads happen here and now rather than when the plan was built.
   *
   * `critical` plans need two distinct approvers, exactly as `critical` gates do.
   */
  async approveMutation(planId: string, operator: string, reason?: string): Promise<MutationApprovalResult> {
    const { runId } = this.options;
    // Preview must never write. The client would block it too (control #1);
    // refusing here keeps the preview path from even reading.
    if (this.options.mode !== 'write') {
      return { ok: false, error: 'preview_run', message: 'Preview runs never apply mutations' };
    }
    const state = this.options.state();
    if (isTerminalStatus(state.status)) {
      return {
        ok: false,
        error: 'run_not_active',
        message: `Run ${runId} is ${state.status}; mutations are applied while the run is live`,
      };
    }
    const found = this.findPlan(planId);
    if (!found) {
      return { ok: false, error: 'plan_not_found', message: `Run ${runId} proposed no plan "${planId}"` };
    }
    // Idempotency (control #11): a plan that already fired must not fire twice.
    const settled = state.mutations[planId]?.status;
    if (isSettledStatus(settled)) {
      return {
        ok: false,
        error: 'already_settled',
        message: `Rencana ini sudah selesai (${PLAN_STATUS_ID[settled]})`,
      };
    }
    if (this.applying.has(planId)) {
      return { ok: false, error: 'apply_in_flight', message: 'Rencana ini sedang diterapkan' };
    }
    const client = this.client;
    if (!client) {
      return { ok: false, error: 'client_unavailable', message: 'No client available for this run' };
    }

    const approvals = this.mutationApprovals.get(planId) ?? new Set<string>();
    approvals.add(operator);
    this.mutationApprovals.set(planId, approvals);
    // The registry owns the threshold: the higher of its risk and the plan's
    // (an unknown endpoint fails closed as critical).
    const required = planApprovalsRequired(found.plan.endpointId, found.plan.riskLevel, this.options.criticalApprovals);
    if (approvals.size < required) {
      // Surface the partial approval in the audit/event stream.
      this.options.emit({
        type: 'log.appended',
        source: 'api',
        nodeId: found.nodeId,
        message: `Persetujuan ${approvals.size}/${required} oleh ${operator} untuk ${endpointLabel(found.plan.endpointId)} — butuh operator kedua`,
        data: { planId, endpointId: found.plan.endpointId },
      });
      return {
        ok: true,
        resolved: false,
        approvals: [...approvals],
        required,
        remaining: required - approvals.size,
      };
    }

    this.applying.add(planId);
    try {
      const outcome = await applyApprovedMutation({
        plan: found.plan,
        client,
        approvedBy: [...approvals],
        signal: this.options.signal,
        ...(reason ? { reason } : {}),
        emit: (event) =>
          this.options.emit({
            source: 'api',
            nodeId: found.nodeId,
            type: event.type,
            ...(event.severity ? { severity: event.severity } : {}),
            message: event.message,
            data: event.data,
          }),
      });
      return { ok: true, resolved: true, approvals: [...approvals], required, remaining: 0, outcome };
    } finally {
      this.applying.delete(planId);
    }
  }

  /**
   * Approve every unsettled plan of an auto-approving run (no-op otherwise),
   * attributed to the auto-approve operator.
   *
   * Called from the bus subscriber, so it must be re-entrancy safe: approving
   * emits `mutation.*` events that re-enter the subscriber. `autoApproving`
   * blocks that recursion, and `applying` / the settled-status check in
   * `approveMutation` make a repeat call harmless.
   *
   * A refusal is logged and skipped rather than thrown: one unapprovable plan
   * (say, a precondition that no longer holds) must not abort the sweep and
   * strand the rest of the batch.
   */
  sweep(): void {
    const operator = this.options.autoApproveAs;
    if (operator === undefined || this.autoApproving) return;
    // Collect first, approve after: `approveMutation` emits events that re-enter
    // the subscriber synchronously, so a sweep that approved inside the latch
    // would be re-entered with a state snapshot taken before the plan loop even
    // finished — which is how the verification plan stayed `planned` forever.
    const pending: string[] = [];
    this.autoApproving = true;
    try {
      const state = this.options.state();
      for (const node of Object.values(state.nodes)) {
        for (const plan of node.proposedMutations) {
          if (this.applying.has(plan.id) || this.swept.has(plan.id)) continue;
          if (isSettledStatus(state.mutations[plan.id]?.status)) continue;
          pending.push(plan.id);
        }
      }
      // Claim before the first await: `approveMutation` emits events that
      // re-enter this sweep synchronously, and without the claim it would fire
      // the same plan again from inside that re-entry (unbounded).
      for (const planId of pending) this.swept.add(planId);
    } finally {
      this.autoApproving = false;
    }
    for (const planId of pending) {
      this.autoQueue = this.autoQueue.then(() => this.autoApproveOne(planId, operator)).catch((err: unknown) => {
        console.error(`[autoApprove] plan ${planId} failed:`, err);
      });
    }
  }

  /**
   * Resolves once the auto-approve queue has drained, including plans queued
   * while it was draining. Never rejects.
   */
  async idle(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.autoQueue;
      await tail;
    } while (tail !== this.autoQueue);
  }

  /**
   * Approve one plan, meeting the two-person rule for a `critical` plan.
   *
   * `approveMutation` counts *distinct* operators, so a critical plan (two
   * approvals) would sit at 1/2 forever under a single auto-approver. The
   * second approval is recorded as a distinct synthetic operator, and the audit
   * trail preserves that: `approvedBy` names both the real operator and the
   * automatic one, so nobody can mistake this write for a two-human sign-off.
   */
  private async autoApproveOne(planId: string, operator: string): Promise<void> {
    const first = await this.approveMutation(planId, operator, 'Auto-approved (autoApprove)');
    if (!first.ok || first.resolved) return;
    const second = await this.approveMutation(planId, AUTO_APPROVER_ID, 'Auto-approved (autoApprove, second signature)');
    if (!second.ok) {
      console.error(`[autoApprove] plan ${planId} could not reach its approval threshold:`, second);
    }
  }
}
