/**
 * Append-only audit ledger.
 *
 * Safety control #13: "Audit event append-only". Every run gets its own
 * JSONL file. Events are redacted before they touch disk. The ledger never
 * rewrites or truncates existing lines — it only appends.
 *
 * Two backends are provided:
 *  - FileLedger    : Node fs, one JSONL file per run (production-local)
 *  - MemoryLedger  : in-process array (tests, ephemeral runs)
 *
 * Both implement the same Ledger interface so callers are storage-agnostic.
 */

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowEvent } from '@simrs-flow/workflow-core';
import { redact } from './redaction.js';
import { parseLedgerHistory, type LedgerHistory, type RunMetadata } from './history.js';

export interface Ledger {
  /** Record run metadata (written once at run start). */
  recordRun(meta: RunMetadata): Promise<void>;
  /** Append a single event (redacted before persistence). */
  append(event: WorkflowEvent): Promise<void>;
  /** Append many events in order. */
  appendMany(events: readonly WorkflowEvent[]): Promise<void>;
  /** Read back all events for a run, in order. */
  read(runId: string): Promise<WorkflowEvent[]>;
  /** List known run ids. */
  listRuns(): Promise<string[]>;
  /** Read validated metadata + events for dashboard history. */
  readHistory(runId: string): Promise<LedgerHistory | undefined>;
  /** Canonical redacted JSONL, including the run.meta line. */
  readJsonl(runId: string): Promise<string | undefined>;
}

/** In-memory ledger for tests and ephemeral runs. */
export class MemoryLedger implements Ledger {
  private events = new Map<string, WorkflowEvent[]>();
  private meta = new Map<string, RunMetadata>();

  async recordRun(meta: RunMetadata): Promise<void> {
    this.meta.set(meta.runId, meta);
    if (!this.events.has(meta.runId)) this.events.set(meta.runId, []);
  }

  async append(event: WorkflowEvent): Promise<void> {
    const list = this.events.get(event.runId) ?? [];
    list.push(redact(event));
    this.events.set(event.runId, list);
  }

  async appendMany(events: readonly WorkflowEvent[]): Promise<void> {
    for (const e of events) await this.append(e);
  }

  async read(runId: string): Promise<WorkflowEvent[]> {
    return [...(this.events.get(runId) ?? [])];
  }

  async listRuns(): Promise<string[]> {
    return [...this.events.keys()];
  }

  async readJsonl(runId: string): Promise<string | undefined> {
    const meta = this.meta.get(runId);
    if (!meta) return undefined;
    const lines = [JSON.stringify({ kind: 'run.meta', ...redact(meta) })];
    lines.push(...(this.events.get(runId) ?? []).map((event) => JSON.stringify(event)));
    return `${lines.join('\n')}\n`;
  }

  async readHistory(runId: string): Promise<LedgerHistory | undefined> {
    const raw = await this.readJsonl(runId);
    return raw === undefined ? undefined : parseLedgerHistory(raw);
  }

  getMeta(runId: string): RunMetadata | undefined {
    return this.meta.get(runId);
  }
}

/** File-backed JSONL ledger. One file per run: `<dir>/<runId>.jsonl`. */
export class FileLedger implements Ledger {
  constructor(private readonly dir: string) {}

  private runFile(runId: string): string {
    // runId is generated internally (run_<ts>_<counter>); still guard against
    // path traversal from any externally-supplied id.
    const safe = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.dir, `${safe}.jsonl`);
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dir)) {
      await mkdir(this.dir, { recursive: true });
    }
  }

  async recordRun(meta: RunMetadata): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify({ kind: 'run.meta', ...redact(meta) }) + '\n';
    await appendFile(this.runFile(meta.runId), line, 'utf8');
  }

  async append(event: WorkflowEvent): Promise<void> {
    await this.ensureDir();
    const line = JSON.stringify(redact(event)) + '\n';
    await appendFile(this.runFile(event.runId), line, 'utf8');
  }

  async appendMany(events: readonly WorkflowEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.ensureDir();
    // Group by run so each file gets a single append call.
    const byRun = new Map<string, string[]>();
    for (const e of events) {
      const arr = byRun.get(e.runId) ?? [];
      arr.push(JSON.stringify(redact(e)));
      byRun.set(e.runId, arr);
    }
    for (const [runId, lines] of byRun) {
      await appendFile(this.runFile(runId), lines.join('\n') + '\n', 'utf8');
    }
  }

  async readJsonl(runId: string): Promise<string | undefined> {
    const file = this.runFile(runId);
    if (!existsSync(file)) return undefined;
    return readFile(file, 'utf8');
  }

  async readHistory(runId: string): Promise<LedgerHistory | undefined> {
    const raw = await this.readJsonl(runId);
    return raw === undefined ? undefined : parseLedgerHistory(raw);
  }

  async read(runId: string): Promise<WorkflowEvent[]> {
    const history = await this.readHistory(runId);
    return history?.events ?? [];
  }

  async listRuns(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    const files = await readdir(this.dir);
    return files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length));
  }
}
