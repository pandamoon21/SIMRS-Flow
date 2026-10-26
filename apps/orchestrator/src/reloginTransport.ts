/**
 * Auto re-login transport wrapper.
 *
 * Wraps the real FetchTransport for a per-user live run. When EvoMedis returns
 * a login page (the session cookie expired mid-run), it asks the
 * UserSessionStore to re-login using the user's retained in-RAM credentials,
 * swaps the fresh `ci_session` into the request's Cookie header, and retries
 * the request once. This keeps long runs from failing on an expired session
 * without persisting anything to disk.
 *
 * Only meaningful for per-user sessions (a token is required). The shared
 * service-account path has no password to re-login with, so it is left as-is.
 */

import { looksLikeLogin, type Transport, type TransportRequest, type TransportResponse } from '@simrs-flow/evomedis-client';
import type { UserSessionStore } from './sessions.js';

function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function field(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return value === undefined || value === null ? '' : String(value).trim();
}

function hasMinimumKasirIdentity(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const row = data as Record<string, unknown>;
  if (!field(row, 'no_transaksi') || !field(row, 'no_registrasikunjungan')) return false;
  return [field(row, 'no_medicalrecord'), field(row, 'nama_pasien'), field(row, 'alamat')].filter(Boolean).length >= 2;
}

function looksLikeInvalidKasirIdentity(req: TransportRequest, res: TransportResponse): boolean {
  if (header(req.headers, 'x-endpoint-id') !== 'kasir.getDataTransaksi') return false;
  const trimmed = res.text.trim();
  if (!trimmed) return true;
  try {
    return !hasMinimumKasirIdentity(JSON.parse(trimmed));
  } catch {
    return false;
  }
}

export class ReloginTransport implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly sessions: UserSessionStore,
    private readonly token: string,
    /** Cookie name (e.g. ci_session) used to rewrite the Cookie header. */
    private readonly cookieName: string,
  ) {}

  async send(req: TransportRequest): Promise<TransportResponse> {
    const res = await this.inner.send(req);
    // Healthy responses (and non-login bodies) pass straight through.
    if (!looksLikeLogin(res.text) && !looksLikeInvalidKasirIdentity(req, res)) return res;

    // Session looks expired — try a single silent re-login + retry.
    let freshCookie: string | undefined;
    try {
      freshCookie = await this.sessions.relogin(this.token);
    } catch {
      // Re-login failed (e.g. password changed); surface the original login
      // page so the parser raises SessionExpiredError as usual.
      return res;
    }
    if (!freshCookie) return res;

    const retried: TransportRequest = {
      ...req,
      headers: { ...req.headers, Cookie: freshCookie },
    };
    void this.cookieName; // cookie value already includes name=value
    return this.inner.send(retried);
  }
}
