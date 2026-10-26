import { useEffect, useMemo, useState } from 'react';
import { UnauthorizedError } from '../../api/client.js';
import { Alert, Badge, Card, CardBody, CardHeader, Spinner, type Tone } from '../../ui/primitives.js';
import { formatRupiah } from './billing.js';
import {
  CATEGORY_LABEL,
  WORKFLOW_LABEL,
  fetchPatients,
  type PatientCategory,
  type ProcessedPatient,
} from './patients.js';

export type PatientFilter = 'all' | PatientCategory | 'attention';

const FILTERS: ReadonlyArray<{ id: PatientFilter; label: string }> = [
  { id: 'all', label: 'Semua' },
  { id: 'titipan', label: 'Titipan' },
  { id: 'naik_kelas', label: 'Naik kelas' },
  { id: 'attention', label: 'Perlu ditinjau' },
];

const CATEGORY_TONE: Record<PatientCategory, Tone> = {
  titipan: 'warning',
  naik_kelas: 'info',
  normal: 'secondary',
};

function matches(patient: ProcessedPatient, filter: PatientFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'attention') return patient.status === 'needs_review';
  return patient.category === filter;
}

export interface PatientsListProps {
  onUnauthorized: () => void;
  initialFilter?: PatientFilter;
}

export function PatientsList({ onUnauthorized, initialFilter = 'all' }: PatientsListProps) {
  const [patients, setPatients] = useState<ProcessedPatient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<PatientFilter>(initialFilter);

  useEffect(() => setFilter(initialFilter), [initialFilter]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    fetchPatients(controller.signal)
      .then((result) => setPatients(result.patients))
      .catch((err) => {
        if (err instanceof UnauthorizedError) onUnauthorized();
        else if (err.name !== 'AbortError') setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [onUnauthorized]);

  const counts = useMemo(() => {
    const total = patients.length;
    const titipan = patients.filter((p) => p.category === 'titipan').length;
    const naikKelas = patients.filter((p) => p.category === 'naik_kelas').length;
    const attention = patients.filter((p) => p.status === 'needs_review').length;
    const nominal = patients.reduce((sum, p) => sum + p.nominal, 0);
    return { total, titipan, naikKelas, attention, nominal };
  }, [patients]);

  const rows = useMemo(() => patients.filter((p) => matches(p, filter)), [patients, filter]);

  return (
    <div className="page-stack patients-page">
      <header className="page-heading">
        <div>
          <span className="page-eyebrow">SIMRS-Flow / pasien dikerjakan</span>
          <h1>Pasien dikerjakan</h1>
          <p>Daftar pasien rawat inap dan rawat jalan yang koreksi bayarnya sudah diproses.</p>
        </div>
        <div className="page-heading-actions">
          <Badge color="secondary">{counts.total} pasien</Badge>
          <Badge color="warning">{counts.titipan} titipan</Badge>
          <Badge color="info">{counts.naikKelas} naik kelas</Badge>
        </div>
      </header>

      {error ? <Alert color="danger">Daftar pasien tidak tersedia: {error}</Alert> : null}

      <div className="patient-filters" role="group" aria-label="Filter pasien">
        {FILTERS.map((f) => {
          const n = f.id === 'all' ? counts.total : f.id === 'attention' ? counts.attention : patients.filter((p) => p.category === f.id).length;
          return (
            <button
              key={f.id}
              type="button"
              className={`patient-filter${filter === f.id ? ' is-on' : ''}`}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}<span className="patient-filter-count">{n}</span>
            </button>
          );
        })}
      </div>

      <Card className="surface-card">
        <CardHeader className="card-header-actions">
          <span>{FILTERS.find((f) => f.id === filter)?.label} · {rows.length} pasien</span>
          <span className="metric-note">Total koreksi: {formatRupiah(counts.nominal)}</span>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="page-loading" role="status"><Spinner size="sm" /> Memuat daftar pasien…</div>
          ) : rows.length === 0 ? (
            <div className="empty">Tidak ada pasien untuk filter ini.</div>
          ) : (
            <div className="patient-table-wrap">
              <table className="patient-table">
                <thead>
                  <tr>
                    <th>No. RM</th>
                    <th>Nama</th>
                    <th>Workflow</th>
                    <th>Tanggal</th>
                    <th>Kategori</th>
                    <th className="num">Nominal</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.noRm} data-attention={p.status === 'needs_review' ? 'yes' : 'no'}>
                      <td className="mono">{p.noRm}</td>
                      <td>{p.name}</td>
                      <td>{WORKFLOW_LABEL[p.workflow]}</td>
                      <td className="mono">{p.date}</td>
                      <td><Badge color={CATEGORY_TONE[p.category]}>{CATEGORY_LABEL[p.category]}</Badge></td>
                      <td className="num mono">{formatRupiah(p.nominal)}</td>
                      <td>
                        {p.status === 'needs_review'
                          ? <Badge color="warning">Perlu ditinjau</Badge>
                          : <Badge color="success">Selesai</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
