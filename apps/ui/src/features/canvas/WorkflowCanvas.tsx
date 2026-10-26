/**
 * WorkflowCanvas — renders the definition as a React Flow graph and overlays
 * live run state. Nodes/edges are derived (definition + RunState) → React
 * Flow elements on every store change, so the canvas is a pure projection.
 *
 * Every workflow uses the same phase-column layout (`phaseLayout.ts`): one
 * column per `layout.phases` entry with a header overlay, cards stacked by
 * their real height. Phases, labels and descriptions come from the definition.
 */

import { type CSSProperties, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Controls,
  EdgeLabelRenderer,
  MiniMap,
  Panel,
  useReactFlow,
  type Edge,
  type Node,
  MarkerType,
  Position,
} from 'reactflow';
import { useRunStore } from '../../store/runStore.js';
import { CARD_REASONS, cardHeightOf, WorkflowNode, type WorkflowNodeData } from './WorkflowNode.js';
import { ReferenceNode, type ReferenceNodeData } from './ReferenceNode.js';
import { REFERENCE_NOTES, edgeDisplayState } from './canvasPresentation.js';
import { rajalRecapHeight, rajalRecapOf } from './rajalPresentation.js';
import {
  buildPhaseLayout,
  CARD_HEIGHT,
  CARD_WIDTH,
  GAP_Y,
  HEADER_HEIGHT,
  HEADER_Y,
  START_X,
  STEP_X,
  type PhaseColumn,
} from './phaseLayout.js';
import type { EdgeStatus, NodeStatus } from '@simrs-flow/workflow-core';
import { Button, ButtonGroup } from '../../ui/primitives.js';
import { motionMs } from '../../ui/motion.js';
import { decisionTrailOf, nextStepOf } from './decisionTrail.js';
import { blockBounds, buildFlexLayout, checksOf, type FlexDirection, type FlexEdge } from './flexLayout.js';
import { FlexNode, type FlexNodeData } from './FlexNode.js';
import { FlowEdge, type FlowEdgeData } from './FlowEdge.js';
import { useAnimatedGraph } from './animatedGraph.js';
import { ranapRuleCatalog } from '@simrs-flow/domain-ranap';
import { rajalRuleCatalog } from '@simrs-flow/domain-rajal';


const nodeTypes = { workflow: WorkflowNode, reference: ReferenceNode, flex: FlexNode };
const edgeTypes = { flow: FlowEdge };

export type CanvasMode = 'fixed' | 'flex';
interface CanvasPrefs { mode: CanvasMode; direction: FlexDirection; fold: boolean }
const CANVAS_PREFS_KEY = 'simrs-flow.canvas.layout.v1';

function readPrefs(): CanvasPrefs {
  try {
    const parsed = JSON.parse(localStorage.getItem(CANVAS_PREFS_KEY) ?? '{}') as Partial<CanvasPrefs>;
    return { mode: parsed.mode === 'flex' ? 'flex' : 'fixed', direction: parsed.direction === 'LR' ? 'LR' : 'TB', fold: parsed.fold !== false };
  } catch {
    return { mode: 'fixed', direction: 'TB', fold: true };
  }
}

/** Phones and narrow tablets get the vertical tree: a horizontal one is far wider than the screen. */
const narrowScreen = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 900px)').matches;

const CATALOGS = { ranap: ranapRuleCatalog, rajal: rajalRuleCatalog } as const;
/** Steps per row (column when vertical) when the flexible tree is folded, so the whole run fits a screen's proportions. */
const FOLD_RANKS = 8;
/** A vertical block is a tall list, so its columns fold sooner. */
const FOLD_RANKS_TB = 5;

function flexEdgeColor(edge: FlexEdge, runLive: boolean): string {
  if (edge.axis === 'side') {
    return edge.tone === 'plan' ? 'var(--accent)' : edge.tone === 'warn' ? 'var(--warning)' : 'var(--danger)';
  }
  switch (edge.status) {
    case 'active': return runLive ? 'var(--accent)' : 'var(--success)';
    case 'taken': return 'var(--success)';
    case 'stopped': return 'var(--danger)';
    case 'skipped': return 'var(--ink-muted)';
    default: return 'var(--ink-faint)';
  }
}

