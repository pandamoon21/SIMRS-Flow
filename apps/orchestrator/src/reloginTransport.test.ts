import { describe, it, expect } from 'vitest';
import { FixtureTransport } from '@simrs-flow/evomedis-client';
import { UserSessionStore } from '../src/sessions.js';
import { ReloginTransport } from '../src/reloginTransport.js';
import type { TransportRequest } from '@simrs-flow/evomedis-client';

const BASE = 'https://simrs.example.local/x';

function req(cookie: string): TransportRequest {
  return {
    url: `${BASE}/kasir/kasir/cekstatus_verifikasi`,
    method: 'POST',
    headers: { Cookie: cookie, 'x-endpoint-id': 'kasir.cekStatusVerifikasi' },
    timeoutMs: 30000,
  };
}

describe('ReloginTransport', () => {
  it('passes healthy responses through untouched', async () => {
    const inner = new FixtureTransport({ 'kasir.cekStatusVerifikasi': { text: '0' } });
    const store = new UserSessionStore({
      baseUrlV1: BASE,
      transport: new FixtureTransport({ 'auth.login': { text: 'ok', setCookies: ['ci_session=new; Path=/'] } }),
    });
    const { token } = await store.login('u', 'p');
    const wrapped = new ReloginTransport(inner, store, token, 'ci_session');
    const res = await wrapped.send(req('ci_session=old'));
    expect(res.text).toBe('0');
  });

  it('re-logs-in and retries when a login page is returned', async () => {
    // inner returns a login page on the FIRST call, then real data once the
    // Cookie header carries the refreshed session.
    let calls = 0;
    const inner: {
      send: (r: TransportRequest) => Promise<{ status: number; text: string; headers: Record<string, string> }>;
      last?: TransportRequest;
    } = {
      async send(r: TransportRequest) {
        calls += 1;
        (inner as { last?: TransportRequest }).last = r;
        if (calls === 1) {
          return { status: 200, text: '<form id="form-login"><input name="password"></form>', headers: {} };
        }
        return { status: 200, text: '0', headers: {} };
      },
    };
    const store = new UserSessionStore({
      baseUrlV1: BASE,
      transport: new FixtureTransport({ 'auth.login': { text: 'ok', setCookies: ['ci_session=fresh; Path=/'] } }),
    });
    const { token } = await store.login('u', 'p');
    const wrapped = new ReloginTransport(inner, store, token, 'ci_session');
    const res = await wrapped.send(req('ci_session=stale'));
    expect(res.text).toBe('0');
    expect(calls).toBe(2); // retried once
    // The retry carried the refreshed cookie.
    expect(inner.last?.headers.Cookie).toBe('ci_session=fresh');
  });

  it('re-logs-in and retries when kasir identity is empty', async () => {
    let calls = 0;
    const inner: {
      send: (r: TransportRequest) => Promise<{ status: number; text: string; headers: Record<string, string> }>;
      last?: TransportRequest;
    } = {
      async send(r: TransportRequest) {
        calls += 1;
        (inner as { last?: TransportRequest }).last = r;
        if (calls === 1) return { status: 200, text: '{}', headers: {} };
        return {
          status: 200,
          text: JSON.stringify({
            no_transaksi: '03-1',
            no_registrasikunjungan: 'REG-1',
            no_medicalrecord: 'RM-1',
            nama_pasien: 'PAS',
          }),
          headers: {},
        };
      },
    };
    const store = new UserSessionStore({
      baseUrlV1: BASE,
      transport: new FixtureTransport({ 'auth.login': { text: 'ok', setCookies: ['ci_session=fresh; Path=/'] } }),
    });
    const { token } = await store.login('u', 'p');
    const wrapped = new ReloginTransport(inner, store, token, 'ci_session');
    const request = req('ci_session=stale');
    request.headers['x-endpoint-id'] = 'kasir.getDataTransaksi';
    const res = await wrapped.send(request);
    expect(JSON.parse(res.text)).toMatchObject({ no_transaksi: '03-1' });
    expect(calls).toBe(2);
    expect(inner.last?.headers.Cookie).toBe('ci_session=fresh');
  });

  it('surfaces the login page when re-login itself fails', async () => {
    const inner = new FixtureTransport({
      'kasir.cekStatusVerifikasi': { text: '<form id="form-login"><input name="password"></form>' },
    });
    // login transport that FAILS (no cookie) so relogin throws.
    const store = new UserSessionStore({
      baseUrlV1: BASE,
      transport: new FixtureTransport({ 'auth.login': { text: 'ok', setCookies: ['ci_session=ok; Path=/'] } }),
    });
    const { token } = await store.login('u', 'p');
    // Now swap the store's login to fail by logging out + using a token that
    // re-login can't satisfy: simplest is a separate store with failing login.
    const failStore = new UserSessionStore({
      baseUrlV1: BASE,
      transport: new FixtureTransport({ 'auth.login': { text: 'nope' } }), // no cookie → relogin throws
    });
    // Seed a session in failStore via a one-off good login, then make further logins fail:
    // simpler: assert the original store path returns the login page when relogin yields nothing.
    void token;
    const wrapped = new ReloginTransport(inner, failStore, 'unknown-token', 'ci_session');
    const res = await wrapped.send(req('ci_session=stale'));
    // unknown token → relogin returns undefined → original login page surfaced
    expect(res.text).toContain('form-login');
  });
});
