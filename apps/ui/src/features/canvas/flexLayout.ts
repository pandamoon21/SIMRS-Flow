/**
 * Flexible ("decision tree") layout, shaped like the hand-drawn reference
 * trees: small label boxes, each step fanning out to the checks it made (or
 * its rules before it runs), every ✗ continuing to what the run did about it
 * (a planned fix, a review, a stop), and the rows converging again before the
 * next step.
 *
 * Pure geometry, written in main/cross coordinates so one algorithm serves
 * both directions: `TB` puts the main axis on y, `LR` on x.
 *
 *  1. Rank steps by longest path from the roots (Sugiyama layering), so a step
 *     always sits after everything it depends on.
 *  2. Order each rank by the barycenter of its parents' lanes (one downward
 *     sweep): parallel and branching steps sit side by side under the step
 *     they came from, which keeps crossings low without a solver.
 *  3. A step's block is step → its chips stacked across the main axis →
 *     outcomes (only when it has one) → a join, or the fork's diamond.
 *  4. Blocks take only the room they use, so the tree stays compact; when a
 *     run changes a block's size the canvas animates the move (see
 *     `animatedGraph.ts`), it never jumps.
 */
import type { NodeRuntimeState, RunState, StepStatus, WorkflowDefinition } from '@simrs-flow/workflow-core';
import { decisionTrailOf, type TrailItem, type TrailMark } from './decisionTrail.js';

export type FlexDirection = 'TB' | 'LR';

/** Visible check nodes per step; the rest fold into one "+N" node (✗ first, so none hide). */
export const MAX_CHECKS = 5;
const RULES_SHOWN = 3;

const STEP = { w: 176, h: 46 };
/** Two lines: what was checked, then the value it found (the reason the operator needs). */
const CHECK = { w: 208, h: 48 };
const OUTCOME = { w: 156, h: 34 };
const DIAMOND = { w: 96, h: 44 };
const JOIN = { w: 8, h: 8 };
const ROW_GAP = 6;
/** Vertical (list) block: step and checks share one column, outcomes to its right. */
const LIST = { step: { w: 248, h: 46 }, check: { w: 248, h: 48 }, outcome: { w: 176, h: 34 }, gapTop: 16, gapRow: 12, gapOut: 22 };
/** Card → chip column, room for the fan-out curves. */
const GAP_FAN = 40;
const GAP_OUT = 18;
/** Last column → join, room for the converging curves. */
const GAP_JOIN = 34;
const GAP_RANK = 34;
const LANE_GAP = 28;
/** Between folded rows: room for the edge that carries on to the next row. */
const ROW_SPACING = 72;
/** Text metrics (IBM Plex Mono, uppercase): diamond text 10px + .04em, edge label 9.5px + .05em and its pill padding. */
const DIAMOND_CHAR = 6.4;
const LABEL_CHAR = 6.2;
const LABEL_PAD = 18;
const LABEL_H = 18;
/** Clear space each side of an edge label, so it never touches the nodes it sits between. */
const LABEL_CLEAR = 14;
/** Distance between a detouring edge and the nodes it goes around. */
const DETOUR_CLEAR = 16;

/** What a step's diamond asks: its single fork's label as a question, or the branches side by side. */
function branchText(forks: ReadonlyArray<{ label?: string; condition?: string }>): string {
  return forks.length > 1 ? forks.map((e) => e.label ?? e.condition ?? '?').join(' / ') : `${forks[0]?.label ?? 'lanjut'}?`;
}

/** A diamond wide enough for its question (the text uses ~70% of the width), within limits. */
function diamondBox(text: string): { w: number; h: number } {
  return { w: Math.min(300, Math.max(DIAMOND.w, Math.ceil((text.length * DIAMOND_CHAR) / 0.7) + 12)), h: DIAMOND.h };
}

export type FlexMark = TrailMark | 'rule';
export type OutcomeTone = 'plan' | 'warn' | 'fail' | 'stop';
/** `active` = taken and leading into the step that is running or waiting right now. */
export type FlexEdgeStatus = 'taken' | 'active' | 'skipped' | 'pending' | 'stopped';

