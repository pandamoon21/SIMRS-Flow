/**
 * Run as a terminal log ("Log saja" mode, docs/run-log-mode-plan.md).
 *
 * Pure projection of `RunState` + definition into the rows the log view draws,
 * top to bottom: per step a divider `── [x/y] Nama ──`, the step's own log lines
 * **untouched** (the legacy format aligns its colons inside the text, so nothing
 * is ever prepended), its decisions (gate / planned writes), and an end line
 * `✓ [x/y] Nama · 1.8s`. A step that was skipped without logging is one row.
 * The run closes with a footer once it is terminal.
 *
 * Steps appear in the order they started (the runner walks the graph one step
 * at a time); a step that has not started yet is not in the log. Run-level
 * lines (no node) sit where their seq falls between the step blocks.
 */
import { reasoningOf, type MutationOutcome, type NodeStatus, type ReasoningItem, type RunLogEntry, type RunState, type WorkflowDefinition } from '@simrs-flow/workflow-core';
import { rankSteps } from '../canvas/flexLayout.js';
import { logTime } from './logView.js';
import { durationLabel, PREVIEW_GATE_LABEL, previewGateStopOf, runOutcomeOf } from '../run/runStatus.js';

export const END_MARK: Partial<Record<NodeStatus, string>> = {
  success: '✓', failed: '✗', blocked: '■', needs_review: '⚠', skipped: '↷', gate_waiting: '⏸', running: '●', retrying: '●', queued: '●',
};
const END_TEXT: Partial<Record<NodeStatus, string>> = {
  failed: 'gagal', blocked: 'berhenti', needs_review: 'perlu ditinjau', skipped: 'dilewati', gate_waiting: 'menunggu keputusan', running: 'berjalan', retrying: 'mengulang', queued: 'antre',
};
const MUTATION_TEXT: Record<MutationOutcome['status'], string> = {
  planned: 'direncanakan', approved: 'disetujui, menunggu eksekusi', applied: 'ditulis, menunggu verifikasi', verified: 'terverifikasi', failed: 'gagal', invalidated: 'dibatalkan (precondition berubah)',
};
export const AUTO_APPROVER = 'auto-approve';

export interface StepRef { nodeId: string; index: number; total: number; label: string }

/** A decision in the log: open (buttons) or settled (one fixed line). */
export type LogDecision =
  | { type: 'gate'; nodeId: string; open: true }
  | { type: 'mutation'; nodeId: string; planId: string; open: true; text: string; riskLevel?: string; endpointId: string }
  | { type: 'gate' | 'mutation'; nodeId: string; open: false; tone: 'ok' | 'fail' | 'info'; auto: boolean; text: string };

export type TermRow =
  | ({ kind: 'divider'; key: string; time: string; continued: boolean } & StepRef)
  | { kind: 'line'; key: string; entry: RunLogEntry }
  | ({ kind: 'end'; key: string; time: string; status: NodeStatus; mark: string; note: string } & StepRef)
  | ({ kind: 'skip'; key: string } & StepRef)
  | { kind: 'decision'; key: string; decision: LogDecision }
  /** One item of the step's checklist (per kunjungan / pasien in rajal); `title` on the first. */
  | { kind: 'check'; key: string; nodeId: string; item: ReasoningItem; title?: string }
  | { kind: 'footer'; key: string; status: RunState['status']; previewDone?: boolean; done: number; total: number; problems: number; duration: string };

const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled']);
const FOOTER_TEXT: Record<string, string> = { completed: 'SELESAI', failed: 'GAGAL', cancelled: 'DIBATALKAN' };
export const footerText = (row: Extract<TermRow, { kind: 'footer' }>) =>
  `════ ${row.previewDone ? PREVIEW_GATE_LABEL.toUpperCase() : FOOTER_TEXT[row.status] ?? row.status.toUpperCase()} · ${row.done}/${row.total} tahap · ${row.problems} masalah · ${row.duration} ════`;

/** `[x/y]` order: topological rank, definition order within a rank. */
export function stepOrder(definition: WorkflowDefinition): Map<string, number> {
  const rank = rankSteps(definition);
  const ordered = definition.nodes.map((node, i) => ({ id: node.id, rank: rank.get(node.id) ?? 0, i })).sort((a, b) => a.rank - b.rank || a.i - b.i);
  return new Map(ordered.map((node, i) => [node.id, i + 1]));
}

