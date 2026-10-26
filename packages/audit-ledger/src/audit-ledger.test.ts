import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  redact,
  redactHeaders,
  REDACTED,
  FileLedger,
  MemoryLedger,
  parseLedgerHistory,
} from '../src/index.js';
import type { WorkflowEvent } from '@simrs-flow/workflow-core';

describe('redact', () => {
  it('removes credential and token keys', () => {
    const input = {
      username: 'naufal',
      password: 'Pku@2026',
      token: 'abc123',
      cookie: 'ci_session=longblob',
      nested: { authorization: 'Bearer xyz', safe: 'keep' },
    };
    const out = redact(input);
    expect(out.password).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
    expect(out.cookie).toBe(REDACTED);
    expect(out.nested.authorization).toBe(REDACTED);
    expect(out.nested.safe).toBe('keep');
    expect(out.username).toBe('naufal');
  });

  it('redacts BPJS card and family card numbers', () => {
    const out = redact({ no_kartu: '0001234567890', no_kk: '3301234567890123' });
    expect(out.no_kartu).toBe(REDACTED);
    expect(out.no_kk).toBe(REDACTED);
  });

  it('masks PHI keys keeping a 2-char tail', () => {
    const out = redact({ nama_pasien: 'BUDI SANTOSO' });
    expect(out.nama_pasien).toBe(`${REDACTED}SO`);
  });

  it('scrubs ci_session blobs embedded in free strings', () => {
    const out = redact({ note: 'set ci_session=AAAA.BBBB; path=/' });
    expect(out.note).not.toContain('AAAA');
    expect(out.note).toContain(REDACTED);
  });

  it('does not mutate the input and handles cycles', () => {
    const input: Record<string, unknown> = { a: 1 };
    input.self = input;
    const out = redact(input) as Record<string, unknown>;
    expect((input as { a: number }).a).toBe(1);
    expect(out.self).toBe(REDACTED);
  });

  it('redacts header bags from object or entries', () => {
    expect(redactHeaders({ Cookie: 'ci_session=x', Accept: 'application/json' })).toEqual({
      Cookie: REDACTED,
      Accept: 'application/json',
    });
    expect(redactHeaders([['authorization', 'Bearer t'], ['x-app', '1']])).toEqual({
      authorization: REDACTED,
      'x-app': '1',
    });
  });
});

function evt(runId: string, seq: number, message: string): WorkflowEvent {
  return {
    schema: 'simrs.workflow.event.v1',
    eventId: `e${seq}`,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    runId,
    workflowId: 'wf',
    workflowVersion: '1.0.0',
    type: 'log.appended',
    source: 'runner',
    message,
  };
}

describe('MemoryLedger', () => {
  it('appends and reads back events per run, redacting payloads', async () => {
    const ledger = new MemoryLedger();
    await ledger.recordRun({
      runId: 'run_a',
      workflowId: 'wf',
      workflowVersion: '1.0.0',
      mode: 'preview',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    await ledger.appendMany([evt('run_a', 1, 'one'), evt('run_a', 2, 'two')]);
    const sensitive = { ...evt('run_a', 3, 'three'), data: { password: 'secret' } };
    await ledger.append(sensitive);

    const read = await ledger.read('run_a');
    expect(read).toHaveLength(3);
    expect(read[2]!.data).toEqual({ password: REDACTED });
    expect(await ledger.listRuns()).toContain('run_a');
    expect(await ledger.readJsonl('run_a')).toContain('"kind":"run.meta"');
  });
});

describe('FileLedger', () => {
  it('reads canonical redacted history from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'simrs-flow-ledger-'));
    try {
      const ledger = new FileLedger(dir);
      await ledger.recordRun({
        runId: 'run_disk',
        workflowId: 'wf',
        workflowVersion: '1.0.0',
        mode: 'preview',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      await ledger.append(evt('run_disk', 1, 'ci_session=secret'));
      await ledger.append({ ...evt('run_disk', 2, 'done'), type: 'run.completed' });

      const raw = await ledger.readJsonl('run_disk');
      expect(raw?.split('\n')[0]).toContain('"kind":"run.meta"');
      expect(raw).not.toContain('secret');
      expect((await new FileLedger(dir).readHistory('run_disk'))?.status).toBe('completed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parseLedgerHistory', () => {
  const meta = JSON.stringify({
    kind: 'run.meta',
    runId: 'run_a',
    workflowId: 'wf',
    workflowVersion: '1.0.0',
    mode: 'preview',
    startedAt: '2026-01-01T00:00:00.000Z',
  });

  it('reconstructs a terminal run', () => {
    const completed = { ...evt('run_a', 2, 'done'), type: 'run.completed' as const };
    const history = parseLedgerHistory(`${meta}\n${JSON.stringify(evt('run_a', 1, 'one'))}\n${JSON.stringify(completed)}\n`);
    expect(history.replayable).toBe(true);
    expect(history.status).toBe('completed');
    expect(history.events).toHaveLength(2);
  });

  it('tolerates only a malformed final tail', () => {
    const history = parseLedgerHistory(`${meta}\n${JSON.stringify(evt('run_a', 1, 'one'))}\n{"schema":`);
    expect(history.status).toBe('interrupted');
    expect(history.truncatedTail).toBe(true);
    expect(history.events).toHaveLength(1);
  });

  it('rejects interior corruption and invalid event sequence', () => {
    const interior = parseLedgerHistory(`${meta}\nnot-json\n${JSON.stringify(evt('run_a', 1, 'one'))}\n`);
    expect(interior.status).toBe('unreplayable');
    expect(interior.reason).toMatch(/line 2/);

    const startsAtTwo = parseLedgerHistory(`${meta}\n${JSON.stringify(evt('run_a', 2, 'one'))}\n`);
    expect(startsAtTwo.status).toBe('unreplayable');
    expect(startsAtTwo.reason).toMatch(/must be 1/);

    const duplicate = parseLedgerHistory(`${meta}\n${JSON.stringify(evt('run_a', 1, 'one'))}\n${JSON.stringify(evt('run_a', 1, 'again'))}\n`);
    expect(duplicate.status).toBe('unreplayable');
    expect(duplicate.reason).toMatch(/sequence/);
  });
});
