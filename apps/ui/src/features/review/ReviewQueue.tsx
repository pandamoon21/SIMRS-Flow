import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunState } from '@simrs-flow/workflow-core';
import { Alert, Badge, Button, Card, CardBody, CardHeader, type Tone } from '../../ui/primitives.js';
import { formatRupiah } from '../dashboard/billing.js';
import {
  DEFAULT_REVIEW_SETTINGS,
  decideGate,
  loadReviewSettings,
  riskOf,
  saveReviewSettings,
  type GateDecision,
  type GateFacts,
  type ReviewSettings,
  type RiskBand,
} from './reviewRules.js';

export interface ReviewQueueProps {
  state?: RunState;
  runId?: string;
  hasReviewContext: boolean;
  onApproveGate: (nodeId: string) => void;
  onRejectGate: (nodeId: string) => void;
  onOpenRun: () => void;
}

interface QueueItem {
  nodeId: string;
  label: string;
  endpointId: string;
  reason: string;
  nominal?: number;
  facts: GateFacts;
  risk: RiskBand;
  decision: GateDecision;
}

const RISK_TONE: Record<RiskBand, Tone> = { low: 'success', medium: 'warning', high: 'danger' };
const DECISION_LABEL: Record<GateDecision, string> = {
  'auto-approve': 'Auto-approved',
  'auto-reject': 'Auto-rejected',
  manual: 'Menunggu Anda',
};
const DECISION_TONE: Record<GateDecision, Tone> = { 'auto-approve': 'success', 'auto-reject': 'danger', manual: 'warning' };

/** Map the domain's declared risk (incl. critical) onto the three review bands. */
function declaredRiskBand(level?: string): RiskBand | undefined {
  if (level === 'low') return 'low';
  if (level === 'medium') return 'medium';
  if (level === 'high' || level === 'critical') return 'high';
  return undefined;
}

