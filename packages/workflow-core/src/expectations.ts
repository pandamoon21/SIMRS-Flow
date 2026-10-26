/**
 * Expectation evaluation — the comparator behind read-before-write
 * preconditions (`Precondition`) and read-after-write verification
 * (`VerificationRule`).
 *
 * Why this is not `===`. The legacy backend answers the same question in
 * several shapes: a text endpoint returns `"0"`, `"1"` or `""`; a JSON one
 * returns `[]`, `{}`, `{total: 0}` or a row array; and it will happily return
 * an HTML/PHP error page with HTTP 200. `ranap_v3.py` therefore never compares
 * exactly either — it writes `str(x).strip() in ("", "0")`
 * (`_ensure_tindakan_belum_terverifikasi`, ranap_v3.py:12286), treats a blocker
 * as "any of nama_unit/no_transaksi/data/total is set"
 * (`_normalize_penunjang_blocker`, 15023), and rejects a body that looks like an
 * error page (`_looks_like_write_error`, 1038). This module ports those rules
 * as one small, documented, unit-tested function.
 *
 * Safety direction. Every ambiguity resolves to `holds: false`. An expectation
 * that cannot be classified, a read that answered with an error page, or a
 * value this comparator does not understand all fail closed — the caller
 * refuses the write. A false `holds: true` is the only genuinely dangerous
 * outcome, so tolerance is only ever added where the legacy script is
 * demonstrably tolerant in the same place.
 *
 * Nothing here reads the clock, the network, or module state: the same
 * (expectation, observed) pair always yields the same result, which is what
 * keeps a replayed run identical to the original.
 */

/**
 * How `expected` is compared with what the read answered.
 *
 * - `equals`   tolerant equality: text compared after trim (case-insensitive
 *              for non-numeric values), numbers compared numerically.
 * - `empty`    the backend's several spellings of "nothing here": ``, `0`,
 *              `false`, `[]`, `{}`, an all-empty object, `{total: 0}`.
 * - `nonEmpty` the negation of `empty` (the legacy `> 0` expectations).
 * - `atLeast`  numeric `observed >= expected` (used for row/history counts,
 *              where the legacy check is only "not empty any more").
 * - `contains` `expected` appears inside the observed text, case-insensitively
 *              (the legacy `"SUDAH KELUAR" in status` style check).
 * - `subset`   every key/value in `expected` matches on the observed object, or
 *              on at least one of its rows.
 * - `allEquals` every selected row-field value equals `expected`; an empty row
 *              set fails closed.
 */
export type ExpectationMatch =
  | 'equals'
  | 'empty'
  | 'nonEmpty'
  | 'atLeast'
  | 'contains'
  | 'subset'
  | 'allEquals';

export interface Expectation {
  /** The value the read must still answer. */
  expected: unknown;
  /** Optional row selector for row-shaped JSON responses. */
  where?: Record<string, unknown>;
  /** Optional field (or dotted path) to read out of a JSON response first. */
  field?: string;
  /** Explicit comparison; inferred from `expected` when omitted. */
  match?: ExpectationMatch;
}

export interface ExpectationResult {
  /** True only when the expectation demonstrably still holds. */
  holds: boolean;
  /** The comparison actually used (inferred when the caller did not say). */
  match: ExpectationMatch;
  /** Short rendering of what the read answered, for the audit trail. */
  observed: string;
  /** One-line explanation, suitable for an operator-facing event message. */
  reason: string;
}

/** How much of a response body is kept in an event/audit record. */
const OBSERVED_MAX_CHARS = 200;

/** Depth cap for the recursive helpers, so a pathological payload cannot spin. */
const MAX_DEPTH = 4;

/**
 * Markers of a body that is an error page rather than an answer. Ported from
 * `_looks_like_write_error` (ranap_v3.py:1038). `parseJson`/`parseText` in the
 * client already reject the *PHP-notice* flavours; this also catches a bare
 * HTML page and "Database Error", which arrive with HTTP 200 and would
 * otherwise be compared as if they were data.
 */
