/**
 * RunApprovals on its own — no WorkflowRunner. The run is simulated with an
 * EventBus whose subscriber folds events into state and re-enters the sweep,
 * exactly as RunService wires it, so re-entrancy is exercised for real.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EvoMedisClient, FixtureTransport, type FixtureEntry } from '@simrs-flow/evomedis-client';
import {
  EventBus,
  applyEvent,
  initialRunState,
  type MutationPlan,
  type RunState,
  type WorkflowDefinition,
  type WorkflowNodeDefinition,
} from '@simrs-flow/workflow-core';
import { AUTO_APPROVER_ID, RunApprovals, resolveAutoApprove } from './runApprovals.js';

const DEFINITION: WorkflowDefinition = {
  id: 'test-approvals',
  version: '1.0.0',
  label: 'Approvals harness',
  domain: 'ranap',
  nodes: [
    { id: 'propose', label: 'Propose', group: 'g', kind: 'mutate', executorRef: 'propose', critical: false, defaultEnabled: true },
    { id: 'hold', label: 'Hold', group: 'g', kind: 'gate', executorRef: 'hold', critical: false, defaultEnabled: true, riskLevel: 'critical' },
  ],
  edges: [{ id: 'propose-hold', source: 'propose', target: 'hold', type: 'sequential' }],
};

function tglPlan(overrides: Partial<MutationPlan> = {}): MutationPlan {
  return {
    id: 'plan-tgl',
    endpointId: 'kasir.updateTglMasuk',
    riskLevel: 'high',
    reason: 'Align admission date',
    preconditions: [
      { description: 'Transaksi belum terverifikasi', check: 'kasir.cekStatusVerifikasi', expected: '0', payload: { no_transaksi: 'T-1' } },
    ],
    payloadSummary: { no_transaksi: 'T-1' },
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

const HAPPY: Record<string, FixtureEntry> = {
  'kasir.cekStatusVerifikasi': { text: '0' },
  'kasir.updateTglMasuk': { text: '1' },
  'kasir.getHistoryKunjungan': { text: JSON.stringify([{ no_transaksi: 'T-1', tgl_masuk: '2026-06-01' }]) },
};

function setup(options: {
  fixtures?: Record<string, FixtureEntry>;
  allowlist?: string[];
  criticalApprovals?: number;
  autoApproveAs?: string;
} = {}) {
  const transport = new FixtureTransport(options.fixtures ?? HAPPY);
  const client = new EvoMedisClient(
    { baseUrlV1: 'https://simrs.test/index.php', cookie: 'ci_session=test' },
    { mode: 'write', transport, mutationAllowlist: options.allowlist ?? ['kasir.updateTglMasuk'] },
  );
  let state: RunState = initialRunState(DEFINITION, 'run-1', 'write');
  const bus = new EventBus();
  const approvals = new RunApprovals({
    runId: 'run-1',
    mode: 'write',
    state: () => state,
    emit: (event) => {
      bus.emit({ runId: 'run-1', workflowId: DEFINITION.id, workflowVersion: DEFINITION.version, ...event });
    },
    signal: new AbortController().signal,
    criticalApprovals: options.criticalApprovals ?? 1,
    ...(options.autoApproveAs ? { autoApproveAs: options.autoApproveAs } : {}),
    nodes: new Map(DEFINITION.nodes.map((n) => [n.id, n] as const)),
    client,
  });
  // Same shape as RunService's subscriber: fold, then sweep (re-entrant).
  bus.subscribe((event) => {
    state = applyEvent(state, event);
    approvals.sweep();
  });
  const propose = (plans: MutationPlan[]) =>
    bus.emit({
      runId: 'run-1', workflowId: DEFINITION.id, workflowVersion: DEFINITION.version,
      type: 'node.needs_review', source: 'runner', nodeId: 'propose', data: { summary: 'planned', proposedMutations: plans },
    });
  const called = () => transport.calls.map((call) => call.headers['x-endpoint-id'] ?? call.url);
  return { approvals, propose, called, state: () => state, bus };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveAutoApprove (the single decision)', () => {
  it('auto-approves write runs on request or by host default, never preview', () => {
    expect(resolveAutoApprove('write', true, false)).toBe(true);
    expect(resolveAutoApprove('write', undefined, true)).toBe(true);
    expect(resolveAutoApprove('write', false, false)).toBe(false);
    expect(resolveAutoApprove('preview', undefined, true)).toBe(false);
  });

  it('refuses an explicit request outside write mode with the API error id', () => {
    expect(() => resolveAutoApprove('preview', true, false)).toThrow(
      expect.objectContaining({ statusCode: 400, apiError: 'autoApprove_requires_write_mode' }),
    );
  });
});

describe('RunApprovals — two-person rule', () => {
  it('a critical plan needs two distinct operators; the same operator twice does not count', async () => {
    const { approvals, propose, called, state } = setup({ criticalApprovals: 2 });
    propose([tglPlan({ riskLevel: 'critical' })]);

    const first = await approvals.approveMutation('plan-tgl', 'alice');
    expect(first).toMatchObject({ ok: true, resolved: false, required: 2, remaining: 1 });
    const again = await approvals.approveMutation('plan-tgl', 'alice');
    expect(again).toMatchObject({ ok: true, resolved: false, remaining: 1 });
    expect(called()).toEqual([]);

    const second = await approvals.approveMutation('plan-tgl', 'bob');
    expect(second).toMatchObject({ ok: true, resolved: true, approvals: ['alice', 'bob'] });
    expect(state().mutations['plan-tgl']?.status).toBe('verified');
    expect(state().mutations['plan-tgl']?.approvedBy).toEqual(['alice', 'bob']);
  });

  it('a critical gate resolves only on the second distinct approver', async () => {
    const { approvals } = setup({ criticalApprovals: 2 });
    const node = DEFINITION.nodes[1] as WorkflowNodeDefinition;
    const decision = approvals.resolveGate(node) as Promise<{ approved: boolean; reason?: string }>;

    expect(approvals.approveGate('hold', 'alice')).toEqual({ ok: true, resolved: false, remaining: 1 });
    expect(approvals.approveGate('hold', 'alice')).toEqual({ ok: true, resolved: false, remaining: 1 });
    expect(approvals.approveGate('hold', 'bob')).toEqual({ ok: true, resolved: true, remaining: 0 });
    await expect(decision).resolves.toEqual({ approved: true, reason: 'Approved by alice, bob' });
    expect(approvals.approveGate('hold', 'carol')).toEqual({ ok: false });
  });

  it('cancel releases a waiting gate as rejected', async () => {
    const { approvals } = setup();
    const decision = approvals.resolveGate(DEFINITION.nodes[1] as WorkflowNodeDefinition);
    approvals.cancel();
    await expect(decision).resolves.toEqual({ approved: false, reason: 'Run cancelled' });
  });
});

describe('RunApprovals — auto-approve never skips the guards', () => {
  it('auto-approves and signs a critical plan as operator + synthetic auto-approver', async () => {
    const { approvals, propose, state } = setup({ criticalApprovals: 2, autoApproveAs: 'alice' });
    propose([tglPlan({ riskLevel: 'critical' })]);
    await approvals.idle();

    expect(state().mutations['plan-tgl']?.status).toBe('verified');
    expect(state().mutations['plan-tgl']?.approvedBy).toEqual(['alice', AUTO_APPROVER_ID]);
  });

  it('still replays preconditions: a stale plan is invalidated before the write', async () => {
    const { approvals, propose, called, state } = setup({
      autoApproveAs: 'alice',
      fixtures: { ...HAPPY, 'kasir.cekStatusVerifikasi': { text: '1' } },
    });
    propose([tglPlan()]);
    await approvals.idle();

    expect(state().mutations['plan-tgl']?.status).toBe('invalidated');
    expect(called()).toEqual(['kasir.cekStatusVerifikasi']);
  });

  it('still enforces the client allowlist: a non-allowlisted endpoint is never called', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { approvals, propose, called, state } = setup({ autoApproveAs: 'alice', allowlist: ['kasir.tampungBayar'] });
    propose([tglPlan()]);
    await approvals.idle();

    expect(called()).not.toContain('kasir.updateTglMasuk');
    expect(state().mutations['plan-tgl']?.status).not.toBe('verified');
    expect(state().mutations['plan-tgl']?.status).not.toBe('applied');
  });

  it('re-entrant event delivery does not apply a plan twice', async () => {
    const { approvals, propose, called, state, bus } = setup({ autoApproveAs: 'alice' });
    propose([tglPlan()]);
    // Every emitted event re-enters sweep(); hammer it some more mid-flight.
    approvals.sweep();
    approvals.sweep();
    await approvals.idle();
    approvals.sweep();
    await approvals.idle();

    expect(called().filter((id) => id === 'kasir.updateTglMasuk')).toHaveLength(1);
    expect(state().mutations['plan-tgl']?.status).toBe('verified');
    expect(bus.getHistory().filter((event) => event.type === 'mutation.approved')).toHaveLength(1);
  });

  it('applies queued plans one at a time, in proposal order', async () => {
    const { approvals, propose, bus } = setup({ autoApproveAs: 'alice' });
    propose([tglPlan({ id: 'plan-a', idempotencyKey: 'a' }), tglPlan({ id: 'plan-b', idempotencyKey: 'b' })]);
    await approvals.idle();

    const trail = bus.getHistory()
      .filter((event) => event.type === 'mutation.approved' || event.type === 'mutation.verified')
      .map((event) => `${event.type.split('.')[1]}:${(event.data as { planId?: string }).planId}`);
    expect(trail).toEqual(['approved:plan-a', 'verified:plan-a', 'approved:plan-b', 'verified:plan-b']);
  });

  it('a manual approval of a settled plan is refused (idempotency)', async () => {
    const { approvals, propose } = setup({ autoApproveAs: 'alice' });
    propose([tglPlan()]);
    await approvals.idle();
    await expect(approvals.approveMutation('plan-tgl', 'bob')).resolves.toMatchObject({ ok: false, error: 'already_settled' });
  });
});
