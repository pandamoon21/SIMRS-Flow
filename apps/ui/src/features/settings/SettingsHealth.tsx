import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, API_BASE, UnauthorizedError, type HealthSummary, type SimrsReachability, type WorkflowSummary } from '../../api/client.js';
import { fetchNaikKelas, naikKelasErrorText, type NaikKelasStatus } from '../naikKelas/naikKelas.js';
import { readMotionSetting, saveMotionSetting, type MotionSetting } from '../../ui/motion.js';
import { Badge, Button, ButtonGroup, Card, CardBody, CardHeader, Col, RefreshButton, Row, Spinner, Table, TableBody, TableDataCell, TableHead, TableHeaderCell, TableRow } from '../../ui/primitives.js';

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
      name: 'Riwayat run', note: 'History, Overview & Rekapitulasi dihitung dari sini',
      location: s?.auditDir, locationNote: 'tidak diset',
      content: s?.audit ? `${s.audit.files} run · ${sizeLabel(s.audit.bytes)}` : health?.auditPersistent ? 'folder belum ada (belum ada run)' : 'hilang saat orchestrator restart',
      persistent: Boolean(health?.auditPersistent), env: ['AUDIT_LEDGER_DIR'],
    },
    {
      name: 'Rules', note: 'Nilai yang diedit di halaman Rules',
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
      name: 'Catatan tim', note: 'Sticky note di Overview',
      location: s?.notesFile, locationNote: 'memori orchestrator',
      content: s?.notes ? `tersimpan · ${sizeLabel(s.notes.bytes)}` : s?.notesFile ? 'belum ada catatan' : 'hilang saat restart',
      persistent: Boolean(s?.notesFile), env: ['NOTES_FILE'],
    },
    {
      name: 'Cache berkas (OCR)', note: 'Hasil Kelengkapan Berkas per No. RM + tanggal',
      location: s?.berkasCacheDir, locationNote: 'cek berkas tidak aktif di host ini',
      content: s?.berkas ? `${s.berkas.files} file · ${sizeLabel(s.berkas.bytes)}` : s?.berkasCacheDir ? 'belum ada (belum pernah dicek)' : '—',
      persistent: s?.berkasCacheDir ? true : undefined, env: ['BERKAS_CACHE_DIR'],
    },
    { name: 'Sesi login', note: 'Login aplikasi & sesi SIMRS tiap operator', locationNote: 'memori orchestrator', content: 'hilang saat restart — operator login ulang', persistent: false, env: [] },
  ];
}

export type CheckTone = 'ok' | 'warn' | 'bad' | 'wait';
export interface StatusCheck { id: string; title: string; tone: CheckTone; value: string; hint?: string }

function ageLabel(hours: number): string {
  if (hours < 1) return 'baru saja';
  if (hours < 48) return `${Math.floor(hours)} jam lalu`;
  return `${Math.floor(hours / 24)} hari lalu`;
}

/** SIMRS answering slower than this makes every run step slow. */
const SIMRS_SLOW_MS = 2000;

/**
 * The page's first answer: is everything a run depends on working, and if not,
 * what to do about it. Plain words; an env name only in the hint that needs one.
 */
