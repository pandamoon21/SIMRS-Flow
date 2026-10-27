import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UnauthorizedError } from '../../api/client.js';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Col, FormInput, Row, Spinner } from '../../ui/primitives.js';
import { Icon } from '../../ui/icons.js';
import { toast } from '../../ui/toast.js';
import { formatRupiah, formatRupiahShort } from '../dashboard/billing.js';
import { pageWindow, type PerPage } from '../table/paging.js';
import { downloadXlsx, Pager, PrintMenu } from '../table/TableKit.js';
import { SuggestInput } from '../table/SuggestInput.js';
import type { PrintDoc } from '../table/print.js';
import {
  COLUMNS,
  EMPTY_FILTER,
  exportTable,
  fetchNaikKelas,
  filterRows,
  normalizeKelas,
  options,
  refreshNaikKelas,
  setNaikKelasSource,
  sortRows,
  summarize,
  type NaikKelasFilter,
  type NaikKelasRow,
  type NaikKelasStatus,
  type SortKey,
  type SortState,
  naikKelasErrorText,
} from './naikKelas.js';

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Quick date ranges; computed at click time so a page left open overnight stays correct. */
const PRESETS: ReadonlyArray<{ id: string; label: string; range: () => [string, string] }> = [
  { id: 'today', label: 'Hari ini', range: () => { const t = isoDay(new Date()); return [t, t]; } },
  { id: '7d', label: '7 hari', range: () => { const d = new Date(); const t = isoDay(d); d.setDate(d.getDate() - 6); return [isoDay(d), t]; } },
  { id: 'month', label: 'Bulan ini', range: () => { const d = new Date(); return [isoDay(new Date(d.getFullYear(), d.getMonth(), 1)), isoDay(d)]; } },
  { id: 'last-month', label: 'Bulan lalu', range: () => { const d = new Date(); return [isoDay(new Date(d.getFullYear(), d.getMonth() - 1, 1)), isoDay(new Date(d.getFullYear(), d.getMonth(), 0))]; } },
  { id: 'year', label: 'Tahun ini', range: () => { const d = new Date(); return [`${d.getFullYear()}-01-01`, isoDay(d)]; } },
  { id: 'all', label: 'Semua', range: () => ['', ''] },
];

/** Advanced "contains" filters, each with suggestions from the data. */
const TEXT_FILTERS: ReadonlyArray<{ key: 'kasus' | 'tindakan' | 'kodeGrouping' | 'klaimBpjs'; label: string; placeholder: string }> = [
  { key: 'kasus', label: 'Kasus', placeholder: 'mis. bedah onko' },
  { key: 'tindakan', label: 'Tindakan', placeholder: 'mis. ct scan' },
  { key: 'kodeGrouping', label: 'Kode grouping', placeholder: 'mis. G-4-23' },
  { key: 'klaimBpjs', label: 'Klaim BPJS', placeholder: 'mis. Klaim BPJS' },
];

