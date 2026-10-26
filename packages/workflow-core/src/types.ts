/**
 * Core contracts for SIMRS-Flow.
 *
 * These types are the single source of truth shared by the runner, the
 * orchestrator, the domain packages, and the React Flow UI. They are
 * intentionally framework-agnostic — nothing here imports React or Node.
 */

import type { ExpectationMatch } from './expectations.js';
import type { Clock } from './ids.js';

// ───────────────────────────────────────────────────────────────
// Definition
// ───────────────────────────────────────────────────────────────

export type WorkflowDomain = 'rajal' | 'ranap';

export type NodeKind =
  | 'input'
  | 'read'
  | 'validate'
  | 'plan'
  | 'mutate'
  | 'verify'
  | 'gate'
  | 'summary';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type EdgeKind =
  | 'sequential'
  | 'branch'
  | 'merge'
  | 'parallel'
  | 'guard';

export interface RetryPolicy {
  /** Maximum attempts including the first try. */
  maxAttempts: number;
  /** Base delay in ms; runner may apply backoff. */
  delayMs: number;
  /** Multiplier applied to delay each retry (1 = constant). */
  backoff?: number;
}

export interface WorkflowNodeUi {
  position?: { x: number; y: number };
  icon?: string;
  color?: string;
  description?: string;
  /** Id of a `layout.phases` entry: the canvas column this node belongs to. */
  phase?: string;
}

export interface WorkflowNodeDefinition {
  id: string;
  label: string;
  group: string;
  kind: NodeKind;
  /** Key resolved against the executor registry, e.g. "ranap.loadVisits". */
  executorRef: string;
  /** If true, a failure here fails the whole run. */
  critical: boolean;
  defaultEnabled: boolean;
  timeoutMs?: number;
  retry?: RetryPolicy;
  riskLevel?: RiskLevel;
  ui?: WorkflowNodeUi;
}

export interface WorkflowEdgeDefinition {
  id: string;
  source: string;
  target: string;
  type?: EdgeKind;
  /** Optional condition key evaluated against run context. */
  condition?: string;
  label?: string;
}

export interface WorkflowGroup {
  id: string;
  label: string;
  color?: string;
}
/** An ordered canvas column — one step of the operator-facing flow. */
export interface WorkflowPhase {
  id: string;
  label: string;
  description: string;
}

export interface WorkflowLayout {
  groups?: WorkflowGroup[];
  /** Ordered left→right columns; when present every node must name one. */
  phases?: WorkflowPhase[];
  /** Whether the UI should auto-layout or honor node ui.position. */
  mode?: 'manual' | 'auto';
}

export interface WorkflowPolicy {
  /** Default execution mode when a run is created. */
  defaultMode?: ExecutionMode;
  /** Endpoint ids allowed to mutate in write mode. */
  mutationAllowlist?: string[];
}

export interface WorkflowDefinition {
  id: string;
  version: string;
  label: string;
  domain: WorkflowDomain;
  inputSchema?: unknown;
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
  layout?: WorkflowLayout;
  policies?: WorkflowPolicy;
}

// ───────────────────────────────────────────────────────────────
// Execution mode & status
// ───────────────────────────────────────────────────────────────

export type ExecutionMode = 'preview' | 'write';

export type NodeStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'success'
  | 'skipped'
  | 'failed'
  | 'blocked'
  | 'needs_review'
  | 'gate_waiting'
  | 'retrying';

export type RunStatus =
  | 'created'
  | 'running'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'failed';

export type EdgeStatus = 'idle' | 'active' | 'completed' | 'skipped' | 'failed';

// ───────────────────────────────────────────────────────────────
// Step results
// ───────────────────────────────────────────────────────────────

export type IssueSeverity = 'info' | 'warn' | 'error';

export interface WorkflowIssue {
  code: string;
  message: string;
  severity: IssueSeverity;
  data?: unknown;
}

