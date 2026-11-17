/**
 * Re-plan barrier (parity gaps 1 and 2), one per run.
 *
 * The legacy script writes inline and re-reads immediately; plan → approve →
 * apply splits that in two, so a node whose follow-up work needs
 * backend-assigned state (a new charge line's `urut_tindakan`) asks for
 * another pass.
 *
 * This adds a loop *around* the mutation gate, never a way past it: the second
 * pass only re-runs the planner. Anything it proposes is a fresh
 * `MutationPlan` that must be approved again and applied through the gate,
 * with preconditions replayed, the allowlist enforced and the two-person rule
 * intact. The runner caps the passes.
 */

import {
  verificationRulesOf,
  type ExecutionMode,
  type MutationOutcomeStatus,
  type MutationPlan,
  type ReplanDecision,
  type ReplanResolver,
  type RunState,
  type WorkflowEvent,
} from '@simrs-flow/workflow-core';

/** A node parked after `needsReplan`, waiting for its mutations to settle. */
interface ReplanWaiter {
  resolve: (decision: ReplanDecision) => void;
  /** Plan ids proposed by the pass that asked; all must settle. */
  planIds: string[];
}

/** Mutation outcomes that can no longer change — the write is over. */
const SETTLED_MUTATION: ReadonlySet<MutationOutcomeStatus> = new Set([
  'verified',
  'failed',
  'invalidated',
]);

/** Events after which a parked re-plan may have become decidable. */
export const MUTATION_SETTLING_EVENTS: ReadonlySet<WorkflowEvent['type']> = new Set([
  'mutation.applied',
  'mutation.verified',
  'mutation.failed',
  'mutation.invalidated',
]);

function findProposedPlan(state: RunState, planId: string): MutationPlan | undefined {
  let found: MutationPlan | undefined;
  for (const node of Object.values(state.nodes)) {
    for (const plan of node.proposedMutations) {
      if (plan.id !== planId) continue;
      if (found) return undefined;
      found = plan;
    }
  }
  return found;
}

function isSettledForReplan(state: RunState, planId: string): boolean {
  const outcome = state.mutations[planId];
  if (!outcome) return false;
  if (SETTLED_MUTATION.has(outcome.status)) return true;
  if (outcome.status !== 'applied') return false;
  const plan = findProposedPlan(state, planId);
  return plan ? verificationRulesOf(plan).length === 0 : false;
}

/**
 * Should a node that asked for another pass get one *now*?
 *
 * `undefined` means "not yet" — at least one plan is still in flight, so the
 * caller parks and re-asks on the next settling event. A decision is only
 * reached once every plan from that pass has no more gate event to wait for:
 *  - verified / failed / invalidated outcomes are terminal;
 *  - applied is enough only when the plan declared no read-after-write rule, so
 *    there will never be a later verification event for that plan.
 *
 * `applied` remains unverified; this only stops an unobservable write from
 * parking the re-plan barrier forever.
 */
export function replanDecision(state: RunState, planIds: string[]): ReplanDecision | undefined {
  if (planIds.some((planId) => !isSettledForReplan(state, planId))) {
    return undefined;
  }
  const outcomes = planIds.map((planId) => state.mutations[planId]);
  const applied = outcomes.filter((outcome) => outcome?.appliedAt !== undefined);
  if (applied.length === 0) {
    return {
      replan: false,
      reason: `none of the ${planIds.length} proposed mutation(s) were applied, so nothing changed to re-read`,
    };
  }
  return {
    replan: true,
    reason: `${applied.length}/${planIds.length} mutation(s) applied — re-reading to plan the follow-up`,
  };
}

export interface ReplanBarrierOptions {
  mode: ExecutionMode;
  /** Current projected run state (read fresh on every decision). */
  state: () => RunState;
  /**
   * Called after a node parks. The plans that parked it may still be
   * unapproved (e.g. only some were swept); an auto-approving run fires them
   * here so the settling events that release the barrier are actually coming.
   */
  onPark?: () => void;
}

export class ReplanBarrier {
  /** Nodes parked awaiting a re-plan decision, keyed by nodeId. */
  private readonly waiters = new Map<string, ReplanWaiter>();

  constructor(private readonly options: ReplanBarrierOptions) {}

  /** The runner's `replanResolver`. */
  readonly resolver: ReplanResolver = (request) => {
    // Preview never applies anything (control #1), so nothing can have
    // changed. The runner already refuses to re-plan in preview; this is the
    // second lock on the same door.
    if (this.options.mode !== 'write') {
      return { replan: false, reason: 'preview run — no mutation is ever applied' };
    }
    const planIds = request.proposedMutations.map((plan) => plan.id);
    if (planIds.length === 0) {
      return { replan: false, reason: 'the pass proposed no mutation, so nothing can have changed' };
    }
    const now = replanDecision(this.options.state(), planIds);
    if (now) return now;
    // Park until every plan settles. Released by `onEvent` on each terminal
    // `mutation.*` event, or by cancel().
    //
    // The decision is re-checked *inside* the executor: with auto-approve the
    // plans can settle between the check above and this `set`, and that
    // settling event has already been delivered — without the second look the
    // node would park with nothing left to wake it.
    return new Promise<ReplanDecision>((resolve) => {
      const settledNow = replanDecision(this.options.state(), planIds);
      if (settledNow) {
        resolve(settledNow);
        return;
      }
      this.waiters.set(request.node.id, { resolve, planIds });
      this.options.onPark?.();
    });
  };

  /** Feed every run event; a mutation reaching a terminal outcome may release a parked node. */
  onEvent(event: WorkflowEvent): void {
    if (MUTATION_SETTLING_EVENTS.has(event.type)) this.release();
  }

  /**
   * Release every parked node whose mutations have all settled. Nodes still
   * waiting on an in-flight plan stay parked.
   */
  release(): void {
    for (const [nodeId, waiter] of [...this.waiters]) {
      const decision = replanDecision(this.options.state(), waiter.planIds);
      if (!decision) continue;
      this.waiters.delete(nodeId);
      waiter.resolve(decision);
    }
  }

  /** Unwind every parked node (run cancelled). */
  cancel(): void {
    for (const waiter of this.waiters.values()) {
      waiter.resolve({ replan: false, reason: 'run cancelled' });
    }
    this.waiters.clear();
  }
}
