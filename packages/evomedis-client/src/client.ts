/**
 * EvoMedisClient — the typed, safety-gated API surface.
 *
 * Every call resolves through the endpoint registry. Safety controls enforced
 * here, before any byte hits the network:
 *
 *   #4  Unknown endpoint            → UnknownEndpointError
 *   #1  Mutating endpoint, preview  → MutationBlockedInPreviewError
 *   #2  Mutating endpoint, write    → requires { approved:true }, else
 *                                      MutationNotApprovedError
 *   #5  Session expired             → SessionExpiredError (fail closed)
 *   #6  HTML/PHP error              → UnexpectedResponseError (fail closed)
 *
 * Read endpoints are always allowed. The client emits redacted call records
 * to an optional sink so the orchestrator can persist an audit trail.
 */

import { redact } from '@simrs-flow/audit-ledger/redaction';
import {
  ENDPOINTS,
  getEndpoint,
  type EndpointDef,
} from './endpoints.js';
import {
  LoginFailedError,
  MutationBlockedInPreviewError,
  MutationNotAllowlistedError,
  MutationNotApprovedError,
  TransportError,
  UnknownEndpointError,
} from './errors.js';
import { looksLikeLogin, parseJson, parseText } from './parsers.js';
import { Session, type SessionConfig } from './session.js';
import {
  FetchTransport,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from './transport.js';

export type ClientMode = 'preview' | 'write';

export interface CallRecord {
  endpointId: string;
  method: string;
  url: string;
  /** Redacted request payload. */
  payload: Record<string, unknown>;
  status: number;
  ok: boolean;
  durationMs: number;
}

export interface ClientOptions {
  mode?: ClientMode;
  transport?: Transport;
  timeoutMs?: number;
  /**
   * Endpoint ids permitted to mutate in write mode (safety control #3). When
   * set, a mutate call whose endpoint is absent fails closed with
   * MutationNotAllowlistedError — even if approved. When undefined the client
   * does not impose an allowlist (the orchestrator always supplies one for
   * write runs; an empty array blocks all mutations).
   */
  mutationAllowlist?: string[];
  /** Receives a redacted record of every call (for the audit ledger). */
  onCall?: (record: CallRecord) => void;
  /** Monotonic clock for durations; defaults to Date.now via performance-free shim. */
  now?: () => number;
}

export interface CallOptions {
  /** Required for mutating endpoints in write mode. */
  approval?: { approved: boolean; approver?: string; reason?: string };
  signal?: AbortSignal;
  /** Override params appended to the URL query string. */
  query?: Record<string, string>;
}

/** A redirect back to the login screen (`…/login`, `…/login/index`), absolute or relative. */
export function isLoginRedirect(location: string): boolean {
  const path = location.split(/[?#]/)[0]!.replace(/\/+$/, '');
  return /(^|\/)login(\/index)?$/i.test(path);
}

function encodeForm(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

function buildUrl(base: string, path: string, query?: Record<string, string>): string {
  const url = `${base}/${path.replace(/^\//, '')}`;
  if (!query || Object.keys(query).length === 0) return url;
  return `${url}?${new URLSearchParams(query).toString()}`;
}


/**
 * Extract a `name=value` cookie pair from a list of raw Set-Cookie header
 * values. Returns the first match for the requested name (e.g. ci_session).
 */
function extractCookie(setCookies: string[], name: string): string | undefined {
  // The login response sets `ci_session` twice (pre-auth, then the authenticated
  // regenerated id). Browsers keep the LAST; taking the first left us on a
  // stale session where kasir reads (getJumlahBayar, getDataTransaksi,
  // get_listtindakan) answered an empty body (verified live 2026-10-15).
  let found: string | undefined;
  for (const raw of setCookies) {
    // A Set-Cookie value is `name=value; Path=/; HttpOnly; ...` — we want the
    // first `name=value` segment only.
    const first = raw.split(';', 1)[0]?.trim() ?? '';
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    if (first.slice(0, eq).trim().toLowerCase() === name.toLowerCase()) found = first;
  }
  return found;
}

function splitSetCookieHeader(header: string | undefined): string[] {
  if (!header) return [];
  return header.split(/,(?=\s*[^;,\s]+=)/).map((value) => value.trim()).filter(Boolean);
}

export class EvoMedisClient {
  private readonly session: Session;
  private readonly transport: Transport;
  private readonly mode: ClientMode;
  private readonly timeoutMs: number;
  private readonly mutationAllowlist?: string[];
  private readonly onCall?: (record: CallRecord) => void;
  private readonly now: () => number;
  /** Counter-based clock fallback so we avoid Date.now in deterministic tests. */
  private tick = 0;

  constructor(sessionConfig: SessionConfig, options: ClientOptions = {}) {
    this.session = new Session(sessionConfig);
    this.transport = options.transport ?? new FetchTransport();
    this.mode = options.mode ?? 'preview';
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.mutationAllowlist = options.mutationAllowlist;
    this.onCall = options.onCall;
    this.now = options.now ?? (() => this.tick++);
  }

  /** Current execution mode. */
  getMode(): ClientMode {
    return this.mode;
  }

  /** Does this client currently hold a session cookie? */
  hasSession(): boolean {
    return this.session.hasCookie();
  }

  /**
   * Programmatic v1 login: POST username/password to `login/index`, capture
   * the `ci_session` cookie from the Set-Cookie response header, and adopt it
   * for subsequent calls. Mirrors the legacy ranap_v3.py login flow.
   *
   * Does NOT go through `call()` — that path discards response headers and
   * would mis-decode the HTML login response. Returns the captured cookie
   * (`name=value`). Throws LoginFailedError when no session is established.
   */
  async login(
    username: string,
    password: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ cookie: string }> {
    const endpoint = getEndpoint('auth.login');
    if (!endpoint) throw new LoginFailedError('auth.login endpoint missing from registry');

    const url = buildUrl(this.session.baseUrlV1, endpoint.path);
    const req: TransportRequest = {
      url,
      method: 'POST',
      // A fresh login should not carry a stale cookie; headers() without one
      // is fine when this.session has none, but be explicit for clarity.
      headers: this.session.headers({ 'x-endpoint-id': 'auth.login' }),
      body: encodeForm({ username, password, submit: '', Submit: 'Login' }),
      timeoutMs: this.timeoutMs,
      signal: options.signal,
    };

    let res;
    try {
      res = await this.transport.send(req);
    } catch (err) {
      // Operator-facing message: name the likely cause, not the JS internals.
      // The underlying detail stays in the error text for support/debugging.
      throw new LoginFailedError(
        `Tidak dapat terhubung ke server EvoMedis — periksa jaringan VPN dan alamat server. (${String(err)})`,
      );
    }

    // CodeIgniter sets ci_session on EVERY response, failed logins included, so a
    // cookie alone proves nothing (live 2026-10-20: any username/password got an
    // app session). A failed login redirects back to `/login`, a good one to
    // `/home/home`; a re-rendered login form is a failure too.
    const location = res.headers['location'] ?? '';
    if ((res.status >= 300 && res.status < 400 && isLoginRedirect(location)) || looksLikeLogin(res.text)) {
      throw new LoginFailedError('invalid username or password');
    }

    const cookie = extractCookie(
      [...(res.setCookies ?? []), ...splitSetCookieHeader(res.headers['set-cookie'])],
      this.session.cookieName,
    );
    if (!cookie) {
      // No session cookie issued — almost always bad credentials (the backend
      // re-renders the login page) or an unexpected response.
      throw new LoginFailedError(
        looksLikeLogin(res.text) ? 'invalid username or password' : 'no session cookie returned',
      );
    }

    this.session.setCookie(cookie);
    return { cookie };
  }

  /**
   * Core entrypoint. Resolves the endpoint, enforces safety gates, sends the
   * request, and decodes per the endpoint's declared response shape.
   */
  async call<T = unknown>(
    endpointId: string,
    data: Record<string, string> = {},
    options: CallOptions = {},
  ): Promise<T> {
    const endpoint = getEndpoint(endpointId);
    if (!endpoint) {
      throw new UnknownEndpointError(endpointId); // #4
    }

    this.enforceMutationGate(endpoint, options);

    const base = endpoint.api === 'v2'
      ? this.session.baseUrlV2 ?? this.session.baseUrlV1
      : endpoint.api === 'origin'
        ? new URL(this.session.baseUrlV1).origin
        : this.session.baseUrlV1;
    const url = buildUrl(base, endpoint.path, options.query);
    const req: TransportRequest = {
      url,
      method: endpoint.method,
      headers: this.session.headers({ 'x-endpoint-id': endpointId }),
      body: endpoint.method === 'POST' ? encodeForm(data) : undefined,
      timeoutMs: this.timeoutMs,
      signal: options.signal,
    };

    const start = this.now();
    let status = 0;
    let text = '';
    try {
      const res = await this.transport.send(req);
      status = res.status;
      text = res.text;
      if (endpoint.response === 'raw') {
        this.emit(endpoint, url, data, status, status >= 200 && status < 300, this.now() - start);
        return res as T;
      }
    } catch (err) {
      this.emit(endpoint, url, data, 0, false, this.now() - start);
      throw new TransportError(endpointId, err);
    }

    const durationMs = this.now() - start;
    const ok = status >= 200 && status < 300;
    this.emit(endpoint, url, data, status, ok, durationMs);

    return this.decode<T>(endpoint, text);
  }

  /** Convenience wrappers mirroring the legacy API surface. */
  async postJson<T = unknown>(
    endpointId: string,
    data: Record<string, string> = {},
    options?: CallOptions,
  ): Promise<T> {
    return this.call<T>(endpointId, data, options);
  }

  async postText(
    endpointId: string,
    data: Record<string, string> = {},
    options?: CallOptions,
  ): Promise<string> {
    return this.call<string>(endpointId, data, options);
  }

  async raw(
    endpointId: string,
    options?: CallOptions,
  ): Promise<TransportResponse> {
    return this.call<TransportResponse>(endpointId, {}, options);
  }

  private decode<T>(endpoint: EndpointDef, text: string): T {
    if (endpoint.response === 'text' || endpoint.response === 'html') {
      return parseText(endpoint.id, text) as unknown as T;
    }
    return parseJson<T>(endpoint.id, text, { tolerateNotices: endpoint.kind === 'read' });
  }

  private enforceMutationGate(endpoint: EndpointDef, options: CallOptions): void {
    if (endpoint.kind !== 'mutate') return;
    if (this.mode === 'preview') {
      throw new MutationBlockedInPreviewError(endpoint.id); // #1
    }
    // write mode
    // #3 allowlist: an endpoint the active workflow did not declare must never
    // fire, even with approval. An undefined allowlist means "not imposed".
    if (this.mutationAllowlist && !this.mutationAllowlist.includes(endpoint.id)) {
      throw new MutationNotAllowlistedError(endpoint.id);
    }
    if (endpoint.requiresApproval && !options.approval?.approved) {
      throw new MutationNotApprovedError(endpoint.id); // #2
    }
  }

  private emit(
    endpoint: EndpointDef,
    url: string,
    data: Record<string, string>,
    status: number,
    ok: boolean,
    durationMs: number,
  ): void {
    if (!this.onCall) return;
    this.onCall({
      endpointId: endpoint.id,
      method: endpoint.method,
      url,
      payload: redact({ ...data }),
      status,
      ok,
      durationMs,
    });
  }
}

/** Re-export the registry for callers that need to introspect it. */
export { ENDPOINTS };
