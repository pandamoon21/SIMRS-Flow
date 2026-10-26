import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, UnauthorizedError, type RunSummary } from '../../api/client.js';
import { displayTime, needsAttention, openRunTitle, runProvenanceLabel, runStatusColor, runStatusLabel, splitRuns } from '../history/RunHistory.js';
import type { DashboardPage } from '../../app/DashboardShell.js';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Col, RefreshButton, Row, Spinner } from '../../ui/primitives.js';
import { SkylineStrip } from '../../ui/decor.js';
import { BillingChart, GateOutcomePanel, KoreksiKelasPanel } from './BillingChart.js';
import { fetchBillingSummary, formatRupiahShort, type BillingSummary } from './billing.js';
import type { PatientFilter } from './RekapPage.js';
import { TeamBoard } from './TeamBoard.js';

export interface DashboardHomeProps {
  onNavigate: (page: DashboardPage) => void;
  onOpenRun: (run: RunSummary) => void;
  onOpenPatients: (filter: PatientFilter) => void;
  onUnauthorized: () => void;
}

export function DashboardHome({ onNavigate, onOpenRun, onOpenPatients, onUnauthorized }: DashboardHomeProps) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [health, setHealth] = useState<{ ok: boolean; ts: string }>();
  const [billing, setBilling] = useState<BillingSummary>();

  const load = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(undefined);
    try {
      const [runResponse, healthResponse, billingResponse] = await Promise.all([
        api.listRuns(),
        api.health(),
        fetchBillingSummary(),
      ]);
      setRuns(runResponse.runs);
      setHealth(healthResponse);
      setBilling(billingResponse);
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized();
      else setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  const { active, recent } = useMemo(() => splitRuns(runs), [runs]);
  const attention = runs.filter(needsAttention).length;
  const billingToday = billing?.days.at(-1)?.amount ?? 0;

  return (
    <div className="page-stack dashboard-home">
      <header className="page-heading">
        <div>
          <span className="page-eyebrow">SIMRS-Flow / operator desk</span>
          <h1>Overview</h1>
          <p>See what is running, what needs attention, and whether this host is ready.</p>
        </div>
        <div className="page-heading-actions">
          <Badge color={health?.ok ? 'success' : 'warning'}>{health?.ok ? 'Host online' : 'Host status unknown'}</Badge>
          <Button color="info" type="button" onClick={() => onNavigate('run')}>Start a run</Button>
        </div>
      </header>

      {error ? <Alert color="danger">Overview unavailable: {error}</Alert> : null}
      {loading && !health ? <div className="page-loading" role="status"><Spinner size="sm" /> Loading operational status…</div> : null}
      <SkylineStrip className="page-horizon" />

      <Row className="g-3">
        <Col sm={6} xl={4}><Card className="metric-card metric-accent" onClick={() => onNavigate('rekap')}><CardBody><span className="metric-label">Billing dikerjakan hari ini</span><strong className="metric-strong-sm">{formatRupiahShort(billingToday)}</strong><span className="metric-note">koreksi bayar tervalidasi</span></CardBody></Card></Col>
        <Col sm={6} xl={2}><Card className="metric-card metric-warn" onClick={() => onOpenPatients('titipan')}><CardBody><span className="metric-label">Pasien titipan</span><strong>{billing?.titipanToday ?? 0}</strong><span className="metric-note">beda kelas · tanpa bayar</span></CardBody></Card></Col>
        <Col sm={6} xl={2}><Card className="metric-card" onClick={() => onOpenPatients('naik_kelas')}><CardBody><span className="metric-label">Pasien naik kelas</span><strong>{billing?.naikKelasToday ?? 0}</strong><span className="metric-note">bayar selisih kelas</span></CardBody></Card></Col>
        <Col sm={6} xl={2}><Card className={`metric-card${attention > 0 ? ' metric-warn' : ''}`} onClick={() => onOpenPatients('attention')}><CardBody><span className="metric-label">Needs attention</span><strong>{attention}</strong><span className="metric-note">review before retrying</span></CardBody></Card></Col>
        <Col sm={6} xl={2}><Card className="metric-card" onClick={() => onNavigate('settings')}><CardBody><span className="metric-label">Service</span><strong>{health?.ok ? 'OK' : 'Check'}</strong><span className="metric-note">{health?.ts ? `checked ${displayTime(health.ts)}` : 'not checked'}</span></CardBody></Card></Col>
      </Row>

      {billing ? (
        <Row className="g-3">
          <Col xs={12}><BillingChart summary={billing} /></Col>
        </Row>
      ) : null}

      <Row className="g-3">
        <Col xl={7}>
          <Card className="surface-card">
            <CardHeader className="card-header-actions"><span>Active work</span><RefreshButton onRefresh={load} title="Muat ulang run aktif" /></CardHeader>
            <CardBody>
              {active.length === 0 ? <div className="empty">No active runs. Start a preview when ready.</div> : <div className="run-list">{active.map((run) => <RunRow key={run.runId} run={run} onOpenRun={onOpenRun} />)}</div>}
            </CardBody>
          </Card>
        </Col>
        <Col xl={5}>
          <Card className="surface-card">
            <CardHeader className="card-header-actions"><span>Recent attention</span><Button color="secondary" variant="outline" size="sm" onClick={() => onNavigate('history')}>View history</Button></CardHeader>
            <CardBody>
              {recent.slice(0, 5).map((run) => <RunRow key={run.runId} run={run} onOpenRun={onOpenRun} />)}
              {recent.length === 0 ? <div className="empty">No completed runs yet.</div> : null}
            </CardBody>
          </Card>
        </Col>
      </Row>

      <Row className="g-3">
        <Col xs={12}><TeamBoard onUnauthorized={onUnauthorized} /></Col>
      </Row>

      {billing ? (
        <Row className="g-3">
          <Col xl={6}><KoreksiKelasPanel summary={billing} /></Col>
          <Col xl={6}><GateOutcomePanel summary={billing} /></Col>
        </Row>
      ) : null}
    </div>
  );
}

function RunRow({ run, onOpenRun }: { run: RunSummary; onOpenRun: (run: RunSummary) => void }) {
  const attention = needsAttention(run);
  return (
    <div className="run-list-row">
      <div className="run-list-meta"><Badge color={runStatusColor(run)}>{runStatusLabel(run)}</Badge>{attention ? <Badge color="warning">Needs attention</Badge> : null}<span>{run.mode}</span><span>{displayTime(run.startedAt)}</span></div>
      <div className="run-list-main"><strong>{run.workflowId}</strong><span>{run.runId} · {runProvenanceLabel(run)}</span></div>
      <Button color="info" variant="outline" size="sm" disabled={!run.replayable} title={openRunTitle(run.replayable)} onClick={() => onOpenRun(run)}>Open</Button>
    </div>
  );
}
