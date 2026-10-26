/**
 * Response parsers and detectors.
 *
 * The legacy backend frequently returns HTML/PHP error pages with a 200
 * status, or a login page when the session has expired. Safety control #5/#6
 * (fail closed): these must never be mistaken for success.
 */

import { SessionExpiredError, UnexpectedResponseError } from './errors.js';

const LOGIN_MARKERS = [
  'name="password"',
  'login/index',
  'id="form-login"',
  'Silakan login',
  'please login',
];

const PHP_ERROR_MARKERS = [
  '<b>Fatal error</b>',
  '<b>Warning</b>',
  '<b>Notice</b>',
  'A PHP Error was encountered',
  'Call Stack',
  'Severity:',
];

/** Heuristic: does this body look like a login page? */
export function looksLikeLogin(body: string): boolean {
  const lower = body.toLowerCase();
  return LOGIN_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

/** Heuristic: does this body look like a PHP/HTML error page? */
export function looksLikePhpError(body: string): boolean {
  return PHP_ERROR_MARKERS.some((m) => body.includes(m));
}

/**
 * One CodeIgniter `error_php` block for a non-fatal Notice/Warning. The
 * template holds only <h4>/<p> children, so the first `</div>` closes it.
 */
const PHP_NOTICE_BLOCK =
  /^<div style="border:1px solid #990000[^>]*>(?:(?!<\/div>)[\s\S])*?Severity:\s*(?:Notice|Warning)(?:(?!<\/div>)[\s\S])*<\/div>\s*/;

/**
 * Drop leading PHP Notice/Warning blocks the controller printed before its
 * JSON. Live: `get_datariwayatsep` prefixes `Trying to access array offset on
 * value of type null` to a valid `[]` when BPJS has no SEP history for the
 * card. Anything left that still looks like an error keeps failing closed.
 */
export function stripPhpNotices(body: string): string {
  let rest = body;
  for (let m = PHP_NOTICE_BLOCK.exec(rest); m; m = PHP_NOTICE_BLOCK.exec(rest)) {
    rest = rest.slice(m[0].length);
  }
  return rest;
}

/**
 * Parse a JSON response, failing closed on login/PHP-error pages.
 * Throws SessionExpiredError or UnexpectedResponseError as appropriate.
 *
 * `tolerateNotices` is for reads only: a write's ack must stay strict, since a
 * notice there can mean the controller ran half its statements.
 */
export function parseJson<T = unknown>(
  endpointId: string,
  body: string,
  { tolerateNotices = false }: { tolerateNotices?: boolean } = {},
): T {
  const raw = body.trim();
  const trimmed = tolerateNotices ? stripPhpNotices(raw).trim() : raw;
  if (looksLikeLogin(trimmed)) {
    throw new SessionExpiredError();
  }
  if (looksLikePhpError(trimmed)) {
    throw new UnexpectedResponseError(endpointId, trimmed);
  }
  // An empty body is this backend's "nothing to report" answer (a clean
  // penunjang guard, an absent SEP, a transaction with no detail row). Legacy's
  // `postFetch` returns `null` for it and every caller reads that as "empty",
  // so parsing it as `{}` keeps the same meaning instead of turning a clean
  // answer into a fail-closed error — which ended whole runs and refused
  // writes the backend had already accepted.
  if (trimmed === '') return {} as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new UnexpectedResponseError(endpointId, trimmed);
  }
}

/** Parse a plain-text response (e.g. "0"/"1"/"SUDAH KELUAR"), failing closed. */
export function parseText(endpointId: string, body: string): string {
  const trimmed = body.trim();
  if (looksLikeLogin(trimmed)) {
    throw new SessionExpiredError();
  }
  if (looksLikePhpError(trimmed)) {
    throw new UnexpectedResponseError(endpointId, trimmed);
  }
  return trimmed;
}

/** Normalize an Indonesian date-ish string to YYYY-MM-DD where possible. */
export function normalizeDate(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  // Already ISO-ish
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s);
  if (dmy) {
    const d = dmy[1]!.padStart(2, '0');
    const m = dmy[2]!.padStart(2, '0');
    return `${dmy[3]}-${m}-${d}`;
  }
  return null;
}

/**
 * Legacy `find_sep` pre-flight: should the `no_kk` from `getdatakunjungan` be
 * rejected as a BPJS card number, forcing the `getdatapenjamin_tab`
 * (`no_asuransi`) fallback? Three conditions, not one: empty, shorter than nine
 * digits, or a NIK starting "33" (the family-card prefix).
 *
 * Returns `''` when the number is usable.
 */
export function noKkRejectionReason(noKk: unknown): '' | 'panjang < 9' | 'berawalan 33 (NIK)' {
  const value = typeof noKk === 'string' ? noKk.trim() : '';
  if (!value || value.length < 9) return 'panjang < 9';
  if (value.startsWith('33')) return 'berawalan 33 (NIK)';
  return '';
}

/** Pad a BPJS card number to 13 digits; null if all-zero/invalid. */
export function normalizeCardNumber(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  const padded = digits.padStart(13, '0');
  if (/^0+$/.test(padded)) return null;
  return padded;
}
