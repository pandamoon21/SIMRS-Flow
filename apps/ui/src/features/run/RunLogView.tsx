/**
 * "Log saja" view of a run (docs/run-log-mode-plan.md): a terminal-style log in
 * place of the canvas. Left, the steps with their status (click = jump to the
 * step in the log, double-click = Inspector); right, the log itself with search,
 * the Debug / Hanya masalah filters, decision cards for waiting gates and
 * writes, and a sticky "Menunggu keputusan (n)" bar.
 *
 * Decisions call the same App handlers the Inspector uses; there is no second
 * approval path. Follows the tail only while already at the bottom, like the
 * Run console.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRunStore } from '../../store/runStore.js';
import { classifyLogLine, logMatches, logTime } from '../panels/logView.js';
import { END_MARK, checkMark, openDecisions, patientTrails, rowText, stepBlocks, stepOrder, terminalRows, type LogBlock, type LogDecision, type TermRow } from '../panels/terminalLog.js';
import { NODE_STATUS_LABEL } from './runStatus.js';
import { PatientLog } from './PatientLog.js';
import { pageZoom } from '../../ui/fitZoom.js';
import { Button, FormCheck } from '../../ui/primitives.js';

export interface RunLogViewProps {
  onApproveGate: (nodeId: string) => void | Promise<void>;
  onRejectGate: (nodeId: string) => void | Promise<void>;
  onApproveMutation: (planId: string) => void | Promise<void>;
  /** Select the step and show it in the Inspector. */
  onOpenNode: (nodeId: string) => void;
}

const FOLLOW_THRESHOLD_PX = 48;
const PROBLEM = new Set(['warn', 'error']);
const PROBLEM_STATUS = new Set(['failed', 'blocked', 'needs_review', 'gate_waiting']);
/** A step block with more log lines than this shows its head and tail until opened (500-patient batches). */
const LINE_FOLD = 40;
const FOLD_KEEP = 12;

function DecisionRow({ decision, label, onApproveGate, onRejectGate, onApproveMutation }: { decision: LogDecision; label: string } & Pick<RunLogViewProps, 'onApproveGate' | 'onRejectGate' | 'onApproveMutation'>) {
  const [pending, setPending] = useState<string>();
  const decide = (key: string, action: () => void | Promise<void>) => {
    if (pending) return;
    setPending(key);
    void Promise.resolve(action()).finally(() => setPending(undefined));
  };
  if (!decision.open) {
    return <div className="tl-decided" data-tone={decision.tone} data-auto={decision.auto ? '' : undefined}>{decision.tone === 'fail' ? '✗' : decision.tone === 'ok' ? '✓' : '→'} {decision.text}</div>;
  }
  if (decision.type === 'gate') {
    return (
      <div className="tl-decision" role="group" aria-label={`Keputusan ${label}`}>
        <span><strong>⏸ {label}</strong> menunggu keputusan operator. Periksa rencana dan precondition di Inspector sebelum memutuskan.</span>
        <span className="tl-decision-actions">
          <Button color="write" size="sm" disabled={Boolean(pending)} title="Catat persetujuan — gate kritis bisa butuh operator kedua" onClick={() => decide('approve', () => onApproveGate(decision.nodeId))}>{pending === 'approve' ? 'Menyetujui…' : 'Setujui'}</Button>
          <Button color="danger" variant="outline" size="sm" disabled={Boolean(pending)} title="Tolak gate ini dan hentikan run di sini" onClick={() => decide('reject', () => onRejectGate(decision.nodeId))}>{pending === 'reject' ? 'Menolak…' : 'Tolak'}</Button>
        </span>
      </div>
    );
  }
  if (!('planId' in decision)) return null;
  return (
    <div className="tl-decision" role="group" aria-label={`Rencana write ${label}`}>
      <span><strong>→ Rencana write</strong> {decision.text} <span className="mono tl-muted">({decision.endpointId}{decision.riskLevel ? ` · ${decision.riskLevel}` : ''})</span></span>
      <span className="tl-decision-actions">
        <Button color="write" size="sm" disabled={Boolean(pending)} title="Setujui; write dijalankan lewat gate dengan precondition dan verifikasi" onClick={() => decide('mutation', () => onApproveMutation(decision.planId))}>{pending === 'mutation' ? 'Menyetujui…' : 'Setujui rencana'}</Button>
      </span>
    </div>
  );
}

