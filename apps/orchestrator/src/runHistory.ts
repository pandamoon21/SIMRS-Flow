/**
 * Run history read back from the audit ledger, with one caching rule.
 *
 * A finished run's JSONL file never changes again, so anything derived from it
 * (the runs-list summary, the dashboard part) can be computed once instead of
 * re-reading and re-parsing every file on each load. The rule, shared by every
 * projection here:
 *
 *   cache only when the run is not live in this process AND its history has a
 *   terminal event (`interrupted` means no terminal event — the file could
 *   still be appended to, e.g. by a run owned by another process).
 *
 * Only the small derived value is retained; events are re-read on demand.
 */

import type { Ledger, LedgerHistory } from '@simrs-flow/audit-ledger';
import type { WorkflowEntry } from './registry.js';
import type { RunSummary } from './RunService.js';

/** The caching rule for anything derived from a run's ledger history. */
export function isHistoryCacheable(history: LedgerHistory, live: boolean): boolean {
  return !live && history.status !== 'interrupted';
}

export interface HistoryProjectionOptions {
  /** Treat a ledger read failure as "no history" instead of throwing. */
  tolerateReadErrors?: boolean;
}

/**
 * A cached projection of ledger histories. `key` invalidates an entry when an
 * outside input of `derive` changes (e.g. the naik kelas list for the
 * dashboard); pass a constant when there is none.
 */
export class HistoryProjection<T> {
  private readonly entries = new Map<string, { key: string; value: T }>();

  constructor(
    private readonly ledger: Ledger,
    private readonly isLive: (runId: string) => boolean,
    private readonly options: HistoryProjectionOptions = {},
  ) {}

  async read(
    runId: string,
    key: string,
    derive: (history: LedgerHistory, live: boolean) => T,
  ): Promise<T | undefined> {
    const cached = this.entries.get(runId);
    if (cached && cached.key === key) return cached.value;
    const history = this.options.tolerateReadErrors
      ? await this.ledger.readHistory(runId).catch(() => undefined)
      : await this.ledger.readHistory(runId);
    if (!history) return undefined;
    const live = this.isLive(runId);
    const value = derive(history, live);
    if (isHistoryCacheable(history, live)) this.entries.set(runId, { key, value });
    return value;
  }

  /** Read every ledger run (optionally skipping some ids), dropping the unreadable. */
  async readAll(
    key: string,
    derive: (history: LedgerHistory, live: boolean, runId: string) => T,
    skip?: ReadonlySet<string>,
  ): Promise<T[]> {
    const runIds = (await this.ledger.listRuns()).filter((runId) => !skip?.has(runId));
    const values = await Promise.all(
      runIds.map((runId) => this.read(runId, key, (history, live) => derive(history, live, runId))),
    );
    return values.filter((value): value is Awaited<T> => value !== undefined) as T[];
  }
}

export class RunHistory {
  private readonly summaries: HistoryProjection<RunSummary>;

  constructor(
    private readonly ledger: Ledger,
    private readonly workflows: (workflowId: string) => WorkflowEntry | undefined,
    private readonly isLive: (runId: string) => boolean,
  ) {
    this.summaries = new HistoryProjection(ledger, isLive);
  }

  read(runId: string): Promise<LedgerHistory | undefined> {
    return this.ledger.readHistory(runId);
  }

  /** Why a historical run cannot be replayed against the current registry, if it cannot. */
  replayProblem(history: LedgerHistory): string | undefined {
    if (!history.meta || !history.replayable) return history.reason ?? 'historical run is not replayable';
    const entry = this.workflows(history.meta.workflowId);
    if (!entry) return `Workflow "${history.meta.workflowId}" is not registered`;
    if (entry.definition.version !== history.meta.workflowVersion) {
      return `Workflow version ${history.meta.workflowVersion} is unavailable (current: ${entry.definition.version})`;
    }
    return undefined;
  }

  summary(runId: string, history: LedgerHistory): RunSummary {
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

  /** Summaries of every ledger run not in `skip` (cached per the rule above). */
  listSummaries(skip: ReadonlySet<string>): Promise<RunSummary[]> {
    return this.summaries.readAll('', (history, _live, runId) => this.summary(runId, history), skip);
  }

  /** A new cached projection over the same ledger and liveness rule. */
  projection<T>(options?: HistoryProjectionOptions): HistoryProjection<T> {
    return new HistoryProjection<T>(this.ledger, this.isLive, options);
  }
}
