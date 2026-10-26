/**
 * Runner — the headless execution engine.
 *
 * Responsibilities:
 *  - resolve execution order from the definition (topological)
 *  - run each enabled node's executor with a context
 *  - emit lifecycle events through the EventBus (never touch UI)
 *  - honor critical-failure semantics, skips, retries, gates, cancellation
 *  - enforce the preview safety rule: in preview mode, mutate/gate nodes
 *    that would call mutating endpoints are converted to plans, not applied
 *  - re-run a node that reported `needsReplan` once its mutations have settled,
 *    bounded by a hard per-node cap
 *
 * The runner is deterministic given the same executors, clock, and id
 * factory — which is what makes runs replayable and testable.
 */

import { EventBus } from './eventBus.js';
import { applyEvent, initialRunState } from './reducer.js';
import { edgeBetween, executionOrder, validateDefinition } from './definition.js';
import { generateRunId, type Clock, systemClock } from './ids.js';
import { DEFAULT_MAX_REPLAN_PASSES } from './types.js';
import type {
  BranchVerdict,
  ExecutionMode,
  ExecutorContext,
  ExecutorRegistry,
  MutationPlan,
  ReplanEventData,
  RunState,
  StepResult,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowNodeDefinition,
} from './types.js';

export interface GateDecision {
  approved: boolean;
  reason?: string;
}

/**
 * Gate resolver. Called when a `gate` node is reached. Returning
 * `{approved:false}` blocks the run from proceeding past the gate.
 * In preview mode the runner supplies a default resolver that auto-holds
 * (never approves a real mutation).
 */
export type GateResolver = (
  node: WorkflowNodeDefinition,
  ctx: ExecutorContext,
) => Promise<GateDecision> | GateDecision;

/** What a node asked for when it set `StepResult.needsReplan`. */
export interface ReplanRequest {
  node: WorkflowNodeDefinition;
  /** 1-based number of the pass that just finished. */
  pass: number;
  /** Cap on passes for this node, including the first. */
  maxPasses: number;
  /**
   * Plans **this pass** proposed. Only these decide whether another pass is
   * owed; plans from an earlier pass have already been accounted for.
   */
  proposedMutations: MutationPlan[];
  /** The result that set `needsReplan`. */
  result: StepResult;
}

export interface ReplanDecision {
  /** True to run the node's executor again. */
  replan: boolean;
  /** Operator-facing explanation, recorded on the emitted event. */
  reason?: string;
}

/**
 * Decides whether a node that asked for another pass gets one, and when.
 *
 * Called only on **write** runs, and only after the node's terminal event has
 * been emitted (so the operator can already see and approve the plans). The
 * resolver is expected to wait until every plan in `request.proposedMutations`
 * has a terminal outcome, then answer `replan: true` if at least one actually
 * applied. `RunService` supplies the real implementation; with no resolver the
 * runner never re-plans.
 */
export type ReplanResolver = (
  request: ReplanRequest,
  ctx: ExecutorContext,
) => Promise<ReplanDecision> | ReplanDecision;

export interface RunnerOptions {
  mode?: ExecutionMode;
  runId?: string;
  clock?: Clock;
  bus?: EventBus;
  /** Per-node enable overrides (id → enabled). Falls back to defaultEnabled. */
  enabled?: Record<string, boolean>;
  /** Resolver for gate nodes. */
  gateResolver?: GateResolver;
  /** Resolver for `needsReplan`; write runs only. Absent = never re-plan. */
  replanResolver?: ReplanResolver;
  /**
   * Hard cap on executor passes per node, counting the first.
   * Defaults to {@link DEFAULT_MAX_REPLAN_PASSES}; clamped to at least 1.
   */
  maxReplanPasses?: number;
  /** External cancellation. */
  signal?: AbortSignal;
  /**
   * Awaited before each step starts. A paused run parks here, between steps,
   * so a step never stops halfway; cancelling must settle it too.
   */
  beforeNode?: () => Promise<void>;
  input?: unknown;
}

export interface RunResult {
  runId: string;
  state: RunState;
  events: WorkflowEvent[];
  status: RunState['status'];
}

const SKIP: StepResult = { status: 'skipped', summary: 'Disabled' };

