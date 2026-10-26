import { describe, it, expect } from 'vitest';
import { MemoryLedger } from '@simrs-flow/audit-ledger';
import { FixtureTransport, type TransportRequest } from '@simrs-flow/evomedis-client';
import { rajalWorkflow } from '@simrs-flow/domain-rajal';
import { ranapWorkflow } from '@simrs-flow/domain-ranap';
import { RANAP_HAPPY_INPUT } from '@simrs-flow/test-fixtures';
import { QaTransport, qaFixtures } from './qaTransport.js';
import { buildServer } from './server.js';

const req = (endpointId: string, extra: Partial<TransportRequest> = {}): TransportRequest =>
  ({ url: 'http://x', method: 'POST', headers: { 'x-endpoint-id': endpointId, cookie: 'ci_session=a' }, body: '', timeoutMs: 20, ...extra });

describe('QaTransport', () => {
  it('fails only the matching endpoint, after N calls, for `times` calls', async () => {
    const inner = new FixtureTransport({ 'a.read': { text: 'ok' }, 'b.read': { text: 'ok' } });
    const qa = new QaTransport(inner, { faults: [{ kind: 'http500', endpointId: 'a.read', afterCalls: 1, times: 1 }] });
    const statuses = [];
    for (const id of ['a.read', 'b.read', 'a.read', 'a.read']) statuses.push((await qa.send(req(id))).status);
    expect(statuses).toEqual([200, 200, 500, 200]);
  });

  it('simulates timeout, network loss, a login page and a dropped cookie', async () => {
    let seenCookie: string | undefined = 'unset';
    const inner = { send: async (r: TransportRequest) => { seenCookie = r.headers.cookie; return { status: 200, text: 'ok', headers: {}, setCookies: [] }; } };
    await expect(new QaTransport(inner, { faults: [{ kind: 'timeout' }] }).send(req('x'))).rejects.toMatchObject({ name: 'AbortError' });
    await expect(new QaTransport(inner, { faults: [{ kind: 'network' }] }).send(req('x'))).rejects.toThrow('fetch failed');
    expect((await new QaTransport(inner, { faults: [{ kind: 'loginPage' }] }).send(req('x'))).text).toContain('form-login');
    await new QaTransport(inner, { faults: [{ kind: 'dropCookie' }] }).send(req('x'));
    expect(seenCookie).toBeUndefined();
  });

  it('refuses unknown scenarios and gives each synthetic rajal medrec its own visit', () => {
    expect(() => qaFixtures('ranap', 'nope')).toThrow('unknown QA scenario');
    const entry = qaFixtures('rajal', 'rajal-synthetic')['kasir.getHistoryKunjungan'] as (r: TransportRequest) => { text: string };
    const trx = (rm: string) => JSON.parse(entry(req('kasir.getHistoryKunjungan', { body: `nomedrec=${rm}` })).text).rows[0].no_transaksi;
    expect(trx('0-80-00-01')).not.toBe(trx('0-80-00-02'));
  });
});

describe('QA runs through the orchestrator', () => {
  const AUTH = { authorization: 'Bearer t' };

  it('runs a 50-patient synthetic rajal batch to one outcome row per patient', async () => {
    const app = buildServer({ ledger: new MemoryLedger(), qaAuth: { token: 't', operator: 'op' } });
    const patientIds = Array.from({ length: 50 }, (_, i) => `0-80-${String(Math.floor(i / 100)).padStart(2, '0')}-${String(i % 100).padStart(2, '0')}`);
    const created = await app.inject({ method: 'POST', url: '/api/runs', headers: AUTH, payload: {
      workflowId: rajalWorkflow.id, mode: 'preview', input: { patientIds, clinics: ['PENYAKIT DALAM'], date: '2026-06-10' }, qa: { scenario: 'rajal-synthetic' },
    } });
    expect(created.statusCode).toBe(201);
    await (app as any).runService.waitFor(created.json().runId);
    const { patients } = (await app.inject({ method: 'GET', url: '/api/patients', headers: AUTH })).json();
    expect(patients).toHaveLength(50);
  });

  it('rejects an unknown scenario with 400 and ignores `qa` on a non-QA host', async () => {
    const qaHost = buildServer({ ledger: new MemoryLedger(), qaAuth: { token: 't', operator: 'op' } });
    const bad = await qaHost.inject({ method: 'POST', url: '/api/runs', headers: AUTH, payload: { workflowId: ranapWorkflow.id, input: RANAP_HAPPY_INPUT, qa: { scenario: 'nope' } } });
    expect(bad.statusCode).toBe(400);

    const prod = buildServer({ ledger: new MemoryLedger() });
    const ok = await prod.inject({ method: 'POST', url: '/api/runs', payload: { workflowId: ranapWorkflow.id, input: RANAP_HAPPY_INPUT, qa: { scenario: 'nope', faults: [{ kind: 'network' }] } } });
    expect(ok.statusCode).toBe(201);
    const state = await (prod as any).runService.waitFor(ok.json().runId);
    expect(state.nodes.load_visits.status).toBe('success'); // no fault was injected
  });
});

