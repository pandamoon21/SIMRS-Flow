import { useEffect, useMemo, useState } from 'react';
import { UnauthorizedError } from '../../api/client.js';
import { Alert, Card, CardBody, Col, Row, Spinner } from '../../ui/primitives.js';
import { BillingChart, GateOutcomePanel, KoreksiKelasPanel } from './BillingChart.js';
import { fetchBillingSummary, formatRupiahShort, type BillingSummary } from './billing.js';

export interface BillingPageProps {
  onUnauthorized: () => void;
}

export function BillingPage({ onUnauthorized }: BillingPageProps) {
  const [billing, setBilling] = useState<BillingSummary>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    fetchBillingSummary(controller.signal)
      .then(setBilling)
      .catch((err) => {
        if (err instanceof UnauthorizedError) onUnauthorized();
        else if (err.name !== 'AbortError') setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [onUnauthorized]);

  const stats = useMemo(() => {
    if (!billing) return undefined;
    const total = billing.days.reduce((sum, d) => sum + d.amount, 0);
    const avg = total / Math.max(1, billing.days.length);
    const today = billing.days.at(-1)?.amount ?? 0;
    const peak = Math.max(0, ...billing.days.map((d) => d.amount));
    return { total, avg, today, peak };
  }, [billing]);

  return (
    <div className="page-stack billing-page">
      <header className="page-heading">
        <div>
          <span className="page-eyebrow">SIMRS-Flow / nominal billing</span>
          <h1>Nominal billing</h1>
          <p>Nominal koreksi bayar tervalidasi per hari, plus rincian koreksi kelas dan hasil gate.</p>
        </div>
      </header>

      {error ? <Alert color="danger">Data billing tidak tersedia: {error}</Alert> : null}
      {loading ? <div className="page-loading" role="status"><Spinner size="sm" /> Memuat data billing…</div> : null}

      {stats ? (
        <Row className="g-3">
          <Col sm={6} xl={3}><Card className="metric-card metric-accent"><CardBody><span className="metric-label">Hari ini</span><strong className="metric-strong-sm">{formatRupiahShort(stats.today)}</strong><span className="metric-note">koreksi bayar tervalidasi</span></CardBody></Card></Col>
          <Col sm={6} xl={3}><Card className="metric-card"><CardBody><span className="metric-label">Total 14 hari</span><strong className="metric-strong-sm">{formatRupiahShort(stats.total)}</strong><span className="metric-note">akumulasi</span></CardBody></Card></Col>
          <Col sm={6} xl={3}><Card className="metric-card"><CardBody><span className="metric-label">Rata-rata / hari</span><strong className="metric-strong-sm">{formatRupiahShort(stats.avg)}</strong><span className="metric-note">14 hari terakhir</span></CardBody></Card></Col>
          <Col sm={6} xl={3}><Card className="metric-card"><CardBody><span className="metric-label">Puncak harian</span><strong className="metric-strong-sm">{formatRupiahShort(stats.peak)}</strong><span className="metric-note">hari tertinggi</span></CardBody></Card></Col>
        </Row>
      ) : null}

      {billing ? (
        <>
          <Row className="g-3"><Col xs={12}><BillingChart summary={billing} /></Col></Row>
          <Row className="g-3">
            <Col xl={6}><KoreksiKelasPanel summary={billing} /></Col>
            <Col xl={6}><GateOutcomePanel summary={billing} /></Col>
          </Row>
        </>
      ) : null}
    </div>
  );
}
