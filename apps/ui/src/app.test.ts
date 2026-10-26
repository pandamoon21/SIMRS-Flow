import { describe, expect, it } from 'vitest';
import { gateActionError, liveStartBlockerOf, runLostMessage, shouldShowWelcome } from './app/App.js';
import { dashboardPageHasContext, dashboardShellClassName } from './app/DashboardShell.js';
import { attentionOf, berkasProgressOf, cancelButtonLabel, currentNodeOf, outcomeDetail, patientOutcomesOf, previewGateStopOf, RUN_STATUS_LABEL } from './features/run/runStatus.js';
import type { RunState } from '@simrs-flow/workflow-core';
import { buildRajalInput, buildRanapInput } from './features/forms/RunInputForm.js';

describe('Dashboard shell', () => {
  it('collapses its grid only while navigation is hidden', () => {
    expect(dashboardShellClassName(true)).toBe('dashboard-shell');
    expect(dashboardShellClassName(false)).toBe('dashboard-shell dashboard-sidebar-hidden');
  });

  it('keeps contextual pages non-actionable without their context', () => {
    expect(dashboardPageHasContext('run', false, false)).toBe(false);
    expect(dashboardPageHasContext('review', true, false)).toBe(false);
    expect(dashboardPageHasContext('home', false, false)).toBe(true);
  });
});

describe('Run detail context', () => {
  const state = {
    runId: 'run-1',
    workflowId: 'wf',
    workflowVersion: '1.0.0',
    mode: 'preview',
    status: 'running',
    lastSeq: 0,
    nodes: {
      first: { id: 'first', status: 'success', attempt: 1, issues: [], warnings: [], evidence: [], proposedMutations: [], logs: [] },
      second: { id: 'second', status: 'gate_waiting', attempt: 1, issues: [], warnings: [], evidence: [], proposedMutations: [], logs: [] },
    },
    edges: {},
    gates: {},
    mutations: {},
    logs: [],
    metrics: {},
  } as RunState;

  it('derives the current node and separate attention from projected state', () => {
    expect(currentNodeOf(state)).toEqual({ id: 'second', status: 'gate_waiting' });
    expect(attentionOf(state)).toBe('Perlu perhatian: Menunggu persetujuan');
    expect(attentionOf({ ...state, status: 'failed' })).toBeUndefined();
    const stopped = { ...state, status: 'failed' as const, nodes: { ...state.nodes, second: { ...state.nodes.second!, status: 'blocked' as const } } };
    expect(attentionOf(stopped, (id) => id.toUpperCase())).toBe('Terblokir: SECOND');
    expect(RUN_STATUS_LABEL.completed).toBe('Selesai');
  });

  it('reads per-patient batch outcomes from the batch summary evidence', () => {
    expect(patientOutcomesOf(state)).toEqual([]);
    const rows = [{ patientId: '0-01-23-45', status: 'lolos', clinics: ['DALAM'], reason: '' }, { patientId: '0-23-45-67', status: 'dilewati', clinics: [], step: 'validate_sep', reason: 'x' }];
    const batch = { ...state, nodes: { ...state.nodes, first: { ...state.nodes.first!, evidence: [{ label: 'rajal.patient-outcomes', data: { rows } }] } } } as RunState;
    expect(patientOutcomesOf(batch)).toEqual(rows);
    const sep = { nodes: { validate_sep: { summary: '2 SEP transaksi tersisa; 3 dilewati — No RJTL SEP for poli BEDAH on transaction T-1; No RJTL SEP for poli ANAK on transaction T-2' } } } as never;
    expect(outcomeDetail(sep, { patientId: 'p', status: 'dilewati', clinics: [], transactions: ['T-2'], step: 'validate_sep', reason: 'generic' })).toBe('No RJTL SEP for poli ANAK on transaction T-2');
    expect(outcomeDetail(sep, { patientId: 'p', status: 'dilewati', clinics: [], transactions: ['T-9'], step: 'validate_sep', reason: 'generic' })).toBe('generic');
  });

  it('shows berkas progress only while the step runs, latest entry first', () => {
    const running = { ...state, nodes: { ...state.nodes, check_berkas: { ...state.nodes.first!, id: 'check_berkas', status: 'running' as const } } };
    expect(berkasProgressOf(running)).toEqual({ phase: 'mulai', label: 'mencari berkas e-klaim…' });
    const logs = [
      { ts: 't', seq: 1, severity: 'debug' as const, message: 'x', nodeId: 'check_berkas', data: { berkasProgress: { phase: 'unduh', done: 0, total: 1, label: 'mengunduh PDF berkas…' } } },
      { ts: 't', seq: 2, severity: 'debug' as const, message: 'y', nodeId: 'check_berkas', data: { berkasProgress: { phase: 'ocr', done: 3, total: 12, label: 'OCR foto 4/12 (hal. 61)' } } },
    ];
    expect(berkasProgressOf({ ...running, logs })).toEqual({ phase: 'ocr', label: 'OCR foto 4/12 (hal. 61)', percent: 25 });
    expect(berkasProgressOf({ ...state, logs })).toBeUndefined();
    // A lost or failed run leaves the node "running"; the chip goes away with the run.
    expect(berkasProgressOf({ ...running, logs, status: 'failed' })).toBeUndefined();
  });

  it('reads a preview held at its gate as finished, not failed', () => {
    const held = { ...state, status: 'failed' as const, gates: { second: { nodeId: 'second', status: 'rejected' } } as never,
      nodes: { ...state.nodes, second: { ...state.nodes.second!, status: 'blocked' as const } } };
    expect(previewGateStopOf(held)).toBe('second');
    expect(attentionOf(held, (id) => id.toUpperCase())).toBe('Ditahan di gerbang (preview): SECOND');
    // A write run, a non-gate stop, or a second stop is a real failure.
    expect(previewGateStopOf({ ...held, mode: 'write' })).toBeUndefined();
    expect(previewGateStopOf({ ...held, gates: {} })).toBeUndefined();
    expect(previewGateStopOf({ ...held, nodes: { ...held.nodes, first: { ...state.nodes.first!, status: 'failed' as const } } })).toBeUndefined();
  });

  it('prefers a queued or retrying node over a review that is already behind it', () => {
    const retrying = { ...state, nodes: { ...state.nodes, third: { ...state.nodes.first!, id: 'third', status: 'retrying' as const } } };
    expect(currentNodeOf(retrying)).toEqual({ id: 'third', status: 'retrying' });
    expect(attentionOf(retrying)).toBeUndefined();
  });
});



