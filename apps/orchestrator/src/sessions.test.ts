import { describe, it, expect } from 'vitest';
import { FixtureTransport, LoginFailedError } from '@simrs-flow/evomedis-client';
import { UserSessionStore } from '../src/sessions.js';

const BASE = 'https://simrs.example.local/evoMedis_pkugombong/index.php';

/** A fixture transport whose auth.login returns a fresh ci_session each call. */
function loginTransport(opts: { fail?: boolean; cookieValue?: string } = {}) {
  let n = 0;
  return new FixtureTransport({
    'auth.login': () => {
      n += 1;
      if (opts.fail) {
        return { text: '<form id="form-login"><input name="password"></form>' };
      }
      return { text: '<html>ok</html>', setCookies: [`ci_session=${opts.cookieValue ?? 'sess'}${n}; Path=/`] };
    },
  });
}

describe('UserSessionStore', () => {
  it('logs in and issues a token bound to the operator + cookie', async () => {
    const store = new UserSessionStore({ baseUrlV1: BASE, transport: loginTransport() });
    const { token, operator } = await store.login('naufal a', 'secret');
    expect(token).toBeTruthy();
    expect(operator).toBe('naufal a');
    const session = store.resolve(token);
    expect(session?.operator).toBe('naufal a');
    expect(session?.cookie).toBe('ci_session=sess1');
    // Password must NOT be exposed via resolve().
    expect((session as unknown as Record<string, unknown>).password).toBeUndefined();
  });

  it('rejects bad credentials with LoginFailedError', async () => {
    const store = new UserSessionStore({ baseUrlV1: BASE, transport: loginTransport({ fail: true }) });
    await expect(store.login('bad', 'creds')).rejects.toBeInstanceOf(LoginFailedError);
    expect(store.size).toBe(0);
  });

  it('requires both username and password', async () => {
    const store = new UserSessionStore({ baseUrlV1: BASE, transport: loginTransport() });
    await expect(store.login('', 'p')).rejects.toBeInstanceOf(LoginFailedError);
    await expect(store.login('u', '')).rejects.toBeInstanceOf(LoginFailedError);
  });

  it('resolves unknown tokens to undefined', () => {
    const store = new UserSessionStore({ baseUrlV1: BASE, transport: loginTransport() });
    expect(store.resolve('nope')).toBeUndefined();
    expect(store.resolve(undefined)).toBeUndefined();
    expect(store.cookieFor('nope')).toBeUndefined();
  });

  it('relogin refreshes the cookie using the retained password', async () => {
    const store = new UserSessionStore({ baseUrlV1: BASE, transport: loginTransport() });
    const { token } = await store.login('u', 'p');
    expect(store.cookieFor(token)).toBe('ci_session=sess1');
    const fresh = await store.relogin(token);
    expect(fresh).toBe('ci_session=sess2'); // counter advanced → new cookie
    expect(store.cookieFor(token)).toBe('ci_session=sess2');
  });

  it('relogin returns undefined for an unknown token', async () => {
    const store = new UserSessionStore({ baseUrlV1: BASE, transport: loginTransport() });
    expect(await store.relogin('nope')).toBeUndefined();
  });

  it('logout drops the session', async () => {
    const store = new UserSessionStore({ baseUrlV1: BASE, transport: loginTransport() });
    const { token } = await store.login('u', 'p');
    expect(store.size).toBe(1);
    expect(store.logout(token)).toBe(true);
    expect(store.size).toBe(0);
    expect(store.resolve(token)).toBeUndefined();
    expect(store.logout(token)).toBe(false); // idempotent
  });
});
