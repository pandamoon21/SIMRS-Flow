/**
 * Selected node details, projected from the shared run store.
 *
 * Beyond status and logs, the inspector renders the *evidence* a step attaches
 * to its result. That is where the parity output lives — the room-day
 * assignment map, the titipan class comparison, the registration alerts, and
 * the verification summary row — and it is unreadable as raw JSON, so the
 * shapes the domain emits get a purpose-built table each. Anything unrecognised
 * still falls back to formatted JSON rather than being dropped.
 */

import { Fragment, useState } from 'react';
import { verificationRulesOf, type Evidence, type MutationCheckResult } from '@simrs-flow/workflow-core';
import { useRunStore } from '../../store/runStore.js';
import { classifyLogLine } from './logView.js';
import { NODE_STATUS_LABEL } from '../run/runStatus.js';
import { decisionTrailOf, nextStepOf } from '../canvas/decisionTrail.js';
import { TRAIL_MARK } from '../canvas/WorkflowNode.js';
import { Alert, Badge, Button, Card, CardBody, CardHeader, type Tone } from '../../ui/primitives.js';

/** Decisions resolve when the server answers, so the button can hold a pending state. */
type Decision = (id: string) => void | Promise<void>;

export interface NodeInspectorProps {
  onApproveGate?: Decision;
  onRejectGate?: Decision;
  onApproveMutation?: Decision;
  onHide?: () => void;
}

const STATUS_TONE: Partial<Record<string, Tone>> = {
  success: 'success', failed: 'danger', blocked: 'danger', needs_review: 'warning',
  gate_waiting: 'warning', running: 'info', retrying: 'info',
};

interface RoomDayAssignments {
  [noTransaksi: string]: string[];
}

interface TitipanRow {
  noTransaksi?: string;
  roomName?: string;
  sepClass?: string;
  roomClass?: string;
  result?: string;
  reason?: string;
}

interface SummaryTsv {
  header: readonly string[];
  rows: readonly string[];
}

