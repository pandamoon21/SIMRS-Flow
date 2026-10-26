/**
 * Per-user EvoMedis session store.
 *
 * A successful EvoMedis login *is* the app login. When a user submits their
 * EvoMedis username/password, the orchestrator logs into SIMRS on their behalf
 * (via EvoMedisClient.login), captures the `ci_session` cookie, and issues an
 * opaque session token. That token both authorizes write actions on the
 * orchestrator API and binds every live run the user starts to *their* cookie
 * — so the SIMRS-side audit trail attributes writes to the real person.
 *
 * Credentials are held in memory ONLY (never written to disk) so the store can
 * silently re-login when the `ci_session` expires mid-use. A process restart
 * clears every session — everyone re-logs-in. That is intentional: there is no
 * credential persistence to leak.
 */

import { randomUUID } from 'node:crypto';
import {
  EvoMedisClient,
  FetchTransport,
  LoginFailedError,
  type Transport,
} from '@simrs-flow/evomedis-client';

export interface UserSession {
  /** Opaque bearer token the UI presents on every request. */
  token: string;
  /** EvoMedis username — the operator identity recorded in the audit trail. */
  operator: string;
  /** Current EvoMedis cookie (`ci_session=...`). */
  cookie: string;
  createdAt: string;
  lastLoginAt: string;
}

export interface UserSessionStoreOptions {
  /** EvoMedis v1 base URL (login + all workflow calls). */
  baseUrlV1: string;
  baseUrlV2?: string;
  cookieName?: string;
  /** Injectable transport for tests; defaults to a real FetchTransport. */
  transport?: Transport;
}

/** Internal record: like UserSession but retains the password in RAM. */
interface SessionRecord extends UserSession {
  password: string;
}

export class UserSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly options: UserSessionStoreOptions) {}

  /** True when a live EvoMedis target is configured (always, given a base URL). */
  get configured(): boolean {
    return Boolean(this.options.baseUrlV1);
  }

  get baseUrlV1(): string {
    return this.options.baseUrlV1;
  }

  get baseUrlV2(): string | undefined {
    return this.options.baseUrlV2;
  }

  /** Cookie name used for sessions (default ci_session). */
  get cookieName(): string {
    return this.options.cookieName ?? 'ci_session';
  }

  private newClient(): EvoMedisClient {
    return new EvoMedisClient(
      {
        baseUrlV1: this.options.baseUrlV1,
        baseUrlV2: this.options.baseUrlV2,
        cookieName: this.options.cookieName,
      },
      // Login itself is mode-agnostic; preview is the safe default.
      { mode: 'preview', transport: this.options.transport ?? new FetchTransport() },
    );
  }

  /**
   * Authenticate against EvoMedis and create a session. Throws LoginFailedError
   * (from the client) on bad credentials. Returns the issued token + operator.
   */
  async login(username: string, password: string): Promise<{ token: string; operator: string }> {
    const user = String(username ?? '').trim();
    const pass = String(password ?? '');
    if (!user || !pass) throw new LoginFailedError('username and password are required');

    const client = this.newClient();
    const { cookie } = await client.login(user, pass);

    const token = randomUUID();
    const now = new Date().toISOString();
    this.sessions.set(token, {
      token,
      operator: user,
      password: pass,
      cookie,
      createdAt: now,
      lastLoginAt: now,
    });
    return { token, operator: user };
  }

  /** Resolve a token to its session (without exposing the password). */
  resolve(token: string | undefined): UserSession | undefined {
    if (!token) return undefined;
    const rec = this.sessions.get(token);
    if (!rec) return undefined;
    const { password: _password, ...session } = rec;
    void _password;
    return session;
  }

  /** Current cookie for a token, or undefined if unknown. */
  cookieFor(token: string | undefined): string | undefined {
    if (!token) return undefined;
    return this.sessions.get(token)?.cookie;
  }

  /**
   * Re-login using the retained in-RAM password and refresh the stored cookie.
   * Called when a live run hits SessionExpiredError. Returns the fresh cookie,
   * or undefined if the token is unknown. Throws LoginFailedError if the
   * re-login itself fails (e.g. the password changed on the SIMRS side).
   */
  async relogin(token: string): Promise<string | undefined> {
    const rec = this.sessions.get(token);
    if (!rec) return undefined;
    const client = this.newClient();
    const { cookie } = await client.login(rec.operator, rec.password);
    rec.cookie = cookie;
    rec.lastLoginAt = new Date().toISOString();
    return cookie;
  }

  /** Drop a session (logout). Idempotent. */
  logout(token: string | undefined): boolean {
    if (!token) return false;
    return this.sessions.delete(token);
  }

  /** Number of active sessions (for logging — never the tokens/passwords). */
  get size(): number {
    return this.sessions.size;
  }
}

