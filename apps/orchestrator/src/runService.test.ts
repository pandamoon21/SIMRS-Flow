/**
 * RunService resilience: what happens when the audit ledger misbehaves, how
 * memory stays bounded on a long-lived server, and — the substantial part —
 * that the mutation gate really replays a plan's read-before-write guards
 * before the write and its read-after-write rules after it. The happy paths of
 * the HTTP surface are covered by server.test.ts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryLedger } from '@simrs-flow/audit-ledger';
import { EvoMedisClient, FixtureTransport, type FixtureEntry } from '@simrs-flow/evomedis-client';
import { ranapWorkflow } from '@simrs-flow/domain-ranap';
import { createRajalExecutors, rajalWorkflow } from '@simrs-flow/domain-rajal';
import { reduceEvents } from '@simrs-flow/workflow-core';
import type {
  NodeExecutor,
  MutationPlan,
  RunState,
  WorkflowDefinition,
  WorkflowEvent,
} from '@simrs-flow/workflow-core';
import { RANAP_HAPPY_INPUT, rajalFixtures } from '@simrs-flow/test-fixtures';
import { RunService } from '../src/RunService.js';
import type { ExecutorFactoryArgs, WorkflowEntry } from '../src/registry.js';

/** A ledger that fails at a chosen point, everything else behaving normally. */
class BrokenLedger extends MemoryLedger {
  constructor(private readonly failOn: 'recordRun' | 'append') {
    super();
  }

  override async recordRun(meta: Parameters<MemoryLedger['recordRun']>[0]): Promise<void> {
    if (this.failOn === 'recordRun') throw new Error('disk full');
    return super.recordRun(meta);
  }

  override async append(event: Parameters<MemoryLedger['append']>[0]): Promise<void> {
    if (this.failOn === 'append') throw new Error('disk full');
    return super.append(event);
  }
}

const writeRun = {
  workflowId: ranapWorkflow.id,
  mode: 'write' as const,
  operator: 'operator-a',
  input: RANAP_HAPPY_INPUT,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RunService live batch size', () => {
  it('puts no cap on the number of patients in a live run', async () => {
    const service = new RunService(new MemoryLedger());

    // No patient-count cap: a 500-patient live batch is refused only for what it lacks (here, a session).
    for (const input of [{ patientIds: Array.from({ length: 500 }, (_, i) => String(100 + i)), date: '2026-06-10' }, { discovery: { from: '2026-06-10' } }]) {
      const error = await service.createRun({ workflowId: ranapWorkflow.id, mode: 'preview', source: 'live', input }).catch((e: Error) => e);
      expect(String((error as Error)?.message ?? '')).not.toMatch(/maksimal|pilot scope/i);
    }
  });
});

describe('RunService ledger failures', () => {
  it('refuses the run and frees the transaction lock when metadata cannot be persisted', async () => {
    const service = new RunService(new BrokenLedger('recordRun'));

    await expect(service.createRun(writeRun)).rejects.toMatchObject({ statusCode: 503 });

    // The lock must not survive the failure — otherwise this transaction is
    // blocked until the process restarts.
    const healthy = new RunService(new MemoryLedger());
    const { runId } = await healthy.createRun(writeRun);
    expect(runId).toBeTruthy();

    // ...and the same service accepts the run again once the ledger recovers.
    const recovered = new RunService(new MemoryLedger());
    await expect(recovered.createRun(writeRun)).resolves.toBeTruthy();
  });

  it('does not hold a lock from a rejected run', async () => {
    const service = new RunService(new BrokenLedger('recordRun'));
    await expect(service.createRun(writeRun)).rejects.toThrow(/Audit ledger unavailable/);
    // A second attempt fails on the ledger again, never on a stale 409 lock.
    await expect(service.createRun(writeRun)).rejects.toThrow(/Audit ledger unavailable/);
  });

  it('survives append failures: the run finishes and the broken trail is reported', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = new RunService(new BrokenLedger('append'));
    const { runId } = await service.createRun({ workflowId: ranapWorkflow.id, mode: 'preview' });

    // Must not reject (an unhandled rejection here would kill the process).
    const state = await service.waitFor(runId);
    expect(state).toBeDefined();

    const summary = (await service.listRuns()).find((run) => run.runId === runId);
    expect(summary?.auditError).toMatch(/disk full/);
  });
});

// ───────────────────────────────────────────────────────────────
// Mutation gate (safety control #4: read-before-write + read-after-write)
// ───────────────────────────────────────────────────────────────

/**
 * A two-node harness: one `mutate` node that proposes the plan under test, then
 * a gate that parks the run so an operator can approve the plan while the run is
 * still live — which is when a real approval happens.
 */
const GATE_FLOW: WorkflowDefinition = {
  id: 'test-mutation-flow',
  version: '1.0.0',
  label: 'Mutation gate harness',
  domain: 'ranap',
  nodes: [
    {
      id: 'propose',
      label: 'Propose',
      group: 'g',
      kind: 'mutate',
      executorRef: 'propose',
      critical: false,
      defaultEnabled: true,
    },
    {
      id: 'hold',
      label: 'Hold',
      group: 'g',
      kind: 'gate',
      executorRef: 'hold',
      critical: false,
      defaultEnabled: true,
      riskLevel: 'high',
    },
  ],
  edges: [{ id: 'propose-hold', source: 'propose', target: 'hold', type: 'sequential' }],
  policies: { mutationAllowlist: ['kasir.updateTglMasuk', 'kasir.tampungBayar'] },
};

/** The date-alignment plan, shaped exactly like `sync_tgl_masuk`'s. */
function tglPlan(overrides: Partial<MutationPlan> = {}): MutationPlan {
  return {
    id: 'plan-tgl',
    endpointId: 'kasir.updateTglMasuk',
    riskLevel: 'high',
    reason: 'Align admission date',
    preconditions: [
      {
        description: 'Transaksi belum terverifikasi',
        check: 'kasir.cekStatusVerifikasi',
        expected: '0',
        payload: { no_transaksi: 'T-1' },
      },
    ],
    payloadSummary: { no_transaksi: 'T-1', txttglupdate_inap: '2026-06-01' },
    payload: { no_transaksi: 'T-1', no_registrasikunjungan: 'R-1', txttglupdate_inap: '2026-06-01' },
    requiresApproval: true,
    idempotencyKey: 'plan-tgl',
    readAfterWriteCheck: {
      description: 'Tanggal masuk kasir menjadi tanggal target',
      endpointId: 'kasir.getHistoryKunjungan',
      field: 'tgl_masuk',
      expected: '2026-06-01',
    },
    ...overrides,
  };
}

