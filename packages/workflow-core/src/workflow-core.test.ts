import { describe, it, expect } from 'vitest';
import {
  WorkflowRunner,
  reduceEvents,
  eventsToJsonl,
  evaluateExpectation,
  isEmptyish,
  looksLikeBackendError,
  numberOf,
  readField,
  replayJsonl,
  fixedClock,
  counterIdFactory,
  EventBus,
  validateDefinition,
  verificationRulesOf,
} from '../src/index.js';
import type {
  ExecutorRegistry,
  MutationPlan,
  ReplanEventData,
  StepResult,
  WorkflowDefinition,
  WorkflowEvent,
} from '../src/index.js';

/** A tiny 4-node workflow: input -> read -> validate -> summary. */
const def: WorkflowDefinition = {
  id: 'test-flow',
  version: '1.0.0',
  label: 'Test Flow',
  domain: 'ranap',
  nodes: [
    { id: 'a', label: 'A', group: 'g', kind: 'input', executorRef: 'a', critical: false, defaultEnabled: true },
    { id: 'b', label: 'B', group: 'g', kind: 'read', executorRef: 'b', critical: true, defaultEnabled: true },
    { id: 'c', label: 'C', group: 'g', kind: 'validate', executorRef: 'c', critical: false, defaultEnabled: true },
    { id: 'd', label: 'D', group: 'g', kind: 'summary', executorRef: 'd', critical: false, defaultEnabled: true },
  ],
  edges: [
    { id: 'a-b', source: 'a', target: 'b', type: 'sequential' },
    { id: 'b-c', source: 'b', target: 'c', type: 'sequential' },
    { id: 'c-d', source: 'c', target: 'd', type: 'sequential' },
  ],
};

const ok = (summary: string): StepResult => ({ status: 'success', summary });

function registry(): ExecutorRegistry {
  return {
    a: () => ok('normalized'),
    b: (ctx) => {
      ctx.scratch.visits = 3;
      ctx.log('loaded visits');
      return ok('3 visits');
    },
    c: (ctx) => ok(`validated ${String(ctx.scratch.visits)}`),
    d: () => ok('summary'),
  };
}

function deterministicRunner(reg: ExecutorRegistry = registry()) {
  const clock = fixedClock();
  const bus = new EventBus({ clock, idFactory: counterIdFactory('evt') });
  return { runner: new WorkflowRunner(def, reg), bus, clock };
}

describe('validateDefinition', () => {
  it('accepts a valid DAG', () => {
    expect(validateDefinition(def, registry()).ok).toBe(true);
  });

  it('rejects dangling edges', () => {
    const bad: WorkflowDefinition = { ...def, edges: [{ id: 'x', source: 'a', target: 'nope' }] };
    const res = validateDefinition(bad);
    expect(res.ok).toBe(false);
    expect(res.problems.some((p) => p.code === 'dangling_edge_target')).toBe(true);
  });

  it('detects cycles', () => {
    const cyclic: WorkflowDefinition = {
      ...def,
      edges: [
        { id: 'a-b', source: 'a', target: 'b' },
        { id: 'b-a', source: 'b', target: 'a' },
      ],
    };
    expect(validateDefinition(cyclic).problems.some((p) => p.code === 'cycle')).toBe(true);
  });

  it('flags missing executors', () => {
    const res = validateDefinition(def, { a: () => ok('x') });
    expect(res.problems.some((p) => p.code === 'missing_executor')).toBe(true);
  });

  it('requires every node to name a declared phase once phases exist', () => {
    const phases = [{ id: 'p', label: 'P', description: 'only phase' }];
    const phased: WorkflowDefinition = {
      ...def,
      layout: { phases },
      nodes: def.nodes.map((n) => ({ ...n, ui: { phase: 'p' } })),
    };
    expect(validateDefinition(phased).ok).toBe(true);
    const stray = { ...phased, nodes: phased.nodes.map((n, i) => (i === 0 ? { ...n, ui: { phase: 'nope' } } : n)) };
    const res = validateDefinition(stray);
    expect(res.problems.map((p) => p.message)).toContain(`node ${def.nodes[0]!.id} has unknown phase nope`);
  });
});

