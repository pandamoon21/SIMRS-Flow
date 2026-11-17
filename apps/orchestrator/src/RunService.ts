/**
 * RunService — the orchestration core.
 *
 * Owns the lifecycle of runs: create, start, stream events (SSE), resolve
 * gates, cancel, and export JSONL. It bridges the headless WorkflowRunner to
 * HTTP by:
 *   - subscribing to the run's EventBus and fanning events out to SSE clients,
 *   - persisting every event to the append-only audit ledger (redacted),
 *   - routing gate/plan approvals to the run's `RunApprovals`.
 *
 * Write-mode safety wiring is composed here (the engine stays generic):
 *   - #3  the workflow's `mutationAllowlist` is passed into the client,
 *   - #10 a per-transaction lock prevents two write runs racing one record,
 *   - two-person approval, auto-approve and the apply path (`runApprovals.ts`);
 *     #4/#5/#6 an approved mutation is applied only through the mutation gate,
 *     which replays the plan's preconditions immediately before the write and
 *     its read-after-write rules immediately after (see `mutationGate.ts`),
 *   - the re-plan barrier around the gate (`replanBarrier.ts`),
 *   - a real network transport is used only for `source: "live"` runs with
 *     credentials configured (`simrsAccess.ts`); everything else stays
 *     fixture-backed,
 *   - ledger-backed history and its cache rule (`runHistory.ts`).
 *
 * Runs execute in-process. For an MVP this is sufficient and keeps the audit
 * trail authoritative. A future version can move execution to a worker.
 */

import type { BerkasReaderPort } from '@simrs-flow/domain-ranap';
import type { RunSummary } from '@simrs-flow/api-contract';
import {
  EventBus,
  WorkflowRunner,
  generateRunId,
  initialRunState,
  applyEvent,
  isTerminalStatus,
  reduceEvents,
  type ExecutionMode,
  type RunState,
  type WorkflowEvent,
} from '@simrs-flow/workflow-core';
import { DEFAULT_CRITICAL_APPROVALS } from '@simrs-flow/evomedis-client';
import type { Ledger } from '@simrs-flow/audit-ledger';
import { getWorkflow, type ExecutorFactoryArgs, type WorkflowEntry } from './registry.js';
import { deriveLockKeys, lockKeyLabel, TransactionLocks } from './locks.js';
import { QaTransport, qaFixtures, qaFixtureTransport, type QaRunOptions } from './qaTransport.js';
import type { UserSessionStore } from './sessions.js';
import { applyRules, type RuleStore } from './rules.js';
import { ReplanBarrier } from './replanBarrier.js';
import {
  httpError,
  resolveAutoApprove,
  RunApprovals,
  type GateApprovalResult,
  type MutationApprovalResult,
} from './runApprovals.js';
import { SimrsAccess, type LiveConfig, type SimrsConnection, type TransportFactory } from './simrsAccess.js';
import { RunHistory } from './runHistory.js';

export type { MutationApprovalRefusal, MutationApprovalResult } from './runApprovals.js';
export type { LiveConfig, TransportFactory } from './simrsAccess.js';

type EventSink = (event: WorkflowEvent) => void;

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
  /** Gate + plan approvals and the auto-approve queue. */
  approvals: RunApprovals;
  /** Nodes parked awaiting a re-plan decision. */
  replans: ReplanBarrier;
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

export type { RunSummary } from '@simrs-flow/api-contract';

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
   * Network transport for live SIMRS calls. Defaults to `FetchTransport`;
   * tests inject a fixture so the live wiring (re-login, cookies) runs offline.
   */
  transportFactory?: TransportFactory;
  /**
   * Deployment-wide default for {@link CreateRunInput.autoApprove}. Off unless
   * an operator explicitly turns it on for a run or the host sets
   * `AUTO_APPROVE_WRITES=true`.
   */
  autoApproveWrites?: boolean;
  /**
   * Approvals a `critical` gate/plan needs (two-person rule). Default
   * `DEFAULT_CRITICAL_APPROVALS` (1, one operator); a two-person site sets 2.
   */
  criticalApprovals?: 1 | 2;
  /** Rules-page values merged into every run's input as defaults. */
  rules?: RuleStore;
  /** Claim bundle reader (Kelengkapan Berkas); handed to live runs only. */
  berkas?: BerkasReaderPort;
}

