/**
 * Fastify server — REST commands + SSE event stream.
 *
 * Endpoints (see docs/architecture.md §Orchestrator API):
 *   GET  /                                 friendly landing page (points at the UI)
 *   POST /api/auth/login                   { username, password } -> { token, operator }
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 *   GET  /api/health
 *   GET  /api/workflows
 *   GET  /api/workflows/:workflowId
 *   GET  /api/rajal/unpaid?from&to[&instalasi&penjamin&unit]  live unpaid-bill batch (No. RM + poli)
 *   GET  /api/ranap/discharged?from&to[&masukFrom&masukTo&verifikasi&bayar&kelPenjamin]  live discharged-inpatient report
 *   GET  /api/naik-kelas                    Iur naik kelas snapshot (stored; auto re-read daily)
 *   POST /api/naik-kelas/refresh            read the sheet now (bearer operator)
 *   POST /api/naik-kelas/source             { source } change the sheet link (bearer operator)
 *   GET  /api/rules                         current Rules-page values + version
 *   POST /api/rules                         { baseVersion, values } (bearer operator)
 *   POST /api/runs                         { workflowId, mode?, input?, enabled?, source? }
 *   GET  /api/runs
 *   GET  /api/runs/:runId
 *   GET  /api/runs/:runId/events           (SSE stream)
 *   POST /api/runs/:runId/cancel
 *   POST /api/runs/:runId/pause | resume
 *   POST /api/runs/:runId/gates/:nodeId/approve
 *   POST /api/runs/:runId/gates/:nodeId/reject
 *   POST /api/runs/:runId/mutations/:planId/approve
 *   GET  /api/runs/:runId/export.jsonl
 *
 * The server is intentionally thin: all logic lives in RunService and the
 * headless engine. This file only translates HTTP to service calls.
 *
 * Unified authentication: login issues a session token plus an HttpOnly app
 * cookie. Bearer-or-cookie auth protects dashboard reads/SSE; write actions
 * remain bearer-only and bind live runs to the user's EvoMedis session.
 */

import type { BerkasReaderPort } from '@simrs-flow/domain-ranap';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { accessUrls, dirStats, fileStats, safeUrl } from './config.js';
import { FileLedger, type Ledger } from '@simrs-flow/audit-ledger';
import { EvoMedisClient, FetchTransport, LoginFailedError } from '@simrs-flow/evomedis-client';
import { fetchRajalUnpaidBatch } from '@simrs-flow/domain-rajal';
import { buildRanapDischargeQuery, parseRanapDischargeReport, type RanapReportFlag } from '@simrs-flow/domain-ranap';
import { ReloginTransport } from './reloginTransport.js';
import { NaikKelasStore, sheetCsvExportUrl } from './naikKelas.js';
import { billingSummary, summarizeRun, type RunDashboardPart } from './dashboard.js';
import type { WorkflowEvent } from '@simrs-flow/workflow-core';
import { RunService, type CreateRunInput, type LiveConfig } from './RunService.js';
import { getWorkflow, listWorkflows } from './registry.js';
import {
  OperatorRegistry,
  clearSessionCookie,
  sessionCookie,
} from './auth.js';
import { UserSessionStore } from './sessions.js';
import { RuleStore } from './rules.js';

