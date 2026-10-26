/**
 * RunService — the orchestration core.
 *
 * Owns the lifecycle of runs: create, start, stream events (SSE), resolve
 * gates, cancel, and export JSONL. It bridges the headless WorkflowRunner to
 * HTTP by:
 *   - subscribing to the run's EventBus and fanning events out to SSE clients,
 *   - persisting every event to the append-only audit ledger (redacted),
 *   - holding gate decisions so the runner can await operator approval.
 *
 * Write-mode safety wiring lives here (the engine stays generic):
 *   - #3  the workflow's `mutationAllowlist` is passed into the client,
 *   - #10 a per-transaction lock prevents two write runs racing one record,
 *   - two-person approval is required for `critical`-risk gates,
 *   - #4/#5/#6 an approved mutation is applied only through the mutation gate,
 *     which replays the plan's preconditions immediately before the write and
 *     its read-after-write rules immediately after (see `mutationGate.ts`),
 *   - a real FetchTransport is used only for `source: "live"` runs with
 *     credentials configured; everything else stays fixture-backed.
 *
 * Runs execute in-process. For an MVP this is sufficient and keeps the audit
 * trail authoritative. A future version can move execution to a worker.
 */

import type { BerkasReaderPort } from '@simrs-flow/domain-ranap';
import {
  EventBus,
  WorkflowRunner,
  generateRunId,
  initialRunState,
  applyEvent,
  isTerminalStatus,
  reduceEvents,
  verificationRulesOf,
  type ExecutionMode,
  type GateResolver,
  type MutationOutcomeStatus,
  type MutationPlan,
  type ReplanDecision,
  type ReplanResolver,
  type RunState,
  type WorkflowEvent,
  type WorkflowNodeDefinition,
} from '@simrs-flow/workflow-core';
import { endpointLabel, FetchTransport, type EvoMedisClient } from '@simrs-flow/evomedis-client';
import type {
  HistoricalRunStatus,
  Ledger,
  LedgerHistory,
} from '@simrs-flow/audit-ledger';
import { getWorkflow, type ExecutorFactoryArgs, type WorkflowEntry } from './registry.js';
import { deriveLockKeys, lockKeyLabel, TransactionLocks } from './locks.js';
import { applyApprovedMutation, type MutationApplyResult } from './mutationGate.js';
import { ReloginTransport } from './reloginTransport.js';
import { QaTransport, qaFixtures, qaFixtureTransport, type QaRunOptions } from './qaTransport.js';
import type { UserSessionStore } from './sessions.js';
import { applyRules, type RuleStore } from './rules.js';

type EventSink = (event: WorkflowEvent) => void;