interface Box { x: number; y: number; w: number; h: number }

export type FlexItem =
  | ({ kind: 'step'; id: string } & Box)
  | ({ kind: 'check'; id: string; stepId: string; mark: FlexMark; text: string; detail?: string } & Box)
  | ({ kind: 'more'; id: string; stepId: string; count: number; rules: boolean } & Box)
  | ({ kind: 'branch'; id: string; stepId: string; text: string } & Box)
  | ({ kind: 'join'; id: string; stepId: string } & Box)
  | ({ kind: 'outcome'; id: string; stepId: string; tone: OutcomeTone; text: string } & Box);

export interface FlexEdge {
  id: string;
  source: string;
  target: string;
  /** `main` joins steps; `fan` runs between a step, its checks and its join; `side` leads to an outcome. */
  axis: 'main' | 'fan' | 'side';
  status: FlexEdgeStatus;
  tone?: OutcomeTone;
  label?: string;
  /** Main-axis coordinate the edge runs straight to before curving (past its row's empty outcome slot). */
  through?: number;
  /** Carries the tree from one folded row to the next: the cross coordinate of the gap it runs along. */
  wrapped?: number;
  /** Goes around the steps it skips: the cross coordinate of the clear line it runs along. */
  detour?: number;
}

export interface FlexLayout {
  items: FlexItem[];
  edges: FlexEdge[];
  bounds: { x: number; y: number; width: number; height: number };
}

export interface RuleLine { status: StepStatus; text: string }

const TERMINAL: ReadonlyArray<string> = ['success', 'failed', 'skipped', 'blocked', 'needs_review'];
const NOW: ReadonlyArray<string> = ['running', 'gate_waiting'];
const RULE_PREFIX: Partial<Record<StepStatus, string>> = { failed: 'Berhenti bila', blocked: 'Berhenti bila', needs_review: 'Ditinjau bila', success: 'Lanjut bila', skipped: 'Dilewati bila' };
const PRIORITY: Record<TrailMark, number> = { fail: 0, plan: 1, warn: 2, ok: 3, info: 4 };

/** Longest-path rank per node; cycles (none expected) fall back to definition order. */
export function rankSteps(definition: WorkflowDefinition): Map<string, number> {
  const rank = new Map<string, number>(definition.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < definition.nodes.length; pass += 1) {
    let changed = false;
    for (const edge of definition.edges) {
      const next = (rank.get(edge.source) ?? 0) + 1;
      if (rank.has(edge.target) && next > (rank.get(edge.target) ?? 0)) { rank.set(edge.target, next); changed = true; }
    }
    if (!changed) break;
  }
  return rank;
}

/**
 * What a step decided, for both canvas views: its recorded checks (✗ first), or
 * before it runs / when it recorded none, the rules it decides by.
 */
export function checksOf(node: NodeRuntimeState | undefined, state: RunState | undefined, rules: readonly RuleLine[], limit = MAX_CHECKS): { checks: Array<{ mark: FlexMark; text: string; detail?: string }>; hidden: number; rulesShown: boolean } {
  const ran = node && TERMINAL.includes(node.status);
  const items = ran
    ? [...decisionTrailOf(node, state?.mutations).items]
      .map((item, index) => ({ item, index }))
      .sort((a, b) => PRIORITY[a.item.mark] - PRIORITY[b.item.mark] || a.index - b.index)
      .map(({ item }) => item)
    : [];
  if (items.length > 0) {
    const shown = items.slice(0, limit).map((item: TrailItem) => ({ mark: item.mark as FlexMark, text: item.text, ...(item.detail ? { detail: item.detail } : {}) }));
    return { checks: shown, hidden: Math.max(0, items.length - limit), rulesShown: false };
  }
  // Not run yet, or ran without recording its checks: what the step decides,
  // from the generated rule catalog, so the rows never vanish when it finishes.
  // The rule that matches how the step ended (a success's "Lanjut bila", a skip's "Dilewati bila") is ticked and read first.
  const matched = (rule: RuleLine) => (node?.status === 'success' || node?.status === 'skipped') && rule.status === node.status;
  const lines = rules.filter((rule) => RULE_PREFIX[rule.status]).map((rule, index) => ({ rule, index }))
    .sort((a, b) => Number(matched(b.rule)) - Number(matched(a.rule)) || a.index - b.index)
    .map(({ rule }) => rule);
  return {
    checks: lines.slice(0, Math.min(limit, RULES_SHOWN)).map((rule) => ({
      mark: matched(rule) ? 'ok' as const : 'rule' as const,
      text: `${RULE_PREFIX[rule.status]}: ${rule.text}`,
    })),
    hidden: Math.max(0, lines.length - Math.min(limit, RULES_SHOWN)),
    rulesShown: true,
  };
}