export interface ServerOptions {
  ledger: Ledger;
  corsOrigins?: string[];
  /**
   * Per-user EvoMedis session store. When present, /api/auth/login works and
   * tokens authorize write actions + supply each run's EvoMedis cookie.
   */
  sessions?: UserSessionStore;
  /**
   * Optional shared service-account cookie (env fallback). Used for live runs
   * that carry no per-user session token.
   */
  live?: LiveConfig;
  /**
   * Path to the built UI static bundle (e.g. `apps/ui/dist`). When present,
   * the orchestrator serves the React Flow canvas alongside the API so the
   * whole app is available on a single port (useful for production / intranet
   * deployments). When absent (or the directory doesn't exist), the root `/`
   * falls back to a landing page that points at the dev UI on port 5173.
   */
  /** Local QA-only bearer token; unset in normal/dev/prod runs. */
  qaAuth?: { readonly token: string; readonly operator: string };
  /**
   * Host default for auto-approving write runs (`AUTO_APPROVE_WRITES=true`).
   * When set, every write run skips the human gate/plan confirmation. Off
   * unless the host explicitly opts in.
   */
  autoApproveWrites?: boolean;
  /** `CRITICAL_APPROVALS` (1 or 2; main.ts defaults to 1); see RunServiceOptions. */
  criticalApprovals?: 1 | 2;
  /** Rules-page store; defaults to a memory-only store (built-in values). */
  rules?: RuleStore;
  /** Add Secure to the browser session cookie (required behind production HTTPS). */
  secureCookies?: boolean;
  uiDir?: string;
  /** Iur naik kelas snapshot store; defaults to a memory-only store with no sheet. */
  naikKelas?: NaikKelasStore;
  /** Claim bundle reader for the opt-in Kelengkapan Berkas run step. */
  berkas?: BerkasReaderPort;
  /** Non-secret host facts for the Settings page (from main.ts env wiring). */
  about?: HostAbout;
  /** Team sticky notes (JSON). Unset = memory only (tests). */
  notesFile?: string;
}

export interface HostAbout {
  evomedisBaseUrl?: string;
  evomedisBaseUrlV2?: string;
  listenHost?: string;
  listenPort?: number;
  auditDir?: string;
  rulesDir?: string;
  naikKelasFile?: string;
  berkasCacheDir?: string;
}

