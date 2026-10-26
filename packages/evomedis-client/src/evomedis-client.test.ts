import { describe, it, expect } from 'vitest';
import {
  ENDPOINTS,
  EvoMedisClient,
  FixtureTransport,
  UnknownEndpointError,
  MutationBlockedInPreviewError,
  MutationNotAllowlistedError,
  MutationNotApprovedError,
  LoginFailedError,
  SessionExpiredError,
  UnexpectedResponseError,
  isMutating,
  mutatingEndpointIds,
  noKkRejectionReason,
  normalizeCardNumber,
  normalizeDate,
} from '../src/index.js';
import type { EndpointDef, SessionConfig } from '../src/index.js';
import { isLoginRedirect } from './client.js';

const sessionConfig: SessionConfig = {
  baseUrlV1: 'https://simrs.example.local/evoMedis_pkugombong/index.php',
  cookie: 'ci_session=valid',
  origin: 'https://simrs.example.local',
};

function client(
  fixtures: Record<string, never> | Record<string, any>,
  mode: 'preview' | 'write' = 'preview',
  mutationAllowlist?: string[],
) {
  const transport = new FixtureTransport(fixtures);
  const calls: any[] = [];
  const c = new EvoMedisClient(sessionConfig, {
    mode,
    transport,
    mutationAllowlist,
    onCall: (r) => calls.push(r),
  });
  return { c, transport, calls };
}

/**
 * Registry-wide invariants. These hold for every entry, so a new endpoint is
 * checked the moment it is added — no per-endpoint test needed to catch a
 * mutation registered without approval, a duplicated path, or a silent
 * promotion to `critical`.
 */
describe('endpoint registry — contract', () => {
  const entries = Object.entries(ENDPOINTS) as Array<[string, EndpointDef]>;
  const defs = entries.map(([, def]) => def);

  it('is non-empty and every entry id equals its registry key', () => {
    expect(entries.length).toBeGreaterThan(0);
    const mismatched = entries.filter(([key, def]) => def.id !== key).map(([key]) => key);
    expect(mismatched).toEqual([]);
  });

  it('keys follow the <module>.<camelCaseAction> id scheme', () => {
    const bad = entries.map(([key]) => key).filter((key) => !/^[a-z][A-Za-z0-9]*\.[a-z][A-Za-z0-9]*$/.test(key));
    expect(bad).toEqual([]);
  });

  it('every entry has a non-empty, trimmed description', () => {
    const bad = defs
      .filter((d) => d.description.trim().length === 0 || d.description !== d.description.trim())
      .map((d) => d.id);
    expect(bad).toEqual([]);
  });

  it('every entry has a non-empty path with no leading slash and no query string', () => {
    const bad = defs
      .filter((d) => d.path.length === 0 || d.path.startsWith('/') || d.path.includes('?'))
      .map((d) => d.id);
    expect(bad).toEqual([]);
  });

  it('no two entries share the same path + method', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const def of defs) {
      const key = `${def.method} ${def.path}`;
      const prior = seen.get(key);
      if (prior) collisions.push(`${key} (${prior} vs ${def.id})`);
      else seen.set(key, def.id);
    }
    expect(collisions).toEqual([]);
  });

  it('every mutating entry requires approval (#2)', () => {
    const bad = defs.filter((d) => d.kind === 'mutate' && d.requiresApproval !== true).map((d) => d.id);
    expect(bad).toEqual([]);
  });

  it('every mutating entry is high or critical risk', () => {
    const bad = defs
      .filter((d) => d.kind === 'mutate' && d.riskLevel !== 'high' && d.riskLevel !== 'critical')
      .map((d) => d.id);
    expect(bad).toEqual([]);
  });

  it('no read or auth entry requires approval or claims high/critical risk', () => {
    const bad = defs
      .filter(
        (d) =>
          d.kind !== 'mutate' &&
          (d.requiresApproval === true || d.riskLevel === 'high' || d.riskLevel === 'critical'),
      )
      .map((d) => d.id);
    expect(bad).toEqual([]);
  });

  it('every read entry is low risk', () => {
    const bad = defs.filter((d) => d.kind === 'read' && d.riskLevel !== 'low').map((d) => d.id);
    expect(bad).toEqual([]);
  });

  it('GET entries never carry a form body concept; v2 entries are GET or POST auth only', () => {
    const bad = defs.filter((d) => d.api === 'v2' && d.kind !== 'auth' && d.method !== 'GET').map((d) => d.id);
    expect(bad).toEqual([]);
  });

  it('mutatingEndpointIds() and isMutating() agree with the registry', () => {
    const fromRegistry = defs.filter((d) => d.kind === 'mutate').map((d) => d.id).sort();
    expect([...mutatingEndpointIds()].sort()).toEqual(fromRegistry);
    expect(defs.filter((d) => isMutating(d.id)).map((d) => d.id).sort()).toEqual(fromRegistry);
  });

  /**
   * Pinned on purpose: promoting an endpoint to `critical` changes the
   * two-person-rule surface (safety control #6). Editing this list must be a
   * deliberate, reviewed act — not a side effect of adding an endpoint.
   */
  it('pins the exact set of critical-risk endpoints', () => {
    const critical = defs.filter((d) => d.riskLevel === 'critical').map((d) => d.id).sort();
    expect(critical).toEqual([
      'kasir.tampungBayar',
      'verifikator.batalVerifikasi',
      'verifikator.simpanVerifikasi',
    ]);
  });

  it('pins the exact set of auth endpoints', () => {
    const auth = defs.filter((d) => d.kind === 'auth').map((d) => d.id).sort();
    expect(auth).toEqual(['auth.login', 'auth.v2Login']);
  });

  it('blocks every registered mutation in preview mode, registry-wide (#1)', async () => {
    const mutations = defs.filter((d) => d.kind === 'mutate');
    expect(mutations.length).toBeGreaterThan(0);
    for (const def of mutations) {
      const { c, transport } = client({ [def.id]: { text: '{}' } }, 'preview');
      await expect(c.call(def.id, {})).rejects.toBeInstanceOf(MutationBlockedInPreviewError);
      expect(transport.calls).toHaveLength(0);
    }
  });

  it('never blocks a read in preview mode, registry-wide', async () => {
    for (const def of defs.filter((d) => d.kind === 'read')) {
      const body = def.response === 'json' ? '{}' : 'ok';
      const { c, transport } = client({ [def.id]: { text: body } }, 'preview');
      await c.call(def.id, {});
      expect(transport.calls).toHaveLength(1);
    }
  });
});