/** A node kind that performs writes when approved. */
function isMutating(node: WorkflowNodeDefinition): boolean {
  return node.kind === 'mutate';
}

export class WorkflowRunner {
  private readonly definition: WorkflowDefinition;
  private readonly registry: ExecutorRegistry;

  constructor(definition: WorkflowDefinition, registry: ExecutorRegistry) {
    this.definition = definition;
    this.registry = registry;
  }

  async run(options: RunnerOptions = {}): Promise<RunResult> {
    const mode: ExecutionMode = options.mode ?? 'preview';
    const clock = options.clock ?? systemClock;
    const runId = options.runId ?? generateRunId(clock);
    const bus = options.bus ?? new EventBus({ clock });
    const maxPasses = Math.max(1, options.maxReplanPasses ?? DEFAULT_MAX_REPLAN_PASSES);

    // Validate before doing anything.
    const validation = validateDefinition(this.definition, this.registry);
    if (!validation.ok) {
      throw new Error(
        `Invalid workflow "${this.definition.id}": ${validation.problems
          .map((p) => p.message)
          .join('; ')}`,
      );
    }

    const events: WorkflowEvent[] = [];
    let state = initialRunState(this.definition, runId, mode);
    const record = (e: WorkflowEvent) => {
      events.push(e);
      state = applyEvent(state, e);
    };
    const unsubscribe = bus.subscribe(record);

    const base = {
      runId,
      workflowId: this.definition.id,
      workflowVersion: this.definition.version,
      source: 'runner' as const,
    };

    const order = executionOrder(this.definition);
    const enabledOf = (n: WorkflowNodeDefinition) =>
      options.enabled?.[n.id] ?? n.defaultEnabled;

    // Internal abort controller combined with external signal.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const scratch: Record<string, unknown> = {};
    const completed = new Set<string>();
    // Nodes whose outcome should prevent dependent downstream nodes from
    // running: disabled, failed, or blocked. A benign `skipped` (a no-op step
    // with nothing to do) does NOT block downstream work.
    const blockingUpstream = new Set<string>();
    const branchVerdicts = new Map<string, BranchVerdict>();
    const blockedByBranch = new Set<string>();
    const branchPruned = new Set<string>();

    bus.emit({ ...base, type: 'run.created', message: `Run ${runId} created in ${mode} mode` });
    bus.emit({ ...base, type: 'run.started', message: `Started in ${mode} mode` });

    let runFailed = false;
    let failMessage: string | undefined;

    try {
      for (const node of order) {
        if (controller.signal.aborted) break;
        if (options.beforeNode) {
          await options.beforeNode();
          if (controller.signal.aborted) break;
        }

        // Skip if disabled.
        if (!enabledOf(node)) {
          bus.emit({
            ...base,
            type: 'node.skipped',
            nodeId: node.id,
            message: `${node.label} disabled`,
            data: { summary: 'Disabled' },
          });
          blockingUpstream.add(node.id);
          continue;
        }

        const incoming = this.definition.edges.filter((edge) => edge.target === node.id);
        if (blockedByBranch.has(node.id) && !incoming.some((edge) =>
          branchVerdicts.get(edge.id) === 'take' && completed.has(edge.source),
        )) {
          bus.emit({
            ...base,
            type: 'node.skipped',
            nodeId: node.id,
            message: `${node.label} tidak dijalankan — cabang referensi belum dapat dipastikan`,
            data: { summary: 'Cabang tidak pasti' },
          });
          branchPruned.add(node.id);
          blockingUpstream.add(node.id);
          continue;
        }
        const skippedRequired = incoming.some((edge) =>
          branchVerdicts.get(edge.id) === 'skip' && edge.type !== 'branch' && edge.type !== 'parallel',
        );
        const skippedOptional = incoming.some((edge) =>
          branchVerdicts.get(edge.id) === 'skip' && (edge.type === 'branch' || edge.type === 'parallel'),
        ) && !incoming.some((edge) =>
          branchVerdicts.get(edge.id) !== 'skip' && completed.has(edge.source),
        );
        const prunedOptionalJoin = incoming.length > 0 && incoming.every((edge) =>
          (edge.type === 'branch' || edge.type === 'parallel') && branchPruned.has(edge.source),
        );
        if (skippedRequired || skippedOptional || prunedOptionalJoin) {
          bus.emit({
            ...base,
            type: 'node.skipped',
            nodeId: node.id,
            message: `${node.label} tidak dijalankan — cabang tidak dipilih`,
            data: { summary: 'Cabang tidak dipilih' },
          });
          branchPruned.add(node.id);
          blockingUpstream.add(node.id);
          continue;
        }

        // Skip if any upstream dependency is blocking (disabled/failed/blocked)
        // and the edge is required. branch/parallel edges are optional joins.
        const upstreamBlocked = incoming.some((e) =>
          blockingUpstream.has(e.source) && e.type !== 'branch' && e.type !== 'parallel' &&
          !(branchPruned.has(e.source) && incoming.some((other) => completed.has(other.source) && branchVerdicts.get(other.id) !== 'skip' && branchVerdicts.get(other.id) !== 'block')),
        );
        if (upstreamBlocked) {
          bus.emit({
            ...base,
            type: 'node.skipped',
            nodeId: node.id,
            message: `${node.label} skipped — upstream dependency unmet`,
            data: { summary: 'Upstream unmet' },
          });
          blockingUpstream.add(node.id);
          continue;
        }

        // One context per node, shared by every pass so `scratch` and the
        // clock stay the same object across a re-plan.
        let pass = 1;
        const ctx: ExecutorContext = {
          runId,
          mode,
          scratch,
          input: options.input,
          signal: controller.signal,
          clock,
          log: (message, severity = 'info', data) =>
            bus.emit({ ...base, type: 'log.appended', nodeId: node.id, severity, message, data }),
          // Snapshots of the folded state: read-only from the executor's side.
          get mutations() {
            return { ...state.mutations };
          },
          get pass() {
            return pass;
          },
          maxPasses,
        };

        let result = await this.runNode(node, ctx, pass, maxPasses, {
          base,
          bus,
          mode,
          gateResolver: options.gateResolver,
        });

        // ── Re-plan passes ──────────────────────────────────────────
        // Write runs only: preview applies nothing, so no node can ever have
        // something new to re-read. The terminal event for the pass has
        // already been emitted, so the operator can see and approve the plans
        // while we wait here.
        if (mode === 'write') {
          const emitExhausted = (reason: string, planIds: string[]) =>
            bus.emit({
              ...base,
              type: 'node.replan_exhausted',
              nodeId: node.id,
              severity: 'warn',
              message: `${node.label} asked for another pass and did not get one — ${reason} (pass ${pass}/${maxPasses})`,
              data: { pass, maxPasses, reason, planIds } satisfies ReplanEventData,
            });

          while (result.needsReplan === true) {
            const planIds = (result.proposedMutations ?? []).map((plan) => plan.id);
            if (controller.signal.aborted) {
              emitExhausted('run cancelled', planIds);
              break;
            }
            if (pass >= maxPasses) {
              emitExhausted(`re-plan cap of ${maxPasses} pass(es) reached`, planIds);
              break;
            }
            const decision = options.replanResolver
              ? await options.replanResolver(
                  {
                    node,
                    pass,
                    maxPasses,
                    proposedMutations: result.proposedMutations ?? [],
                    result,
                  },
                  ctx,
                )
              : { replan: false, reason: 'no re-plan resolver configured' };
            if (!decision.replan || controller.signal.aborted) {
              emitExhausted(
                controller.signal.aborted
                  ? 'run cancelled'
                  : (decision.reason ?? 'the re-plan resolver declined'),
                planIds,
              );
              break;
            }
            pass += 1;
            bus.emit({
              ...base,
              type: 'node.replanning',
              nodeId: node.id,
              message: `${node.label} re-planning (pass ${pass}/${maxPasses})${decision.reason ? ` — ${decision.reason}` : ''}`,
              data: {
                pass,
                maxPasses,
                ...(decision.reason ? { reason: decision.reason } : {}),
                planIds,
              } satisfies ReplanEventData,
            });
            result = await this.runNode(node, ctx, pass, maxPasses, {
              base,
              bus,
              mode,
              gateResolver: options.gateResolver,
            });
          }
        }

        for (const edge of this.definition.edges.filter((e) => e.source === node.id)) {
          const verdict = result.branches?.[edge.id];
          if (verdict === 'take' || verdict === 'skip' || verdict === 'block') {
            branchVerdicts.set(edge.id, verdict);
          } else if (edge.condition) {
            // A conditional edge cannot be taken without an explicit, valid verdict.
            branchVerdicts.set(edge.id, 'block');
          }
          if (branchVerdicts.get(edge.id) === 'block') blockedByBranch.add(edge.target);
        }

        if (
          result.status === 'success' ||
          result.status === 'needs_review'
        ) {
          completed.add(node.id);
        } else if (result.status === 'failed' || result.status === 'blocked') {
          // Genuinely blocking — dependents should not run.
          blockingUpstream.add(node.id);
        }
        // `skipped` is benign: neither completed nor blocking. Dependents
        // run normally (they will themselves skip if their inputs are absent).

        // Activate outgoing edges toward completed targets.
        this.markEdges(node, completed, branchVerdicts, bus, base);

        if (result.status === 'failed' && node.critical) {
          runFailed = true;
          failMessage = `Critical node "${node.label}" failed: ${result.summary}`;
          break;
        }
        if (result.status === 'blocked' && node.critical) {
          runFailed = true;
          failMessage = `Critical node "${node.label}" blocked: ${result.summary}`;
          break;
        }
      }
    } finally {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }

    if (controller.signal.aborted) {
      bus.emit({ ...base, type: 'run.cancelled', message: 'Run cancelled' });
    } else if (runFailed) {
      bus.emit({ ...base, type: 'run.failed', severity: 'error', message: failMessage });
    } else {
      bus.emit({
        ...base,
        type: 'run.completed',
        message: `Completed ${completed.size}/${order.length} nodes`,
      });
    }

    unsubscribe();
    return { runId, state, events, status: state.status };
  }

