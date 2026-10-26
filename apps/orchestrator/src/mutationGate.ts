/**
 * Mutation gate — safety control #4, enforced.
 *
 * A `MutationPlan` records the guards that must hold for its write to be safe:
 * `preconditions` (read-before-write) and `readAfterWriteCheck(s)`
 * (read-after-write). Recording them is not enforcing them. This module is the
 * single place where they are actually replayed:
 *
 *   1. every `Precondition.check` is re-read through the client and compared
 *      with `expected` **at the moment the write is about to fire** — a plan
 *      approved five minutes ago must not fire against state that has since
 *      changed. Any check that no longer holds refuses the write and emits
 *      `mutation.invalidated`; the mutating endpoint is never called.
 *   2. the write is applied through `EvoMedisClient` (so the preview block, the
 *      per-workflow allowlist and the approval requirement all still apply) and
 *      the acknowledgement is checked the way `_write_result_is_success`
 *      (ranap_v3.py:1241) checks it.
 *   3. every read-after-write rule is re-read and compared. All must hold, as
 *      the conjunction in `_confirm_verifikasi_state` (ranap_v3.py:15371) does.
 *      A mismatch emits `mutation.failed` — the write may have half-landed, so
 *      it must be loud.
 *
 * Fail closed, everywhere. A precondition that cannot be *evaluated* — the read
 * threw, the endpoint is unknown or is not a read, the plan carries no
 * addressable payload — counts as not holding and the write is refused. A
 * silent pass here is the worst possible outcome: it would report a control as
 * verified when nothing was checked.
 *
 * Determinism: no clock and no randomness. Event timestamps come from the run's
 * EventBus, exactly as for every other event.
 */

import {
  evaluateExpectation,
  looksLikeBackendError,
  verificationRulesOf,
  type IssueSeverity,
  type MutationCheckResult,
  type MutationEventData,
  type MutationOutcomeStatus,
  type MutationPhase,
  type MutationPlan,
  type Precondition,
  type VerificationRule,
  type WorkflowEventType,
} from '@simrs-flow/workflow-core';
import { endpointLabel,
  describeResponse,
  getEndpoint,
  TransportError,
  type EndpointDef,
  type EvoMedisClient,
} from '@simrs-flow/evomedis-client';

/** Emits a `mutation.*` event on the run's bus (the caller fills the envelope). */
export type MutationEmit = (event: {
  type: WorkflowEventType;
  severity?: IssueSeverity;
  message: string;
  data: MutationEventData;
}) => void;

export interface MutationApplyResult {
  planId: string;
  endpointId: string;
  status: Extract<MutationOutcomeStatus, 'invalidated' | 'applied' | 'verified' | 'failed'>;
  /** Where a refusal or failure happened. */
  phase?: MutationPhase;
  reason?: string;
  /** The write may have landed despite the failure — reconcile by hand. */
  ambiguous?: boolean;
  preconditionResults: MutationCheckResult[];
  verificationResults: MutationCheckResult[];
}

export interface ApplyMutationInput {
  plan: MutationPlan;
  client: EvoMedisClient;
  /** Distinct operators who approved (two for a `critical` plan). */
  approvedBy: string[];
  emit: MutationEmit;
  reason?: string;
  signal?: AbortSignal;
}

/** Request the client is asked to send for one replayed check or the write. */
interface ResolvedRequest {
  data: Record<string, string>;
  query?: Record<string, string>;
  source: NonNullable<MutationCheckResult['payloadSource']>;
}

/**
 * Keep only the scalar fields of a `payloadSummary`. It is a human-facing digest
 * (`{no_registrasikunjungan, grand_total, baris}`), so this is a weak last
 * resort for *reads* only — never for a write.
 */
