/**
 * Log presentation model for the run console.
 *
 * The executors write the operator log in the shape the ward already reads
 * (see `domain-ranap/src/logic/logFormat.ts`): section headings, `+ ` bullets,
 * and aligned `- label : value` pairs. Two things used to destroy that on
 * screen — every line carried a repeated `[hh:mm:ss] node_id:` prefix, which
 * pushed the aligned columns out of true, and consecutive lines from the same
 * step had nothing tying them together.
 *
 * So the console groups consecutive entries by the step that emitted them and
 * puts the timestamp and step name in a header instead of on every line. The
 * message column is then left untouched, which is what keeps the colons
 * aligned. This module is the pure part of that: grouping and line
 * classification, with no React in sight.
 */

import type { NodeStatus, RunLogEntry, RunState, WorkflowDefinition } from '@simrs-flow/workflow-core';

/** The visual shapes a log line can take, driven by its own indentation. */
export type LogShape = 'heading' | 'bullet' | 'numbered' | 'pair' | 'plain';

/** One run of consecutive entries from the same step. */
export interface LogGroup {
  /** Stable React key — the first entry's seq is unique within a run. */
  key: string;
  nodeId?: string;
  /** Human step name (`Ambil Kunjungan`), falling back to the id, then `Run`. */
  label: string;
  /** The step's group in the workflow layout, e.g. `Kamar`. */
  section?: string;
  status?: NodeStatus;
  /** `hh:mm:ss` of the first entry. */
  time: string;
  entries: RunLogEntry[];
  /** Worst severity in the group — drives the header accent. */
  severity: RunLogEntry['severity'];
}

const SEVERITY_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Classify a line by its own leading characters.
 *
 * Order matters: a pair line is also indented, so the indented shapes are
 * tested before the catch-all heading rule.
 */
export function classifyLogLine(message: string): LogShape {
  if (/^\s*-\s.+\s:\s/.test(message)) return 'pair';
  if (/^\s*\+\s/.test(message)) return 'bullet';
  if (/^\s+\d+\.\s/.test(message)) return 'numbered';
  if (/^\S/.test(message)) return 'heading';
  return 'plain';
}

/** `2026-06-10T11:42:38.000Z` → `11:42:38`. */
export function logTime(ts: string): string {
  return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

function worseOf(a: RunLogEntry['severity'], b: RunLogEntry['severity']): RunLogEntry['severity'] {
  return (SEVERITY_RANK[b] ?? 1) > (SEVERITY_RANK[a] ?? 1) ? b : a;
}

/**
 * Fold a flat log into per-step groups, preserving order.
 *
 * A group breaks when the emitting node changes, so a step that logs twice with
 * another step's output in between correctly shows as two groups.
 */
export function groupLogs(
  logs: readonly RunLogEntry[],
  definition?: WorkflowDefinition,
  nodes?: RunState['nodes'],
): LogGroup[] {
  const labels = new Map<string, { label: string; section?: string }>();
  if (definition) {
    const sections = new Map((definition.layout?.groups ?? []).map((group) => [group.id, group.label]));
    for (const node of definition.nodes) {
      const section = sections.get(node.group);
      labels.set(node.id, { label: node.label, ...(section ? { section } : {}) });
    }
  }

  const groups: LogGroup[] = [];
  for (const entry of logs) {
    const last = groups[groups.length - 1];
    if (last && last.nodeId === entry.nodeId) {
      last.entries.push(entry);
      last.severity = worseOf(last.severity, entry.severity);
      continue;
    }
    const meta = entry.nodeId ? labels.get(entry.nodeId) : undefined;
    const status = entry.nodeId ? nodes?.[entry.nodeId]?.status : undefined;
    groups.push({
      key: String(entry.seq),
      ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
      label: meta?.label ?? entry.nodeId ?? 'Run',
      ...(meta?.section ? { section: meta.section } : {}),
      ...(status ? { status } : {}),
      time: logTime(entry.ts),
      entries: [entry],
      severity: entry.severity,
    });
  }
  return groups;
}

/** Status keys in pipeline order, so the summary row never reshuffles itself. */
export const STATUS_ORDER: readonly NodeStatus[] = [
  'running',
  'retrying',
  'gate_waiting',
  'success',
  'needs_review',
  'skipped',
  'blocked',
  'failed',
  'queued',
  'pending',
];

/** Count nodes by status, in {@link STATUS_ORDER}, dropping the empty buckets. */
export function statusCounts(nodes: RunState['nodes'] | undefined): Array<{ status: NodeStatus; count: number }> {
  if (!nodes) return [];
  const counts = new Map<NodeStatus, number>();
  for (const node of Object.values(nodes)) {
    counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  }
  return STATUS_ORDER.filter((status) => (counts.get(status) ?? 0) > 0).map((status) => ({
    status,
    count: counts.get(status) ?? 0,
  }));
}

/** How many steps have reached a terminal state, for the `18/31` progress read-out. */
export function stepProgress(nodes: RunState['nodes'] | undefined): { done: number; total: number } {
  const all = Object.values(nodes ?? {});
  const settled: NodeStatus[] = ['success', 'needs_review', 'skipped', 'blocked', 'failed'];
  return { done: all.filter((node) => settled.includes(node.status)).length, total: all.length };
}

/** Case-insensitive; dashes ignored so a No. RM matches with or without them (0-90-00-09 = 0900009). */
export function logMatches(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const t = text.toLowerCase();
  return t.includes(q) || t.replace(/-/g, '').includes(q.replace(/-/g, ''));
}