const BACKEND_ERROR_MARKERS: readonly string[] = [
  '<!doctype',
  '<html',
  'database error',
  'a php error was encountered',
  'severity:',
  'uncaught',
  'fatal error',
];

/** Does this body look like an error page instead of an answer? */
export function looksLikeBackendError(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const lower = value.toLowerCase();
  return BACKEND_ERROR_MARKERS.some((marker) => lower.includes(marker));
}

/** Text forms the backend uses interchangeably for "nothing / not set / no". */
const EMPTY_TEXTS: readonly string[] = ['', '0', '-', 'false', 'null', 'undefined'];

/** Rows carried directly, or under the backend's `rows` / `data` wrappers. */
function rowsOf(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.rows)) return record.rows;
    if (Array.isArray(record.data)) return record.data;
  }
  return undefined;
}

/**
 * Is this value one of the backend's spellings of "nothing"?
 *
 * Scalars: empty/whitespace text, `0`, `-`, `false`. Arrays: no elements.
 * Objects: every value is itself empty — which is exactly
 * `_normalize_penunjang_blocker`'s `has_blocker` test inverted, so a blocker
 * response of `{nama_unit:"", no_transaksi:"", data:"", total:0}` reads as
 * empty while any populated field does not.
 */
export function isEmptyish(value: unknown, depth = 0): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'boolean') return value === false;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'string') return EMPTY_TEXTS.includes(value.trim().toLowerCase());
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>);
    return values.every((entry) => isEmptyish(entry, depth + 1));
  }
  // Anything else (function, symbol) is not an answer we can read.
  return false;
}

/** Trimmed text rendering of a scalar; `undefined` for containers. */
function scalarText(value: unknown): string | undefined {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Whole-value text rendering, truncated for the audit trail. */
function renderObserved(value: unknown): string {
  const scalar = scalarText(value);
  const text = scalar ?? (() => {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return '[unserializable]';
    }
  })();
  return text.length > OBSERVED_MAX_CHARS ? `${text.slice(0, OBSERVED_MAX_CHARS)}…` : text;
}

/**
 * Numeric reading of a response. Covers the shapes the legacy script counts:
 * a bare number, a numeric string, a row array's length, and the `total` field
 * of `cek_order_belum_terlayani` / `cek_order_belum_transfer`
 * (ranap_v3.py:3768, 3783).
 */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Money-ish answers arrive with Indonesian thousand separators
    // ("1.500.000"); separators are stripped, so a decimal fraction would be
    // misread. No expectation in the registry uses one — these fields are
    // integer rupiah, counts, or status flags.
    if (!/^-?\d+([.,]\d+)*$/.test(trimmed)) return undefined;
    const parsed = Number(trimmed.replace(/[.,]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('total' in record) {
      const total = numberOf(record.total);
      if (total !== undefined) return total;
    }
    const rows = rowsOf(value);
    if (rows) return rows.length;
  }
  return undefined;
}

/**
 * Read a field (or dotted path) out of a response.
 *
 * On an array, `length` gives the row count and any other field gives the
 * per-row values, so a comparison against a row-shaped read means "any row".
 * A `rows`/`data` wrapper is stepped through transparently.
 */
export function readField(value: unknown, field?: string): unknown {
  if (!field) return value;
  let current: unknown = value;
  for (const segment of field.split('.')) {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) {
      if (segment === 'length') {
        current = current.length;
        continue;
      }
      current = current.map((row) => readField(row, segment));
      continue;
    }
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (segment in record) {
        current = record[segment];
        continue;
      }
      const rows = rowsOf(current);
      if (rows) {
        current = segment === 'length' ? rows.length : rows.map((row) => readField(row, segment));
        continue;
      }
      return undefined;
    }
    return undefined;
  }
  return current;
}

/** Tolerant scalar equality: numeric when either side is numeric, else text. */
function scalarEquals(expected: unknown, observed: unknown): boolean {
  if (typeof expected === 'number') {
    const actual = numberOf(observed);
    return actual !== undefined && actual === expected;
  }
  const wanted = scalarText(expected);
  const actual = scalarText(observed);
  if (wanted === undefined || actual === undefined) return false;
  if (wanted === actual) return true;
  return wanted.toLowerCase() === actual.toLowerCase();
}

