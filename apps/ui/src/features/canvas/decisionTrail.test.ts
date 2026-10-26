import { describe, expect, it } from 'vitest';
import { reasoningEvidence, type NodeRuntimeState, type RunState, type WorkflowDefinition } from '@simrs-flow/workflow-core';
import { decisionTrailOf, nextStepOf } from './decisionTrail.js';

const node = (patch: Partial<NodeRuntimeState>): NodeRuntimeState => ({
  id: 'visite', status: 'success', attempt: 1, issues: [], warnings: [], evidence: [], proposedMutations: [], logs: [], ...patch,
});
const plan = (id: string, reason: string) => ({ id, endpointId: 'penatajasaInap.tambahTindakan', reason }) as NodeRuntimeState['proposedMutations'][number];

describe('decision trail', () => {
  it('shows checked days, and turns a fixed ✗ into ✓ once its write is verified', () => {
    const rt = node({
      evidence: [reasoningEvidence({
        title: 'Total 3 hari (17–19 Okt)',
        items: [
          { label: 'Visite DPJP tgl 17', ok: true },
          { label: 'Visite DPJP tgl 18', ok: true },
          { label: 'Visite DPJP tgl 19', ok: false, planId: 'p19' },
        ],
      })],
      proposedMutations: [plan('p19', 'Tambah visite DPJP tgl 19')],
    });
    const planned = decisionTrailOf(rt, { p19: { planId: 'p19', endpointId: 'e', status: 'planned' } });
    expect(planned.title).toBe('Total 3 hari (17–19 Okt)');
    expect(planned.items.map((i) => i.mark)).toEqual(['ok', 'ok', 'plan']);
    expect(planned.items[2]!.detail).toBe('direncanakan');

    const fixed = decisionTrailOf(rt, { p19: { planId: 'p19', endpointId: 'e', status: 'verified' } });
    expect(fixed.items[2]).toEqual({ mark: 'ok', text: 'Visite DPJP tgl 19', detail: 'diperbaiki & terverifikasi' });
  });

  it('falls back to plans, errors and warnings when a step has no checklist', () => {
    const rt = node({
      proposedMutations: [plan('p1', 'Koreksi SEP kasir')],
      issues: [{ code: 'x', message: 'SEP tidak cocok', severity: 'error' }, { code: 'i', message: 'info', severity: 'info' }],
      warnings: [{ code: 'w', message: 'Toleransi dipakai', severity: 'warn' }],
    });
    expect(decisionTrailOf(rt, { p1: { planId: 'p1', endpointId: 'e', status: 'failed' } }).items).toEqual([
      { mark: 'fail', text: 'Koreksi SEP kasir', detail: 'write gagal' },
      { mark: 'fail', text: 'SEP tidak cocok' },
      { mark: 'warn', text: 'Toleransi dipakai' },
    ]);
  });

  it('names the steps a finished node led to and the ones it ruled out', () => {
    const definition = {
      nodes: [{ id: 'gate', label: 'Gerbang' }, { id: 'verify', label: 'Verifikasi' }, { id: 'pay', label: 'Bayar' }],
      edges: [{ id: 'e1', source: 'gate', target: 'verify', label: 'disetujui' }, { id: 'e2', source: 'gate', target: 'pay' }],
    } as unknown as WorkflowDefinition;
    const state = {
      nodes: { gate: node({ id: 'gate' }), verify: node({ id: 'verify', status: 'running' }), pay: node({ id: 'pay', status: 'skipped' }) },
      edges: { e1: { id: 'e1', status: 'completed' }, e2: { id: 'e2', status: 'skipped' } },
    } as unknown as RunState;
    expect(nextStepOf(definition, state, 'gate')).toEqual({ go: ['Verifikasi (disetujui)'], stop: ['Bayar'] });
    expect(nextStepOf(definition, state, 'verify')).toBeUndefined();
  });
});
