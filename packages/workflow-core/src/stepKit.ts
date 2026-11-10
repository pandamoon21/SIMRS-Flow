/**
 * Step toolkit — the plumbing every domain executor repeats.
 *
 * Both domain packages turn backend reads into `StepResult`s the same way:
 * build a result with a status and an operator summary, attach issue codes,
 * swallow an optional read without losing the fact that it failed, and coerce
 * the legacy backend's loosely-typed rows. This module holds exactly that and
 * nothing domain-specific.
 *
 * It stays inside workflow-core (no network, no Node-only deps): the read
 * helpers take the client *structurally* ({@link StepReadClient}), so this
 * package never imports `@simrs-flow/evomedis-client`.
 *
 * What a step can return is declared per node in each domain's `outcomes.ts`
 * and checked against real results (see `./outcomes.ts`), not read off these
 * helper calls.
 */

import type { ExecutorContext, IssueSeverity, MutationPlan, StepResult, WorkflowIssue } from './types.js';

// ── step results ─────────────────────────────────────────────────

export function ok(summary: string, extra?: Partial<StepResult>): StepResult {
  return { status: 'success', summary, ...extra };
}

export function fail(summary: string, extra?: Partial<StepResult>): StepResult {
  return { status: 'failed', summary, ...extra };
}

export function blocked(summary: string, extra?: Partial<StepResult>): StepResult {
  return { status: 'blocked', summary, ...extra };
}

export function skipped(summary: string, extra?: Partial<StepResult>): StepResult {
  return { status: 'skipped', summary, ...extra };
}

export function review(summary: string, extra?: Partial<StepResult>): StepResult {
  return { status: 'needs_review', summary, ...extra };
}

/** A planning step: `skipped` when there is nothing to propose, otherwise `needs_review` carrying the plans. */
export function planResult(summary: string, plans: MutationPlan[]): StepResult {
  if (plans.length === 0) return skipped(summary);
  return { status: 'needs_review', summary, proposedMutations: plans };
}

/** An issue with a stable machine code (warn unless told otherwise). */
export function warning(code: string, message: string, severity: IssueSeverity = 'warn'): WorkflowIssue {
  return { code, message, severity };
}

/** The text of a caught error, the way every executor spells it. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── reads that may fail ──────────────────────────────────────────

/** Outcome of a read attempted without letting its failure escape. */
export type ReadAttempt<T> = { ok: true; value: T } | { ok: false; error: unknown; message: string };

/**
 * Run a read and hand back its value or its failure, never a throw. For the
 * call sites that react to a failure in their own words (a review line, a
 * dropped record); {@link softJson}/{@link softText} are the logged variant.
 */
export async function attempt<T>(read: () => Promise<T>): Promise<ReadAttempt<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error, message: errorMessage(error) };
  }
}

export interface StepReadOptions {
  query?: Record<string, string>;
  signal?: AbortSignal;
}

/** The slice of the SIMRS client a soft read needs — structural, so no client import. */
export interface StepReadClient {
  postJson<T = unknown>(endpointId: string, data?: Record<string, string>, options?: StepReadOptions): Promise<T>;
  postText(endpointId: string, data?: Record<string, string>, options?: StepReadOptions): Promise<string>;
}

/** Scratch key holding `{ [endpointId]: failureCount }` for the run. */
export const READ_FAILURES_KEY = 'readFailures';

function readFailures(ctx: ExecutorContext): Record<string, number> {
  return (ctx.scratch[READ_FAILURES_KEY] ??= {}) as Record<string, number>;
}

/**
 * Read failures, recorded so a step cannot report a clean verdict it never
 * earned. A silently-empty read is otherwise indistinguishable from a genuinely
 * empty answer.
 */
export function recordReadFailure(ctx: ExecutorContext, endpointId: string): void {
  const failures = readFailures(ctx);
  failures[endpointId] = (failures[endpointId] ?? 0) + 1;
}

/** How often `endpointId` failed so far this run (compare before/after a node's own reads). */
export function readFailureCount(ctx: ExecutorContext, endpointId: string): number {
  return readFailures(ctx)[endpointId] ?? 0;
}

/** Which of `endpointIds` failed at least once during this run. */
export function failedReads(ctx: ExecutorContext, ...endpointIds: readonly string[]): string[] {
  const failures = readFailures(ctx);
  return endpointIds.filter((id) => (failures[id] ?? 0) > 0);
}

/**
 * A read that is allowed to fail: the failure is counted against `endpointId`
 * and its reason lands in the debug log, then `fallback` is returned. The
 * legacy scripts wrap almost every read in a bare `try/except` and carry on;
 * a missing optional read must not fail the step, but it must stay visible.
 */
export async function softRead<T, F>(
  ctx: ExecutorContext,
  endpointId: string,
  read: () => Promise<T>,
  fallback: F,
): Promise<T | F> {
  try {
    return await read();
  } catch (err) {
    recordReadFailure(ctx, endpointId);
    ctx.log(`Read ${endpointId} gagal: ${errorMessage(err)}`, 'debug');
    return fallback;
  }
}

/** {@link softRead} of a JSON endpoint; `undefined` when the read failed. */
export function softJson<T>(
  ctx: ExecutorContext,
  client: StepReadClient,
  endpointId: string,
  data: Record<string, string>,
  options?: { query?: Record<string, string> },
): Promise<T | undefined> {
  return softRead(ctx, endpointId, () => client.postJson<T>(endpointId, data, { signal: ctx.signal, ...(options ?? {}) }), undefined);
}

/** {@link softRead} of a text endpoint; `''` when the read failed. */
export function softText(
  ctx: ExecutorContext,
  client: StepReadClient,
  endpointId: string,
  data: Record<string, string>,
  options?: { query?: Record<string, string> },
): Promise<string> {
  return softRead(ctx, endpointId, () => client.postText(endpointId, data, { signal: ctx.signal, ...(options ?? {}) }), '');
}

// ── legacy row coercion ──────────────────────────────────────────
//
// The legacy CodeIgniter endpoints return string-keyed dicts with wildly
// inconsistent field names and value types (numbers arrive as strings, dates
// in three formats, booleans as "0"/"1"/"true"). Rather than invent a typed
// model per endpoint — which the backend would violate anyway — callers read
// fields through these coercing accessors, the same thing the Python does with
// `str(row.get(key) or "").strip()`.

/** An untyped row from a legacy SIMRS endpoint. */
export interface LegacyRow {
  readonly [key: string]: unknown;
}

/** `str(row.get(key) or "").strip()` — the Python idiom, once. First non-blank key wins. */
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

/** Uppercased field read — the comparison form. */
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

/**
 * The `rows` array of a typed grid reply, or `[]`. Narrower than
 * {@link rowsOf}: only the `rows` envelope counts, and the element type is the
 * caller's — for endpoints whose reply shape is already pinned down.
 */
export function rowsField<T>(reply: { readonly rows?: readonly T[] } | null | undefined): readonly T[] {
  return reply?.rows ?? [];
}

function isRow(value: unknown): value is LegacyRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
