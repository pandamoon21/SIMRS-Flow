/**
 * Overview billing visuals: a 14-day nominal-billing bar chart, and the
 * koreksi-kelas / gate-outcome breakdown panels. Presentational only — data is
 * fetched by DashboardHome and passed in.
 */

import { Card, CardBody, CardHeader } from '../../ui/primitives.js';
import { type BillingSummary, formatRupiah, formatRupiahShort } from './billing.js';
import { SeriesChart, type ChartType } from './SeriesChart.js';

export type { ChartType };

export interface BillingChartProps {
  summary: BillingSummary;
  type?: ChartType;
  /** ISO date picked in the chart; drives a date filter. */
  selectedDate?: string;
  onSelectDate?: (date: string) => void;
}

/** Overview: the trailing billing window (14 days) as a responsive chart. */
export function BillingChart({ summary, type = 'bar', selectedDate, onSelectDate }: BillingChartProps) {
  const total = summary.days.reduce((sum, d) => sum + d.amount, 0);
  const avg = total / Math.max(1, summary.days.length);
  const points = summary.days.map((d) => ({
    key: d.date,
    label: String(Number(d.date.slice(8, 10))),
    value: d.amount,
    title: `${d.date} · ${formatRupiah(d.amount)}`,
  }));
  return (
    <Card className="surface-card billing-chart-card">
      <CardHeader className="card-header-actions">
        <div className="billing-chart-head">
          <span className="metric-label">Nominal billing dikerjakan · {summary.days.length} hari</span>
          <div className="billing-chart-total">
            <strong>{formatRupiahShort(total)}</strong>
            <span>total · {formatRupiahShort(avg)}/hari rata-rata</span>
          </div>
        </div>
        <span className="billing-legend"><i className="billing-swatch" /> Rupiah / hari</span>
      </CardHeader>
      <CardBody>
        <SeriesChart
          points={points}
          type={type}
          format={formatRupiahShort}
          currentKey={summary.days.at(-1)?.date}
          {...(selectedDate ? { selectedKey: selectedDate } : {})}
          {...(onSelectDate ? { onSelect: onSelectDate } : {})}
          ariaLabel={`Grafik nominal billing ${summary.days.length} hari terakhir`}
        />
      </CardBody>
    </Card>
  );
}

function Bar({ label, sub, value, pct, tone }: { label: string; sub?: string; value: string; pct: number; tone: string }) {
  return (
    <div className="mini-bar-row">
      <div className="mini-bar-head">
        <span>{label}</span>
        <strong className={`mini-bar-value tone-${tone}`}>{value}</strong>
      </div>
      <div className="mini-bar-track"><div className={`mini-bar-fill tone-${tone}`} style={{ width: `${pct}%` }} /></div>
      {sub ? <span className="mini-bar-sub">{sub}</span> : null}
    </div>
  );
}

export function KoreksiKelasPanel({ summary }: { summary: BillingSummary }) {
  const totalPatients = summary.titipanToday + summary.naikKelasToday;
  const pct = (n: number) => (totalPatients === 0 ? 0 : Math.round((n / totalPatients) * 100));
  return (
    <Card className="surface-card">
      <CardHeader className="card-header-actions">
        <span>Koreksi kelas · hari ini</span>
        <span className="metric-note">{summary.titipanToday} + {summary.naikKelasToday} pasien</span>
      </CardHeader>
      <CardBody>
        <Bar label="Pasien titipan" sub="beda kelas · tanpa bayar selisih" value={String(summary.titipanToday)} pct={pct(summary.titipanToday)} tone="warning" />
        <Bar label="Pasien naik kelas" sub="bayar selisih kelas" value={String(summary.naikKelasToday)} pct={pct(summary.naikKelasToday)} tone="info" />
      </CardBody>
    </Card>
  );
}

export function GateOutcomePanel({ summary }: { summary: BillingSummary }) {
  const { approved, rejected, pending } = summary.gate;
  const total = Math.max(1, approved + rejected + pending);
  const decided = Math.max(1, approved + rejected);
  const approvalRate = Math.round((approved / decided) * 100);
  return (
    <Card className="surface-card">
      <CardHeader className="card-header-actions">
        <span>Hasil gate</span>
        <div className="billing-chart-total gate-rate">
          <strong className="tone-success">{approvalRate}%</strong>
          <span>approval rate</span>
        </div>
      </CardHeader>
      <CardBody>
        <Bar label="Approved" value={`${approved} · ${Math.round((approved / total) * 100)}%`} pct={Math.round((approved / total) * 100)} tone="success" />
        <Bar label="Rejected" value={`${rejected} · ${Math.round((rejected / total) * 100)}%`} pct={Math.round((rejected / total) * 100)} tone="danger" />
        <Bar label="Pending" value={`${pending} · ${Math.round((pending / total) * 100)}%`} pct={Math.round((pending / total) * 100)} tone="warning" />
      </CardBody>
    </Card>
  );
}