/** A plan at one of these statuses will never move again. */
const TERMINAL_PLAN_STATUSES = new Set(['verified', 'failed', 'invalidated']);
const PROBLEM_STATUSES = new Set<NodeStatus>(['gate_waiting', 'failed', 'blocked', 'needs_review']);

function edgeColor(status: EdgeStatus): string {
  switch (status) {
    case 'active': return 'var(--accent)';
    case 'completed': return 'var(--success)';
    case 'failed': return 'var(--danger)';
    case 'skipped': return 'var(--ink-muted)';
    default: return 'var(--ink-faint)';
  }
}
export function cameraTargetNode<T extends { id: string; data: { status: NodeStatus } }>(nodes: readonly T[]): T | undefined {
  // A waiting gate outranks a running node: it is the one blocked on the operator.
  return nodes.find((node) => node.data.status === 'gate_waiting')
    ?? nodes.find((node) => node.data.status === 'running')
    ?? [...nodes].reverse().find((node) => !['pending', 'queued'].includes(node.data.status))
    ?? nodes[0];
}

export interface WorkflowCanvasProps {
  /** Ask the run page to reveal the inspector for the selected node. */
  readonly onReviewNode?: () => void;
  readonly onSelectExecutableNode?: () => void;
}

/** Aligned phase headers, portalled so they follow the pane transform. */
function PhaseHeaders({ phases }: { phases: readonly PhaseColumn[] }) {
  return (
    <EdgeLabelRenderer>
      {phases.map((phase) => (
        <div
          key={phase.id}
          className={`phase-header${phase.active ? ' is-active' : ''}${phase.failed ? ' is-failed' : ''}${phase.needsReview ? ' needs-review' : ''}`}
          style={{
            position: 'absolute',
            transform: `translate(${START_X + phase.column * STEP_X}px, ${HEADER_Y}px)`,
            width: CARD_WIDTH,
            height: HEADER_HEIGHT,
            pointerEvents: 'none',
          }}
          title={phase.description}
          aria-label={`${phase.label}: ${phase.completed} dari ${phase.total} selesai`}
        >
          <span className="phase-header-name">{phase.column + 1}. {phase.label}</span>
          <span className="phase-header-count">{phase.completed}/{phase.total}</span>
        </div>
      ))}
    </EdgeLabelRenderer>
  );
}

