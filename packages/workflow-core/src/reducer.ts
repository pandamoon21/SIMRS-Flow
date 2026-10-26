/**
 * Reducer — projects an ordered WorkflowEvent stream into RunState.
 *
 * This is the contract that makes runs replayable: feeding the same events
 * in the same order always yields the same RunState, with no access to the
 * runner, the network, or the clock. The UI renders RunState; it never
 * mutates it directly.
 */

import type {
  EdgeRuntimeState,
  ExecutionMode,
  GateState,
  MutationEventData,
  MutationOutcome,
  MutationPlan,
  NodeReplanState,
  NodeRuntimeState,
  NodeStatus,
  ReplanEventData,
  RunLogEntry,
  RunState,
  RunStatus,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowIssue,
} from './types.js';

function emptyNode(id: string): NodeRuntimeState {
  return {
    id,
    status: 'pending',
    attempt: 0,
    issues: [],
    warnings: [],
    evidence: [],
    proposedMutations: [],
    logs: [],
  };
}

/** Build the initial RunState for a definition before any events apply. */
export function initialRunState(
  definition: WorkflowDefinition,
  runId: string,
  mode: ExecutionMode,
): RunState {
  const nodes: Record<string, NodeRuntimeState> = {};
  for (const node of definition.nodes) {
    nodes[node.id] = emptyNode(node.id);
  }
  const edges: Record<string, EdgeRuntimeState> = {};
  for (const edge of definition.edges) {
    edges[edge.id] = { id: edge.id, status: 'idle' };
  }
  return {
    runId,
    workflowId: definition.id,
    workflowVersion: definition.version,
    mode,
    status: 'created',
    lastSeq: 0,
    nodes,
    edges,
    gates: {},
    mutations: {},
    logs: [],
    metrics: {},
  };
}

const EVENT_TO_NODE_STATUS: Partial<Record<WorkflowEvent['type'], NodeStatus>> = {
  'node.queued': 'queued',
  'node.started': 'running',
  'node.succeeded': 'success',
  'node.failed': 'failed',
  'node.skipped': 'skipped',
  'node.blocked': 'blocked',
  'node.needs_review': 'needs_review',
  'node.retrying': 'retrying',
};

function toMillis(iso?: string): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Seed a `planned` outcome for a proposed mutation.
 *
 * Called for every plan the run proposes, in either mode: the runner only emits
 * `mutation.planned` in preview, but a write run's plans arrive on the node's
 * terminal event, and both must show up per plan id. Existing entries are never
 * overwritten — a plan already carrying an outcome must not be reset to
 * `planned` by a later replay of the event that introduced it.
 */
function seedMutation(
  mutations: Record<string, MutationOutcome>,
  plan: MutationPlan,
  nodeId: string | undefined,
  ts: string,
): void {
  if (!plan || typeof plan !== 'object' || typeof plan.id !== 'string') return;
  if (mutations[plan.id]) return;
  mutations[plan.id] = {
    planId: plan.id,
    endpointId: plan.endpointId,
    status: 'planned',
    plannedAt: ts,
    ...(nodeId ? { nodeId } : {}),
    ...(plan.riskLevel ? { riskLevel: plan.riskLevel } : {}),
    ...(plan.idempotencyKey ? { idempotencyKey: plan.idempotencyKey } : {}),
  };
}

/** The `mutation.*` event types that carry an outcome for a single plan. */
const MUTATION_EVENT_STATUS = {
  'mutation.approved': 'approved',
  'mutation.applied': 'applied',
  'mutation.verified': 'verified',
  'mutation.failed': 'failed',
  'mutation.invalidated': 'invalidated',
} as const satisfies Partial<Record<WorkflowEvent['type'], MutationOutcome['status']>>;

/**
 * Fold one re-plan fact into a node's re-plan state. Absent fields keep their
 * previous value, so the state survives replay in the order the runner emits:
 * terminal(needsReplan) → `node.replanning` → terminal → … → `node.replan_exhausted`.
 */
