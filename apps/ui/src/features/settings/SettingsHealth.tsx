import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, API_BASE, UnauthorizedError, type HealthSummary, type WorkflowSummary } from '../../api/client.js';
import { fetchNaikKelas, type NaikKelasStatus } from '../naikKelas/naikKelas.js';
import { readMotionSetting, saveMotionSetting, type MotionSetting } from '../../ui/motion.js';
import { Alert, Badge, Button, ButtonGroup, Card, CardBody, CardHeader, Col, RefreshButton, Row, Spinner, Table, TableBody, TableDataCell, TableHead, TableHeaderCell, TableRow } from '../../ui/primitives.js';

/** A value an operator may need to type elsewhere (URL, path): one click copies it. */
function CopyValue({ value, children }: { value: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); } catch { /* clipboard blocked: the text stays selectable */ }
  };
  return (
    <span className="copy-value">
      <code>{children ?? value}</code>
      <button type="button" className={`copy-value-btn${copied ? ' is-copied' : ''}`} onClick={() => void copy()} aria-label={`Salin ${value}`} title="Salin">
        {copied ? 'Tersalin' : 'Salin'}
      </button>
    </span>
  );
}

/** "2 hari 4 jam", "3 jam 12 menit", "5 menit" — uptime reads in whole units. */
export function uptimeLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d} hari ${h % 24} jam`;
  if (h > 0) return `${h} jam ${m % 60} menit`;
  return m > 0 ? `${m} menit` : 'baru saja';
}

const sizeLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

interface StorageRow { name: string; note: string; location?: string; locationNote?: string; content: string; persistent?: boolean; env: string[] }

/** One row per dataset the app keeps, with where it lives and what survives a restart. */
export function storageRows(health: HealthSummary | undefined, naik: NaikKelasStatus | undefined): StorageRow[] {
  const s = health?.storage;
  const snapshot = naik?.snapshot;
  return [
    {
      name: 'Riwayat run (audit ledger)', note: 'History, ekspor JSONL, jejak audit',
      location: s?.auditDir, locationNote: 'tidak diset',
      content: s?.audit ? `${s.audit.files} run · ${sizeLabel(s.audit.bytes)}` : health?.auditPersistent ? 'folder belum ada (belum ada run)' : 'hilang saat orchestrator restart',
      persistent: Boolean(health?.auditPersistent), env: ['AUDIT_LEDGER_DIR'],
    },
    {
      name: 'Rules (nilai yang bisa diedit)', note: 'Halaman Rules, versi tersimpan',
      location: s?.rulesDir, content: s?.rules ? `${s.rules.files} file · ${sizeLabel(s.rules.bytes)}` : 'belum ada versi tersimpan (pakai bawaan)',
      persistent: s?.rulesDir ? true : undefined, env: ['RULES_DIR'],
    },
    {
      name: 'Iur naik kelas', note: `Salinan sheet form dokter · diperbarui tiap ${naik?.refreshHours ?? 24} jam`,
      location: s?.naikKelasFile,
      content: snapshot ? `${snapshot.rows.length} baris · diambil ${new Date(snapshot.fetchedAt).toLocaleString('id-ID')}${s?.naikKelas ? ` · ${sizeLabel(s.naikKelas.bytes)}` : ''}` : 'belum pernah diambil',
      persistent: s?.naikKelasFile ? true : undefined, env: ['NAIK_KELAS_FILE', 'NAIK_KELAS_SHEET_URL', 'NAIK_KELAS_REFRESH_HOURS'],
    },
    {
      name: 'Cache berkas (OCR)', note: 'Hasil Kelengkapan Berkas per No. RM + tanggal masuk/pulang',
      location: s?.berkasCacheDir, locationNote: 'cek berkas tidak aktif di host ini',
      content: s?.berkas ? `${s.berkas.files} file · ${sizeLabel(s.berkas.bytes)}` : s?.berkasCacheDir ? 'belum ada (belum pernah dicek)' : '—',
      persistent: s?.berkasCacheDir ? true : undefined, env: ['BERKAS_CACHE_DIR'],
    },
    {
      name: 'Rekapitulasi & Overview', note: 'Nominal billing, pasien dikerjakan',
      locationNote: 'belum ada sumber data', content: 'angka DEMO — belum tersambung ke data billing nyata', env: [],
    },
    { name: 'Sesi login operator', note: 'Token & cookie EvoMedis per operator', locationNote: 'memori orchestrator', content: 'hilang saat restart — operator login ulang', persistent: false, env: [] },
    { name: 'Catatan tim & presensi', note: 'Overview › Operator aktif', locationNote: 'memori orchestrator', content: 'hilang saat restart', persistent: false, env: [] },
  ];
}

const yesNo = (value: boolean | undefined, yes: string, no: string, tone: 'success' | 'warning' | 'danger' = 'success') =>
  <Badge color={value ? tone : 'secondary'}>{value ? yes : no}</Badge>;

const MOTION_OPTIONS: { value: MotionSetting; label: string; hint: string }[] = [
  { value: 'auto', label: 'Otomatis', hint: 'Hemat di PC lemah (RAM ≤ 4 GB / ≤ 4 core) atau saat layar tersendat' },
  { value: 'full', label: 'Penuh', hint: 'Semua animasi' },
  { value: 'lite', label: 'Hemat', hint: 'Tanpa animasi dekoratif yang terus berjalan; status dan progress tetap' },
  { value: 'off', label: 'Mati', hint: 'Tanpa gerak sama sekali' },
];

/** Per-PC animation setting (saved in this browser only). */
function MotionCard() {
  const [setting, setSetting] = useState<MotionSetting>(readMotionSetting);
  const [mode, setMode] = useState(() => (typeof document === 'undefined' ? undefined : document.documentElement.dataset.motion));
  const choose = (value: MotionSetting) => { setSetting(value); setMode(saveMotionSetting(value)); };
  const active = MOTION_OPTIONS.find((option) => option.value === setting);
  return (
    <Card className="surface-card">
      <CardHeader>Animasi</CardHeader>
      <CardBody>
        <ButtonGroup size="sm" aria-label="Pengaturan animasi">
          {MOTION_OPTIONS.map((option) => (
            <Button key={option.value} color="secondary" variant={option.value === setting ? undefined : 'outline'} aria-pressed={option.value === setting} title={option.hint} onClick={() => choose(option.value)}>{option.label}</Button>
          ))}
        </ButtonGroup>
        <p className="settings-note mt-2">{active?.hint}{setting === 'auto' && mode ? ` · sekarang: ${mode === 'lite' ? 'hemat' : mode === 'off' ? 'mati' : 'penuh'}` : ''}. Disimpan di browser PC ini saja.</p>
      </CardBody>
    </Card>
  );
}

export function SettingsHealth({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [health, setHealth] = useState<HealthSummary>();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // The Iur page's status (rows, last fetch) — optional: Settings still renders when it fails.
  const [naik, setNaik] = useState<NaikKelasStatus>();

  const load = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(undefined);
    try {
      const [healthResponse, workflowResponse] = await Promise.all([api.healthDetail(), api.listWorkflows()]);
      setHealth(healthResponse);
      setWorkflows(workflowResponse.workflows);
      setNaik(await fetchNaikKelas().catch(() => undefined));
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

  const pageUrl = typeof window === 'undefined' ? '' : `${window.location.origin}/`;
  const apiUrl = API_BASE || pageUrl;
  const network = health?.network;
  const evomedis = health?.evomedis;
  const policy = health?.policy;
  const host = health?.host;
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="page-stack settings-page">
      <header className="page-heading">
        <div>
          <span className="page-eyebrow">Read-only operational posture</span>
          <h1>Pengaturan & kesehatan</h1>
          <p>Alamat, target SIMRS, dan posisi host ini. Kredensial, cookie, token, dan respons mentah SIMRS tidak pernah ditampilkan di sini.</p>
        </div>
        <div className="page-heading-actions">
          <Badge color={health?.ok ? 'success' : error ? 'danger' : 'secondary'}>{health?.ok ? 'Host aktif' : error ? 'Tidak terjangkau' : 'Memeriksa…'}</Badge>
          <RefreshButton onRefresh={load} size={undefined} title="Periksa ulang host" />
        </div>
      </header>

      {loading && !health ? <div className="page-loading" role="status"><Spinner size="sm" /> Memeriksa host…</div> : null}
      {error ? <Alert color="danger">Detail host tidak tersedia: {error}</Alert> : null}

      <Row className="g-3">
        <Col xl={6}>
          <Card className="surface-card h-100">
            <CardHeader>Akses aplikasi</CardHeader>
            <CardBody>
              <dl className="summary-list settings-list">
                <dt>Dibuka di browser ini</dt><dd><CopyValue value={pageUrl} /></dd>
                <dt>API orchestrator</dt><dd><CopyValue value={apiUrl} />{API_BASE ? null : <span className="settings-note">sama dengan alamat halaman</span>}</dd>
                <dt>Orchestrator mendengar di</dt><dd>{network ? <code>{network.listen}</code> : '—'}</dd>
                <dt>Alamat untuk PC lain</dt>
                <dd>
                  {!network ? '—' : network.loopbackOnly ? (
                    <span className="settings-note is-warn">Hanya bisa dibuka dari PC ini (bind loopback). Set <code>ORCHESTRATOR_HOST=0.0.0.0</code> agar PC lain di LAN bisa membuka.</span>
                  ) : network.urls.length === 0 ? <span className="settings-note">Tidak ada alamat IPv4 LAN terdeteksi.</span> : (
                    <span className="settings-stack">{network.urls.map((url) => <CopyValue key={url} value={url} />)}</span>
                  )}
                </dd>
                <dt>Build UI di orchestrator</dt><dd>{health?.uiAvailable ? 'tersedia · satu port untuk API + UI' : 'tidak ada · pakai dev server Vite'}</dd>
              </dl>
            </CardBody>
          </Card>
        </Col>
        <Col xl={6}>
          <Card className="surface-card h-100">
            <CardHeader>Target SIMRS (EvoMedis)</CardHeader>
            <CardBody>
              <dl className="summary-list settings-list">
                <dt>Base URL</dt><dd>{evomedis ? <CopyValue value={evomedis.baseUrl} /> : '—'}</dd>
                <dt>Host / IP</dt><dd>{evomedis ? <code>{evomedis.host}</code> : '—'}</dd>
                {evomedis?.baseUrlV2 ? <><dt>Base URL v2</dt><dd><CopyValue value={evomedis.baseUrlV2} /></dd></> : null}
                <dt>Run live</dt><dd>{health?.liveAvailable ? 'tersedia · login per operator' : 'butuh sesi operator'}</dd>
                <dt>Mode bawaan</dt><dd><Badge color="info">{health?.defaultMode ?? 'preview'}</Badge> <span className="settings-note">tulis selalu butuh pilihan eksplisit</span></dd>
              </dl>
            </CardBody>
          </Card>
        </Col>
        <Col xl={6}>
          <Card className="surface-card h-100">
            <CardHeader>Kebijakan</CardHeader>
            <CardBody>
              <dl className="summary-list settings-list">
                <dt>Persetujuan critical</dt><dd>{policy ? `${policy.criticalApprovals} operator` : '—'} <span className="settings-note"><code>CRITICAL_APPROVALS</code></span></dd>
                <dt>Auto-approve write (host)</dt><dd>{yesNo(policy?.autoApproveWrites, 'aktif', 'mati', 'warning')} <span className="settings-note"><code>AUTO_APPROVE_WRITES</code></span></dd>
                <dt>QA login</dt><dd>{yesNo(policy?.qaLogin, 'aktif — jangan untuk produksi', 'mati', 'danger')} <span className="settings-note"><code>QA_AUTH_TOKEN</code></span></dd>
                <dt>Satu pasien per run live</dt><dd><Badge color="info">aktif</Badge> <span className="settings-note">batas pilot, ditegakkan di server</span></dd>
              </dl>
            </CardBody>
          </Card>
        </Col>
        <Col xl={6}>
          <Card className="surface-card h-100">
            <CardHeader>Host & browser</CardHeader>
            <CardBody>
              <dl className="summary-list settings-list">
                <dt>Nama host</dt><dd>{host ? <code>{host.name}</code> : '—'}</dd>
                <dt>Platform</dt><dd>{host ? `${host.platform} · Node ${host.node}` : '—'}</dd>
                <dt>Aktif sejak</dt><dd>{host ? <>{new Date(host.startedAt).toLocaleString('id-ID')} <span className="settings-note">{uptimeLabel(host.uptimeSec)}</span></> : '—'}</dd>
                <dt>Build</dt><dd>{health?.buildVersion ?? 'development'}</dd>
                <dt>Zona waktu browser</dt><dd>{browserTz}</dd>
                <dt>Diperiksa</dt><dd>{health?.ts ? new Date(health.ts).toLocaleString('id-ID') : '—'}</dd>
              </dl>
            </CardBody>
          </Card>
        </Col>
        <Col xs={12}>
          <MotionCard />
        </Col>
        <Col xs={12}>
          <Card className="surface-card">
            <CardHeader>Penyimpanan data</CardHeader>
            <CardBody className="p-0">
              <div className="table-responsive">
                <Table align="middle" className="mb-0 storage-table">
                  <TableHead><TableRow><TableHeaderCell>Data</TableHeaderCell><TableHeaderCell>Lokasi</TableHeaderCell><TableHeaderCell>Isi</TableHeaderCell><TableHeaderCell>Bertahan saat restart</TableHeaderCell><TableHeaderCell>Diatur lewat .env</TableHeaderCell></TableRow></TableHead>
                  <TableBody>
                    {storageRows(health, naik).map((row) => (
                      <TableRow key={row.name}>
                        <TableDataCell><strong>{row.name}</strong><div className="history-run-id">{row.note}</div></TableDataCell>
                        <TableDataCell>{row.location ? <CopyValue value={row.location} /> : <span className="settings-note">{row.locationNote ?? '—'}</span>}</TableDataCell>
                        <TableDataCell>{row.content}</TableDataCell>
                        <TableDataCell><Badge color={row.persistent === true ? 'success' : row.persistent === false ? 'warning' : 'secondary'}>{row.persistent === true ? 'ya, di disk' : row.persistent === false ? 'tidak — memori' : 'belum ada'}</Badge></TableDataCell>
                        <TableDataCell>{row.env.length ? row.env.map((name) => <code key={name} className="storage-env">{name}</code>) : <span className="settings-note">—</span>}</TableDataCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="settings-note storage-foot">Ubah lokasi di <code>.env</code> lalu restart orchestrator. Folder dibuat otomatis saat data pertama ditulis; cadangkan folder riwayat run dan rules secara berkala.</p>
            </CardBody>
          </Card>
        </Col>
        <Col xs={12}>
          <Card className="surface-card">
            <CardHeader>Workflow terdaftar</CardHeader>
            <CardBody className="p-0">
              <div className="table-responsive">
                <Table hover align="middle" className="mb-0">
                  <TableHead><TableRow><TableHeaderCell>Workflow</TableHeaderCell><TableHeaderCell>Domain</TableHeaderCell><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Nodes</TableHeaderCell></TableRow></TableHead>
                  <TableBody>{workflows.map((workflow) => <TableRow key={workflow.id}><TableDataCell><strong>{workflow.label}</strong><div className="history-run-id">{workflow.id}</div></TableDataCell><TableDataCell>{workflow.domain}</TableDataCell><TableDataCell>{workflow.version}</TableDataCell><TableDataCell>{workflow.nodeCount}</TableDataCell></TableRow>)}</TableBody>
                </Table>
              </div>
            </CardBody>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