describe('parsers', () => {
  it('normalizes card numbers to 13 digits and rejects all-zero', () => {
    expect(normalizeCardNumber('1234567890')).toBe('0001234567890');
    expect(normalizeCardNumber('0000000000000')).toBeNull();
    expect(normalizeCardNumber('')).toBeNull();
  });

  it('rejects a no_kk that cannot be the BPJS card, like find_sep does', () => {
    // Empty, too short, or a Central-Java NIK ("33…") all force the payer-tab fallback.
    expect(noKkRejectionReason('')).toBe('panjang < 9');
    expect(noKkRejectionReason('   ')).toBe('panjang < 9');
    expect(noKkRejectionReason(undefined)).toBe('panjang < 9');
    expect(noKkRejectionReason('12345678')).toBe('panjang < 9');
    expect(noKkRejectionReason('3301234567890123')).toBe('berawalan 33 (NIK)');
    expect(noKkRejectionReason('0001234567890')).toBe('');
    expect(noKkRejectionReason('3301234')).not.toBe(''); // too short wins over prefix
  });

  it('normalizes assorted date formats', () => {
    expect(normalizeDate('2026-06-12 10:00')).toBe('2026-06-12');
    expect(normalizeDate('12/06/2026')).toBe('2026-06-12');
    expect(normalizeDate('12-06-2026')).toBe('2026-06-12');
    expect(normalizeDate('garbage')).toBeNull();
  });
});

describe('EvoMedisClient — read path', () => {
  it('returns parsed JSON for a known read endpoint', async () => {
    const { c, transport } = client({
      'kasir.getHistoryKunjungan': { text: JSON.stringify({ total: 1, rows: [{ no_transaksi: '03-1' }] }) },
    });
    const res = await c.postJson<{ total: number; rows: unknown[] }>('kasir.getHistoryKunjungan', {
      txtmedrec: '0-01-23-45',
    });
    expect(res.total).toBe(1);
    expect(transport.calls[0]!.headers['x-endpoint-id']).toBe('kasir.getHistoryKunjungan');
  });

  it('parses plain-text endpoints', async () => {
    const { c } = client({ 'kasir.cekStatusVerifikasi': { text: '0' } });
    expect(await c.postText('kasir.cekStatusVerifikasi', { no_transaksi: '03-1' })).toBe('0');
  });

  it('returns headers and bytes for raw same-origin reads', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const { c, transport } = client({
      'laboratoriumHasil.lisPdf': {
        text: '%PDF',
        bodyBytes: bytes,
        headers: { 'content-type': 'application/pdf', 'content-length': '4' },
      },
    });

    const res = await c.raw('laboratoriumHasil.lisPdf', { query: { no_transaksi: 'LAB-1' } });

    expect(res.headers['content-length']).toBe('4');
    expect(res.bodyBytes).toEqual(bytes);
    expect(transport.calls[0]!.url).toBe(
      'https://simrs.example.local/lis_new/pdf.php?no_transaksi=LAB-1',
    );
  });

  it('emits a redacted call record', async () => {
    const { c, calls } = client({
      'pendaftaran.getRiwayatSep': { text: JSON.stringify([]) },
    });
    await c.postJson('pendaftaran.getRiwayatSep', { no_kartu: '0001234567890' });
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.no_kartu).toBe('«redacted»');
    expect(calls[0].ok).toBe(true);
  });
});

