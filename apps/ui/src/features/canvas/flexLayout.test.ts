import { describe, expect, it } from 'vitest';
import { initialRunState, reasoningEvidence, type RunState, type WorkflowDefinition } from '@simrs-flow/workflow-core';
import { ranapRuleCatalog, ranapWorkflow } from '@simrs-flow/domain-ranap';
import { rajalRuleCatalog, rajalWorkflow } from '@simrs-flow/domain-rajal';
import { buildFlexLayout, MAX_CHECKS, rankSteps, type FlexDirection, type FlexItem } from './flexLayout.js';

const rulesFor = (catalog: typeof ranapRuleCatalog) => (id: string) => catalog.entries.find((e) => e.nodeId === id)?.outcomes ?? [];

function overlaps(a: FlexItem, b: FlexItem): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function assertNoOverlap(items: FlexItem[]) {
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      expect(overlaps(items[i]!, items[j]!), `${items[i]!.id} overlaps ${items[j]!.id}`).toBe(false);
    }
  }
}

describe('flexible layout', () => {
  for (const [name, workflow, catalog] of [['ranap', ranapWorkflow, ranapRuleCatalog], ['rajal', rajalWorkflow, rajalRuleCatalog]] as const) {
    for (const direction of ['TB', 'LR'] as FlexDirection[]) {
      it(`places every ${name} step, rule and diamond without overlap (${direction})`, () => {
        const layout = buildFlexLayout(workflow, undefined, rulesFor(catalog), direction);
        expect(layout.items.filter((i) => i.kind === 'step')).toHaveLength(workflow.nodes.length);
        assertNoOverlap(layout.items);
      });
    }
  }

  it('ranks a step after everything it depends on', () => {
    const rank = rankSteps(ranapWorkflow);
    for (const edge of ranapWorkflow.edges) expect(rank.get(edge.target)!).toBeGreaterThan(rank.get(edge.source)!);
  });

  it('swaps axes between vertical and horizontal', () => {
    const tb = buildFlexLayout(ranapWorkflow, undefined, () => [], 'TB');
    const lr = buildFlexLayout(ranapWorkflow, undefined, () => [], 'LR');
    const first = (layout: typeof tb, id: string) => layout.items.find((i) => i.id === id)!;
    const [a, b] = [ranapWorkflow.nodes[0]!.id, 'validate_sep'];
    expect(first(tb, b).y).toBeGreaterThan(first(tb, a).y);
    expect(first(lr, b).x).toBeGreaterThan(first(lr, a).x);
  });

  it('shows a finished step’s checks with ✗ first, caps them, and branches ✗ to its outcome', () => {
    const definition = { ...ranapWorkflow } as WorkflowDefinition;
    const state = initialRunState(definition, 'r', 'preview') as RunState;
    state.nodes.validate_sep = {
      ...state.nodes.validate_sep!,
      status: 'failed',
      evidence: [reasoningEvidence({ items: [
        ...Array.from({ length: 6 }, (_, i) => ({ label: `ok ${i}`, ok: true })),
        { label: 'SEP RITL ditemukan', ok: false, detail: 'tidak ada' },
      ] })],
    };
    const layout = buildFlexLayout(definition, state, () => [], 'TB');
    const checks = layout.items.filter((i) => i.kind === 'check' && i.stepId === 'validate_sep');
    expect(checks).toHaveLength(MAX_CHECKS);
    expect(checks[0]).toMatchObject({ mark: 'fail', text: 'SEP RITL ditemukan' });
    expect(layout.items.find((i) => i.kind === 'more' && i.stepId === 'validate_sep')).toMatchObject({ count: 2 });
    expect(layout.items.find((i) => i.kind === 'outcome' && i.stepId === 'validate_sep')).toMatchObject({ tone: 'stop', text: '■ Berhenti di sini' });
    assertNoOverlap(layout.items);
  });

  it('puts a decision diamond on real forks and colours the path taken', () => {
    const state = initialRunState(ranapWorkflow, 'r', 'preview') as RunState;
    const igd = ranapWorkflow.edges.find((e) => e.source === 'detect_origin' && e.target === 'process_igd')!;
    const poli = ranapWorkflow.edges.find((e) => e.source === 'detect_origin' && e.target === 'process_poli')!;
    state.nodes.detect_origin = { ...state.nodes.detect_origin!, status: 'success' };
    state.edges[igd.id] = { id: igd.id, status: 'completed' };
    state.edges[poli.id] = { id: poli.id, status: 'skipped' };
    const layout = buildFlexLayout(ranapWorkflow, state, () => [], 'TB');
    expect(layout.items.find((i) => i.id === 'detect_origin::branch')).toMatchObject({ kind: 'branch', text: 'IGD / POLI' });
    expect(layout.edges.find((e) => e.id === `spine:${igd.id}`)).toMatchObject({ source: 'detect_origin::branch', status: 'taken', label: 'IGD' });
    expect(layout.edges.find((e) => e.id === `spine:${poli.id}`)).toMatchObject({ status: 'skipped' });
  });
});

