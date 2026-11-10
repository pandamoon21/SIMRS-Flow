import { describe, expect, it } from 'vitest';
import { fixedClock } from './ids.js';
import type { ExecutorContext } from './types.js';
import {
  attempt,
  blocked,
  fail,
  failedReads,
  flag,
  ok,
  planResult,
  readFailureCount,
  review,
  rowsField,
  rowsOf,
  skipped,
  softJson,
  softText,
  str,
  warning,
  type StepReadClient,
} from './stepKit.js';

function ctxWithLog(): { ctx: ExecutorContext; logs: Array<[string, string | undefined]> } {
  const logs: Array<[string, string | undefined]> = [];
  const ctx = {
    runId: 'run_1',
    mode: 'preview',
    scratch: {},
    input: {},
    log: (message: string, severity?: string) => logs.push([message, severity]),
    signal: new AbortController().signal,
    clock: fixedClock(),
    mutations: {},
    pass: 1,
  } as unknown as ExecutorContext;
  return { ctx, logs };
}

const failing: StepReadClient = {
  postJson: () => Promise.reject(new Error('boom')),
  postText: () => Promise.reject(new Error('boom')),
};

describe('step results', () => {
  it('builds each status and carries extra fields', () => {
    expect(ok('a')).toEqual({ status: 'success', summary: 'a' });
    expect(fail('b', { branches: { e: 'skip' } })).toEqual({ status: 'failed', summary: 'b', branches: { e: 'skip' } });
    expect(blocked('c').status).toBe('blocked');
    expect(skipped('d').status).toBe('skipped');
    expect(review('e').status).toBe('needs_review');
    expect(planResult('none', [])).toEqual({ status: 'skipped', summary: 'none' });
    expect(warning('code_x', 'msg')).toEqual({ code: 'code_x', message: 'msg', severity: 'warn' });
  });
});

describe('soft reads', () => {
  it('returns the fallback, logs at debug and counts the failure per endpoint', async () => {
    const { ctx, logs } = ctxWithLog();
    expect(await softJson(ctx, failing, 'a.read', {})).toBeUndefined();
    expect(await softText(ctx, failing, 'a.read', {})).toBe('');
    expect(readFailureCount(ctx, 'a.read')).toBe(2);
    expect(failedReads(ctx, 'a.read', 'b.read')).toEqual(['a.read']);
    expect(logs).toEqual([['Read a.read gagal: boom', 'debug'], ['Read a.read gagal: boom', 'debug']]);
  });

  it('passes the signal and query through on success', async () => {
    const { ctx } = ctxWithLog();
    const seen: unknown[] = [];
    const client: StepReadClient = {
      postJson: async (_id, _data, options) => {
        seen.push(options);
        return { rows: [] } as never;
      },
      postText: async () => 'x',
    };
    await softJson(ctx, client, 'a.read', {}, { query: { q: '1' } });
    expect(seen).toEqual([{ signal: ctx.signal, query: { q: '1' } }]);
    expect(readFailureCount(ctx, 'a.read')).toBe(0);
  });

  it('attempt reports a failure instead of throwing', async () => {
    expect(await attempt(() => Promise.resolve(3))).toEqual({ ok: true, value: 3 });
    const failed = await attempt(() => Promise.reject(new Error('nope')));
    expect(failed.ok).toBe(false);
    expect(!failed.ok && failed.message).toBe('nope');
  });
});

describe('row coercion', () => {
  it('reads the legacy envelopes and scalars', () => {
    expect(rowsOf({ data: [{ a: 1 }, 2] })).toEqual([{ a: 1 }]);
    expect(rowsField<{ a: number }>({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(rowsField(undefined)).toEqual([]);
    expect(str({ a: ' null ', b: ' x ' }, 'a', 'b')).toBe('x');
    expect(flag('Ya')).toBe(true);
    expect(flag('0')).toBe(false);
  });
});