describe('EvoMedisClient — safety gates', () => {
  it('blocks unknown endpoints (#4)', async () => {
    const { c } = client({});
    await expect(c.call('does.notExist')).rejects.toBeInstanceOf(UnknownEndpointError);
  });

  it('blocks mutating endpoints in preview (#1)', async () => {
    const { c, transport } = client({ 'kasir.tampungBayar': { text: '{}' } }, 'preview');
    await expect(c.call('kasir.tampungBayar', {})).rejects.toBeInstanceOf(MutationBlockedInPreviewError);
    // nothing should have been sent
    expect(transport.calls).toHaveLength(0);
  });

  it('requires approval for mutating endpoints in write mode (#2)', async () => {
    const { c } = client({ 'kasir.tampungBayar': { text: '1' } }, 'write');
    await expect(c.call('kasir.tampungBayar', {})).rejects.toBeInstanceOf(MutationNotApprovedError);
  });

  /**
   * `kasir.tampungBayar` is a `response: 'text'` endpoint — the legacy
   * `tampung_bayar_kasir` goes through `_write_text`, so SIMRS answers with a
   * bare status string, not JSON. Decoding must hand back that trimmed string.
   */
  it('allows an approved mutation in write mode', async () => {
    const { c, transport } = client({ 'kasir.tampungBayar': { text: '1' } }, 'write');
    const res = await c.call<string>(
      'kasir.tampungBayar',
      { no_reg: 'REG-1' },
      { approval: { approved: true, approver: 'operator', reason: 'pilot' } },
    );
    expect(res).toBe('1');
    expect(transport.calls).toHaveLength(1);
  });

  it('blocks a mutation absent from the allowlist even when approved (#3)', async () => {
    const { c, transport } = client(
      { 'kasir.tampungBayar': { text: '1' } },
      'write',
      ['elektromedik.transferTagihan'], // allowlist excludes tampungBayar
    );
    await expect(
      c.call('kasir.tampungBayar', { no_reg: 'REG-1' }, { approval: { approved: true } }),
    ).rejects.toBeInstanceOf(MutationNotAllowlistedError);
    expect(transport.calls).toHaveLength(0); // nothing sent
  });

  it('allows an allowlisted, approved mutation', async () => {
    const { c, transport } = client(
      { 'elektromedik.transferTagihan': { text: JSON.stringify({ status: true }) } },
      'write',
      ['elektromedik.transferTagihan'],
    );
    await c.call('elektromedik.transferTagihan', { id: '1' }, { approval: { approved: true } });
    expect(transport.calls).toHaveLength(1);
  });

  it('blocks all mutations when the allowlist is empty', async () => {
    const { c } = client(
      { 'elektromedik.transferTagihan': { text: '{}' } },
      'write',
      [], // empty allowlist → nothing may mutate
    );
    await expect(
      c.call('elektromedik.transferTagihan', {}, { approval: { approved: true } }),
    ).rejects.toBeInstanceOf(MutationNotAllowlistedError);
  });
});

