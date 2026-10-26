import { describe, it, expect } from 'vitest';
import type { RunLogEntry, RunState } from '@simrs-flow/workflow-core';
import { ranapWorkflow } from '@simrs-flow/domain-ranap';
import { classifyLogLine, groupLogs, logTime, statusCounts, stepProgress } from '../src/features/panels/logView.js';

function entry(seq: number, message: string, nodeId?: string, severity: RunLogEntry['severity'] = 'info'): RunLogEntry {
  return { seq, ts: `2026-06-10T08:0${seq % 10}:00.000Z`, severity, message, ...(nodeId ? { nodeId } : {}) };
}

describe('classifyLogLine', () => {
  it('recognises each shape the executors emit', () => {
    // The exact strings the ranap log produces, so a formatting change here
    // fails loudly rather than quietly losing its styling.
    expect(classifyLogLine('Mencari kunjungan yang bisa diproses...')).toBe('heading');
    expect(classifyLogLine('3. Sinkronisasi tindakan rawat inap untuk 1 transaksi...')).toBe('heading');
    expect(classifyLogLine('+ Ditemukan 1 kunjungan yang bisa diproses:')).toBe('bullet');
    expect(classifyLogLine('   + Sinkronisasi tindakan')).toBe('bullet');
    expect(classifyLogLine('    1. Unit      : RUANG ARAFAH KELAS 3')).toBe('numbered');
    expect(classifyLogLine('    - No RM      : 0-01-23-45')).toBe('pair');
    expect(classifyLogLine('       Tgl masuk : 2026-06-10')).toBe('plain');
  });

  it('prefers the indented shapes over the heading catch-all', () => {
    // A pair line is indented, so testing "starts with non-space" first would
    // have mislabelled every value row as a heading.
    expect(classifyLogLine('    - Hasil : SEP correct!')).not.toBe('heading');
  });
});

describe('groupLogs', () => {
  it('folds consecutive entries from one step into a single group', () => {
    const groups = groupLogs([
      entry(1, 'Run created'),
      entry(2, 'Mencari kunjungan...', 'load_visits'),
      entry(3, '+ Ditemukan 1 kunjungan:', 'load_visits'),
      entry(4, '    - Unit : ARAFAH', 'load_visits'),
      entry(5, 'Validasi SEP...', 'validate_sep'),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[1]!.nodeId).toBe('load_visits');
    expect(groups[1]!.entries).toHaveLength(3);
    expect(groups[2]!.nodeId).toBe('validate_sep');
  });

  it('re-opens a group when another step logs in between', () => {
    const groups = groupLogs([
      entry(1, 'a', 'load_visits'),
      entry(2, 'b', 'validate_sep'),
      entry(3, 'c', 'load_visits'),
    ]);
    expect(groups.map((group) => group.nodeId)).toEqual(['load_visits', 'validate_sep', 'load_visits']);
  });

  it('labels a group with the step name and its workflow section', () => {
    const groups = groupLogs([entry(1, 'Assignment hari ruang...', 'build_rooms')], ranapWorkflow);
    expect(groups[0]!.label).toBe('Susun Kamar');
    expect(groups[0]!.section).toBe('Kamar');
  });

  it('falls back to the node id, then to Run, when no definition is given', () => {
    const groups = groupLogs([entry(1, 'x', 'build_rooms'), entry(2, 'y')]);
    expect(groups[0]!.label).toBe('build_rooms');
    expect(groups[1]!.label).toBe('Run');
  });

  it('raises the group severity to the worst line it contains', () => {
    const groups = groupLogs([
      entry(1, 'ok', 'check_balance'),
      entry(2, 'careful', 'check_balance', 'warn'),
      entry(3, 'broken', 'check_balance', 'error'),
    ]);
    expect(groups[0]!.severity).toBe('error');
  });

  it('carries the node status so the header can show it', () => {
    const nodes = { build_rooms: { status: 'success' } } as unknown as RunState['nodes'];
    const groups = groupLogs([entry(1, 'x', 'build_rooms')], ranapWorkflow, nodes);
    expect(groups[0]!.status).toBe('success');
  });
});

describe('logTime', () => {
  it('reduces an ISO timestamp to wall-clock seconds', () => {
    expect(logTime('2026-06-10T08:04:00.000Z')).toBe('08:04:00');
  });

  it('passes a value it cannot slice through unchanged', () => {
    expect(logTime('08:04')).toBe('08:04');
  });
});

describe('statusCounts and stepProgress', () => {
  const nodes = {
    a: { status: 'success' },
    b: { status: 'success' },
    c: { status: 'needs_review' },
    d: { status: 'pending' },
    e: { status: 'blocked' },
  } as unknown as RunState['nodes'];

  it('orders statuses by pipeline position and drops empty buckets', () => {
    expect(statusCounts(nodes)).toEqual([
      { status: 'success', count: 2 },
      { status: 'needs_review', count: 1 },
      { status: 'blocked', count: 1 },
      { status: 'pending', count: 1 },
    ]);
  });

  it('counts only settled steps as done', () => {
    // `pending` is not settled; the other four are.
    expect(stepProgress(nodes)).toEqual({ done: 4, total: 5 });
  });

  it('handles a run that has not started', () => {
    expect(statusCounts(undefined)).toEqual([]);
    expect(stepProgress(undefined)).toEqual({ done: 0, total: 0 });
  });
});