function durationOf(node: RunState['nodes'][string]): string | undefined {
  const ms = node.durationMs ?? (node.startedAt && node.finishedAt ? Date.parse(node.finishedAt) - Date.parse(node.startedAt) : undefined);
  return ms === undefined || !Number.isFinite(ms) ? undefined : durationLabel(ms);
}

const AUTO_REASON = /autoApprove|auto-approve/i;

/**
 * An auto-approving run approves every plan through one sweep, but a
 * non-critical plan records only the operator as approver, and a failure later
 * replaces the plan's reason. So the run as a whole is the evidence: any gate or
 * plan that says it was auto-approved marks all of the run's approvals as such.
 */
export function runAutoApproves(state: RunState): boolean {
  return Object.values(state.gates).some((gate) => AUTO_REASON.test(gate.reason ?? ''))
    || Object.values(state.mutations).some((m) => m.approvedBy?.includes(AUTO_APPROVER) || AUTO_REASON.test(m.reason ?? ''));
}

function decisionsOf(nodeId: string, state: RunState, autoRun: boolean): LogDecision[] {
  const out: LogDecision[] = [];
  const gate = state.gates[nodeId];
  if (gate?.status === 'waiting') out.push({ type: 'gate', nodeId, open: true });
  else if (gate) {
    const auto = AUTO_REASON.test(gate.reason ?? '');
    out.push(gate.status === 'approved'
      ? { type: 'gate', nodeId, open: false, tone: 'ok', auto, text: auto ? 'Disetujui otomatis (auto-approve)' : `Disetujui${gate.reason ? ` — ${gate.reason}` : ''}` }
      : { type: 'gate', nodeId, open: false, tone: 'fail', auto: false, text: `${gate.status === 'expired' ? 'Kedaluwarsa' : 'Ditolak'}${gate.reason ? ` — ${gate.reason}` : ''}` });
  }
  for (const plan of state.nodes[nodeId]?.proposedMutations ?? []) {
    const outcome = state.mutations[plan.id];
    const status = outcome?.status ?? 'planned';
    // The executor's "sekarang → seharusnya" line (payloadSummary.perubahan) says what the write changes.
    const change = (plan.payloadSummary as Record<string, unknown> | undefined)?.perubahan;
    const what = `${plan.reason || plan.endpointId}${typeof change === 'string' && change && !(plan.reason ?? '').includes(change) ? ` (${change})` : ''}`;
    if (status === 'planned') {
      // The orchestrator applies plans only while the run is live (409 run_not_active after).
      const ended = state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled';
      if (state.mode === 'write' && plan.requiresApproval && ended) {
        out.push({ type: 'mutation', nodeId, open: false, tone: 'info', auto: false, text: `Rencana: ${what} · tidak diterapkan — run sudah berakhir` });
      } else if (state.mode === 'write' && plan.requiresApproval) {
        out.push({ type: 'mutation', nodeId, planId: plan.id, open: true, text: what, endpointId: plan.endpointId, ...(plan.riskLevel ? { riskLevel: plan.riskLevel } : {}) });
      } else {
        out.push({ type: 'mutation', nodeId, open: false, tone: 'info', auto: false, text: `Rencana: ${what} · ${state.mode === 'preview' ? 'preview, tidak ditulis' : 'direncanakan'}` });
      }
      continue;
    }
    const by = (outcome?.approvedBy ?? []).filter((op) => op !== AUTO_APPROVER);
    const auto = autoRun || Boolean(outcome?.approvedBy?.includes(AUTO_APPROVER));
    const who = auto ? 'Disetujui otomatis (auto-approve)' : by.length ? `Disetujui oleh ${by.join(', ')}` : 'Disetujui';
    const bad = status === 'failed' || status === 'invalidated';
    out.push({ type: 'mutation', nodeId, open: false, tone: bad ? 'fail' : 'ok', auto, text: `${who} · ${what} · ${MUTATION_TEXT[status]}${outcome?.reason && bad ? ` — ${outcome.reason}` : ''}` });
  }
  return out;
}

export interface TerminalOptions {
  /** Add each step's checklist after its lines — the per-patient breakdown an aggregate log lacks. */
  checks?: boolean;
  /** Summarise every multi-item checklist (count + problems), not only the long ones: the quiet view of a batch. */
  summary?: boolean;
}