describe('flexible layout stability and shape', () => {
  /** Every step finished with the maximum number of checks, half of them ✗ with a planned fix. */
  function finishedState(workflow: WorkflowDefinition): RunState {
    const state = initialRunState(workflow, 'r', 'preview') as RunState;
    for (const node of workflow.nodes) {
      state.nodes[node.id] = {
        ...state.nodes[node.id]!,
        status: 'needs_review',
        evidence: [reasoningEvidence({ items: Array.from({ length: 8 }, (_, i) => ({ label: `cek ${i}`, ok: i % 2 === 0, ...(i % 2 ? { detail: 'x' } : {}) })) })],
      };
    }
    return state;
  }

  for (const direction of ['TB', 'LR'] as FlexDirection[]) {
    it(`stays overlap-free and keeps step order once every step has filled in its checks (${direction})`, () => {
      for (const [workflow, catalog] of [[ranapWorkflow, ranapRuleCatalog], [rajalWorkflow, rajalRuleCatalog]] as const) {
        const before = buildFlexLayout(workflow, undefined, rulesFor(catalog), direction);
        const after = buildFlexLayout(workflow, finishedState(workflow), rulesFor(catalog), direction);
        assertNoOverlap(after.items);
        // Same nodes for steps and joins (they move, animated, but never appear or vanish).
        const ids = (layout: typeof before) => layout.items.filter((i) => i.kind === 'step' || i.kind === 'join' || i.kind === 'branch').map((i) => i.id);
        expect(ids(after)).toEqual(ids(before));
      }
    });
  }

  for (const direction of ['TB', 'LR'] as FlexDirection[]) {
    it(`folds a long tree into rows without overlap, routing row changes through the gap (${direction})`, () => {
      const line = buildFlexLayout(ranapWorkflow, finishedState(ranapWorkflow), rulesFor(ranapRuleCatalog), direction);
      const folded = buildFlexLayout(ranapWorkflow, finishedState(ranapWorkflow), rulesFor(ranapRuleCatalog), direction, 8);
      assertNoOverlap(folded.items);
      const along = (layout: typeof line) => (direction === 'LR' ? layout.bounds.width : layout.bounds.height);
      expect(along(folded)).toBeLessThan(along(line) / 2);
      const wrapped = folded.edges.filter((e) => e.wrapped !== undefined);
      expect(wrapped.length).toBeGreaterThanOrEqual(3);
      // The detour runs in empty space: no item spans the gap's cross coordinate.
      for (const edge of wrapped) {
        for (const item of folded.items) {
          const [from, to] = direction === 'LR' ? [item.y, item.y + item.h] : [item.x, item.x + item.w];
          expect(edge.wrapped! > from && edge.wrapped! < to, `${edge.id} crosses ${item.id}`).toBe(false);
        }
      }
    });
  }

  it('is compact: a step block is far shorter than the old card-and-grid layout', () => {
    const layout = buildFlexLayout(ranapWorkflow, undefined, rulesFor(ranapRuleCatalog), 'LR');
    const perStep = layout.bounds.width / new Set(rankSteps(ranapWorkflow).values()).size;
    expect(perStep).toBeLessThan(560);
  });

  it('fans a step out to its checks and converges them on its join (LR)', () => {
    const state = initialRunState(ranapWorkflow, 'r', 'preview') as RunState;
    state.nodes.validate_sep = {
      ...state.nodes.validate_sep!,
      status: 'needs_review',
      evidence: [reasoningEvidence({ items: [{ label: 'a', ok: false, detail: 'x' }, { label: 'b', ok: true }] })],
    };
    const layout = buildFlexLayout(ranapWorkflow, state, () => [], 'LR');
    const [fail, ok] = layout.items.filter((i) => i.kind === 'check' && i.stepId === 'validate_sep');
    const outcome = layout.items.find((i) => i.kind === 'outcome' && i.stepId === 'validate_sep')!;
    // The ✗ continues to its outcome in its own row.
    expect(outcome.y).toBe(fail!.y);
    expect(outcome.x).toBeGreaterThan(fail!.x);
    const fan = layout.edges.filter((e) => e.source === 'validate_sep').map((e) => e.target);
    expect(fan).toEqual([fail!.id, ok!.id]);
    expect(layout.edges.find((e) => e.source === outcome.id)).toMatchObject({ target: 'validate_sep::join' });
    // A row without an outcome runs straight past the empty outcome slot before curving.
    expect(layout.edges.find((e) => e.source === ok!.id)).toMatchObject({ target: 'validate_sep::join', through: outcome.x + outcome.w });
    expect(layout.edges.find((e) => e.id.startsWith('spine:') && e.target === 'load_kasir')).toMatchObject({ source: 'validate_sep::join' });
  });

  it('lists a step’s checks under it when vertical, each outcome to the right of its check (TB)', () => {
    const state = initialRunState(ranapWorkflow, 'r', 'preview') as RunState;
    state.nodes.validate_sep = {
      ...state.nodes.validate_sep!,
      status: 'needs_review',
      evidence: [reasoningEvidence({ items: [{ label: 'a', ok: false, detail: 'x' }, { label: 'b', ok: true }] })],
    };
    const layout = buildFlexLayout(ranapWorkflow, state, () => [], 'TB');
    const step = layout.items.find((i) => i.id === 'validate_sep')!;
    const [fail, ok] = layout.items.filter((i) => i.kind === 'check' && i.stepId === 'validate_sep');
    const outcome = layout.items.find((i) => i.kind === 'outcome' && i.stepId === 'validate_sep')!;
    expect(fail!.x).toBe(step.x);
    expect(ok!.y).toBeGreaterThan(fail!.y);
    expect(outcome.y).toBe(fail!.y);
    expect(outcome.x).toBeGreaterThan(fail!.x + fail!.w);
    // A chain: step → ✗ → ✓ → join.
    expect(layout.edges.filter((e) => e.axis === 'fan' && e.source.startsWith('validate_sep')).map((e) => [e.source, e.target])).toEqual([
      ['validate_sep', fail!.id], [fail!.id, ok!.id], [ok!.id, 'validate_sep::join'],
    ]);
    // A lane is one list wide, not a fan of six chips.
    expect(layout.bounds.width).toBeLessThan(1400);
  });

  it('keeps a finished step’s rules when it recorded no checks, ticking its success rule', () => {
    const rules = () => [{ status: 'success' as const, text: 'semua cocok' }, { status: 'failed' as const, text: 'tidak cocok' }];
    const state = initialRunState(ranapWorkflow, 'r', 'preview') as RunState;
    state.nodes.validate_sep = { ...state.nodes.validate_sep!, status: 'success', evidence: [] };
    const layout = buildFlexLayout(ranapWorkflow, state, rules, 'LR');
    const checks = layout.items.filter((i) => i.kind === 'check' && i.stepId === 'validate_sep');
    expect(checks.map((c) => (c as { mark: string }).mark)).toEqual(['ok', 'rule']);
    expect(layout.items.some((i) => i.kind === 'outcome' && i.stepId === 'validate_sep')).toBe(false);
  });

  it('ends a stopped step at its stop outcome', () => {
    const state = initialRunState(ranapWorkflow, 'r', 'preview') as RunState;
    state.nodes.validate_sep = {
      ...state.nodes.validate_sep!,
      status: 'failed',
      evidence: [reasoningEvidence({ items: [{ label: 'a', ok: false, detail: 'x' }] })],
    };
    const layout = buildFlexLayout(ranapWorkflow, state, () => [], 'LR');
    const outcome = layout.items.find((i) => i.kind === 'outcome' && i.stepId === 'validate_sep')!;
    expect(outcome).toMatchObject({ tone: 'stop' });
    expect(layout.edges.some((e) => e.source === outcome.id)).toBe(false);
  });
});

