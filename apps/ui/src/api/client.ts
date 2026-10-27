/**
 * Orchestrator API client for the UI.
 *
 * Thin wrapper over the REST endpoints plus an SSE subscription helper.
 * The base URL comes from VITE_ORCHESTRATOR_URL so the same build can target
 * different intranet hosts.
 *
 * Auth: login returns the canonical bearer token and also sets an HttpOnly
 * browser cookie. REST keeps the bearer for write authorization and sends the
 * cookie for authenticated reads; EventSource uses the cookie because it
 * cannot attach an Authorization header.
 */

import type { ExecutionMode, RunState, WorkflowDefinition, WorkflowEvent } from '@simrs-flow/workflow-core';

const BASE =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ORCHESTRATOR_URL ??
  '';
/** Orchestrator origin the UI talks to ('' = same origin as the page). */
export const API_BASE = BASE;

const TOKEN_KEY = 'simrs-flow.token';
const USER_KEY = 'simrs-flow.lastUser';

/** Persistent token (localStorage) wins over the per-tab token (sessionStorage)
 * so an opted-in "Ingat saya" login survives a full browser close. */
function readStoredToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

let authToken: string | undefined = readStoredToken();

/** Raised on a 401 so the UI can bounce back to the login screen. */
export class UnauthorizedError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export class NetworkError extends Error {
  constructor() {
    super('Tidak dapat terhubung ke server. Pastikan orchestrator berjalan dan alamat server benar.');
    this.name = 'NetworkError';
  }
}