export function terminalRows(definition: WorkflowDefinition, state: RunState | undefined, options: TerminalOptions = {}): TermRow[] {
  if (!state) return [];
  const order = stepOrder(definition);
  const total = definition.nodes.length;
  const labelOf = new Map(definition.nodes.map((node) => [node.id, node.label]));
  const ref = (nodeId: string): StepRef => ({ nodeId, index: order.get(nodeId) ?? 0, total, label: labelOf.get(nodeId) ?? nodeId });

  const logsOf = new Map<string, RunLogEntry[]>();
  const runLines: RunLogEntry[] = [];
  for (const entry of state.logs) {
    if (entry.nodeId && labelOf.has(entry.nodeId)) (logsOf.get(entry.nodeId) ?? logsOf.set(entry.nodeId, []).get(entry.nodeId)!).push(entry);
    else runLines.push(entry);
  }
  // Steps that have started (or logged), in the order they did.
  const started = definition.nodes
    .map((node) => state.nodes[node.id])
    .filter((node): node is RunState['nodes'][string] => Boolean(node) && (node!.status !== 'pending' || logsOf.has(node!.id)))
    .map((node) => ({ node, at: logsOf.get(node.id)?.[0]?.seq, ts: node.startedAt ?? logsOf.get(node.id)?.[0]?.ts ?? '' }))
    .sort((a, b) => (a.ts && b.ts && a.ts !== b.ts ? a.ts.localeCompare(b.ts) : (order.get(a.node.id) ?? 0) - (order.get(b.node.id) ?? 0)));

  const rows: TermRow[] = [];
  const autoRun = runAutoApproves(state);
  let runIndex = 0;
  const flushRunLines = (beforeSeq: number) => {
    while (runIndex < runLines.length && runLines[runIndex]!.seq < beforeSeq) {
      const entry = runLines[runIndex++]!;
      rows.push({ kind: 'line', key: `l${entry.seq}`, entry });
    }
  };
  for (const { node, at } of started) {
    if (at !== undefined) flushRunLines(at);
    const step = ref(node.id);
    const logs = logsOf.get(node.id) ?? [];
    if (node.status === 'skipped' && logs.length === 0) {
      rows.push({ kind: 'skip', key: `s:${node.id}`, ...step });
      continue;
    }
    rows.push({ kind: 'divider', key: `d:${node.id}`, time: logTime(node.startedAt ?? logs[0]?.ts ?? ''), continued: false, ...step });
    let previousSeq = logs[0]?.seq;
    for (const entry of logs) {
      // Another step's or the run's lines came in between: re-open this step's block.
      if (previousSeq !== undefined && runLines.some((line) => line.seq > previousSeq! && line.seq < entry.seq)) {
        flushRunLines(entry.seq);
        rows.push({ kind: 'divider', key: `d:${node.id}:${entry.seq}`, time: logTime(entry.ts), continued: true, ...step });
      }
      rows.push({ kind: 'line', key: `l${entry.seq}`, entry });
      previousSeq = entry.seq;
    }
    if (options.checks) rows.push(...checkRows(node.id, reasoningOf(node.evidence), options.summary, state?.mutations));
    for (const [i, decision] of decisionsOf(node.id, state, autoRun).entries()) rows.push({ kind: 'decision', key: `x:${node.id}:${i}`, decision });
    const duration = durationOf(node);
    const settled = !['running', 'retrying', 'queued', 'gate_waiting'].includes(node.status);
    rows.push({
      kind: 'end',
      key: `e:${node.id}`,
      time: logTime(node.finishedAt ?? node.startedAt ?? ''),
      status: node.status,
      mark: END_MARK[node.status] ?? '•',
      note: [END_TEXT[node.status], settled ? duration : undefined].filter(Boolean).join(' · '),
      ...step,
    });
  }
  flushRunLines(Number.POSITIVE_INFINITY);
  if (TERMINAL_RUN.has(state.status)) {
    const outcome = runOutcomeOf(state);
    // A preview held at its gate is the expected end, not a failure: same words as the status badge.
    rows.push({ kind: 'footer', key: 'footer', status: state.status, ...(previewGateStopOf(state) ? { previewDone: true } : {}), done: outcome.done, total: outcome.total, problems: outcome.problems, duration: durationLabel(outcome.durationMs) });
  }
  return rows;
}

/** Decisions still waiting for an operator, in log order. */
export function openDecisions(rows: readonly TermRow[]): Array<Extract<TermRow, { kind: 'decision' }>> {
  return rows.filter((row): row is Extract<TermRow, { kind: 'decision' }> => row.kind === 'decision' && row.decision.open);
}