export interface Evidence {
  label: string;
  /** Endpoint id or source that produced this evidence. */
  source?: string;
  data?: unknown;
}

/**
 * A read-before-write guard. Replayed by the orchestrator's mutation gate
 * immediately before the write fires (`apps/orchestrator/src/mutationGate.ts`);
 * if it no longer holds, the write is refused and `mutation.invalidated` is
 * emitted. A guard that cannot be evaluated fails closed.
 */
export interface Precondition {
  description: string;
  /** Read endpoint id re-called at write time, e.g. `kasir.cekStatusVerifikasi`. */
  check: string;
  /**
   * What that read must still answer. Compared with the tolerant comparator in
   * `expectations.ts`, not with `===`, because the backend spells the same
   * answer as `''`, `'0'`, `[]`, `{}` or `{total: 0}` depending on endpoint.
   */
  expected: unknown;
  /**
   * Request body for the replay read. Defaults to the plan's `payload`, then to
   * the string-valued fields of its `payloadSummary` — so a per-line-item check
   * (e.g. `penatajasaInap.cekStatusVerifikasi`, which needs `kd_tindakan` and
   * `urut_tindakan`) must set this explicitly or it cannot address its row.
   */
  payload?: Record<string, string>;
  /** Query params for the replay read (used for `GET` read endpoints). */
  query?: Record<string, string>;
  /** Optional row selector for row-shaped JSON responses. */
  where?: Record<string, unknown>;
  /** Field (or dotted path) to read out of a JSON response before comparing. */
  field?: string;
  /** Explicit comparison; inferred from `expected` when omitted. */
  match?: ExpectationMatch;
}

/**
 * A read-after-write check. Replayed once the write has been applied; all rules
 * on a plan must hold or `mutation.failed` is emitted (the write may have
 * half-landed).
 */
export interface VerificationRule {
  description: string;
  /** Endpoint id used to read state after the write. */
  endpointId: string;
  /** Optional row selector for row-shaped JSON responses. */
  where?: Record<string, unknown>;
  /** Field path that must match expected after the write. */
  field: string;
  expected: unknown;
  /** Request body for the verification read; defaults as for `Precondition`. */
  payload?: Record<string, string>;
  /** Query params for the verification read (used for `GET` read endpoints). */
  query?: Record<string, string>;
  /** Explicit comparison; inferred from `expected` when omitted. */
  match?: ExpectationMatch;
}

export interface MutationPlan {
  id: string;
  endpointId: string;
  riskLevel: RiskLevel;
  reason: string;
  preconditions: Precondition[];
  /**
   * Human-facing digest of the write, for the approver and the audit trail.
   * It is NOT the request body: the orchestrator refuses to apply a plan that
   * carries no `payload`, because sending a summary to a mutating endpoint
   * would write the wrong thing.
   */
  payloadSummary: Record<string, unknown>;
  requiresApproval: boolean;
  idempotencyKey: string;
  /**
   * The exact form body the mutating endpoint is called with. Required for the
   * orchestrator to apply the plan; a plan without it is review-only and the
   * gate refuses it (fail closed).
   */
  payload?: Record<string, string>;
  /** Query params for the write (used for `GET` mutating endpoints, if any). */
  query?: Record<string, string>;
  /**
   * Single read-after-write rule. Retained for existing callers; treated as a
   * one-element list. Prefer `readAfterWriteChecks`.
   */
  readAfterWriteCheck?: VerificationRule;
  /**
   * Read-after-write rules as a conjunction — **the preferred form**. The
   * legacy confirmation is often two reads at once (`_confirm_verifikasi_state`,
   * ranap_v3.py:15371, requires `cekstatus_verifikasi == "1"` *and* no new
   * penunjang blocker), which one triple cannot express. Every rule must hold;
   * when both fields are set, the effective set is their concatenation.
   */
  readAfterWriteChecks?: VerificationRule[];
}

