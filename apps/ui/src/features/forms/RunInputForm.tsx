/**
 * RunInputForm — operator-facing inputs for workflow runs.
 *
 * The backend/domain executors remain the source of truth for validation. This
 * form provides a first usability layer so live runs no longer depend on a
 * hardcoded demo MR/date.
 *
 * The inpatient advanced block exposes the four `ranap_v3.py` `main()` switches
 * an operator legitimately needs per run: `debug_mode` (reveals the no reg /
 * no trx / SEP-source columns and the gizi preflight), `skip_verifikasi_sep`,
 * `enable_tampung_bayar`, and `user_proses` for the summary row.
 *
 * The outpatient side has two mutually exclusive ways to name a batch, mirroring
 * `rajal_v23.js`: a typed No. RM list, or auto-fetch (`doFetch`, source line
 * 1451) which reads the unpaid-bill report for a period and discovers the list.
 * They are a radio pair, not a fallback, and the inactive one's fields are not
 * rendered at all — an operator must never believe they typed a list and get a
 * two-hundred-patient batch. The batch size is not knowable before the run
 * (only the orchestrator can read the report), so the guardrail is the
 * optional `maxPatients` cap (empty = no limit), named in the summary badge.
 */

import { useEffect, useMemo, useState } from 'react';
import type { RanapInput } from '@simrs-flow/domain-ranap';
import {
  normalizeClinicLabel,
  normalizeRajalPaymentConfig,
  RAJAL_CLINIC_MAPPING,
  RAJAL_DEFAULT_PAYMENT_CONFIG,
  RAJAL_DEFAULT_SKIP_TREATMENTS,
  RAJAL_INSTALASI_OPTIONS,
  RAJAL_PAYMENT_TYPE_OPTIONS,
  RAJAL_SHIFT_OPTIONS,
  RAJAL_TREATMENT_TEMPLATES,
  resolveRajalClinicMatch,
} from '@simrs-flow/domain-rajal';
import { RANAP_REPORT_PENJAMIN_OPTIONS, type RanapReportFlag } from '@simrs-flow/domain-ranap';
import type { RajalInput, RajalTreatmentGroup } from '@simrs-flow/domain-rajal';
import { Alert, Badge, Button, Card, CardBody, CardHeader, FormCheck, FormInput, FormLabel, FormSelect, FormTextarea } from '../../ui/primitives.js';
import { api, type RanapDischargeRow } from '../../api/client.js';
import { Icon } from '../../ui/icons.js';

export type RunInputDomain = 'ranap' | 'rajal';
export type RunInput = RanapInput | RajalInput;

export interface RunInputResult {
  input?: RunInput;
  enabled?: Record<string, boolean>;
  error?: string;
  summary: string;
}

interface RunInputFormProps {
  domain: RunInputDomain;
  source: 'offline' | 'live';
  onInputChange: (result: RunInputResult) => void;
  /**
   * Another run is on screen. This form only prepares the NEXT run, so its
   * "No. RM wajib diisi" check must not read as an error of the viewed run.
   */
  viewingRunId?: string;
}

interface RanapDraft {
  noRm: string;
  tanggal: string;
  toleranceDays: string;
  acceptedPenjaminKeywords: string;
  /** Optional run switches; absent means the legacy default (all off). */
  debugMode?: boolean;
  skipVerifikasiSep?: boolean;
  /** Absent/true = verify (legacy default). False runs the checks only: no gate, verification, payment. */
  enableVerifikasi?: boolean;
  enableTampungBayar?: boolean;
  /** Opt-in Kelengkapan Berkas notice (downloads and reads the e-klaim bundle). */
  cekBerkas?: boolean;
  userProses?: string;
}

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