function mergeReplan(
  prev: NodeReplanState | undefined,
  patch: Partial<NodeReplanState>,
): NodeReplanState {
  const reason = patch.reason ?? prev?.reason;
  return {
    pass: patch.pass ?? prev?.pass ?? 1,
    maxPasses: patch.maxPasses ?? prev?.maxPasses ?? 1,
    requested: patch.requested ?? prev?.requested ?? false,
    exhausted: patch.exhausted ?? prev?.exhausted ?? false,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function asIssues(data: unknown, key: 'issues' | 'warnings'): WorkflowIssue[] {
  if (data && typeof data === 'object' && key in (data as Record<string, unknown>)) {
    const arr = (data as Record<string, unknown>)[key];
    if (Array.isArray(arr)) return arr as WorkflowIssue[];
  }
  return [];
}

/**
 * Apply a single event to a state, returning a new state.
 * Pure: never mutates the input state object graph in place beyond cloning.
 */
export function applyEvent(state: RunState, event: WorkflowEvent): RunState {
  const next: RunState = {
    ...state,
    lastSeq: event.seq,
    nodes: { ...state.nodes },
    edges: { ...state.edges },
    gates: { ...state.gates },
    mutations: { ...state.mutations },
    logs: state.logs,
    metrics: state.metrics,
  };

  // Always capture log-bearing events into the run log and per-node log.
  const logBearing =
    event.message !== undefined ||
    event.type === 'log.appended' ||
    event.severity === 'error';
  if (logBearing && event.message !== undefined) {
    const entry: RunLogEntry = {
      ts: event.ts,
      seq: event.seq,
      severity: event.severity ?? 'info',
      message: event.message,
      nodeId: event.nodeId,
      data: event.data,
    };
    next.logs = [...state.logs, entry];
    if (event.nodeId && next.nodes[event.nodeId]) {
      const n = next.nodes[event.nodeId]!;
      next.nodes[event.nodeId] = { ...n, logs: [...n.logs, entry] };
    }
  }

  switch (event.type) {
    case 'run.created':
      next.status = 'created';
      next.createdAt = event.ts;
      break;
    case 'run.started':
      next.status = 'running';
      next.startedAt = event.ts;
      break;
    case 'run.paused':
      next.status = 'paused';
      break;
    case 'run.resumed':
      next.status = 'running';
      break;
    case 'run.cancelled':
      next.status = 'cancelled';
      next.finishedAt = event.ts;
      break;
    case 'run.completed':
      next.status = 'completed';
      next.finishedAt = event.ts;
      if (typeof event.message === 'string') next.summary = event.message;
      break;
    case 'run.failed':
      next.status = 'failed';
      next.finishedAt = event.ts;
      if (typeof event.message === 'string') next.summary = event.message;
      break;

    case 'node.queued':
    case 'node.started':
    case 'node.succeeded':
    case 'node.failed':
    case 'node.skipped':
    case 'node.blocked':
    case 'node.needs_review':
    case 'node.retrying': {
      if (!event.nodeId) break;
      const prev = next.nodes[event.nodeId] ?? emptyNode(event.nodeId);
      const status = EVENT_TO_NODE_STATUS[event.type] ?? prev.status;
      const updated: NodeRuntimeState = { ...prev, status };
      const data = (event.data ?? {}) as Record<string, unknown>;

      if (event.type === 'node.started') {
        updated.startedAt = event.ts;
        updated.attempt = prev.attempt + 1;
      }
      if (event.type === 'node.retrying') {
        updated.attempt = prev.attempt + 1;
      }
      if (
        event.type === 'node.succeeded' ||
        event.type === 'node.failed' ||
        event.type === 'node.skipped' ||
        event.type === 'node.blocked' ||
        event.type === 'node.needs_review'
      ) {
        updated.finishedAt = event.ts;
        const start = toMillis(updated.startedAt);
        const end = toMillis(event.ts);
        if (start !== undefined && end !== undefined) {
          updated.durationMs = Math.max(0, end - start);
        }
        if (typeof data.summary === 'string') updated.summary = data.summary;
        const issues = asIssues(data, 'issues');
        const warnings = asIssues(data, 'warnings');
        if (issues.length) updated.issues = [...prev.issues, ...issues];
        if (warnings.length) updated.warnings = [...prev.warnings, ...warnings];
        if (Array.isArray(data.evidence)) {
          updated.evidence = [...prev.evidence, ...(data.evidence as never[])];
        }
        if (Array.isArray(data.proposedMutations)) {
          updated.proposedMutations = [
            ...prev.proposedMutations,
            ...(data.proposedMutations as never[]),
          ];
          for (const plan of data.proposedMutations as MutationPlan[]) {
            seedMutation(next.mutations, plan, event.nodeId, event.ts);
          }
        }
        // A pass that asks for another one, or any pass after the first, is
        // recorded so the operator (and a replay) can see the loop.
        if (data.needsReplan === true || prev.replan) {
          updated.replan = mergeReplan(prev.replan, {
            requested: data.needsReplan === true,
            ...(typeof data.replanPass === 'number' ? { pass: data.replanPass } : {}),
            ...(typeof data.maxReplanPasses === 'number'
              ? { maxPasses: data.maxReplanPasses }
              : {}),
          });
        }
      }
      next.nodes[event.nodeId] = updated;
      break;
    }

    case 'node.replanning':
    case 'node.replan_exhausted': {
      if (!event.nodeId) break;
      const prev = next.nodes[event.nodeId] ?? emptyNode(event.nodeId);
      const data = (event.data ?? {}) as Partial<ReplanEventData>;
      const refused = event.type === 'node.replan_exhausted';
      next.nodes[event.nodeId] = {
        ...prev,
        // Neither event changes the node's status: the pass that just ran
        // already reported it, and `node.started` reports the next one.
        replan: mergeReplan(prev.replan, {
          ...(typeof data.pass === 'number' ? { pass: data.pass } : {}),
          ...(typeof data.maxPasses === 'number' ? { maxPasses: data.maxPasses } : {}),
          requested: refused,
          exhausted: refused,
          ...(data.reason !== undefined ? { reason: data.reason } : {}),
        }),
      };
      break;
    }

    case 'edge.activated':
    case 'edge.completed':
    case 'edge.skipped':
    case 'edge.deactivated': {
      if (!event.edgeId) break;
      const status =
        event.type === 'edge.activated'
          ? 'active'
          : event.type === 'edge.completed'
            ? 'completed'
            : event.type === 'edge.skipped'
              ? 'skipped'
              : 'idle';
      next.edges[event.edgeId] = { id: event.edgeId, status };
      break;
    }

    case 'gate.waiting':
    case 'gate.approved':
    case 'gate.rejected':
    case 'gate.expired': {
      if (!event.nodeId) break;
      const prevGate = next.gates[event.nodeId];
      const gate: GateState = {
        nodeId: event.nodeId,
        status:
          event.type === 'gate.waiting'
            ? 'waiting'
            : event.type === 'gate.approved'
              ? 'approved'
              : event.type === 'gate.rejected'
                ? 'rejected'
                : 'expired',
        requestedAt: prevGate?.requestedAt ?? event.ts,
        resolvedAt: event.type === 'gate.waiting' ? undefined : event.ts,
        reason: event.message ?? prevGate?.reason,
      };
      next.gates[event.nodeId] = gate;
      // Reflect gate state on the node for the UI.
      if (next.nodes[event.nodeId]) {
        const n = next.nodes[event.nodeId]!;
        next.nodes[event.nodeId] = {
          ...n,
          status: event.type === 'gate.waiting' ? 'gate_waiting' : n.status,
        };
      }
      break;
    }

    case 'metric.updated': {
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (typeof data.key === 'string' && typeof data.value === 'number') {
        next.metrics = { ...state.metrics, [data.key]: data.value };
      }
      break;
    }

    case 'mutation.planned': {
      // The runner emits this in preview with the whole plan as `data`.
      seedMutation(next.mutations, event.data as MutationPlan, event.nodeId, event.ts);
      break;
    }

    case 'mutation.approved':
    case 'mutation.applied':
    case 'mutation.verified':
    case 'mutation.failed':
    case 'mutation.invalidated': {
      const data = (event.data ?? {}) as MutationEventData;
      if (typeof data.planId !== 'string' || data.planId === '') break;
      const status = MUTATION_EVENT_STATUS[event.type];
      const prev = next.mutations[data.planId];
      // Events arrive in causal order, so the event type is the outcome. An
      // out-of-order replay cannot happen within a run: the ledger is append
      // only and the reducer consumes it in `seq` order.
      const outcome: MutationOutcome = {
        planId: data.planId,
        endpointId: prev?.endpointId ?? data.endpointId ?? 'unknown',
        ...prev,
        status,
        ...(event.nodeId ? { nodeId: event.nodeId } : {}),
        ...(data.riskLevel ? { riskLevel: data.riskLevel } : {}),
        ...(data.idempotencyKey ? { idempotencyKey: data.idempotencyKey } : {}),
        ...(data.approvedBy ? { approvedBy: data.approvedBy } : {}),
        ...(data.phase ? { phase: data.phase } : {}),
        ...(data.reason !== undefined ? { reason: data.reason } : {}),
        ...(data.ambiguous !== undefined ? { ambiguous: data.ambiguous } : {}),
        ...(data.preconditionResults ? { preconditionResults: data.preconditionResults } : {}),
        ...(data.verificationResults ? { verificationResults: data.verificationResults } : {}),
      };
      if (event.type === 'mutation.approved') outcome.approvedAt = event.ts;
      if (event.type === 'mutation.applied') outcome.appliedAt = event.ts;
      if (
        event.type === 'mutation.verified' ||
        event.type === 'mutation.failed' ||
        event.type === 'mutation.invalidated'
      ) {
        outcome.settledAt = event.ts;
      }
      next.mutations[data.planId] = outcome;
      break;
    }

    // artifact.* is captured via the node-log path above.
    default:
      break;
  }

  return next;
}

/** Reduce a full event list into a final RunState. */
export function reduceEvents(
  definition: WorkflowDefinition,
  runId: string,
  mode: ExecutionMode,
  events: readonly WorkflowEvent[],
): RunState {
  let state = initialRunState(definition, runId, mode);
  for (const event of events) {
    state = applyEvent(state, event);
  }
  return state;
}

/** Convenience: which run statuses are terminal. */
export function isTerminalStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
