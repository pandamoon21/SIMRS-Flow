import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, UnauthorizedError, type RunSummary } from '../../api/client.js';
import { Alert, Badge, Button, Card, CardBody, CardHeader, RefreshButton, Spinner, Table, TableBody, TableDataCell, TableHead, TableHeaderCell, TableRow } from '../../ui/primitives.js';
import { durationLabel, RUN_STATUS_LABEL } from '../run/runStatus.js';
import { withViewTransition } from '../../ui/motion.js';
import { toast } from '../../ui/toast.js';

const ACTIVE_STATUSES = new Set<RunSummary['status']>(['created', 'running', 'paused']);

export function splitRuns(runs: RunSummary[]): { active: RunSummary[]; recent: RunSummary[] } {
  return {
    active: runs.filter((run) => ACTIVE_STATUSES.has(run.status)),
    recent: runs.filter((run) => !ACTIVE_STATUSES.has(run.status)),
  };
}

export function displayTime(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

const RELATIVE = new Intl.RelativeTimeFormat('id', { numeric: 'auto' });
const STEPS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [['day', 86_400_000], ['hour', 3_600_000], ['minute', 60_000]];

/** "5 menit yang lalu" — scanning a list, the age matters more than the clock time. */
export function relativeTime(value: string | undefined, now = Date.now()): string {
  const at = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return '—';
  const diff = at - now;
  for (const [unit, ms] of STEPS) {
    if (Math.abs(diff) >= ms) return RELATIVE.format(Math.round(diff / ms), unit);
  }
  return 'baru saja';
}

export function runDuration(run: Pick<RunSummary, 'startedAt' | 'finishedAt'>): string {
  const ms = run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : NaN;
  return Number.isFinite(ms) && ms >= 0 ? durationLabel(ms) : '—';
}

const STATUS_LABEL: Record<RunSummary['status'], string> = { ...RUN_STATUS_LABEL, interrupted: 'Terputus', unreplayable: 'Tanpa log' };

/**
 * A preview that stopped only because preview holds the final gate (see
 * previewGateStopOf). The list has no node states, so this reads the run's
 * reason, which RunService words as `... blocked: Preview mode — gate held`.
 */
export function isPreviewGateStop(run: Pick<RunSummary, 'mode' | 'status' | 'reason'>): boolean {
  return run.mode === 'preview' && run.status === 'failed' && /Preview mode — gate held/.test(run.reason ?? '');
}

export function runStatusLabel(run: Pick<RunSummary, 'mode' | 'status' | 'reason'>): string {
  return isPreviewGateStop(run) ? 'Preview selesai' : STATUS_LABEL[run.status];
}

export function runStatusColor(run: Pick<RunSummary, 'mode' | 'status' | 'reason'>): ReturnType<typeof statusColor> {
  return isPreviewGateStop(run) ? 'success' : statusColor(run.status);
}

export function statusColor(status: RunSummary['status']): 'success' | 'danger' | 'warning' | 'info' | 'secondary' {
  if (status === 'completed') return 'success';
  if (status === 'failed' || status === 'interrupted') return 'danger';
  if (status === 'paused' || status === 'unreplayable') return 'warning';
  if (status === 'running') return 'info';
  return 'secondary';
}

export function needsAttention(run: RunSummary): boolean {
  if (isPreviewGateStop(run)) return false;
  return run.status === 'failed' || run.status === 'paused' || run.status === 'unreplayable';
}

export function runProvenanceLabel(run: RunSummary): string {
  return run.source === 'ledger' ? 'Historical ledger' : 'In-memory run';
}

/** A disabled control has to say why; "Open" is disabled whenever a run has no replayable log. */
export function openRunTitle(replayable: boolean): string {
  return replayable ? 'Open this run on the canvas' : 'No replayable event log was recorded for this run';
}

export type RunFilter = 'all' | 'active' | 'attention' | 'completed' | 'failed';

export const RUN_FILTERS: ReadonlyArray<{ id: RunFilter; label: string; test: (run: RunSummary) => boolean }> = [
  { id: 'all', label: 'Semua', test: () => true },
  { id: 'active', label: 'Aktif', test: (run) => ACTIVE_STATUSES.has(run.status) },
  { id: 'attention', label: 'Perlu perhatian', test: needsAttention },
  { id: 'completed', label: 'Selesai', test: (run) => run.status === 'completed' || isPreviewGateStop(run) },
  { id: 'failed', label: 'Gagal', test: (run) => (run.status === 'failed' && !isPreviewGateStop(run)) || run.status === 'interrupted' },
];

export function filterRuns(runs: RunSummary[], filter: RunFilter, workflowId: string, query: string): RunSummary[] {
  const test = RUN_FILTERS.find((item) => item.id === filter)?.test ?? (() => true);
  const needle = query.trim().toLowerCase();
  return runs
    .filter((run) => test(run)
      && (!workflowId || run.workflowId === workflowId)
      && (!needle || run.runId.toLowerCase().includes(needle) || (run.operator ?? '').toLowerCase().includes(needle)))
    // Live runs float to the top; the stable sort keeps newest-first within each group.
    .sort((a, b) => Number(ACTIVE_STATUSES.has(b.status)) - Number(ACTIVE_STATUSES.has(a.status)));
}

const PAGE_SIZE = 50;
const POLL_MS = 10_000;

export interface RunHistoryProps {
  onOpenRun: (run: RunSummary) => void;
  onUnauthorized: () => void;
  /** Workflow id → operator-facing label. */
  workflowLabels?: Record<string, string>;
}

export function RunHistory({ onOpenRun, onUnauthorized, workflowLabels = {} }: RunHistoryProps) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<RunFilter>('all');
  const [workflowId, setWorkflowId] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  // Refreshing keeps the current rows on screen; only the first load shows the empty spinner.
  const load = useCallback(async (): Promise<boolean> => {
    try {
      setRuns((await api.listRuns()).runs);
      setError(undefined);
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setLoaded(true);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const { active } = useMemo(() => splitRuns(runs), [runs]);
  // ponytail: polls only while something is running; an SSE run index would replace this.
  useEffect(() => {
    if (active.length === 0) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active.length, load]);

  const visible = useMemo(() => filterRuns(runs, filter, workflowId, query), [filter, query, runs, workflowId]);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const rows = visible.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const workflowIds = useMemo(() => [...new Set(runs.map((run) => run.workflowId))], [runs]);
  const change = (update: () => void) => withViewTransition(() => { update(); setPage(0); });

  return (
    <Card className="history-card">
      <CardHeader className="history-head">
        <span>Run history</span>
        <RefreshButton onRefresh={load} disabled={!loaded} title="Muat ulang daftar run" />
      </CardHeader>
      <CardBody>
        {error ? <Alert color="danger">Riwayat run tidak dapat dimuat: {error}</Alert> : null}
        <div className="history-toolbar">
          <div className="patient-filters" role="group" aria-label="Filter status run">
            {RUN_FILTERS.map((item) => (
              <button key={item.id} type="button" className={`patient-filter${filter === item.id ? ' is-on' : ''}`} aria-pressed={filter === item.id} onClick={() => change(() => setFilter(item.id))}>
                {item.label}<span className="patient-filter-count">{runs.filter(item.test).length}</span>
              </button>
            ))}
          </div>
          <label className="rekap-control">
            Workflow
            <select value={workflowId} onChange={(event) => { const value = event.target.value; change(() => setWorkflowId(value)); }}>
              <option value="">Semua workflow</option>
              {workflowIds.map((id) => <option key={id} value={id}>{workflowLabels[id] ?? id}</option>)}
            </select>
          </label>
          <label className="rekap-control history-search">
            Cari
            <input type="search" placeholder="Run ID atau operator" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
          </label>
        </div>
        {!loaded ? (
          <div className="history-state" role="status"><Spinner size="sm" /> Memuat riwayat run…</div>
        ) : runs.length === 0 ? (
          <div className="history-state">Belum ada run yang tercatat.</div>
        ) : visible.length === 0 ? (
          <div className="history-state">
            Tidak ada run yang cocok.{' '}
            <button type="button" className="rekap-clear" onClick={() => change(() => { setFilter('all'); setWorkflowId(''); setQuery(''); })}>Reset filter</button>
          </div>
        ) : (
          <>
            <div className="table-responsive">
              <Table align="middle" hover>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell scope="col">Mulai</TableHeaderCell>
                    <TableHeaderCell scope="col">Workflow</TableHeaderCell>
                    <TableHeaderCell scope="col">Status</TableHeaderCell>
                    <TableHeaderCell scope="col">Durasi</TableHeaderCell>
                    <TableHeaderCell scope="col">Mode</TableHeaderCell>
                    <TableHeaderCell scope="col">Operator</TableHeaderCell>
                    <TableHeaderCell scope="col">Aksi</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((run) => (
                    <TableRow key={run.runId} className={ACTIVE_STATUSES.has(run.status) ? 'history-row-active' : ''}>
                      <TableDataCell><span title={displayTime(run.startedAt)}>{relativeTime(run.startedAt)}</span></TableDataCell>
                      <TableDataCell>
                        <strong>{workflowLabels[run.workflowId] ?? run.workflowId}</strong>
                        <div className="history-run-id" title={runProvenanceLabel(run)}>{run.runId}</div>
                      </TableDataCell>
                      <TableDataCell>
                        <Badge color={runStatusColor(run)}>{runStatusLabel(run)}</Badge>
                        {needsAttention(run) ? <span className="history-attention">Perlu perhatian</span> : null}
                        {run.reason ? <div className="history-reason">{run.reason}</div> : null}
                      </TableDataCell>
                      <TableDataCell className="mono">{runDuration(run)}</TableDataCell>
                      <TableDataCell>{run.mode}</TableDataCell>
                      <TableDataCell>{run.operator ?? '—'}</TableDataCell>
                      <TableDataCell>
                        <div className="history-actions">
                          <Button color="info" variant="outline" size="sm" type="button" disabled={!run.replayable} title={openRunTitle(run.replayable)} onClick={() => onOpenRun(run)}>
                            {ACTIVE_STATUSES.has(run.status) ? 'Pantau' : 'Open'}
                          </Button>
                          <a className="btn btn-outline-secondary btn-sm" href={api.exportRunUrl(run.runId)} title="Download the redacted JSONL audit trail" download onClick={() => toast('info', `Mengunduh audit trail · ${run.runId}`)}>
                            Export
                          </a>
                        </div>
                      </TableDataCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {pages > 1 ? (
              <div className="rekap-pager">
                <span className="rekap-pager-info">{current * PAGE_SIZE + 1}–{current * PAGE_SIZE + rows.length} dari {visible.length}</span>
                <div className="rekap-pager-controls">
                  <button type="button" className="rekap-page-btn" aria-label="Halaman sebelumnya" disabled={current === 0} onClick={() => setPage(current - 1)}>‹</button>
                  <span className="rekap-page-current">Hal {current + 1} / {pages}</span>
                  <button type="button" className="rekap-page-btn" aria-label="Halaman berikutnya" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>›</button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardBody>
    </Card>
  );
}
