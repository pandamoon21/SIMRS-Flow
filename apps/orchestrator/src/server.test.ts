import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@simrs-flow/audit-ledger';
import { FixtureTransport } from '@simrs-flow/evomedis-client';
import { ranapWorkflow } from '@simrs-flow/domain-ranap';
import { buildServer } from '../src/server.js';
import { UserSessionStore } from '../src/sessions.js';
import type { FastifyInstance } from 'fastify';
import { RANAP_HAPPY_INPUT } from '@simrs-flow/test-fixtures';

let app: FastifyInstance;
let ledger: MemoryLedger;
const QA_TOKEN = 'test-read-token';
const AUTH = { authorization: `Bearer ${QA_TOKEN}` };

beforeEach(() => {
  ledger = new MemoryLedger();
  app = buildServer({ ledger, qaAuth: { token: QA_TOKEN, operator: 'test-operator' } });
});

async function json(method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>) {
  const res = await app.inject({ method, url, payload: payload as never, headers });
  return { status: res.statusCode, body: res.json() as any };
}

describe('orchestrator API', () => {
  it('health check responds', async () => {
    const { status, body } = await json('GET', '/api/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('keeps detailed health authenticated and non-secret', async () => {
    expect((await json('GET', '/api/health/details')).status).toBe(401);
    const { status, body } = await json('GET', '/api/health/details', undefined, AUTH);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      defaultMode: 'preview',
      auditPersistent: false,
      uiAvailable: false,
    });
    expect(JSON.stringify(body)).not.toMatch(/cookie|password|token/i);
  });

  it('root serves an HTML landing page pointing at the UI', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('localhost:5173');
  });

  it('serves the built UI and handles configured CORS', async () => {
    const uiDir = mkdtempSync(join(tmpdir(), 'simrs-flow-ui-'));
    writeFileSync(join(uiDir, 'index.html'), '<main>dashboard</main>');
    const staticApp = buildServer({
      ledger: new MemoryLedger(),
      corsOrigins: ['http://operator.local'],
      uiDir,
    });
    try {
      const root = await staticApp.inject({ method: 'GET', url: '/' });
      expect(root.statusCode).toBe(200);
      expect(root.body).toContain('dashboard');
      const preflight = await staticApp.inject({
        method: 'OPTIONS',
        url: '/api/health',
        headers: {
          origin: 'http://operator.local',
          'access-control-request-method': 'GET',
        },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('http://operator.local');
    } finally {
      await staticApp.close();
      rmSync(uiDir, { recursive: true, force: true });
    }
  });

  it('lists workflows', async () => {
    const { body } = await json('GET', '/api/workflows', undefined, AUTH);
    const ids = body.workflows.map((w: any) => w.id);
    expect(ids).toContain(ranapWorkflow.id);
  });

  it('returns a workflow definition', async () => {
    const { status, body } = await json('GET', `/api/workflows/${ranapWorkflow.id}`, undefined, AUTH);
    expect(status).toBe(200);
    // Served verbatim from the definition — pinning a literal count here just
    // breaks every time a step is added.
    expect(body.nodes).toHaveLength(ranapWorkflow.nodes.length);
  });

  it('requires authentication for workflow and run reads', async () => {
    expect((await json('GET', '/api/workflows')).status).toBe(401);
    expect((await json('GET', '/api/runs')).status).toBe(401);
    expect((await json('GET', '/api/runs/run_unknown')).status).toBe(401);
    expect((await json('GET', '/api/runs/run_unknown/export.jsonl')).status).toBe(401);
    expect((await json('GET', '/api/runs/run_unknown/events')).status).toBe(401);
  });

  it('404s an unknown workflow', async () => {
    const { status } = await json('GET', '/api/workflows/nope', undefined, AUTH);
    expect(status).toBe(404);
  });

  it('creates a preview run, completes it, and records the audit trail', async () => {
    const created = await json('POST', '/api/runs', {
      workflowId: ranapWorkflow.id,
      mode: 'preview',
      input: RANAP_HAPPY_INPUT,
    });
    expect(created.status).toBe(201);
    const runId = created.body.runId as string;

    const service = (app as any).runService;
    const state = await service.waitFor(runId);
    expect(state.status).toBe('failed'); // gate blocks → critical gate fails run in preview
    // Up-to-gate nodes succeeded.
    expect(state.nodes.load_visits.status).toBe('success');
    // The gate held (preview never approves a write).
    expect(state.nodes.final_gate.status).toBe('blocked');

    // Events were persisted to the ledger.
    const recorded = await ledger.read(runId);
    expect(recorded.length).toBeGreaterThan(0);

    // Export endpoint returns JSONL.
    const exp = await app.inject({ method: 'GET', url: `/api/runs/${runId}/export.jsonl`, headers: AUTH });
    expect(exp.statusCode).toBe(200);
    expect(exp.body.split('\n').length).toBeGreaterThan(1);
  });

  it('rejects a run without a workflowId', async () => {
    const { status } = await json('POST', '/api/runs', {});
    expect(status).toBe(400);
  });

  it('refuses autoApprove outside write mode', async () => {
    // Preview never applies a mutation, so auto-approval there is a caller
    // mistake — accepting it silently would misrepresent what the run did.
    const { status, body } = await json('POST', '/api/runs', {
      workflowId: ranapWorkflow.id,
      mode: 'preview',
      input: RANAP_HAPPY_INPUT,
      autoApprove: true,
    });
    expect(status).toBe(400);
    expect(body.error).toBe('autoApprove_requires_write_mode');
  });

  it('cancels a run', async () => {
    const created = await json('POST', '/api/runs', {
      workflowId: ranapWorkflow.id,
      input: RANAP_HAPPY_INPUT,
    });
    const runId = created.body.runId as string;
    const { status } = await json('POST', `/api/runs/${runId}/cancel`);
    expect(status).toBe(200);
  });


  it('refuses to pause or resume an unknown run', async () => {
    expect((await json('POST', '/api/runs/nope/pause')).status).toBe(409);
    expect((await json('POST', '/api/runs/nope/resume')).status).toBe(409);
  });
});

