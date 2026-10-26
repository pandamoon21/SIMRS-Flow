import { describe, expect, it } from 'vitest';
import type { RunSummary } from './api/client.js';
import { filterRuns, isPreviewGateStop, needsAttention, runStatusLabel, openRunTitle, relativeTime, runDuration, runProvenanceLabel, splitRuns } from './features/history/RunHistory.js';
import { isNodeActivationKey } from './features/canvas/WorkflowNode.js';

// Keep the UI's keyboard and provenance contracts pure so they can be checked without a browser.

function run(status: RunSummary['status']): RunSummary {
  return {
    runId: `run-${status}`,
    workflowId: 'wf',
    workflowVersion: '1.0.0',
    mode: 'preview',
    status,
    startedAt: '2026-07-21T00:00:00.000Z',
    replayable: status === 'completed',
    source: 'ledger',
  };
}

describe('splitRuns', () => {
  it('separates active runs from terminal and unreplayable history', () => {
    const { active, recent } = splitRuns([
      run('created'),
      run('running'),
      run('paused'),
      run('completed'),
      run('interrupted'),
      run('unreplayable'),
    ]);

    expect(active.map((item) => item.status)).toEqual(['created', 'running', 'paused']);
    expect(recent.map((item) => item.status)).toEqual(['completed', 'interrupted', 'unreplayable']);
  });

  it('flags only the runs an operator has to look at', () => {
    expect(['failed', 'paused', 'unreplayable'].map((s) => needsAttention(run(s as RunSummary['status'])))).toEqual([true, true, true]);
    expect(['completed', 'running', 'created'].map((s) => needsAttention(run(s as RunSummary['status'])))).toEqual([false, false, false]);
  });

  it('explains a disabled open button rather than leaving a dead control', () => {
    expect(openRunTitle(false)).toMatch(/no replayable event log/i);
    expect(openRunTitle(true)).not.toMatch(/no replayable/i);
  });

  it('labels storage provenance without inventing execution source', () => {
    expect(runProvenanceLabel(run('completed'))).toBe('Historical ledger');
    expect(runProvenanceLabel({ ...run('running'), source: 'memory' })).toBe('In-memory run');
  });
});

describe('Workflow node keyboard activation', () => {
  it('uses Enter and Space only', () => {
    expect(isNodeActivationKey('Enter')).toBe(true);
    expect(isNodeActivationKey(' ')).toBe(true);
    expect(isNodeActivationKey('Escape')).toBe(false);
  });
});

describe('history list helpers', () => {
  const now = Date.parse('2026-10-18T12:00:00.000Z');
  it('describes age relative to now', () => {
    expect(relativeTime('2026-10-18T11:55:00.000Z', now)).toBe('5 menit yang lalu');
    expect(relativeTime('2026-10-18T11:59:50.000Z', now)).toBe('baru saja');
    expect(relativeTime('2026-10-17T12:00:00.000Z', now)).toBe('kemarin');
    expect(relativeTime(undefined, now)).toBe('—');
  });

  it('computes duration only for finished runs', () => {
    expect(runDuration({ startedAt: '2026-10-18T12:00:00.000Z', finishedAt: '2026-10-18T12:01:05.000Z' })).toBe('1m 5s');
    expect(runDuration({ startedAt: '2026-10-18T12:00:00.000Z' })).toBe('—');
  });

  it('filters by status group, workflow and query, with live runs first', () => {
    const runs = [
      { ...run('completed'), runId: 'a-done', workflowId: 'ranap', operator: 'budi' },
      { ...run('failed'), runId: 'b-fail', workflowId: 'rajal' },
      { ...run('running'), runId: 'c-live', workflowId: 'ranap' },
    ];
    expect(filterRuns(runs, 'all', '', '').map((r) => r.runId)).toEqual(['c-live', 'a-done', 'b-fail']);
    expect(filterRuns(runs, 'attention', '', '').map((r) => r.runId)).toEqual(['b-fail']);
    expect(filterRuns(runs, 'all', 'ranap', '').map((r) => r.runId)).toEqual(['c-live', 'a-done']);
    expect(filterRuns(runs, 'all', '', 'BUDI').map((r) => r.runId)).toEqual(['a-done']);
  });
});

describe('preview gate stop in run lists', () => {
  it('labels a preview held at the final gate as finished and keeps it out of attention', () => {
    const held = { ...run('failed'), mode: 'preview' as const, reason: 'Critical node "Gerbang Akhir" blocked: Preview mode — gate held' };
    expect(isPreviewGateStop(held)).toBe(true);
    expect(runStatusLabel(held)).toBe('Preview selesai');
    expect(needsAttention(held)).toBe(false);
    expect(filterRuns([held], 'failed', '', '')).toEqual([]);
    expect(filterRuns([held], 'completed', '', '')).toEqual([held]);
    const realFailure = { ...held, reason: 'Critical node "Ambil Kunjungan" failed: timeout' };
    expect(isPreviewGateStop(realFailure)).toBe(false);
    expect(needsAttention(realFailure)).toBe(true);
    expect(isPreviewGateStop({ ...held, mode: 'write' as const })).toBe(false);
  });
});