interface RajalDraft {
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

const ACCEPTED_PENJAMIN_TEXT = 'BPJS PBI, BPJS NON PBI';
/*
 * The poli dropdown offers each *distinct* clinic once. The mapping carries
 * aliases that normalize to the same clinic — e.g. "POLI DALAM, GINJAL DAN
 * HIPERTENSI" and "DALAM, GINJAL DAN HIPERTENSI" (the matcher strips "POLI ").
 * Offering both lets the operator pick two chips for one clinic, which makes
 * the unit matcher tie 3000-3000 and drop the record as ambiguous. Keep the
 * first (canonical) spelling per normalized clinic.
 */
const LEGACY_CLINICS = [
  ...new Map(
    Object.keys(RAJAL_CLINIC_MAPPING).map((key) => [normalizeClinicLabel(key), key] as const),
  ).values(),
].sort();
const RAJAL_FILTER_KEY = 'simrs-flow.rajal.filters.v1';
const DEFAULT_RAJAL_REQUIRED_TREATMENTS = 'PENDAFTARAN PASIEN\nBIAYA OBAT';

const RAJAL_PENUNJANG = [
  { id: 'validate_radiology', label: 'Radiologi' },
  { id: 'validate_elektromedik', label: 'Elektromedik' },
  { id: 'validate_lab_pa', label: 'Lab PA' },
  { id: 'validate_lab', label: 'Lab reguler' },
];

function todayIso(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function splitList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function clampToleranceDays(value: string): number {
  if (!value.trim()) return 3;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(Math.max(Math.trunc(parsed), 0), 14);
}

function optionalPositiveInteger(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function currentCommaToken(value: string): string {
  const lastComma = value.lastIndexOf(',');
  return (lastComma >= 0 ? value.slice(lastComma + 1) : value).trim();
}

function replaceCurrentCommaToken(value: string, nextToken: string): string {
  const lastComma = value.lastIndexOf(',');
  if (lastComma < 0) return nextToken;
  const prefix = value.slice(0, lastComma + 1).trimEnd();
  return `${prefix} ${nextToken}`;
}

/**
 * Clinic options matching the text being typed, minus the ones already picked.
 *
 * Only *committed* tokens (everything before the last comma) mark an option as
 * already-selected. The token being typed is the search query, not a selection
 * — counting it hid the very option the operator was finishing typing (e.g.
 * typing "DALAM" made "DALAM" vanish from the suggestions).
 */
/** Static clinics plus live report headings, one per normalized clinic (static spelling wins). */
export function mergeClinicOptions(base: readonly string[], live: readonly string[]): string[] {
  const byLabel = new Map(base.map((clinic) => [normalizeClinicLabel(clinic), clinic] as const));
  for (const clinic of live) {
    const label = normalizeClinicLabel(clinic);
    if (label && !byLabel.has(label)) byLabel.set(label, clinic.trim());
  }
  return [...byLabel.values()].sort();
}

export function filterClinicOptions(options: readonly string[], text: string): string[] {
  const token = currentCommaToken(text).toUpperCase();
  const committed = splitList(text.slice(0, Math.max(text.lastIndexOf(','), 0)));
  const selected = new Set(committed.map((c) => c.toUpperCase()));
  return options.filter((clinic) => {
    const normalized = clinic.toUpperCase();
    return !selected.has(normalized) && (!token || normalized.includes(token));
  });
}

function openNativePicker(input: HTMLInputElement): void {
  input.showPicker?.();
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

const linesToRows = (text: string, group = 'A'): TreatmentRow[] => splitList(text).map((name) => ({ enabled: true, name, group }));

/** `A|registration|PENDAFTARAN PASIEN` rows of a legacy template → groups. */
function templateRowsToGroups(rows: readonly string[]): RajalTreatmentGroup[] {
  return rows
    .map((row) => {
      const [group, key, name] = row.split('|');
      return group && key && name ? { group, key, name } : undefined;
    })
    .filter((entry): entry is RajalTreatmentGroup => entry !== undefined);
}

function loadSavedRajalFilters(): Partial<RajalDraft> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(RAJAL_FILTER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<RajalDraft>;
    // `mode` and `discoverMaxPatients` are deliberately not restored. Both
    // decide how much work a run takes on, and the safety model's first rule is
    // that scope is never inherited from saved config: an operator must land in
    // typed-list mode with the pilot cap every time and opt out on purpose.
    return {
      clinics: parsed.clinics,
      acceptedPenjaminKeywords: parsed.acceptedPenjaminKeywords,
      tindakanIncludeKeywords: parsed.tindakanIncludeKeywords,
      tindakanExcludeKeywords: parsed.tindakanExcludeKeywords,
      tindakanMinCount: parsed.tindakanMinCount,
      discoverInstalasi: parsed.discoverInstalasi,
      discoverPenjamin: parsed.discoverPenjamin,
      discoverUnit: parsed.discoverUnit,
      requiredRows: parsed.requiredRows,
      requiredLogic: parsed.requiredLogic,
      skipRows: parsed.skipRows,
    };
  } catch {
    return {};
  }
}

function saveRajalFilters(draft: RajalDraft): void {
  if (typeof localStorage === 'undefined') return;
  const saved: Partial<RajalDraft> = {
    clinics: draft.clinics,
    acceptedPenjaminKeywords: draft.acceptedPenjaminKeywords,
    tindakanIncludeKeywords: draft.tindakanIncludeKeywords,
    tindakanExcludeKeywords: draft.tindakanExcludeKeywords,
    tindakanMinCount: draft.tindakanMinCount,
    discoverInstalasi: draft.discoverInstalasi,
    discoverPenjamin: draft.discoverPenjamin,
    discoverUnit: draft.discoverUnit,
    requiredRows: draft.requiredRows,
    requiredLogic: draft.requiredLogic,
    skipRows: draft.skipRows,
  };
  localStorage.setItem(RAJAL_FILTER_KEY, JSON.stringify(saved));
}

/** Nodes the runner skips when verification is off; their dependants skip with them. */
export const RANAP_VERIFY_OFF: Record<string, boolean> = { final_gate: false, execute_verifikasi: false, tampung_bayar: false };

export function buildRanapInput(draft: RanapDraft): RunInputResult {
  const patientIds = splitList(draft.noRm);
  const noRm = patientIds[0] ?? '';
  if (patientIds.length === 0) return { error: 'No. RM wajib diisi untuk rawat inap.', summary: 'Ranap belum lengkap' };
  // The ranap workflow bills ONE patient per run (ranap_v3 main() takes one medrec);
  // the engine reads only the first id, so a second one would be silently ignored.
  if (patientIds.length > 1) {
    return { error: `Rawat inap diproses satu pasien per run — sisakan satu No. RM (${patientIds.length} diisi).`, summary: `Ranap ${patientIds.length} pasien` };
  }
  if (!isIsoDate(draft.tanggal)) {
    return { error: 'Tanggal rawat inap wajib diisi dengan format valid.', summary: `Ranap ${noRm}` };
  }

  const acceptedPenjaminKeywords = splitList(draft.acceptedPenjaminKeywords);
  const toleranceDays = clampToleranceDays(draft.toleranceDays);
  const userProses = (draft.userProses ?? '').trim();
  const verify = draft.enableVerifikasi !== false;
  const input: RanapInput = {
    noRm,
    patientIds,
    tanggal: draft.tanggal,
    toleranceDays,
    acceptedPenjaminKeywords: acceptedPenjaminKeywords.length ? acceptedPenjaminKeywords : undefined,
    debugMode: draft.debugMode === true,
    skipVerifikasiSep: draft.skipVerifikasiSep === true,
    // Payment is staged only for registrations whose verification was planned, so it follows verification.
    enableTampungBayar: verify && draft.enableTampungBayar === true,
    ...(userProses ? { userProses } : {}),
  };
  const flags = [
    draft.debugMode ? 'debug' : '',
    draft.skipVerifikasiSep ? 'skip SEP' : '',
    verify ? '' : 'tanpa verifikasi',
    input.enableTampungBayar ? 'tampung bayar' : '',
    draft.cekBerkas ? 'cek berkas' : '',
  ].filter(Boolean);
  const suffix = flags.length ? ` · ${flags.join(', ')}` : '';
  return {
    input,
    // Checks-only run: the runner skips the gate and everything after it.
    // The berkas notice is an opt-in node (defaultEnabled false) switched on here.
    ...(verify && !draft.cekBerkas ? {} : { enabled: { ...(verify ? {} : RANAP_VERIFY_OFF), ...(draft.cekBerkas ? { check_berkas: true } : {}) } }),
    summary: `Ranap ${patientIds.length} pasien @ ${draft.tanggal} (±${toleranceDays} hari)${suffix}`,
  };
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
function buildRajalDiscoveryInput(draft: RajalDraft, enabled: Record<string, boolean>): RunInputResult {
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

export function buildRajalInput(draft: RajalDraft, enabled: Record<string, boolean> = {}): RunInputResult {
  const result = draft.mode === 'discover' ? buildRajalDiscoveryInput(draft, enabled) : buildRajalListInput(draft, enabled);
  if (!result.input) return result;
  const tags = [
    draft.enableVerifikasi === false ? 'tanpa verifikasi' : '',
    draft.enableTampungBayar === false ? 'tanpa tampung bayar' : '',
    enabled.check_berkas ? 'cek berkas' : '',
  ].filter(Boolean);
  return tags.length ? { ...result, summary: `${result.summary} · ${tags.join(' · ')}` } : result;
}

function buildRajalListInput(draft: RajalDraft, enabled: Record<string, boolean>): RunInputResult {
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

/**
 * Legacy `doFetch` into the list form: the report's No. RM list replaces the
 * typed one and its period becomes the visit range. Scope `all` takes the
 * report's poli headings; `selected` keeps the operator's chips (the server
 * already narrowed the report to them).
 */
export function applyRajalFetch<T extends RajalDraft>(
  draft: T,
  result: { patientIds: readonly string[]; clinics: readonly string[] },
  from: string,
  to: string,
): T {
  return {
    ...draft,
    patientIds: result.patientIds.join('\n'),
    // Section titles can differ only by spacing; trimmed they would repeat as chips.
    clinics: draft.fetchScope === 'selected' ? draft.clinics : [...new Set(result.clinics.map((clinic) => clinic.trim()).filter(Boolean))].join(', '),
    date: from,
    dateTo: to,
  };
}

/** Drop one poli chip from the comma list. */
export function removeClinic(text: string, clinic: string): string {
  return splitList(text).filter((item) => item !== clinic).join(', ');
}

/**
 * After a poli chip is removed, drop the fetched No. RM that were seen only
 * under removed poli. RM typed by hand (absent from the report map) stay.
 */
export function keepPatientsForClinics(
  patientIds: string,
  clinics: string,
  clinicsByRm: Readonly<Record<string, readonly string[]>>,
): string {
  const kept = splitList(clinics);
  return splitList(patientIds)
    .filter((id) => {
      const seen = clinicsByRm[id];
      return !seen || seen.some((heading) => resolveRajalClinicMatch(heading, kept).matches.length > 0);
    })
    .join('\n');
}

/** Digits only, so 0-12-34-56, 123456 and 0123456 all find the same No. RM. */
export function rmMatches(rm: string, query: string): boolean {
  const q = query.replace(/\D/g, '');
  return !q || rm.replace(/\D/g, '').includes(q);
}

/** Quick find over a No. RM list: digit-tolerant search, one action per row. */
function RmFinder({ id, items, pickLabel, onPick, onRemove, current }: {
  id: string;
  items: ReadonlyArray<{ rm: string; detail?: string }>;
  pickLabel: string;
  onPick: (rm: string) => void;
  onRemove?: (rm: string) => void;
  current?: readonly string[];
}) {
  const [query, setQuery] = useState('');
  const hits = items.filter((item) => rmMatches(item.rm, query));
  return (
    <div className="rm-finder">
      <div className="rm-search">
        <Icon name="search" size={16} aria-hidden="true" />
        <FormInput id={id} type="search" inputMode="numeric" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari No. RM — 123456 atau 0-12-34-56" aria-label="Cari No. RM" />
      </div>
      <small aria-live="polite">{hits.length} dari {items.length} No. RM</small>
      {hits.length ? (
        <ul className="rm-results">
          {hits.map((item) => (
            <li key={item.rm} aria-current={current?.includes(item.rm) ? 'true' : undefined}>
              <span className="rm-results-text"><strong>{item.rm}</strong>{item.detail ? <span>{item.detail}</span> : null}</span>
              <Button color="secondary" variant="outline" size="sm" type="button" onClick={() => onPick(item.rm)}>{pickLabel}</Button>
              {onRemove ? <button type="button" className="chip-remove" aria-label={`Hapus ${item.rm}`} onClick={() => onRemove(item.rm)}>×</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const LOGIC_OPTIONS: ReadonlyArray<{ id: RequiredLogic; label: string; hint: string }> = [
  { id: 'or', label: 'Salah satu (OR)', hint: 'Cukup satu tindakan yang dicentang ada di tagihan.' },
  { id: 'and', label: 'Semua (AND)', hint: 'Setiap tindakan yang dicentang wajib ada di tagihan.' },
  { id: 'group', label: 'Per grup', hint: 'Huruf sama = cukup salah satu (OR); huruf berbeda = semua grup wajib (AND).' },
];

/** One line per treatment: tick to use it, edit the name, add more below. */
function TreatmentRowsEditor({ id, title, hint, rows, logic, onChange, onLogicChange }: {
  id: string;
  title: string;
  hint?: string;
  rows: TreatmentRow[];
  logic?: RequiredLogic;
  onChange: (rows: TreatmentRow[]) => void;
  onLogicChange?: (logic: RequiredLogic) => void;
}) {
  const update = (i: number, patch: Partial<TreatmentRow>) => onChange(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const active = rows.filter((row) => row.enabled && row.name.trim()).length;
  return (
    <div className="run-field treatment-rows" role="group" aria-labelledby={`${id}-title`}>
      <div className="treatment-rows-head">
        <span className="form-label" id={`${id}-title`}>{title}</span>
        <span className="treatment-rows-count">{active} aktif</span>
      </div>
      {onLogicChange ? (
        <div className="treatment-logic" role="radiogroup" aria-label={`Logika ${title}`}>
          {LOGIC_OPTIONS.map((option) => (
            <button key={option.id} type="button" role="radio" aria-checked={logic === option.id} className={`patient-filter${logic === option.id ? ' is-on' : ''}`} title={option.hint} onClick={() => onLogicChange(option.id)}>{option.label}</button>
          ))}
        </div>
      ) : null}
      <small>{onLogicChange ? LOGIC_OPTIONS.find((option) => option.id === logic)?.hint : hint}</small>
      {rows.map((row, i) => (
        <div key={i} className={`treatment-row${row.enabled ? '' : ' is-off'}`}>
          <input type="checkbox" className="form-check-input" aria-label={`Pakai baris ${i + 1}`} checked={row.enabled} onChange={(event) => update(i, { enabled: event.target.checked })} />
          {logic === 'group' ? (
            <select className="form-select treatment-group" aria-label={`Grup baris ${i + 1}`} value={row.group || 'A'} onChange={(event) => update(i, { group: event.target.value })}>
              {LETTERS.slice(0, 6).split('').map((letter) => <option key={letter} value={letter}>{letter}</option>)}
            </select>
          ) : null}
          <FormInput id={i === 0 ? id : undefined} aria-label={`${title} baris ${i + 1}`} value={row.name} placeholder="nama tindakan" onChange={(event) => update(i, { name: event.target.value })} />
          <button type="button" className="panel-close" aria-label={`Hapus baris ${i + 1}`} title="Hapus baris" onClick={() => onChange(rows.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <Button color="secondary" variant="outline" size="sm" type="button" onClick={() => onChange([...rows, { enabled: true, name: '', group: rows.at(-1)?.group || 'A' }])}>+ Tambah tindakan</Button>
    </div>
  );
}

export function RunInputForm({ domain, source, onInputChange, viewingRunId }: RunInputFormProps) {
  const defaultDate = useMemo(todayIso, []);
  const savedRajalFilters = useMemo(loadSavedRajalFilters, []);
  const [showClinics, setShowClinics] = useState(false);
  const [ranap, setRanap] = useState<RanapDraft>({
    noRm: '',
    tanggal: defaultDate,
    toleranceDays: '3',
    acceptedPenjaminKeywords: ACCEPTED_PENJAMIN_TEXT,
    // Legacy defaults: preview-safe. Verification-SEP skipping and payment
    // staging are per-run, opt-in decisions and never restored from storage.
    debugMode: false,
    skipVerifikasiSep: false,
    enableVerifikasi: true,
    enableTampungBayar: false,
    cekBerkas: false,
    userProses: '',
  });
  const [rajal, setRajal] = useState<RajalDraft>({
    // Never restored: the run always starts from the typed list at the pilot cap.
    mode: 'list',
    patientIds: '',
    clinics: savedRajalFilters.clinics ?? 'DALAM',
    date: defaultDate,
    acceptedPenjaminKeywords: savedRajalFilters.acceptedPenjaminKeywords ?? ACCEPTED_PENJAMIN_TEXT,
    tindakanIncludeKeywords: savedRajalFilters.tindakanIncludeKeywords ?? DEFAULT_RAJAL_REQUIRED_TREATMENTS,
    tindakanExcludeKeywords: savedRajalFilters.tindakanExcludeKeywords ?? RAJAL_DEFAULT_SKIP_TREATMENTS.join('\n'),
    tindakanMinCount: savedRajalFilters.tindakanMinCount ?? '',
    discoverInstalasi: savedRajalFilters.discoverInstalasi ?? RAJAL_INSTALASI_OPTIONS[0].code,
    discoverFrom: defaultDate,
    discoverTo: defaultDate,
    discoverPenjamin: savedRajalFilters.discoverPenjamin ?? '',
    discoverUnit: savedRajalFilters.discoverUnit ?? '',
    discoverMaxPatients: '',
    paymentShift: RAJAL_DEFAULT_PAYMENT_CONFIG.shift,
    paymentType: RAJAL_DEFAULT_PAYMENT_CONFIG.type,
    paymentPayerCode: RAJAL_DEFAULT_PAYMENT_CONFIG.payerCode,
    requiredRows: savedRajalFilters.requiredRows
      ?? linesToRows(savedRajalFilters.tindakanIncludeKeywords ?? DEFAULT_RAJAL_REQUIRED_TREATMENTS),
    requiredLogic: savedRajalFilters.requiredLogic ?? 'or',
    skipRows: savedRajalFilters.skipRows
      ?? linesToRows(savedRajalFilters.tindakanExcludeKeywords ?? RAJAL_DEFAULT_SKIP_TREATMENTS.join('\n')),
    // Never restored: skipping SEP validation is a per-run decision.
    sepCheckRequired: true,
    enableVerifikasi: true,
    enableTampungBayar: true,
  });
  const [rajalEnabled, setRajalEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(RAJAL_PENUNJANG.map((item) => [item.id, true])),
  );

  // Live runs pull poli names from the unpaid-bill report (1st of the month →
  // the run date) so a clinic SIMRS adds is offered without a code change.
  const [liveClinics, setLiveClinics] = useState<string[]>([]);
  const clinicPeriodTo = (rajal.mode === 'discover' ? rajal.discoverTo : rajal.date) ?? '';
  useEffect(() => {
    if (domain !== 'rajal' || source !== 'live' || !/^\d{4}-\d{2}-\d{2}$/.test(clinicPeriodTo)) return;
    let alive = true;
    api.rajalUnpaid({ from: `${clinicPeriodTo.slice(0, 8)}01`, to: clinicPeriodTo })
      .then((res) => { if (alive) setLiveClinics(res.clinics); })
      .catch(() => { /* static list stays usable */ });
    return () => { alive = false; };
  }, [domain, source, clinicPeriodTo]);

  // "Ambil dari laporan" (legacy doFetch) for the list mode.
  const [fetchState, setFetchState] = useState<{ busy: boolean; message?: string; error?: boolean }>({ busy: false });
  const fetchFromReport = async () => {
    const from = (rajal.discoverFrom ?? '').trim();
    const to = (rajal.discoverTo ?? '').trim();
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
      setFetchState({ busy: false, error: true, message: 'Periode laporan belum valid.' });
      return;
    }
    const selected = splitList(rajal.clinics);
    if (rajal.fetchScope === 'selected' && selected.length === 0) {
      setFetchState({ busy: false, error: true, message: 'Pilih minimal satu poli, atau ganti ke "Semua poli".' });
      return;
    }
    setFetchState({ busy: true, message: 'Mengambil laporan belum bayar…' });
    try {
      const res = await api.rajalUnpaid({
        from,
        to,
        instalasi: rajal.discoverInstalasi,
        penjamin: rajal.discoverPenjamin,
        ...(rajal.fetchScope === 'selected' ? { unit: selected.join(',') } : {}),
      });
      setLiveClinics((value) => [...new Set([...value, ...res.clinics])]);
      setFetchedClinicsByRm(res.clinicsByPatientId);
      setRajal((value) => applyRajalFetch(value, res, from, to));
      setFetchState({ busy: false, message: `${res.patientIds.length} No. RM dari ${res.clinics.length} poli (${res.total} baris laporan).` });
    } catch (err) {
      setFetchState({ busy: false, error: true, message: `Gagal mengambil laporan: ${err instanceof Error ? err.message : String(err)}` });
    }
  };
  const [fetchedClinicsByRm, setFetchedClinicsByRm] = useState<Record<string, string[]>>({});
  const setClinicsPruned = (clinics: string) =>
    setRajal((value) => ({ ...value, clinics, patientIds: keepPatientsForClinics(value.patientIds, clinics, fetchedClinicsByRm) }));
  const selectedClinics = [...new Set(splitList(rajal.clinics))];
  const rajalRmList = splitList(rajal.patientIds);

  // Rawat inap "Ambil data": discharged-inpatient report, picked one patient at a time.
  const [ranapFetch, setRanapFetch] = useState<{ from: string; to: string; masukFrom: string; masukTo: string; verifikasi: RanapReportFlag; bayar: RanapReportFlag; kelPenjamin: string }>(
    () => ({ from: `${defaultDate.slice(0, 8)}01`, to: defaultDate, masukFrom: '', masukTo: '', verifikasi: '0', bayar: '0', kelPenjamin: '' }),
  );
  const [ranapRows, setRanapRows] = useState<RanapDischargeRow[]>([]);
  const [ranapFetchState, setRanapFetchState] = useState<{ busy: boolean; message?: string; error?: boolean }>({ busy: false });
  const fetchRanapReport = async () => {
    const f = ranapFetch;
    if (!isIsoDate(f.from) || !isIsoDate(f.to) || f.from > f.to) {
      setRanapFetchState({ busy: false, error: true, message: 'Periode keluar belum valid.' });
      return;
    }
    setRanapFetchState({ busy: true, message: 'Mengambil laporan pasien keluar…' });
    try {
      const res = await api.ranapDischarged(f);
      setRanapRows(res.rows);
      setRanapFetchState({ busy: false, message: `${res.rows.length} pasien. Pilih satu untuk mengisi No. RM dan tanggal masuk.` });
    } catch (err) {
      setRanapFetchState({ busy: false, error: true, message: `Gagal mengambil laporan: ${err instanceof Error ? err.message : String(err)}` });
    }
  };
  const clinicOptions = useMemo(() => mergeClinicOptions(LEGACY_CLINICS, liveClinics), [liveClinics]);
  const filteredClinics = useMemo(() => filterClinicOptions(clinicOptions, rajal.clinics), [clinicOptions, rajal.clinics]);

  const result = useMemo(
    () => (domain === 'ranap' ? buildRanapInput(ranap) : buildRajalInput(rajal, rajalEnabled)),
    [domain, ranap, rajal, rajalEnabled],
  );

  useEffect(() => {
    onInputChange(result);
  }, [onInputChange, result]);

  useEffect(() => {
    saveRajalFilters(rajal);
  }, [rajal]);

  const title = domain === 'ranap' ? 'Input Rawat Inap' : 'Input Rawat Jalan';
  const hint = source === 'live' ? 'Dipakai untuk run SIMRS langsung' : 'Hanya keterangan untuk data contoh';
  const discovering = domain === 'rajal' && rajal.mode === 'discover';

  return (
    <Card className="run-input-panel" role="group" aria-label="Input run SIMRS">
      <CardHeader className="card-header-actions">
        <div><strong>{title}</strong><span className="card-subtitle">{hint}</span></div>
        {viewingRunId && result.error
          ? <Badge color="secondary">Untuk run baru — belum diisi</Badge>
          : <Badge color={result.error ? 'danger' : 'info'}>{result.error ?? result.summary}</Badge>}
      </CardHeader>
      <CardBody className="page-stack">
        {domain === 'ranap' ? (
          <div className="run-input-grid ranap-inputs">
            <fieldset className="run-field wide rajal-fetch" aria-label="Ambil dari laporan pasien keluar rawat inap">
              <legend className="toggle-group-title">Ambil dari laporan pasien keluar</legend>
              <div className="run-input-grid ranap-inputs">
                <div className="run-field"><FormLabel htmlFor="ranap-fetch-from">Keluar dari</FormLabel><FormInput id="ranap-fetch-from" type="date" value={ranapFetch.from} onFocus={(event) => openNativePicker(event.currentTarget)} onChange={(event) => setRanapFetch((value) => ({ ...value, from: event.target.value }))} /></div>
                <div className="run-field"><FormLabel htmlFor="ranap-fetch-to">Keluar sampai</FormLabel><FormInput id="ranap-fetch-to" type="date" value={ranapFetch.to} onFocus={(event) => openNativePicker(event.currentTarget)} onChange={(event) => setRanapFetch((value) => ({ ...value, to: event.target.value }))} /></div>
                <div className="run-field"><FormLabel htmlFor="ranap-fetch-masuk-from">Masuk dari (opsional)</FormLabel><FormInput id="ranap-fetch-masuk-from" type="date" value={ranapFetch.masukFrom} onFocus={(event) => openNativePicker(event.currentTarget)} onChange={(event) => setRanapFetch((value) => ({ ...value, masukFrom: event.target.value }))} /></div>
                <div className="run-field"><FormLabel htmlFor="ranap-fetch-masuk-to">Masuk sampai (opsional)</FormLabel><FormInput id="ranap-fetch-masuk-to" type="date" value={ranapFetch.masukTo} onFocus={(event) => openNativePicker(event.currentTarget)} onChange={(event) => setRanapFetch((value) => ({ ...value, masukTo: event.target.value }))} /></div>
                <div className="run-field"><FormLabel htmlFor="ranap-fetch-verif">Verifikasi</FormLabel><FormSelect id="ranap-fetch-verif" value={ranapFetch.verifikasi} onChange={(event) => setRanapFetch((value) => ({ ...value, verifikasi: event.target.value as RanapReportFlag }))}><option value="">Semua</option><option value="1">Sudah</option><option value="0">Belum</option></FormSelect></div>
                <div className="run-field"><FormLabel htmlFor="ranap-fetch-bayar">Bayar</FormLabel><FormSelect id="ranap-fetch-bayar" value={ranapFetch.bayar} onChange={(event) => setRanapFetch((value) => ({ ...value, bayar: event.target.value as RanapReportFlag }))}><option value="">Semua</option><option value="1">Sudah</option><option value="0">Belum</option></FormSelect></div>
                <div className="run-field"><FormLabel htmlFor="ranap-fetch-penjamin">Penjamin</FormLabel><FormSelect id="ranap-fetch-penjamin" value={ranapFetch.kelPenjamin} onChange={(event) => setRanapFetch((value) => ({ ...value, kelPenjamin: event.target.value }))}>{RANAP_REPORT_PENJAMIN_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</FormSelect></div>
              </div>
              <div className="rajal-fetch-actions">
                <Button color="primary" size="sm" type="button" disabled={ranapFetchState.busy || source !== 'live'} title={source !== 'live' ? 'Butuh sumber live (login EvoMedis)' : undefined} onClick={() => void fetchRanapReport()}>{ranapFetchState.busy ? 'Mengambil…' : 'Ambil data'}</Button>
              </div>
              {source !== 'live' ? <small className="fetch-hint">Pilih sumber <b>Live SIMRS</b> untuk mengambil data dari laporan.</small> : null}
              {ranapFetchState.message ? <small role="status" className={ranapFetchState.error ? 'text-danger' : undefined}>{ranapFetchState.message}</small> : null}
              {ranapRows.length ? (
                <RmFinder
                  id="ranap-rm-find"
                  items={ranapRows.map((row) => ({ rm: row.noRm, detail: `${row.nama} · ${row.ruang} · ${row.jaminan} · masuk ${row.tglMasuk} → keluar ${row.tglKeluar} · ${row.verifikasi}` }))}
                  pickLabel="Pilih"
                  current={splitList(ranap.noRm)}
                  onPick={(rm) => {
                    const row = ranapRows.find((item) => item.noRm === rm);
                    setRanap((value) => ({ ...value, noRm: rm, ...(row && isIsoDate(row.tglMasuk) ? { tanggal: row.tglMasuk } : {}) }));
                  }}
                />
              ) : null}
            </fieldset>
            <div className="run-field wide"><FormLabel htmlFor="ranap-rm">No. RM</FormLabel><FormTextarea id="ranap-rm" rows={2} value={ranap.noRm} onChange={(event) => setRanap((value) => ({ ...value, noRm: event.target.value }))} placeholder="0-90-00-09" /><small>Satu pasien per run.</small></div>
            <div className="run-field"><FormLabel htmlFor="ranap-date">Tanggal</FormLabel><FormInput id="ranap-date" type="date" value={ranap.tanggal} onFocus={(event) => openNativePicker(event.currentTarget)} onChange={(event) => setRanap((value) => ({ ...value, tanggal: event.target.value }))} /></div>
            <div className="run-field"><FormLabel htmlFor="ranap-tolerance">Toleransi hari</FormLabel><FormInput id="ranap-tolerance" type="number" min={0} max={14} value={ranap.toleranceDays} onChange={(event) => setRanap((value) => ({ ...value, toleranceDays: event.target.value }))} onBlur={(event) => { const clamped = String(clampToleranceDays(event.target.value)); setRanap((value) => ({ ...value, toleranceDays: clamped })); }} /></div>
            <div className="run-field wide"><FormLabel htmlFor="ranap-guarantor">Penjamin diterima</FormLabel><FormInput id="ranap-guarantor" value={ranap.acceptedPenjaminKeywords} onChange={(event) => setRanap((value) => ({ ...value, acceptedPenjaminKeywords: event.target.value }))} /></div>
            <div className="toggle-group write-actions wide" role="group" aria-label="Aksi write rawat inap">
              <span className="toggle-group-title">Aksi write</span>
              <div className="toggle-grid">
                <FormCheck
                  id="ranap-verifikasi"
                  label="Verifikasi"
                  title="Rencanakan verifikasi (simpan verifikasi) setelah gerbang akhir disetujui. Matikan untuk run pemeriksaan saja."
                  checked={ranap.enableVerifikasi !== false}
                  onChange={(c) => setRanap((value) => ({ ...value, enableVerifikasi: c, ...(c ? {} : { enableTampungBayar: false }) }))}
                />
                <FormCheck
                  id="ranap-tampung-bayar"
                  label="Tampung bayar setelah verifikasi"
                  title={ranap.enableVerifikasi === false ? 'Butuh Verifikasi aktif' : 'Rencanakan penampungan pembayaran setelah verifikasi disetujui'}
                  checked={ranap.enableVerifikasi !== false && ranap.enableTampungBayar === true}
                  disabled={ranap.enableVerifikasi === false}
                  onChange={(c) => setRanap((value) => ({ ...value, enableTampungBayar: c }))}
                />
              </div>
              <small>Hanya ditulis di run <b>Write</b> setelah disetujui; Preview tetap tidak menulis.</small>
              {ranap.enableVerifikasi === false ? (
                <Alert color="info" className="mb-0">
                  Run pemeriksaan saja: gerbang akhir, verifikasi, tampung bayar, dan ringkasan TSV dilewati. Hasil cek tiap langkah tetap tampil.
                </Alert>
              ) : null}
            </div>
            <details className="run-advanced wide">
              <summary>Opsi lanjutan rawat inap</summary>
              <div className="advanced-stack">
                <div className="toggle-group" role="group" aria-label="Opsi run rawat inap">
                  <span className="toggle-group-title">Mode</span>
                  <div className="toggle-grid">
                    <FormCheck
                      id="ranap-debug"
                      label="Mode debug"
                      title="Tampilkan no reg, no trx, sumber SEP, dan preflight gizi pada log"
                      checked={ranap.debugMode === true}
                      onChange={(c) => setRanap((value) => ({ ...value, debugMode: c }))}
                    />
                    <FormCheck
                      id="ranap-skip-sep"
                      label="Lewati validasi SEP"
                      title="Terima tagihan meski SEP RITL tidak ditemukan — setara skip_verifikasi_sep"
                      checked={ranap.skipVerifikasiSep === true}
                      onChange={(c) => setRanap((value) => ({ ...value, skipVerifikasiSep: c }))}
                    />
                    <FormCheck
                      id="ranap-cek-berkas"
                      label="Cek kelengkapan berkas (OCR)"
                      title={source !== 'live' ? 'Butuh sumber Live SIMRS (berkas e-klaim diunduh dari SIMRS)' : 'Unduh berkas e-klaim pasien dan cari dokumen wajib: SEP, resume, rincian biaya, kamar penuh bila titipan, hasil rontgen/EKG bila ditagihkan. Hanya notice, tidak memblokir. Bundel besar ±1 menit.'}
                      checked={ranap.cekBerkas === true}
                      onChange={(c) => setRanap((value) => ({ ...value, cekBerkas: c }))}
                    />
                  </div>
                </div>
                {ranap.skipVerifikasiSep ? (
                  <Alert color="warning" className="mb-0">
                    Validasi SEP dilewati. Tagihan akan diproses tanpa SEP RITL yang cocok — pastikan ini memang disengaja.
                  </Alert>
                ) : null}
                <div className="run-field">
                  <FormLabel htmlFor="ranap-user-proses">User proses</FormLabel>
                  <FormInput
                    id="ranap-user-proses"
                    value={ranap.userProses ?? ''}
                    placeholder="nama operator"
                    onChange={(event) => setRanap((value) => ({ ...value, userProses: event.target.value }))}
                  />
                  <small>Dicatat pada kolom user_proses di ringkasan verifikasi.</small>
                </div>
              </div>
            </details>
          </div>
        ) : (
          <>
            {/* The two modes are exclusive and only the active one renders its
                fields, so a typed list and a discovered batch can never be
                mistaken for one another. */}
            <div className="toggle-group" role="radiogroup" aria-label="Sumber daftar pasien rawat jalan">
              <span className="toggle-group-title">Sumber pasien</span>
              <div className="toggle-grid">
                <FormCheck type="radio" name="rajal-batch-mode" id="rajal-mode-list" label="Daftar No. RM" title="Proses hanya No. RM yang diketik di bawah" checked={!discovering} onChange={() => setRajal((value) => ({ ...value, mode: 'list' }))} />
                <FormCheck type="radio" name="rajal-batch-mode" id="rajal-mode-discover" label="Cari otomatis (laporan belum bayar)" title="Ambil daftar pasien dari laporan pasien belum bayar untuk satu periode" checked={discovering} onChange={() => setRajal((value) => ({ ...value, mode: 'discover' }))} />
              </div>
            </div>
            <div className="run-input-grid rajal-inputs">
              {discovering ? (
                <>
                  <div className="run-field"><FormLabel htmlFor="rajal-instalasi">Instalasi</FormLabel><FormSelect id="rajal-instalasi" value={rajal.discoverInstalasi ?? RAJAL_INSTALASI_OPTIONS[0].code} onChange={(event) => setRajal((value) => ({ ...value, discoverInstalasi: event.target.value }))}>{RAJAL_INSTALASI_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</FormSelect></div>
                  <div className="run-field"><FormLabel htmlFor="rajal-max-patients">Batas pasien</FormLabel><FormInput id="rajal-max-patients" type="number" min={1} placeholder="tanpa batas" value={rajal.discoverMaxPatients ?? ''} onChange={(event) => setRajal((value) => ({ ...value, discoverMaxPatients: event.target.value }))} /><small>Opsional. Kosong = tanpa batas; diisi = run ditolak bila batch melebihi angka ini.</small></div>
                  <div className="run-field"><FormLabel htmlFor="rajal-from">Periode dari</FormLabel><FormInput id="rajal-from" type="date" value={rajal.discoverFrom ?? ''} onFocus={(event) => openNativePicker(event.currentTarget)} onChange={(event) => setRajal((value) => ({ ...value, discoverFrom: event.target.value }))} /></div>
                  <div className="run-field"><FormLabel htmlFor="rajal-to">Periode sampai</FormLabel><FormInput id="rajal-to" type="date" value={rajal.discoverTo ?? ''} onFocus={(event) => openNativePicker(event.currentTarget)} onChange={(event) => setRajal((value) => ({ ...value, discoverTo: event.target.value }))} /><small>Periode ini juga menjadi rentang tanggal kunjungan yang diproses.</small></div>
                  <div className="run-field"><FormLabel htmlFor="rajal-penjamin-filter">Filter penjamin</FormLabel><FormInput id="rajal-penjamin-filter" value={rajal.discoverPenjamin ?? ''} onChange={(event) => setRajal((value) => ({ ...value, discoverPenjamin: event.target.value }))} placeholder="BPJS" /><small>Substring kolom penjamin pada laporan; kosong = semua.</small></div>
                  <div className="run-field"><FormLabel htmlFor="rajal-unit-filter">Filter unit</FormLabel><FormInput id="rajal-unit-filter" value={rajal.discoverUnit ?? ''} onChange={(event) => setRajal((value) => ({ ...value, discoverUnit: event.target.value }))} placeholder="MATA, DALAM" /><small>Dipisah koma, dicocokkan ke judul seksi laporan.</small></div>
                </>
              ) : (
                <>
                  <fieldset className="run-field wide rajal-fetch" aria-label="Ambil dari laporan belum bayar">
                    <legend className="toggle-group-title">Ambil dari laporan belum bayar</legend>
                    <div className="run-input-grid rajal-inputs">
                      <div className="run-field"><FormLabel htmlFor="rajal-fetch-from">Periode dari</FormLabel><FormInput id="rajal-fetch-from" type="date" value={rajal.discoverFrom ?? ''} onFocus={(event) => openNativePicker(event.currentTarget)} onChange={(event) => setRajal((value) => ({ ...value, discoverFrom: event.target.value }))} /></div>
                      <div className="run-field"><FormLabel htmlFor="rajal-fetch-to">Periode sampai</FormLabel><FormInput id="rajal-fetch-to" type="date" value={rajal.discoverTo ?? ''} onFocus={(event) => openNativePicker(event.currentTarget)} onChange={(event) => setRajal((value) => ({ ...value, discoverTo: event.target.value }))} /></div>
                      <div className="run-field"><FormLabel htmlFor="rajal-fetch-instalasi">Instalasi</FormLabel><FormSelect id="rajal-fetch-instalasi" value={rajal.discoverInstalasi ?? RAJAL_INSTALASI_OPTIONS[0].code} onChange={(event) => setRajal((value) => ({ ...value, discoverInstalasi: event.target.value }))}>{RAJAL_INSTALASI_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</FormSelect></div>
                      <div className="run-field"><FormLabel htmlFor="rajal-fetch-penjamin">Filter penjamin</FormLabel><FormInput id="rajal-fetch-penjamin" value={rajal.discoverPenjamin ?? ''} onChange={(event) => setRajal((value) => ({ ...value, discoverPenjamin: event.target.value }))} placeholder="BPJS" /></div>
                    </div>
                    <div className="rajal-fetch-actions">
                      <div className="toggle-grid" role="radiogroup" aria-label="Cakupan poli">
                        <FormCheck type="radio" name="rajal-fetch-scope" id="rajal-fetch-all" label="Semua poli" title="Ambil semua poli di laporan; daftar poli diganti judul seksi laporan" checked={rajal.fetchScope !== 'selected'} onChange={() => setRajal((value) => ({ ...value, fetchScope: 'all' }))} />
                        <FormCheck type="radio" name="rajal-fetch-scope" id="rajal-fetch-selected" label="Poli terpilih" title="Ambil hanya pasien di poli yang sudah dipilih di bawah" checked={rajal.fetchScope === 'selected'} onChange={() => setRajal((value) => ({ ...value, fetchScope: 'selected' }))} />
                      </div>
                      <Button color="primary" size="sm" type="button" disabled={fetchState.busy || source !== 'live'} title={source !== 'live' ? 'Butuh sumber live (login EvoMedis)' : undefined} onClick={() => void fetchFromReport()}>{fetchState.busy ? 'Mengambil…' : 'Ambil data'}</Button>
                    </div>
                    {source !== 'live' ? <small className="fetch-hint">Pilih sumber <b>Live SIMRS</b> untuk mengambil data dari laporan.</small> : null}
                    {fetchState.message ? <small role="status" className={fetchState.error ? 'text-danger' : undefined}>{fetchState.message}</small> : null}
                  </fieldset>
                  <div className="run-field wide">
                    <div className="field-head"><FormLabel htmlFor="rajal-rm">No. RM ({splitList(rajal.patientIds).length})</FormLabel>{rajal.patientIds.trim() ? <Button color="secondary" variant="ghost" size="sm" type="button" onClick={() => setRajal((value) => ({ ...value, patientIds: '' }))}>Kosongkan</Button> : null}</div>
                    <FormTextarea id="rajal-rm" rows={2} value={rajal.patientIds} onChange={(event) => setRajal((value) => ({ ...value, patientIds: event.target.value }))} placeholder="0-90-00-09" />
                    {rajalRmList.length > 1 ? (
                      <RmFinder
                        id="rajal-rm-find"
                        items={rajalRmList.map((rm) => ({ rm, detail: fetchedClinicsByRm[rm]?.join(', ') }))}
                        pickLabel="Pakai ini saja"
                        onPick={(rm) => setRajal((value) => ({ ...value, patientIds: rm }))}
                        onRemove={(rm) => setRajal((value) => ({ ...value, patientIds: splitList(value.patientIds).filter((id) => id !== rm).join('\n') }))}
                      />
                    ) : null}
                  </div>
                </>
              )}
              <div className="run-field wide combo-field"><FormLabel htmlFor="rajal-clinic">Poli</FormLabel><div className="combo-wrap"><FormInput id="rajal-clinic" value={rajal.clinics} onFocus={() => setShowClinics(true)} onBlur={() => setTimeout(() => setShowClinics(false), 120)} onChange={(event) => { setRajal((value) => ({ ...value, clinics: event.target.value })); setShowClinics(true); }} placeholder="PENYAKIT DALAM" role="combobox" aria-controls="rajal-clinic-options" aria-expanded={showClinics} aria-autocomplete="list" />{showClinics ? <div className="combo-menu" id="rajal-clinic-options" role="listbox">{filteredClinics.length ? filteredClinics.map((clinic) => <Button color="secondary" variant="ghost" className="combo-option" type="button" role="option" key={clinic} onMouseDown={(event) => { event.preventDefault(); setRajal((value) => ({ ...value, clinics: replaceCurrentCommaToken(value.clinics, clinic) })); setShowClinics(false); }}>{clinic}</Button>) : <div className="combo-empty">No suggestions; manual input remains available.</div>}</div> : null}</div>{selectedClinics.length ? (
                <ul className="chip-list" aria-label="Poli terpilih">
                  {selectedClinics.map((clinic) => <li className="chip" key={clinic}>{clinic}<button type="button" className="chip-remove" aria-label={`Hapus ${clinic}`} onClick={() => setClinicsPruned(removeClinic(rajal.clinics, clinic))}>×</button></li>)}
                  <li><Button color="secondary" variant="ghost" size="sm" type="button" onClick={() => setClinicsPruned('')}>Hapus semua</Button></li>
                </ul>
              ) : null}{discovering ? <small>Kosongkan untuk memakai judul seksi laporan; diisi berarti mempersempit batch ke poli tersebut.</small> : null}</div>
              {discovering ? null : <div className="run-field"><FormLabel htmlFor="rajal-date">Tanggal</FormLabel><FormInput id="rajal-date" type="date" value={rajal.date} onFocus={(event) => openNativePicker(event.currentTarget)} onChange={(event) => setRajal((value) => ({ ...value, date: event.target.value }))} /></div>}
              {discovering ? null : <div className="run-field"><FormLabel htmlFor="rajal-date-to">Sampai (opsional)</FormLabel><FormInput id="rajal-date-to" type="date" value={rajal.dateTo ?? ''} min={rajal.date} onFocus={(event) => openNativePicker(event.currentTarget)} onChange={(event) => setRajal((value) => ({ ...value, dateTo: event.target.value }))} /><small>Kosong = satu hari. Terisi otomatis dari periode laporan.</small></div>}
            </div>
            <div className="toggle-group write-actions" role="group" aria-label="Aksi write rawat jalan">
              <span className="toggle-group-title">Aksi write</span>
              <div className="toggle-grid">
                <FormCheck id="rajal-verifikasi" label="Verifikasi" title="Rencanakan simpan verifikasi untuk kunjungan yang belum diverifikasi. Mati: kunjungan belum terverifikasi dilewati, tidak dibayar." checked={rajal.enableVerifikasi !== false} onChange={(c) => setRajal((value) => ({ ...value, enableVerifikasi: c }))} />
                <FormCheck id="rajal-tampung-bayar" label="Tampung bayar" title="Rencanakan tampung bayar untuk kunjungan yang lolos semua cek. Mati: run pemeriksaan saja." checked={rajal.enableTampungBayar !== false} onChange={(c) => setRajal((value) => ({ ...value, enableTampungBayar: c }))} />
              </div>
              <small>Hanya ditulis di run <b>Write</b> setelah disetujui; Preview tetap tidak menulis.</small>
              {rajal.enableTampungBayar === false ? <Alert color="info" className="mb-0">Run pemeriksaan saja: semua cek tetap jalan, tampung bayar tidak dirancang.</Alert> : null}
            </div>
            <details className="run-advanced">
              <summary>Advanced outpatient filters</summary>
              <div className="advanced-stack">
                <div className="toggle-group" role="group" aria-label="Outpatient supporting services"><span className="toggle-group-title">Checks enabled</span><div className="toggle-grid">{RAJAL_PENUNJANG.map((item) => <FormCheck id={`support-${item.id}`} label={item.label} checked={rajalEnabled[item.id] ?? true} key={item.id} onChange={(c) => setRajalEnabled((value) => ({ ...value, [item.id]: c }))} />)}<FormCheck id="rajal-sep-check" label="Validasi SEP" title="Legacy sepCheckRequired: cocokkan SEP RJTL hari yang sama. Matikan untuk melewati cek SEP." checked={rajal.sepCheckRequired !== false} onChange={(c) => setRajal((value) => ({ ...value, sepCheckRequired: c }))} />
                  <FormCheck id="rajal-cek-berkas" label="Cek kelengkapan berkas (OCR)" title={source !== 'live' ? 'Butuh sumber Live SIMRS (berkas e-klaim diunduh dari SIMRS)' : 'Unduh berkas e-klaim tiap kunjungan dan cari dokumen wajib: SEP, lembar verifikasi rawat jalan, rincian biaya, hasil rontgen/EKG bila ditagihkan. Hanya notice, tidak memblokir.'} checked={rajalEnabled.check_berkas === true} onChange={(c) => setRajalEnabled((value) => ({ ...value, check_berkas: c }))} /></div></div>
                <div className="run-input-grid advanced-inputs"><div className="run-field wide"><FormLabel htmlFor="rajal-guarantor">Penjamin diterima</FormLabel><FormInput id="rajal-guarantor" value={rajal.acceptedPenjaminKeywords} onChange={(event) => setRajal((value) => ({ ...value, acceptedPenjaminKeywords: event.target.value }))} /></div><div className="run-field"><FormLabel htmlFor="rajal-min-actions">Minimal tindakan</FormLabel><FormInput id="rajal-min-actions" type="number" min={1} value={rajal.tindakanMinCount} onChange={(event) => setRajal((value) => ({ ...value, tindakanMinCount: event.target.value }))} placeholder="optional" /></div></div>
                <div className="run-input-grid advanced-inputs"><div className="run-field"><FormLabel htmlFor="rajal-payment-shift">Shift bayar</FormLabel><FormSelect id="rajal-payment-shift" value={rajal.paymentShift ?? RAJAL_DEFAULT_PAYMENT_CONFIG.shift} onChange={(event) => setRajal((value) => ({ ...value, paymentShift: event.target.value }))}>{RAJAL_SHIFT_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}</FormSelect></div><div className="run-field"><FormLabel htmlFor="rajal-payment-type">Jenis bayar</FormLabel><FormSelect id="rajal-payment-type" value={rajal.paymentType ?? RAJAL_DEFAULT_PAYMENT_CONFIG.type} onChange={(event) => setRajal((value) => ({ ...value, paymentType: event.target.value }))}>{RAJAL_PAYMENT_TYPE_OPTIONS.map((option) => <option key={option.code} value={option.code}>{option.label} · {option.code}</option>)}</FormSelect></div><div className="run-field"><FormLabel htmlFor="rajal-payment-payer">Kode penjamin bayar</FormLabel><FormInput id="rajal-payment-payer" value={rajal.paymentPayerCode ?? ''} onChange={(event) => setRajal((value) => ({ ...value, paymentPayerCode: event.target.value }))} /><small>Default {RAJAL_DEFAULT_PAYMENT_CONFIG.payerCode}; masuk ke kd_penjamin.</small></div></div>
                <div className="template-row" role="group" aria-label="Required treatment templates">{RAJAL_TREATMENT_TEMPLATES.map((template) => <Button color="secondary" variant="outline" size="sm" key={template.id} type="button" aria-pressed={rajal.treatmentTemplateId === template.id} onClick={() => setRajal((value) => ({ ...value, treatmentTemplateId: template.id, requiredLogic: 'group', requiredRows: templateRowsToGroups(template.rows).map((g) => ({ enabled: true, name: g.name, group: g.group })) }))}>{template.label}</Button>)}</div>
                <TreatmentRowsEditor
                  id="rajal-required"
                  title="Wajib ada tindakan"
                  rows={rajal.requiredRows ?? []}
                  logic={rajal.requiredLogic ?? 'or'}
                  onLogicChange={(logic) => setRajal((value) => ({ ...value, requiredLogic: logic, treatmentTemplateId: undefined }))}
                  onChange={(rows) => setRajal((value) => ({ ...value, requiredRows: rows, treatmentTemplateId: undefined }))}
                />
                <TreatmentRowsEditor
                  id="rajal-skip"
                  title="Tindakan yang di-skip"
                  hint="Tagihan dilewati bila salah satu tindakan yang dicentang ditemukan (cukup satu = OR)."
                  rows={rajal.skipRows ?? []}
                  onChange={(rows) => setRajal((value) => ({ ...value, skipRows: rows }))}
                />
              </div>
            </details>
          </>
        )}
      </CardBody>
    </Card>
  );
}