/**
 * All read-after-write rules declared by a plan, singular field first.
 *
 * Both fields are honoured so no existing caller breaks; the result is a
 * conjunction — every rule must hold for the write to count as verified.
 */
export function verificationRulesOf(plan: MutationPlan): VerificationRule[] {
  return [
    ...(plan.readAfterWriteCheck ? [plan.readAfterWriteCheck] : []),
    ...(plan.readAfterWriteChecks ?? []),
  ];
}

// ───────────────────────────────────────────────────────────────
// Mutation outcomes (read-before/after-write enforcement)
// ───────────────────────────────────────────────────────────────

/** Which stage of the write a check or failure belongs to. */
export type MutationPhase = 'precondition' | 'write' | 'verify';

/** One replayed precondition or verification rule and what it saw. */
export interface MutationCheckResult {
  description: string;
  /** Read endpoint that was re-called. */
  endpointId: string;
  expected: unknown;
  /** Comparison used (explicit or inferred). */
  match?: ExpectationMatch;
  /** Short rendering of what the read answered. */
  observed?: string;
  /** True only when the check demonstrably still holds. */
  holds: boolean;
  /** One-line explanation of the verdict. */
  reason?: string;
  /**
   * Set when the check could not be evaluated at all (read failed, endpoint
   * unknown, no addressable payload). Always accompanied by `holds: false` —
   * an unevaluable check fails closed.
   */
  error?: string;
  /** Where the read's request body came from. */
  payloadSource?: 'check' | 'plan' | 'payloadSummary';
}

/**
 * Lifecycle of a single mutation plan within a run.
 *
 * `planned` → `approved` → (`invalidated` | `applied`) → (`verified` | `failed`).
 * `applied` without `verified` means the write landed but has not been
 * confirmed; `failed` after `applied` means the confirmation did not match and
 * the write may have half-landed.
 */
export type MutationOutcomeStatus =
  | 'planned'
  | 'approved'
  | 'invalidated'
  | 'applied'
  | 'verified'
  | 'failed';

/**
 * Per-plan write outcome projected onto `RunState.mutations`, keyed by plan id.
 * This is what lets a later step (or the ledger) tell a *planned* write from a
 * *landed* one.
 */
export interface MutationOutcome {
  planId: string;
  endpointId: string;
  status: MutationOutcomeStatus;
  /** Node that proposed the plan. */
  nodeId?: string;
  riskLevel?: RiskLevel;
  idempotencyKey?: string;
  plannedAt?: string;
  approvedAt?: string;
  appliedAt?: string;
  /** Timestamp of the terminal event (verified / failed / invalidated). */
  settledAt?: string;
  /** Distinct operators who approved (two for `critical`). */
  approvedBy?: string[];
  /** Operator-facing explanation of a refusal or failure. */
  reason?: string;
  /** Stage a refusal/failure happened in. */
  phase?: MutationPhase;
  /**
   * True when the write may have landed despite the failure (e.g. a transport
   * timeout) and must be reconciled by hand.
   */
  ambiguous?: boolean;
  preconditionResults?: MutationCheckResult[];
  verificationResults?: MutationCheckResult[];
}

/** Payload carried by every `mutation.*` event (the reducer reads these). */
export interface MutationEventData {
  planId: string;
  endpointId: string;
  riskLevel?: RiskLevel;
  idempotencyKey?: string;
  status?: MutationOutcomeStatus;
  phase?: MutationPhase;
  reason?: string;
  ambiguous?: boolean;
  approvedBy?: string[];
  preconditionResults?: MutationCheckResult[];
  verificationResults?: MutationCheckResult[];
}

export type StepStatus =
  | 'success'
  | 'failed'
  | 'skipped'
  | 'blocked'
  | 'needs_review';

export type BranchVerdict = 'take' | 'skip' | 'block';

