/**
 * `@simrs-flow/domain-ranap/contract` — what the UI and the orchestrator read
 * about the ranap workflow without loading its executors: run-input building,
 * node ids and facts, evidence readers, and the wire types they produce.
 * Everything here is pure; nothing imports `executors.ts` except for types.
 */

export { OPT_IN_NODES, ranapWorkflow } from './workflow.js';
export { ranapRuleCatalog } from './ruleCatalog.js';
export { BANK_DARAH_UNIT_KEYWORDS, CATHLAB_UNIT_KEYWORDS } from './logic/blockers.js';
export { IBS_MANUAL_REVIEW_ROOM_TOKEN } from './logic/ibs.js';

export { buildRanapInput, clampToleranceDays, RANAP_VERIFY_OFF } from './input.js';
export type { RanapDraft } from './input.js';
export {
  BERKAS_PROGRESS_KEY,
  RANAP_NEXT_ACTION,
  RANAP_NODE,
  RANAP_TITIPAN_EVIDENCE,
  RANAP_VALID_RM_REASON,
  readBerkasProgress,
  readTitipan,
} from './nodes.js';
export type { RanapNodeId } from './nodes.js';
export { RANAP_REPORT_PENJAMIN_OPTIONS } from './logic/dischargeReport.js';
export type { RanapDischargeRow, RanapReportFlag } from './logic/dischargeReport.js';
export type { RanapInput } from './executors.js';
