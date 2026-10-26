import type { Evidence, NodeStatus, RunState } from '@simrs-flow/workflow-core';
import { CARD_HEIGHT } from './phaseLayout.js';

/**
 * Pure Rajal MULAI recap: projects the per-poli queue summary from the
 * `rajal.clinic-counts` evidence the filter executor emits. Layout lives in
 * `phaseLayout.ts`; labels, phases and descriptions live on the definition.
 */

export interface RajalClinicCount {
  clinic: string;
  patientCount: number;
}

export interface RajalClinicCounts {
  complete: boolean;
  totalClinics: number;
  totalPatients: number;
  clinics: readonly RajalClinicCount[];
}

export interface RajalRecap {
  clinicCounts?: RajalClinicCounts;
  clinicCountsState: 'waiting' | 'unavailable' | 'ready';
  /** Selected clinics, shown while the filter has not produced counts yet. */
  clinics: readonly string[];
  /** Result count currently known for the queue (typed input or start_batch). */
  queuePatients?: number;
}

/** A filter at one of these statuses will not emit further evidence. */
const TERMINAL_STATUSES = new Set<NodeStatus>(['success', 'skipped', 'failed', 'blocked', 'needs_review']);
const COUNT_EVIDENCE_LABEL = 'rajal.clinic-counts';
const COUNT_EVIDENCE_SOURCE = 'filter_records';

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate the latest `rajal.clinic-counts` evidence. A newer invalid record
 * means "no data" — never fall back to an older one. The cross-checks accept
 * every-zero as valid and reject figures that cannot describe unique patients.
 */
export function readRajalClinicCounts(evidence: readonly Evidence[]): RajalClinicCounts | undefined {
  let candidate: Evidence | undefined;
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    if (evidence[index]?.label === COUNT_EVIDENCE_LABEL) {
      candidate = evidence[index];
      break;
    }
  }
  if (!candidate || candidate.source !== COUNT_EVIDENCE_SOURCE) return undefined;
  const data = candidate.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  if (record.basis !== 'matched-visits' || typeof record.complete !== 'boolean') return undefined;
  if (!isCount(record.totalClinics) || !isCount(record.totalPatients) || !Array.isArray(record.clinics)) return undefined;
  const clinics: RajalClinicCount[] = [];
  const seen = new Set<string>();
  for (const entry of record.clinics) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
    const item = entry as Record<string, unknown>;
    if (typeof item.clinic !== 'string' || !item.clinic.trim() || !isCount(item.patientCount)) return undefined;
    const key = item.clinic.trim().toUpperCase();
    if (seen.has(key)) return undefined;
    seen.add(key);
    clinics.push({ clinic: item.clinic.trim(), patientCount: item.patientCount });
  }
  if (record.totalClinics !== clinics.length) return undefined;
  const maxClinicCount = clinics.reduce((max, clinic) => Math.max(max, clinic.patientCount), 0);
  const sumClinicCounts = clinics.reduce((sum, clinic) => sum + clinic.patientCount, 0);
  if (maxClinicCount > record.totalPatients || record.totalPatients > sumClinicCounts) return undefined;
  return { complete: record.complete, totalClinics: record.totalClinics, totalPatients: record.totalPatients, clinics };
}

/** `ANAK` → `Poli ANAK`; a label already prefixed with POLI is left untouched. */
function clinicPrefix(clinic: string): string {
  return /^poli\s/i.test(clinic) ? clinic : `Poli ${clinic}`;
}

function readLatestEvidence(evidence: readonly Evidence[], label: string): Evidence | undefined {
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    if (evidence[index]?.label === label) return evidence[index];
  }
  return undefined;
}

/** Selected clinic labels, uppercase and deduplicated, order preserved. */
function readSelectedClinics(state: RunState | undefined): readonly string[] {
  const entry = readLatestEvidence(state?.nodes.resolve_clinics?.evidence ?? [], 'rajal.selected-clinics');
  if (!entry || !Array.isArray(entry.data)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const raw of entry.data) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().toUpperCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Queue size reported by start_batch (typed input or discovered batch). */
function readQueuePatients(state: RunState | undefined): number | undefined {
  const entry = readLatestEvidence(state?.nodes.start_batch?.evidence ?? [], 'rajal.batch-count');
  if (!entry || typeof entry.data !== 'object' || entry.data === null || Array.isArray(entry.data)) return undefined;
  const total = (entry.data as Record<string, unknown>).totalPatients;
  return isCount(total) ? total : undefined;
}

/** MULAI recap state, fail-closed: a corrupt newer record never falls back to an older one. */
export function rajalRecapOf(state: RunState | undefined): RajalRecap {
  const clinics = readSelectedClinics(state);
  const queuePatients = readQueuePatients(state);
  const filter = state?.nodes.filter_records;
  const counts = readRajalClinicCounts(filter?.evidence ?? []);
  const known = queuePatients === undefined ? {} : { queuePatients };
  if (counts) return { clinicCounts: counts, clinicCountsState: 'ready', clinics, ...known };
  // A label that exists but failed validation must not fall back to an older
  // record, and a terminal filter without any counts has none coming.
  const hasRaw = (filter?.evidence ?? []).some((item) => item.label === COUNT_EVIDENCE_LABEL);
  if (hasRaw || (filter && TERMINAL_STATUSES.has(filter.status))) {
    return { clinicCountsState: 'unavailable', clinics, ...known };
  }
  return { clinicCountsState: 'waiting', clinics, ...known };
}

/** MULAI card height: title, purpose, one line per poli plus totals, footer. */
export function rajalRecapHeight(recap: RajalRecap): number {
  return recap.clinicCounts ? Math.max(CARD_HEIGHT, 200 + 20 * (recap.clinicCounts.clinics.length + 3)) : CARD_HEIGHT;
}

/**
 * Recap lines for the MULAI card, matching the plan's wording:
 * waiting shows queue size + per-clinic "menunggu pencocokan kunjungan";
 * ready shows exact per-clinic unique counts, with a partial-data caveat.
 */
export function formatRajalClinicCounts(
  counts: RajalClinicCounts | undefined,
  options: { state: 'waiting' | 'unavailable' | 'ready'; clinics?: readonly string[]; queuePatients?: number },
): string[] {
  if (options.state === 'unavailable' || !counts) {
    return options.state === 'unavailable'
      ? ['Rekap poli belum tersedia untuk run ini']
      : [];
  }
  const lines = [
    'Rekap setelah filter kunjungan',
    `Total poli: ${counts.totalClinics} Poli`,
    ...counts.clinics.map((clinic, index) => `${index + 1}. ${clinicPrefix(clinic.clinic)}: ${clinic.patientCount} pasien`),
    counts.complete ? `Total pasien: ${counts.totalPatients} pasien` : `Total pasien terbaca: ${counts.totalPatients} pasien`,
    ...(counts.complete ? ['Pasien lintas poli dihitung sekali pada total.'] : ['Data parsial — sebagian riwayat belum terbaca']),
  ];
  return lines;
}

/** Waiting recap: queue total and every selected poli, none counted yet. */
export function formatRajalQueueWaiting(clinics: readonly string[], queuePatients: number | undefined): string[] {
  const total = queuePatients === undefined ? '—' : `${queuePatients}`;
  return [
    'Rekap setelah filter kunjungan',
    `Total poli: ${clinics.length} Poli`,
    ...clinics.map((clinic, index) => `${index + 1}. ${clinicPrefix(clinic)}: Menunggu pencocokan kunjungan`),
    `Total pasien: ${total} pasien dalam antrean`,
  ];
}
