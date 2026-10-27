/**
 * Specialist visite / consultation repair, ported from `ranap_v3.py`.
 *
 * `sinkronkan_visite_konsultasi_spesialis_group` (ranap_v3.py:11982) is the
 * legacy script's second-largest repair set. It walks every specialist charge on
 * a rawat-inap group — `VISITE DOKTER SPESIALIS`, `VISITE DR ANAK SCN`,
 * `KONSULTASI DOKTER SPESIALIS LEWAT TELEPON` — and fixes each one in place:
 * fills an empty performing doctor from the CPPT notes, deletes the row when the
 * CPPT cannot name one, corrects a tariff that does not match the room class,
 * rewrites a non-standard action name, moves a charge to the room that actually
 * owned that day, drops a consultation when the same doctor already has a visite
 * that day, enforces the once-per-day / three-per-stay quotas, and finally makes
 * sure the patient's own attending doctor has a visite at all.
 *
 * ## Why this returns a plan instead of writing
 *
 * The Python writes inline (`_hapus_spesialis_row`,
 * `tambah_tindakan_polis`, `update_tgl_tindakan_inap`,
 * `_tampung_pelaksana_checked`). In SIMRS-Flow a `mutate` step never writes: it
 * emits `MutationPlan`s that an operator approves. So only the *decision* half
 * is ported here, as an ordered list of {@link VisiteOp}s — one op per legacy
 * write, in the order the Python performs them. Nothing in this module performs
 * I/O, reads the clock implicitly, or keeps module state.
 *
 * ## The two assumptions a write run must re-check
 *
 * 1. **Writes are assumed to succeed.** The legacy code re-reads
 *    `get_listtindakan` after every write and branches on the result; a planner
 *    cannot observe a write it has not made. This module models it the way the
 *    Python's own `DRY_RUN` branch does — `hapus_tindakan_inap` returns `"1"`
 *    and `_tampung_pelaksana_checked` returns `ok: True` under `DRY_RUN`, i.e.
 *    success — and then keeps iterating over a *simulated* row set so the whole
 *    ordered script is produced in one pass rather than one phase per run.
 * 2. **A created row cannot be named.** `urut_tindakan` is assigned by the
 *    backend, so the `updateTgl` / `setPelaksana` ops that the Python issues
 *    against a freshly added row carry no `row`/`urutTindakan`; they carry
 *    {@link VisiteOp.dependsOnSequence}, the `sequence` of the op that creates
 *    the row they target. The executor must re-read
 *    `verifikator_get_listtindakan` to resolve it — which is exactly what the
 *    Python does.
 *
 * Whenever either assumption is load-bearing the plan comes back with
 * `status: 'incomplete'` and an `issues` entry, meaning: execute what is here,
 * then re-read and re-plan.
 *
 * ## Hoisted fetches (endpoint → parameter)
 *
 * Every read the legacy code performs is a parameter on
 * {@link PlanVisiteSyncArgs}:
 *
 *  - `poliklinik/verifikator/get_listtindakan` (`verifikator_get_listtindakan`,
 *    ranap_v3.py:4896) / `poliklinik/penatajasa_inap/get_listtindakan`
 *    (`_refresh_listtindakan_inap`, ranap_v3.py:12078) — endpoint ids
 *    `verifikator.getListTindakan` / `penatajasaInap.getListTindakan` →
 *    `listTindakanByNoTransaksi`, keyed by the stay's `no_transaksi`
 *  - `poliklinik/penatajasa_inap/getdetail_komponen_transaksi`
 *    (`getdetail_komponen_transaksi`, ranap_v3.py:4222) →
 *    `komponenDetailByRow`, keyed by {@link komponenDetailKey}. This is where
 *    the performing specialist lives (component `29`).
 *  - `poliklinik/verifikator/gettindakan`
 *    (`ambil_master_tindakan_verifikator`, ranap_v3.py:4832) /
 *    `poliklinik/penatajasa_inap/gettindakan` (`ambil_master_tindakan_inap`,
 *    ranap_v3.py:3907) — endpoint ids `verifikator.getTindakan` /
 *    `penatajasaInap.getTindakan` → `masterTindakanByNoTransaksi`, keyed by the
 *    `no_transaksi` the master list was fetched for (the Python also passes
 *    `kd_unit`, `kd_detkelpenjamin` and `tgl_masuk`, all derivable from the room
 *    row and the kunjungan payload below)
 *  - `poliklinik/penatajasa_inap/getcmbparamedis_pelaksana`
 *    (`ambil_paramedis_pelaksana`, ranap_v3.py:1903) — endpoint id
 *    `penatajasaInap.getCmbParamedisPelaksana` →
 *    `paramedisPelaksanaByKdUnit`, keyed by `kd_unit` plus the `'undefined'`
 *    bucket the legacy code falls back to. Used by
 *    {@link resolveExactParamedisName} to turn a CPPT display name into the
 *    exact registry spelling `tampung_pelaksana` demands.
 *  - `poliklinik/penatajasa_inap/getdatakunjungan` (`ambil_datakunjungan`) —
 *    endpoint id `penatajasaInap.getDataKunjungan` →
 *    `dataKunjunganByNoTransaksi` (`nama_paramedis`, `nama_pasien`,
 *    `kd_paramedis`, `tgl_masuk`)
 *  - `kasir/kasir/getdatatransaksi` (`ambil_datatransaksi`) — endpoint id
 *    `kasir.getDataTransaksi` → `dataTransaksiByNoTransaksi`, the fallback the
 *    Python uses when `getdatakunjungan` comes back empty
 *  - CPPT v1: `rme/ri_rme/get_single_id` (`get_rme_single_info`,
 *    ranap_v3.py:3113) → `rme/ri_cppt/load_awal` → `rme/ri_cppt/load_soap`
 *    (`get_evo_v1_cppt_rows`, ranap_v3.py:3130, paged 100 at a time) — endpoint
 *    ids `rme.getSingleId`, `rme.loadCpptAwal`, `rme.loadCpptSoap` →
 *    `cpptV1RowsByNoReg`
 *  - CPPT v2: `api/ringkasan_pasien/loadTglMasuk`
 *    (`get_evo_v2_timeline_rows`, ranap_v3.py:3225, resolves `single_id`) →
 *    `api_inap/cppt/cppt_riwayat` (`get_evo_v2_cppt_rows`, ranap_v3.py:3241) —
 *    endpoint ids `ringkasanPasien.loadTglMasuk`, `cppt.riwayat` →
 *    `cpptV2RowsByNoReg`. An empty array is how "v1 had nothing, fall back to
 *    v2" and "neither is available" are both expressed, exactly as the Python's
 *    `available = bool(rows)`.
 *    `_get_evo_v1_doctor_date_match` (3192) and `_get_evo_v2_doctor_date_match`
 *    (3282) need no parameter of their own — they are pure filters over these
 *    same rows, and are reproduced as {@link getSpesialisV2MatchState}.
 *  - `poliklinik/penatajasa_inap/cekstatusbayar` (`cekstatusbayar_tindakan`,
 *    ranap_v3.py:4770) — endpoint id `penatajasaInap.cekStatusBayar` →
 *    `statusBayarByTindakan`, keyed by {@link tindakanStatusKey}; only consulted
 *    when the row's own hints are inconclusive
 *  - `poliklinik/penatajasa_inap/cekstatus_verifikasi`
 *    (`cekstatus_verifikasi_tindakan`) — endpoint id
 *    `penatajasaInap.cekStatusVerifikasi` → `statusVerifikasiByTindakan`, same
 *    key
 *
 * `room_day_assignments` is not a fetch: it comes from `buildRoomDayAssignments`
 * in `./rooms.js`, and `_build_room_owner_by_date` is imported from there rather
 * than re-implemented.
 *
 * ## Endpoints the ops target
 *
 *  - `hapus` → `penatajasaInap.hapusTindakan` (`hapus_tindakan_inap`)
 *  - `tambah` / `repairTarif` / `relocateRoom` →
 *    `penatajasaInap.tambahTindakanPolis` (`tambah_tindakan_polis`)
 *  - `updateTgl` → `penatajasaInap.updateTgl` (`update_tgl_tindakan_inap`)
 *  - `setPelaksana` → `poliklinik.tampungPelaksana`
 *    (`tampung_pelaksana_tindakan`, component `29`)
 *
 * ## Coverage
 *
 * Fully ported: `_get_spesialis_action_key`, `_get_patient_paramedis_group_info`,
 * `_get_spesialis_pelaksana_name`, `_get_cppt_doctor_candidates_for_date`,
 * `_pick_cppt_pelaksana_for_empty_spesialis`,
 * `_try_fill_spesialis_pelaksana_from_cppt`,
 * `_looks_like_room_label_spesialis_pelaksana`, `_is_same_spesialis_row`,
 * `_get_spesialis_fallback_kd_unit`, `_preserve_spesialis_row`,
 * `_repair_spesialis_visite_from_cppt_or_delete`,
 * `_repair_konsultasi_to_primary_doctor`, `_get_spesialis_room_class`,
 * `_get_expected_spesialis_tarif`, `_get_spesialis_exact_name`,
 * `_needs_spesialis_room_relocation`, `_needs_spesialis_tarif_repair`,
 * `_needs_spesialis_name_repair`, `_enrich_repaired_spesialis_row`,
 * `_repair_nonstandard_visite_spesialis_row`,
 * `_repair_wrong_tarif_spesialis_row`, `_repair_spesialis_wrong_room_row`,
 * `_collect_spesialis_rows_for_group`, `_get_spesialis_v2_match_state`,
 * `_pick_spesialis_keep_row`, `_hapus_spesialis_row`,
 * `_dedup_konsultasi_when_visite_same_day`, `_cleanup_spesialis_action_rows`,
 * `_ensure_primary_patient_visite`, `sinkronkan_visite_konsultasi_spesialis_group`,
 * plus the helpers they lean on: `_looks_like_v2_doctor_row` (3088),
 * `_pick_tindakan_meta`'s specialist branches (9296),
 * `_resolve_exact_paramedis_name` (4347), `_boleh_hapus_tindakan` (12307) and
 * `_row_allows_delete_by_hint` (12270).
 *
 * `_log_spesialis_v2_fallback` (ranap_v3.py:11406) is ported as
 * {@link spesialisV2FallbackLine} and pushed into `lines` at each
 * `_pick_spesialis_keep_row` call site, under the same `DEBUG_MODE` gate
 * (`PlanVisiteSyncArgs.debug`). It changes no decision — it prints the CPPT
 * match state of every candidate the sort is about to rank.
 *
 * `_tampung_pelaksana_checked`'s error-recovery arms (ranap_v3.py:4499 onwards)
 * live in `executors.ts`, not here: the read-back is the `setPelaksana` plan's
 * read-after-write rule, and the "write a throwaway performer, then write the
 * real one" `DATABASE ERROR` workaround is driven across re-plan passes from
 * `ctx.mutations`. {@link resolveExactParamedisName} and
 * `tindakanSync.pickIntermediateParamedisName` are what that ladder is built
 * from.
 */

import { buildUpdateDateTime, datePart, parseDateTimeFlexible } from './dates.js';
import { extractRoomClassKey, normalizeCareClassKey } from './careClass.js';
import {
  doctorNameMatchesRelaxed,
  extractRoomSegments,
  isAnesthesiologistName,
  isBynyPatient,
  isIcuRoomName,
  isKonsultasiTeleponName,
  isProtectedNonDeletableCharge,
  isVisiteDrAnakScnName,
  isVisiteSpesialisName,
  looksLikePediatricianName,
  normalizeParamedisDisplay,
  roomLabelMatchesSegment,
} from './names.js';
import {
  buildRoomOwnerByDate,
  groupRowsByDate,
  groupRowsByDateAndPelaksana,
  groupRowsByPelaksana,
  normalizeRoomStays,
} from './rooms.js';
import type { RoomStayOptions } from './rooms.js';
import {
  compactTextKey,
  normalizeTextKey,
  parseCurrencyInt,
  rowLogLabel,
  safeInt,
} from './scalars.js';
import type { LegacyRow } from './types.js';
import { rowsOf, str } from './types.js';

// ---------------------------------------------------------------------------
// Constants — every tariff, keyword and threshold copied from the Python
// ---------------------------------------------------------------------------

/** `kd_komponen` the performing specialist is stored under (`_get_spesialis_pelaksana_name`). */
export const SPESIALIS_KD_KOMPONEN = '29';

/** `_get_spesialis_exact_name` (ranap_v3.py:10624) — the canonical action names. */
export const SPESIALIS_EXACT_NAMES: Readonly<Record<string, string>> = {
  visite: 'VISITE DOKTER SPESIALIS',
  visite_scn: 'VISITE DR ANAK SCN',
  konsultasi: 'KONSULTASI DOKTER SPESIALIS LEWAT TELEPON',
};

/** `_cleanup_spesialis_action_rows`'s `label_map` (ranap_v3.py:11528). */
export const SPESIALIS_ACTION_LABELS: Readonly<Record<string, string>> = {
  visite: 'visite dokter spesialis',
  konsultasi: 'konsultasi dokter spesialis lewat telepon',
  visite_scn: 'visite dr anak scn',
};

/**
 * `_get_expected_spesialis_tarif` (ranap_v3.py:10615) — the visite tariff per
 * room class. **A wrong number here is a wrong bill.** Anything not listed
 * (VIP, VVIP, ICU, ISOLASI, …) yields 0, which the Python reads as "no expected
 * tariff, leave the price alone".
 */
export const SPESIALIS_TARIF_BY_CLASS: Readonly<Record<string, number>> = {
  'KELAS 3': 50000,
  'KELAS 2': 75000,
  'KELAS 1': 75000,
};

/** `max_iterations = 20` in `sinkronkan_visite_konsultasi_spesialis_group`. */
export const SPESIALIS_SYNC_MAX_ITERATIONS = 20;

/**
 * `normalized_rows[3:]` (ranap_v3.py:11715) — a doctor who is not the patient's
 * own may bill at most three specialist rows across the whole stay.
 */
export const SPESIALIS_OTHER_DOCTOR_MAX_TOTAL = 3;

/** The `kd_detkelpenjamin` fallback the Python hard-codes at every add site. */
export const DEFAULT_KD_DETKELPENJAMIN = '15';

/** `default_time="00:00:01"` on every `_build_update_datetime` call here. */
export const SPESIALIS_UPDATE_DEFAULT_TIME = '00:00:01';

/** `_pick_cppt_pelaksana_for_empty_spesialis`'s candidate preview cuts at 4 names. */
const CANDIDATE_PREVIEW_LIMIT = 4;

