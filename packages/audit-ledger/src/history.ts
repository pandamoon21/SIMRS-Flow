import { EVENT_SCHEMA, type ExecutionMode, type RunStatus, type WorkflowEvent } from '@simrs-flow/workflow-core';

export interface RunMetadata {
  runId: string;
  workflowId: string;
  workflowVersion: string;
  mode: ExecutionMode;
  startedAt: string;
  operator?: string;
  /** Rules-page version merged into this run's input (0 = built-in defaults). */
  rulesVersion?: number;
}

export type HistoricalRunStatus = RunStatus | 'interrupted' | 'unreplayable';

export interface LedgerHistory {
  meta?: RunMetadata;
  events: WorkflowEvent[];
  status: HistoricalRunStatus;
  finishedAt?: string;
  replayable: boolean;
  truncatedTail: boolean;
  reason?: string;
  raw: string;
}

const TERMINAL_TYPES = new Set<WorkflowEvent['type']>([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

function metadataOf(value: unknown): RunMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (
    item.kind !== 'run.meta' ||
    typeof item.runId !== 'string' ||
    typeof item.workflowId !== 'string' ||
    typeof item.workflowVersion !== 'string' ||
    (item.mode !== 'preview' && item.mode !== 'write') ||
    typeof item.startedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    runId: item.runId,
    workflowId: item.workflowId,
    workflowVersion: item.workflowVersion,
    mode: item.mode,
    startedAt: item.startedAt,
    ...(typeof item.operator === 'string' ? { operator: item.operator } : {}),
    ...(typeof item.rulesVersion === 'number' ? { rulesVersion: item.rulesVersion } : {}),
  };
}

function eventError(value: unknown, meta: RunMetadata, previousSeq: number): string | undefined {
  if (!value || typeof value !== 'object') return 'event is not an object';
  const event = value as Partial<WorkflowEvent>;
  if (event.schema !== EVENT_SCHEMA) return 'event schema mismatch';
  if (event.runId !== meta.runId) return 'event runId mismatch';
  if (event.workflowId !== meta.workflowId) return 'event workflowId mismatch';
  if (event.workflowVersion !== meta.workflowVersion) return 'event workflowVersion mismatch';
  if (!Number.isInteger(event.seq)) return 'event sequence is invalid';
  if (previousSeq === 0 && event.seq !== 1) return 'first event sequence must be 1';
  if ((event.seq ?? 0) <= previousSeq) return 'event sequence is not strictly increasing';
  if (typeof event.type !== 'string' || typeof event.ts !== 'string') return 'event envelope is incomplete';
  return undefined;
}

function failed(raw: string, reason: string, meta?: RunMetadata, events: WorkflowEvent[] = []): LedgerHistory {
  return {
    meta,
    events,
    status: 'unreplayable',
    replayable: false,
    truncatedTail: false,
    reason,
    raw,
  };
}

/** Parse one append-only ledger file. Only a malformed final line is tolerated. */
export function parseLedgerHistory(raw: string): LedgerHistory {
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return failed(raw, 'ledger is empty');

  let first: unknown;
  try {
    first = JSON.parse(lines[0]!);
  } catch {
    return failed(raw, 'run.meta is malformed');
  }
  const meta = metadataOf(first);
  if (!meta) return failed(raw, 'run.meta is missing or invalid');

  const events: WorkflowEvent[] = [];
  let previousSeq = 0;
  let truncatedTail = false;
  for (let i = 1; i < lines.length; i += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch {
      if (i === lines.length - 1) {
        truncatedTail = true;
        break;
      }
      return failed(raw, `ledger line ${i + 1} is malformed`, meta, events);
    }
    const problem = eventError(parsed, meta, previousSeq);
    if (problem) return failed(raw, `ledger line ${i + 1}: ${problem}`, meta, events);
    const event = parsed as WorkflowEvent;
    events.push(event);
    previousSeq = event.seq;
  }

  const terminal = [...events].reverse().find((event) => TERMINAL_TYPES.has(event.type));
  const last = events.at(-1);
  if (!terminal || terminal !== last) {
    return {
      meta,
      events,
      status: 'interrupted',
      replayable: false,
      truncatedTail,
      reason: truncatedTail ? 'ledger ended with a partial line' : 'run has no terminal event',
      raw,
    };
  }

  const status: RunStatus =
    terminal.type === 'run.completed'
      ? 'completed'
      : terminal.type === 'run.cancelled'
        ? 'cancelled'
        : 'failed';
  return {
    meta,
    events,
    status,
    finishedAt: terminal.ts,
    replayable: true,
    truncatedTail,
    raw,
  };
}