/** Plain text of a row, for search and copy. */
export function rowText(row: TermRow): string {
  switch (row.kind) {
    case 'divider': return `${row.time} ── [${row.index}/${row.total}] ${row.label}${row.continued ? ' (lanjutan)' : ''}`;
    case 'line': return row.entry.message;
    case 'end': return `${row.time} ${row.mark} [${row.index}/${row.total}] ${row.label}${row.note ? ` · ${row.note}` : ''}`;
    case 'skip': return `↷ [${row.index}/${row.total}] ${row.label} · dilewati`;
    case 'decision': return row.decision.open ? (row.decision.type === 'gate' ? 'Menunggu keputusan gate' : `Menunggu persetujuan: ${row.decision.text}`) : row.decision.text;
    case 'footer': return footerText(row);
    case 'check': return `${checkMark(row.item)} ${row.item.label}${row.item.detail ? ` — ${row.item.detail}` : ''}`;
  }
}

export const checkMark = (item: ReasoningItem) => (item.ok === true ? '✓' : item.ok === false ? (item.planId ? '→' : '✗') : '•');

/**
 * Rows folded into one block per step (divider → its lines, checks, decisions
 * → its end row), so each step reads as a unit. Run-level lines, skipped steps
 * and the footer stay loose. A line that only repeats the step's name or the
 * line right above it (start message, summary logged twice) is dropped here,
 * not in {@link terminalRows}, which keeps every message.
 */
export interface LogBlock {
  key: string;
  head?: Extract<TermRow, { kind: 'divider' }>;
  end?: Extract<TermRow, { kind: 'end' }>;
  rows: TermRow[];
}

export function stepBlocks(rows: readonly TermRow[]): LogBlock[] {
  const blocks: LogBlock[] = [];
  let open: LogBlock | undefined;
  for (const row of rows) {
    if (row.kind === 'divider') {
      open = { key: row.key, head: row, rows: [] };
      blocks.push(open);
      continue;
    }
    const nodeId = row.kind === 'line' ? row.entry.nodeId : row.kind === 'decision' ? row.decision.nodeId : 'nodeId' in row ? row.nodeId : undefined;
    if (open?.head && nodeId === open.head.nodeId && row.kind !== 'skip') {
      if (row.kind === 'end') {
        open.end = row;
        open = undefined;
        continue;
      }
      if (row.kind === 'line') {
        const text = row.entry.message.trim();
        const previous = open.rows.at(-1);
        if (text === open.head.label || (previous?.kind === 'line' && previous.entry.message.trim() === text)) continue;
      }
      open.rows.push(row);
      continue;
    }
    open = undefined;
    blocks.push({ key: `b:${row.key}`, rows: [row] });
  }
  return blocks;
}

/** Above this many items a step's checklist is summarised: problems listed (capped), the rest counted. */
export const CHECK_LIST_LIMIT = 8;
const CHECK_PROBLEM_CAP = 25;

/**
 * A step's checklist as rows. A 500-patient batch would otherwise print 500
 * lines per step; so past {@link CHECK_LIST_LIMIT} only the ✗ items are listed
 * (up to a cap) and the ✓ / • / → ones collapse into one count row. Each
 * patient's full trail lives in the per-patient view.
 */
/**
 * A checklist ✗ that a write is fixing reads by that write's real outcome: once
 * verified it is ✓ (as on the canvas), a failed/refused write is a plain ✗.
 * Without this a paid patient's Tampung Bayar line stayed red in the log.
 */
export function resolvePlanItem(item: ReasoningItem, mutations: Record<string, MutationOutcome> = {}): ReasoningItem {
  if (!item.planId) return item;
  const status = mutations[item.planId]?.status;
  const note = (text: string) => (item.detail ? `${item.detail} · ${text}` : text);
  if (status === 'verified') return { ...item, ok: true, detail: note('terverifikasi') };
  if (status === 'failed' || status === 'invalidated') {
    const { planId: _planId, ...rest } = item;
    return { ...rest, ok: false, detail: note(status === 'failed' ? 'write gagal' : 'dibatalkan (syarat berubah)') };
  }
  return item;
}

