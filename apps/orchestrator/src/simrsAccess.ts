/**
 * SIMRS access: operator session → cookie + base URLs → transport.
 *
 * The one place that turns "who is asking" into "how to reach SIMRS". Used by
 * RunService for live runs and by the server's run-setup report reads, so both
 * resolve cookies and wrap re-login the same way.
 *
 *   - A per-user session (the logged-in operator's own EvoMedis cookie) takes
 *     priority over the shared service-account env config.
 *   - Per-user transports are wrapped in `ReloginTransport`, so an expired
 *     cookie triggers one silent re-login + retry with the user's retained
 *     credentials. The env cookie has no credentials to re-login with.
 *   - The base transport comes from an injectable factory (default
 *     `FetchTransport`), so tests exercise the wiring without a network.
 */

import { EvoMedisClient, FetchTransport, type Transport } from '@simrs-flow/evomedis-client';
import { ReloginTransport } from './reloginTransport.js';
import type { UserSessionStore } from './sessions.js';

/** Live SIMRS connection, resolved from the environment by the entrypoint. */
export interface LiveConfig {
  baseUrlV1: string;
  cookie: string;
  baseUrlV2?: string;
}

/** Builds the innermost (network) transport. */
export type TransportFactory = () => Transport;

export interface SimrsAccessOptions {
  /** Per-user session store; supplies each operator's own EvoMedis cookie. */
  sessions?: UserSessionStore;
  /** Shared service-account credentials (env fallback). */
  live?: LiveConfig;
  /** Network transport; defaults to `new FetchTransport()`. */
  transportFactory?: TransportFactory;
}

/** A resolved SIMRS connection for one caller. */
export interface SimrsConnection {
  baseUrlV1: string;
  baseUrlV2?: string;
  cookie: string;
  /** Set when the cookie is the caller's own session (re-login possible). */
  sessionToken?: string;
}

export type ConnectionResult =
  | { ok: true; connection: SimrsConnection }
  | { ok: false; message: string };

export class SimrsAccess {
  private readonly sessions?: UserSessionStore;
  private readonly live?: LiveConfig;
  private readonly transportFactory: TransportFactory;

  constructor(options: SimrsAccessOptions = {}) {
    this.sessions = options.sessions;
    this.live = options.live;
    this.transportFactory = options.transportFactory ?? (() => new FetchTransport());
  }

  /**
   * Connection for a live run: the caller's own session first, then the
   * shared env config. Fails closed when either the cookie or base URL is
   * missing.
   */
  connection(sessionToken: string | undefined): ConnectionResult {
    const userCookie = this.sessions?.cookieFor(sessionToken);
    const baseUrlV1 = userCookie ? this.sessions?.baseUrlV1 : this.live?.baseUrlV1;
    const baseUrlV2 = userCookie ? this.sessions?.baseUrlV2 : this.live?.baseUrlV2;
    const cookie = userCookie ?? this.live?.cookie;
    if (!cookie || !baseUrlV1) {
      return {
        ok: false,
        message:
          userCookie === undefined && this.live === undefined
            ? 'Live source unavailable — log in (per-user) or configure EVOMEDIS_BASE_URL/EVOMEDIS_SESSION_COOKIE'
            : 'Live source unavailable — EVOMEDIS_BASE_URL not configured',
      };
    }
    return {
      ok: true,
      connection: {
        baseUrlV1,
        ...(baseUrlV2 ? { baseUrlV2 } : {}),
        cookie,
        ...(userCookie && this.sessions && sessionToken ? { sessionToken } : {}),
      },
    };
  }

  /**
   * Transport for a connection. `wrapInner` decorates the network transport
   * *inside* the re-login wrapper (QA faults sit there, so a dropped cookie
   * exercises the real recovery).
   */
  transportFor(connection: SimrsConnection, wrapInner?: (inner: Transport) => Transport): Transport {
    const base = this.transportFactory();
    const inner = wrapInner ? wrapInner(base) : base;
    return connection.sessionToken && this.sessions
      ? new ReloginTransport(inner, this.sessions, connection.sessionToken, this.sessions.cookieName)
      : inner;
  }

  /**
   * A preview-mode client on the caller's *own* EvoMedis session (re-login on
   * expiry), for read-only report reads. `undefined` when the caller has no
   * live per-user session; the env service account is never used here.
   */
  userReadClient(sessionToken: string | undefined): EvoMedisClient | undefined {
    const sessions = this.sessions;
    const cookie = sessions?.cookieFor(sessionToken);
    if (!sessions || !cookie || !sessionToken) return undefined;
    return new EvoMedisClient(
      { baseUrlV1: sessions.baseUrlV1, baseUrlV2: sessions.baseUrlV2, cookieName: sessions.cookieName, cookie },
      {
        mode: 'preview',
        transport: new ReloginTransport(this.transportFactory(), sessions, sessionToken, sessions.cookieName),
      },
    );
  }
}