function scalarsOf(summary: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

/**
 * Work out what to send for a replayed read.
 *
 * Preference order: the check's own `payload` (the only form that can address a
 * single line item), then the plan's real write body, then the scalar fields of
 * its summary. `payloadSource` is reported on every result so the audit trail
 * shows which was used — a check answered from `payloadSummary` may have been
 * under-addressed and is therefore weaker evidence.
 *
 * `EvoMedisClient` only sends a body on POST, so for a GET read everything moves
 * into the query string.
 */
function resolveRequest(
  endpoint: EndpointDef,
  own: { payload?: Record<string, string>; query?: Record<string, string> },
  plan: MutationPlan,
): ResolvedRequest {
  const [base, source]: [Record<string, string>, ResolvedRequest['source']] = own.payload
    ? [own.payload, 'check']
    : plan.payload
      ? [plan.payload, 'plan']
      : [scalarsOf(plan.payloadSummary), 'payloadSummary'];
  const query = { ...(endpoint.method === 'GET' ? base : {}), ...(own.query ?? {}) };
  return {
    data: base,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    source,
  };
}

/**
 * Re-read one guard and compare it with what the plan expects.
 *
 * Never throws: every failure mode becomes `holds: false` with an `error`, so
 * the caller refuses the write rather than skipping the check.
 */
async function evaluateCheck(
  client: EvoMedisClient,
  plan: MutationPlan,
  check: {
    description: string;
    endpointId: string;
    expected: unknown;
    where?: Record<string, unknown>;
    field?: string;
    match?: MutationCheckResult['match'];
    payload?: Record<string, string>;
    query?: Record<string, string>;
  },
  signal?: AbortSignal,
): Promise<MutationCheckResult> {
  const base: MutationCheckResult = {
    description: check.description,
    endpointId: check.endpointId,
    expected: check.expected,
    holds: false,
  };

  const endpoint = getEndpoint(check.endpointId);
  if (!endpoint) {
    // Unknown endpoint: unverifiable, so the write is refused (control #4).
    return { ...base, error: `unknown endpoint "${check.endpointId}"` };
  }
  if (endpoint.kind !== 'read') {
    // A guard must never itself write. A plan pointing a check at a mutating
    // endpoint is malformed; refuse instead of calling it.
    return { ...base, error: `"${check.endpointId}" is not a read endpoint` };
  }

  const request = resolveRequest(endpoint, check, plan);
  if (Object.keys(request.data).length === 0 && !request.query) {
    // Nothing identifies the record, so any answer would be about the wrong
    // thing (or an empty answer that looks like a pass). Fail closed.
    return { ...base, payloadSource: request.source, error: 'no payload to address the read' };
  }

  let observed: unknown;
  try {
    observed = await client.call<unknown>(check.endpointId, request.data, {
      ...(request.query ? { query: request.query } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    return {
      ...base,
      payloadSource: request.source,
      error: `read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const verdict = evaluateExpectation(
    {
      expected: check.expected,
      ...(check.where ? { where: check.where } : {}),
      ...(check.field ? { field: check.field } : {}),
      ...(check.match ? { match: check.match } : {}),
    },
    observed,
  );
  return {
    ...base,
    payloadSource: request.source,
    holds: verdict.holds,
    match: verdict.match,
    observed: verdict.observed,
    reason: verdict.reason,
  };
}

/**
 * Did the backend acknowledge the write? Ported from `_write_result_is_success`
 * (ranap_v3.py:1241) plus `_confirm_verifikasi_state`'s `response_ok` check
 * (15371): an empty body is an acknowledgement (the legacy controllers answer
 * writes with nothing), a JSON `status` field is honoured when present, and an
 * error page or an unexpected notice is a failure.
 *
 * This is not the read-after-write check — it only says the request was not
 * rejected outright. Confirmation is the `VerificationRule`s' job.
 */
export function writeAcknowledged(response: unknown, endpointId = ''): { ok: boolean; reason: string } {
  if (looksLikeBackendError(response)) {
    // Keep what the page says: the bare label left a live tampung bayar refusal undiagnosable.
    const text = typeof response === 'string' ? response : JSON.stringify(response);
    return { ok: false, reason: `write answered with a backend error page — ${describeResponse(text ?? '')}` };
  }
  if (typeof response === 'string') {
    // The backend sometimes JSON-encodes its notice (`"Transfer sukses"` with quotes).
    const cleaned = response.trim().replace(/^"(.*)"$/s, '$1').trim();
    if (cleaned === '') return { ok: true, reason: 'empty acknowledgement' };
    if (['1', 'OK', 'TRUE', 'DRY_RUN', 'SUCCESS'].includes(cleaned.toUpperCase())) {
      return { ok: true, reason: `acknowledged "${cleaned}"` };
    }
    // ranap_v3.py:6403 — transfer endpoints succeed when the notice contains it.
    if (/transfer sukses/i.test(cleaned)) return { ok: true, reason: `acknowledged "${cleaned}"` };
    // tambah_tindakan_polis answers the new urut_tindakan (live 2026-10-15: "43").
    if (endpointId === 'penatajasaInap.tambahTindakanPolis' && /^\d+$/.test(cleaned)) {
      return { ok: true, reason: `added as urut_tindakan ${cleaned}` };
    }
    return { ok: false, reason: `write answered "${cleaned.slice(0, 200)}"` };
  }
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    if ('status' in record) {
      const status = record.status;
      const ok = status === true || status === 1 || String(status).trim().toLowerCase() === 'true' || String(status).trim() === '1';
      return ok
        ? { ok: true, reason: 'status field is true' }
        : { ok: false, reason: `write reported status=${String(status)}` };
    }
  }
  // No signal either way — the read-after-write rules decide.
  return { ok: true, reason: 'no failure signal in the response' };
}

/** Preconditions as checks; the shape the evaluator wants. */
function asCheck(precondition: Precondition): Parameters<typeof evaluateCheck>[2] {
  return {
    description: precondition.description,
    endpointId: precondition.check,
    expected: precondition.expected,
    ...(precondition.where ? { where: precondition.where } : {}),
    ...(precondition.field ? { field: precondition.field } : {}),
    ...(precondition.match ? { match: precondition.match } : {}),
    ...(precondition.payload ? { payload: precondition.payload } : {}),
    ...(precondition.query ? { query: precondition.query } : {}),
  };
}

function asRuleCheck(rule: VerificationRule): Parameters<typeof evaluateCheck>[2] {
  return {
    description: rule.description,
    endpointId: rule.endpointId,
    expected: rule.expected,
    ...(rule.where ? { where: rule.where } : {}),
    field: rule.field,
    ...(rule.match ? { match: rule.match } : {}),
    ...(rule.payload ? { payload: rule.payload } : {}),
    ...(rule.query ? { query: rule.query } : {}),
  };
}

/** One-line digest of the checks that did not hold. */
function failureDetail(results: readonly MutationCheckResult[]): string {
  return results
    .filter((result) => !result.holds)
    .map((result) => `${result.endpointId}: ${result.error ?? result.reason ?? 'did not hold'}`)
    .join(' | ');
}

/**
 * Apply an approved mutation, with both halves of control #4 enforced.
 *
 * Emits `mutation.approved`, then exactly one of `mutation.invalidated`
 * (refused, nothing written), `mutation.failed` (write rejected, or written but
 * unconfirmed) or `mutation.verified` (written and confirmed). `mutation.applied`
 * is emitted the moment the write is acknowledged, before verification, so the
 * audit trail records the write even if the confirming read then fails.
 */
export async function applyApprovedMutation(
  input: ApplyMutationInput,
): Promise<MutationApplyResult> {
  const { plan, client, approvedBy, emit, signal } = input;
  const identity = {
    planId: plan.id,
    endpointId: plan.endpointId,
    ...(plan.riskLevel ? { riskLevel: plan.riskLevel } : {}),
    ...(plan.idempotencyKey ? { idempotencyKey: plan.idempotencyKey } : {}),
  } satisfies MutationEventData;

  emit({
    type: 'mutation.approved',
    message: `${endpointLabel(plan.endpointId)} disetujui oleh ${approvedBy.join(', ')}`,
    data: {
      ...identity,
      status: 'approved',
      approvedBy: [...approvedBy],
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });

  const refuse = (
    reason: string,
    phase: MutationPhase,
    preconditionResults: MutationCheckResult[] = [],
  ): MutationApplyResult => {
    emit({
      type: 'mutation.invalidated',
      severity: 'error',
      message: `${endpointLabel(plan.endpointId)} tidak dijalankan — ${reason}`,
      data: { ...identity, status: 'invalidated', phase, reason, preconditionResults },
    });
    return {
      planId: plan.id,
      endpointId: plan.endpointId,
      status: 'invalidated',
      phase,
      reason,
      preconditionResults,
      verificationResults: [],
    };
  };

  // ── Is this plan executable at all? ───────────────────────────────
  const endpoint = getEndpoint(plan.endpointId);
  if (!endpoint) return refuse(`unknown endpoint "${plan.endpointId}"`, 'write');
  if (endpoint.kind !== 'mutate') {
    return refuse(`"${plan.endpointId}" is not a mutating endpoint`, 'write');
  }
  const writeBody = plan.payload;
  if (!writeBody || Object.keys(writeBody).length === 0) {
    // `payloadSummary` is a digest, not a request body — sending it would write
    // the wrong thing. A plan without an explicit `payload` is review-only.
    return refuse('plan carries no executable payload (payload is required to write)', 'write');
  }

  // ── 1. Read-before-write: replay every precondition, now ──────────
  const preconditionResults: MutationCheckResult[] = [];
  for (const precondition of plan.preconditions) {
    preconditionResults.push(await evaluateCheck(client, plan, asCheck(precondition), signal));
  }
  if (preconditionResults.some((result) => !result.holds)) {
    return refuse(
      `precondition no longer holds — ${failureDetail(preconditionResults)}`,
      'precondition',
      preconditionResults,
    );
  }

  // ── 2. The write itself ───────────────────────────────────────────
  // Still routed through the client, so the preview block (#1), the allowlist
  // (#3) and the approval requirement (#2) all apply exactly as before.
  let response: unknown;
  try {
    response = await client.call<unknown>(plan.endpointId, writeBody, {
      approval: { approved: true, approver: approvedBy.join(', ') },
      ...(plan.query ? { query: plan.query } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // A transport error is ambiguous: the write may have landed even though no
    // response came back. Flag it for manual reconciliation.
    const ambiguous = err instanceof TransportError;
    emit({
      type: 'mutation.failed',
      severity: 'error',
      message: `${endpointLabel(plan.endpointId)} tidak diterapkan — ${reason}`,
      data: {
        ...identity,
        status: 'failed',
        phase: 'write',
        reason,
        ambiguous,
        preconditionResults,
      },
    });
    return {
      planId: plan.id,
      endpointId: plan.endpointId,
      status: 'failed',
      phase: 'write',
      reason,
      ambiguous,
      preconditionResults,
      verificationResults: [],
    };
  }

  const acknowledgement = writeAcknowledged(response, plan.endpointId);
  if (!acknowledgement.ok) {
    emit({
      type: 'mutation.failed',
      severity: 'error',
      message: `${endpointLabel(plan.endpointId)} ditolak SIMRS — ${acknowledgement.reason}`,
      data: {
        ...identity,
        status: 'failed',
        phase: 'write',
        reason: acknowledgement.reason,
        preconditionResults,
      },
    });
    return {
      planId: plan.id,
      endpointId: plan.endpointId,
      status: 'failed',
      phase: 'write',
      reason: acknowledgement.reason,
      preconditionResults,
      verificationResults: [],
    };
  }

  emit({
    type: 'mutation.applied',
    message: `${endpointLabel(plan.endpointId)} diterapkan ke SIMRS (${acknowledgement.reason})`,
    data: { ...identity, status: 'applied', phase: 'write', preconditionResults },
  });

  // ── 3. Read-after-write: every declared rule must hold ────────────
  const rules = verificationRulesOf(plan);
  const verificationResults: MutationCheckResult[] = [];
  for (const rule of rules) {
    verificationResults.push(await evaluateCheck(client, plan, asRuleCheck(rule), signal));
  }

  if (rules.length === 0) {
    // Nothing to confirm with. The write stays `applied`, never `verified` —
    // that distinction is the point, so a summary step can tell them apart.
    const reason = 'no read-after-write rule declared — write applied but unconfirmed';
    emit({
      type: 'log.appended',
      severity: 'warn',
      message: `${endpointLabel(plan.endpointId)}: ${reason}`,
      data: { ...identity, status: 'applied', phase: 'verify', reason },
    });
    return {
      planId: plan.id,
      endpointId: plan.endpointId,
      status: 'applied',
      phase: 'verify',
      reason,
      preconditionResults,
      verificationResults,
    };
  }

  if (verificationResults.some((result) => !result.holds)) {
    const reason = `read-after-write mismatch — ${failureDetail(verificationResults)}`;
    emit({
      type: 'mutation.failed',
      severity: 'error',
      // Loud on purpose: the write was accepted but the state does not read
      // back as expected, so it may have half-landed.
      message: `${endpointLabel(plan.endpointId)} sudah ditulis tetapi BELUM terverifikasi — cek manual di SIMRS: ${reason}`,
      data: {
        ...identity,
        status: 'failed',
        phase: 'verify',
        reason,
        ambiguous: true,
        preconditionResults,
        verificationResults,
      },
    });
    return {
      planId: plan.id,
      endpointId: plan.endpointId,
      status: 'failed',
      phase: 'verify',
      reason,
      ambiguous: true,
      preconditionResults,
      verificationResults,
    };
  }

  emit({
    type: 'mutation.verified',
    message: `${endpointLabel(plan.endpointId)} terverifikasi (${rules.length} cek ulang)`,
    data: { ...identity, status: 'verified', phase: 'verify', preconditionResults, verificationResults },
  });
  return {
    planId: plan.id,
    endpointId: plan.endpointId,
    status: 'verified',
    preconditionResults,
    verificationResults,
  };
}