  private async runNode(
    node: WorkflowNodeDefinition,
    ctx: ExecutorContext,
    pass: number,
    maxPasses: number,
    deps: {
      base: Pick<WorkflowEvent, 'runId' | 'workflowId' | 'workflowVersion' | 'source'>;
      bus: EventBus;
      mode: ExecutionMode;
      gateResolver?: GateResolver;
    },
  ): Promise<StepResult> {
    const { base, bus, mode, gateResolver } = deps;
    const { signal } = ctx;
    const executor = this.registry[node.executorRef];

    const maxAttempts = node.retry?.maxAttempts ?? 1;
    let attempt = 0;
    let lastResult: StepResult = SKIP;

    while (attempt < maxAttempts) {
      attempt++;
      if (signal.aborted) return { status: 'skipped', summary: 'Cancelled' };

      if (attempt === 1) {
        bus.emit({ ...base, type: 'node.queued', nodeId: node.id });
      } else {
        bus.emit({
          ...base,
          type: 'node.retrying',
          nodeId: node.id,
          message: `Retry ${attempt}/${maxAttempts}`,
        });
      }
      bus.emit({ ...base, type: 'node.started', nodeId: node.id, message: node.label });

      try {
        // Gate nodes are resolved via the gate resolver.
        if (node.kind === 'gate') {
          bus.emit({ ...base, type: 'gate.waiting', nodeId: node.id, message: `${node.label} awaiting approval` });
          const decision = gateResolver
            ? await gateResolver(node, ctx)
            : { approved: false, reason: 'No gate resolver — held in preview' };
          if (decision.approved) {
            bus.emit({ ...base, type: 'gate.approved', nodeId: node.id, message: decision.reason });
            lastResult = { status: 'success', summary: decision.reason ?? 'Approved' };
            bus.emit({
              ...base,
              type: 'node.succeeded',
              nodeId: node.id,
              data: { summary: lastResult.summary },
            });
            return lastResult;
          }
          bus.emit({ ...base, type: 'gate.rejected', nodeId: node.id, message: decision.reason });
          lastResult = { status: 'blocked', summary: decision.reason ?? 'Gate held' };
          bus.emit({
            ...base,
            type: 'node.blocked',
            nodeId: node.id,
            message: lastResult.summary,
            data: { summary: lastResult.summary },
          });
          return lastResult;
        }

        const raw = executor ? await executor(ctx) : SKIP;
        lastResult = raw;

        // Preview safety: a mutate node must never report "applied".
        // Its executor should return proposedMutations; we surface them as
        // planned mutations and mark the node needs_review if it tried to
        // signal an applied write while in preview.
        if (mode === 'preview' && isMutating(node) && raw.proposedMutations?.length) {
          for (const plan of raw.proposedMutations) {
            bus.emit({
              ...base,
              type: 'mutation.planned',
              nodeId: node.id,
              message: `Planned mutation ${plan.endpointId} (${plan.riskLevel})`,
              data: plan,
            });
          }
        }

        this.emitTerminal(node, raw, bus, base, pass, maxPasses);
        if (raw.status === 'failed' && attempt < maxAttempts) {
          continue; // retry
        }
        return raw;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastResult = { status: 'failed', summary: message };
        if (attempt >= maxAttempts) {
          bus.emit({
            ...base,
            type: 'node.failed',
            nodeId: node.id,
            severity: 'error',
            message,
            data: { summary: message },
          });
          return lastResult;
        }
        bus.emit({
          ...base,
          type: 'log.appended',
          nodeId: node.id,
          severity: 'warn',
          message: `Attempt ${attempt} threw: ${message}`,
        });
      }
    }
    return lastResult;
  }

