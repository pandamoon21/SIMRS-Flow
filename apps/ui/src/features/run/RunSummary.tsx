/**
 * What the operator needs the moment a run ends: did it finish, what landed,
 * where it stopped, and the next move (history, audit export, another run).
 */
import { useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import type { RunState } from '@simrs-flow/workflow-core';
import { api } from '../../api/client.js';
import { Button } from '../../ui/primitives.js';
import { durationLabel, nextActionOf, outcomeDetail, patientOutcomesOf, PREVIEW_GATE_LABEL, previewGateStopOf, RUN_STATUS_LABEL, runOutcomeOf } from './runStatus.js';

export interface RunSummaryProps {
  state: RunState;
  runId: string;
  labelOf: (nodeId: string) => string;
  onFocusNode: (nodeId: string) => void;
  onOpenHistory: () => void;
  onNewRun: () => void;
  /** Persisted box, in canvas-wrap coordinates; the operator can resize it. */
  style?: CSSProperties;
  /** The shared eight resize handles, labelled for this panel. */
  grips?: ReactNode;
  /** Lets the page measure the content height for the default box. */
  sectionRef?: Ref<HTMLElement>;
}

export function RunSummary({ state, runId, labelOf, onFocusNode, onOpenHistory, onNewRun, style, grips, sectionRef }: RunSummaryProps) {
  // Closable so the finished graph underneath can be read; it returns for the next run.
  const [closedFor, setClosedFor] = useState<string>();
  const outcome = runOutcomeOf(state);
  if (closedFor === runId) return null;
  const { verified, failed, open } = outcome.mutations;
  // Fixture replays never reach the orchestrator, so there is no ledger to list or export.
  const fixture = runId.startsWith('offline-');
  const held = previewGateStopOf(state);
  const patients = patientOutcomesOf(state);
  const skipped = patients.filter((row) => row.status === 'dilewati');
  return (
    <section ref={sectionRef} className="run-summary" data-status={held ? 'completed' : state.status} aria-label="Ringkasan run" style={style}>
      <header className="run-summary-head">
        <span className="run-summary-status">{held ? PREVIEW_GATE_LABEL : RUN_STATUS_LABEL[state.status]}</span>
        <span className="run-summary-id mono">{runId}</span>
        <button type="button" className="run-error-close run-summary-close" aria-label="Tutup ringkasan" onClick={() => setClosedFor(runId)}>×</button>
      </header>
      <dl className="run-summary-facts">
        <div><dt>Langkah</dt><dd className="mono">{outcome.done}/{outcome.total}</dd></div>
        <div><dt>Durasi</dt><dd className="mono">{durationLabel(outcome.durationMs)}</dd></div>
        <div><dt>Masalah</dt><dd className="mono">{outcome.problems}</dd></div>
        {patients.length > 1 ? (
          <div><dt>Pasien</dt><dd className="mono">{patients.length - skipped.length} lolos · {skipped.length} dilewati</dd></div>
        ) : null}
        {verified + failed + open > 0 ? (
          <div><dt>Write</dt><dd className="mono">
            {state.mode === 'preview'
              ? `${open} rencana (preview, tidak ditulis)`
              : `${verified} terverifikasi${failed ? ` · ${failed} gagal` : ''}${open ? ` · ${open} terbuka` : ''}`}
          </dd></div>
        ) : null}
      </dl>
      {skipped.length > 0 && patients.length > 1 ? (
        <details className="run-summary-patients" open={skipped.length <= 4}>
          <summary>{skipped.length} pasien dilewati — kenapa?</summary>
          <ul>
            {skipped.map((row) => (
              <li key={row.patientId}>
                <span className="mono">{row.patientId}</span>
                <span className="run-summary-reason">{row.clinics.length ? `${row.clinics.join(', ')} · ` : ''}{outcomeDetail(state, row)}</span>
                {row.step ? <button type="button" className="rekap-link" onClick={() => onFocusNode(row.step!)}>{labelOf(row.step)}</button> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {held ? (
        <p className="run-summary-stop">Sampai di <strong>{labelOf(held)}</strong> — gerbang ditahan karena preview; tidak ada yang ditulis.</p>
      ) : outcome.stopNodeId ? (
        <p className="run-summary-stop">Berhenti di <strong>{labelOf(outcome.stopNodeId)}</strong>. {nextActionOf(outcome.stopNodeId)}</p>
      ) : null}
      <div className="run-summary-actions">
        {held ? (
          <Button color="secondary" variant="outline" size="sm" onClick={() => onFocusNode(held)}>Ke gerbang</Button>
        ) : outcome.stopNodeId ? (
          <Button color="danger" variant="outline" size="sm" onClick={() => onFocusNode(outcome.stopNodeId!)}>Ke node gagal</Button>
        ) : null}
        {!fixture ? <Button color="secondary" variant="outline" size="sm" onClick={onOpenHistory}>Lihat di History</Button> : null}
        {!fixture ? (
          <a className="btn btn-outline-secondary btn-sm" href={api.exportRunUrl(runId)} download title="Unduh jejak audit JSONL (sudah diredaksi)">Export JSONL</a>
        ) : null}
        <Button color="info" size="sm" onClick={onNewRun}>Run baru</Button>
      </div>
      {grips}
    </section>
  );
}