/** Best-effort nominal (rupiah) from a mutation's payload summary. */
function extractNominal(payloadSummary: Record<string, unknown> | undefined): number | undefined {
  if (!payloadSummary) return undefined;
  const direct = Object.entries(payloadSummary).find(([k]) => /nominal|total|tarif|jumlah|amount/i.test(k));
  if (direct) {
    const n = Number(String(direct[1]).replace(/[^\d]/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const dtBayar = payloadSummary['dt_bayar'];
  if (typeof dtBayar === 'string') {
    const params = new URLSearchParams(dtBayar);
    for (const key of ['nominal', 'total', 'tarif', 'jumlah']) {
      const raw = params.get(key);
      if (raw) {
        const n = Number(raw.replace(/[^\d]/g, ''));
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  }
  return undefined;
}

function buildQueue(state: RunState | undefined, settings: ReviewSettings): QueueItem[] {
  if (!state) return [];
  const items: QueueItem[] = [];
  for (const [nodeId, gate] of Object.entries(state.gates ?? {})) {
    if (gate?.status !== 'waiting') continue;
    const node = state.nodes[nodeId];
    const mutation = node?.proposedMutations?.[0];
    const outcome = mutation ? state.mutations?.[mutation.id] : undefined;
    const preResults = outcome?.preconditionResults;
    const preconditionsOk = preResults && preResults.length > 0 ? preResults.every((r) => r.holds) : undefined;
    const nominal = extractNominal(mutation?.payloadSummary as Record<string, unknown> | undefined);
    const facts: GateFacts = {
      nominal,
      declaredRisk: declaredRiskBand(mutation?.riskLevel),
      preconditionsOk,
      requiresApproval: mutation?.requiresApproval ?? true,
    };
    items.push({
      nodeId,
      label: node?.summary ?? nodeId,
      endpointId: mutation?.endpointId ?? '—',
      reason: mutation?.reason ?? 'Gate menunggu persetujuan.',
      nominal,
      facts,
      risk: riskOf(facts, settings),
      decision: decideGate(facts, settings),
    });
  }
  return items;
}

export function ReviewQueue({ state, runId, hasReviewContext, onApproveGate, onRejectGate, onOpenRun }: ReviewQueueProps) {
  const [settings, setSettings] = useState<ReviewSettings>(loadReviewSettings);
  const update = (patch: Partial<ReviewSettings>) =>
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveReviewSettings(next);
      return next;
    });

  const queue = useMemo(() => buildQueue(state, settings), [state, settings]);

  // Fire each auto-decision once through the real gate endpoints.
  const handled = useRef<Set<string>>(new Set());
  useEffect(() => {
    handled.current = new Set();
  }, [runId]);
  useEffect(() => {
    for (const item of queue) {
      const key = `${item.nodeId}:${item.decision}`;
      if (item.decision === 'manual' || handled.current.has(key)) continue;
      handled.current.add(key);
      if (item.decision === 'auto-approve') onApproveGate(item.nodeId);
      else if (item.decision === 'auto-reject') onRejectGate(item.nodeId);
    }
  }, [queue, onApproveGate, onRejectGate]);

  const manual = queue.filter((q) => q.decision === 'manual');
  const autoApproved = queue.filter((q) => q.decision === 'auto-approve').length;
  const autoRejected = queue.filter((q) => q.decision === 'auto-reject').length;

  return (
    <div className="page-stack review-page">
      <header className="page-heading">
        <div>
          <span className="page-eyebrow">SIMRS-Flow / approval queue</span>
          <h1>Review</h1>
          <p>Gates awaiting a decision. Confirm the exact mutation and preconditions before approving a write.</p>
        </div>
        <div className="page-heading-actions review-summary">
          <Badge color="warning">{manual.length} need you</Badge>
          <Badge color="success">{autoApproved} auto-ok</Badge>
          <Badge color="danger">{autoRejected} auto-rej</Badge>
        </div>
      </header>

      {/* Automation & risk rules */}
      <Card className="surface-card review-rules-card">
        <CardHeader>Automation &amp; risk rules</CardHeader>
        <CardBody className="review-rules-body">
          <div className="review-rules-col">
            <span className="control-label">Auto-decisions</span>
            <label className="review-toggle">
              <span>
                Auto-approve <b className="tone-success">low-risk</b> gates
                <em>Preconditions must pass</em>
              </span>
              <input type="checkbox" checked={settings.autoApproveLow} onChange={(e) => update({ autoApproveLow: e.target.checked })} />
            </label>
            <label className="review-toggle">
              <span>
                Auto-reject on <b className="tone-danger">precondition fail</b>
                <em>e.g. SEP mismatch, locked payment</em>
              </span>
              <input type="checkbox" checked={settings.autoRejectOnFail} onChange={(e) => update({ autoRejectOnFail: e.target.checked })} />
            </label>
          </div>
          <div className="review-rules-col">
            <span className="control-label">Risk thresholds · by nominal</span>
            <div className="review-threshold-grid">
              <label className="review-threshold">
                <span className="tone-success">Low ≤</span>
                <input
                  className="form-control"
                  inputMode="numeric"
                  value={formatRupiah(settings.riskLowMax)}
                  onChange={(e) => update({ riskLowMax: Number(e.target.value.replace(/[^\d]/g, '')) || 0 })}
                />
              </label>
              <label className="review-threshold">
                <span className="tone-danger">High ≥</span>
                <input
                  className="form-control"
                  inputMode="numeric"
                  value={formatRupiah(settings.riskHighMin)}
                  onChange={(e) => update({ riskHighMin: Number(e.target.value.replace(/[^\d]/g, '')) || 0 })}
                />
              </label>
            </div>
            <div className="review-threshold-legend">
              <span className="tone-success">Low ≤ {formatRupiah(settings.riskLowMax)}</span>
              <span className="tone-warning">Medium</span>
              <span className="tone-danger">High ≥ {formatRupiah(settings.riskHighMin)}</span>
            </div>
            <Button color="secondary" variant="outline" size="sm" type="button" onClick={() => { setSettings(DEFAULT_REVIEW_SETTINGS); saveReviewSettings(DEFAULT_REVIEW_SETTINGS); }}>
              Reset to defaults
            </Button>
          </div>
        </CardBody>
      </Card>

      {!hasReviewContext || queue.length === 0 ? (
        <Alert color="info">No gates are waiting. Review is available when a run has a waiting gate or needs-review node.</Alert>
      ) : (
        <div className="review-queue">
          {queue.map((item) => {
            const isManual = item.decision === 'manual';
            return (
              <Card className={`surface-card review-card risk-${item.risk}`} key={item.nodeId}>
                <CardHeader className="card-header-actions review-card-head">
                  <div className="review-card-title">
                    <strong>{item.label}</strong>
                    <span className="mono muted-copy">{item.endpointId}</span>
                  </div>
                  <div className="review-card-badges">
                    <Badge color={RISK_TONE[item.risk]}>{item.risk} risk</Badge>
                    {item.facts.preconditionsOk === false ? <Badge color="danger">precondition fail</Badge> : null}
                  </div>
                </CardHeader>
                <CardBody className="review-card-body">
                  <p className="review-card-reason">{item.reason}</p>
                  <dl className="summary-list compact-summary">
                    {item.nominal !== undefined ? <><dt>Nominal</dt><dd className="mono tone-info">{formatRupiah(item.nominal)}</dd></> : null}
                    <dt>Precheck</dt>
                    <dd className={item.facts.preconditionsOk === false ? 'tone-danger' : item.facts.preconditionsOk ? 'tone-success' : ''}>
                      {item.facts.preconditionsOk === false ? 'Syarat tidak terpenuhi' : item.facts.preconditionsOk ? 'Preconditions re-checked · OK' : 'Syarat belum dicek'}
                    </dd>
                  </dl>
                  <div className="review-card-actions">
                    {isManual ? (
                      <>
                        <Button color="secondary" variant="outline" size="sm" onClick={onOpenRun}>Lihat di kanvas</Button>
                        <Button color="danger" variant="outline" size="sm" onClick={() => onRejectGate(item.nodeId)}>Tolak</Button>
                        <Button color="info" size="sm" onClick={() => onApproveGate(item.nodeId)}>Setujui</Button>
                      </>
                    ) : (
                      <>
                        <Badge color={DECISION_TONE[item.decision]}>{DECISION_LABEL[item.decision]} · auto</Badge>
                        <Button color="secondary" variant="outline" size="sm" onClick={onOpenRun}>Override</Button>
                      </>
                    )}
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
      <p className="review-foot muted-copy">
        Auto-decisions run only within the rules above and are always written to the redacted audit ledger. Critical gates need the number of approvals configured on the host (CRITICAL_APPROVALS).
      </p>
    </div>
  );
}
