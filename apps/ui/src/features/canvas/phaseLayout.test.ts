import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@simrs-flow/workflow-core';
import { ranapWorkflow } from '@simrs-flow/domain-ranap';
import { rajalWorkflow } from '@simrs-flow/domain-rajal';
import { buildPhaseLayout, CARD_HEIGHT, CARD_WIDTH, GAP_Y, type PhaseLayout } from './phaseLayout.js';

function noOverlap(layout: PhaseLayout): boolean {
  const rects = Object.values(layout.byNodeId).map((n) => ({ ...n.position, h: n.height }));
  return rects.every((a, i) => rects.every((b, j) => i === j
    || !(a.x < b.x + CARD_WIDTH && b.x < a.x + CARD_WIDTH && a.y < b.y + b.h && b.y < a.y + a.h)));
}

describe('phase-column layout', () => {
  it('maps ranap onto the nine legacy-flow columns', () => {
    const layout = buildPhaseLayout(ranapWorkflow, undefined, () => CARD_HEIGHT);
    // Pra-verifikasi holds four steps since the opt-in Kelengkapan Berkas notice.
    expect(layout.phases.map((p) => p.total)).toEqual([2, 2, 4, 5, 4, 4, 5, 4, 4]);
    expect(layout.phases.at(-1)?.label).toBe('Verifikasi & Bayar');
  });

  it('never draws an edge right-to-left and never overlaps cards', () => {
    for (const definition of [ranapWorkflow, rajalWorkflow]) {
      const layout = buildPhaseLayout(definition, undefined, () => CARD_HEIGHT);
      for (const edge of definition.edges) {
        expect(layout.byNodeId[edge.target]!.column, edge.id).toBeGreaterThanOrEqual(layout.byNodeId[edge.source]!.column);
      }
      expect(noOverlap(layout)).toBe(true);
    }
  });

  it('pushes cards below a tall MULAI recap instead of overlapping them', () => {
    const tall = 200 + 20 * 33;
    const layout = buildPhaseLayout(rajalWorkflow, undefined, (id) => (id === 'start_batch' ? tall : CARD_HEIGHT));
    const mulai = layout.byNodeId.start_batch!;
    const below = Object.values(layout.byNodeId).filter((n) => n.column === mulai.column && n.row > mulai.row);
    for (const node of below) expect(node.position.y).toBeGreaterThanOrEqual(mulai.position.y + tall + GAP_Y);
    expect(noOverlap(layout)).toBe(true);
    expect(layout.bounds.height).toBeGreaterThanOrEqual(mulai.position.y + tall - 12);
  });

  it('puts every node of a phase-less definition in one overflow column', () => {
    const bare: WorkflowDefinition = {
      ...rajalWorkflow,
      layout: { mode: 'manual' },
      nodes: rajalWorkflow.nodes.map(({ ui: _ui, ...node }) => node),
    };
    const layout = buildPhaseLayout(bare, undefined, () => CARD_HEIGHT);
    expect(layout.phases.map((p) => p.id)).toEqual(['lainnya']);
    expect(Object.values(layout.byNodeId).every((n) => n.phaseId === 'lainnya')).toBe(true);
  });

  it('counts progress per phase from run state', () => {
    const state = { nodes: { validate_sep: { status: 'needs_review' }, load_kasir: { status: 'success' } } } as never;
    const sep = buildPhaseLayout(ranapWorkflow, state, () => CARD_HEIGHT).phases.find((p) => p.id === 'sep')!;
    expect(sep).toMatchObject({ completed: 1, needsReview: true, total: 4 });
  });
});