function cellText(row: NaikKelasRow, key: SortKey, money?: boolean): string {
  const v = row[key];
  if (v === null || v === '') return '–';
  if (money && typeof v === 'number') return formatRupiah(v);
  return key === 'timestamp' ? String(v).replace('T', ' ') : String(v);
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

export interface NaikKelasPageProps {
  onUnauthorized: () => void;
}

export function NaikKelasPage({ onUnauthorized }: NaikKelasPageProps) {
  const [status, setStatus] = useState<NaikKelasStatus>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sourceDraft, setSourceDraft] = useState('');
  const [filter, setFilter] = useState<NaikKelasFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<SortState>({ key: 'tglPulang', dir: 'desc' });
  const [perPage, setPerPage] = useState<PerPage>(25);
  const [page, setPage] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handle = useCallback((err: unknown) => {
    if (err instanceof UnauthorizedError) onUnauthorized();
    else setError(err instanceof Error ? err.message : String(err));
  }, [onUnauthorized]);

  const load = useCallback(() => {
    setLoading(true);
    return fetchNaikKelas()
      .then((s) => { setStatus(s); setSourceDraft(s.source === s.defaultSource ? '' : s.source); setError(undefined); })
      .catch(handle)
      .finally(() => setLoading(false));
  }, [handle]);
  useEffect(() => { void load(); }, [load]);

  const refresh = async () => {
    setBusy(true);
    try {
      const s = await refreshNaikKelas();
      setStatus(s);
      setError(undefined);
      toast('success', `Data diperbarui · ${s.snapshot?.rows.length ?? 0} baris`);
    } catch (err) {
      handle(err);
      void load();
    } finally {
      setBusy(false);
    }
  };

  const saveSource = async (value: string) => {
    setBusy(true);
    try {
      const s = await setNaikKelasSource(value);
      setStatus(s);
      setSourceDraft(s.source === s.defaultSource ? '' : s.source);
      setError(undefined);
      toast('success', 'Sumber disimpan dan data dibaca ulang');
    } catch (err) {
      handle(err);
      void load();
    } finally {
      setBusy(false);
    }
  };

  const all = status?.snapshot?.rows ?? [];
  const rows = useMemo(() => sortRows(filterRows(all, filter), sort), [all, filter, sort]);
  const totals = useMemo(() => summarize(rows), [rows]);
  const kelasOptions = useMemo(() => options(all, (r) => normalizeKelas(r.hakKelas)), [all]);
  const ranapOptions = useMemo(() => options(all, (r) => normalizeKelas(r.kelasRanap)), [all]);
  const dokterOptions = useMemo(() => options(all, (r) => r.dokter), [all]);
  const suggestions = useMemo(() => Object.fromEntries(TEXT_FILTERS.map((f) => [f.key, options(all, (r) => r[f.key])])), [all]);

  useEffect(() => setPage(1), [filter, perPage, sort]);
  const win = pageWindow(rows.length, perPage, page);
  const pageRows = rows.slice(win.start, win.end);
  // Paging keeps the operator where they are and only rewinds the table box.
  const goPage = (next: number) => { setPage(next); scrollRef.current?.scrollTo({ top: 0 }); };

  const set = <K extends keyof NaikKelasFilter>(key: K, value: NaikKelasFilter[K]) => setFilter((f) => ({ ...f, [key]: value }));

  /** One chip per active filter, each removable on its own. */
  const chips = useMemo(() => {
    const out: Array<{ label: string; clear: Partial<NaikKelasFilter> }> = [];
    if (filter.query) out.push({ label: `Cari “${filter.query}”`, clear: { query: '' } });
    if (filter.from || filter.to) out.push({ label: `${filter.dateField === 'tglPulang' ? 'Pulang' : 'Diinput'} ${filter.from || '…'} – ${filter.to || '…'}`, clear: { from: '', to: '' } });
    if (filter.hakKelas) out.push({ label: `Hak kelas ${filter.hakKelas}`, clear: { hakKelas: '' } });
    if (filter.kelasRanap) out.push({ label: `Ranap ${filter.kelasRanap}`, clear: { kelasRanap: '' } });
    if (filter.dokter) out.push({ label: filter.dokter, clear: { dokter: '' } });
    for (const f of TEXT_FILTERS) if (filter[f.key]) out.push({ label: `${f.label}: ${filter[f.key]}`, clear: { [f.key]: '' } });
    if (filter.iurMin || filter.iurMax) out.push({ label: `IUR ${filter.iurMin || '…'} – ${filter.iurMax || '…'}`, clear: { iurMin: '', iurMax: '' } });
    if (filter.billingMin || filter.billingMax) out.push({ label: `Billing ${filter.billingMin || '…'} – ${filter.billingMax || '…'}`, clear: { billingMin: '', billingMax: '' } });
    return out;
  }, [filter]);
  const scope = chips.map((c) => c.label).join(' · ');
  const fileStem = `iur-naik-kelas-${filter.from || 'awal'}_${filter.to || isoDay(new Date())}`;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedCount = TEXT_FILTERS.filter((f) => filter[f.key]).length + (filter.iurMin || filter.iurMax ? 1 : 0) + (filter.billingMin || filter.billingMax ? 1 : 0);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: COLUMNS.find((c) => c.key === key)?.money ? 'desc' : 'asc' }));

  const printDoc = (): PrintDoc => ({
    title: 'Daftar Iur Naik Kelas Pasien',
    subtitle: `${scope || 'Semua data'} · data per ${when(status?.snapshot?.fetchedAt)}`,
    stats: [
      { label: 'Pasien', value: String(totals.count) },
      { label: 'Total IUR', value: formatRupiah(totals.iur) },
      { label: 'Rata-rata IUR', value: formatRupiah(Math.round(totals.avgIur)) },
      { label: 'Total billing', value: formatRupiah(totals.billing) },
    ],
    columns: COLUMNS.map((c) => ({ key: c.key, label: c.label, numeric: Boolean(c.money), nowrap: ['noRm', 'tglPulang', 'timestamp', 'hakKelas', 'kelasRanap', 'kodeGrouping'].includes(c.key) })),
    rows: rows.map((r) => Object.fromEntries(COLUMNS.map((c) => [c.key, cellText(r, c.key, c.money)]))),
  });

  const exportXlsx = () => {
    const { header, body, widths } = exportTable(rows);
    downloadXlsx(fileStem, 'Iur naik kelas', header, body, widths);
  };

  const snapshot = status?.snapshot;

  return (
    <div className="page-stack rekap-page naik-page">
      <header className="page-heading">
        <div>
          <span className="page-eyebrow">SIMRS-Flow / iur naik kelas</span>
          <h1>Iur Naik Kelas</h1>
          <p>Daftar iur pasien BPJS naik kelas dari form dokter. Data disimpan di server dan diperbarui otomatis setiap {status?.refreshHours ?? 24} jam.</p>
        </div>
        <div className="page-heading-actions naik-sync">
          <span className="metric-note">
            Data per <strong>{when(snapshot?.fetchedAt)}</strong>{snapshot ? ` · oleh ${snapshot.fetchedBy}` : ''}
            {status?.nextAutoRefreshAt ? <><br />Otomatis berikutnya ±{when(status.nextAutoRefreshAt)}</> : null}
          </span>
          <Button color="secondary" variant="outline" size="sm" onClick={() => void refresh()} disabled={busy || loading} title="Baca ulang spreadsheet sekarang">
            {busy ? <Spinner size="sm" /> : null} Ambil sekarang
          </Button>
        </div>
      </header>

      {error ? <Alert color="danger">Gagal: {error}. {snapshot ? 'Data tersimpan terakhir tetap ditampilkan.' : 'Pastikan sheet dibagikan “siapa saja yang memiliki link”, atau periksa sumber di Pengaturan lanjutan.'}</Alert> : null}
      {!error && status?.lastError ? <Alert color="warning">Pembaruan terakhir gagal ({when(status.lastError.at)}: {naikKelasErrorText(status.lastError.message)}). Data tersimpan sebelumnya tetap ditampilkan.</Alert> : null}
      {snapshot?.missingColumns.length ? <Alert color="warning">Kolom tidak ditemukan di sheet: {snapshot.missingColumns.join(', ')}. Nilainya tampil kosong — judul kolom di form mungkin berubah.</Alert> : null}

      <Row className="g-3">
        <Col sm={6} xl={3}><Card className="metric-card metric-accent"><CardBody><span className="metric-label">Total IUR</span><strong className="metric-strong-sm">{formatRupiahShort(totals.iur)}</strong><span className="metric-note">{formatRupiah(totals.iur)}</span></CardBody></Card></Col>
        <Col sm={6} xl={3}><Card className="metric-card"><CardBody><span className="metric-label">Pasien</span><strong className="metric-strong-sm">{totals.count}</strong><span className="metric-note">{chips.length ? `dari ${all.length} total` : 'semua data'}</span></CardBody></Card></Col>
        <Col sm={6} xl={3}><Card className="metric-card"><CardBody><span className="metric-label">Rata-rata IUR</span><strong className="metric-strong-sm">{formatRupiahShort(totals.avgIur)}</strong><span className="metric-note">per pasien</span></CardBody></Card></Col>
        <Col sm={6} xl={3}><Card className="metric-card"><CardBody><span className="metric-label">Total billing</span><strong className="metric-strong-sm">{formatRupiahShort(totals.billing)}</strong><span className="metric-note">klaim kelas I {formatRupiahShort(totals.klaimKelas1)}</span></CardBody></Card></Col>
      </Row>

      <div className="naik-search">
        <Icon name="search" size={16} aria-hidden="true" />
        <FormInput type="search" value={filter.query} onChange={(e) => set('query', e.target.value)} placeholder="Cari No. RM (123456 / 0-12-34-56), nama, dokter, kasus, tindakan, kode grouping" aria-label="Cari pasien naik kelas" />
      </div>

      <div className="patient-filters" role="group" aria-label="Rentang tanggal cepat">
        {PRESETS.map((p) => {
          const [from, to] = p.range();
          const on = filter.from === from && filter.to === to;
          return <button key={p.id} type="button" className={`patient-filter${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => setFilter((f) => ({ ...f, from, to }))}>{p.label}</button>;
        })}
      </div>

      <div className="rekap-toolbar">
        <label className="rekap-control"><span>Tanggal</span>
          <select value={filter.dateField} onChange={(e) => set('dateField', e.target.value as NaikKelasFilter['dateField'])}>
            <option value="tglPulang">Tgl pulang</option>
            <option value="timestamp">Tgl input form</option>
          </select>
        </label>
        <label className="rekap-control"><span>Dari</span><input type="date" value={filter.from} max={filter.to || undefined} onChange={(e) => set('from', e.target.value)} /></label>
        <label className="rekap-control"><span>Sampai</span><input type="date" value={filter.to} min={filter.from || undefined} onChange={(e) => set('to', e.target.value)} /></label>
        <label className="rekap-control"><span>Hak kelas</span>
          <select value={filter.hakKelas} onChange={(e) => set('hakKelas', e.target.value)}><option value="">Semua</option>{kelasOptions.map((k) => <option key={k} value={k}>{k}</option>)}</select>
        </label>
        <label className="rekap-control"><span>Kelas ranap</span>
          <select value={filter.kelasRanap} onChange={(e) => set('kelasRanap', e.target.value)}><option value="">Semua</option>{ranapOptions.map((k) => <option key={k} value={k}>{k}</option>)}</select>
        </label>
        <label className="rekap-control"><span>Dokter</span>
          <select value={filter.dokter} onChange={(e) => set('dokter', e.target.value)}><option value="">Semua dokter</option>{dokterOptions.map((d) => <option key={d} value={d}>{d}</option>)}</select>
        </label>
      </div>

      {/* Open state is the operator's: deriving it from the active-filter count
          snapped the panel shut the moment a field was cleared. */}
      <details className="filter-more" open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
        <summary>Filter lanjutan{advancedCount ? ` (${advancedCount} aktif)` : ''} — kasus, tindakan, kode grouping, klaim, rentang IUR/billing</summary>
        <div className="filter-grid">
          {TEXT_FILTERS.map((f) => (
            <div key={f.key} className="rekap-control"><span>{f.label} berisi</span>
              <SuggestInput value={filter[f.key]} onChange={(v) => set(f.key, v)} suggestions={suggestions[f.key] ?? []} placeholder={f.placeholder} ariaLabel={`${f.label} berisi`} />
            </div>
          ))}
          <div className="rekap-control"><span>IUR (Rp)</span>
            <div className="filter-range">
              <input inputMode="numeric" value={filter.iurMin} placeholder="min, mis. 1 jt" onChange={(e) => set('iurMin', e.target.value)} aria-label="IUR minimum" />
              <input inputMode="numeric" value={filter.iurMax} placeholder="maks" onChange={(e) => set('iurMax', e.target.value)} aria-label="IUR maksimum" />
            </div>
          </div>
          <div className="rekap-control"><span>Total billing (Rp)</span>
            <div className="filter-range">
              <input inputMode="numeric" value={filter.billingMin} placeholder="min" onChange={(e) => set('billingMin', e.target.value)} aria-label="Billing minimum" />
              <input inputMode="numeric" value={filter.billingMax} placeholder="maks" onChange={(e) => set('billingMax', e.target.value)} aria-label="Billing maksimum" />
            </div>
          </div>
        </div>
      </details>

      {chips.length ? (
        <div className="filter-chips" aria-label="Filter aktif">
          <ul className="chip-list">
            {chips.map((c) => <li className="chip" key={c.label}>{c.label}<button type="button" className="chip-remove" aria-label={`Hapus filter ${c.label}`} onClick={() => setFilter((f) => ({ ...f, ...c.clear }))}>×</button></li>)}
          </ul>
          <button type="button" className="rekap-clear" onClick={() => setFilter(EMPTY_FILTER)}>Reset semua filter</button>
        </div>
      ) : null}

      <Card className="surface-card rekap-table-card">
        <CardHeader className="card-header-actions rekap-table-head">
          <span>{rows.length} pasien · <span className="metric-note">IUR {formatRupiah(totals.iur)}</span></span>
          <div className="rekap-export">
            <PrintMenu scope="naik-kelas" doc={printDoc} disabled={rows.length === 0} />
            <Button color="primary" size="sm" onClick={exportXlsx} disabled={rows.length === 0}><Icon name="download" size={16} /> Export XLSX</Button>
          </div>
        </CardHeader>
        <CardBody>
          {loading && !status ? (
            <div className="page-loading" role="status"><Spinner size="sm" /> Memuat data…</div>
          ) : rows.length === 0 ? (
            <div className="empty">Tidak ada data untuk filter ini. {chips.length ? <button type="button" className="rekap-clear" onClick={() => setFilter(EMPTY_FILTER)}>Reset filter</button> : null}</div>
          ) : (
            <>
              <Pager label="Navigasi halaman atas" win={win} total={rows.length} perPage={perPage} onPage={goPage} onPerPage={setPerPage} />
              <div ref={scrollRef} className="data-scroll" tabIndex={0} aria-label="Tabel iur naik kelas — geser dengan Shift+scroll atau tombol panah">
                <table className="patient-table naik-table">
                  <thead>
                    <tr>
                      {COLUMNS.map((c) => (
                        <th key={c.key} className={c.money ? 'num' : undefined} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                          <button type="button" className="naik-sort" onClick={() => toggleSort(c.key)}>
                            {c.label}<span aria-hidden="true">{sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r, i) => (
                      <tr key={`${r.timestamp}-${r.noRm}-${i}`}>
                        {COLUMNS.map((c) => (
                          <td key={c.key} data-label={c.label} className={[c.money ? 'num mono' : '', c.key === 'noRm' || c.key === 'tglPulang' ? 'mono' : '', c.key === 'nama' ? 'cell-name' : ''].filter(Boolean).join(' ') || undefined} title={c.key === 'tindakan' || c.key === 'kasus' ? r[c.key] : undefined}>
                            {c.key === 'kelasRanap' ? <Badge color="info">{cellText(r, c.key)}</Badge> : cellText(r, c.key, c.money)}
                          </td>
                        ))}
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

      <details className="run-advanced naik-advanced">
        <summary>Pengaturan lanjutan</summary>
        <div className="advanced-stack">
          <div className="run-field">
            <label className="form-label" htmlFor="naik-source">URL sumber (Google Sheets)</label>
            <FormInput id="naik-source" value={sourceDraft} onChange={(e) => setSourceDraft(e.target.value)} placeholder={status?.defaultSource ?? 'https://docs.google.com/spreadsheets/d/…/edit?gid=…'} />
            <small>
              Sumber aktif: {status?.source ?? '–'}. Kosongkan untuk memakai default server. Berlaku untuk semua operator; hanya link Google Sheets
              yang dibagikan “siapa saja yang memiliki link”. Menyimpan langsung membaca ulang data.
            </small>
          </div>
          <div className="template-row">
            <Button color="primary" size="sm" type="button" onClick={() => void saveSource(sourceDraft)} disabled={busy || sourceDraft.trim() === (status && status.source !== status.defaultSource ? status.source : '')}>Simpan &amp; ambil</Button>
            <Button color="secondary" variant="outline" size="sm" type="button" onClick={() => void saveSource('')} disabled={busy || !status || status.source === status.defaultSource}>Pakai default</Button>
            {status ? <a className="btn btn-sm btn-link" href={status.source} target="_blank" rel="noreferrer noopener">Buka spreadsheet ↗</a> : null}
          </div>
        </div>
      </details>
    </div>
  );
}