function setToken(token: string | undefined, remember = false): void {
  authToken = token;
  try {
    if (token) {
      if (remember) {
        localStorage.setItem(TOKEN_KEY, token);
        sessionStorage.removeItem(TOKEN_KEY);
      } else {
        sessionStorage.setItem(TOKEN_KEY, token);
        localStorage.removeItem(TOKEN_KEY);
      }
    } else {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* storage unavailable — token still held in memory for this session */
  }
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return authToken ? { ...extra, Authorization: `Bearer ${authToken}` } : extra;
}

export interface WorkflowSummary {
  id: string;
  label: string;
  domain: string;
  version: string;
  nodeCount: number;
}

export interface HealthSummary {
  ok: boolean;
  ts: string;
  defaultMode?: 'preview';
  auditPersistent?: boolean;
  liveAvailable?: boolean;
  uiAvailable?: boolean;
  buildVersion?: string;
  host?: { name: string; platform: string; node: string; startedAt: string; uptimeSec: number };
  network?: { listen: string; loopbackOnly: boolean; urls: string[] };
  evomedis?: { baseUrl: string; host: string; baseUrlV2?: string };
  storage?: {
    auditDir?: string; audit?: { files: number; bytes: number };
    rulesDir?: string; rules?: { files: number; bytes: number };
    naikKelasFile?: string; naikKelas?: { bytes: number; modifiedAt: string };
    berkasCacheDir?: string; berkas?: { files: number; bytes: number };
    notesFile?: string; notes?: { bytes: number; modifiedAt: string };
  };
  policy?: { criticalApprovals: 1 | 2; autoApproveWrites: boolean; qaLogin: boolean };
}

/** `GET /api/health/simrs`: one unauthenticated GET of the SIMRS base URL from the host. */
export interface SimrsReachability {
  configured: boolean;
  reachable: boolean;
  status?: number;
  ms?: number;
  host?: string;
  checkedAt: string;
  error?: string;
}

export interface RunSummary {
  runId: string;
  workflowId: string;
  workflowVersion: string;
  mode: ExecutionMode;
  status: RunState['status'] | 'interrupted' | 'unreplayable';
  startedAt: string;
  finishedAt?: string;
  operator?: string;
  replayable: boolean;
  source: 'memory' | 'ledger';
  reason?: string;
  truncatedTail?: boolean;
}

/** `GET /api/rajal/unpaid` — the live unpaid-bill report as a run batch. */
export interface RajalUnpaidResult {
  patientIds: string[];
  clinics: string[];
  clinicsByPatientId: Record<string, string[]>;
  total: number;
}

/** One row of `GET /api/ranap/discharged` (laporan pasien keluar rawat inap). */
export interface RanapDischargeRow {
  noRm: string;
  nama: string;
  ruang: string;
  jaminan: string;
  dpjp: string;
  tglMasuk: string;
  tglKeluar: string;
  verifikasi: string;
  bayar: string;
}

/** The orchestrator's `{ error | message }` body, when the failed response has one. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string; message?: string };
    return j.message || j.error || '';
  } catch {
    // Fastify always answers 5xx with a JSON body; an empty 5xx is the Vite dev
    // proxy failing to reach the orchestrator (ECONNREFUSED on :4500).
    return res.status >= 500 ? 'orchestrator tidak terjangkau — jalankan run.bat api' : '';
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders(), credentials: 'include' });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    const detail = await errorDetail(res);
    throw new Error(`GET ${path.split('?')[0]} → ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: authHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    // Surface the orchestrator's error message when present.
    const detail = await errorDetail(res);
    throw new Error(`POST ${path} → ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

async function delJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: authHeaders(), credentials: 'include' });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** Rules-page values; the orchestrator (apps/orchestrator/src/rules.ts) validates and owns them. */
export interface RuleValues {
  ranap: { bankDarahUnits: string[]; cathlabUnits: string[]; ibsManualReviewRooms: string[] };
  rajal: {
    treatmentGroups: Array<{ group: string; key: string; name: string }>;
    skipTreatments: string[];
    paymentConfig: { shift: string; type: string; payerCode: string };
  };
}
export interface RuleSet { version: number; updatedAt?: string; updatedBy?: string; values: RuleValues }

export interface PresenceOperator { name: string; online: boolean; lastSeenMs: number; self: boolean; }
export interface PresenceResult { operators: PresenceOperator[]; onlineCount: number; }
export type NoteColor = 'amber' | 'sky' | 'green' | 'pink';
export interface StickyNote { id: string; author: string; text: string; color: NoteColor; createdAt: string; }

/** A hidden tab keeps its run stream this long before releasing the connection. */
const HIDDEN_RELEASE_MS = 10_000;

export const api = {
  // ── Auth ──
  isAuthenticated: () => Boolean(authToken),
  async login(username: string, password: string, remember = false): Promise<{ operator: string }> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
    } catch {
      throw new NetworkError();
    }
    if (!res.ok) {
      let message = 'login failed';
      try {
        const j = (await res.json()) as { message?: string };
        if (j.message) message = j.message;
      } catch {
        /* ignore */
      }
      throw new Error(message);
    }
    const { token, operator } = (await res.json()) as { token: string; operator: string };
    setToken(token, remember);
    try {
      if (remember) localStorage.setItem(USER_KEY, username);
      else localStorage.removeItem(USER_KEY);
    } catch { /* storage unavailable */ }
    return { operator };
  },
  /** Last username from a remembered login, for prefilling the form. */
  lastUsername(): string {
    try { return localStorage.getItem(USER_KEY) ?? ''; } catch { return ''; }
  },
  /** True when a persistent ("Ingat saya") token is present. */
  isRemembered(): boolean {
    try { return Boolean(localStorage.getItem(TOKEN_KEY)); } catch { return false; }
  },
  /** Clear only the stored auth token (keeps the remembered username). */
  forgetSession(): void { setToken(undefined); },
  async qaLogin(): Promise<{ operator: string }> {
    const { token, operator } = await postJson<{ token: string; operator: string }>('/api/auth/qa-login');
    setToken(token);
    return { operator };
  },
  async logout(): Promise<void> {
    try {
      await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: authHeaders(), credentials: 'include' });
    } finally {
      setToken(undefined);
    }
  },
  me: () => getJson<{ operator: string }>('/api/auth/me'),
  simrsHealth: () => getJson<SimrsReachability>('/api/health/simrs'),

  // ── Health, workflows & runs ──
  health: () => getJson<HealthSummary>('/api/health'),
  healthDetail: () => getJson<HealthSummary>('/api/health/details'),
  listWorkflows: () => getJson<{ workflows: WorkflowSummary[] }>('/api/workflows'),
  getWorkflow: (id: string) => getJson<WorkflowDefinition>(`/api/workflows/${id}`),
  createRun: (body: {
    workflowId: string;
    mode?: ExecutionMode;
    input?: unknown;
    enabled?: Record<string, boolean>;
    source?: 'fixture' | 'live';
    autoApprove?: boolean;
  }) => postJson<{ runId: string }>('/api/runs', body),
  listRuns: () => getJson<{ runs: RunSummary[] }>('/api/runs'),
  rajalUnpaid: (query: { from: string; to: string; instalasi?: string; penjamin?: string; unit?: string }) =>
    getJson<RajalUnpaidResult>(`/api/rajal/unpaid?${new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString()}`),
  ranapDischarged: (query: { from: string; to: string; masukFrom?: string; masukTo?: string; verifikasi?: string; bayar?: string; kelPenjamin?: string }) =>
    getJson<{ rows: RanapDischargeRow[] }>(`/api/ranap/discharged?${new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString()}`),
  getRun: (runId: string) => getJson<RunState>(`/api/runs/${runId}`),
  exportRunUrl: (runId: string) => `${BASE}/api/runs/${encodeURIComponent(runId)}/export.jsonl`,
  cancel: (runId: string) => postJson<{ cancelled: boolean }>(`/api/runs/${runId}/cancel`),
  pause: (runId: string) => postJson<{ paused: boolean }>(`/api/runs/${runId}/pause`),
  resume: (runId: string) => postJson<{ resumed: boolean }>(`/api/runs/${runId}/resume`),
  approveGate: (runId: string, nodeId: string, reason?: string) =>
    postJson<{ approved: boolean; resolved: boolean; remainingApprovals: number }>(
      `/api/runs/${runId}/gates/${nodeId}/approve`,
      { reason },
    ),
  rejectGate: (runId: string, nodeId: string, reason?: string) =>
    postJson<{ rejected: boolean }>(`/api/runs/${runId}/gates/${nodeId}/reject`, { reason }),
  /**
   * Approve one mutation plan. The orchestrator gates the apply — a `critical`
   * plan still needs a second operator (control #22, two-person rule); the
   * response says whether this call fired the write (`resolved`) or is still
   * waiting on another approver (`remainingApprovals`).
   */
  approveMutation: (runId: string, planId: string, reason?: string) =>
    postJson<{
      approved: boolean;
      resolved: boolean;
      approvals: string[];
      remainingApprovals: number;
      outcome?: { status: string; phase?: string; reason?: string };
    }>(`/api/runs/${runId}/mutations/${encodeURIComponent(planId)}/approve`, { reason }),

  // ── Rules page ──
  getRules: () => getJson<RuleSet>('/api/rules'),
  saveRules: (baseVersion: number, values: RuleValues) => postJson<RuleSet>('/api/rules', { baseVersion, values }),
  getRuleHistory: (limit = 20) => getJson<{ versions: RuleSet[] }>(`/api/rules/history?limit=${limit}`),

  // ── Team presence & sticky notes ──
  getPresence: () => getJson<PresenceResult>('/api/presence'),
  listNotes: () => getJson<{ notes: StickyNote[] }>('/api/notes'),
  addNote: (text: string, color: NoteColor) => postJson<{ note: StickyNote }>('/api/notes', { text, color }),
  deleteNote: (id: string) => delJson<{ ok: boolean }>(`/api/notes/${encodeURIComponent(id)}`),

  /**
   * Subscribe to a run's SSE stream. Returns an unsubscribe function.
   *
   * Reconnects with backoff on failure instead of dying silently: a transient
   * network blip or an orchestrator restart used to close the single
   * EventSource for good, leaving the run console frozen with no logs while the
   * run kept going server-side. The orchestrator replays full history to every
   * new subscriber, and `seen` (keyed on eventId/runId:seq) survives across
   * reconnects, so a re-subscribe is self-healing and never double-applies an
   * event into the store. Reconnects stop only on an explicit unsubscribe, on a
   * terminal run event, or after MAX_ATTEMPTS consecutive failures.
   */
  streamEvents(runId: string, onEvent: (e: WorkflowEvent) => void, onError?: (error: Error) => void): () => void {
    const url = `${BASE}/api/runs/${encodeURIComponent(runId)}/events`;
    const seen = new Set<string>();
    const MAX_ATTEMPTS = 8;
    let source: EventSource | undefined;
    let closed = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;

    // Chrome allows 6 HTTP/1.1 connections per host and every watching tab holds
    // one stream: from the 7th tab every request stalled. A tab hidden for a
    // while lets go of its stream and picks it up again when shown; the replayed
    // history is deduped by `seen`, so nothing is lost or doubled.
    let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = () => {
      if (closed || finished) return;
      if (document.visibilityState === 'hidden') {
        hiddenTimer ??= setTimeout(() => {
          hiddenTimer = undefined;
          if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
          source?.close();
          source = undefined;
        }, HIDDEN_RELEASE_MS);
        return;
      }
      if (hiddenTimer !== undefined) { clearTimeout(hiddenTimer); hiddenTimer = undefined; }
      if (!source && timer === undefined) { attempts = 0; connect(); }
    };
    const hasDocument = typeof document !== 'undefined';
    if (hasDocument) document.addEventListener('visibilitychange', onVisibility);

    const close = () => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
      if (hasDocument) document.removeEventListener('visibilitychange', onVisibility);
      source?.close();
      source = undefined;
    };

    const connect = () => {
      if (closed) return;
      source = new EventSource(url, { withCredentials: true });
      // The orchestrator emits unnamed (default "message") frames whose JSON
      // payload carries the event `type`, so a single onmessage handler is
      // sufficient and avoids double-dispatch.
      source.onmessage = (msg) => {
        try {
          const payload = JSON.parse(msg.data) as Partial<WorkflowEvent> & { error?: string; message?: string };
          if (payload.error) {
            // A server-side error (run_not_found / unreplayable) is terminal —
            // reconnecting would just fail the same way.
            close();
            onError?.(new Error(payload.message ?? payload.error));
            return;
          }
          // A live frame means the connection is healthy again.
          attempts = 0;
          const event = payload as WorkflowEvent;
          const eventKey = event.eventId ?? `${event.runId}:${event.seq}`;
          if (seen.has(eventKey)) return;
          seen.add(eventKey);
          onEvent(event);
          if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
            finished = true;
            close();
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      source.onerror = () => {
        if (closed || finished) return;
        // Drop the dead socket and re-subscribe with backoff. The replayed
        // history is deduped by `seen`, so we resume without losing or
        // repeating events. Surface the outage once so the operator sees it,
        // but keep trying instead of going permanently silent.
        source?.close();
        source = undefined;
        if (attempts === 0) onError?.(new Error('Koneksi ke orchestrator terputus — menyambung ulang…'));
        if (attempts >= MAX_ATTEMPTS) {
          close();
          onError?.(new Error('Koneksi ke orchestrator gagal setelah beberapa percobaan — cek orchestrator'));
          return;
        }
        const delay = Math.min(1000 * 2 ** attempts, 15000);
        attempts += 1;
        timer = setTimeout(connect, delay);
      };
    };

    connect();
    // Opened in a background tab: no visibilitychange will come, so start the release clock now.
    if (hasDocument && document.visibilityState === 'hidden') onVisibility();
    return close;
  },
};

export { BASE as ORCHESTRATOR_BASE };

