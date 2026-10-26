import { useEffect, useMemo, useRef, useState } from 'react';
import { UnauthorizedError } from '../../api/client.js';
import { Alert, Badge, Button, ButtonGroup, Card, CardBody, CardHeader, Col, FormInput, Row, Spinner, type Tone } from '../../ui/primitives.js';
import { Icon, type IconName } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { withViewTransition } from '../../ui/motion.js';
import { pageWindow, type PerPage } from '../table/paging.js';
import { downloadXlsx, Pager, PrintMenu } from '../table/TableKit.js';
import type { PrintDoc } from '../table/print.js';
import { GateOutcomePanel, KoreksiKelasPanel } from './BillingChart.js';
import { SeriesChart, type ChartType } from './SeriesChart.js';
import { fetchBillingSummary, formatRupiah, formatRupiahShort, type BillingSummary } from './billing.js';
import { CATEGORY_LABEL, SHIFT_LABEL, WORKFLOW_LABEL, fetchPatients, type PatientCategory, type ProcessedPatient } from './patients.js';
import {
  EMPTY_REKAP_FILTER,
  PERIODS,
  categoryCounts,
  deltaPct,
  filterExceptCategory,
  inRange,
  isoDay,
  matchesCategory,
  periodRange,
  previousRange,
  seriesOf,
  sortPatients,
  totalsOf,
  type PeriodId,
  type RekapFilter,
  type RekapSortKey,
} from './rekapData.js';

export type PatientFilter = RekapFilter['category'];

const CATEGORY_TABS: ReadonlyArray<{ id: PatientFilter; label: string }> = [
  { id: 'all', label: 'Semua' },
  { id: 'titipan', label: 'Titipan' },
  { id: 'naik_kelas', label: 'Naik kelas' },
  { id: 'normal', label: 'Normal' },
  { id: 'attention', label: 'Perlu ditinjau' },
];

const CATEGORY_TONE: Record<PatientCategory, Tone> = { titipan: 'warning', naik_kelas: 'info', normal: 'secondary' };

const CHART_TYPES: ReadonlyArray<{ id: ChartType; label: string; icon: IconName }> = [
  { id: 'bar', label: 'Batang', icon: 'chart-bar' },
  { id: 'line', label: 'Garis', icon: 'chart-line' },
  { id: 'area', label: 'Area', icon: 'chart-area' },
];

const COLUMNS: ReadonlyArray<{ key: RekapSortKey; label: string; numeric?: boolean; width: number }> = [
  { key: 'noRm', label: 'No. RM', width: 13 },
  { key: 'name', label: 'Nama', width: 26 },
  { key: 'workflow', label: 'Workflow', width: 12 },
  { key: 'date', label: 'Tanggal', width: 17 },
  { key: 'shift', label: 'Shift', width: 9 },
  { key: 'category', label: 'Kategori', width: 12 },
  { key: 'operator', label: 'Operator', width: 18 },
  { key: 'nominal', label: 'Nominal', numeric: true, width: 14 },
  { key: 'status', label: 'Status', width: 14 },
];

function cellText(p: ProcessedPatient, key: RekapSortKey): string {
  switch (key) {
    case 'workflow': return WORKFLOW_LABEL[p.workflow];
    case 'date': return `${p.date} ${p.time}`;
    case 'shift': return `Shift ${p.shift}`;
    case 'category': return CATEGORY_LABEL[p.category];
    case 'nominal': return formatRupiah(p.nominal);
    case 'status': return p.status === 'needs_review' ? 'Perlu ditinjau' : 'Selesai';
    default: return String(p[key]);
  }
}

/** A chart bar narrows the table to that day / month / shift. */
type ChartPick = { unit: 'day' | 'month' | 'shift'; key: string; label: string };

function Delta({ pct }: { pct: number | undefined }) {
  if (pct === undefined) return <span className="metric-note">tidak ada pembanding</span>;
  const tone = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  return <span className={`rekap-delta is-${tone}`}>{pct > 0 ? '▲' : pct < 0 ? '▼' : '='} {Math.abs(pct)}% vs periode sebelumnya</span>;
}

export interface RekapPageProps {
  onUnauthorized: () => void;
  initialFilter?: PatientFilter;
}

