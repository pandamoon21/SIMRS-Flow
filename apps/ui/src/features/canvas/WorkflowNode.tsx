/**
 * WorkflowNode — a single React Flow node card.
 *
 * It is the run's primary reading surface: status, a two-line summary, the
 * highest-priority issue, plan progress, duration and risk. Everything the
 * operator needs for routine monitoring is here; the inspector stays closed
 * until evidence or an approval decision is required, so the canvas keeps its
 * width. The card never computes status itself — all state arrives from the
 * canvas, which reads it from the run store.
 */

import { memo, useEffect, useRef } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import type { NodeKind, NodeStatus, RiskLevel, WorkflowIssue } from '@simrs-flow/workflow-core';
import {
  formatRajalClinicCounts,
  formatRajalQueueWaiting,
  type RajalClinicCounts,
} from './rajalPresentation.js';
import { NODE_STATUS_LABEL } from '../run/runStatus.js';
import { pulse, type PulseTone } from '../../ui/motion.js';
import type { DecisionTrail, NextStep, TrailMark } from './decisionTrail.js';
import type { FlexMark } from './flexLayout.js';
import { FlowHandles } from './FlexNode.js';

export const TRAIL_MARK: Record<TrailMark, string> = { ok: '✓', fail: '✗', warn: '!', plan: '→', info: '•' };
const REASON_MARK: Record<FlexMark, string> = { ...TRAIL_MARK, rule: '◇' };
/** Reasons shown on a fixed-view card; the inspector shows the full trail. */
export const CARD_REASONS = 3;

export interface CardReason { mark: FlexMark; text: string; detail?: string }

const PULSE_TONE: Partial<Record<NodeStatus, PulseTone>> = {
  success: 'success', failed: 'danger', blocked: 'danger', gate_waiting: 'warning', needs_review: 'warning',
};

export interface WorkflowNodeData {
  label: string;
  group: string;
  /** Human label of the layout group, when the definition names one. */
  groupLabel: string;
  kind: NodeKind;
  status: NodeStatus;
  riskLevel?: RiskLevel;
  durationMs?: number;
  summary?: string;
  issues?: readonly WorkflowIssue[];
  warnings?: readonly WorkflowIssue[];
  planCount?: number;
  plansPending?: number;
  plansVerified?: number;
  plansFailed?: number;
  /** True on a confirmed-write run, where plan approval is actionable. */
  isWriteRun?: boolean;
  /** One-line purpose from the definition (`ui.description`). */
  description?: string;
  /** MULAI recap, projected from the filter's clinic-count evidence. */
  clinicCounts?: RajalClinicCounts;
  clinicCountsState?: 'waiting' | 'unavailable' | 'ready';
  /** Selected clinic labels, shown while counts are still pending. */
  clinics?: readonly string[];
  /** Queue size already known from typed input or start_batch. */
  queuePatients?: number;
  /** Why the step ended this way (checklist, plans, problems); see decisionTrail.ts. */
  trail?: DecisionTrail;
  /** Where the run went after this step, once it finished. */
  next?: NextStep;
  /** Fixed view: why the step ended this way (its checks, ✗ first), or the rules it decides by. */
  reasons?: readonly CardReason[];
  reasonsHidden?: number;
  reasonsAreRules?: boolean;
  onSelect?: () => void;
  /**
   * Select the node *and* open the inspector. The canvas wires this to the same
   * selection plus the run page's inspector visibility; the card only asks for
   * a review, the inspector keeps the approve/reject buttons.
   */
  onReview?: () => void;
  /** Flexible view: a small label box like the hand-drawn trees; the inspector holds the rest. */
  compact?: boolean;
  /** Compact boxes mount only the two handles their direction uses. */
  vertical?: boolean;
}

export function isNodeActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

const KIND_ICON: Record<NodeKind, string> = {
  input: '⥁',
  read: '↧',
  validate: '✓',
  plan: '✎',
  mutate: '⚡',
  verify: '⤿',
  gate: '⛔',
  summary: '∑',
};

/** Statuses whose card deserves the review affordance. */
const REVIEW_STATUSES: NodeStatus[] = ['needs_review', 'gate_waiting', 'blocked', 'failed'];

