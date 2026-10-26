/**
 * Typed error hierarchy for the EvoMedis client. Each error maps to a
 * specific safety/contract failure so callers (and tests) can branch on type.
 */

export class EvoMedisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvoMedisError';
  }
}

/** Endpoint id is not in the registry — blocked by safety control #4. */
export class UnknownEndpointError extends EvoMedisError {
  constructor(public readonly endpointId: string) {
    super(`Unknown endpoint "${endpointId}" — blocked (not in registry)`);
    this.name = 'UnknownEndpointError';
  }
}

/** A mutating endpoint was invoked in preview mode — safety control #1/#2. */
export class MutationBlockedInPreviewError extends EvoMedisError {
  constructor(public readonly endpointId: string) {
    super(`Mutating endpoint "${endpointId}" blocked in preview mode`);
    this.name = 'MutationBlockedInPreviewError';
  }
}

/** A mutating endpoint was invoked in write mode without approval. */
export class MutationNotApprovedError extends EvoMedisError {
  constructor(public readonly endpointId: string) {
    super(`Mutating endpoint "${endpointId}" requires approval before write`);
    this.name = 'MutationNotApprovedError';
  }
}

/**
 * A mutating endpoint was invoked in write mode but is not on the active
 * workflow's mutation allowlist — safety control #3. Fail closed: even with
 * approval, an endpoint the workflow did not declare must never fire.
 */
export class MutationNotAllowlistedError extends EvoMedisError {
  constructor(public readonly endpointId: string) {
    super(`Mutating endpoint "${endpointId}" is not on the workflow mutation allowlist`);
    this.name = 'MutationNotAllowlistedError';
  }
}

/** The session expired / response looked like a login page — fail closed. */
export class SessionExpiredError extends EvoMedisError {
  constructor() {
    super('Session expired or not authenticated (login redirect detected)');
    this.name = 'SessionExpiredError';
  }
}

/** A login attempt (username/password) did not yield a valid session. */
export class LoginFailedError extends EvoMedisError {
  constructor(public readonly reason: string) {
    super(`EvoMedis login failed: ${reason}`);
    this.name = 'LoginFailedError';
  }
}

/** The server returned an HTML/PHP error where JSON was expected. */
export class UnexpectedResponseError extends EvoMedisError {
  constructor(
    public readonly endpointId: string,
    public readonly snippet: string,
  ) {
    super(`Unexpected response from "${endpointId}": ${describeResponse(snippet)}`);
    this.name = 'UnexpectedResponseError';
  }
}

/** Network/transport failure or timeout. */
export class TransportError extends EvoMedisError {
  constructor(
    public readonly endpointId: string,
    public override readonly cause: unknown,
  ) {
    super(`Transport error calling "${endpointId}": ${String(cause)}`);
    this.name = 'TransportError';
  }
}

/**
 * A CodeIgniter PHP error page says what went wrong only after ~150 chars of
 * markup, so a blind cut lost it ("Severity: Notice Message: Undefine…").
 * Keep the error block's text (severity, message, file, line) instead.
 */
export function describeResponse(snippet: string): string {
  const php = /A PHP Error was encountered([\s\S]*?)(?:<\/div>|$)/i.exec(snippet);
  if (!php) {
    // Other markup (a Database Error page, a bare HTML body): its text, not its tags.
    if (!/<[a-z!/]/i.test(snippet)) return snippet.slice(0, 160);
    return snippet.slice(0, 4000)
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  }
  const text = php[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return `PHP error — ${text}`.slice(0, 300);
}