export function RekapPage({ onUnauthorized, initialFilter = 'all' }: RekapPageProps) {
  const [billing, setBilling] = useState<BillingSummary>();
  const [patients, setPatients] = useState<ProcessedPatient[]>([]);
  const [demo, setDemo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const today = isoDay(new Date());
  const now = useMemo(() => new Date(), [today]);
  const [period, setPeriod] = useState<PeriodId>('month');
  const [filter, setFilter] = useState<RekapFilter>(() => {
    const [from, to] = periodRange('month', new Date());
    return { ...EMPTY_REKAP_FILTER, from, to, category: initialFilter };
  });
  const [pick, setPick] = useState<ChartPick>();
  const [chartType, setChartType] = useState<ChartType>('bar');
  const [sort, setSort] = useState<{ key: RekapSortKey; dir: 'asc' | 'desc' }>({ key: 'date', dir: 'desc' });
  const [perPage, setPerPage] = useState<PerPage>(25);
  const [page, setPage] = useState(1);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => setFilter((f) => ({ ...f, category: initialFilter })), [initialFilter]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    Promise.all([fetchBillingSummary(controller.signal), fetchPatients(controller.signal)])
      .then(([b, p]) => { setBilling(b); setPatients(p.patients); setDemo(Boolean(b.demo || p.demo)); })
      .catch((err) => {
        if (err instanceof UnauthorizedError) onUnauthorized();
        else if (err.name !== 'AbortError') setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [onUnauthorized]);

  const choosePeriod = (id: Exclude<PeriodId, 'custom'>) => withViewTransition(() => {
    const [from, to] = periodRange(id, now);
    setPeriod(id);
    setPick(undefined);
    setFilter((f) => ({ ...f, from, to }));
  });
  const setRange = (from: string, to: string) => { setPeriod('custom'); setPick(undefined); setFilter((f) => ({ ...f, from, to })); };

  /** The four fixed periods, always visible: "hari / minggu / bulan / tahun ini". */
  const periodCards = useMemo(() => (['today', 'week', 'month', 'year'] as const).map((id) => {
    const [from, to] = periodRange(id, now);
    const t = totalsOf(patients.filter((p) => inRange(p.date, from, to)));
    return { id, label: PERIODS.find((x) => x.id === id)!.label, from, to, ...t };
  }), [patients, now]);

  // Selected period (cards + chart); the table adds every other filter on top.
  const inPeriod = useMemo(() => patients.filter((p) => inRange(p.date, filter.from, filter.to)), [patients, filter.from, filter.to]);
  const totals = useMemo(() => totalsOf(inPeriod), [inPeriod]);
  const prevTotals = useMemo(() => {
    const prev = previousRange(filter.from, filter.to);
    return prev ? totalsOf(patients.filter((p) => inRange(p.date, prev[0], prev[1]))) : undefined;
  }, [patients, filter.from, filter.to]);
  const series = useMemo(() => seriesOf(inPeriod, filter.from, filter.to, formatRupiah), [inPeriod, filter.from, filter.to]);

  const pickMatches = (p: ProcessedPatient) =>
    !pick || (pick.unit === 'day' ? p.date === pick.key : pick.unit === 'month' ? p.date.startsWith(pick.key) : String(p.shift) === pick.key);
  const base = useMemo(() => filterExceptCategory(patients, filter).filter(pickMatches), [patients, filter, pick]);
  const counts = useMemo(() => categoryCounts(base), [base]);
  const rows = useMemo(() => sortPatients(base.filter((p) => matchesCategory(p, filter.category)), sort.key, sort.dir), [base, filter.category, sort]);
  const rowsNominal = useMemo(() => rows.reduce((n, p) => n + p.nominal, 0), [rows]);
  const operators = useMemo(() => [...new Set(patients.map((p) => p.operator))].sort(), [patients]);

  useEffect(() => setPage(1), [filter, pick, perPage, sort]);
  const win = pageWindow(rows.length, perPage, page);
  const pageRows = rows.slice(win.start, win.end);
  const goPage = (next: number) => { setPage(next); scrollRef.current?.scrollTo({ top: 0 }); };

  const set = <K extends keyof RekapFilter>(key: K, value: RekapFilter[K]) => setFilter((f) => ({ ...f, [key]: value }));
  const periodLabel = period === 'custom'
    ? `${filter.from || '…'} – ${filter.to || '…'}`
    : `${PERIODS.find((p) => p.id === period)?.label}${filter.from ? ` (${filter.from === filter.to ? filter.from : `${filter.from} – ${filter.to}`})` : ''}`;

  const chips = [
    filter.query ? { label: `Cari “${filter.query}”`, clear: () => set('query', '') } : null,
    pick ? { label: pick.label, clear: () => setPick(undefined) } : null,
    filter.category !== 'all' ? { label: CATEGORY_TABS.find((c) => c.id === filter.category)!.label, clear: () => set('category', 'all') } : null,
    filter.workflow ? { label: WORKFLOW_LABEL[filter.workflow], clear: () => set('workflow', '') } : null,
    filter.shift ? { label: SHIFT_LABEL[Number(filter.shift) as 1 | 2 | 3], clear: () => set('shift', '') } : null,
    filter.status ? { label: filter.status === 'needs_review' ? 'Perlu ditinjau' : 'Selesai', clear: () => set('status', '') } : null,
    filter.operator ? { label: filter.operator, clear: () => set('operator', '') } : null,
  ].filter((c): c is { label: string; clear: () => void } => Boolean(c));
  const resetTableFilters = () => { setPick(undefined); setFilter((f) => ({ ...EMPTY_REKAP_FILTER, from: f.from, to: f.to })); };

  const onChartSelect = (key: string) => {
    if (pick?.key === key) return setPick(undefined);
    const point = series.points.find((p) => p.key === key);
    setPick({ unit: series.unit, key, label: point?.title.split(' · ')[0] ?? key });
  };

  const toggleSort = (key: RekapSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'nominal' || key === 'date' ? 'desc' : 'asc' }));

  const fileStem = `rekap-pasien-${filter.from || 'awal'}_${filter.to || today}`;
  const exportXlsx = () => downloadXlsx(
    fileStem,
    'Rekap pasien',
    [...COLUMNS.map((c) => c.label), 'Run ID'],
    rows.map((p) => [...COLUMNS.map((c) => (c.key === 'nominal' ? p.nominal : cellText(p, c.key))), p.runId]),
    [...COLUMNS.map((c) => c.width), 30],
  );
  const printDoc = (): PrintDoc => ({
    title: 'Rekapitulasi Pasien',
    subtitle: [periodLabel, ...chips.map((c) => c.label)].join(' · '),
    stats: [
      { label: 'Pasien', value: String(rows.length) },
      { label: 'Nominal', value: formatRupiah(rowsNominal) },
      { label: 'Titipan', value: String(rows.filter((p) => p.category === 'titipan').length) },
      { label: 'Naik kelas', value: String(rows.filter((p) => p.category === 'naik_kelas').length) },
    ],
    columns: COLUMNS.map((c) => ({ key: c.key, label: c.label, numeric: Boolean(c.numeric), nowrap: c.key === 'noRm' || c.key === 'date' })),
    rows: rows.map((p) => Object.fromEntries(COLUMNS.map((c) => [c.key, cellText(p, c.key)]))),
  });
  async function copyTable() {
    const tsv = [COLUMNS.map((c) => c.label).join('\t'), ...rows.map((p) => COLUMNS.map((c) => cellText(p, c.key)).join('\t'))].join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      toast('success', `${rows.length} baris disalin`);
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('danger', 'Gagal menyalin ke clipboard — gunakan Export XLSX.');
    }
  }

  const unitLabel = series.unit === 'shift' ? 'per shift' : series.unit === 'day' ? 'per hari' : 'per bulan';

  return (
    <div className="page-stack rekap-page">
      <header className="page-heading">
        <div>
          <span className="page-eyebrow">SIMRS-Flow / rekapitulasi</span>
          <h1>Rekapitulasi</h1>
          <p>Nominal koreksi bayar tervalidasi dan daftar pasien yang telah dikerjakan, per hari, minggu, bulan, dan tahun.</p>
        </div>
        <div className="page-heading-actions">
          {demo ? <span className="rekap-demo-chip" title="Angka dan pasien di halaman ini adalah data contoh dari placeholder, bukan data SIMRS.">Data demo</span> : null}
        </div>
      </header>

      {error ? <Alert color="danger">Data rekapitulasi tidak tersedia: {error}</Alert> : null}
      {loading ? <div className="page-loading" role="status"><Spinner size="sm" /> Memuat rekapitulasi…</div> : null}

      <div className="rekap-periods" role="group" aria-label="Ringkasan per periode">
        {periodCards.map((c) => (
          <button key={c.id} type="button" className={`rekap-period-card${period === c.id ? ' is-on' : ''}`} aria-pressed={period === c.id} onClick={() => choosePeriod(c.id)}>
            <span className="metric-label">{c.label}</span>
            <strong>{formatRupiahShort(c.nominal)}</strong>
            <span className="metric-note">{c.count} pasien · {c.titipan} titipan · {c.naikKelas} naik kelas</span>
          </button>
        ))}
      </div>

      <div className="rekap-range">
        <div className="patient-filters" role="group" aria-label="Periode">
          {PERIODS.map((p) => (
            <button key={p.id} type="button" className={`patient-filter${period === p.id ? ' is-on' : ''}`} aria-pressed={period === p.id} onClick={() => choosePeriod(p.id)}>{p.label}</button>
          ))}
        </div>
        <label className="rekap-control"><span>Dari</span><input type="date" value={filter.from} max={filter.to || undefined} onChange={(e) => setRange(e.target.value, filter.to)} /></label>
        <label className="rekap-control"><span>Sampai</span><input type="date" value={filter.to} min={filter.from || undefined} onChange={(e) => setRange(filter.from, e.target.value)} /></label>
      </div>

      <Row className="g-3">
        <Col sm={6} xl={3}><Card className="metric-card metric-accent"><CardBody><span className="metric-label">Nominal · {periodLabel}</span><strong className="metric-strong-sm">{formatRupiahShort(totals.nominal)}</strong><Delta pct={prevTotals ? deltaPct(totals.nominal, prevTotals.nominal) : undefined} /></CardBody></Card></Col>
        <Col sm={6} xl={3}><Card className="metric-card"><CardBody><span className="metric-label">Pasien dikerjakan</span><strong className="metric-strong-sm">{totals.count}</strong><Delta pct={prevTotals ? deltaPct(totals.count, prevTotals.count) : undefined} /></CardBody></Card></Col>
        <Col sm={6} xl={3}><Card className="metric-card"><CardBody><span className="metric-label">Titipan / naik kelas</span><strong className="metric-strong-sm">{totals.titipan} / {totals.naikKelas}</strong><span className="metric-note">rata-rata {formatRupiahShort(totals.count ? totals.nominal / totals.count : 0)} per pasien</span></CardBody></Card></Col>
        <Col sm={6} xl={3}><Card className={`metric-card${totals.attention ? ' metric-warn' : ''}`}><CardBody><span className="metric-label">Perlu ditinjau</span><strong className="metric-strong-sm">{totals.attention}</strong><span className="metric-note">{totals.attention ? <button type="button" className="rekap-link" onClick={() => set('category', 'attention')}>tampilkan di tabel</button> : 'tidak ada'}</span></CardBody></Card></Col>
      </Row>

      <Card className="surface-card billing-chart-card">
        <CardHeader className="card-header-actions">
          <div className="billing-chart-head">
            <span className="metric-label">Nominal {unitLabel} · {periodLabel}</span>
            <div className="billing-chart-total"><strong>{formatRupiahShort(totals.nominal)}</strong><span>pilih batang untuk menyaring tabel</span></div>
          </div>
          <ButtonGroup size="sm" aria-label="Pilih tipe grafik">
            {CHART_TYPES.map((c) => (
              <Button key={c.id} color="secondary" variant={chartType === c.id ? undefined : 'outline'} aria-pressed={chartType === c.id} onClick={() => setChartType(c.id)}>
                <Icon name={c.icon} size={16} /> <span className="rekap-chart-type-label">{c.label}</span>
              </Button>
            ))}
          </ButtonGroup>
        </CardHeader>
        <CardBody>
          <SeriesChart
            points={series.points}
            type={chartType}
            format={formatRupiahShort}
            {...(pick ? { selectedKey: pick.key } : {})}
            currentKey={series.unit === 'day' ? today : series.unit === 'month' ? today.slice(0, 7) : undefined}
            onSelect={onChartSelect}
            ariaLabel={`Grafik nominal ${unitLabel}, ${periodLabel}`}
          />
        </CardBody>
      </Card>

      {billing ? (
        <Row className="g-3">
          <Col xl={6}><KoreksiKelasPanel summary={billing} /></Col>
          <Col xl={6}><GateOutcomePanel summary={billing} /></Col>
        </Row>
      ) : null}

      <div className="naik-search">
        <Icon name="search" size={16} aria-hidden="true" />
        <FormInput type="search" value={filter.query} onChange={(e) => set('query', e.target.value)} placeholder="Cari No. RM (123456 / 0-12-34-56), nama, operator, run ID" aria-label="Cari pasien" />
      </div>

      <div className="patient-filters" role="group" aria-label="Filter kategori pasien">
        {CATEGORY_TABS.map((f) => (
          <button key={f.id} type="button" className={`patient-filter${filter.category === f.id ? ' is-on' : ''}`} aria-pressed={filter.category === f.id} onClick={() => set('category', f.id)}>
            {f.label}<span className="patient-filter-count">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      <div className="rekap-toolbar">
        <label className="rekap-control"><span>Workflow</span>
          <select value={filter.workflow} onChange={(e) => set('workflow', e.target.value as RekapFilter['workflow'])}>
            <option value="">Semua</option><option value="ranap">{WORKFLOW_LABEL.ranap}</option><option value="rajal">{WORKFLOW_LABEL.rajal}</option>
          </select>
        </label>
        <label className="rekap-control"><span>Shift</span>
          <select value={filter.shift} onChange={(e) => set('shift', e.target.value as RekapFilter['shift'])}>
            <option value="">Semua shift</option>{([1, 2, 3] as const).map((s) => <option key={s} value={String(s)}>{SHIFT_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="rekap-control"><span>Status</span>
          <select value={filter.status} onChange={(e) => set('status', e.target.value as RekapFilter['status'])}>
            <option value="">Semua</option><option value="done">Selesai</option><option value="needs_review">Perlu ditinjau</option>
          </select>
        </label>
        <label className="rekap-control"><span>Operator</span>
          <select value={filter.operator} onChange={(e) => set('operator', e.target.value)}>
            <option value="">Semua operator</option>{operators.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      </div>

      {chips.length ? (
        <div className="filter-chips" aria-label="Filter aktif">
          <ul className="chip-list">
            {chips.map((c) => <li className="chip" key={c.label}>{c.label}<button type="button" className="chip-remove" aria-label={`Hapus filter ${c.label}`} onClick={c.clear}>×</button></li>)}
          </ul>
          <button type="button" className="rekap-clear" onClick={resetTableFilters}>Reset filter tabel</button>
        </div>
      ) : null}

      <Card className="surface-card rekap-table-card">
        <CardHeader className="card-header-actions rekap-table-head">
          <span>{periodLabel} · {rows.length} pasien · <span className="metric-note">koreksi {formatRupiah(rowsNominal)}</span></span>
          <div className="rekap-export">
            <Button color="secondary" variant="outline" size="sm" onClick={() => void copyTable()} disabled={rows.length === 0}><Icon name="copy" size={16} /> {copied ? 'Tersalin' : 'Salin'}</Button>
            <PrintMenu scope="rekap" doc={printDoc} disabled={rows.length === 0} />
            <Button color="primary" size="sm" onClick={exportXlsx} disabled={rows.length === 0}><Icon name="download" size={16} /> Export XLSX</Button>
          </div>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="page-loading" role="status"><Spinner size="sm" /> Memuat daftar pasien…</div>
          ) : rows.length === 0 ? (
            <div className="empty">Tidak ada pasien untuk filter ini. {chips.length ? <button type="button" className="rekap-clear" onClick={resetTableFilters}>Reset filter</button> : null}</div>
          ) : (
            <>
              <Pager label="Navigasi halaman atas" win={win} total={rows.length} perPage={perPage} onPage={goPage} onPerPage={setPerPage} />
              <div ref={scrollRef} className="data-scroll" tabIndex={0} aria-label="Tabel pasien — geser dengan Shift+scroll atau tombol panah">
                <table className="patient-table">
                  <thead>
                    <tr>
                      {COLUMNS.map((c) => (
                        <th key={c.key} className={c.numeric ? 'num' : undefined} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                          <button type="button" className="naik-sort" onClick={() => toggleSort(c.key)}>{c.label}<span aria-hidden="true">{sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span></button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((p) => (
                      <tr key={p.runId} data-attention={p.status === 'needs_review' ? 'yes' : 'no'}>
                        <td className="mono" data-label="No. RM">{p.noRm}</td>
                        <td data-label="Nama" className="cell-name">{p.name}</td>
                        <td data-label="Workflow">{WORKFLOW_LABEL[p.workflow]}</td>
                        <td className="mono" data-label="Tanggal">{p.date} <span className="metric-note">{p.time}</span></td>
                        <td data-label="Shift"><span className={`shift-pill shift-${p.shift}`}>Shift {p.shift}</span></td>
                        <td data-label="Kategori"><Badge color={CATEGORY_TONE[p.category]}>{CATEGORY_LABEL[p.category]}</Badge></td>
                        <td data-label="Operator">{p.operator}</td>
                        <td className="num mono" data-label="Nominal">{formatRupiah(p.nominal)}</td>
                        <td data-label="Status">{p.status === 'needs_review' ? <Badge color="warning">Perlu ditinjau</Badge> : <Badge color="success">Selesai</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager label="Navigasi halaman bawah" win={win} total={rows.length} perPage={perPage} onPage={goPage} />
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