describe('Login welcome', () => {
  it('shows only when reduced motion is not preferred', () => {
    expect(shouldShowWelcome(false)).toBe(true);
    expect(shouldShowWelcome(true)).toBe(false);
  });
});

describe('App live start guard', () => {
  it('keeps offline replay startable without operator input', () => {
    expect(liveStartBlockerOf('offline', { summary: 'Input belum lengkap' })).toBeUndefined();
  });

  it('explains why live orchestrator cannot start yet', () => {
    expect(liveStartBlockerOf('live', { summary: 'Ranap belum lengkap' })).toBe('Input run belum lengkap.');
    expect(liveStartBlockerOf('live', { error: 'No. RM wajib diisi.', summary: 'Ranap belum lengkap' })).toBe(
      'No. RM wajib diisi.',
    );
  });

  it('allows live orchestrator start once input is valid', () => {
    const input = buildRanapInput({
      noRm: '0-90-00-09',
      tanggal: '2026-06-26',
      toleranceDays: '3',
      acceptedPenjaminKeywords: '',
    });
    expect(liveStartBlockerOf('live', input)).toBeUndefined();
  });

  it('puts no cap on live batch size (production runs whole clinic-days)', () => {
    const base = {
      patientIds: '', clinics: 'PENYAKIT DALAM', date: '2026-06-26', acceptedPenjaminKeywords: '',
      tindakanIncludeKeywords: '', tindakanExcludeKeywords: '', tindakanMinCount: '',
    };
    const big = buildRajalInput({ ...base, patientIds: Array.from({ length: 500 }, (_, i) => `0${String(100000 + i)}`).join(', ') });
    expect((big.input as { patientIds: string[] }).patientIds).toHaveLength(500);
    expect(liveStartBlockerOf('live', big)).toBeUndefined();
    const discovered = buildRajalInput({ ...base, mode: 'discover', clinics: '', discoverFrom: '2026-06-26', discoverTo: '2026-06-26' });
    expect(liveStartBlockerOf('live', discovered)).toBeUndefined();
  });
});

describe('Lost run stream', () => {
  it('ends a run the orchestrator no longer knows, and leaves blips alone', () => {
    expect(runLostMessage('run_not_found')).toMatch(/orchestrator restart/);
    expect(runLostMessage('SSE connection failed after several attempts — check the orchestrator')).toMatch(/putus/);
    expect(runLostMessage('SSE connection lost — reconnecting…')).toBeUndefined();
  });
});

describe('Operator feedback on irreversible actions', () => {
  it('reports a failed gate decision instead of swallowing it', () => {
    expect(gateActionError('approve', new Error('run locked'))).toBe('Gagal menyetujui gate: run locked');
    expect(gateActionError('reject', 'offline')).toBe('Gagal menolak gate: offline');
  });

  it('makes the cancel button ask before it fires', () => {
    expect(cancelButtonLabel(false)).toBe('Stop run');
    expect(cancelButtonLabel(true)).toBe('Klik lagi untuk stop');
  });
});
