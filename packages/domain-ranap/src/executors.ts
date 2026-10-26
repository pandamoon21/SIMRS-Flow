/**
 * Rawat inap executors.
 *
 * Each executor is one step of `ranap_v3.py`'s `main()`. The decisions live in
 * `./logic/*` — pure ports of the legacy functions, unit-tested against them —
 * and this file is the I/O shell: it fetches what a decision needs, calls it,
 * writes the operator log, and turns the verdict into a `StepResult`.
 *
 * Two invariants hold throughout:
 *  - read/validate/plan steps run for real against fixtures or live reads;
 *  - `mutate` steps NEVER call the network here. They emit a `MutationPlan`
 *    that the UI surfaces for approval (safety controls #1, #3, #5, #6).
 *
 * The log is written in the shape the ward's billing operators already read
 * (see `./logic/logFormat.ts` and `Proses pengerjaan billing rawat inap unt.md`):
 * section headings, `+ ` sub-blocks, and aligned `label : value` pairs.
 * Identifiers that only matter when debugging — `no reg`, `no trx`, the unit and
 * paramedis codes, the SEP source, the gizi preflight — are marked debug-only
 * and stay hidden unless the run asks for them, exactly as the legacy
 * `DEBUG_MODE` gate does. Two consequences of that gate are easy to get wrong:
 *
 *  - `No trx pasien` is **not** gated (log spec line 33, ranap_v3.py:15957);
 *    only `No reg` is, and the codes stay interleaved in the spec's field order
 *    rather than moved to the end of the block;
 *  - a transaction number must not reach an alert *message*, because
 *    `preverify_summary` prints those messages and `emit_summary` can copy them
 *    into the TSV keterangan column — both non-debug output. Numbers travel in a
 *    step's `evidence` instead, where the renderer can gate them.
 */

import type {
  ExecutorContext,
  ExecutorRegistry,
  IssueSeverity,
  MutationPlan,
  Precondition,
  StepResult,
  VerificationRule,
  WorkflowIssue,
} from '@simrs-flow/workflow-core';
import { reasoningEvidence, type ReasoningItem } from '@simrs-flow/workflow-core';
import type { EvoMedisClient } from '@simrs-flow/evomedis-client';
import { noKkRejectionReason, normalizeCardNumber } from '@simrs-flow/evomedis-client';

import { flag, type LegacyRow, rowsOf, str, upper } from './logic/types.js';
import { berkasFactsOf, evaluateBerkas, pageList, type BerkasProgressPort, type BerkasReaderPort } from '@simrs-flow/berkas/evaluate';
import {
  buildUpdateDateTime,
  clampToleranceDays,
  combineDateTime,
  datePart,
  expandTargetDates,
  formatDate,
  parseDateFlexible,
  parseDateTimeFlexible,
  resolveTargetDateTimeFromHistoryItem,
  timePart,
} from './logic/dates.js';
import {
  compactTextKey,
  normalizeNoRmInput,
  normalizeTanggalInput,
  normalizeTextKey,
  parseJsonText,
  sortedRows,
} from './logic/scalars.js';
import {
  extractRoomSegments,
  isBynyPatient,
  isIgdSourceCandidate,
  isBpjsPenjamin,
  isTransferredRow,
  looksLikeBynyParentSep,
  looksLikeBynySickDiagnosis,
  normalizePenjaminFilters,
  normalizeParamedisDisplay,
  roomLabelMatchesSegment,
  stripRoomRolePrefix,
} from './logic/names.js';
import {
  findPaidPaymentCandidates,
  findVerifiedPaymentCandidates,
  selectKunjunganPaymentCandidates,
} from './logic/selection.js';
import {
  buildSepResultFromKnownSep,
  matchSepFromHistory,
  resolveJenisSepPasien,
  type SepResult,
} from './logic/sep.js';
import {
  buildRoomDayAssignments,
  getRoomGroupDateRange,
  normalizeRoomStays,
} from './logic/rooms.js';
import {
  evaluateTitipanForRoomRow,
  extractSepClassKey,
  resolveSepClassKey,
  type TitipanEvaluation,
} from './logic/careClass.js';
import {
  deriveIgdSourceSignal,
  detectGroupOriginFromRows,
  buildSkippedOriginInfo,
  extractSepKeysFromRoomRows,
  type IgdSourceSignal,
  type OriginInfo,
} from './logic/origin.js';
import {
  checkMissingIgdDepoOrObatForVerification,
  collectBankDarahBlockers,
  collectCathlabBlockers,
  findHangingRelatedTransactions,
  isGiziPenunjangBlocker,
  normalizePenunjangBlocker,
  penunjangBlockerLabel,
} from './logic/blockers.js';
import { RunAlerts } from './logic/alerts.js';
import {
  DEFAULT_OBAT_KD_TINDAKAN,
  buildBiayaObatDetailEntry,
  buildHistoryObatEntry,
  matchHistoryObatToBiayaRows,
  sortHistoryObatEntries,
} from './logic/obat.js';
import {
  DIRECT_HASIL_MAX_PAGES,
  DIRECT_HASIL_ROWS_PER_PAGE,
  collectDirectHasilRowsForGroup,
  collectPenunjangHistories,
  collectPenunjangValidationCandidates,
  filterHistoryRowsForDateRange,
  validateHasilElektromedik,
  validateHasilLaboratoriumPk,
  validateHasilPa,
  validateHasilRadiologi,
  validatePenunjangResultsForGroup,
  type PenunjangCandidate,
  type PenunjangHistories,
  type PenunjangValidation,
} from './logic/penunjangResults.js';
import { buildIbsConsistencyAlert, detectIbsBedahContext, validateIbsConsistency } from './logic/ibs.js';
import {
  collectOrderGiziTransactionsForGroup,
  planGiziBlockerRecovery,
  planOrderGiziRecovery,
  planOrderGiziSend,
  type OrderGiziTransaction,
} from './logic/gizi.js';
import {
  TINDAKAN_SYNC_ENDPOINTS,
  getKomponenParamedisName,
  pickIntermediateParamedisName,
  planTindakanSync,
  resolveExactParamedisName,
  rowAllowsDeleteByHint,
  type KomponenRowsProvider,
  type RowStatusProvider,
  type TindakanOp,
  type TindakanSyncIssue,
} from './logic/tindakanSync.js';
import {
  getSpesialisActionKey,
  getSpesialisFallbackKdUnit,
  komponenDetailKey,
  planVisiteSync,
  tindakanStatusKey,
  type VisiteIssue,
  type VisiteOp,
} from './logic/visiteSync.js';
import { buildRekapitulasiDetailHakParams, checkBalanceTotalTagihan } from './logic/balance.js';
import {
  buildTampungBayarPayload,
  evaluateTampungBayarEligibility,
} from './logic/tampungBayar.js';
import { VERIFIKASI_SUMMARY_HEADER, buildVerifikasiSummaryRow } from './logic/summary.js';
import { bulletLine, dataBlock, numberedBlock, type LogItem } from './logic/logFormat.js';

/** Input accepted by the ranap workflow — mirrors `main()`'s parameters. */
export interface RanapInput {
  noRm: string;
  patientIds?: string[];
  tanggal: string;
  toleranceDays?: number;
  acceptedPenjaminKeywords?: string[];
  /** Legacy `debug_mode`: reveals no_reg / no_trx / SEP source / gizi preflight. */
  debugMode?: boolean;
  /** Legacy `skip_verifikasi_sep`: accept a bill whose SEP could not be matched. */
  skipVerifikasiSep?: boolean;
  /** Legacy `enable_tampung_bayar`: stage the payment after verification. */
  enableTampungBayar?: boolean;
  /** Legacy `shift_pembayaran`. */
  shiftPembayaran?: string;
  /** Legacy `user_proses` — the operator credited in the summary row. */
  userProses?: string;
  /**
   * Rules-page overrides of the manual-settlement unit keywords
   * (`_collect_bank_darah_blockers` / `_collect_cathlab_blockers`). Absent
   * keeps the legacy keyword; an empty list disables that blocker.
   */
  manualBlockerUnits?: { bankDarah?: string[]; cathlab?: string[] };
  /** Rules-page override of the wards whose IBS mismatch is a review, not an error. */
  ibsManualReviewRooms?: string[];
}

/** A visit row as returned by gethistorykunjungan (subset we rely on). */
export interface VisitRow extends LegacyRow {
  no_registrasikunjungan: string;
  no_transaksi: string;
  kd_unit: string;
}

export interface RanapDeps {
  client: EvoMedisClient;
  /**
   * Base URL of the EvoMedis **v2** JSON API, when the deployment has one.
   *
   * It is passed separately because `EvoMedisClient` keeps its `Session`
   * private and silently falls back to `baseUrlV1` for a `v2` endpoint when no
   * v2 URL is configured — so calling `cppt.riwayat` on a v1-only instance
   * posts to `…/index.php/api_inap/cppt/cppt_riwayat`, which answers with a
   * CodeIgniter 404 (or the login page, which would trip `ReloginTransport`).
   * The v2 CPPT reads are therefore issued only when this is set; see
   * {@link fetchCpptV2Rows}.
   */
  baseUrlV2?: string;
  /**
   * Claim bundle reader for `check_berkas` (Node host only; absent in fixture
   * runs and in the browser, where the step reports itself unavailable).
   */
  berkas?: BerkasReaderPort;
}

const ACCEPTED_DEFAULT = ['BPJS PBI', 'BPJS NON PBI'];

/** Scratch keys, so a typo cannot silently break the hand-off between steps. */
const K = {
  input: 'input',
  alerts: 'alerts',
  visits: 'visits',
  allVisitRows: 'allVisitRows',
  sepResult: 'sepResult',
  identity: 'identity',
  kasirLines: 'kasirLines',
  elektromedik: 'elektromedik',
  roomRowsByReg: 'roomRowsByReg',
  roomDayAssignments: 'roomDayAssignments',
  /** `group_start`/`group_end` per registration (ranap_v3.py:16190-16202). */
  groupWindowByReg: 'groupWindowByReg',
  /** The pending `_sync_tgl_masuk_awal_rawat_inap` write, one per registration. */
  tglMasukSyncByReg: 'tglMasukSyncByReg',
  titipan: 'titipan',
  originByReg: 'originByReg',
  /** `igd_source_by_reg` (ranap_v3.py:16246). */
  igdSourceByReg: 'igdSourceByReg',
  /** `poli_source_candidate_by_reg` (ranap_v3.py:16245). */
  poliSourceByReg: 'poliSourceByReg',
  /** `get_listtindakan_poli_igd(poli_source)` per registration, read once. */
  poliSourceRowsByReg: 'poliSourceRowsByReg',
  /** `handled_igd_transactions` (ranap_v3.py:16249). */
  handledIgdTrx: 'handledIgdTrx',
  /** `used_elektromedik_trx` (ranap_v3.py:16248). */
  usedElektromedikTrx: 'usedElektromedikTrx',
  listTindakanByTrx: 'listTindakanByTrx',
  penunjangHistories: 'penunjangHistories',
  /** `_build_rekapitulasi_detail_hak_params` per registration, built once. */
  rekapParamsByReg: 'rekapParamsByReg',
  /** `rekapitulasi_detail_hak_html` per registration, read once and shared. */
  rekapHtmlByReg: 'rekapHtmlByReg',
  /** `order_items` + `getdataordergizi` snapshot per registration, for recovery. */
  giziOrdersByReg: 'giziOrdersByReg',
  grandTotal: 'grandTotal',
  /**
   * `no_registrasikunjungan` → that registration's own `verdict.kasirTotal`.
   *
   * The legacy summary row prints the total for *that* registration
   * (`_emit_verifikasi_summary_tsv` + `cek_balance_total_tagihan`), so a
   * run-wide max would print one registration's money on another's row.
   */
  grandTotalByReg: 'grandTotalByReg',
  /** `_get_penunjang_keterangan_for_summary(reg)` — per registration, not run-wide. */
  summaryKeteranganByReg: 'summaryKeteranganByReg',
  /** `_BYNY_RME_STATUS_CACHE` / `byny_rme_status_by_reg`, keyed by registration. */
  bynyRmeCache: 'bynyRmeCache',
  /** `_RME_SINGLE_INFO_CACHE` — `rme/ri_rme/get_single_id` per registration. */
  rmeSingleByReg: 'rmeSingleByReg',
  /** Non-gizi penunjang blocker label per registration, keyed by reg. */
  penunjangBlockerByReg: 'penunjangBlockerByReg',
  /** Endpoint ids whose read came back as an error, with a count. */
  readFailures: 'readFailures',
  /** Registrations `execute_verifikasi` actually proposed a verification for. */
  plannedVerificationRegs: 'plannedVerificationRegs',
  /**
   * `no_registrasikunjungan` → the id of the `verifikator.simpanVerifikasi`
   * plan proposed for it. `emit_summary` looks the outcome up in
   * `ctx.mutations` so a row is emitted only for a verification that really
   * landed (`if verified`, ranap_v3.py:16828).
   */
  verificationPlanByReg: 'verificationPlanByReg',
  /** The latest Lab PK write proposed per `lab|poli` pair, for process_poli re-plan passes. */
  labPkPlanByPair: 'labPkPlanByPair',
  /**
   * `_tampung_pelaksana_checked`'s retry ladder, carried across re-plan passes.
   *
   * `pelaksanaPlanByLine`: charge line + component → the id of the
   * `poliklinik.tampungPelaksana` plan the last pass proposed for it. A later
   * pass looks that id up in `ctx.mutations`; a `failed` outcome is the port's
   * reading of "the write did not stick" (ranap_v3.py:4499-4521).
   *
   * `pelaksanaEscalated`: lines whose intermediate-then-desired sequence has
   * already been proposed. This is `allow_intermediate_retry=False` on the two
   * inner calls (ranap_v3.py:4546, 4580) — the ladder is climbed once, never
   * recursively.
   */
  pelaksanaPlanByLine: 'pelaksanaPlanByLine',
  pelaksanaEscalated: 'pelaksanaEscalated',
  /**
   * Registrations a `verifikator.batalVerifikasi` plan has already been proposed
   * for, so a second pass does not reopen the same bill twice
   * (`_ensure_tindakan_belum_terverifikasi` calls it once per registration).
   */
  batalVerifikasiByReg: 'batalVerifikasiByReg',
  /** `_HISTORY_OBAT_ENRICHED_CACHE` — the enriched pharmacy orders, read once. */
  historyObatEntries: 'historyObatEntries',
  /** `_VERIFIKATOR_DETAIL_TRANSAKSI_CACHE`, keyed `no_referensi|kd_tindakan`. */
  biayaObatDetailCache: 'biayaObatDetailCache',
  /** `_EVO_V2_TIMELINE_CACHE` — the v2 patient timeline, keyed by medrec. */
  cpptV2TimelineByRm: 'cpptV2TimelineByRm',
} as const;

// ── scratch helpers ──────────────────────────────────────────────

function getScratch<T>(ctx: ExecutorContext, key: string): T | undefined {
  return ctx.scratch[key] as T | undefined;
}

function scratchRecord<T>(ctx: ExecutorContext, key: string): Record<string, T> {
  return (ctx.scratch[key] ??= {}) as Record<string, T>;
}

function scratchSet(ctx: ExecutorContext, key: string): Set<string> {
  return (ctx.scratch[key] ??= new Set<string>()) as Set<string>;
}

function inputOf(ctx: ExecutorContext): RanapInput {
  return getScratch<RanapInput>(ctx, K.input) ?? (ctx.input as RanapInput);
}

function isDebug(ctx: ExecutorContext): boolean {
  return inputOf(ctx)?.debugMode === true;
}

/**
 * The run's tolerance window, in days.
 *
 * `main()` clamps the operator's value once (`_clamp_tolerance_days`,
 * ranap_v3.py:15675) and then passes it to **every** date comparison —
 * `detect_group_origin_from_inap` (16268),
 * `log_transaksi_terkait_menggantung` (16541), and both blocker collectors
 * (16549, 16573). The `7` in those signatures is only a Python default;
 * hard-coding it here scanned ±7 days on a run configured for ±3 and pulled
 * unrelated visits in as hanging transactions or CATHLAB blockers.
 */
function toleranceOf(ctx: ExecutorContext): number {
  return clampToleranceDays(inputOf(ctx)?.toleranceDays ?? 3);
}

/** The run's alert registry — the port of the legacy module-level dicts. */
function alertsOf(ctx: ExecutorContext): RunAlerts {
  let alerts = getScratch<RunAlerts>(ctx, K.alerts);
  if (!alerts) {
    alerts = new RunAlerts();
    ctx.scratch[K.alerts] = alerts;
  }
  return alerts;
}

/**
 * Read failures, recorded so a step cannot report a clean verdict it never
 * earned.
 *
 * `softJson`/`softText` swallow the error the way the legacy `try/except` does,
 * but the legacy script prints the exception and its caller registers a sync
 * issue; a silently-empty read here used to be indistinguishable from a genuinely
 * empty answer. `validate_penunjang` in particular reported
 * "Hasil penunjang lengkap (0 pemeriksaan diperiksa)" when all four history
 * reads had failed.
 */
function recordReadFailure(ctx: ExecutorContext, endpointId: string): void {
  const failures = scratchRecord<number>(ctx, K.readFailures);
  failures[endpointId] = (failures[endpointId] ?? 0) + 1;
}

/** Which of `endpointIds` failed at least once during this run. */
function failedReads(ctx: ExecutorContext, ...endpointIds: readonly string[]): string[] {
  const failures = scratchRecord<number>(ctx, K.readFailures);
  return endpointIds.filter((id) => (failures[id] ?? 0) > 0);
}

/**
 * `byny_rme_status_by_reg.get(reg, {})` (ranap_v3.py:16218, 16843).
 *
 * `getBynyRmeStatus` already memoizes per registration, which is exactly the
 * Python's per-reg dict; reading it back here is what keeps the newborn marker
 * on the newborn's own registration instead of smearing one run-wide value
 * across every row.
 */
function bynyRmeStatusFor(ctx: ExecutorContext, reg: string): BynyRmeStatus | undefined {
  return scratchRecord<BynyRmeStatus>(ctx, K.bynyRmeCache)[reg.trim()];
}

function visitsOf(ctx: ExecutorContext): LegacyRow[] {
  return getScratch<LegacyRow[]>(ctx, K.visits) ?? [];
}

function roomGroupsOf(ctx: ExecutorContext): Record<string, LegacyRow[]> {
  return getScratch<Record<string, LegacyRow[]>>(ctx, K.roomRowsByReg) ?? {};
}

function primaryVisit(ctx: ExecutorContext): LegacyRow | undefined {
  return visitsOf(ctx)[0];
}

/** Emit a multi-line log block, one event per line so ordering is preserved. */
function emit(ctx: ExecutorContext, lines: readonly string[], severity: IssueSeverity | 'debug' = 'info'): void {
  for (const line of lines) ctx.log(line, severity);
}

function splitPatientIds(input: RanapInput): string[] {
  const ids = input.patientIds?.length ? input.patientIds : (input.noRm ?? '').split(/[\n,]+/);
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

/**
 * The medrec form the endpoints want. `main()` normalises `no_rm` before its
 * first read and passes the canonical `0-12-34-56` everywhere; only the first id
 * of a sweep goes through `normalizeInput`, so the rest have to be canonicalised
 * here or the history read asks for a medrec the backend does not have. An id
 * that cannot be normalised is passed through unchanged — `normalizeInput`
 * already failed the run for the first one, and refusing the others here would
 * turn a typo in a batch into a dead step instead of an empty history.
 */
function normalizedMedrec(patientId: string): string {
  try {
    return normalizeNoRmInput(patientId);
  } catch {
    return patientId;
  }
}

// ── step results ─────────────────────────────────────────────────

function ok(summary: string, extra?: Partial<StepResult>): StepResult {
  return { status: 'success', summary, ...extra };
}
function fail(summary: string): StepResult {
  return { status: 'failed', summary };
}
function blocked(summary: string, extra?: Partial<StepResult>): StepResult {
  return { status: 'blocked', summary, ...extra };
}
function skipped(summary: string): StepResult {
  return { status: 'skipped', summary };
}
/** Attach the operator checklist (see workflow-core `reasoning.ts`) to a result. */
function reasoned(result: StepResult, title: string, items: ReasoningItem[]): StepResult {
  return items.length ? { ...result, evidence: [...(result.evidence ?? []), reasoningEvidence({ title, items })] } : result;
}

const visitLabel = (row: LegacyRow): string =>
  `${str(row, 'nama_unit') || 'Kunjungan'} · masuk ${str(row, 'tgl_masuk') || '-'}`;

function review(summary: string, extra?: Partial<StepResult>): StepResult {
  return { status: 'needs_review', summary, ...extra };
}
function planResult(summary: string, plans: MutationPlan[]): StepResult {
  if (plans.length === 0) return skipped(summary);
  return { status: 'needs_review', summary, proposedMutations: plans };
}

function warning(code: string, message: string, severity: IssueSeverity = 'warn'): WorkflowIssue {
  return { code, message, severity };
}

/** The argument triple of every per-line-item tindakan check. */
interface TindakanLineKey {
  no_transaksi: string;
  kd_tindakan: string;
  urut_tindakan: string;
}

/** The three fields the cashier's order guards are addressed by. */
interface KasirOrderKey {
  no_registrasikunjungan: string;
  no_transaksi: string;
  kd_unit: string;
}

interface LabPkTransferKey {
  noTransaksiLab: string;
  noTransaksipoli: string;
}

function labPkPayload(key: LabPkTransferKey): Record<string, string> {
  return { no_transaksi: key.noTransaksiLab, no_transaksipoli: key.noTransaksipoli };
}

function labPkListPayload(key: LabPkTransferKey): Record<string, string> {
  return { ...labPkPayload(key), rujukan: 'false', rujukan_keluar: 'false' };
}

/**
 * The read-before-write guards, one factory per legacy check.
 *
 * Each plan below carries the guards that actually protect *its* endpoint. A
 * plan stamped with an unrelated precondition is worse than no precondition at
 * all: it reads as a control that was verified when it never applied. The
 * transaction-level `kasir.cekstatus_verifikasi` in particular guards the
 * cashier's own writes, not the per-line-item tindakan writes.
 *
 * Every entry is a **function of its own request body**, not a constant. The
 * mutation gate falls back to the plan's write payload when a check declares
 * none (`resolveRequest`, `apps/orchestrator/src/mutationGate.ts`), and for a
 * per-line-item read that fallback silently under-addresses: `cekstatus_verifikasi`
 * wants `(no_transaksi, kd_tindakan, urut_tindakan)` and an under-addressed read
 * can answer empty, which reads as a pass. So `payload` is set explicitly on
 * every check, including the GET ones — the gate moves a GET's body into the
 * query string for us.
 *
 * `match` is likewise explicit wherever inference would be wrong or merely
 * lucky. Two traps, both confirmed against `expectations.ts`: `expected: {total: 0}`
 * infers `subset` and then *refuses* the bare `{}` a clean registration returns,
 * while `expected: {}` infers `subset` over no keys and *holds* even when a
 * blocker is present. Every "nothing here" guard therefore says `match: 'empty'`.
 */
const PRECONDITION = {
  /** `_ensure_tindakan_belum_terverifikasi` (ranap_v3.py:12286) — per line item. */
  tindakanBelumTerverifikasi: (line: TindakanLineKey): Precondition => ({
    description: 'Tindakan belum terverifikasi (dicek per baris tindakan)',
    check: 'penatajasaInap.cekStatusVerifikasi',
    expected: '0',
    // `str(...).strip() in ("", "0")` — both spellings mean "not yet".
    match: 'empty',
    payload: { ...line },
  }),
  /**
   * The mirror image, and the guard on the *un*-verification.
   *
   * `_ensure_tindakan_belum_terverifikasi` only reaches `batal_verifikasi` when
   * `cekstatus_verifikasi_tindakan` came back outside `("", "0")`
   * (ranap_v3.py:12293-12300). Reopening a bill whose line is *already*
   * unverified would be a write with no reason, so the plan refuses itself.
   * `nonEmpty` is the exact negation the legacy uses: the comparator reads `''`,
   * `'0'`, `'-'` and `'false'` as "not set".
   */
  tindakanMasihTerverifikasi: (line: TindakanLineKey): Precondition => ({
    description: 'Baris tindakan masih terverifikasi (batal verifikasi hanya untuk baris terverifikasi)',
    check: 'penatajasaInap.cekStatusVerifikasi',
    expected: '1',
    match: 'nonEmpty',
    payload: { ...line },
  }),
  /** `_boleh_hapus_tindakan`'s payment check (ranap_v3.py:12325) — per line item. */
  tindakanBelumDibayar: (line: TindakanLineKey): Precondition => ({
    description: 'Tindakan belum dibayar (dicek per baris tindakan)',
    check: 'penatajasaInap.cekStatusBayar',
    expected: '0',
    match: 'empty',
    payload: { ...line },
  }),
  /**
   * The poli/IGD controller's own guards (`_boleh_hapus_tindakan_poli_igd`,
   * ranap_v3.py:12651). Two of the three are per line item; the verification one
   * is **not** — `cekstatus_verifikasi_poli_igd` (ranap_v3.py:3965) takes a bare
   * `no_transaksipoli`, so addressing it per row would send a field the
   * controller does not read.
   */
  tindakanPoliBelumTerverifikasi: (poliTrx: string): Precondition => ({
    description: 'Transaksi poliklinik belum terverifikasi',
    check: 'poliklinik.cekStatusVerifikasi',
    expected: '0',
    match: 'empty',
    payload: { no_transaksipoli: poliTrx },
  }),
  tindakanPoliBelumDibayar: (line: TindakanLineKey): Precondition => ({
    description: 'Tindakan poliklinik belum dibayar (per baris tindakan)',
    check: 'poliklinik.cekStatusBayar',
    expected: '0',
    match: 'empty',
    payload: { ...line },
  }),
  tindakanPoliBelumDitransfer: (line: TindakanLineKey): Precondition => ({
    description: 'Tindakan poliklinik belum ditransfer (per baris tindakan)',
    check: 'poliklinik.cekStatusTransfer',
    expected: '0',
    match: 'empty',
    payload: { ...line },
  }),
  tindakanPoliSudahDitransfer: (line: TindakanLineKey): Precondition => ({
    description: 'Tindakan poliklinik masih ditransfer (reset hanya jika transfer masih aktif)',
    check: 'poliklinik.cekStatusTransfer',
    expected: '1',
    match: 'nonEmpty',
    payload: { ...line },
  }),
  /** `cek_status_order_poli_igd` must answer empty (ranap_v3.py:9204). */
  igdOrderSelesai: (igdTrx: string): Precondition => ({
    description: 'Tidak ada order IGD yang belum selesai',
    check: 'poliklinik.cekStatusOrder',
    expected: '',
    match: 'empty',
    payload: { no_transaksi: igdTrx },
  }),
  /** `cek_jumlah_transfer_igd` must be non-empty (ranap_v3.py:9233). */
  igdBiayaTransferAda: (igdTrx: string): Precondition => ({
    description: 'Biaya transfer IGD terbaca (bukan kosong)',
    check: 'poliklinik.cekJumlahTransfer',
    expected: '> 0',
    match: 'nonEmpty',
    payload: { no_transaksi: igdTrx },
  }),
  /** `cek_status_bayar_elektromedik` must be falsy (ranap_v3.py:6313). */
  elektromedikBelumDibayar: (trx: string): Precondition => ({
    description: 'Tagihan elektromedik belum dibayar',
    check: 'elektromedik.cekStatusBayar',
    expected: '0',
    match: 'empty',
    payload: { no_transaksi: trx },
  }),
  /** `cekstatusbayar_transfer_laboratorium_pk` before resetting a Lab PK transfer. */
  labPkMasihTransfer: (key: LabPkTransferKey): Precondition => ({
    description: 'Lab PK masih terbaca transfer',
    check: 'laboratorium.cekStatusBayarTransfer',
    expected: '1',
    match: 'nonEmpty',
    payload: { no_transaksi: key.noTransaksiLab },
  }),
  labPkTransferMasihAktif: (key: LabPkTransferKey): Precondition => ({
    description: 'Lab PK masih terbaca transfer ke tagihan tujuan',
    check: 'laboratorium.cekStatusTransfer',
    expected: '1',
    match: 'nonEmpty',
    payload: labPkPayload(key),
  }),
  labPkParentPoliMasihTransfer: (key: LabPkTransferKey): Precondition => ({
    description: 'Transaksi tujuan Lab PK masih terbaca menerima transfer',
    check: 'laboratorium.cekStatusTransferPoliTujuan',
    expected: '1',
    match: 'nonEmpty',
    payload: { no_transaksipoli: key.noTransaksipoli },
  }),
  /** `cektransaksiterbuka_laboratorium_pk` must still say the lab transaction is closed before reopening. */
  labPkPerluBuka: (noTransaksiLab: string): Precondition => ({
    description: 'Transaksi Lab PK masih perlu dibuka',
    check: 'laboratorium.cekTransaksiTerbuka',
    expected: '0',
    match: 'empty',
    payload: { no_transaksi: noTransaksiLab },
  }),
  /** `cektutuptransaksi_laboratorium_pk` must still say the lab transaction is not closed before closing. */
  labPkPerluTutup: (noTransaksiLab: string): Precondition => ({
    description: 'Transaksi Lab PK belum siap transfer',
    check: 'laboratorium.cekTutupTransaksi',
    expected: '0',
    match: 'empty',
    payload: { no_transaksi: noTransaksiLab },
  }),
  labPkBelumTransfer: (key: LabPkTransferKey): Precondition => ({
    description: 'Lab PK belum terbaca transfer ke tagihan tujuan',
    check: 'laboratorium.cekStatusTransfer',
    expected: '0',
    match: 'empty',
    payload: labPkPayload(key),
  }),
  /** `transfer_lab` is only posted once a closed lab bill and non-empty total are visible. */
  labPkSiapTransfer: (key: LabPkTransferKey): Precondition[] => [
    {
      description: 'Transaksi Lab PK sudah tutup',
      check: 'laboratorium.cekTutupTransaksi',
      expected: '1',
      match: 'nonEmpty',
      payload: { no_transaksi: key.noTransaksiLab },
    },
    {
      description: 'Biaya transfer Lab PK terbaca',
      check: 'laboratorium.getTotal',
      expected: '> 0',
      match: 'nonEmpty',
      payload: labPkListPayload(key),
    },
    {
      description: 'Lab PK belum terbaca transfer ke tagihan tujuan',
      check: 'laboratorium.cekStatusTransfer',
      expected: '0',
      match: 'empty',
      payload: labPkPayload(key),
    },
  ],
  /**
   * `cek_jadwal_gizi` (ranap_v3.py:15167). The legacy accepts `""` **or** `"1"`;
   * this asks for `"1"` only, which is the stricter half — an unreadable
   * schedule refuses the send rather than assuming the kitchen can still take it.
   */
  giziJadwalTersedia: (orderTrx: string): Precondition => ({
    description: 'Jadwal order gizi masih dapat dikirim',
    check: 'penatajasaInap.cekJadwalGizi',
    expected: '1',
    match: 'equals',
    payload: { no_order: orderTrx },
  }),
  /** `getdataordergizi` must still return rows (ranap_v3.py:15232). */
  giziDetailMasihAda: (orderTrx: string, noRm: string): Precondition => ({
    description: 'Detail order gizi masih ada (bukan sudah terhapus)',
    check: 'penatajasaInap.getDataOrderGizi',
    expected: '> 0 baris',
    match: 'nonEmpty',
    payload: { no_transaksi: orderTrx, nomedrec: noRm, page: '1', rows: '50' },
  }),
  /** `cekstatus_keluar_verifikator` (ranap_v3.py:4998) — patient discharged. */
  sudahKeluar: (reg: string): Precondition => ({
    description: 'Pasien sudah keluar (status keluar terkonfirmasi)',
    check: 'verifikator.cekStatusKeluar',
    expected: 'SUDAH KELUAR',
    match: 'contains',
    payload: { no_registrasikunjungan: reg },
  }),
  /** `cektransaksi_penunjang_verifikator` (ranap_v3.py:4990) — no blocker left. */
  tidakAdaBlockerPenunjang: (reg: string): Precondition => ({
    description: 'Tidak ada blocker transaksi penunjang',
    check: 'verifikator.cekTransaksiPenunjang',
    expected: 'tidak ada blocker',
    match: 'empty',
    payload: { no_registrasikunjungan: reg },
  }),
  /** `verified and balanced` (ranap_v3.py:16855) — staged only AFTER verifying. */
  transaksiSudahTerverifikasi: (trx: string): Precondition => ({
    description: 'Transaksi sudah terverifikasi (tampung bayar hanya setelah verifikasi)',
    check: 'kasir.cekStatusVerifikasi',
    expected: '1',
    match: 'equals',
    payload: { no_transaksi: trx },
  }),
  /**
   * The guard for an **add**. `tambah_tindakan_polis` (ranap_v3.py:4173) has no
   * per-line guard of its own — there is no line yet — so the control that
   * matters is the one `reject_verified` applied at the start of the run: the
   * transaction must still be unverified, or the add lands on a closed bill.
   */
  transaksiBelumTerverifikasi: (trx: string): Precondition => ({
    description: 'Transaksi belum terverifikasi (tindakan baru hanya boleh masuk bill terbuka)',
    check: 'kasir.cekStatusVerifikasi',
    expected: '0',
    match: 'empty',
    payload: { no_transaksi: trx },
  }),
  /** `cek_order_belum_terlayani.total == 0` (ranap_v3.py:3768). */
  tidakAdaOrderBelumTerlayani: (key: KasirOrderKey): Precondition => ({
    description: 'Tidak ada order yang belum terlayani',
    check: 'kasir.cekOrderBelumTerlayani',
    expected: 0,
    match: 'empty',
    payload: { ...key },
  }),
  /** `cek_order_belum_transfer.total == 0` (ranap_v3.py:3783). */
  tidakAdaOrderBelumTransfer: (key: KasirOrderKey): Precondition => ({
    description: 'Tidak ada order yang belum ditransfer',
    check: 'kasir.cekOrderBelumTransfer',
    expected: 0,
    match: 'empty',
    payload: { ...key },
  }),
  /** `gethistory_pembayaran_kasir` must still be empty (ranap_v3.py:3799). */
  belumAdaRiwayatPembayaran: (reg: string, trx: string): Precondition => ({
    description: 'Belum ada riwayat pembayaran',
    check: 'kasir.getHistoryPembayaran',
    expected: [],
    match: 'empty',
    // A GET: the gate copies this body into the query string.
    payload: { no_registrasikunjungan: reg, no_transaksi: trx },
  }),
} as const;

/**
 * Build a mutation plan.
 *
 * `payload` is the **exact form body** the endpoint is called with, and it is
 * what makes a plan executable at all: `applyApprovedMutation`
 * (`apps/orchestrator/src/mutationGate.ts`) refuses a plan without one, because
 * sending the human-facing `payloadSummary` to a mutating endpoint would write
 * the wrong thing. A plan that deliberately carries no `payload` is review-only
 * and must say why at its site.
 *
 * `preconditions` and `readAfterWriteChecks` are **enforced**, not merely
 * recorded: the gate re-reads every `Precondition.check` through the client at
 * the moment the write is about to fire and refuses it with
 * `mutation.invalidated` if any no longer holds, then re-reads every
 * verification rule and emits `mutation.verified` or `mutation.failed`. A check
 * that cannot be evaluated — read threw, endpoint unknown, nothing to address
 * the read with — fails closed. That is why every check here carries its own
 * `payload` and, where inference would be wrong, its own `match`.
 *
 * `id` and `idempotencyKey` carry the emitting node and the plan's index within
 * it: `sync_tindakan` and `sync_visite` both propose `penatajasaInap.updateTgl`
 * for the same `no_transaksi`, and `recover_gizi` can propose several
 * `hapusDetailOrderGizi` for one order, so endpoint + transaction alone is not
 * unique within a run.
 *
 * A re-plan pass (`ctx.pass > 1`) additionally stamps the pass number, because
 * a second pass re-runs the *same* node and would otherwise re-mint an id the
 * first pass already used. The reducer refuses to reseed a plan id it has seen
 * (`seedMutation`), so a colliding id would show pass 2's plan wearing pass 1's
 * settled outcome — and the re-plan barrier would read it as already applied.
 * Pass 1 ids are left exactly as they were.
 */
function mutationPlan(
  ctx: ExecutorContext,
  opts: {
    /** The workflow node emitting the plan — part of the idempotency key. */
    node: string;
    /** The plan's index within that node — part of the idempotency key. */
    index: number;
    endpointId: string;
    riskLevel: MutationPlan['riskLevel'];
    reason: string;
    /** The guards that really protect this endpoint; `[]` when the legacy write has none. */
    preconditions: readonly Precondition[];
    /** The request body. Omit **only** with a `ponytail:` note saying why. */
    payload?: Record<string, string>;
    payloadSummary?: Record<string, unknown>;
    trx?: string;
    /** Read-after-write rules, as a conjunction — all must hold. */
    readAfterWriteChecks?: readonly VerificationRule[];
  },
): MutationPlan {
  const trx = opts.trx ?? str(primaryVisit(ctx), 'no_transaksi') ?? 'unknown';
  const pass = ctx.pass > 1 ? `pass${ctx.pass}:` : '';
  const key = `${ctx.runId}:${pass}${opts.node}:${opts.index}:${opts.endpointId}:${trx}`;
  return {
    id: key,
    endpointId: opts.endpointId,
    riskLevel: opts.riskLevel,
    reason: opts.reason,
    preconditions: [...opts.preconditions],
    payloadSummary: opts.payloadSummary ?? { no_transaksi: trx },
    requiresApproval: true,
    idempotencyKey: key,
    ...(opts.payload ? { payload: opts.payload } : {}),
    ...(opts.readAfterWriteChecks && opts.readAfterWriteChecks.length > 0
      ? { readAfterWriteChecks: [...opts.readAfterWriteChecks] }
      : {}),
  };
}

// ── write bodies, copied field-for-field from `ranap_v3.py` ──────
//
// The key names are inconsistent on purpose: `No_Transaksi_Poli` for an add,
// `No_Transaksi` for a pelaksana, bare `no_transaksi` for a delete. They are the
// CodeIgniter controllers' own field names and a "tidied" spelling is silently
// dropped by the backend.

/**
 * `update_tgl_tindakan_inap` (ranap_v3.py:4707), for **one** row.
 *
 * The Python batches: it re-dates a whole list in a single POST, joining the
 * three per-row fields with the literal separator `','` (so three rows arrive as
 * `A','B','C`). This port emits **one plan per row** instead. The wire shape is
 * identical — a single-row call is the same body with one value and no
 * separator — and splitting buys two things the batch cannot have: an approver
 * can refuse one line without refusing the day, and each plan can carry the
 * per-line-item `cekstatus_verifikasi`/`cekstatusbayar` guards that actually
 * protect it (a batched plan would have to repeat the same endpoint id once per
 * row, which reads as a duplicated control). `TindakanOp.batchKey` still travels
 * in `payloadSummary` so the audit trail records which rows the legacy would
 * have sent together.
 */
function updateTglInapPayload(op: {
  noTransaksi: string;
  kdTindakan: string;
  tglJam: string;
  urutTindakan: string;
  targetDatetime: string;
}): Record<string, string> {
  return {
    txttglupdate_inap: op.targetDatetime,
    no_transaksi: op.noTransaksi,
    kd_user: '',
    kd_tindakan: op.kdTindakan,
    tgl_jam: op.tglJam,
    urut_tindakan: op.urutTindakan,
  };
}

/** `update_tgl_tindakan_poli_igd` (ranap_v3.py:4076), for one row. */
function updateTglPoliPayload(op: {
  noTransaksi: string;
  kdTindakan: string;
  urutTindakan: string;
  targetDatetime: string;
}): Record<string, string> {
  return {
    txtupdatetgl_poli: op.targetDatetime,
    no_transaksi: op.noTransaksi,
    kd_user: '',
    kd_tindakan: op.kdTindakan,
    urut_tindakan: op.urutTindakan,
  };
}

/** `batal_transfer_tagihan_igd` (ranap_v3.py:6350), used for POLI sources too. */
function batalTransferPoliPayload(noTransaksi: string, kdUnit: string): Record<string, string> {
  return {
    no_transaksipoli: noTransaksi,
    no_transaksi: noTransaksi,
    kd_unit: kdUnit,
  };
}

/** `transfer_tagihan_igd` (ranap_v3.py:6392), despite the name, also transfers POLI source bills. */
function transferIgdPayload(op: {
  noTransaksi: string;
  noTransaksiPoli: string;
  kdUnitPoli: string;
  kdDetkelpenjamin: string;
  biaya: string;
  kdUnit: string;
  kdTindakan: string;
}): Record<string, string> {
  return {
    no_transaksi: op.noTransaksi,
    no_transaksipoli: op.noTransaksiPoli,
    kd_unit_poli: op.kdUnitPoli,
    Kd_DetKelPenjamin: op.kdDetkelpenjamin,
    biaya: op.biaya,
    kd_unit: op.kdUnit,
    kd_tindakan: op.kdTindakan,
  };
}

/** `hapus_tindakan_inap` (ranap_v3.py:4787). `alasan_batal` is always `"1"`. */
function hapusTindakanPayload(op: {
  noTransaksi: string;
  kdTindakan: string;
  tglJam: string;
  urutTindakan: string;
}): Record<string, string> {
  return {
    no_transaksi: op.noTransaksi,
    kd_tindakan: op.kdTindakan,
    Kd_Alasan_Batal_Transaksi: '1',
    tgl_jam: op.tglJam,
    urut_tindakan: op.urutTindakan,
  };
}

/** Shared fields of `tambah_tindakan_polis` and its verifikator twin. */
interface TambahTindakanArgs {
  noTransaksi: string;
  kdParamedis: string;
  kdDetkelpenjamin: string;
  kdTindakan: string;
  kdUnit: string;
  harga: string;
  kdKamar: string;
}

/** `tambah_tindakan_polis` (ranap_v3.py:4173). */
function tambahTindakanPolisPayload(op: TambahTindakanArgs): Record<string, string> {
  return {
    No_Transaksi_Poli: op.noTransaksi,
    Kd_ParaMedis_Poli: op.kdParamedis,
    Kd_DetKelPenjamin_Poli: op.kdDetkelpenjamin,
    Kd_Tindakan_Poli: op.kdTindakan,
    Kd_Unit_Poli: op.kdUnit,
    Harga_Poli: op.harga,
    pisah_klaim: '0',
    Qty_Poli: '1',
    Jumlah_Poli: op.harga,
    kd_kamar: op.kdKamar,
    tgl_mulai: '',
    tgl_selesai: '',
    durasi: '',
  };
}

/**
 * `tambah_tindakan_polis_verifikator` (ranap_v3.py:4845) — the same body minus
 * `pisah_klaim`, `tgl_mulai`, `tgl_selesai` and `durasi`. The verifikator
 * controller does not read them.
 */
function tambahTindakanVerifikatorPayload(op: TambahTindakanArgs): Record<string, string> {
  return {
    No_Transaksi_Poli: op.noTransaksi,
    Kd_ParaMedis_Poli: op.kdParamedis,
    Kd_DetKelPenjamin_Poli: op.kdDetkelpenjamin,
    Kd_Tindakan_Poli: op.kdTindakan,
    Kd_Unit_Poli: op.kdUnit,
    Harga_Poli: op.harga,
    Qty_Poli: '1',
    Jumlah_Poli: op.harga,
    kd_kamar: op.kdKamar,
  };
}

/**
 * `tampung_pelaksana_tindakan` (ranap_v3.py:4193).
 *
 * `Kd_ParaMedis` is misnamed in the backend: `_tampung_pelaksana_checked`
 * (ranap_v3.py:4477) passes the *display name* the unit's dropdown uses, not a
 * code — which is why `_resolve_exact_paramedis_name` has to snap the desired
 * name onto the registry spelling first. An empty string clears the performer,
 * which is what the DPJB and oxygen sweeps want.
 */
function tampungPelaksanaPayload(op: {
  noTransaksi: string;
  pelaksana: string;
  kdTindakan: string;
  harga: string;
  kdKomponen: string;
  urutTindakan: string;
  hargaPersen?: string;
  diskon?: string;
  nilai?: string;
}): Record<string, string> {
  return {
    No_Transaksi: op.noTransaksi,
    Kd_ParaMedis: op.pelaksana,
    Kd_Tindakan: op.kdTindakan,
    harga: op.harga,
    harga_persen: op.hargaPersen || '100',
    kd_komponen: op.kdKomponen,
    urut_tindakan: op.urutTindakan,
    diskon: op.diskon ?? '',
    nilai: op.nilai ?? '',
  };
}

function transferLabPkPayload(op: LabPkTransferKey & {
  kdUnitPoli: string;
  kdDetkelpenjamin: string;
  biaya: string;
}): Record<string, string> {
  return {
    no_transaksi: op.noTransaksiLab,
    no_transaksipoli: op.noTransaksipoli,
    kd_unit_poli: op.kdUnitPoli,
    Kd_DetKelPenjamin: op.kdDetkelpenjamin,
    biaya: op.biaya,
  };
}

// ── fetch helpers ────────────────────────────────────────────────

/**
 * A read that is allowed to come back empty. The legacy script wraps almost
 * every read in a bare `try/except` and carries on with `{}`; a missing
 * optional read must not fail the step, but it must still be visible, so the
 * reason lands in the debug log.
 */
async function softJson<T>(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  endpointId: string,
  data: Record<string, string>,
  options?: { query?: Record<string, string> },
): Promise<T | undefined> {
  try {
    return await client.postJson<T>(endpointId, data, { signal: ctx.signal, ...(options ?? {}) });
  } catch (err) {
    recordReadFailure(ctx, endpointId);
    ctx.log(`Read ${endpointId} gagal: ${err instanceof Error ? err.message : String(err)}`, 'debug');
    return undefined;
  }
}

async function softText(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  endpointId: string,
  data: Record<string, string>,
  options?: { query?: Record<string, string> },
): Promise<string> {
  try {
    return await client.postText(endpointId, data, { signal: ctx.signal, ...(options ?? {}) });
  } catch (err) {
    recordReadFailure(ctx, endpointId);
    ctx.log(`Read ${endpointId} gagal: ${err instanceof Error ? err.message : String(err)}`, 'debug');
    return '';
  }
}

/**
 * `ambil_historykunjungan_inap` (ranap_v3.py:3330) — the inpatient visit tab.
 *
 * The three empty filter fields and the `page`/`rows` pair are not optional: the
 * controller reads them off the POST body and a missing `rows` silently caps the
 * answer at the grid default, which is how a long stay loses its later rooms.
 */
function historyKunjunganInapPayload(noRm: string): Record<string, string> {
  return {
    nomedrec: noRm,
    cmbunithistory_inap: '',
    dttglmasuk1_inap: '',
    dttglmasuk2_inap: '',
    page: '1',
    rows: '200',
  };
}

/** `gethistoryilab` / `gethistory_orderpa` / `gethistoryirad` / `gethistoryiok` — one page of 50. */
/** `getdatapiutang` filter as the upload-berkas page sends it (kd_instalasi 3 ranap, 1 rajal). */
function berkasIndexPayload(noRm: string, from: string, to: string, kdInstalasi: '1' | '3'): Record<string, string> {
  return {
    kd_instalasi: kdInstalasi, kd_kelasperawatan: '', kd_ruangperawatan: '', kd_poli: '', periode: '2',
    txtperiode1_upld: from, txtperiode2_upld: to, txtnosep_upld: '', kd_penjamin: '',
    no_sep_kosong_eklaim: 'false', no_sep_tdk_kosong_eklaim: 'false', posting_sudah_eklaim: 'false', posting_belum_eklaim: 'false',
    no_medicalrecord: noRm, kd_jenis: '', reveral_bpjs: '0', page: '1', rows: '20',
  };
}

/** `YYYY-MM-DD` of a date (UTC calendar day — the run clock is UTC-stamped). */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` shifted by whole days. */
function isoDayOffset(iso: string, days: number): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
}

function historyByMedrecPayload(noRm: string): Record<string, string> {
  return { nomedrec: noRm, page: '1', rows: '50' };
}

/** Build the executor registry, closing over live dependencies. */
export function createRanapExecutors(deps: RanapDeps): ExecutorRegistry {
  const { client, baseUrlV2 } = deps;

  return {
    // ── Preflight ────────────────────────────────────────────────

    'ranap.normalizeInput': (ctx) => {
      const raw = ctx.input as RanapInput;
      const inputTitle = 'Input run diperiksa sebelum membaca SIMRS';
      if (!raw?.noRm && !raw?.patientIds?.length) return reasoned(fail('No RM wajib diisi'), inputTitle, [{ label: 'No RM diisi', ok: false, detail: 'kosong' }]);

      const patientIds = splitPatientIds(raw);
      const firstPatientId = patientIds[0];
      if (!firstPatientId) return fail('No RM wajib diisi');
      // One patient per run (ranap_v3 main() takes one medrec). Every later step
      // reads `noRm`, so extra ids would be dropped without a word.
      if (patientIds.length > 1) {
        return reasoned(fail(`Rawat inap memproses satu pasien per run; diterima ${patientIds.length} No RM`), inputTitle,
          [{ label: 'Satu No RM per run', ok: false, detail: `${patientIds.length} diisi` }]);
      }

      let noRm: string;
      try {
        noRm = normalizeNoRmInput(firstPatientId);
      } catch (err) {
        return reasoned(fail(`Input No RM tidak valid | input=${firstPatientId} | alasan=${asMessage(err)}`), inputTitle,
          [{ label: 'Format No RM valid', ok: false, detail: `${firstPatientId}: ${asMessage(err)}` }]);
      }

      let tanggal: string;
      try {
        tanggal = normalizeTanggalInput(raw.tanggal);
      } catch (err) {
        return reasoned(fail(`Input tanggal tidak valid | input=${raw.tanggal ?? '-'} | alasan=${asMessage(err)}`), inputTitle, [
          { label: 'Format No RM valid', ok: true, detail: noRm },
          { label: 'Format tanggal valid', ok: false, detail: `${raw.tanggal ?? '-'}: ${asMessage(err)}` },
        ]);
      }

      const toleranceDays = clampToleranceDays(raw.toleranceDays ?? 3);
      const accepted = normalizePenjaminFilters(raw.acceptedPenjaminKeywords ?? ACCEPTED_DEFAULT);
      const normalized: RanapInput = {
        ...raw,
        noRm,
        patientIds,
        tanggal,
        toleranceDays,
        acceptedPenjaminKeywords: accepted,
      };
      ctx.scratch[K.input] = normalized;

      emit(ctx, [
        `Proses pengerjaan billing rawat inap untuk no rm ${noRm} dimulai`,
        accepted.length > 0 ? 'Filter penjamin aktif' : 'Filter penjamin nonaktif',
        `    Accepted: ${accepted.length > 0 ? accepted.join(', ') : 'ALL'}`,
      ]);
      if (noRm !== firstPatientId) {
        ctx.log(`- No RM dinormalisasi | input=${firstPatientId} | hasil=${noRm}`, 'debug');
      }
      // `main()` reports the normalised date too (ranap_v3.py:15644-15645); only
      // the RM half of the pair was ported.
      const rawTanggal = String(raw.tanggal ?? '').trim();
      if (tanggal && tanggal !== rawTanggal) {
        ctx.log(`- Tanggal dinormalisasi | input=${rawTanggal || '-'} | hasil=${tanggal}`, 'debug');
      }

      return reasoned(ok(`${patientIds.length} medrec, ${tanggal}, toleransi ±${toleranceDays} hari`), inputTitle, [
        { label: 'Format No RM valid', ok: true, detail: noRm },
        { label: 'Format tanggal valid', ok: true, detail: tanggal },
        { label: `Toleransi tanggal ±${toleranceDays} hari`, ok: null },
        { label: 'Penjamin diterima', ok: null, detail: accepted.length > 0 ? accepted.join(', ') : 'semua' },
      ]);
    },

    'ranap.loadVisits': async (ctx) => {
      const input = inputOf(ctx);
      const debug = isDebug(ctx);
      ctx.log('Mencari kunjungan yang bisa diproses...');

      const allRows: LegacyRow[] = [];
      for (const patientId of splitPatientIds(input)) {
        const medrec = normalizedMedrec(patientId);
        // `ambil_historykunjungan` (ranap_v3.py:3322) keys on `nomedrec`, not
        // `txtmedrec` — that field name belongs to `getdatatransaksi`.
        const res = await softJson<unknown>(ctx, client, 'kasir.getHistoryKunjungan', { nomedrec: medrec });
        let rows = rowsOf(res);
        if (rows.length === 0) {
          // `main()`'s fallback: an empty kasir history still leaves the
          // inpatient tab populated for transferred-but-unbilled stays.
          const fallback = await softJson<unknown>(
            ctx,
            client,
            'penatajasaInap.getHistoryKunjunganTab',
            historyKunjunganInapPayload(medrec),
          );
          rows = rowsOf(fallback);
          if (rows.length > 0) {
            ctx.log(
              `- Fallback history rawat inap digunakan | count=${rows.length} | alasan=history kasir kosong`,
              'debug',
            );
          }
        }
        allRows.push(...rows);
      }
      ctx.scratch[K.allVisitRows] = allRows;

      const visitTitle = `Kunjungan dipilih untuk tgl ${input.tanggal} (±${input.toleranceDays} hari)`;
      if (allRows.length === 0) {
        return reasoned(skipped('Tidak ada kunjungan yang ditemukan'), visitTitle, [{ label: 'Riwayat kunjungan terbaca', ok: false, detail: 'kosong di menu kasir dan tab rawat inap' }]);
      }

      const candidates = selectKunjunganPaymentCandidates({
        rows: allRows,
        tanggal: input.tanggal,
        toleranceDays: input.toleranceDays,
        noRm: input.noRm,
        acceptedPenjaminKeywords: input.acceptedPenjaminKeywords,
      });
      ctx.scratch[K.visits] = candidates;

      if (candidates.length === 0) {
        return reasoned(skipped(`Tidak ada kunjungan yang bisa diproses dari ${allRows.length} baris history`), visitTitle, [
          { label: 'Riwayat kunjungan terbaca', ok: true, detail: `${allRows.length} baris` },
          { label: 'Kunjungan cocok tanggal & penjamin', ok: false, detail: 'tidak ada yang cocok' },
        ]);
      }

      // The spec (log spec line 6) and `_log_payment_candidates`
      // (ranap_v3.py:437) both say "bisa di payment" — this is the line the
      // ward's operators grep for, so the wording is load-bearing.
      ctx.log(`+ Ditemukan ${candidates.length} kunjungan yang bisa di payment:`);
      candidates.forEach((row, index) => {
        emit(
          ctx,
          numberedBlock(
            index + 1,
            [
              { label: 'Unit', value: str(row, 'nama_unit') },
              { label: 'Tgl masuk', value: str(row, 'tgl_masuk') },
              { label: 'No reg', value: str(row, 'no_registrasikunjungan'), debugOnly: true },
              { label: 'No trx', value: str(row, 'no_transaksi'), debugOnly: true },
              { label: 'Kd unit', value: str(row, 'kd_unit'), debugOnly: true },
              { label: 'Penjamin', value: str(row, 'nama_penjamin') },
            ],
            { debug },
          ),
        );
      });

      return reasoned(ok(`${candidates.length} kunjungan dari ${allRows.length} baris history`, {
        evidence: [
          {
            label: 'kunjungan',
            source: 'kasir.getHistoryKunjungan',
            data: { candidates: candidates.length, scanned: allRows.length },
          },
        ],
      }), visitTitle, [
        { label: 'Riwayat kunjungan terbaca', ok: true, detail: `${allRows.length} baris` },
        ...candidates.map((row) => ({ label: visitLabel(row), ok: true, detail: str(row, 'nama_penjamin') || 'penjamin -' })),
      ]);
    },

    'ranap.rejectVerified': async (ctx) => {
      const visits = visitsOf(ctx);
      if (visits.length === 0) return skipped('Tidak ada kunjungan untuk diperiksa');

      // findVerifiedPaymentCandidates is pure, so the statuses are read first.
      const statusByTrx = new Map<string, string>();
      for (const visit of visits) {
        const trx = str(visit, 'no_transaksi');
        if (!trx || statusByTrx.has(trx)) continue;
        statusByTrx.set(trx, await softText(ctx, client, 'kasir.cekStatusVerifikasi', { no_transaksi: trx }));
      }

      const verified = findVerifiedPaymentCandidates(visits, (trx) => statusByTrx.get(trx) ?? '');
      const verifiedTrx = new Set(verified.map((row) => str(row, 'no_transaksi')));
      const checks: ReasoningItem[] = visits.map((visit) => verifiedTrx.has(str(visit, 'no_transaksi'))
        ? { label: visitLabel(visit), ok: false, detail: 'sudah terverifikasi — tidak boleh diubah' }
        : { label: visitLabel(visit), ok: true, detail: 'belum terverifikasi' });
      const title = `${visits.length} kunjungan dicek status verifikasinya`;
      if (verified.length === 0) return reasoned(ok(`Tidak ada transaksi terverifikasi dari ${visits.length} kunjungan`), title, checks);

      ctx.log(
        '[WARN] Ditemukan kunjungan yang sudah terverifikasi | proses dihentikan untuk mencegah perubahan pada transaksi verified',
        'error',
      );
      const debug = isDebug(ctx);
      for (const row of verified) {
        emit(
          ctx,
          dataBlock(
            [
              { label: 'Unit', value: str(row, 'nama_unit') },
              { label: 'Tgl masuk', value: str(row, 'tgl_masuk') },
              { label: 'Status verifikasi', value: str(row, '_status_verifikasi_kasir') },
              { label: 'Catatan', value: str(row, '_is_premium_room_guard') ? 'room premium / MULTAZAM PLATINUM' : '' },
              { label: 'No reg', value: str(row, 'no_registrasikunjungan'), debugOnly: true },
              { label: 'No trx', value: str(row, 'no_transaksi'), debugOnly: true },
            ],
            { bullet: '+ Kunjungan sudah terverifikasi:', debug },
          ),
          'error',
        );
      }
      return reasoned(blocked(`${verified.length} kunjungan sudah terverifikasi`), title, checks);
    },

    'ranap.rejectPaid': async (ctx) => {
      const visits = visitsOf(ctx);
      if (visits.length === 0) return skipped('Tidak ada kunjungan untuk diperiksa');

      // `kasir.getHistoryPembayaran` is a GET: its parameters travel in the
      // query string, not a form body (see the registry entry).
      const historyByKey = new Map<string, LegacyRow[]>();
      for (const visit of visits) {
        const reg = str(visit, 'no_registrasikunjungan');
        const trx = str(visit, 'no_transaksi');
        const key = `${reg}|${trx}`;
        if (!reg || !trx || historyByKey.has(key)) continue;
        const res = await softJson<unknown>(
          ctx,
          client,
          'kasir.getHistoryPembayaran',
          {},
          { query: { no_registrasikunjungan: reg, no_transaksi: trx } },
        );
        historyByKey.set(key, rowsOf(res));
      }

      const paid = findPaidPaymentCandidates(
        visits,
        (row) => historyByKey.get(`${str(row, 'no_registrasikunjungan')}|${str(row, 'no_transaksi')}`) ?? [],
      );
      const paidKeys = new Set(paid.map((row) => `${str(row, 'no_registrasikunjungan')}|${str(row, 'no_transaksi')}`));
      const payChecks: ReasoningItem[] = visits.map((visit) => paidKeys.has(`${str(visit, 'no_registrasikunjungan')}|${str(visit, 'no_transaksi')}`)
        ? { label: visitLabel(visit), ok: false, detail: 'sudah ada riwayat pembayaran' }
        : { label: visitLabel(visit), ok: true, detail: 'belum pernah dibayar' });
      const payTitle = `${visits.length} kunjungan dicek riwayat pembayarannya`;
      if (paid.length === 0) return reasoned(ok(`Tidak ada riwayat pembayaran dari ${visits.length} kunjungan`), payTitle, payChecks);

      ctx.log(
        '[WARN] Ditemukan kunjungan yang sudah pernah ditampung bayar | proses dihentikan untuk mencegah perubahan pada transaksi yang sudah memiliki riwayat pembayaran',
        'error',
      );
      const debug = isDebug(ctx);
      for (const row of paid) {
        emit(
          ctx,
          dataBlock(
            [
              { label: 'Unit', value: str(row, 'nama_unit') },
              { label: 'Tgl masuk', value: str(row, 'tgl_masuk') },
              { label: 'Riwayat pembayaran', value: str(row, '_payment_history_count') },
              { label: 'Kwitansi terakhir', value: str(row, '_last_kwitansi') },
              { label: 'No reg', value: str(row, 'no_registrasikunjungan'), debugOnly: true },
              { label: 'No trx', value: str(row, 'no_transaksi'), debugOnly: true },
            ],
            { bullet: '+ Kunjungan sudah memiliki riwayat pembayaran:', debug },
          ),
          'error',
        );
      }
      return reasoned(blocked(`${paid.length} kunjungan sudah memiliki riwayat pembayaran`), payTitle, payChecks);
    },

    // ── SEP / billing identity ───────────────────────────────────

    'ranap.validateSep': async (ctx) => {
      const input = inputOf(ctx);
      const visits = visitsOf(ctx);
      const debug = isDebug(ctx);
      // 03- prefixed transactions are the inpatient ones; try them first.
      const ordered = [...visits].sort(
        (a, b) =>
          Number(str(b, 'no_transaksi').startsWith('03-')) - Number(str(a, 'no_transaksi').startsWith('03-')),
      );
      const anchor = ordered[0];
      if (!anchor) return skipped('Tidak ada registrasi untuk divalidasi');

      const reg = str(anchor, 'no_registrasikunjungan');
      ctx.log(`Mengambil SEP untuk transaksi: ${str(anchor, 'no_transaksi') || '-'} / unit ${str(anchor, 'nama_unit') || '-'}`);

      // Card number: no_kk from pendaftaran, falling back to the payer tab.
      //
      // `find_sep` (ranap_v3.py:6038) rejects `no_kk` on three conditions, not
      // one: empty, shorter than 9 digits, or prefixed `33`. The prefix rule is
      // what makes this work at PKU Gombong — Central Java NIKs start `33`, so a
      // `no_kk` field holding the patient's 16-digit NIK instead of a BPJS card
      // is routine, and treating it as the card number fails every such SEP
      // lookup. Only an entirely empty field was rejected before.
      const kunjungan = await softJson<LegacyRow>(ctx, client, 'pendaftaran.getDataKunjungan', {
        txtmedrec_pdft: input.noRm,
      });
      const noKk = str(kunjungan, 'no_kk');
      // One shared rule (`noKkRejectionReason`), the same one the outpatient
      // path calls — the reason string below comes from it too.
      const noKkRejected = noKkRejectionReason(noKk);
      let card: string | null;
      if (noKkRejected) {
        const penjamin = reg
          ? await softJson<LegacyRow>(ctx, client, 'pendaftaran.getDataPenjaminTab', {
              no_registrasikunjungan: reg,
            })
          : undefined;
        card = normalizeCardNumber(str(penjamin, 'no_asuransi'));
        if (noKk) {
          ctx.log(
            `- No KK diabaikan sebagai no kartu BPJS | no_kk=${noKk} | alasan=${noKkRejected} | sumber=getdatapenjamin_tab`,
            'debug',
          );
        }
      } else {
        card = normalizeCardNumber(noKk);
      }

      let result: SepResult = { sepValid: false, reason: 'No kartu BPJS kosong atau tidak ditemukan' };
      let sepRows: LegacyRow[] = [];
      if (card) {
        const raw = await softJson<unknown>(ctx, client, 'pendaftaran.getRiwayatSep', { no_kartu: card });
        // A timed-out/failed BPJS read is "unread", not "this patient has no SEP"
        // (live 2026-10-15: AbortError reported as "Tidak ada SEP tanggal …").
        if (raw === undefined) {
          return fail('Riwayat SEP BPJS tidak terbaca (timeout/gagal) — ulangi run; SEP belum dapat dinilai');
        }
        sepRows = rowsOf(raw);
        result = matchSepFromHistory({
          sepRows,
          targetDate: input.tanggal,
          expectedService: 'RITL',
          toleranceDays: input.toleranceDays,
          noKartuBpjs: card,
        });
        // The history row carries no care class on this backend (verified live
        // 2026-10-15), so every titipan evaluation read "kelas_sep_tidak_terbaca".
        // `_resolve_sep_class_key` falls back to `getdata_sep_bpjs`; read it once
        // for the matched SEP and keep ONLY its named class fields. Merging the
        // whole detail is wrong: `extractSepClassKey` takes the first class-like
        // scalar in insertion order, and the detail's `pisa: "1"` (family code)
        // would then read as KELAS 1.
        if (result.sepValid && result.sepOK && result.sepItem && !extractSepClassKey(result.sepItem)) {
          const detail = await softJson<LegacyRow>(ctx, client, 'pendaftaran.getDataSepBpjs', { no_sep: result.sepOK });
          const kelas = str(detail, 'kelas_perawatan', 'kdKelas', 'nmKelas', 'kelas_rawat', 'hak_kelas');
          if (kelas) result = { ...result, sepItem: { ...result.sepItem, kelas_perawatan: kelas } };
        }
      }

      // Two recoveries, in `main()`'s order: any 03- candidate that already
      // carries a real SEP of its own can use it, and only then may a newborn
      // (BYNY) confirmed healthy ride the mother's SEP with the requirement
      // waived. A sick newborn on BPJS still needs its own.
      if (!result.sepValid) {
        const fallback = await resolveSepFallback(ctx, client, ordered, input, result);
        if (fallback) result = fallback;
      }

      if (!result.sepValid && input.skipVerifikasiSep) {
        ctx.log(
          `[WARN] SEP tidak valid tetapi dilewati | tanggal=${input.tanggal} | alasan=skip_verifikasi_sep=True`,
          'warn',
        );
        result = {
          sepValid: true,
          sepOptional: true,
          sepOptionalReason: 'skip_verifikasi_sep',
          sepOK: '',
          sepItem: { jns_pelayanan: 'RITL', tgl_sep: input.tanggal },
          targetTanggal: input.tanggal,
          matchedTanggal: input.tanggal,
          configuredToleranceDays: input.toleranceDays,
          appliedToleranceDays: 0,
          matchType: 'skip_sep_verification',
        };
      }

      ctx.scratch[K.sepResult] = result;
      const sepItem = result.sepItem ?? {};
      emit(
        ctx,
        dataBlock(
          [
            { label: 'No kartu BPJS', value: card },
            { label: 'SEP', value: result.sepOK },
            { label: 'Jenis SEP', value: str(sepItem, 'jns_pelayanan') },
            { label: 'Diagnosa awal', value: str(sepItem, 'diagnosa_awal', 'diagnosa') },
            { label: 'No rujukan', value: str(sepItem, 'no_rujukan') },
            { label: 'PPK Pelayanan', value: str(sepItem, 'ppkPelayanan', 'ppk_pelayanan', 'ppk') },
            { label: 'Tgl SEP', value: result.matchedTanggal ?? str(sepItem, 'tgl_sep') },
            { label: 'Tgl pulang', value: str(sepItem, 'tgl_pulang') },
            { label: 'Match type', value: result.matchType, debugOnly: true },
            { label: 'Toleransi dipakai', value: result.appliedToleranceDays, debugOnly: true },
          ],
          { bullet: '+ Data:', debug },
        ),
      );

      const sepChecks: ReasoningItem[] = [
        card ? { label: 'No kartu BPJS', ok: true, detail: card } : { label: 'No kartu BPJS', ok: false, detail: 'kosong / tidak ditemukan' },
        result.sepOptional
          ? { label: 'SEP RITL', ok: null, detail: `diterima tanpa verifikasi (${result.sepOptionalReason ?? '-'})` }
          : result.sepValid
            ? { label: 'SEP RITL ditemukan', ok: true, detail: result.sepOK || '-' }
            : { label: 'SEP RITL ditemukan', ok: false, detail: result.reason ?? `tidak ada SEP RITL untuk ${input.tanggal}` },
        ...(result.sepValid && !result.sepOptional
          ? [{
            label: `Tanggal SEP sesuai ${input.tanggal}`,
            ok: true,
            detail: result.matchType === 'exact'
              ? `tepat tanggal ${result.matchedTanggal ?? ''}`.trim()
              : `tgl ${result.matchedTanggal ?? '-'} · dalam toleransi ±${result.appliedToleranceDays ?? 0} hari`,
          }]
          : []),
      ];
      const sepTitle = `Cari SEP rawat inap untuk ${input.tanggal} (toleransi ±${input.toleranceDays ?? 0} hari)`;
      if (!result.sepValid) {
        return reasoned(fail(result.reason ?? `SEP RITL tidak ditemukan untuk ${input.tanggal}`), sepTitle, sepChecks);
      }
      if (result.sepOptional) {
        return reasoned(review(`SEP opsional diterima (${result.sepOptionalReason ?? '-'})`, {
          warnings: [warning('sep_optional', `SEP diterima tanpa verifikasi: ${result.sepOptionalReason ?? '-'}`)],
        }), sepTitle, sepChecks);
      }
      return reasoned(ok(
        result.matchType === 'exact'
          ? 'SEP cocok tepat tanggal'
          : `SEP cocok dalam toleransi ${result.appliedToleranceDays ?? 0} hari`,
        { evidence: [{ label: 'sep', source: 'pendaftaran.getRiwayatSep', data: { rows: sepRows.length } }] },
      ), sepTitle, sepChecks);
    },

    'ranap.loadKasir': async (ctx) => {
      const input = inputOf(ctx);
      const visits = visitsOf(ctx);
      const debug = isDebug(ctx);
      if (visits.length === 0) return skipped('Tidak ada transaksi untuk dibaca');

      ctx.log('Mengambil data transaksi dari menu kasir untuk data awal...');

      // `main()` asks the SEP anchor first, and only then walks the 03-
      // candidates **newest first** (`sorted(..., key=_parse_datetime_flexible
      // (tgl_masuk), reverse=True)`, ranap_v3.py:15893-15897). An unparseable
      // date sorts last, matching the Python's `or datetime.min`. Picking the
      // older admission for a readmitted patient takes every identity field —
      // `no_sep`, `kd_unit`, `nama_pasien`, `nama_penjamin` — from the wrong
      // stay, and `compare_sep` then plans a SEP "correction" against it.
      const anchor = [...visits].sort(
        (a, b) =>
          Number(str(b, 'no_transaksi').startsWith('03-')) - Number(str(a, 'no_transaksi').startsWith('03-')),
      )[0];
      const fallbacks = visits
        .filter((row) => row !== anchor && str(row, 'no_transaksi').startsWith('03-'))
        .sort((a, b) => admissionTime(b) - admissionTime(a));
      const candidates = anchor ? [anchor, ...fallbacks] : fallbacks;

      let identity: LegacyRow | undefined;
      let chosen: LegacyRow | undefined;
      for (const visit of candidates) {
        // `kasir.getDataTransaksi` is dead on this backend (empty body for every
        // transaction), so the identity is assembled from the three reads that
        // answer instead — see readKasirIdentity.
        const candidate = await readKasirIdentity(ctx, client, input, visit);
        if (candidate) {
          identity = candidate;
          chosen = visit;
          break;
        }
      }

      const kasirTitle = 'Identitas tagihan dibaca dari menu kasir';
      if (!identity || !chosen) {
        return reasoned(fail(
          'Data transaksi kasir tidak terbaca | alasan=cookies/session kemungkinan sudah expired',
        ), kasirTitle, [{ label: 'Data transaksi kasir terbaca', ok: false, detail: `${candidates.length} transaksi dicoba — sesi mungkin habis` }]);
      }
      if (chosen !== anchor) {
        // ranap_v3.py:15904 — the operator has to know the identity came from a
        // different stay than the SEP lookup used.
        ctx.log(
          `- Fallback data transaksi awal digunakan | trx=${str(chosen, 'no_transaksi') || '-'} | ` +
            `reg=${str(chosen, 'no_registrasikunjungan') || '-'} | kd_unit=${str(chosen, 'kd_unit') || '-'}`,
          'debug',
        );
      }

      // `_resolve_jenis_sep_pasien` (ranap_v3.py:5630) has five inputs, not two:
      // when the kasir transaction does not already carry a recognisable jenis
      // SEP it falls back to `pendaftaran.getdata_sep_bpjs` and then to
      // `pendaftaran.getdatapenjamin_tab`. `main()` passes the registration
      // (15944) so both fallbacks are reachable. The first call below is the
      // cheap probe: `source === 'kasir'` means the kasir value settled it and
      // the Python would have returned before either read.
      const currentJenisSep = str(identity, 'jenis_sep');
      const noSepKasir = str(identity, 'no_sep');
      const regKasir = str(identity, 'no_registrasikunjungan');
      let jenisSep = resolveJenisSepPasien({ currentJenisSep, noSep: noSepKasir });
      if (jenisSep.source !== 'kasir') {
        const sepDetail = noSepKasir
          ? await softJson<LegacyRow>(ctx, client, 'pendaftaran.getDataSepBpjs', { no_sep: noSepKasir })
          : undefined;
        const penjaminTab = regKasir
          ? await softJson<LegacyRow>(ctx, client, 'pendaftaran.getDataPenjaminTab', {
              no_registrasikunjungan: regKasir,
            })
          : undefined;
        jenisSep = resolveJenisSepPasien({
          currentJenisSep,
          noSep: noSepKasir,
          ...(sepDetail ? { sepDetail } : {}),
          noRegistrasiKunjungan: regKasir,
          ...(penjaminTab ? { penjaminTab } : {}),
        });
      }
      ctx.scratch[K.identity] = { ...identity, jenis_sep: jenisSep.jenisSep, _jenis_sep_source: jenisSep.source };

      // Field order is the log spec's (lines 28-44), including where the
      // debug-only codes are interleaved: `Kd unit pasien` … `Kd paramedis`
      // between `Unit pasien` and `Nama paramedis`, and `No reg` between
      // `Penjamin` and `Nama PJ`. `No trx pasien` is a non-debug field there
      // (spec line 33) and `_log_data_block` passes it with no debug flag
      // (ranap_v3.py:15957) — only `No reg` is gated.
      emit(
        ctx,
        dataBlock(
          [
            { label: 'No RM', value: str(identity, 'no_medicalrecord') },
            { label: 'Nama pasien', value: str(identity, 'nama_pasien') },
            { label: 'Alamat pasien', value: str(identity, 'alamat') },
            { label: 'Jenis kelamin', value: str(identity, 'jenis') },
            { label: 'Tempat lahir', value: str(identity, 'tempat_lahir') },
            { label: 'No trx pasien', value: str(identity, 'no_transaksi') },
            { label: 'Unit pasien', value: str(identity, 'nama_unit') },
            { label: 'Kd unit pasien', value: str(identity, 'kd_unit'), debugOnly: true },
            { label: 'Kd instalasi', value: str(identity, 'kd_instalasi'), debugOnly: true },
            { label: 'Kd kelpenjamin', value: str(identity, 'kd_kelpenjamin'), debugOnly: true },
            { label: 'Kd paramedis', value: str(identity, 'kd_paramedis'), debugOnly: true },
            { label: 'Nama paramedis', value: str(identity, 'nama_paramedis') },
            { label: 'Penjamin', value: str(identity, 'nama_penjamin') },
            { label: 'No reg', value: regKasir, debugOnly: true },
            { label: 'Nama PJ', value: str(identity, 'nama_pg') },
            { label: 'No SEP', value: noSepKasir },
            { label: 'Jenis SEP', value: jenisSep.jenisSep },
          ],
          { bullet: '+ Data:', debug },
        ),
      );
      if (jenisSep.source && jenisSep.source !== 'kasir') {
        // ranap_v3.py:15971 — the source line the Python prints outside the block.
        ctx.log(
          `- Fallback jenis SEP pasien | source=${jenisSep.source} | value=${jenisSep.jenisSep || '-'}`,
        );
      }

      // Billing lines, per transaction — the input to every later comparison.
      // `kasir.getListTindakan` is dead on this backend; the inpatient module's
      // own list carries the same billed lines and answers reliably.
      const lines: Record<string, LegacyRow[]> = {};
      for (const visit of visits) {
        const trx = str(visit, 'no_transaksi');
        if (!trx) continue;
        const res = await softJson<unknown>(ctx, client, 'penatajasaInap.getListTindakan', {
          no_transaksi: trx,
          page: '1',
          rows: '200',
        });
        lines[trx] = rowsOf(res);
      }
      ctx.scratch[K.kasirLines] = lines;

      const total = Object.values(lines).reduce((sum, rows) => sum + rows.length, 0);
      return reasoned(ok(`${total} baris tagihan dari ${visits.length} transaksi`), kasirTitle, [
        { label: 'Data transaksi kasir terbaca', ok: true, detail: `${str(identity, 'nama_pasien') || '-'} · trx ${str(identity, 'no_transaksi') || '-'}` },
        { label: 'SEP tercatat di kasir', ok: noSepKasir ? true : null, detail: noSepKasir || 'kosong — dicek di langkah SEP' },
        { label: 'Jenis SEP', ok: null, detail: `${jenisSep.jenisSep || '-'} (sumber: ${jenisSep.source || '-'})` },
        ...Object.entries(lines).map(([trx, rows]) => ({ label: `Tindakan trx ${trx}`, ok: rows.length > 0 ? true : null, detail: `${rows.length} baris` })),
      ]);
    },

    'ranap.compareSep': (ctx) => {
      const sep = getScratch<SepResult>(ctx, K.sepResult);
      const identity = getScratch<LegacyRow>(ctx, K.identity);
      const input = inputOf(ctx);
      const debug = isDebug(ctx);
      ctx.log('Validasi SEP antara pendaftaran dengan data transaksi kasir...');

      if (!sep || !identity) return skipped('Data SEP atau identitas kasir belum tersedia');

      const sepKasir = str(identity, 'no_sep');
      const sepPendaftaran = sep.sepOK ?? '';
      const sepItem = sep.sepItem ?? {};
      const ppk = str(sepItem, 'ppkPelayanan', 'ppk_pelayanan', 'ppk');

      if (input.skipVerifikasiSep) {
        emit(ctx, dataBlock([{ label: 'Hasil', value: 'Validasi dilewati (skip_verifikasi_sep=True)' }], { bullet: '+ Hasil:', debug }));
        return skipped('Validasi SEP dilewati');
      }
      if (sep.sepOptional) {
        emit(
          ctx,
          dataBlock([{ label: 'Hasil', value: `Validasi opsional dilewati (${sep.sepOptionalReason ?? '-'})` }], {
            bullet: '+ Hasil:',
            debug,
          }),
        );
        return skipped('Validasi SEP opsional dilewati');
      }

      const items: LogItem[] = [
        { label: 'SEP kasir', value: sepKasir },
        { label: 'SEP pendaftaran', value: sepPendaftaran },
        { label: 'PPK pelayanan', value: ppk },
      ];

      const sepReg = str(identity, 'no_registrasikunjungan');
      // `ambil_datatransaksi`'s own body (ranap_v3.py:3352) — the guard and the
      // confirmation both re-read the row this plan was built from.
      const sepReadPayload = {
        txtmedrec: input.noRm,
        no_transaksi: str(identity, 'no_transaksi'),
        kd_unit: str(identity, 'kd_unit'),
        no_registrasikunjungan: sepReg,
      };

      // When `kasir.getDataTransaksi` gave no usable identity the composite
      // carries no kasir SEP. We therefore cannot confirm
      // whether the bill already carries the right SEP, so we must NOT
      // auto-plan a correction we cannot verify — surface it for review and let
      // the operator confirm in SIMRS (per the rawat-inap policy; rawat jalan
      // auto-corrects instead).
      if (sepPendaftaran && str(identity, '_sep_unreadable') === '1') {
        emit(
          ctx,
          dataBlock([...items, { label: 'Hasil', value: 'SEP kasir tidak terbaca — konfirmasi manual di SIMRS' }], { bullet: '+ Hasil:', debug }),
          'warn',
        );
        alertsOf(ctx).registerRegAlert(
          sepReg,
          'WARN',
          `SEP kasir tidak terbaca (kasir.getDataTransaksi tidak menjawab) | pendaftaran=${sepPendaftaran} — konfirmasi manual, tidak ada koreksi otomatis`,
        );
        return reasoned({
          status: 'needs_review',
          summary: `SEP kasir tidak terbaca; SEP pendaftaran ${sepPendaftaran} — konfirmasi manual di SIMRS sebelum koreksi`,
        }, 'SEP di menu kasir dibandingkan dengan SEP pendaftaran', [
          { label: 'SEP kasir terbaca', ok: false, detail: 'kasir tidak menjawab — konfirmasi manual, tidak ada koreksi otomatis' },
          { label: 'SEP pendaftaran', ok: null, detail: sepPendaftaran },
        ]);
      }

      if (sepPendaftaran && sepPendaftaran !== sepKasir) {
        emit(ctx, dataBlock([...items, { label: 'Hasil', value: 'SEP mismatch' }, { label: 'Aksi', value: 'Rencana update SEP' }], { bullet: '+ Hasil:', debug }), 'warn');
        alertsOf(ctx).registerRegAlert(
          str(identity, 'no_registrasikunjungan'),
          'WARN',
          `SEP kasir berbeda dengan pendaftaran | kasir=${sepKasir || '-'} | pendaftaran=${sepPendaftaran}`,
        );
        const correction = mutationPlan(ctx, {
            node: 'compare_sep',
            index: 0,
            endpointId: 'rekamMedis.simpanSep',
            riskLevel: 'high',
            reason: `Koreksi SEP kasir ${sepKasir || '-'} menjadi ${sepPendaftaran}`,
            // `update_sep` (ranap_v3.py:6134) has no read guard at all — it only
            // refuses an empty registration or an empty new SEP. The one thing
            // worth re-reading is that the kasir SEP is still the value this
            // plan was built against, so the correction cannot clobber someone
            // else's edit; there is no payment-history or verification guard.
            preconditions: [
              {
                description: 'SEP kasir masih bernilai lama (belum dikoreksi pihak lain)',
                check: 'kasir.getDataTransaksi',
                expected: sepKasir,
                field: 'no_sep',
                payload: sepReadPayload,
              },
            ],
            // `update_sep` (ranap_v3.py:6134) posts exactly two fields; the
            // `old_sep` it takes is only used for its own log line.
            payload: { no_registrasikunjungan: sepReg, no_sep: sepPendaftaran },
            payloadSummary: {
              no_registrasikunjungan: sepReg,
              old_sep: sepKasir,
              new_sep: sepPendaftaran,
            },
            readAfterWriteChecks: [
              {
                description: 'SEP kasir menjadi nilai baru',
                endpointId: 'kasir.getDataTransaksi',
                field: 'no_sep',
                expected: sepPendaftaran,
                payload: sepReadPayload,
              },
            ],
          });
        return reasoned(
          planResult(`SEP mismatch — rencana koreksi ke ${sepPendaftaran}`, [correction]),
          'SEP di menu kasir dibandingkan dengan SEP pendaftaran',
          [{ label: 'SEP kasir sama dengan SEP pendaftaran', ok: false, detail: `kasir ${sepKasir || '-'} ≠ pendaftaran ${sepPendaftaran} — koreksi ke ${sepPendaftaran}`, planId: correction.id }],
        );
      }

      emit(ctx, dataBlock([...items, { label: 'Hasil', value: 'SEP correct!' }], { bullet: '+ Hasil:', debug }));
      return reasoned(ok('SEP kasir sesuai dengan pendaftaran'), 'SEP di menu kasir dibandingkan dengan SEP pendaftaran',
        [{ label: 'SEP kasir sama dengan SEP pendaftaran', ok: true, detail: sepKasir || sepPendaftaran || '-' }]);
    },

    'ranap.detectByny': async (ctx) => {
      const identity = getScratch<LegacyRow>(ctx, K.identity);
      const namaPasien = str(identity, 'nama_pasien');
      const bynyTitle = 'Pasien bayi baru lahir (BYNY) dan SEP-nya';
      if (!isBynyPatient(namaPasien)) return reasoned(ok('Bukan pasien BYNY (bayi baru lahir)'), bynyTitle, [{ label: 'Pasien BYNY', ok: null, detail: 'bukan bayi baru lahir — tidak ada cek tambahan' }]);

      const reg = str(identity, 'no_registrasikunjungan');
      const status = await getBynyRmeStatus(ctx, client, reg);
      const keadaan = status.keadaan;
      const diagnosis = status.diagnosis;
      const healthy = status.is_healthy;
      const noSep = str(identity, 'no_sep');
      const parentLike = looksLikeBynyParentSep(noSep);
      // No run-wide copy: `getBynyRmeStatus` has already filed this status under
      // its own registration, which is what `byny_rme_status_by_reg` is
      // (ranap_v3.py:15764).
      const debug = isDebug(ctx);
      emit(
        ctx,
        dataBlock(
          [
            { label: 'Nama', value: namaPasien },
            { label: 'Keadaan', value: keadaan },
            { label: 'Diagnosis', value: diagnosis },
            { label: 'No SEP', value: noSep },
            {
              label: 'Catatan',
              value: parentLike ? 'SEP mengikuti orang tua' : 'SEP mandiri bayi terdeteksi',
            },
            { label: 'No reg', value: reg, debugOnly: true },
            { label: 'Single id RME', value: status.single_id, debugOnly: true },
            { label: 'Sumber status RME', value: status.reason, debugOnly: true },
          ],
          { bullet: healthy ? '+ Pasien BYNY sehat:' : '+ Pasien BYNY perlu perhatian:', debug },
        ),
        healthy ? 'info' : 'warn',
      );

      const bynyChecks: ReasoningItem[] = [
        { label: 'Bayi sehat menurut RME', ok: healthy, detail: `${keadaan || '-'}${diagnosis ? ` · ${diagnosis}` : ''}` },
        { label: 'SEP bayi', ok: healthy || !parentLike ? true : false, detail: parentLike ? 'mengikuti SEP orang tua' : 'SEP mandiri bayi' },
      ];
      if (!healthy && isBpjsPenjamin(str(identity, 'nama_penjamin')) && parentLike) {
        alertsOf(ctx).registerRegAlert(reg, 'WARN', 'Pasien BYNY sakit memerlukan SEP mandiri BPJS');
        return reasoned(review('Pasien BYNY sakit memerlukan SEP mandiri BPJS', {
          warnings: [warning('byny_sep', 'Bayi sakit dengan penjamin BPJS memerlukan SEP mandiri')],
        }), bynyTitle, bynyChecks);
      }
      return reasoned(ok(healthy ? 'Pasien BYNY sehat — SEP mengikuti orang tua' : 'Pasien BYNY perlu evaluasi SEP'), bynyTitle, bynyChecks);
    },

    'ranap.collectElektromedik': async (ctx) => {
      const input = inputOf(ctx);
      const visits = visitsOf(ctx);
      // Only visits parked in a "penunjang lain" unit carry transferable
      // elektromedik charges — the same filter `main()` applies.
      const elektromedikTrx = new Set(
        visits.filter((row) => upper(row, 'nama_unit').includes('PENUNJANG LAIN')).map((row) => str(row, 'no_transaksi')).filter(Boolean),
      );
      if (elektromedikTrx.size === 0) {
        ctx.scratch[K.elektromedik] = [];
        return reasoned(ok('Tidak ada transaksi penunjang elektromedik aktif'), 'Transaksi penunjang elektromedik (PENUNJANG LAIN)',
          [{ label: 'Ada transaksi elektromedik', ok: null, detail: 'tidak ada — langkah transfer elektromedik tidak perlu' }]);
      }

      // `get_historykunjungan_elektromedik` (ranap_v3.py:6199) keys on
      // `no_medicalrecord` and pages explicitly; `txtmedrec` is a different
      // controller's field name and returns nothing here.
      const res = await softJson<unknown>(ctx, client, 'elektromedik.getHistoryKunjungan', {
        no_medicalrecord: input.noRm,
        page: '1',
        rows: '50',
      });
      const rows = rowsOf(res).filter((row) => elektromedikTrx.has(str(row, 'no_transaksi')));
      ctx.scratch[K.elektromedik] = rows;
      ctx.log(`Mengambil history penunjang elektromedik aktif untuk no RM ${input.noRm}...`, 'debug');
      return reasoned(ok(`${rows.length} record elektromedik dari ${elektromedikTrx.size} transaksi aktif`), 'Transaksi penunjang elektromedik (PENUNJANG LAIN)', [
        { label: 'Ada transaksi elektromedik', ok: null, detail: `${elektromedikTrx.size} transaksi aktif` },
        { label: 'Riwayat elektromedik terbaca', ok: rows.length > 0 ? true : null, detail: `${rows.length} record` },
      ]);
    },

    // ── Room assignment ──────────────────────────────────────────

    'ranap.buildRooms': async (ctx) => {
      const input = inputOf(ctx);
      const visits = visitsOf(ctx);
      const sep = getScratch<SepResult>(ctx, K.sepResult);
      const debug = isDebug(ctx);
      const anchorDate = sep?.matchedTanggal || sep?.targetTanggal || input.tanggal;
      // `_sync_tgl_masuk_awal_rawat_inap` stamps `datetime.now()`'s time-of-day
      // (ranap_v3.py:8913). Read the run's clock once and reuse it: a test clock
      // advances on every call, so two reads would produce two timestamps.
      const now = ctx.clock.now();

      const inpatientTrx = new Set(
        visits.filter((row) => str(row, 'no_transaksi').startsWith('03-')).map((row) => str(row, 'no_transaksi')),
      );
      const roomTitle = `Kamar dan hari rawat disusun dari tgl SEP ${anchorDate}`;
      if (inpatientTrx.size === 0) return reasoned(skipped('Tidak ada transaksi rawat inap (03-) pada kunjungan terpilih'), roomTitle, [{ label: 'Ada transaksi rawat inap (03-)', ok: false, detail: 'tidak ada pada kunjungan terpilih' }]);

      const historyInap = rowsOf(
        await softJson<unknown>(
          ctx,
          client,
          'penatajasaInap.getHistoryKunjunganTab',
          historyKunjunganInapPayload(input.noRm),
        ),
      );
      const base = historyInap.filter((row) => inpatientTrx.has(str(row, 'no_transaksi')));
      const roomRows = base.length > 0 ? base : visits.filter((row) => inpatientTrx.has(str(row, 'no_transaksi')));

      // Enrich each stay with the room/class codes later steps compare on.
      const enriched: LegacyRow[] = [];
      for (const row of roomRows) {
        const trx = str(row, 'no_transaksi');
        const reg = str(row, 'no_registrasikunjungan');
        // The inpatient history row carries no `kd_unit` on this backend and
        // `penatajasaInap.getDataKunjungan` answers with a "Database Error" page
        // (both verified live 2026-10-15), which left the room tab unread and
        // every room "kelas_ruang_tidak_terbaca". The visit row `load_visits`
        // already resolved for the same transaction holds the code.
        let kdUnit = str(row, 'kd_unit') || str(visits.find((visit) => str(visit, 'no_transaksi') === trx), 'kd_unit');
        if (!kdUnit) {
          const detail = await softJson<LegacyRow>(ctx, client, 'penatajasaInap.getDataKunjungan', {
            txtmedrec_inap: input.noRm,
            no_transaksi: trx,
          });
          kdUnit = str(detail, 'kd_unit');
        }
        const tab = kdUnit
          ? await softJson<LegacyRow>(ctx, client, 'penatajasaInap.getDataKunjunganTab', {
              no_registrasikunjungan: reg,
              kd_unit: kdUnit,
              no_transaksi: trx,
              urut_masuk_ruang: str(row, 'urut_masuk_ruang'),
            })
          : undefined;
        const tab2 = kdUnit
          ? await softJson<LegacyRow>(ctx, client, 'poliklinik.getDataKunjunganTab2', {
              no_registrasikunjungan: reg,
              kd_unit: kdUnit,
            })
          : undefined;
        enriched.push({
          ...row,
          kd_unit: kdUnit || str(row, 'kd_unit'),
          kd_detkelpenjamin: str(tab, 'kd_detkelpenjamin') || str(row, 'kd_detkelpenjamin') || '15',
          kd_kelasperawatan: str(tab, 'kd_kelasperawatan') || str(row, 'kd_kelasperawatan') || str(tab2, 'kd_kelasperawatan'),
          kd_kamarperawatan: str(tab, 'kd_kamarperawatan') || str(row, 'kd_kamarperawatan') || str(tab2, 'kd_kamarperawatan'),
          kd_ruangperawatan: str(tab, 'kd_ruangperawatan') || str(row, 'kd_ruangperawatan') || str(tab2, 'kd_ruangperawatan'),
          kd_spesialisasi: str(tab, 'kd_spesialisasi') || str(row, 'kd_spesialisasi') || str(tab2, 'kd_spesialisasi'),
        });
      }

      const byReg: Record<string, LegacyRow[]> = {};
      for (const row of enriched) {
        const reg = str(row, 'no_registrasikunjungan');
        (byReg[reg] ??= []).push(row);
      }

      const assignments: Record<string, string[]> = {};
      const windows: Record<string, { start: string; end: string }> = {};
      const pendingSync: Record<string, TglMasukSync> = {};
      const tolerance = toleranceOf(ctx);
      const alerts = alertsOf(ctx);
      for (const [reg, rows] of Object.entries(byReg)) {
        alerts.resetSyncIssues(reg);
        alerts.resetRegAlerts(reg);
        let stays: LegacyRow[] = normalizeRoomStays(rows);
        // `_sync_tgl_masuk_awal_rawat_inap` (ranap_v3.py:16186) runs here, before
        // `_build_room_day_assignments` (16188), and mutates `first_row
        // ["tgl_masuk"]` in place — so it changes the room-day result. The write
        // itself is proposed by `sync_tgl_masuk`; the corrected date is applied
        // in memory here because that is what the Python's assignment sees (its
        // `DRY_RUN` write returns `""`, which `_write_result_is_success` accepts).
        const sync = planTglMasukAwalSync(stays, anchorDate, now);
        if (sync) {
          pendingSync[reg] = sync;
          stays = sync.stays;
        }
        byReg[reg] = stays;
        Object.assign(assignments, buildRoomDayAssignments(stays, anchorDate));
        windows[reg] = groupPenunjangWindow(stays, anchorDate, tolerance);
      }
      ctx.scratch[K.roomRowsByReg] = byReg;
      ctx.scratch[K.roomDayAssignments] = assignments;
      ctx.scratch[K.groupWindowByReg] = windows;
      ctx.scratch[K.tglMasukSyncByReg] = pendingSync;

      ctx.log('Assignment hari ruang...');
      let index = 0;
      for (const rows of Object.values(byReg)) {
        for (const row of rows) {
          index += 1;
          const trx = str(row, 'no_transaksi');
          emit(
            ctx,
            numberedBlock(
              index,
              [
                { label: 'Ruang', value: str(row, 'nama_unit') },
                { label: 'Tanggal', value: (assignments[trx] ?? []).join(', ') },
                { label: 'No reg', value: str(row, 'no_registrasikunjungan'), debugOnly: true },
                { label: 'No trx', value: trx, debugOnly: true },
              ],
              { debug },
            ),
          );
        }
      }

      const groupCount = Object.keys(byReg).length;
      const roomChecks: ReasoningItem[] = Object.values(byReg).flatMap((rows) => rows.map((row) => {
        const days = assignments[str(row, 'no_transaksi')] ?? [];
        return { label: `${str(row, 'nama_unit') || 'Ruang'}`, ok: days.length > 0 ? true : null, detail: days.length ? `${days.length} hari: ${days[0]}${days.length > 1 ? ` – ${days[days.length - 1]}` : ''}` : 'tidak mendapat hari rawat' };
      }));
      for (const reg of Object.keys(pendingSync)) {
        roomChecks.push({ label: `Tgl masuk awal = tgl SEP${groupCount > 1 ? ` (${reg})` : ''}`, ok: false, detail: 'beda — diselaraskan di langkah Sinkronisasi Tanggal Masuk' });
      }
      return reasoned(ok(`${enriched.length} ruang dalam ${groupCount} grup rawat inap`, {
        evidence: [
          { label: 'roomDayAssignments', data: assignments },
          { label: 'groupPenunjangWindow', data: windows },
        ],
      }), roomTitle, roomChecks);
    },

    /**
     * `_sync_tgl_masuk_awal_rawat_inap` (called ranap_v3.py:16186, defined 8894).
     *
     * A real `kasir.updateTglMasuk` write: the first stay's admission date is
     * moved onto the SEP date so the hospital days start where the SEP says the
     * episode started. `build_rooms` has already applied the correction in memory
     * — that is the order the Python runs it in, and the room-day assignment
     * depends on it — so this node's job is to propose the write that makes the
     * correction real.
     */
    'ranap.syncTglMasuk': (ctx) => {
      const pending = getScratch<Record<string, TglMasukSync>>(ctx, K.tglMasukSyncByReg) ?? {};
      const entries = Object.entries(pending);
      if (entries.length === 0) {
        return skipped('Tanggal masuk awal rawat inap sudah sesuai tanggal SEP');
      }

      const debug = isDebug(ctx);
      const plans = entries.map(([reg, sync], index) => {
        emit(
          ctx,
          dataBlock(
            [
              { label: 'From', value: sync.from },
              { label: 'To', value: sync.to },
              { label: 'Alasan', value: 'samakan tanggal masuk awal rawat inap ke tanggal SEP' },
              { label: 'Trx', value: sync.noTransaksi, debugOnly: true },
              { label: 'Reg', value: reg, debugOnly: true },
            ],
            { bullet: '+ Update tanggal masuk rawat inap:', debug },
          ),
        );
        return mutationPlan(ctx, {
          node: 'sync_tgl_masuk',
          index,
          endpointId: 'kasir.updateTglMasuk',
          riskLevel: 'high',
          reason: `Selaraskan tanggal masuk awal rawat inap ${sync.from || '-'} menjadi ${sync.to}`,
          trx: sync.noTransaksi,
          // The Python has no guard *before* the write; what it does have is the
          // condition that got it here (`current_date != target_date`,
          // ranap_v3.py:8911) and a confirmation read afterwards
          // (`_is_tgl_masuk_kasir_updated`, 8890). Both are the same row of
          // `gethistorykunjungan`, so that is the check recorded.
          preconditions: [
            {
              description: 'Tanggal masuk kasir masih bernilai lama (belum dikoreksi pihak lain)',
              check: 'kasir.getHistoryKunjungan',
              // Live 2026-10-15: the kasir history answers `tgl_masuk` as a bare
              // `YYYY-MM-DD` while `sync.from` is the penatajasa datetime, so the
              // full value never matched and the gate refused every correction.
              // The date half is what this write changes, as the readback checks.
              expected: datePart(sync.from),
              match: 'contains',
              field: 'tgl_masuk',
              // `ambil_historykunjungan` (ranap_v3.py:3322) keys on `nomedrec`.
              payload: { nomedrec: inputOf(ctx).noRm },
            },
          ],
          // `update_tgl_masuk_kasir` (ranap_v3.py:3516). `kd_user` really is the
          // hard-coded "735" the legacy sends, and the two tindakan fields are
          // present-but-empty: the controller reads them off the body.
          payload: {
            txttglupdate_inap: sync.to,
            no_transaksi: sync.noTransaksi,
            kd_user: '735',
            kd_tindakan: '',
            tgl_jam: '',
            no_registrasikunjungan: reg,
          },
          payloadSummary: {
            no_transaksi: sync.noTransaksi,
            no_registrasikunjungan: reg,
            txttglupdate_inap: sync.to,
          },
          readAfterWriteChecks: [
            {
              description: 'Tanggal masuk kasir menjadi tanggal SEP',
              endpointId: 'kasir.getHistoryKunjungan',
              field: 'tgl_masuk',
              expected: sync.targetDate,
              // The row answers `YYYY-MM-DD HH:MM:SS`; only the date half moved.
              match: 'contains',
              payload: { nomedrec: inputOf(ctx).noRm },
            },
          ],
        });
      });

      return reasoned(
        planResult(`Rencana koreksi tanggal masuk awal ${plans.length} grup rawat inap`, plans),
        'Tanggal masuk awal rawat inap dibandingkan dengan tanggal SEP',
        entries.map(([, sync], index) => ({
          label: `Tgl masuk ${datePart(sync.from) || '-'} = tgl SEP ${sync.to}`,
          ok: false,
          detail: `beda — ubah ke ${sync.to}`,
          planId: plans[index]!.id,
        })),
      );
    },

    /**
     * `ambil_listtindakan` for every stay of every group.
     *
     * The Python has no such step because every consumer fetches the lines for
     * itself: `validate_ibs_consistency` (ranap_v3.py:8830),
     * `validate_obat_pulang_for_group` (13203) and
     * `_check_missing_igd_depo_or_obat_for_verification` (8001) each run their
     * own `ambil_listtindakan` loop. Hanging the map off `detect_origin`'s
     * non-newborn branch meant a BYNY patient — for whom `detect_origin` takes
     * the `_build_skipped_origin_info` path — left it empty, and four downstream
     * steps then reported success on no data at all.
     *
     * A read that fails is recorded as a sync issue for its registration, which
     * is how the Python's `except` branches make a failure reach
     * `_emit_pre_verification_summary` instead of vanishing.
     */
    'ranap.loadCharges': async (ctx) => {
      const groups = roomGroupsOf(ctx);
      if (Object.keys(groups).length === 0) return skipped('Belum ada grup rawat inap');

      const { lines, failedRegs, transactions } = await loadChargeLinesInto(ctx, client, groups);
      const chargeTitle = 'Daftar tindakan tiap ruang dibaca dari penata jasa';
      const chargeChecks: ReasoningItem[] = Object.keys(groups).map((reg) => ({
        label: `List tindakan terbaca${Object.keys(groups).length > 1 ? ` (${reg})` : ''}`,
        ok: !failedRegs.includes(reg),
        detail: failedRegs.includes(reg) ? 'gagal dibaca — langkah berikutnya bisa kurang data' : 'terbaca',
      }));
      if (failedRegs.length > 0) {
        return reasoned(review(`${failedRegs.length} grup dengan list tindakan yang tidak terbaca`, {
          warnings: [
            warning('list_tindakan_read', `List tindakan rawat inap gagal dibaca untuk ${failedRegs.length} grup`),
          ],
        }), chargeTitle, chargeChecks);
      }
      return reasoned(ok(`${lines} baris tindakan dari ${transactions} transaksi ruang`), chargeTitle,
        [...chargeChecks, { label: 'Baris tindakan', ok: null, detail: `${lines} baris dari ${transactions} transaksi ruang` }]);
    },

    'ranap.evaluateTitipan': (ctx) => {
      const groups = roomGroupsOf(ctx);
      const sep = getScratch<SepResult>(ctx, K.sepResult);
      const identity = getScratch<LegacyRow>(ctx, K.identity);
      const assignments = getScratch<Record<string, string[]>>(ctx, K.roomDayAssignments) ?? {};
      const debug = isDebug(ctx);
      if (Object.keys(groups).length === 0) return skipped('Belum ada ruang untuk dievaluasi');

      const sepItem = sep?.sepItem ?? {};
      const namaPasien = str(identity, 'nama_pasien');
      const sepClass = resolveSepClassKey(sepItem, sep?.sepOK ?? str(identity, 'no_sep'), str(identity, 'no_registrasikunjungan'));

      const evaluations: Array<TitipanEvaluation & { noTransaksi: string }> = [];
      const titipanRooms: string[] = [];
      let index = 0;
      for (const rows of Object.values(groups)) {
        for (const row of rows) {
          index += 1;
          // `byny_rme_status_by_reg.get(reg, {})` (ranap_v3.py:16227). A healthy
          // newborn in a room above the mother's entitled class gets the softened
          // reason, not the harsh TITIPAN one — without the status every newborn
          // was flagged as if it had been upgraded on purpose.
          const rowReg = str(row, 'no_registrasikunjungan');
          const rmeStatus = bynyRmeStatusFor(ctx, rowReg);
          const evaluation = evaluateTitipanForRoomRow({
            roomRow: row,
            sepItem,
            sepClassKey: sepClass.key,
            sepClassSource: sepClass.source,
            namaPasien,
            ...(rmeStatus ? { bynyRmeStatus: rmeStatus } : {}),
          });
          evaluations.push({ ...evaluation, noTransaksi: str(row, 'no_transaksi') });
          if (evaluation.isTitipan) titipanRooms.push(evaluation.roomName);

          emit(
            ctx,
            numberedBlock(index, [{ label: 'Ruang', value: evaluation.roomName }], { debug }),
          );
          emit(ctx, [bulletLine(`Tanggal: ${(assignments[str(row, 'no_transaksi')] ?? []).join(', ') || '-'}`, '      ')]);
          emit(ctx, [bulletLine('Evaluasi titipan', '      ')]);
          emit(
            ctx,
            dataBlock(
              [
                { label: 'Kelas SEP', value: evaluation.sepClass },
                { label: 'Kelas ruang', value: evaluation.roomClass },
                { label: 'Hasil', value: evaluation.result },
                { label: 'Alasan', value: evaluation.reason },
                { label: 'Sumber kelas SEP', value: evaluation.sepClassSource, debugOnly: true },
              ],
              { indent: '           ', debug },
            ),
            evaluation.isTitipan ? 'warn' : 'info',
          );
        }
      }
      ctx.scratch[K.titipan] = evaluations;

      const titipanTitle = `Kelas ruang dibandingkan dengan hak kelas SEP (${sepClass.key || 'tidak terbaca'})`;
      const titipanChecks: ReasoningItem[] = evaluations.map((item) => ({
        label: `${item.roomName} sesuai hak kelas`,
        ok: item.isTitipan ? false : item.result === 'NORMAL' ? true : null,
        detail: item.isTitipan
          ? `TITIPAN — ruang ${item.roomClass || '-'} di atas hak ${item.sepClass || '-'}`
          : item.result === 'NORMAL' ? `ruang ${item.roomClass || '-'} · hak ${item.sepClass || '-'}` : `belum dapat dievaluasi: ${item.reason}`,
      }));
      const evidence = [{ label: 'titipan', data: evaluations }, reasoningEvidence({ title: titipanTitle, items: titipanChecks })];
      if (titipanRooms.length > 0) {
        return review(`${titipanRooms.length} ruang terdeteksi TITIPAN: ${titipanRooms.join(', ')}`, {
          warnings: [warning('titipan', `Kelas ruang di atas hak SEP: ${titipanRooms.join(', ')}`)],
          evidence,
        });
      }
      // Report "sesuai" only for rooms actually compared. A room whose SEP or
      // room class could not be read is not a pass — the legacy log says
      // PERLU CEK MANUAL / TIDAK DAPAT DIEVALUASI, and so must the summary.
      const unevaluated = evaluations.filter((item) => item.result !== 'NORMAL');
      if (unevaluated.length > 0) {
        return review(
          `${unevaluated.length}/${evaluations.length} ruang belum dapat dievaluasi (${[
            ...new Set(unevaluated.map((item) => item.reason)),
          ].join(', ')})`,
          {
            warnings: [
              warning('titipan_unevaluated', `Kelas SEP atau kelas ruang tidak terbaca untuk ${unevaluated.length} ruang`),
            ],
            evidence,
          },
        );
      }
      return ok(`${evaluations.length} ruang sesuai hak kelas SEP`, { evidence });
    },

    // ── Gizi ─────────────────────────────────────────────────────

    /**
     * `ensure_ordergizi_terkirim` (called ranap_v3.py:16235, defined 15089).
     *
     * The legacy step **sends** every pending diet order (`kirim_ordergizi`), so
     * this is a `mutate` node: reporting "N order gizi perlu dikirim" as a
     * success while planning nothing was a verdict for work that was never going
     * to happen. `main()` wraps the call per registration and, on an exception,
     * registers a sync issue plus an ERROR reg-alert (16236-16240) — both of
     * which is how the failure reaches `_emit_pre_verification_summary`.
     */
    'ranap.preflightGizi': async (ctx) => {
      const groups = roomGroupsOf(ctx);
      const debug = isDebug(ctx);
      if (Object.keys(groups).length === 0) return skipped('Belum ada grup rawat inap');

      // The legacy log hides this block outside debug mode: it is preflight
      // noise unless something is actually wrong.
      if (debug) ctx.log(`Preflight order gizi untuk ${Object.keys(groups).length} grup rawat inap.`, 'debug');

      const alerts = alertsOf(ctx);
      const cache = scratchRecord<GiziOrderSnapshot>(ctx, K.giziOrdersByReg);
      const plans: MutationPlan[] = [];
      let blockedOrders = 0;
      let failures = 0;
      const giziChecks: ReasoningItem[] = [];
      const giziTitle = 'Order gizi tiap grup: sudah terkirim ke instalasi gizi?';
      for (const [reg, rows] of Object.entries(groups)) {
        try {
          const historyByNoTransaksi: Record<string, unknown> = {};
          for (const row of rows) {
            const trx = str(row, 'no_transaksi');
            if (!trx) continue;
            // `gethistory_ordergizi` (ranap_v3.py:5014) — `page` is required too.
            historyByNoTransaksi[trx] = await softJson<unknown>(ctx, client, 'penatajasaInap.getHistoryOrderGizi', {
              no_transaksi: trx,
              kd_unit_poli: str(row, 'kd_unit'),
              page: '1',
              rows: '50',
            });
          }
          const orderItems = collectOrderGiziTransactionsForGroup({ roomRows: rows, historyByNoTransaksi });
          // `cek_order_gizi` (ranap_v3.py:5040) posts the registration as `no_reg`.
          const cek = await softText(ctx, client, 'penatajasaInap.cekOrderGizi', { no_reg: reg });
          const detailByOrder: Record<string, unknown> = {};
          const jadwalByOrder: Record<string, unknown> = {};
          for (const item of orderItems) {
            // `getdataordergizi` (ranap_v3.py:5027): `nomedrec`, plus paging.
            detailByOrder[item.noTransaksiOrderGizi] = await softJson<unknown>(
              ctx,
              client,
              'penatajasaInap.getDataOrderGizi',
              {
                no_transaksi: item.noTransaksiOrderGizi,
                nomedrec: inputOf(ctx).noRm,
                page: '1',
                rows: '50',
              },
            );
            // `cek_jadwal_gizi` (ranap_v3.py:15154) keys on `no_order`. Without
            // it every order read as schedulable by default, so a kitchen refusal
            // never surfaced.
            jadwalByOrder[item.noTransaksiOrderGizi] = await softText(
              ctx,
              client,
              'penatajasaInap.cekJadwalGizi',
              { no_order: item.noTransaksiOrderGizi },
            );
          }
          // Kept for `recover_gizi`, which needs the same snapshot to build its
          // per-attempt action list.
          cache[reg] = { orderItems, detailByOrder };

          const plan = planOrderGiziSend({
            roomRows: rows,
            orderItems,
            cekOrderGiziResponse: cek,
            detailByOrder,
            jadwalByOrder,
          });
          blockedOrders += plan.blocked.length;
          for (const action of plan.alreadySent) giziChecks.push({ label: `Order gizi ${action.noTransaksiOrderGizi} terkirim`, ok: true });
          for (const action of plan.blocked) giziChecks.push({ label: `Order gizi ${action.noTransaksiOrderGizi} terkirim`, ok: false, detail: `terblokir: ${action.reason}` });
          if (plan.historyMissing) giziChecks.push({ label: 'History order gizi ditemukan', ok: false, detail: 'SIMRS mencatat order tertunda, tetapi history-nya kosong — cek manual' });
          for (const action of plan.toSend) {
            giziChecks.push({ label: `Order gizi ${action.noTransaksiOrderGizi} terkirim`, ok: false, detail: `belum (${action.reason}) — kirim`, planId: `@gizi:${plans.length}` });
            plans.push(
              mutationPlan(ctx, {
                node: 'preflight_gizi',
                index: plans.length,
                endpointId: 'penatajasaInap.kirimOrderGizi',
                riskLevel: 'high',
                reason: `Kirim order gizi ${action.noTransaksiOrderGizi} (${action.reason})`,
                trx: action.noTransaksiOrderGizi,
                preconditions: [PRECONDITION.giziJadwalTersedia(action.noTransaksiOrderGizi)],
                // `kirim_ordergizi` (ranap_v3.py:5058) — two fields, nothing else.
                payload: {
                  no_transaksi_ordergizi: action.noTransaksiOrderGizi,
                  catatan_gizi: '',
                },
                payloadSummary: {
                  no_transaksi_ordergizi: action.noTransaksiOrderGizi,
                  catatan_gizi: '',
                  no_registrasikunjungan: reg,
                },
              }),
            );
          }
          if (plan.historyMissing) {
            alerts.registerRegAlert(
              reg,
              'WARN',
              'History order gizi tidak ditemukan | cek_order_gizi > 0 tetapi history order gizi tidak ditemukan',
            );
          }
          if (debug) {
            emit(
              ctx,
              dataBlock(
                [
                  { label: 'Order gizi belum terkirim', value: plan.toSend.length },
                  { label: 'Sudah terkirim', value: plan.alreadySent.length },
                  { label: 'Terblokir', value: plan.blocked.length },
                  { label: 'No reg', value: reg, debugOnly: true },
                ],
                { bullet: '+ Preflight order gizi:', debug },
              ),
              'debug',
            );
          }
        } catch (err) {
          // ranap_v3.py:16236-16240.
          failures += 1;
          giziChecks.push({ label: `Order gizi terbaca${Object.keys(groups).length > 1 ? ` (${reg})` : ''}`, ok: false, detail: asMessage(err) });
          alerts.registerSyncIssue(reg, 'preflight_order_gizi', `error=${asMessage(err)}`);
          alerts.registerRegAlert(reg, 'ERROR', `Preflight order gizi gagal | error=${asMessage(err)}`);
          if (debug) ctx.log(`Error preflight gizi reg=${reg}: ${asMessage(err)}`, 'debug');
        }
      }

      // Placeholder plan refs ("@gizi:<index>") resolve to the real plan ids now that they exist.
      for (const item of giziChecks) {
        if (item.planId?.startsWith('@gizi:')) {
          const id = plans[Number(item.planId.slice(6))]?.id;
          if (id) item.planId = id; else delete item.planId;
        }
      }
      if (giziChecks.length === 0) giziChecks.push({ label: 'Ada order gizi', ok: null, detail: 'tidak ada order gizi pada grup ini' });
      if (failures > 0) {
        return reasoned(review(`Preflight order gizi gagal untuk ${failures} grup`, {
          warnings: [warning('gizi_preflight_error', `${failures} grup gagal preflight order gizi`, 'error')],
          ...(plans.length > 0 ? { proposedMutations: plans } : {}),
        }), giziTitle, giziChecks);
      }
      if (plans.length > 0) {
        return reasoned(planResult(`Rencana kirim ${plans.length} order gizi yang belum terkirim`, plans), giziTitle, giziChecks);
      }
      if (blockedOrders > 0) {
        return reasoned(review(`${blockedOrders} order gizi terblokir dan perlu recovery`, {
          warnings: [warning('gizi_blocked', `${blockedOrders} order gizi tidak dapat dikirim otomatis`)],
        }), giziTitle, giziChecks);
      }
      return reasoned(ok('Preflight gizi bersih'), giziTitle, giziChecks);
    },

    // ── Origin (IGD / POLI) ──────────────────────────────────────

    'ranap.detectOrigin': async (ctx) => {
      const input = inputOf(ctx);
      const groups = roomGroupsOf(ctx);
      const identity = getScratch<LegacyRow>(ctx, K.identity);
      const allRows = getScratch<LegacyRow[]>(ctx, K.allVisitRows) ?? [];
      const listByTrx = getScratch<Record<string, LegacyRow[]>>(ctx, K.listTindakanByTrx) ?? {};
      const elektromedik = getScratch<LegacyRow[]>(ctx, K.elektromedik) ?? [];
      const sep = getScratch<SepResult>(ctx, K.sepResult);
      const debug = isDebug(ctx);
      const tolerance = toleranceOf(ctx);
      if (Object.keys(groups).length === 0) return skipped('Belum ada grup rawat inap');

      ctx.log(`Mencari cara masuk pasien untuk ${Object.keys(groups).length} grup rawat inap...`);

      const anchorDate = sep?.matchedTanggal || sep?.targetTanggal || input.tanggal;
      const originByReg: Record<string, OriginInfo> = {};
      const igdSourceByReg = scratchRecord<LegacyRow>(ctx, K.igdSourceByReg);
      const poliSourceByReg = scratchRecord<LegacyRow>(ctx, K.poliSourceByReg);
      const namaPasien = str(identity, 'nama_pasien');
      const alerts = alertsOf(ctx);

      // Hemodialysis charges on a candidate IGD visit force IGD origin. Read once
      // per run rather than once per group: `_get_igd_source_signal_info` memoizes
      // in `_IGD_SOURCE_SIGNAL_CACHE` (ranap_v3.py:13767).
      const igdSignalByTrx: Record<string, IgdSourceSignal> = {};
      for (const candidate of allRows) {
        const trx = str(candidate, 'no_transaksi');
        if (!trx || igdSignalByTrx[trx] || !upper(candidate, 'nama_unit').includes('IGD')) continue;
        igdSignalByTrx[trx] = deriveIgdSourceSignal(await fetchPoliListTindakan(ctx, client, trx));
      }
      // `poli_history = ambil_historykunjungan_poli(no_rm)` (ranap_v3.py:16243) —
      // fetched once and shared by both source lookups.
      const poliHistory = rowsOf(
        await softJson<unknown>(ctx, client, 'poliklinik.getHistoryKunjungan', {
          nomedrec: input.noRm,
          cmbunithistory_poli: '',
          dttglmasuk1_poli: '',
          dttglmasuk2_poli: '',
          page: '1',
          rows: '200',
        }),
      );

      for (const [reg, rows] of Object.entries(groups)) {
        // A newborn can be admitted directly, so the legacy script does not
        // look for an entry visit at all.
        if (isBynyPatient(str(rows[0], 'nama_pasien') || namaPasien)) {
          originByReg[reg] = buildSkippedOriginInfo({
            reason: 'pasien BYNY dapat berasal langsung, jadi origin asal tidak dicek',
            inferredType: 'langsung_byny',
          });
        } else {
          // The charge lines come from `load_charges`, which fetches them for
          // every group unconditionally — hanging them off this branch left the
          // map empty for a newborn and four later validations silently passed.
          const groupRows: LegacyRow[] = [];
          const dataKunjunganByTrx: Record<string, LegacyRow> = {};
          for (const row of rows) {
            const trx = str(row, 'no_transaksi');
            if (!trx) continue;
            groupRows.push(
              ...(listByTrx[trx] ?? []).map((line) => ({
                ...line,
                no_transaksi: trx,
                no_registrasikunjungan: reg,
              })),
            );
            const detail = await softJson<LegacyRow>(ctx, client, 'penatajasaInap.getDataKunjungan', {
              txtmedrec_inap: input.noRm,
              no_transaksi: trx,
            });
            if (detail) dataKunjunganByTrx[trx] = detail;
          }

          let info = detectGroupOriginFromRows({
            roomRows: rows,
            listTindakanRows: groupRows,
            noRm: input.noRm,
            kunjunganRows: allRows,
            toleranceDays: tolerance,
            dataKunjunganByTrx,
            igdSignalByTrx,
          });

          // The hemodialysis override (ranap_v3.py:16270-16296): a stay with no
          // UGD room charge but a nearby IGD visit billing hemodialysis *is* an
          // IGD admission. Without it the HD charges are never transferred and
          // later surface as a hanging transaction.
          if (!info.skipOriginCheck && !info.requiresIgdSource) {
            const fallback = await findRelatedIgdSourceForGroup(ctx, client, {
              noRm: input.noRm,
              roomRows: rows,
              kunjunganRows: allRows,
              elektromedikHistory: elektromedik,
              poliHistory,
              tanggal: anchorDate,
              toleranceDays: tolerance,
              igdSignalByTrx,
              dataKunjunganByTrx,
            });
            if (fallback && flag(fallback['has_hemodialisa_signal'])) {
              info = {
                ...info,
                requiresIgdSource: true,
                requiresPoliSource: false,
                inferredOrigin: {
                  ...(info.inferredOrigin ?? { type: 'igd' }),
                  type: 'igd',
                  trx: str(fallback, 'no_transaksi'),
                  reg: str(fallback, 'no_registrasikunjungan'),
                  hasHemodialisaSignal: true,
                  matchedNames: [...((fallback['matched_names'] as string[] | undefined) ?? [])],
                },
              };
              igdSourceByReg[reg] = fallback;
            }
          }
          originByReg[reg] = info;
        }

        const info = originByReg[reg]!;
        const caraMasuk = info.skipOriginCheck
          ? 'Tidak dicek (BYNY)'
          : info.requiresPoliSource
            ? 'Poliklinik'
            : info.requiresIgdSource
              ? 'IGD'
              : 'Tidak diketahui';
        emit(ctx, ['+ Origin rawat inap']);
        emit(
          ctx,
          dataBlock(
            [
              { label: 'Poliklinik', value: info.requiresPoliSource },
              { label: 'IGD', value: info.requiresIgdSource },
              { label: 'Cara masuk pasien', value: caraMasuk },
              { label: 'Catatan', value: info.skipReason },
              { label: 'No reg', value: reg, debugOnly: true },
              { label: 'Inferred', value: info.inferredOrigin?.type, debugOnly: true },
              { label: 'SEP match', value: info.inferredOrigin?.sepMatch, debugOnly: true },
              { label: 'Doctor match', value: info.inferredOrigin?.doctorMatch, debugOnly: true },
              { label: 'Exact date', value: info.inferredOrigin?.exactDate, debugOnly: true },
              { label: 'HD signal', value: info.inferredOrigin?.hasHemodialisaSignal, debugOnly: true },
            ],
            { indent: '    ', debug },
          ),
        );

        // Resolve the actual source row, and say so when there is none
        // (ranap_v3.py:16321-16370). `process_igd`/`process_poli` used to fall
        // back to the registration number where a transaction number belongs,
        // which then flowed into the plan id, the idempotency key and the payload.
        const inapRef = str(rows[0], 'no_transaksi');
        if (info.requiresIgdSource && !igdSourceByReg[reg]) {
          const igdSource = await findRelatedIgdSourceForGroup(ctx, client, {
            noRm: input.noRm,
            roomRows: rows,
            kunjunganRows: allRows,
            elektromedikHistory: elektromedik,
            poliHistory,
            tanggal: anchorDate,
            toleranceDays: tolerance,
            igdSignalByTrx,
            dataKunjunganByTrx: {},
          });
          if (igdSource) igdSourceByReg[reg] = igdSource;
          else {
            emit(
              ctx,
              dataBlock(
                [
                  { label: 'Inap ref', value: inapRef },
                  { label: 'Reg', value: reg, debugOnly: true },
                ],
                { bullet: '+ IGD asal terkait tidak ditemukan:', debug },
              ),
              'warn',
            );
            alerts.registerRegAlert(reg, 'WARN', `IGD asal terkait tidak ditemukan | inap_ref=${inapRef || '-'}`);
          }
        }
        if (info.requiresPoliSource && !poliSourceByReg[reg]) {
          const poliSource = await findRelatedPoliSource(ctx, client, {
            noRm: input.noRm,
            kunjunganInap: rows[0] ?? {},
            tanggal: anchorDate,
            toleranceDays: tolerance,
            poliHistory,
          });
          if (poliSource) poliSourceByReg[reg] = poliSource;
          else {
            emit(
              ctx,
              dataBlock(
                [
                  { label: 'Inap ref', value: inapRef },
                  { label: 'Reg', value: reg, debugOnly: true },
                ],
                { bullet: '+ POLI asal terkait tidak ditemukan:', debug },
              ),
              'warn',
            );
            alerts.registerRegAlert(reg, 'WARN', `POLI asal terkait tidak ditemukan | inap_ref=${inapRef || '-'}`);
          }
        }
      }

      ctx.scratch[K.originByReg] = originByReg;

      const infos = Object.values(originByReg);
      const igd = infos.filter((info) => info.requiresIgdSource).length;
      const poli = infos.filter((info) => info.requiresPoliSource).length;
      const unknownRegs = Object.entries(originByReg).filter(([, info]) =>
        !info.skipOriginCheck && (
          !info.requiresIgdSource && !info.requiresPoliSource || info.requiresIgdSource && info.requiresPoliSource
        ),
      );
      const unknown = unknownRegs.length;
      const multi = Object.keys(originByReg).length > 1;
      const originChecks: ReasoningItem[] = Object.entries(originByReg).flatMap(([reg, info]): ReasoningItem[] => {
        const prefix = multi ? `${str(groups[reg]?.[0], 'no_transaksi') || reg} · ` : '';
        if (info.skipOriginCheck) return [{ label: `${prefix}Asal masuk`, ok: null, detail: `tidak dicek: ${info.skipReason ?? '-'}` }];
        if (info.requiresIgdSource && info.requiresPoliSource) return [{ label: `${prefix}Asal masuk jelas`, ok: false, detail: 'terdeteksi IGD dan POLI sekaligus' }];
        if (!info.requiresIgdSource && !info.requiresPoliSource) return [{ label: `${prefix}Asal masuk jelas`, ok: false, detail: 'tidak terdeteksi IGD maupun POLI' }];
        const via = info.requiresIgdSource ? 'IGD' : 'POLI';
        const source = info.requiresIgdSource ? igdSourceByReg[reg] : poliSourceByReg[reg];
        return [
          { label: `${prefix}Asal masuk: ${via}`, ok: true },
          { label: `${prefix}Transaksi ${via} asal ditemukan`, ok: source ? true : false, detail: source ? `${str(source, 'nama_unit') || via} · ${str(source, 'no_transaksi') || '-'}` : 'tidak ditemukan — tagihan asal tidak bisa ditarik otomatis' },
        ];
      });
      const originTitle = 'Asal masuk rawat inap (IGD atau poliklinik) menentukan cabang berikutnya';
      const branches = {
        detect_origin__process_igd: igd > 0 ? 'take' : unknown > 0 ? 'block' : 'skip',
        detect_origin__process_poli: poli > 0 ? 'take' : unknown > 0 ? 'block' : 'skip',
      } as const;
      if (unknown > 0) {
        for (const [reg] of unknownRegs) {
          alerts.registerSyncIssue(reg, 'detect_origin', 'asal IGD/POLI tidak dapat dipastikan');
        }
        return reasoned(review(`${unknown} grup tanpa asal masuk yang bisa dipastikan: ${unknownRegs.map(([reg]) => `${str(groups[reg]?.[0], 'no_transaksi') || reg} (asal IGD/POLI tidak jelas)`).join(', ')}`, {
          warnings: [warning('origin_unknown', `${unknown} grup rawat inap tidak memiliki asal masuk yang jelas`)],
          branches,
        }), originTitle, originChecks);
      }
      return reasoned(ok(`Asal masuk: ${igd} IGD, ${poli} Poliklinik`, { branches }), originTitle, originChecks);
    },

    'ranap.processIgd': async (ctx) => {
      const input = inputOf(ctx);
      const originByReg = getScratch<Record<string, OriginInfo>>(ctx, K.originByReg) ?? {};
      const igdSourceByReg = scratchRecord<LegacyRow>(ctx, K.igdSourceByReg);
      const handledIgd = scratchSet(ctx, K.handledIgdTrx);
      const usedElektromedik = scratchSet(ctx, K.usedElektromedikTrx);
      const debug = isDebug(ctx);
      const regs = Object.entries(originByReg).filter(([, info]) => info.requiresIgdSource);
      if (regs.length === 0) return skipped('Bukan pasien masuk via IGD');

      ctx.log('1. Perapihan asal masuk pasien: IGD');
      ctx.log(bulletLine('Sinkronisasi tindakan'));

      const plans: MutationPlan[] = [];
      const missing: string[] = [];
      // Found IGD source whose charges are all already transferred: that is
      // the finished state, not a missing source (live 2026-10-15, three of
      // three inpatients read "IGD asal tidak ditemukan" for exactly this).
      const settled: string[] = [];
      const igdChecks: ReasoningItem[] = [];
      const igdPrefix = (reg: string) => (regs.length > 1 ? `${reg} · ` : '');
      for (const [reg] of regs) {
        // `if igd_source:` (ranap_v3.py:16389) — no source, no transfer. Passing
        // the registration number as the transaction was a silent corruption of
        // the plan id, the idempotency key and the payload summary; the missing
        // source has already been logged and alerted by `detect_origin`.
        const source = igdSourceByReg[reg];
        const igdTrx = str(source, 'no_transaksi');
        if (!source || !igdTrx) {
          igdChecks.push({ label: `${igdPrefix(reg)}Transaksi IGD asal ditemukan`, ok: false, detail: 'tidak ditemukan' });
          missing.push(reg);
          continue;
        }
        // ranap_v3.py:16392-16395 — the elektromedik charge folded into this
        // transfer must not be transferred again by `transfer_elektromedik`, and
        // the IGD transaction itself is a handled one for the hanging scan.
        const sourceElektromedik = str(source, 'source_no_transaksi');
        if (sourceElektromedik) usedElektromedik.add(sourceElektromedik);
        handledIgd.add(igdTrx);

        emit(
          ctx,
          dataBlock(
            [
              { label: 'IGD', value: igdTrx },
              { label: 'Unit', value: str(source, 'nama_unit') },
              { label: 'Tgl', value: str(source, 'tgl_masuk') },
              { label: 'Reg', value: reg, debugOnly: true },
              { label: 'Reg IGD', value: str(source, 'no_registrasikunjungan'), debugOnly: true },
              { label: 'Linked inap', value: str(source, 'linked_inap_trx'), debugOnly: true },
              { label: 'Source SEP', value: str(source, 'source_sep'), debugOnly: true },
            ],
            { bullet: '+ Kandidat IGD asal:', indent: '   ', debug },
          ),
        );

        // Everything `transfer_tagihan_igd` (ranap_v3.py:6392) needs, read the
        // way `proses_transfer_igd` (ranap_v3.py:9215-9240) reads it: the
        // destination transaction from the IGD registration, the still-pending
        // charge codes joined with the literal `','`, and the transfer amount.
        const igdReg = str(source, 'no_registrasikunjungan');
        const destination = await fetchPoliLinkedTransaksi(ctx, client, input.noRm, igdReg);
        const noTransaksiPoli = str(destination, 'no_transaksi');
        const kdUnitPoli = str(destination, 'kd_unit');
        const kdDetkelpenjamin = str(destination, 'kd_detkelpenjamin') || '15';
        const pending = (await fetchPoliListTindakan(ctx, client, igdTrx)).filter(
          (row) => !isTransferredRow(row),
        );
        const kdTindakanList = sortedRows(pending)
          .map((row) => str(row, 'kd_tindakan'))
          .filter(Boolean);
        const biaya = await softText(ctx, client, 'poliklinik.cekJumlahTransfer', {
          no_transaksi: igdTrx,
        });

        const payloadSummary = {
          no_registrasikunjungan: reg,
          igd_trx: igdTrx,
          igd_reg: igdReg || '-',
          no_transaksipoli: noTransaksiPoli || '-',
          biaya: biaya || '-',
          tindakan: kdTindakanList.length,
        };
        // The Python refuses the transfer outright when any of these is missing
        // (ranap_v3.py:9221, 9232, 9238); a plan built on a blank destination or
        // a blank amount would post nonsense.
        const missingField =
          !noTransaksiPoli || !kdUnitPoli
            ? 'data transaksi tujuan IGD tidak lengkap'
            : kdTindakanList.length === 0
              ? 'tidak ada tindakan IGD yang masih pending transfer'
              : !biaya.trim()
                ? 'biaya transfer IGD kosong'
                : '';
        if (kdTindakanList.length === 0 && noTransaksiPoli && kdUnitPoli) {
          ctx.log(`- IGD asal sudah tertransfer seluruhnya | trx=${igdTrx}`);
          igdChecks.push({ label: `${igdPrefix(reg)}Tagihan IGD ${igdTrx} sudah ditransfer ke rawat inap`, ok: true });
          settled.push(reg);
          continue;
        }
        if (missingField) {
          ctx.log(`- Skip transfer IGD | trx=${igdTrx} | alasan=${missingField}`, 'warn');
          alertsOf(ctx).registerRegAlert(reg, 'WARN', `Transfer IGD asal dilewati | ${missingField}`);
          igdChecks.push({ label: `${igdPrefix(reg)}Tagihan IGD ${igdTrx} sudah ditransfer ke rawat inap`, ok: false, detail: `tidak bisa ditransfer otomatis: ${missingField}` });
          missing.push(reg);
          continue;
        }

        plans.push(
          mutationPlan(ctx, {
            node: 'process_igd',
            index: plans.length,
            endpointId: 'poliklinik.transferIgd',
            riskLevel: 'high',
            reason: `Transfer tagihan IGD asal ke tagihan rawat inap (reg ${reg})`,
            trx: igdTrx,
            // `proses_transfer_igd` refuses on a non-empty order status and on an
            // empty transfer amount (ranap_v3.py:9204, 9233).
            preconditions: [
              PRECONDITION.igdOrderSelesai(igdTrx),
              PRECONDITION.igdBiayaTransferAda(igdTrx),
            ],
            payload: transferIgdPayload({
              noTransaksi: igdTrx,
              noTransaksiPoli,
              kdUnitPoli,
              kdDetkelpenjamin,
              biaya,
              // The IGD unit itself, not the destination's (ranap_v3.py:9257).
              kdUnit: str(source, 'kd_unit'),
              // "format sesuai HAR: 38','16','1929…" — the legacy comment at
              // ranap_v3.py:9201. One code stays a bare code, no separator.
              kdTindakan: kdTindakanList.join("','"),
            }),
            payloadSummary,
            readAfterWriteChecks: sortedRows(pending)
              .filter((row) => str(row, 'kd_tindakan') && str(row, 'urut_tindakan'))
              .map((row) => ({
                description: `Tindakan IGD ${str(row, 'kd_tindakan')}#${str(row, 'urut_tindakan')} terbaca sudah transfer`,
                endpointId: 'poliklinik.cekStatusTransfer',
                field: '',
                expected: '1',
                match: 'nonEmpty',
                payload: {
                  no_transaksi: igdTrx,
                  kd_tindakan: str(row, 'kd_tindakan'),
                  urut_tindakan: str(row, 'urut_tindakan'),
                },
              })),
          }),
        );
        igdChecks.push({ label: `${igdPrefix(reg)}Tagihan IGD ${igdTrx} sudah ditransfer ke rawat inap`, ok: false, detail: `${kdTindakanList.length} tindakan belum — transfer`, planId: plans[plans.length - 1]!.id });
      }

      const igdTitle = 'Tagihan IGD asal harus pindah ke tagihan rawat inap';
      if (plans.length === 0 && missing.length === 0) {
        return reasoned(ok(`Tagihan IGD asal sudah tertransfer untuk ${settled.length} grup`), igdTitle, igdChecks);
      }
      if (plans.length === 0) {
        return reasoned(review(`IGD asal tidak ditemukan untuk ${missing.length} grup`, {
          warnings: [warning('igd_source_missing', `${missing.length} grup origin IGD tanpa transaksi asal`)],
        }), igdTitle, igdChecks);
      }
      return reasoned(planResult(`Rencana perapihan ${plans.length} tagihan IGD asal`, plans), igdTitle, igdChecks);
    },

    /**
     * `proses_tagihan_poli_asal` (ranap_v3.py:7432): date-sync the source POLI
     * rows, reset a transferred source when a transferred row still needs work,
     * then transfer the clean pending source rows onto the inpatient bill.
     */
    'ranap.processPoli': async (ctx) => {
      const input = inputOf(ctx);
      const sep = getScratch<SepResult>(ctx, K.sepResult);
      const originByReg = getScratch<Record<string, OriginInfo>>(ctx, K.originByReg) ?? {};
      const poliSourceByReg = scratchRecord<LegacyRow>(ctx, K.poliSourceByReg);
      const poliRowsByReg = scratchRecord<LegacyRow[]>(ctx, K.poliSourceRowsByReg);
      const debug = isDebug(ctx);
      const regs = Object.entries(originByReg).filter(([, info]) => info.requiresPoliSource);
      if (regs.length === 0) return skipped('Bukan pasien masuk via Poliklinik');
      const now = ctx.clock.now();

      ctx.log('1. Perapihan asal masuk pasien: Poliklinik');
      ctx.log(bulletLine('Sinkronisasi tindakan'));

      const plans: MutationPlan[] = [];
      const missing: string[] = [];
      let needsReplan = false;
      for (const [reg] of regs) {
        const source = poliSourceByReg[reg];
        const poliTrx = str(source, 'no_transaksi');
        if (!source || !poliTrx) {
          missing.push(reg);
          continue;
        }

        emit(
          ctx,
          dataBlock(
            [
              { label: 'POLI', value: poliTrx },
              { label: 'Unit', value: str(source, 'nama_unit') },
              { label: 'Tgl', value: str(source, 'tgl_masuk') },
              { label: 'Reg', value: reg, debugOnly: true },
              { label: 'Reg POLI', value: str(source, 'no_registrasikunjungan'), debugOnly: true },
            ],
            { bullet: '+ Kandidat POLI asal:', indent: '   ', debug },
          ),
        );

        const sourceRows = await fetchPoliListTindakan(ctx, client, poliTrx);
        poliRowsByReg[reg] = sourceRows;
        const targetDate = datePart(
          sep?.matchedTanggal || sep?.targetTanggal || input.tanggal || str(source, 'tgl_masuk'),
        );
        const penunjangHistories = await loadPenunjangHistories(ctx, client, input.noRm);
        const labTargetRows = await collectHistoryTargetRowsByReference(
          ctx,
          client,
          poliTrx,
          penunjangHistories.lab,
          'laboratoriumHasil.getDetailTransaksi',
          'no_transaksi',
        );
        const radTargetRows = await collectHistoryTargetRowsByReference(
          ctx,
          client,
          poliTrx,
          penunjangHistories.rad,
          'penatajasaInap.getDetailHistoryIrad',
          'no_trans',
        );
        const labTargetDates = expandTargetDates(labTargetRows);
        const radTargetDates = expandTargetDates(radTargetRows);

        const updateRows = [
          ...(targetDate
            ? sourceRows
                .filter(
                  (row) =>
                    !isTransferredRow(row) &&
                    str(row, 'nama_tindakan').toUpperCase() === 'BIAYA OBAT' &&
                    datePart(str(row, 'tgl_transaksi', 'tgl_jam')) !== targetDate,
                )
                .map((row) => ({ row, targetDate, label: 'BIAYA OBAT' }))
            : []),
          ...poliPenunjangDateUpdates(sourceRows, labTargetDates, 'BIAYA LABORATORIUM', (name) => name === 'BIAYA LABORATORIUM'),
          ...poliPenunjangDateUpdates(sourceRows, radTargetDates, 'BIAYA RADIOLOGI', (name) => name.includes('BIAYA RADIOLOGI')),
        ];
        if (updateRows.length > 0) {
          for (const { row, targetDate: updateTargetDate, label } of updateRows) {
            const kdTindakan = str(row, 'kd_tindakan');
            const urutTindakan = str(row, 'urut_tindakan');
            if (!kdTindakan || !urutTindakan) {
              ctx.log(
                `- Skip tanggal ${label} POLI | trx=${poliTrx} | alasan=kd_tindakan/urut_tindakan kosong`,
                'debug',
              );
              continue;
            }
            const targetDatetime = buildUpdateDateTime(
              updateTargetDate,
              str(row, 'tgl_transaksi', 'tgl_jam'),
              '00:00:01',
              now,
            );
            const line: TindakanLineKey = {
              no_transaksi: poliTrx,
              kd_tindakan: kdTindakan,
              urut_tindakan: urutTindakan,
            };
            plans.push(
              mutationPlan(ctx, {
                node: 'process_poli',
                index: plans.length,
                endpointId: 'poliklinik.updateTgl',
                riskLevel: 'high',
                reason:
                  `Samakan tanggal ${label} POLI ke tanggal ${label === 'BIAYA OBAT' ? 'sumber POLI' : 'history/hasil penunjang terkait'} ` +
                  `(${str(row, 'nama_tindakan') || '-'} → ${targetDatetime})`,
                trx: poliTrx,
                preconditions: [
                  PRECONDITION.tindakanPoliBelumTerverifikasi(poliTrx),
                  PRECONDITION.tindakanPoliBelumDibayar(line),
                  PRECONDITION.tindakanPoliBelumDitransfer(line),
                ],
                payload: updateTglPoliPayload({
                  noTransaksi: poliTrx,
                  kdTindakan,
                  urutTindakan,
                  targetDatetime,
                }),
                payloadSummary: {
                  no_registrasikunjungan: reg,
                  poli_trx: poliTrx,
                  poli_reg: str(source, 'no_registrasikunjungan') || '-',
                  nama_tindakan: str(row, 'nama_tindakan'),
                  target: targetDatetime,
                },
                readAfterWriteChecks: [
                  {
                    description: `Tanggal ${label} POLI ${kdTindakan}#${urutTindakan} terbaca ${updateTargetDate}`,
                    endpointId: 'poliklinik.getListTindakan',
                    where: { kd_tindakan: kdTindakan, urut_tindakan: urutTindakan },
                    field: 'tgl_transaksi',
                    expected: updateTargetDate,
                    match: 'contains',
                    payload: { no_transaksi: poliTrx, page: '1', rows: '999' },
                  },
                ],
              }),
            );
          }
          needsReplan = true;
          continue;
        }

        const resetRows = [
          ...(targetDate
            ? sourceRows.filter(
                (row) =>
                  isTransferredRow(row) &&
                  str(row, 'nama_tindakan').toUpperCase() === 'BIAYA OBAT' &&
                  datePart(str(row, 'tgl_transaksi', 'tgl_jam')) !== targetDate,
              )
            : []),
          ...poliTransferredPenunjangMismatchRows(sourceRows, labTargetDates, (name) => name === 'BIAYA LABORATORIUM'),
          ...poliTransferredPenunjangMismatchRows(sourceRows, radTargetDates, (name) => name.includes('BIAYA RADIOLOGI')),
        ].filter((row) => str(row, 'kd_tindakan') && str(row, 'urut_tindakan'));
        if (resetRows.length > 0) {
          const first = sortedRows(resetRows)[0]!;
          const firstLine: TindakanLineKey = {
            no_transaksi: poliTrx,
            kd_tindakan: str(first, 'kd_tindakan'),
            urut_tindakan: str(first, 'urut_tindakan'),
          };
          plans.push(
            mutationPlan(ctx, {
              node: 'process_poli',
              index: plans.length,
              endpointId: 'poliklinik.batalTransfer',
              riskLevel: 'high',
              reason: `Batal transfer POLI asal agar tanggal tagihan bisa disinkronkan (reg ${reg})`,
              trx: poliTrx,
              preconditions: [
                PRECONDITION.tindakanPoliBelumTerverifikasi(poliTrx),
                PRECONDITION.tindakanPoliSudahDitransfer(firstLine),
              ],
              payload: batalTransferPoliPayload(poliTrx, str(source, 'kd_unit') || '0'),
              payloadSummary: {
                no_registrasikunjungan: reg,
                poli_trx: poliTrx,
                poli_reg: str(source, 'no_registrasikunjungan') || '-',
                kd_unit: str(source, 'kd_unit') || '0',
                baris: resetRows.length,
              },
              readAfterWriteChecks: sortedRows(resetRows).map((row) => ({
                description: `Tindakan POLI ${str(row, 'kd_tindakan')}#${str(row, 'urut_tindakan')} terbaca belum transfer`,
                endpointId: 'poliklinik.cekStatusTransfer',
                field: '',
                expected: '0',
                match: 'empty',
                payload: {
                  no_transaksi: poliTrx,
                  kd_tindakan: str(row, 'kd_tindakan'),
                  urut_tindakan: str(row, 'urut_tindakan'),
                },
              })),
            }),
          );
          needsReplan = true;
          continue;
        }

        const labPkPlans = await planLabPkForPoliSource(ctx, client, {
          noRm: input.noRm,
          source,
          reg,
          firstIndex: plans.length,
        });
        if (labPkPlans.length > 0) {
          plans.push(...labPkPlans);
          needsReplan = true;
          continue;
        }

        const pending = sourceRows.filter((row) => !isTransferredRow(row));
        const kdTindakanList = sortedRows(pending)
          .map((row) => str(row, 'kd_tindakan'))
          .filter(Boolean);
        if (kdTindakanList.length === 0) {
          ctx.log(`- Tidak ada tagihan POLI asal yang perlu ditransfer | trx=${poliTrx}`, 'debug');
          continue;
        }

        const poliReg = str(source, 'no_registrasikunjungan');
        const destination = await fetchPoliLinkedTransaksi(ctx, client, input.noRm, poliReg);
        const noTransaksiPoli = str(destination, 'no_transaksi');
        const kdUnitPoli = str(destination, 'kd_unit');
        const kdDetkelpenjamin = str(destination, 'kd_detkelpenjamin') || str(source, 'kd_detkelpenjamin') || '15';
        const biaya = await softText(ctx, client, 'poliklinik.cekJumlahTransfer', { no_transaksi: poliTrx });
        const missingField =
          !noTransaksiPoli || !kdUnitPoli
            ? 'data transaksi tujuan POLI tidak lengkap'
            : !biaya.trim()
              ? 'biaya transfer POLI kosong'
              : '';
        if (missingField) {
          ctx.log(`- Skip transfer POLI | trx=${poliTrx} | alasan=${missingField}`, 'warn');
          alertsOf(ctx).registerRegAlert(reg, 'WARN', `Transfer POLI asal dilewati | ${missingField}`);
          missing.push(reg);
          continue;
        }

        plans.push(
          mutationPlan(ctx, {
            node: 'process_poli',
            index: plans.length,
            endpointId: 'poliklinik.transferIgd',
            riskLevel: 'high',
            reason: `Transfer tagihan POLI asal ke tagihan rawat inap (reg ${reg})`,
            trx: poliTrx,
            preconditions: [
              PRECONDITION.igdOrderSelesai(poliTrx),
              PRECONDITION.igdBiayaTransferAda(poliTrx),
            ],
            payload: transferIgdPayload({
              noTransaksi: poliTrx,
              noTransaksiPoli,
              kdUnitPoli,
              kdDetkelpenjamin,
              biaya,
              kdUnit: str(source, 'kd_unit'),
              kdTindakan: kdTindakanList.join("','"),
            }),
            payloadSummary: {
              no_registrasikunjungan: reg,
              poli_trx: poliTrx,
              poli_reg: poliReg || '-',
              no_transaksipoli: noTransaksiPoli,
              biaya,
              tindakan: kdTindakanList.length,
            },
            readAfterWriteChecks: sortedRows(pending)
              .filter((row) => str(row, 'kd_tindakan') && str(row, 'urut_tindakan'))
              .map((row) => ({
                description: `Tindakan POLI ${str(row, 'kd_tindakan')}#${str(row, 'urut_tindakan')} terbaca sudah transfer`,
                endpointId: 'poliklinik.cekStatusTransfer',
                field: '',
                expected: '1',
                match: 'nonEmpty',
                payload: {
                  no_transaksi: poliTrx,
                  kd_tindakan: str(row, 'kd_tindakan'),
                  urut_tindakan: str(row, 'urut_tindakan'),
                },
              })),
          }),
        );
      }

      const poliTitle = 'Tagihan poliklinik asal dirapikan sebelum digabung ke rawat inap';
      const poliChecks: ReasoningItem[] = [
        ...regs.map(([reg]): ReasoningItem => (missing.includes(reg)
          ? { label: `Transaksi POLI asal lengkap${regs.length > 1 ? ` (${reg})` : ''}`, ok: false, detail: 'tidak ditemukan / data tidak lengkap' }
          : { label: `Transaksi POLI asal ditemukan${regs.length > 1 ? ` (${reg})` : ''}`, ok: true, detail: str(poliSourceByReg[reg], 'no_transaksi') || '-' })),
        // Each planned fix is one line the operator can follow to its approval.
        ...plans.map((plan): ReasoningItem => ({ label: plan.reason, ok: false, detail: 'perlu dirapikan', planId: plan.id })),
      ];
      if (plans.length === 0 && missing.length === 0) poliChecks.push({ label: 'Tagihan poliklinik asal sudah sesuai', ok: true });
      if (plans.length === 0) {
        if (missing.length > 0) {
          return reasoned(review(`POLI asal tidak ditemukan/lengkap untuk ${missing.length} grup`, {
            warnings: [
              warning('poli_source_missing', `${missing.length} grup origin Poliklinik tanpa transaksi asal/lengkap`),
            ],
          }), poliTitle, poliChecks);
        }
        return reasoned(skipped(`Tagihan Poliklinik asal sudah sesuai${passSuffix(ctx)}`), poliTitle, poliChecks);
      }
      if (!needsReplan) return reasoned(planResult(`Rencana perapihan ${plans.length} tagihan Poliklinik asal${passSuffix(ctx)}`, plans), poliTitle, poliChecks);

      const passNote = replanNote(ctx, plans.length, 'rencana POLI asal', [
        `${plans.length} rencana POLI harus mendarat sebelum cabang berikutnya bisa dibaca`,
      ]);
      if (passNote.log) ctx.log(passNote.log, 'warn');
      return reasoned({
        status: 'needs_review',
        summary: `Rencana perapihan ${plans.length} baris tagihan Poliklinik asal${passNote.summarySuffix}`,
        proposedMutations: plans,
        needsReplan: true,
        ...(passNote.warning ? { warnings: [passNote.warning] } : {}),
      }, poliTitle, poliChecks);
    },

    'ranap.transferElektromedik': async (ctx) => {
      const items = getScratch<LegacyRow[]>(ctx, K.elektromedik) ?? [];
      // `sisa_no_transaksi_elektromedik` (ranap_v3.py:16510-16516): only the
      // charges that are *not* derivatives of an active IGD transfer. Transferring
      // all of them meant a hemodialysis IGD admission got both a
      // `poliklinik.transferIgd` and an `elektromedik.transferTagihan` plan for
      // the same charge — a double transfer if both were approved.
      const used = scratchSet(ctx, K.usedElektromedikTrx);
      const remaining = items.filter((row) => !used.has(str(row, 'no_transaksi')));
      const emTitle = 'Tagihan elektromedik ditransfer ke tagihan rawat inap';
      if (items.length === 0) return reasoned(skipped('Tidak ada penunjang elektromedik untuk ditransfer'), emTitle, [{ label: 'Ada tagihan elektromedik', ok: null, detail: 'tidak ada' }]);
      if (remaining.length === 0) {
        return reasoned(skipped(
          `Semua ${items.length} tagihan elektromedik sudah termasuk dalam transfer IGD asal`,
        ), emTitle, [{ label: 'Tagihan elektromedik ikut transfer IGD asal', ok: true, detail: `${items.length} transaksi` }]);
      }
      // `proses_tagihan_elektromedik` (ranap_v3.py:6310) transfers **one
      // transaction per call**, and each call needs the destination poli
      // transaction plus the unit `get_datakunjungan_elektromedik` reports for
      // it. One plan per transaction is therefore the wire shape, and it lets an
      // approver refuse a single charge.
      const plans: MutationPlan[] = [];
      const incomplete: string[] = [];
      for (const row of remaining) {
        const trx = str(row, 'no_transaksi');
        const noTransaksiPoli = str(row, 'no_transaksipoli');
        if (!trx || !noTransaksiPoli) {
          incomplete.push(trx || '-');
          continue;
        }
        const detail = await softJson<LegacyRow>(ctx, client, 'elektromedik.getDataKunjungan', {
          no_transaksipoli: noTransaksiPoli,
          no_transaksi: trx,
        });
        const kdUnitPoli = str(detail, 'kd_unit');
        if (!kdUnitPoli) {
          // ranap_v3.py:6292 — "Data kunjungan elektromedik tidak lengkap".
          ctx.log(`- Data kunjungan elektromedik tidak lengkap | trx=${trx}`, 'warn');
          incomplete.push(trx);
          continue;
        }
        plans.push(
          mutationPlan(ctx, {
            node: 'transfer_elektromedik',
            index: plans.length,
            endpointId: 'elektromedik.transferTagihan',
            riskLevel: 'high',
            reason: `Transfer tagihan elektromedik ${trx} ke tagihan rawat inap`,
            trx,
            // `proses_tagihan_elektromedik` only transfers a transaction whose
            // `cek_statusbayar` is still falsy (ranap_v3.py:6313).
            preconditions: [PRECONDITION.elektromedikBelumDibayar(trx)],
            // `transfer_tagihan_elektromedik` (ranap_v3.py:6176). The caller
            // leaves `kd_detkelpenjamin` at its default, so "15" it is.
            payload: {
              no_transaksi: trx,
              no_transaksipoli: noTransaksiPoli,
              kd_detkelpenjamin: '15',
              kd_unit_poli: kdUnitPoli,
            },
            payloadSummary: {
              no_transaksi: trx,
              no_transaksipoli: noTransaksiPoli,
              kd_unit_poli: kdUnitPoli,
              nama_unit: str(row, 'nama_unit'),
            },
            readAfterWriteChecks: [
              {
                description: 'Semua tindakan elektromedik terbaca sudah transfer',
                endpointId: 'elektromedik.getListTindakan',
                field: 'status_kirim',
                expected: '1',
                match: 'allEquals',
                payload: { no_transaksi: trx },
              },
            ],
          }),
        );
      }

      const emChecks: ReasoningItem[] = [
        ...incomplete.map((trx): ReasoningItem => ({ label: `Elektromedik ${trx} bisa ditransfer`, ok: false, detail: 'data kunjungan / tujuan transfer tidak lengkap' })),
        ...plans.map((plan): ReasoningItem => ({ label: plan.reason, ok: false, detail: 'belum ditransfer — transfer', planId: plan.id })),
      ];
      if (plans.length === 0) {
        return reasoned(review(`Data kunjungan elektromedik tidak lengkap untuk ${incomplete.length} transaksi`, {
          warnings: [
            warning('elektromedik_incomplete', `Transaksi elektromedik tanpa tujuan transfer: ${incomplete.join(', ')}`),
          ],
        }), emTitle, emChecks);
      }
      return reasoned(planResult(`Rencana transfer ${plans.length} tagihan elektromedik`, plans), emTitle, emChecks);
    },

    // ── Hanging transactions & blockers ──────────────────────────

    'ranap.scanHangingTrx': (ctx) => {
      const groups = roomGroupsOf(ctx);
      const allRows = getScratch<LegacyRow[]>(ctx, K.allVisitRows) ?? [];
      const elektromedik = getScratch<LegacyRow[]>(ctx, K.elektromedik) ?? [];
      const debug = isDebug(ctx);
      if (Object.keys(groups).length === 0) return skipped('Belum ada grup rawat inap');

      ctx.log(
        `2. Mengecek apakah ada transaksi lain yang masih menggantung untuk ${Object.keys(groups).length} grup rawat inap...`,
      );

      // `handled_transactions` is the union of **four** groups
      // (ranap_v3.py:16520-16536): the room transactions, the POLI source
      // transactions, the IGD source transactions, and the elektromedik list.
      // Omitting the IGD and POLI sources reported the very transaction the
      // pipeline is transferring as hanging, which raised a WARN reg-alert that
      // then blocked verification.
      const handled = new Set<string>();
      for (const rows of Object.values(groups)) {
        for (const row of rows) {
          const trx = str(row, 'no_transaksi');
          if (trx) handled.add(trx);
        }
      }
      for (const source of Object.values(scratchRecord<LegacyRow>(ctx, K.poliSourceByReg))) {
        const trx = str(source, 'no_transaksi');
        if (trx) handled.add(trx);
      }
      for (const trx of scratchSet(ctx, K.handledIgdTrx)) {
        if (trx) handled.add(trx);
      }
      for (const row of elektromedik) {
        const trx = str(row, 'no_transaksi');
        if (trx) handled.add(trx);
      }

      const hanging = findHangingRelatedTransactions({
        kunjunganRows: allRows,
        roomRowsByReg: groups,
        handledTransactions: handled,
        toleranceDays: toleranceOf(ctx),
      });

      const hangTitle = 'Transaksi terkait (IGD, poli, penunjang) sudah ditransfer atau dibayar';
      if (hanging.length === 0) {
        ctx.log(bulletLine('Tidak ada transaksi menggantung'));
        return reasoned(ok('Tidak ada transaksi terkait yang menggantung'), hangTitle, [{ label: 'Tidak ada transaksi menggantung', ok: true }]);
      }

      const alerts = alertsOf(ctx);
      for (const row of hanging) {
        const reg = str(row, '_hanging_reg');
        // The alert text carries no transaction number: `preverify_summary`
        // prints these lines and `emit_summary` copies them into the TSV
        // keterangan column, both of which are non-debug output, and the log spec
        // (line 59) keeps `no trx` behind the debug gate. The numbers travel in
        // this step's `hangingTransactions` evidence instead, where the renderer
        // can gate them.
        alerts.registerRegAlert(
          reg,
          'WARN',
          `Transaksi terkait masih menggantung | unit=${str(row, 'nama_unit') || '-'}`,
        );
        emit(
          ctx,
          dataBlock(
            [
              { label: 'Unit', value: str(row, 'nama_unit') },
              { label: 'Tgl masuk', value: str(row, 'tgl_masuk') },
              { label: 'Status bayar', value: str(row, 'status_bayar') },
              { label: 'No trx', value: str(row, 'no_transaksi'), debugOnly: true },
              { label: 'No reg', value: reg, debugOnly: true },
            ],
            { bullet: '+ Transaksi menggantung:', debug },
          ),
          'warn',
        );
      }
      return reasoned(review(`${hanging.length} transaksi terkait masih menggantung`, {
        warnings: [warning('hanging_trx', `${hanging.length} transaksi terkait belum ditransfer atau dibayar`)],
        evidence: [
          {
            label: 'hangingTransactions',
            data: hanging.map((row) => ({
              reg: str(row, '_hanging_reg'),
              noTransaksi: str(row, 'no_transaksi'),
              namaUnit: str(row, 'nama_unit'),
            })),
          },
        ],
      }), hangTitle, hanging.map((row) => ({ label: `${str(row, 'nama_unit') || 'Transaksi'} · masuk ${str(row, 'tgl_masuk') || '-'}`, ok: false, detail: `menggantung (${str(row, 'status_bayar') || 'belum bayar'}) — selesaikan di SIMRS` })));
    },

    'ranap.checkManualBlockers': (ctx) => {
      const groups = roomGroupsOf(ctx);
      const allRows = getScratch<LegacyRow[]>(ctx, K.allVisitRows) ?? [];
      const debug = isDebug(ctx);
      const tolerance = toleranceOf(ctx);
      if (Object.keys(groups).length === 0) return skipped('Belum ada grup rawat inap');

      const alerts = alertsOf(ctx);
      const found: string[] = [];
      const evidence: Array<{ reg: string; blocker: string; transaksi: string[]; units: string[] }> = [];
      const manualChecks: ReasoningItem[] = [];
      const manualTitle = 'Unit yang wajib dibayar/ditransfer manual sebelum verifikasi (Rules: Bank Darah, Cathlab)';
      for (const [reg, rows] of Object.entries(groups)) {
        const handled = new Set(rows.map((row) => str(row, 'no_transaksi')).filter(Boolean));
        const checks: Array<[string, LegacyRow[]]> = [
          [
            'BANK DARAH',
            collectBankDarahBlockers({
              kunjunganRows: allRows,
              roomRows: rows,
              handledTransactions: handled,
              toleranceDays: tolerance,
              unitKeywords: inputOf(ctx).manualBlockerUnits?.bankDarah,
            }),
          ],
          [
            'CATHLAB',
            collectCathlabBlockers({
              kunjunganRows: allRows,
              roomRows: rows,
              handledTransactions: handled,
              toleranceDays: tolerance,
              unitKeywords: inputOf(ctx).manualBlockerUnits?.cathlab,
            }),
          ],
        ];
        for (const [label, blockers] of checks) {
          manualChecks.push(blockers.length === 0
            ? { label: `Tidak ada transaksi ${label} tertunda${Object.keys(groups).length > 1 ? ` (${reg})` : ''}`, ok: true }
            : { label: `Tidak ada transaksi ${label} tertunda${Object.keys(groups).length > 1 ? ` (${reg})` : ''}`, ok: false, detail: `${blockers.length} belum ditransfer: ${[...new Set(blockers.map((row) => str(row, 'nama_unit') || '-'))].join(', ')} — transfer manual di SIMRS` });
          if (blockers.length === 0) continue;
          const transaksi = blockers.map((row) => str(row, 'no_transaksi') || '-');
          const units = blockers.map((row) => str(row, 'nama_unit') || '-');
          // Two details: the non-debug one names units only, and the transaction
          // numbers stay behind the debug gate (log spec line 59). The alert text
          // uses the unit form because `preverify_summary` prints it and
          // `emit_summary` can copy it into the TSV keterangan column.
          const unitDetail = [...new Set(units)].join(' ; ');
          const trxDetail = blockers
            .map((row) => `trx=${str(row, 'no_transaksi') || '-'} unit=${str(row, 'nama_unit') || '-'}`)
            .join(' ; ');
          alerts.registerRegAlert(
            reg,
            'ERROR',
            `Blocker verifikasi manual | transaksi ${label} belum ditransfer | unit=${unitDetail || '-'}`,
          );
          alerts.registerVerificationBlocker(reg, `transaksi ${label} belum ditransfer`);
          found.push(`${label} (${blockers.length})`);
          evidence.push({ reg, blocker: label, transaksi, units });
          emit(
            ctx,
            dataBlock(
              [
                { label: 'Alasan', value: `transaksi ${label} belum ditransfer` },
                { label: 'Detail', value: unitDetail },
                { label: 'Detail trx', value: trxDetail, debugOnly: true },
                { label: 'No reg', value: reg, debugOnly: true },
              ],
              { bullet: '+ Blocker verifikasi manual:', debug },
            ),
            'error',
          );
        }
      }

      if (found.length > 0) {
        // `needs_review`, not `blocked`: `main()` collects these blockers
        // (ranap_v3.py:16544-16592) and then still runs step 3 tindakan (16594),
        // 4 visite (16646), 5 IBS (16674), 6 penunjang (16697) and 7 obat pulang
        // (16727), skipping only the affected registration's verification
        // (16799-16809). In this graph a `blocked` status stops every downstream
        // node whatever its criticality, so returning it here threw away the
        // repairs and the plans of steps 20-24. The verification blockers
        // registered above are what `preverify_summary` — the single critical
        // gate — reads through `_get_blocking_reg_alerts`.
        return reasoned(review(`Blocker verifikasi manual: ${found.join(', ')}`, {
          warnings: [
            warning('manual_blocker', `Transaksi ${found.join(', ')} harus ditransfer manual lebih dulu`, 'error'),
          ],
          evidence: [{ label: 'manualBlockers', data: evidence }],
        }), manualTitle, manualChecks);
      }
      return reasoned(ok('Tidak ada blocker verifikasi manual'), manualTitle, manualChecks);
    },

    'ranap.detectBlockers': async (ctx) => {
      const groups = roomGroupsOf(ctx);
      const regs = Object.keys(groups);
      if (regs.length === 0) return skipped('Belum ada grup rawat inap');

      const alerts = alertsOf(ctx);
      const hardByReg = scratchRecord<string>(ctx, K.penunjangBlockerByReg);
      const hard: string[] = [];
      const soft: string[] = [];
      const penChecks: ReasoningItem[] = [];
      const penTitle = 'Order penunjang (lab, radiologi, gizi, …) yang belum ditransfer/terlayani';
      for (const reg of regs) {
        const res = await softJson<unknown>(ctx, client, 'verifikator.cekTransaksiPenunjang', {
          no_registrasikunjungan: reg,
        });
        const blocker = normalizePenunjangBlocker(res);
        const regLabel = regs.length > 1 ? ` (${reg})` : '';
        if (!blocker.hasBlocker) {
          penChecks.push({ label: `Tidak ada order penunjang tertunda${regLabel}`, ok: true });
          continue;
        }
        const label = penunjangBlockerLabel(blocker);
        penChecks.push(isGiziPenunjangBlocker(blocker)
          ? { label: `Tidak ada order penunjang tertunda${regLabel}`, ok: false, detail: `${label} — order gizi, dipulihkan otomatis di langkah Recovery Gizi` }
          : { label: `Tidak ada order penunjang tertunda${regLabel}`, ok: false, detail: `${label} — verifikasi grup ini ditahan sampai diselesaikan di SIMRS` });
        if (isGiziPenunjangBlocker(blocker)) {
          alerts.registerRegAlert(reg, 'WARN', `Blocker penunjang sebelum verifikasi | ${label}`);
          soft.push(label);
        } else {
          alerts.registerRegAlert(reg, 'ERROR', `Blocker penunjang sebelum verifikasi | ${label}`);
          // `proses_verifikasi_inap` refuses this registration and registers
          // `blocker_penunjang_manual` (ranap_v3.py:15492-15503). It is not one of
          // the three shapes `_get_blocking_reg_alerts` recognises, so it does not
          // hold `preverify_summary` — it holds *this registration's*
          // verification, which `execute_verifikasi` reproduces.
          hardByReg[reg] = label;
          hard.push(label);
        }
        ctx.log(`+ Blocker penunjang: ${label}`, isGiziPenunjangBlocker(blocker) ? 'warn' : 'error');
      }

      if (hard.length > 0) {
        // `needs_review`, for the same reason as `check_manual_blockers`: `main()`
        // reads this blocker per registration inside the verification loop
        // (ranap_v3.py:16780) and skips only that registration, and a `blocked`
        // status here would stop every downstream node instead.
        // `execute_verifikasi` refuses the affected registration.
        return reasoned(review(`Blocker penunjang: ${hard.join(', ')}`, {
          warnings: [warning('penunjang_blocker', hard.join(', '), 'error')],
        }), penTitle, penChecks);
      }
      if (soft.length > 0) {
        return reasoned(review(`Blocker penunjang gizi: ${soft.join(', ')} — dapat dipulihkan otomatis`, {
          warnings: [warning('gizi_blocker', soft.join(', '))],
        }), penTitle, penChecks);
      }
      return reasoned(ok('Tidak ada blocker penunjang'), penTitle, penChecks);
    },

    // ── Tindakan / visite ────────────────────────────────────────

    /**
     * `sinkronkan_tindakan_harian_inap` (ranap_v3.py:13964), per stay.
     *
     * The decision half is `logic/tindakanSync.ts`; this fetches everything its
     * argument interface names, calls it once per room transaction, prints the
     * plan's own log block, files its issues on the run's alert registry and
     * turns each returned operation into one `MutationPlan` — in the planner's
     * `sequence` order, which is the Python's execution order and is not
     * reorderable.
     *
     * The planner assumes every operation it emits succeeds, exactly as the
     * legacy `DRY_RUN` branch does, so on a real write run the operator has to
     * re-read and re-plan after applying them: a refused or failed write
     * invalidates every later operation in the list, and the row a `tambah`
     * creates gets its `urut_tindakan` from the backend.
     *
     * That re-read is a **re-plan pass**: on `ctx.pass > 1` the charge lines are
     * re-fetched before anything is planned (`reloadChargeLines`), so the rows a
     * previous pass added exist, and the rows a previous pass re-dated but the
     * backend did not move are simply planned again — which is
     * `_find_unmatched_updated_rows` (ranap_v3.py:4049) expressed as another
     * pass rather than as an inline retry.
     *
     * `now` is `ctx.clock.now()`, the run's injected clock, read once for the
     * whole step: `_build_update_datetime` stamps the wall clock onto every
     * target date, and reading it per row would make the proposed
     * `txttglupdate_inap` differ between two replays of the same run.
     */
    'ranap.syncTindakan': async (ctx) => {
      const input = inputOf(ctx);
      const groups = roomGroupsOf(ctx);
      const entries = Object.entries(groups);
      const assignments = getScratch<Record<string, string[]>>(ctx, K.roomDayAssignments) ?? {};
      if (ctx.pass > 1) await reloadChargeLines(ctx, client);
      const listByTrx = getScratch<Record<string, LegacyRow[]>>(ctx, K.listTindakanByTrx) ?? {};
      const windows = getScratch<Record<string, { start: string; end: string }>>(ctx, K.groupWindowByReg) ?? {};
      const poliSourceByReg = scratchRecord<LegacyRow>(ctx, K.poliSourceByReg);
      const poliRowsByReg = scratchRecord<LegacyRow[]>(ctx, K.poliSourceRowsByReg);
      const elektromedikHistory = getScratch<LegacyRow[]>(ctx, K.elektromedik) ?? [];
      const sep = getScratch<SepResult>(ctx, K.sepResult);
      const alerts = alertsOf(ctx);
      const debug = isDebug(ctx);
      const stays = entries.flatMap(([, rows]) => rows);
      if (stays.length === 0) return skipped('Belum ada ruang untuk disinkronkan');

      ctx.log(`3. Sinkronisasi tindakan rawat inap untuk ${stays.length} transaksi...`);
      const anchorDate = sep?.matchedTanggal || sep?.targetTanggal || input.tanggal;
      const now = ctx.clock.now();
      const histories = await loadPenunjangHistories(ctx, client, input.noRm);

      const plans: MutationPlan[] = [];
      const untouched: Array<{ reg: string; trx: string; tindakan: string; alasan: string }> = [];
      /** Rows the planner refused because they are already verified, per reg. */
      const verifiedByReg: Record<string, Array<{ row: LegacyRow; reason: string; noTransaksi: string }>> = {};
      let index = 0;
      let issueCount = 0;
      /** How many lines climbed `_tampung_pelaksana_checked`'s ladder this pass. */
      let escalations = 0;

      for (const [reg, rooms] of entries) {
        const window = windows[reg] ?? getRoomGroupDateRange(rooms);
        const paHistory = filterHistoryRowsForDateRange(histories.pa, window.start, window.end);
        const radHistory = filterHistoryRowsForDateRange(histories.rad, window.start, window.end);
        const labHistory = filterHistoryRowsForDateRange(histories.lab, window.start, window.end);
        const paDetailCount = await detailRowCounts(ctx, client, 'kemoterapi.getDetailHistoryOrderPa', paHistory);
        const radDetailCount = await detailRowCounts(ctx, client, 'penatajasaInap.getDetailHistoryIrad', radHistory);
        const rekapDetailHakHtml = await fetchRekapHtml(ctx, client, reg, rooms);
        const poliSourceRows = poliRowsByReg[reg] ?? [];
        const poliSource = poliSourceByReg[reg]
          ? { ...poliSourceByReg[reg], tindakan_rows: poliSourceRows }
          : undefined;

        for (const room of rooms) {
          const trx = str(room, 'no_transaksi');
          const roomName = str(room, 'nama_unit');
          const kdUnit = str(room, 'kd_unit');
          const dates = assignments[trx] ?? [];
          const pelaksana = await resolveRoomPelaksana(
            ctx,
            client,
            roomName,
            str(room, 'kd_unit_setting', 'kd_unit'),
          );
          emit(
            ctx,
            numberedBlock(
              index + 1,
              [
                { label: 'Nama ruang', value: roomName },
                { label: 'Pelaksana jasa', value: pelaksana },
                { label: 'Tanggal', value: dates },
                { label: 'No trx', value: trx, debugOnly: true },
                { label: 'No reg', value: str(room, 'no_registrasikunjungan'), debugOnly: true },
              ],
              { indent: '   ', debug },
            ),
          );
          emit(ctx, [bulletLine('Sinkronisasi tindakan', '      ')]);
          index += 1;
          if (!trx) continue;

          const listRows = listByTrx[trx] ?? [];
          const kdDetkelpenjamin = str(room, 'kd_detkelpenjamin') || '15';
          const datakunjungan = await softJson<LegacyRow>(ctx, client, 'penatajasaInap.getDataKunjungan', {
            txtmedrec_inap: input.noRm,
            no_transaksi: trx,
          });
          const datakunjunganTab = await softJson<LegacyRow>(ctx, client, 'penatajasaInap.getDataKunjunganTab', {
            no_registrasikunjungan: reg,
            kd_unit: kdUnit,
            no_transaksi: trx,
            urut_masuk_ruang: str(room, 'urut_masuk_ruang'),
          });
          const datakunjunganTab2 = await softJson<LegacyRow>(ctx, client, 'poliklinik.getDataKunjunganTab2', {
            no_registrasikunjungan: reg,
            kd_unit: kdUnit,
          });
          // `ambil_master_tindakan_inap` (ranap_v3.py:3907) and
          // `ambil_master_tindakan_verifikator` (4832) are both GETs.
          const masterRows = await fetchMasterTindakan(ctx, client, 'penatajasaInap.getTindakan', kdUnit, kdDetkelpenjamin);
          const verifikatorMasterRows = await fetchMasterTindakan(ctx, client, 'verifikator.getTindakan', kdUnit, kdDetkelpenjamin);
          const verifikatorDatakunjungan = await softJson<LegacyRow>(ctx, client, 'verifikator.getDataKunjungan', {
            txtmedrec_vrf: input.noRm,
            no_transaksi: trx,
          });
          const verifikatorDatakunjunganTab = await softJson<LegacyRow>(
            ctx,
            client,
            'verifikator.getDataKunjunganTab',
            {
              no_registrasikunjungan: reg,
              kd_unit: kdUnit,
              no_transaksi: trx,
              urut_masuk_ruang: str(room, 'urut_masuk_ruang'),
            },
          );
          const paramedisOptions = await fetchParamedisPelaksana(ctx, client, kdUnit || 'undefined');
          const komponenRows = await komponenRowsProvider(ctx, client, trx, listRows);
          const statusBayarTindakan = await statusProbe(ctx, client, 'penatajasaInap.cekStatusBayar', trx, listRows);
          const labTargetRows = await collectHistoryTargetRowsByReference(
            ctx,
            client,
            trx,
            labHistory,
            'laboratoriumHasil.getDetailTransaksi',
            'no_transaksi',
          );

          const plan = planTindakanSync({
            noRm: input.noRm,
            kunjunganInap: room,
            tglSep: anchorDate,
            ...(datakunjungan ? { datakunjungan } : {}),
            ...(datakunjunganTab ? { datakunjunganTab } : {}),
            ...(datakunjunganTab2 ? { datakunjunganTab2 } : {}),
            listRows,
            masterRows,
            verifikatorMasterRows,
            ...(verifikatorDatakunjungan ? { verifikatorDatakunjungan } : {}),
            ...(verifikatorDatakunjunganTab ? { verifikatorDatakunjunganTab } : {}),
            targetDatesOverride: dates,
            ...(poliSource ? { poliSource } : {}),
            elektromedikHistory,
            labTargetRows,
            paHistory,
            paDetailCount,
            radHistory,
            radDetailCount,
            rekapDetailHakHtml,
            // `statusVerifikasiTindakan` is deliberately not supplied:
            // `bolehHapusTindakan` only consults it when the row's own
            // `status_verifikasi` hint is non-falsy, and `rowAllowsDeleteByHint`
            // has already refused every such row, so the read is unreachable.
            // The guard still fires at write time — it is a `Precondition` on
            // every delete plan, replayed by the mutation gate.
            roomPelaksana: pelaksana,
            roomPelaksanaOptionNames: paramedisOptions
              .map((item) => normalizeParamedisDisplay(str(item, 'nama_paramedis')))
              .filter(Boolean),
            paramedisOptions,
            komponenRows,
            statusBayarTindakan,
            debug,
            now,
          });

          // The planner's own operator block, in order.
          emit(ctx, plan.lines);
          issueCount += registerPlannerIssues(alerts, reg, 'sinkronkan_tindakan_harian_inap', plan.issues);
          for (const row of plan.untouched) {
            untouched.push({
              reg,
              trx,
              tindakan: str(row.row, 'nama_tindakan'),
              alasan: row.reason,
            });
            // `_ensure_tindakan_belum_terverifikasi` (ranap_v3.py:12286): a row
            // the planner refused *because it is verified* is not a dead end in
            // the legacy — it calls `batal_verifikasi` and edits it anyway.
            if (looksVerifiedButOtherwiseEditable(row.row)) {
              (verifiedByReg[reg] ??= []).push({
                row: row.row,
                reason: row.reason,
                noTransaksi: trx,
              });
            }
          }
          for (const op of plan.ops) {
            if (op.kind === 'setPelaksana') {
              const rungs = pelaksanaLadder(ctx, 'sync_tindakan', {
                line: {
                  noTransaksi: op.noTransaksi,
                  kdTindakan: op.kdTindakan ?? '',
                  urutTindakan: op.urutTindakan ?? '',
                  kdKomponen: op.kdKomponen ?? '',
                },
                desired: op.pelaksana ?? '',
                currentName:
                  getKomponenParamedisName(op.row ?? {}, komponenRows, op.kdKomponen ?? '') ?? '',
                paramedisOptions,
              });
              if (rungs.length > 1) escalations += 1;
              for (const rung of rungs) {
                plans.push(tindakanOpPlan(ctx, 'sync_tindakan', plans.length, op, rung));
              }
              continue;
            }
            plans.push(tindakanOpPlan(ctx, 'sync_tindakan', plans.length, op));
          }
        }
      }

      // One `batal_verifikasi` per registration, appended after the pass's own
      // repairs: the rows it unblocks are planned on the *next* pass, once the
      // un-verification has landed and read back.
      const batalPlans = await planBatalVerifikasi(ctx, client, 'sync_tindakan', verifiedByReg, plans.length);
      plans.push(...batalPlans);

      const evidence = [
        { label: 'tindakanUntouched', data: untouched },
        { label: 'tindakanOps', data: plans.map((item) => ({ id: item.id, endpointId: item.endpointId })) },
      ];
      // Two kinds of outstanding work justify another pass, and only these two.
      //
      // A plan the gate cannot execute is work this pass could not finish: the
      // row it targets does not exist yet, so there is no `urut_tindakan` to
      // address it with. Everything `tindakanOpPlan` builds today carries a
      // payload, so this is a guard for the day the planner grows a follow-up
      // to its own `tambah` — not a live path.
      //
      // A `batal_verifikasi` is the other: the rows it unblocks can only be
      // planned once it has landed and read back.
      //
      // What is deliberately *not* a reason is "this pass proposed a performer
      // write and would like to watch it land". The barrier releases a node only
      // when **every** plan of the pass is terminal, and an add has no line yet to
      // read back, so the gate leaves it `applied` — parking on one would hang the
      // node. It would also stop every ordinary write run here, short of
      // `final_gate`. The retry ladder therefore reacts on whatever pass the node
      // does take; see `pelaksanaLadder`.
      const unaddressable = plans.filter((plan) => plan.payload === undefined).length;
      const passNote = replanNote(ctx, unaddressable + batalPlans.length, 'rencana tindakan', [
        ...(unaddressable > 0 ? [`${unaddressable} rencana tindakan belum dapat dialamatkan`] : []),
        ...(batalPlans.length > 0
          ? [`${batalPlans.length} batal verifikasi harus mendarat sebelum barisnya bisa diperbaiki`]
          : []),
      ]);
      // Per room: does its daily billing already match the stay? Then one line per fix, linked to its plan.
      // Plan ids end with ":<no_transaksi>" (see `mutationPlan`); tindakan summaries carry no trx field.
      const tindakanChecks: ReasoningItem[] = [
        ...stays.map((stay): ReasoningItem => {
          const fixes = plans.filter((plan) => plan.id.endsWith(`:${str(stay, 'no_transaksi')}`));
          return fixes.length === 0
            ? { label: `Tindakan harian ${str(stay, 'nama_unit') || 'ruang'} sesuai`, ok: true }
            : { label: `Tindakan harian ${str(stay, 'nama_unit') || 'ruang'} sesuai`, ok: false, detail: `${fixes.length} perbaikan direncanakan` };
        }),
        ...plans.map((plan): ReasoningItem => ({ label: plan.reason, ok: false, detail: 'perbaikan', planId: plan.id })),
      ];
      const tindakanTitle = `Tindakan harian (kamar, visite perawat, dll.) dicocokkan dengan hari rawat · ${stays.length} ruang`;
      if (plans.length === 0) {
        return reasoned(ok(
          `Tindakan harian sudah sesuai untuk ${stays.length} transaksi ruang${passSuffix(ctx)}`,
          { evidence },
        ), tindakanTitle, tindakanChecks);
      }
      if (escalations > 0) {
        // `- Retry pelaksana sementara …` (ranap_v3.py:4532).
        ctx.log(
          `- Retry pelaksana sementara untuk ${escalations} baris | ` +
            `alasan=write pelaksana pass sebelumnya gagal (workaround DATABASE ERROR)`,
          'warn',
        );
      }
      // The plan assumes each write lands; say so where the operator reads it.
      ctx.log(
        `- Rencana dibuat dengan asumsi setiap write berhasil (mengikuti cabang DRY_RUN ranap_v3.py) | ` +
          `catatan=setelah eksekusi wajib re-read ambil_listtindakan dan re-plan`,
        'warn',
      );
      if (passNote.log) ctx.log(passNote.log, 'warn');
      return reasoned({
        status: 'needs_review',
        summary:
          `Rencana ${plans.length} perbaikan tindakan harian untuk ${stays.length} transaksi ruang ` +
          `(asumsi write berhasil — perlu re-plan setelah eksekusi)${passNote.summarySuffix}`,
        proposedMutations: plans,
        evidence,
        ...(passNote.needsReplan ? { needsReplan: true } : {}),
        ...(issueCount > 0 || passNote.warning
          ? {
              warnings: [
                ...(issueCount > 0
                  ? [warning('tindakan_sync_issue', `${issueCount} catatan sinkronisasi tindakan`)]
                  : []),
                ...(passNote.warning ? [passNote.warning] : []),
              ],
            }
          : {}),
      }, tindakanTitle, tindakanChecks);
    },

    /**
     * `sinkronkan_visite_konsultasi_spesialis_group` (ranap_v3.py:11982), per
     * registration, through `logic/visiteSync.ts`.
     *
     * The planner returns `status: 'incomplete'` when it emitted an add — whose
     * created row the backend names, so the follow-up `updateTgl`/`setPelaksana`
     * cannot be addressed yet — or when it hit the 20-iteration cap. That is
     * never a clean success: the step reports `needs_review`, carries the
     * planner's own "execute, re-read, re-plan" warning, and asks the engine for
     * another pass (`StepResult.needsReplan`).
     *
     * On that pass (`ctx.pass > 1`) the charge lines are re-fetched first, so
     * the row the add created is present with its backend-assigned
     * `urut_tindakan` — which is exactly what turns the two payload-less
     * follow-ups into ordinary, executable plans. A write run therefore closes
     * the repair the legacy script performs inline; a preview run never
     * re-plans, because nothing was ever applied for it to re-read.
     */
    'ranap.syncVisite': async (ctx) => {
      const input = inputOf(ctx);
      const groups = roomGroupsOf(ctx);
      const entries = Object.entries(groups);
      if (entries.length === 0) return skipped('Belum ada grup rawat inap');

      const assignments = getScratch<Record<string, string[]>>(ctx, K.roomDayAssignments) ?? {};
      if (ctx.pass > 1) await reloadChargeLines(ctx, client);
      const listByTrx = getScratch<Record<string, LegacyRow[]>>(ctx, K.listTindakanByTrx) ?? {};
      const alerts = alertsOf(ctx);
      // One clock read per pass — see `ranap.syncTindakan`.
      const now = ctx.clock.now();

      ctx.log(`4. Sinkronisasi visite/konsultasi spesialis untuk ${entries.length} grup rawat inap...`);

      const plans: MutationPlan[] = [];
      const untouched: Array<{ reg: string; tindakan: string; alasan: string }> = [];
      const incompleteRegs: string[] = [];
      const verifiedByReg: Record<string, Array<{ row: LegacyRow; reason: string; noTransaksi: string }>> = {};
      let issueCount = 0;
      let escalations = 0;
      // Operator checklist across registrations; plan ids replace the planner's op sequences.
      const reasoningItems: ReasoningItem[] = [];
      const reasoningTitles: string[] = [];

      for (const [reg, rooms] of entries) {
        const listTindakanByNoTransaksi: Record<string, unknown> = {};
        const masterTindakanByNoTransaksi: Record<string, unknown> = {};
        const dataKunjunganByNoTransaksi: Record<string, unknown> = {};
        const dataTransaksiByNoTransaksi: Record<string, unknown> = {};
        const paramedisPelaksanaByKdUnit: Record<string, unknown> = {};
        const komponenDetailByRow: Record<string, unknown> = {};
        const statusBayarByTindakan: Record<string, unknown> = {};
        const statusVerifikasiByTindakan: Record<string, unknown> = {};
        const roomDayAssignments: Record<string, readonly string[]> = {};

        for (const room of rooms) {
          const trx = str(room, 'no_transaksi');
          if (!trx) continue;
          const kdUnit = str(room, 'kd_unit');
          roomDayAssignments[trx] = assignments[trx] ?? [];
          const listRows = listByTrx[trx] ?? [];
          listTindakanByNoTransaksi[trx] = listRows;
          masterTindakanByNoTransaksi[trx] = await fetchMasterTindakan(
            ctx,
            client,
            'penatajasaInap.getTindakan',
            kdUnit,
            str(room, 'kd_detkelpenjamin') || '15',
          );
          const dataInap =
            (await softJson<LegacyRow>(ctx, client, 'penatajasaInap.getDataKunjungan', {
              txtmedrec_inap: input.noRm,
              no_transaksi: trx,
            })) ?? {};
          dataKunjunganByNoTransaksi[trx] = dataInap;
          // `_get_patient_paramedis_group_info` only reaches `ambil_datatransaksi`
          // when `ambil_datakunjungan` came back empty (ranap_v3.py:10230), so
          // the kasir read is not issued unless that happens.
          if (Object.keys(dataInap).length === 0) {
            dataTransaksiByNoTransaksi[trx] =
              (await softJson<LegacyRow>(ctx, client, 'kasir.getDataTransaksi', {
                txtmedrec: input.noRm,
                no_transaksi: trx,
                kd_unit: kdUnit,
                no_registrasikunjungan: reg,
              })) ?? {};
          }
          const bucket = kdUnit || 'undefined';
          if (!(bucket in paramedisPelaksanaByKdUnit)) {
            paramedisPelaksanaByKdUnit[bucket] = await fetchParamedisPelaksana(ctx, client, bucket);
          }
          // Only the specialist rows need a component read and a status probe.
          for (const row of listRows) {
            if (!getSpesialisActionKey(row)) continue;
            const keyed = { ...row, no_transaksi: trx };
            komponenDetailByRow[komponenDetailKey(keyed)] = await softJson<unknown>(
              ctx,
              client,
              'penatajasaInap.getDetailKomponenTransaksi',
              {},
              // ranap_v3.py:4232 sends these as query params on a POST; as a form
              // body the backend answers "Database Error" (verified live 2026-10-15).
              {
                query: {
                  no_transaksi: trx,
                  kd_tindakan: str(row, 'kd_tindakan'),
                  tgl_jam: str(row, 'tgl_jam', 'tgl_transaksi'),
                  urut_tindakan: str(row, 'urut_tindakan'),
                },
              },
            );
            const statusKey = tindakanStatusKey(keyed);
            const probe = { no_transaksi: trx, kd_tindakan: str(row, 'kd_tindakan'), urut_tindakan: str(row, 'urut_tindakan') };
            statusBayarByTindakan[statusKey] = await softText(ctx, client, 'penatajasaInap.cekStatusBayar', probe);
            statusVerifikasiByTindakan[statusKey] = await softText(
              ctx,
              client,
              'penatajasaInap.cekStatusVerifikasi',
              probe,
            );
          }
        }

        const cpptV1RowsByNoReg = { [reg]: await fetchCpptV1Rows(ctx, client, input.noRm, reg) };
        // `_get_evo_v2_doctor_date_match` (ranap_v3.py:3282) falls back to the
        // v2 timeline when v1 has no note for a day. Only issued when the
        // deployment really has a v2 API; see `RanapDeps.baseUrlV2`.
        const cpptV2Rows = await fetchCpptV2Rows(ctx, client, baseUrlV2, input.noRm, reg);

        const plan = planVisiteSync({
          noRm: input.noRm,
          roomRows: rooms,
          roomDayAssignments,
          listTindakanByNoTransaksi,
          komponenDetailByRow,
          masterTindakanByNoTransaksi,
          paramedisPelaksanaByKdUnit,
          dataKunjunganByNoTransaksi,
          dataTransaksiByNoTransaksi,
          cpptV1RowsByNoReg,
          ...(cpptV2Rows ? { cpptV2RowsByNoReg: { [reg]: cpptV2Rows } } : {}),
          statusBayarByTindakan,
          statusVerifikasiByTindakan,
          debug: isDebug(ctx),
          now,
        });

        emit(ctx, plan.lines);
        issueCount += registerPlannerIssues(alerts, reg, 'sinkronkan_visite_spesialis', plan.issues);
        for (const row of plan.untouched) {
          untouched.push({ reg, tindakan: str(row.row, 'nama_tindakan'), alasan: row.reason });
          if (looksVerifiedButOtherwiseEditable(row.row)) {
            (verifiedByReg[reg] ??= []).push({
              row: row.row,
              reason: row.reason,
              noTransaksi: str(row.row, 'no_transaksi'),
            });
          }
        }
        if (plan.status === 'incomplete') incompleteRegs.push(reg);
        // The specialist repair posts to the same `tampung_pelaksana_tindakan`
        // the daily sweep does, so it inherits the same retry ladder.
        const komponenFor = (row: LegacyRow) => rowsOf(komponenDetailByRow[komponenDetailKey(row)]);
        // Op sequence → index of its first plan (a retry ladder adds more after it).
        const planIndexBySequence = new Map<number, number>();
        for (const op of plan.ops) {
          planIndexBySequence.set(op.sequence, plans.length);
          if (op.kind === 'setPelaksana' && op.urutTindakan) {
            const rungs = pelaksanaLadder(ctx, 'sync_visite', {
              line: {
                noTransaksi: op.noTransaksi,
                kdTindakan: op.kdTindakan ?? '',
                urutTindakan: op.urutTindakan,
                kdKomponen: op.kdKomponen ?? '',
              },
              desired: op.pelaksana ?? '',
              currentName:
                getKomponenParamedisName(op.row ?? {}, komponenFor, op.kdKomponen ?? '') ?? '',
              // The same bucket `setPelaksanaOnRow` resolves the desired name
              // from (`_get_spesialis_fallback_kd_unit`, ranap_v3.py:10455): a
              // specialist charge row carries no `kd_unit` of its own, so the
              // dropdown belongs to the stay it sits on.
              paramedisOptions: rowsOf(
                paramedisPelaksanaByKdUnit[getSpesialisFallbackKdUnit(op.row ?? {}) || 'undefined'],
              ),
            });
            if (rungs.length > 1) escalations += 1;
            for (const rung of rungs) {
              plans.push(visiteOpPlan(ctx, 'sync_visite', plans.length, op, rung));
            }
            continue;
          }
          plans.push(visiteOpPlan(ctx, 'sync_visite', plans.length, op));
        }
        if (plan.reasoning) {
          const prefix = entries.length > 1 ? `${reg} · ` : '';
          reasoningTitles.push(`${prefix}${plan.reasoning.title}`);
          for (const item of plan.reasoning.items) {
            const index = item.opSequence !== undefined ? planIndexBySequence.get(item.opSequence) : undefined;
            const planId = index !== undefined ? plans[index]?.id : undefined;
            reasoningItems.push({ label: `${prefix}${item.label}`, ok: item.ok, ...(item.detail ? { detail: item.detail } : {}), ...(planId ? { planId } : {}) });
          }
        }
      }

      const batalPlans = await planBatalVerifikasi(ctx, client, 'sync_visite', verifiedByReg, plans.length);
      plans.push(...batalPlans);

      const evidence = [
        { label: 'visiteUntouched', data: untouched },
        ...(reasoningItems.length ? [reasoningEvidence({ title: reasoningTitles.join(' · '), items: reasoningItems })] : []),
      ];
      if (plans.length === 0 && incompleteRegs.length === 0) {
        return ok(
          `Visite/konsultasi spesialis sudah sesuai untuk ${entries.length} grup${passSuffix(ctx)}`,
          { evidence },
        );
      }

      const warnings: WorkflowIssue[] = [];
      if (issueCount > 0) {
        warnings.push(warning('visite_sync_issue', `${issueCount} catatan sinkronisasi visite`));
      }
      const passNote = replanNote(ctx, incompleteRegs.length + batalPlans.length, 'grup visite', [
        ...(incompleteRegs.length > 0 ? [`${incompleteRegs.length} grup visite belum lengkap`] : []),
        ...(batalPlans.length > 0
          ? [`${batalPlans.length} batal verifikasi harus mendarat sebelum barisnya bisa diperbaiki`]
          : []),
      ]);
      if (escalations > 0) {
        ctx.log(
          `- Retry pelaksana sementara untuk ${escalations} baris visite | ` +
            `alasan=write pelaksana pass sebelumnya gagal (workaround DATABASE ERROR)`,
          'warn',
        );
      }
      if (incompleteRegs.length > 0) {
        // The planner's own `'incomplete'`: execute, re-read, re-plan. On a write
        // run the engine now performs that loop; on preview it stays advice.
        ctx.log(
          `[WARN] Rencana visite belum lengkap | reg=${incompleteRegs.join(', ')} | ` +
            `aksi=execute, re-read get_listtindakan, lalu re-plan`,
          'warn',
        );
        warnings.push(
          warning(
            'visite_incomplete',
            `Rencana visite belum lengkap untuk ${incompleteRegs.length} grup — execute, re-read, re-plan`,
          ),
        );
      }
      if (passNote.log) ctx.log(passNote.log, 'warn');
      if (passNote.warning) warnings.push(passNote.warning);
      // Never a clean success: the plan models writes it could not observe.
      ctx.log(
        `- Rencana dibuat dengan asumsi setiap write berhasil (mengikuti cabang DRY_RUN ranap_v3.py)`,
        'warn',
      );
      return {
        status: 'needs_review',
        summary:
          incompleteRegs.length > 0
            ? `Rencana ${plans.length} perbaikan visite/konsultasi — ${incompleteRegs.length} grup perlu re-plan setelah eksekusi${passNote.summarySuffix}`
            : `Rencana ${plans.length} perbaikan visite/konsultasi spesialis (asumsi write berhasil)${passSuffix(ctx)}`,
        ...(plans.length > 0 ? { proposedMutations: plans } : {}),
        evidence,
        ...(passNote.needsReplan ? { needsReplan: true } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },

    'ranap.validateIbs': async (ctx) => {
      const groups = roomGroupsOf(ctx);
      const listByTrx = getScratch<Record<string, LegacyRow[]>>(ctx, K.listTindakanByTrx) ?? {};
      const debug = isDebug(ctx);
      const regs = Object.entries(groups);
      if (regs.length === 0) return skipped('Belum ada grup rawat inap');

      ctx.log(`5. Validasi IBS untuk ${regs.length} grup rawat inap...`);
      const alerts = alertsOf(ctx);
      const problems: string[] = [];
      const ibsChecks: ReasoningItem[] = [];
      for (const [reg, rows] of regs) {
        const lines = rows.flatMap((row) => listByTrx[str(row, 'no_transaksi')] ?? []);
        // `validate_ibs_consistency` (ranap_v3.py:8831) reads the rekapitulasi
        // page for the DEPO IBS side of the comparison; without it `hasDepoIbs`
        // was always false and only the half-of-a-mismatch could ever be seen.
        const rekapitulasiHtml = await fetchRekapHtml(ctx, client, reg, rows);
        const args = { roomRows: rows, listTindakanRows: lines, rekapitulasiHtml, manualReviewRooms: inputOf(ctx).ibsManualReviewRooms };
        const context = detectIbsBedahContext(args);
        const verdict = validateIbsConsistency(args);
        emit(
          ctx,
          dataBlock(
            [
              { label: 'Hasil', value: verdict.ok ? 'Konsisten' : verdict.reason || 'Perlu cek manual' },
              { label: 'Biaya IBS', value: context.hasBiayaIbs },
              { label: 'Depo IBS', value: context.hasDepoIbs },
              { label: 'No reg', value: reg, debugOnly: true },
            ],
            { bullet: '+ Validasi IBS:', indent: '   ', debug },
          ),
          verdict.ok ? 'info' : 'warn',
        );
        ibsChecks.push({
          label: `Biaya IBS dan depo IBS konsisten${regs.length > 1 ? ` (${reg})` : ''}`,
          ok: verdict.ok,
          detail: `biaya IBS: ${context.hasBiayaIbs ? 'ada' : 'tidak'} · depo IBS: ${context.hasDepoIbs ? 'ada' : 'tidak'}${verdict.ok ? '' : ` — ${verdict.reason || 'perlu cek manual'}`}`,
        });
        const alert = buildIbsConsistencyAlert(verdict);
        if (alert) {
          // The Python registers **both** (ranap_v3.py:8852-8859): the reg alert
          // and the verification blocker, whose "ERROR: IBS mismatch" prefix is
          // one of the three shapes `_get_blocking_reg_alerts` stops on.
          alerts.registerRegAlert(reg, alert.level, alert.message);
          alerts.registerVerificationBlocker(reg, alert.message);
          problems.push(`${reg}: ${verdict.reason || 'perlu cek manual'}`);
        }
      }

      // A step whose only evidence is a read that failed cannot report a clean
      // verdict; `load_charges` files its own sync issue, and this is the honest
      // status for the node itself.
      const unreadable = failedReads(ctx, 'penatajasaInap.getListTindakan', 'rekapitulasi.detailHakHtml');
      const ibsTitle = 'Tagihan operasi (biaya IBS) dibandingkan dengan pemakaian depo IBS';
      if (unreadable.length > 0) ibsChecks.push({ label: 'Data pembanding IBS terbaca', ok: false, detail: `gagal: ${unreadable.join(', ')}` });
      if (problems.length > 0) {
        return reasoned(review(`${problems.length} grup dengan IBS yang perlu diperiksa`, {
          warnings: [warning('ibs', problems.join(' ; '))],
        }), ibsTitle, ibsChecks);
      }
      if (unreadable.length > 0) {
        return reasoned(review('Validasi IBS tidak dapat dipastikan — data pembanding tidak terbaca', {
          warnings: [warning('ibs_unreadable', `Read gagal: ${unreadable.join(', ')}`)],
        }), ibsTitle, ibsChecks);
      }
      return reasoned(ok(`IBS konsisten untuk ${regs.length} grup`), ibsTitle, ibsChecks);
    },

    'ranap.validatePenunjang': async (ctx) => {
      const input = inputOf(ctx);
      const groups = roomGroupsOf(ctx);
      const debug = isDebug(ctx);
      const regs = Object.entries(groups);
      if (regs.length === 0) return skipped('Belum ada grup rawat inap');

      ctx.log(`6. Validasi hasil penunjang untuk ${regs.length} grup rawat inap...`);

      // `sync_tindakan` already needed the same four reads (`main()` builds
      // `group_penunjang_histories` at ranap_v3.py:16203, before step 3), so the
      // loader memoizes them for the run.
      const histories = await loadPenunjangHistories(ctx, client, input.noRm);

      const windows = getScratch<Record<string, { start: string; end: string }>>(ctx, K.groupWindowByReg) ?? {};
      const elektromedikAll = getScratch<LegacyRow[]>(ctx, K.elektromedik) ?? [];
      const poliSourceByReg = scratchRecord<LegacyRow>(ctx, K.poliSourceByReg);
      const tolerance = toleranceOf(ctx);
      const alerts = alertsOf(ctx);
      const keteranganByReg = scratchRecord<string[]>(ctx, K.summaryKeteranganByReg);
      let needsAttention = 0;
      let checked = 0;

      const penunjangChecks: ReasoningItem[] = [];
      for (const [reg, rows] of regs) {
        // `group_penunjang_histories[reg]` (ranap_v3.py:16203-16209): each history
        // is narrowed to the group's own window before it is validated, so a stale
        // unresulted order from a previous admission cannot become a candidate for
        // this episode and block it.
        const window = windows[reg] ?? getRoomGroupDateRange(rows);
        const groupHistories: PenunjangHistories = {
          lab: filterHistoryRowsForDateRange(histories.lab, window.start, window.end),
          pa: filterHistoryRowsForDateRange(histories.pa, window.start, window.end),
          rad: filterHistoryRowsForDateRange(histories.rad, window.start, window.end),
          ok: filterHistoryRowsForDateRange(histories.ok, window.start, window.end),
        };
        const groupElektromedik = filterHistoryRowsForDateRange(elektromedikAll, window.start, window.end);

        // The two Lab PK candidate sources `validate_penunjang_results_for_group`
        // (ranap_v3.py:8406-8409) reads and the Radiologi one it adds: without
        // them the Lab PK branch produced no candidate at all.
        const poliSource = poliSourceByReg[reg];
        const relatedLabPk = poliSource
          ? await collectRelatedLabPk(ctx, client, input.noRm, poliSource, tolerance)
          : [];
        const directLabRows = collectDirectHasilRowsForGroup({
          roomRows: rows,
          pages: await fetchDirectHasilPages(ctx, client, 'lab', input.noRm, rows),
        });
        const directRadRows = collectDirectHasilRowsForGroup({
          roomRows: rows,
          pages: await fetchDirectHasilPages(ctx, client, 'rad', input.noRm, rows),
        });

        const candidateArgs = {
          roomRows: rows,
          relatedLabPk,
          directLabRows,
          penunjangHistories: groupHistories,
          directRadRows,
          elektromedikHistory: groupElektromedik,
        };
        const candidateSet = collectPenunjangValidationCandidates(candidateArgs);

        // Two passes: fetch each candidate's detail/result, then decide. The
        // decision functions are pure, so all I/O happens here.
        const prefetched = new Map<string, PenunjangValidation>();
        for (const candidate of candidateSet.all) {
          prefetched.set(candidateKey(candidate), await validateCandidate(ctx, client, input.noRm, candidate));
        }

        const groupResult = validatePenunjangResultsForGroup({
          ...candidateArgs,
          validate: (candidate) =>
            prefetched.get(candidateKey(candidate)) ?? {
              ok: false,
              modality: candidate.modality,
              noTransaksi: candidate.noTransaksi,
              status: 'warn',
              needsAttention: true,
              hasResult: false,
              approve: 'unknown',
              reason: 'hasil belum dapat dibaca',
              issues: ['hasil belum dapat dibaca'],
              summary: 'hasil belum dapat dibaca',
              severity: 'warn',
              details: [],
            },
        });

        const groupNeedsAttention = groupResult.needsAttention.length > 0;
        checked += groupResult.results.length;
        for (const result of groupResult.results) {
          penunjangChecks.push({
            label: `Hasil ${result.modality} ${result.noTransaksi || ''}`.trim(),
            ok: result.needsAttention ? false : true,
            detail: result.summary || result.reason || (result.needsAttention ? 'perlu dicek' : 'lengkap'),
          });
        }
        for (const line of groupResult.lines) ctx.log(`   ${line}`, groupNeedsAttention ? 'warn' : 'info');
        // Name each transaction and what is outstanding: "4 transaksi perlu
        // perhatian" alone sent the operator hunting through SIMRS.
        for (const item of groupResult.needsAttention) {
          ctx.log(`     - ${item.modality} ${item.noTransaksi || '-'}: ${item.summary || item.reason || '-'}`, 'warn');
        }
        for (const alert of groupResult.alerts) {
          alerts.registerRegAlert(alert.reg, alert.level, alert.message);
          // `_get_penunjang_keterangan_for_summary(reg)` is per registration
          // (ranap_v3.py:16843 keys the whole summary row by reg); one run-wide
          // list put registration A's keterangan on registration B's row.
          (keteranganByReg[reg] ??= []).push(alert.message);
        }
        if (groupNeedsAttention) needsAttention += 1;
        if (debug) {
          emit(
            ctx,
            dataBlock(
              [
                { label: 'Kandidat', value: groupResult.candidates.length },
                { label: 'Perlu perhatian', value: groupResult.needsAttention.length },
                { label: 'Periode', value: `${window.start || '-'} s/d ${window.end || '-'}` },
                { label: 'No reg', value: reg, debugOnly: true },
              ],
              { bullet: '+ Ringkasan penunjang:', indent: '   ', debug },
            ),
            'debug',
          );
        }
      }

      const penunjangTitle = 'Setiap pemeriksaan penunjang yang ditagihkan punya hasil';
      if (penunjangChecks.length === 0) penunjangChecks.push({ label: 'Ada pemeriksaan penunjang', ok: null, detail: 'tidak ada pada periode rawat' });
      if (needsAttention > 0) {
        return reasoned(review(`${needsAttention} grup dengan hasil penunjang yang belum lengkap`, {
          warnings: [warning('penunjang_hasil', `${needsAttention} grup memiliki hasil penunjang yang perlu dicek`)],
        }), penunjangTitle, penunjangChecks);
      }
      // "0 pemeriksaan diperiksa" is only a clean result when the histories were
      // actually read. `softJson` swallows a failure and yields `undefined`, which
      // becomes an empty array — indistinguishable from "no penunjang orders"
      // until the failure is recorded.
      const unreadable = failedReads(ctx, ...PENUNJANG_HISTORY_ENDPOINTS);
      if (unreadable.length > 0) {
        return reasoned(review('Hasil penunjang tidak dapat dipastikan — history penunjang tidak terbaca', {
          warnings: [warning('penunjang_unreadable', `Read gagal: ${unreadable.join(', ')}`)],
        }), penunjangTitle, [...penunjangChecks, { label: 'History penunjang terbaca', ok: false, detail: `gagal: ${unreadable.join(', ')}` }]);
      }
      return reasoned(ok(`Hasil penunjang lengkap (${checked} pemeriksaan diperiksa)`), penunjangTitle, penunjangChecks);
    },

    /**
     * `validate_obat_pulang_for_group` (ranap_v3.py:13203), joined the way the
     * Python joins the two records.
     *
     * Both sides are **enriched with their detail lines before matching**: each
     * pharmacy order via `getdetail_historyobat` (`_get_history_obat_entries`,
     * ranap_v3.py:5833) and each `BIAYA OBAT` charge via
     * `verifikator_getdetail_transaksi` (`_build_biaya_obat_detail_entry`,
     * 5889). That is what gives `matchHistoryObatToBiayaRows` the item/qty
     * fingerprint its exact pass compares; matching on names alone made the
     * exact pass unreachable and left the loose pass with nothing to overlap,
     * so two different orders on the same day were indistinguishable.
     */
    'ranap.validateObatPulang': async (ctx) => {
      const input = inputOf(ctx);
      const groups = roomGroupsOf(ctx);
      const listByTrx = getScratch<Record<string, LegacyRow[]>>(ctx, K.listTindakanByTrx) ?? {};
      const debug = isDebug(ctx);
      const regs = Object.entries(groups);
      if (regs.length === 0) return skipped('Belum ada grup rawat inap');

      ctx.log(`7. Cek obat pulang untuk ${regs.length} grup rawat inap...`);

      const historyEntries = await fetchHistoryObatEntries(ctx, client, input.noRm);

      const alerts = alertsOf(ctx);
      const problems: string[] = [];
      const obatChecks: ReasoningItem[] = [];
      for (const [reg, rows] of regs) {
        const range = getRoomGroupDateRange(rows);
        const biayaRows = rows
          .flatMap((row) => listByTrx[str(row, 'no_transaksi')] ?? [])
          .filter((row) => upper(row, 'nama_tindakan').includes('BIAYA OBAT'));
        const biaya = await Promise.all(
          biayaRows.map(async (row) => buildBiayaObatDetailEntry(row, await fetchBiayaObatDetail(ctx, client, row))),
        );
        const matches = matchHistoryObatToBiayaRows(historyEntries, biaya);
        const takeHome = historyEntries.filter((entry) => flag(entry['is_take_home']));
        const unmatched = biaya.length - matches.length;

        emit(
          ctx,
          dataBlock(
            [
              { label: 'Periode', value: `${range.start || '-'} s/d ${range.end || '-'}` },
              { label: 'Baris biaya obat', value: biaya.length },
              { label: 'Cocok dengan order', value: matches.length },
              { label: 'Obat pulang terdeteksi', value: takeHome.length },
              { label: 'Order farmasi diperiksa', value: historyEntries.length, debugOnly: true },
              { label: 'Cocok eksak', value: matches.filter((item) => item.mode === 'exact').length, debugOnly: true },
              { label: 'No reg', value: reg, debugOnly: true },
            ],
            { bullet: '+ Cek obat pulang:', indent: '   ', debug },
          ),
          unmatched > 0 ? 'warn' : 'info',
        );

        // Live 2026-10-15: the inpatient charge list carries no `no_referensi`
        // on `BIAYA OBAT` rows, so their detail cannot be read and the join has
        // nothing to compare. Name that as unverifiable, not as a mismatch.
        const unreferenced = biaya.filter((entry) => !str(entry, 'no_referensi')).length;
        obatChecks.push({
          label: `Biaya obat cocok dengan order farmasi${regs.length > 1 ? ` (${reg})` : ''}`,
          ok: unmatched === 0,
          detail: unmatched === 0
            ? `${matches.length}/${biaya.length} baris cocok · obat pulang ${takeHome.length}`
            : unreferenced >= unmatched ? `${unmatched} baris tanpa no referensi — cocokkan manual` : `${unmatched} baris tanpa order pembanding`,
        });
        if (unmatched > 0 && unreferenced >= unmatched) {
          alerts.registerRegAlert(reg, 'WARN', `${unmatched} baris biaya obat tanpa no_referensi — cocokkan obat pulang manual`);
          problems.push(`${reg}: ${unmatched} baris tanpa no_referensi (tidak dapat dicocokkan otomatis)`);
        } else if (unmatched > 0) {
          alerts.registerRegAlert(reg, 'WARN', `${unmatched} baris biaya obat tanpa order pembanding`);
          problems.push(`${reg}: ${unmatched} baris`);
        }
      }

      const obatTitle = 'Baris BIAYA OBAT dicocokkan dengan order farmasi (termasuk obat pulang)';
      // Unreadable data is checked before mismatches: a pharmacy read that timed
      // out leaves nothing to match, and "N baris tanpa order pembanding" would
      // then blame the bill for a failed read (live 2026-10-20: 0/17, 30 s gap).
      // Also, `0 - 0 = 0` unmatched rows is not a validation when neither side could be
      // read. `validate_obat_pulang_for_group` (ranap_v3.py:13203) fetches both;
      // here they come from `load_charges` and the pharmacy history above. The
      // two detail reads count too: without them the signatures are empty and a
      // "0 unmatched" verdict is the answer to a question nobody asked.
      const unreadable = failedReads(
        ctx,
        'penatajasaInap.getListTindakan',
        'penatajasaInap.getHistoryObat',
        'penatajasaInap.getDetailHistoryObat',
        'verifikator.getDetailTransaksi',
      );
      if (unreadable.length > 0) {
        return reasoned(review('Obat pulang tidak dapat dipastikan — data pembanding tidak terbaca', {
          warnings: [warning('obat_pulang_unreadable', `Read gagal: ${unreadable.join(', ')}`)],
        }), obatTitle, [...obatChecks, { label: 'Data pembanding obat terbaca', ok: false, detail: `gagal: ${unreadable.join(', ')}` }]);
      }
      if (problems.length > 0) {
        return reasoned(review(`${problems.length} grup dengan biaya obat yang belum cocok`, {
          warnings: [warning('obat_pulang', problems.join(' ; '))],
        }), obatTitle, obatChecks);
      }
      return reasoned(ok(`Obat pulang tervalidasi untuk ${regs.length} grup`), obatTitle, obatChecks);
    },

    // ── Verification, balance, payment ───────────────────────────

    'ranap.preverifySummary': (ctx) => {
      const groups = roomGroupsOf(ctx);
      const allRows = getScratch<LegacyRow[]>(ctx, K.allVisitRows) ?? [];
      const originByReg = getScratch<Record<string, OriginInfo>>(ctx, K.originByReg) ?? {};
      const listByTrx = getScratch<Record<string, LegacyRow[]>>(ctx, K.listTindakanByTrx) ?? {};
      const debug = isDebug(ctx);
      const regs = Object.entries(groups);
      if (regs.length === 0) return skipped('Belum ada grup rawat inap');

      const alerts = alertsOf(ctx);
      const blocking: string[] = [];
      const preChecks: ReasoningItem[] = [];
      for (const [reg, rows] of regs) {
        // An IGD admission with neither a DEPO IGD nor a BIAYA OBAT line means
        // the pharmacy charges never arrived — verifying now would lock an
        // incomplete bill.
        const igdCheck = checkMissingIgdDepoOrObatForVerification({
          kunjunganRows: allRows,
          roomRows: rows,
          originInfo: originByReg[reg],
          listTindakanRows: rows.flatMap((row) => listByTrx[str(row, 'no_transaksi')] ?? []),
        });
        const regNote = regs.length > 1 ? ` (${reg})` : '';
        if (originByReg[reg]?.requiresIgdSource) {
          preChecks.push({ label: `Masuk via IGD: DEPO IGD / BIAYA OBAT sudah tertagih${regNote}`, ok: !igdCheck.hasBlocker, detail: `depo IGD ${igdCheck.hasDepoIgd ? 'ada' : 'tidak ada'} · biaya obat ${igdCheck.hasBiayaObat ? 'ada' : 'tidak ada'}` });
        }
        if (igdCheck.hasBlocker) {
          const detail = `periode=${igdCheck.periode || '-'} | depo_igd=${igdCheck.hasDepoIgd ? 'ada' : 'tidak ada'} | biaya_obat=${igdCheck.hasBiayaObat ? 'ada' : 'tidak ada'}`;
          alerts.registerRegAlert(reg, 'ERROR', `Blocker verifikasi manual | origin IGD belum ada DEPO IGD/BIAYA OBAT | ${detail}`);
          alerts.registerVerificationBlocker(reg, 'origin IGD belum ada DEPO IGD/BIAYA OBAT');
        }

        const summary = alerts.buildPreVerificationSummary(reg);
        for (const line of summary.lines) ctx.log(line, summary.hasBlocker ? 'warn' : 'info');
        if (debug && alerts.hasSyncIssues(reg)) {
          ctx.log(`   Issues: ${alerts.getSyncIssueSummary(reg)}`, 'debug');
        }
        if (summary.hasBlocker) blocking.push(`${reg}: ${summary.blocking.slice(0, 3).join('; ')}`);
        else if (alerts.hasSyncIssues(reg)) blocking.push(`${reg}: ${alerts.getSyncIssueSummary(reg)}`);
        preChecks.push(summary.hasBlocker
          ? { label: `Tidak ada blocker verifikasi${regNote}`, ok: false, detail: summary.blocking.slice(0, 3).join('; ') }
          : alerts.hasSyncIssues(reg)
            ? { label: `Sinkronisasi tanpa masalah${regNote}`, ok: false, detail: alerts.getSyncIssueSummary(reg) }
            : { label: `Tidak ada blocker verifikasi${regNote}`, ok: true });
      }

      // The gate is per registration too. `main()` has no run-level gate at all:
      // it `continue`s past the blocked registration (ranap_v3.py:16789-16809)
      // and verifies the rest. So the run only stops when *every* registration is
      // blocked; with one clean registration left the pipeline has work to do and
      // `execute_verifikasi` does the per-registration filtering.
      const preTitle = 'Semua catatan dari langkah sebelumnya dikumpulkan sebelum verifikasi';
      if (blocking.length >= regs.length) {
        return reasoned(blocked(`Verifikasi ditahan — ${blocking.length} grup masih punya blocker`, {
          issues: [warning('preverify_blocked', blocking.join(' | '), 'error')],
        }), preTitle, preChecks);
      }
      if (blocking.length > 0) {
        return reasoned(review(`${blocking.length}/${regs.length} grup masih punya blocker verifikasi`, {
          warnings: [warning('preverify_blocked', blocking.join(' | '), 'error')],
        }), preTitle, preChecks);
      }
      return reasoned(ok(`Pra-verifikasi bersih untuk ${regs.length} grup`), preTitle, preChecks);
    },

    'ranap.recoverGizi': async (ctx) => {
      const groups = roomGroupsOf(ctx);
      const regs = Object.entries(groups);
      if (regs.length === 0) return skipped('Belum ada grup rawat inap');

      const snapshots = scratchRecord<GiziOrderSnapshot>(ctx, K.giziOrdersByReg);
      const plans: MutationPlan[] = [];
      for (const [reg, rows] of regs) {
        const res = await softJson<unknown>(ctx, client, 'verifikator.cekTransaksiPenunjang', {
          no_registrasikunjungan: reg,
        });
        const blocker = normalizePenunjangBlocker(res);
        if (!blocker.hasBlocker || !isGiziPenunjangBlocker(blocker)) continue;

        // `recoveryPlans[n]` is the pass for attempt `n + 1`, built against the
        // order the blocker names — `recover_ordergizi_error`'s
        // `preferred_order_trx` (ranap_v3.py:15191). Without it every attempt read
        // as "a pass would find something" and the node could never propose a
        // single recovery write. The order snapshot comes from `preflight_gizi`,
        // which already read `getdataordergizi` for every order of the group; a
        // blocking order that is not in the group's history yields an empty pass,
        // which is the Python's `any_deleted == False` outcome.
        const snapshot = snapshots[reg];
        const recoveryPass = planOrderGiziRecovery({
          kunjunganInap: rows[0] ?? {},
          orderItems: snapshot?.orderItems ?? [],
          detailByOrder: snapshot?.detailByOrder ?? {},
          preferredOrderTrx: blocker.noTransaksi,
        });
        const recovery = planGiziBlockerRecovery({
          kunjunganInap: rows[0],
          blockers: [blocker],
          recoveryPlans: [recoveryPass],
          dryRun: ctx.mode === 'preview',
        });
        ctx.log(`+ Recovery blocker gizi | reg=${reg} | outcome=${recovery.outcome} | ${recovery.reason}`, 'warn');
        for (const step of recovery.steps) {
          for (const action of step.actions ?? []) {
            if (action.action === 'none') continue;
            plans.push(
              mutationPlan(ctx, {
                node: 'recover_gizi',
                // One order can yield several `hapusDetail` actions, so the
                // index has to run across the whole node, not per order.
                index: plans.length,
                endpointId: giziEndpointFor(action.action),
                riskLevel: 'high',
                reason: `Recovery order gizi (${action.action}): ${action.reason}`,
                trx: action.noTransaksiOrderGizi,
                preconditions: giziPreconditionsFor(
                  action.action,
                  action.noTransaksiOrderGizi,
                  inputOf(ctx).noRm,
                ),
                // `batalkirim_ordergizi` (ranap_v3.py:5069) and
                // `hapus_detailordergizi` (5077) — the only difference is the
                // line number the delete needs.
                payload: {
                  no_transaksi_ordergizi: action.noTransaksiOrderGizi,
                  ...(action.action === 'hapusDetail' ? { urut_order: action.urutOrder ?? '' } : {}),
                },
                payloadSummary: {
                  no_transaksi: action.noTransaksiOrderGizi,
                  ...(action.urutOrder ? { urut_order: action.urutOrder } : {}),
                },
              }),
            );
          }
        }
      }

      const recoverTitle = 'Order gizi yang menahan verifikasi dipulihkan';
      if (plans.length === 0) return reasoned(skipped('Tidak ada blocker gizi yang perlu dipulihkan'), recoverTitle, [{ label: 'Tidak ada blocker gizi', ok: true }]);
      return reasoned(planResult(`Rencana ${plans.length} aksi recovery order gizi`, plans), recoverTitle,
        plans.map((plan) => ({ label: plan.reason, ok: false, detail: 'pulihkan', planId: plan.id })));
    },

    /**
     * Kelengkapan Berkas (opt-in, notice only; docs/berkas-ocr.md): reads the
     * e-klaim bundle PDF of each registration and lists which required claim
     * documents it holds. Never blocks — the operator still checks by hand.
     */
    'ranap.checkBerkas': async (ctx) => {
      const reader = deps.berkas;
      if (!reader) return skipped('Cek berkas (OCR) tidak tersedia di host ini');
      const input = inputOf(ctx);
      const groups = roomGroupsOf(ctx);
      const regs = Object.keys(groups);
      if (regs.length === 0) return skipped('Belum ada grup rawat inap');
      const berkasTitle = 'Dokumen wajib klaim dicari di berkas e-klaim (judul halaman, OCR untuk foto)';
      const progress = (reg: string) => (p: BerkasProgressPort) =>
        ctx.log(`Berkas ${reg}: ${p.label}`, 'debug', { berkasProgress: { phase: p.phase, done: p.done, total: p.total, label: p.label } });

      // The claim index: one row per visit with SEP and register numbers.
      const tolerance = clampToleranceDays(input.toleranceDays ?? 3);
      const piutang = rowsOf(await softJson<unknown>(ctx, client, 'uploadBerkas.getDataPiutang', berkasIndexPayload(input.noRm, isoDayOffset(input.tanggal, -(tolerance + 3)), isoDay(ctx.clock.now()), '3')));
      const rows = piutang.filter((row) => regs.includes(str(row, 'no_registrasikunjungan')));
      if (rows.length === 0) {
        return reasoned(review('Berkas e-klaim belum ditemukan untuk registrasi ini — periksa manual', {
          warnings: [warning('berkas_index', failedReads(ctx, 'uploadBerkas.getDataPiutang').length ? 'Daftar berkas (getdatapiutang) tidak terbaca' : `Tidak ada baris berkas untuk ${regs.join(', ')}`)],
        }), berkasTitle, [{ label: 'Berkas e-klaim ditemukan', ok: false, detail: regs.join(', ') }]);
      }

      const listByTrx = getScratch<Record<string, LegacyRow[]>>(ctx, K.listTindakanByTrx) ?? {};
      const titipan = (getScratch<TitipanEvaluation[]>(ctx, K.titipan) ?? []).some((item) => item.isTitipan);
      const items: ReasoningItem[] = [];
      const missing: string[] = [];
      for (const row of rows) {
        const reg = str(row, 'no_registrasikunjungan');
        const noSep = str(row, 'no_sep');
        if (!noSep) {
          missing.push(`${reg}: belum ada SEP di berkas`);
          items.push({ label: `Berkas ${reg}`, ok: false, detail: 'tanpa no SEP' });
          continue;
        }
        progress(reg)({ phase: 'unduh', done: 0, total: 1, label: 'mengunduh PDF berkas…' });
        let pdf: Uint8Array | undefined;
        try {
          const res = await client.raw('eklaim.cetakSimplifikasi', { query: { no_transaksi: 'undefined', no_sep: noSep, no_register: reg, kd_instalasi: '3' }, signal: ctx.signal });
          if (res.status === 200 && res.bodyBytes && String.fromCharCode(...res.bodyBytes.subarray(0, 4)) === '%PDF') pdf = res.bodyBytes;
        } catch (err) {
          ctx.log(`Read eklaim.cetakSimplifikasi gagal: ${err instanceof Error ? err.message : String(err)}`, 'debug');
        }
        if (!pdf) {
          missing.push(`${reg}: PDF berkas tidak terbaca`);
          items.push({ label: `Berkas ${reg}`, ok: false, detail: 'PDF tidak terbaca' });
          continue;
        }
        const cacheKey = `${input.noRm}_${str(row, 'tgl_masuk').slice(0, 10)}_${(str(row, 'tgl_keluar_rm') || str(row, 'tgl_keluar') || 'belum-pulang').slice(0, 10)}`;
        const report = await reader.read(pdf, { cacheKey, onProgress: progress(reg), signal: ctx.signal });
        const charges = (groups[reg] ?? []).flatMap((room) => listByTrx[str(room, 'no_transaksi')] ?? []).map((line) => str(line, 'nama_tindakan'));
        const result = evaluateBerkas(report, berkasFactsOf(charges, titipan));
        emit(ctx, [
          `Kelengkapan Berkas${rows.length > 1 ? ` (${reg})` : ''}:`,
          ...result.checks.map((check, i) => `   ${i + 1}. ${check.label} ${check.found
            ? `${check.probable ? '✓ kemungkinan (foto bergrid EKG)' : '✓'} ${pageList(check.pages)}`
            : `✗ belum ada — ${check.why}`}`),
          ...(result.others.length ? [`   Dokumen lain: ${result.others.map((o) => `${o.label} (${pageList(o.pages)})`).join('; ')}`] : []),
          `   ${report.pageCount} halaman · ${report.photoPages} foto${report.fromCache ? ' · dari cache' : report.ocrRun ? ` · ${report.ocrRun} di-OCR` : ''}`,
        ], result.missing.length ? 'warn' : 'info');
        for (const check of result.checks) {
          items.push({ label: check.label, ok: check.found ? (check.probable ? null : true) : false, detail: check.found ? pageList(check.pages) : `belum ada — ${check.why}` });
        }
        for (const check of result.missing) missing.push(rows.length > 1 ? `${reg}: ${check.label}` : check.label);
      }
      return reasoned(
        missing.length
          ? review(`Berkas belum lengkap: ${missing.join(', ')} — periksa manual`, { warnings: [warning('berkas_kurang', missing.join(' ; '))] })
          : ok(`Berkas lengkap: ${items.length} dokumen wajib ditemukan`),
        berkasTitle,
        items,
      );
    },

    'ranap.checkBalance': async (ctx) => {
      const groups = roomGroupsOf(ctx);
      const debug = isDebug(ctx);
      const regs = Object.entries(groups);
      if (regs.length === 0) return skipped('Belum ada grup rawat inap');

      const alerts = alertsOf(ctx);
      const unbalanced: string[] = [];
      let grandTotal = 0;
      const grandTotalByReg: Record<string, number> = {};
      const balanceChecks: ReasoningItem[] = [];
      const regPrefix = (reg: string) => (regs.length > 1 ? `${reg} · ` : '');
      const rupiah = (n: number) => `Rp ${Math.round(n).toLocaleString('id-ID')}`;

      for (const [reg, rows] of regs) {
        try {
          await resolveRekapParams(ctx, client, reg, rows);
        } catch (err) {
          alerts.registerRegAlert(reg, 'ERROR', `Parameter rekapitulasi tidak dapat dibentuk | ${asMessage(err)}`);
          unbalanced.push(`${reg}: parameter rekapitulasi tidak dapat dibentuk`);
          balanceChecks.push({ label: `${regPrefix(reg)}Total kasir = total rekapitulasi`, ok: false, detail: 'parameter rekapitulasi tidak dapat dibentuk' });
          continue;
        }

        // `rekapitulasi_detail_hak_html` is a GET: all seventeen computed
        // parameters have to travel in the query string. Handed to the client as
        // a data object they are silently discarded (only POSTs are form-encoded)
        // and the backend answers with an unfiltered recap — which then never
        // balances against the cashier total.
        const rekapHtml = await fetchRekapHtml(ctx, client, reg, rows);
        // `cek_balance_total_tagihan` (ranap_v3.py:8641) calls
        // `get_jumlah_bayar_kasir(no_registrasikunjungan=reg)` — `no_transaksi`
        // and `kd_unit` stay **empty**, so the cashier answers with the
        // episode-wide total, which is the figure the rekapitulasi reports. Naming
        // the primary transaction compares one room's total against the whole
        // episode's recap, so a two-room stay can never balance — and
        // `check_balance` is critical, so the run dies.
        const jumlahBayar = await softJson<LegacyRow>(ctx, client, 'kasir.getJumlahBayar', {
          no_transaksi: '',
          no_registrasikunjungan: reg,
          kd_unit: '',
          ck_totaltagihan_ksr: 'true',
          ck_retur_apt: 'false',
        });
        // `getJumlahBayar` answers with an empty body for every inpatient
        // registration on this backend (verified live 2026-10-15, all three
        // pilot patients, with and without a transaction). That is "unread",
        // not "the cashier owes nothing": say so instead of reporting a fake
        // `selisih` against a zero total.
        if (!jumlahBayar || Object.keys(jumlahBayar).length === 0) {
          ctx.log(`- Grand total kasir tidak terbaca (kasir.getJumlahBayar kosong) | reg=${reg}`, 'warn');
          alerts.registerRegAlert(reg, 'ERROR', 'Grand total kasir tidak terbaca — cek balance manual di SIMRS');
          alerts.registerVerificationBlocker(reg, 'grand total kasir tidak terbaca');
          unbalanced.push(`${reg}: grand total kasir tidak terbaca`);
          balanceChecks.push({ label: `${regPrefix(reg)}Total kasir = total rekapitulasi`, ok: false, detail: 'grand total kasir tidak terbaca — cek manual di SIMRS' });
          continue;
        }
        const verdict = checkBalanceTotalTagihan({
          rekapHtml,
          kasirTotals: jumlahBayar,
          roomRows: rows,
        });
        grandTotal = Math.max(grandTotal, verdict.kasirTotal);
        grandTotalByReg[reg] = verdict.kasirTotal;
        balanceChecks.push({
          label: `${regPrefix(reg)}Total kasir = total rekapitulasi`,
          ok: verdict.balanced,
          detail: verdict.balanced
            ? `${rupiah(verdict.kasirTotal)} = ${rupiah(verdict.rekapTotal)}`
            : `kasir ${rupiah(verdict.kasirTotal)} · rekap ${rupiah(verdict.rekapTotal)} · selisih ${rupiah(verdict.difference)}${verdict.reason ? ` — ${verdict.reason}` : ''}`,
        });

        emit(
          ctx,
          dataBlock(
            [
              { label: 'Grand total kasir', value: verdict.kasirTotal },
              { label: 'Total rekapitulasi', value: verdict.rekapTotal },
              { label: 'Selisih', value: verdict.difference },
              { label: 'Hasil', value: verdict.balanced ? 'Balance' : 'Belum balance' },
              // Not debug-gated: nothing in the log spec marks a failure reason
              // debug-only, and `cek_balance_total_tagihan` prints the three
              // totals unconditionally when it refuses (ranap_v3.py:8648-8656).
              // A non-debug run showed "Belum balance" with no explanation.
              { label: 'Alasan', value: verdict.reason },
              { label: 'No reg', value: reg, debugOnly: true },
            ],
            { bullet: '+ Cek balance total tagihan:', debug },
          ),
          verdict.balanced ? 'info' : 'error',
        );

        if (!verdict.balanced) {
          alerts.registerRegAlert(reg, 'ERROR', 'Grand total kasir dan rekapitulasi belum balance');
          alerts.registerVerificationBlocker(reg, 'grand total kasir dan rekapitulasi belum balance');
          unbalanced.push(`${reg}: selisih ${verdict.difference}`);
        }
      }
      ctx.scratch[K.grandTotal] = grandTotal;
      ctx.scratch[K.grandTotalByReg] = grandTotalByReg;

      // Per registration, as `main()` checks it (ranap_v3.py:16810-16821): an
      // unbalanced group registers a verification blocker and is `continue`d
      // past, so the run only stops when no group balances at all. The blocker
      // above is what makes `execute_verifikasi` skip just that registration.
      const balanceTitle = 'Grand total kasir dibandingkan dengan total rekapitulasi';
      if (unbalanced.length >= regs.length) {
        return reasoned(blocked(`Total tagihan belum balance untuk ${unbalanced.length} grup`, {
          issues: [warning('balance', unbalanced.join(' | '), 'error')],
        }), balanceTitle, balanceChecks);
      }
      if (unbalanced.length > 0) {
        return reasoned(review(`Total tagihan belum balance untuk ${unbalanced.length}/${regs.length} grup`, {
          warnings: [warning('balance', unbalanced.join(' | '), 'error')],
        }), balanceTitle, balanceChecks);
      }
      return reasoned(ok(`Total tagihan balance untuk ${regs.length} grup`), balanceTitle, balanceChecks);
    },

    // Gate node — resolved by the runner's gate resolver; the executor only
    // records that the pipeline reached it.
    'ranap.finalGate': (ctx) => {
      const regs = Object.keys(roomGroupsOf(ctx)).length;
      return reasoned(ok(`Siap verifikasi ${regs} grup rawat inap — menunggu persetujuan dua operator`), 'Gerbang persetujuan sebelum verifikasi ditulis ke SIMRS', [
        { label: `${regs} grup lolos pra-verifikasi`, ok: true },
        { label: 'Persetujuan operator', ok: null, detail: 'operator menyetujui atau menolak di Inspector' },
      ]);
    },

    /**
     * `main()`'s per-registration verification loop (ranap_v3.py:16753-16809).
     *
     * Verification is decided **per registration**, not per run: a registration
     * with sync issues (16789), with a blocking manual alert (16799), or with a
     * non-gizi penunjang blocker (`proses_verifikasi_inap`, 15492) is skipped with
     * `continue` while the others go ahead. Planning for every registration
     * regardless meant one blocked room silently carried the whole episode
     * through the gate.
     *
     * **This step waits.** The Python writes `simpan_verifikasi`, confirms with
     * `_confirm_verifikasi_state` (15371) and only *then* emits the summary row
     * (16828) and stages the payment (16855). Both of those are separate nodes
     * here, and the runner releases a node as soon as its terminal event is out
     * — so without a barrier the graph reached `emit_summary` while the
     * verification was still `planned` and every registration read as
     * unverified. Returning `needsReplan` while plans are in flight is that
     * barrier: on a write run the node parks until every verification plan
     * reaches a terminal outcome, then runs again with the real results in
     * `ctx.mutations`.
     *
     * The operator-facing consequence is deliberate and is stated in the step
     * summary and the log: a **write run whose verification nobody approves now
     * stops here** instead of running on to a summary that would have had
     * nothing in it. Reaching the pass cap with the verification still
     * unconfirmed says so plainly rather than reporting a finished run.
     *
     * Preview is untouched: `final_gate` holds before this node is reached, and
     * the engine never grants a re-plan pass on a run that applies nothing.
     */
    'ranap.executeVerifikasi': (ctx) => {
      const groups = roomGroupsOf(ctx);
      const regs = Object.keys(groups);
      if (regs.length === 0) return skipped('Belum ada grup rawat inap');

      const alerts = alertsOf(ctx);
      const penunjangBlockers = scratchRecord<string>(ctx, K.penunjangBlockerByReg);
      const debug = isDebug(ctx);
      const planByReg = scratchRecord<string>(ctx, K.verificationPlanByReg);
      // A registration whose verification was already proposed is not proposed
      // again: `main()` calls `simpan_verifikasi` once per registration and
      // reports the outcome, it never retries the write. So a second pass only
      // reads what happened.
      if (regs.some((reg) => planByReg[reg] !== undefined)) {
        return observeVerifikasi(ctx, regs, planByReg);
      }

      const eligible: string[] = [];
      const skippedRegs: string[] = [];
      for (const reg of regs) {
        const blockerLabel = penunjangBlockers[reg];
        if (blockerLabel) {
          // `proses_verifikasi_inap` registers this itself before refusing
          // (ranap_v3.py:15492-15503); the sync issue is also what stops
          // `tampung_bayar` for the same registration (16846).
          alerts.registerSyncIssue(reg, 'blocker_penunjang_manual', blockerLabel);
        }
        const reason = alerts.hasSyncIssues(reg)
          ? `masih ada error sinkronisasi: ${alerts.getSyncIssueSummary(reg) || '-'}`
          : alerts.getBlockingRegAlerts(reg).length > 0
            ? `masih ada blocker manual: ${alerts.getBlockingRegAlerts(reg).slice(0, 3).join('; ')}`
            : '';
        if (reason) {
          skippedRegs.push(`${reg}: ${reason}`);
          emit(
            ctx,
            dataBlock(
              [
                { label: 'Alasan', value: reason },
                { label: 'Reg', value: reg, debugOnly: true },
              ],
              { bullet: '+ Skip verifikasi rawat inap:', debug },
            ),
            'warn',
          );
          continue;
        }
        eligible.push(reg);
      }
      ctx.scratch[K.plannedVerificationRegs] = eligible;

      const verTitle = 'Verifikasi per registrasi rawat inap';
      const skippedChecks = skippedRegs.map((entry): ReasoningItem => {
        const [reg, ...rest] = entry.split(': ');
        return { label: `Registrasi ${reg} bisa diverifikasi`, ok: false, detail: `dilewati: ${rest.join(': ')}` };
      });
      if (eligible.length === 0) {
        return reasoned(blocked(`Verifikasi dilewati untuk ${skippedRegs.length} grup — ${skippedRegs.join(' | ')}`, {
          issues: [warning('verifikasi_skipped', skippedRegs.join(' | '), 'error')],
        }), verTitle, skippedChecks);
      }

      const plans = eligible.map((reg, index) =>
        mutationPlan(ctx, {
          node: 'execute_verifikasi',
          index,
          endpointId: 'verifikator.simpanVerifikasi',
          riskLevel: 'critical',
          reason: `Finalisasi verifikasi registrasi ${reg}`,
          trx: str(groups[reg]?.[0], 'no_transaksi'),
          preconditions: [
            PRECONDITION.sudahKeluar(reg),
            PRECONDITION.tidakAdaBlockerPenunjang(reg),
          ],
          // `simpan_verifikasi` (ranap_v3.py:5005) posts one field.
          payload: { no_registrasikunjungan: reg },
          payloadSummary: { no_registrasikunjungan: reg },
          // `_confirm_verifikasi_state` (ranap_v3.py:15371) is a **conjunction**:
          // `cekstatus_verifikasi_kasir(no_transaksi)` must read "1" AND
          // `cektransaksi_penunjang` must report no new blocker. Both are
          // expressed here; `get_cekverifikasi` is not used because its response
          // is plain text with no `status` field to read.
          //
          // `field: ''` on purpose — `readField` returns the whole body for an
          // empty path, and these endpoints answer with a bare string, so naming
          // any field would read `undefined` and fail a write that did land.
          readAfterWriteChecks: [
            {
              description: 'Status verifikasi kasir menjadi "1"',
              endpointId: 'kasir.cekStatusVerifikasi',
              field: '',
              expected: '1',
              match: 'equals',
              payload: { no_transaksi: str(groups[reg]?.[0], 'no_transaksi') },
            },
            {
              description: 'Tidak ada blocker penunjang baru setelah verifikasi',
              endpointId: 'verifikator.cekTransaksiPenunjang',
              field: '',
              expected: 'tidak ada blocker',
              match: 'empty',
              payload: { no_registrasikunjungan: reg },
            },
          ],
        }),
      );
      // Which plan verifies which registration. `emit_summary` needs the link:
      // the Python emits a row `if verified` (ranap_v3.py:16828), and the only
      // way to know that here is to look this plan's real outcome up in
      // `ctx.mutations`.
      eligible.forEach((reg, index) => {
        const plan = plans[index];
        if (plan) planByReg[reg] = plan.id;
      });

      const skippedNote = skippedRegs.length > 0 ? ` (${skippedRegs.length} grup dilewati)` : '';
      // Each eligible registration reads ✗ "belum terverifikasi" until its plan is verified, then ✓.
      const verChecks: ReasoningItem[] = [
        ...eligible.map((reg, index): ReasoningItem => ({ label: `Registrasi ${reg} terverifikasi`, ok: false, detail: 'belum — simpan verifikasi', ...(plans[index] ? { planId: plans[index]!.id } : {}) })),
        ...skippedChecks,
      ];
      if (plans.length === 0) return reasoned(planResult(`Rencana verifikasi 0 grup rawat inap${skippedNote}`, plans), verTitle, verChecks);

      // The barrier. `pass >= maxPasses` means no further pass will be granted,
      // so saying "waiting" would describe something the engine has already
      // declined; the flag stays set because that refusal is what puts
      // `node.replan_exhausted` in the audit trail.
      const lastPass = ctx.pass >= ctx.maxPasses;
      const waiting = lastPass
        ? `batas re-plan tercapai pada pass ${ctx.pass}/${ctx.maxPasses} — ` +
          `verifikasi belum terkonfirmasi, ringkasan dan tampung bayar tidak akan terbit`
        : `menunggu persetujuan operator: run berhenti di sini sampai ${plans.length} rencana ` +
          `verifikasi selesai (verified/failed/invalidated)`;
      ctx.log(
        lastPass
          ? `[WARN] Verifikasi rawat inap ${waiting}`
          : `- Verifikasi rawat inap ${waiting}`,
        'warn',
      );
      return reasoned({
        status: 'needs_review',
        summary: `Rencana verifikasi ${plans.length} grup rawat inap${skippedNote} — ${waiting}`,
        proposedMutations: plans,
        // Write runs only; the runner ignores it in preview.
        needsReplan: true,
        ...(lastPass
          ? {
              warnings: [
                warning(
                  'replan_exhausted',
                  `Verifikasi ${plans.length} grup belum terkonfirmasi saat batas re-plan tercapai`,
                  'error',
                ),
              ],
            }
          : {}),
      }, verTitle, verChecks);
    },

    'ranap.tampungBayar': async (ctx) => {
      const input = inputOf(ctx);
      const groups = roomGroupsOf(ctx);
      const visits = visitsOf(ctx);
      const listByTrx = getScratch<Record<string, LegacyRow[]>>(ctx, K.listTindakanByTrx) ?? {};
      const debug = isDebug(ctx);
      const regs = Object.entries(groups);
      if (regs.length === 0) return skipped('Belum ada grup rawat inap');
      const tampungTitle = 'Pembayaran ditampung hanya untuk registrasi yang terverifikasi dan balance';
      if (input.enableTampungBayar === false) return reasoned(skipped('Tampung bayar dinonaktifkan untuk run ini'), tampungTitle, [{ label: 'Tampung bayar diaktifkan', ok: null, detail: 'dimatikan di Run setup' }]);
      const tampungRegs: string[] = [];

      // `if verified and balanced and not _has_sync_issues(reg)`
      // (ranap_v3.py:16855) — the payment follows the same per-registration
      // decision the verification made, not the run as a whole.
      //
      // `verified` is the **real** outcome on a write run, not "verification was
      // planned": `execute_verifikasi` now parks until its plans settle, so by
      // the time this node runs `ctx.mutations` carries the answer the Python
      // gets from `_confirm_verifikasi_state`. Staging a payment against a
      // verification that never landed is precisely what the legacy's `if
      // verified` prevents.
      //
      // In preview the plan is still built for the registrations verification
      // was planned for, which is the legacy's own `DRY_RUN` behaviour:
      // `_confirm_verifikasi_state` returns `confirmed` from the dry response
      // (`{"status": True}`, ranap_v3.py:5010) without reading the cashier back.
      const plannedRegs = new Set(getScratch<string[]>(ctx, K.plannedVerificationRegs) ?? []);
      const planByReg = scratchRecord<string>(ctx, K.verificationPlanByReg);
      const verificationOf = (reg: string): string =>
        ctx.mutations[planByReg[reg] ?? '']?.status ?? 'planned';
      const alerts = alertsOf(ctx);

      const plans: MutationPlan[] = [];
      const refusals: string[] = [];
      for (const [reg, rows] of regs) {
        if (!plannedRegs.has(reg)) {
          refusals.push(`${reg}: verifikasi tidak dijalankan untuk registrasi ini`);
          continue;
        }
        if (ctx.mode !== 'preview' && verificationOf(reg) !== 'verified') {
          refusals.push(`${reg}: verifikasi belum terkonfirmasi (status=${verificationOf(reg)})`);
          continue;
        }
        if (alerts.hasSyncIssues(reg)) {
          refusals.push(`${reg}: masih ada error sinkronisasi (${alerts.getSyncIssueSummary(reg) || '-'})`);
          continue;
        }
        const primary = rows[0];
        const listTindakanByTrx: Record<string, readonly LegacyRow[]> = {};
        for (const row of rows) {
          const trx = str(row, 'no_transaksi');
          if (trx) listTindakanByTrx[trx] = listByTrx[trx] ?? [];
        }

        const payload = buildTampungBayarPayload({
          noRm: input.noRm,
          roomRows: rows,
          listTindakanByTrx,
          ...(input.shiftPembayaran ? { shiftPembayaran: input.shiftPembayaran } : {}),
        });

        // The three read-before-write guards `proses_tampung_bayar_group`
        // performs before it stages anything (ranap_v3.py:3768, 3783, 3799).
        // Without them the eligibility check's three refusal branches are dead
        // code, and this is the one endpoint in the graph that moves money.
        const guardTrx = payload.summary.trx || str(primary, 'no_transaksi');
        const guardReg = payload.summary.reg || reg;
        const guardKdUnit = payload.summary.kdUnit || str(primary, 'kd_unit');
        const orderBelumTerlayani = await softJson<unknown>(ctx, client, 'kasir.cekOrderBelumTerlayani', {
          no_registrasikunjungan: guardReg,
          no_transaksi: guardTrx,
          kd_unit: guardKdUnit,
        });
        const orderBelumTransfer = await softJson<unknown>(ctx, client, 'kasir.cekOrderBelumTransfer', {
          no_registrasikunjungan: guardReg,
          no_transaksi: guardTrx,
          kd_unit: guardKdUnit,
        });
        // `gethistory_pembayaran_kasir` is a GET (ranap_v3.py:3483): its two
        // parameters travel in the query string or they are dropped.
        const historyPembayaran = rowsOf(
          await softJson<unknown>(
            ctx,
            client,
            'kasir.getHistoryPembayaran',
            {},
            { query: { no_registrasikunjungan: guardReg, no_transaksi: guardTrx } },
          ),
        );

        const eligibility = evaluateTampungBayarEligibility({
          kunjunganRows: visits,
          roomRows: rows,
          payload,
          orderBelumTerlayani,
          orderBelumTransfer,
          historyPembayaran,
          dryRun: ctx.mode === 'preview',
        });

        emit(
          ctx,
          dataBlock(
            [
              { label: 'Baris tindakan', value: payload.rowCount },
              { label: 'Grand total', value: payload.grandTotalText },
              { label: 'Hasil', value: eligibility.eligible ? 'Dapat ditampung bayar' : 'Ditolak' },
              { label: 'Alasan', value: eligibility.detail || eligibility.reason },
              { label: 'Ruang premium', value: eligibility.premiumRooms },
              { label: 'No reg', value: reg, debugOnly: true },
              { label: 'Sumber baris', value: payload.rowSource, debugOnly: true },
              { label: 'Riwayat pembayaran', value: historyPembayaran.length, debugOnly: true },
            ],
            { bullet: '+ Tampung bayar:', debug },
          ),
          eligibility.eligible ? 'info' : 'warn',
        );

        if (!eligibility.eligible) {
          refusals.push(`${reg}: ${eligibility.detail || eligibility.reason}`);
          continue;
        }
        tampungRegs.push(reg);
        plans.push(
          mutationPlan(ctx, {
            node: 'tampung_bayar',
            index: plans.length,
            endpointId: 'kasir.tampungBayar',
            riskLevel: 'critical',
            reason: `Tampung bayar registrasi ${reg} sebesar ${payload.grandTotalText}`,
            trx: str(primary, 'no_transaksi'),
            // `main()` stages payment only `if verified and balanced`
            // (ranap_v3.py:16855) — so the verification status must read "1"
            // here, the opposite of a "belum terverifikasi" guard. The other
            // three are `proses_tampung_bayar_group`'s own refusals.
            preconditions: [
              PRECONDITION.transaksiSudahTerverifikasi(guardTrx),
              PRECONDITION.tidakAdaOrderBelumTerlayani({
                no_registrasikunjungan: guardReg,
                no_transaksi: guardTrx,
                kd_unit: guardKdUnit,
              }),
              PRECONDITION.tidakAdaOrderBelumTransfer({
                no_registrasikunjungan: guardReg,
                no_transaksi: guardTrx,
                kd_unit: guardKdUnit,
              }),
              PRECONDITION.belumAdaRiwayatPembayaran(guardReg, guardTrx),
            ],
            // `tampung_bayar_kasir` (ranap_v3.py:3545). The body is already
            // assembled — key order, the nested URL-encoded `dt_bayar` form and
            // the compact `tindakan` JSON are pinned in `tampungBayar.test.ts` —
            // so it is used verbatim rather than rebuilt here.
            payload: payload.fields,
            payloadSummary: {
              no_registrasikunjungan: reg,
              grand_total: payload.grandTotalText,
              baris: payload.rowCount,
            },
            readAfterWriteChecks: [
              {
                description: 'Riwayat pembayaran menjadi tidak kosong',
                endpointId: 'kasir.getHistoryPembayaran',
                field: 'length',
                expected: 1,
                payload: { no_registrasikunjungan: guardReg, no_transaksi: guardTrx },
              },
            ],
          }),
        );
      }

      const tampungChecks: ReasoningItem[] = [
        ...tampungRegs.map((reg, index): ReasoningItem => ({ label: `Pembayaran registrasi ${reg} ditampung`, ok: false, detail: 'belum — tampung bayar', ...(plans[index] ? { planId: plans[index]!.id } : {}) })),
        ...refusals.map((entry): ReasoningItem => {
          const [reg, ...rest] = entry.split(': ');
          return { label: `Registrasi ${reg} boleh ditampung bayar`, ok: false, detail: rest.join(': ') };
        }),
      ];
      if (plans.length === 0) {
        return reasoned(skipped(
          refusals.length > 0 ? `Tampung bayar ditolak: ${refusals.join(' | ')}` : 'Tidak ada yang bisa ditampung bayar',
        ), tampungTitle, tampungChecks);
      }
      return reasoned(planResult(`Rencana tampung bayar ${plans.length} grup`, plans), tampungTitle, tampungChecks);
    },

    /**
     * `_emit_verifikasi_summary_tsv`, driven the way `main()` drives it.
     *
     * The Python emits a row **only** `if verified` (ranap_v3.py:16828) and
     * `continue`s past a registration it skipped (16789-16809), and it passes
     * `byny_rme_status_by_reg.get(reg, {})` (16843) — per registration, not one
     * run-wide value. Emitting a row for every registration regardless reported a
     * verification that never happened, and the run-wide newborn marker put
     * `BAYI SEHAT` on every row as soon as any patient in the run was a newborn.
     *
     * `verified` is the **real** outcome, not "verification was planned":
     * `execute_verifikasi` records which `verifikator.simpanVerifikasi` plan
     * belongs to which registration, and this step looks that plan up in
     * `ctx.mutations`. A row is emitted only when the plan reached `verified` —
     * the write landed *and* both read-after-write rules held. `applied`
     * (unconfirmed), `failed`, `invalidated` and `planned` all emit nothing,
     * because a summary row is the ward's record that the bill was closed.
     *
     * A preview run therefore emits no rows at all, which is correct — nothing
     * is ever applied there — and the summary says so rather than reporting an
     * empty result as if the registrations had been examined and rejected.
     *
     * The outcome this reads is a *settled* one, not a snapshot taken while the
     * write was still in flight: `execute_verifikasi` returns
     * `needsReplan: true` while it has verification plans outstanding, so on a
     * write run the graph does not reach this node until every one of them is
     * `verified`, `failed` or `invalidated`. That is the same order the Python
     * runs in — write, `_confirm_verifikasi_state` (15371), *then* emit the row
     * (16828). A run whose verification nobody approved stops at
     * `execute_verifikasi` and never gets here at all.
     */
    'ranap.emitSummary': (ctx) => {
      const input = inputOf(ctx);
      const groups = roomGroupsOf(ctx);
      const identity = getScratch<LegacyRow>(ctx, K.identity);
      const sep = getScratch<SepResult>(ctx, K.sepResult);
      const keteranganByReg = scratchRecord<string[]>(ctx, K.summaryKeteranganByReg);
      const grandTotal = getScratch<number>(ctx, K.grandTotal) ?? 0;
      const grandTotalByReg = scratchRecord<number>(ctx, K.grandTotalByReg);
      const regs = Object.entries(groups);
      if (regs.length === 0) return skipped('Tidak ada grup untuk dirangkum');

      const planByReg = scratchRecord<string>(ctx, K.verificationPlanByReg);
      const outcomes = ctx.mutations;
      const outcomeFor = (reg: string) => {
        const planId = planByReg[reg];
        return planId ? outcomes[planId] : undefined;
      };
      const verified = new Set(regs.map(([reg]) => reg).filter((reg) => outcomeFor(reg)?.status === 'verified'));
      const proposed = regs.map(([reg]) => reg).filter((reg) => planByReg[reg] !== undefined);
      const unsettled = proposed.filter((reg) => !verified.has(reg));

      const rows: string[] = [];
      for (const [reg, roomRows] of regs) {
        if (!verified.has(reg)) continue;
        const bynyRmeStatus = bynyRmeStatusFor(ctx, reg);
        const row = buildVerifikasiSummaryRow({
          noRm: input.noRm,
          roomRows,
          namaPasien: str(identity, 'nama_pasien'),
          noMedicalrecord: str(identity, 'no_medicalrecord'),
          namaPenjamin: str(identity, 'nama_penjamin'),
          ...(sep?.sepItem ? { sepItem: sep.sepItem } : {}),
          fallbackNoSep: sep?.sepOK ?? str(identity, 'no_sep'),
          ...(bynyRmeStatus ? { bynyRmeStatus } : {}),
          ...(input.userProses ? { userProses: input.userProses } : {}),
          // `_emit_verifikasi_summary_tsv` reads the cashier total for *this*
          // registration; a run-wide max put one registration's money on
          // another's row when several groups were verified together.
          grandTotal: grandTotalByReg[reg] ?? grandTotal,
          keterangan: keteranganByReg[reg] ?? [],
        });
        if (row.tsv) rows.push(row.tsv);
      }

      const alerts = alertsOf(ctx);
      const alertCount = regs.reduce((sum, [reg]) => sum + alerts.getRegAlerts(reg).length, 0);
      // Why a registration produced no row, in the operator's own terms: a
      // preview never writes, and a write run can still be waiting on the gate.
      const pendingNote = unsettled
        .map((reg) => `${outcomeFor(reg)?.status ?? 'planned'}`)
        .reduce<Record<string, number>>((acc, status) => {
          acc[status] = (acc[status] ?? 0) + 1;
          return acc;
        }, {});
      const pendingText = Object.entries(pendingNote)
        .map(([status, count]) => `${count} ${status}`)
        .join(', ');
      const summary =
        ctx.mode === 'preview'
          ? `Preview — tidak ada write yang dijalankan, jadi tidak ada baris ringkasan ` +
            `(${regs.length} grup diperiksa, ${proposed.length} rencana verifikasi dibuat)`
          : rows.length === regs.length
            ? `Ringkasan ${rows.length} dari ${regs.length} grup rawat inap`
            : `Ringkasan ${rows.length} dari ${regs.length} grup rawat inap — ` +
              `${unsettled.length} registrasi belum terverifikasi${pendingText ? ` (${pendingText})` : ''}`;

      ctx.log('Ringkasan verifikasi rawat inap');
      if (rows.length > 0) {
        ctx.log(VERIFIKASI_SUMMARY_HEADER.join('\t'));
        for (const row of rows) ctx.log(row);
      } else {
        ctx.log(bulletLine('Tidak ada registrasi terverifikasi yang bisa dirangkum'));
      }
      if (unsettled.length > 0) {
        ctx.log(
          `+ ${unsettled.length} registrasi tanpa baris ringkasan | alasan=verifikasi belum terkonfirmasi` +
            `${pendingText ? ` (${pendingText})` : ''}`,
          'warn',
        );
      }
      if (alertCount > 0) ctx.log(`+ ${alertCount} catatan/alert tercatat untuk run ini`, 'warn');

      const summaryChecks: ReasoningItem[] = regs.map(([reg]): ReasoningItem => (verified.has(reg)
        ? { label: `Baris ringkasan registrasi ${reg}`, ok: true, detail: 'terverifikasi — masuk TSV' }
        : planByReg[reg] !== undefined
          ? { label: `Baris ringkasan registrasi ${reg}`, ok: null, detail: ctx.mode === 'preview' ? 'preview — tidak ditulis' : `verifikasi ${outcomeFor(reg)?.status ?? 'planned'}` }
          : { label: `Baris ringkasan registrasi ${reg}`, ok: false, detail: 'tidak diverifikasi' }));
      const summaryEvidence = reasoningEvidence({ title: 'Satu baris TSV per registrasi yang benar-benar terverifikasi', items: summaryChecks });
      return ok(summary, {
        evidence: [
          summaryEvidence,
          { label: 'summaryTsv', data: { header: VERIFIKASI_SUMMARY_HEADER, rows } },
          {
            label: 'verificationOutcomes',
            data: proposed.map((reg) => ({
              reg,
              planId: planByReg[reg],
              status: outcomeFor(reg)?.status ?? 'planned',
            })),
          },
          { label: 'alerts', data: regs.map(([reg]) => ({ reg, alerts: alerts.getRegAlerts(reg) })) },
        ],
      });
    },
  };
}

// ── local helpers ────────────────────────────────────────────────

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `_has_minimum_kasir_identity` (ranap_v3.py:1304) — enough identity to trust
 * the read.
 *
 * Two conditions, in the Python's order: the transaction **and** the
 * registration must both be present, and then at least **two** of the three soft
 * fields (`no_medicalrecord`, `nama_pasien`, `alamat`). Requiring all three of
 * medrec/name/transaction instead — and never checking the registration — both
 * accepted responses with a blank reg, whose alerts then get filed under the
 * empty string, and rejected responses the Python accepts, aborting a critical
 * node on a row that only happens to lack a name.
 */
function hasMinimumKasirIdentity(data: LegacyRow | undefined): boolean {
  if (!data) return false;
  if (!str(data, 'no_transaksi') || !str(data, 'no_registrasikunjungan')) return false;
  const soft = [str(data, 'no_medicalrecord'), str(data, 'nama_pasien'), str(data, 'alamat')];
  return soft.filter(Boolean).length >= 2;
}

/**
 * Build the kasir identity for one visit: `kasir.getDataTransaksi` first, then a
 * composite when that read gives no usable identity. (It was believed dead -
 * empty for every transaction - but that was a broken session cookie; live
 * 2026-10-15 it answers with `no_sep`.) The composite assembles the same fields
 * from three other reads:
 *   - `pendaftaran.getDataKunjungan`  → no_medicalrecord, nama_pasien, alamat,
 *                                       tempat_lahir, jenis, no_transaksi, no_reg
 *   - `penatajasaInap.getDataKunjunganTab` → jenis_sep, kd_instalasi, kd_unit
 *   - `poliklinik.getDataTransaksi`   → nama_unit, kd_unit (fallback for unit)
 *
 * `nama_penjamin` comes from the visit-history row the caller already holds.
 * `no_sep` stays empty here — SEP resolution reads the authoritative value from
 * `pendaftaran.getRiwayatSep`/`getDataSepBpjs`, and `compare_sep` only needs the
 * kasir value as a *starting* point the same resolution would override. Display
 * fields no working endpoint carries (`kd_kelpenjamin`, `kd_paramedis`,
 * `nama_paramedis`, `nama_pg`) are simply absent — they render as `-`.
 *
 * All three reads are soft (tolerant): a partial composite is fine as long as
 * `hasMinimumKasirIdentity` still gates it, so a single flaky read degrades the
 * log line, never the run.
 */
async function readKasirIdentity(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  input: { noRm: string },
  visit: LegacyRow,
): Promise<LegacyRow | undefined> {
  const reg = str(visit, 'no_registrasikunjungan');
  const trx = str(visit, 'no_transaksi');
  const kdUnit = str(visit, 'kd_unit');
  // `ambil_datatransaksi` (ranap_v3.py:3360). It answers once the session cookie
  // is right (live 2026-10-15, with no_sep); it only looked dead before. Prefer
  // it - it is the only read carrying the kasir's recorded SEP.
  const kasir = await softJson<LegacyRow>(ctx, client, 'kasir.getDataTransaksi', {
    txtmedrec: input.noRm,
    no_transaksi: trx,
    kd_unit: kdUnit,
    no_registrasikunjungan: reg,
  });
  if (hasMinimumKasirIdentity(kasir)) return kasir;
  const [demog, tab, poli] = await Promise.all([
    softJson<LegacyRow>(ctx, client, 'pendaftaran.getDataKunjungan', { txtmedrec_pdft: input.noRm }),
    reg
      ? softJson<LegacyRow>(ctx, client, 'penatajasaInap.getDataKunjunganTab', {
          no_registrasikunjungan: reg,
          kd_unit: kdUnit,
          no_transaksi: trx,
        })
      : Promise.resolve(undefined),
    reg
      ? softJson<LegacyRow>(ctx, client, 'poliklinik.getDataTransaksi', {
          txtmedrec_poli: input.noRm,
          no_transaksi: trx,
          no_registrasikunjungan: reg,
          kd_unit: kdUnit,
        })
      : Promise.resolve(undefined),
  ]);

  const identity: LegacyRow = {
    // Guard + payload fields.
    no_transaksi: trx || str(demog, 'no_transaksi'),
    no_registrasikunjungan: reg || str(demog, 'no_registrasikunjungan'),
    no_medicalrecord: str(demog, 'no_medicalrecord'),
    // Demographics.
    nama_pasien: str(demog, 'nama_pasien'),
    alamat: str(demog, 'alamat'),
    tempat_lahir: str(demog, 'tempat_lahir'),
    jenis: str(demog, 'jenis'),
    tanggal_lahir: str(demog, 'tanggal_lahir'),
    // Transaction type / unit.
    jenis_sep: str(tab, 'jenis_sep'),
    kd_instalasi: str(tab, 'kd_instalasi'),
    kd_unit: kdUnit || str(tab, 'kd_unit') || str(poli, 'kd_unit'),
    nama_unit: str(visit, 'nama_unit') || str(poli, 'nama_unit'),
    // Penjamin from the visit row; SEP resolved downstream.
    nama_penjamin: str(visit, 'nama_penjamin') || str(demog, 'nama_penjamin'),
    no_sep: '',
    // Marker: the kasir transaction's recorded SEP is unknown because the only
    // endpoint that carried it (`kasir.getDataTransaksi`) is dead on this
    // backend. `compare_sep` uses this to avoid auto-planning a correction it
    // cannot verify — it surfaces needs_review instead.
    _sep_unreadable: '1',
  };
  return hasMinimumKasirIdentity(identity) ? identity : undefined;
}

/**
 * `_parse_datetime_flexible(row["tgl_masuk"]) or datetime.min` as a sortable
 * number — an unreadable admission date sorts last under a descending sort.
 */
function admissionTime(row: LegacyRow): number {
  return parseDateTimeFlexible(str(row, 'tgl_masuk'))?.getTime() ?? Number.NEGATIVE_INFINITY;
}

/** The pending `_sync_tgl_masuk_awal_rawat_inap` correction for one group. */
interface TglMasukSync {
  noTransaksi: string;
  /** The row's current `tgl_masuk`, verbatim. */
  from: string;
  /** The datetime the write would set. */
  to: string;
  /** Just the date half of {@link to} — what the confirmation read compares. */
  targetDate: string;
  /** The group's stays with the correction applied and re-normalised. */
  stays: LegacyRow[];
}

/**
 * `_sync_tgl_masuk_awal_rawat_inap` (ranap_v3.py:8894) — the decision and the
 * in-memory half, without the write.
 *
 * Returns `undefined` when the Python would `return False` before writing: no
 * stays, no transaction or registration on the first stay, no readable SEP date,
 * or the first stay already starts on the SEP date.
 *
 * When the corrected start would swallow the discharge time the Python pushes
 * `tgl_keluar` to the same date, keeping the row a valid interval
 * (ranap_v3.py:8952-8960).
 *
 * `now` is the run's injected clock (`ctx.clock.now()`), which is what the
 * Python's `now_time = datetime.now().strftime("%H:%M:%S")` (ranap_v3.py:8913)
 * becomes here: the same wall-clock time-of-day stamped onto the SEP date, but
 * reproducible on replay. It is routed through `buildUpdateDateTime`, so a clock
 * reading exactly midnight yields `00:00:01` rather than the Python's
 * `00:00:00` — a one-second-per-day divergence in the safe direction, since the
 * backend treats a `00:00:00` stamp as "no time given" and re-derives it, which
 * is the very thing this write is trying to override (`_normalize_update_time`,
 * ranap_v3.py:1570).
 */
function planTglMasukAwalSync(
  stays: readonly LegacyRow[],
  tglSep: string,
  now: Date,
): TglMasukSync | undefined {
  const first = stays[0];
  if (!first) return undefined;

  const noTransaksi = str(first, 'no_transaksi');
  const noReg = str(first, 'no_registrasikunjungan');
  const targetDate = datePart(tglSep);
  const currentTglMasuk = str(first, 'tgl_masuk');
  const currentDate = datePart(currentTglMasuk);
  if (!noTransaksi || !noReg || !targetDate || currentDate === targetDate) return undefined;

  const targetDatetime = buildUpdateDateTime(targetDate, currentTglMasuk, '00:00:01', now);
  if (!targetDatetime) return undefined;

  const corrected: Record<string, unknown> = {
    ...first,
    _actual_tgl_masuk: first['_actual_tgl_masuk'] ?? first['tgl_masuk'],
    _actual_tgl_keluar: first['_actual_tgl_keluar'] ?? first['tgl_keluar'],
    tgl_masuk: targetDatetime,
  };

  const tglKeluar = str(first, 'tgl_keluar');
  if (currentTglMasuk && tglKeluar) {
    const keluarDt = parseDateTimeFlexible(tglKeluar);
    const startDt = parseDateTimeFlexible(targetDatetime);
    if (keluarDt && startDt && keluarDt.getTime() <= startDt.getTime()) {
      let candidate = combineDateTime(targetDate, timePart(tglKeluar, '23:59:59'));
      const candidateDt = parseDateTimeFlexible(candidate);
      if (!candidateDt || candidateDt.getTime() <= startDt.getTime()) {
        candidate = combineDateTime(targetDate, '23:59:59');
      }
      corrected['tgl_keluar'] = candidate;
    }
  }

  return {
    noTransaksi,
    from: currentTglMasuk,
    to: targetDatetime,
    targetDate,
    // `room_rows[:] = _normalize_room_stays(sorted_rows)` (ranap_v3.py:8961) —
    // the correction can reorder the stays, so they are re-normalised.
    stays: normalizeRoomStays([corrected, ...stays.slice(1)]),
  };
}

/**
 * `group_start` / `group_end` for one registration (ranap_v3.py:16190-16202).
 *
 * The window is the group's own span, widened to include the SEP date, and — when
 * any stay is still open (`tgl_keluar` blank) — extended forward by the run's
 * tolerance. It is what the four penunjang histories are filtered to, so a stale
 * unresulted order from a previous admission cannot become a candidate for this
 * episode.
 */
function groupPenunjangWindow(
  stays: readonly LegacyRow[],
  tglSep: string,
  toleranceDays: number,
): { start: string; end: string } {
  const starts = stays.map((row) => datePart(row['tgl_masuk'])).filter(Boolean);
  const sepDate = datePart(tglSep);
  if (sepDate) starts.push(sepDate);
  const ends = stays
    .map((row) => datePart(str(row, 'tgl_keluar') || str(row, 'tgl_masuk')))
    .filter(Boolean);
  // ISO dates compare lexicographically, so min/max on the strings is Python's.
  const start = starts.length > 0 ? starts.reduce((min, item) => (item < min ? item : min)) : '';
  let end = ends.length > 0 ? ends.reduce((max, item) => (item > max ? item : max)) : '';
  if (stays.some((row) => !datePart(row['tgl_keluar']))) {
    const base = parseDateFlexible(end) ?? parseDateFlexible(start);
    if (base) {
      const extended = new Date(base.getTime());
      extended.setDate(extended.getDate() + toleranceDays);
      end = formatDate(extended);
    }
  }
  return { start, end };
}

function candidateKey(candidate: PenunjangCandidate): string {
  return `${candidate.modality}|${candidate.noTransaksi}`;
}

/** The four reads `validate_penunjang` depends on for its clean verdict. */
const PENUNJANG_HISTORY_ENDPOINTS = [
  'penatajasaInap.getHistoryILab',
  'kemoterapi.getHistoryOrderPa',
  'poliklinik.getHistoryIrad',
  'penatajasaInap.getHistoryIok',
] as const;

/** `_collect_ordergizi_transactions_for_group` output plus its detail snapshot. */
interface GiziOrderSnapshot {
  orderItems: OrderGiziTransaction[];
  detailByOrder: Record<string, unknown>;
}

/**
 * `_build_rekapitulasi_detail_hak_params` (ranap_v3.py:8570) including the two
 * reads it makes internally, memoized per registration.
 *
 * The Python builds these params inside both `fetch_rekapitulasi_detail_hak_html`
 * (for the IBS check) and `fetch_rekapitulasi_detail_hak` (for the balance
 * check), so both get the `getdatakunjungan_tab2` codes; building them without
 * tab2 for one caller would ask the backend for a different recap.
 *
 * @throws whatever `buildRekapitulasiDetailHakParams` throws — a group with no
 *   readable `tgl_masuk` is a data fault the caller has to report.
 */
async function resolveRekapParams(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  reg: string,
  roomRows: readonly LegacyRow[],
): Promise<Record<string, string>> {
  const cache = scratchRecord<Record<string, string>>(ctx, K.rekapParamsByReg);
  const cached = cache[reg];
  if (cached) return cached;

  const primary = roomRows[0];
  const noRm = inputOf(ctx).noRm;
  const datakunjungan = await softJson<LegacyRow>(ctx, client, 'penatajasaInap.getDataKunjungan', {
    txtmedrec_inap: noRm,
    no_transaksi: str(primary, 'no_transaksi'),
  });
  const kdUnit = str(datakunjungan, 'kd_unit') || str(primary, 'kd_unit');
  const datakunjunganTab2 = kdUnit
    ? await softJson<LegacyRow>(ctx, client, 'poliklinik.getDataKunjunganTab2', {
        no_registrasikunjungan: reg,
        kd_unit: kdUnit,
      })
    : undefined;

  return (cache[reg] = buildRekapitulasiDetailHakParams({
    noRm,
    roomRows,
    ...(datakunjungan ? { datakunjungan } : {}),
    ...(datakunjunganTab2 ? { datakunjunganTab2 } : {}),
  }));
}

/**
 * `fetch_rekapitulasi_detail_hak_html` (ranap_v3.py:8608), memoized per
 * registration.
 *
 * `validate_ibs_consistency` and `cek_balance_total_tagihan` both scrape this
 * page for the same group, so the read happens once.
 */
async function fetchRekapHtml(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  reg: string,
  roomRows: readonly LegacyRow[],
): Promise<string> {
  const cache = scratchRecord<string>(ctx, K.rekapHtmlByReg);
  const cached = cache[reg];
  if (cached !== undefined) return cached;

  let query: Record<string, string>;
  try {
    query = await resolveRekapParams(ctx, client, reg, roomRows);
  } catch {
    // The Python's caller skips the fetch when the params cannot be built.
    return (cache[reg] = '');
  }
  if (Object.keys(query).length === 0) return (cache[reg] = '');
  return (cache[reg] = await softText(ctx, client, 'rekapitulasi.detailHakHtml', {}, { query }));
}

/** `get_listtindakan_poli_igd` (ranap_v3.py:3936) — paged to 999. */
async function fetchPoliListTindakan(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  noTransaksi: string,
): Promise<LegacyRow[]> {
  return rowsOf(
    await softJson<unknown>(ctx, client, 'poliklinik.getListTindakan', {
      no_transaksi: noTransaksi,
      page: '1',
      rows: '999',
    }),
  );
}

async function fetchLabPkListTindakan(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  key: LabPkTransferKey,
): Promise<LegacyRow[]> {
  return rowsOf(await softJson<unknown>(ctx, client, 'laboratorium.getListTindakan', labPkListPayload(key)));
}

function labPkRowsAreTutup(rows: readonly LegacyRow[]): boolean {
  return rows.length > 0 && rows.every((row) => str(row, 'tutup_transaksi').toLowerCase() === 'tutup');
}

function labPkHasPendingRows(rows: readonly LegacyRow[]): boolean {
  return rows.some((row) => str(row, 'status_bayar').toLowerCase() !== 'sudah');
}

function labPkRowsAllSudah(rows: readonly LegacyRow[]): boolean {
  return rows.length > 0 && !labPkHasPendingRows(rows);
}

function labPkRowsTutupSummary(rows: readonly LegacyRow[]): string {
  const states: string[] = [];
  for (const row of rows.slice(0, 10)) {
    const state = str(row, 'tutup_transaksi') || '-';
    if (!states.includes(state)) states.push(state);
  }
  return states.join(',') || '-';
}

interface LabPkStatus {
  key: LabPkTransferKey;
  transferFlag: string;
  transferPoliTujuan: string;
  verifikasiPoliTujuan: string;
  transaksiTerbuka: string;
  statusTutup: string;
  statusBayar: string;
  statusTransfer: string;
  listRows: LegacyRow[];
  pendingRows: boolean;
  allRowsSudah: boolean;
}

async function readLabPkStatus(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  key: LabPkTransferKey,
): Promise<LabPkStatus> {
  const [transferFlag, transferPoliTujuan, verifikasiPoliTujuan, transaksiTerbuka, statusTutup, statusBayar, statusTransfer] =
    await Promise.all([
      softText(ctx, client, 'laboratorium.cekStatusBayarTransfer', { no_transaksi: key.noTransaksiLab }),
      softText(ctx, client, 'laboratorium.cekStatusTransferPoliTujuan', { no_transaksipoli: key.noTransaksipoli }),
      softText(ctx, client, 'laboratorium.cekStatusVerifikasi', { no_transaksipoli: key.noTransaksipoli }),
      softText(ctx, client, 'laboratorium.cekTransaksiTerbuka', { no_transaksi: key.noTransaksiLab }),
      softText(ctx, client, 'laboratorium.cekTutupTransaksi', { no_transaksi: key.noTransaksiLab }),
      softText(ctx, client, 'laboratorium.cekStatusBayar', { no_transaksi: key.noTransaksiLab }),
      softText(ctx, client, 'laboratorium.cekStatusTransfer', labPkPayload(key)),
    ]);
  const listRows = await fetchLabPkListTindakan(ctx, client, key);
  return {
    key,
    transferFlag: transferFlag.trim(),
    transferPoliTujuan: transferPoliTujuan.trim(),
    verifikasiPoliTujuan: verifikasiPoliTujuan.trim(),
    transaksiTerbuka: transaksiTerbuka.trim(),
    statusTutup: statusTutup.trim(),
    statusBayar: statusBayar.trim(),
    statusTransfer: statusTransfer.trim(),
    listRows,
    pendingRows: labPkHasPendingRows(listRows),
    allRowsSudah: labPkRowsAllSudah(listRows),
  };
}

function labPkPlanKey(key: LabPkTransferKey): string {
  return `${key.noTransaksiLab}|${key.noTransaksipoli}`;
}

function labPkVerified(ctx: ExecutorContext, id: string | undefined): boolean {
  return Boolean(id && ctx.mutations[id]?.status === 'verified');
}

function labPkBatalPreconditions(key: LabPkTransferKey, status: LabPkStatus): Precondition[] {
  const guards: Precondition[] = [];
  if (status.transferFlag === '1') guards.push(PRECONDITION.labPkMasihTransfer(key));
  if (status.statusTransfer === '1') guards.push(PRECONDITION.labPkTransferMasihAktif(key));
  if (status.transferPoliTujuan === '1') guards.push(PRECONDITION.labPkParentPoliMasihTransfer(key));
  return guards.length > 0 ? guards : [PRECONDITION.labPkMasihTransfer(key)];
}

function labPkBatalTransferRules(key: LabPkTransferKey): VerificationRule[] {
  return [
    {
      description: 'Lab PK tidak lagi terbaca transfer ke tagihan tujuan',
      endpointId: 'laboratorium.cekStatusTransfer',
      field: '',
      expected: '0',
      match: 'empty',
      payload: labPkPayload(key),
    },
    {
      description: 'Flag transfer Lab PK sudah kosong',
      endpointId: 'laboratorium.cekStatusBayarTransfer',
      field: '',
      expected: '0',
      match: 'empty',
      payload: { no_transaksi: key.noTransaksiLab },
    },
    {
      description: 'Transaksi tujuan Lab PK tidak lagi terbaca transfer',
      endpointId: 'laboratorium.cekStatusTransferPoliTujuan',
      field: '',
      expected: '0',
      match: 'empty',
      payload: { no_transaksipoli: key.noTransaksipoli },
    },
  ];
}

function labPkOpenRule(noTransaksiLab: string): VerificationRule {
  return {
    description: 'Transaksi Lab PK terbaca terbuka',
    endpointId: 'laboratorium.cekTransaksiTerbuka',
    field: '',
    expected: '1',
    match: 'nonEmpty',
    payload: { no_transaksi: noTransaksiLab },
  };
}

function labPkTutupRules(key: LabPkTransferKey): VerificationRule[] {
  return [
    {
      description: 'Transaksi Lab PK terbaca tutup',
      endpointId: 'laboratorium.cekTutupTransaksi',
      field: '',
      expected: '1',
      match: 'nonEmpty',
      payload: { no_transaksi: key.noTransaksiLab },
    },
    {
      description: 'Semua baris Lab PK terbaca Tutup',
      endpointId: 'laboratorium.getListTindakan',
      field: 'tutup_transaksi',
      expected: 'Tutup',
      match: 'allEquals',
      payload: labPkListPayload(key),
    },
  ];
}

function labPkTransferRules(key: LabPkTransferKey): VerificationRule[] {
  return [
    {
      description: 'Lab PK terbaca sudah transfer ke tagihan tujuan',
      endpointId: 'laboratorium.cekStatusTransfer',
      field: '',
      expected: '1',
      match: 'nonEmpty',
      payload: labPkPayload(key),
    },
    {
      description: 'Semua tindakan Lab PK berstatus Sudah',
      endpointId: 'laboratorium.getListTindakan',
      field: 'status_bayar',
      expected: 'Sudah',
      match: 'allEquals',
      payload: labPkListPayload(key),
    },
  ];
}

async function planLabPkForPoliSource(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  args: { noRm: string; source: LegacyRow; reg: string; firstIndex: number },
): Promise<MutationPlan[]> {
  const related = await collectRelatedLabPk(ctx, client, args.noRm, args.source, toleranceOf(ctx));
  const sourceKdUnit = str(args.source, 'kd_unit');
  const sourceKdDet = str(args.source, 'kd_detkelpenjamin') || '15';
  const planByPair = scratchRecord<string>(ctx, K.labPkPlanByPair);
  const plans: MutationPlan[] = [];

  for (const item of related) {
    const key = { noTransaksiLab: str(item, 'no_transaksi_lab'), noTransaksipoli: str(item, 'no_transaksi') };
    if (!key.noTransaksiLab || !key.noTransaksipoli) continue;
    const status = await readLabPkStatus(ctx, client, key);
    ctx.log(
      `- Status Lab PK | source=POLI | lab=${key.noTransaksiLab} | poli=${key.noTransaksipoli} | ` +
        `transfer_flag=${status.transferFlag || '-'} | transfer_status=${status.statusTransfer || '-'} | ` +
        `parent_poli_transfer=${status.transferPoliTujuan || '-'} | parent_poli_verif=${status.verifikasiPoliTujuan || '-'} | ` +
        `transaksi_terbuka=${status.transaksiTerbuka || '-'} | status_tutup=${status.statusTutup || '-'} | ` +
        `status_bayar=${status.statusBayar || '-'}`,
    );
    if (status.allRowsSudah) {
      ctx.log(
        `- Lab PK sudah transfer | source=POLI | lab=${key.noTransaksiLab} | poli=${key.noTransaksipoli} | ` +
          'alasan=semua tindakan laboratorium sudah berstatus Sudah',
      );
      continue;
    }

    const pair = labPkPlanKey(key);
    const previousId = planByPair[pair];
    if (previousId && !labPkVerified(ctx, previousId)) {
      ctx.log(`- Lab PK menunggu hasil write sebelumnya | lab=${key.noTransaksiLab} | status=${ctx.mutations[previousId]?.status ?? 'planned'}`);
      continue;
    }

    const perluBatal = status.transferFlag === '1' || ((status.statusTransfer === '1' || status.transferPoliTujuan === '1') && status.pendingRows);
    if (perluBatal && !labPkVerified(ctx, previousId)) {
      const plan = mutationPlan(ctx, {
        node: 'process_poli',
        index: args.firstIndex + plans.length,
        endpointId: 'laboratorium.batalTransfer',
        riskLevel: 'high',
        reason: `Batal transfer Lab PK terkait POLI asal karena status transfer inkonsisten (reg ${args.reg})`,
        trx: key.noTransaksiLab,
        preconditions: labPkBatalPreconditions(key, status),
        payload: labPkPayload(key),
        payloadSummary: { no_registrasikunjungan: args.reg, lab_trx: key.noTransaksiLab, poli_trx: key.noTransaksipoli },
        readAfterWriteChecks: labPkBatalTransferRules(key),
      });
      planByPair[pair] = plan.id;
      plans.push(plan);
      continue;
    }

    if (status.transaksiTerbuka !== '1') {
      const plan = mutationPlan(ctx, {
        node: 'process_poli',
        index: args.firstIndex + plans.length,
        endpointId: 'laboratorium.bukaBhp',
        riskLevel: 'high',
        reason: `Buka transaksi Lab PK terkait POLI asal sebelum transfer (reg ${args.reg})`,
        trx: key.noTransaksiLab,
        preconditions: [PRECONDITION.labPkPerluBuka(key.noTransaksiLab)],
        payload: { no_transaksi: key.noTransaksiLab },
        payloadSummary: { no_registrasikunjungan: args.reg, lab_trx: key.noTransaksiLab, poli_trx: key.noTransaksipoli },
        readAfterWriteChecks: [labPkOpenRule(key.noTransaksiLab)],
      });
      planByPair[pair] = plan.id;
      plans.push(plan);
      continue;
    }

    if (status.statusTutup !== '1' || !labPkRowsAreTutup(status.listRows)) {
      const plan = mutationPlan(ctx, {
        node: 'process_poli',
        index: args.firstIndex + plans.length,
        endpointId: 'laboratorium.tutupBhp',
        riskLevel: 'high',
        reason: `Tutup transaksi Lab PK terkait POLI asal sebelum transfer (reg ${args.reg})`,
        trx: key.noTransaksiLab,
        preconditions: [PRECONDITION.labPkPerluTutup(key.noTransaksiLab)],
        payload: { no_transaksi: key.noTransaksiLab },
        payloadSummary: {
          no_registrasikunjungan: args.reg,
          lab_trx: key.noTransaksiLab,
          poli_trx: key.noTransaksipoli,
          tutup_states: labPkRowsTutupSummary(status.listRows),
        },
        readAfterWriteChecks: labPkTutupRules(key),
      });
      planByPair[pair] = plan.id;
      plans.push(plan);
      continue;
    }

    const biaya = await softText(ctx, client, 'laboratorium.getTotal', labPkListPayload(key));
    if (!sourceKdUnit || !biaya.trim()) {
      ctx.log(`- Skip transfer Lab PK | lab=${key.noTransaksiLab} | alasan=kd_unit_poli/biaya kosong`, 'warn');
      continue;
    }
    const plan = mutationPlan(ctx, {
      node: 'process_poli',
      index: args.firstIndex + plans.length,
      endpointId: 'laboratorium.transferLab',
      riskLevel: 'high',
      reason: `Transfer Lab PK terkait POLI asal ke tagihan rawat inap (reg ${args.reg})`,
      trx: key.noTransaksiLab,
      preconditions: PRECONDITION.labPkSiapTransfer(key),
      payload: transferLabPkPayload({ ...key, kdUnitPoli: sourceKdUnit, kdDetkelpenjamin: sourceKdDet, biaya }),
      payloadSummary: {
        no_registrasikunjungan: args.reg,
        lab_trx: key.noTransaksiLab,
        poli_trx: key.noTransaksipoli,
        kd_unit_poli: sourceKdUnit,
        biaya,
      },
      readAfterWriteChecks: labPkTransferRules(key),
    });
    planByPair[pair] = plan.id;
    plans.push(plan);
  }
  return plans;
}

/**
 * `_collect_related_lab_pk` (ranap_v3.py:7647) — the lab orders raised on the
 * poli source transaction, within the tolerance of its own admission date.
 *
 * These are the Lab PK candidates `validate_penunjang_results_for_group` reads
 * first; each row's `no_transaksi_lab` is the transaction to validate.
 */
async function collectRelatedLabPk(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  noRm: string,
  poliSource: LegacyRow,
  toleranceDays: number,
): Promise<LegacyRow[]> {
  const sourceTrx = str(poliSource, 'no_transaksi');
  if (!sourceTrx) return [];
  const sourceDate = parseDateFlexible(str(poliSource, 'tgl_masuk'));

  const rows = rowsOf(
    await softJson<unknown>(ctx, client, 'laboratorium.getHistoryKunjungan', {
      nomedrec: noRm,
      page: '1',
      rows: '50',
    }),
  );
  const hasil: LegacyRow[] = [];
  for (const row of rows) {
    if (str(row, 'no_transaksi') !== sourceTrx) continue;
    const labDt = parseDateFlexible(str(row, 'tgl_masuk'));
    if (sourceDate && labDt) {
      const diff = Math.abs(Math.round((labDt.getTime() - sourceDate.getTime()) / 86_400_000));
      if (diff > clampToleranceDays(toleranceDays)) continue;
    }
    hasil.push(row);
  }
  return hasil;
}

/** The `…/hasil_pemeriksaan/getdatakunjungan` field map, per module. */
function directHasilPayload(
  modality: 'lab' | 'rad',
  noRm: string,
  startDate: string,
  endDate: string,
  page: number,
): Record<string, string> {
  const paging = { page: String(page), rows: String(DIRECT_HASIL_ROWS_PER_PAGE) };
  if (modality === 'lab') {
    // ranap_v3.py:5248 — every field is `…_hsllab`.
    return {
      txtmedreccari_hsllab: noRm,
      txtnama_pasiencari_hsllab: '',
      txtalamatcari_hsllab: '',
      txttgltransaksicari_hsllab: startDate,
      txttgltransaksicari2_hsllab: endDate,
      ...paging,
    };
  }
  // ranap_v3.py:5143 — `…_hslrad`, plus the two extra filter dropdowns.
  return {
    txtmedreccari_hslrad: noRm,
    txtnama_pasiencari_hslrad: '',
    txtalamatcari_hslrad: '',
    txttgltransaksicari_hslrad: startDate,
    txttgltransaksicari2_hslrad: endDate,
    cmbparamediscari_hslrad: '',
    cmbunitcari_hslrad: '',
    ...paging,
  };
}

/**
 * The page payloads `_collect_direct_hasil_rows_for_group` (ranap_v3.py:7976)
 * walks: at most {@link DIRECT_HASIL_MAX_PAGES} pages over the group's declared
 * date range, stopping at the first empty or short page.
 *
 * The paging stop condition is duplicated here because the pure collector takes
 * pre-fetched pages, and fetching all four unconditionally would be three
 * pointless round trips for the common single-page case.
 */
async function fetchDirectHasilPages(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  modality: 'lab' | 'rad',
  noRm: string,
  roomRows: readonly LegacyRow[],
): Promise<unknown[]> {
  const { start, end } = getRoomGroupDateRange(roomRows);
  if (!start) return [];
  const endpointId = modality === 'lab' ? 'laboratoriumHasil.getDataKunjungan' : 'radiologi.getDataKunjungan';
  const pages: unknown[] = [];
  for (let page = 1; page <= DIRECT_HASIL_MAX_PAGES; page += 1) {
    const payload = await softJson<unknown>(
      ctx,
      client,
      endpointId,
      directHasilPayload(modality, noRm, start, end || start, page),
    );
    const rows = rowsOf(payload);
    if (rows.length === 0) break;
    pages.push(payload);
    if (rows.length < DIRECT_HASIL_ROWS_PER_PAGE) break;
  }
  return pages;
}

// ── origin source lookups ────────────────────────────────────────

/** Element-wise descending compare over a score tuple — Python's `reverse=True`. */
function compareScoresDesc(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined || bv === undefined) continue;
    if (typeof av === 'number' && typeof bv === 'number') {
      if (av !== bv) return bv - av;
      continue;
    }
    const as = String(av);
    const bs = String(bv);
    if (as !== bs) return bs < as ? -1 : 1;
  }
  return 0;
}

/** `abs((a.date() - b.date()).days)`, or `999` when either date is unreadable. */
function absDiffDays(a: Date | null, b: Date | null): number {
  if (!a || !b) return 999;
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.abs(Math.round((ua - ub) / 86_400_000));
}

/** `get_datatransaksi_poli_igd` (ranap_v3.py:3437) — `kd_unit` is hard-coded. */
async function fetchPoliLinkedTransaksi(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  noRm: string,
  reg: string,
): Promise<LegacyRow | undefined> {
  return softJson<LegacyRow>(ctx, client, 'poliklinik.getDataTransaksi', {
    txtmedrec_poli: noRm,
    no_transaksi: '',
    kd_unit: '1001',
    no_registrasikunjungan: reg,
  });
}

interface FindRelatedIgdSourceArgs {
  noRm: string;
  roomRows: readonly LegacyRow[];
  kunjunganRows: readonly LegacyRow[];
  elektromedikHistory: readonly LegacyRow[];
  poliHistory: readonly LegacyRow[];
  tanggal: string;
  toleranceDays: number;
  igdSignalByTrx: Readonly<Record<string, IgdSourceSignal>>;
  dataKunjunganByTrx: Readonly<Record<string, LegacyRow>>;
}

/**
 * `_find_related_igd_source_for_group` (ranap_v3.py:13804) — the IGD visit this
 * inpatient group came in through.
 *
 * Three candidate sweeps, each only reached when the previous found nothing: the
 * elektromedik history's `no_transaksipoli` parents, then the patient's own visit
 * history, then the poli visit history. A candidate has to be *linked* — the
 * poli controller's `getdatatransaksi` for its registration points back at one of
 * this group's transactions or registrations — or carry a SJP/SEP this group also
 * carries; anything else is a different episode. Within tolerance of the SEP date,
 * the best score wins, on the Python's tuple.
 *
 * The Python's second and third sweeps are the same `ambil_historykunjungan_poli`
 * read (cached), so they are one sweep here.
 */
async function findRelatedIgdSourceForGroup(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  args: FindRelatedIgdSourceArgs,
): Promise<LegacyRow | undefined> {
  const tolerance = clampToleranceDays(args.toleranceDays);
  const targetDt = parseDateFlexible(args.tanggal);
  const transaksiInap = new Set(
    args.roomRows.map((row) => str(row, 'no_transaksi')).filter(Boolean),
  );
  const registrasiInap = new Set(
    args.roomRows.map((row) => str(row, 'no_registrasikunjungan')).filter(Boolean),
  );
  const targetSepKeys = new Set(
    extractSepKeysFromRoomRows(args.roomRows, args.noRm, args.dataKunjunganByTrx),
  );

  const candidates: Array<{ score: (number | string)[]; row: LegacyRow }> = [];
  const seen = new Set<string>();

  const appendCandidate = async (
    parentIgd: string,
    rowReg: string,
    sourceNoTransaksi: string,
    sourceDt: Date | null,
  ): Promise<void> => {
    if (!parentIgd || !rowReg || seen.has(parentIgd)) return;

    const linked = await fetchPoliLinkedTransaksi(ctx, client, args.noRm, rowReg);
    const linkedTrx = str(linked, 'no_transaksi');
    const linkedReg = str(linked, 'no_registrasikunjungan');
    const linkedMatch =
      transaksiInap.size === 0 || transaksiInap.has(linkedTrx) || registrasiInap.has(linkedReg);

    // `ambil_datakunjungan_poli` first, then the inpatient `getdatakunjungan`
    // (ranap_v3.py:13828-13835).
    let sourceRow = await softJson<LegacyRow>(ctx, client, 'poliklinik.getDataKunjungan', {
      txtmedrec_poli: args.noRm,
      no_transaksi: parentIgd,
      tgl_masuk: sourceDt ? formatDate(sourceDt) : '',
      no_registrasikunjungan: rowReg,
    });
    if (!sourceRow || Object.keys(sourceRow).length === 0) {
      sourceRow = await softJson<LegacyRow>(ctx, client, 'penatajasaInap.getDataKunjungan', {
        txtmedrec_inap: args.noRm,
        no_transaksi: parentIgd,
      });
    }

    const signal =
      args.igdSignalByTrx[parentIgd] ??
      deriveIgdSourceSignal(await fetchPoliListTindakan(ctx, client, parentIgd));
    const sourceSep = str(sourceRow, 'no_sjp', 'no_sep');
    const sepMatch = targetSepKeys.size > 0 && Boolean(sourceSep) && targetSepKeys.has(sourceSep);
    if (!linkedMatch && !sepMatch) return;

    let diffDays = 999;
    if (targetDt && sourceDt) {
      diffDays = absDiffDays(sourceDt, targetDt);
      if (diffDays > tolerance) return;
    }

    seen.add(parentIgd);
    candidates.push({
      score: [
        linkedMatch ? 1 : 0,
        sepMatch ? 1 : 0,
        sourceNoTransaksi ? 1 : 0,
        signal.hasHemodialisaSignal ? 1 : 0,
        diffDays === 0 ? 1 : 0,
        -diffDays,
        parentIgd,
      ],
      row: {
        no_transaksi: parentIgd,
        no_registrasikunjungan: rowReg,
        source_no_transaksi: sourceNoTransaksi,
        linked_inap_trx: linkedTrx,
        linked_inap_reg: linkedReg,
        source_sep: sourceSep,
        kd_unit: str(sourceRow, 'kd_unit'),
        kd_detkelpenjamin: str(sourceRow, 'kd_detkelpenjamin'),
        nama_unit: str(sourceRow, 'nama_unit'),
        tgl_masuk: str(sourceRow, 'tgl_masuk'),
        has_hemodialisa_signal: signal.hasHemodialisaSignal,
        matched_names: [...signal.matchedNames],
        detail: sourceRow ?? {},
      },
    });
  };

  for (const row of args.elektromedikHistory) {
    const parentIgd = str(row, 'no_transaksipoli');
    if (!parentIgd.startsWith('02-')) continue;
    await appendCandidate(
      parentIgd,
      str(row, 'no_registrasikunjungan'),
      str(row, 'no_transaksi'),
      parseDateTimeFlexible(str(row, 'tgl_transaksi', 'tgl_jam')),
    );
  }

  const igdLikeRows = (rows: readonly LegacyRow[]) => rows.filter(isIgdSourceCandidate);

  if (candidates.length === 0) {
    for (const row of igdLikeRows(args.kunjunganRows)) {
      await appendCandidate(
        str(row, 'no_transaksi'),
        str(row, 'no_registrasikunjungan'),
        '',
        parseDateTimeFlexible(str(row, 'tgl_masuk')),
      );
    }
  }
  if (candidates.length === 0) {
    for (const row of igdLikeRows(args.poliHistory)) {
      await appendCandidate(
        str(row, 'no_transaksi'),
        str(row, 'no_registrasikunjungan'),
        '',
        parseDateTimeFlexible(str(row, 'tgl_masuk')),
      );
    }
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => compareScoresDesc(a.score, b.score));
  return candidates[0]?.row;
}

interface FindRelatedPoliSourceArgs {
  noRm: string;
  kunjunganInap: LegacyRow;
  tanggal: string;
  toleranceDays: number;
  poliHistory: readonly LegacyRow[];
}

/**
 * `_find_related_poli_source` (ranap_v3.py:13932) — the outpatient-clinic visit
 * this inpatient stay was admitted from.
 *
 * Only `01-` clinic visits on or before the reference date and inside the
 * tolerance are considered (a clinic visit *after* the admission cannot be its
 * source, which is why the Python drops a positive `diff_days`). A candidate has
 * to be linked back to this stay, or match on SEP, on the referral unit named in
 * `nama_rujukanasal`, or on the doctor — the same `fallback_match` disjunction.
 */
async function findRelatedPoliSource(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  args: FindRelatedPoliSourceArgs,
): Promise<LegacyRow | undefined> {
  const tolerance = clampToleranceDays(args.toleranceDays);
  const noTransaksiInap = str(args.kunjunganInap, 'no_transaksi');
  if (!noTransaksiInap.startsWith('03-')) return undefined;

  const dataInap =
    (await softJson<LegacyRow>(ctx, client, 'penatajasaInap.getDataKunjungan', {
      txtmedrec_inap: args.noRm,
      no_transaksi: noTransaksiInap,
    })) ?? {};
  const originText = upper(dataInap, 'nama_rujukanasal');
  const originKey = normalizeTextKey(originText);
  const tglRef = datePart(
    args.tanggal || str(dataInap, 'tgl_masuk') || str(args.kunjunganInap, 'tgl_masuk'),
  );
  const tglRefDt = parseDateFlexible(tglRef);
  const kdParamedisInap = str(dataInap, 'kd_paramedis');
  const registrasiInap = str(args.kunjunganInap, 'no_registrasikunjungan');
  const targetSepKeys = new Set(extractSepKeysFromRoomRows([args.kunjunganInap], args.noRm, {}));

  const candidates: Array<{ score: (number | string)[]; row: LegacyRow }> = [];
  for (const row of args.poliHistory) {
    const noTransaksiPoli = str(row, 'no_transaksi');
    const noRegPoli = str(row, 'no_registrasikunjungan');
    if (!noTransaksiPoli.startsWith('01-') || !noRegPoli) continue;

    const rowDate = datePart(str(row, 'tgl_masuk'));
    const rowDt = parseDateFlexible(rowDate);
    let diffDays = 999;
    if (tglRefDt && rowDt) {
      const signed = Math.round(
        (Date.UTC(rowDt.getFullYear(), rowDt.getMonth(), rowDt.getDate()) -
          Date.UTC(tglRefDt.getFullYear(), tglRefDt.getMonth(), tglRefDt.getDate())) /
          86_400_000,
      );
      // A clinic visit dated after the admission is not its source.
      if (signed > 0 || Math.abs(signed) > tolerance) continue;
      diffDays = signed;
    }

    const linked = await fetchPoliLinkedTransaksi(ctx, client, args.noRm, noRegPoli);
    const linkedTrx = str(linked, 'no_transaksi');
    const linkedReg = str(linked, 'no_registrasikunjungan');
    const detail =
      (await softJson<LegacyRow>(ctx, client, 'poliklinik.getDataKunjungan', {
        txtmedrec_poli: args.noRm,
        no_transaksi: noTransaksiPoli,
        tgl_masuk: rowDate,
        no_registrasikunjungan: noRegPoli,
      })) ?? {};

    const kdParamedisPoli = str(detail, 'kd_paramedis');
    const sourceSep = str(detail, 'no_sjp', 'no_sep');
    const namaUnitPoli = str(detail, 'nama_unit') || str(row, 'nama_unit');
    const unitKey = normalizeTextKey(namaUnitPoli);
    const linkedMatch =
      (Boolean(linkedTrx) && linkedTrx === noTransaksiInap) ||
      (Boolean(linkedReg) && linkedReg === registrasiInap);
    const doctorMatch = Boolean(kdParamedisInap) && kdParamedisPoli === kdParamedisInap;
    const consultMatch = originText.includes('KONSULTASI');
    const unitMatch =
      Boolean(unitKey) && Boolean(originKey) && (originKey.includes(unitKey) || unitKey.includes(originKey));
    const sepMatch = targetSepKeys.size > 0 && Boolean(sourceSep) && targetSepKeys.has(sourceSep);
    const exactDate = rowDate === tglRef;
    const fallbackMatch =
      sepMatch || unitMatch || (consultMatch && doctorMatch) || (doctorMatch && exactDate);
    if (!linkedMatch && !fallbackMatch) continue;

    candidates.push({
      score: [
        linkedMatch ? 1 : 0,
        sepMatch ? 1 : 0,
        unitMatch ? 1 : 0,
        doctorMatch ? 1 : 0,
        consultMatch ? 1 : 0,
        exactDate ? 1 : 0,
        -Math.abs(diffDays),
        rowDate,
      ],
      row: {
        no_transaksi: noTransaksiPoli,
        no_registrasikunjungan: noRegPoli,
        nama_unit: str(row, 'nama_unit'),
        tgl_masuk: rowDate,
        kd_unit: str(detail, 'kd_unit') || str(row, 'kd_unit'),
        kd_paramedis: kdParamedisPoli,
        kd_detkelpenjamin: str(detail, 'kd_detkelpenjamin') || str(linked, 'kd_detkelpenjamin'),
        linked_inap_trx: linkedTrx,
        linked_inap_reg: linkedReg,
        source_sep: sourceSep,
        detail,
      },
    });
  }

  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => compareScoresDesc(a.score, b.score));
  return candidates[0]?.row;
}

/**
 * `_resolve_room_pelaksana` (ranap_v3.py:1918-1981) — find the paramedis account
 * that stands in for a room's own service charges.
 *
 * The unit's paramedis dropdown carries entries named after the ward, usually
 * with a role prefix (`PERAWAT ARAFAH`, `BIDAN VK`, `RUANG ICU`). The legacy
 * script scores every (option, room segment) pair on a ladder and takes the
 * highest, tie-broken by the longer option name.
 *
 * Three details the earlier first-match version dropped, each of which changes
 * the answer:
 *  - a room name with no extractable segment returns `""`, not the normalised
 *    room label — the Python's very first statement (1919-1921);
 *  - most rungs require `has_perawat_signal`, so an arbitrary doctor whose name
 *    merely contains the room segment cannot win outright;
 *  - an empty dropdown for a real `kd_unit` is retried against
 *    `kd_unit="undefined"` (1923-1924), which is where the shared ward accounts
 *    live.
 *
 * The Python returns the option's raw `nama_paramedis`, prefix included.
 */
async function resolveRoomPelaksana(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  namaUnit: string,
  kdUnit: string,
): Promise<string> {
  const segments = extractRoomSegments(namaUnit);
  if (segments.length === 0) return '';

  // `ambil_paramedis_pelaksana` (ranap_v3.py:1907) is a GET with `kd_unit` as a
  // query parameter; `kd_unit or "undefined"` is the Python's own default.
  let options = await fetchParamedisPelaksana(ctx, client, kdUnit || 'undefined');
  if (options.length === 0 && kdUnit && kdUnit !== 'undefined') {
    options = await fetchParamedisPelaksana(ctx, client, 'undefined');
  }
  if (options.length === 0) return '';

  let best: { score: number; length: number; nama: string } | undefined;
  for (const item of options) {
    const namaParamedis = str(item, 'nama_paramedis', 'nama', 'text');
    if (!namaParamedis) continue;
    const namaKey = normalizeTextKey(namaParamedis);
    const strippedKey = normalizeTextKey(stripRoomRolePrefix(namaParamedis));
    const namaCompact = compactTextKey(namaParamedis);
    const jabatanKey = normalizeTextKey(str(item, 'nama_jabatanparamedis'));
    const hasPerawatSignal =
      namaKey.includes('PERAWAT') ||
      jabatanKey.includes('PERAWAT') ||
      namaKey.startsWith('BIDAN ') ||
      namaKey.startsWith('RUANG ');

    for (const segment of segments) {
      const segmentCompact = compactTextKey(segment);
      let score = 0;
      if (hasPerawatSignal && strippedKey === segment) score = 650;
      else if (namaKey === `PERAWAT ${segment}`) score = 640;
      else if (namaKey === `BIDAN ${segment}` || namaKey === `RUANG ${segment}`) score = 630;
      else if (hasPerawatSignal && roomLabelMatchesSegment(namaKey, segment)) score = 575;
      else if (namaKey === segment && hasPerawatSignal) score = 550;
      else if (namaKey === segment) score = 500;
      else if (hasPerawatSignal && namaKey.includes(segment)) score = 450;
      else if (namaKey.includes(segment)) score = 350;
      else if (segmentCompact && namaCompact.includes(segmentCompact) && hasPerawatSignal) score = 325;
      else if (
        segment.length >= 3 &&
        namaKey.length >= 3 &&
        (namaKey.startsWith(segment) || segment.startsWith(namaKey))
      ) {
        score = hasPerawatSignal ? 250 : 150;
      }
      if (!score) continue;
      // `kandidat.sort(key=(score, len(nama_key)), reverse=True)` then `[0]` —
      // a strictly-greater comparison keeps the first of equal candidates, which
      // is what Python's stable sort does.
      if (!best || score > best.score || (score === best.score && namaKey.length > best.length)) {
        best = { score, length: namaKey.length, nama: namaParamedis };
      }
    }
  }
  return best?.nama ?? '';
}

/** `ambil_paramedis_pelaksana` — the dropdown answers with a bare array. */
async function fetchParamedisPelaksana(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  kdUnit: string,
): Promise<LegacyRow[]> {
  return rowsOf(
    await softJson<unknown>(
      ctx,
      client,
      'penatajasaInap.getCmbParamedisPelaksana',
      {},
      { query: { kd_unit: kdUnit } },
    ),
  );
}

// ── planner plumbing (tindakan / visite) ─────────────────────────

/**
 * The four penunjang order histories, read once per run.
 *
 * `main()` builds `group_penunjang_histories` (ranap_v3.py:16203) *before* step 3
 * and hands the same rows to the daily-tindakan sync and to the result
 * validation, so both consumers here share one set of reads.
 */
async function loadPenunjangHistories(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  noRm: string,
): Promise<PenunjangHistories> {
  const cached = getScratch<PenunjangHistories>(ctx, K.penunjangHistories);
  if (cached) return cached;
  // All four page explicitly (ranap_v3.py:5088, 5107, 5135, 5183):
  // `{nomedrec, page, rows}`.
  const historyPayload = historyByMedrecPayload(noRm);
  const histories = collectPenunjangHistories({
    lab: await softJson<unknown>(ctx, client, 'penatajasaInap.getHistoryILab', historyPayload),
    pa: await softJson<unknown>(ctx, client, 'kemoterapi.getHistoryOrderPa', historyPayload),
    rad: await softJson<unknown>(ctx, client, 'poliklinik.getHistoryIrad', historyPayload),
    ok: await softJson<unknown>(ctx, client, 'penatajasaInap.getHistoryIok', historyPayload),
  });
  ctx.scratch[K.penunjangHistories] = histories;
  return histories;
}

/**
 * `_expand_target_dates`' `detail_count_getter` — how many detail lines each
 * penunjang order carries, pre-read because the planner is synchronous.
 *
 * A row with no readable detail counts once, which is the Python's own
 * `max(1, …)` fallback.
 */
async function detailRowCounts(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  endpointId: string,
  rows: readonly LegacyRow[],
): Promise<(row: LegacyRow) => number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const trx = str(row, 'no_transaksi');
    if (!trx || trx in counts) continue;
    // `getdetail_history_orderpa` / `getdetail_historyirad` are GETs keyed
    // `no_trans` (ranap_v3.py:5119, 5175).
    counts[trx] = rowsOf(
      await softJson<unknown>(ctx, client, endpointId, {}, { query: { no_trans: trx } }),
    ).length;
  }
  return (row: LegacyRow) => counts[str(row, 'no_transaksi')] ?? 1;
}

function poliPenunjangDateUpdates(
  rows: readonly LegacyRow[],
  targetDates: readonly string[],
  label: string,
  namePredicate: (upperName: string) => boolean,
): Array<{ row: LegacyRow; targetDate: string; label: string }> {
  if (targetDates.length === 0) return [];
  return sortedRows(rows.filter((row) => !isTransferredRow(row) && namePredicate(upper(row, 'nama_tindakan'))))
    .map((row, index) => ({ row, targetDate: targetDates[Math.min(index, targetDates.length - 1)] ?? '', label }))
    .filter((item) => item.targetDate && datePart(str(item.row, 'tgl_transaksi', 'tgl_jam')) !== item.targetDate);
}

function poliTransferredPenunjangMismatchRows(
  rows: readonly LegacyRow[],
  targetDates: readonly string[],
  namePredicate: (upperName: string) => boolean,
): LegacyRow[] {
  if (targetDates.length === 0) return [];
  return sortedRows(rows.filter((row) => isTransferredRow(row) && namePredicate(upper(row, 'nama_tindakan')))).filter(
    (row, index) => datePart(str(row, 'tgl_transaksi', 'tgl_jam')) !== targetDates[Math.min(index, targetDates.length - 1)],
  );
}

/** `ambil_master_tindakan_inap` / `…_verifikator` — both GETs, same parameters. */
async function fetchMasterTindakan(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  endpointId: string,
  kdUnit: string,
  kdDetkelpenjamin: string,
): Promise<LegacyRow[]> {
  return rowsOf(
    await softJson<unknown>(
      ctx,
      client,
      endpointId,
      {},
      { query: { kd_unit: kdUnit, kd_detkelpenjamin: kdDetkelpenjamin, nama_tindakan: '' } },
    ),
  );
}

/**
 * `getdetail_komponen_transaksi` for every charge row of one transaction,
 * pre-read into the synchronous provider `planTindakanSync` wants.
 *
 * The Python fetches lazily and memoizes in `_DETAIL_KOMPONEN_CACHE`
 * (ranap_v3.py:4222); a planner cannot fetch mid-decision, so the whole
 * transaction is read up front. Rows without both identifiers are skipped —
 * the endpoint keys on `(no_transaksi, kd_tindakan, tgl_jam, urut_tindakan)`.
 */
async function komponenRowsProvider(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  noTransaksi: string,
  rows: readonly LegacyRow[],
): Promise<KomponenRowsProvider> {
  const byKey: Record<string, LegacyRow[]> = {};
  for (const row of rows) {
    const keyed = { ...row, no_transaksi: noTransaksi };
    const cacheKey = komponenDetailKey(keyed);
    if (cacheKey in byKey) continue;
    if (!str(row, 'kd_tindakan') || !str(row, 'urut_tindakan')) continue;
    byKey[cacheKey] = rowsOf(
      await softJson<unknown>(ctx, client, 'penatajasaInap.getDetailKomponenTransaksi', {}, {
        query: {
          no_transaksi: noTransaksi,
          kd_tindakan: str(row, 'kd_tindakan'),
          tgl_jam: str(row, 'tgl_jam', 'tgl_transaksi'),
          urut_tindakan: str(row, 'urut_tindakan'),
        },
      }),
    );
  }
  return (row: LegacyRow) => byKey[komponenDetailKey({ ...row, no_transaksi: noTransaksi })];
}

/**
 * `cekstatusbayar_tindakan` for the rows whose own hints cannot settle it.
 *
 * `_boleh_hapus_tindakan` (ranap_v3.py:12307) only reaches the probe when the
 * row's `status` / `status_bayar` / `nama_jenispembayaran` hints are
 * inconclusive, so only those rows are read — a long stay would otherwise cost
 * one request per charge line.
 */
async function statusProbe(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  endpointId: string,
  noTransaksi: string,
  rows: readonly LegacyRow[],
): Promise<RowStatusProvider> {
  const unpaidBayar = ['0', 'BELUM', 'BELUMBAYAR'];
  const unpaidJenis = ['-', '0', 'BELUM', 'BELUMBAYAR'];
  const byKey: Record<string, string> = {};
  for (const row of rows) {
    const statusHint = String(row['status'] ?? '').trim();
    const statusBayarHint = compactTextKey(row['status_bayar']);
    const jenisBayarHint = compactTextKey(row['nama_jenispembayaran'] ?? row['jenis_bayar']);
    const conclusive =
      ['', '0', 'false', 'False'].includes(statusHint) &&
      (!statusBayarHint || unpaidBayar.includes(statusBayarHint)) &&
      (!jenisBayarHint || unpaidJenis.includes(jenisBayarHint));
    if (conclusive) continue;
    const keyed = { ...row, no_transaksi: noTransaksi };
    const cacheKey = tindakanStatusKey(keyed);
    if (cacheKey in byKey) continue;
    byKey[cacheKey] = await softText(ctx, client, endpointId, {
      no_transaksi: noTransaksi,
      kd_tindakan: str(row, 'kd_tindakan'),
      urut_tindakan: str(row, 'urut_tindakan'),
    });
  }
  return (row: LegacyRow) => byKey[tindakanStatusKey({ ...row, no_transaksi: noTransaksi })];
}

/**
 * `_collect_history_target_rows_by_reference` (ranap_v3.py:1631) — the penunjang
 * orders raised *by* one transaction, reduced to `{no_transaksi, tgl_transaksi}`
 * target rows.
 *
 * It lives here rather than in `logic/` because the reference match needs a
 * detail read per history row; the pure half is two field comparisons.
 */
async function collectHistoryTargetRowsByReference(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  noTransaksiRef: string,
  historyRows: readonly LegacyRow[],
  detailEndpointId: string,
  detailQueryKey: string,
): Promise<LegacyRow[]> {
  const ref = noTransaksiRef.trim();
  if (!ref) return [];
  // `_row_matches_source_reference` (ranap_v3.py:1621) — four spellings.
  const matchesRef = (row: LegacyRow): boolean =>
    ['no_referensi', 'no_transaksipoli', 'no_transaksi_poli', 'no_transaksi_ref'].some(
      (key) => str(row, key) === ref,
    );

  const matched: LegacyRow[] = [];
  const seen = new Set<string>();
  for (const item of sortedRows(historyRows)) {
    const historyTrx = str(item, 'no_transaksi');
    if (!historyTrx || seen.has(historyTrx)) continue;
    seen.add(historyTrx);

    const detailRows = rowsOf(
      await softJson<unknown>(ctx, client, detailEndpointId, {}, { query: { [detailQueryKey]: historyTrx } }),
    );
    const matchingDetails = detailRows.filter((row) => matchesRef(row));
    if (matchingDetails.length === 0 && !matchesRef(item)) continue;

    const datedDetails = matchingDetails
      .map((row) => ({ row, parsed: parseDateTimeFlexible(str(row, 'tgl_transaksi', 'tgl_order', 'tgl_masuk')) }))
      .filter((entry): entry is { row: LegacyRow; parsed: Date } => entry.parsed !== null);
    const earliest = datedDetails.length > 0
      ? datedDetails.reduce((min, entry) => (entry.parsed < min.parsed ? entry : min))
      : undefined;
    const targetDatetime = earliest
      ? resolveTargetDateTimeFromHistoryItem(earliest.row)
      : resolveTargetDateTimeFromHistoryItem(item);
    if (!targetDatetime) continue;
    matched.push({ no_transaksi: historyTrx, tgl_transaksi: targetDatetime });
  }
  return matched.sort(
    (a, b) =>
      (parseDateTimeFlexible(str(a, 'tgl_transaksi'))?.getTime() ?? Number.MAX_SAFE_INTEGER) -
      (parseDateTimeFlexible(str(b, 'tgl_transaksi'))?.getTime() ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * `get_evo_v1_cppt_rows` (ranap_v3.py:3130) — the CPPT notes the visite repair
 * uses as its doctor/date oracle, paged five deep as the Python pages them.
 *
 * v2 (`api/ringkasan_pasien/loadTglMasuk` → `api_inap/cppt/cppt_riwayat`) is the
 * fallback and lives in {@link fetchCpptV2Rows}; it is only issued when the
 * deployment really has a v2 base URL.
 */
async function fetchCpptV1Rows(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  noRm: string,
  reg: string,
): Promise<LegacyRow[]> {
  if (!noRm || !reg) return [];
  const single = await getRmeSingleInfo(ctx, client, reg);
  const singleId = str(single, 'single_id');
  if (!singleId) return [];
  await softJson<unknown>(ctx, client, 'rme.loadCpptAwal', {
    No_Reg: reg,
    txtsingle_inap: singleId,
  });

  const rows: LegacyRow[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 5; page += 1) {
    const pageRows = rowsOf(
      await softJson<unknown>(ctx, client, 'rme.loadCpptSoap', {
        jns_user: '',
        No_MedicalRecord: noRm,
        No_Reg: reg,
        txtsingle_inap: singleId,
        page: String(page),
        rows: '100',
      }),
    );
    if (pageRows.length === 0) break;
    for (const row of pageRows) {
      const key = [str(row, 'id_soapi'), str(row, 'tgl_entry'), str(row, 'nama_paramedis')].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    if (pageRows.length < 100) break;
  }
  return rows;
}

/**
 * File a planner's issues on the run's alert registry.
 *
 * Only `ERROR` becomes a **sync issue**: `_has_sync_issues` is what stops a
 * registration's verification and its payment (ranap_v3.py:16789, 16846), and an
 * INFO like "metadata tindakan tidak ditemukan" must not do that. Everything is
 * recorded as a reg alert at its own level, which `preverify_summary` prints.
 */
function registerPlannerIssues(
  alerts: RunAlerts,
  reg: string,
  phase: string,
  issues: readonly (TindakanSyncIssue | VisiteIssue)[],
): number {
  for (const issue of issues) {
    alerts.registerRegAlert(reg, issue.level, issue.message);
    if (issue.level === 'ERROR') alerts.registerSyncIssue(reg, phase, issue.message);
  }
  return issues.length;
}

// ── `_tampung_pelaksana_checked` (ranap_v3.py:4440) across re-plan passes ──

/** The four fields that identify one performer write, for the pass bookkeeping. */
interface PelaksanaLine {
  noTransaksi: string;
  kdTindakan: string;
  urutTindakan: string;
  kdKomponen: string;
}

/** `` `${node}|${trx}|${kd}|${urut}|${komponen}` `` — stable across passes. */
function pelaksanaLineKey(node: string, line: PelaksanaLine): string {
  return [node, line.noTransaksi, line.kdTindakan, line.urutTindakan, line.kdKomponen].join('|');
}

/**
 * `_is_pelaksana_already_correct` (ranap_v3.py:4377), expressed as the plan's
 * read-after-write rule.
 *
 * The legacy writes the performer and *immediately re-reads the component* —
 * `ok = raw_success or confirmed` (4507) — because this endpoint answers a
 * failed write with a 200 and an error notice. That re-read is what the
 * mutation gate's `readAfterWriteChecks` already does, so declaring it here
 * moves the confirmation into the audited path and, crucially, turns "the value
 * did not stick" into a `mutation.failed` outcome a later pass can react to.
 * Without a rule the gate leaves the plan at `applied` — written, unconfirmed —
 * and the retry ladder would have nothing to trigger on.
 *
 * Clears are verified too. A "clear the performer" write (`pelaksana === ''`,
 * the DPJB and oksigen sweeps) expects `nama_paramedis` to be *empty*, and the
 * comparator treats a field read off rows as empty when **every** selected row
 * is blank (`expectations.ts`, `case 'empty'`: `target.every(isEmptyish)`).
 *
 *  - When `kd_komponen` is known the rule is scoped with
 *    `where: { kd_komponen }`, so only the component this plan wrote is read
 *    back and only that row has to come back blank.
 *  - When it is unknown every component of the line is in scope, so an
 *    unrelated component that still carries a performer makes the check fail.
 *    That is fail-closed: the plan surfaces for operator review rather than
 *    passing as a false positive.
 *
 * The only case with no rule is a row this pass cannot address
 * (`urut_tindakan` unknown), which the gate refuses outright anyway.
 *
 * The legacy escalation cannot fire for a clear either way:
 * `_pick_intermediate_paramedis_name` excludes the current name, and the
 * DATABASE ERROR it works around is a *swap*.
 */
export function pelaksanaReadBackRule(op: {
  noTransaksi: string;
  kdTindakan: string;
  tglJam: string;
  urutTindakan: string;
  kdKomponen?: string;
  pelaksana: string;
}): VerificationRule[] {
  if (!op.urutTindakan) return [];
  return [
    {
      description: op.pelaksana
        ? `Pelaksana terbaca kembali sebagai "${op.pelaksana}"`
        : 'Pelaksana terbaca kembali kosong',
      endpointId: 'penatajasaInap.getDetailKomponenTransaksi',
      // One row per tariff component; read back the component this plan wrote.
      ...(op.kdKomponen ? { where: { kd_komponen: op.kdKomponen } } : {}),
      field: 'nama_paramedis',
      expected: op.pelaksana,
      match: op.pelaksana ? 'equals' : 'empty',
      // ranap_v3.py:4232: query params on a POST with no body; a form body answers
      // "Database Error". The empty payload stops the gate falling back to the write body.
      payload: {},
      query: {
        no_transaksi: op.noTransaksi,
        kd_tindakan: op.kdTindakan,
        tgl_jam: op.tglJam,
        urut_tindakan: op.urutTindakan,
      },
    },
  ];
}

function tindakanDateReadBackRules(op: TindakanOp): VerificationRule[] {
  const kdTindakan = op.kdTindakan ?? '';
  const urutTindakan = op.urutTindakan ?? '';
  const targetDate = op.targetDate || datePart(op.targetDatetime ?? '');
  if (!kdTindakan || !urutTindakan || !targetDate) return [];
  const kdKamar = op.kdKamar ?? str(op.row, 'kd_kamarperawatan');
  return [
    {
      description: `Tanggal tindakan ${kdTindakan}#${urutTindakan} terbaca ${targetDate}`,
      endpointId: 'penatajasaInap.getListTindakan',
      where: { kd_tindakan: kdTindakan, urut_tindakan: urutTindakan },
      // Live list answers tgl_transaksi as "12 Oct 2026 13:47:54"; tgl_jam is ISO.
      field: 'tgl_jam',
      expected: targetDate,
      match: 'contains',
      payload: {
        no_transaksi: op.noTransaksi,
        no_registrasikunjungan: op.noRegistrasikunjungan,
        ...(kdKamar ? { kd_kamarperawatan: kdKamar } : {}),
        page: '1',
        rows: '999',
      },
    },
  ];
}

/**
 * Did the previous pass's performer write fail in the way the legacy escalates
 * on?
 *
 * `_tampung_pelaksana_checked` climbs the ladder only when the write neither
 * succeeded nor read back **and** `"DATABASE ERROR"` appears in the response
 * (ranap_v3.py:4516-4522). The mutation gate does not hand the raw body back —
 * `looksLikeBackendError` collapses a "Database Error" page into
 * `"write answered with a backend error page"` before the outcome is recorded —
 * so the discriminator here is that reason, the literal phrase when it does
 * survive, or a `verify`-phase failure, which is exactly the legacy's *other*
 * trigger: `raw_success` was true but the read-back disagreed.
 *
 * A failure at the `precondition` phase is **not** escalated: nothing was
 * written, so an intermediate performer would not clear anything.
 */
function pelaksanaWriteDidNotStick(outcome: { status: string; phase?: string; reason?: string } | undefined): boolean {
  if (outcome?.status !== 'failed') return false;
  if (outcome.phase === 'verify') return true;
  const reason = (outcome.reason ?? '').toLowerCase();
  return reason.includes('database error') || reason.includes('backend error page');
}

/** One rung of the ladder: the performer to write, and how to label it. */
interface PelaksanaRung {
  pelaksana: string;
  /**
   * `desired` is the write whose outcome the next pass reacts to; the
   * `intermediate` rung is the throwaway one and is never remembered — the
   * legacy escalates on the write that was supposed to land, not on the parking
   * spot (`allow_intermediate_retry=False`, ranap_v3.py:4546).
   */
  role: 'desired' | 'intermediate';
  /** Appended to the plan's `reason` so the audit trail shows the escalation. */
  note: string;
}

/**
 * `_tampung_pelaksana_checked`'s retry ladder (ranap_v3.py:4440-4597), expressed
 * as plans instead of as nested calls.
 *
 * Ordinarily one rung: write the desired performer, snapped to the dropdown's
 * own spelling by `_resolve_exact_paramedis_name` (4460) — the backend matches
 * `Kd_ParaMedis` on the display name, so an unsnapped name silently writes
 * nothing.
 *
 * When the previous pass's plan for this same line came back `failed`, two:
 * park the row on an intermediate paramedic first, then write the desired one
 * (4524-4581). That is the documented workaround for the backend's DATABASE
 * ERROR on a direct swap. `excludeNames` is the legacy's own list — the current
 * performer, both spellings of the desired one, and the empty string — so the
 * intermediate is never a no-op.
 *
 * The ceiling is the legacy's: `allow_intermediate_retry=False` on both inner
 * calls means the ladder is climbed **once per line per run**, never
 * recursively. `K.pelaksanaEscalated` is that flag.
 */
function pelaksanaLadder(
  ctx: ExecutorContext,
  node: string,
  args: {
    line: PelaksanaLine;
    desired: string;
    currentName: string;
    paramedisOptions: readonly LegacyRow[];
  },
): PelaksanaRung[] {
  const desired = resolveExactParamedisName(args.desired, args.paramedisOptions);
  const plain: PelaksanaRung[] = [{ pelaksana: desired, role: 'desired', note: '' }];
  if (!desired) return plain;

  const key = pelaksanaLineKey(node, args.line);
  const escalated = scratchSet(ctx, K.pelaksanaEscalated);
  if (escalated.has(key)) return plain;

  const previousId = scratchRecord<string>(ctx, K.pelaksanaPlanByLine)[key];
  if (!previousId) return plain;
  if (!pelaksanaWriteDidNotStick(ctx.mutations[previousId])) return plain;

  const temp = pickIntermediateParamedisName(args.paramedisOptions, [
    args.currentName,
    desired,
    args.desired,
    '',
  ]);
  // `if not temp_name: return base_result` (ranap_v3.py:4528) — with no other
  // account to park the row on there is no workaround, only the same write.
  if (!temp) return plain;

  escalated.add(key);
  const reason = ctx.mutations[previousId]?.reason ?? 'write pelaksana gagal';
  return [
    {
      pelaksana: temp,
      role: 'intermediate',
      note: `retry pelaksana sementara (workaround DATABASE ERROR: ${reason})`,
    },
    {
      pelaksana: desired,
      role: 'desired',
      note: 'retry update pelaksana final setelah pelaksana sementara',
    },
  ];
}

/**
 * One `MutationPlan` per {@link TindakanOp}, with the write body the legacy
 * function posts and the guards that really protect it.
 *
 * Every op kind maps to exactly one endpoint and one body, so none of these
 * plans is review-only.
 *
 * `pelaksanaOverride` is set by {@link pelaksanaLadder} when the same line is
 * being written twice in one pass (intermediate, then desired); it replaces the
 * op's performer without disturbing the op the planner produced.
 */
function tindakanOpPlan(
  ctx: ExecutorContext,
  node: string,
  index: number,
  op: TindakanOp,
  pelaksanaOverride?: PelaksanaRung,
): MutationPlan {
  const line: TindakanLineKey = {
    no_transaksi: op.noTransaksi,
    kd_tindakan: op.kdTindakan ?? '',
    urut_tindakan: op.urutTindakan ?? '',
  };
  const base = {
    node,
    index,
    trx: op.noTransaksi,
    // Operator-facing: the internal phase id stays in payloadSummary.phase for audit.
    reason: op.reason,
  } as const;
  const summary = {
    kind: op.kind,
    phase: op.phase,
    urut_tindakan: op.urutTindakan ?? '',
    ...(op.actionKey ? { action: op.actionKey } : {}),
    ...(op.targetDate ? { tanggal: op.targetDate } : {}),
    ...(op.batchKey ? { batch: op.batchKey } : {}),
  };

  if (op.kind === 'updateTgl' || op.kind === 'rebalance') {
    return mutationPlan(ctx, {
      ...base,
      endpointId: TINDAKAN_SYNC_ENDPOINTS.updateTgl,
      riskLevel: 'high',
      preconditions: [
        PRECONDITION.tindakanBelumTerverifikasi(line),
        PRECONDITION.tindakanBelumDibayar(line),
      ],
      payload: updateTglInapPayload({
        noTransaksi: op.noTransaksi,
        kdTindakan: op.kdTindakan ?? '',
        tglJam: op.tglJam ?? '',
        urutTindakan: op.urutTindakan ?? '',
        targetDatetime: op.targetDatetime ?? '',
      }),
      payloadSummary: { ...summary, target: op.targetDatetime ?? '' },
      readAfterWriteChecks: tindakanDateReadBackRules(op),
    });
  }

  if (op.kind === 'hapus') {
    return mutationPlan(ctx, {
      ...base,
      endpointId: TINDAKAN_SYNC_ENDPOINTS.hapus,
      riskLevel: 'high',
      preconditions: [
        PRECONDITION.tindakanBelumTerverifikasi(line),
        PRECONDITION.tindakanBelumDibayar(line),
      ],
      payload: hapusTindakanPayload({
        noTransaksi: op.noTransaksi,
        kdTindakan: op.kdTindakan ?? '',
        tglJam: op.tglJam ?? '',
        urutTindakan: op.urutTindakan ?? '',
      }),
      payloadSummary: { ...summary, tindakan: str(op.row, 'nama_tindakan') },
    });
  }

  if (op.kind === 'tambah') {
    const args: TambahTindakanArgs = {
      noTransaksi: op.noTransaksi,
      kdParamedis: op.kdParamedis ?? '',
      kdDetkelpenjamin: op.kdDetkelpenjamin ?? '15',
      kdTindakan: op.kdTindakan ?? '',
      kdUnit: op.kdUnit ?? '',
      harga: op.harga ?? '',
      kdKamar: op.kdKamar ?? '',
    };
    const viaVerifikator = op.endpointId === TINDAKAN_SYNC_ENDPOINTS.tambahVerifikator;
    return mutationPlan(ctx, {
      ...base,
      endpointId: op.endpointId,
      riskLevel: 'high',
      preconditions: [PRECONDITION.transaksiBelumTerverifikasi(op.noTransaksi)],
      payload: viaVerifikator
        ? tambahTindakanVerifikatorPayload(args)
        : tambahTindakanPolisPayload(args),
      payloadSummary: { ...summary, tindakan: op.namaTindakan ?? '', harga: op.harga ?? '' },
    });
  }

  // `setPelaksana`.
  const pelaksana = pelaksanaOverride?.pelaksana ?? op.pelaksana ?? '';
  const readBack = pelaksanaReadBackRule({
    noTransaksi: op.noTransaksi,
    kdTindakan: op.kdTindakan ?? '',
    tglJam: op.tglJam || str(op.row, 'tgl_jam', 'tgl_transaksi'),
    urutTindakan: op.urutTindakan ?? '',
    ...(op.kdKomponen ? { kdKomponen: op.kdKomponen } : {}),
    pelaksana,
  });
  const plan = mutationPlan(ctx, {
    ...base,
    reason: pelaksanaOverride?.note ? `${base.reason} — ${pelaksanaOverride.note}` : base.reason,
    endpointId: TINDAKAN_SYNC_ENDPOINTS.tampungPelaksana,
    riskLevel: 'medium',
    // `_tampung_pelaksana_checked` gates on the line's own verification only
    // (`_ensure_tindakan_belum_terverifikasi_for_write`, ranap_v3.py:4460); it
    // never reads the payment status.
    preconditions: [PRECONDITION.tindakanBelumTerverifikasi(line)],
    payload: tampungPelaksanaPayload({
      noTransaksi: op.noTransaksi,
      pelaksana,
      kdTindakan: op.kdTindakan ?? '',
      harga: op.harga ?? '',
      kdKomponen: op.kdKomponen ?? '',
      urutTindakan: op.urutTindakan ?? '',
      ...(op.hargaPersen ? { hargaPersen: op.hargaPersen } : {}),
      ...(op.diskon !== undefined ? { diskon: op.diskon } : {}),
      ...(op.nilai !== undefined ? { nilai: op.nilai } : {}),
    }),
    payloadSummary: {
      ...summary,
      pelaksana: pelaksana || '<kosong>',
      komponen: op.kdKomponen ?? '',
      ...(pelaksanaOverride?.note ? { retry: pelaksanaOverride.note } : {}),
    },
    ...(readBack.length > 0 ? { readAfterWriteChecks: readBack } : {}),
  });
  // Only the *desired* write is remembered: a later pass escalates on the write
  // that was supposed to land, not on the throwaway intermediate one.
  if ((pelaksanaOverride?.role ?? 'desired') === 'desired') {
    recordPelaksanaPlan(
      ctx,
      node,
      {
        noTransaksi: op.noTransaksi,
        kdTindakan: op.kdTindakan ?? '',
        urutTindakan: op.urutTindakan ?? '',
        kdKomponen: op.kdKomponen ?? '',
      },
      plan.id,
    );
  }
  return plan;
}

/**
 * Remember which plan carries which line's performer write, so the next pass
 * can look its outcome up in `ctx.mutations`.
 *
 * Recorded per pass and overwritten, because the ladder only ever reacts to the
 * *most recent* attempt — the same rule as the legacy's single `hasil` variable.
 */
function recordPelaksanaPlan(
  ctx: ExecutorContext,
  node: string,
  line: PelaksanaLine,
  planId: string,
): void {
  scratchRecord<string>(ctx, K.pelaksanaPlanByLine)[pelaksanaLineKey(node, line)] = planId;
}

/**
 * One `MutationPlan` per {@link VisiteOp}.
 *
 * The two follow-ups of an add (`updateTgl` and `setPelaksana` carrying
 * `dependsOnSequence`) target a row the backend has not created yet, so their
 * `urut_tindakan` is unknown and **no payload can be built**. Those plans are
 * emitted without one on purpose: the gate refuses a payload-less plan, which is
 * the safe outcome for the pass that proposed it. The step reports
 * `needsReplan`, so on a write run the engine waits for the add to settle and
 * calls the executor again — and the pass that follows re-reads the charge
 * lines, names the created row, and emits the same follow-up with a payload.
 *
 * `pelaksanaOverride` carries a rung of {@link pelaksanaLadder}: the specialist
 * repair posts to the same `tampung_pelaksana_tindakan` the daily sweep does, so
 * it inherits the same DATABASE ERROR workaround.
 */
function visiteOpPlan(
  ctx: ExecutorContext,
  node: string,
  index: number,
  op: VisiteOp,
  pelaksanaOverride?: PelaksanaRung,
): MutationPlan {
  const line: TindakanLineKey = {
    no_transaksi: op.noTransaksi,
    kd_tindakan: op.kdTindakan ?? '',
    urut_tindakan: op.urutTindakan ?? '',
  };
  const base = {
    node,
    index,
    trx: op.noTransaksi,
    reason: op.reason,
  } as const;
  const summary = {
    kind: op.kind,
    no_registrasikunjungan: op.noRegistrasikunjungan,
    urut_tindakan: op.urutTindakan ?? '',
    ...(op.dependsOnSequence ? { depends_on_op: op.dependsOnSequence } : {}),
  };

  if (op.kind === 'hapus') {
    return mutationPlan(ctx, {
      ...base,
      endpointId: op.endpointId,
      riskLevel: 'high',
      preconditions: [
        PRECONDITION.tindakanBelumTerverifikasi(line),
        PRECONDITION.tindakanBelumDibayar(line),
      ],
      payload: hapusTindakanPayload({
        noTransaksi: op.noTransaksi,
        kdTindakan: op.kdTindakan ?? '',
        tglJam: op.tglJam ?? '',
        urutTindakan: op.urutTindakan ?? '',
      }),
      payloadSummary: { ...summary, tindakan: str(op.row, 'nama_tindakan') },
    });
  }

  if (op.kind === 'tambah' || op.kind === 'repairTarif' || op.kind === 'relocateRoom') {
    const harga = op.correctedHargaRaw || String(op.correctedHarga ?? '');
    return mutationPlan(ctx, {
      ...base,
      endpointId: op.endpointId,
      riskLevel: 'high',
      preconditions: [PRECONDITION.transaksiBelumTerverifikasi(op.noTransaksi)],
      payload: tambahTindakanPolisPayload({
        noTransaksi: op.noTransaksi,
        kdParamedis: op.kdParamedis ?? '',
        kdDetkelpenjamin: op.kdDetkelpenjamin ?? '15',
        kdTindakan: op.kdTindakan ?? '',
        kdUnit: op.kdUnit ?? '',
        harga,
        kdKamar: op.kdKamarperawatan ?? '',
      }),
      payloadSummary: { ...summary, tindakan: op.correctedNamaTindakan ?? '', harga },
    });
  }

  if (op.kind === 'updateTgl') {
    const addressable = Boolean(op.kdTindakan && op.urutTindakan);
    return mutationPlan(ctx, {
      ...base,
      endpointId: op.endpointId,
      riskLevel: 'high',
      preconditions: addressable ? [PRECONDITION.tindakanBelumTerverifikasi(line)] : [],
      // No payload when the row this re-dates was created by an earlier op in
      // the same plan — the backend assigns `urut_tindakan`, so
      // `update_tgl_tindakan_inap` has nothing to address. The gate refuses such
      // a plan (fail closed), which is the correct outcome for *this* pass:
      // `sync_visite` reports `needsReplan`, the engine waits for the add to
      // settle, and the next pass re-reads `get_listtindakan` and re-plans the
      // follow-up against a row that now has a name.
      ...(addressable
        ? {
            payload: updateTglInapPayload({
              noTransaksi: op.noTransaksi,
              kdTindakan: op.kdTindakan ?? '',
              tglJam: op.tglJam ?? '',
              urutTindakan: op.urutTindakan ?? '',
              targetDatetime: op.targetDatetime ?? '',
            }),
          }
        : {}),
      payloadSummary: { ...summary, target: op.targetDatetime ?? '' },
    });
  }

  // `setPelaksana`.
  const addressable = Boolean(op.urutTindakan);
  const pelaksana = pelaksanaOverride?.pelaksana ?? op.pelaksana ?? '';
  const readBack = addressable
    ? pelaksanaReadBackRule({
        noTransaksi: op.noTransaksi,
        kdTindakan: op.kdTindakan ?? '',
        // `_detail_komponen_cache_key` (ranap_v3.py:4251) keys on `tgl_jam`, and
        // `setPelaksanaOnRow` does not carry one on the op — the row it targets
        // does. An empty one would under-address the confirming read.
        tglJam: op.tglJam || str(op.row, 'tgl_jam', 'tgl_transaksi'),
        urutTindakan: op.urutTindakan ?? '',
        ...(op.kdKomponen ? { kdKomponen: op.kdKomponen } : {}),
        pelaksana,
      })
    : [];
  const plan = mutationPlan(ctx, {
    ...base,
    reason: pelaksanaOverride?.note ? `${base.reason} — ${pelaksanaOverride.note}` : base.reason,
    endpointId: op.endpointId,
    riskLevel: 'medium',
    preconditions: addressable ? [PRECONDITION.tindakanBelumTerverifikasi(line)] : [],
    // Same reason as the `updateTgl` follow-up above — a row that only exists in
    // the plan cannot be addressed by `urut_tindakan` yet, and the re-plan pass
    // is what turns it into an executable plan.
    ...(addressable
      ? {
          payload: tampungPelaksanaPayload({
            noTransaksi: op.noTransaksi,
            pelaksana,
            kdTindakan: op.kdTindakan ?? '',
            harga: str(op.row, 'harga') || op.correctedHargaRaw || '',
            kdKomponen: op.kdKomponen ?? '',
            urutTindakan: op.urutTindakan ?? '',
          }),
        }
      : {}),
    payloadSummary: {
      ...summary,
      pelaksana: pelaksana || '<kosong>',
      komponen: op.kdKomponen ?? '',
      ...(pelaksanaOverride?.note ? { retry: pelaksanaOverride.note } : {}),
    },
    ...(readBack.length > 0 ? { readAfterWriteChecks: readBack } : {}),
  });
  if (addressable && (pelaksanaOverride?.role ?? 'desired') === 'desired') {
    recordPelaksanaPlan(
      ctx,
      node,
      {
        noTransaksi: op.noTransaksi,
        kdTindakan: op.kdTindakan ?? '',
        urutTindakan: op.urutTindakan ?? '',
        kdKomponen: op.kdKomponen ?? '',
      },
      plan.id,
    );
  }
  return plan;
}

// ── `_ensure_tindakan_belum_terverifikasi`'s escalation (ranap_v3.py:12296) ──

/**
 * A charge line the planner refused *because it is verified*, and therefore a
 * candidate for `batal_verifikasi`.
 *
 * The legacy test is two-stage and both stages matter
 * (`_ensure_tindakan_belum_terverifikasi`, ranap_v3.py:12287-12295): the row's
 * own `status_verifikasi` hint must be outside `("", "0", "false", "False")`,
 * **and** `cekstatus_verifikasi_tindakan` must agree. A hint alone is not enough
 * — the Python re-reads before it reopens a bill, and so does this.
 *
 * Rows refused for any *other* reason are not candidates: a paid line, a
 * protected charge name or a `flag` are not something un-verifying would fix,
 * and reopening a bill to no purpose is exactly the write this must not propose.
 */
interface VerifiedBlockedLine {
  row: LegacyRow;
  reason: string;
  line: TindakanLineKey;
}

/**
 * `rowAllowsDeleteByHint` refuses on four different signals; only the
 * verification one is reversible. This isolates it: the row must be verified
 * *and* must not also be blocked by payment or by the protected-charge list,
 * because `batal_verifikasi` would leave those refusals exactly as they were.
 */
function looksVerifiedButOtherwiseEditable(row: LegacyRow): boolean {
  const hint = String(row['status_verifikasi'] ?? '').trim();
  if (['', '0', 'false', 'False'].includes(hint)) return false;
  // Everything except the verification hint must already allow the edit.
  return rowAllowsDeleteByHint({ ...row, status_verifikasi: '0' });
}

/**
 * The second stage: `cekstatus_verifikasi_tindakan(no_transaksi, kd_tindakan,
 * urut_tindakan)` must also report the line as verified (ranap_v3.py:12292).
 *
 * The probe is issued **only** for rows that already passed the hint test, so an
 * ordinary run adds no reads at all. A read that fails yields `''`, which reads
 * as "not verified" and therefore proposes nothing — a failed read must never
 * become the justification for reopening a bill.
 */
async function collectVerifiedBlockedLines(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  candidates: readonly { row: LegacyRow; reason: string; noTransaksi: string }[],
): Promise<VerifiedBlockedLine[]> {
  const blocked: VerifiedBlockedLine[] = [];
  for (const candidate of candidates) {
    const line: TindakanLineKey = {
      no_transaksi: candidate.noTransaksi,
      kd_tindakan: str(candidate.row, 'kd_tindakan'),
      urut_tindakan: str(candidate.row, 'urut_tindakan'),
    };
    if (!line.no_transaksi || !line.urut_tindakan) continue;
    const probed = (await softText(ctx, client, 'penatajasaInap.cekStatusVerifikasi', { ...line })).trim();
    if (['', '0', 'false', 'False'].includes(probed)) continue;
    blocked.push({ row: candidate.row, reason: candidate.reason, line });
  }
  return blocked;
}

/**
 * `batal_verifikasi(no_registrasikunjungan)` (ranap_v3.py:3493) as an approvable
 * plan — the escalation `_ensure_tindakan_belum_terverifikasi` performs inline.
 *
 * Reopening a closed bill has the blast radius the endpoint registry says it
 * has, so it is `critical`: two distinct operators must approve it, exactly as
 * for the verification it reverses. Making it a plan rather than a silent side
 * effect is what keeps safety control #4 intact — the operator sees *which*
 * lines it unblocks before it fires, and the audit trail records it.
 *
 * One plan per registration, because that is the endpoint's granularity: the
 * Python passes only `no_registrasikunjungan` and it un-verifies the whole
 * registration, however many lines needed it.
 *
 * The guard and the confirmation are the Python's own two reads, in order:
 * the line must still read as verified before (12292), and must read back as
 * *not* verified after (12303-12305). Both address one representative line —
 * the same triple `cekstatus_verifikasi_tindakan` takes.
 */
function batalVerifikasiPlan(
  ctx: ExecutorContext,
  node: string,
  index: number,
  reg: string,
  blocked: readonly VerifiedBlockedLine[],
): MutationPlan | undefined {
  const probe = blocked[0]?.line;
  if (!reg || !probe) return undefined;
  return mutationPlan(ctx, {
    node,
    index,
    endpointId: 'verifikator.batalVerifikasi',
    riskLevel: 'critical',
    reason:
      `Batal verifikasi registrasi ${reg} agar ${blocked.length} baris tindakan yang sudah ` +
      `terverifikasi bisa diperbaiki (${blocked[0]?.reason ?? '-'})`,
    trx: probe.no_transaksi,
    preconditions: [PRECONDITION.tindakanMasihTerverifikasi(probe)],
    payload: { no_registrasikunjungan: reg },
    payloadSummary: {
      no_registrasikunjungan: reg,
      baris: blocked.length,
      tindakan: blocked.map((item) => str(item.row, 'nama_tindakan')).filter(Boolean),
    },
    readAfterWriteChecks: [
      {
        description: 'Baris tindakan tidak lagi terverifikasi',
        endpointId: 'penatajasaInap.cekStatusVerifikasi',
        // `readField` returns the whole body for an empty path, and this
        // endpoint answers with a bare string.
        field: '',
        expected: '0',
        match: 'empty',
        payload: { ...probe },
      },
    ],
  });
}

/**
 * Turn "these registrations have verified rows the planner had to refuse" into
 * at most one `verifikator.batalVerifikasi` plan each, logging the escalation
 * the way `_log_sync_detail_block("Batal verifikasi sebelum …")` logs it
 * (ranap_v3.py:12297).
 *
 * A registration already carrying a plan from an earlier pass is skipped:
 * `batal_verifikasi` is idempotent in effect but not in audit weight, and the
 * pass that follows re-reads the rows to see whether it worked.
 */
/**
 * The second pass of `execute_verifikasi`: read what actually happened.
 *
 * `proses_verifikasi_inap` writes once and then calls `_confirm_verifikasi_state`
 * (ranap_v3.py:15371), returning `True` only when the response was OK, the
 * cashier status reads `"1"` and no blocker reappeared. The mutation gate has
 * already replayed exactly that conjunction as the plan's read-after-write
 * rules, so this pass has nothing left to write — it reports.
 *
 * No verification is ever re-proposed here. The legacy does not retry
 * `simpan_verifikasi` either: a failed confirmation is reported and the
 * registration is left for a human.
 */
function observeVerifikasi(
  ctx: ExecutorContext,
  regs: readonly string[],
  planByReg: Readonly<Record<string, string>>,
): StepResult {
  const proposed = regs.filter((reg) => planByReg[reg] !== undefined);
  const statusOf = (reg: string): string => ctx.mutations[planByReg[reg] as string]?.status ?? 'planned';
  const verified = proposed.filter((reg) => statusOf(reg) === 'verified');
  const unconfirmed = proposed.filter((reg) => statusOf(reg) !== 'verified');
  const detail = unconfirmed.map((reg) => `${reg}: ${statusOf(reg)}`);

  for (const reg of unconfirmed) {
    // `_log_sync_detail_block("Verifikasi gagal", …)` (ranap_v3.py:15540) — the
    // registration keeps a sync issue so `tampung_bayar` refuses it too.
    alertsOf(ctx).registerRegAlert(
      reg,
      'ERROR',
      `Verifikasi rawat inap belum terkonfirmasi | status=${statusOf(reg)}`,
    );
  }
  emit(
    ctx,
    dataBlock(
      [
        { label: 'Terkonfirmasi', value: `${verified.length}/${proposed.length}` },
        { label: 'Belum terkonfirmasi', value: detail.join('; ') },
        { label: 'Pass', value: `${ctx.pass}/${ctx.maxPasses}`, debugOnly: true },
      ],
      { bullet: '+ Hasil verifikasi rawat inap:', debug: isDebug(ctx) },
    ),
    unconfirmed.length > 0 ? 'warn' : 'info',
  );

  if (unconfirmed.length === 0) {
    return ok(`Verifikasi terkonfirmasi untuk ${verified.length} grup rawat inap${passSuffix(ctx)}`);
  }
  return review(
    `Verifikasi terkonfirmasi untuk ${verified.length}/${proposed.length} grup rawat inap — ` +
      `${detail.join(' | ')}${passSuffix(ctx)}`,
    {
      warnings: [warning('verifikasi_unconfirmed', detail.join(' | '), 'error')],
    },
  );
}

async function planBatalVerifikasi(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  node: string,
  candidatesByReg: Readonly<Record<string, ReadonlyArray<{ row: LegacyRow; reason: string; noTransaksi: string }>>>,
  firstIndex: number,
): Promise<MutationPlan[]> {
  const already = scratchSet(ctx, K.batalVerifikasiByReg);
  const plans: MutationPlan[] = [];
  for (const [reg, candidates] of Object.entries(candidatesByReg)) {
    if (candidates.length === 0 || already.has(`${node}|${reg}`)) continue;
    const blocked = await collectVerifiedBlockedLines(ctx, client, candidates);
    if (blocked.length === 0) continue;
    const plan = batalVerifikasiPlan(ctx, node, firstIndex + plans.length, reg, blocked);
    if (!plan) continue;
    already.add(`${node}|${reg}`);
    plans.push(plan);
    emit(
      ctx,
      dataBlock(
        [
          { label: 'Baris', value: blocked.length },
          {
            label: 'Tindakan',
            value: blocked.map((item) => str(item.row, 'nama_tindakan') || '-').join(', '),
          },
          { label: 'Alasan', value: 'status verifikasi masih aktif, perbaikan baris ditahan' },
          { label: 'Reg', value: reg, debugOnly: true },
        ],
        { bullet: '+ Batal verifikasi sebelum perbaikan tindakan:', debug: isDebug(ctx) },
      ),
      'warn',
    );
  }
  return plans;
}

function giziEndpointFor(action: 'kirim' | 'batalKirim' | 'hapusDetail'): string {
  switch (action) {
    case 'kirim':
      return 'penatajasaInap.kirimOrderGizi';
    case 'batalKirim':
      return 'penatajasaInap.batalKirimOrderGizi';
    case 'hapusDetail':
      return 'penatajasaInap.hapusDetailOrderGizi';
  }
}

/**
 * The read-before-write guard for one gizi recovery action.
 *
 * A diet order is an `18-…` transaction of its own: neither
 * `kasir.cekstatus_verifikasi` nor `gethistory_pembayaran` says anything about
 * it. What the Python checks is the order's own schedule before sending
 * (`cek_jadwal_gizi` must be `""`/`"1"`, ranap_v3.py:15167) and the order detail
 * still having rows before recalling or deleting one (ranap_v3.py:15232).
 */
function giziPreconditionsFor(
  action: 'kirim' | 'batalKirim' | 'hapusDetail',
  orderTrx: string,
  noRm: string,
): readonly Precondition[] {
  if (action === 'kirim') return [PRECONDITION.giziJadwalTersedia(orderTrx)];
  return [PRECONDITION.giziDetailMasihAda(orderTrx, noRm)];
}

/** `_get_history_obat_entries`'s page bound (ranap_v3.py:5833: `max_pages=10`). */
const HISTORY_OBAT_MAX_PAGES = 10;

/** `_get_history_obat_entries`'s page size (ranap_v3.py:5833: `rows=100`). */
const HISTORY_OBAT_ROWS_PER_PAGE = 100;

/**
 * `gethistoryobat_inap` (ranap_v3.py:5657), paged as `_get_history_obat_entries`
 * pages it (ranap_v3.py:5833).
 *
 * The endpoint is deliberately asymmetric and the legacy call is not a mistake:
 * `nomedrec` is appended to the URL while `{page, rows}` go in the POST body.
 * Sending all three in the query returns page 1 of the grid default; sending all
 * three in the body returns every patient's orders.
 *
 * Paging stops at the first empty or short page, or after
 * {@link HISTORY_OBAT_MAX_PAGES} pages — the Python's bound, which caps a very
 * long stay rather than walking the whole pharmacy history.
 */
async function fetchHistoryObatRows(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  noRm: string,
): Promise<LegacyRow[]> {
  const collected: LegacyRow[] = [];
  for (let page = 1; page <= HISTORY_OBAT_MAX_PAGES; page += 1) {
    const payload = await softJson<unknown>(
      ctx,
      client,
      'penatajasaInap.getHistoryObat',
      { page: String(page), rows: String(HISTORY_OBAT_ROWS_PER_PAGE) },
      { query: { nomedrec: noRm } },
    );
    const rows = rowsOf(payload);
    if (rows.length === 0) break;
    collected.push(...rows);
    if (rows.length < HISTORY_OBAT_ROWS_PER_PAGE) break;
    if (page === HISTORY_OBAT_MAX_PAGES) {
      ctx.log(
        `- History obat dipotong pada batas ${HISTORY_OBAT_MAX_PAGES} halaman | rows=${collected.length}`,
        'debug',
      );
    }
  }
  return collected;
}

/**
 * `_get_history_obat_entries` (ranap_v3.py:5833) — the pharmacy orders, each
 * one enriched with its own detail lines.
 *
 * Three things the raw page rows do not give you and this does:
 *  - **de-duplication on `no_order`**, because the grid repeats an order across
 *    pages when the underlying list shifts between reads;
 *  - the `getdetail_historyobat` line items, folded into the item/qty
 *    fingerprint `matchHistoryObatToBiayaRows`'s exact pass compares. Without
 *    it `signature_exact` is empty on every entry, the exact pass can never
 *    fire, and the loose pass has an empty name set — the match collapses to
 *    "whatever is left";
 *  - the Python's own ordering, oldest order first with `no_order` breaking
 *    ties, so the pairing is stable when two orders score equally.
 *
 * The detail read is memoized per `no_order` for the run, as the Python's
 * `_DETAIL_HISTORY_OBAT_CACHE` is: `validate_obat_pulang` runs the join once per
 * registration and a two-registration run would otherwise read every order
 * twice.
 */
async function fetchHistoryObatEntries(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  noRm: string,
): Promise<LegacyRow[]> {
  const cached = getScratch<LegacyRow[]>(ctx, K.historyObatEntries);
  if (cached) return cached;

  const entries: LegacyRow[] = [];
  const seen = new Set<string>();
  for (const orderRow of await fetchHistoryObatRows(ctx, client, noRm)) {
    const noOrder = str(orderRow, 'no_order');
    if (!noOrder || seen.has(noOrder)) continue;
    seen.add(noOrder);
    // `getdetail_historyobat_inap` (ranap_v3.py:5670) is a GET keyed by
    // `no_order` alone; the parameter travels in the query string.
    const detailRows = rowsOf(
      await softJson<unknown>(
        ctx,
        client,
        'penatajasaInap.getDetailHistoryObat',
        {},
        { query: { no_order: noOrder } },
      ),
    );
    entries.push(buildHistoryObatEntry(orderRow, detailRows));
  }
  const sorted = sortHistoryObatEntries(entries);
  ctx.scratch[K.historyObatEntries] = sorted;
  return sorted;
}

/**
 * `verifikator_getdetail_transaksi(no_referensi, kd_tindakan)`
 * (ranap_v3.py:4908), the charge-side half of the obat join.
 *
 * `_build_biaya_obat_detail_entry` (5889) reads it with the row's own
 * `kd_tindakan`, defaulting to `"16"`, and skips the read entirely when the row
 * carries no `no_referensi` — there is nothing to address it with. Memoized on
 * the same key pair the Python caches on.
 */
async function fetchBiayaObatDetail(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  row: LegacyRow,
): Promise<LegacyRow[]> {
  const noReferensi = str(row, 'no_referensi');
  if (!noReferensi) return [];
  const kdTindakan = str(row, 'kd_tindakan') || DEFAULT_OBAT_KD_TINDAKAN;
  const cache = scratchRecord<LegacyRow[]>(ctx, K.biayaObatDetailCache);
  const key = `${noReferensi}|${kdTindakan}`;
  const hit = cache[key];
  if (hit) return hit;
  // A GET (ranap_v3.py:4915 uses `_get_json` with `params`), so both fields
  // travel in the query string.
  const rows = rowsOf(
    await softJson<unknown>(
      ctx,
      client,
      'verifikator.getDetailTransaksi',
      {},
      { query: { no_transaksi: noReferensi, kd_tindakan: kdTindakan } },
    ),
  );
  cache[key] = rows;
  return rows;
}

/**
 * `get_evo_v2_cppt_rows` (ranap_v3.py:3241) — the v2 doctor/date oracle the
 * specialist repair falls back to when v1 has no note for a day.
 *
 * Returns `undefined` when the v2 API is not available, which is **not** the
 * same as "no CPPT": `planVisiteSync` treats an empty array as "v1 had nothing,
 * fall back to v2 and it had nothing either", so handing it `[]` on a v1-only
 * deployment would state an opinion the run never obtained. `undefined` makes
 * the executor omit `cpptV2RowsByNoReg` entirely.
 *
 * Two reads, as the Python does them: the patient timeline
 * (`api/ringkasan_pasien/loadTglMasuk`, 3225) to find this registration's
 * `single_id`, then `api_inap/cppt/cppt_riwayat` keyed by it. No `single_id`
 * for the registration means no rows — the Python's own early return.
 */
async function fetchCpptV2Rows(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  baseUrlV2: string | undefined,
  noRm: string,
  reg: string,
): Promise<LegacyRow[] | undefined> {
  if (!baseUrlV2 || !noRm || !reg) return undefined;

  const timeline = scratchRecord<LegacyRow[]>(ctx, K.cpptV2TimelineByRm);
  const timelineRows =
    timeline[noRm] ??
    (timeline[noRm] = rowsOf(
      await softJson<unknown>(
        ctx,
        client,
        'ringkasanPasien.loadTglMasuk',
        {},
        { query: { keyword: '', no_medicalrecord: noRm } },
      ),
    ));

  const singleId = timelineRows
    .filter((row) => str(row, 'no_kunjungan') === reg)
    .map((row) => str(row, 'single_id'))
    .find(Boolean);
  if (!singleId) {
    ctx.log(`- Backup visite CPPT v2 | reg=${reg || '-'} | status=skip | alasan=single_id tidak ditemukan`, 'debug');
    return [];
  }

  return rowsOf(
    await softJson<unknown>(
      ctx,
      client,
      'cppt.riwayat',
      {},
      {
        query: {
          Single_id: singleId,
          No_Reg: reg,
          jns_user: '0',
          jabatan: '',
          from: 'ringkasan_pasien',
          filterNoReg: '0',
        },
      },
    ),
  );
}

/**
 * `ambil_listtindakan` for every room transaction, into `K.listTindakanByTrx`.
 *
 * Shared by `load_charges` and by the re-plan passes of `sync_tindakan` /
 * `sync_visite`, so a second pass reads exactly what the first one did — from
 * the backend, never from the cached map. That is the point of the pass: the
 * rows a `tambah` created now carry their backend-assigned `urut_tindakan`, and
 * the rows an `update_tgl` was supposed to move either moved or did not
 * (`_find_unmatched_updated_rows`, ranap_v3.py:4049).
 *
 * A read that fails leaves nothing behind but a sync issue for its
 * registration — the same way `main()`'s `except` branches reach
 * `_emit_pre_verification_summary` instead of vanishing.
 */
async function loadChargeLinesInto(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  groups: Record<string, LegacyRow[]>,
): Promise<{ lines: number; failedRegs: string[]; transactions: number }> {
  const alerts = alertsOf(ctx);
  const listTindakanByTrx: Record<string, LegacyRow[]> = {};
  const failedRegs: string[] = [];
  let lines = 0;
  for (const [reg, rows] of Object.entries(groups)) {
    let regFailed = false;
    for (const row of rows) {
      const trx = str(row, 'no_transaksi');
      if (!trx || listTindakanByTrx[trx]) continue;
      const before = failedReads(ctx, 'penatajasaInap.getListTindakan').length;
      // `ambil_listtindakan` (ranap_v3.py:3924) pages to 999; without it the
      // grid default truncates a long stay's charge list.
      const res = rowsOf(
        await softJson<unknown>(ctx, client, 'penatajasaInap.getListTindakan', {
          no_transaksi: trx,
          no_registrasikunjungan: reg,
          kd_kamarperawatan: str(row, 'kd_kamarperawatan'),
          page: '1',
          rows: '999',
        }),
      );
      if (failedReads(ctx, 'penatajasaInap.getListTindakan').length > before) regFailed = true;
      listTindakanByTrx[trx] = res;
      lines += res.length;
    }
    if (regFailed) {
      alerts.registerSyncIssue(reg, 'ambil_listtindakan', 'error=list tindakan rawat inap tidak terbaca');
      failedRegs.push(reg);
    }
  }
  ctx.scratch[K.listTindakanByTrx] = listTindakanByTrx;
  return { lines, failedRegs, transactions: Object.keys(listTindakanByTrx).length };
}

/** The re-plan pass's re-read, logged where the operator can see it happened. */
async function reloadChargeLines(ctx: ExecutorContext, client: EvoMedisClient): Promise<void> {
  const groups = roomGroupsOf(ctx);
  if (Object.keys(groups).length === 0) return;
  const { lines, failedRegs } = await loadChargeLinesInto(ctx, client, groups);
  ctx.log(
    `- Re-read list tindakan untuk pass ${ctx.pass}/${ctx.maxPasses} | baris=${lines}` +
      (failedRegs.length > 0 ? ` | gagal=${failedRegs.join(', ')}` : ''),
    failedRegs.length > 0 ? 'warn' : 'debug',
  );
}

/** What a step has to say when a pass could not finish the work it found. */
interface ReplanNote {
  /** Ask the engine for another pass (write runs only — preview ignores it). */
  needsReplan: boolean;
  /** Appended to the step summary, so the status line is never over-confident. */
  summarySuffix: string;
  /** Operator log line. */
  log?: string;
  /** Recorded only when the cap is reached and work is still outstanding. */
  warning?: WorkflowIssue;
}

/**
 * Turn "`pendingCount` pieces of work are not addressable yet" into the flag,
 * the log line and the summary suffix.
 *
 * On the last allowed pass it says so plainly instead of promising a pass that
 * will never come: the runner refuses to grant one past `ctx.maxPasses` and
 * emits `node.replan_exhausted`, so a summary still reading "perlu re-plan"
 * would describe an event the engine has already declined. The flag is still
 * set, because that refusal is what puts `node.replan_exhausted` in the audit
 * trail.
 */
function replanNote(
  ctx: ExecutorContext,
  pendingCount: number,
  what: string,
  /**
   * Optional breakdown when one pass is outstanding for more than one reason
   * (an unaddressable follow-up *and* a `batal_verifikasi` that has to land
   * first). Replaces the bare `${pendingCount} ${what}` phrase so the operator
   * reads why, not just how many.
   */
  detail: readonly string[] = [],
): ReplanNote {
  if (pendingCount <= 0) return { needsReplan: false, summarySuffix: '' };
  const subject = detail.length > 0 ? detail.join(' + ') : `${pendingCount} ${what}`;
  if (ctx.pass >= ctx.maxPasses) {
    const message =
      `${subject} masih belum dapat dieksekusi setelah pass ${ctx.pass}/${ctx.maxPasses} — ` +
      `batas re-plan tercapai, sisanya harus dikerjakan manual`;
    return {
      needsReplan: true,
      summarySuffix: ` — ${message}`,
      log: `[WARN] ${message}`,
      warning: warning('replan_exhausted', message, 'error'),
    };
  }
  const message =
    `${subject} baru dapat dialamatkan setelah write pass ${ctx.pass} diterapkan — ` +
    `minta pass ${ctx.pass + 1}/${ctx.maxPasses}`;
  return { needsReplan: true, summarySuffix: ` — ${message}`, log: `- ${message}` };
}

/** `" (pass n/m setelah re-plan)"`, or nothing at all on the first pass. */
function passSuffix(ctx: ExecutorContext): string {
  return ctx.pass > 1 ? ` (pass ${ctx.pass}/${ctx.maxPasses} setelah re-plan)` : '';
}

/**
 * `get_byny_rme_status` (ranap_v3.py:2017) — is this newborn confirmed healthy?
 *
 * Two calls, and both are required:
 *
 *  1. `rme/ri_rme/get_single_id` yields the `single_id` the discharge summary is
 *     keyed by, plus the birth date (`tanggal_lahir`/`tgl_lahir`, then
 *     `tgl_masuk`) that later anchors the newborn's room days.
 *  2. `rme/ri_ringkasan_pulang/getdata_last` yields `rows[0].dt.data_post` — a
 *     **JSON string** that has to be parsed. `keadaan` and
 *     `txt_diagnosis_text_rinplg` live inside it, nowhere near the top level.
 *
 * `is_healthy` needs positive proof: the discharge form's "baik" box must be
 * ticked (`keadaan` compacts to `CHKBAIKRINPLG`, or `chk_baik_rinplg === "on"`)
 * *and* the diagnosis must not look sick. A missing `single_id`, a missing row,
 * an unparseable `data_post` — every one of those means **not healthy**, because
 * the consequence of a false "healthy" is waiving a sick newborn's SEP
 * requirement on a BPJS bill.
 *
 * Memoized per registration for the run, as the Python memoizes in
 * `_BYNY_RME_STATUS_CACHE`.
 */
interface BynyRmeStatus extends LegacyRow {
  available: boolean;
  single_id: string;
  birth_date: string;
  birth_source: string;
  is_healthy: boolean;
  requires_sep_mandiri: boolean | null;
  keadaan: string;
  diagnosis: string;
  reason: string;
}

function emptyBynyRmeStatus(reason: string): BynyRmeStatus {
  return {
    available: false,
    single_id: '',
    birth_date: '',
    birth_source: '',
    is_healthy: false,
    requires_sep_mandiri: null,
    keadaan: '',
    diagnosis: '',
    reason,
  };
}

/**
 * `get_rme_single_info` (ranap_v3.py:3113) with its `_RME_SINGLE_INFO_CACHE`.
 *
 * Two consumers need the same `single_id`: the newborn health check and the
 * CPPT v1 pager. Reading it twice per registration is what the Python's cache
 * exists to prevent.
 */
async function getRmeSingleInfo(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  reg: string,
): Promise<LegacyRow> {
  const key = reg.trim();
  if (!key) return {};
  const cache = scratchRecord<LegacyRow>(ctx, K.rmeSingleByReg);
  const cached = cache[key];
  if (cached) return cached;
  return (cache[key] =
    (await softJson<LegacyRow>(ctx, client, 'rme.getSingleId', {
      no_registrasikunjungan: key,
    })) ?? {});
}

async function getBynyRmeStatus(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  noRegistrasiKunjungan: string,
): Promise<BynyRmeStatus> {
  const reg = noRegistrasiKunjungan.trim();
  if (!reg) return emptyBynyRmeStatus('no_reg_empty');

  const cache = (ctx.scratch[K.bynyRmeCache] ??= {}) as Record<string, BynyRmeStatus>;
  const cached = cache[reg];
  if (cached) return cached;

  const single = await getRmeSingleInfo(ctx, client, reg);
  const singleId = str(single, 'single_id');
  const birthDate = datePart(str(single, 'tanggal_lahir', 'tgl_lahir')) || datePart(str(single, 'tgl_masuk'));
  const base: BynyRmeStatus = {
    ...emptyBynyRmeStatus(''),
    single_id: singleId,
    birth_date: birthDate,
    birth_source: birthDate ? 'rme/ri_rme/get_single_id' : '',
  };
  if (!singleId) {
    return (cache[reg] = { ...base, reason: 'single_id_not_found' });
  }

  const last = await softJson<unknown>(ctx, client, 'rme.getRingkasanPulangLast', {
    no_registrasikunjungan: reg,
    single_id: singleId,
  });
  const rows = rowsOf(last);
  const first = rows[0];
  if (!first) {
    return (cache[reg] = { ...base, reason: 'ringkasan_pulang_not_found' });
  }

  const dt = (first['dt'] && typeof first['dt'] === 'object' ? first['dt'] : {}) as LegacyRow;
  const dataPost = parseJsonText<LegacyRow>(dt['data_post'], {}) ?? {};
  const keadaan = str(dataPost, 'keadaan');
  const keadaanKey = compactTextKey(keadaan);
  const diagnosis = str(dataPost, 'txt_diagnosis_text_rinplg', 'txt_diagnosa_masuk_rinplg');
  const diagnosisSick = looksLikeBynySickDiagnosis(diagnosis);
  const isHealthy =
    (keadaanKey === 'CHKBAIKRINPLG' || str(dataPost, 'chk_baik_rinplg').toLowerCase() === 'on') &&
    !diagnosisSick;

  return (cache[reg] = {
    ...base,
    available: true,
    is_healthy: isHealthy,
    requires_sep_mandiri: !isHealthy,
    keadaan: keadaan || (isHealthy ? 'chk_baik_rinplg' : ''),
    diagnosis,
    reason: isHealthy
      ? 'ringkasan_pulang_baik'
      : diagnosisSick
        ? 'diagnosis_mengarah_sakit'
        : 'ringkasan_pulang_tidak_baik',
  });
}

/**
 * Fetch what one penunjang candidate's validator needs, then run it.
 *
 * Each modality has its own detail + result endpoints; the validators are pure,
 * so every read happens here. A read that comes back empty is passed through as
 * empty — the validators already treat "no result" as "not ready", which is the
 * fail-closed answer.
 */
async function validateCandidate(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  noRm: string,
  candidate: PenunjangCandidate,
): Promise<PenunjangValidation> {
  const trx = candidate.noTransaksi;
  switch (candidate.modality) {
    case 'Lab PK': {
      // Both detail reads are GETs. `getdetail_historyilab` keys on `no_trans`
      // (ranap_v3.py:5096) — not `no_order`, which is the pharmacy endpoint's
      // field — and `getdetailtransaksi` on `no_transaksi` (ranap_v3.py:5284).
      const detailRows = rowsOf(
        await softJson<unknown>(ctx, client, 'penatajasaInap.getDetailHistoryILab', {}, { query: { no_trans: trx } }),
      );
      const detailHasilRows = rowsOf(
        await softJson<unknown>(
          ctx,
          client,
          'laboratoriumHasil.getDetailTransaksi',
          {},
          { query: { no_transaksi: trx } },
        ),
      );
      const hasilRows = rowsOf(await softJson<unknown>(ctx, client, 'laboratoriumHasil.getHasilPemeriksaan', { no_transaksi: trx }));
      // `validate_hasil_laboratorium_pk` counts the LIS print (`cetak_lis`) as a
      // document channel. Never read here, `lis_url` was always "tidak" and
      // every Lab PK order needed attention (live 2026-10-15: the endpoint
      // answers with the `lis_new/pdf.php?no_transaksi=…` link).
      const lisUrl = await softText(ctx, client, 'laboratoriumHasil.cetakLis', { no_transaksi: trx });
      const hasilData = await softJson<LegacyRow>(ctx, client, 'laboratoriumHasil.getDataTransaksi', {
        txtmedrec: noRm,
        no_transaksi: trx,
        txttgltransaksicari_hsllab: '',
      });
      return validateHasilLaboratoriumPk({
        noRm,
        noTransaksiLab: trx,
        detailRows,
        detailHasilRows,
        hasilRows,
        lisUrl,
        ...(hasilData && Object.keys(hasilData).length > 0 ? { hasilData } : {}),
      });
    }
    case 'PA': {
      const detailRows = rowsOf(
        await softJson<unknown>(ctx, client, 'kemoterapi.getDetailHistoryOrderPa', {}, { query: { no_trans: trx } }),
      );
      return validateHasilPa({ noTransaksiPa: trx, detailRows });
    }
    case 'Radiologi': {
      // `getdetail_historyirad` (ranap_v3.py:5175): GET, keyed `no_trans`.
      const detailRows = rowsOf(
        await softJson<unknown>(ctx, client, 'penatajasaInap.getDetailHistoryIrad', {}, { query: { no_trans: trx } }),
      );
      const hasilRows = rowsOf(await softJson<unknown>(ctx, client, 'radiologi.getHasilPemeriksaan', { no_transaksi: trx }));
      const berkasRows = rowsOf(await softJson<unknown>(ctx, client, 'radiologi.getBerkas', { no_transaksi: trx }));
      return validateHasilRadiologi({ noTransaksiRad: trx, detailRows, hasilRows, berkasRows });
    }
    case 'Elektromedik': {
      const detailRows = rowsOf(await softJson<unknown>(ctx, client, 'elektromedik.getListTindakan', { no_transaksi: trx }));
      const hasilRows = rowsOf(
        await softJson<unknown>(ctx, client, 'elektromedikHasil.getListHasilPemeriksaan', { no_transaksi: trx }),
      );
      const statusBayar = await softText(ctx, client, 'elektromedik.cekStatusBayar', { no_transaksi: trx });
      return validateHasilElektromedik({ noTransaksiElm: trx, detailRows, hasilRows, statusBayar: flag(statusBayar) });
    }
  }
}

/**
 * The two SEP recoveries `main()` runs over its 03- candidates
 * (ranap_v3.py:15748-15857), in its order and with its precedence.
 *
 * Per candidate:
 *  - **known SEP** — an inpatient row that already carries a real SEP of its own
 *    (not the mother's placeholder) can use it. This runs for **every** 03-
 *    candidate, newborn or not (ranap_v3.py:15792); `candidate_has_real_sep` is
 *    computed before the BYNY branch is ever entered. Gating it on BYNY, as this
 *    used to, threw away a perfectly good SEP for every non-newborn.
 *  - **healthy-newborn waiver** — only for a BYNY row, only when the RME
 *    confirms the baby healthy, only on a BPJS payer, and only when the row has
 *    no real SEP of its own (`not candidate_has_real_sep`, ranap_v3.py:15812).
 *    Without that last condition a healthy newborn that *has* a SEP whose date
 *    misses the tolerance window gets its requirement waived; the Python does
 *    not waive it.
 *
 * The waiver is **deferred**: the Python records it in
 * `byny_sep_optional_context` and applies it only after the loop
 * (ranap_v3.py:15823), so a later candidate with a genuinely valid SEP still
 * wins. Returning on the first healthy newborn would prefer a waiver over a real
 * SEP. The first recorded context wins, matching `is None`.
 */
async function resolveSepFallback(
  ctx: ExecutorContext,
  client: EvoMedisClient,
  candidates: readonly LegacyRow[],
  input: RanapInput,
  current: SepResult,
): Promise<SepResult | undefined> {
  let waiver: SepResult | undefined;

  for (const candidate of candidates) {
    const trx = str(candidate, 'no_transaksi');
    if (!trx.startsWith('03-')) continue;

    const detail = await softJson<LegacyRow>(ctx, client, 'penatajasaInap.getDataKunjungan', {
      txtmedrec_inap: input.noRm,
      no_transaksi: trx,
    });
    const namaPasien = str(detail, 'nama_pasien') || str(candidate, 'nama_pasien');
    const noSep = str(detail, 'no_sep') || str(candidate, 'no_sep');
    const hasRealSep = Boolean(noSep) && !looksLikeBynyParentSep(noSep);

    if (hasRealSep) {
      const explicit = buildSepResultFromKnownSep({
        noSep,
        targetDate: input.tanggal,
        fallbackDate: datePart(str(detail, 'tgl_masuk') || str(candidate, 'tgl_masuk')),
        noKartuBpjs: current.noKartuBPJS ?? '',
        toleranceDays: input.toleranceDays,
        expectedService: 'RITL',
        matchType: 'byny_known_sep',
      });
      if (explicit.sepValid) {
        ctx.log(`- SEP mandiri terdeteksi dan dipakai | trx=${trx} | no_sep=${noSep}`, 'info');
        return explicit;
      }
    }

    if (!isBynyPatient(namaPasien)) continue;

    const reg = str(candidate, 'no_registrasikunjungan');
    const rmeStatus = await getBynyRmeStatus(ctx, client, reg);
    if (!rmeStatus.is_healthy) {
      ctx.log(
        `[WARN] Pasien BYNY sakit / tidak terkonfirmasi sehat | trx=${trx} | reg=${reg || '-'} | ` +
          `keadaan=${rmeStatus.keadaan || '-'} | diagnosis=${rmeStatus.diagnosis || '-'} | ` +
          `alasan=${rmeStatus.reason || '-'} | catatan=jika penjamin BPJS maka perlu SEP mandiri`,
        'warn',
      );
      continue;
    }
    if (!isBpjsPenjamin(str(candidate, 'nama_penjamin')) || hasRealSep || waiver) continue;

    // `byny_base_date` — the birth date from `get_single_id`, not whatever the
    // discharge summary happens to carry. This value becomes the room-day anchor
    // for the newborn, so reading the wrong field misdates every hospital day.
    // (The Python's middle term reads `rme_status["tgl_masuk"]`, a key
    // `get_byny_rme_status` never sets; it is kept for shape, never fires.)
    const baseDate =
      datePart(rmeStatus.birth_date) || datePart(str(rmeStatus, 'tgl_masuk')) || input.tanggal;
    ctx.log(
      `- SEP mandiri BYNY dilewati | trx=${trx} | reg=${reg || '-'} | ` +
        `alasan=bayi sehat, mengikuti SEP orang tua | tanggal_dasar=${baseDate || '-'}`,
      'warn',
    );
    waiver = {
      sepValid: true,
      sepOptional: true,
      sepOptionalReason: 'byny_sehat_mengikuti_sep_orangtua',
      sepOK: '',
      noKartuBPJS: '',
      sepItem: {
        jns_pelayanan: 'RITL',
        tgl_sep: baseDate,
        keterangan_sep_optional: rmeStatus.reason,
      },
      targetTanggal: baseDate,
      matchedTanggal: baseDate,
      bynyBaseDate: baseDate,
      configuredToleranceDays: input.toleranceDays,
      appliedToleranceDays: 0,
      matchType: 'byny_optional',
    };
  }

  return waiver;
}
