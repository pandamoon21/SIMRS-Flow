import type { NodeStatus, RunState, WorkflowDefinition } from '@simrs-flow/workflow-core';

/**
 * Pure phase-column layout for every workflow: one column per
 * `layout.phases` entry, left→right, cards stacked top→bottom in declaration
 * order. Rows stack by each card's real height, so a tall card (the rajal
 * MULAI recap) pushes the cards below it instead of overlapping them.
 */

export const CARD_WIDTH = 260;
export const CARD_HEIGHT = 176;
export const GAP_X = 72;
export const GAP_Y = 28;
export const START_X = 40;
export const HEADER_Y = 12;
export const HEADER_HEIGHT = 52;
export const START_Y = 84;
export const STEP_X = CARD_WIDTH + GAP_X;

/** Column for nodes that name no declared phase. */
const OVERFLOW_PHASE = { id: 'lainnya', label: 'Lainnya', description: 'Langkah tanpa tahap' };

export interface PhaseColumn {
  id: string;
  label: string;
  description: string;
  column: number;
  completed: number;
  skipped: number;
  total: number;
  active: boolean;
  failed: boolean;
  needsReview: boolean;
}

export interface PhaseNodePlacement {
  phaseId: string;
  column: number;
  row: number;
  position: { x: number; y: number };
  height: number;
}

export interface PhaseLayout {
  phases: PhaseColumn[];
  byNodeId: Record<string, PhaseNodePlacement>;
  bounds: { width: number; height: number };
}

export function buildPhaseLayout(
  definition: WorkflowDefinition,
  state: RunState | undefined,
  heightOf: (nodeId: string) => number,
): PhaseLayout {
  const declared = definition.layout?.phases ?? [];
  const known = new Set(declared.map((phase) => phase.id));
  const phaseOf = (node: WorkflowDefinition['nodes'][number]) =>
    node.ui?.phase && known.has(node.ui.phase) ? node.ui.phase : OVERFLOW_PHASE.id;
  const needsOverflow = definition.nodes.some((node) => phaseOf(node) === OVERFLOW_PHASE.id);
  const columns = needsOverflow ? [...declared, OVERFLOW_PHASE] : declared;

  const byNodeId: Record<string, PhaseNodePlacement> = {};
  let maxBottom = START_Y;
  const phases = columns.map((phase, column) => {
    const nodes = definition.nodes.filter((node) => phaseOf(node) === phase.id);
    let y = START_Y;
    nodes.forEach((node, row) => {
      const height = heightOf(node.id);
      byNodeId[node.id] = { phaseId: phase.id, column, row, position: { x: START_X + column * STEP_X, y }, height };
      y += height + GAP_Y;
    });
    maxBottom = Math.max(maxBottom, y - GAP_Y);
    const statuses: NodeStatus[] = nodes.map((node) => state?.nodes[node.id]?.status ?? 'pending');
    return {
      id: phase.id,
      label: phase.label,
      description: phase.description,
      column,
      completed: statuses.filter((status) => status === 'success').length,
      skipped: statuses.filter((status) => status === 'skipped').length,
      total: nodes.length,
      active: statuses.some((status) => status === 'running' || status === 'retrying' || status === 'gate_waiting'),
      failed: statuses.some((status) => status === 'failed' || status === 'blocked'),
      needsReview: statuses.some((status) => status === 'needs_review'),
    };
  });

  return {
    phases,
    byNodeId,
    bounds: {
      width: START_X + Math.max(0, columns.length - 1) * STEP_X + CARD_WIDTH,
      height: maxBottom - HEADER_Y,
    },
  };
}
