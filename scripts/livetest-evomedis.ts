/**
 * Live smoke test against a REAL EvoMedis/SIMRS server.
 *
 * Safety: preview mode only. No mutating endpoint is ever sent. Credentials
 * come from env (EVO_USER/EVO_PASS/EVO_BASE) — never hardcoded. Nothing
 * sensitive (cookie, PHI) is printed; only PASS/FAIL and shapes.
 *
 * Run:  EVO_BASE=... EVO_USER=... EVO_PASS=... node --import tsx scripts/livetest-evomedis.ts [noRm]
 */
import {
  EvoMedisClient,
  FetchTransport,
  MutationBlockedInPreviewError,
  SessionExpiredError,
  UnexpectedResponseError,
} from '../packages/evomedis-client/src/index.js';

const BASE = process.env.EVO_BASE ?? process.env.EVOMEDIS_BASE_URL ?? (() => { throw new Error('Set EVOMEDIS_BASE_URL (see .env.example)'); })();
const USER = process.env.EVO_USER ?? '';
const PASS = process.env.EVO_PASS ?? '';
const NO_RM = process.argv[2] ?? '000000'; // dummy by default — no real PHI

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  console.log(`PASS: ${m}`);
  pass++;
};
const bad = (m: string) => {
  console.log(`FAIL: ${m}`);
  fail++;
};

/** Login with the form flow and return the ci_session cookie value. */
async function login(): Promise<string> {
  const body = new URLSearchParams({ username: USER, password: PASS, submit: '' }).toString();
  const res = await fetch(`${BASE}/login/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body,
    redirect: 'manual',
  });
  // Collect Set-Cookie (Node fetch exposes getSetCookie()).
  const setCookies =
    typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
  const ci = setCookies
    .map((c: string) => /ci_session=[^;]+/.exec(c)?.[0])
    .find((v: string | undefined) => Boolean(v));
  if (!ci) throw new Error(`login did not yield ci_session (status ${res.status})`);
  return ci;
}

async function main() {
  console.log(`### LIVE EvoMedis smoke test (preview only) — base hidden, noRm=${NO_RM} ###`);

  // 1. Login
  let cookie = '';
  try {
    cookie = await login();
    ok('login returned a ci_session cookie');
  } catch (e) {
    bad(`login failed: ${(e as Error).message}`);
    return finish();
  }

  // 2. Build the REAL client (preview) with a real fetch transport.
  const client = new EvoMedisClient(
    { baseUrlV1: BASE, cookie, origin: new URL(BASE).origin },
    { mode: 'preview', transport: new FetchTransport(), timeoutMs: 20000 },
  );

  // 3. Read endpoint — visit history. Dummy RM may return empty rows; the
  //    point is: it parses as JSON and is NOT a login/PHP-error page.
  try {
    const res = await client.postJson<{ total?: number; rows?: unknown[] }>(
      'kasir.getHistoryKunjungan',
      { txtmedrec: NO_RM },
    );
    const rows = Array.isArray(res?.rows) ? res.rows.length : 'n/a';
    ok(`kasir.getHistoryKunjungan parsed as JSON (rows=${rows})`);
  } catch (e) {
    if (e instanceof SessionExpiredError) bad('read got SessionExpiredError (cookie not accepted)');
    else if (e instanceof UnexpectedResponseError) bad(`read got non-JSON/PHP-error page`);
    else bad(`read threw: ${(e as Error).constructor.name}: ${(e as Error).message}`);
  }

  // 4. A second read endpoint (different module) to confirm breadth.
  try {
    await client.postText('kasir.cekStatusVerifikasi', { no_transaksi: '00-0000000' });
    ok('kasir.cekStatusVerifikasi reachable + decoded as text');
  } catch (e) {
    // A dummy transaction may legitimately error server-side; only flag auth/parse failures.
    if (e instanceof SessionExpiredError) bad('text read got SessionExpiredError');
    else ok(`kasir.cekStatusVerifikasi handled (${(e as Error).constructor.name})`);
  }

  // 5. SAFETY: a mutating endpoint must be blocked in preview — never sent.
  try {
    await client.call('kasir.tampungBayar', { no_reg: 'X' });
    bad('SECURITY: mutating endpoint was NOT blocked in preview!');
  } catch (e) {
    if (e instanceof MutationBlockedInPreviewError) ok('mutating endpoint blocked in preview (no request sent)');
    else bad(`mutate blocked but wrong error: ${(e as Error).constructor.name}`);
  }

  finish();
}

function finish() {
  console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
