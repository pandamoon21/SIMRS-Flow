import { describe, it, expect } from 'vitest';
import { FixtureTransport, type Transport, type TransportRequest, type TransportResponse } from '@simrs-flow/evomedis-client';
import { UserSessionStore } from './sessions.js';
import { ReloginTransport } from './reloginTransport.js';
import { SimrsAccess } from './simrsAccess.js';

const BASE = 'https://simrs.example.local/x';
const LOGIN_PAGE = '<form id="form-login"><input name="password"></form>';

/** A network stand-in: answers a login page until the Cookie header is fresh. */
class StaleThenFresh implements Transport {
  readonly cookies: string[] = [];
  async send(req: TransportRequest): Promise<TransportResponse> {
    this.cookies.push(req.headers.Cookie ?? '');
    return { status: 200, text: req.headers.Cookie === 'ci_session=fresh' ? '0' : LOGIN_PAGE, headers: {} };
  }
}

async function loggedInStore() {
  let n = 0;
  const store = new UserSessionStore({
    baseUrlV1: BASE,
    baseUrlV2: `${BASE}/v2`,
    transport: new FixtureTransport({
      'auth.login': () => {
        n += 1;
        return { text: 'ok', setCookies: [n === 1 ? 'ci_session=first; Path=/' : 'ci_session=fresh; Path=/'] };
      },
    }),
  });
  const { token } = await store.login('u', 'p');
  return { store, token };
}

const request = (cookie: string): TransportRequest => ({
  url: `${BASE}/kasir/kasir/cekstatus_verifikasi`,
  method: 'POST',
  headers: { Cookie: cookie, 'x-endpoint-id': 'kasir.cekStatusVerifikasi' },
  timeoutMs: 1000,
});

describe('SimrsAccess', () => {
  it('prefers the operator session and wraps its transport in re-login', async () => {
    const { store, token } = await loggedInStore();
    const network = new StaleThenFresh();
    const access = new SimrsAccess({
      sessions: store,
      live: { baseUrlV1: 'https://env.example.local', cookie: 'ci_session=env' },
      transportFactory: () => network,
    });

    const resolved = access.connection(token);
    expect(resolved).toEqual({
      ok: true,
      connection: { baseUrlV1: BASE, baseUrlV2: `${BASE}/v2`, cookie: 'ci_session=first', sessionToken: token },
    });
    if (!resolved.ok) return;

    const transport = access.transportFor(resolved.connection);
    expect(transport).toBeInstanceOf(ReloginTransport);
    const res = await transport.send(request('ci_session=stale'));
    expect(res.text).toBe('0');
    expect(network.cookies).toEqual(['ci_session=stale', 'ci_session=fresh']);
  });

  it('puts an inner wrapper (QA faults) inside the re-login wrapper', async () => {
    const { store, token } = await loggedInStore();
    const network = new StaleThenFresh();
    const seen: string[] = [];
    const access = new SimrsAccess({ sessions: store, transportFactory: () => network });
    const resolved = access.connection(token);
    if (!resolved.ok) throw new Error('expected a connection');
    const transport = access.transportFor(resolved.connection, (inner) => ({
      send: (req) => { seen.push(req.headers.Cookie ?? ''); return inner.send(req); },
    }));
    await transport.send(request('ci_session=stale'));
    // The wrapper saw both the first try and the re-login retry.
    expect(seen).toEqual(['ci_session=stale', 'ci_session=fresh']);
  });

  it('falls back to the env service account without re-login', () => {
    const network = new StaleThenFresh();
    const access = new SimrsAccess({
      live: { baseUrlV1: 'https://env.example.local', cookie: 'ci_session=env' },
      transportFactory: () => network,
    });
    const resolved = access.connection(undefined);
    expect(resolved).toEqual({ ok: true, connection: { baseUrlV1: 'https://env.example.local', cookie: 'ci_session=env' } });
    if (!resolved.ok) return;
    expect(access.transportFor(resolved.connection)).toBe(network);
  });

  it('fails closed with the operator-facing reason', async () => {
    expect(new SimrsAccess().connection(undefined)).toEqual({
      ok: false,
      message: 'Live source unavailable — log in (per-user) or configure EVOMEDIS_BASE_URL/EVOMEDIS_SESSION_COOKIE',
    });
    expect(new SimrsAccess({ live: { baseUrlV1: '', cookie: 'ci_session=env' } }).connection(undefined)).toEqual({
      ok: false,
      message: 'Live source unavailable — EVOMEDIS_BASE_URL not configured',
    });
  });

  it('builds report-read clients only on the caller’s own session', async () => {
    const { store, token } = await loggedInStore();
    const access = new SimrsAccess({
      sessions: store,
      live: { baseUrlV1: 'https://env.example.local', cookie: 'ci_session=env' },
      transportFactory: () => new StaleThenFresh(),
    });
    expect(access.userReadClient(token)).toBeDefined();
    expect(access.userReadClient(undefined)).toBeUndefined();
    expect(access.userReadClient('not-a-session')).toBeUndefined();
  });
});
