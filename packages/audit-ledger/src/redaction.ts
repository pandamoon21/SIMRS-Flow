/**
 * Redaction — strips credentials, tokens, and PHI before anything is
 * logged or persisted. Safety control #14: "Redaction PHI/credential/token".
 *
 * The policy is deny-by-key plus value-pattern scrubbing, applied
 * recursively. It is deliberately conservative: when in doubt, redact.
 */

export const REDACTED = '«redacted»';

/** Keys whose values are always redacted (case-insensitive substring match). */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'authorization',
  'auth-key',
  'authorization-key',
  'cookie',
  'ci_session',
  'phpsessid',
  'session',
  'apikey',
  'api_key',
  'x-token',
  'credential',
  'kartu', // BPJS card number
  'no_kartu',
  'no_kk', // family card
  'nik',
  'ktp',
];

/**
 * PHI-ish keys that should be masked (kept partially for debugging) rather
 * than fully removed. We keep the last 2 chars so operators can correlate.
 */
export const MASK_KEY_PATTERNS: readonly string[] = [
  'nama_pasien',
  'nama_peserta',
  'alamat',
  'tgl_lahir',
  'tanggal_lahir',
  'no_telp',
  'telepon',
];

/** Value patterns that look like secrets regardless of their key. */
const VALUE_PATTERNS: readonly RegExp[] = [
  // long url-encoded ci_session blobs
  /ci_session=[^;\s]+/gi,
  // bearer tokens
  /bearer\s+[a-z0-9._-]+/gi,
];

function keyMatches(key: string, patterns: readonly string[]): boolean {
  const k = key.toLowerCase();
  return patterns.some((p) => k.includes(p));
}

function maskValue(value: string): string {
  if (value.length <= 2) return REDACTED;
  return `${REDACTED}${value.slice(-2)}`;
}

function scrubString(value: string): string {
  let out = value;
  for (const re of VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Recursively redact an arbitrary value. Returns a new structure; never
 * mutates the input. Cyclic references are handled via a seen set.
 */
export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return scrubString(value) as unknown as T;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (seen.has(value as object)) {
    return REDACTED as unknown as T;
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((v) => redact(v, seen)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (keyMatches(key, SENSITIVE_KEY_PATTERNS)) {
      out[key] = REDACTED;
    } else if (keyMatches(key, MASK_KEY_PATTERNS) && typeof val === 'string') {
      out[key] = maskValue(val);
    } else {
      out[key] = redact(val, seen);
    }
  }
  return out as unknown as T;
}

/** Redact a header bag (plain object or [key,value] entries). */
export function redactHeaders(
  headers: Record<string, string> | Iterable<[string, string]>,
): Record<string, string> {
  const entries: Iterable<[string, string]> =
    typeof (headers as Iterable<[string, string]>)[Symbol.iterator] === 'function'
      ? (headers as Iterable<[string, string]>)
      : Object.entries(headers as Record<string, string>);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    out[k] = keyMatches(k, SENSITIVE_KEY_PATTERNS) ? REDACTED : scrubString(v);
  }
  return out;
}