/** Only the highest-priority issue belongs on the canvas; remaining detail is in the inspector. */
const MAX_ISSUE_LINES = 1;

function fmtDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Errors first, then warnings: what an operator must read before anything else. */
export function nodeIssueLines(data: WorkflowNodeData): {
  lines: readonly { key: string; text: string; severity: 'error' | 'warn' }[];
  extra: number;
} {
  const prioritized = [
    ...(data.issues ?? []).map((issue) => ({ issue, severity: issue.severity === 'error' ? 'error' : issue.severity })),
    ...(data.warnings ?? []).map((issue) => ({ issue, severity: 'warn' as const })),
  ].sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1));
  const lines = prioritized.slice(0, MAX_ISSUE_LINES).map(({ issue, severity }, index) => ({
    key: `${issue.code}-${index}`,
    text: `[${issue.code}] ${issue.message}`,
    severity: severity === 'error' ? ('error' as const) : ('warn' as const),
  }));
  return { lines, extra: Math.max(0, prioritized.length - lines.length) };
}

/** `2 menunggu · 1 terverifikasi · 1 gagal`, empty when the node has no plans. */
export function planProgressLabel(data: WorkflowNodeData): string {
  const parts: string[] = [];
  if (data.plansPending) parts.push(`${data.plansPending} menunggu`);
  if (data.plansVerified) parts.push(`${data.plansVerified} terverifikasi`);
  if (data.plansFailed) parts.push(`${data.plansFailed} gagal`);
  return parts.join(' · ');
}

/**
 * Human name for the node status, with the plan progress appended for a mutate
 * node so "3 menunggu" is never mistaken for "3 tulisan sudah masuk".
 */
export function statusLabelOf(data: WorkflowNodeData): string {
  const base = NODE_STATUS_LABEL[data.status];
  if (data.status === 'success' && data.plansFailed) return 'Selesai — ada plan gagal';
  return base;
}

export function nodeSummaryText(data: WorkflowNodeData): string {
  const summary = data.summary?.trim();
  if (summary) return summary;
  if (data.status === 'pending' || data.status === 'queued') return 'Belum diproses';
  if (data.status === 'skipped') return 'Tidak ada yang dikerjakan';
  return NODE_STATUS_LABEL[data.status];
}

/**
 * The accessible name carries status, plan progress, queue recap availability
 * and issue count — never a medical record number or other PHI.
 */
export function nodeAriaLabel(data: WorkflowNodeData): string {
  const issues = (data.issues?.length ?? 0) + (data.warnings?.length ?? 0);
  const plans = data.planCount ? `, ${planProgressLabel(data) || `${data.planCount} plan`}` : '';
  const recap = data.clinicCounts
    ? `, ${data.clinicCounts.totalClinics} poli, ${data.clinicCounts.totalPatients} pasien`
    : data.clinicCountsState === 'waiting'
      ? ', rekap antrean sedang dihitung'
      : data.clinicCountsState === 'unavailable'
        ? ', rekap antrean tidak tersedia'
        : '';
  const issueText = issues > 0 ? `, ${issues} catatan` : '';
  return `${data.label} — ${statusLabelOf(data)}${plans}${recap}${issueText}`;
}

/** Full MULAI recap; the card is sized by the layout to hold every line. */
function nodeRecapLines(data: WorkflowNodeData): string[] {
  if (!data.clinicCountsState) return [];
  if (data.clinicCountsState === 'ready') return formatRajalClinicCounts(data.clinicCounts, { state: 'ready' });
  if (data.clinicCountsState === 'unavailable') return formatRajalClinicCounts(undefined, { state: 'unavailable' });
  return formatRajalQueueWaiting(data.clinics ?? [], data.queuePatients);
}

const RISK_LABEL: Partial<Record<RiskLevel, string>> = { high: 'Risiko tinggi', critical: 'Kritis' };

/** A ✗/!/→ reason carries its detail (what was wrong, what is planned); ✓ and rules read fine alone. */
const showsDetail = (r: CardReason) => Boolean(r.detail) && r.mark !== 'ok' && r.mark !== 'rule';
const reasonText = (r: CardReason) => (showsDetail(r) ? `${r.text} — ${r.detail}` : r.text);