export function statusChecks(input: { health?: HealthSummary; healthError?: string; simrs?: SimrsReachability; operator?: string; naik?: NaikKelasStatus; now: number }): StatusCheck[] {
  const { health, simrs, naik, now } = input;
  const host = health?.host;
  const policy = health?.policy;
  const fetchedAt = naik?.snapshot ? Date.parse(naik.snapshot.fetchedAt) : undefined;
  const ageHours = fetchedAt === undefined ? undefined : (now - fetchedAt) / 3_600_000;
  const refreshHours = naik?.refreshHours ?? 24;

  const app: StatusCheck = input.healthError
    ? { id: 'app', title: 'Server aplikasi', tone: 'bad', value: 'tidak terjangkau', hint: 'Jalankan ulang aplikasi di PC server (run.bat start), lalu tekan Periksa ulang.' }
    : host
      ? { id: 'app', title: 'Server aplikasi', tone: 'ok', value: `berjalan ${uptimeLabel(host.uptimeSec)}`, hint: `sejak ${new Date(host.startedAt).toLocaleString('id-ID')} · ${host.name}` }
      : { id: 'app', title: 'Server aplikasi', tone: 'wait', value: 'memeriksa…' };

  const simrsCheck: StatusCheck = !simrs
    ? { id: 'simrs', title: 'Koneksi SIMRS', tone: 'wait', value: 'memeriksa…' }
    : !simrs.configured
      ? { id: 'simrs', title: 'Koneksi SIMRS', tone: 'bad', value: 'alamat SIMRS belum diatur', hint: 'Isi EVOMEDIS_BASE_URL di .env, lalu restart aplikasi.' }
      : !simrs.reachable
        ? { id: 'simrs', title: 'Koneksi SIMRS', tone: 'bad', value: 'tidak bisa dihubungi', hint: `${simrs.host ?? 'SIMRS'}: ${simrs.error ?? 'gagal'}. Cek jaringan PC server, atau SIMRS sedang down.` }
        : (simrs.ms ?? 0) > SIMRS_SLOW_MS
          ? { id: 'simrs', title: 'Koneksi SIMRS', tone: 'warn', value: `lambat · ${simrs.ms} ms`, hint: `${simrs.host} lambat menjawab — run akan terasa lambat.` }
          : { id: 'simrs', title: 'Koneksi SIMRS', tone: 'ok', value: `terhubung · ${simrs.ms} ms`, ...(simrs.host ? { hint: simrs.host } : {}) };

  const login: StatusCheck = input.operator
    ? { id: 'login', title: 'Login Anda', tone: 'ok', value: input.operator, hint: 'Sesi SIMRS login ulang otomatis bila habis karena idle.' }
    : { id: 'login', title: 'Login Anda', tone: 'wait', value: '…' };

  const history: StatusCheck = !health
    ? { id: 'history', title: 'Riwayat run', tone: 'wait', value: '…' }
    : health.auditPersistent
      ? { id: 'history', title: 'Riwayat run', tone: 'ok', value: health.storage?.audit ? `${health.storage.audit.files} run tersimpan` : 'tersimpan di disk', hint: 'Cadangkan foldernya berkala (lihat Penyimpanan data).' }
      : { id: 'history', title: 'Riwayat run', tone: 'bad', value: 'hanya di memori', hint: 'Hilang saat restart. Isi AUDIT_LEDGER_DIR di .env.' };

  const iurFailed = naik?.lastError && (fetchedAt === undefined || Date.parse(naik.lastError.at) > fetchedAt);
  const iur: StatusCheck = !naik
    ? { id: 'iur', title: 'Data iur naik kelas', tone: 'wait', value: '…' }
    : iurFailed
      ? { id: 'iur', title: 'Data iur naik kelas', tone: 'warn', value: 'gagal diperbarui', hint: `${naikKelasErrorText(naik.lastError!.message)}. Data lama tetap dipakai; perbaiki di halaman Iur Naik Kelas.` }
      : ageHours === undefined
        ? { id: 'iur', title: 'Data iur naik kelas', tone: 'warn', value: 'belum pernah diambil', hint: 'Buka halaman Iur Naik Kelas lalu tekan Perbarui.' }
        : ageHours > refreshHours * 2
          ? { id: 'iur', title: 'Data iur naik kelas', tone: 'warn', value: `${naik.snapshot!.rows.length} baris · ${ageLabel(ageHours)}`, hint: 'Lebih tua dari jadwal — cek link sheet di halaman Iur Naik Kelas.' }
          : { id: 'iur', title: 'Data iur naik kelas', tone: 'ok', value: `${naik.snapshot!.rows.length} baris · ${ageLabel(ageHours)}`, hint: `diperbarui otomatis tiap ${refreshHours} jam` };

  const write: StatusCheck = !policy
    ? { id: 'write', title: 'Keamanan write', tone: 'wait', value: '…' }
    : policy.qaLogin
      ? { id: 'write', title: 'Keamanan write', tone: 'bad', value: 'login QA aktif', hint: 'Siapa pun di PC server bisa masuk tanpa akun. Hapus QA_AUTH_TOKEN dari .env untuk pemakaian nyata.' }
      : policy.autoApproveWrites
        ? { id: 'write', title: 'Keamanan write', tone: 'ok', value: 'disetujui otomatis', hint: 'Run selalu mulai sebagai preview. Write tetap lewat cek syarat & verifikasi baca-ulang.' }
        : { id: 'write', title: 'Keamanan write', tone: 'ok', value: `butuh ${policy.criticalApprovals} persetujuan`, hint: 'Write menunggu operator menekan Setujui.' };

  return [app, simrsCheck, login, history, iur, write];
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
    <Card className="surface-card h-100">
      <CardHeader>Animasi di PC ini</CardHeader>
      <CardBody>
        <ButtonGroup size="sm" aria-label="Pengaturan animasi">
          {MOTION_OPTIONS.map((option) => (
            <Button key={option.value} color="secondary" variant={option.value === setting ? undefined : 'outline'} aria-pressed={option.value === setting} title={option.hint} onClick={() => choose(option.value)}>{option.label}</Button>
          ))}
        </ButtonGroup>
        <p className="settings-note mt-2">{active?.hint}{setting === 'auto' && mode ? ` · sekarang: ${mode === 'lite' ? 'hemat' : mode === 'off' ? 'mati' : 'penuh'}` : ''}.</p>
        <p className="settings-note">PC kantor terasa berat saat run besar? Pilih <b>Hemat</b>, dan di halaman Run pakai tampilan <b>Fixed</b>. Disimpan di browser PC ini saja.</p>
      </CardBody>
    </Card>
  );
}