/** Does `expected` appear as a scalar value anywhere inside `observed`? */
function equalsSomewhere(expected: unknown, observed: unknown, depth = 0): boolean {
  if (scalarEquals(expected, observed)) return true;
  if (depth >= MAX_DEPTH || observed === null || typeof observed !== 'object') return false;
  const entries = Array.isArray(observed)
    ? observed
    : Object.values(observed as Record<string, unknown>);
  return entries.some((entry) => equalsSomewhere(expected, entry, depth + 1));
}

function filterRows(value: unknown, where?: Record<string, unknown>): unknown {
  if (!where || Object.keys(where).length === 0) return value;
  const rows = rowsOf(value);
  return rows ? rows.filter((row) => subsetMatches(where, row)) : [];
}

/** Every key/value of `expected` matches on `observed` (or on one of its rows). */
function subsetMatches(expected: Record<string, unknown>, observed: unknown): boolean {
  const entries = Object.entries(expected);
  const onOne = (candidate: unknown): boolean =>
    entries.every(([key, value]) => scalarEquals(value, readField(candidate, key)));
  if (onOne(observed)) return true;
  const rows = rowsOf(observed);
  return rows ? rows.some((row) => onOne(row)) : false;
}

/**
 * Predicate spellings the domain executors already use in `expected`.
 *
 * These are prose, not values — `'> 0'`, `'> 0 baris'`, `'tidak ada blocker'`.
 * They are part of the existing plan data, so recognising exactly these forms
 * is what makes those preconditions enforceable at all. New plans should set
 * `match` explicitly instead; anything unrecognised falls through to tolerant
 * equality (and prose never equals a real answer, so it fails closed).
 */
function predicateMatch(expected: string): ExpectationMatch | undefined {
  const text = expected.trim().toLowerCase();
  // `'> 0'` (biaya transfer IGD terbaca) and `'> 0 baris'` (detail order gizi
  // masih ada) — ranap_v3.py:9233 and 15232.
  if (/^>\s*0\b/.test(text)) return 'nonEmpty';
  // `'tidak ada blocker'` — `_normalize_penunjang_blocker` reports no blocker,
  // ranap_v3.py:15023.
  if (/^(tidak ada|no)\b.*\bblocker\b/.test(text)) return 'empty';
  return undefined;
}

/**
 * Infer the comparison from the shape of `expected`. Returns `undefined` when
 * `expected` carries nothing comparable — the caller must then fail closed.
 */
export function inferMatch(expected: unknown, field?: string): ExpectationMatch | undefined {
  if (expected === undefined || expected === null) return undefined;
  if (Array.isArray(expected)) return expected.length === 0 ? 'empty' : 'subset';
  if (typeof expected === 'object') return 'subset';
  if (typeof expected === 'number') {
    // A count expectation ("history becomes non-empty") is satisfied by more
    // rows as well; the legacy check is only that it is no longer empty.
    return field === 'length' ? 'atLeast' : 'equals';
  }
  if (typeof expected === 'boolean') return expected ? 'nonEmpty' : 'empty';
  if (typeof expected === 'string') {
    const predicate = predicateMatch(expected);
    if (predicate) return predicate;
    const text = expected.trim();
    // `""` and `"0"` are the backend's "not set" answers, and the legacy guard
    // accepts either for both (`in ("", "0")`, ranap_v3.py:12293).
    if (EMPTY_TEXTS.includes(text.toLowerCase())) return 'empty';
    // A multi-word phrase is a status line the legacy script substring-matches
    // ("SUDAH KELUAR", ranap_v3.py:4998).
    if (/\s/.test(text)) return 'contains';
    return 'equals';
  }
  return undefined;
}

/**
 * Evaluate one expectation against what a read answered.
 *
 * Never throws: a caller that cannot even perform the read should build a
 * failing result itself (see the orchestrator's mutation gate), and everything
 * this function cannot decide is reported as `holds: false`.
 */