export function RunLogView({ onApproveGate, onRejectGate, onApproveMutation, onOpenNode }: RunLogViewProps) {
  const state = useRunStore((store) => store.state);
  const definition = useRunStore((store) => store.definition);
  const clearedThrough = useRunStore((store) => store.consoleClearedThroughSeq);
  const clearConsole = useRunStore((store) => store.clearConsole);
  const [debugMode, setDebugMode] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [query, setQuery] = useState('');
  // Rajal logs are aggregate ("3 kunjungan cocok"); the checklist is where each patient shows up.
  const [checks, setChecks] = useState(definition?.domain === 'rajal');
  // Ringkas: a batch of hundreds of patients reads as one count per step plus its problems.
  const [quiet, setQuiet] = useState(definition?.domain === 'rajal');
  const [hitCursor, setHitCursor] = useState(0);
  const [following, setFollowing] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  // A search looks through every line, so Ringkas steps aside while one is typed.
  const quietNow = quiet && !query.trim();
  const patients = useMemo(() => (definition ? patientTrails(definition, state) : []), [definition, state]);
  // A batch opens per patient; the operator's own pick then sticks.
  const [viewPick, setViewPick] = useState<'patients' | 'steps'>();
  const view = viewPick ?? (patients.length > 1 ? 'patients' : 'steps');
  // The step view's rows are only built when shown, or when a decision card needs them:
  // on a 500-patient batch they cost hundreds of ms on a slow PC for a hidden view.
  const decisionOpen = Boolean(state && (Object.values(state.nodes).some((node) => node.status === 'gate_waiting')
    || Object.values(state.mutations).some((mutation) => mutation.status === 'planned')));
  const needRows = view === 'steps' || decisionOpen;
  const allRows = useMemo(() => (definition && needRows ? terminalRows(definition, state, { checks, summary: quietNow }) : []), [definition, state, checks, quietNow, needRows]);
  const rows = useMemo(() => allRows.filter((row) => (row.kind === 'line'
    ? row.entry.seq > clearedThrough && (debugMode || row.entry.severity !== 'debug') && (!(problemsOnly || quietNow) || PROBLEM.has(row.entry.severity))
    : row.kind !== 'check' || !problemsOnly || row.item.ok === false)), [allRows, clearedThrough, debugMode, problemsOnly, quietNow]);
  const blocks = useMemo(() => stepBlocks(rows).filter((block) => !problemsOnly || !block.head || block.rows.length > 0 || PROBLEM_STATUS.has(block.end?.status ?? '')), [rows, problemsOnly]);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const waiting = openDecisions(rows);
  // End rows are drawn inside their block's header, so they are not search targets of their own.
  const hits = useMemo(() => rows.filter((row) => row.kind !== 'end' && logMatches(rowText(row), query)).map((row) => row.key), [query, rows]);
  const hitSet = useMemo(() => new Set(hits), [hits]);
  const current = hits.length ? hits[Math.min(hitCursor, hits.length - 1)] : undefined;
  const labelOf = (id: string) => definition?.nodes.find((node) => node.id === id)?.label ?? id;
  const steps = useMemo(() => {
    if (!definition) return [];
    const order = stepOrder(definition);
    return [...definition.nodes].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).map((node) => ({ id: node.id, label: node.label, index: order.get(node.id) ?? 0 }));
  }, [definition]);

  // Scrolls the log box only (scrollIntoView would also shift the page), and instantly: a smooth
  // scroll reports positions near the tail first, which re-arms auto-follow and snaps back down.
  const scrollToKey = useCallback((key: string | undefined, block: 'start' | 'center' = 'center') => {
    const logBox = box.current;
    const element = key ? logBox?.querySelector<HTMLElement>(`[data-row="${CSS.escape(key)}"]`) : null;
    if (!logBox || !element) return;
    setFollowing(false);
    // Rows sit inside step blocks, so offsetTop is not relative to the box; measure instead.
    const top = (element.getBoundingClientRect().top - logBox.getBoundingClientRect().top) / pageZoom() + logBox.scrollTop;
    logBox.scrollTo({ top: top - (block === 'center' ? (logBox.clientHeight - element.offsetHeight) / 2 : 8) });
  }, []);
  const jumpToStep = (nodeId: string) => {
    const key = rows.find((row) => (row.kind === 'divider' || row.kind === 'skip') && row.nodeId === nodeId)?.key;
    if (view === 'steps') scrollToKey(key, 'start');
    else { setViewPick('steps'); requestAnimationFrame(() => scrollToKey(key, 'start')); }
  };

  useEffect(() => { setChecks(definition?.domain === 'rajal'); setQuiet(definition?.domain === 'rajal'); }, [definition?.domain]);
  useEffect(() => { setHitCursor(0); }, [query]);
  useEffect(() => { if (current) scrollToKey(current); }, [current, scrollToKey]);
  const onScroll = () => {
    const element = box.current;
    if (element) setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_THRESHOLD_PX);
  };
  useEffect(() => {
    if (!following || !box.current) return;
    box.current.scrollTop = box.current.scrollHeight;
  }, [following, rows.length, state?.status]);
  const toLatest = () => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
    setFollowing(true);
  };

  if (!definition) return null;
  const renderRow = (row: TermRow) => {
    const hit = hitSet.has(row.key) ? (row.key === current ? ' is-hit is-current' : ' is-hit') : '';
    switch (row.kind) {
      case 'divider':
        return (
          <div key={row.key} data-row={row.key} className={`tl-divider${hit}`} onDoubleClick={() => onOpenNode(row.nodeId)} title="Klik ganda: buka di Inspector">
            <span className="tl-time">{row.time}</span> ── <b>[{row.index}/{row.total}] {row.label}</b>{row.continued ? ' (lanjutan)' : ''} <span className="tl-rule" aria-hidden="true" />
          </div>
        );
      case 'line':
        return (
          <div key={row.key} data-row={row.key} className={`tl-line${hit}`} data-shape={classifyLogLine(row.entry.message)} data-severity={row.entry.severity} title={`${logTime(row.entry.ts)} · ${row.entry.severity}`}>
            {PROBLEM.has(row.entry.severity) ? <span className="visually-hidden">{row.entry.severity}: </span> : null}
            {row.entry.message}
          </div>
        );
      case 'end':
        return (
          <div key={row.key} data-row={row.key} className={`tl-end${hit}`} data-status={row.status} onDoubleClick={() => onOpenNode(row.nodeId)}>
            <span className="tl-time">{row.time}</span> <span className="tl-mark">{row.mark}</span> [{row.index}/{row.total}] {row.label}{row.note ? <span className="tl-muted"> · {row.note}</span> : null}
          </div>
        );
      case 'skip':
        return <div key={row.key} data-row={row.key} className={`tl-end tl-skip${hit}`} data-status="skipped" onDoubleClick={() => onOpenNode(row.nodeId)}>{rowText(row)}</div>;
      case 'decision':
        return (
          <div key={row.key} data-row={row.key} className={hit.trim()}>
            <DecisionRow decision={row.decision} label={labelOf(row.decision.nodeId)} onApproveGate={onApproveGate} onRejectGate={onRejectGate} onApproveMutation={onApproveMutation} />
          </div>
        );
      case 'footer':
        return <div key={row.key} data-row={row.key} className={`tl-footer${hit}`} data-status={row.previewDone ? 'completed' : row.status}>{rowText(row)}</div>;
      case 'check':
        return (
          <div key={row.key} data-row={row.key} className={`tl-check-row${hit}`}>
            {row.title ? <div className="tl-check-title">{row.title}</div> : null}
            <div className="tl-check" data-ok={String(row.item.ok)}>
              <span className="tl-mark" aria-hidden="true">{checkMark(row.item)}</span>
              <span>{row.item.label}{row.item.detail ? <span className="tl-muted"> — {row.item.detail}</span> : null}</span>
            </div>
          </div>
        );
    }
  };
  // Head + tail of a very long block; search and an explicit click show it all.
  const renderBody = (block: LogBlock) => {
    const lines = block.rows.filter((row) => row.kind === 'line');
    if (lines.length <= LINE_FOLD || unfolded.has(block.key) || query.trim()) return block.rows.map(renderRow);
    const hidden = new Set<TermRow>(lines.slice(FOLD_KEEP, lines.length - FOLD_KEEP));
    const out = [];
    for (const [i, row] of block.rows.entries()) {
      if (!hidden.has(row)) out.push(renderRow(row));
      else if (!hidden.has(block.rows[i - 1]!)) {
        out.push(
          <button key={`${block.key}:fold`} type="button" className="tl-fold" onClick={() => setUnfolded((set) => new Set(set).add(block.key))}>
            ⋯ {hidden.size} baris disembunyikan — tampilkan semua
          </button>,
        );
      }
    }
    return out;
  };
  const renderBlock = (block: LogBlock) => {
    const { head, end } = block;
    if (!head) return block.rows.map(renderRow);
    const status = end?.status ?? (head.continued ? undefined : state?.nodes[head.nodeId]?.status);
    const hit = hitSet.has(head.key) ? (head.key === current ? ' is-hit is-current' : ' is-hit') : '';
    return (
      <section key={block.key} data-row={head.key} className="tl-block" data-status={status} aria-label={`[${head.index}/${head.total}] ${head.label}`}>
        <header className={`tl-block-head${hit}`} onDoubleClick={() => onOpenNode(head.nodeId)} title="Klik ganda: buka di Inspector">
          <span className="tl-step-no">{head.index}/{head.total}</span>
          <b>{head.label}{head.continued ? <span className="tl-muted"> (lanjutan)</span> : null}</b>
          <span className="tl-time">{head.time}</span>
          {end ? <span className="tl-block-status" data-status={end.status}><span className="tl-mark" aria-hidden="true">{end.mark}</span> {end.note || NODE_STATUS_LABEL[end.status]}</span> : null}
        </header>
        {block.rows.length ? <div className="tl-block-body">{renderBody(block)}</div> : null}
      </section>
    );
  };

  const toolbarEl = (
    <div className="tl-toolbar">
      <div className="tl-search" role="search">
        <input className="form-control" type="search" placeholder="Cari di log (teks / No. RM)…" aria-label="Cari di log" value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && hits.length) { event.preventDefault(); setHitCursor((i) => (i + (event.shiftKey ? hits.length - 1 : 1)) % hits.length); } }} />
        <span className="tl-hits" aria-live="polite">{query.trim() ? (hits.length ? `${Math.min(hitCursor, hits.length - 1) + 1}/${hits.length}` : '0 hasil') : ''}</span>
        <button type="button" className="tl-nav" aria-label="Hasil sebelumnya" disabled={hits.length === 0} onClick={() => setHitCursor((i) => (i + hits.length - 1) % hits.length)}>‹</button>
        <button type="button" className="tl-nav" aria-label="Hasil berikutnya" disabled={hits.length === 0} onClick={() => setHitCursor((i) => (i + 1) % hits.length)}>›</button>
      </div>
      <FormCheck id="tl-quiet" label="Ringkas" title="Per tahap cukup hitungan dan baris bermasalah — untuk batch besar. Baris lain tampil saat mencari." checked={quiet} onChange={setQuiet} />
      <FormCheck id="tl-checks" label="Rincian per kunjungan" title="Tampilkan checklist tiap tahap: hasil per pasien / kunjungan" checked={checks} onChange={setChecks} />
      <FormCheck id="tl-problems" label="Hanya masalah" title="Tampilkan hanya baris peringatan dan error" checked={problemsOnly} onChange={setProblemsOnly} />
      <FormCheck id="tl-debug" label="Mode debug" title="Tampilkan juga baris debug: no reg, no trx, sumber SEP, preflight gizi" checked={debugMode} onChange={setDebugMode} />
      <Button color="secondary" variant="outline" size="sm" onClick={clearConsole} disabled={!state?.logs.length}>Bersihkan</Button>
    </div>
  );

  return (
    <div className="run-log-view">
      <nav className="tl-steps" aria-label="Tahap run">
        <select className="form-select tl-steps-select" aria-label="Lompat ke tahap" value="" onChange={(event) => { if (event.target.value) jumpToStep(event.target.value); }}>
          <option value="">Lompat ke tahap…</option>
          {steps.map((step) => <option key={step.id} value={step.id}>{step.index}. {step.label}</option>)}
        </select>
        <ol className="tl-steps-list">
          {steps.map((step) => {
            const status = state?.nodes[step.id]?.status ?? 'pending';
            return (
              <li key={step.id}>
                <button type="button" data-status={status} title={`${NODE_STATUS_LABEL[status]} · klik: lompat di log · klik ganda: Inspector`} onClick={() => jumpToStep(step.id)} onDoubleClick={() => onOpenNode(step.id)}>
                  <span className="tl-mark" aria-hidden="true">{END_MARK[status] ?? '○'}</span>
                  <span className="tl-step-index">{step.index}</span>
                  <span className="tl-step-label">{step.label}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <section className="tl-main" aria-label="Log run">
        {patients.length ? (
          <div className="tl-viewbar" role="tablist" aria-label="Susunan log">
            <button type="button" role="tab" aria-selected={view === 'patients'} onClick={() => setViewPick('patients')}>Per pasien <b>{patients.length}</b></button>
            <button type="button" role="tab" aria-selected={view === 'steps'} onClick={() => setViewPick('steps')}>Per tahap</button>
            <span className="tl-viewbar-sum">
              {patients.filter((p) => p.status === 'dilewati').length} dilewati · {patients.filter((p) => p.status === 'lolos').length} lolos · {patients.filter((p) => p.status === 'proses').length} diproses
            </span>
          </div>
        ) : null}
        {view === 'steps' ? toolbarEl : null}
        {waiting.length ? (
          <button type="button" className="tl-waiting" onClick={() => { const key = waiting[0]!.key; if (view === 'steps') scrollToKey(key); else { setViewPick('steps'); requestAnimationFrame(() => scrollToKey(key)); } }}>
            ⏸ Menunggu keputusan ({waiting.length}) · {labelOf(waiting[0]!.decision.nodeId)} — klik untuk ke kartu
          </button>
        ) : null}
        {view === 'patients' ? <PatientLog patients={patients} runId={state?.runId} onOpenNode={onOpenNode} /> : (
          <div className="tl-box-shell">
            <div className="tl-box" ref={box} onScroll={onScroll} aria-live="polite">
              {rows.length ? blocks.map(renderBlock) : <div className="empty">Belum ada log. Mulai run atau tunggu event berikutnya.</div>}
            </div>
            {!following && rows.length ? <Button className="log-follow-pill" color="info" size="sm" onClick={toLatest}>Ke terbaru</Button> : null}
          </div>
        )}
      </section>
    </div>
  );
}