interface GateWaiter {
  resolve: (decision: { approved: boolean; reason?: string }) => void;
  /** Distinct operators who have approved this gate so far. */
  approvals: Set<string>;
  /** Approvals required before the gate resolves (1, or 2 for critical). */
  required: number;
}

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
const MUTATION_SETTLING_EVENTS: ReadonlySet<WorkflowEvent['type']> = new Set([
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
function replanDecision(state: RunState, planIds: string[]): ReplanDecision | undefined {
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

interface RunHandle {
  runId: string;
  workflowId: string;
  mode: ExecutionMode;
  operator?: string;
  state: RunState;
  events: WorkflowEvent[];
  ledgerWrites: Promise<void>;
  /** First audit-write failure, if any. Surfaced on the run summary. */
  ledgerError?: string;
  bus: EventBus;
  controller: AbortController;
  sinks: Set<EventSink>;
  /** Pending gate approvals keyed by nodeId. */
  gates: Map<string, GateWaiter>;
  /** Nodes parked awaiting a re-plan decision, keyed by nodeId. */
  replans: Map<string, ReplanWaiter>;
  /** Client used by the mutation gate; write runs only. */
  client?: EvoMedisClient;
  /** Distinct operators who have approved each mutation plan, keyed by plan id. */
  mutationApprovals: Map<string, Set<string>>;
  /** Plan ids whose apply is in flight (guards against a double submit). */
  applying: Set<string>;
  /**
   * True while `autoApprovePlans` is sweeping. Approving emits events that
   * re-enter the bus subscriber, so the sweep needs its own latch.
   */
  autoApproving?: boolean;
  /** Plan ids auto-approve has already fired, so a re-entry cannot repeat one. */
  swept: Set<string>;
  /**
   * Auto-approved writes run one at a time per run. Fired in parallel, two
   * tampung bayar hit the cashier at once and one came back as a backend error
   * page; sent alone, the same plan landed (live 2026-10-20).
   */
  autoQueue: Promise<void>;
  finished: Promise<void>;
  /** Set while paused: the runner parks on it before its next step. */
  pause?: { promise: Promise<void>; resolve: () => void };
}

export type RunSource = 'fixture' | 'live';

export interface CreateRunInput {
  workflowId: string;
  mode?: ExecutionMode;
  input?: unknown;
  enabled?: Record<string, boolean>;
  /** Authenticated operator (required for write runs). */
  operator?: string;
  /** Session token of the logged-in user, supplying their EvoMedis cookie. */
  sessionToken?: string;
  /** `live` calls the real SIMRS; `fixture` (default) replays canned data. */
  source?: RunSource;
  /**
   * Resolve every gate and mutation plan of a *write* run without a human
   * approval, using `operator` as the approver.
   *
   * This removes the human confirmation step only. Everything else still
   * applies: the plan must be allowlisted, its preconditions are replayed
   * immediately before the write, the read-after-write rules are replayed
   * after, and the two-person rule is satisfied by the same operator. Only an
   * authenticated operator may set it, and it is refused in preview mode.
   */
  autoApprove?: boolean;
  /** QA harness (scenario, latency, faults). The server passes it only on a QA host. */
  qa?: QaRunOptions;
}

/** Live SIMRS connection, resolved from the environment by the entrypoint. */
export interface LiveConfig {
  baseUrlV1: string;
  cookie: string;
  baseUrlV2?: string;
}

export interface RunSummary {
  runId: string;
  workflowId: string;
  workflowVersion: string;
  mode: ExecutionMode;
  status: RunState['status'] | HistoricalRunStatus;
  startedAt: string;
  finishedAt?: string;
  operator?: string;
  replayable: boolean;
  source: 'memory' | 'ledger';
  reason?: string;
  truncatedTail?: boolean;
  /** Set when an audit-ledger append failed; the trail for this run is incomplete. */
  auditError?: string;
}

export interface RunSubscription {
  historical: boolean;
  unsubscribe: () => void;
}

export interface RunServiceOptions {
  /**
   * Shared service-account credentials (env fallback). Used for live runs
   * that carry no per-user session token. When absent AND no per-user session
   * is supplied, `source: "live"` runs are rejected.
   */
  live?: LiveConfig;
  /** Per-user session store; supplies each run's own EvoMedis cookie. */
  sessions?: UserSessionStore;
  /** Finished runs held in memory before falling back to the ledger. */
  retainFinishedRuns?: number;
  /**
   * Workflow lookup. Defaults to the registry; tests inject a synthetic
   * workflow so the mutation gate can be exercised without a domain package.
   */
  workflows?: (workflowId: string) => WorkflowEntry | undefined;
  /**
   * Deployment-wide default for {@link CreateRunInput.autoApprove}. Off unless
   * an operator explicitly turns it on for a run or the host sets
   * `AUTO_APPROVE_WRITES=true`.
   */
  autoApproveWrites?: boolean;
  /**
   * Approvals a `critical` gate/plan needs (two-person rule). Default 2; a
   * single-operator site sets 1 so verifikasi/tampung bayar stay reachable.
   */
  criticalApprovals?: 1 | 2;
  /** Rules-page values merged into every run's input as defaults. */
  rules?: RuleStore;
  /** Claim bundle reader (Kelengkapan Berkas); handed to live runs only. */
  berkas?: BerkasReaderPort;
}

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

/** Thrown by createRun for caller-mapped HTTP errors. */
function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** Risk level that demands two-person approval at the gate. */
function gateApprovalsRequired(node: WorkflowNodeDefinition, critical: number): number {
  return node.riskLevel === 'critical' ? critical : 1;
}

/**
 * Approvals a mutation plan needs before it may fire. Mirrors the gate rule
 * (control #22) so applying a `critical` plan cannot be a cheaper path than
 * approving a `critical` gate.
 */
function planApprovalsRequired(plan: MutationPlan, critical: number): number {
  return plan.riskLevel === 'critical' ? critical : 1;
}

/**
 * Finished runs kept in memory. Beyond this, the oldest are dropped and served
 * from the ledger instead (getState/subscribe/listRuns all fall back to it).
 * ponytail: fixed cap, not time-based — swap for a TTL only if operators need
 * a guaranteed window rather than a guaranteed bound.
 */
const RETAINED_FINISHED_RUNS = 50;

/**
 * The name recorded as the second approver of a `critical` plan when a run is
 * auto-approved. It is deliberately not a plausible human name: the audit trail
 * must make clear that the second signature was automatic, not a colleague's.
 */
const AUTO_APPROVER_ID = 'auto-approve';

/** Indonesian names of a settled plan's status, for operator messages. */
const PLAN_STATUS_ID: Record<string, string> = { applied: 'diterapkan', verified: 'terverifikasi', failed: 'gagal', invalidated: 'dibatalkan' };

export class RunService {
  private runs = new Map<string, RunHandle>();
  /** Finish order of terminal runs still held in memory (oldest first). */
  private retired: string[] = [];
  /**
   * Summaries of finished runs read back from the ledger. A terminal run's
   * file never changes again, so listRuns need not re-read and re-parse every
   * JSONL file on each dashboard load. Only the small summary is retained —
   * the events are re-read on demand by getState/subscribe.
   */
  private readonly summaryCache = new Map<string, RunSummary>();
  private readonly locks = new TransactionLocks();
  private readonly live?: LiveConfig;
  private readonly sessions?: UserSessionStore;
  private readonly retainFinished: number;
  private readonly workflows: (workflowId: string) => WorkflowEntry | undefined;
  /** Host-level default for auto-approving write runs; see `autoApproveWrites`. */
  private readonly autoApproveWrites: boolean;
  private readonly criticalApprovals: number;
  private readonly rules?: RuleStore;
  private readonly berkas?: BerkasReaderPort;

  constructor(
    private readonly ledger: Ledger,
    options: RunServiceOptions = {},
  ) {
    this.live = options.live;
    this.sessions = options.sessions;
    this.retainFinished = options.retainFinishedRuns ?? RETAINED_FINISHED_RUNS;
    this.workflows = options.workflows ?? getWorkflow;
    this.autoApproveWrites = options.autoApproveWrites ?? false;
    this.criticalApprovals = options.criticalApprovals ?? 2;
    this.rules = options.rules;
    this.berkas = options.berkas;
  }

  /** Create and immediately start a run. Returns the runId. */
  async createRun(req: CreateRunInput): Promise<{ runId: string }> {
    const entry = this.workflows(req.workflowId);
    if (!entry) {
      throw httpError(404, `Unknown workflow "${req.workflowId}"`);
    }
    const mode: ExecutionMode = req.mode ?? 'preview';
    const source: RunSource = req.source ?? 'fixture';
    if (req.qa?.scenario && source !== 'live') {
      try { qaFixtures(entry.definition.domain === 'rajal' ? 'rajal' : 'ranap', req.qa.scenario); }
      catch (err) { throw httpError(400, (err as Error).message); }
    }

    // Write runs must be attributed to an authenticated operator.
    if (mode === 'write' && !req.operator) {
      throw httpError(401, 'Write runs require an authenticated operator');
    }
    // Auto-approval is a write-run convenience only: preview never applies a
    // mutation, so asking for it there is a caller mistake, not a silent no-op.
    if (req.autoApprove && mode !== 'write') {
      throw httpError(400, 'autoApprove is only supported for write runs');
    }
    const autoApprove = mode === 'write' && (req.autoApprove === true || this.autoApproveWrites);

    // Resolve the EvoMedis cookie + base URL for live runs. A per-user session
    // (the logged-in operator's own cookie) takes priority over the shared
    // service-account env config.
    const userCookie = this.sessions?.cookieFor(req.sessionToken);
    const liveBaseUrl = userCookie ? this.sessions?.baseUrlV1 : this.live?.baseUrlV1;
    const liveBaseUrlV2 = userCookie ? this.sessions?.baseUrlV2 : this.live?.baseUrlV2;
    const liveCookie = userCookie ?? this.live?.cookie;

    // Live runs need a cookie + base URL; fail closed otherwise.
    if (source === 'live' && (!liveCookie || !liveBaseUrl)) {
      throw httpError(
        400,
        userCookie === undefined && this.live === undefined
          ? 'Live source unavailable — log in (per-user) or configure EVOMEDIS_BASE_URL/EVOMEDIS_SESSION_COOKIE'
          : 'Live source unavailable — EVOMEDIS_BASE_URL not configured',
      );
    }

    const runId = generateRunId();

    // #10 per-transaction lock: only write runs hold locks (preview cannot
    // write, so it cannot race a record).
    const lockKeys = mode === 'write' ? deriveLockKeys(req.input) : [];
    if (lockKeys.length > 0) {
      const conflict = this.locks.acquire(runId, lockKeys);
      if (conflict) {
        throw httpError(409, `${lockKeyLabel(conflict)} sedang dikerjakan run lain — tunggu run itu selesai atau hentikan dulu`);
      }
    }

    const bus = new EventBus();
    const controller = new AbortController();

    const handle: RunHandle = {
      runId,
      workflowId: req.workflowId,
      mode,
      ...(req.operator ? { operator: req.operator } : {}),
      state: initialRunState(entry.definition, runId, mode),
      events: [],
      ledgerWrites: Promise.resolve(),
      bus,
      controller,
      sinks: new Set(),
      gates: new Map(),
      replans: new Map(),
      mutationApprovals: new Map(),
      applying: new Set(),
      swept: new Set(),
      autoQueue: Promise.resolve(),
      finished: Promise.resolve(),
    };
    this.runs.set(runId, handle);
    const rules = this.rules?.get();
    const input = rules ? applyRules(entry.definition.domain, req.input, rules.values) : req.input;

    // Persist run metadata. If the ledger is unwritable we must not start the
    // run: it would hold its transaction lock forever and leave an untracked
    // handle behind, blocking that record until the process restarts.
    try {
      await this.ledger.recordRun({
        runId,
        workflowId: entry.definition.id,
        workflowVersion: entry.definition.version,
        mode,
        startedAt: new Date().toISOString(),
        operator: req.operator,
        ...(rules ? { rulesVersion: rules.version } : {}),
      });
    } catch (err) {
      this.runs.delete(runId);
      this.locks.release(runId);
      throw httpError(503, `Jejak audit tidak bisa ditulis (cek folder AUDIT_LEDGER_DIR / disk penuh): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Fan out + persist every event.
    bus.subscribe((event) => {
      handle.events.push(event);
      handle.state = applyEvent(handle.state, event);
      // Preserve append order and make waitFor/export able to await durability.
      // A failed append must neither poison the rest of the chain nor surface as
      // an unhandled rejection (nothing awaits `finished` on the HTTP path, so
      // that would take the process down). Record the first failure instead —
      // the run keeps going and the incomplete trail is reported on the summary.
      handle.ledgerWrites = handle.ledgerWrites
        .then(() => this.ledger.append(event))
        .catch((err: unknown) => {
          handle.ledgerError ??= err instanceof Error ? err.message : String(err);
          console.error(`[audit] ledger append failed for run ${runId}:`, err);
        });
      for (const sink of handle.sinks) {
        try {
          sink(event);
        } catch {
          /* a slow/broken SSE client must not break the run */
        }
      }
      // A mutation reaching a terminal outcome may release a parked node.
      if (MUTATION_SETTLING_EVENTS.has(event.type)) this.releaseReplans(handle);
      // Auto-approve: fire every newly proposed plan as soon as it appears,
      // attributed to the requesting operator. Plans from a re-plan pass arrive
      // the same way, so the sweep is re-run rather than only on the first
      // event. The gate still replays preconditions and verification.
      if (autoApprove && req.operator) this.autoApprovePlans(handle, req.operator);
    });

    // Build the per-run client args: allowlist from the workflow policy, and a
    // real transport only for live runs.
    const factoryArgs: ExecutorFactoryArgs = {
      mode,
      mutationAllowlist: entry.definition.policies?.mutationAllowlist,
    };
    if (req.qa && source !== 'live') {
      factoryArgs.transport = qaFixtureTransport(entry.definition.domain === 'rajal' ? 'rajal' : 'ranap', req.qa);
    }
    if (source === 'live' && liveCookie && liveBaseUrl) {
      // QA faults sit inside the re-login wrapper, so a dropped cookie exercises the real recovery.
      const fetchTransport = req.qa ? new QaTransport(new FetchTransport(), req.qa) : new FetchTransport();
      // For per-user sessions, wrap the transport so an expired cookie triggers
      // a silent re-login + retry using the user's retained credentials.
      factoryArgs.transport =
        userCookie && this.sessions && req.sessionToken
          ? new ReloginTransport(fetchTransport, this.sessions, req.sessionToken, this.sessions.cookieName)
          : fetchTransport;
      factoryArgs.baseUrlV1 = liveBaseUrl;
      factoryArgs.cookie = liveCookie;
      if (liveBaseUrlV2) factoryArgs.baseUrlV2 = liveBaseUrlV2;
      // The bundle PDF only exists on SIMRS; a fixture run reports the step unavailable.
      if (this.berkas) factoryArgs.berkas = this.berkas;
    }

    const executors = entry.buildExecutors(factoryArgs);
    const runner = new WorkflowRunner(entry.definition, executors);

    // The mutation gate's client. Built from the same args as the executors',
    // so it carries the same mode, allowlist and transport. Only write runs get
    // one: preview never applies a mutation (and the client would block it
    // anyway — control #1 is unchanged).
    if (mode === 'write') {
      handle.client = entry.createClient(factoryArgs);
    }

    // Map nodeId → risk so the gate resolver knows the approval threshold.
    const nodeRisk = new Map(entry.definition.nodes.map((n) => [n.id, n] as const));

    const gateResolver: GateResolver = (node) => {
      // In preview, gates auto-hold (never approve a real write).
      if (mode === 'preview') {
        return { approved: false, reason: 'Preview — gate ditahan, tidak ada yang ditulis' };
      }
      const def = nodeRisk.get(node.id) ?? node;
      // Auto-approve: resolve at once. A `critical` gate needs two distinct
      // approvers, so the synthetic auto-approver is named alongside the real
      // operator — the audit trail must not read as a two-human sign-off.
      if (autoApprove) {
        const approvers = gateApprovalsRequired(def, this.criticalApprovals) > 1 ? `${req.operator}, ${AUTO_APPROVER_ID}` : req.operator;
        return { approved: true, reason: `Auto-approved by ${approvers} (autoApprove)` };
      }
      // In write mode, await external approval(s) via approveGate/rejectGate.
      // `Promise.withResolvers` needs a newer lib than this project targets.
      const required = gateApprovalsRequired(def, this.criticalApprovals);
      return new Promise((resolve) => {
        handle.gates.set(node.id, { resolve, approvals: new Set(), required });
      });
    };

    /**
     * Re-plan barrier (parity gaps 1 and 2). The legacy script writes inline
     * and re-reads immediately; plan → approve → apply splits that in two, so
     * a node whose follow-up work needs backend-assigned state (a new charge
     * line's `urut_tindakan`) asks for another pass.
     *
     * This adds a loop *around* the mutation gate, never a way past it: the
     * second pass only re-runs the planner. Anything it proposes is a fresh
     * `MutationPlan` that must be approved again and applied through the gate,
     * with preconditions replayed, the allowlist enforced and the two-person
     * rule intact. The runner caps the passes.
     */
    const replanResolver: ReplanResolver = (request) => {
      // Preview never applies anything (control #1), so nothing can have
      // changed. The runner already refuses to re-plan in preview; this is the
      // second lock on the same door.
      if (mode !== 'write') {
        return { replan: false, reason: 'preview run — no mutation is ever applied' };
      }
      const planIds = request.proposedMutations.map((plan) => plan.id);
      if (planIds.length === 0) {
        return { replan: false, reason: 'the pass proposed no mutation, so nothing can have changed' };
      }
      const now = replanDecision(handle.state, planIds);
      if (now) return now;
      // Park until every plan settles. Released by the bus subscriber on each
      // terminal `mutation.*` event, or by cancel().
      //
      // The decision is re-checked *inside* the executor: with auto-approve the
      // plans can settle between the check above and this `set`, and that
      // settling event has already been delivered — without the second look the
      // node would park with nothing left to wake it.
      return new Promise<ReplanDecision>((resolve) => {
        const settledNow = replanDecision(handle.state, planIds);
        if (settledNow) {
          resolve(settledNow);
          return;
        }
        handle.replans.set(request.node.id, { resolve, planIds });
        // The plans that parked this node may still be unapproved (e.g. the
        // node proposed several and only some were swept). Fire them now so the
        // settling events that release this barrier are actually coming.
        if (autoApprove && req.operator) this.autoApprovePlans(handle, req.operator);
      });
    };

    handle.finished = runner
      .run({
        mode,
        bus,
        runId,
        input,
        enabled: req.enabled,
        signal: controller.signal,
        beforeNode: () => handle.pause?.promise ?? Promise.resolve(),
        gateResolver,
        replanResolver,
      })
      .then(() => undefined)
      .catch((err) => {
        bus.emit({
          runId,
          workflowId: entry.definition.id,
          workflowVersion: entry.definition.version,
          type: 'run.failed',
          source: 'api',
          severity: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .then(() => handle.ledgerWrites)
      .finally(() => {
        // Release the transaction lock once the run is terminal and durable.
        this.locks.release(runId);
        this.retire(runId);
      })
      // Nothing awaits this on the HTTP path; never let it reject unhandled.
      .catch((err: unknown) => {
        console.error(`[run] ${runId} terminated abnormally:`, err);
      });

    return { runId };
  }

  /**
   * Release every parked node whose mutations have all settled. Called after
   * each terminal `mutation.*` event; nodes still waiting on an in-flight plan
   * stay parked.
   */
  private releaseReplans(handle: RunHandle): void {
    for (const [nodeId, waiter] of [...handle.replans]) {
      const decision = replanDecision(handle.state, waiter.planIds);
      if (!decision) continue;
      handle.replans.delete(nodeId);
      waiter.resolve(decision);
    }
  }

  /**
   * Drop the oldest finished runs so memory stays bounded on a long-lived
   * server. Evicted runs remain fully readable from the append-only ledger.
   */
  private retire(runId: string): void {
    this.retired.push(runId);
    while (this.retired.length > this.retainFinished) {
      this.runs.delete(this.retired.shift()!);
    }
  }

  private replayProblem(history: LedgerHistory): string | undefined {
    if (!history.meta || !history.replayable) return history.reason ?? 'historical run is not replayable';
    const entry = this.workflows(history.meta.workflowId);
    if (!entry) return `Workflow "${history.meta.workflowId}" is not registered`;
    if (entry.definition.version !== history.meta.workflowVersion) {
      return `Workflow version ${history.meta.workflowVersion} is unavailable (current: ${entry.definition.version})`;
    }
    return undefined;
  }

  private historySummary(runId: string, history: LedgerHistory): RunSummary {
    const meta = history.meta;
    const replayProblem = this.replayProblem(history);
    return {
      runId: meta?.runId ?? runId,
      workflowId: meta?.workflowId ?? 'unknown',
      workflowVersion: meta?.workflowVersion ?? 'unknown',
      mode: meta?.mode ?? 'preview',
      status: replayProblem && history.status !== 'interrupted' ? 'unreplayable' : history.status,
      startedAt: meta?.startedAt ?? '',
      ...(history.finishedAt ? { finishedAt: history.finishedAt } : {}),
      ...(meta?.operator ? { operator: meta.operator } : {}),
      replayable: !replayProblem,
      source: 'ledger',
      ...(replayProblem ? { reason: replayProblem } : {}),
      ...(history.truncatedTail ? { truncatedTail: true } : {}),
    };
  }

  private async historical(runId: string): Promise<LedgerHistory | undefined> {
    return this.ledger.readHistory(runId);
  }

  async getState(runId: string): Promise<RunState | undefined> {
    const active = this.runs.get(runId)?.state;
    if (active) return active;
    const history = await this.historical(runId);
    if (!history) return undefined;
    const replayProblem = this.replayProblem(history);
    if (replayProblem || !history.meta) throw new Error(replayProblem);
    const entry = this.workflows(history.meta.workflowId)!;
    return reduceEvents(entry.definition, runId, history.meta.mode, history.events);
  }

  getEvents(runId: string): WorkflowEvent[] | undefined {
    return this.runs.get(runId)?.events;
  }

  /** True while the run is still live in this process (not yet terminal). */
  isLive(runId: string): boolean {
    const status = this.runs.get(runId)?.state.status;
    return status !== undefined && !['completed', 'failed', 'cancelled'].includes(status);
  }

  /** Mode of a run (used by the server to decide whether auth is required). */
  getMode(runId: string): ExecutionMode | undefined {
    return this.runs.get(runId)?.mode;
  }

  async listRuns(): Promise<RunSummary[]> {
    const active = [...this.runs.values()].map<RunSummary>((handle) => ({
      runId: handle.runId,
      workflowId: handle.workflowId,
      workflowVersion: handle.state.workflowVersion,
      mode: handle.mode,
      status: handle.state.status,
      startedAt: handle.state.startedAt ?? handle.state.createdAt ?? '',
      ...(handle.state.finishedAt ? { finishedAt: handle.state.finishedAt } : {}),
      ...(handle.operator ? { operator: handle.operator } : {}),
      replayable: true,
      source: 'memory',
      ...(handle.ledgerError ? { auditError: handle.ledgerError } : {}),
    }));
    const activeIds = new Set(active.map((run) => run.runId));
    const historical = await Promise.all(
      (await this.ledger.listRuns())
        .filter((runId) => !activeIds.has(runId))
        .map(async (runId) => {
          const cached = this.summaryCache.get(runId);
          if (cached) return cached;
          const history = await this.historical(runId);
          if (!history) return undefined;
          const summary = this.historySummary(runId, history);
          // `interrupted` means no terminal event — the file could still be
          // appended to (e.g. a run owned by another process), so don't cache it.
          if (history.status !== 'interrupted') this.summaryCache.set(runId, summary);
          return summary;
        }),
    );
    return [...active, ...historical.filter((run): run is RunSummary => Boolean(run))]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Subscribe an SSE sink; historical runs replay and close immediately. */
  async subscribe(runId: string, sink: EventSink): Promise<RunSubscription | undefined> {
    const handle = this.runs.get(runId);
    if (handle) {
      for (const event of handle.events) sink(event);
      handle.sinks.add(sink);
      return { historical: false, unsubscribe: () => handle.sinks.delete(sink) };
    }
    const history = await this.historical(runId);
    if (!history) return undefined;
    const replayProblem = this.replayProblem(history);
    if (replayProblem) throw new Error(replayProblem);
    for (const event of history.events) sink(event);
    return { historical: true, unsubscribe: () => undefined };
  }

  /**
   * Pause before the next step (the running one finishes). Returns false when
   * the run is unknown, already paused, or no longer running.
   */
  pause(runId: string, operator?: string): boolean {
    const handle = this.runs.get(runId);
    if (!handle || handle.pause || !['created', 'running'].includes(handle.state.status)) return false;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    handle.pause = { promise, resolve };
    handle.bus.emit({
      runId,
      workflowId: handle.workflowId,
      workflowVersion: handle.state.workflowVersion,
      type: 'run.paused',
      source: 'api',
      message: `Dijeda${operator ? ` oleh ${operator}` : ''} — lanjut setelah step berjalan selesai`,
    });
    return true;
  }

  resume(runId: string, operator?: string): boolean {
    const handle = this.runs.get(runId);
    if (!handle?.pause) return false;
    const { resolve } = handle.pause;
    handle.pause = undefined;
    handle.bus.emit({
      runId,
      workflowId: handle.workflowId,
      workflowVersion: handle.state.workflowVersion,
      type: 'run.resumed',
      source: 'api',
      message: `Dilanjutkan${operator ? ` oleh ${operator}` : ''}`,
    });
    resolve();
    return true;
  }

  cancel(runId: string): boolean {
    const handle = this.runs.get(runId);
    if (!handle) return false;
    handle.controller.abort();
    // A paused runner is parked before its next step; let it see the abort.
    handle.pause?.resolve();
    handle.pause = undefined;
    // Release any pending gate so the runner unwinds.
    for (const waiter of handle.gates.values()) {
      waiter.resolve({ approved: false, reason: 'Run cancelled' });
    }
    handle.gates.clear();
    // Same for a node parked waiting for its mutations to settle.
    for (const waiter of handle.replans.values()) {
      waiter.resolve({ replan: false, reason: 'run cancelled' });
    }
    handle.replans.clear();
    this.locks.release(runId);
    return true;
  }

  /**
   * Approve a waiting gate. Critical gates need two distinct operators; the
   * first approval is held and the gate resolves only on the second. Returns
   * the outcome so the API can tell the operator whether more is needed.
   */
  approveGate(
    runId: string,
    nodeId: string,
    operator: string,
    reason?: string,
  ): { ok: true; resolved: boolean; remaining: number } | { ok: false } {
    const handle = this.runs.get(runId);
    const waiter = handle?.gates.get(nodeId);
    if (!handle || !waiter) return { ok: false };

    waiter.approvals.add(operator);
    if (waiter.approvals.size >= waiter.required) {
      const approvers = [...waiter.approvals].join(', ');
      waiter.resolve({ approved: true, reason: reason ?? `Approved by ${approvers}` });
      handle.gates.delete(nodeId);
      return { ok: true, resolved: true, remaining: 0 };
    }
    // Surface partial approval in the audit/event stream.
    handle.bus.emit({
      runId,
      workflowId: handle.workflowId,
      workflowVersion: handle.state.workflowVersion,
      type: 'gate.waiting',
      source: 'api',
      nodeId,
      message: `Approval ${waiter.approvals.size}/${waiter.required} by ${operator} — second approver required`,
    });
    return { ok: true, resolved: false, remaining: waiter.required - waiter.approvals.size };
  }

  /** Every plan the run has proposed so far, with the node that proposed it. */
  private findPlan(
    handle: RunHandle,
    planId: string,
  ): { plan: MutationPlan; nodeId: string } | undefined {
    for (const node of Object.values(handle.state.nodes)) {
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
  async approveMutation(
    runId: string,
    planId: string,
    operator: string,
    reason?: string,
  ): Promise<MutationApprovalResult> {
    const handle = this.runs.get(runId);
    if (!handle) return { ok: false, error: 'run_not_found', message: `Unknown run "${runId}"` };
    // Preview must never write. The client would block it too (control #1);
    // refusing here keeps the preview path from even reading.
    if (handle.mode !== 'write') {
      return { ok: false, error: 'preview_run', message: 'Preview runs never apply mutations' };
    }
    if (isTerminalStatus(handle.state.status)) {
      return {
        ok: false,
        error: 'run_not_active',
        message: `Run ${runId} is ${handle.state.status}; mutations are applied while the run is live`,
      };
    }
    const found = this.findPlan(handle, planId);
    if (!found) {
      return { ok: false, error: 'plan_not_found', message: `Run ${runId} proposed no plan "${planId}"` };
    }
    // Idempotency (control #11): a plan that already fired must not fire twice.
    const settled = handle.state.mutations[planId]?.status;
    if (settled === 'applied' || settled === 'verified' || settled === 'failed' || settled === 'invalidated') {
      return {
        ok: false,
        error: 'already_settled',
        message: `Rencana ini sudah selesai (${PLAN_STATUS_ID[settled]})`,
      };
    }
    if (handle.applying.has(planId)) {
      return { ok: false, error: 'apply_in_flight', message: 'Rencana ini sedang diterapkan' };
    }
    if (!handle.client) {
      return { ok: false, error: 'client_unavailable', message: 'No client available for this run' };
    }

    const approvals = handle.mutationApprovals.get(planId) ?? new Set<string>();
    approvals.add(operator);
    handle.mutationApprovals.set(planId, approvals);
    const required = planApprovalsRequired(found.plan, this.criticalApprovals);
    if (approvals.size < required) {
      // Surface the partial approval in the audit/event stream.
      handle.bus.emit({
        runId,
        workflowId: handle.workflowId,
        workflowVersion: handle.state.workflowVersion,
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

    handle.applying.add(planId);
    try {
      const outcome = await applyApprovedMutation({
        plan: found.plan,
        client: handle.client,
        approvedBy: [...approvals],
        signal: handle.controller.signal,
        ...(reason ? { reason } : {}),
        emit: (event) =>
          handle.bus.emit({
            runId,
            workflowId: handle.workflowId,
            workflowVersion: handle.state.workflowVersion,
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
      handle.applying.delete(planId);
    }
  }

  /**
   * Approve every unsettled plan of an auto-approving run, attributed to
   * `operator`.
   *
   * Called from the bus subscriber, so it must be re-entrancy safe: approving
   * emits `mutation.*` events that re-enter the subscriber. `handle.autoApproving`
   * blocks that recursion, and `applying` / the settled-status check in
   * `approveMutation` make a repeat call harmless.
   *
   * A refusal is logged and skipped rather than thrown: one unapprovable plan
   * (say, a precondition that no longer holds) must not abort the sweep and
   * strand the rest of the batch.
   */
  private autoApprovePlans(handle: RunHandle, operator: string): void {
    if (handle.autoApproving) return;
    // Collect first, approve after: `approveMutation` emits events that re-enter
    // the subscriber synchronously, so a sweep that approved inside the latch
    // would be re-entered with a state snapshot taken before the plan loop even
    // finished — which is how the verification plan stayed `planned` forever.
    const pending: string[] = [];
    handle.autoApproving = true;
    try {
      for (const node of Object.values(handle.state.nodes)) {
        for (const plan of node.proposedMutations) {
          if (handle.applying.has(plan.id) || handle.swept.has(plan.id)) continue;
          const settled = handle.state.mutations[plan.id]?.status;
          if (settled === 'applied' || settled === 'verified' || settled === 'failed' || settled === 'invalidated') continue;
          pending.push(plan.id);
        }
      }
      // Claim before the first await: `approveMutation` emits events that
      // re-enter this sweep synchronously, and without the claim it would fire
      // the same plan again from inside that re-entry (unbounded).
      for (const planId of pending) handle.swept.add(planId);
    } finally {
      handle.autoApproving = false;
    }
    for (const planId of pending) {
      handle.autoQueue = handle.autoQueue.then(() => this.autoApproveOne(handle, planId, operator)).catch((err: unknown) => {
        console.error(`[autoApprove] plan ${planId} failed:`, err);
      });
    }
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
  private async autoApproveOne(handle: RunHandle, planId: string, operator: string): Promise<void> {
    const first = await this.approveMutation(handle.runId, planId, operator, 'Auto-approved (autoApprove)');
    if (!first.ok || first.resolved) return;
    const second = await this.approveMutation(
      handle.runId,
      planId,
      AUTO_APPROVER_ID,
      'Auto-approved (autoApprove, second signature)',
    );
    if (!second.ok) {
      console.error(`[autoApprove] plan ${planId} could not reach its approval threshold:`, second);
    }
  }

  rejectGate(runId: string, nodeId: string, operator: string, reason?: string): boolean {
    const handle = this.runs.get(runId);
    const waiter = handle?.gates.get(nodeId);
    if (!handle || !waiter) return false;
    waiter.resolve({ approved: false, reason: reason ?? `Rejected by ${operator}` });
    handle.gates.delete(nodeId);
    return true;
  }

  /** Wait for a run to finish (used by tests). */
  async waitFor(runId: string): Promise<RunState | undefined> {
    const handle = this.runs.get(runId);
    if (!handle) return undefined;
    await handle.finished;
    await handle.ledgerWrites;
    return handle.state;
  }

  async exportJsonl(runId: string): Promise<string | undefined> {
    const handle = this.runs.get(runId);
    if (handle) await handle.ledgerWrites;
    return this.ledger.readJsonl(runId);
  }
}