/**
 * Finished runs kept in memory. Beyond this, the oldest are dropped and served
 * from the ledger instead (getState/subscribe/listRuns all fall back to it).
 * ponytail: fixed cap, not time-based — swap for a TTL only if operators need
 * a guaranteed window rather than a guaranteed bound.
 */
const RETAINED_FINISHED_RUNS = 50;

export class RunService {
  private runs = new Map<string, RunHandle>();
  /** Finish order of terminal runs still held in memory (oldest first). */
  private retired: string[] = [];
  private readonly locks = new TransactionLocks();
  private readonly retainFinished: number;
  private readonly workflows: (workflowId: string) => WorkflowEntry | undefined;
  /** Host-level default for auto-approving write runs; see `autoApproveWrites`. */
  private readonly autoApproveWrites: boolean;
  private readonly criticalApprovals: number;
  private readonly rules?: RuleStore;
  private readonly berkas?: BerkasReaderPort;
  /** Operator session → SIMRS transport; shared with the server's report reads. */
  readonly simrs: SimrsAccess;
  /** Ledger-backed run history (summaries + the shared cache rule). */
  readonly history: RunHistory;

  constructor(
    private readonly ledger: Ledger,
    options: RunServiceOptions = {},
  ) {
    this.retainFinished = options.retainFinishedRuns ?? RETAINED_FINISHED_RUNS;
    this.workflows = options.workflows ?? getWorkflow;
    this.autoApproveWrites = options.autoApproveWrites ?? false;
    this.criticalApprovals = options.criticalApprovals ?? DEFAULT_CRITICAL_APPROVALS;
    this.rules = options.rules;
    this.berkas = options.berkas;
    this.simrs = new SimrsAccess({
      ...(options.sessions ? { sessions: options.sessions } : {}),
      ...(options.live ? { live: options.live } : {}),
      ...(options.transportFactory ? { transportFactory: options.transportFactory } : {}),
    });
    this.history = new RunHistory(ledger, this.workflows, (runId) => this.isLive(runId));
  }

