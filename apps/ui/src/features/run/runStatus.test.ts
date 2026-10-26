import { describe, expect, it } from 'vitest';
import type { RunState } from '@simrs-flow/workflow-core';
import { durationLabel, runOutcomeOf } from './runStatus.js';

const base = {
  runId: 'r1', workflowId: 'w', workflowVersion: '1', mode: 'preview', lastSeq: 0,
  edges: {}, gates: {}, metrics: {},
} as const;

describe('runOutcomeOf', () => {
  it('summarises steps, wall-clock time, problems, writes and the stop node', () => {
    const state = {
      ...base,
      status: 'failed',
      startedAt: '2026-10-18T10:00:00.000Z',
      finishedAt: '2026-10-18T10:01:05.000Z',
      nodes: {
        a: { id: 'a', status: 'success', durationMs: 900 },
        b: { id: 'b', status: 'failed', durationMs: 100 },
        c: { id: 'c', status: 'pending' },
      },
      mutations: {
        p1: { planId: 'p1', endpointId: 'e', status: 'verified' },
        p2: { planId: 'p2', endpointId: 'e', status: 'invalidated' },
        p3: { planId: 'p3', endpointId: 'e', status: 'planned' },
      },
      logs: [
        { seq: 1, severity: 'info', message: 'ok' },
        { seq: 2, severity: 'warn', message: 'hmm' },
        { seq: 3, severity: 'error', message: 'no' },
      ],
    } as unknown as RunState;
    expect(runOutcomeOf(state)).toEqual({
      done: 2, total: 3, durationMs: 65_000, problems: 2,
      mutations: { verified: 1, failed: 1, open: 1 },
      stopNodeId: 'b',
    });
  });

  it('falls back to summed step time and an empty outcome', () => {
    const state = { ...base, status: 'running', nodes: { a: { id: 'a', status: 'success', durationMs: 400 } }, mutations: {}, logs: [] } as unknown as RunState;
    expect(runOutcomeOf(state).durationMs).toBe(400);
    expect(runOutcomeOf(undefined)).toEqual({ done: 0, total: 0, durationMs: 0, problems: 0, mutations: { verified: 0, failed: 0, open: 0 } });
  });

  it('formats durations for operators', () => {
    expect(durationLabel(420)).toBe('420ms');
    expect(durationLabel(5_000)).toBe('5.0s');
    expect(durationLabel(65_000)).toBe('1m 5s');
  });
});
