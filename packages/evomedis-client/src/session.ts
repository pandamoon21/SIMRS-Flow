/**
 * Session handling. Credentials are never hardcoded — they are supplied at
 * runtime (env/secret store) via SessionConfig. Safety control #17.
 *
 * This is intentionally minimal: it holds the current cookie and base URLs,
 * and exposes a hook for refresh-on-expiry that the orchestrator can wire to
 * a real login flow. The client treats a missing cookie as fail-closed.
 */

export interface SessionConfig {
  /** Base URL of the v1 CodeIgniter app (no trailing slash). */
  baseUrlV1: string;
  /** Base URL of the v2 JSON API (optional). */
  baseUrlV2?: string;
  /** Current session cookie value (e.g. "ci_session=..."). */
  cookie?: string;
  /** Cookie name, default ci_session. */
  cookieName?: string;
  /** Optional Origin/Referer to mimic the browser. */
  origin?: string;
  referer?: string;
}

export class Session {
  private cookie?: string;
  constructor(private readonly config: SessionConfig) {
    this.cookie = config.cookie;
  }

  get baseUrlV1(): string {
    const base = this.config.baseUrlV1.replace(/\/$/, '');
    return /\/index\.php$/i.test(base) ? base : `${base}/index.php`;
  }

  get baseUrlV2(): string | undefined {
    return this.config.baseUrlV2?.replace(/\/$/, '');
  }

  /** Cookie name the session uses (default ci_session). */
  get cookieName(): string {
    return this.config.cookieName ?? 'ci_session';
  }

  hasCookie(): boolean {
    return Boolean(this.cookie && this.cookie.length > 0);
  }

  /** Build request headers for an API call. */
  headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...extra,
    };
    if (this.cookie) headers['Cookie'] = this.cookie;
    if (this.config.origin) headers['Origin'] = this.config.origin;
    if (this.config.referer) headers['Referer'] = this.config.referer;
    return headers;
  }

  /** Replace the active cookie (after a refresh/login). */
  setCookie(cookie: string): void {
    this.cookie = cookie;
  }
}