const TONE_BADGE: Record<CheckTone, 'success' | 'warning' | 'danger' | 'secondary'> = { ok: 'success', warn: 'warning', bad: 'danger', wait: 'secondary' };
const TONE_TEXT: Record<CheckTone, string> = { ok: 'OK', warn: 'Cek', bad: 'Masalah', wait: '…' };

export function SettingsHealth({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [health, setHealth] = useState<HealthSummary>();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [simrs, setSimrs] = useState<SimrsReachability>();
  const [operator, setOperator] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // The Iur page's status (rows, last fetch) — optional: Settings still renders when it fails.
  const [naik, setNaik] = useState<NaikKelasStatus>();

  const load = useCallback(async (): Promise<boolean> => {
    setLoading(true);
    setError(undefined);
    setSimrs(undefined);
    try {
      const [healthResponse, workflowResponse] = await Promise.all([api.healthDetail(), api.listWorkflows()]);
      setHealth(healthResponse);
      setWorkflows(workflowResponse.workflows);
      // Each may fail on its own without hiding the rest of the page.
      const [simrsResponse, me, naikResponse] = await Promise.all([
        api.simrsHealth().catch(() => undefined),
        api.me().catch(() => undefined),
        fetchNaikKelas().catch(() => undefined),
      ]);
      setSimrs(simrsResponse ?? { configured: true, reachable: false, checkedAt: new Date().toISOString(), error: 'pemeriksaan gagal' });
      setOperator(me?.operator);
      setNaik(naikResponse);
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
  const checks = statusChecks({ ...(health ? { health } : {}), ...(error ? { healthError: error } : {}), ...(simrs ? { simrs } : {}), ...(operator ? { operator } : {}), ...(naik ? { naik } : {}), now: Date.now() });
  const problems = checks.filter((check) => check.tone === 'bad' || check.tone === 'warn').length;

  return (
    <div className="page-stack settings-page">
      <header className="page-heading">
        <div>
          <span className="page-eyebrow">Pengaturan</span>
          <h1>Pengaturan & status</h1>
          <p>Apakah semua yang dibutuhkan run berjalan, alamat untuk PC lain, dan preferensi PC ini. Kata sandi, cookie, dan data pasien tidak pernah tampil di sini.</p>
        </div>
        <div className="page-heading-actions">
          <Badge color={error ? 'danger' : loading ? 'secondary' : problems ? 'warning' : 'success'}>{error ? 'Tidak terjangkau' : loading ? 'Memeriksa…' : problems ? `${problems} perlu dicek` : 'Semua normal'}</Badge>
          <RefreshButton onRefresh={load} size={undefined} title="Periksa ulang" />
        </div>
      </header>

      {loading && !health ? <div className="page-loading" role="status"><Spinner size="sm" /> Memeriksa…</div> : null}

      <section aria-label="Status" className="settings-checks">
        {checks.map((check) => (
          <div key={check.id} className="settings-check" data-tone={check.tone}>
            <div className="settings-check-head">
              <span className="settings-check-title">{check.title}</span>
              <Badge color={TONE_BADGE[check.tone]}>{TONE_TEXT[check.tone]}</Badge>
            </div>
            <div className="settings-check-value">{check.value}</div>
            {check.hint ? <div className="settings-note">{check.hint}</div> : null}
          </div>
        ))}
      </section>

      <Row className="g-3">
        <Col xl={6}>
          <Card className="surface-card h-100">
            <CardHeader>Buka dari PC lain</CardHeader>
            <CardBody>
              {!network ? <p className="settings-note">—</p> : network.loopbackOnly ? (
                <p className="settings-note is-warn">Saat ini hanya bisa dibuka dari PC server. Agar PC lain di LAN bisa membuka, isi <code>ORCHESTRATOR_HOST=0.0.0.0</code> di <code>.env</code> lalu restart aplikasi.</p>
              ) : network.urls.length === 0 ? <p className="settings-note">Tidak ada alamat LAN terdeteksi di PC server.</p> : (
                <>
                  <p className="settings-note">Ketik salah satu alamat ini di Chrome/Edge PC lain yang satu jaringan:</p>
                  <span className="settings-stack">{network.urls.map((url) => <CopyValue key={url} value={url} />)}</span>
                </>
              )}
              <dl className="summary-list settings-list mt-3">
                <dt>Halaman ini dibuka di</dt><dd><CopyValue value={pageUrl} /></dd>
              </dl>
            </CardBody>
          </Card>
        </Col>
        <Col xl={6}>
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
              <p className="settings-note storage-foot">Cadangkan folder <b>Riwayat run</b> dan <b>Rules</b> secara berkala (salin ke flashdisk / drive bersama). Untuk memindah lokasi: ubah <code>.env</code>, lalu restart aplikasi.</p>
            </CardBody>
          </Card>
        </Col>
        <Col xs={12}>
          <details className="surface-card settings-tech">
            <summary>Detail teknis <span className="settings-note">— untuk admin, atau saat melaporkan masalah</span></summary>
            <Row className="g-3 settings-tech-body">
              <Col xl={6}>
                <dl className="summary-list settings-list">
                  <dt>Alamat SIMRS</dt><dd>{evomedis ? <CopyValue value={evomedis.baseUrl} /> : '—'}</dd>
                  {evomedis?.baseUrlV2 ? <><dt>Alamat SIMRS v2</dt><dd><CopyValue value={evomedis.baseUrlV2} /></dd></> : null}
                  <dt>Cek SIMRS terakhir</dt><dd>{simrs ? `${simrs.reachable ? `HTTP ${simrs.status}` : simrs.error ?? '-'} · ${new Date(simrs.checkedAt).toLocaleTimeString('id-ID')}` : '—'}</dd>
                  <dt>API orchestrator</dt><dd><CopyValue value={apiUrl} /></dd>
                  <dt>Mendengar di</dt><dd>{network ? <code>{network.listen}</code> : '—'} <span className="settings-note"><code>ORCHESTRATOR_HOST</code> · <code>ORCHESTRATOR_PORT</code></span></dd>
                  <dt>UI dilayani orchestrator</dt><dd>{health?.uiAvailable ? 'ya · satu port untuk API + UI' : 'tidak · dev server Vite'}</dd>
                </dl>
              </Col>
              <Col xl={6}>
                <dl className="summary-list settings-list">
                  <dt>Persetujuan critical</dt><dd>{policy ? `${policy.criticalApprovals} operator` : '—'} <span className="settings-note"><code>CRITICAL_APPROVALS</code></span></dd>
                  <dt>Auto-approve write</dt><dd>{yesNo(policy?.autoApproveWrites, 'aktif', 'mati', 'warning')} <span className="settings-note"><code>AUTO_APPROVE_WRITES</code></span></dd>
                  <dt>Login QA</dt><dd>{yesNo(policy?.qaLogin, 'aktif — jangan untuk produksi', 'mati', 'danger')} <span className="settings-note"><code>QA_AUTH_TOKEN</code></span></dd>
                  <dt>Host</dt><dd>{host ? <><code>{host.name}</code> <span className="settings-note">{host.platform} · Node {host.node}</span></> : '—'}</dd>
                  <dt>Build</dt><dd>{health?.buildVersion ?? 'development'}</dd>
                  <dt>Zona waktu browser</dt><dd>{browserTz}</dd>
                </dl>
              </Col>
              <Col xs={12}>
                <div className="table-responsive">
                  <Table hover align="middle" className="mb-0">
                    <TableHead><TableRow><TableHeaderCell>Workflow</TableHeaderCell><TableHeaderCell>Domain</TableHeaderCell><TableHeaderCell>Versi</TableHeaderCell><TableHeaderCell>Langkah</TableHeaderCell></TableRow></TableHead>
                    <TableBody>{workflows.map((workflow) => <TableRow key={workflow.id}><TableDataCell><strong>{workflow.label}</strong><div className="history-run-id">{workflow.id}</div></TableDataCell><TableDataCell>{workflow.domain}</TableDataCell><TableDataCell>{workflow.version}</TableDataCell><TableDataCell>{workflow.nodeCount}</TableDataCell></TableRow>)}</TableBody>
                  </Table>
                </div>
              </Col>
            </Row>
          </details>
        </Col>
      </Row>
    </div>
  );
}