describe('orchestrator API — write-mode security', () => {
  // A fixture transport whose auth.login issues a cookie for any credentials,
  // so the UserSessionStore can mint real session tokens in tests.
  function loginTransport() {
    let n = 0;
    return new FixtureTransport({
      'auth.login': () => {
        n += 1;
        return { text: '<html>ok</html>', setCookies: [`ci_session=tok${n}; Path=/`] };
      },
    });
  }

  function writeApp() {
    const ledger = new MemoryLedger();
    const sessions = new UserSessionStore({
      baseUrlV1: 'https://simrs.example.local/x',
      transport: loginTransport(),
    });
    return buildServer({ ledger, sessions });
  }

  async function inject(
    a: FastifyInstance,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) {
    const res = await a.inject({ method, url, payload: payload as never, headers });
    let body: any;
    try {
      body = res.json();
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body };
  }

  /** Log in and return an Authorization header for the given user. */
  async function authFor(a: FastifyInstance, username: string): Promise<Record<string, string>> {
    const res = await inject(a, 'POST', '/api/auth/login', { username, password: 'pw' });
    return { authorization: `Bearer ${res.body.token}` };
  }

  async function waitForPlannedMutation(a: FastifyInstance, runId: string): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const state = await (a as any).runService.getState(runId);
      const planned = Object.values((state?.mutations ?? {}) as Record<string, { planId?: string; status?: string }>)
        .find((outcome) => outcome.status === 'planned' && outcome.planId);
      if (planned?.planId) return planned.planId;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('run never proposed a mutation');
  }

  async function waitForGate(
    a: FastifyInstance,
    runId: string,
    auth: Record<string, string>,
    nodeId = 'final_gate',
  ): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const state = await (a as any).runService.getState(runId);
      if (state?.nodes[nodeId]?.status === 'gate_waiting') return;
      const planned = Object.values((state?.mutations ?? {}) as Record<string, { planId?: string; status?: string }>)
        .find((outcome) => outcome.status === 'planned' && outcome.planId);
      if (planned?.planId) {
        const settled = await inject(
          a,
          'POST',
          `/api/runs/${runId}/mutations/${encodeURIComponent(planned.planId)}/approve`,
          {},
          auth,
        );
        expect(settled.status).toBe(200);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`run never reached gate ${nodeId}`);
  }


  it('keeps QA login unavailable unless configured', async () => {
    const a = writeApp();
    const { status } = await inject(a, 'POST', '/api/auth/qa-login');
    expect(status).toBe(404);
  });

  it('accepts an explicit QA token for local UI QA', async () => {
    const a = buildServer({
      ledger: new MemoryLedger(),
      qaAuth: { token: 'qa-local-token', operator: 'qa-operator' },
    });
    const login = await a.inject({ method: 'POST', url: '/api/auth/qa-login' });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ token: 'qa-local-token', operator: 'qa-operator' });
    expect(login.headers['set-cookie']).toContain('simrs_flow_session=qa-local-token');
    expect(login.headers['set-cookie']).toContain('HttpOnly');
    expect(login.headers['set-cookie']).toContain('SameSite=Lax');

    const me = await inject(a, 'GET', '/api/auth/me', undefined, { cookie: 'simrs_flow_session=qa-local-token' });
    expect(me.status).toBe(200);
    expect(me.body.operator).toBe('qa-operator');
  });

  it('keeps writes bearer-only when a valid read cookie is present', async () => {
    const a = buildServer({
      ledger: new MemoryLedger(),
      qaAuth: { token: 'qa-local-token', operator: 'qa-operator' },
    });
    const cookie = { cookie: 'simrs_flow_session=qa-local-token' };
    expect((await inject(a, 'GET', '/api/workflows', undefined, cookie)).status).toBe(200);
    const write = await inject(
      a,
      'POST',
      '/api/runs',
      { workflowId: ranapWorkflow.id, mode: 'write', input: RANAP_HAPPY_INPUT },
      cookie,
    );
    expect(write.status).toBe(401);
  });

  it('logs in with EvoMedis credentials and issues a token', async () => {
    const a = writeApp();
    const login = await a.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'pw' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().token).toBeTruthy();
    expect(login.json().operator).toBe('alice');
    expect(login.headers['set-cookie']).toContain('simrs_flow_session=');
  });

  it('rejects a write run with no operator token (401)', async () => {
    const a = writeApp();
    const { status, body } = await inject(a, 'POST', '/api/runs', {
      workflowId: ranapWorkflow.id,
      mode: 'write',
      input: RANAP_HAPPY_INPUT,
    });
    expect(status).toBe(401);
    expect(body.error).toBe('operator_auth_required');
  });

  it('rejects a write run with an unknown token (401)', async () => {
    const a = writeApp();
    const { status } = await inject(
      a,
      'POST',
      '/api/runs',
      { workflowId: ranapWorkflow.id, mode: 'write', input: RANAP_HAPPY_INPUT },
      { authorization: 'Bearer nope' },
    );
    expect(status).toBe(401);
  });

  it('accepts a per-user live run without a shared service-account cookie', async () => {
    const a = writeApp();
    const AUTH = await authFor(a, 'alice');
    const { status } = await inject(
      a,
      'POST',
      '/api/runs',
      { workflowId: ranapWorkflow.id, mode: 'preview', source: 'live', input: RANAP_HAPPY_INPUT },
      AUTH,
    );
    expect(status).toBe(201);
  });
  it('allows a preview run with no token (reads stay open)', async () => {
    const a = writeApp();
    const { status } = await inject(a, 'POST', '/api/runs', {
      workflowId: ranapWorkflow.id,
      mode: 'preview',
      input: RANAP_HAPPY_INPUT,
    });
    expect(status).toBe(201);
  });

  it('accepts a write run from a logged-in operator and pauses at the gate', async () => {
    const a = writeApp();
    const AUTH = await authFor(a, 'alice');
    const { status, body } = await inject(
      a,
      'POST',
      '/api/runs',
      { workflowId: ranapWorkflow.id, mode: 'write', input: RANAP_HAPPY_INPUT },
      AUTH,
    );
    expect(status).toBe(201);
    const runId = body.runId as string;
    // Let the run advance to the gate.
    await waitForGate(a, runId, AUTH);
    const state = await (a as any).runService.getState(runId);
    expect(state.nodes.final_gate.status).toBe('gate_waiting');
  });

  it('requires two distinct operators to approve a critical gate', async () => {
    const a = writeApp();
    const AUTH = await authFor(a, 'alice');
    const AUTH2 = await authFor(a, 'bob');
    const created = await inject(
      a,
      'POST',
      '/api/runs',
      { workflowId: ranapWorkflow.id, mode: 'write', input: RANAP_HAPPY_INPUT },
      AUTH,
    );
    const runId = created.body.runId as string;
    await waitForGate(a, runId, AUTH);

    // First approval (alice) holds the gate — one more required.
    const first = await inject(a, 'POST', `/api/runs/${runId}/gates/final_gate/approve`, {}, AUTH);
    expect(first.status).toBe(200);
    expect(first.body.resolved).toBe(false);
    expect(first.body.remainingApprovals).toBe(1);

    // Same operator approving again does not advance the count.
    const dup = await inject(a, 'POST', `/api/runs/${runId}/gates/final_gate/approve`, {}, AUTH);
    expect(dup.body.resolved).toBe(false);

    // Second distinct operator (bob) resolves it.
    const second = await inject(a, 'POST', `/api/runs/${runId}/gates/final_gate/approve`, {}, AUTH2);
    expect(second.body.resolved).toBe(true);
    expect(second.body.remainingApprovals).toBe(0);
  });

  it('rejects gate approval without a token (401)', async () => {
    const a = writeApp();
    const AUTH = await authFor(a, 'alice');
    const created = await inject(
      a,
      'POST',
      '/api/runs',
      { workflowId: ranapWorkflow.id, mode: 'write', input: RANAP_HAPPY_INPUT },
      AUTH,
    );
    const runId = created.body.runId as string;
    const { status } = await inject(a, 'POST', `/api/runs/${runId}/gates/final_gate/approve`, {});
    expect(status).toBe(401);
  });

  it('rejects mutation approval without a token (401)', async () => {
    const a = writeApp();
    const AUTH = await authFor(a, 'alice');
    const created = await inject(
      a,
      'POST',
      '/api/runs',
      { workflowId: ranapWorkflow.id, mode: 'write', input: RANAP_HAPPY_INPUT },
      AUTH,
    );
    const runId = created.body.runId as string;
    const { status } = await inject(a, 'POST', `/api/runs/${runId}/mutations/plan-x/approve`, {});
    expect(status).toBe(401);
  });

  it('404s an unknown mutation plan', async () => {
    const a = writeApp();
    const AUTH = await authFor(a, 'alice');
    const created = await inject(
      a,
      'POST',
      '/api/runs',
      { workflowId: ranapWorkflow.id, mode: 'write', input: RANAP_HAPPY_INPUT },
      AUTH,
    );
    const runId = created.body.runId as string;
    const { status, body } = await inject(
      a,
      'POST',
      `/api/runs/${runId}/mutations/not-a-plan/approve`,
      {},
      AUTH,
    );
    expect(status).toBe(404);
    expect(body.error).toBe('plan_not_found');
  });

  it('applies a pending mutation while the run is still live', async () => {
    // The run now proposes a real mutation before the gate, and the mutation
    // approval route should still be able to apply it while the run is live.
    const a = writeApp();
    const AUTH = await authFor(a, 'alice');
    const created = await inject(
      a,
      'POST',
      '/api/runs',
      { workflowId: ranapWorkflow.id, mode: 'write', input: RANAP_HAPPY_INPUT },
      AUTH,
    );
    const runId = created.body.runId as string;
    const planId = await waitForPlannedMutation(a, runId);

    const { status, body } = await inject(
      a,
      'POST',
      `/api/runs/${runId}/mutations/${encodeURIComponent(planId)}/approve`,
      {},
      AUTH,
    );
    expect(status).toBe(200);
    expect(body.resolved).toBe(true);
  });

  it('locks a transaction: a second write run on the same record is 409', async () => {
    const a = writeApp();
    const AUTH = await authFor(a, 'alice');
    const input = { noRm: '012345', tanggal: '2026-06-10' };
    const first = await inject(
      a,
      'POST',
      '/api/runs',
      { workflowId: ranapWorkflow.id, mode: 'write', input },
      AUTH,
    );
    expect(first.status).toBe(201);
    // The first run is paused at the gate (lock still held).
    await waitForGate(a, first.body.runId as string, AUTH);
    await new Promise((r) => setTimeout(r, 10));
    const second = await inject(
      a,
      'POST',
      '/api/runs',
      { workflowId: ranapWorkflow.id, mode: 'write', input },
      AUTH,
    );
    expect(second.status).toBe(409);
    expect(second.body.error).toContain('No RM 012345 (2026-06-10) sedang dikerjakan run lain');
  });

  it('logout invalidates the token', async () => {
    const a = writeApp();
    const AUTH = await authFor(a, 'alice');
    // me works while logged in
    expect((await inject(a, 'GET', '/api/auth/me', undefined, AUTH)).status).toBe(200);
    const logout = await a.inject({ method: 'POST', url: '/api/auth/logout', headers: AUTH });
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    // after logout, the token no longer authorizes
    expect((await inject(a, 'GET', '/api/auth/me', undefined, AUTH)).status).toBe(401);
    const run = await inject(
      a,
      'POST',
      '/api/runs',
      { workflowId: ranapWorkflow.id, mode: 'write', input: RANAP_HAPPY_INPUT },
      AUTH,
    );
    expect(run.status).toBe(401);
  });
});

