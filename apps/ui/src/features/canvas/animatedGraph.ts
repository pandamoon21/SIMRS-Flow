/**
 * Animates canvas layout changes cheaply enough for office PCs.
 *
 * A node that moves gets `is-gliding` for one glide: a CSS transform
 * transition, run by the browser's compositor, so React Flow renders once per
 * change instead of once per frame (a per-frame JS tween re-creates every node
 * and edge element each frame and fell to ~25 fps on a 4× slower CPU). Edges
 * cannot follow a CSS transition, so those touching a moving node get
 * `is-settling` (hidden) and fade back in where the node lands. New elements
 * fade in on mount (CSS); removed ones stay one glide with `is-exiting`.
 *
 * Only a layout switch (Fixed/Flexible, direction, fold) glides. A running
 * workflow re-flows the graph on nearly every event; on an office PC those
 * arrive faster than one glide, so gliding them kept most edges hidden for the
 * whole run (Flexible) or brought them back visibly late (Fixed). Run-driven
 * moves snap, with the edges attached.
 *
 * Unchanged elements keep their object identity, so React Flow skips them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Edge, Node } from 'reactflow';

export const GLIDE_MS = 340;

interface Frame { x: number; y: number; w?: number; h?: number }

function frameOf(node: Node): Frame {
  const width = node.style?.width;
  const height = node.style?.height;
  return { x: node.position.x, y: node.position.y, ...(typeof width === 'number' ? { w: width } : {}), ...(typeof height === 'number' ? { h: height } : {}) };
}

/**
 * React Flow 11 keeps a measured size only until the next `nodes` update, and
 * a node without one is hidden until re-measured — which never happens when
 * its size did not change. The known size is handed over as `width`/`height`.
 */
function sized<N extends Node>(node: N): N {
  const { w, h } = frameOf(node);
  return { ...node, ...(w !== undefined ? { width: w } : {}), ...(h !== undefined ? { height: h } : {}) };
}

export function movedBetween(a: Node, b: Node): boolean {
  const [p, q] = [frameOf(a), frameOf(b)];
  return Math.abs(p.x - q.x) > 0.5 || Math.abs(p.y - q.y) > 0.5 || Math.abs((p.w ?? 0) - (q.w ?? 0)) > 0.5 || Math.abs((p.h ?? 0) - (q.h ?? 0)) > 0.5;
}

const withClass = <T extends { className?: string }>(item: T, name: string): T => ({ ...item, className: `${item.className ?? ''} ${name}` });
const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Reuse the previous object for every element whose content is unchanged
 * (functions are ignored, as JSON drops them), so a run event re-renders only
 * the nodes and edges it actually touched.
 */
function useStable<T extends { id: string }>(items: T[], prepare: (item: T) => T): T[] {
  const cache = useRef(new Map<string, { key: string; item: T }>());
  return useMemo(() => {
    const next = new Map<string, { key: string; item: T }>();
    const out = items.map((item) => {
      const key = JSON.stringify(item);
      const hit = cache.current.get(item.id);
      const entry = hit && hit.key === key ? hit : { key, item: prepare(item) };
      next.set(item.id, entry);
      return entry.item;
    });
    cache.current = next;
    return out;
    // `prepare` is a pure module-level function.
  }, [items]);
}

const identity = <T,>(item: T) => item;

export interface Motion<N, E> {
  previous: { nodes: N[]; edges: E[]; layoutKey: string };
  /** Until when (ms) each node glides / each edge stays hidden; an interrupted glide keeps its class. */
  gliding: Map<string, number>;
  settling: Map<string, number>;
  leavingNodes: Map<string, { until: number; node: N }>;
  leavingEdges: Map<string, { until: number; edge: E }>;
}

export function newMotion<N extends Node, E extends Edge>(nodes: N[], edges: E[], layoutKey: string): Motion<N, E> {
  return { previous: { nodes, edges, layoutKey }, gliding: new Map(), settling: new Map(), leavingNodes: new Map(), leavingEdges: new Map() };
}