function checkRows(nodeId: string, reasoning: ReturnType<typeof reasoningOf>, summary = false, mutations: Record<string, MutationOutcome> = {}): TermRow[] {
  const items = (reasoning?.items ?? []).map((item) => resolvePlanItem(item, mutations));
  const title = reasoning?.title;
  const row = (item: ReasoningItem, i: number | string, first: boolean): TermRow => ({ kind: 'check', key: `c:${nodeId}:${i}`, nodeId, item, ...(first && title ? { title } : {}) });
  if (items.length <= (summary ? 1 : CHECK_LIST_LIMIT)) return items.map((item, i) => row(item, i, i === 0));
  const problems = items.filter((item) => item.ok === false && !item.planId);
  const shown = problems.slice(0, CHECK_PROBLEM_CAP);
  const count = (pred: (item: ReasoningItem) => boolean) => items.filter(pred).length;
  const ok = count((item) => item.ok === true);
  const info = count((item) => item.ok === null);
  const planned = count((item) => item.ok === false && Boolean(item.planId));
  const rest = problems.length - shown.length;
  const tally: ReasoningItem = {
    label: [problems.length ? `${problems.length} bermasalah` : '', ok ? `${ok} lolos` : '', planned ? `${planned} direncanakan write` : '', info ? `${info} info` : ''].filter(Boolean).join(' · ') || `${items.length} item`,
    ok: problems.length ? false : ok ? true : null,
    detail: `${items.length} item${rest > 0 ? `, ${shown.length} bermasalah pertama di bawah` : ''} — rincian lengkap di tampilan Per pasien`,
  };
  return [row(tally, 'sum', true), ...shown.map((item, i) => row(item, `p${i}`, false))];
}

export type PatientStatus = 'dilewati' | 'lolos' | 'proses';
export const PATIENT_STATUS_LABEL: Record<PatientStatus, string> = { dilewati: 'Dilewati', lolos: 'Lolos', proses: 'Diproses' };

export interface TrailItem extends StepRef { item: ReasoningItem }
export interface PatientTrail {
  rm: string;
  /** Every checklist item about this patient, in step order. */
  trail: TrailItem[];
  status: PatientStatus;
  /** Why: the first ✗ (the step that dropped them, or a note), its detail. */
  reason: string;
  /**
   * The step that matters: dilewati → where they were first ✗ (not the batch
   * summary that repeats it); diproses → where they are now; lolos → the note's step, if any.
   */
  step: string;
  /** ✗ items that did not drop the patient (e.g. a berkas notice). */
  notes: number;
  /** Items the step resolved by planning a write. */
  writes: number;
}

/**
 * One row per patient from the checklist items tagged with `subject`.
 *
 * A step drops a patient by listing them ✗ and leaving them out of every later
 * step, and the batch summary (last step) gives each a final verdict; so the
 * patient's **last** item decides: ✗ = dilewati, ✓ = lolos once the run has
 * ended (• at the end = dilewati: no verdict was reached), else in progress. An earlier ✗ followed by later ✓ items is a
 * notice that did not stop the patient.
 */
export function patientTrails(definition: WorkflowDefinition, state: RunState | undefined): PatientTrail[] {
  if (!state) return [];
  const order = stepOrder(definition);
  const total = definition.nodes.length;
  const byRm = new Map<string, TrailItem[]>();
  const nodes = [...definition.nodes].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  for (const node of nodes) {
    const items = (reasoningOf(state.nodes[node.id]?.evidence)?.items ?? []).map((item) => resolvePlanItem(item, state.mutations));
    for (const item of items) {
      if (!item.subject) continue;
      const trail = byRm.get(item.subject) ?? byRm.set(item.subject, []).get(item.subject)!;
      trail.push({ nodeId: node.id, index: order.get(node.id) ?? 0, total, label: node.label, item });
    }
  }
  const ended = TERMINAL_RUN.has(state.status);
  const bad = (t: TrailItem) => t.item.ok === false && !t.item.planId;
  const why = (t: TrailItem) => t.item.detail || t.item.label;
  return [...byRm].map(([rm, trail]) => {
    const last = trail.at(-1)!;
    // Ended on an info item (e.g. "tidak ada kunjungan") = never reached a verdict: not processed.
    const status: PatientStatus = bad(last) || (ended && last.item.ok === null) ? 'dilewati' : ended ? 'lolos' : 'proses';
    const problems = trail.filter(bad);
    const first = problems[0];
    // Only the final summary said ✗ (no visit ever matched): the step is the last • before it.
    const lastInfo = first === last ? trail.slice(0, -1).reverse().find((t) => t.item.ok === null) : undefined;
    const stepItem = status === 'dilewati' ? lastInfo ?? first ?? last : status === 'proses' ? last : first;
    const reasonItem = status === 'dilewati' ? lastInfo ?? first ?? last : first;
    return {
      rm,
      trail,
      status,
      reason: reasonItem ? why(reasonItem) : '',
      step: stepItem?.label ?? '',
      notes: problems.length - (status === 'dilewati' ? 1 : 0),
      writes: trail.filter((t) => t.item.planId).length,
    };
  });
}
