/**
 * Node facts the UI and the orchestrator read about the rajal workflow: node
 * ids, what the operator does when a run stops at a node, and typed readers for
 * the evidence the executors emit. Pure and light (no executor code), served
 * through the `@simrs-flow/domain-rajal/contract` subpath.
 *
 * `nodes.test.ts` pins {@link RAJAL_NODE} to `rajalWorkflow`, and the evidence
 * label to what `rajal.emitBatchSummary` emits, so a rename fails there and at
 * every compile-time use of the constant.
 */

import { BERKAS_PROGRESS_KEY, readBerkasProgress } from '@simrs-flow/berkas/evaluate';
import type { RajalPatientOutcome } from './executors.js';

export const RAJAL_NODE = {
  loadConfig: 'load_config',
  normalizeIds: 'normalize_ids',
  resolveClinics: 'resolve_clinics',
  startBatch: 'start_batch',
  loadHistory: 'load_history',
  filterRecords: 'filter_records',
  checkRencanaOnko: 'check_rencana_onko',
  validateExitDate: 'validate_exit_date',
  validateTransaction: 'validate_transaction',
  validateTreatment: 'validate_treatment',
  validateRadiology: 'validate_radiology',
  validateElektromedik: 'validate_elektromedik',
  validateLabPa: 'validate_lab_pa',
  validateLab: 'validate_lab',
  checkBerkas: 'check_berkas',
  validateSep: 'validate_sep',
  checkPayment: 'check_payment',
  checkVerification: 'check_verification',
  submitPayment: 'submit_payment',
  confirmResult: 'confirm_result',
  emitPatientSummary: 'emit_patient_summary',
  emitBatchSummary: 'emit_batch_summary',
} as const;

export type RajalNodeId = (typeof RAJAL_NODE)[keyof typeof RAJAL_NODE];

/** The four penunjang checks an operator can switch off per run, in Setup order. */
export const RAJAL_PENUNJANG_NODES: ReadonlyArray<{ id: RajalNodeId; label: string }> = [
  { id: RAJAL_NODE.validateRadiology, label: 'Radiologi' },
  { id: RAJAL_NODE.validateElektromedik, label: 'Elektromedik' },
  { id: RAJAL_NODE.validateLabPa, label: 'Lab PA' },
  { id: RAJAL_NODE.validateLab, label: 'Lab reguler' },
];

/** What the operator does next when a run stops at the node. Unlisted nodes get the UI's generic advice. */
export const RAJAL_NEXT_ACTION: Readonly<Partial<Record<RajalNodeId, string>>> = {
  [RAJAL_NODE.normalizeIds]: 'Perbaiki daftar No RM di Setup, lalu mulai run lagi.',
  [RAJAL_NODE.resolveClinics]: 'Pilih poli yang dikenal di Setup, lalu mulai run lagi.',
  [RAJAL_NODE.loadHistory]: 'Pastikan No RM benar dan pasien punya kunjungan rawat jalan pada tanggal itu.',
  [RAJAL_NODE.validateExitDate]: 'Isi tanggal keluar kunjungan di menu Poliklinik SIMRS, lalu jalankan ulang.',
  [RAJAL_NODE.checkVerification]: 'Selesaikan order yang belum terlayani / belum ditransfer di SIMRS, lalu jalankan ulang.',
};

/** Evidence label `emit_batch_summary` carries the per-patient outcome rows under. */
export const RAJAL_PATIENT_OUTCOMES_EVIDENCE = 'rajal.patient-outcomes';

/**
 * The per-patient outcome rows from a node's (or event's) evidence list, or
 * undefined when the list carries none.
 */
export function readPatientOutcomes(
  evidence: ReadonlyArray<{ label?: string; data?: unknown }> | undefined,
): RajalPatientOutcome[] | undefined {
  const found = evidence?.find((item) => item.label === RAJAL_PATIENT_OUTCOMES_EVIDENCE);
  const rows = (found?.data as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as RajalPatientOutcome[]) : undefined;
}

export type { RajalPatientOutcome };
export { BERKAS_PROGRESS_KEY, readBerkasProgress };
