/**
 * Per-run state the rajal steps hand to each other.
 *
 * The runner gives every node the same `ctx.scratch` bag. This module is the
 * one place that names its rajal keys and their types, so a step reads
 * `rajalState(ctx).matching` instead of a cast string key, and a typo or a
 * wrong element type is a compile error. The keys are unchanged from the
 * string-keyed version (scratch is in-memory only, but keeping them stable
 * keeps debugging output comparable).
 *
 * Who writes what, in run order:
 *  - `load_config` → `config`; `normalize_ids` → `ids`, `discovery`,
 *    `clinicsByPatientId`; `resolve_clinics` → `clinics` (and prunes `ids`);
 *    `start_batch` → `batchTotal`.
 *  - `load_history` → `history`, `historyUnreadableCount`;
 *    `filter_records` → `matching`, `batchRecords`.
 *  - `validate_transaction` → `transactions`; `validate_treatment` →
 *    `treatments`, `rajalConsultByTrx`; `check_payment` → `payable`;
 *    `check_verification` → `verificationPlanByTrx`; `submit_payment` →
 *    `paymentPlanIds`.
 *  - Any step that drops a visit prunes `matching`/`transactions`/`treatments`/
 *    `payable` together ({@link pruneRajalRecords} in executors.ts) and stamps
 *    `droppedAt`; `patientNotes` explains a patient that never reached the batch;
 *    the checklist wrapper sets `currentStep` before each executor.
 */
import type { ExecutorContext } from '@simrs-flow/workflow-core';
import type { RajalUnpaidBatch } from './unpaidReport.js';
import type {
  RajalBatchRecord,
  RajalConsultKind,
  RajalInput,
  RajalPaymentState,
  RajalRecordRow,
  RajalTransactionState,
  RajalTreatmentState,
} from './types.js';

export interface RajalRunState {
  /** The run input with defaults applied (`load_config`). */
  config: RajalInput;
  /** Normalised, de-duplicated medrecs in the queue. */
  ids: string[];
  /** The unpaid-bill report batch, on a discovery run. */
  discovery: RajalUnpaidBatch;
  /** Discovery: medrec → report sections it appeared under. */
  clinicsByPatientId: Record<string, string[]>;
  /** The clinics this run bills. */
  clinics: string[];
  batchTotal: number;
  /** Every history row read, stamped with its `patientId`. */
  history: RajalRecordRow[];
  historyUnreadableCount: number;
  /** Visits still in play; every guard narrows it. */
  matching: RajalRecordRow[];
  batchRecords: RajalBatchRecord[];
  transactions: RajalTransactionState[];
  treatments: RajalTreatmentState[];
  rajalConsultByTrx: Record<string, RajalConsultKind>;
  payable: RajalPaymentState[];
  /** `simpan_verifikasi` plan id per transaction (second-pass barrier). */
  verificationPlanByTrx: Record<string, string>;
  paymentPlanIds: string[];
  /** Transaction → node id of the step that dropped it. */
  droppedAt: Record<string, string>;
  /** Patient → why it never reached the batch. */
  patientNotes: Record<string, string>;
  /** Node id of the executor running now (set by the checklist wrapper). */
  currentStep: string;
}

/** The run's rajal state: a typed view over `ctx.scratch` — reads and writes go straight through. */
export function rajalState(ctx: ExecutorContext): Partial<RajalRunState> {
  return ctx.scratch as Partial<RajalRunState>;
}
