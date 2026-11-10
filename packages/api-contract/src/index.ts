/**
 * @simrs-flow/api-contract
 *
 * The orchestrator ↔ UI wire contract: request and response bodies of the REST
 * API. Type-only — this package emits no runtime code — so the UI can import it
 * without pulling server modules into the browser bundle, and a field added on
 * one side fails to compile on the other instead of drifting silently.
 *
 * Domain-owned shapes (run inputs, report rows) are re-exported from the
 * domains' light `/contract` subpaths, which stay their single source.
 */

import type { HistoricalRunStatus } from '@simrs-flow/audit-ledger';
import type { RajalInput, RajalPaymentConfig, RajalTreatmentGroup } from '@simrs-flow/domain-rajal/contract';
import type { RanapDischargeRow, RanapInput } from '@simrs-flow/domain-ranap/contract';
import type { ExecutionMode } from '@simrs-flow/workflow-core';

export type { RanapDischargeRow, RanapInput, RajalInput };

/** Run input of any registered domain, as `POST /api/runs` carries it. */
export type RunInput = RanapInput | RajalInput;

/** `POST /api/runs` body. */
export interface CreateRunRequest {
  workflowId: string;
  mode?: ExecutionMode;
  input?: RunInput;
  /** Per-run node switches (see `RunInputResult.enabled`). */
  enabled?: Record<string, boolean>;
  /** `live` calls the real SIMRS; `fixture` (default) replays canned data. */
  source?: 'fixture' | 'live';
  /** Write runs only: resolve gates and plans without a click. Refused in preview. */
  autoApprove?: boolean;
}

/** One row of `GET /api/runs`. */
export interface RunSummary {
  runId: string;
  workflowId: string;
  workflowVersion: string;
  mode: ExecutionMode;
  status: HistoricalRunStatus;
  startedAt: string;
  finishedAt?: string;
  operator?: string;
  replayable: boolean;
  source: 'memory' | 'ledger';
  reason?: string;
  truncatedTail?: boolean;
  /** Set when an audit-ledger append failed; the trail for this run is incomplete. */
  auditError?: string;
}

/** Rules-page values; the orchestrator (apps/orchestrator/src/rules.ts) validates and owns them. */
export interface RuleValues {
  ranap: {
    /** Unit keywords whose unpaid orders block verification until settled by hand. */
    bankDarahUnits: string[];
    cathlabUnits: string[];
    /** Wards whose IBS mismatch is downgraded to a manual review. */
    ibsManualReviewRooms: string[];
  };
  rajal: {
    /** Same letter is OR, different letters are AND. */
    treatmentGroups: RajalTreatmentGroup[];
    /** Presence anywhere on the bill rejects it. */
    skipTreatments: string[];
    paymentConfig: RajalPaymentConfig;
  };
}

/** `GET/POST /api/rules` body. */
export interface RuleSet {
  /** 0 = built-in legacy defaults, never saved. */
  version: number;
  updatedAt?: string;
  updatedBy?: string;
  values: RuleValues;
}
