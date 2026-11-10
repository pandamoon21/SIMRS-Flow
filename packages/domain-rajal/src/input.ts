/**
 * Rajal run input: the Setup form's draft → a validated {@link RajalInput} plus
 * the per-run node switches. Pure and light (no executor code), served through
 * the `@simrs-flow/domain-rajal/contract` subpath so the UI renders the form
 * while the domain owns what a valid outpatient batch is.
 *
 * Two mutually exclusive ways to name a batch, mirroring `rajal_v23.js`: a
 * typed No. RM list, or auto-fetch (`doFetch`, source line 1451) which reads
 * the unpaid-bill report for a period. The batch size is not knowable before
 * the run, so the guardrail is the optional `maxPatients` cap (empty = no
 * limit), named in the summary.
 */

import { isIsoDate, optionalPositiveInteger, splitList, type RunInputResult } from '@simrs-flow/workflow-core';
import type { RajalInput } from './executors.js';
import {
  normalizeRajalPaymentConfig,
  RAJAL_INSTALASI_OPTIONS,
  RAJAL_TREATMENT_TEMPLATES,
  type RajalTreatmentGroup,
} from './legacyConfig.js';
import { RAJAL_NODE } from './nodes.js';

/** One treatment line in the rajal editors; unticked lines are kept but ignored. */
export interface TreatmentRow {
  enabled: boolean;
  name: string;
  /** Group letter, only read when the required list is in `group` logic. */
  group: string;
}

/**
 * How the required list combines: `or` = any one line is enough, `and` = every
 * line must be billed, `group` = legacy letters (same letter OR, different AND).
 */
export type RequiredLogic = 'or' | 'and' | 'group';

/** `list` = the operator types No. RM; `discover` = legacy auto-fetch. */
export type RajalBatchMode = 'list' | 'discover';