const STARTED_AT = new Date().toISOString();

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const sessions = options.sessions;
  const qaAuth = options.qaAuth;
  const rules = options.rules ?? new RuleStore();
  const service = new RunService(options.ledger, {
    rules,
    live: options.live,
    sessions,
    autoApproveWrites: options.autoApproveWrites ?? false,
    criticalApprovals: options.criticalApprovals,
    ...(options.berkas ? { berkas: options.berkas } : {}),
  });

  void app.register(cors, {
    origin: options.corsOrigins ?? true,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE'],
  });

  // ── Static UI (optional) ───────────────────────────────────────────
  // When a built UI bundle directory is provided, serve it so the entire app
  // (API + canvas) runs on a single port. The dev workflow uses Vite on :5173
  // instead, so this is skipped during development.
  const uiDir = options.uiDir && existsSync(options.uiDir) ? options.uiDir : null;
  if (uiDir) {
    void app.register(fastifyStatic, {
      root: uiDir,
      prefix: '/',
      decorateReply: true,
    });
  }

  /** Bearer token used for mutations; cookies never authorize writes. */
  const bearerTokenOf = (req: FastifyRequest) => OperatorRegistry.bearer(req.headers['authorization']);

  /** Browser reads/SSE may use the HttpOnly app cookie or the existing bearer. */
  const readTokenOf = (req: FastifyRequest) =>
    bearerTokenOf(req) ?? OperatorRegistry.cookie(req.headers.cookie);

  const operatorForToken = (token: string | undefined): { name: string; token: string } | undefined => {
    const session = sessions?.resolve(token);
    if (session && token) return { name: session.operator, token };
    if (token && qaAuth && token === qaAuth.token) return { name: qaAuth.operator, token };
    return undefined;
  };

  const readOperatorOf = (req: FastifyRequest) => operatorForToken(readTokenOf(req));
  const writeOperatorOf = (req: FastifyRequest) => operatorForToken(bearerTokenOf(req));
  const requireRead = (req: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    const operator = readOperatorOf(req);
    // Return undefined, not the (truthy) reply: callers do `if (!requireRead(..)) return reply`,
    // and returning the reply let the handler body run on after the 401 was sent.
    if (!operator) {
      reply.code(401).send({ error: 'operator_auth_required' });
      return undefined;
    }
    return operator;
  };

  // ── Auth ──────────────────────────────────────────────────────────
  app.post<{ Body: { username?: string; password?: string } }>('/api/auth/login', async (req, reply) => {
    if (!sessions) return reply.code(503).send({ error: 'login_unavailable' });
    const { username, password } = req.body ?? {};
    try {
      const { token, operator } = await sessions.login(username ?? '', password ?? '');
      reply.header('Set-Cookie', sessionCookie(token, options.secureCookies ?? false));
      return reply.code(200).send({ token, operator });
    } catch (err) {
      const message = err instanceof LoginFailedError ? err.reason : 'login failed';
      return reply.code(401).send({ error: 'login_failed', message });
    }
  });

  if (qaAuth) {
    app.post('/api/auth/qa-login', async (_req, reply) => {
      reply.header('Set-Cookie', sessionCookie(qaAuth.token, options.secureCookies ?? false));
      return reply.code(200).send({ token: qaAuth.token, operator: qaAuth.operator });
    });
  }

  app.post('/api/auth/logout', async (req, reply) => {
    sessions?.logout(readTokenOf(req));
    reply.header('Set-Cookie', clearSessionCookie(options.secureCookies ?? false));
    return reply.code(200).send({ ok: true });
  });

  app.get('/api/auth/me', async (req, reply) => {
    const op = readOperatorOf(req);
    if (!op) return reply.code(401).send({ error: 'not_authenticated' });
    return { operator: op.name };
  });

  // When no UI bundle is being served, fall back to a friendly landing page
  // so a browser hitting `/` doesn't get a bare Fastify 404. When a built UI
  // is present, @fastify/static serves its index.html at `/` instead.
  if (!uiDir) {
    app.get('/', async (_req, reply) => {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>SIMRS-Flow orchestrator</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1.5rem; color: #1a1a1a; }
  h1 { font-size: 1.3rem; } code { background: #f0f0f0; padding: .1rem .35rem; border-radius: 3px; }
  a { color: #0a58ca; } ul { padding-left: 1.2rem; } .muted { color: #666; }
</style></head>
<body>
  <h1>SIMRS-Flow orchestrator</h1>
  <p>This is the <strong>API server</strong> (mode default: <strong>preview</strong>). It has no web page of its own — the workflow canvas is a separate app.</p>
  <p><strong>Open the UI here:</strong> <a href="http://localhost:5173">http://localhost:5173</a></p>
  <p class="muted">Useful API endpoints on this server:</p>
  <ul>
    <li><a href="/api/health">/api/health</a> — liveness check</li>
    <li><a href="/api/workflows">/api/workflows</a> — registered workflows</li>
    <li><a href="/api/runs">/api/runs</a> — runs</li>
  </ul>
</body>
</html>`;
    });
  }

  app.get('/api/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get('/api/health/details', async (req, reply) => {
    if (!requireRead(req, reply)) return reply;
    return {
      ok: true,
      ts: new Date().toISOString(),
      defaultMode: 'preview',
      auditPersistent: options.ledger instanceof FileLedger,
      liveAvailable: Boolean(options.live || sessions),
      uiAvailable: Boolean(uiDir),
      buildVersion: process.env.npm_package_version ?? 'development',
      ...hostDetails(options),
    };
  });

  // Dashboard reads, derived from the audit ledger (see dashboard.ts). A
  // finished run's file never changes, so its part is computed once; the
  // naik kelas list is part of the key because it changes the category.
  const dashboardCache = new Map<string, { naikKelasAt: string; part: RunDashboardPart }>();
  const dashboardParts = async (): Promise<RunDashboardPart[]> => {
    const snapshot = naikKelas.status().snapshot;
    const naikKelasAt = snapshot?.fetchedAt ?? '';
    const naikKelasRm = new Set((snapshot?.rows ?? []).map((row) => row.noRm));
    const parts = await Promise.all((await options.ledger.listRuns()).map(async (runId) => {
      const cached = dashboardCache.get(runId);
      if (cached && cached.naikKelasAt === naikKelasAt) return cached.part;
      const history = await options.ledger.readHistory(runId).catch(() => undefined);
      if (!history) return undefined;
      const live = service.isLive(runId);
      const part = summarizeRun(history, naikKelasRm, live);
      if (!live && history.status !== 'interrupted') dashboardCache.set(runId, { naikKelasAt, part });
      return part;
    }));
    return parts.filter((part): part is RunDashboardPart => Boolean(part));
  };

  app.get('/api/billing/summary', async (req, reply) => {
    if (!requireRead(req, reply)) return reply;
    return billingSummary(await dashboardParts(), new Date());
  });

  app.get('/api/patients', async (req, reply) => {
    if (!requireRead(req, reply)) return reply;
    const patients = (await dashboardParts()).flatMap((part) => part.patients)
      .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
    return { patients };
  });

  // ── Presence & sticky notes ─────────────────────────────────────
  // Who is active is live state (memory, from each operator's own requests);
  // the team's sticky notes persist in `notesFile` so a restart keeps them.
  const NOTE_COLORS = ['amber', 'sky', 'green', 'pink'] as const;
  type NoteColor = (typeof NOTE_COLORS)[number];
  interface StickyNote { id: string; author: string; text: string; color: NoteColor; createdAt: string; }
  const presence = new Map<string, number>();
  const notes: StickyNote[] = (() => {
    if (!options.notesFile || !existsSync(options.notesFile)) return [];
    try {
      const saved = JSON.parse(readFileSync(options.notesFile, 'utf8')) as unknown;
      return Array.isArray(saved) ? (saved as StickyNote[]) : [];
    } catch {
      return [];
    }
  })();
  let noteSeq = notes.reduce((max, n) => Math.max(max, Number(n.id.replace(/\D/g, '')) || 0), 0);
  const saveNotes = () => {
    if (!options.notesFile) return;
    mkdirSync(dirname(options.notesFile), { recursive: true });
    const tmp = `${options.notesFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(notes, null, 2));
    renameSync(tmp, options.notesFile);
  };
  const ONLINE_WINDOW_MS = 90_000;
  const touch = (name: string | undefined) => { if (name) presence.set(name, Date.now()); };
  const presenceList = (self?: string) => {
    const now = Date.now();
    if (self) presence.set(self, now);
    const operators = [...presence.entries()].map(([name, last]) => (
      { name, online: now - last <= ONLINE_WINDOW_MS, lastSeenMs: last, self: name === self }
    )).sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeenMs - a.lastSeenMs);
    return { operators, onlineCount: operators.filter((o) => o.online).length };
  };

  app.get('/api/presence', async (req, reply) => {
    const op = readOperatorOf(req);
    if (!op) return reply.code(401).send({ error: 'operator_auth_required' });
    touch(op.name);
    return presenceList(op.name);
  });

  app.get('/api/notes', async (req, reply) => {
    const op = readOperatorOf(req);
    if (!op) return reply.code(401).send({ error: 'operator_auth_required' });
    touch(op.name);
    return { notes: [...notes].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) };
  });

  app.post<{ Body: { text?: string; color?: string } }>('/api/notes', async (req, reply) => {
    const op = readOperatorOf(req);
    if (!op) return reply.code(401).send({ error: 'operator_auth_required' });
    const text = (req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'text_required' });
    if (text.length > 280) return reply.code(400).send({ error: 'text_too_long' });
    const color = (NOTE_COLORS as readonly string[]).includes(req.body?.color ?? '')
      ? (req.body!.color as NoteColor)
      : 'amber';
    noteSeq += 1;
    const note: StickyNote = { id: `n${noteSeq}`, author: op.name, text, color, createdAt: new Date().toISOString() };
    notes.push(note);
    saveNotes();
    touch(op.name);
    return reply.code(201).send({ note });
  });

  app.delete<{ Params: { id: string } }>('/api/notes/:id', async (req, reply) => {
    const op = readOperatorOf(req);
    if (!op) return reply.code(401).send({ error: 'operator_auth_required' });
    const idx = notes.findIndex((n) => n.id === req.params.id);
    if (idx === -1) return reply.code(404).send({ error: 'note_not_found' });
    // Shared team board: any authenticated operator may clear a note.
    notes.splice(idx, 1);
    saveNotes();
    return reply.code(200).send({ ok: true });
  });

  app.get('/api/workflows', async (req, reply) => {
    if (!requireRead(req, reply)) return reply;
    return {
      workflows: listWorkflows().map((w) => ({
        id: w.id,
        label: w.label,
        domain: w.domain,
        version: w.version,
        nodeCount: w.nodes.length,
      })),
    };
  });

  app.get<{ Params: { workflowId: string } }>('/api/workflows/:workflowId', async (req, reply) => {
    if (!requireRead(req, reply)) return reply;
    const entry = getWorkflow(req.params.workflowId);
    if (!entry) return reply.code(404).send({ error: 'workflow_not_found' });
    return entry.definition;
  });

  // Legacy `doFetch` for the run setup: the live unpaid-bill report as a batch
  // (No. RM list + poli headings) the operator then edits. Also feeds the poli
  // picker, so a clinic SIMRS adds shows up without a code change.
  // Read-only (preview client).
  /**
   * A preview-mode client on the caller's own EvoMedis session (re-login on
   * expiry), for the run-setup report reads. Sends 401/409 and returns
   * undefined when there is no live session.
   */
  const liveReadClient = (req: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    const operator = readOperatorOf(req);
    if (!operator) { reply.code(401).send({ error: 'operator_auth_required' }); return undefined; }
    const cookie = sessions?.cookieFor(operator.token);
    if (!sessions || !cookie) { reply.code(409).send({ error: 'live_session_required' }); return undefined; }
    return new EvoMedisClient(
      { baseUrlV1: sessions.baseUrlV1, baseUrlV2: sessions.baseUrlV2, cookieName: sessions.cookieName, cookie },
      {
        mode: 'preview',
        transport: new ReloginTransport(new FetchTransport(), sessions, operator.token, sessions.cookieName),
      },
    );
  };
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  app.get<{ Querystring: { from?: string; to?: string; instalasi?: string; penjamin?: string; unit?: string } }>('/api/rajal/unpaid', async (req, reply) => {
    const from = req.query.from ?? '';
    const to = req.query.to ?? '';
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return reply.code(400).send({ error: 'from_to_required' });
    const client = liveReadClient(req, reply);
    if (!client) return reply;
    try {
      const { instalasi, penjamin, unit } = req.query;
      const batch = await fetchRajalUnpaidBatch(client, {
        from,
        to,
        ...(instalasi?.trim() ? { instalasi: instalasi.trim() } : {}),
        ...(penjamin?.trim() ? { penjamin: penjamin.trim() } : {}),
        ...(unit?.trim() ? { unit: unit.trim() } : {}),
      });
      if (!batch.readable) return reply.code(502).send({ error: 'report_unreadable' });
      return {
        patientIds: batch.uniquePatientIds,
        clinics: batch.clinics,
        clinicsByPatientId: batch.clinicsByPatientId,
        total: batch.stats.total,
      };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Rawat inap counterpart: the discharged-inpatient report the cashier uses
  // (laporan_keluar_rwi_kasir), filtered by verification/payment state.
  app.get<{ Querystring: { from?: string; to?: string; masukFrom?: string; masukTo?: string; verifikasi?: string; bayar?: string; kelPenjamin?: string } }>('/api/ranap/discharged', async (req, reply) => {
    const { from = '', to = '', masukFrom = '', masukTo = '', verifikasi = '', bayar = '', kelPenjamin = '' } = req.query;
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return reply.code(400).send({ error: 'from_to_required' });
    if ((masukFrom && !ISO_DATE.test(masukFrom)) || (masukTo && !ISO_DATE.test(masukTo))) return reply.code(400).send({ error: 'masuk_invalid' });
    const flag = (v: string): RanapReportFlag => (v === '0' || v === '1' ? v : '');
    if (!/^\d{0,2}$/.test(kelPenjamin)) return reply.code(400).send({ error: 'kelPenjamin_invalid' });
    const client = liveReadClient(req, reply);
    if (!client) return reply;
    try {
      const html = await client.postText('laporanKeluarRanap.preview', {}, {
        query: buildRanapDischargeQuery({ keluarFrom: from, keluarTo: to, masukFrom, masukTo, verifikasi: flag(verifikasi), bayar: flag(bayar), kelPenjamin }),
      });
      const report = parseRanapDischargeReport(html);
      if (!report.readable) return reply.code(502).send({ error: 'report_unreadable' });
      return { rows: report.rows };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // Iur naik kelas: the doctors' Google Form responses sheet. Views are served
  // from the stored snapshot (auto re-read every refresh window); an operator
  // can force a read or change the source. Only Google Sheets links are
  // accepted, and only their fixed CSV export URL is ever fetched.
  const naikKelas = options.naikKelas ?? new NaikKelasStore();
  app.get('/api/naik-kelas', async (req, reply) => {
    if (!requireRead(req, reply)) return reply;
    // First view on a fresh host: read once so the page is not empty.
    if (!naikKelas.status().snapshot) await naikKelas.refresh('first view').catch(() => undefined);
    return naikKelas.status();
  });
  app.post('/api/naik-kelas/refresh', async (req, reply) => {
    const operator = writeOperatorOf(req);
    if (!operator) return reply.code(401).send({ error: 'operator_auth_required' });
    try {
      await naikKelas.refresh(operator.name);
      return naikKelas.status();
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message, status: naikKelas.status() });
    }
  });
  app.post<{ Body: { source?: unknown } }>('/api/naik-kelas/source', async (req, reply) => {
    const operator = writeOperatorOf(req);
    if (!operator) return reply.code(401).send({ error: 'operator_auth_required' });
    const source = typeof req.body?.source === 'string' ? req.body.source : '';
    if (source.trim() && !sheetCsvExportUrl(source)) return reply.code(400).send({ error: 'source_must_be_google_sheets_url' });
    try {
      await naikKelas.setSource(source, operator.name);
      return naikKelas.status();
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message, status: naikKelas.status() });
    }
  });

  // ── Rules page ────────────────────────────────────────────────────
  app.get('/api/rules', async (req, reply) => {
    if (!requireRead(req, reply)) return reply;
    return rules.get();
  });

  app.get<{ Querystring: { limit?: string } }>('/api/rules/history', async (req, reply) => {
    if (!requireRead(req, reply)) return reply;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    return { versions: rules.history(limit) };
  });

  app.post<{ Body: { baseVersion?: unknown; values?: unknown } }>('/api/rules', async (req, reply) => {
    // Changing rules alters future runs: bearer operator only, like a write run.
    const operator = writeOperatorOf(req);
    if (!operator) return reply.code(401).send({ error: 'operator_auth_required' });
    try {
      return await rules.save(req.body?.values, req.body?.baseVersion, operator.name);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }
  });

  app.post<{ Body: CreateRunInput }>('/api/runs', async (req, reply) => {
    const body = req.body ?? ({} as CreateRunInput);
    if (!body.workflowId) return reply.code(400).send({ error: 'workflowId_required' });

    // Write runs require an authenticated operator (fail closed).
    let operator: string | undefined;
    let sessionToken: string | undefined;
    if (body.mode === 'write') {
      const op = writeOperatorOf(req);
      if (!op) return reply.code(401).send({ error: 'operator_auth_required' });
      operator = op.name;
      sessionToken = op.token;
    } else {
      // Preview runs may still carry a session so live reads use the user's cookie.
      const op = writeOperatorOf(req);
      operator = op?.name;
      sessionToken = op?.token;
    }

    // `autoApprove` skips the human confirmation for a write run's gates and
    // plans. It is only meaningful (and only accepted) on an authenticated
    // write run; everything else — allowlist, preconditions, read-after-write
    // verification — still runs.
    const autoApprove = body.mode === 'write' && body.autoApprove === true;
    if (body.autoApprove === true && body.mode !== 'write') {
      return reply.code(400).send({ error: 'autoApprove_requires_write_mode' });
    }

    try {
      // `qa` (fixture scenarios, latency, faults) is honoured on a QA host only.
      const { qa, ...rest } = body;
      const { runId } = await service.createRun({ ...rest, autoApprove, operator, sessionToken, ...(qaAuth && qa ? { qa } : {}) });
      return reply.code(201).send({ runId });
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(statusCode).send({ error: (err as Error).message });
    }
  });

  app.get('/api/runs', async (req, reply) => {
    if (!requireRead(req, reply)) return reply;
    return { runs: await service.listRuns() };
  });

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (req, reply) => {
    if (!requireRead(req, reply)) return reply;
    try {
      const state = await service.getState(req.params.runId);
      if (!state) return reply.code(404).send({ error: 'run_not_found' });
      return state;
    } catch (err) {
      return reply.code(409).send({ error: 'run_unreplayable', message: (err as Error).message });
    }
  });

  // Server-Sent Events stream of the run's events (history replayed first).
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/events', async (req, reply) => {
    if (!requireRead(req, reply)) return reply;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const write = (event: WorkflowEvent) => {
      // Intentionally unnamed frames: every frame is a default "message"
      // event so the browser EventSource `onmessage` handler receives it.
      // The event kind is carried in the JSON payload's `type` field, so no
      // information is lost by omitting the SSE `event:` line.
      reply.raw.write(`id: ${event.seq}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      const subscription = await service.subscribe(req.params.runId, write);
      if (!subscription) {
        reply.raw.write(`data: ${JSON.stringify({ error: 'run_not_found' })}\n\n`);
        reply.raw.end();
        return;
      }
      if (subscription.historical) {
        reply.raw.end();
        return;
      }
      // Heartbeat keeps proxies from closing the idle connection.
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15000);
      req.raw.on('close', () => {
        clearInterval(heartbeat);
        subscription.unsubscribe();
      });
    } catch (err) {
      reply.raw.write(`data: ${JSON.stringify({ error: 'run_unreplayable', message: (err as Error).message })}\n\n`);
      reply.raw.end();
    }
  });

  app.post<{ Params: { runId: string } }>('/api/runs/:runId/cancel', async (req, reply) => {
    // Cancelling a write run is a privileged action; preview runs are open so
    // the kill switch stays frictionless for dry-runs.
    if (service.getMode(req.params.runId) === 'write' && !writeOperatorOf(req)) {
      return reply.code(401).send({ error: 'operator_auth_required' });
    }
    return service.cancel(req.params.runId)
      ? { cancelled: true }
      : reply.code(404).send({ error: 'run_not_found' });
  });

  // Pause/resume follow the cancel route's auth: open for preview, operator-only for write runs.
  for (const action of ['pause', 'resume'] as const) {
    app.post<{ Params: { runId: string } }>(`/api/runs/:runId/${action}`, async (req, reply) => {
      const op = writeOperatorOf(req);
      if (service.getMode(req.params.runId) === 'write' && !op) {
        return reply.code(401).send({ error: 'operator_auth_required' });
      }
      return service[action](req.params.runId, op?.name)
        ? { [action === 'pause' ? 'paused' : 'resumed']: true }
        : reply.code(409).send({ error: `run_not_${action === 'pause' ? 'pausable' : 'paused'}` });
    });
  }

  app.post<{ Params: { runId: string; nodeId: string }; Body: { reason?: string } }>(
    '/api/runs/:runId/gates/:nodeId/approve',
    async (req, reply) => {
      const op = writeOperatorOf(req);
      if (!op) return reply.code(401).send({ error: 'operator_auth_required' });
      const result = service.approveGate(req.params.runId, req.params.nodeId, op.name, req.body?.reason);
      if (!result.ok) return reply.code(404).send({ error: 'gate_not_waiting' });
      return { approved: true, resolved: result.resolved, remainingApprovals: result.remaining };
    },
  );

  app.post<{ Params: { runId: string; nodeId: string }; Body: { reason?: string } }>(
    '/api/runs/:runId/gates/:nodeId/reject',
    async (req, reply) => {
      const op = writeOperatorOf(req);
      if (!op) return reply.code(401).send({ error: 'operator_auth_required' });
      return service.rejectGate(req.params.runId, req.params.nodeId, op.name, req.body?.reason)
        ? { rejected: true }
        : reply.code(404).send({ error: 'gate_not_waiting' });
    },
  );

  /**
   * Approve a proposed mutation, and apply it once enough operators have.
   *
   * Bearer-only, like every write action. Approval does not itself write: the
   * mutation gate replays the plan's preconditions immediately before the call
   * and its read-after-write rules immediately after, so a stale approval is
   * refused rather than executed. A refusal is a 200 whose `outcome.status` is
   * `invalidated` — the operator needs the detail, not a bare error.
   */
  app.post<{ Params: { runId: string; planId: string }; Body: { reason?: string } }>(
    '/api/runs/:runId/mutations/:planId/approve',
    async (req, reply) => {
      const op = writeOperatorOf(req);
      if (!op) return reply.code(401).send({ error: 'operator_auth_required' });
      const result = await service.approveMutation(
        req.params.runId,
        req.params.planId,
        op.name,
        req.body?.reason,
      );
      if (!result.ok) {
        const notFound = result.error === 'run_not_found' || result.error === 'plan_not_found';
        return reply.code(notFound ? 404 : 409).send({ error: result.error, message: result.message });
      }
      return {
        approved: true,
        resolved: result.resolved,
        approvals: result.approvals,
        remainingApprovals: result.remaining,
        ...(result.resolved ? { outcome: result.outcome } : {}),
      };
    },
  );

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/export.jsonl', async (req, reply) => {
    if (!requireRead(req, reply)) return reply;
    const jsonl = await service.exportJsonl(req.params.runId);
    if (jsonl === undefined) return reply.code(404).send({ error: 'run_not_found' });
    return reply.header('Content-Type', 'application/x-ndjson').send(jsonl);
  });

  // Expose internals for tests.
  (app as unknown as { runService: RunService }).runService = service;
  if (sessions) (app as unknown as { sessions: UserSessionStore }).sessions = sessions;
  return app;
}

/** Where this host listens, which SIMRS it talks to, and where it keeps files; nothing secret. */
function hostDetails(options: ServerOptions) {
  const about = options.about ?? {};
  const evomedis = safeUrl(about.evomedisBaseUrl);
  const access = about.listenHost && about.listenPort ? accessUrls(about.listenHost, about.listenPort, networkInterfaces()) : undefined;
  return {
    host: {
      name: hostname(),
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      startedAt: STARTED_AT,
      uptimeSec: Math.round(process.uptime()),
    },
    network: access ? { listen: `${about.listenHost}:${about.listenPort}`, ...access } : undefined,
    evomedis: evomedis ? { baseUrl: evomedis, host: new URL(evomedis).host, baseUrlV2: safeUrl(about.evomedisBaseUrlV2) } : undefined,
    // Where each dataset lives and how much is there, so an operator can see what survives a restart.
    storage: {
      auditDir: about.auditDir ? resolve(about.auditDir) : undefined,
      audit: about.auditDir ? dirStats(resolve(about.auditDir), '.jsonl') : undefined,
      rulesDir: about.rulesDir ? resolve(about.rulesDir) : undefined,
      rules: about.rulesDir ? dirStats(resolve(about.rulesDir)) : undefined,
      naikKelasFile: about.naikKelasFile ? resolve(about.naikKelasFile) : undefined,
      naikKelas: about.naikKelasFile ? fileStats(resolve(about.naikKelasFile)) : undefined,
      berkasCacheDir: about.berkasCacheDir ? resolve(about.berkasCacheDir) : undefined,
      berkas: about.berkasCacheDir ? dirStats(resolve(about.berkasCacheDir), '.json') : undefined,
    },
    policy: {
      criticalApprovals: options.criticalApprovals ?? 2,
      autoApproveWrites: options.autoApproveWrites ?? false,
      qaLogin: Boolean(options.qaAuth),
    },
  };
}
