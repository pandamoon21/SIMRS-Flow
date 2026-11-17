/**
 * Declared outcomes — what a node's executor can conclude and touch, written
 * down as data next to the domain, and the rule catalog built from it.
 *
 * A domain package declares, per node, the `StepResult` statuses and summary
 * templates its executor can return, the issue codes and detail findings it
 * reports, the writes it can plan and the endpoints it reads. The rule catalog
 * the Rules page renders is those declarations plus endpoint metadata
 * ({@link buildRuleCatalog}); nothing scrapes executor source.
 *
 * Declarations are kept honest at runtime: {@link recordStepResults} wraps an
 * executor registry and hands every returned `StepResult` to a sink, and
 * {@link undeclaredOutcomes} lists the ones no declaration covers. Each domain
 * test suite records all of its fixture runs and fails on any undeclared
 * outcome, so dropping a declaration or adding an undeclared summary is a
 * test failure, not a silently stale catalog.
 *
 * Templates: `…` stands for a value filled in at runtime and matches any text
 * (including none). Whitespace runs compare as one space.
 */

import type {
  ExecutorRegistry,
  RuleCatalog,
  RuleCatalogEndpoint,
  RuleCatalogEntry,
  StepResult,
  WorkflowDefinition,
} from './types.js';

/** One node's declared outcomes: a {@link RuleCatalogEntry} minus its identity; empty lists may be left out. */
export interface DeclaredOutcomes {
  outcomes: RuleCatalogEntry['outcomes'];
  issues?: RuleCatalogEntry['issues'];
  findings?: RuleCatalogEntry['findings'];
  actions?: RuleCatalogEntry['actions'];
  reads?: RuleCatalogEntry['reads'];
  writes?: RuleCatalogEntry['writes'];
}

/** Declarations for every node of one workflow, keyed by node id. */
export type OutcomeDeclarations = Readonly<Record<string, DeclaredOutcomes>>;

/** The endpoint registry fields the catalog copies (structural, so no client import). */
export type EndpointLookup = Readonly<Record<string, Pick<RuleCatalogEndpoint, 'kind' | 'riskLevel' | 'description'>>>;

/**
 * The rule catalog of `workflow`, entries in node order. Throws when a node has
 * no declaration, a declaration names no node, or a declared endpoint is
 * unknown or on the wrong side (a write that is not a mutation, a read that is).
 */
export function buildRuleCatalog(
  workflow: WorkflowDefinition,
  declarations: OutcomeDeclarations,
  endpoints: EndpointLookup,
): RuleCatalog {
  const nodeIds = new Set(workflow.nodes.map((n) => n.id));
  const stray = Object.keys(declarations).filter((id) => !nodeIds.has(id));
  if (stray.length) throw new Error(`${workflow.id}: outcomes declared for unknown node(s) ${stray.join(', ')}`);

  const used = new Set<string>();
  const entries = workflow.nodes.map((node): RuleCatalogEntry => {
    const d = declarations[node.id];
    if (!d) throw new Error(`${workflow.id}: node ${node.id} declares no outcomes`);
    const reads = [...(d.reads ?? [])].sort();
    const writes = [...(d.writes ?? [])].sort();
    for (const id of reads) {
      const kind = endpoints[id]?.kind;
      if (!kind || kind === 'mutate') throw new Error(`${node.id}: declared read ${id} is ${kind ?? 'not a known endpoint'}`);
      used.add(id);
    }
    for (const id of writes) {
      if (endpoints[id]?.kind !== 'mutate') throw new Error(`${node.id}: declared write ${id} is not a mutating endpoint`);
      used.add(id);
    }
    for (const a of d.actions ?? []) {
      if (!writes.includes(a.endpointId)) throw new Error(`${node.id}: action on ${a.endpointId} is not a declared write`);
    }
    return {
      nodeId: node.id,
      executorRef: node.executorRef,
      outcomes: d.outcomes,
      issues: d.issues ?? [],
      findings: d.findings ?? [],
      actions: d.actions ?? [],
      reads,
      writes,
    };
  });

  const catalogEndpoints: Record<string, RuleCatalogEndpoint> = {};
  for (const id of [...used].sort()) {
    const def = endpoints[id]!;
    catalogEndpoints[id] = { id, kind: def.kind, riskLevel: def.riskLevel, description: def.description };
  }
  return { workflowId: workflow.id, entries, endpoints: catalogEndpoints };
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
const templateCache = new Map<string, RegExp>();

/** Whether `text` is an instance of `template` (`…` = any runtime value). */
export function matchesTemplate(template: string, text: string): boolean {
  let re = templateCache.get(template);
  if (!re) {
    const body = collapse(template)
      .split('…')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[\\s\\S]*?');
    re = new RegExp(`^${body}$`);
    templateCache.set(template, re);
  }
  return re.test(collapse(text));
}

/** One `StepResult` an executor returned, tagged with its node. */
export interface RecordedStepResult {
  nodeId: string;
  result: StepResult;
}

/**
 * `registry` with every executor wrapped so each returned `StepResult` is also
 * handed to `sink` under its node id (resolved through `workflow`). Behaviour
 * is otherwise untouched: the same result object is returned, throws pass through.
 */
export function recordStepResults(
  workflow: WorkflowDefinition,
  registry: ExecutorRegistry,
  sink: (record: RecordedStepResult) => void,
): ExecutorRegistry {
  const nodeOf = new Map(workflow.nodes.map((n) => [n.executorRef, n.id]));
  return Object.fromEntries(
    Object.entries(registry).map(([ref, executor]) => [
      ref,
      async (ctx) => {
        const result = await executor(ctx);
        sink({ nodeId: nodeOf.get(ref) ?? ref, result });
        return result;
      },
    ]),
  );
}

/** A recorded result some part of which no declaration covers. */
export interface UndeclaredOutcome {
  nodeId: string;
  kind: 'outcome' | 'issue' | 'write';
  /** `status: summary`, the issue code, or the planned endpoint id. */
  value: string;
}

/**
 * Every recorded status/summary, issue code and planned write that the node's
 * declaration does not cover, deduplicated. Empty means the declarations are
 * runtime truth for everything the recorded runs exercised.
 */
export function undeclaredOutcomes(
  declarations: OutcomeDeclarations,
  records: Iterable<RecordedStepResult>,
): UndeclaredOutcome[] {
  const found = new Map<string, UndeclaredOutcome>();
  const add = (u: UndeclaredOutcome) => found.set(`${u.nodeId}|${u.kind}|${u.value}`, u);
  for (const { nodeId, result } of records) {
    const d = declarations[nodeId];
    const declared = d?.outcomes ?? [];
    if (!declared.some((o) => o.status === result.status && matchesTemplate(o.text, result.summary))) {
      add({ nodeId, kind: 'outcome', value: `${result.status}: ${collapse(result.summary)}` });
    }
    const codes = new Set((d?.issues ?? []).map((i) => i.code));
    for (const issue of [...(result.issues ?? []), ...(result.warnings ?? [])]) {
      if (!codes.has(issue.code)) add({ nodeId, kind: 'issue', value: issue.code });
    }
    const writes = new Set(d?.writes ?? []);
    for (const plan of result.proposedMutations ?? []) {
      if (!writes.has(plan.endpointId)) add({ nodeId, kind: 'write', value: plan.endpointId });
    }
  }
  return [...found.values()];
}