export interface StepResult<TData = unknown> {
  status: StepStatus;
  summary: string;
  /** Verdicts keyed by outgoing edge id; conditional edges require a valid verdict. */
  branches?: Record<string, BranchVerdict>;
  data?: TData;
  issues?: WorkflowIssue[];
  warnings?: WorkflowIssue[];
  proposedMutations?: MutationPlan[];
  evidence?: Evidence[];
  /**
   * "I cannot finish planning until the mutations I just proposed have landed."
   *
   * The legacy script writes inline and re-reads immediately: it adds a charge
   * line and then re-dates it, changes a date and retries the rows that did not
   * move (`_find_unmatched_updated_rows`, ranap_v3.py:4049). Plan → approve →
   * apply splits that in two, so a node whose follow-up work depends on
   * backend-assigned state (a new row's `urut_tindakan`) sets this to ask for
   * another pass.
   *
   * What the engine then does (`WorkflowRunner` + `RunService`):
   *  - **write runs only** — preview applies nothing, so nothing can have
   *    changed and the flag is recorded but never acted on;
   *  - the node's terminal event fires first, so the operator can see and
   *    approve the plans;
   *  - once every plan *this pass* proposed reaches a terminal outcome
   *    (`verified` / `failed` / `invalidated`) **and at least one was applied**,
   *    the node's executor is called again with the same `scratch`, an
   *    incremented `ctx.pass`, and `ctx.mutations` showing the real outcomes;
   *  - passes are capped (`RunnerOptions.maxReplanPasses`, default
   *    {@link DEFAULT_MAX_REPLAN_PASSES}). Hitting the cap emits
   *    `node.replan_exhausted` and stops — a loop that will not converge must
   *    report, not spin.
   *
   * Setting it does not weaken any control: a re-plan only re-runs the
   * *planner*. Every write still goes through approval and the mutation gate.
   */
  needsReplan?: boolean;
}

// ───────────────────────────────────────────────────────────────
// Events
// ───────────────────────────────────────────────────────────────

export const EVENT_SCHEMA = 'simrs.workflow.event.v1' as const;

export type EventSource =
  | 'runner'
  | 'ui'
  | 'api'
  | 'python-bridge'
  | 'legacy-adapter';

export type WorkflowEventType =
  // run lifecycle
  | 'run.created'
  | 'run.started'
  | 'run.paused'
  | 'run.resumed'
  | 'run.cancelled'
  | 'run.completed'
  | 'run.failed'
  // node lifecycle
  | 'node.queued'
  | 'node.started'
  | 'node.progress'
  | 'node.succeeded'
  | 'node.failed'
  | 'node.skipped'
  | 'node.blocked'
  | 'node.needs_review'
  | 'node.retrying'
  // re-plan passes (a node re-reading after its mutations landed)
  | 'node.replanning'
  | 'node.replan_exhausted'
  // edges
  | 'edge.activated'
  | 'edge.completed'
  | 'edge.deactivated'
  | 'edge.skipped'
  // gates
  | 'gate.waiting'
  | 'gate.approved'
  | 'gate.rejected'
  | 'gate.expired'
  // mutations
  | 'mutation.planned'
  | 'mutation.approved'
  | 'mutation.applied'
  | 'mutation.verified'
  | 'mutation.failed'
  | 'mutation.invalidated'
  // logs & metrics
  | 'log.appended'
  | 'metric.updated'
  | 'artifact.created';

export interface WorkflowEvent {
  schema: typeof EVENT_SCHEMA;
  eventId: string;
  /** Monotonic sequence number within a run, starting at 1. */
  seq: number;
  ts: string;
  runId: string;
  workflowId: string;
  workflowVersion: string;
  type: WorkflowEventType;
  source: EventSource;
  nodeId?: string;
  edgeId?: string;
  severity?: IssueSeverity | 'debug';
  message?: string;
  data?: unknown;
}