describe('ranap fails closed when a SIMRS read fails (QA faults)', () => {
  const AUTH = { authorization: 'Bearer t' };
  const run = async (faults: unknown[]) => {
    const app = buildServer({ ledger: new MemoryLedger(), qaAuth: { token: 't', operator: 'op' } });
    const created = await app.inject({ method: 'POST', url: '/api/runs', headers: AUTH, payload: { workflowId: ranapWorkflow.id, mode: 'preview', input: RANAP_HAPPY_INPUT, qa: { faults } } });
    return (app as any).runService.waitFor(created.json().runId);
  };

  it('happy fixture still reaches the final gate', async () => {
    const state = await run([]);
    expect(state.nodes.preverify_summary.status).toBe('success');
    expect(state.nodes.final_gate.status).toBe('blocked'); // preview hold
  });

  it('an unread verification status or payment history stops the run at once', async () => {
    const verif = await run([{ kind: 'network', endpointId: 'kasir.cekStatusVerifikasi', times: 1 }]);
    expect(verif.nodes.reject_verified.status).toBe('blocked');
    expect(verif.nodes.reject_verified.summary).toContain('tidak terbaca');
    const paid = await run([{ kind: 'network', endpointId: 'kasir.getHistoryPembayaran', times: 1 }]);
    expect(paid.nodes.reject_paid.status).toBe('blocked');
    expect(paid.nodes.final_gate.status).toBe('pending');
  });

  it('one failed charge read holds verification at the pre-verification summary', async () => {
    const state = await run([{ kind: 'http500', endpointId: 'penatajasaInap.getListTindakan', times: 1 }]);
    expect(state.nodes.validate_ibs.status).toBe('needs_review');
    expect(state.nodes.preverify_summary.status).toBe('blocked');
    expect(state.nodes.final_gate.status).toBe('pending');
  });
});

describe('ranap cleanup-only run (Verifikasi off)', () => {
  it('still produces the Ringkasan summary row', async () => {
    const app = buildServer({ ledger: new MemoryLedger(), qaAuth: { token: 't', operator: 'op' } });
    const created = await app.inject({ method: 'POST', url: '/api/runs', headers: { authorization: 'Bearer t' }, payload: {
      workflowId: ranapWorkflow.id, mode: 'preview', input: RANAP_HAPPY_INPUT,
      enabled: { final_gate: false, execute_verifikasi: false, tampung_bayar: false },
    } });
    const state = await (app as any).runService.waitFor(created.json().runId);
    expect(state.nodes.tampung_bayar.status).toBe('skipped');
    expect(state.nodes.emit_summary.status).toBe('success');
    expect(state.status).toBe('completed');
  });
});

describe('rajal outcome wording follows the real payment result', () => {
  const AUTH = { authorization: 'Bearer t' };
  const run = async (mode: 'preview' | 'write') => {
    const app = buildServer({ ledger: new MemoryLedger(), qaAuth: { token: 't', operator: 'op' } });
    const created = await app.inject({ method: 'POST', url: '/api/runs', headers: AUTH, payload: {
      workflowId: rajalWorkflow.id, mode, ...(mode === 'write' ? { autoApprove: true } : {}),
      input: { patientIds: ['012345'], clinics: ['PENYAKIT DALAM'], date: '2026-06-10' },
    } });
    return (app as any).runService.waitFor(created.json().runId);
  };

  it('preview says there is nothing to confirm', async () => {
    const state = await run('preview');
    expect(state.nodes.confirm_result.summary).toBe('Preview — tidak ada pembayaran untuk dikonfirmasi');
  });

  it('write reports what happened to each payment (fixtures never read back as paid)', async () => {
    const state = await run('write');
    expect(state.nodes.confirm_result.status).toBe('needs_review');
    expect(state.nodes.confirm_result.summary).toMatch(/0 pembayaran terverifikasi; 1 gagal — cek manual di SIMRS/);
    expect(state.nodes.emit_batch_summary.summary).toMatch(/write: 0 pembayaran terverifikasi/);
  });
});
