/**
 * Authorization header parsing.
 *
 * Auth itself is a per-user EvoMedis login (see sessions.ts + server.ts):
 * `POST /api/auth/login` issues a session token, which the client returns as
 * `Authorization: Bearer <token>`. This module only extracts that token from
 * the header; resolving it to an operator is the UserSessionStore's job.
 *
 * Tokens are session secrets: never log them or echo them in responses.
 */

export const APP_SESSION_COOKIE = 'simrs_flow_session';

export class OperatorRegistry {
  /** Extract the bearer token from an Authorization header value. */
  static bearer(header: string | undefined): string | undefined {
    if (!header) return undefined;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    return m ? m[1]!.trim() : undefined;
  }

  /** Extract one cookie value without adding a cookie-parser dependency. */
  static cookie(header: string | undefined, name = APP_SESSION_COOKIE): string | undefined {
    if (!header) return undefined;
    for (const item of header.split(';')) {
      const separator = item.indexOf('=');
      if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
      const value = item.slice(separator + 1).trim();
      if (!value) return undefined;
      try {
        return decodeURIComponent(value);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${APP_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${APP_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