export interface RajalDraft {
  /** Absent means `list`, so an older caller keeps the typed-list behaviour. */
  mode?: RajalBatchMode;
  patientIds: string;
  clinics: string;
  date: string;
  acceptedPenjaminKeywords: string;
  tindakanIncludeKeywords: string;
  tindakanExcludeKeywords: string;
  tindakanMinCount: string;
  paymentShift?: string;
  paymentType?: string;
  paymentPayerCode?: string;
  /** Auto-fetch fields; only read when `mode === 'discover'`. */
  discoverInstalasi?: string;
  discoverFrom?: string;
  discoverTo?: string;
  discoverPenjamin?: string;
  discoverUnit?: string;
  discoverMaxPatients?: string;
  /** List mode: end of the visit range; set by "Ambil dari laporan". Absent = single `date`. */
  dateTo?: string;
  /** List-mode fetch scope: every poli in the report, or only the selected chips. */
  fetchScope?: 'all' | 'selected';
  /**
   * The legacy treatment template the operator picked, kept as a group id.
   * Present only while the textareas still hold exactly the template's rows:
   * editing them by hand clears it so a stale AND/OR grouping is never applied.
   */
  treatmentTemplateId?: string;
  /** Row editors; when present they replace the free-text keyword fields above. */
  requiredRows?: TreatmentRow[];
  requiredLogic?: RequiredLogic;
  skipRows?: TreatmentRow[];
  /** Legacy `sepCheckRequired`; absent/true = validate SEP. */
  sepCheckRequired?: boolean;
  /** Absent/true = plan `simpan verifikasi` for unverified visits; false drops them instead. */
  enableVerifikasi?: boolean;
  /** Absent/true = plan tampung bayar (the workflow's purpose); false = checks only. */
  enableTampungBayar?: boolean;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'tindakan';

/** Required-treatment rows → the executor's AND/OR groups (unticked/blank rows dropped). */
export function treatmentGroupsFromRows(rows: readonly TreatmentRow[], logic: RequiredLogic): RajalTreatmentGroup[] {
  const used = new Set<string>();
  return rows
    .filter((row) => row.enabled && row.name.trim())
    .map((row, i) => {
      let key = slug(row.name);
      while (used.has(key)) key = `${key}_${i + 1}`;
      used.add(key);
      const group = logic === 'or' ? 'A' : logic === 'and' ? LETTERS[i % LETTERS.length]! : (row.group.trim().toUpperCase() || 'A');
      return { group, key, name: row.name.trim() };
    });
}

/** `A|registration|PENDAFTARAN PASIEN` rows of a legacy template → groups. */
export function templateRowsToGroups(rows: readonly string[]): RajalTreatmentGroup[] {
  return rows
    .map((row) => {
      const [group, key, name] = row.split('|');
      return group && key && name ? { group, key, name } : undefined;
    })
    .filter((entry): entry is RajalTreatmentGroup => entry !== undefined);
}

/** The shared advanced-filter half of both outpatient modes. */
function rajalTindakanFilters(draft: RajalDraft) {
  const acceptedPenjaminKeywords = splitList(draft.acceptedPenjaminKeywords);
  const rowNames = (rows: readonly TreatmentRow[]) => rows.filter((row) => row.enabled && row.name.trim()).map((row) => row.name.trim());
  const tindakanIncludeKeywords = draft.requiredRows ? rowNames(draft.requiredRows) : splitList(draft.tindakanIncludeKeywords);
  const tindakanExcludeKeywords = draft.skipRows ? rowNames(draft.skipRows) : splitList(draft.tindakanExcludeKeywords);
  const template = draft.requiredRows ? undefined : RAJAL_TREATMENT_TEMPLATES.find((item) => item.id === draft.treatmentTemplateId);
  const rowGroups = draft.requiredRows ? treatmentGroupsFromRows(draft.requiredRows, draft.requiredLogic ?? 'or') : [];
  const paymentConfig = normalizeRajalPaymentConfig({
    shift: draft.paymentShift,
    type: draft.paymentType,
    payerCode: draft.paymentPayerCode,
  });
  return {
    acceptedPenjaminKeywords: acceptedPenjaminKeywords.length ? acceptedPenjaminKeywords : undefined,
    tindakanIncludeKeywords: tindakanIncludeKeywords.length ? tindakanIncludeKeywords : undefined,
    tindakanExcludeKeywords: tindakanExcludeKeywords.length ? tindakanExcludeKeywords : undefined,
    tindakanMinCount: optionalPositiveInteger(draft.tindakanMinCount),
    // The template's own rows carry the legacy AND/OR semantics; the free-text
    // keyword lists above are only a coarse include/exclude. Emitting the
    // template as `treatmentGroups` is what actually enforces "Pendaftaran AND
    // Obat" instead of "Pendaftaran OR Obat".
    ...(template ? { treatmentGroups: templateRowsToGroups(template.rows) } : {}),
    ...(rowGroups.length ? { treatmentGroups: rowGroups } : {}),
    ...(tindakanExcludeKeywords.length ? { skipTreatments: tindakanExcludeKeywords } : {}),
    ...(draft.sepCheckRequired === false ? { sepCheckRequired: false } : {}),
    ...(draft.enableVerifikasi === false ? { enableVerifikasi: false } : {}),
    ...(draft.enableTampungBayar === false ? { enableTampungBayar: false } : {}),
    paymentConfig,
  };
}

/** Optional discovery cap; empty or invalid = no limit. */
export function rajalMaxPatients(value: string | undefined): number | undefined {
  return optionalPositiveInteger(value ?? '');
}

/**
 * Legacy `doFetch` (source line 1451) as run input: no `patientIds`, a period
 * and the report filters instead. `date` carries the period start because the
 * rest of the pipeline still uses it as a per-record fallback; the effective
 * range comes from `discovery.from`/`.to`, which is what legacy's `autosaveCfg`
 * copies onto `dateFrom`/`dateTo` (source line 413).
 */
function buildRajalDiscoveryInput(draft: RajalDraft, enabled: Record<string, boolean>): RunInputResult<RajalInput> {
  const from = (draft.discoverFrom ?? '').trim();
  const to = (draft.discoverTo ?? '').trim();
  const maxPatients = rajalMaxPatients(draft.discoverMaxPatients);
  if (!isIsoDate(from) || !isIsoDate(to)) {
    return { error: 'Periode cari otomatis wajib diisi dengan format valid.', summary: 'Rajal cari otomatis belum lengkap', enabled };
  }
  if (from > to) {
    return { error: 'Periode cari otomatis terbalik: tanggal awal melewati tanggal akhir.', summary: 'Rajal cari otomatis belum lengkap', enabled };
  }

  const instalasi = (draft.discoverInstalasi ?? '').trim() || RAJAL_INSTALASI_OPTIONS[0].code;
  const penjamin = (draft.discoverPenjamin ?? '').trim();
  const unit = (draft.discoverUnit ?? '').trim();
  const clinics = splitList(draft.clinics);
  const input: RajalInput = {
    ...(clinics.length ? { clinics } : {}),
    date: from,
    discovery: {
      instalasi,
      from,
      to,
      ...(penjamin ? { penjamin } : {}),
      ...(unit ? { unit } : {}),
      ...(maxPatients ? { maxPatients } : {}),
    },
    ...rajalTindakanFilters(draft),
  };

  const instalasiLabel = RAJAL_INSTALASI_OPTIONS.find((option) => option.code === instalasi)?.label ?? instalasi;
  const scope = [
    instalasiLabel,
    ...(penjamin ? [`penjamin "${penjamin}"`] : []),
    ...(unit ? [`unit "${unit}"`] : []),
    clinics.length ? `${clinics.length} poli dipilih` : 'poli dari laporan',
  ].join(', ');
  return {
    input,
    enabled,
    summary: `Rajal cari otomatis ${from} → ${to} · ${scope}${maxPatients ? ` · maks ${maxPatients} pasien` : ''}`,
  };
}

function buildRajalListInput(draft: RajalDraft, enabled: Record<string, boolean>): RunInputResult<RajalInput> {
  const patientIds = splitList(draft.patientIds);
  const clinics = splitList(draft.clinics);
  if (patientIds.length === 0) {
    return { error: 'Minimal satu No. RM wajib diisi untuk rawat jalan.', summary: 'Rajal belum lengkap', enabled };
  }
  if (clinics.length === 0) {
    return { error: 'Minimal satu poli wajib diisi untuk rawat jalan.', summary: `${patientIds.length} pasien`, enabled };
  }
  if (!isIsoDate(draft.date)) {
    return { error: 'Tanggal rawat jalan wajib diisi dengan format valid.', summary: `${patientIds.length} pasien`, enabled };
  }
  const dateTo = (draft.dateTo ?? '').trim();
  if (dateTo && (!isIsoDate(dateTo) || dateTo < draft.date)) {
    return { error: 'Tanggal sampai harus valid dan tidak sebelum tanggal awal.', summary: `${patientIds.length} pasien`, enabled };
  }
  const range = dateTo && dateTo > draft.date;

  const input: RajalInput = {
    patientIds,
    clinics,
    date: draft.date,
    // Legacy `doFetch` carries the report period as the visit range (source line 413).
    ...(range ? { dateFrom: draft.date, dateTo } : {}),
    ...rajalTindakanFilters(draft),
  };
  // The mode is named in the badge so it can never be confused with the
  // discovered batch, which reaches a very different scale.
  return {
    input,
    enabled,
    summary: `Rajal daftar No. RM · ${patientIds.length} pasien, ${clinics.length} poli @ ${draft.date}${range ? ` → ${dateTo}` : ''}`,
  };
}

/** The draft as run input; `enabled` carries the Setup node switches (penunjang checks, berkas notice). */
export function buildRajalInput(draft: RajalDraft, enabled: Record<string, boolean> = {}): RunInputResult<RajalInput> {
  const result = draft.mode === 'discover' ? buildRajalDiscoveryInput(draft, enabled) : buildRajalListInput(draft, enabled);
  if (!result.input) return result;
  const tags = [
    draft.enableVerifikasi === false ? 'tanpa verifikasi' : '',
    draft.enableTampungBayar === false ? 'tanpa tampung bayar' : '',
    enabled[RAJAL_NODE.checkBerkas] ? 'cek berkas' : '',
  ].filter(Boolean);
  return tags.length ? { ...result, summary: `${result.summary} · ${tags.join(' · ')}` } : result;
}