/** A planned fix's detail is "<value> · <plan state>" (decisionTrail.ts): the state alone. */
export function planNote(detail: string | undefined): string | undefined {
  return detail?.split(' · ').at(-1);
}

/** What a chip shows under its label: the value found, without a plan's state (its outcome says that). */
export function chipDetail(mark: FlexMark, detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  if (mark !== 'plan') return detail;
  const parts = detail.split(' · ');
  return parts.length > 1 ? parts.slice(0, -1).join(' · ') : undefined;
}

function outcomeOf(mark: FlexMark, detail: string | undefined, node: NodeRuntimeState | undefined): { tone: OutcomeTone; text: string } | undefined {
  const stopped = node?.status === 'failed' || node?.status === 'blocked';
  // "direncanakan" alone does not say what happens next; the write still waits for an operator.
  // The chip shows the value; the outcome says only what happens next.
  if (mark === 'plan') { const note = planNote(detail); return { tone: 'plan', text: !note || note === 'direncanakan' ? '→ Perbaikan direncanakan' : `→ ${note}` }; }
  if (mark === 'warn') return { tone: 'warn', text: '⚠ Perlu ditinjau operator' };
  if (mark === 'fail') return stopped ? { tone: 'stop', text: '■ Berhenti di sini' } : { tone: 'fail', text: '✗ Tidak terpenuhi, run lanjut' };
  return undefined;
}