describe('WorkflowRunner', () => {
  it('runs all nodes to completion', async () => {
    const { runner, bus } = deterministicRunner();
    const result = await runner.run({ bus, mode: 'preview', runId: 'run_1', clock: fixedClock() });
    expect(result.status).toBe('completed');
    expect(result.state.nodes.d!.status).toBe('success');
    expect(result.state.nodes.c!.summary).toBe('validated 3');
  });

  it('fails the run when a critical node throws', async () => {
    const reg = registry();
    reg.b = () => {
      throw new Error('boom');
    };
    const { runner, bus } = deterministicRunner(reg);
    const result = await runner.run({ bus, runId: 'run_2' });
    expect(result.status).toBe('failed');
    expect(result.state.nodes.b!.status).toBe('failed');
    // downstream not run
    expect(result.state.nodes.d!.status).toBe('pending');
  });

  it('skips downstream when an upstream node is disabled', async () => {
    const { runner, bus } = deterministicRunner();
    const result = await runner.run({ bus, runId: 'run_3', enabled: { b: false } });
    expect(result.state.nodes.b!.status).toBe('skipped');
    expect(result.state.nodes.c!.status).toBe('skipped');
  });

  it('retries a failing node up to maxAttempts', async () => {
    let calls = 0;
    const reg = registry();
    const retryDef: WorkflowDefinition = {
      ...def,
      nodes: def.nodes.map((n) =>
        n.id === 'c' ? { ...n, retry: { maxAttempts: 3, delayMs: 0 } } : n,
      ),
    };
    reg.c = () => {
      calls++;
      return calls < 3 ? ({ status: 'failed', summary: 'transient' } as StepResult) : ok('recovered');
    };
    const result = await new WorkflowRunner(retryDef, reg).run({ runId: 'run_4' });
    expect(calls).toBe(3);
    expect(result.state.nodes.c!.status).toBe('success');
  });

  it('cancels mid-run when the signal aborts', async () => {
    const controller = new AbortController();
    const reg = registry();
    reg.b = () => {
      controller.abort();
      return ok('aborting now');
    };
    const result = await new WorkflowRunner(def, reg).run({
      runId: 'run_5',
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
  });
});

describe('branch verdicts', () => {
  const branchDef: WorkflowDefinition = {
    ...def,
    nodes: [
      def.nodes[0]!,
      { ...def.nodes[1]!, id: 'left', executorRef: 'left', critical: false },
      { ...def.nodes[2]!, id: 'right', executorRef: 'right' },
      { ...def.nodes[3]!, id: 'merge', executorRef: 'merge' },
    ],
    edges: [
      { id: 'a-left', source: 'a', target: 'left', type: 'branch', condition: 'left' },
      { id: 'a-right', source: 'a', target: 'right', type: 'branch', condition: 'right' },
      { id: 'left-merge', source: 'left', target: 'merge', type: 'branch' },
      { id: 'right-merge', source: 'right', target: 'merge', type: 'branch' },
    ],
  };

  const execute = (branches?: StepResult['branches']) => {
    let planned = 0;
    const reg: ExecutorRegistry = {
      a: () => ({ ...ok('choice'), ...(branches ? { branches } : {}) }),
      left: () => ok('left'),
      right: () => ok('right'),
      merge: () => { planned++; return ok('planned'); },
    };
    return { run: new WorkflowRunner(branchDef, reg).run({ runId: 'branch-test' }), planned: () => planned };
  };

  it('takes one arm, skips the other and lets their merge execute', async () => {
    const { run, planned } = execute({ 'a-left': 'take', 'a-right': 'skip' });
    const result = await run;
    expect(result.state.nodes.left!.status).toBe('success');
    expect(result.state.nodes.right!.status).toBe('skipped');
    expect(result.state.edges['a-right']!.status).toBe('skipped');
    expect(result.events.some((event) => event.type === 'edge.skipped' && event.edgeId === 'a-right')).toBe(true);
    expect(result.state.nodes.merge!.status).toBe('success');
    expect(planned()).toBe(1);
  });

  it('does not execute a merge when both optional arms are skipped', async () => {
    const { run, planned } = execute({ 'a-left': 'skip', 'a-right': 'skip' });
    const result = await run;
    expect(result.state.nodes.merge!.status).toBe('skipped');
    expect(planned()).toBe(0);
  });

  it('keeps a proven selected arm when another arm is blocked', async () => {
    const { run, planned } = execute({ 'a-left': 'take', 'a-right': 'block' });
    const result = await run;
    expect(result.state.nodes.right!.status).toBe('skipped');
    expect(result.state.nodes.merge!.status).toBe('success');
    expect(planned()).toBe(1);
  });

  it('blocks ambiguous branches and prevents planning after the merge', async () => {
    const { run, planned } = execute({ 'a-left': 'block', 'a-right': 'block' });
    const result = await run;
    expect(result.state.nodes.left!.status).toBe('skipped');
    expect(result.state.nodes.right!.status).toBe('skipped');
    expect(result.state.nodes.merge!.status).toBe('skipped');
    expect(result.state.nodes.left!.summary).toBe('Cabang tidak pasti');
    expect(result.state.edges['a-left']!.status).toBe('skipped');
    expect(planned()).toBe(0);
  });

  it('allows a required merge from one selected arm but not from only pruned arms', async () => {
    const requiredMerge: WorkflowDefinition = {
      ...branchDef,
      edges: branchDef.edges.map((edge) => edge.target === 'merge' ? { ...edge, type: 'merge' } : edge),
    };
    let planned = 0;
    const reg: ExecutorRegistry = {
      a: () => ({ ...ok('choice'), branches: { 'a-left': 'take', 'a-right': 'skip' } }),
      left: () => ok('selected'),
      right: () => ok('unselected'),
      merge: () => { planned++; return ok('planned'); },
    };
    const selected = await new WorkflowRunner(requiredMerge, reg).run({ runId: 'required-merge-selected' });
    expect(selected.state.nodes.merge!.status).toBe('success');
    expect(planned).toBe(1);

    reg.a = () => ({ ...ok('choice'), branches: { 'a-left': 'block', 'a-right': 'skip' } });
    const none = await new WorkflowRunner(requiredMerge, reg).run({ runId: 'required-merge-none' });
    expect(none.state.nodes.merge!.status).toBe('skipped');
    expect(planned).toBe(1);

    reg.a = () => ({ ...ok('choice'), branches: { 'a-left': 'take', 'a-right': 'take' } });
    reg.right = () => ({ status: 'failed', summary: 'read failed' });
    const failed = await new WorkflowRunner(requiredMerge, reg).run({ runId: 'required-merge-failed' });
    expect(failed.state.nodes.merge!.status).toBe('skipped');
    expect(planned).toBe(1);
  });

  it('fails closed on a missing or invalid verdict for a conditional edge', async () => {
    const cases: NonNullable<StepResult['branches']>[] = [{ 'a-left': 'take' }, { 'a-left': 'take', 'a-right': 'invalid' as 'take' }];
    for (const branches of cases) {
      const { run, planned } = execute(branches);
      const result = await run;
      expect(result.state.nodes.right!.status).toBe('skipped');
      expect(result.state.edges['a-right']!.status).toBe('skipped');
      expect(result.state.nodes.merge!.status).toBe('success');
      expect(planned()).toBe(1);
    }
    const { run, planned } = execute();
    const result = await run;
    expect(result.state.nodes.merge!.status).toBe('skipped');
    expect(planned()).toBe(0);
  });

  it('skips required targets on a skipped edge even when the source succeeded', async () => {
    const requiredDef: WorkflowDefinition = {
      ...def,
      edges: [{ ...def.edges[0]!, condition: 'chosen' }, ...def.edges.slice(1)],
    };
    const reg = registry();
    reg.a = () => ({ ...ok('not chosen'), branches: { 'a-b': 'skip' } });
    const result = await new WorkflowRunner(requiredDef, reg).run({ runId: 'required-skip' });
    expect(result.state.nodes.b!.status).toBe('skipped');
    expect(result.state.nodes.c!.status).toBe('skipped');
    expect(result.state.edges['a-b']!.status).toBe('skipped');
  });

  it('preserves legacy completion for unconditional edges without branches', async () => {
    const result = await new WorkflowRunner(def, registry()).run({ runId: 'legacy-edges' });
    for (const edge of def.edges) {
      expect(result.events.some((event) => event.type === 'edge.completed' && event.edgeId === edge.id)).toBe(true);
    }
    expect(result.events.some((event) => event.type === 'edge.skipped')).toBe(false);
  });
});

describe('gate handling', () => {
  const gateDef: WorkflowDefinition = {
    ...def,
    nodes: def.nodes.map((n) => (n.id === 'c' ? { ...n, kind: 'gate' as const } : n)),
  };

  it('holds at a gate by default in preview', async () => {
    const result = await new WorkflowRunner(gateDef, registry()).run({ runId: 'run_g1' });
    expect(result.state.gates.c!.status).toBe('rejected');
    expect(result.state.nodes.c!.status).toBe('blocked');
  });

  it('proceeds when the gate resolver approves', async () => {
    const result = await new WorkflowRunner(gateDef, registry()).run({
      runId: 'run_g2',
      mode: 'write',
      gateResolver: () => ({ approved: true, reason: 'operator approved' }),
    });
    expect(result.state.gates.c!.status).toBe('approved');
    expect(result.state.nodes.d!.status).toBe('success');
  });
});

describe('expectation comparator', () => {
  /** `holds` for one (expected, observed) pair, with the default inference. */
  const holds = (expected: unknown, observed: unknown, extra: Record<string, unknown> = {}) =>
    evaluateExpectation({ expected, ...extra }, observed).holds;

  it('treats the backend spellings of "not set" as equivalent', () => {
    // `_ensure_tindakan_belum_terverifikasi` accepts "" or "0" for the same
    // question (ranap_v3.py:12293) — a text endpoint returns either.
    expect(holds('0', '0')).toBe(true);
    expect(holds('0', '')).toBe(true);
    expect(holds('0', '  ')).toBe(true);
    expect(holds('0', undefined)).toBe(true);
    // ...but a verified row must not read as unverified.
    expect(holds('0', '1')).toBe(false);
  });

  it('does not accept an empty answer for a positive expectation', () => {
    expect(holds('1', '1')).toBe(true);
    expect(holds('1', '')).toBe(false);
    expect(holds('1', '0')).toBe(false);
  });

  it('reads a blank field on row-shaped answers as empty (live komponen shape)', () => {
    const rows = [{ kd_komponen: '29', nama_paramedis: null }, { kd_komponen: '98', nama_paramedis: 'PERAWAT' }];
    expect(evaluateExpectation({ expected: '', field: 'nama_paramedis', match: 'empty', where: { kd_komponen: '29' } }, rows).holds).toBe(true);
    expect(evaluateExpectation({ expected: '', field: 'nama_paramedis', match: 'empty', where: { kd_komponen: '98' } }, rows).holds).toBe(false);
  });

  it('compares JSON emptiness across [], {} and {total: 0}', () => {
    expect(holds([], [])).toBe(true);
    expect(holds([], {})).toBe(true);
    expect(holds([], [{ no_kwitansi: 'K-1' }])).toBe(false);
    // `cek_order_belum_terlayani.total == 0` (ranap_v3.py:3768).
    expect(holds(0, { total: 0 })).toBe(true);
    expect(holds(0, { total: '2' })).toBe(false);
  });

  it('reads "no blocker" the way _normalize_penunjang_blocker does', () => {
    const clear = { nama_unit: '', no_transaksi: '', data: '', total: 0 };
    expect(holds('tidak ada blocker', clear)).toBe(true);
    expect(holds('tidak ada blocker', {})).toBe(true);
    expect(holds('tidak ada blocker', { ...clear, nama_unit: 'GIZI' })).toBe(false);
    expect(holds('tidak ada blocker', { ...clear, total: 1 })).toBe(false);
  });

  it('reads "> 0" expectations as "still set"', () => {
    expect(holds('> 0', '15000')).toBe(true);
    expect(holds('> 0', '')).toBe(false);
    expect(holds('> 0 baris', [{ kd_menu: '1' }])).toBe(true);
    expect(holds('> 0 baris', [])).toBe(false);
  });

  it('substring-matches a status phrase', () => {
    expect(holds('SUDAH KELUAR', 'STATUS: SUDAH KELUAR')).toBe(true);
    expect(holds('SUDAH KELUAR', 'BELUM KELUAR')).toBe(false);
  });

  it('matches an object expectation against the response or any of its rows', () => {
    expect(holds({ tunai: '0', piutang: '0' }, { tunai: '0', piutang: '0', total: '90000' })).toBe(true);
    expect(holds({ tunai: '0', piutang: '0' }, { tunai: '0', piutang: '50000' })).toBe(false);
    expect(holds({ no_sep: 'S-1' }, [{ no_sep: 'S-0' }, { no_sep: 'S-1' }])).toBe(true);
    expect(holds({ no_sep: 'S-1' }, { rows: [{ no_sep: 'S-2' }] })).toBe(false);
  });

  it('counts rows for a length expectation, accepting more than the minimum', () => {
    expect(holds(1, [{ a: 1 }], { field: 'length' })).toBe(true);
    expect(holds(1, [{ a: 1 }, { a: 2 }], { field: 'length' })).toBe(true);
    expect(holds(1, [], { field: 'length' })).toBe(false);
  });

  it('matches a field read off a row-shaped response when any row matches', () => {
    // `gethistorykunjungan` answers with rows; the rule names one field.
    const rows = [{ tgl_masuk: '2026-05-01' }, { tgl_masuk: '2026-06-01' }];
    expect(holds('2026-06-01', rows, { field: 'tgl_masuk' })).toBe(true);
    expect(holds('2026-07-01', rows, { field: 'tgl_masuk' })).toBe(false);
  });

  it('can require every selected row field to match', () => {
    const rows = [{ status_bayar: 'Sudah' }, { status_bayar: 'Belum' }];
    expect(holds('Sudah', rows, { field: 'status_bayar', match: 'allEquals' })).toBe(false);
    expect(holds('Sudah', rows.slice(0, 1), { field: 'status_bayar', match: 'allEquals' })).toBe(true);
    expect(holds('Sudah', [], { field: 'status_bayar', match: 'allEquals' })).toBe(false);
  });

  it('can narrow a row-shaped response before reading the field', () => {
    const rows = [
      { kd_tindakan: 'P01', urut_tindakan: '1', tgl_transaksi: '2026-06-09 07:30:00' },
      { kd_tindakan: 'P01', urut_tindakan: '2', tgl_transaksi: '2026-06-10 08:00:00' },
    ];
    expect(
      holds('2026-06-10', rows, {
        where: { kd_tindakan: 'P01', urut_tindakan: '2' },
        field: 'tgl_transaksi',
        match: 'contains',
      }),
    ).toBe(true);
    expect(
      holds('2026-06-10', rows, {
        where: { kd_tindakan: 'P01', urut_tindakan: '1' },
        field: 'tgl_transaksi',
        match: 'contains',
      }),
    ).toBe(false);
  });

  it('finds a value the plan was built against anywhere in the response', () => {
    // The SEP plans record the endpoint, not the field.
    expect(holds('S-123', { no_transaksi: 'T-1', no_sep: 'S-123' })).toBe(true);
    expect(holds('S-123', { no_transaksi: 'T-1', no_sep: 'S-999' })).toBe(false);
    // With an explicit field, only that field counts.
    expect(holds('S-123', { no_sep: 'S-999', other: 'S-123' }, { field: 'no_sep' })).toBe(false);
  });

  it('fails closed on an error page and on an unusable expectation', () => {
    expect(looksLikeBackendError('<html><body>Database Error</body></html>')).toBe(true);
    expect(holds('0', 'A PHP Error was encountered')).toBe(false);
    expect(holds('0', '<!DOCTYPE html>')).toBe(false);
    const unusable = evaluateExpectation({ expected: undefined }, '0');
    expect(unusable.holds).toBe(false);
    expect(unusable.reason).toMatch(/no comparable/);
  });

  it('honours an explicit match over the inferred one', () => {
    // '0' would infer `empty`; asked for equality it must compare exactly.
    expect(holds('0', '', { match: 'equals' })).toBe(false);
    expect(holds('0', '0', { match: 'equals' })).toBe(true);
  });

  it('exposes the helpers it is built from', () => {
    expect(isEmptyish({ a: '', b: 0 })).toBe(true);
    expect(numberOf('1.500.000')).toBe(1500000);
    expect(numberOf('abc')).toBeUndefined();
    expect(readField([{ no_sep: 'A' }, { no_sep: 'B' }], 'no_sep')).toEqual(['A', 'B']);
    expect(readField({ rows: [{ x: 1 }] }, 'length')).toBe(1);
  });
});

describe('mutation outcome projection', () => {
  const plan = (id: string): MutationPlan => ({
    id,
    endpointId: 'kasir.tampungBayar',
    riskLevel: 'critical',
    reason: 'test',
    preconditions: [],
    payloadSummary: { no_transaksi: 'T-1' },
    requiresApproval: true,
    idempotencyKey: id,
  });

  const mutateDef: WorkflowDefinition = {
    ...def,
    nodes: def.nodes.map((n) => (n.id === 'c' ? { ...n, kind: 'mutate' as const } : n)),
  };

  function runWithPlan(reg: ExecutorRegistry) {
    return new WorkflowRunner(mutateDef, reg).run({ runId: 'run_m1', clock: fixedClock() });
  }

  it('records every proposed plan as `planned`, keyed by plan id', async () => {
    const reg = registry();
    reg.c = () => ({
      status: 'needs_review',
      summary: 'planned',
      proposedMutations: [plan('p-1'), plan('p-2')],
    });
    const result = await runWithPlan(reg);
    expect(Object.keys(result.state.mutations)).toEqual(['p-1', 'p-2']);
    expect(result.state.mutations['p-1']).toMatchObject({
      planId: 'p-1',
      endpointId: 'kasir.tampungBayar',
      status: 'planned',
      nodeId: 'c',
      riskLevel: 'critical',
    });
  });

  it('advances a plan through approved → applied → verified', () => {
    const bus = new EventBus({ clock: fixedClock(), idFactory: counterIdFactory('evt') });
    const base = {
      runId: 'run_m2',
      workflowId: def.id,
      workflowVersion: def.version,
      source: 'api' as const,
      nodeId: 'c',
    };
    const events = [
      bus.emit({ ...base, type: 'mutation.planned', data: plan('p-1') }),
      bus.emit({ ...base, type: 'mutation.approved', data: { planId: 'p-1', endpointId: 'kasir.tampungBayar', approvedBy: ['alice', 'bob'] } }),
      bus.emit({ ...base, type: 'mutation.applied', data: { planId: 'p-1', endpointId: 'kasir.tampungBayar' } }),
      bus.emit({ ...base, type: 'mutation.verified', data: { planId: 'p-1', endpointId: 'kasir.tampungBayar' } }),
    ];
    const state = reduceEvents(def, 'run_m2', 'write', events);
    const outcome = state.mutations['p-1'];
    expect(outcome?.status).toBe('verified');
    expect(outcome?.approvedBy).toEqual(['alice', 'bob']);
    expect(outcome?.appliedAt).toBeDefined();
    expect(outcome?.settledAt).toBeDefined();
  });

  it('keeps `applied` visible when verification then fails', () => {
    const bus = new EventBus({ clock: fixedClock(), idFactory: counterIdFactory('evt') });
    const base = {
      runId: 'run_m3',
      workflowId: def.id,
      workflowVersion: def.version,
      source: 'api' as const,
    };
    const events = [
      bus.emit({ ...base, type: 'mutation.applied', data: { planId: 'p-9', endpointId: 'kasir.updateTglMasuk' } }),
      bus.emit({
        ...base,
        type: 'mutation.failed',
        data: { planId: 'p-9', endpointId: 'kasir.updateTglMasuk', phase: 'verify', reason: 'mismatch', ambiguous: true },
      }),
    ];
    const outcome = reduceEvents(def, 'run_m3', 'write', events).mutations['p-9'];
    // The write landed but was not confirmed — both facts must survive.
    expect(outcome?.status).toBe('failed');
    expect(outcome?.phase).toBe('verify');
    expect(outcome?.appliedAt).toBeDefined();
    expect(outcome?.ambiguous).toBe(true);
  });

  it('ignores a mutation event with no plan id', () => {
    const bus = new EventBus({ clock: fixedClock(), idFactory: counterIdFactory('evt') });
    const event = bus.emit({
      runId: 'run_m4',
      workflowId: def.id,
      workflowVersion: def.version,
      source: 'api',
      type: 'mutation.applied',
      data: { endpointId: 'kasir.updateTglMasuk' },
    });
    expect(reduceEvents(def, 'run_m4', 'write', [event]).mutations).toEqual({});
  });
});

describe('verificationRulesOf', () => {
  const rule = (description: string) => ({
    description,
    endpointId: 'kasir.cekStatusVerifikasi',
    field: 'status',
    expected: '1',
  });
  const base: MutationPlan = {
    id: 'p-1',
    endpointId: 'verifikator.simpanVerifikasi',
    riskLevel: 'critical',
    reason: 'test',
    preconditions: [],
    payloadSummary: {},
    requiresApproval: true,
    idempotencyKey: 'p-1',
  };

  it('treats the singular field as a one-element list', () => {
    expect(verificationRulesOf({ ...base, readAfterWriteCheck: rule('single') })).toHaveLength(1);
  });

  it('returns the plural rules as a conjunction', () => {
    const rules = verificationRulesOf({ ...base, readAfterWriteChecks: [rule('a'), rule('b')] });
    expect(rules.map((r) => r.description)).toEqual(['a', 'b']);
  });

  it('honours both fields rather than dropping either', () => {
    const rules = verificationRulesOf({
      ...base,
      readAfterWriteCheck: rule('legacy'),
      readAfterWriteChecks: [rule('new')],
    });
    expect(rules.map((r) => r.description)).toEqual(['legacy', 'new']);
  });

  it('is empty when a plan declares nothing', () => {
    expect(verificationRulesOf(base)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────
// ExecutorContext: the injected clock, and mutation outcomes
// ───────────────────────────────────────────────────────────────

describe('ExecutorContext', () => {
  it('hands executors the injected clock, so two runs stay byte-identical', async () => {
    // The Python stamps `datetime.now()` onto a target date
    // (`_build_update_datetime`). Reading the real clock here would make the
    // recorded stream irreproducible; `ctx.clock` is the replayable substitute.
    const reg = registry();
    reg.b = (ctx) => {
      ctx.scratch.stamp = ctx.clock.now().toISOString();
      return ok(`stamped ${String(ctx.scratch.stamp)}`);
    };
    reg.d = (ctx) => ok(`summary at ${String(ctx.scratch.stamp)}`);

    const run = () =>
      new WorkflowRunner(def, reg).run({
        runId: 'run_clock',
        clock: fixedClock(),
        bus: new EventBus({ clock: fixedClock(), idFactory: counterIdFactory('evt') }),
      });
    const a = await run();
    const b = await run();

    expect(a.state.nodes.d!.summary).toBe('summary at 2026-01-01T00:00:00.000Z');
    expect(eventsToJsonl(a.events)).toEqual(eventsToJsonl(b.events));
  });

  it('defaults to the system clock when none is injected', async () => {
    const reg = registry();
    let seen = 0;
    reg.a = (ctx) => {
      seen = ctx.clock.now().getTime();
      return ok('now');
    };
    const before = Date.now();
    await new WorkflowRunner(def, reg).run({ runId: 'run_sysclock' });
    expect(seen).toBeGreaterThanOrEqual(before);
  });

  it('exposes each plan’s outcome, read-only, to later nodes', async () => {
    const mutateDef: WorkflowDefinition = {
      ...def,
      nodes: def.nodes.map((n) => (n.id === 'c' ? { ...n, kind: 'mutate' as const } : n)),
    };
    const reg = registry();
    reg.c = () => ({
      status: 'needs_review',
      summary: 'planned',
      proposedMutations: [
        {
          id: 'p-1',
          endpointId: 'kasir.updateTglMasuk',
          riskLevel: 'high',
          reason: 'align date',
          preconditions: [],
          payloadSummary: {},
          requiresApproval: true,
          idempotencyKey: 'p-1',
        },
      ],
    });
    reg.d = (ctx) => {
      // Writing to the snapshot must not reach the run state.
      (ctx.mutations as Record<string, unknown>)['p-1'] = 'tampered';
      return ok(`p-1 is ${ctx.mutations['p-1']?.status ?? 'unknown'}`);
    };

    const result = await new WorkflowRunner(mutateDef, reg).run({
      runId: 'run_ctxmut',
      clock: fixedClock(),
    });

    // A preview run never applies, so the plan stays `planned` — which is
    // exactly the distinction `emit_summary` needs to make.
    expect(result.state.nodes.d!.summary).toBe('p-1 is planned');
    expect(result.state.mutations['p-1']?.status).toBe('planned');
  });
});

// ───────────────────────────────────────────────────────────────
// Re-plan passes (parity gaps 1 and 2)
// ───────────────────────────────────────────────────────────────

describe('re-plan passes', () => {
  const mutateDef: WorkflowDefinition = {
    ...def,
    nodes: def.nodes.map((n) => (n.id === 'c' ? { ...n, kind: 'mutate' as const } : n)),
  };

  const plan = (id: string): MutationPlan => ({
    id,
    endpointId: 'penatajasaInap.tambahTindakan',
    riskLevel: 'high',
    reason: 'add a charge line whose urut_tindakan the backend assigns',
    preconditions: [],
    payloadSummary: {},
    requiresApproval: true,
    idempotencyKey: id,
  });

  /** Stand-in for the orchestrator's gate: the write lands and confirms. */
  function settle(bus: EventBus, plans: readonly MutationPlan[]): void {
    for (const p of plans) {
      for (const type of ['mutation.applied', 'mutation.verified'] as const) {
        bus.emit({
          runId: 'run_rp',
          workflowId: def.id,
          workflowVersion: def.version,
          source: 'api',
          nodeId: 'c',
          type,
          message: `${type} ${p.id}`,
          data: { planId: p.id, endpointId: p.endpointId },
        });
      }
    }
  }

  function eventsOfType(events: readonly WorkflowEvent[], type: WorkflowEvent['type']) {
    return events.filter((event) => event.type === type);
  }

  it('re-runs a node whose mutations landed, and the second pass sees them', async () => {
    const seen: Array<{ pass: number; maxPasses: number; status?: string }> = [];
    const reg = registry();
    reg.c = (ctx) => {
      seen.push({
        pass: ctx.pass,
        maxPasses: ctx.maxPasses,
        ...(ctx.mutations['p-1'] ? { status: ctx.mutations['p-1'].status } : {}),
      });
      if (ctx.pass === 1) {
        return {
          status: 'needs_review',
          summary: 'line added; urut_tindakan not known yet',
          proposedMutations: [plan('p-1')],
          needsReplan: true,
        };
      }
      return ok(`re-dated the line (${ctx.mutations['p-1']?.status ?? 'unknown'})`);
    };

    const bus = new EventBus({ clock: fixedClock(), idFactory: counterIdFactory('evt') });
    const result = await new WorkflowRunner(mutateDef, reg).run({
      runId: 'run_rp',
      mode: 'write',
      bus,
      clock: fixedClock(),
      replanResolver: (request) => {
        settle(bus, request.proposedMutations);
        return { replan: true, reason: '1/1 mutation(s) applied' };
      },
    });

    // Pass 1 cannot see its own plan (it has not been emitted yet); pass 2 sees
    // the real outcome — a *verified* write, not a planned one.
    expect(seen).toEqual([
      { pass: 1, maxPasses: 3 },
      { pass: 2, maxPasses: 3, status: 'verified' },
    ]);
    expect(result.state.nodes.c!.status).toBe('success');
    expect(result.state.nodes.c!.summary).toBe('re-dated the line (verified)');
    expect(result.state.nodes.c!.replan).toEqual({
      pass: 2,
      maxPasses: 3,
      requested: false,
      exhausted: false,
      reason: '1/1 mutation(s) applied',
    });

    const replanning = eventsOfType(result.events, 'node.replanning');
    expect(replanning).toHaveLength(1);
    expect(replanning[0]?.data as ReplanEventData).toMatchObject({
      pass: 2,
      maxPasses: 3,
      planIds: ['p-1'],
    });
    expect(eventsOfType(result.events, 'node.replan_exhausted')).toHaveLength(0);
    // Downstream still ran once, after the node finally converged.
    expect(result.state.nodes.d!.status).toBe('success');
  });

  it('replays the re-plan passes to an identical state', async () => {
    const reg = registry();
    let calls = 0;
    reg.c = (ctx) => {
      calls += 1;
      return ctx.pass === 1
        ? {
            status: 'needs_review',
            summary: 'incomplete',
            proposedMutations: [plan('p-1')],
            needsReplan: true,
          }
        : ok('converged');
    };
    const bus = new EventBus({ clock: fixedClock(), idFactory: counterIdFactory('evt') });
    const result = await new WorkflowRunner(mutateDef, reg).run({
      runId: 'run_rp',
      mode: 'write',
      bus,
      clock: fixedClock(),
      replanResolver: (request) => {
        settle(bus, request.proposedMutations);
        return { replan: true, reason: 'applied' };
      },
    });

    expect(calls).toBe(2);
    // The whole point of the event contract: nothing about a re-plan lives
    // outside the stream, so the fold reproduces it exactly.
    const replayed = reduceEvents(mutateDef, 'run_rp', 'write', result.events);
    expect(JSON.stringify(replayed)).toEqual(JSON.stringify(result.state));
    const roundTripped = replayJsonl(mutateDef, eventsToJsonl(result.events), {
      runId: 'run_rp',
      mode: 'write',
    });
    expect(roundTripped.nodes.c!.replan).toEqual(result.state.nodes.c!.replan);
  });

  it('stops at the cap and reports it instead of spinning', async () => {
    let calls = 0;
    const reg = registry();
    reg.c = () => {
      calls += 1;
      return {
        status: 'needs_review',
        summary: `pass ${calls} still incomplete`,
        proposedMutations: [plan(`p-${calls}`)],
        needsReplan: true,
      };
    };
    const bus = new EventBus({ clock: fixedClock(), idFactory: counterIdFactory('evt') });
    let asked = 0;
    const result = await new WorkflowRunner(mutateDef, reg).run({
      runId: 'run_rp',
      mode: 'write',
      bus,
      clock: fixedClock(),
      replanResolver: (request) => {
        asked += 1;
        settle(bus, request.proposedMutations);
        return { replan: true, reason: 'applied' };
      },
    });

    // Three passes, two of them granted; the third request is never even put
    // to the resolver, because the cap is checked first.
    expect(calls).toBe(3);
    expect(asked).toBe(2);
    const exhausted = result.events.filter((e) => e.type === 'node.replan_exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.message).toMatch(/re-plan cap of 3 pass\(es\) reached/);
    expect(exhausted[0]?.severity).toBe('warn');
    expect(result.state.nodes.c!.replan).toEqual({
      pass: 3,
      maxPasses: 3,
      requested: true,
      exhausted: true,
      reason: 're-plan cap of 3 pass(es) reached',
    });
    // The run ends normally rather than hanging, and the node keeps its own
    // (unconverged) status for the operator to act on.
    expect(result.status).toBe('completed');
    expect(result.state.nodes.c!.status).toBe('needs_review');
  });

  it('honours a lower cap and clamps a nonsensical one', async () => {
    const reg = registry();
    let calls = 0;
    reg.c = () => {
      calls += 1;
      return {
        status: 'needs_review',
        summary: 'incomplete',
        proposedMutations: [plan(`p-${calls}`)],
        needsReplan: true,
      };
    };
    const one = await new WorkflowRunner(mutateDef, reg).run({
      runId: 'run_rp',
      mode: 'write',
      clock: fixedClock(),
      maxReplanPasses: 2,
      replanResolver: () => ({ replan: true }),
    });
    expect(calls).toBe(2);
    expect(one.state.nodes.c!.replan?.maxPasses).toBe(2);

    calls = 0;
    await new WorkflowRunner(mutateDef, reg).run({
      runId: 'run_rp',
      mode: 'write',
      clock: fixedClock(),
      maxReplanPasses: 0,
      replanResolver: () => ({ replan: true }),
    });
    expect(calls).toBe(1);
  });

  it('does not re-plan when the resolver declines, or when there is none', async () => {
    const reg = registry();
    let calls = 0;
    reg.c = () => {
      calls += 1;
      return {
        status: 'needs_review',
        summary: 'incomplete',
        proposedMutations: [plan('p-1')],
        needsReplan: true,
      };
    };
    const declined = await new WorkflowRunner(mutateDef, reg).run({
      runId: 'run_rp',
      mode: 'write',
      clock: fixedClock(),
      replanResolver: () => ({ replan: false, reason: 'nothing was applied' }),
    });
    expect(calls).toBe(1);
    expect(declined.state.nodes.c!.replan).toMatchObject({
      requested: true,
      exhausted: true,
      reason: 'nothing was applied',
    });

    calls = 0;
    const noResolver = await new WorkflowRunner(mutateDef, reg).run({
      runId: 'run_rp',
      mode: 'write',
      clock: fixedClock(),
    });
    expect(calls).toBe(1);
    expect(noResolver.state.nodes.c!.replan?.reason).toMatch(/no re-plan resolver/);
  });

  it('never re-plans a preview run', async () => {
    // Preview applies nothing (safety control #1), so there is never anything
    // new to re-read — the flag is recorded and ignored.
    let calls = 0;
    let asked = 0;
    const reg = registry();
    reg.c = () => {
      calls += 1;
      return {
        status: 'needs_review',
        summary: 'would need another pass',
        proposedMutations: [plan('p-1')],
        needsReplan: true,
      };
    };
    const result = await new WorkflowRunner(mutateDef, reg).run({
      runId: 'run_rp_preview',
      clock: fixedClock(),
      replanResolver: () => {
        asked += 1;
        return { replan: true };
      },
    });

    expect(calls).toBe(1);
    expect(asked).toBe(0);
    expect(
      result.events.some(
        (e) => e.type === 'node.replanning' || e.type === 'node.replan_exhausted',
      ),
    ).toBe(false);
    // The request is still recorded honestly — it just was not granted.
    expect(result.state.nodes.c!.replan).toEqual({
      pass: 1,
      maxPasses: 3,
      requested: true,
      exhausted: false,
    });
  });
});

describe('replay determinism', () => {
  it('reduces events to the same state and survives JSONL round-trip', async () => {
    const result = await new WorkflowRunner(def, registry()).run({
      runId: 'run_r1',
      clock: fixedClock(),
      bus: new EventBus({ clock: fixedClock(), idFactory: counterIdFactory('evt') }),
    });

    const direct = reduceEvents(def, 'run_r1', 'preview', result.events);
    const jsonl = eventsToJsonl(result.events);
    const replayed = replayJsonl(def, jsonl, { runId: 'run_r1' });

    expect(replayed.nodes.d!.status).toBe(direct.nodes.d!.status);
    expect(replayed.status).toBe(direct.status);
    expect(JSON.stringify(replayed.nodes)).toEqual(JSON.stringify(direct.nodes));
  });

  it('produces byte-identical event streams across two deterministic runs', async () => {
    const run = async () =>
      new WorkflowRunner(def, registry()).run({
        runId: 'run_fixed',
        clock: fixedClock(),
        bus: new EventBus({ clock: fixedClock(), idFactory: counterIdFactory('evt') }),
      });
    const a = await run();
    const b = await run();
    expect(eventsToJsonl(a.events)).toEqual(eventsToJsonl(b.events));
  });
});
