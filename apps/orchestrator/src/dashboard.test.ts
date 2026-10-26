import { describe, it, expect } from 'vitest';
import type { LedgerHistory } from '@simrs-flow/audit-ledger';
import type { WorkflowEvent } from '@simrs-flow/workflow-core';
import { MemoryLedger } from '@simrs-flow/audit-ledger';
import { ranapWorkflow } from '@simrs-flow/domain-ranap';
import { RANAP_HAPPY_INPUT } from '@simrs-flow/test-fixtures';
import { billingSummary, rupiah, shiftOf, summarizeRun, wibParts } from './dashboard.js';
import { buildServer } from './server.js';

let seq = 0;
const ev = (type: string, extra: Partial<WorkflowEvent> = {}): WorkflowEvent =>
  ({ schema: 'simrs.workflow.event.v1', eventId: `e${++seq}`, seq, ts: '2026-10-20T01:00:00Z', runId: 'r1', workflowId: 'x', workflowVersion: '1', source: 'runner', type, ...extra }) as WorkflowEvent;

const history = (workflowId: string, mode: 'preview' | 'write', events: WorkflowEvent[], status: LedgerHistory['status'] = 'completed'): LedgerHistory => ({
  meta: { runId: 'r1', workflowId, workflowVersion: '1', mode, startedAt: '2026-10-20T01:30:00Z', operator: 'op-a' },
  events,
  status,
  replayable: true,
  truncatedTail: false,
  raw: '',
});

const plan = (id: string, payloadSummary: Record<string, unknown>) =>
  ev('mutation.planned', { data: { id, endpointId: 'kasir.tampungBayar', payloadSummary } });

describe('dashboard helpers', () => {
  it('reads WIB date/time/shift and rupiah text', () => {
    expect(wibParts('2026-10-20T17:30:00Z')).toEqual({ date: '2026-10-21', time: '00:30', minutes: 30 });
    expect([shiftOf(7 * 60), shiftOf(14 * 60), shiftOf(20 * 60), shiftOf(6 * 60 + 59)]).toEqual([1, 2, 3, 3]);
    expect([rupiah('Rp 1.234.567'), rupiah('345700'), rupiah('1.000,50'), rupiah(undefined)]).toEqual([1234567, 345700, 1000, 0]);
  });

  it('ranap: one patient; titipan and nominal only from a verified tampung bayar', () => {
    const part = summarizeRun(history('ranap-verifikasi-tampung-bayar', 'write', [
      ev('node.succeeded', { nodeId: 'normalize_input', data: { evidence: [{ label: 'reasoning', data: { items: [{ label: 'Format No RM valid', detail: '0-12-34-56' }] } }] } }),
      ev('log.appended', { message: '    - Nama pasien    : PASIEN SATU' }),
      ev('node.needs_review', { nodeId: 'evaluate_titipan', data: { evidence: [{ label: 'titipan', data: [{ isTitipan: true }] }] } }),
      plan('p1', { grand_total: 'Rp 2.500.000' }),
      plan('p2', { grand_total: 'Rp 9.000.000' }),
      ev('mutation.verified', { data: { planId: 'p1' } }),
      ev('gate.waiting', { nodeId: 'final_gate' }),
      ev('gate.approved', { nodeId: 'final_gate' }),
    ]), new Set());
    expect(part.patients).toEqual([expect.objectContaining({
      noRm: '0-12-34-56', name: 'PASIEN SATU', workflow: 'ranap', category: 'titipan', nominal: 2_500_000,
      status: 'done', date: '2026-10-20', time: '08:30', shift: 1, operator: 'op-a',
    })]);
    expect(part.gate).toEqual({ approved: 1, rejected: 0, pending: 0 });
  });

  it('ranap: naik kelas from the sheet; preview gates and unverified plans do not count', () => {
    const part = summarizeRun(history('ranap-verifikasi-tampung-bayar', 'preview', [
      ev('node.succeeded', { nodeId: 'normalize_input', data: { evidence: [{ label: 'reasoning', data: { items: [{ label: 'Format No RM valid', detail: '0-12-34-56' }] } }] } }),
      plan('p1', { grand_total: 'Rp 2.500.000' }),
      ev('gate.rejected', { nodeId: 'final_gate' }),
    ], 'failed'), new Set(['0-12-34-56']));
    expect(part.patients[0]).toMatchObject({ category: 'naik_kelas', nominal: 0, status: 'needs_review' });
    expect(part.gate).toEqual({ approved: 0, rejected: 0, pending: 0 });
  });

  it('rajal: a row per batch patient, nominal matched by transaction', () => {
    const dtBayar = new URLSearchParams({ txtjumlah_pembayaran: '345700' }).toString();
    const part = summarizeRun(history('rajal-patient-processor', 'write', [
      plan('p1', { no_transaksi: '01-1', dt_bayar: dtBayar }),
      ev('mutation.verified', { data: { planId: 'p1' } }),
      ev('node.succeeded', { nodeId: 'emit_batch_summary', data: { evidence: [{ label: 'rajal.patient-outcomes', data: { rows: [
        { patientId: '0-12-34-56', status: 'lolos', transactions: ['01-1'] },
        { patientId: '0-90-00-01', status: 'dilewati', transactions: ['01-2'] },
      ] } }] } }),
    ]), new Set());
    expect(part.patients.map((p) => [p.noRm, p.nominal, p.status])).toEqual([['0-12-34-56', 345_700, 'done'], ['0-90-00-01', 0, 'needs_review']]);
  });

  it('ranap: older runs name the medrec only in the start log line', () => {
    const part = summarizeRun(history('ranap-verifikasi-tampung-bayar', 'write', [
      ev('log.appended', { nodeId: 'normalize_input', message: 'Proses pengerjaan billing rawat inap untuk no rm 0-90-00-02 dimulai' }),
      ev('node.succeeded', { nodeId: 'normalize_input', data: { summary: '1 medrec' } }),
    ]), new Set());
    expect(part.patients.map((p) => p.noRm)).toEqual(['0-90-00-02']);
  });

  it('a waiting gate is pending only while the run is live', () => {
    const events = [ev('gate.waiting', { nodeId: 'final_gate' })];
    expect(summarizeRun(history('ranap-x', 'write', events, 'interrupted'), new Set(), true).gate.pending).toBe(1);
    expect(summarizeRun(history('ranap-x', 'write', events, 'interrupted'), new Set(), false).gate.pending).toBe(0);
  });

  it('billingSummary: 14 WIB days ending today, today-only category counts', () => {
    const p = (date: string, category: 'titipan' | 'naik_kelas' | 'normal', nominal: number) =>
      ({ noRm: '', name: '', workflow: 'ranap' as const, date, category, nominal, status: 'done' as const, operator: '', time: '', shift: 1 as const, runId: '' });
    const sum = billingSummary([
      { patients: [p('2026-10-20', 'titipan', 100), p('2026-10-20', 'naik_kelas', 50), p('2026-10-01', 'normal', 999)], gate: { approved: 2, rejected: 1, pending: 1 } },
    ], new Date('2026-10-20T03:00:00Z'));
    expect(sum.days).toHaveLength(14);
    expect(sum.days.at(-1)).toEqual({ date: '2026-10-20', amount: 150 });
    expect(sum.days[0]!.date).toBe('2026-10-07');
    expect(sum).toMatchObject({ titipanToday: 1, naikKelasToday: 1, gate: { approved: 2, rejected: 1, pending: 1 } });
  });
});