/** Fields a caller supplies; envelope fields are filled by the bus. */
export type WorkflowEventInput = Omit<
  WorkflowEvent,
  'schema' | 'eventId' | 'seq' | 'ts'
>;

// ───────────────────────────────────────────────────────────────
// Projected run state (reducer output → UI)
// ───────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────
// Re-plan passes
// ───────────────────────────────────────────────────────────────

/**
 * Hard cap on how many times one node's executor may run in a single run,
 * counting the first pass. Two re-plans is enough for the legacy repair loops
 * (add → re-read → re-date), and small enough that a non-converging planner
 * stops loudly instead of spinning.
 */
export const DEFAULT_MAX_REPLAN_PASSES = 3;

/**
 * Re-plan bookkeeping projected onto a node, so an operator (and a replay) can
 * see that a node ran more than once and why it stopped.
 */
export interface NodeReplanState {
  /** Passes executed so far; 1 is the first, ordinary pass. */
  pass: number;
  /** Cap in force for this node, including the first pass. */
  maxPasses: number;
  /** The most recently finished pass asked for another one. */
  requested: boolean;
  /**
   * A request for another pass was refused — the cap was reached, nothing was
   * applied, or the run was cancelled. The node's own status is unchanged.
   */
  exhausted: boolean;
  /** Why the last pass was granted or refused. */
  reason?: string;
}

/** Payload carried by `node.replanning` and `node.replan_exhausted`. */
export interface ReplanEventData {
  /** Pass number: the one starting (`node.replanning`) or the last one run. */
  pass: number;
  maxPasses: number;
  reason?: string;
  /** Plan ids whose outcomes triggered (or failed to trigger) the pass. */
  planIds?: string[];
}

export interface NodeRuntimeState {
  id: string;
  status: NodeStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  attempt: number;
  summary?: string;
  issues: WorkflowIssue[];
  warnings: WorkflowIssue[];
  evidence: Evidence[];
  proposedMutations: MutationPlan[];
  logs: RunLogEntry[];
  /** Present only once the node has asked for, or been through, a re-plan. */
  replan?: NodeReplanState;
}

export interface EdgeRuntimeState {
  id: string;
  status: EdgeStatus;
}

export interface RunLogEntry {
  ts: string;
  seq: number;
  severity: IssueSeverity | 'debug';
  message: string;
  nodeId?: string;
  data?: unknown;
}

export interface GateState {
  nodeId: string;
  status: 'waiting' | 'approved' | 'rejected' | 'expired';
  requestedAt: string;
  resolvedAt?: string;
  reason?: string;
}

export interface RunState {
  runId: string;
  workflowId: string;
  workflowVersion: string;
  mode: ExecutionMode;
  status: RunStatus;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  lastSeq: number;
  nodes: Record<string, NodeRuntimeState>;
  edges: Record<string, EdgeRuntimeState>;
  gates: Record<string, GateState>;
  /**
   * Per-plan write outcome, keyed by `MutationPlan.id`. Seeded as `planned` from
   * every proposed mutation, then advanced by the `mutation.*` events, so a
   * summary step can distinguish "verification was planned" from "verification
   * landed and was confirmed".
   */
  mutations: Record<string, MutationOutcome>;
  logs: RunLogEntry[];
  metrics: Record<string, number>;
  summary?: string;
}

// ───────────────────────────────────────────────────────────────
// Runner contracts
// ───────────────────────────────────────────────────────────────