export function buildFlexLayout(
  definition: WorkflowDefinition,
  state: RunState | undefined,
  rulesOf: (nodeId: string) => readonly RuleLine[],
  direction: FlexDirection,
  /** Ranks per row before the tree folds onto a new row (column in TB); 0 = one long line. */
  wrap = 0,
): FlexLayout {
  const tb = direction === 'TB';
  const size = (box: { w: number; h: number }) => (tb ? { main: box.h, cross: box.w } : { main: box.w, cross: box.h });
  const place = (main: number, cross: number, s: { main: number; cross: number }): Box =>
    tb ? { x: cross, y: main, w: s.cross, h: s.main } : { x: main, y: cross, w: s.main, h: s.cross };
  const step = size(tb ? LIST.step : STEP);
  const check = size(tb ? LIST.check : CHECK);
  const outcome = size(tb ? LIST.outcome : OUTCOME);
  const rowPitch = check.cross + ROW_GAP;
  /**
   * Vertical blocks are a list, not a fan: the checks hang one under another
   * below their step and each outcome sits to the right of its check. Fanning
   * them sideways made every lane ~1000px wide and pushed sibling branches
   * (IGD / POLI) a screen apart.
   */
  const listShift = (LIST.gapOut + LIST.outcome.w) / 2;
  const forksOf = (id: string) => definition.edges.filter((e) => e.source === id && (e.type === 'branch' || e.type === 'guard'));
  const leaf = (id: string) => !definition.edges.some((e) => e.source === id);

  const rank = rankSteps(definition);
  const ranks: string[][] = [];
  for (const node of definition.nodes) (ranks[rank.get(node.id) ?? 0] ??= []).push(node.id);
  const parentsOf = (id: string) => definition.edges.filter((e) => e.target === id).map((e) => e.source);
  /**
   * Label drawn on a step-to-step edge. The edge out of a single-fork diamond
   * is left bare: the diamond already asks it ("DISETUJUI?"), and repeating it
   * on the edge only crowded the next step.
   */
  const spineLabelOf = (edge: WorkflowDefinition['edges'][number]): string | undefined => {
    const forks = forksOf(edge.source);
    if (forks.length === 1 && forks[0]!.id === edge.id) return undefined;
    return edge.label ?? (edge.condition ? edge.condition.replace(/^origin_/, '').toUpperCase() : undefined);
  };

  // Each step's chips (checks, then the "+N" fold) with the outcome a ✗ leads to.
  type Chip = { check?: { mark: FlexMark; text: string; detail?: string }; outcome?: { tone: OutcomeTone; text: string } };
  const blockOf = new Map(definition.nodes.map((n) => {
    const node = state?.nodes[n.id];
    const { checks, hidden, rulesShown } = checksOf(node, state, rulesOf(n.id));
    const chips: Chip[] = checks.map((c) => {
      const result = rulesShown ? undefined : outcomeOf(c.mark, c.detail, node);
      return { check: c, ...(result ? { outcome: result } : {}) };
    });
    if (hidden > 0) chips.push({});
    const forks = forksOf(n.id);
    return [n.id, { chips, hidden, rulesShown, hasOutcome: chips.some((c) => c.outcome), joinSize: size(forks.length > 0 ? diamondBox(branchText(forks)) : JOIN) }] as const;
  }));
  // Across the main axis a block always reserves room for the most chips it can show, so lanes
  // and folded rows never shift when a run fills a step in: only the steps after it in its own
  // row move, and the canvas animates far fewer nodes per change (smooth on office PCs).
  const halfOf = (id: string) => (tb
    ? Math.max(LIST.check.w + LIST.gapOut + LIST.outcome.w, 2 * (listShift + blockOf.get(id)!.joinSize.cross / 2)) / 2
    : Math.max(step.cross, (MAX_CHECKS + 1) * rowPitch - ROW_GAP, blockOf.get(id)!.joinSize.cross) / 2);

  // Lane centres: barycenter of the parents' lanes, then packed around 0 by each block's own width.
  const laneOf = new Map<string, number>();
  for (const ids of ranks) {
    if (!ids) continue;
    const ordered = ids
      .map((id, index) => {
        const parents = parentsOf(id).filter((p) => laneOf.has(p));
        const bary = parents.length ? parents.reduce((sum, p) => sum + laneOf.get(p)!, 0) / parents.length : 0;
        return { id, bary, index };
      })
      .sort((a, b) => a.bary - b.bary || a.index - b.index);
    const total = ordered.reduce((sum, entry) => sum + 2 * halfOf(entry.id), 0) + LANE_GAP * (ordered.length - 1);
    let cursor = -total / 2;
    for (const entry of ordered) {
      const half = halfOf(entry.id);
      laneOf.set(entry.id, cursor + half);
      cursor += 2 * half + LANE_GAP;
    }
  }

  const items: FlexItem[] = [];
  const edges: FlexEdge[] = [];
  /** Join (or diamond) of each step: where its outgoing step edges start. */
  const tailOf = new Map<string, string>();
  let mainCursor = 0;
  // Folding: every `wrap` ranks start a new row (column in TB) back at main 0.
  const rowOfRank = new Map<number, number>();
  const rowStart: number[] = [];
  let shown = 0;
  for (const [r, ids] of ranks.entries()) {
    if (!ids) continue;
    const row = wrap > 0 ? Math.floor(shown / wrap) : 0;
    if (shown > 0 && wrap > 0 && shown % wrap === 0) mainCursor = 0;
    if (rowStart[row] === undefined) rowStart[row] = items.length;
    rowOfRank.set(r, row);
    shown += 1;
    let rankLength = 0;
    for (const id of ids) {
      const node = state?.nodes[id];
      const spine = (laneOf.get(id) ?? 0) - (tb ? listShift : 0);
      const ran = Boolean(node && TERMINAL.includes(node.status));
      const stopped = node?.status === 'failed' || node?.status === 'blocked';
      const flow: FlexEdgeStatus = stopped ? 'stopped' : NOW.includes(node?.status ?? '') ? 'active' : node?.status === 'skipped' ? 'skipped' : ran ? 'taken' : 'pending';
      items.push({ kind: 'step', id, ...place(mainCursor, spine - step.cross / 2, step) });

      const { chips, hidden, rulesShown, hasOutcome, joinSize } = blockOf.get(id)!;
      if (tb) {
        // List: step → check → check → … → join, each ✗ branching right to its outcome.
        const forks = forksOf(id);
        const joinId = forks.length > 0 ? `${id}::branch` : `${id}::join`;
        let previous = id;
        let cursor = mainCursor + step.main + LIST.gapTop;
        chips.forEach((chip, i) => {
          const chipId = chip.check ? `${id}::check:${i}` : `${id}::more`;
          const box = place(cursor, spine - check.cross / 2, check);
          if (chip.check) {
            const c = chip.check;
            items.push({ kind: 'check', id: chipId, stepId: id, mark: c.mark, text: c.text, ...(c.detail ? { detail: c.detail } : {}), ...box });
          } else {
            items.push({ kind: 'more', id: chipId, stepId: id, count: hidden, rules: rulesShown, ...box });
          }
          // Past a stop the list is what the step checked, not a path the run took.
          const status: FlexEdgeStatus = stopped && previous !== id ? 'skipped' : stopped ? 'taken' : flow;
          edges.push({ id: `${previous}->${chipId}`, source: previous, target: chipId, axis: 'fan', status });
          if (chip.outcome) {
            const outcomeId = `${chipId}::outcome`;
            items.push({ kind: 'outcome', id: outcomeId, stepId: id, tone: chip.outcome.tone, text: chip.outcome.text, ...place(cursor, spine + check.cross / 2 + LIST.gapOut, outcome) });
            edges.push({ id: `${chipId}->${outcomeId}`, source: chipId, target: outcomeId, axis: 'side', status: 'taken', tone: chip.outcome.tone });
          }
          previous = chipId;
          cursor += check.main + LIST.gapRow;
        });
        if (leaf(id)) {
          // Nothing comes after this step: its list just ends, no dangling join.
          rankLength = Math.max(rankLength, cursor - LIST.gapRow - mainCursor);
          continue;
        }
        const joinMain = chips.length === 0 ? mainCursor + step.main + GAP_RANK : cursor - LIST.gapRow + LIST.gapTop;
        const joinBox = place(joinMain, spine - joinSize.cross / 2, joinSize);
        items.push(forks.length > 0
          ? { kind: 'branch', id: joinId, stepId: id, text: branchText(forks), ...joinBox }
          : { kind: 'join', id: joinId, stepId: id, ...joinBox });
        tailOf.set(id, joinId);
        edges.push({ id: `${previous}->${joinId}`, source: previous, target: joinId, axis: 'fan', status: stopped ? 'skipped' : flow });
        rankLength = Math.max(rankLength, joinMain + joinSize.main - mainCursor);
        continue;
      }
      const chipMain = mainCursor + step.main + GAP_FAN;
      const outcomeMain = chipMain + check.main + GAP_OUT;
      const columnsEnd = chips.length === 0 ? mainCursor + step.main : hasOutcome ? outcomeMain + outcome.main : chipMain + check.main;
      const joinMain = columnsEnd + (chips.length === 0 ? GAP_RANK : GAP_JOIN);
      const forks = forksOf(id);
      const joinId = forks.length > 0 ? `${id}::branch` : `${id}::join`;
      const joinBox = place(joinMain, spine - joinSize.cross / 2, joinSize);
      const end = leaf(id);
      if (end) {
        // Nothing comes after this step: its rows just end, no dangling join.
      } else if (forks.length > 0) {
        items.push({ kind: 'branch', id: joinId, stepId: id, text: branchText(forks), ...joinBox });
      } else {
        items.push({ kind: 'join', id: joinId, stepId: id, ...joinBox });
      }
      if (!end) tailOf.set(id, joinId);
      if (chips.length === 0 && !end) edges.push({ id: `${id}->${joinId}`, source: id, target: joinId, axis: 'fan', status: flow });

      // A stopped step's rows do not carry on to the next step.
      const onward: FlexEdgeStatus = stopped ? 'skipped' : flow;
      chips.forEach((chip, i) => {
        const cross = spine + (i - (chips.length - 1) / 2) * rowPitch - check.cross / 2;
        const chipId = chip.check ? `${id}::check:${i}` : `${id}::more`;
        if (chip.check) {
          const c = chip.check;
          items.push({ kind: 'check', id: chipId, stepId: id, mark: c.mark, text: c.text, ...(c.detail ? { detail: c.detail } : {}), ...place(chipMain, cross, check) });
        } else {
          items.push({ kind: 'more', id: chipId, stepId: id, count: hidden, rules: rulesShown, ...place(chipMain, cross, check) });
        }
        edges.push({ id: `${id}->${chipId}`, source: id, target: chipId, axis: 'fan', status: stopped ? 'taken' : flow });
        if (chip.outcome) {
          const outcomeId = `${chipId}::outcome`;
          // Centred on its chip's row, so the chip → outcome edge is straight.
          items.push({ kind: 'outcome', id: outcomeId, stepId: id, tone: chip.outcome.tone, text: chip.outcome.text, ...place(outcomeMain, cross + (check.cross - outcome.cross) / 2, outcome) });
          edges.push({ id: `${chipId}->${outcomeId}`, source: chipId, target: outcomeId, axis: 'side', status: 'taken', tone: chip.outcome.tone });
          if (chip.outcome.tone !== 'stop' && !end) edges.push({ id: `${outcomeId}->${joinId}`, source: outcomeId, target: joinId, axis: 'fan', status: onward });
          return;
        }
        // A row without an outcome runs straight past the empty outcome slot before curving.
        if (!end) edges.push({ id: `${chipId}->${joinId}`, source: chipId, target: joinId, axis: 'fan', status: onward, ...(hasOutcome ? { through: columnsEnd } : {}) });
      });
      rankLength = Math.max(rankLength, joinMain + joinSize.main - mainCursor);
    }
    // A labelled edge leaving this rank sits halfway across the gap: make the gap fit the label.
    const labelRoom = Math.max(0, ...ids.flatMap((id) => definition.edges
      .filter((e) => e.source === id)
      .map((e) => spineLabelOf(e))
      .filter((label): label is string => Boolean(label))
      .map((label) => (tb ? LABEL_H : label.length * LABEL_CHAR + LABEL_PAD) + 2 * LABEL_CLEAR)));
    mainCursor += rankLength + Math.max(GAP_RANK, labelRoom);
  }

  // Stack the rows across the main axis, each just clear of the one before.
  let offset = 0;
  let previousEdge = 0;
  const gapBefore: number[] = [];
  rowStart.forEach((from, row) => {
    const to = rowStart[row + 1] ?? items.length;
    const rowItems = items.slice(from, to);
    const crossOf = (i: FlexItem) => (tb ? [i.x, i.x + i.w] : [i.y, i.y + i.h]) as [number, number];
    const low = Math.min(...rowItems.map((i) => crossOf(i)[0]));
    const high = Math.max(...rowItems.map((i) => crossOf(i)[1]));
    if (row > 0) { offset = previousEdge - low + ROW_SPACING; gapBefore[row] = previousEdge + ROW_SPACING / 2; }
    for (const item of rowItems) { if (tb) item.x += offset; else item.y += offset; }
    previousEdge = high + offset;
  });

  /**
   * An edge that skips steps (check_balance → Ringkasan past the gate,
   * verifikasi and tampung bayar) would run straight through them. When the
   * straight line between its ends hits a node, it goes around instead: along
   * the near outer side of everything between its ends.
   */
  const byId = new Map(items.map((item) => [item.id, item]));
  const rowOfItem = new Map<FlexItem, number>();
  rowStart.forEach((from, row) => { for (const item of items.slice(from, rowStart[row + 1] ?? items.length)) rowOfItem.set(item, row); });
  const detourOf = (sourceId: string, targetId: string): number | undefined => {
    const a = byId.get(sourceId);
    const b = byId.get(targetId);
    if (!a || !b) return undefined;
    const mainOf = (i: FlexItem) => (tb ? [i.y, i.y + i.h] : [i.x, i.x + i.w]) as [number, number];
    const crossOf = (i: FlexItem) => (tb ? [i.x, i.x + i.w] : [i.y, i.y + i.h]) as [number, number];
    const from = mainOf(a)[1];
    const to = mainOf(b)[0];
    const lineAt = [(crossOf(a)[0] + crossOf(a)[1]) / 2, (crossOf(b)[0] + crossOf(b)[1]) / 2];
    const [lo, hi] = [Math.min(...lineAt) - 2, Math.max(...lineAt) + 2];
    const between = items.filter((i) => i !== a && i !== b && rowOfItem.get(i) === rowOfItem.get(a) && mainOf(i)[1] > from && mainOf(i)[0] < to);
    if (!between.some((i) => crossOf(i)[1] > lo && crossOf(i)[0] < hi)) return undefined;
    const low = Math.min(...between.map((i) => crossOf(i)[0])) - DETOUR_CLEAR;
    const high = Math.max(...between.map((i) => crossOf(i)[1])) + DETOUR_CLEAR;
    return Math.abs(high - lineAt[0]!) <= Math.abs(lineAt[0]! - low) ? high : low;
  };

  // Edges between steps, coloured by what the run actually did.
  for (const edge of definition.edges) {
    const status = state?.edges[edge.id]?.status;
    const source = state?.nodes[edge.source];
    const flex: FlexEdgeStatus = status === 'completed' || status === 'active'
      ? NOW.includes(state?.nodes[edge.target]?.status ?? '') ? 'active' : 'taken'
      : status === 'skipped' || status === 'failed' || state?.nodes[edge.target]?.status === 'skipped'
        ? 'skipped'
        : source?.status === 'failed' || source?.status === 'blocked' ? 'stopped' : 'pending';
    const label = spineLabelOf(edge);
    const targetRow = rowOfRank.get(rank.get(edge.target) ?? 0) ?? 0;
    const wrapped = rowOfRank.get(rank.get(edge.source) ?? 0) !== targetRow ? gapBefore[targetRow] : undefined;
    const from = tailOf.get(edge.source) ?? edge.source;
    const detour = wrapped === undefined ? detourOf(from, edge.target) : undefined;
    edges.push({ id: `spine:${edge.id}`, source: from, target: edge.target, axis: 'main', status: flex, ...(label ? { label } : {}), ...(wrapped !== undefined ? { wrapped } : {}), ...(detour !== undefined ? { detour } : {}) });
  }

  const detours = edges.flatMap((e) => (e.detour === undefined ? [] : [e.detour]));
  const minX = Math.min(...items.map((i) => i.x), ...(tb ? detours : []));
  const minY = Math.min(...items.map((i) => i.y), ...(tb ? [] : detours));
  const maxX = Math.max(...items.map((i) => i.x + i.w), ...(tb ? detours : []));
  const maxY = Math.max(...items.map((i) => i.y + i.h), ...(tb ? [] : detours));
  return { items, edges, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}

/** Bounds of one step's whole block (card, checks, outcomes, join), for the camera. */
export function blockBounds(layout: FlexLayout, stepId: string): { x: number; y: number; width: number; height: number } | undefined {
  const own = layout.items.filter((item) => item.id === stepId || ('stepId' in item && item.stepId === stepId));
  if (own.length === 0) return undefined;
  const minX = Math.min(...own.map((i) => i.x));
  const minY = Math.min(...own.map((i) => i.y));
  return { x: minX, y: minY, width: Math.max(...own.map((i) => i.x + i.w)) - minX, height: Math.max(...own.map((i) => i.y + i.h)) - minY };
}