interface RegAlertGroup {
  reg: string;
  alerts: Array<{ level: string; message: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mutationFieldLabel(key: string): string {
  const labels: Record<string, string> = {
    kd_penjamin: 'Kode penjamin bayar',
    dt_bayar: 'Rincian bayar',
    tindakan: 'Baris tindakan',
    no_reg: 'No. registrasi',
    no_transaksi: 'No. transaksi',
    kd_unit: 'Kode unit',
  };
  return labels[key] ?? key;
}

function mutationFieldValue(key: string, value: unknown): string {
  if (key === 'dt_bayar') return Object.entries(Object.fromEntries(new URLSearchParams(String(value)))).map(([k, v]) => `${k}=${v}`).join(', ');
  if (key === 'tindakan') {
    try {
      const rows = JSON.parse(String(value)) as unknown;
      if (Array.isArray(rows)) return `${rows.length} row(s)`;
    } catch {
      // fall through to raw value
    }
  }
  return Array.isArray(value) ? value.join(', ') || '—' : String(value);
}

function CheckResults({ title, results }: { title: string; results?: readonly MutationCheckResult[] }) {
  if (!results?.length) return null;
  return (
    <>
      <span className="mutation-subtitle">{title}</span>
      <ul className="mutation-checks">
        {results.map((result, index) => (
          <li key={index} data-check-holds={result.holds ? 'yes' : 'no'}>
            {result.holds ? '✓' : '✕'} {result.description} <span className="mono">({result.endpointId})</span>
            {result.reason || result.error ? <div className="muted-copy">{result.error ?? result.reason}</div> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Room → billed hospital days. The single most-checked output of a ranap run. */
function RoomDaysTable({ data }: { data: RoomDayAssignments }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return <div className="muted-copy">Belum ada assignment hari ruang.</div>;
  return (
    <table className="evidence-table">
      <thead>
        <tr>
          <th>Transaksi</th>
          <th>Hari</th>
          <th className="num">Jml</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([trx, days]) => (
          <tr key={trx}>
            <td className="mono">{trx}</td>
            <td>{days.join(', ') || '—'}</td>
            <td className="num">{days.length}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** SEP entitlement versus the room actually occupied. */
function TitipanTable({ rows }: { rows: readonly TitipanRow[] }) {
  return (
    <table className="evidence-table">
      <thead>
        <tr>
          <th>Ruang</th>
          <th>Kelas SEP</th>
          <th>Kelas ruang</th>
          <th>Hasil</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row.noTransaksi ?? index} data-titipan={row.result === 'TITIPAN' ? 'yes' : 'no'}>
            <td>{row.roomName ?? '—'}</td>
            <td>{row.sepClass ?? '—'}</td>
            <td>{row.roomClass ?? '—'}</td>
            <td>
              <span className="evidence-verdict" data-verdict={row.result ?? ''}>
                {row.result ?? '—'}
              </span>
              {row.reason ? <div className="muted-copy">{row.reason}</div> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The tab-separated verification summary the ward pastes into its recap sheet. */
function SummaryTsvTable({ data }: { data: SummaryTsv }) {
  const [copied, setCopied] = useState(false);
  const tsv = [data.header.join('\t'), ...data.rows].join('\n');

  const copy = () => {
    void navigator.clipboard?.writeText(tsv).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  };

  if (data.rows.length === 0) return <div className="muted-copy">Belum ada baris ringkasan.</div>;
  return (
    <>
      <div className="evidence-scroll">
        <table className="evidence-table">
          <thead>
            <tr>{data.header.map((cell) => <th key={cell}>{cell}</th>)}</tr>
          </thead>
          <tbody>
            {data.rows.map((row, index) => (
              <tr key={index}>
                {row.split('\t').map((cell, cellIndex) => (
                  <td className={cellIndex === 4 ? 'num mono' : ''} key={cellIndex}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button color="secondary" variant="outline" size="sm" onClick={copy} title="Salin sebagai TSV untuk Excel">
        {copied ? 'Copied' : 'Salin TSV'}
      </Button>
    </>
  );
}

/** Registration alerts, grouped the way the legacy pre-verification block prints them. */
function AlertGroups({ groups }: { groups: readonly RegAlertGroup[] }) {
  const withAlerts = groups.filter((group) => group.alerts.length > 0);
  if (withAlerts.length === 0) return <div className="muted-copy">Tidak ada catatan untuk registrasi ini.</div>;
  return (
    <ul className="evidence-alerts">
      {withAlerts.flatMap((group) =>
        group.alerts.map((alert, index) => (
          <li data-level={alert.level} key={`${group.reg}-${index}`}>
            <span className="evidence-alert-level">{alert.level}</span>
            {alert.message}
          </li>
        )),
      )}
    </ul>
  );
}

const RISK_LABEL: Record<string, string> = { low: 'rendah', medium: 'sedang', high: 'tinggi', critical: 'kritis' };

/** Pick a renderer by evidence label, falling back to formatted JSON. */
function EvidenceBody({ item }: { item: Evidence }) {
  const { label, data } = item;
  if (label === 'roomDayAssignments' && isRecord(data)) {
    return <RoomDaysTable data={data as RoomDayAssignments} />;
  }
  if (label === 'titipan' && Array.isArray(data)) {
    return <TitipanTable rows={data as TitipanRow[]} />;
  }
  if (label === 'summaryTsv' && isRecord(data) && Array.isArray(data.rows)) {
    return <SummaryTsvTable data={data as unknown as SummaryTsv} />;
  }
  if (label === 'alerts' && Array.isArray(data)) {
    return <AlertGroups groups={data as RegAlertGroup[]} />;
  }
  if (Array.isArray(data) && data.every((entry) => typeof entry === 'string')) {
    return <div className="mono evidence-list">{(data as string[]).join(', ')}</div>;
  }
  if (isRecord(data) && Object.values(data).every((value) => typeof value !== 'object')) {
    // `.summary-list` is a two-column grid, so dt/dd must stay direct children.
    return (
      <dl className="summary-list compact-summary">
        {Object.entries(data).map(([key, value]) => (
          <Fragment key={key}>
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
          </Fragment>
        ))}
      </dl>
    );
  }
  // Anything without an operator-facing renderer is for support, not for the cashier.
  return (
    <details className="evidence-raw">
      <summary>Detail teknis</summary>
      <pre className="evidence-json">{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}

export function NodeInspector({ onApproveGate, onRejectGate, onApproveMutation, onHide }: NodeInspectorProps) {
  const definition = useRunStore((store) => store.definition);
  const state = useRunStore((store) => store.state);
  const isWriteRun = state?.mode === 'write';
  const selectedNodeId = useRunStore((store) => store.selectedNodeId);
  const definitionNode = definition?.nodes.find((node) => node.id === selectedNodeId);
  const runtimeNode = selectedNodeId ? state?.nodes[selectedNodeId] : undefined;
  const gate = selectedNodeId ? state?.gates[selectedNodeId] : undefined;
  const sectionLabel = definition?.layout?.groups?.find((group) => group.id === definitionNode?.group)?.label;
  const trail = decisionTrailOf(runtimeNode, state?.mutations);
  const next = selectedNodeId ? nextStepOf(definition, state, selectedNodeId) : undefined;
  // Which decision is in flight (e.g. "approve:gate-1"); blocks repeat clicks until the server answers.
  const [pending, setPending] = useState<string>();
  const decide = (key: string, action: Decision | undefined, id: string) => {
    if (!action || pending) return;
    setPending(key);
    void Promise.resolve(action(id)).finally(() => setPending(undefined));
  };

  return (
    <Card className="panel-card inspector-card">
      <CardHeader className="card-header-actions">
        <span>{definitionNode ? `Inspector · ${definitionNode.label}` : 'Inspector'}</span>
        {onHide ? <button type="button" className="panel-close" aria-label="Tutup inspector" title="Tutup inspector" onClick={onHide}>×</button> : null}
      </CardHeader>
      <CardBody className="panel-scroll">
        {!definition || !selectedNodeId ? <div className="empty">Pilih node untuk melihat status, bukti, dan rencana.</div> : null}
        {definition && selectedNodeId ? (
          <>
            <dl className="summary-list compact-summary">
              <dt>Tahap</dt><dd>{sectionLabel ?? definitionNode?.group ?? '—'}</dd>
              <dt>Status</dt><dd><Badge color={STATUS_TONE[runtimeNode?.status ?? 'pending'] ?? 'secondary'}>{NODE_STATUS_LABEL[runtimeNode?.status ?? 'pending']}</Badge></dd>
              {runtimeNode?.durationMs !== undefined ? <><dt>Durasi</dt><dd>{runtimeNode.durationMs} ms</dd></> : null}
              {definitionNode?.riskLevel ? <><dt>Risiko</dt><dd><Badge color={definitionNode.riskLevel === 'critical' ? 'danger' : definitionNode.riskLevel === 'high' ? 'warning' : 'info'}>{RISK_LABEL[definitionNode.riskLevel] ?? definitionNode.riskLevel}</Badge></dd></> : null}
              {runtimeNode?.summary ? <><dt>Ringkasan</dt><dd>{runtimeNode.summary}</dd></> : null}
              <dt>ID</dt><dd className="mono">{selectedNodeId}</dd>
            </dl>

            {trail.items.length || next ? (
              <section className="panel-section inspector-trail">
                <h2>Alur keputusan</h2>
                {trail.title ? <p className="inspector-trail-title">{trail.title}</p> : null}
                {trail.items.length ? (
                  <ul className="wf-trail is-full">
                    {trail.items.map((item, index) => (
                      <li key={`${item.text}-${index}`} data-mark={item.mark}>
                        <span className="wf-mark" aria-hidden="true">{TRAIL_MARK[item.mark]}</span>
                        <span className="wf-trail-text">{item.text}{item.detail ? <span className="wf-trail-detail"> — {item.detail}</span> : null}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {next ? (
                  <p className={`wf-next${next.go.length ? '' : ' is-stop'}`}>
                    {next.go.length ? <>→ Lanjut ke <strong>{next.go.join(', ')}</strong></> : '■ Run berhenti di langkah ini'}
                    {next.stop.length ? <span className="wf-trail-detail"> · tidak dijalankan: {next.stop.join(', ')}</span> : null}
                  </p>
                ) : null}
              </section>
            ) : null}

            {gate?.status === 'waiting' ? (
              <Alert color="warning">
                <strong>Gate menunggu persetujuan</strong>
                <p className="mb-2 mt-1">Periksa rencana dan syaratnya sebelum memutuskan.</p>
                <div className="button-row">
                  <Button color="warning" disabled={Boolean(pending)} title="Catat persetujuan Anda — gate kritis bisa butuh operator kedua (sesuai pengaturan host)" onClick={() => decide(`approve:${selectedNodeId}`, onApproveGate, selectedNodeId)}>
                    {pending === `approve:${selectedNodeId}` ? 'Menyetujui…' : 'Setujui'}
                  </Button>
                  <Button color="danger" variant="outline" disabled={Boolean(pending)} title="Tolak gate ini dan hentikan run di sini" onClick={() => decide(`reject:${selectedNodeId}`, onRejectGate, selectedNodeId)}>
                    {pending === `reject:${selectedNodeId}` ? 'Menolak…' : 'Tolak'}
                  </Button>
                </div>
              </Alert>
            ) : null}

            {runtimeNode?.issues.map((issue, index) => <Alert color={issue.severity === 'error' ? 'danger' : issue.severity === 'warn' ? 'warning' : 'info'} key={`${issue.code}-${index}`}>[{issue.code}] {issue.message}</Alert>)}
            {runtimeNode?.warnings.map((warning, index) => <Alert color="warning" key={`${warning.code}-${index}`}>[{warning.code}] {warning.message}</Alert>)}

            {runtimeNode?.proposedMutations.length ? (
              <section className="panel-section">
                <h2>Rencana perubahan</h2>
                {runtimeNode.proposedMutations.map((mutation) => {
                  const outcome = state?.mutations[mutation.id];
                  const rules = verificationRulesOf(mutation);
                  const settled = outcome?.status;
                  const isTerminal = settled === 'verified' || settled === 'failed' || settled === 'invalidated' || settled === 'applied';
                  // Plans apply only while the run is live; after it ends the orchestrator refuses (run_not_active).
                  const runEnded = state?.status === 'completed' || state?.status === 'failed' || state?.status === 'cancelled';
                  const canApprove = isWriteRun && onApproveMutation && mutation.requiresApproval && !isTerminal && !runEnded;
                  return (
                    <div className="mutation-plan" key={mutation.id}>
                      <div className="mutation-title"><Badge color={mutation.riskLevel === 'critical' ? 'danger' : 'warning'}>{mutation.riskLevel}</Badge><strong className="mono">{mutation.endpointId}</strong></div>
                      <p>{mutation.reason}</p>
                      {outcome ? (
                        <Alert color={outcome.status === 'verified' ? 'success' : outcome.status === 'failed' || outcome.status === 'invalidated' ? 'danger' : 'info'}>
                          Mutation status: <strong>{outcome.status}</strong>{outcome.phase ? ` (${outcome.phase})` : ''}{outcome.reason ? ` — ${outcome.reason}` : ''}
                          {outcome.ambiguous ? <div className="muted-copy"><strong>Write may have landed; reconcile in SIMRS before continuing.</strong></div> : null}
                        </Alert>
                      ) : null}
                      {Object.keys(mutation.payloadSummary).length ? (
                        <dl className="summary-list compact-summary">
                          {Object.entries(mutation.payloadSummary).map(([key, value]) => (
                            <Fragment key={key}>
                              <dt>{mutationFieldLabel(key)}</dt>
                              <dd className="mono">{mutationFieldValue(key, value)}</dd>
                            </Fragment>
                          ))}
                        </dl>
                      ) : null}
                      {mutation.preconditions.length ? (
                        <>
                          <span className="mutation-subtitle">Preconditions re-checked at approval</span>
                          <ul className="mutation-checks">
                            {mutation.preconditions.map((precondition, index) => (
                              <li key={index}>
                                {precondition.description} <span className="mono">({precondition.check})</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      {rules.length ? (
                        <>
                          <span className="mutation-subtitle">Verified after write</span>
                          <ul className="mutation-checks">
                            {rules.map((rule, index) => (
                              <li key={index}>
                                {rule.description} <span className="mono">({rule.endpointId})</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                      <CheckResults title="Precondition results" results={outcome?.preconditionResults} />
                      <CheckResults title="Verification results" results={outcome?.verificationResults} />
                      <span className="muted-copy">Approval required: {mutation.requiresApproval ? 'yes' : 'no'}</span>
                      {isWriteRun && mutation.requiresApproval && !settled && runEnded ? (
                        <span className="muted-copy">Tidak diterapkan: run sudah berakhir. Rencana hanya bisa disetujui selama run masih berjalan.</span>
                      ) : null}
                      {canApprove ? (
                        <div className="button-row mt-2">
                          <Button
                            color={mutation.riskLevel === 'critical' ? 'danger' : 'warning'}
                            title={mutation.riskLevel === 'critical' ? 'Setujui — plan critical (verifikasi/tampung bayar); jumlah persetujuan mengikuti konfigurasi host' : 'Setujui mutasi ini; write dijalankan lewat gate dengan verifikasi'}
                            disabled={Boolean(pending)}
                            onClick={() => decide(`mutation:${mutation.id}`, onApproveMutation, mutation.id)}
                          >
                            {pending === `mutation:${mutation.id}` ? 'Menyetujui…' : mutation.riskLevel === 'critical' ? 'Setujui (kritis)' : 'Approve & apply'}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </section>
            ) : null}

            {runtimeNode?.evidence.some((item) => item.label !== 'reasoning') ? (
              <section className="panel-section">
                <h2>Bukti</h2>
                {/* `reasoning` is already drawn as Alur Keputusan above. */}
                {runtimeNode.evidence.filter((item) => item.label !== 'reasoning').map((item, index) => (
                  <div className="evidence-block" key={`${item.label}-${index}`}>
                    <div className="evidence-head">
                      <strong>{item.label}</strong>
                      {item.source ? <span className="mono muted-copy">{item.source}</span> : null}
                    </div>
                    <EvidenceBody item={item} />
                  </div>
                ))}
              </section>
            ) : null}

            {runtimeNode?.logs.length ? (
              <section className="panel-section">
                <h2>Log node</h2>
                <div className="log-box node-log-box">
                  {runtimeNode.logs.map((log) => (
                    <div
                      className="log-line"
                      data-shape={classifyLogLine(log.message)}
                      data-severity={log.severity}
                      key={log.seq}
                    >
                      {log.message}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