  /** Create and immediately start a run. Returns the runId. */
  async createRun(req: CreateRunInput): Promise<{ runId: string }> {
    const mode: ExecutionMode = req.mode ?? 'preview';
    // The one place the auto-approve default is decided (400 outside write
    // mode). Checked first so the API answers exactly as it always has.
    const autoApprove = resolveAutoApprove(mode, req.autoApprove, this.autoApproveWrites);
    const entry = this.workflows(req.workflowId);
    if (!entry) {
      throw httpError(404, `Unknown workflow "${req.workflowId}"`);
    }
    const source: RunSource = req.source ?? 'fixture';
    if (req.qa?.scenario && source !== 'live') {
      try { qaFixtures(entry.definition.domain === 'rajal' ? 'rajal' : 'ranap', req.qa.scenario); }
      catch (err) { throw httpError(400, (err as Error).message); }
    }

    // Write runs must be attributed to an authenticated operator.
    if (mode === 'write' && !req.operator) {
      throw httpError(401, 'Write runs require an authenticated operator');
    }

    // Live runs need a cookie + base URL; fail closed otherwise. A per-user
    // session takes priority over the shared service-account env config.
    let live: SimrsConnection | undefined;
    if (source === 'live') {
      const resolved = this.simrs.connection(req.sessionToken);
      if (!resolved.ok) throw httpError(400, resolved.message);
      live = resolved.connection;
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
    const state = (): RunState => handle.state;
    const approvals = new RunApprovals({
      runId,
      mode,
      state,
      emit: (event) => {
        bus.emit({ runId, workflowId: req.workflowId, workflowVersion: handle.state.workflowVersion, ...event });
      },
      signal: controller.signal,
      criticalApprovals: this.criticalApprovals,
      // Write runs always carry an operator (checked above).
      ...(autoApprove && req.operator ? { autoApproveAs: req.operator } : {}),
      nodes: new Map(entry.definition.nodes.map((n) => [n.id, n] as const)),
    });

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
      approvals,
      replans: new ReplanBarrier({ mode, state, onPark: () => approvals.sweep() }),
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
      handle.replans.onEvent(event);
      // Auto-approve (no-op otherwise): fire every newly proposed plan as soon
      // as it appears, attributed to the requesting operator. Plans from a
      // re-plan pass arrive the same way, so the sweep is re-run rather than
      // only on the first event. The gate still replays preconditions and
      // verification.
      handle.approvals.sweep();
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
    if (live) {
      const qa = req.qa;
      // QA faults sit inside the re-login wrapper, so a dropped cookie exercises
      // the real recovery. Per-user sessions get the silent re-login + retry.
      factoryArgs.transport = this.simrs.transportFor(live, qa ? (inner) => new QaTransport(inner, qa) : undefined);
      factoryArgs.baseUrlV1 = live.baseUrlV1;
      factoryArgs.cookie = live.cookie;
      if (live.baseUrlV2) factoryArgs.baseUrlV2 = live.baseUrlV2;
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
      approvals.attachClient(entry.createClient(factoryArgs));
    }

    handle.finished = runner
      .run({
        mode,
        bus,
        runId,
        input,
        enabled: req.enabled,
        signal: controller.signal,
        beforeNode: () => handle.pause?.promise ?? Promise.resolve(),
        gateResolver: approvals.resolveGate,
        replanResolver: handle.replans.resolver,
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
   * Drop the oldest finished runs so memory stays bounded on a long-lived
   * server. Evicted runs remain fully readable from the append-only ledger.
   */
  private retire(runId: string): void {
    this.retired.push(runId);
    while (this.retired.length > this.retainFinished) {
      this.runs.delete(this.retired.shift()!);
    }
  }

  async getState(runId: string): Promise<RunState | undefined> {
    const active = this.runs.get(runId)?.state;
    if (active) return active;
    const history = await this.history.read(runId);
    if (!history) return undefined;
    const replayProblem = this.history.replayProblem(history);
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
    return status !== undefined && !isTerminalStatus(status);
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
      // Why it stopped; the UI tells a preview held at its gate from a real failure by it.
      ...(handle.state.status === 'failed' && handle.state.summary ? { reason: handle.state.summary } : {}),
      ...(handle.ledgerError ? { auditError: handle.ledgerError } : {}),
    }));
    const historical = await this.history.listSummaries(new Set(active.map((run) => run.runId)));
    return [...active, ...historical]
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
    const history = await this.history.read(runId);
    if (!history) return undefined;
    const replayProblem = this.history.replayProblem(history);
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
    handle.approvals.cancel();
    // Same for a node parked waiting for its mutations to settle.
    handle.replans.cancel();
    this.locks.release(runId);
    return true;
  }

  /**
   * Approve a waiting gate. Critical gates need two distinct operators; the
   * first approval is held and the gate resolves only on the second. Returns
   * the outcome so the API can tell the operator whether more is needed.
   */
  approveGate(runId: string, nodeId: string, operator: string, reason?: string): GateApprovalResult {
    const handle = this.runs.get(runId);
    if (!handle) return { ok: false };
    return handle.approvals.approveGate(nodeId, operator, reason);
  }

  /**
   * Approve a proposed mutation and — once enough distinct operators have
   * approved — apply it through the mutation gate (see `RunApprovals`).
   */
  async approveMutation(
    runId: string,
    planId: string,
    operator: string,
    reason?: string,
  ): Promise<MutationApprovalResult> {
    const handle = this.runs.get(runId);
    if (!handle) return { ok: false, error: 'run_not_found', message: `Unknown run "${runId}"` };
    return handle.approvals.approveMutation(planId, operator, reason);
  }

  rejectGate(runId: string, nodeId: string, operator: string, reason?: string): boolean {
    const handle = this.runs.get(runId);
    if (!handle) return false;
    return handle.approvals.rejectGate(nodeId, operator, reason);
  }

  /**
   * Resolves once the run's auto-approve queue has drained (tests await this
   * instead of sleeping). Resolves at once for an unknown run.
   */
  async approvalsIdle(runId: string): Promise<void> {
    await this.runs.get(runId)?.approvals.idle();
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