/** "Cek Balance ok" under the title "Cek Balance" says nothing the status pill does not. */
export function redundantSummary(data: Pick<WorkflowNodeData, 'label' | 'summary' | 'status'>, hasReasons: boolean): boolean {
  const summary = data.summary?.trim().toLowerCase();
  if (!summary) return hasReasons && (data.status === 'pending' || data.status === 'queued');
  return summary === `${data.label.toLowerCase()} ok` || (summary === 'skipped' && data.status === 'skipped');
}

/**
 * Height a fixed-view card needs for its content, so the phase column stacks
 * cards by what they show instead of one size that clips a review card and
 * leaves a finished one half empty. Text metrics: 12px title (~18 chars/line
 * beside the widest status pill), 11px reasons (~38 chars/line, two lines max).
 */
export function cardHeightOf(data: WorkflowNodeData): number {
  const lines = (text: string, perLine: number, max = 2) => Math.min(max, Math.ceil(text.length / perLine));
  const reasons = data.reasons ?? [];
  let h = 22 + lines(data.label, 18) * 16;
  if (data.description) h += 18;
  if (!redundantSummary(data, reasons.length > 0)) h += 4 + lines(nodeSummaryText(data), 40) * 15;
  if (reasons.length) {
    h += 22 + reasons.reduce((sum, r) => sum + 2 + lines(reasonText(r), 38) * 15, 0);
    if (data.trail?.title && !data.reasonsAreRules) h += 2 + lines(data.trail.title, 36) * 15;
    if (data.reasonsHidden) h += 15;
  } else if ((data.issues?.length ?? 0) + (data.warnings?.length ?? 0) > 0) h += 18;
  if (data.next) h += 18;
  // Meta row (a risk badge stands taller than the duration text), then the review button.
  h += data.riskLevel === 'high' || data.riskLevel === 'critical' ? 30 : 22;
  if (REVIEW_STATUSES.includes(data.status) && data.onReview) h += 34;
  return Math.max(112, h + 10);
}

