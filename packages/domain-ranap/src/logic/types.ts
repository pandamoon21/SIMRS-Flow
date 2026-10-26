/**
 * Shared row shapes for the ported `ranap_v3.py` logic.
 *
 * The legacy CodeIgniter endpoints return string-keyed dicts with wildly
 * inconsistent field names and value types (numbers arrive as strings, dates
 * in three formats, booleans as "0"/"1"/"true"). Rather than invent a typed
 * model per endpoint — which the backend would violate anyway — the ported
 * helpers accept `LegacyRow` and read fields through the coercing accessors
 * below. That keeps the port faithful to the Python, which does the same
 * thing with `str(row.get(key) or "").strip()`.
 */

/** An untyped row from a legacy SIMRS endpoint. */
export interface LegacyRow {
  readonly [key: string]: unknown;
}

/** `str(row.get(key) or "").strip()` — the Python idiom, once. */
export function str(row: LegacyRow | undefined | null, ...keys: string[]): string {
  if (!row) return '';
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value : String(value);
    const trimmed = text.trim();
    if (trimmed && trimmed.toLowerCase() !== 'null' && trimmed.toLowerCase() !== 'undefined') {
      return trimmed;
    }
  }
  return '';
}

/** Uppercased, whitespace-collapsed field read — the comparison form. */
export function upper(row: LegacyRow | undefined | null, ...keys: string[]): string {
  return str(row, ...keys).toUpperCase();
}

/** Truthy in the legacy sense: "1", "true", "yes", "ya", "y", non-zero number. */
export function flag(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (!text) return false;
  return ['1', 'true', 'yes', 'ya', 'y', 't', 'ada'].includes(text);
}

/** Read an array of rows out of the several envelope shapes the backend uses. */
export function rowsOf(payload: unknown): LegacyRow[] {
  if (Array.isArray(payload)) return payload.filter(isRow);
  if (payload && typeof payload === 'object') {
    const bag = payload as Record<string, unknown>;
    for (const key of ['rows', 'data', 'result', 'records', 'items']) {
      const candidate = bag[key];
      if (Array.isArray(candidate)) return candidate.filter(isRow);
    }
  }
  return [];
}

function isRow(value: unknown): value is LegacyRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
