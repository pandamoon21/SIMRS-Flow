/**
 * Run-input contract shared by the domain packages and the UI.
 *
 * A domain turns an operator's form draft into a validated run input plus the
 * per-run node switches (`enabled`) the runner honours. The UI only renders the
 * draft and shows `error` / `summary`; it never decides what a valid input is.
 */

export interface RunInputResult<I = unknown> {
  input?: I;
  /** Per-run node switches; `false` skips a node (and its dependants), `true` turns an opt-in node on. */
  enabled?: Record<string, boolean>;
  /** Why the draft is not runnable yet; absent when `input` is set. */
  error?: string;
  /** One-line operator-facing description of the run the draft describes. */
  summary: string;
}

/** Operator lists: comma or newline separated, trimmed, blanks dropped. */
export function splitList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

/** A real calendar date in `YYYY-MM-DD` form. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** A positive integer from a text field; empty, invalid or non-positive = undefined. */
export function optionalPositiveInteger(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}