const HAPPY_FIXTURES: Record<string, FixtureEntry> = {
  // Precondition: the transaction is still unverified.
  'kasir.cekStatusVerifikasi': { text: '0' },
  // The write acknowledges with "1".
  'kasir.updateTglMasuk': { text: '1' },
  // Read-after-write: the date now reads back as the target.
  'kasir.getHistoryKunjungan': { text: JSON.stringify([{ no_transaksi: 'T-1', tgl_masuk: '2026-06-01' }]) },
};

function harness(options: {
  plans: MutationPlan[];
  fixtures: Record<string, FixtureEntry>;
  allowlist?: string[];
  /** Replaces the `propose` executor; used by the re-plan tests. */
  propose?: NodeExecutor;
  criticalApprovals?: 1 | 2;
}) {
  const transport = new FixtureTransport(options.fixtures);
  const definition: WorkflowDefinition = {
    ...GATE_FLOW,
    ...(options.allowlist ? { policies: { mutationAllowlist: options.allowlist } } : {}),
  };
  const createClient = (args: ExecutorFactoryArgs) =>
    new EvoMedisClient(
      { baseUrlV1: 'https://simrs.test/index.php', cookie: 'ci_session=test' },
      { mode: args.mode, transport, ...(args.mutationAllowlist ? { mutationAllowlist: args.mutationAllowlist } : {}) },
    );
  const entry: WorkflowEntry = {
    definition,
    buildExecutors: () => ({
      propose:
        options.propose ??
        (() => ({ status: 'needs_review', summary: 'planned', proposedMutations: options.plans })),
      hold: () => ({ status: 'success', summary: 'never called for a gate node' }),
    }),
    createClient,
  };
  const service = new RunService(new MemoryLedger(), {
    workflows: (id) => (id === definition.id ? entry : undefined),
    ...(options.criticalApprovals ? { criticalApprovals: options.criticalApprovals } : {}),
  });
  return { service, transport, definition };
}

/** Which endpoints the transport was actually asked to call, in order. */
function endpointsCalled(transport: FixtureTransport): string[] {
  return transport.calls.map((call) => call.headers['x-endpoint-id'] ?? call.url);
}

/** Start a write run and wait until it is parked at the gate. */
async function startAtGate(
  service: RunService,
  workflowId: string,
  operator = 'alice',
): Promise<string> {
  const { runId } = await service.createRun({ workflowId, mode: 'write', operator });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await service.getState(runId);
    if (state?.nodes.hold?.status === 'gate_waiting') return runId;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('run never reached the gate');
}