/** Fold one graph update into the motion state; nodes glide only when `layoutKey` changed. */
export function advanceMotion<N extends Node, E extends Edge>(m: Motion<N, E>, nodes: N[], edges: E[], layoutKey: string, now: number, animate = true): void {
  const { previous } = m;
  if ((previous.nodes !== nodes || previous.edges !== edges) && animate) {
    const until = now + GLIDE_MS;
    if (previous.layoutKey !== layoutKey) {
      const before = new Map(previous.nodes.map((n) => [n.id, n]));
      for (const node of nodes) {
        const old = before.get(node.id);
        if (old && old !== node && movedBetween(old, node)) m.gliding.set(node.id, until);
      }
      for (const edge of edges) {
        if (m.gliding.get(edge.source) === until || m.gliding.get(edge.target) === until) m.settling.set(edge.id, until);
      }
    }
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edgeIds = new Set(edges.map((e) => e.id));
    for (const node of previous.nodes) if (!nodeIds.has(node.id)) m.leavingNodes.set(node.id, { until, node });
    for (const edge of previous.edges) if (!edgeIds.has(edge.id)) m.leavingEdges.set(edge.id, { until, edge });
    // An element that comes back while its exiting copy is still out would be
    // rendered twice under one React key; React then strands DOM nodes the
    // store no longer knows (stale edges on the canvas, some hidden for good).
    for (const id of nodeIds) m.leavingNodes.delete(id);
    for (const id of edgeIds) m.leavingEdges.delete(id);
  }
  m.previous = { nodes, edges, layoutKey };
  for (const map of [m.gliding, m.settling]) for (const [id, t] of map) if (t <= now) map.delete(id);
  for (const map of [m.leavingNodes, m.leavingEdges]) for (const [id, l] of map) if (l.until <= now) map.delete(id);
}

export function useAnimatedGraph<N extends Node, E extends Edge>(rawNodes: N[], rawEdges: E[], layoutKey: string): { nodes: N[]; edges: E[] } {
  const nodes = useStable(rawNodes, sized);
  const edges = useStable(rawEdges, identity);
  const [tick, setTick] = useState(0);
  const motion = useRef(newMotion(nodes, edges, layoutKey));

  // Classes are decided in the same render that moves the node: a transition
  // only runs if it is in place when the transform changes.
  const { out, nextEnd } = useMemo(() => {
    const m = motion.current;
    advanceMotion(m, nodes, edges, layoutKey, performance.now(), !reducedMotion());
    const decorated = {
      nodes: m.gliding.size || m.leavingNodes.size
        ? [
            ...nodes.map((n) => (m.gliding.has(n.id) ? withClass(n, 'is-gliding') : n)),
            ...[...m.leavingNodes.values()].map((l) => withClass({ ...l.node, selectable: false, focusable: false }, 'is-exiting')),
          ]
        : nodes,
      edges: m.settling.size || m.leavingEdges.size
        ? [
            ...edges.map((e) => (m.settling.has(e.id) ? withClass(e, 'is-settling') : e)),
            ...[...m.leavingEdges.values()].map((l) => withClass({ ...l.edge, selectable: false, focusable: false }, 'is-exiting')),
          ]
        : edges,
    };
    const ends = [...m.gliding.values(), ...m.settling.values(), ...[...m.leavingNodes.values(), ...m.leavingEdges.values()].map((l) => l.until)];
    return { out: decorated, nextEnd: ends.length ? Math.max(...ends) : undefined };
    // `tick` re-runs this once the latest glide ends, to drop the classes.
  }, [nodes, edges, layoutKey, tick]);

  useEffect(() => {
    if (nextEnd === undefined) return;
    const timer = window.setTimeout(() => setTick((t) => t + 1), Math.max(0, nextEnd - performance.now()) + 20);
    return () => window.clearTimeout(timer);
  }, [nextEnd]);

  return out;
}