describe('flex layout edge labels', () => {
  const cases: Array<[string, WorkflowDefinition, typeof ranapRuleCatalog]> = [['ranap', ranapWorkflow, ranapRuleCatalog], ['rajal', rajalWorkflow, rajalRuleCatalog]];
  for (const [name, definition, catalog] of cases) {
    for (const direction of ['LR', 'TB'] as FlexDirection[]) {
      it(`${name} ${direction}: every step-to-step label fits in its gap, and single-fork diamonds carry no repeat label`, () => {
        const layout = buildFlexLayout(definition, undefined, rulesFor(catalog), direction);
        const byId = new Map(layout.items.map((i) => [i.id, i]));
        for (const edge of layout.edges.filter((e) => e.axis === 'main' && e.label && e.wrapped === undefined)) {
          const source = byId.get(edge.source)!;
          const target = byId.get(edge.target)!;
          // Gap along the main axis between the edge's two ends, vs the label pill (9.5px mono ≈ 6.2px/char + padding).
          const gap = direction === 'LR' ? target.x - (source.x + source.w) : target.y - (source.y + source.h);
          const need = direction === 'LR' ? edge.label!.length * 6.2 + 18 : 18;
          expect(gap, `${edge.id} "${edge.label}"`).toBeGreaterThanOrEqual(need);
        }
        for (const branch of layout.items.filter((i) => i.kind === 'branch')) {
          const out = layout.edges.filter((e) => e.axis === 'main' && e.source === branch.id);
          const forks = definition.edges.filter((e) => e.source === (branch as { stepId: string }).stepId && (e.type === 'branch' || e.type === 'guard'));
          if (forks.length === 1) expect(out.find((e) => e.id === `spine:${forks[0]!.id}`)?.label).toBeUndefined();
          // The diamond is wide enough for its question (text uses ~70% of the width at ~6.4px/char).
          const text = (branch as { text: string }).text;
          expect(branch.w * 0.7 + 1, text).toBeGreaterThanOrEqual(Math.min(text.length * 6.4, 300 * 0.7 - 12));
        }
      });
    }
  }
});
