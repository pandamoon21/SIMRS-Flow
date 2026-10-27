/**
 * Decision trail: why a step ended the way it did, and where the run goes next.
 *
 * Items come, in order, from (1) the step's own reasoning checklist when its
 * executor attached one, (2) every write it planned — shown as "direncanakan"
 * and flipped to ✓/✗ by the plan's real outcome — and (3) its errors and
 * warnings. Nothing is inferred beyond what the step reported, so the trail can
 * be incomplete but never claims a check the step did not make.
 */
import { reasoningOf, type MutationOutcome, type NodeRuntimeState, type RunState, type WorkflowDefinition } from '@simrs-flow/workflow-core';

export type TrailMark = 'ok' | 'fail' | 'warn' | 'plan' | 'info';

export interface TrailItem {
  mark: TrailMark;
  text: string;
  detail?: string;
}

export interface DecisionTrail {
  title?: string;
  items: TrailItem[];
}

const PLAN_DONE = new Set(['verified']);
const PLAN_BAD = new Set(['failed', 'invalidated']);

function planMark(outcome: MutationOutcome | undefined): { mark: TrailMark; note: string } {
  if (outcome && PLAN_DONE.has(outcome.status)) return { mark: 'ok', note: 'selesai & terverifikasi' };
  if (outcome && PLAN_BAD.has(outcome.status)) return { mark: 'fail', note: outcome.status === 'failed' ? 'write gagal' : 'dibatalkan (precondition berubah)' };
  if (outcome?.status === 'applied') return { mark: 'plan', note: 'ditulis, menunggu verifikasi' };
  if (outcome?.status === 'approved') return { mark: 'plan', note: 'disetujui, menunggu eksekusi' };
  return { mark: 'plan', note: 'direncanakan' };
}

export function decisionTrailOf(node: NodeRuntimeState | undefined, mutations: RunState['mutations'] = {}): DecisionTrail {
  if (!node) return { items: [] };
  const items: TrailItem[] = [];
  const reasoning = reasoningOf(node.evidence);
  const referenced = new Set<string>();
  for (const item of reasoning?.items ?? []) {
    if (item.planId) {
      referenced.add(item.planId);
      const outcome = mutations[item.planId];
      // A ✗ the step is fixing reads as "being fixed", then ✓ once the write is verified.
      if (outcome && PLAN_DONE.has(outcome.status)) {
        items.push({ mark: 'ok', text: item.label, detail: 'diperbaiki & terverifikasi' });
        continue;
      }
      const { mark, note } = planMark(outcome);
      items.push({ mark: mark === 'fail' ? 'fail' : item.ok === false ? 'plan' : mark, text: item.label, detail: item.detail ? `${item.detail} · ${note}` : note });
      continue;
    }
    items.push({ mark: item.ok === true ? 'ok' : item.ok === false ? 'fail' : 'info', text: item.label, ...(item.detail ? { detail: item.detail } : {}) });
  }
  for (const plan of node.proposedMutations) {
    if (referenced.has(plan.id)) continue;
    const { mark, note } = planMark(mutations[plan.id]);
    // The executor's "sekarang → seharusnya" line, when it recorded one.
    const change = (plan.payloadSummary as Record<string, unknown> | undefined)?.perubahan;
    items.push({ mark, text: plan.reason || plan.endpointId, detail: typeof change === 'string' && change ? `${change} · ${note}` : note });
  }
  for (const issue of node.issues) {
    if (issue.severity === 'info') continue;
    items.push({ mark: issue.severity === 'error' ? 'fail' : 'warn', text: issue.message });
  }
  for (const warning of node.warnings) items.push({ mark: 'warn', text: warning.message });
  return { ...(reasoning?.title ? { title: reasoning.title } : {}), items };
}

export interface NextStep {
  /** Steps the run continued into from this one. */
  go: string[];
  /** Steps that were reachable from here but did not run. */
  stop: string[];
}

/** Where the run went after this step, read from the real edge outcomes. */
export function nextStepOf(definition: WorkflowDefinition | undefined, state: RunState | undefined, nodeId: string): NextStep | undefined {
  const node = state?.nodes[nodeId];
  if (!definition || !node || ['pending', 'queued', 'running', 'retrying'].includes(node.status)) return undefined;
  const labelOf = (id: string) => definition.nodes.find((n) => n.id === id)?.label ?? id;
  const go: string[] = [];
  const stop: string[] = [];
  for (const edge of definition.edges.filter((e) => e.source === nodeId)) {
    const status = state.edges[edge.id]?.status;
    const target = state.nodes[edge.target];
    const name = edge.label ? `${labelOf(edge.target)} (${edge.label})` : labelOf(edge.target);
    // Only the edge's own outcome counts: a target with several inputs may have run via another one.
    if (status === 'completed' || status === 'active') go.push(name);
    else if (status === 'skipped' || status === 'failed' || target?.status === 'skipped') stop.push(name);
  }
  return go.length || stop.length ? { go, stop } : undefined;
}