export function evaluateExpectation(
  expectation: Expectation,
  observed: unknown,
): ExpectationResult {
  const inferred = expectation.match ?? inferMatch(expectation.expected, expectation.field);
  const match: ExpectationMatch = inferred ?? 'equals';
  const rendered = renderObserved(observed);
  const done = (holds: boolean, reason: string): ExpectationResult => ({
    holds,
    match,
    observed: rendered,
    reason,
  });

  // Fail closed: an expectation with nothing comparable in it is not a control.
  if (!inferred) {
    return done(false, 'expectation carries no comparable `expected` value');
  }
  // Fail closed: a 200 carrying "Database Error" or an HTML page is not an answer.
  if (looksLikeBackendError(observed)) {
    return done(false, 'read answered with a backend error page');
  }

  const selected = filterRows(observed, expectation.where);
  const target = readField(selected, expectation.field);
  const whereText = expectation.where ? ` where ${renderObserved(expectation.where)}` : '';
  const where = expectation.field ? `${expectation.field}${whereText}=${renderObserved(target)}` : renderObserved(selected);

  switch (match) {
    case 'empty': {
      // A field read off rows yields one value per row; `[null]` is "every row blank".
      const blank = Array.isArray(target) && expectation.field ? target.every((v) => isEmptyish(v)) : isEmptyish(target);
      return blank
        ? done(true, `still empty (${where})`)
        : done(false, `expected empty, read ${where}`);
    }
    case 'nonEmpty':
      return isEmptyish(target)
        ? done(false, `expected a value, read ${where}`)
        : done(true, `still set (${where})`);
    case 'atLeast': {
      const wanted = numberOf(expectation.expected) ?? 0;
      const actual = numberOf(target);
      if (actual === undefined) return done(false, `expected >= ${wanted}, read no number in ${where}`);
      return actual >= wanted
        ? done(true, `${actual} >= ${wanted}`)
        : done(false, `expected >= ${wanted}, read ${actual}`);
    }
    case 'contains': {
      const wanted = String(expectation.expected).trim();
      const actual = scalarText(target) ?? renderObserved(target);
      return actual.toLowerCase().includes(wanted.toLowerCase())
        ? done(true, `contains "${wanted}"`)
        : done(false, `expected "${wanted}" in ${where}`);
    }
    case 'subset': {
      const rows = Array.isArray(expectation.expected)
        ? (expectation.expected as unknown[])
        : [expectation.expected];
      const holds = rows.every((row) =>
        row && typeof row === 'object'
          ? subsetMatches(row as Record<string, unknown>, target)
          : equalsSomewhere(row, target),
      );
      return holds
        ? done(true, 'every expected field still matches')
        : done(false, `expected ${renderObserved(expectation.expected)}, read ${where}`);
    }
    case 'allEquals': {
      const values = Array.isArray(target) ? target : [target];
      const holds = values.length > 0 && values.every((entry) => scalarEquals(expectation.expected, entry));
      return holds
        ? done(true, `every selected value is ${renderObserved(expectation.expected)}`)
        : done(false, `expected every selected value to be ${renderObserved(expectation.expected)}, read ${where}`);
    }
    case 'equals':
    default: {
      const wanted = renderObserved(expectation.expected);
      // With an explicit field, compare that field only — but a field read off
      // a row-shaped response yields one value per row (see `readField`), and
      // any row matching is a match. Without a field, accept the value
      // appearing anywhere in the response: the plans that guard "this field
      // still holds its old value" name the endpoint, not the field (e.g. the
      // SEP still being the value the plan was built against).
      const holds = expectation.field
        ? Array.isArray(target)
          ? target.some((entry) => scalarEquals(expectation.expected, entry))
          : scalarEquals(expectation.expected, target)
        : equalsSomewhere(expectation.expected, target);
      return holds
        ? done(true, `still ${wanted}`)
        : done(false, `expected ${wanted}, read ${where}`);
    }
  }
}
