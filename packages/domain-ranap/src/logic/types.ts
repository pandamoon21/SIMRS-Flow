/**
 * Shared row shapes for the ported `ranap_v3.py` logic.
 *
 * The legacy CodeIgniter endpoints return string-keyed dicts with wildly
 * inconsistent field names and value types (numbers arrive as strings, dates
 * in three formats, booleans as "0"/"1"/"true"). Rather than invent a typed
 * model per endpoint — which the backend would violate anyway — the ported
 * helpers accept `LegacyRow` and read fields through the coercing accessors.
 * That keeps the port faithful to the Python, which does the same thing with
 * `str(row.get(key) or "").strip()`.
 *
 * The accessors are shared with the rajal domain and live in the workflow-core
 * step toolkit; this module re-exports them so the ported logic keeps one
 * local import path.
 */
export { flag, rowsOf, str, upper } from '@simrs-flow/workflow-core';
export type { LegacyRow } from '@simrs-flow/workflow-core';
