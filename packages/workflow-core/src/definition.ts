/**
 * Definition helpers: validation, indexing, and execution ordering.
 *
 * The runner relies on a valid DAG. These helpers catch malformed
 * definitions early (dangling edges, unknown executors, cycles) and
 * compute the order in which nodes run.
 */

import type {
  ExecutorRegistry,
  WorkflowDefinition,
  WorkflowEdgeDefinition,
  WorkflowNodeDefinition,
} from './types.js';

export interface ValidationProblem {
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: ValidationProblem[];
}

/**
 * Validate a definition against a (optional) executor registry.
 * Pass the registry to also confirm every executorRef resolves.
 */
export function validateDefinition(
  definition: WorkflowDefinition,
  registry?: ExecutorRegistry,
): ValidationResult {
  const problems: ValidationProblem[] = [];
  const nodeIds = new Set<string>();

  for (const node of definition.nodes) {
    if (nodeIds.has(node.id)) {
      problems.push({ code: 'duplicate_node', message: `Duplicate node id: ${node.id}` });
    }
    nodeIds.add(node.id);
    if (registry && !(node.executorRef in registry)) {
      problems.push({
        code: 'missing_executor',
        message: `Node "${node.id}" references executor "${node.executorRef}" which is not registered`,
      });
    }
  }

  // Declared phases drive the canvas columns; a node naming an unknown phase
  // would silently fall into the overflow column, so it is a definition error.
  const phases = definition.layout?.phases;
  if (phases) {
    const phaseIds = new Set(phases.map((phase) => phase.id));
    for (const node of definition.nodes) {
      const phase = node.ui?.phase;
      if (!phase || !phaseIds.has(phase)) {
        problems.push({ code: 'unknown_phase', message: `node ${node.id} has unknown phase ${phase ?? '(none)'}` });
      }
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id)) {
      problems.push({ code: 'duplicate_edge', message: `Duplicate edge id: ${edge.id}` });
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) {
      problems.push({
        code: 'dangling_edge_source',
        message: `Edge "${edge.id}" source "${edge.source}" is not a node`,
      });
    }
    if (!nodeIds.has(edge.target)) {
      problems.push({
        code: 'dangling_edge_target',
        message: `Edge "${edge.id}" target "${edge.target}" is not a node`,
      });
    }
  }

  // Cycle detection via topo sort.
  const order = tryTopoSort(definition);
  if (!order) {
    problems.push({ code: 'cycle', message: 'Workflow graph contains a cycle' });
  }

  return { ok: problems.length === 0, problems };
}

/** Index nodes by id. */
export function indexNodes(
  definition: WorkflowDefinition,
): Map<string, WorkflowNodeDefinition> {
  return new Map(definition.nodes.map((n) => [n.id, n]));
}

/** Group outgoing edges by source node id. */
export function outgoingEdges(
  definition: WorkflowDefinition,
): Map<string, WorkflowEdgeDefinition[]> {
  const map = new Map<string, WorkflowEdgeDefinition[]>();
  for (const edge of definition.edges) {
    const list = map.get(edge.source) ?? [];
    list.push(edge);
    map.set(edge.source, list);
  }
  return map;
}

/** Edge lookup by (source,target). */
export function edgeBetween(
  definition: WorkflowDefinition,
  source: string,
  target: string,
): WorkflowEdgeDefinition | undefined {
  return definition.edges.find((e) => e.source === source && e.target === target);
}

/**
 * Kahn's algorithm. Returns null if the graph has a cycle.
 * Ties are broken by the node's original declaration order, which keeps the
 * execution order stable and matches the legacy pipeline sequence.
 */
export function tryTopoSort(definition: WorkflowDefinition): WorkflowNodeDefinition[] | null {
  const nodes = definition.nodes;
  const indexOf = new Map(nodes.map((n, i) => [n.id, i] as const));
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));

  for (const edge of definition.edges) {
    if (!indexOf.has(edge.source) || !indexOf.has(edge.target)) continue;
    adj.get(edge.source)!.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  // Ready set ordered by declaration index for determinism.
  const ready: string[] = nodes
    .filter((n) => (indegree.get(n.id) ?? 0) === 0)
    .map((n) => n.id);
  ready.sort((a, b) => (indexOf.get(a)! - indexOf.get(b)!));

  const result: WorkflowNodeDefinition[] = [];
  const byId = indexNodes(definition);

  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(byId.get(id)!);
    const next = adj.get(id) ?? [];
    // Process successors in declaration order.
    const newlyReady: string[] = [];
    for (const target of next) {
      const d = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, d);
      if (d === 0) newlyReady.push(target);
    }
    newlyReady.sort((a, b) => (indexOf.get(a)! - indexOf.get(b)!));
    ready.unshift(...newlyReady);
    // Re-sort the whole ready frontier to keep global determinism.
    ready.sort((a, b) => (indexOf.get(a)! - indexOf.get(b)!));
  }

  if (result.length !== nodes.length) return null; // cycle
  return result;
}

/** Topological order or throw — used by the runner after validation. */
export function executionOrder(definition: WorkflowDefinition): WorkflowNodeDefinition[] {
  const order = tryTopoSort(definition);
  if (!order) {
    throw new Error(`Cannot compute execution order: workflow "${definition.id}" has a cycle`);
  }
  return order;
}