/** `_row_allows_delete_by_hint` / `_boleh_hapus_tindakan` — "not paid" spellings. */
const UNPAID_STATUS_BAYAR_KEYS: readonly string[] = ['0', 'BELUM', 'BELUMBAYAR'];

/** As above for the payment-type hint, which may also legitimately be a dash. */
const UNPAID_JENIS_BAYAR_KEYS: readonly string[] = ['-', '0', 'BELUM', 'BELUMBAYAR'];

/** `status`/`status_verifikasi` spellings the legacy code reads as "not yet". */
const FALSEY_STATUS_KEYS: readonly string[] = ['', '0', 'false', 'False'];

// ---------------------------------------------------------------------------
// Private text helpers
// ---------------------------------------------------------------------------

/** Python's bare `str(value or "").strip()`, without the `str()` accessor's null filtering. */
function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** `" ".join(str(value or "").upper().split())` — the collapsed comparison form. */
function collapseUpper(value: unknown): string {
  return text(value).toUpperCase().split(/\s+/).filter(Boolean).join(' ');
}

/** Python's `str(x)` on a possibly-missing dict value, used for identity compares. */
function rawString(value: unknown): string {
  return String(value);
}

function isRecordLike(value: unknown): value is LegacyRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `if not data_inap:` on a dict — an empty dict is falsy in Python. */
function isNonEmptyRow(value: unknown): value is LegacyRow {
  return isRecordLike(value) && Object.keys(value).length > 0;
}

