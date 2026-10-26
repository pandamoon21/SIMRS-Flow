/**
 * Iur naik kelas — the Google Form responses sheet doctors fill in for BPJS
 * patients upgrading their class. The orchestrator reads the sheet's CSV
 * export server-side (no CORS, no Google credentials: the sheet is link-shared)
 * and hands the UI typed rows.
 *
 * Only Google Sheets URLs are accepted, and the fetch always goes to the
 * fixed `docs.google.com/.../export` endpoint built from the sheet id — an
 * operator-editable source must not become a way to make the host fetch an
 * arbitrary URL.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Sheet URL → its CSV export URL, or undefined when it is not a Google Sheets link. */
export function sheetCsvExportUrl(sheetUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(sheetUrl.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return undefined;
  const id = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/.exec(url.pathname)?.[1];
  if (!id) return undefined;
  const gid = url.searchParams.get('gid') ?? /gid=(\d+)/.exec(url.hash)?.[1] ?? '0';
  if (!/^\d+$/.test(gid)) return undefined;
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CR/LF line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // drop a UTF-8 BOM
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export interface NaikKelasRow {
  /** Form submission time, ISO `YYYY-MM-DDTHH:mm:ss` (sheet: `dd/mm/yyyy hh:mm:ss`). */
  timestamp: string;
  noRm: string;
  nama: string;
  hakKelas: string;
  kelasRanap: string;
  totalBilling: number | null;
  tindakan: string;
  kasus: string;
  dokter: string;
  kodeGrouping: string;
  klaimBpjs: string;
  klaimKelas1: number | null;
  klaimKelas2: number | null;
  iur: number | null;
  /** Discharge date, ISO `YYYY-MM-DD`. */
  tglPulang: string;
}

/** `dd/mm/yyyy[ hh:mm:ss]` → ISO; anything else is returned trimmed. */
function isoFromSheetDate(value: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!m) return value.trim();
  const date = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return m[4] ? `${date}T${m[4].padStart(2, '0')}:${m[5]}:${m[6] ?? '00'}` : date;
}

/**
 * One name per room class (RS PKU Gombong): DELUXE is the same class as VIP,
 * PRESIDENT SUITE is VVIP. Roman numerals are kept; "1" → "I" etc.
 */
export function normalizeKelasRanap(value: string): string {
  const v = value.trim().toUpperCase().replace(/\s+/g, ' ');
  if (v === 'DELUXE') return 'VIP';
  if (v === 'PRESIDENT SUITE' || v === 'PRESIDENTIAL SUITE') return 'VVIP';
  return ({ '1': 'I', '2': 'II', '3': 'III' } as Record<string, string>)[v] ?? v;
}

/** `Rp6.908.402` / `Rp 1.234,50` → 6908402 / 1234.5; blank or unreadable → null. */
function rupiah(value: string): number | null {
  const cleaned = value.replace(/rp/gi, '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

/**
 * Columns are looked up by header text, not position, so a column the form
 * owner inserts or reorders does not shift every value into the wrong field.
 */
const HEADERS: Record<keyof NaikKelasRow, string> = {
  timestamp: 'timestamp',
  noRm: 'nomer rekam medis',
  nama: 'nama pasien',
  hakKelas: 'hak kelas',
  kelasRanap: 'kelas ranap',
  totalBilling: 'total billing',
  tindakan: 'tindakan',
  kasus: 'kasus',
  dokter: 'dokter',
  kodeGrouping: 'kode grouping',
  klaimBpjs: 'klaim bpjs',
  klaimKelas1: 'klaim bpjs kelas i',
  klaimKelas2: 'klaim bpjs kelas ii',
  iur: 'iur',
  tglPulang: 'tanggal kepulangan pasien',
};

export interface NaikKelasSheet {
  rows: NaikKelasRow[];
  /** Expected headers the sheet no longer has — shown so a renamed column is noticed, not silently blank. */
  missingColumns: string[];
}

export function parseNaikKelasSheet(csv: string): NaikKelasSheet {
  const [header = [], ...body] = parseCsv(csv);
  const index = new Map(header.map((h, i) => [h.trim().toLowerCase(), i] as const));
  const missingColumns = Object.values(HEADERS).filter((h) => !index.has(h));
  const cell = (row: string[], key: keyof NaikKelasRow) => {
    const i = index.get(HEADERS[key]);
    return i === undefined ? '' : (row[i] ?? '').trim();
  };
  const rows = body
    .filter((row) => row.some((c) => c.trim() !== ''))
    .map((row): NaikKelasRow => ({
      timestamp: isoFromSheetDate(cell(row, 'timestamp')),
      noRm: cell(row, 'noRm'),
      nama: cell(row, 'nama'),
      hakKelas: cell(row, 'hakKelas'),
      kelasRanap: normalizeKelasRanap(cell(row, 'kelasRanap')),
      totalBilling: rupiah(cell(row, 'totalBilling')),
      tindakan: cell(row, 'tindakan'),
      kasus: cell(row, 'kasus'),
      dokter: cell(row, 'dokter'),
      kodeGrouping: cell(row, 'kodeGrouping'),
      klaimBpjs: cell(row, 'klaimBpjs'),
      klaimKelas1: rupiah(cell(row, 'klaimKelas1')),
      klaimKelas2: rupiah(cell(row, 'klaimKelas2')),
      iur: rupiah(cell(row, 'iur')),
      tglPulang: isoFromSheetDate(cell(row, 'tglPulang')),
    }));
  return { rows, missingColumns };
}

/* ════════════════════════════════════════════════════════════════
 * Snapshot store: the sheet is read at most once per refresh window
 * (default 24 h) or on an operator's manual refresh, and every page view is
 * served from the saved snapshot. Persisted as one JSON file so a restart
 * does not refetch; there is no database in this deployment.
 * ════════════════════════════════════════════════════════════════ */

export interface NaikKelasSnapshot extends NaikKelasSheet {
  source: string;
  fetchedAt: string;
  /** Who triggered the read: an operator name, or "auto". */
  fetchedBy: string;
}

export interface NaikKelasStatus {
  snapshot?: NaikKelasSnapshot;
  /** The configured source (operator setting, else env/default). */
  source: string;
  defaultSource: string;
  refreshHours: number;
  nextAutoRefreshAt?: string;
  refreshing: boolean;
  /** Last failed read, kept until a read succeeds; the old snapshot stays served. */
  lastError?: { at: string; message: string };
}

export interface NaikKelasStoreOptions {
  /** JSON file for the snapshot + source setting; omit for memory only (tests). */
  file?: string;
  defaultSource?: string;
  refreshHours?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface Persisted {
  source?: string;
  snapshot?: NaikKelasSnapshot;
}

export class NaikKelasStore {
  private source?: string;
  private snapshot?: NaikKelasSnapshot;
  private lastError?: { at: string; message: string };
  private inflight?: Promise<NaikKelasSnapshot>;
  private timer?: ReturnType<typeof setInterval>;
  readonly defaultSource: string;
  readonly refreshHours: number;

  constructor(private readonly options: NaikKelasStoreOptions = {}) {
    // From NAIK_KELAS_SHEET_URL; empty until set there or by an operator on the page.
    this.defaultSource = options.defaultSource ?? '';
    this.refreshHours = options.refreshHours && options.refreshHours > 0 ? options.refreshHours : 24;
    if (options.file && existsSync(options.file)) {
      try {
        const saved = JSON.parse(readFileSync(options.file, 'utf8')) as Persisted;
        this.source = saved.source;
        this.snapshot = saved.snapshot;
      } catch {
        // A corrupt cache is only a cache: the next read rebuilds it.
      }
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  get currentSource(): string {
    return this.source || this.defaultSource;
  }

  private persist(): void {
    if (!this.options.file) return;
    mkdirSync(dirname(this.options.file), { recursive: true });
    const tmp = `${this.options.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ source: this.source, snapshot: this.snapshot } satisfies Persisted));
    renameSync(tmp, this.options.file);
  }

  status(): NaikKelasStatus {
    const fetched = this.snapshot ? Date.parse(this.snapshot.fetchedAt) : undefined;
    return {
      ...(this.snapshot ? { snapshot: this.snapshot } : {}),
      source: this.currentSource,
      defaultSource: this.defaultSource,
      refreshHours: this.refreshHours,
      ...(fetched ? { nextAutoRefreshAt: new Date(fetched + this.refreshHours * 3_600_000).toISOString() } : {}),
      refreshing: Boolean(this.inflight),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  isStale(): boolean {
    if (!this.snapshot || this.snapshot.source !== this.currentSource) return true;
    return this.now().getTime() - Date.parse(this.snapshot.fetchedAt) >= this.refreshHours * 3_600_000;
  }

  /** Read the sheet now. Concurrent callers share one request. */
  refresh(by: string): Promise<NaikKelasSnapshot> {
    this.inflight ??= this.read(by).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async read(by: string): Promise<NaikKelasSnapshot> {
    const source = this.currentSource;
    const exportUrl = sheetCsvExportUrl(source);
    try {
      if (!exportUrl) throw new Error('source_must_be_google_sheets_url');
      const res = await (this.options.fetch ?? fetch)(exportUrl, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      const text = await res.text();
      // A private sheet answers 200 with Google's sign-in HTML, not CSV.
      if (!res.ok) throw new Error(`sheet_http_${res.status}`);
      if (/^\s*</.test(text)) throw new Error('sheet_not_public');
      this.snapshot = { source, fetchedAt: this.now().toISOString(), fetchedBy: by, ...parseNaikKelasSheet(text) };
      this.lastError = undefined;
      this.persist();
      return this.snapshot;
    } catch (err) {
      this.lastError = { at: this.now().toISOString(), message: err instanceof Error ? err.message : String(err) };
      throw err;
    }
  }

  /** Change the source (empty = default) and read it at once. Throws on a non-Sheets URL. */
  async setSource(source: string, by: string): Promise<NaikKelasSnapshot> {
    const next = source.trim();
    if (next && !sheetCsvExportUrl(next)) throw new Error('source_must_be_google_sheets_url');
    this.source = next || undefined;
    this.persist();
    return this.refresh(by);
  }

  /** Hourly check; reads the sheet when the snapshot is older than the refresh window. */
  startAuto(intervalMs = 3_600_000): void {
    this.stopAuto();
    const tick = () => { if (this.isStale() && !this.inflight) this.refresh('auto').catch(() => undefined); };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }

  stopAuto(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