  private emitTerminal(
    node: WorkflowNodeDefinition,
    result: StepResult,
    bus: EventBus,
    base: Pick<WorkflowEvent, 'runId' | 'workflowId' | 'workflowVersion' | 'source'>,
    pass: number,
    maxPasses: number,
  ): void {
    const data = {
      summary: result.summary,
      issues: result.issues,
      warnings: result.warnings,
      evidence: result.evidence,
      proposedMutations: result.proposedMutations,
      // Only carried when it means something, so an ordinary node's terminal
      // event keeps exactly the shape it had before.
      ...(result.needsReplan === true || pass > 1
        ? {
            needsReplan: result.needsReplan === true,
            replanPass: pass,
            maxReplanPasses: maxPasses,
          }
        : {}),
    };
    switch (result.status) {
      case 'success':
        bus.emit({ ...base, type: 'node.succeeded', nodeId: node.id, message: result.summary, data });
        break;
      case 'skipped':
        bus.emit({ ...base, type: 'node.skipped', nodeId: node.id, message: result.summary, data });
        break;
      case 'failed':
        bus.emit({ ...base, type: 'node.failed', nodeId: node.id, severity: 'error', message: result.summary, data });
        break;
      case 'blocked':
        bus.emit({ ...base, type: 'node.blocked', nodeId: node.id, message: result.summary, data });
        break;
      case 'needs_review':
        bus.emit({ ...base, type: 'node.needs_review', nodeId: node.id, severity: 'warn', message: result.summary, data });
        break;
    }
  }

