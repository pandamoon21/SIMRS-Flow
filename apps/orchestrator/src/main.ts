/**
 * Orchestrator entry point. Reads configuration from the environment
 * (never hardcoded credentials), wires the audit ledger, and starts the
 * Fastify server.
 */

import { FileLedger, MemoryLedger, type Ledger } from '@simrs-flow/audit-ledger';
import { buildServer } from './server.js';
import { createBerkasReader } from '@simrs-flow/berkas';
import { UserSessionStore } from './sessions.js';
import { RuleStore } from './rules.js';
import { NaikKelasStore } from './naikKelas.js';
import { accessUrls, corsOriginsFromEnv, env } from './config.js';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Placeholder until EVOMEDIS_BASE_URL is set: logins fail, offline fixtures still work. */
const UNSET_EVOMEDIS_BASE_URL = 'https://simrs.invalid/evomedis/index.php';

async function main(): Promise<void> {
  const port = Number(env('ORCHESTRATOR_PORT', '4500'));
  // LAN by default so other PCs reach the app; set ORCHESTRATOR_HOST=127.0.0.1 for this PC only.
  const hostSet = env('ORCHESTRATOR_HOST') !== undefined;
  let host = env('ORCHESTRATOR_HOST', '0.0.0.0')!;
  const corsOrigins = corsOriginsFromEnv();

  const auditDir = env('AUDIT_LEDGER_DIR');
  const ledger: Ledger = auditDir ? new FileLedger(auditDir) : new MemoryLedger();

  // EvoMedis target, from EVOMEDIS_BASE_URL (no built-in default). Users log
  // in per-user via POST /api/auth/login, which establishes their own cookie.
  const baseUrlV1 = env('EVOMEDIS_BASE_URL') ?? UNSET_EVOMEDIS_BASE_URL;
  // eslint-disable-next-line no-console
  if (baseUrlV1 === UNSET_EVOMEDIS_BASE_URL) console.warn('[orchestrator] EVOMEDIS_BASE_URL is not set: EvoMedis login will fail until it is (see .env.example)');
  const baseUrlV2 = env('EVOMEDIS_BASE_URL_V2');
  const cookieName = env('EVOMEDIS_SESSION_COOKIE_NAME', 'ci_session')!;

  // Per-user session store: the primary auth path. A successful EvoMedis login
  // issues a token that authorizes write actions and supplies the run cookie.
  const sessions = new UserSessionStore({ baseUrlV1, baseUrlV2, cookieName });

  // Optional shared service-account cookie (env fallback) for live runs that
  // carry no per-user session token.
  const cookieValue = env('EVOMEDIS_SESSION_COOKIE');
  const live = cookieValue
    ? { baseUrlV1, cookie: `${cookieName}=${cookieValue}`, baseUrlV2 }
    : undefined;

  // Serve the built UI bundle alongside the API when available. The UI is
  // built into apps/ui/dist by `npm run build`; when that directory exists,
  // the orchestrator serves its index.html and assets at `/` so the whole
  // app is reachable on a single port. Set UI_DIR to override the default.
  const uiDir = env('UI_DIR', join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'dist'));

  const qaAuthToken = env('QA_AUTH_TOKEN');
  // QA login bypasses EvoMedis auth; never expose it beyond this machine. An
  // explicit LAN bind with QA on is refused; the LAN *default* steps back to loopback.
  if (qaAuthToken && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    if (hostSet) throw new Error(`QA_AUTH_TOKEN is set but ORCHESTRATOR_HOST=${host} is not loopback; unset QA_AUTH_TOKEN for LAN/production`);
    host = '127.0.0.1';
    // eslint-disable-next-line no-console
    console.warn('[orchestrator] QA_AUTH_TOKEN is set: binding 127.0.0.1 only (unset it to serve the LAN)');
  }
  const qaAuth = qaAuthToken ? { token: qaAuthToken, operator: env('QA_AUTH_OPERATOR', 'qa-operator')! } : undefined;
  const secureCookies = env('APP_COOKIE_SECURE', '0') === '1';
  // Pilot convenience: skip the human gate/plan confirmation for write runs.
  // Everything else (allowlist, preconditions, read-after-write verification,
  // audit trail) still applies. Off unless the host opts in.
  const autoApproveWrites = env('AUTO_APPROVE_WRITES', '0') === '1';

  // Single-operator site: CRITICAL_APPROVALS=1 lets one operator approve verifikasi/tampung bayar.
  const criticalApprovals = env('CRITICAL_APPROVALS', '2') === '1' ? 1 : 2;
  // Rules-page values are configuration, not run state: always persisted.
  const rules = new RuleStore(env('RULES_DIR', './.data/rules'));
  // Iur naik kelas: stored snapshot of the doctors' form sheet, re-read once per
  // NAIK_KELAS_REFRESH_HOURS (default 24) and on an operator's manual refresh.
  const naikKelas = new NaikKelasStore({
    file: env('NAIK_KELAS_FILE', './.data/naik-kelas.json'),
    defaultSource: env('NAIK_KELAS_SHEET_URL', ''),
    refreshHours: Number(env('NAIK_KELAS_REFRESH_HOURS', '24')),
  });
  naikKelas.startAuto();
  // Kelengkapan Berkas: PDF + offline OCR on this host; results cached per No. RM + stay dates.
  const berkasCacheDir = env('BERKAS_CACHE_DIR', './.data/berkas')!;
  const berkas = createBerkasReader({ cacheDir: berkasCacheDir });
  const about = {
    evomedisBaseUrl: baseUrlV1,
    evomedisBaseUrlV2: baseUrlV2,
    listenHost: host,
    listenPort: port,
    auditDir,
    rulesDir: env('RULES_DIR', './.data/rules'),
    naikKelasFile: env('NAIK_KELAS_FILE', './.data/naik-kelas.json'),
    berkasCacheDir,
  };
  const app = buildServer({ ledger, corsOrigins, sessions, live, uiDir, qaAuth, secureCookies, autoApproveWrites, criticalApprovals, rules, naikKelas, about, berkas });

  try {
    await app.listen({ port, host });
    // eslint-disable-next-line no-console
    console.log(`[orchestrator] listening on http://${host}:${port} (mode default: preview)`);
    // eslint-disable-next-line no-console
    for (const url of accessUrls(host, port, networkInterfaces()).urls) console.log(`[orchestrator] open: ${url}`);
    if (!auditDir) {
      // eslint-disable-next-line no-console
      console.log('[orchestrator] AUDIT_LEDGER_DIR not set — using in-memory ledger (non-persistent)');
    }
    // eslint-disable-next-line no-console
    console.log(`[orchestrator] EvoMedis target: ${baseUrlV1}`);
    // eslint-disable-next-line no-console
    console.log('[orchestrator] auth: per-user EvoMedis login at POST /api/auth/login');
    if (qaAuth) {
      // eslint-disable-next-line no-console
      console.log('[orchestrator] auth: QA login enabled at POST /api/auth/qa-login');
    }
    // eslint-disable-next-line no-console
    console.log(
      live
        ? '[orchestrator] shared service-account cookie: configured (fallback for live runs without login)'
        : '[orchestrator] shared service-account cookie: none — live runs require a per-user login',
    );
    // eslint-disable-next-line no-console
    console.log(
      uiDir
        ? `[orchestrator] UI: serving built bundle from ${uiDir} at http://${host}:${port}/`
        : '[orchestrator] UI: no built bundle found — dev UI runs separately at http://localhost:5173',
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[orchestrator] failed to start', err);
    process.exit(1);
  }
}

void main();