describe('dashboard routes', () => {
  it('serve ledger-derived rows, never demo data', async () => {
    const app = buildServer({ ledger: new MemoryLedger(), qaAuth: { token: 't', operator: 'op' } });
    const AUTH = { authorization: 'Bearer t' };
    const empty = (await app.inject({ method: 'GET', url: '/api/patients', headers: AUTH })).json();
    expect(empty).toEqual({ patients: [] });

    const created = await app.inject({ method: 'POST', url: '/api/runs', payload: { workflowId: ranapWorkflow.id, mode: 'preview', input: RANAP_HAPPY_INPUT } });
    await (app as any).runService.waitFor(created.json().runId);
    const { patients } = (await app.inject({ method: 'GET', url: '/api/patients', headers: AUTH })).json();
    expect(patients).toEqual([expect.objectContaining({ noRm: '0-01-23-45', workflow: 'ranap', nominal: 0, runId: created.json().runId })]);
    const billing = (await app.inject({ method: 'GET', url: '/api/billing/summary', headers: AUTH })).json();
    expect(billing.demo).toBeUndefined();
    expect(billing.days).toHaveLength(14);
  });
});

describe('team board', () => {
  it('keeps sticky notes across a restart and lists only real operators', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const notesFile = join(mkdtempSync(join(tmpdir(), 'notes-')), 'notes.json');
    const AUTH = { authorization: 'Bearer t' };
    const first = buildServer({ ledger: new MemoryLedger(), qaAuth: { token: 't', operator: 'op' }, notesFile });
    expect((await first.inject({ method: 'GET', url: '/api/notes', headers: AUTH })).json()).toEqual({ notes: [] });
    expect((await first.inject({ method: 'POST', url: '/api/notes', headers: AUTH, payload: { text: 'cek titipan', color: 'sky' } })).statusCode).toBe(201);
    const presence = (await first.inject({ method: 'GET', url: '/api/presence', headers: AUTH })).json();
    expect(presence.operators.map((o: { name: string }) => o.name)).toEqual(['op']);

    const second = buildServer({ ledger: new MemoryLedger(), qaAuth: { token: 't', operator: 'op' }, notesFile });
    const { notes } = (await second.inject({ method: 'GET', url: '/api/notes', headers: AUTH })).json();
    expect(notes).toEqual([expect.objectContaining({ id: 'n1', author: 'op', text: 'cek titipan', color: 'sky' })]);
    expect((await second.inject({ method: 'POST', url: '/api/notes', headers: AUTH, payload: { text: 'dua' } })).json().note.id).toBe('n2');
  });
});
