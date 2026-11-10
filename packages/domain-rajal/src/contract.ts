/**
 * `@simrs-flow/domain-rajal/contract` — what the UI and the orchestrator read
 * about the rajal workflow without loading its executors: run-input building,
 * node ids and facts, evidence readers, the legacy option tables the Setup and
 * Rules pages render, and the wire types they produce. Everything here is pure;
 * nothing imports `executors.ts` except for types.
 */

export { OPT_IN_NODES, rajalWorkflow } from './workflow.js';
export { rajalRuleCatalog } from './ruleCatalog.generated.js';
export { buildRajalInput, rajalMaxPatients, templateRowsToGroups, treatmentGroupsFromRows } from './input.js';
export type { RajalBatchMode, RajalDraft, RequiredLogic, TreatmentRow } from './input.js';
export {
  BERKAS_PROGRESS_KEY,
  RAJAL_NEXT_ACTION,
  RAJAL_NODE,
  RAJAL_PATIENT_OUTCOMES_EVIDENCE,
  RAJAL_PENUNJANG_NODES,
  readBerkasProgress,
  readPatientOutcomes,
} from './nodes.js';
export type { RajalNodeId, RajalPatientOutcome } from './nodes.js';
export {
  normalizeClinicLabel,
  normalizeRajalPaymentConfig,
  resolveRajalClinicMatch,
  RAJAL_CLINIC_MAPPING,
  RAJAL_DEFAULT_PAYMENT_CONFIG,
  RAJAL_DEFAULT_SKIP_TREATMENTS,
  RAJAL_INSTALASI_OPTIONS,
  RAJAL_PAYMENT_TYPE_OPTIONS,
  RAJAL_SHIFT_OPTIONS,
  RAJAL_TREATMENT_TEMPLATES,
} from './legacyConfig.js';
export type { RajalPaymentConfig, RajalTreatmentGroup } from './legacyConfig.js';
export type { RajalDiscoveryInput, RajalInput } from './executors.js';