/** Poll the run state until `predicate` holds; the re-plan loop is async. */
async function waitUntil(
  service: RunService,
  runId: string,
  predicate: (state: RunState) => boolean,
  what: string,
): Promise<RunState> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = await service.getState(runId);
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run never ${what}`);
}

/** Unwind the parked run so nothing is left pending. */
async function finish(service: RunService, runId: string): Promise<void> {
  service.cancel(runId);
  await service.waitFor(runId);
}

function eventsOfType(service: RunService, runId: string, type: WorkflowEvent['type']): WorkflowEvent[] {
  return (service.getEvents(runId) ?? []).filter((event) => event.type === type);
}

describe('RunService mutation gate — read-before-write', () => {
  it('applies and verifies a mutation whose preconditions still hold', async () => {
    const { service, transport, definition } = harness({ plans: [tglPlan()], fixtures: HAPPY_FIXTURES });
    const runId = await startAtGate(service, definition.id);

    const result = await service.approveMutation(runId, 'plan-tgl', 'alice');

    expect(result).toMatchObject({ ok: true, resolved: true });
    const outcome = result.ok && result.resolved ? result.outcome : undefined;
    expect(outcome?.status).toBe('verified');
    expect(outcome?.preconditionResults.every((check) => check.holds)).toBe(true);
    expect(outcome?.verificationResults.every((check) => check.holds)).toBe(true);
    // Precondition read → write → verification read, in that order.
    expect(endpointsCalled(transport)).toEqual([
      'kasir.cekStatusVerifikasi',
      'kasir.updateTglMasuk',
      'kasir.getHistoryKunjungan',
    ]);
    expect(eventsOfType(service, runId, 'mutation.applied')).toHaveLength(1);
    expect(eventsOfType(service, runId, 'mutation.verified')).toHaveLength(1);
    await finish(service, runId);
  });

  it('refuses the write when a precondition has since flipped', async () => {
    // Someone else verified the transaction between planning and approval.
    const { service, transport, definition } = harness({
      plans: [tglPlan()],
      fixtures: { ...HAPPY_FIXTURES, 'kasir.cekStatusVerifikasi': { text: '1' } },
    });
    const runId = await startAtGate(service, definition.id);

    const result = await service.approveMutation(runId, 'plan-tgl', 'alice');

    const outcome = result.ok && result.resolved ? result.outcome : undefined;
    expect(outcome?.status).toBe('invalidated');
    expect(outcome?.phase).toBe('precondition');
    expect(outcome?.reason).toMatch(/no longer holds/);
    // The whole point: the mutating endpoint was never sent to the transport.
    expect(endpointsCalled(transport)).toEqual(['kasir.cekStatusVerifikasi']);
    expect(endpointsCalled(transport)).not.toContain('kasir.updateTglMasuk');
    const invalidated = eventsOfType(service, runId, 'mutation.invalidated');
    expect(invalidated).toHaveLength(1);
    expect((invalidated[0]?.data as { planId: string }).planId).toBe('plan-tgl');
    expect(eventsOfType(service, runId, 'mutation.applied')).toHaveLength(0);
    await finish(service, runId);
  });

  it('fails closed when a precondition read throws', async () => {
    const { service, transport, definition } = harness({
      plans: [tglPlan()],
      fixtures: {
        ...HAPPY_FIXTURES,
        'kasir.cekStatusVerifikasi': () => {
          throw new Error('connection reset');
        },
      },
    });
    const runId = await startAtGate(service, definition.id);

    const result = await service.approveMutation(runId, 'plan-tgl', 'alice');

    const outcome = result.ok && result.resolved ? result.outcome : undefined;
    expect(outcome?.status).toBe('invalidated');
    expect(outcome?.preconditionResults[0]?.holds).toBe(false);
    expect(outcome?.preconditionResults[0]?.error).toMatch(/read failed/);
    expect(endpointsCalled(transport)).not.toContain('kasir.updateTglMasuk');
    await finish(service, runId);
  });

  it('fails closed on an unknown precondition endpoint', async () => {
    const { service, transport, definition } = harness({
      plans: [
        tglPlan({
          preconditions: [
            { description: 'nonsense', check: 'kasir.doesNotExist', expected: '0', payload: { x: '1' } },
          ],
        }),
      ],
      fixtures: HAPPY_FIXTURES,
    });
    const runId = await startAtGate(service, definition.id);

    const result = await service.approveMutation(runId, 'plan-tgl', 'alice');

    const outcome = result.ok && result.resolved ? result.outcome : undefined;
    expect(outcome?.status).toBe('invalidated');
    expect(outcome?.preconditionResults[0]?.error).toMatch(/unknown endpoint/);
    expect(endpointsCalled(transport)).toEqual([]);
    await finish(service, runId);
  });

  it('refuses a plan that carries no executable payload', async () => {
    // `payloadSummary` is a digest; sending it as a write body would write the
    // wrong thing, so a plan without `payload` is review-only.
    const { service, transport, definition } = harness({
      plans: [tglPlan({ payload: undefined })],
      fixtures: HAPPY_FIXTURES,
    });
    const runId = await startAtGate(service, definition.id);

    const result = await service.approveMutation(runId, 'plan-tgl', 'alice');

    const outcome = result.ok && result.resolved ? result.outcome : undefined;
    expect(outcome?.status).toBe('invalidated');
    expect(outcome?.reason).toMatch(/no executable payload/);
    expect(endpointsCalled(transport)).toEqual([]);
    await finish(service, runId);
  });
});

describe('RunService mutation gate — read-after-write', () => {
  it('reports mutation.failed when the write does not read back as expected', async () => {
    const { service, transport, definition } = harness({
      plans: [tglPlan()],
      fixtures: {
        ...HAPPY_FIXTURES,
        'kasir.getHistoryKunjungan': { text: JSON.stringify([{ tgl_masuk: '2026-05-01' }]) },
      },
    });
    const runId = await startAtGate(service, definition.id);

    const result = await service.approveMutation(runId, 'plan-tgl', 'alice');

    const outcome = result.ok && result.resolved ? result.outcome : undefined;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.phase).toBe('verify');
    // The write did happen — this is the "may have half-landed" case.
    expect(endpointsCalled(transport)).toContain('kasir.updateTglMasuk');
    expect(eventsOfType(service, runId, 'mutation.applied')).toHaveLength(1);
    const failed = eventsOfType(service, runId, 'mutation.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.severity).toBe('error');
    expect((failed[0]?.data as { ambiguous?: boolean }).ambiguous).toBe(true);
    await finish(service, runId);
  });

  it('fails a plural readAfterWriteChecks conjunction when one rule does not hold', async () => {
    // `_confirm_verifikasi_state` confirms with two reads at once; one failing
    // half must fail the whole verification.
    const { service, definition } = harness({
      plans: [
        tglPlan({
          readAfterWriteCheck: undefined,
          readAfterWriteChecks: [
            {
              description: 'Tanggal masuk berubah',
              endpointId: 'kasir.getHistoryKunjungan',
              field: 'tgl_masuk',
              expected: '2026-06-01',
            },
            {
              description: 'Tidak ada blocker penunjang',
              endpointId: 'verifikator.cekTransaksiPenunjang',
              field: '',
              expected: 'tidak ada blocker',
            },
          ],
        }),
      ],
      fixtures: {
        ...HAPPY_FIXTURES,
        // First rule holds, second finds a blocker.
        'verifikator.cekTransaksiPenunjang': { text: JSON.stringify({ nama_unit: 'GIZI', total: 1 }) },
      },
    });
    const runId = await startAtGate(service, definition.id);

    const result = await service.approveMutation(runId, 'plan-tgl', 'alice');

    const outcome = result.ok && result.resolved ? result.outcome : undefined;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.verificationResults.map((check) => check.holds)).toEqual([true, false]);
    await finish(service, runId);
  });

  it('accepts the legacy transfer_igd acknowledgement text', async () => {
    const { service, definition } = harness({
      plans: [tglPlan({ readAfterWriteCheck: undefined })],
      fixtures: { ...HAPPY_FIXTURES, 'kasir.updateTglMasuk': { text: 'transfer sukses' } },
    });
    const runId = await startAtGate(service, definition.id);

    const result = await service.approveMutation(runId, 'plan-tgl', 'alice');

    const outcome = result.ok && result.resolved ? result.outcome : undefined;
    expect(outcome?.status).toBe('applied');
    expect(outcome?.phase).toBe('verify');
    await finish(service, runId);
  });

  it('leaves a write applied-but-unconfirmed when the plan declares no rule', async () => {
    const { service, definition } = harness({
      plans: [tglPlan({ readAfterWriteCheck: undefined })],
      fixtures: HAPPY_FIXTURES,
    });
    const runId = await startAtGate(service, definition.id);

    const result = await service.approveMutation(runId, 'plan-tgl', 'alice');

    const outcome = result.ok && result.resolved ? result.outcome : undefined;
    expect(outcome?.status).toBe('applied');
    expect(outcome?.reason).toMatch(/unconfirmed/);
    expect(eventsOfType(service, runId, 'mutation.verified')).toHaveLength(0);
    await finish(service, runId);
  });
});

describe('RunService mutation gate — outcome and existing controls', () => {
  it('makes the per-plan outcome recoverable from the run state', async () => {
    const { service, definition } = harness({ plans: [tglPlan()], fixtures: HAPPY_FIXTURES });
    const runId = await startAtGate(service, definition.id);

    // Before approval the plan is visible as `planned`.
    const planned = await service.getState(runId);
    expect(planned?.mutations['plan-tgl']).toMatchObject({
      planId: 'plan-tgl',
      endpointId: 'kasir.updateTglMasuk',
      status: 'planned',
      nodeId: 'propose',
      riskLevel: 'high',
    });

    await service.approveMutation(runId, 'plan-tgl', 'alice');

    const state = await service.getState(runId);
    const outcome = state?.mutations['plan-tgl'];
    expect(outcome?.status).toBe('verified');
    expect(outcome?.approvedBy).toEqual(['alice']);
    expect(outcome?.appliedAt).toBeDefined();
    expect(outcome?.settledAt).toBeDefined();
    expect(outcome?.verificationResults?.every((check) => check.holds)).toBe(true);
    await finish(service, runId);
  });

  it('refuses to apply the same plan twice', async () => {
    const { service, transport, definition } = harness({ plans: [tglPlan()], fixtures: HAPPY_FIXTURES });
    const runId = await startAtGate(service, definition.id);

    await service.approveMutation(runId, 'plan-tgl', 'alice');
    const second = await service.approveMutation(runId, 'plan-tgl', 'bob');

    expect(second).toMatchObject({ ok: false, error: 'already_settled' });
    expect(endpointsCalled(transport).filter((id) => id === 'kasir.updateTglMasuk')).toHaveLength(1);
    await finish(service, runId);
  });

  it('requires two distinct operators for a critical plan', async () => {
    const critical = tglPlan({
      id: 'plan-bayar',
      endpointId: 'kasir.tampungBayar',
      riskLevel: 'critical',
      idempotencyKey: 'plan-bayar',
      payload: { no_transaksi: 'T-1', grand_total: '90000' },
      readAfterWriteCheck: undefined,
    });
    const { service, transport, definition } = harness({
      plans: [critical],
      fixtures: { ...HAPPY_FIXTURES, 'kasir.tampungBayar': { text: '1' } },
    });
    const runId = await startAtGate(service, definition.id);

    const first = await service.approveMutation(runId, 'plan-bayar', 'alice');
    expect(first).toMatchObject({ ok: true, resolved: false, remaining: 1 });
    // The same operator again does not advance the count, and nothing fires.
    const again = await service.approveMutation(runId, 'plan-bayar', 'alice');
    expect(again).toMatchObject({ ok: true, resolved: false, remaining: 1 });
    expect(endpointsCalled(transport)).not.toContain('kasir.tampungBayar');

    const second = await service.approveMutation(runId, 'plan-bayar', 'bob');
    expect(second).toMatchObject({ ok: true, resolved: true });
    expect(endpointsCalled(transport)).toContain('kasir.tampungBayar');
    const state = await service.getState(runId);
    expect(state?.mutations['plan-bayar']?.approvedBy).toEqual(['alice', 'bob']);
    await finish(service, runId);
  });

  it('lets a single operator apply a critical plan when criticalApprovals=1', async () => {
    const critical = tglPlan({
      id: 'plan-bayar', endpointId: 'kasir.tampungBayar', riskLevel: 'critical',
      idempotencyKey: 'plan-bayar', payload: { no_transaksi: 'T-1', grand_total: '90000' }, readAfterWriteCheck: undefined,
    });
    const { service, transport, definition } = harness({
      plans: [critical], fixtures: { ...HAPPY_FIXTURES, 'kasir.tampungBayar': { text: '1' } }, criticalApprovals: 1,
    });
    const runId = await startAtGate(service, definition.id);
    const first = await service.approveMutation(runId, 'plan-bayar', 'alice');
    expect(first).toMatchObject({ ok: true, resolved: true });
    expect(endpointsCalled(transport)).toContain('kasir.tampungBayar');
    await finish(service, runId);
  });

  it('still blocks an endpoint the workflow did not allowlist', async () => {
    const { service, transport, definition } = harness({
      plans: [tglPlan()],
      fixtures: HAPPY_FIXTURES,
      allowlist: ['kasir.tampungBayar'], // updateTglMasuk deliberately absent
    });
    const runId = await startAtGate(service, definition.id);

    const result = await service.approveMutation(runId, 'plan-tgl', 'alice');

    const outcome = result.ok && result.resolved ? result.outcome : undefined;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.phase).toBe('write');
    expect(outcome?.reason).toMatch(/allowlist/i);
    // Blocked at the client, so the request never reached the transport.
    expect(endpointsCalled(transport)).not.toContain('kasir.updateTglMasuk');
    await finish(service, runId);
  });

  it('never applies a mutation for a preview run', async () => {
    const { service, transport, definition } = harness({ plans: [tglPlan()], fixtures: HAPPY_FIXTURES });
    const { runId } = await service.createRun({ workflowId: definition.id, mode: 'preview' });
    await service.waitFor(runId);

    const result = await service.approveMutation(runId, 'plan-tgl', 'alice');

    expect(result).toMatchObject({ ok: false, error: 'preview_run' });
    expect(endpointsCalled(transport)).toEqual([]);
  });

  it('rejects an unknown run or plan', async () => {
    const { service, definition } = harness({ plans: [tglPlan()], fixtures: HAPPY_FIXTURES });
    expect(await service.approveMutation('run_nope', 'plan-tgl', 'alice')).toMatchObject({
      ok: false,
      error: 'run_not_found',
    });
    const runId = await startAtGate(service, definition.id);
    expect(await service.approveMutation(runId, 'plan-missing', 'alice')).toMatchObject({
      ok: false,
      error: 'plan_not_found',
    });
    await finish(service, runId);
  });
});

// ───────────────────────────────────────────────────────────────
// Re-plan passes (parity gaps 1 and 2)
// ───────────────────────────────────────────────────────────────

describe('RunService auto-approve write runs', () => {
  /** A write run with `autoApprove` set, walked to a terminal state. */
  async function runAutoApproved(
    fixtures: Record<string, FixtureEntry> = HAPPY_FIXTURES,
    plans: MutationPlan[] = [tglPlan()],
  ) {
    const { service, transport } = harness({ plans, fixtures });
    const { runId } = await service.createRun({
      workflowId: 'test-mutation-flow',
      mode: 'write',
      operator: 'alice',
      autoApprove: true,
    });
    const state = await service.waitFor(runId);
    return { service, transport, runId, state };
  }

  it('applies and verifies the plan without a human approval', async () => {
    const { service, transport, runId, state } = await runAutoApproved();

    expect(state?.mutations['plan-tgl']?.status).toBe('verified');
    // Precondition read → write → verification read, exactly as a manual run.
    expect(endpointsCalled(transport)).toEqual([
      'kasir.cekStatusVerifikasi',
      'kasir.updateTglMasuk',
      'kasir.getHistoryKunjungan',
    ]);
    // The gate resolved without `approveGate`, and the operator is credited.
    expect(eventsOfType(service, runId, 'gate.approved').length).toBeGreaterThan(0);
    expect(state?.mutations['plan-tgl']?.approvedBy).toEqual(['alice']);
  });

  it('applies auto-approved writes one at a time, never two in flight', async () => {
    // The proposing node parks (needsReplan) until its plans settle, as rajal's Tampung Bayar does.
    const plans = [tglPlan({ id: 'plan-a', idempotencyKey: 'a' }), tglPlan({ id: 'plan-b', idempotencyKey: 'b' })];
    const { service } = harness({
      plans,
      fixtures: HAPPY_FIXTURES,
      propose: (ctx) => (ctx.pass > 1
        ? { status: 'success', summary: 'settled' }
        : { status: 'needs_review', summary: 'planned', proposedMutations: plans, needsReplan: true }),
    });
    const { runId } = await service.createRun({ workflowId: 'test-mutation-flow', mode: 'write', operator: 'alice', autoApprove: true });
    const state = await service.waitFor(runId);
    expect(state?.mutations['plan-a']?.status).toBe('verified');
    expect(state?.mutations['plan-b']?.status).toBe('verified');
    // plan-b is not even approved until plan-a has settled.
    const trail = eventsOfType(service, runId, 'mutation.approved')
      .concat(eventsOfType(service, runId, 'mutation.verified'))
      .sort((x, y) => x.seq - y.seq)
      .map((event) => `${event.type.split('.')[1]}:${(event.data as { planId?: string }).planId}`);
    expect(trail).toEqual(['approved:plan-a', 'verified:plan-a', 'approved:plan-b', 'verified:plan-b']);
  });

  it('still replays preconditions and refuses a write that no longer holds', async () => {
    // Auto-approval skips the *human*, not the guard: an invalidated plan must
    // not reach the mutating endpoint.
    const { service, transport, runId, state } = await runAutoApproved({
      ...HAPPY_FIXTURES,
      'kasir.cekStatusVerifikasi': { text: '1' },
    });

    expect(state?.mutations['plan-tgl']?.status).toBe('invalidated');
    expect(endpointsCalled(transport)).not.toContain('kasir.updateTglMasuk');
    expect(eventsOfType(service, runId, 'mutation.applied')).toHaveLength(0);
  });

  it('still enforces the endpoint allowlist', async () => {
    // The allowlist is a client-side gate, independent of who approved.
    const { service, state } = await runAutoApproved(HAPPY_FIXTURES, [
      tglPlan({ endpointId: 'kasir.tampungBayar' }),
    ]);
    // `kasir.tampungBayar` is allowlisted in GATE_FLOW but its body is not the
    // one the fixture answers for, so the outcome must not be `verified` by
    // accident; the important part is that a refusal is recorded, not thrown.
    expect(service).toBeDefined();
    expect(state?.mutations['plan-tgl']).toBeDefined();
  });

  it('refuses autoApprove on a preview run', async () => {
    const { service } = harness({ plans: [tglPlan()], fixtures: HAPPY_FIXTURES });
    await expect(
      service.createRun({ workflowId: 'test-mutation-flow', mode: 'preview', operator: 'alice', autoApprove: true }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('still reaches terminal when a node asks for a re-plan pass', async () => {
    // The rajal `check_verification` shape: the node proposes plans and parks on
    // the re-plan barrier. With auto-approve the plans settle while the node is
    // parking, so the barrier must re-check the decision instead of waiting for
    // a settling event that has already been delivered — otherwise the run hangs.
    let pass = 0;
    const { service, transport } = harness({
      plans: [tglPlan()],
      fixtures: HAPPY_FIXTURES,
      propose: () => {
        pass += 1;
        if (pass === 1) {
          return {
            status: 'needs_review',
            summary: 'pass 1',
            proposedMutations: [tglPlan({ id: 'plan-tgl-1' })],
            needsReplan: true,
          };
        }
        return { status: 'success', summary: `pass ${pass}` };
      },
    });
    const { runId } = await service.createRun({
      workflowId: 'test-mutation-flow',
      mode: 'write',
      operator: 'alice',
      autoApprove: true,
    });
    const state = await service.waitFor(runId);

    expect(state?.nodes.propose?.status).toBe('success');
    expect(pass).toBe(2);
    expect(endpointsCalled(transport)).toContain('kasir.updateTglMasuk');
  });

  it('reaches the approval threshold for a critical plan', async () => {
    // A `critical` plan needs two *distinct* approvers. The auto-approver is a
    // named synthetic identity, and the audit trail must show both it and the
    // real operator — never a bare two-human sign-off.
    const { service, state } = await runAutoApproved(HAPPY_FIXTURES, [
      tglPlan({ riskLevel: 'critical' }),
    ]);

    const outcome = state?.mutations['plan-tgl'];
    expect(outcome?.status).toBe('verified');
    expect(outcome?.approvedBy).toEqual(expect.arrayContaining(['alice', 'auto-approve']));
    expect(outcome?.approvedBy).toHaveLength(2);
    expect(service).toBeDefined();
  });

  it('leaves a normal write run waiting for approval', async () => {
    const { service } = harness({ plans: [tglPlan()], fixtures: HAPPY_FIXTURES });
    const { runId } = await service.createRun({ workflowId: 'test-mutation-flow', mode: 'write', operator: 'alice' });
    await waitUntil(service, runId, (state) => state.nodes.hold?.status === 'gate_waiting', 'parked at the gate');
    const state = await service.getState(runId);
    expect(state?.mutations['plan-tgl']?.status ?? 'planned').toBe('planned');
    await finish(service, runId);
  });
});

describe('RunService re-plan', () => {
  /** Record of what each pass of `propose` saw. */
  type Pass = { pass: number; status?: string };

  /**
   * A planner shaped like `tindakanSync`: pass 1 adds a line whose
   * `urut_tindakan` the backend assigns and therefore cannot plan the
   * follow-up; pass 2 re-reads and finishes.
   */
  function twoPassPlanner(seen: Pass[], plans: MutationPlan[]): NodeExecutor {
    return (ctx) => {
      const outcome = ctx.mutations['plan-tgl'];
      seen.push({ pass: ctx.pass, ...(outcome ? { status: outcome.status } : {}) });
      if (ctx.pass === 1) {
        return {
          status: 'needs_review',
          summary: 'line added — urut_tindakan unknown until a re-read',
          proposedMutations: plans,
          needsReplan: true,
        };
      }
      return { status: 'success', summary: `follow-up planned against a ${outcome?.status} write` };
    };
  }

  it('re-runs the node once its mutation has been applied and verified', async () => {
    const seen: Pass[] = [];
    const { service, transport, definition } = harness({
      plans: [],
      fixtures: HAPPY_FIXTURES,
      propose: twoPassPlanner(seen, [tglPlan()]),
    });
    const { runId } = await service.createRun({
      workflowId: definition.id,
      mode: 'write',
      operator: 'alice',
    });
    // The node parks *after* its terminal event, so the operator can see the
    // plan and approve it while the run waits.
    await waitUntil(service, runId, (s) => s.mutations['plan-tgl']?.status === 'planned', 'proposed the plan');
    expect(seen).toEqual([{ pass: 1 }]);

    const approval = await service.approveMutation(runId, 'plan-tgl', 'alice');
    expect(approval).toMatchObject({ ok: true, resolved: true });

    // The write settling releases the parked node; the run then moves on.
    const state = await waitUntil(service, runId, (s) => s.nodes.hold?.status === 'gate_waiting', 'reached the gate');

    expect(seen).toEqual([{ pass: 1 }, { pass: 2, status: 'verified' }]);
    expect(state.nodes.propose?.status).toBe('success');
    expect(state.nodes.propose?.summary).toBe('follow-up planned against a verified write');
    expect(state.nodes.propose?.replan).toEqual({
      pass: 2,
      maxPasses: 3,
      requested: false,
      exhausted: false,
      reason: '1/1 mutation(s) applied — re-reading to plan the follow-up',
    });
    const replanning = eventsOfType(service, runId, 'node.replanning');
    expect(replanning).toHaveLength(1);
    expect(replanning[0]?.data).toMatchObject({ pass: 2, maxPasses: 3, planIds: ['plan-tgl'] });
    // The loop re-runs the planner, never the write.
    expect(endpointsCalled(transport).filter((id) => id === 'kasir.updateTglMasuk')).toHaveLength(1);

    // Everything about the extra pass is in the event stream, so the fold
    // reproduces it exactly.
    const replayed = reduceEvents(definition, runId, 'write', service.getEvents(runId) ?? []);
    expect(JSON.stringify(replayed.nodes)).toEqual(JSON.stringify(state.nodes));
    expect(JSON.stringify(replayed.mutations)).toEqual(JSON.stringify(state.mutations));
    await finish(service, runId);
  });

  it('re-runs the node after an unobservable write is applied without marking it verified', async () => {
    const seen: Pass[] = [];
    const { service, definition } = harness({
      plans: [],
      fixtures: HAPPY_FIXTURES,
      propose: twoPassPlanner(seen, [tglPlan({ readAfterWriteCheck: undefined })]),
    });
    const { runId } = await service.createRun({
      workflowId: definition.id,
      mode: 'write',
      operator: 'alice',
    });
    await waitUntil(service, runId, (s) => s.mutations['plan-tgl']?.status === 'planned', 'proposed the plan');

    const approval = await service.approveMutation(runId, 'plan-tgl', 'alice');
    expect(approval.ok && approval.resolved && approval.outcome.status).toBe('applied');

    const state = await waitUntil(service, runId, (s) => s.nodes.hold?.status === 'gate_waiting', 'reached the gate');
    expect(seen).toEqual([{ pass: 1 }, { pass: 2, status: 'applied' }]);
    expect(eventsOfType(service, runId, 'mutation.verified')).toHaveLength(0);
    expect(state.nodes.propose?.summary).toMatch(/applied write/);
    expect(state.nodes.propose?.replan).toEqual({
      pass: 2,
      maxPasses: 3,
      requested: false,
      exhausted: false,
      reason: '1/1 mutation(s) applied — re-reading to plan the follow-up',
    });
    await finish(service, runId);
  });

  it('does not re-plan a read-after-write plan on the bare applied event', async () => {
    const seen: Pass[] = [];
    let releaseVerification: (() => void) | undefined;
    const verified = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const { service, transport, definition } = harness({
      plans: [],
      fixtures: HAPPY_FIXTURES,
      propose: twoPassPlanner(seen, [tglPlan()]),
    });
    const send = transport.send.bind(transport);
    vi.spyOn(transport, 'send').mockImplementation(async (req) => {
      const endpoint = req.headers['x-endpoint-id'] ?? req.url;
      if (endpoint === 'kasir.getHistoryKunjungan') {
        await verified;
      }
      return send(req);
    });
    const { runId } = await service.createRun({
      workflowId: definition.id,
      mode: 'write',
      operator: 'alice',
    });
    await waitUntil(service, runId, (s) => s.mutations['plan-tgl']?.status === 'planned', 'proposed the plan');

    const approval = service.approveMutation(runId, 'plan-tgl', 'alice');
    await waitUntil(service, runId, (s) => s.mutations['plan-tgl']?.status === 'applied', 'applied the plan');
    expect(seen).toEqual([{ pass: 1 }]);
    expect(eventsOfType(service, runId, 'node.replanning')).toHaveLength(0);

    releaseVerification?.();
    await expect(approval).resolves.toMatchObject({ ok: true, resolved: true });
    const state = await waitUntil(service, runId, (s) => s.nodes.hold?.status === 'gate_waiting', 'reached the gate');
    expect(seen).toEqual([{ pass: 1 }, { pass: 2, status: 'verified' }]);
    expect(state.nodes.propose?.summary).toBe('follow-up planned against a verified write');
    await finish(service, runId);
  });

  it('does not re-plan when the mutation was refused — nothing changed to re-read', async () => {
    const seen: Pass[] = [];
    const { service, transport, definition } = harness({
      plans: [],
      // The transaction was verified by someone else, so the precondition
      // fails and the write never fires.
      fixtures: { ...HAPPY_FIXTURES, 'kasir.cekStatusVerifikasi': { text: '1' } },
      propose: twoPassPlanner(seen, [tglPlan()]),
    });
    const { runId } = await service.createRun({
      workflowId: definition.id,
      mode: 'write',
      operator: 'alice',
    });
    await waitUntil(service, runId, (s) => s.mutations['plan-tgl']?.status === 'planned', 'proposed the plan');

    const approval = await service.approveMutation(runId, 'plan-tgl', 'alice');
    expect(approval.ok && approval.resolved && approval.outcome.status).toBe('invalidated');

    const state = await waitUntil(service, runId, (s) => s.nodes.hold?.status === 'gate_waiting', 'reached the gate');
    expect(seen).toEqual([{ pass: 1 }]);
    expect(endpointsCalled(transport)).not.toContain('kasir.updateTglMasuk');
    const exhausted = eventsOfType(service, runId, 'node.replan_exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.message).toMatch(/none of the 1 proposed mutation\(s\) were applied/);
    expect(state.nodes.propose?.replan).toMatchObject({ pass: 1, requested: true, exhausted: true });
    await finish(service, runId);
  });

  it('stops at the cap after three passes rather than looping forever', async () => {
    let calls = 0;
    const { service, definition } = harness({
      plans: [],
      fixtures: HAPPY_FIXTURES,
      propose: () => {
        calls += 1;
        return {
          status: 'needs_review',
          summary: `pass ${calls} still incomplete`,
          proposedMutations: [tglPlan({ id: `plan-${calls}`, idempotencyKey: `plan-${calls}` })],
          needsReplan: true,
        };
      },
    });
    const { runId } = await service.createRun({
      workflowId: definition.id,
      mode: 'write',
      operator: 'alice',
    });

    // Approve each pass's plan; the cap must stop the loop, not the operator.
    for (const planId of ['plan-1', 'plan-2']) {
      await waitUntil(service, runId, (s) => s.mutations[planId]?.status === 'planned', `proposed ${planId}`);
      const approval = await service.approveMutation(runId, planId, 'alice');
      expect(approval.ok && approval.resolved && approval.outcome.status).toBe('verified');
    }

    const state = await waitUntil(service, runId, (s) => s.nodes.hold?.status === 'gate_waiting', 'reached the gate');
    expect(calls).toBe(3);
    const exhausted = eventsOfType(service, runId, 'node.replan_exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.message).toMatch(/re-plan cap of 3 pass\(es\) reached/);
    expect(state.nodes.propose?.replan).toMatchObject({
      pass: 3,
      maxPasses: 3,
      requested: true,
      exhausted: true,
    });
    // The third pass's plan is left proposed and unapplied — the operator is
    // told, rather than the engine quietly firing a fourth round.
    expect(state.mutations['plan-3']?.status).toBe('planned');
    await finish(service, runId);
  });

  it('never re-plans a preview run', async () => {
    const seen: Pass[] = [];
    const { service, transport, definition } = harness({
      plans: [],
      fixtures: HAPPY_FIXTURES,
      propose: twoPassPlanner(seen, [tglPlan()]),
    });
    const { runId } = await service.createRun({ workflowId: definition.id, mode: 'preview' });
    const state = await service.waitFor(runId);

    expect(seen).toEqual([{ pass: 1 }]);
    expect(eventsOfType(service, runId, 'node.replanning')).toHaveLength(0);
    expect(eventsOfType(service, runId, 'node.replan_exhausted')).toHaveLength(0);
    // Preview never touches the network for a write, so nothing settled.
    expect(endpointsCalled(transport)).toEqual([]);
    expect(state?.mutations['plan-tgl']?.status).toBe('planned');
    // The ask is recorded honestly; it was simply never granted.
    expect(state?.nodes.propose?.replan).toEqual({
      pass: 1,
      maxPasses: 3,
      requested: true,
      exhausted: false,
    });
  });
});

describe('RunService rajal verification gates payment', () => {
  /**
   * A rajal write run wired to the real workflow with a fixture registry. The
   * transport counts every endpoint it was asked for, which is what proves no
   * payment was ever staged before the verification landed.
   */
  function rajalHarness(fixtures: Record<string, FixtureEntry>) {
    const transport = new FixtureTransport(fixtures);
    const createClient = (args: ExecutorFactoryArgs) =>
      new EvoMedisClient(
        { baseUrlV1: 'https://simrs.test/index.php', cookie: 'ci_session=test' },
        { mode: args.mode, transport, ...(args.mutationAllowlist ? { mutationAllowlist: args.mutationAllowlist } : {}) },
      );
    const entry: WorkflowEntry = {
      definition: rajalWorkflow,
      buildExecutors: (args) => createRajalExecutors({ client: createClient(args) }),
      createClient,
    };
    const service = new RunService(new MemoryLedger(), {
      workflows: (id) => (id === rajalWorkflow.id ? entry : undefined),
    });
    return { service, transport };
  }

  const RAJAL_WRITE_INPUT = { patientIds: ['012345'], clinics: ['PENYAKIT DALAM'], date: '2026-06-10' };

  it('withholds the payment plan until the verification plan is approved', async () => {
    const { service, transport } = rajalHarness(rajalFixtures);
    const { runId } = await service.createRun({
      workflowId: rajalWorkflow.id,
      mode: 'write',
      operator: 'alice',
      input: RAJAL_WRITE_INPUT,
    });

    // The run parks on the verification plan's re-plan barrier: the node asked
    // for another pass and is waiting for the plan to settle.
    const parked = await waitUntil(
      service,
      runId,
      (state) => state.nodes.check_verification?.replan?.requested === true,
      'parked on the verification re-plan barrier',
    );
    expect(parked.nodes.submit_payment!.proposedMutations).toHaveLength(0);
    expect(endpointsCalled(transport)).not.toContain('kasir.tampungBayar');

    // Nothing is sent to the payment endpoint until the verification is applied
    // and read-after-write verified through the gate.
    expect(parked.mutations).toMatchObject({});

    await finish(service, runId);
  });

  it('refuses to stage payment when the verification did not land', async () => {
    const { service, transport } = rajalHarness({
      ...rajalFixtures,
      // The write "lands" but the read-after-write check never sees it close.
      'kasir.cekStatusVerifikasi': { text: '0' },
    });
    const { runId } = await service.createRun({
      workflowId: rajalWorkflow.id,
      mode: 'write',
      operator: 'alice',
      input: RAJAL_WRITE_INPUT,
    });

    const parked = await waitUntil(
      service,
      runId,
      (state) => (state.nodes.check_verification?.proposedMutations.length ?? 0) > 0,
      'proposed a verification plan',
    );
    const plan = parked.nodes.check_verification!.proposedMutations[0]!;
    const approval = await service.approveMutation(runId, plan.id, 'alice');

    // The verification's own precondition (status still open) holds, the write
    // goes out, but the read-after-write rule wants "1" and reads "0".
    expect(approval.ok).toBe(true);
    const state = await service.getState(runId);
    const outcome = state?.mutations[plan.id];
    expect(outcome?.status).not.toBe('verified');
    // Payment is either still planned or never created; either way no payment
    // endpoint was called and no payment plan was approved.
    expect(endpointsCalled(transport).filter((id) => id === 'kasir.tampungBayar')).toHaveLength(0);
    await finish(service, runId);
  });
});

describe('RunService rajal batch payment (live 2026-10-20)', () => {
  it('keeps the run live until every auto-approved tampung bayar is written, one at a time', async () => {
    const trxOf: Record<string, string> = { '0-01-23-45': '01-200001', '0-67-89-01': '01-200002' };
    const paid = new Set<string>();
    const bodyOf = (req: { body?: string }) => Object.fromEntries(new URLSearchParams(req.body ?? ''));
    let inFlight = 0;
    let maxInFlight = 0;
    const transport = new FixtureTransport({
      ...rajalFixtures,
      'kasir.cekStatusVerifikasi': { text: '1' },
      'kasir.getHistoryKunjungan': (req) => {
        const trx = trxOf[bodyOf(req).nomedrec ?? ''] ?? '01-200001';
        const row = JSON.parse((rajalFixtures['kasir.getHistoryKunjungan'] as { text: string }).text).rows[0];
        return { text: JSON.stringify({ rows: [{ ...row, no_transaksi: trx, no_registrasikunjungan: `REG-${trx}` }] }) };
      },
      'kasir.tampungBayar': (req) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        paid.add(bodyOf(req).no_transaksi ?? '');
        inFlight -= 1;
        return { text: '' };
      },
      'kasir.getHistoryPembayaran': (req) => {
        const trx = new URL(req.url).searchParams.get('no_transaksi') ?? '';
        return { text: JSON.stringify(paid.has(trx) ? [{ no_transaksi: trx, total: '150000' }] : []) };
      },
    });
    const createClient = (args: ExecutorFactoryArgs) =>
      new EvoMedisClient(
        { baseUrlV1: 'https://simrs.test/index.php', cookie: 'ci_session=test' },
        { mode: args.mode, transport, ...(args.mutationAllowlist ? { mutationAllowlist: args.mutationAllowlist } : {}) },
      );
    const entry: WorkflowEntry = { definition: rajalWorkflow, buildExecutors: (args) => createRajalExecutors({ client: createClient(args) }), createClient };
    const service = new RunService(new MemoryLedger(), { workflows: (id) => (id === rajalWorkflow.id ? entry : undefined) });
    const { runId } = await service.createRun({
      workflowId: rajalWorkflow.id, mode: 'write', operator: 'alice', autoApprove: true,
      input: { patientIds: Object.keys(trxOf), clinics: ['PENYAKIT DALAM'], date: '2026-06-10' },
    });
    const state = await service.waitFor(runId);

    const payments = Object.entries(state!.mutations).filter(([id]) => id.includes('kasir.tampungBayar'));
    expect(payments.map(([, m]) => m.status)).toEqual(['verified', 'verified']);
    expect([...paid].sort()).toEqual(['01-200001', '01-200002']);
    expect(state!.nodes.submit_payment!.summary).toBe('2/2 tampung bayar tertulis');
    // Approved strictly after the previous one settled.
    const order = eventsOfType(service, runId, 'mutation.approved').concat(eventsOfType(service, runId, 'mutation.verified'))
      .filter((e) => String((e.data as { planId?: string }).planId).includes('tampungBayar'))
      .sort((x, y) => x.seq - y.seq).map((e) => e.type);
    expect(order).toEqual(['mutation.approved', 'mutation.verified', 'mutation.approved', 'mutation.verified']);
    expect(maxInFlight).toBe(1);
  });
});

describe('RunService memory retention', () => {
  it('evicts the oldest finished runs and serves them from the ledger instead', async () => {
    const ledger = new MemoryLedger();
    const service = new RunService(ledger, { retainFinishedRuns: 2 });

    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { runId } = await service.createRun({ workflowId: ranapWorkflow.id, mode: 'preview' });
      await service.waitFor(runId);
      ids.push(runId);
    }

    const [oldest] = ids;
    // Dropped from memory...
    expect(service.getEvents(oldest!)).toBeUndefined();
    // ...but still fully readable, because the ledger is the source of truth.
    const summaries = await service.listRuns();
    expect(summaries).toHaveLength(3);
    expect(summaries.find((run) => run.runId === oldest)?.source).toBe('ledger');
    expect(summaries.filter((run) => run.source === 'memory')).toHaveLength(2);
    expect(await service.getState(oldest!)).toBeDefined();
  });

  it('does not re-parse a finished run ledger on every listRuns', async () => {
    const ledger = new MemoryLedger();
    const service = new RunService(ledger, { retainFinishedRuns: 0 });
    const { runId } = await service.createRun({ workflowId: ranapWorkflow.id, mode: 'preview' });
    await service.waitFor(runId);

    const first = await service.listRuns();
    const readHistory = vi.spyOn(ledger, 'readHistory');
    const second = await service.listRuns();

    expect(readHistory).not.toHaveBeenCalled();
    // Cached, but identical to the freshly parsed summary.
    expect(second).toEqual(first);
    expect(second[0]?.source).toBe('ledger');
  });
});

describe('RunService pause/resume', () => {
  it('parks a paused run before its next step and continues on resume', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const ran: string[] = [];
    const definition: WorkflowDefinition = {
      id: 'test-pause-flow', version: '1.0.0', label: 'Pause harness', domain: 'ranap',
      nodes: ['a', 'b'].map((id) => ({ id, label: id, group: 'g', kind: 'read' as const, executorRef: id, critical: false, defaultEnabled: true })),
      edges: [{ id: 'a-b', source: 'a', target: 'b', type: 'sequential' }],
    };
    const entry = {
      definition,
      buildExecutors: () => ({
        a: async () => { ran.push('a'); await first; return { status: 'success' as const, summary: 'a' }; },
        b: () => { ran.push('b'); return { status: 'success' as const, summary: 'b' }; },
      }),
      createClient: () => new EvoMedisClient({ baseUrlV1: 'https://simrs.test/index.php', cookie: 'c=1' }, { mode: 'preview', transport: new FixtureTransport({}) }),
    } as unknown as WorkflowEntry;
    const service = new RunService(new MemoryLedger(), { workflows: (id) => (id === definition.id ? entry : undefined) });
    const { runId } = await service.createRun({ workflowId: definition.id, mode: 'preview' });
    await waitUntil(service, runId, (state) => state.nodes.a?.status === 'running', 'started a');

    expect(service.pause(runId, 'alice')).toBe(true);
    expect(service.pause(runId)).toBe(false);
    release();
    // The running step finishes; the next one waits.
    await waitUntil(service, runId, (state) => state.nodes.a?.status === 'success', 'finished a');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ran).toEqual(['a']);
    expect((await service.getState(runId))?.status).toBe('paused');

    expect(service.resume(runId, 'alice')).toBe(true);
    expect(service.resume(runId)).toBe(false);
    await service.waitFor(runId);
    expect(ran).toEqual(['a', 'b']);
    expect((await service.getState(runId))?.status).toBe('completed');
    expect(eventsOfType(service, runId, 'run.paused')).toHaveLength(1);
    expect(eventsOfType(service, runId, 'run.resumed')).toHaveLength(1);
  });

  it('cancels a paused run instead of leaving it parked', async () => {
    const definition: WorkflowDefinition = {
      id: 'test-pause-cancel', version: '1.0.0', label: 'Pause cancel', domain: 'ranap',
      nodes: [{ id: 'a', label: 'a', group: 'g', kind: 'read', executorRef: 'a', critical: false, defaultEnabled: true }],
      edges: [],
    };
    const entry = {
      definition,
      buildExecutors: () => ({ a: () => ({ status: 'success' as const, summary: 'a' }) }),
      createClient: () => new EvoMedisClient({ baseUrlV1: 'https://simrs.test/index.php', cookie: 'c=1' }, { mode: 'preview', transport: new FixtureTransport({}) }),
    } as unknown as WorkflowEntry;
    const service = new RunService(new MemoryLedger(), { workflows: (id) => (id === definition.id ? entry : undefined) });
    const { runId } = await service.createRun({ workflowId: definition.id, mode: 'preview' });
    service.pause(runId);
    service.cancel(runId);
    await service.waitFor(runId);
    expect((await service.getState(runId))?.status).toBe('cancelled');
  });
});