export function WorkflowCanvas({ onReviewNode, onSelectExecutableNode }: WorkflowCanvasProps) {
  const [followActive, setFollowActive] = useState(true);
  const [prefs, setPrefs] = useState<CanvasPrefs>(readPrefs);
  // No view transition here: the node tween morphs one layout into the other with the edges attached.
  const updatePrefs = (next: Partial<CanvasPrefs>) => setPrefs((previous) => {
    const merged = { ...previous, ...next };
    try { localStorage.setItem(CANVAS_PREFS_KEY, JSON.stringify(merged)); } catch { /* storage may be disabled */ }
    return merged;
  });
  const flex = prefs.mode === 'flex';
  const direction: FlexDirection = narrowScreen() ? 'TB' : prefs.direction;
  const definition = useRunStore((s) => s.definition);
  // Deferred: when events outpace what a slow PC can draw, React skips the stale
  // intermediate canvas renders instead of stalling the glide animations.
  const state = useDeferredValue(useRunStore((s) => s.state));
  const selectedNodeId = useRunStore((s) => s.selectedNodeId);
  const selectNode = useRunStore((s) => s.selectNode);
  const { fitBounds, getZoom, setCenter } = useReactFlow<WorkflowNodeData>();
  const previousFollowTarget = useRef<string>();
  // The operator's first pointer/keyboard interaction on this run wins over the
  // one-shot auto camera; a new definition or run re-arms it.
  const cameraTouched = useRef(false);
  const cameraKey = useRef<string>();
  const latestNodes = useRef<Node<WorkflowNodeData | ReferenceNodeData | FlexNodeData>[]>([]);
  const latestFollowActive = useRef(followActive);
  latestFollowActive.current = followActive;

  const rajalRecap = useMemo(
    () => (definition?.domain === 'rajal' ? rajalRecapOf(state) : undefined),
    [definition?.domain, state],
  );
  // Card content per step, shared by the fixed layout (heights) and the nodes.
  const cardData = useMemo(() => {
    if (!definition) return new Map<string, Omit<WorkflowNodeData, 'onSelect' | 'onReview'>>();
    const groupLabels = new Map(definition.layout?.groups?.map((group) => [group.id, group.label]) ?? []);
    const catalog = CATALOGS[definition.domain as keyof typeof CATALOGS];
    return new Map(definition.nodes.map((n) => {
      const rt = state?.nodes[n.id];
      const plans = rt?.proposedMutations ?? [];
      const outcomes = plans.map((plan) => state?.mutations[plan.id]);
      const recap = n.id === 'start_batch' ? rajalRecap : undefined;
      const next = nextStepOf(definition, state, n.id);
      const reasons = checksOf(rt, state, catalog?.entries.find((entry) => entry.nodeId === n.id)?.outcomes ?? [], CARD_REASONS);
      const data: Omit<WorkflowNodeData, 'onSelect' | 'onReview'> = {
        label: n.label,
        group: n.group,
        groupLabel: groupLabels.get(n.group) ?? n.group,
        kind: n.kind,
        status: rt?.status ?? 'pending',
        riskLevel: n.riskLevel,
        durationMs: rt?.durationMs,
        summary: rt?.summary,
        issues: rt?.issues ?? [],
        warnings: rt?.warnings ?? [],
        planCount: plans.length,
        plansPending: outcomes.filter((outcome) => !outcome || !TERMINAL_PLAN_STATUSES.has(outcome.status)).length,
        plansVerified: outcomes.filter((outcome) => outcome?.status === 'verified').length,
        plansFailed: outcomes.filter((outcome) => outcome?.status === 'failed' || outcome?.status === 'invalidated').length,
        isWriteRun: state?.mode === 'write',
        trail: decisionTrailOf(rt, state?.mutations),
        reasons: reasons.checks,
        reasonsHidden: reasons.hidden,
        reasonsAreRules: reasons.rulesShown,
        ...(next ? { next } : {}),
        ...(n.ui?.description ? { description: n.ui.description } : {}),
        ...(recap ? { clinicCountsState: recap.clinicCountsState, clinics: recap.clinics } : {}),
        ...(recap?.clinicCounts ? { clinicCounts: recap.clinicCounts } : {}),
        ...(recap?.queuePatients !== undefined ? { queuePatients: recap.queuePatients } : {}),
      };
      return [n.id, data] as const;
    }));
  }, [definition, rajalRecap, state]);

  const layout = useMemo(() => {
    if (!definition) return undefined;
    const recapHeight = rajalRecap ? rajalRecapHeight(rajalRecap) : CARD_HEIGHT;
    const reviewable = Boolean(onReviewNode);
    return buildPhaseLayout(definition, state, (id) => (id === 'start_batch' && rajalRecap
      ? recapHeight
      : cardHeightOf({ ...cardData.get(id)!, ...(reviewable ? { onReview: () => undefined } : {}) })));
  }, [cardData, definition, onReviewNode, rajalRecap, state]);

  const flexLayout = useMemo(() => {
    if (!definition || !flex) return undefined;
    const catalog = CATALOGS[definition.domain as keyof typeof CATALOGS];
    return buildFlexLayout(definition, state, (id) => catalog?.entries.find((entry) => entry.nodeId === id)?.outcomes ?? [], direction, prefs.fold ? (direction === 'TB' ? FOLD_RANKS_TB : FOLD_RANKS) : 0);
  }, [definition, direction, flex, prefs.fold, state]);

  const nodes = useMemo<Node<WorkflowNodeData | ReferenceNodeData | FlexNodeData>[]>(() => {
    if (!definition || !layout) return [];
    const executableNodes = definition.nodes.map((n) => {
      const placement = layout.byNodeId[n.id]!;
      const flexBox = flexLayout?.items.find((item) => item.kind === 'step' && item.id === n.id);
      return {
        id: n.id,
        type: 'workflow',
        position: flexBox ? { x: flexBox.x, y: flexBox.y } : placement.position,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        draggable: false,
        style: flexBox ? { width: flexBox.w, height: flexBox.h } : { width: CARD_WIDTH, height: placement.height },
        data: {
          ...cardData.get(n.id)!,
          ...(flexBox ? { compact: true, vertical: direction === 'TB' } : {}),
          onSelect: () => { selectNode(n.id); onSelectExecutableNode?.(); },
          ...(onReviewNode ? { onReview: () => { selectNode(n.id); onSelectExecutableNode?.(); onReviewNode(); } } : {}),
        },
        selected: n.id === selectedNodeId,
      };
    });
    if (flexLayout) {
      // Flexible: the step cards plus each step's checks, folds, forks and outcomes.
      const openStep = (stepId: string) => () => { selectNode(stepId); onSelectExecutableNode?.(); onReviewNode?.(); };
      const vertical = direction === 'TB';
      const flexNodes: Node<FlexNodeData>[] = flexLayout.items.flatMap((item): Node<FlexNodeData>[] => {
        if (item.kind === 'step') return [];
        const data: FlexNodeData = item.kind === 'check'
          ? { vertical, kind: 'check', mark: item.mark, text: item.text, ...(item.detail ? { detail: item.detail } : {}), onOpen: openStep(item.stepId) }
          : item.kind === 'more'
            ? { vertical, kind: 'more', count: item.count, rules: item.rules, onOpen: openStep(item.stepId) }
            : item.kind === 'branch' ? { vertical, kind: 'branch', text: item.text }
              : item.kind === 'join' ? { vertical, kind: 'join' } : { vertical, kind: 'outcome', tone: item.tone, text: item.text };
        return [{ id: item.id, type: 'flex', position: { x: item.x, y: item.y }, style: { width: item.w, height: item.h }, data, draggable: false, selectable: false, focusable: false }];
      });
      return [...executableNodes, ...flexNodes];
    }
    // A note sits under its anchor when that slot is free, otherwise at the
    // bottom of the anchor's column, so it never covers an executable card.
    const columnBottom = new Map<number, number>();
    for (const placement of Object.values(layout.byNodeId)) {
      columnBottom.set(placement.column, Math.max(columnBottom.get(placement.column) ?? 0, placement.position.y + placement.height));
    }
    const notes = REFERENCE_NOTES[definition.domain as 'rajal' | 'ranap'] ?? [];
    const referenceNodes: Node<ReferenceNodeData>[] = notes.flatMap((note) => {
      const anchor = layout.byNodeId[note.anchor];
      if (!anchor) return [];
      const below = anchor.position.y + anchor.height + GAP_Y;
      const free = Object.values(layout.byNodeId).every((other) => other.column !== anchor.column || other.position.y < below);
      const y = free ? below : (columnBottom.get(anchor.column) ?? below) + GAP_Y;
      columnBottom.set(anchor.column, y + CARD_HEIGHT);
      return [{
        id: `reference:${note.id}`,
        type: 'reference',
        position: { x: anchor.position.x + 20, y },
        data: { label: note.label, detail: note.detail },
        draggable: false,
        selectable: false,
        focusable: false,
      }];
    });
    return [...executableNodes, ...referenceNodes];
  }, [cardData, definition, direction, flexLayout, layout, selectedNodeId, selectNode, onReviewNode, onSelectExecutableNode]);
  latestNodes.current = nodes;


  const workflowNodes = nodes.filter((node): node is Node<WorkflowNodeData> => node.type === 'workflow');
  /**
   * Bring one step into view. In the flexible view the target is its whole
   * block (card, checks, outcomes); `fit` frames the block, otherwise the
   * camera only pans to it and keeps the operator's zoom.
   */
  const focusStep = useCallback((id: string, { fit = true, minZoom = 0.82, duration = motionMs(260) }: { fit?: boolean; minZoom?: number; duration?: number } = {}) => {
    const block = flexLayout ? blockBounds(flexLayout, id) : undefined;
    if (block && fit) {
      // A small block would otherwise be blown up to max zoom; frame at least a screenful around it.
      const width = Math.max(block.width, 1400);
      const height = Math.max(block.height, 560);
      fitBounds({ x: block.x - (width - block.width) / 2, y: block.y - (height - block.height) / 2, width, height }, { padding: 0.04, duration });
      return;
    }
    const node = latestNodes.current.find((n) => n.id === id);
    const box = block ?? (node ? { x: node.position.x, y: node.position.y, width: node.width ?? CARD_WIDTH, height: node.height ?? CARD_HEIGHT } : undefined);
    if (!box) return;
    setCenter(box.x + box.width / 2, box.y + box.height / 2, { zoom: Math.max(getZoom(), minZoom), duration });
  }, [fitBounds, flexLayout, getZoom, setCenter]);
  const latestFocus = useRef(focusStep);
  latestFocus.current = focusStep;

  // Steps the operator has to look at, in workflow order; ‹ › step through them (wrapping).
  const problemIds = workflowNodes.filter((node) => PROBLEM_STATUSES.has(node.data.status)).map((node) => node.id);
  const [problemCursor, setProblemCursor] = useState(-1);
  const showProblem = (delta: 1 | -1) => {
    if (problemIds.length === 0) return;
    const next = problemCursor < 0 ? (delta === 1 ? 0 : problemIds.length - 1) : (problemCursor + delta + problemIds.length) % problemIds.length;
    setProblemCursor(next);
    selectNode(problemIds[next]);
    focusStep(problemIds[next]!);
  };
  const problemPosition = problemCursor >= 0 && problemCursor < problemIds.length ? `${problemCursor + 1}/${problemIds.length}` : String(problemIds.length);
  /** Until a step has moved, "Saat ini" would only repeat "Awal". */
  const runReached = workflowNodes.some((node) => !['pending', 'queued'].includes(node.data.status));
  const centerActive = () => {
    const target = cameraTargetNode(workflowNodes);
    if (target) focusStep(target.id);
  };

  const fitToDisplay = useCallback(() => {
    if (flexLayout) {
      fitBounds(flexLayout.bounds, { padding: 0.06, duration: motionMs(320) });
      return;
    }
    if (!layout) return;
    fitBounds({ x: 0, y: HEADER_Y, ...layout.bounds }, { padding: 0.06, duration: motionMs(320) });
  }, [fitBounds, flexLayout, layout]);
  // Switching layout or direction re-frames the whole graph once.
  const firstFrame = useRef(true);
  useEffect(() => {
    if (firstFrame.current) { firstFrame.current = false; return; }
    const id = window.setTimeout(() => fitToDisplay(), 60);
    return () => window.clearTimeout(id);
    // Only on a mode/direction change, not on every state update.
  }, [prefs.mode, prefs.fold, direction]);

  // ponytail: one timer per run reads the latest frontier; only a new run re-arms it.
  useEffect(() => {
    if (!definition) return;
    const key = `${definition.id}:${state?.runId ?? ''}`;
    if (cameraKey.current !== key) {
      cameraKey.current = key;
      cameraTouched.current = false;
    }
    if (cameraTouched.current) return;
    const id = window.setTimeout(() => {
      if (cameraTouched.current || !latestFollowActive.current) return;
      const target = cameraTargetNode(latestNodes.current.filter((node): node is Node<WorkflowNodeData> => node.type === 'workflow'));
      if (!target) return;
      latestFocus.current(target.id, { minZoom: 0.85, duration: 0 });
      cameraTouched.current = true;
    }, 60);
    return () => window.clearTimeout(id);
  }, [definition?.id, state?.runId]);

  const markCameraTouched = useCallback(() => {
    cameraTouched.current = true;
  }, []);

  useEffect(() => {
    // Respect the Follow toggle: when off, never move the camera automatically.
    if (!followActive) return;
    // Follow the progress frontier: prefer an active node, otherwise the
    // furthest node that has already run. Replays often advance a node from
    // pending straight to success without a visible 'running' frame, so
    // tracking only 'running' left the viewport stranded mid-run.
    // A waiting review gate must not hold the camera when a later node runs.
    const activeNode = cameraTargetNode(nodes.filter((node): node is Node<WorkflowNodeData> => node.type === 'workflow'));
    if (!activeNode || ['pending', 'queued'].includes(activeNode.data.status)) return;
    const followTarget = `${activeNode.id}:${activeNode.data.status}`;
    if (previousFollowTarget.current === followTarget) return;
    previousFollowTarget.current = followTarget;
    // Following pans only: re-fitting every block as the run moves would keep changing the zoom.
    focusStep(activeNode.id, { fit: false, minZoom: flexLayout ? 0.6 : 0.82 });
  }, [flexLayout, focusStep, followActive, nodes]);

  useEffect(() => {
    if (!state || ['created', 'running', 'paused'].includes(state.status)) return;
    previousFollowTarget.current = undefined;
  }, [state?.status]);

  useEffect(() => {
    previousFollowTarget.current = undefined;
  }, [definition?.id, state?.runId]);

  const edges = useMemo<Edge[]>(() => {
    if (!definition) return [];
    if (flexLayout) {
      const runLive = Boolean(state && ['created', 'running', 'paused'].includes(state.status));
      const tb = direction === 'TB';
      return flexLayout.edges.map((edge): Edge<FlowEdgeData> => {
        const side = edge.axis === 'side';
        const color = flexEdgeColor(edge, runLive);
        // Every edge flows along the main axis, except a vertical list's ✗ → outcome, which steps right.
        const across = !tb || side;
        const live = runLive && edge.status === 'active';
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: across ? 'out-right' : 'out-bottom',
          targetHandle: across ? 'in-left' : 'in-top',
          type: 'flow',
          ...(edge.label ? { label: edge.label } : {}),
          data: { vertical: tb, ...(edge.through !== undefined ? { through: edge.through } : {}), ...(edge.wrapped !== undefined ? { wrapped: edge.wrapped } : {}) },
          className: `workflow-edge flex-edge flex-edge--${edge.axis} flex-edge--${side ? `side-${edge.tone}` : live ? 'active' : edge.status}`,
          style: { stroke: color },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 11, height: 11 },
        };
      });
    }
    return [
      ...definition.edges.map((e) => {
        const status = state?.edges[e.id]?.status ?? 'idle';
        const display = edgeDisplayState(status, state?.nodes[e.source]?.status ?? 'pending', state?.nodes[e.target]?.status ?? 'pending');
        // A traversed leg (`adjacent`) is a completed path: same green, solid.
        const color = edgeColor(display === 'adjacent' ? 'completed' : display);
        const sameColumn = layout?.byNodeId[e.source]?.column === layout?.byNodeId[e.target]?.column;
        const label = e.label ?? (e.condition ? e.condition.replace(/^origin_/, '').toUpperCase() : undefined);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          ...(sameColumn ? { sourceHandle: 'out-bottom', targetHandle: 'in-top' } : { sourceHandle: 'out-right', targetHandle: 'in-left' }),
          // Not RF's `animated`: a looping dash repaints the one SVG every edge shares; colour and weight mark the active leg.
          ...(label ? { label, labelBgPadding: [4, 2] as [number, number], labelBgBorderRadius: 2 } : {}),
          type: 'smoothstep',
          className: `workflow-edge workflow-edge--${display}${label ? ' workflow-edge--labelled' : ''}`,
          style: { stroke: color, strokeWidth: display === 'active' || display === 'failed' ? 2.5 : 1.5, strokeDasharray: display === 'skipped' ? '5 5' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        };
      }),
      ...(REFERENCE_NOTES[definition.domain as 'rajal' | 'ranap'] ?? [])
        .filter((note) => definition.nodes.some((node) => node.id === note.anchor))
        .map((note) => ({
          id: `reference-edge:${note.id}`,
          source: note.anchor,
          target: `reference:${note.id}`,
          sourceHandle: 'out-bottom',
          type: 'smoothstep',
          className: 'workflow-edge workflow-edge--reference',
          style: { stroke: 'var(--ink-muted)', strokeWidth: 1, strokeDasharray: '4 6' },
        })),
    ];
  }, [definition, direction, flexLayout, layout, state]);
  const animated = useAnimatedGraph(nodes, edges, `${prefs.mode}:${direction}:${prefs.fold}`);

  if (!definition) {
    return <div className="empty">Pick a workflow and start a run to see the canvas.</div>;
  }

  return (
    <ReactFlow
      nodes={animated.nodes}
      edges={animated.edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      nodesDraggable={false}
      onNodeClick={(_, node) => {
        markCameraTouched();
        if (node.type === 'workflow') (node.data as WorkflowNodeData).onSelect?.();
      }}
      onPaneClick={() => {
        markCameraTouched();
        selectNode(undefined);
      }}
      onMoveStart={(event) => { if (event) markCameraTouched(); }}
      minZoom={0.1}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      // Un-zoom the canvas relative to the page's fit-zoom. React Flow divides the
      // getBoundingClientRect handle offsets it measures by its own viewport zoom,
      // and under `html { zoom: var(--fit-zoom) }` that rect is already scaled by
      // the page zoom — edges then attach ~11 screen px off their handles. Living
      // in unzoomed CSS px restores one coordinate space for nodes, handles and
      // paths; fitView/fitBounds size the graph to this container.
      style={{ zoom: 'calc(1 / var(--fit-zoom, 1))' } as CSSProperties}
      className={flex ? `is-flex is-flex-${direction}` : 'is-fixed'}
    >
      <Panel position="top-right" className="canvas-helper-panel">
        <ButtonGroup size="sm" role="group" aria-label="Canvas view controls">
          <Button color="secondary" variant="outline" type="button" title="Ke langkah pertama alur" onClick={() => { cameraTouched.current = true; const first = definition.nodes[0]; if (first) focusStep(first.id); }}>Awal</Button>
          <Button color="secondary" variant="outline" type="button" disabled={!runReached} title={runReached ? 'Ke langkah yang sedang berjalan / menunggu, atau yang terakhir dicapai run' : 'Belum ada langkah yang berjalan — sama dengan Awal'} onClick={() => { cameraTouched.current = true; centerActive(); }}>Saat ini</Button>
        </ButtonGroup>
        <ButtonGroup size="sm" role="group" aria-label="Navigasi langkah bermasalah">
          <Button color="secondary" variant="outline" type="button" disabled={problemIds.length === 0} aria-label="Masalah sebelumnya" title="Langkah bermasalah sebelumnya" onClick={() => { cameraTouched.current = true; showProblem(-1); }}>‹</Button>
          <Button color="secondary" variant="outline" type="button" disabled={problemIds.length === 0} title={problemIds.length ? `Langkah gagal / perlu tinjauan / menunggu gate (${problemIds.length}) · klik untuk berikutnya` : 'Belum ada langkah bermasalah'} onClick={() => { cameraTouched.current = true; showProblem(1); }}>Issues {problemPosition}</Button>
          <Button color="secondary" variant="outline" type="button" disabled={problemIds.length === 0} aria-label="Masalah berikutnya" title="Langkah bermasalah berikutnya" onClick={() => { cameraTouched.current = true; showProblem(1); }}>›</Button>
        </ButtonGroup>
        <ButtonGroup size="sm" role="group" aria-label="Canvas view">
          <Button color="secondary" variant="outline" type="button" title="Ke langkah terakhir alur" onClick={() => { cameraTouched.current = true; const last = definition.nodes[definition.nodes.length - 1]; if (last) focusStep(last.id); }}>Akhir</Button>
          <Button color="secondary" variant="outline" type="button" title="Fit untuk seluruh alur · klik kartu untuk detail" onClick={() => { cameraTouched.current = true; fitToDisplay(); }}>Fit</Button>
          <Button color="secondary" variant="outline" type="button" onClick={() => { cameraTouched.current = true; if (selectedNodeId) focusStep(selectedNodeId, { minZoom: 0.9 }); }} disabled={!selectedNodeId} title={selectedNodeId ? 'Centre the selected node' : 'Select a node first'}>Selected</Button>
          <Button color={followActive ? 'info' : 'secondary'} variant={followActive ? undefined : 'outline'} type="button" aria-pressed={followActive} title={followActive ? 'Auto-follow the running node (on)' : 'Auto-follow the running node (off)'} onClick={() => { markCameraTouched(); setFollowActive((v) => !v); }}>Follow</Button>
        </ButtonGroup>
        <ButtonGroup size="sm" role="group" aria-label="Tata letak kanvas">
          <Button color={!flex ? 'info' : 'secondary'} variant={!flex ? undefined : 'outline'} type="button" aria-pressed={!flex} title="Kolom per fase (tata letak tetap)" onClick={() => updatePrefs({ mode: 'fixed' })}>Fixed</Button>
          <Button color={flex ? 'info' : 'secondary'} variant={flex ? undefined : 'outline'} type="button" aria-pressed={flex} title="Pohon keputusan: cek, cabang, dan jalur yang diambil" onClick={() => updatePrefs({ mode: 'flex' })}>Flexible</Button>
        </ButtonGroup>
        {flex ? (
          <ButtonGroup size="sm" role="group" aria-label="Arah pohon">
            <Button color={direction === 'TB' ? 'info' : 'secondary'} variant={direction === 'TB' ? undefined : 'outline'} type="button" aria-pressed={direction === 'TB'} title="Atas ke bawah" onClick={() => updatePrefs({ direction: 'TB' })}>↓ Vertikal</Button>
            <Button color={direction === 'LR' ? 'info' : 'secondary'} variant={direction === 'LR' ? undefined : 'outline'} type="button" aria-pressed={direction === 'LR'} disabled={narrowScreen()} title={narrowScreen() ? 'Layar sempit memakai vertikal' : 'Kiri ke kanan'} onClick={() => updatePrefs({ direction: 'LR' })}>→ Horizontal</Button>
            <Button color={prefs.fold ? 'info' : 'secondary'} variant={prefs.fold ? undefined : 'outline'} type="button" aria-pressed={prefs.fold} title={prefs.fold ? `Dilipat: tiap ${direction === 'TB' ? FOLD_RANKS_TB : FOLD_RANKS} langkah pindah ke baris baru · klik untuk satu garis panjang` : 'Satu garis panjang · klik untuk melipat jadi beberapa baris'} onClick={() => updatePrefs({ fold: !prefs.fold })}>⤶ Lipat</Button>
          </ButtonGroup>
        ) : null}
      </Panel>
      {layout && !flex ? <PhaseHeaders phases={layout.phases} /> : null}
      <MiniMap
        pannable
        className="workflow-minimap"
        position="bottom-right"
        zoomable
        onClick={(_, position) => {
          markCameraTouched();
          setCenter(position.x, position.y, { zoom: getZoom(), duration: motionMs(220) });
        }}
        onNodeClick={(_, node) => {
          markCameraTouched();
          if (node.type !== 'workflow') return;
          (node.data as WorkflowNodeData).onSelect?.();
          setCenter(node.position.x + (node.width ?? CARD_WIDTH) / 2, node.position.y + (node.height ?? CARD_HEIGHT) / 2, { zoom: Math.max(getZoom(), 0.9), duration: motionMs(220) });
        }}
        nodeClassName={(n) => (n.type === 'reference' ? 'mm-reference' : n.type === 'flex' ? 'mm-flex' : `mm-status-${(n.data as WorkflowNodeData).status}`)}
      />
      <Controls />
    </ReactFlow>
  );
}