describe('EvoMedisClient — fail closed', () => {
  it('throws SessionExpiredError on a login page (#5)', async () => {
    const { c } = client({
      'kasir.getHistoryKunjungan': { text: '<form id="form-login"><input name="password"></form>' },
    });
    await expect(c.call('kasir.getHistoryKunjungan')).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('names the PHP error, not the markup before it, in UnexpectedResponseError', () => {
    const page = `<div style="border:1px solid #990000;padding-left:20px;margin:0 0 10px 0;">

<h4>A PHP Error was encountered</h4>

<p>Severity: Notice</p>
<p>Message:  Undefined index: txtdiskonpn_pembayaran</p>
<p>Filename: kasir/Kasir.php</p>
<p>Line Number: 812</p>

</div>{"status":false}`;
    expect(new UnexpectedResponseError('kasir.tampungBayar', page).message).toBe(
      'Unexpected response from "kasir.tampungBayar": PHP error — Severity: Notice Message: Undefined index: txtdiskonpn_pembayaran Filename: kasir/Kasir.php Line Number: 812',
    );
    expect(new UnexpectedResponseError('x', 'plain body').message).toBe('Unexpected response from "x": plain body');
  });

  it('throws UnexpectedResponseError on a PHP error page (#6)', async () => {
    const { c } = client({
      'kasir.getHistoryKunjungan': { text: '<b>Fatal error</b>: undefined index in kasir.php' },
    });
    await expect(c.call('kasir.getHistoryKunjungan')).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('reads JSON behind a leading PHP notice on reads, never on writes or fatals', async () => {
    // Live get_datariwayatsep body when BPJS has no SEP history for the card.
    const notice =
      '<div style="border:1px solid #990000;padding-left:20px;margin:0 0 10px 0;">\n<h4>A PHP Error was encountered</h4>\n' +
      '<p>Severity: Notice</p>\n<p>Message:  Trying to access array offset on value of type null</p>\n' +
      '<p>Filename: pendaftaran/pendaftaran_pasien.php</p>\n<p>Line Number: 4706</p>\n</div>';
    const { c } = client({ 'pendaftaran.getRiwayatSep': { text: `${notice}${notice}[]` } });
    await expect(c.postJson('pendaftaran.getRiwayatSep', { no_kartu: '0001234567890' })).resolves.toEqual([]);

    const fatal = notice.replace('Severity: Notice', 'Severity: Error');
    const { c: fatalClient } = client({ 'pendaftaran.getRiwayatSep': { text: `${fatal}[]` } });
    await expect(fatalClient.call('pendaftaran.getRiwayatSep')).rejects.toBeInstanceOf(UnexpectedResponseError);

    const { c: writer } = client({ 'elektromedik.transferTagihan': { text: `${notice}{"status":true}` } }, 'write');
    await expect(
      writer.call('elektromedik.transferTagihan', {}, { approval: { approved: true } }),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('treats malformed JSON as unexpected, not success', async () => {
    const { c } = client({ 'kasir.getHistoryKunjungan': { text: 'not json at all' } });
    await expect(c.call('kasir.getHistoryKunjungan')).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it('decodes an empty body as an empty answer, not a parse failure', async () => {
    // This backend answers "nothing to report" with HTTP 200 and a zero-length
    // body (a clean penunjang guard, a transaction with no detail row). Legacy's
    // `postFetch` returns `null` for it; rejecting it turned a clean answer into
    // a fail-closed error that ended runs and refused accepted writes.
    const { c } = client({ 'kasir.getHistoryKunjungan': { text: '' } });
    await expect(c.call('kasir.getHistoryKunjungan')).resolves.toEqual({});
    // Whitespace-only is the same answer, not malformed JSON.
    const { c: spaced } = client({ 'kasir.getHistoryKunjungan': { text: '   \n ' } });
    await expect(spaced.call('kasir.getHistoryKunjungan')).resolves.toEqual({});
  });
});

describe('EvoMedisClient — login', () => {
  function loginClient(fixtures: Record<string, any>) {
    const transport = new FixtureTransport(fixtures);
    // Start with NO cookie — login must establish it.
    const c = new EvoMedisClient(
      { baseUrlV1: 'https://simrs.example.local/evoMedis_pkugombong/index.php' },
      { mode: 'preview', transport },
    );
    return { c, transport };
  }

  it('captures ci_session from Set-Cookie and adopts it', async () => {
    const { c, transport } = loginClient({
      'auth.login': {
        text: '<html>dashboard</html>',
        setCookies: ['ci_session=abc123; Path=/; HttpOnly'],
      },
    });
    expect(c.hasSession()).toBe(false);
    const { cookie } = await c.login('naufal a', 'secret');
    expect(cookie).toBe('ci_session=abc123');
    expect(c.hasSession()).toBe(true);
    // The login POST matches the legacy browser form shape.
    const call = transport.calls[0]!;
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded; charset=UTF-8');
    const form = new URLSearchParams(call.body);
    expect(form.get('username')).toBe('naufal a');
    expect(form.get('password')).toBe('secret');
    expect(form.get('submit')).toBe('');
    expect(form.get('Submit')).toBe('Login');
  });

  it('captures ci_session from a collapsed set-cookie header', async () => {
    const transport = new FixtureTransport({
      'auth.login': {
        text: 'ok',
        headers: { 'set-cookie': 'csrf=1; Path=/, ci_session=abc123; Path=/; HttpOnly' },
      },
    });
    const c = new EvoMedisClient({ baseUrlV1: 'https://simrs.example.local/app/index.php' }, { transport });

    const { cookie } = await c.login('u', 'p');

    expect(cookie).toBe('ci_session=abc123');
  });

  it('accepts the EvoMedis app root URL for v1 login', async () => {
    const transport = new FixtureTransport({
      'auth.login': { text: 'ok', setCookies: ['ci_session=root; Path=/'] },
    });
    const c = new EvoMedisClient(
      { baseUrlV1: 'https://simrs.example.local/evoMedis_pkugombong/' },
      { transport },
    );

    await c.login('u', 'p');

    expect(transport.calls[0]!.url).toBe(
      'https://simrs.example.local/evoMedis_pkugombong/index.php/login/index',
    );
  });

  it('rejects bad credentials (login page re-rendered, no cookie)', async () => {
    const { c } = loginClient({
      'auth.login': {
        text: '<form id="form-login"><input name="password"></form>',
      },
    });
    await expect(c.login('bad', 'creds')).rejects.toBeInstanceOf(LoginFailedError);
    expect(c.hasSession()).toBe(false);
  });

  it('rejects bad credentials even though a ci_session cookie is set (live shape)', async () => {
    // EvoMedis answers every login with Set-Cookie; only the redirect target differs.
    const { c } = loginClient({
      'auth.login': {
        status: 302,
        text: '',
        headers: { location: 'http://simrs.example.local/evoMedis_pkugombong/index.php/login' },
        setCookies: ['ci_session=pre; Path=/', 'ci_session=anon; Path=/'],
      },
    });
    await expect(c.login('x-invalid', 'wrong')).rejects.toThrow(/invalid username or password/);
    expect(c.hasSession()).toBe(false);
  });

  it('accepts the redirect to home that a good login gets', async () => {
    const { c } = loginClient({
      'auth.login': {
        status: 302,
        text: '<h4>A PHP Error was encountered</h4><p>Message: Undefined variable: cek_password</p>',
        headers: { location: 'http://simrs.example.local/evoMedis_pkugombong/index.php/home/home' },
        setCookies: ['ci_session=pre; Path=/', 'ci_session=auth; Path=/'],
      },
    });
    await expect(c.login('naufal a', 'secret')).resolves.toEqual({ cookie: 'ci_session=auth' });
    expect(isLoginRedirect('/evoMedis/index.php/login/index/')).toBe(true);
    expect(isLoginRedirect('login?err=1')).toBe(true);
    expect(isLoginRedirect('http://h/index.php/home/home')).toBe(false);
    expect(isLoginRedirect('http://h/index.php/loginlog/view')).toBe(false);
  });

  it('rejects when no session cookie is returned', async () => {
    const { c } = loginClient({
      'auth.login': { text: '<html>ok</html>' }, // 200 but no Set-Cookie
    });
    await expect(c.login('x', 'y')).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('picks ci_session out of multiple Set-Cookie values', async () => {
    const { c } = loginClient({
      'auth.login': {
        text: '<html>ok</html>',
        setCookies: ['other=1; Path=/', 'ci_session=zzz; Path=/', 'csrf=9; Path=/'],
      },
    });
    const { cookie } = await c.login('u', 'p');
    expect(cookie).toBe('ci_session=zzz');
  });

  it('keeps the last ci_session when login regenerates the session (live shape)', async () => {
    // EvoMedis sets the pre-auth id first, then the authenticated one; the
    // first one answers kasir reads with an empty body.
    const { c } = loginClient({
      'auth.login': { text: 'ok', setCookies: ['ci_session=preauth; Path=/', 'ci_session=authed; Path=/; HttpOnly'] },
    });
    const { cookie } = await c.login('u', 'p');
    expect(cookie).toBe('ci_session=authed');
  });

  it('honors a custom cookie name', async () => {
    const transport = new FixtureTransport({
      'auth.login': { text: 'ok', setCookies: ['PHPSESSID=pp; Path=/'] },
    });
    const c = new EvoMedisClient(
      { baseUrlV1: 'https://simrs.example.local/x', cookieName: 'PHPSESSID' },
      { transport },
    );
    const { cookie } = await c.login('u', 'p');
    expect(cookie).toBe('PHPSESSID=pp');
  });

  it('uses the established session on subsequent calls', async () => {
    const { c, transport } = loginClient({
      'auth.login': { text: 'ok', setCookies: ['ci_session=live1; Path=/'] },
      'kasir.cekStatusVerifikasi': { text: '0' },
    });
    await c.login('u', 'p');
    await c.postText('kasir.cekStatusVerifikasi', { no_transaksi: '03-1' });
    const readCall = transport.calls[1]!;
    expect(readCall.headers['Cookie']).toBe('ci_session=live1');
  });
});