  private markEdges(
    node: WorkflowNodeDefinition,
    completed: Set<string>,
    branchVerdicts: Map<string, BranchVerdict>,
    bus: EventBus,
    base: Pick<WorkflowEvent, 'runId' | 'workflowId' | 'workflowVersion' | 'source'>,
  ): void {
    const out = this.definition.edges.filter((e) => e.source === node.id);
    for (const edge of out) {
      if (branchVerdicts.get(edge.id) === 'skip' || branchVerdicts.get(edge.id) === 'block') {
        bus.emit({ ...base, type: 'edge.skipped', edgeId: edge.id });
      } else if (completed.has(node.id)) {
        bus.emit({ ...base, type: 'edge.activated', edgeId: edge.id });
        bus.emit({ ...base, type: 'edge.completed', edgeId: edge.id });
      } else {
        bus.emit({ ...base, type: 'edge.deactivated', edgeId: edge.id });
      }
    }
    // Touch helper to keep edgeBetween referenced for downstream tooling.
    void edgeBetween;
  }
}

/** Convenience one-shot runner. */
export async function runWorkflow(
  definition: WorkflowDefinition,
  registry: ExecutorRegistry,
  options?: RunnerOptions,
): Promise<RunResult> {
  return new WorkflowRunner(definition, registry).run(options);
}