export interface ExecutorContext {
  runId: string;
  mode: ExecutionMode;
  /** Mutable bag of data shared across nodes in a run. */
  scratch: Record<string, unknown>;
  /** Original run input. */
  input: unknown;
  /** Emit a log line tied to the current node. */
  log: (message: string, severity?: IssueSeverity | 'debug', data?: unknown) => void;
  /** Cooperative cancellation signal. */
  signal: AbortSignal;
  /**
   * The run's injected clock — **the only time source an executor may read**.
   *
   * `new Date()`, `Date.now()` and friends break replay: a recorded run fed
   * back through the reducer would not reproduce its own state. This is the
   * same `Clock` the runner and the EventBus stamp events with, so a test that
   * passes `fixedClock()` gets byte-identical event streams (and byte-identical
   * `MutationPlan` payloads) across runs.
   *
   * Read it as `ctx.clock.now()` — e.g. where `_build_update_datetime`
   * (ranap_v3.py) stamps `datetime.now()` onto a target date.
   *
   * Note `fixedClock()` advances on every call, so read it once per decision
   * and reuse the value rather than calling it repeatedly.
   */
  readonly clock: Clock;
  /**
   * Every mutation this run has proposed so far, keyed by `MutationPlan.id`,
   * with its real outcome — a snapshot taken when the property is read.
   *
   * This is how a summary step tells a *planned* write from a *landed* one
   * (`emit_summary` emits a row only for a registration that verified,
   * ranap_v3.py:16828). Read `outcome.status`:
   *
   * | status | meaning |
   * |---|---|
   * | `planned` | proposed; nobody has approved it |
   * | `approved` | approved, gate running, nothing written yet |
   * | `invalidated` | refused before the write — a precondition no longer held; **nothing was sent** |
   * | `applied` | the write landed but the plan declared no read-after-write rule, so it is unconfirmed |
   * | `verified` | the write landed **and** every read-after-write rule held |
   * | `failed` | the write was rejected, or landed and did not read back correctly (check `phase` and `ambiguous`) |
   *
   * `appliedAt` is set iff the write actually fired. `preconditionResults` /
   * `verificationResults` carry the replayed checks and what each one observed.
   * A plan id absent from this map was never proposed by this run.
   *
   * Read-only: the object is a copy, and writing to it changes nothing. The
   * only way to affect a mutation is to propose a `MutationPlan`.
   */
  readonly mutations: Readonly<Record<string, Readonly<MutationOutcome>>>;
  /**
   * Which pass of this node is running: 1 on the ordinary pass, 2+ when the
   * previous pass set {@link StepResult.needsReplan} and its mutations landed.
   * On a pass > 1 the executor is expected to re-read and plan the follow-up
   * work it could not address before (`urut_tindakan` is now assigned).
   */
  readonly pass: number;
  /** Cap on `pass` for this node. `pass === maxPasses` is the last chance. */
  readonly maxPasses: number;
}

export type NodeExecutor<TData = unknown> = (
  ctx: ExecutorContext,
) => Promise<StepResult<TData>> | StepResult<TData>;

export type ExecutorRegistry = Record<string, NodeExecutor>;

// ───────────────────────────────────────────────────────────────
// Rule catalog (generated from executor source by scripts/gen-rule-catalog.ts)
// ───────────────────────────────────────────────────────────────

/** One endpoint a step touches, copied from the EvoMedis registry. */
export interface RuleCatalogEndpoint {
  id: string;
  kind: 'read' | 'mutate' | 'auth';
  riskLevel: RiskLevel;
  description: string;
}

/**
 * What one node's executor can conclude and touch. Texts are the literal
 * summaries/messages in source; `…` marks a value filled in at runtime.
 */
export interface RuleCatalogEntry {
  nodeId: string;
  executorRef: string;
  outcomes: ReadonlyArray<{ status: StepStatus; text: string }>;
  issues: ReadonlyArray<{ code: string; text: string }>;
  /** Detail reasons collected into a list (`hard.push('…')`) and joined into a summary. */
  findings: readonly string[];
  /** Writes the step can plan, with the plan's `reason` text. */
  actions: ReadonlyArray<{ endpointId: string; text: string }>;
  reads: readonly string[];
  writes: readonly string[];
}

export interface RuleCatalog {
  workflowId: string;
  entries: readonly RuleCatalogEntry[];
  endpoints: Readonly<Record<string, RuleCatalogEndpoint>>;
}