/** `', '.join(names[:4])` + `', +N item'`, as `_repair_spesialis_visite_from_cppt_or_delete` formats it. */
function candidatePreview(names: readonly string[]): string {
  if (names.length === 0) return '-';
  const head = names.slice(0, CANDIDATE_PREVIEW_LIMIT).join(', ');
  const extra = names.length - CANDIDATE_PREVIEW_LIMIT;
  return extra > 0 ? `${head}, +${extra} item` : head;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** `_get_spesialis_action_key`'s three outcomes, plus "not a specialist row". */
export type VisiteActionKey = 'visite' | 'visite_scn' | 'konsultasi' | '';

/**
 * A specialist charge row after `_collect_spesialis_rows_for_group` /
 * `_enrich_repaired_spesialis_row` have decorated it. The underscore-prefixed
 * fields are the Python's own scratch keys, kept verbatim so the grouping
 * helpers in `./rooms.js` (`_row_date`, `_pelaksana_key`) keep working.
 */
export interface SpesialisRow extends LegacyRow {
  /** `_no_rm` — the patient the group belongs to. */
  readonly _no_rm: string;
  /** `_action_key` — `_get_spesialis_action_key(row)`. */
  readonly _action_key: VisiteActionKey;
  /** `_row_date` — `_date_part(tgl_jam or tgl_transaksi)`. */
  readonly _row_date: string;
  /** `_source_room_row` — the stay the charge is actually billed under. */
  readonly _source_room_row: LegacyRow;
  /** `_source_room_name` — that stay's `nama_unit`. */
  readonly _source_room_name: string;
  /** `_owner_room_row` — the stay that owns `_row_date` per the day assignment. */
  readonly _owner_room_row: LegacyRow;
  /** `_owner_room_name` — the owner stay's `nama_unit`. */
  readonly _owner_room_name: string;
  /** `_pelaksana` — component-29 performer name, `''` when unset. */
  readonly _pelaksana: string;
  /** `_pelaksana_key` — `_normalize_paramedis_display(_pelaksana)`. */
  readonly _pelaksana_key: string;
  /** `_is_anest` — `_is_anesthesiologist_name(_pelaksana)`. */
  readonly _is_anest: boolean;
  /**
   * Not in the Python: marks a row this planner *assumed into existence* after
   * an add op, so the simulation can converge. Such a row is never itself
   * deleted or re-planned — its real `urut_tindakan` is unknown.
   */
  readonly _synthetic?: boolean;
}

/** `_get_patient_paramedis_group_info`'s return shape (ranap_v3.py:10218). */
export interface PatientParamedisGroupInfo {
  /** Every distinct attending doctor seen across the group's stays, in stay order. */
  allNames: string[];
  /** `_normalize_paramedis_display` of each of `allNames`. */
  allKeys: Set<string>;
  /** The *last* stay's attending doctor — the patient's own doctor. */
  primaryName: string;
  /** `_normalize_paramedis_display(primaryName)`. */
  primaryKey: string;
  /** First `nama_pasien` found, used only for the BYNY test. */
  patientName: string;
  /** `_is_byny_patient(patientName)`. */
  isByny: boolean;
}

/** `_get_cppt_doctor_candidates_for_date`'s return shape (ranap_v3.py:10297). */
export interface CpptDoctorCandidates {
  /** Distinct doctor names charting on the target date, in CPPT order. */
  names: string[];
  /** `'v1'`, `'v2'`, or `''` when neither CPPT source returned anything. */
  source: string;
  /** `bool(rows)` — was any CPPT readable at all for this registration? */
  available: boolean;
}

/** `_get_spesialis_v2_match_state`'s cached fields (ranap_v3.py:11382). */
export interface SpesialisV2MatchState {
  /**
   * `_cppt_doctor_date_match`: `true`/`false` when a CPPT was readable,
   * `null` when it was not (which the Python treats as "no opinion").
   */
  state: boolean | null;
  /** `_cppt_doctor_date_match_count`. */
  count: number;
  /** `_cppt_doctor_date_match_names`. */
  names: string[];
  /** `_cppt_doctor_date_match_source` — `'v1'`, `'v2'` or `''`. */
  source: string;
}

/** The CPPT reads {@link getSpesialisV2MatchState} and friends fold over. */
export interface CpptLookups {
  /** `get_evo_v1_cppt_rows(no_rm, no_reg)` keyed by `no_registrasikunjungan`. */
  cpptV1RowsByNoReg?: Readonly<Record<string, unknown>>;
  /** `get_evo_v2_cppt_rows(no_rm, no_reg)` keyed by `no_registrasikunjungan`. */
  cpptV2RowsByNoReg?: Readonly<Record<string, unknown>>;
}

/** The two status probes `_boleh_hapus_tindakan` may need. */
export interface DeleteGateLookups {
  /** `cekstatusbayar_tindakan` keyed by {@link tindakanStatusKey}. */
  statusBayarByTindakan?: Readonly<Record<string, unknown>>;
  /** `cekstatus_verifikasi_tindakan` keyed by {@link tindakanStatusKey}. */
  statusVerifikasiByTindakan?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Cache keys the caller must use when building the hoisted maps
// ---------------------------------------------------------------------------

/**
 * `_detail_komponen_cache_key` (ranap_v3.py:4251) — the key
 * `komponenDetailByRow` must be built with:
 * `` `${no_transaksi}|${kd_tindakan}|${tgl_jam ?? tgl_transaksi}|${urut_tindakan}` ``.
 */
export function komponenDetailKey(row: LegacyRow): string {
  return [
    str(row, 'no_transaksi'),
    str(row, 'kd_tindakan'),
    str(row, 'tgl_jam', 'tgl_transaksi'),
    str(row, 'urut_tindakan'),
  ].join('|');
}

/**
 * The key for `statusBayarByTindakan` / `statusVerifikasiByTindakan`:
 * `` `${no_transaksi}|${kd_tindakan}|${urut_tindakan}` `` — the argument triple
 * of `cekstatusbayar_tindakan` and `cekstatus_verifikasi_tindakan`.
 */
export function tindakanStatusKey(row: LegacyRow): string {
  return [str(row, 'no_transaksi'), str(row, 'kd_tindakan'), str(row, 'urut_tindakan')].join('|');
}

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

/** `_get_spesialis_action_key` (ranap_v3.py:10191). SCN is probed before the generic visite. */
export function getSpesialisActionKey(row: LegacyRow): VisiteActionKey {
  const nama = row['nama_tindakan'];
  if (isVisiteDrAnakScnName(nama)) return 'visite_scn';
  if (isVisiteSpesialisName(nama)) return 'visite';
  if (isKonsultasiTeleponName(nama)) return 'konsultasi';
  return '';
}

/** `_get_spesialis_exact_name` (ranap_v3.py:10624). */
export function getSpesialisExactName(actionKey: unknown): string {
  return SPESIALIS_EXACT_NAMES[text(actionKey)] ?? '';
}

/** `_get_expected_spesialis_tarif` (ranap_v3.py:10615). */
export function getExpectedSpesialisTarif(roomClass: unknown): number {
  return SPESIALIS_TARIF_BY_CLASS[normalizeCareClassKey(roomClass)] ?? 0;
}

/**
 * `_get_spesialis_room_class` (ranap_v3.py:10602) — the class of the room the
 * charge belongs to. Source stay wins, then the owner stay, then the row itself.
 */
export function getSpesialisRoomClass(row: LegacyRow): string {
  const candidates = [row['_source_room_row'], row['_owner_room_row'], row];
  for (const candidate of candidates) {
    if (!isRecordLike(candidate)) continue;
    const roomClass = extractRoomClassKey(candidate);
    if (roomClass) return roomClass;
  }
  return '';
}

/** `_get_spesialis_fallback_kd_unit` (ranap_v3.py:10455). */
export function getSpesialisFallbackKdUnit(row: LegacyRow): string {
  const sourceRoom = row['_source_room_row'];
  const ownerRoom = row['_owner_room_row'];
  return (
    str(row, 'kd_unit') ||
    (isRecordLike(sourceRoom) ? str(sourceRoom, 'kd_unit') : '') ||
    (isRecordLike(ownerRoom) ? str(ownerRoom, 'kd_unit') : '')
  );
}

/**
 * `_preserve_spesialis_row` (ranap_v3.py:10464) — an anaesthetist's visite or
 * consultation is left completely alone: never deleted, never rewritten. (The
 * separate non-ICU rule in `_cleanup_spesialis_action_rows` fires only for rows
 * this predicate has *not* protected, i.e. `visite_scn`.)
 */
export function preserveSpesialisRow(row: LegacyRow): boolean {
  const actionKey = str(row, '_action_key');
  return (actionKey === 'visite' || actionKey === 'konsultasi') && row['_is_anest'] === true;
}

/**
 * `_looks_like_room_label_spesialis_pelaksana` (ranap_v3.py:10418) — is the
 * "doctor" on this row really the ward's own name? Both the source and owner
 * room names are segmented and matched against the performer.
 */
export function looksLikeRoomLabelSpesialisPelaksana(row: LegacyRow): boolean {
  const pelaksana = str(row, '_pelaksana');
  if (!pelaksana) return false;
  const pelaksanaKey = normalizeTextKey(pelaksana);
  if (!pelaksanaKey) return false;
  for (const roomName of [str(row, '_source_room_name'), str(row, '_owner_room_name')]) {
    for (const segment of extractRoomSegments(roomName)) {
      if (roomLabelMatchesSegment(pelaksana, segment)) return true;
      const segmentKey = normalizeTextKey(segment);
      if (segmentKey && pelaksanaKey === segmentKey) return true;
    }
  }
  return false;
}

/**
 * `_is_same_spesialis_row` (ranap_v3.py:10439) — identity by
 * `(no_transaksi, kd_tindakan, urut_tindakan, tgl_jam|tgl_transaksi)`.
 */
export function isSameSpesialisRow(left: unknown, right: unknown): boolean {
  if (!isRecordLike(left) || !isRecordLike(right)) return false;
  return (
    str(left, 'no_transaksi') === str(right, 'no_transaksi') &&
    str(left, 'kd_tindakan') === str(right, 'kd_tindakan') &&
    str(left, 'urut_tindakan') === str(right, 'urut_tindakan') &&
    str(left, 'tgl_jam', 'tgl_transaksi') === str(right, 'tgl_jam', 'tgl_transaksi')
  );
}

/**
 * `_needs_spesialis_room_relocation` (ranap_v3.py:10632) — consultations only,
 * and only when the stay the charge sits on is not the stay that owns its date.
 */
export function needsSpesialisRoomRelocation(row: LegacyRow): boolean {
  if (str(row, '_action_key') !== 'konsultasi') return false;
  const sourceRoom = row['_source_room_row'];
  const ownerRoom = row['_owner_room_row'];
  const sourceTrx =
    (isRecordLike(sourceRoom) ? str(sourceRoom, 'no_transaksi') : '') || str(row, 'no_transaksi');
  const ownerTrx = isRecordLike(ownerRoom) ? str(ownerRoom, 'no_transaksi') : '';
  const rowDate = str(row, '_row_date');
  return Boolean(sourceTrx && ownerTrx && rowDate && sourceTrx !== ownerTrx);
}

/**
 * `_needs_spesialis_tarif_repair` (ranap_v3.py:10644) — `visite` only. A row
 * with no price, or a room class with no expected tariff, is left alone.
 */
export function needsSpesialisTarifRepair(row: LegacyRow): boolean {
  if (str(row, '_action_key') !== 'visite') return false;
  const currentPrice = parseCurrencyInt(row['harga'], 0);
  if (currentPrice <= 0) return false;
  const expectedPrice = getExpectedSpesialisTarif(getSpesialisRoomClass(row));
  if (expectedPrice <= 0) return false;
  return currentPrice !== expectedPrice;
}

/**
 * `_needs_spesialis_name_repair` (ranap_v3.py:10656) — a `visite` whose name
 * merely *starts with* `VISITE DOKTER SPESIALIS` (e.g. a suffixed master-data
 * variant) is non-standard; the exact name is fine.
 */
export function needsSpesialisNameRepair(row: LegacyRow): boolean {
  if (str(row, '_action_key') !== 'visite') return false;
  const namaTindakan = collapseUpper(row['nama_tindakan']);
  if (!namaTindakan) return false;
  if (namaTindakan === 'VISITE DOKTER SPESIALIS') return false;
  return namaTindakan.startsWith('VISITE DOKTER SPESIALIS');
}

/** `_looks_like_v2_doctor_row` (ranap_v3.py:3088) — is this CPPT v2 row a doctor's note? */
export function looksLikeV2DoctorRow(row: LegacyRow): boolean {
  const jabatan = normalizeTextKey(row['jabatan_paramedis']);
  const nama = text(row['nama_paramedis']);
  if (jabatan.includes('DOKTER')) return true;
  return /\bDR\b|\bSP\b/i.test(nama);
}

// ---------------------------------------------------------------------------
// Performer lookups
// ---------------------------------------------------------------------------

/**
 * `_get_spesialis_pelaksana_name` (ranap_v3.py:10285) via
 * `_get_komponen_paramedis_name(row, kd_komponen="29")` (4264).
 *
 * `''` covers both of the Python's outcomes — no component-29 detail line at
 * all (`None`) and a line whose `nama_paramedis` is blank, `-`, `None` or
 * `null` — because the caller immediately does `str(nama or "").strip()`.
 */
export function getSpesialisPelaksanaName(
  row: LegacyRow,
  komponenDetailByRow?: Readonly<Record<string, unknown>>,
): string {
  const detailRows = rowsOf(komponenDetailByRow?.[komponenDetailKey(row)]).filter(
    (item) => str(item, 'kd_komponen') === SPESIALIS_KD_KOMPONEN,
  );
  if (detailRows.length === 0) return '';
  for (const item of detailRows) {
    const raw = item['nama_paramedis'];
    if (raw === null || raw === undefined) continue;
    const nama = text(raw);
    if (nama && nama !== '-' && !['NONE', 'NULL'].includes(compactTextKey(nama))) return nama;
  }
  return '';
}

/**
 * `_resolve_exact_paramedis_name` (ranap_v3.py:4347) — turn a display name into
 * the exact spelling in the unit's performer registry, because
 * `tampung_pelaksana` matches on the string.
 *
 * Exact (normalised) match wins; a *single* relaxed match is accepted; anything
 * ambiguous or unlisted falls back to the name as given.
 */
export function resolveExactParamedisName(
  desiredName: unknown,
  kdUnit = '',
  paramedisPelaksanaByKdUnit?: Readonly<Record<string, unknown>>,
): string {
  const rawName = text(desiredName);
  if (!rawName) return '';
  let options = rowsOf(paramedisPelaksanaByKdUnit?.[kdUnit || 'undefined']);
  if (options.length === 0 && kdUnit && kdUnit !== 'undefined') {
    options = rowsOf(paramedisPelaksanaByKdUnit?.['undefined']);
  }
  if (options.length === 0) return rawName;

  const desiredKey = normalizeParamedisDisplay(rawName);
  const exactMatches: string[] = [];
  const relaxedMatches: string[] = [];
  for (const item of options) {
    const namaParamedis = item['nama_paramedis'];
    if (!text(namaParamedis)) continue;
    if (normalizeParamedisDisplay(namaParamedis) === desiredKey) {
      exactMatches.push(String(namaParamedis));
      continue;
    }
    if (doctorNameMatchesRelaxed(namaParamedis, rawName)) relaxedMatches.push(String(namaParamedis));
  }
  if (exactMatches[0] !== undefined) return exactMatches[0];
  if (relaxedMatches.length === 1 && relaxedMatches[0] !== undefined) return relaxedMatches[0];
  return rawName;
}

// ---------------------------------------------------------------------------
// Patient / group metadata
// ---------------------------------------------------------------------------

/** Named arguments for {@link getPatientParamedisGroupInfo}. */
export interface GetPatientParamedisGroupInfoArgs {
  /** `no_rm` — carried only so the caller's fetch keys line up. */
  noRm?: string;
  /** The group's room rows; walked in `_normalize_room_stays` order. */
  roomRows: readonly LegacyRow[];
  /** `ambil_datakunjungan(no_rm, no_transaksi)` keyed by `no_transaksi`. */
  dataKunjunganByNoTransaksi?: Readonly<Record<string, unknown>>;
  /** `ambil_datatransaksi(...)` keyed by `no_transaksi` — the fallback. */
  dataTransaksiByNoTransaksi?: Readonly<Record<string, unknown>>;
  /** Passed through to `normalizeRoomStays`. */
  roomStayOptions?: RoomStayOptions;
}

/**
 * `_get_patient_paramedis_group_info` (ranap_v3.py:10218).
 *
 * Faithful quirk: `primary_name` is *overwritten* on every stay that names a
 * doctor, so the patient's own doctor is the one on the **last** stay in
 * `normalizeRoomStays` order — not the first, and not the most frequent.
 */
export function getPatientParamedisGroupInfo(
  args: GetPatientParamedisGroupInfoArgs,
): PatientParamedisGroupInfo {
  const stays = normalizeRoomStays(args.roomRows ?? [], args.roomStayOptions ?? {});
  const allNames: string[] = [];
  const allKeys = new Set<string>();
  let primaryName = '';
  let primaryKey = '';
  let patientName = '';

  const kunjunganOf = (trx: string): LegacyRow => {
    const dataInap = args.dataKunjunganByNoTransaksi?.[trx];
    if (isNonEmptyRow(dataInap)) return dataInap;
    const fallback = args.dataTransaksiByNoTransaksi?.[trx];
    return isNonEmptyRow(fallback) ? fallback : {};
  };

  for (const row of stays) {
    const noTransaksi = str(row, 'no_transaksi');
    if (!noTransaksi) continue;
    const dataInap = kunjunganOf(noTransaksi);
    if (!patientName) {
      patientName = str(dataInap, 'nama_pasien') || str(row, 'nama_pasien');
    }
    const namaParamedis = str(dataInap, 'nama_paramedis') || str(row, 'nama_paramedis');
    if (!namaParamedis || namaParamedis === '-') continue;
    const normalized = normalizeParamedisDisplay(namaParamedis);
    if (normalized && !allKeys.has(normalized)) {
      allNames.push(namaParamedis);
      allKeys.add(normalized);
    }
    primaryName = namaParamedis;
    primaryKey = normalized;
  }

  if (!primaryName && stays.length > 0) {
    // `sorted(..., key=tgl_masuk, reverse=True)[0]` — the latest admission.
    const latest = [...stays].sort(
      (left, right) =>
        (parseDateTimeFlexible(right['tgl_masuk'])?.getTime() ?? -Infinity) -
        (parseDateTimeFlexible(left['tgl_masuk'])?.getTime() ?? -Infinity),
    )[0];
    const fallbackTrx = latest ? str(latest, 'no_transaksi') : '';
    if (fallbackTrx) {
      // The Python skips `ambil_datakunjungan` here and goes straight to
      // `ambil_datatransaksi`; reproduced rather than "fixed".
      const fallbackData = args.dataTransaksiByNoTransaksi?.[fallbackTrx];
      const fallbackName = isNonEmptyRow(fallbackData) ? str(fallbackData, 'nama_paramedis') : '';
      const fallbackKey = normalizeParamedisDisplay(fallbackName);
      if (fallbackName && fallbackKey) {
        if (!allKeys.has(fallbackKey)) {
          allNames.push(fallbackName);
          allKeys.add(fallbackKey);
        }
        primaryName = fallbackName;
        primaryKey = fallbackKey;
      }
    }
  }

  return {
    allNames,
    allKeys,
    primaryName,
    primaryKey,
    patientName,
    isByny: isBynyPatient(patientName),
  };
}

// ---------------------------------------------------------------------------
// CPPT
// ---------------------------------------------------------------------------

/**
 * `_get_cppt_doctor_candidates_for_date` (ranap_v3.py:10297) — every doctor who
 * charted on `targetDate`. v1 is authoritative; v2 is only consulted when v1
 * returned nothing, and then only its doctor rows count.
 */
export function getCpptDoctorCandidatesForDate(
  noRm: unknown,
  noRegistrasikunjungan: unknown,
  targetDate: unknown,
  lookups: CpptLookups = {},
): CpptDoctorCandidates {
  const rm = text(noRm);
  const reg = text(noRegistrasikunjungan);
  const target = datePart(targetDate);
  if (!rm || !reg || !target) return { names: [], source: '', available: false };

  let rows = rowsOf(lookups.cpptV1RowsByNoReg?.[reg]);
  let source = 'v1';
  if (rows.length === 0) {
    rows = rowsOf(lookups.cpptV2RowsByNoReg?.[reg]);
    source = 'v2';
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (datePart(row['tgl_entry']) !== target) continue;
    const name = text(row['nama_paramedis']);
    if (!name) continue;
    if (source === 'v2' && !looksLikeV2DoctorRow(row)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return { names, source: rows.length > 0 ? source : '', available: rows.length > 0 };
}

/**
 * `_get_spesialis_v2_match_state` (ranap_v3.py:11382) over
 * `_get_evo_v1_doctor_date_match` (3192) and `_get_evo_v2_doctor_date_match`
 * (3282) — does the CPPT confirm that *this* doctor charted on this row's date?
 *
 * `state: null` means no CPPT was readable, which the Python treats as no
 * opinion (it never deletes on a `null`). The v1 filter does **not** apply
 * `_looks_like_v2_doctor_row`; the v2 filter does. Order matters.
 */
export function getSpesialisV2MatchState(
  row: LegacyRow,
  lookups: CpptLookups = {},
): SpesialisV2MatchState {
  const empty: SpesialisV2MatchState = { state: null, count: 0, names: [], source: '' };
  const rm = str(row, '_no_rm');
  const reg = str(row, 'no_registrasikunjungan');
  const doctorName = str(row, '_pelaksana');
  const target = str(row, '_row_date');
  if (!rm || !reg || !doctorName || !target) return empty;

  const probe = (rows: readonly LegacyRow[], source: string, requireDoctorRow: boolean) => {
    const matched = rows.filter((item) => {
      if (datePart(item['tgl_entry']) !== target) return false;
      if (requireDoctorRow && !looksLikeV2DoctorRow(item)) return false;
      return doctorNameMatchesRelaxed(doctorName, item['nama_paramedis']);
    });
    return {
      available: rows.length > 0,
      state: matched.length > 0,
      count: matched.length,
      names: matched.map((item) => text(item['nama_paramedis'])).filter(Boolean),
      source,
    };
  };

  let result = probe(rowsOf(lookups.cpptV1RowsByNoReg?.[reg]), 'v1', false);
  if (!result.available) result = probe(rowsOf(lookups.cpptV2RowsByNoReg?.[reg]), 'v2', true);
  if (!result.available) return empty;
  return {
    state: result.state,
    count: result.count,
    names: result.names,
    source: result.source || 'unknown',
  };
}

/** Named arguments for {@link pickCpptPelaksanaForEmptySpesialis}. */
export interface PickCpptPelaksanaArgs {
  /** The row whose performer is missing or invalid. */
  row: LegacyRow;
  /** Every specialist row in the group — the same-day cross-check pool. */
  rows: readonly LegacyRow[];
  /** `_get_patient_paramedis_group_info` output. */
  patientInfo?: PatientParamedisGroupInfo;
  /** CPPT reads. */
  lookups?: CpptLookups;
}

/**
 * `_pick_cppt_pelaksana_for_empty_spesialis` (ranap_v3.py:10327) — pick *the*
 * doctor, or nobody.
 *
 * The narrowing order is load-bearing and each step only commits on a unique
 * answer:
 *  1. no CPPT candidates → nobody;
 *  2. for `visite_scn`, a single paediatrician wins outright; several
 *     paediatricians narrow the pool (the rest are dropped);
 *  3. a single relaxed match against the patient's own doctor wins;
 *  4. a single relaxed match against a performer already on another row of the
 *     same action *and* the same date wins;
 *  5. otherwise a lone remaining candidate wins, else nobody.
 */
export function pickCpptPelaksanaForEmptySpesialis(args: PickCpptPelaksanaArgs): {
  name: string;
  info: CpptDoctorCandidates;
} {
  const { row } = args;
  const info = getCpptDoctorCandidatesForDate(
    row['_no_rm'],
    row['no_registrasikunjungan'],
    row['_row_date'],
    args.lookups ?? {},
  );
  let candidates = [...info.names];
  if (candidates.length === 0) return { name: '', info };

  const actionKey = str(row, '_action_key');
  const primaryName = text(args.patientInfo?.primaryName);
  if (actionKey === 'visite_scn') {
    const pediatricians = candidates.filter((name) => looksLikePediatricianName(name));
    if (pediatricians.length === 1 && pediatricians[0] !== undefined) {
      return { name: pediatricians[0], info };
    }
    if (pediatricians.length > 0) candidates = pediatricians;
  }

  if (primaryName) {
    const matchedPrimary = candidates.filter((name) => doctorNameMatchesRelaxed(name, primaryName));
    if (matchedPrimary.length === 1 && matchedPrimary[0] !== undefined) {
      return { name: matchedPrimary[0], info };
    }
  }

  const rowDate = str(row, '_row_date');
  const sameDayNames = (args.rows ?? [])
    .filter((item) => str(item, '_action_key') === actionKey && str(item, '_row_date') === rowDate)
    .map((item) => str(item, '_pelaksana'))
    .filter(Boolean);
  if (sameDayNames.length > 0) {
    const matchedSameDay = [
      ...new Set(
        candidates.filter((name) =>
          sameDayNames.some((existing) => doctorNameMatchesRelaxed(name, existing)),
        ),
      ),
    ];
    if (matchedSameDay.length === 1 && matchedSameDay[0] !== undefined) {
      return { name: matchedSameDay[0], info };
    }
  }

  if (candidates.length === 1 && candidates[0] !== undefined) return { name: candidates[0], info };
  return { name: '', info };
}

// ---------------------------------------------------------------------------
// Row collection and enrichment
// ---------------------------------------------------------------------------

/** Named arguments for {@link enrichRepairedSpesialisRow}. */
export interface EnrichRepairedSpesialisRowArgs {
  row: LegacyRow;
  noRm: unknown;
  noTransaksi: unknown;
  noReg: unknown;
  sourceRoomRow?: LegacyRow;
  ownerRoomRow?: LegacyRow;
  komponenDetailByRow?: Readonly<Record<string, unknown>>;
}

/**
 * `_enrich_repaired_spesialis_row` (ranap_v3.py:10667) — decorate a bare
 * tindakan row into a {@link SpesialisRow}. `ownerRoomRow` defaults to
 * `sourceRoomRow`, and `kd_unit`/`kd_unit_setting` fall back through row →
 * source → owner exactly as in the Python.
 */
export function enrichRepairedSpesialisRow(args: EnrichRepairedSpesialisRowArgs): SpesialisRow {
  const sourceRoomRow = isRecordLike(args.sourceRoomRow) ? args.sourceRoomRow : {};
  const ownerRoomRow = isRecordLike(args.ownerRoomRow) ? args.ownerRoomRow : sourceRoomRow;
  const base: LegacyRow = {
    ...args.row,
    _no_rm: text(args.noRm),
    no_transaksi: text(args.noTransaksi),
    no_registrasikunjungan: text(args.noReg),
    _action_key: getSpesialisActionKey(args.row),
    _row_date: datePart(str(args.row, 'tgl_jam', 'tgl_transaksi')),
    _source_room_row: { ...sourceRoomRow },
    _source_room_name: str(sourceRoomRow, 'nama_unit'),
    _owner_room_row: { ...ownerRoomRow },
    _owner_room_name: str(ownerRoomRow, 'nama_unit') || str(sourceRoomRow, 'nama_unit'),
    kd_unit:
      str(args.row, 'kd_unit') || str(sourceRoomRow, 'kd_unit') || str(ownerRoomRow, 'kd_unit'),
    kd_unit_setting:
      str(args.row, 'kd_unit_setting') ||
      str(sourceRoomRow, 'kd_unit_setting') ||
      str(ownerRoomRow, 'kd_unit_setting'),
  };
  const pelaksana = getSpesialisPelaksanaName(base, args.komponenDetailByRow);
  return {
    ...base,
    _pelaksana: pelaksana,
    _pelaksana_key: normalizeParamedisDisplay(pelaksana),
    _is_anest: isAnesthesiologistName(pelaksana),
  } as SpesialisRow;
}

/** Named arguments for {@link collectSpesialisRowsForGroup}. */
export interface CollectSpesialisRowsArgs {
  noRm: string;
  /** The group's room rows, in the order supplied (the Python does not normalise here). */
  roomRows: readonly LegacyRow[];
  /** `buildRoomDayAssignments` output: `no_transaksi` → owned `YYYY-MM-DD`s. */
  roomDayAssignments: Readonly<Record<string, readonly string[]>>;
  /** `get_listtindakan` payload keyed by the stay's `no_transaksi`. */
  listTindakanByNoTransaksi?: Readonly<Record<string, unknown>>;
  /** `getdetail_komponen_transaksi` payloads keyed by {@link komponenDetailKey}. */
  komponenDetailByRow?: Readonly<Record<string, unknown>>;
}

/**
 * `_collect_spesialis_rows_for_group` (ranap_v3.py:11339) — every specialist
 * charge on the group, decorated with its source stay, the stay that owns its
 * date, and its performer.
 *
 * A row whose date has no owner falls back to the stay it was found on, so
 * `_needs_spesialis_room_relocation` then compares a stay against itself and
 * declines — the legacy "leave it where it is" default.
 */
export function collectSpesialisRowsForGroup(args: CollectSpesialisRowsArgs): SpesialisRow[] {
  const ownerByDate = buildRoomOwnerByDate(args.roomRows ?? [], args.roomDayAssignments ?? {});
  const collected: SpesialisRow[] = [];
  for (const roomRow of args.roomRows ?? []) {
    const noTransaksi = str(roomRow, 'no_transaksi');
    const noReg = str(roomRow, 'no_registrasikunjungan');
    if (!noTransaksi || !noReg) continue;
    for (const row of rowsOf(args.listTindakanByNoTransaksi?.[noTransaksi])) {
      const actionKey = getSpesialisActionKey(row);
      if (!actionKey) continue;
      const rowDate = datePart(str(row, 'tgl_jam', 'tgl_transaksi'));
      const ownerRow = ownerByDate[rowDate] ?? roomRow;
      const pelaksana = getSpesialisPelaksanaName(
        { ...row, no_transaksi: noTransaksi },
        args.komponenDetailByRow,
      );
      collected.push({
        ...row,
        _no_rm: args.noRm,
        no_transaksi: noTransaksi,
        no_registrasikunjungan: noReg,
        _action_key: actionKey,
        _row_date: rowDate,
        _source_room_row: roomRow,
        _source_room_name: str(roomRow, 'nama_unit'),
        _owner_room_row: ownerRow,
        _owner_room_name: str(ownerRow, 'nama_unit') || str(roomRow, 'nama_unit'),
        _pelaksana: pelaksana,
        _pelaksana_key: normalizeParamedisDisplay(pelaksana),
        _is_anest: isAnesthesiologistName(pelaksana),
      } as SpesialisRow);
    }
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Duplicate resolution
// ---------------------------------------------------------------------------

/**
 * `_pick_spesialis_keep_row` (ranap_v3.py:11431) — of several rows that collide,
 * which one survives.
 *
 * Sort key, in order: performer is one of `preferredKeys` (the patient's own
 * doctors) → CPPT confirms the doctor charted that day → earliest
 * `tgl_jam`/`tgl_transaksi` (unreadable dates sort last, the Python's
 * `datetime.max`) → lowest `urut_tindakan` (missing sorts to 999999). Ties keep
 * input order, as Python's stable `sorted` does.
 */
export function pickSpesialisKeepRow(
  rows: readonly LegacyRow[],
  preferredKeys: ReadonlySet<string> = new Set(),
  lookups: CpptLookups = {},
): LegacyRow | undefined {
  const decorated = rows.map((row, index) => ({
    row,
    index,
    // `str(row.get("_pelaksana_key", ""))` — the Python defaults to `''` here,
    // unlike the patient/other split below which uses a bare `.get()`.
    preferred: preferredKeys.has(str(row, '_pelaksana_key')) ? 0 : 1,
    matched: getSpesialisV2MatchState(row, lookups).state === true ? 0 : 1,
    time: parseDateTimeFlexible(str(row, 'tgl_jam', 'tgl_transaksi'))?.getTime() ?? Infinity,
    urut: safeInt(row['urut_tindakan'], 999999),
  }));
  decorated.sort(
    (left, right) =>
      left.preferred - right.preferred ||
      left.matched - right.matched ||
      left.time - right.time ||
      left.urut - right.urut ||
      left.index - right.index,
  );
  return decorated[0]?.row;
}

/**
 * `_log_spesialis_v2_fallback` (ranap_v3.py:11406) — the debug line printed
 * immediately before `_pick_spesialis_keep_row` ranks a set of colliding rows.
 *
 * It changes no decision; it exposes the CPPT evidence the second sort key is
 * about to use, so an operator can see *why* one duplicate survived. The three
 * guards are the Python's own and all of them matter:
 *
 *  1. fewer than two rows — nothing collided, so there is nothing to explain;
 *  2. every candidate's match state is `null` — no CPPT was readable at all, so
 *     the line would say `unknown` for everything and mean nothing;
 *  3. `DEBUG_MODE` — the caller's gate, not this function's.
 *
 * Returns `undefined` when the line must not be printed. `source` is the sorted,
 * comma-joined set of every candidate's match source (`v1`, `v2`, `unknown`),
 * exactly as the Python joins it — a mixed group really does print `v1,v2`.
 */
export function spesialisV2FallbackLine(
  rows: readonly LegacyRow[],
  lookups: CpptLookups = {},
): string | undefined {
  if ((rows ?? []).length < 2) return undefined;
  const infoParts: string[] = [];
  const sourceParts = new Set<string>();
  let hasKnownState = false;
  for (const row of rows) {
    const match = getSpesialisV2MatchState(row, lookups);
    if (match.state !== null) hasKnownState = true;
    // `str(row.get("_cppt_doctor_date_match_source") or "unknown")` — the Python
    // reads the field the state getter caches, which is `''` (→ `unknown`)
    // whenever no CPPT was readable.
    sourceParts.add(match.source || 'unknown');
    const state = match.state === true ? 'ya' : match.state === false ? 'tidak' : 'unknown';
    infoParts.push(`${str(row, '_pelaksana') || '-'}@${str(row, '_row_date') || '-'}=${state}`);
  }
  if (!hasKnownState) return undefined;
  const sample = rows[0] ?? {};
  return (
    `  - Fallback visite CPPT | reg=${str(sample, 'no_registrasikunjungan') || '-'} | ` +
    `aksi=${str(sample, '_action_key') || '-'} | ` +
    `source=${[...sourceParts].sort().join(',') || '-'} | kandidat=${infoParts.join(' || ')}`
  );
}

/** The Python's keep-row identity test: same `urut_tindakan` *and* `no_transaksi`. */
function isKeepRow(row: LegacyRow, keepRow: LegacyRow | undefined): boolean {
  if (!keepRow) return false;
  return (
    rawString(row['urut_tindakan']) === rawString(keepRow['urut_tindakan']) &&
    rawString(row['no_transaksi']) === rawString(keepRow['no_transaksi'])
  );
}

// ---------------------------------------------------------------------------
// Delete gate
// ---------------------------------------------------------------------------

/** `_row_allows_delete_by_hint` (ranap_v3.py:12270). */
export function rowAllowsDeleteByHint(row: LegacyRow): boolean {
  if (['1', 'true'].includes(text(row['flag']).toLowerCase())) return false;
  const statusVerifikasiHint = text(row['status_verifikasi']);
  if (statusVerifikasiHint && !FALSEY_STATUS_KEYS.includes(statusVerifikasiHint)) return false;
  const statusBayar = compactTextKey(row['status_bayar']);
  if (statusBayar && !UNPAID_STATUS_BAYAR_KEYS.includes(statusBayar)) return false;
  const jenisBayar = compactTextKey(row['nama_jenispembayaran'] ?? row['jenis_bayar']);
  if (jenisBayar && !UNPAID_JENIS_BAYAR_KEYS.includes(jenisBayar)) return false;
  return true;
}

/**
 * `_boleh_hapus_tindakan` (ranap_v3.py:12307) — may this row be deleted at all?
 *
 * Check order matters and each early return is a refusal:
 *  1. a protected charge name is never deletable;
 *  2. the row's own paid/verified hints must allow it;
 *  3. it must not be verified — and because a plan never writes, the legacy
 *     `batal_verifikasi`-then-retry escape hatch is unavailable, exactly as
 *     under `DRY_RUN`, so a verified row is refused;
 *  4. a fully "nothing paid, nothing verified" hint set passes without a probe;
 *  5. otherwise `cekstatusbayar` must come back `''` or `'0'`. With no
 *     `statusBayarByTindakan` entry the lookup reads as `''`, i.e. unpaid —
 *     the same default the Python gets from an empty response body.
 */
export function bolehHapusSpesialisRow(row: LegacyRow, lookups: DeleteGateLookups = {}): boolean {
  if (isProtectedNonDeletableCharge(row['nama_tindakan'])) return false;
  if (!rowAllowsDeleteByHint(row)) return false;

  const statusVerifikasiHint = text(row['status_verifikasi']);
  if (!FALSEY_STATUS_KEYS.includes(statusVerifikasiHint)) {
    const probed = text(lookups.statusVerifikasiByTindakan?.[tindakanStatusKey(row)]);
    if (!['', '0'].includes(probed)) return false;
  }

  const statusHint = text(row['status']);
  const statusBayarHint = compactTextKey(row['status_bayar']);
  const jenisBayarHint = compactTextKey(row['nama_jenispembayaran'] ?? row['jenis_bayar']);
  if (
    FALSEY_STATUS_KEYS.includes(statusHint) &&
    (!statusBayarHint || UNPAID_STATUS_BAYAR_KEYS.includes(statusBayarHint)) &&
    (!jenisBayarHint || UNPAID_JENIS_BAYAR_KEYS.includes(jenisBayarHint))
  ) {
    return true;
  }
  return ['', '0'].includes(text(lookups.statusBayarByTindakan?.[tindakanStatusKey(row)]));
}

// ---------------------------------------------------------------------------
// Master metadata
// ---------------------------------------------------------------------------

/**
 * The specialist branches of `_pick_tindakan_meta` (ranap_v3.py:9296) — the
 * master row that supplies `kd_tindakan` and `harga` for an add.
 *
 * For `VISITE DOKTER SPESIALIS` the comparison is on the *collapsed* uppercase
 * name (so a double-spaced master row still matches); for every other exact
 * name it is the Python's plain `strip().upper()`. In both cases the master
 * list is searched before the transaction's own list.
 */
export function pickSpesialisTindakanMeta(
  masterRows: readonly LegacyRow[],
  listRows: readonly LegacyRow[],
  exactName: string,
): LegacyRow | undefined {
  const target = text(exactName).toUpperCase();
  if (!target) return undefined;
  if (target === 'VISITE DOKTER SPESIALIS') {
    for (const row of masterRows) {
      if (collapseUpper(row['nama_tindakan']) === target) return row;
    }
    for (const row of listRows) {
      if (collapseUpper(row['nama_tindakan']) === target) return row;
    }
    return undefined;
  }
  for (const row of masterRows) {
    if (text(row['nama_tindakan']).toUpperCase() === target) return row;
  }
  for (const row of listRows) {
    if (text(row['nama_tindakan']).toUpperCase() === target) return row;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The operation union
// ---------------------------------------------------------------------------

/**
 * The six writes the legacy repair set performs.
 *
 *  - `setPelaksana` — `tampung_pelaksana_tindakan`: fill or replace the
 *    performing specialist (component 29), sourced from the CPPT notes or from
 *    the patient's own attending doctor.
 *  - `hapus` — `hapus_tindakan_inap`: delete a specialist row.
 *  - `tambah` — `tambah_tindakan_polis`: add the missing
 *    `VISITE DOKTER SPESIALIS` for the patient's own doctor
 *    (`_ensure_primary_patient_visite`).
 *  - `updateTgl` — `update_tgl_tindakan_inap`: restore a row's date after it was
 *    re-added.
 *  - `repairTarif` — `tambah_tindakan_polis` re-adding a `visite` with the
 *    corrected tariff (`_repair_wrong_tarif_spesialis_row`) or the corrected
 *    canonical action name (`_repair_nonstandard_visite_spesialis_row`); always
 *    preceded by the `hapus` of the row it replaces.
 *  - `relocateRoom` — `tambah_tindakan_polis` re-adding the charge under the
 *    stay that owns its date (`_repair_spesialis_wrong_room_row`); always
 *    followed by the `hapus` of the source row.
 */
export type VisiteOpKind =
  | 'setPelaksana'
  | 'hapus'
  | 'tambah'
  | 'updateTgl'
  | 'repairTarif'
  | 'relocateRoom';

/** One intended write. Exactly one endpoint call. */
export interface VisiteOp {
  kind: VisiteOpKind;
  /** The `evomedis-client` endpoint id this op fires. */
  endpointId: string;
  /** Transaction the op writes to — the *target* stay for `relocateRoom`. */
  noTransaksi: string;
  /** Registration the op writes to — the *target* stay for `relocateRoom`. */
  noRegistrasikunjungan: string;
  /**
   * The existing billing row involved. The target for `hapus` and for a
   * `setPelaksana` on an already-present row; the row being *replaced* (audit
   * anchor only) for `repairTarif`/`relocateRoom`; absent for `tambah` and for
   * any op against a row this plan has not seen yet.
   */
  row?: LegacyRow;
  /** `kd_tindakan`: the row's own for `hapus`, the master metadata's for an add. */
  kdTindakan?: string;
  /** `urut_tindakan` — absent on an add, because the backend assigns it. */
  urutTindakan?: string;
  /** `tgl_jam` of the row being deleted (`hapus_tindakan_inap` needs it). */
  tglJam?: string;
  /** `_build_update_datetime(...)` target for `updateTgl`. */
  targetDatetime?: string;
  /** Performer name for `setPelaksana`, already resolved to the registry spelling. */
  pelaksana?: string;
  /** `kd_komponen` — always `'29'` for `setPelaksana`. */
  kdKomponen?: string;
  /** For `repairTarif` / `relocateRoom` / `tambah`: the corrected action name. */
  correctedNamaTindakan?: string;
  /** The corrected tariff as an integer. */
  correctedHarga?: number;
  /**
   * The tariff string the Python actually puts on the wire, verbatim. The
   * backend is fed a string and the legacy call sites are inconsistent about
   * whether it is parsed first, so both forms are carried.
   */
  correctedHargaRaw?: string;
  /** The room class the corrected charge belongs to. */
  correctedRoomClass?: string;
  /** `kd_unit` for the add payload. */
  kdUnit?: string;
  /** `kd_kamarperawatan` for the add payload. */
  kdKamarperawatan?: string;
  /** `kd_detkelpenjamin` for the add payload; `'15'` when the row has none. */
  kdDetkelpenjamin?: string;
  /** `kd_paramedis` for the add payload, from the kunjungan/transaksi record. */
  kdParamedis?: string;
  /**
   * `sequence` of the op that creates the row this op targets. Set on the
   * `updateTgl`/`setPelaksana` follow-ups of an add: the new row's
   * `urut_tindakan` is server-assigned, so the executor must re-read
   * `get_listtindakan` to resolve it — which is what the Python does.
   */
  dependsOnSequence?: number;
  /** Operator-facing Indonesian reason, in the legacy log's wording. */
  reason: string;
  /** 1-based position in the Python's own execution order. */
  sequence: number;
}

/** A row the planner deliberately did not touch, and why. */
export interface VisiteUntouchedRow {
  row: LegacyRow;
  reason: string;
}

/** `_register_sync_issue` / the `[WARN]` prints, as structured output. */
export interface VisiteIssue {
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
}

/**
 * `sinkronkan_visite_konsultasi_spesialis_group`'s result, as a plan.
 *
 * `status` mirrors the Python's own return value with one addition:
 *  - `'ok'` — nothing to do (`{"status": "ok"}`);
 *  - `'changed'` — every op here is fully specified and can be executed as-is;
 *  - `'incomplete'` — the Python's `{"status": "incomplete"}`. Reached when the
 *    iteration cap is hit, or when the plan contains an add whose created row
 *    cannot be named. Execute what is here, then re-read and re-plan.
 */
/**
 * The operator-facing checklist of what the plan decided: one line per existing
 * specialist charge (kept ✓, or ✗ with the op that removes it / the reason it
 * cannot), plus whether the patient's own doctor (DPJP) has a visite. Lines a
 * write will fix name that op by `sequence`, so the UI can link it to its plan.
 */
export interface VisiteReasoning {
  title: string;
  items: Array<{ label: string; ok: boolean | null; detail?: string; opSequence?: number }>;
}

export interface VisiteSyncPlan {
  noRegistrasikunjungan: string;
  ops: VisiteOp[];
  untouched: VisiteUntouchedRow[];
  issues: VisiteIssue[];
  lines: string[];
  status: 'ok' | 'changed' | 'incomplete';
  reasoning?: VisiteReasoning;
}

/** Named arguments for {@link planVisiteSync}. Every field is a hoisted read. */
export interface PlanVisiteSyncArgs {
  /** `no_rm` — the group's patient. */
  noRm: string;
  /** The group's room rows (one per stay). */
  roomRows: readonly LegacyRow[];
  /** `buildRoomDayAssignments` output: `no_transaksi` → owned `YYYY-MM-DD`s. */
  roomDayAssignments: Readonly<Record<string, readonly string[]>>;
  /**
   * Override for the dates a specialist charge may sit on. Defaults to the
   * union of `roomDayAssignments`' values, which is what the Python computes.
   */
  allowedDates?: readonly string[];
  /** `get_listtindakan` payload keyed by the stay's `no_transaksi`. */
  listTindakanByNoTransaksi?: Readonly<Record<string, unknown>>;
  /** `getdetail_komponen_transaksi` payload keyed by {@link komponenDetailKey}. */
  komponenDetailByRow?: Readonly<Record<string, unknown>>;
  /** `ambil_master_tindakan_*` payload keyed by the stay's `no_transaksi`. */
  masterTindakanByNoTransaksi?: Readonly<Record<string, unknown>>;
  /** `ambil_paramedis_pelaksana(kd_unit)` payload keyed by `kd_unit` (plus `'undefined'`). */
  paramedisPelaksanaByKdUnit?: Readonly<Record<string, unknown>>;
  /** `ambil_datakunjungan(no_rm, no_transaksi)` keyed by `no_transaksi`. */
  dataKunjunganByNoTransaksi?: Readonly<Record<string, unknown>>;
  /** `ambil_datatransaksi(...)` keyed by `no_transaksi`. */
  dataTransaksiByNoTransaksi?: Readonly<Record<string, unknown>>;
  /** `get_evo_v1_cppt_rows` keyed by `no_registrasikunjungan`. */
  cpptV1RowsByNoReg?: Readonly<Record<string, unknown>>;
  /** `get_evo_v2_cppt_rows` keyed by `no_registrasikunjungan`. */
  cpptV2RowsByNoReg?: Readonly<Record<string, unknown>>;
  /** `cekstatusbayar_tindakan` keyed by {@link tindakanStatusKey}. */
  statusBayarByTindakan?: Readonly<Record<string, unknown>>;
  /** `cekstatus_verifikasi_tindakan` keyed by {@link tindakanStatusKey}. */
  statusVerifikasiByTindakan?: Readonly<Record<string, unknown>>;
  /** Passed to `normalizeRoomStays` when resolving the patient's doctor. */
  roomStayOptions?: RoomStayOptions;
  /** `max_iterations = 20`; lower it only in tests. */
  maxIterations?: number;
  /**
   * `DEBUG_MODE` (`RanapInput.debugMode`). Gates
   * {@link spesialisV2FallbackLine} exactly as `_log_spesialis_v2_fallback`
   * gates itself (ranap_v3.py:11407) — debug-only output, no decision.
   */
  debug?: boolean;
  /**
   * `_build_update_datetime` stamps the current wall clock onto the target
   * date, so the one clock read in the whole flow is injected here.
   */
  now?: Date;
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/** A row in the simulated working set. */
interface WorkRow {
  row: SpesialisRow;
  removed: boolean;
}

/** Endpoint ids the ops target, resolved once. */
const ENDPOINT = {
  hapus: 'penatajasaInap.hapusTindakan',
  tambah: 'penatajasaInap.tambahTindakanPolis',
  updateTgl: 'penatajasaInap.updateTgl',
  tampungPelaksana: 'poliklinik.tampungPelaksana',
} as const;

/**
 * `sinkronkan_visite_konsultasi_spesialis_group` (ranap_v3.py:11982) as a
 * planner.
 *
 * The legacy loop re-reads every specialist row, runs four phases in a fixed
 * order — consultation/visite same-day dedup, then `visite_scn`, `visite` and
 * `konsultasi` cleanup — and restarts from the top as soon as any phase changes
 * something, up to 20 times. Only when nothing changes does it add the
 * patient's own visite.
 *
 * This port runs that same loop over a *simulated* row set: each emitted op's
 * effect is applied locally (a deleted row leaves the set, a filled performer
 * is written back, an added row is assumed into existence) so the full ordered
 * script comes out of a single pass. `ops` is therefore in the Python's own
 * execution order, and `sequence` is that order made explicit.
 */
export function planVisiteSync(args: PlanVisiteSyncArgs): VisiteSyncPlan {
  const roomRows = args.roomRows ?? [];
  const noReg = str(roomRows[0], 'no_registrasikunjungan');
  const cpptLookups: CpptLookups = {
    cpptV1RowsByNoReg: args.cpptV1RowsByNoReg,
    cpptV2RowsByNoReg: args.cpptV2RowsByNoReg,
  };
  const deleteGate: DeleteGateLookups = {
    statusBayarByTindakan: args.statusBayarByTindakan,
    statusVerifikasiByTindakan: args.statusVerifikasiByTindakan,
  };

  const ops: VisiteOp[] = [];
  const untouched: VisiteUntouchedRow[] = [];
  const issues: VisiteIssue[] = [];
  const lines: string[] = [];
  let assumedCreate = false;

  /**
   * `_log_spesialis_v2_fallback(rows, preferred_keys)` — printed immediately
   * before each `_pick_spesialis_keep_row` call (ranap_v3.py:11433), and only
   * there: the total-quota sort at 11715 uses the same match state but the
   * Python does not log it.
   */
  const logV2Fallback = (rows: readonly LegacyRow[]): void => {
    if (args.debug !== true) return;
    const line = spesialisV2FallbackLine(rows, cpptLookups);
    if (line) lines.push(line);
  };

  if (roomRows.length === 0) {
    return { noRegistrasikunjungan: noReg, ops, untouched, issues, lines, status: 'ok' };
  }

  const patientInfo = getPatientParamedisGroupInfo({
    noRm: args.noRm,
    roomRows,
    dataKunjunganByNoTransaksi: args.dataKunjunganByNoTransaksi,
    dataTransaksiByNoTransaksi: args.dataTransaksiByNoTransaksi,
    roomStayOptions: args.roomStayOptions,
  });
  lines.push('+ Data:');
  lines.push(`   - Dokter pasien : ${patientInfo.primaryName || '-'}`);
  if (patientInfo.allNames.length > 1) {
    lines.push(`   - Kandidat lain : ${patientInfo.allNames.join(', ')}`);
  }

  const allowedDates = new Set(
    (args.allowedDates ?? Object.values(args.roomDayAssignments ?? {}).flatMap((dates) => [...dates]))
      .map((date) => text(date))
      .filter(Boolean),
  );

  // ── working set ────────────────────────────────────────────────
  const works: WorkRow[] = collectSpesialisRowsForGroup({
    noRm: args.noRm,
    roomRows,
    roomDayAssignments: args.roomDayAssignments ?? {},
    listTindakanByNoTransaksi: args.listTindakanByNoTransaksi,
    komponenDetailByRow: args.komponenDetailByRow,
  }).map((row) => ({ row, removed: false }));

  const live = (): SpesialisRow[] => works.filter((work) => !work.removed).map((work) => work.row);
  const findWork = (row: LegacyRow): WorkRow | undefined =>
    works.find((work) => !work.removed && (work.row === row || isSameSpesialisRow(work.row, row)));

  const emit = (op: Omit<VisiteOp, 'sequence'>): VisiteOp => {
    const stamped: VisiteOp = { ...op, sequence: ops.length + 1 };
    ops.push(stamped);
    return stamped;
  };
  // The legacy loop re-logs a skip on every iteration; the plan reports each
  // distinct one once so the operator sees a set, not a transcript.
  const seenIssues = new Set<string>();
  const note = (level: VisiteIssue['level'], message: string): void => {
    const key = `${level}|${message}`;
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    issues.push({ level, message });
  };
  const seenUntouched = new Set<string>();
  const skip = (row: LegacyRow, reason: string): void => {
    const key = `${komponenDetailKey(row)}|${reason}`;
    if (seenUntouched.has(key)) return;
    seenUntouched.add(key);
    untouched.push({ row, reason });
  };

  const masterRowsOf = (trx: string): LegacyRow[] => rowsOf(args.masterTindakanByNoTransaksi?.[trx]);
  const listRowsOf = (trx: string): LegacyRow[] => rowsOf(args.listTindakanByNoTransaksi?.[trx]);
  const kunjunganOf = (trx: string): LegacyRow => {
    const dataInap = args.dataKunjunganByNoTransaksi?.[trx];
    if (isNonEmptyRow(dataInap)) return dataInap;
    const fallback = args.dataTransaksiByNoTransaksi?.[trx];
    return isNonEmptyRow(fallback) ? fallback : {};
  };

  // ── `_hapus_spesialis_row` (ranap_v3.py:11446) ─────────────────
  const hapusSpesialisRow = (row: SpesialisRow, reason: string): boolean => {
    const noTransaksi = str(row, 'no_transaksi');
    const label = `${str(row, '_action_key') || 'spesialis'} spesialis`;
    if (row['_synthetic'] === true) {
      // Not a legacy branch: this row exists only in the simulation, so its
      // real `urut_tindakan` is unknown and a delete cannot be addressed.
      skip(row, `${reason}; row hasil tambah belum bisa dialamatkan sebelum re-read`);
      note(
        'WARN',
        `Tidak bisa hapus ${label} hasil tambah pada plan yang sama | reg=${str(row, 'no_registrasikunjungan') || '-'} | tanggal=${str(row, '_row_date') || '-'} | alasan=${reason}`,
      );
      return false;
    }
    if (!bolehHapusSpesialisRow(row, deleteGate)) {
      skip(row, `${reason}; sudah bayar / verifikasi`);
      lines.push(
        `  - Skip hapus ${label} | trx=${noTransaksi || '-'} | reg=${str(row, 'no_registrasikunjungan') || '-'} | tanggal=${str(row, '_row_date') || '-'} | pelaksana=${str(row, '_pelaksana') || '-'} | alasan=${reason}; sudah bayar / verifikasi`,
      );
      return false;
    }
    emit({
      kind: 'hapus',
      endpointId: ENDPOINT.hapus,
      noTransaksi,
      noRegistrasikunjungan: str(row, 'no_registrasikunjungan'),
      row,
      kdTindakan: str(row, 'kd_tindakan'),
      urutTindakan: str(row, 'urut_tindakan'),
      tglJam: str(row, 'tgl_jam'),
      reason,
    });
    lines.push(
      `  - Hapus ${label} | trx=${noTransaksi || '-'} | reg=${str(row, 'no_registrasikunjungan') || '-'} | tanggal=${str(row, '_row_date') || '-'} | pelaksana=${str(row, '_pelaksana') || '-'} | alasan=${reason} | row=[${rowLogLabel(row)}]`,
    );
    const work = findWork(row);
    if (work) work.removed = true;
    return true;
  };

  // ── `_tampung_pelaksana_checked` on an existing row ────────────
  const setPelaksanaOnRow = (row: SpesialisRow, desiredName: string, logTitle: string): boolean => {
    if (row['_synthetic'] === true) {
      // Same limitation as the delete guard: a row this plan only assumed into
      // existence has no addressable `urut_tindakan` yet.
      note(
        'WARN',
        `Tidak bisa tampung pelaksana pada row hasil tambah dalam plan yang sama | reg=${str(row, 'no_registrasikunjungan') || '-'} | tanggal=${str(row, '_row_date') || '-'} | pelaksana=${desiredName || '-'}`,
      );
      return false;
    }
    const fallbackKdUnit = getSpesialisFallbackKdUnit(row);
    const resolved = resolveExactParamedisName(
      desiredName,
      fallbackKdUnit,
      args.paramedisPelaksanaByKdUnit,
    );
    emit({
      kind: 'setPelaksana',
      endpointId: ENDPOINT.tampungPelaksana,
      noTransaksi: str(row, 'no_transaksi'),
      noRegistrasikunjungan: str(row, 'no_registrasikunjungan'),
      row,
      kdTindakan: str(row, 'kd_tindakan'),
      urutTindakan: str(row, 'urut_tindakan'),
      pelaksana: resolved,
      kdKomponen: SPESIALIS_KD_KOMPONEN,
      kdUnit: fallbackKdUnit,
      reason: logTitle,
    });
    lines.push(
      `  - ${logTitle} | trx=${str(row, 'no_transaksi') || '-'} | reg=${str(row, 'no_registrasikunjungan') || '-'} | tanggal=${str(row, '_row_date') || '-'} | pelaksana=${resolved || '-'} | row=[${rowLogLabel(row)}]`,
    );
    // `_tampung_pelaksana_checked` returns ok/confirmed under DRY_RUN, so the
    // write is assumed to have landed; the simulated row is updated in place.
    const work = findWork(row);
    if (work) {
      work.row = {
        ...work.row,
        _pelaksana: resolved,
        _pelaksana_key: normalizeParamedisDisplay(resolved),
        _is_anest: isAnesthesiologistName(resolved),
      } as SpesialisRow;
    }
    return true;
  };

  /**
   * The add → re-date → set-performer triple every repair ends with. `kind` is
   * the semantic label of the add leg; the two follow-ups point back at it via
   * `dependsOnSequence` because the created row cannot be named yet.
   */
  const emitCreateTriple = (params: {
    kind: 'tambah' | 'repairTarif' | 'relocateRoom';
    row?: SpesialisRow;
    noTransaksi: string;
    noReg: string;
    kdTindakan: string;
    kdUnit: string;
    kdKamar: string;
    kdDetkelpenjamin: string;
    kdParamedis: string;
    namaTindakan: string;
    harga: number;
    hargaRaw: string;
    roomClass: string;
    targetDate: string;
    sourceDateTime: string;
    desiredName: string;
    addReason: string;
    updateReason: string;
    pelaksanaReason: string;
    ownerRoomRow: LegacyRow;
    sourceRoomRow: LegacyRow;
  }): void => {
    const addOp = emit({
      kind: params.kind,
      endpointId: ENDPOINT.tambah,
      noTransaksi: params.noTransaksi,
      noRegistrasikunjungan: params.noReg,
      ...(params.row ? { row: params.row } : {}),
      kdTindakan: params.kdTindakan,
      correctedNamaTindakan: params.namaTindakan,
      correctedHarga: params.harga,
      correctedHargaRaw: params.hargaRaw,
      correctedRoomClass: params.roomClass,
      kdUnit: params.kdUnit,
      kdKamarperawatan: params.kdKamar,
      kdDetkelpenjamin: params.kdDetkelpenjamin,
      kdParamedis: params.kdParamedis,
      reason: params.addReason,
    });
    assumedCreate = true;
    lines.push(
      `  - Tambah ${params.namaTindakan.toLowerCase()} | trx=${params.noTransaksi} | reg=${params.noReg} | tanggal=${params.targetDate} | kd_tindakan=${params.kdTindakan || '-'} | harga=${params.hargaRaw || '-'} | alasan=${params.addReason}`,
    );

    const targetDatetime = buildUpdateDateTime(
      params.targetDate,
      params.sourceDateTime,
      SPESIALIS_UPDATE_DEFAULT_TIME,
      args.now ?? new Date(),
    );
    emit({
      kind: 'updateTgl',
      endpointId: ENDPOINT.updateTgl,
      noTransaksi: params.noTransaksi,
      noRegistrasikunjungan: params.noReg,
      kdTindakan: params.kdTindakan,
      targetDatetime,
      dependsOnSequence: addOp.sequence,
      reason: params.updateReason,
    });
    lines.push(
      `  - Update tanggal ${params.namaTindakan.toLowerCase()} | trx=${params.noTransaksi} | reg=${params.noReg} | target=${targetDatetime} | alasan=${params.updateReason}`,
    );

    if (params.desiredName) {
      const resolved = resolveExactParamedisName(
        params.desiredName,
        params.kdUnit,
        args.paramedisPelaksanaByKdUnit,
      );
      emit({
        kind: 'setPelaksana',
        endpointId: ENDPOINT.tampungPelaksana,
        noTransaksi: params.noTransaksi,
        noRegistrasikunjungan: params.noReg,
        kdTindakan: params.kdTindakan,
        pelaksana: resolved,
        kdKomponen: SPESIALIS_KD_KOMPONEN,
        kdUnit: params.kdUnit,
        correctedHargaRaw: params.hargaRaw,
        dependsOnSequence: addOp.sequence,
        reason: params.pelaksanaReason,
      });
      lines.push(
        `  - ${params.pelaksanaReason} | trx=${params.noTransaksi} | reg=${params.noReg} | tanggal=${params.targetDate} | pelaksana=${resolved || '-'}`,
      );
    }

    // Assume the add landed, so the loop converges and
    // `_ensure_primary_patient_visite` sees the row the Python's write run would
    // have re-read. `urut_tindakan` is unknown, hence `_synthetic`.
    const created = enrichRepairedSpesialisRow({
      row: {
        nama_tindakan: params.namaTindakan,
        kd_tindakan: params.kdTindakan,
        urut_tindakan: '',
        harga: String(params.harga || params.hargaRaw),
        tgl_jam: targetDatetime,
        _synthetic: true,
      },
      noRm: args.noRm,
      noTransaksi: params.noTransaksi,
      noReg: params.noReg,
      sourceRoomRow: params.sourceRoomRow,
      ownerRoomRow: params.ownerRoomRow,
    });
    works.push({
      row: {
        ...created,
        _row_date: params.targetDate,
        _pelaksana: params.desiredName,
        _pelaksana_key: normalizeParamedisDisplay(params.desiredName),
        _is_anest: isAnesthesiologistName(params.desiredName),
        _synthetic: true,
      } as SpesialisRow,
      removed: false,
    });
  };

  // ── `_try_fill_spesialis_pelaksana_from_cppt` (10374) ──────────
  const tryFillPelaksanaFromCppt = (row: SpesialisRow, rows: readonly SpesialisRow[]): boolean => {
    const { name, info } = pickCpptPelaksanaForEmptySpesialis({
      row,
      rows,
      patientInfo,
      lookups: cpptLookups,
    });
    const actionKey = str(row, '_action_key');
    const label = SPESIALIS_ACTION_LABELS[actionKey] ?? 'spesialis';
    if (!name) {
      note(
        'INFO',
        `CPPT tidak cukup untuk isi pelaksana spesialis | reg=${str(row, 'no_registrasikunjungan') || '-'} | aksi=${actionKey || '-'} | tanggal=${str(row, '_row_date') || '-'} | source=${info.source || '-'} | kandidat=${info.names.join(',') || '-'}`,
      );
      return false;
    }
    return setPelaksanaOnRow(row, name, `Isi pelaksana ${label} dari CPPT`);
  };

  // ── `_repair_spesialis_visite_from_cppt_or_delete` (10471) ─────
  const repairVisiteFromCpptOrDelete = (
    row: SpesialisRow,
    rows: readonly SpesialisRow[],
  ): boolean => {
    if (preserveSpesialisRow(row)) return false;
    const actionKey = str(row, '_action_key');
    if (actionKey !== 'visite' && actionKey !== 'visite_scn') return false;

    const rowDate = str(row, '_row_date');
    const label = actionKey === 'visite' ? 'visite dokter spesialis' : 'visite dr anak scn';
    const pelaksanaKey = str(row, '_pelaksana_key');
    const invalidPelaksana = !pelaksanaKey || looksLikeRoomLabelSpesialisPelaksana(row);

    if (invalidPelaksana) {
      const { name, info } = pickCpptPelaksanaForEmptySpesialis({
        row,
        rows,
        patientInfo,
        lookups: cpptLookups,
      });
      if (name) return setPelaksanaOnRow(row, name, `Ganti pelaksana ${label} dari CPPT`);
      const reason =
        info.names.length > 0
          ? `pelaksana ${label} tidak valid dan kandidat dokter CPPT tidak tunggal (${candidatePreview(info.names)})`
          : `pelaksana ${label} tidak valid dan tidak ada dokter CPPT pada tanggal ${rowDate || '-'}`;
      return hapusSpesialisRow(row, reason);
    }

    const match = getSpesialisV2MatchState(row, cpptLookups);
    if (match.state === false) {
      note(
        'INFO',
        `Toleransi mismatch CPPT untuk ${label} | trx=${str(row, 'no_transaksi') || '-'} | reg=${str(row, 'no_registrasikunjungan') || '-'} | tanggal=${rowDate || '-'} | pelaksana=${str(row, '_pelaksana') || '-'} | source=${match.source || '-'} | kandidat=${candidatePreview(match.names)} | alasan=CPPT bukan rujukan utama jika rule visite sudah terpenuhi`,
      );
    }
    return false;
  };

  // ── `_repair_konsultasi_to_primary_doctor` (10542) ─────────────
  const repairKonsultasiToPrimaryDoctor = (
    row: SpesialisRow,
    rows: readonly SpesialisRow[],
  ): boolean => {
    if (preserveSpesialisRow(row)) return false;
    if (str(row, '_action_key') !== 'konsultasi') return false;

    const rowKey = str(row, '_pelaksana_key');
    if (rowKey) return false;

    const rowDate = str(row, '_row_date');
    if (!patientInfo.primaryName || !patientInfo.primaryKey) {
      return hapusSpesialisRow(
        row,
        'dokter penanggungjawab pasien tidak ditemukan untuk konsultasi dokter spesialis lewat telepon',
      );
    }

    const sameDayPrimaryRows = rows.filter(
      (item) =>
        str(item, '_action_key') === 'konsultasi' &&
        str(item, '_row_date') === rowDate &&
        str(item, '_pelaksana_key') === patientInfo.primaryKey &&
        !isSameSpesialisRow(item, row),
    );
    if (sameDayPrimaryRows.length > 0) {
      return hapusSpesialisRow(
        row,
        `konsultasi dokter penanggungjawab pasien sudah ada pada tanggal ${rowDate || '-'}`,
      );
    }

    return setPelaksanaOnRow(
      row,
      patientInfo.primaryName,
      'Isi pelaksana konsultasi dokter spesialis lewat telepon',
    );
  };

  /**
   * The metadata both delete-and-re-add repairs need, or `undefined` after
   * recording the legacy skip reason.
   */
  const repairContextOf = (
    row: SpesialisRow,
    skipTitle: string,
  ):
    | {
        noRm: string;
        noTransaksi: string;
        noReg: string;
        kdUnit: string;
        kdKamar: string;
        kdDetkelpenjamin: string;
        targetDate: string;
        desiredName: string;
        roomClass: string;
        sourceRoomRow: LegacyRow;
        meta: LegacyRow;
        masterPrice: number;
        kdParamedis: string;
      }
    | undefined => {
    const sourceRoomRow = isRecordLike(row['_source_room_row']) ? row['_source_room_row'] : {};
    const noRm = str(row, '_no_rm');
    const noTransaksi = str(row, 'no_transaksi');
    const rowNoReg = str(row, 'no_registrasikunjungan');
    const kdUnit = str(sourceRoomRow, 'kd_unit') || str(row, 'kd_unit');
    const kdKamar = str(sourceRoomRow, 'kd_kamarperawatan') || str(row, 'kd_kamarperawatan');
    const kdDetkelpenjamin =
      str(sourceRoomRow, 'kd_detkelpenjamin') ||
      str(row, 'kd_detkelpenjamin') ||
      DEFAULT_KD_DETKELPENJAMIN;
    const targetDate = str(row, '_row_date') || datePart(str(row, 'tgl_jam', 'tgl_transaksi'));
    if (!noRm || !noTransaksi || !rowNoReg || !kdUnit || !kdKamar || !targetDate) {
      skip(row, 'metadata transaksi tidak lengkap');
      lines.push(`  - ${skipTitle} | trx=${noTransaksi || '-'} | reg=${rowNoReg || '-'} | tanggal=${targetDate || '-'} | alasan=metadata transaksi tidak lengkap`);
      return undefined;
    }
    const meta = pickSpesialisTindakanMeta(
      masterRowsOf(noTransaksi),
      listRowsOf(noTransaksi),
      'VISITE DOKTER SPESIALIS',
    );
    if (!meta) {
      skip(row, 'metadata VISITE DOKTER SPESIALIS tidak ditemukan');
      lines.push(`  - ${skipTitle} | trx=${noTransaksi} | reg=${rowNoReg} | tanggal=${targetDate} | alasan=metadata VISITE DOKTER SPESIALIS tidak ditemukan`);
      return undefined;
    }
    const dataInap = kunjunganOf(noTransaksi);
    return {
      noRm,
      noTransaksi,
      noReg: rowNoReg,
      kdUnit,
      kdKamar,
      kdDetkelpenjamin,
      targetDate,
      desiredName: str(row, '_pelaksana'),
      roomClass: getSpesialisRoomClass(row) || '-',
      sourceRoomRow,
      meta,
      masterPrice: parseCurrencyInt(meta['harga'], 0),
      kdParamedis:
        str(dataInap, 'kd_paramedis') ||
        str(sourceRoomRow, 'kd_paramedis') ||
        str(row, 'kd_paramedis'),
    };
  };

  // ── `_repair_nonstandard_visite_spesialis_row` (10708) ─────────
  const repairNonstandardVisiteRow = (row: SpesialisRow): boolean => {
    const context = repairContextOf(row, 'Skip repair nama visite dokter spesialis');
    if (!context) return false;
    const originalName = text(row['nama_tindakan']).split(/\s+/).filter(Boolean).join(' ');
    const targetPrice = getExpectedSpesialisTarif(context.roomClass) || context.masterPrice;
    if (
      !hapusSpesialisRow(
        row,
        `nama tindakan visite dokter spesialis tidak standar (${originalName || '-'})`,
      )
    ) {
      return false;
    }
    emitCreateTriple({
      kind: 'repairTarif',
      row,
      noTransaksi: context.noTransaksi,
      noReg: context.noReg,
      kdTindakan: str(context.meta, 'kd_tindakan'),
      kdUnit: context.kdUnit,
      kdKamar: context.kdKamar,
      kdDetkelpenjamin: context.kdDetkelpenjamin,
      kdParamedis: context.kdParamedis,
      namaTindakan: 'VISITE DOKTER SPESIALIS',
      harga: targetPrice || context.masterPrice,
      hargaRaw: String(targetPrice || context.masterPrice || ''),
      roomClass: context.roomClass,
      targetDate: context.targetDate,
      sourceDateTime: str(row, 'tgl_jam', 'tgl_transaksi'),
      desiredName: context.desiredName,
      addReason: `repair nama visite dokter spesialis tidak standar (${originalName || '-'}) menjadi VISITE DOKTER SPESIALIS untuk ${context.roomClass}`,
      updateReason: 'kembalikan tanggal visite dokter spesialis setelah repair nama',
      pelaksanaReason: 'Tampung ulang pelaksana visite dokter spesialis',
      ownerRoomRow: isRecordLike(row['_owner_room_row'])
        ? row['_owner_room_row']
        : context.sourceRoomRow,
      sourceRoomRow: context.sourceRoomRow,
    });
    return true;
  };

  // ── `_repair_wrong_tarif_spesialis_row` (10917) ────────────────
  const repairWrongTarifRow = (row: SpesialisRow): boolean => {
    const context = repairContextOf(row, 'Skip repair tarif visite dokter spesialis');
    if (!context) return false;
    const oldPrice = parseCurrencyInt(row['harga'], 0);
    const targetPrice = getExpectedSpesialisTarif(context.roomClass) || context.masterPrice;
    if (targetPrice <= 0 || targetPrice === oldPrice) {
      skip(row, 'harga target belum berbeda dari harga row');
      lines.push(
        `  - Skip repair tarif visite dokter spesialis | trx=${context.noTransaksi} | reg=${context.noReg} | tanggal=${context.targetDate} | kelas=${context.roomClass} | harga_lama=${oldPrice} | harga_target=${targetPrice || '-'} | alasan=harga target belum berbeda dari harga row`,
      );
      return false;
    }
    if (
      !hapusSpesialisRow(
        row,
        `tarif visite dokter spesialis ${oldPrice} tidak sesuai untuk ${context.roomClass}`,
      )
    ) {
      return false;
    }
    emitCreateTriple({
      kind: 'repairTarif',
      row,
      noTransaksi: context.noTransaksi,
      noReg: context.noReg,
      kdTindakan: str(context.meta, 'kd_tindakan'),
      kdUnit: context.kdUnit,
      kdKamar: context.kdKamar,
      kdDetkelpenjamin: context.kdDetkelpenjamin,
      kdParamedis: context.kdParamedis,
      namaTindakan: 'VISITE DOKTER SPESIALIS',
      harga: targetPrice,
      hargaRaw: String(targetPrice),
      roomClass: context.roomClass,
      targetDate: context.targetDate,
      sourceDateTime: str(row, 'tgl_jam', 'tgl_transaksi'),
      desiredName: context.desiredName,
      addReason: `repair tarif visite dokter spesialis ${oldPrice} menjadi ${targetPrice} untuk ${context.roomClass}`,
      updateReason: 'kembalikan tanggal visite dokter spesialis setelah repair tarif',
      pelaksanaReason: 'Tampung ulang pelaksana visite dokter spesialis',
      ownerRoomRow: isRecordLike(row['_owner_room_row'])
        ? row['_owner_room_row']
        : context.sourceRoomRow,
      sourceRoomRow: context.sourceRoomRow,
    });
    return true;
  };

  // ── `_repair_spesialis_wrong_room_row` (11138) ─────────────────
  const repairWrongRoomRow = (row: SpesialisRow): boolean => {
    if (!needsSpesialisRoomRelocation(row)) return false;

    const actionKey = str(row, '_action_key');
    const exactName = getSpesialisExactName(actionKey);
    const rowDate = str(row, '_row_date');
    const desiredName = str(row, '_pelaksana');
    const sourceRoomRow = isRecordLike(row['_source_room_row']) ? row['_source_room_row'] : {};
    const ownerRoomRow = isRecordLike(row['_owner_room_row']) ? row['_owner_room_row'] : {};
    const noRm = str(row, '_no_rm');
    const sourceNoTransaksi = str(row, 'no_transaksi');
    const sourceNoReg = str(row, 'no_registrasikunjungan');
    const targetNoTransaksi = str(ownerRoomRow, 'no_transaksi');
    const targetNoReg = str(ownerRoomRow, 'no_registrasikunjungan');
    const targetKdUnit = str(ownerRoomRow, 'kd_unit') || str(row, 'kd_unit');
    const targetKdKamar =
      str(ownerRoomRow, 'kd_kamarperawatan') || str(row, 'kd_kamarperawatan');
    const targetKdDetkelpenjamin =
      str(ownerRoomRow, 'kd_detkelpenjamin') ||
      str(row, 'kd_detkelpenjamin') ||
      DEFAULT_KD_DETKELPENJAMIN;
    const targetRoomName = str(ownerRoomRow, 'nama_unit');
    const targetPrice = parseCurrencyInt(row['harga'], 0);

    if (
      !noRm ||
      !sourceNoTransaksi ||
      !sourceNoReg ||
      !targetNoTransaksi ||
      !targetNoReg ||
      !targetKdUnit ||
      !targetKdKamar ||
      !exactName ||
      !rowDate
    ) {
      skip(row, 'metadata transaksi target tidak lengkap');
      lines.push(
        `  - Skip pindah tindakan spesialis ke ruang owner | aksi=${actionKey || '-'} | trx_sumber=${sourceNoTransaksi || '-'} | trx_target=${targetNoTransaksi || '-'} | tanggal=${rowDate || '-'} | alasan=metadata transaksi target tidak lengkap`,
      );
      return false;
    }

    const targetListBefore = listRowsOf(targetNoTransaksi);
    const meta = pickSpesialisTindakanMeta(
      masterRowsOf(targetNoTransaksi),
      targetListBefore,
      exactName,
    );
    if (!meta) {
      skip(row, `metadata ${exactName} tidak ditemukan di ruang target`);
      lines.push(
        `  - Skip pindah tindakan spesialis ke ruang owner | aksi=${actionKey || '-'} | trx_sumber=${sourceNoTransaksi} | trx_target=${targetNoTransaksi} | tanggal=${rowDate} | ruang_target=${targetRoomName || '-'} | alasan=metadata ${exactName} tidak ditemukan di ruang target`,
      );
      return false;
    }

    const existingTargetRows = targetListBefore.filter(
      (item) =>
        getSpesialisActionKey(item) === actionKey &&
        datePart(str(item, 'tgl_jam', 'tgl_transaksi')) === rowDate,
    );
    if (existingTargetRows.length > 0) {
      return hapusSpesialisRow(
        row,
        `dipindah ke ruang owner ${targetRoomName || '-'} karena row target tanggal ${rowDate} sudah ada`,
      );
    }

    const dataTarget = kunjunganOf(targetNoTransaksi);
    const targetKdParamedis =
      str(dataTarget, 'kd_paramedis') ||
      str(ownerRoomRow, 'kd_paramedis') ||
      str(row, 'kd_paramedis');
    const metaPrice = parseCurrencyInt(meta['harga'], 0);
    const hargaAdd = String(targetPrice || metaPrice || str(meta, 'harga'));

    emitCreateTriple({
      kind: 'relocateRoom',
      row,
      noTransaksi: targetNoTransaksi,
      noReg: targetNoReg,
      kdTindakan: str(meta, 'kd_tindakan'),
      kdUnit: targetKdUnit,
      kdKamar: targetKdKamar,
      kdDetkelpenjamin: targetKdDetkelpenjamin,
      kdParamedis: targetKdParamedis,
      namaTindakan: exactName,
      harga: targetPrice || metaPrice,
      hargaRaw: hargaAdd,
      roomClass: extractRoomClassKey(ownerRoomRow) || getSpesialisRoomClass(row) || '-',
      targetDate: rowDate,
      sourceDateTime: str(row, 'tgl_jam', 'tgl_transaksi'),
      desiredName,
      addReason: `pindah ${exactName.toLowerCase()} dari ruang ${str(sourceRoomRow, 'nama_unit') || str(row, '_source_room_name') || '-'} ke ruang owner ${targetRoomName || '-'} pada tanggal ${rowDate}`,
      updateReason: `samakan tanggal ${exactName.toLowerCase()} ke room owner yang benar`,
      pelaksanaReason: `Tampung pelaksana ${exactName.toLowerCase()} di ruang owner`,
      ownerRoomRow,
      sourceRoomRow: ownerRoomRow,
    });

    if (
      !hapusSpesialisRow(
        row,
        `dipindah ke ruang owner ${targetRoomName || '-'} pada tanggal ${rowDate || '-'}`,
      )
    ) {
      note(
        'WARN',
        `hapus_${actionKey}_sumber_setelah_pindah | trx=${sourceNoTransaksi || '-'} | reg=${sourceNoReg || '-'} | tanggal=${rowDate || '-'}`,
      );
    }
    return true;
  };

  // ── `_dedup_konsultasi_when_visite_same_day` (11489) ───────────
  const dedupKonsultasiWhenVisiteSameDay = (rows: readonly SpesialisRow[]): boolean => {
    const visiteKeys = new Set<string>();
    for (const row of rows) {
      if (str(row, '_action_key') !== 'visite') continue;
      if (preserveSpesialisRow(row)) continue;
      const pelaksanaKey = str(row, '_pelaksana_key');
      const rowDate = str(row, '_row_date');
      if (pelaksanaKey && rowDate) visiteKeys.add(`${pelaksanaKey}|${rowDate}`);
    }
    if (visiteKeys.size === 0) return false;

    let changed = false;
    for (const row of rows) {
      if (str(row, '_action_key') !== 'konsultasi') continue;
      if (preserveSpesialisRow(row)) continue;
      const pelaksanaKey = str(row, '_pelaksana_key');
      const rowDate = str(row, '_row_date');
      if (!pelaksanaKey || !rowDate) continue;
      if (!visiteKeys.has(`${pelaksanaKey}|${rowDate}`)) continue;
      const deleted = hapusSpesialisRow(
        row,
        `dokter ${pelaksanaKey} sudah memiliki visite pada tanggal ${rowDate}, konsultasi dihapus`,
      );
      changed = deleted || changed;
    }
    return changed;
  };

  // ── `_cleanup_spesialis_action_rows` (11526) ───────────────────
  const cleanupSpesialisActionRows = (
    actionKey: 'visite' | 'visite_scn' | 'konsultasi',
    rows: readonly SpesialisRow[],
  ): boolean => {
    let changed = false;
    const label = SPESIALIS_ACTION_LABELS[actionKey] ?? 'spesialis';
    const allRelevant = rows.filter((row) => str(row, '_action_key') === actionKey);
    for (const row of allRelevant.filter((row) => preserveSpesialisRow(row))) {
      skip(row, 'dokter anestesi dipertahankan, tidak dihapus atau direwrite');
    }
    let relevantRows = allRelevant.filter((row) => !preserveSpesialisRow(row));

    if (allowedDates.size > 0) {
      const sorted = [...allowedDates].sort();
      const first = sorted[0] ?? '';
      const last = sorted[sorted.length - 1] ?? '';
      for (const row of relevantRows) {
        const rowDate = str(row, '_row_date');
        if (rowDate && allowedDates.has(rowDate)) continue;
        changed =
          hapusSpesialisRow(
            row,
            `tanggal ${rowDate || '-'} di luar range rawat inap (${first} s/d ${last})`,
          ) || changed;
      }
    }
    if (changed) return changed;

    for (const row of relevantRows) {
      if (!needsSpesialisRoomRelocation(row)) continue;
      changed = repairWrongRoomRow(row) || changed;
    }
    if (changed) return changed;

    for (const row of relevantRows) {
      if (!needsSpesialisNameRepair(row)) continue;
      changed = repairNonstandardVisiteRow(row) || changed;
    }
    if (changed) return changed;

    for (const row of relevantRows) {
      changed =
        (actionKey === 'konsultasi'
          ? repairKonsultasiToPrimaryDoctor(row, rows)
          : repairVisiteFromCpptOrDelete(row, rows)) || changed;
    }
    if (changed) return changed;

    for (const row of relevantRows) {
      if (actionKey === 'konsultasi') continue;
      if (str(row, '_pelaksana_key')) continue;
      changed = tryFillPelaksanaFromCppt(row, rows) || changed;
    }
    if (changed) return changed;

    for (const row of relevantRows) {
      if (str(row, '_pelaksana_key')) continue;
      changed = hapusSpesialisRow(row, `pelaksana ${label} kosong`) || changed;
    }
    if (changed) return changed;

    for (const row of relevantRows) {
      if (!looksLikeRoomLabelSpesialisPelaksana(row)) continue;
      changed =
        hapusSpesialisRow(
          row,
          `pelaksana ${label} berupa label ruangan (${str(row, '_pelaksana') || '-'})`,
        ) || changed;
    }
    if (changed) return changed;

    for (const row of relevantRows) {
      const roomNameForRule = str(row, '_source_room_name') || str(row, '_owner_room_name');
      if (row['_is_anest'] === true && !isIcuRoomName(roomNameForRule)) {
        changed =
          hapusSpesialisRow(
            row,
            `pelaksana anestesi tidak diperbolehkan di ruang non-ICU (${roomNameForRule || '-'})`,
          ) || changed;
      }
    }
    if (changed) return changed;

    for (const row of relevantRows) {
      if (!needsSpesialisTarifRepair(row)) continue;
      changed = repairWrongTarifRow(row) || changed;
    }
    if (changed) return changed;

    // Anaesthetists in non-ICU rooms drop out of the quota arithmetic even when
    // the delete above was refused.
    relevantRows = relevantRows.filter(
      (row) =>
        !(
          row['_is_anest'] === true &&
          !isIcuRoomName(str(row, '_source_room_name') || str(row, '_owner_room_name'))
        ),
    );

    if (actionKey === 'visite_scn') {
      for (const dateRows of Object.values(groupRowsByDateAndPelaksana(relevantRows))) {
        logV2Fallback(dateRows);
        const keepRow = pickSpesialisKeepRow(dateRows, new Set(), cpptLookups);
        for (const row of dateRows) {
          if (isKeepRow(row, keepRow)) continue;
          changed =
            hapusSpesialisRow(
              row as SpesialisRow,
              `pelaksana yang sama maksimal 1x per hari untuk ${label}`,
            ) || changed;
        }
      }
      return changed;
    }

    const patientRows = relevantRows.filter((row) =>
      patientInfo.allKeys.has(rawString(row['_pelaksana_key'])),
    );
    const otherRows = relevantRows.filter(
      (row) => !patientInfo.allKeys.has(rawString(row['_pelaksana_key'])),
    );

    for (const dateRows of Object.values(groupRowsByDate(patientRows))) {
      logV2Fallback(dateRows);
      const keepRow = pickSpesialisKeepRow(dateRows, patientInfo.allKeys, cpptLookups);
      for (const row of dateRows) {
        if (isKeepRow(row, keepRow)) continue;
        changed =
          hapusSpesialisRow(
            row as SpesialisRow,
            `dokter pasien maksimal 1x per hari untuk ${label}`,
          ) || changed;
      }
    }
    if (changed) return changed;

    const keptOtherRows: LegacyRow[] = [];
    for (const dateRows of Object.values(groupRowsByDateAndPelaksana(otherRows))) {
      logV2Fallback(dateRows);
      const keepRow = pickSpesialisKeepRow(dateRows, new Set(), cpptLookups);
      if (keepRow) keptOtherRows.push(keepRow);
      for (const row of dateRows) {
        if (isKeepRow(row, keepRow)) continue;
        changed =
          hapusSpesialisRow(
            row as SpesialisRow,
            `pelaksana yang sama selain dokter pasien maksimal 1x per hari untuk ${label}`,
          ) || changed;
      }
    }
    if (changed) return changed;

    for (const pelaksanaRows of Object.values(groupRowsByPelaksana(keptOtherRows))) {
      const normalized = pelaksanaRows
        .map((row, index) => ({
          row,
          index,
          matched: getSpesialisV2MatchState(row, cpptLookups).state === true ? 0 : 1,
          time: parseDateTimeFlexible(str(row, 'tgl_jam', 'tgl_transaksi'))?.getTime() ?? Infinity,
          urut: safeInt(row['urut_tindakan'], 999999),
        }))
        .sort(
          (left, right) =>
            left.matched - right.matched ||
            left.time - right.time ||
            left.urut - right.urut ||
            left.index - right.index,
        )
        .map((entry) => entry.row);
      for (const row of normalized.slice(SPESIALIS_OTHER_DOCTOR_MAX_TOTAL)) {
        changed =
          hapusSpesialisRow(
            row as SpesialisRow,
            `pelaksana yang sama selain dokter pasien maksimal total ${SPESIALIS_OTHER_DOCTOR_MAX_TOTAL}x selama perawatan untuk ${label}`,
          ) || changed;
      }
    }
    return changed;
  };

  // ── `_ensure_primary_patient_visite` (11723) ───────────────────
  let dpjp: { ok: boolean; detail: string; opSequence?: number } | undefined;
  const ensurePrimaryPatientVisite = (): boolean => {
    const skipReason = (reason: string): false => {
      dpjp = { ok: false, detail: `tidak ditambahkan: ${reason}` };
      note('INFO', `Skip tambah visite dokter pasien | alasan=${reason}`);
      lines.push(`  - Skip tambah visite dokter pasien | alasan=${reason}`);
      return false;
    };
    if (!patientInfo.primaryName || !patientInfo.primaryKey) {
      return skipReason('nama paramedis pasien tidak ditemukan');
    }
    const dateOwner = buildRoomOwnerByDate(roomRows, args.roomDayAssignments ?? {});
    if (Object.keys(dateOwner).length === 0) {
      return skipReason('owner tanggal rawat inap tidak ditemukan');
    }

    const spesialisRows = live();
    const inRange = (row: LegacyRow): boolean =>
      allowedDates.size === 0 || allowedDates.has(str(row, '_row_date'));
    const hasVisite = spesialisRows.some(
      (row) => str(row, '_action_key') === 'visite' && inRange(row),
    );
    const hasVisiteScn = spesialisRows.some(
      (row) => str(row, '_action_key') === 'visite_scn' && inRange(row),
    );
    const amanahRoom = roomRows.some((row) => normalizeTextKey(row['nama_unit']).includes('AMANAH'));
    if (patientInfo.isByny && amanahRoom && hasVisiteScn && !hasVisite) {
      return skipReason(
        'bayi di ruang Amanah dengan VISITE DR ANAK SCN tidak wajib punya VISITE DOKTER SPESIALIS',
      );
    }
    if (
      spesialisRows.some(
        (row) =>
          str(row, '_action_key') === 'visite' &&
          str(row, '_pelaksana_key') === patientInfo.primaryKey &&
          inRange(row),
      )
    ) {
      dpjp = { ok: true, detail: 'sudah ada dalam rentang rawat' };
      return false;
    }
    if (
      spesialisRows.some(
        (row) =>
          str(row, '_action_key') === 'visite' &&
          str(row, '_pelaksana_key') === patientInfo.primaryKey &&
          allowedDates.size > 0 &&
          !allowedDates.has(str(row, '_row_date')),
      )
    ) {
      return skipReason('masih ada visite dokter pasien di luar range yang belum dibersihkan');
    }

    let targetCandidates =
      allowedDates.size > 0
        ? [...allowedDates].filter((date) => date in dateOwner).sort()
        : [];
    if (targetCandidates.length === 0) targetCandidates = Object.keys(dateOwner).sort();
    const targetDate = targetCandidates[targetCandidates.length - 1];
    if (!targetDate) return false;
    const targetRoomRow = dateOwner[targetDate];
    if (!targetRoomRow) return false;
    if (
      isAnesthesiologistName(patientInfo.primaryName) &&
      !isIcuRoomName(targetRoomRow['nama_unit'])
    ) {
      return skipReason('anestesi non-ICU tidak diperbolehkan');
    }

    const noTransaksi = str(targetRoomRow, 'no_transaksi');
    const targetNoReg = str(targetRoomRow, 'no_registrasikunjungan');
    const kdUnit = str(targetRoomRow, 'kd_unit');
    const kdKamar = str(targetRoomRow, 'kd_kamarperawatan');
    const kdDetkelpenjamin =
      str(targetRoomRow, 'kd_detkelpenjamin') || DEFAULT_KD_DETKELPENJAMIN;
    if (!noTransaksi || !targetNoReg || !kdUnit || !kdKamar) {
      return skipReason('metadata transaksi rawat inap tidak lengkap');
    }

    const meta = pickSpesialisTindakanMeta(
      masterRowsOf(noTransaksi),
      listRowsOf(noTransaksi),
      'VISITE DOKTER SPESIALIS',
    );
    if (!meta) return skipReason('metadata VISITE DOKTER SPESIALIS tidak ditemukan');

    const dataInap = kunjunganOf(noTransaksi);
    dpjp = { ok: false, detail: `belum ada — tambah tgl ${targetDate}`, opSequence: ops.length + 1 };
    emitCreateTriple({
      kind: 'tambah',
      noTransaksi,
      noReg: targetNoReg,
      kdTindakan: str(meta, 'kd_tindakan'),
      kdUnit,
      kdKamar,
      kdDetkelpenjamin,
      kdParamedis: str(dataInap, 'kd_paramedis') || str(targetRoomRow, 'kd_paramedis'),
      namaTindakan: 'VISITE DOKTER SPESIALIS',
      harga: parseCurrencyInt(meta['harga'], 0),
      // The Python sends the master `harga` verbatim here, not the class tariff.
      hargaRaw: str(meta, 'harga'),
      roomClass: extractRoomClassKey(targetRoomRow) || '-',
      targetDate,
      sourceDateTime: '',
      desiredName: patientInfo.primaryName,
      addReason: `pasien belum memiliki visite dokter spesialis, tambah visite dokter pasien ${patientInfo.primaryName} pada tanggal ${targetDate}`,
      updateReason: 'pindahkan visite dokter pasien ke tanggal terakhir perawatan',
      pelaksanaReason: 'Tampung pelaksana visite dokter pasien',
      ownerRoomRow: targetRoomRow,
      sourceRoomRow: targetRoomRow,
    });
    return true;
  };

  // ── the loop ──────────────────────────────────────────────────
  const maxIterations = args.maxIterations ?? SPESIALIS_SYNC_MAX_ITERATIONS;
  let iteration = 0;
  let cleanupIncomplete = false;
  for (;;) {
    iteration += 1;
    if (iteration > maxIterations) {
      note(
        'ERROR',
        `Stop sinkronisasi spesialis | reg=${noReg || '-'} | alasan=melebihi batas iterasi`,
      );
      lines.push(
        `  - Stop sinkronisasi spesialis | reg=${noReg || '-'} | alasan=melebihi batas iterasi`,
      );
      cleanupIncomplete = true;
      break;
    }
    // One collection per iteration, shared by all four phases — the Python
    // hands the same `rows` list to each, and only reaches a later phase when
    // every earlier one reported no change.
    const rows = live();
    if (dedupKonsultasiWhenVisiteSameDay(rows)) continue;
    if (cleanupSpesialisActionRows('visite_scn', rows)) continue;
    if (cleanupSpesialisActionRows('visite', rows)) continue;
    if (cleanupSpesialisActionRows('konsultasi', rows)) continue;
    break;
  }

  if (!cleanupIncomplete) ensurePrimaryPatientVisite();

  if (assumedCreate) {
    note(
      'WARN',
      'Plan memuat tambah tindakan: urut_tindakan row baru ditentukan backend, jadi op updateTgl/setPelaksana lanjutan harus di-resolve ulang lewat re-read get_listtindakan sebelum dieksekusi',
    );
  }

  const status: VisiteSyncPlan['status'] =
    cleanupIncomplete || assumedCreate ? 'incomplete' : ops.length > 0 ? 'changed' : 'ok';
  lines.push('+ Status:');
  if (status === 'incomplete') {
    lines.push('   - Hasil         : masih ada tindakan yang perlu diproses ulang setelah run berikutnya');
  } else if (status === 'changed') {
    lines.push('   - Hasil         : sinkronisasi visite/konsultasi selesai, ada perubahan');
  } else {
    lines.push('   - Hasil         : tidak ada perubahan, data visite/konsultasi sudah sesuai');
  }

  return { noRegistrasikunjungan: noReg, ops, untouched, issues, lines, status, reasoning: buildReasoning() };

  function buildReasoning(): VisiteReasoning {
    const dates = [...allowedDates].sort();
    const ACTION: Record<string, string> = { visite: 'Visite', visite_scn: 'Visite SCN', konsultasi: 'Konsultasi' };
    const items: VisiteReasoning['items'] = [];
    // Original charges only; `_synthetic` rows are this plan's own additions.
    const originals = works.filter((work) => work.row['_synthetic'] !== true)
      .sort((a, b) => str(a.row, '_row_date').localeCompare(str(b.row, '_row_date')));
    for (const work of originals) {
      const row = work.row;
      const label = `${ACTION[str(row, '_action_key')] ?? 'Spesialis'} ${str(row, '_pelaksana') || '-'} · tgl ${str(row, '_row_date') || '-'}`;
      const removal = ops.find((op) => op.kind === 'hapus' && op.row !== undefined && (op.row === row || isSameSpesialisRow(op.row, row)));
      const held = untouched.find((entry) => entry.row === row || isSameSpesialisRow(entry.row, row));
      if (removal) items.push({ label, ok: false, detail: `dihapus: ${removal.reason ?? ''}`.trim(), opSequence: removal.sequence });
      else if (held) items.push({ label, ok: false, detail: held.reason });
      else items.push({ label, ok: true, detail: `tanggal di dalam rawat ${dates[0] ?? '-'} s/d ${dates.at(-1) ?? '-'} · tidak perlu diubah` });
    }
    const name = patientInfo.primaryName || 'dokter pasien';
    const outcome = dpjp as { ok: boolean; detail: string; opSequence?: number } | undefined;
    items.push(outcome
      ? { label: `Visite DPJP ${name}`, ok: outcome.ok, detail: outcome.detail, ...(outcome.opSequence ? { opSequence: outcome.opSequence } : {}) }
      : { label: `Visite DPJP ${name}`, ok: null, detail: 'belum dicek — sinkronisasi berhenti lebih dulu' });
    const title = dates.length
      ? `Rawat ${dates.length} hari (${dates[0]}${dates.length > 1 ? ` – ${dates[dates.length - 1]}` : ''})`
      : 'Rentang rawat tidak diketahui';
    return { title, items };
  }
}

/** What one planned visite write changes: the charge, its value now → the value it will have. */
export function describeVisiteOp(op: VisiteOp, currentPelaksana?: string): string {
  const name = String(op.row?.['nama_tindakan'] ?? '').trim() || op.correctedNamaTindakan || `tindakan ${op.kdTindakan ?? '-'}`;
  const at = (datetime: string | undefined) => (datetime ?? '').slice(0, 16) || '-';
  const rp = (n: number | undefined) => (n !== undefined && Number.isFinite(n) ? ` · Rp ${Math.round(n).toLocaleString('id-ID')}` : '');
  switch (op.kind) {
    case 'setPelaksana':
      return `${name}: dokter ${currentPelaksana?.trim() || '(kosong)'} → ${op.pelaksana?.trim() || '(dikosongkan)'}`;
    case 'hapus':
      return `${name} tgl ${at(op.tglJam ?? String(op.row?.['tgl_jam'] ?? ''))}: dihapus`;
    case 'updateTgl':
      return `${name}: tanggal ${at(String(op.row?.['tgl_jam'] ?? op.tglJam ?? ''))} → ${at(op.targetDatetime)}`;
    case 'tambah':
      return `${op.correctedNamaTindakan || name}: ditambahkan${op.targetDatetime ? ` tgl ${at(op.targetDatetime)}` : ''}${rp(op.correctedHarga)}`;
    case 'repairTarif':
      return `${name} → ${op.correctedNamaTindakan || name}${op.correctedRoomClass ? ` (${op.correctedRoomClass})` : ''}${rp(op.correctedHarga)}`;
    case 'relocateRoom':
      return `${name}: dipindah ke tagihan ruang ${op.noTransaksi}${op.correctedRoomClass ? ` (${op.correctedRoomClass})` : ''}`;
  }
}
