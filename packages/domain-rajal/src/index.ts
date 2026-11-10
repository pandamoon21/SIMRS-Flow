/**
 * @simrs-flow/domain-rajal
 *
 * Rawat jalan workflow definition and dry-run executors. Exports only what is
 * used outside the package: the light `./contract` surface (workflow, input
 * building, node facts, option tables) plus the executors, batch discovery and
 * the report/clinic helpers the live-validation script uses. Verdict logic
 * stays internal — import it from `./logic/*` inside the package.
 */

export * from './contract.js';
export { createRajalExecutors, fetchRajalUnpaidBatch } from './executors.js';
export type { RajalDeps, RajalUnpaidBatchArgs } from './executors.js';
export {
  buildRajalUnpaidReportQuery,
  extractRajalClinicFromSection,
  parseRajalUnpaidReport,
  shouldExcludeRajalSection,
} from './unpaidReport.js';
export type { RajalUnpaidBatch } from './unpaidReport.js';