function WorkflowNodeView({ data, selected }: NodeProps<WorkflowNodeData>) {
  const activate = () => data.onSelect?.();
  const review = () => (data.onReview ?? data.onSelect)?.();
  const { lines, extra } = nodeIssueLines(data);
  const plans = planProgressLabel(data);
  const canReview = REVIEW_STATUSES.includes(data.status) && Boolean(data.onReview);
  const recapLines = nodeRecapLines(data);
  const reviewLabel = data.status === 'gate_waiting' || (data.isWriteRun && (data.plansPending ?? 0) > 0)
    ? 'Tinjau & setujui'
    : 'Tinjau detail';
  const duration = fmtDuration(data.durationMs);
  const risk = data.riskLevel ? RISK_LABEL[data.riskLevel] : undefined;

  // One ring when a node lands in a state the operator should notice; the first
  // render (e.g. reopening a finished run) stays quiet.
  const cardRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef(data.status);
  useEffect(() => {
    if (previousStatus.current === data.status) return;
    previousStatus.current = data.status;
    const tone = PULSE_TONE[data.status];
    if (tone) pulse(cardRef.current, tone);
  }, [data.status]);

  if (data.compact) {
    return (
      <div
        ref={cardRef}
        className={`wf-node wf-node--compact nodrag status-${data.status}${selected ? ' selected' : ''}`}
        data-testid="wf-node"
        role="button"
        tabIndex={0}
        aria-label={nodeAriaLabel(data)}
        title={`${data.label} — ${statusLabelOf(data)}${data.summary ? `
${data.summary}` : ''}`}
        onClick={(event) => { event.stopPropagation(); review(); }}
        onKeyDown={(event) => {
          if (!isNodeActivationKey(event.key)) return;
          event.preventDefault();
          review();
        }}
      >
        <FlowHandles vertical={Boolean(data.vertical)} />
        <span className="wf-compact-dot" aria-hidden="true" />
        <span className="wf-compact-label">{data.label}</span>
        {risk ? <span className="wf-compact-risk" aria-hidden="true">{data.riskLevel === 'critical' ? '!!' : '!'}</span> : null}
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      className={`wf-node nodrag status-${data.status}${selected ? ' selected' : ''}`}
      data-testid="wf-node"
      role="button"
      tabIndex={0}
      aria-label={nodeAriaLabel(data)}
      onClick={(event) => { event.stopPropagation(); activate(); }}
      onKeyDown={(event) => {
        if (!isNodeActivationKey(event.key)) return;
        event.preventDefault();
        activate();
      }}
    >
      <Handle id="in-left" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="in-top" type="target" position={Position.Top} isConnectable={false} />

      <div className="wf-node-head">
        <span className="wf-node-title">
          <span className="wf-node-kind" aria-hidden="true">{KIND_ICON[data.kind]}</span>
          <span className="label-text">{data.label}</span>
        </span>
        <span className="status-pill"><span className="dot" aria-hidden />{statusLabelOf(data)}</span>
      </div>
      {data.description ? <p className="wf-node-description" title={data.description}>{data.description}</p> : null}

      {recapLines.length ? (
        <ul className="node-recap" aria-label="Rekap poli">
          {recapLines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : redundantSummary(data, Boolean(data.reasons?.length)) ? null : (
        <p className="summary" title={data.summary}>{nodeSummaryText(data)}</p>
      )}

      {data.reasons?.length ? (
        <div className="wf-reasons" data-rules={data.reasonsAreRules ? '' : undefined}>
          <span className="wf-reasons-title">{data.reasonsAreRules ? (data.status === 'pending' || data.status === 'queued' ? 'Akan diputuskan' : 'Aturan') : 'Alasan'}</span>
          <ul className="wf-trail" aria-label={data.reasonsAreRules ? 'Aturan langkah' : 'Alasan keputusan'}>
            {data.trail?.title && !data.reasonsAreRules ? <li className="wf-trail-title">{data.trail.title}</li> : null}
            {data.reasons.map((item, index) => (
              <li key={`${item.text}-${index}`} data-mark={item.mark} title={item.detail ? `${item.text} — ${item.detail}` : item.text}>
                <span className="wf-mark" aria-hidden="true">{REASON_MARK[item.mark]}</span>
                <span className="wf-trail-text">{item.text}{showsDetail(item) ? <span className="wf-trail-detail"> — {item.detail}</span> : null}</span>
              </li>
            ))}
            {data.reasonsHidden ? <li className="wf-trail-more">+{data.reasonsHidden} {data.reasonsAreRules ? 'aturan' : 'cek'} lagi · buka inspector</li> : null}
          </ul>
        </div>
      ) : lines.length ? (
        <div className="issues">
          {lines.map((line) => (
            <div className={`issue issue-${line.severity}`} key={line.key}>{line.text}</div>
          ))}
          {extra > 0 ? <div className="issue-more">+{extra} catatan</div> : null}
        </div>
      ) : null}
      {data.next ? (
        <div className={`wf-next${data.next.go.length ? '' : ' is-stop'}`} title={[...data.next.go.map((n) => `lanjut: ${n}`), ...data.next.stop.map((n) => `tidak dijalankan: ${n}`)].join(' · ')}>
          {data.next.go.length ? `→ ${data.next.go.join(', ')}` : `■ Berhenti · ${data.next.stop.join(', ')} tidak dijalankan`}
        </div>
      ) : null}

      <div className="meta">
        {risk ? <span className={`risk-badge risk-${data.riskLevel}`}>{risk}</span> : null}
        <span className="meta-right">{plans ? <span className="plan-progress">{plans}</span> : null}{duration ? <span>{duration}</span> : null}</span>
      </div>

      {canReview ? (
        <button
          type="button"
          className="node-review nodrag"
          onClick={(event) => {
            event.stopPropagation();
            review();
          }}
          title="Buka inspector untuk melihat bukti dan menyetujui"
        >
          {reviewLabel}
        </button>
      ) : null}

      <Handle id="out-bottom" type="source" position={Position.Bottom} isConnectable={false} />
      <Handle id="out-right" type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

/** Content depends on `data` and selection only, so a node that merely moves (a tween frame) is skipped. */
export const WorkflowNode = memo(WorkflowNodeView, (a, b) => a.data === b.data && a.selected === b.selected);
