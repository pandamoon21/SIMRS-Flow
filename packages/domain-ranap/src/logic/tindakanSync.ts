/**
 * The per-charge daily-tindakan repair loop, ported from
 * `sinkronkan_tindakan_harian_inap` (`ranap_v3.py:13964`) and its decision
 * helpers.
 *
 * ## What this module is
 *
 * The legacy function walks one inpatient transaction's billing lines and makes
 * a decision **per charge row**: re-date it, delete it, add the one that is
 * missing, move it onto a day that has none, or fix the performing paramedic.
 * It performs those writes inline. In SIMRS-Flow a `mutate` step never writes —
 * it emits `MutationPlan`s that an operator approves — so only the *decision*
 * half is ported here: {@link planTindakanSync} returns an **ordered list of
 * intended operations** ({@link TindakanOp}) in the Python's own execution
 * order, plus the rows it deliberately left alone, the issues it registered,
 * and the operator log block as data.
 *
 * ## The write-observation assumption (important)
 *
 * The Python re-reads `ambil_listtindakan` after every successful write
 * (`_refresh_listtindakan_inap`, `ranap_v3.py:12078`) and the later phases
 * branch on what came back. A planner cannot observe a write, so — exactly as
 * the Python's own `DRY_RUN` branch does — **every emitted operation is assumed
 * to have succeeded** and the working row set is advanced accordingly:
 *
 *  - `hapus` removes the row from the working set;
 *  - `updateTgl` / `rebalance` rewrite the working row's `tgl_jam` /
 *    `tgl_transaksi` to the target datetime;
 *  - `tambah` adds **nothing** — the server assigns the new row's `urut_tindakan`
 *    and timestamp, and the Python's `DRY_RUN` branch likewise sees no new row
 *    (it prints `Dry run: tambah … tidak membuat row baru …` and moves on).
 *
 * Two consequences the executor must honour on a real write run:
 *
 *  1. after applying any operation it must re-read `ambil_listtindakan` and call
 *     `planTindakanSync` again, because a rejected or failed write invalidates
 *     every later operation in the list;
 *  2. the follow-up "samakan tanggal hasil tambah … ke tanggal target harian"
 *     `update_tgl` that the Python issues on the row a `tambah` created
 *     (`ranap_v3.py:14419`) is **not** in the op list — it cannot be, the row
 *     does not exist yet. After a `tambah` the executor must re-read and re-plan;
 *     the re-plan will not need it if the server dated the row correctly.
 *
 * Similarly, `_ensure_tindakan_belum_terverifikasi` (`ranap_v3.py:12286`) can
 * cancel a verification before deleting; under `DRY_RUN` it refuses instead, and
 * so does this port. A row blocked that way lands in `untouched`, never in `ops`.
 *
 * ## Purity
 *
 * No HTTP client, no module state, no implicit clock. Every read the Python
 * performs mid-function is an explicit field on {@link PlanTindakanSyncArgs},
 * documented with the endpoint that supplies it. `now` is required only because
 * `_build_update_datetime` stamps the current wall-clock time onto the target
 * date (see `dates.ts`).
 */

import { normalizeCareClassKey, extractRoomClassKey } from './careClass.js';
import { buildUpdateDateTime, datePart, expandTargetDates, iterDateParts, parseDateTimeFlexible } from './dates.js';
import {
  doctorNameMatchesRelaxed,
  extractRoomSegments,
  isBiayaDiitGiziName,
  isBiayaIbsName,
  isBynyPatient,
  isDepoIbsName,
  isDpjbName,
  isIgdOriginChargeName,
  isJasaName,
  isKonsultasiTeleponName,
  isOksigenBhpName,
  isPartusDoctorActionName,
  isProtectedNonDeletableCharge,
  isRoomChargeName,
  isVisiteDrAnakScnName,
  isVisiteSpesialisName,
  normalizeParamedisDisplay,
  resolveExistingJasaCategoryClass,
} from './names.js';
import { groupRowsByDate } from './rooms.js';
import {
  compactTextKey,
  normalizeTextKey,
  parseCurrencyInt,
  rowLogLabel,
  sortedRows,
  stripHtmlText,
} from './scalars.js';
import type { LegacyRow } from './types.js';
import { rowsOf, str } from './types.js';

// ---------------------------------------------------------------------------
// Endpoint registry ids
// ---------------------------------------------------------------------------

/**
 * The registry ids the planned operations would call. Kept as one table so the
 * executor and the workflow's `mutationAllowlist` cannot drift apart.
 *
 *  - `updateTgl` — `update_tgl_tindakan_inap` (`ranap_v3.py:4682`)
 *  - `hapus` — `hapus_tindakan_inap` (`ranap_v3.py:4777`)
 *  - `tambah` — `tambah_tindakan_polis` (`ranap_v3.py:4162`)
 *  - `tambahVerifikator` — `tambah_tindakan_polis_verifikator` (`ranap_v3.py:4845`),
 *    reached through `tambah_biaya_ruang_verifikator` (`ranap_v3.py:14914`)
 *  - `tampungPelaksana` — `tampung_pelaksana_tindakan` (`ranap_v3.py:4193`),
 *    called by `_tampung_pelaksana_checked` (`ranap_v3.py:4440`)
 */

/**
 * `harga` for `tampung_pelaksana`: SIMRS takes it as the *line* total and divides
 * by qty to get the unit price (live 2026-10-27: a qty-2 MEDIKASI sent its unit
 * price 15 000 and came back 2 x 7 500, the bill Rp 15 000 short). So send
 * `jumlah`, else harga x qty. Legacy `_tampung_pelaksana_checked`
 * (ranap_v3.py:4477) sent the unit price and had the same bug on qty > 1.
 */
export function pelaksanaHarga(row: Record<string, unknown>): string {
  const jumlah = Number(row['jumlah']);
  if (Number.isFinite(jumlah) && jumlah > 0) return String(jumlah);
  const harga = Number(row['harga']);
  const qty = Number(row['qty']) || 1;
  return Number.isFinite(harga) && String(row['harga'] ?? '').trim() !== '' ? String(harga * qty) : String(row['harga'] ?? '');
}

export const TINDAKAN_SYNC_ENDPOINTS = {
  updateTgl: 'penatajasaInap.updateTgl',
  hapus: 'penatajasaInap.hapusTindakan',
  tambah: 'penatajasaInap.tambahTindakanPolis',
  tambahVerifikator: 'verifikator.tambahTindakanPolis',
  tampungPelaksana: 'poliklinik.tampungPelaksana',
} as const;

// ---------------------------------------------------------------------------
// Operation and plan types
// ---------------------------------------------------------------------------

/** Which legacy write an operation stands for. */
export type TindakanOpKind =
  /** `update_tgl_tindakan_inap` — re-date an existing charge row. */
  | 'updateTgl'
  /** `hapus_tindakan_inap` — delete a charge row. */
  | 'hapus'
  /** `tambah_tindakan_polis` / `…_verifikator` — add a missing charge. */
  | 'tambah'
  /** `_tampung_pelaksana_checked` — fix the performing paramedic. */
  | 'setPelaksana'
  /** `_rebalance_action_rows_inap` — move a row to another allowed date. */
  | 'rebalance';

/** The three structural charges the daily loop guarantees per day. */
export type TindakanActionKey = 'jasa' | 'dpjb' | 'room';

/** One intended write, in the Python's execution order. */
export interface TindakanOp {
  kind: TindakanOpKind;
  /** Endpoint the operation would call, as a registry id. */
  endpointId: string;
  noTransaksi: string;
  noRegistrasikunjungan: string;
  /** The charge row this targets; absent for `tambah`. */
  row?: LegacyRow;
  kdTindakan?: string;
  urutTindakan?: string;
  /**
   * The row's *current* `tgl_jam` — both `update_tgl` and `hapus_tindakan` take
   * it as part of the row's identity, so it must be the pre-mutation value.
   */
  tglJam?: string;
  /** Target datetime for updateTgl / rebalance / tambah (`YYYY-MM-DD HH:MM:SS`). */
  targetDatetime?: string;
  /** The calendar day `targetDatetime` belongs to, for grouping in the UI. */
  targetDate?: string;
  /** Desired paramedic for setPelaksana / tambah (`''` means "clear it"). */
  pelaksana?: string;
  /** `kd_komponen` the pelaksana lives on — `98` jasa, `29` DPJB, oksigen varies. */
  kdKomponen?: string;
  /** `tampung_pelaksana` money fields, read off `getdetail_komponen_transaksi`. */
  harga?: string;
  hargaPersen?: string;
  diskon?: string;
  nilai?: string;
  /** `tambah_tindakan_polis` payload fields. */
  namaTindakan?: string;
  kdUnit?: string;
  kdParamedis?: string;
  kdDetkelpenjamin?: string;
  kdKamar?: string;
  /** Which of the three structural charges this concerns, when it is one. */
  actionKey?: TindakanActionKey;
  /** The `ranap_v3.py` function that decided this, for the audit trail. */
  phase: string;
  /**
   * Rows sharing a `batchKey` were a *single* `update_tgl` POST in the Python
   * (it re-dates a list of rows in one call). Split here so each row can be
   * approved on its own; an executor may re-batch them.
   */
  batchKey?: string;
  /** Operator-facing Indonesian reason, matching the legacy log wording. */
  reason: string;
  /** Ordering hint: the Python's own execution order must be preserved. */
  sequence: number;
}

/** A row the loop looked at and deliberately left alone. */
export interface TindakanUntouchedRow {
  row: LegacyRow;
  reason: string;
}

/** An entry from `_register_sync_issue` / `_register_reg_alert`. */
export interface TindakanSyncIssue {
  level: 'INFO' | 'WARN' | 'ERROR';
  message: string;
}

/** The planner's whole verdict. */
export interface TindakanSyncPlan {
  noTransaksi: string;
  noRegistrasikunjungan: string;
  /** The days this stay is allowed to carry structural charges on. */
  targetDates: string[];
  ops: TindakanOp[];
  /**
   * Rows examined but deliberately left alone, with why — the legacy log prints
   * these as `Skip …` lines. Two additions the legacy does not print: the
   * `sudah sesuai` pelaksana rows (it logs those, just not as a skip) and the
   * BIAYA OBAT rows, so the disabled `_sinkronkan_tanggal_biaya_obat_inap`
   * reaches the operator instead of vanishing.
   */
  untouched: TindakanUntouchedRow[];
  /**
   * Issues the legacy registers via `_register_sync_issue` / `_register_reg_alert`,
   * de-duplicated and capped at 240 characters as the Python does. Most legacy
   * registrations fire on a *failed write*, which a planner cannot observe;
   * what survives here are the pre-write refusals (an invalid day range, a
   * missing master tindakan, a missing `kd_kamarperawatan`).
   */
  issues: TindakanSyncIssue[];
  /**
   * The operator log block, as data — same wording and order as the Python
   * prints, minus the `hasil=` / `confirmed=` fields, which report a write
   * result that does not exist yet.
   */
  lines: string[];
}

/** One corrupt row found in the rekapitulasi HTML. */
export interface MalformedRekapEntry {
  /** `YYYY-MM-DD` of the rekap row. */
  date: string;
  /** The full `tindakan` cell text, as the legacy log quotes it. */
  text: string;
  /** The trailing `/`-separated segment, i.e. the pelaksana the rekap shows. */
  pelaksana: string;
}

/**
 * `getdetail_komponen_transaksi` (`poliklinik/penatajasa_inap/getdetail_komponen_transaksi`,
 * not yet in the endpoint registry) for one charge row.
 *
 * Return `undefined` for "not fetched"; the port then behaves exactly as the
 * Python does when the endpoint answers with an empty list.
 */
export type KomponenRowsProvider = (row: LegacyRow) => readonly LegacyRow[] | undefined;

/** `cekstatusbayar_tindakan` / `cekstatus_verifikasi_tindakan` for one row. */
export type RowStatusProvider = (row: LegacyRow) => string | undefined;

/** `detail_count_getter` — how many detail lines a penunjang order carries. */
export type DetailCountProvider = (row: LegacyRow) => number;

/** Every read `sinkronkan_tindakan_harian_inap` performs, hoisted. */
export interface PlanTindakanSyncArgs {
  /** Operator input; only used to document the plan. */
  noRm?: string;
  /** The room-stay row (`gethistorykunjungan_tab` / `normalizeRoomStays` output). */
  kunjunganInap: LegacyRow;
  /** SEP / admission date the IGD and poli charges are pulled back to. */
  tglSep?: string;

  // ── identity reads ────────────────────────────────────────────────
  /** `ambil_datakunjungan` → `penatajasaInap.getDataKunjungan`. */
  datakunjungan?: LegacyRow;
  /** `ambil_datakunjungan_tab_inap` → `penatajasaInap.getDataKunjunganTab`. */
  datakunjunganTab?: LegacyRow;
  /** `ambil_datakunjungan_tab2_inap` → `poliklinik.getDataKunjunganTab2`. */
  datakunjunganTab2?: LegacyRow;

  // ── the billing lines ─────────────────────────────────────────────
  /** `ambil_listtindakan` / `_refresh_listtindakan_inap` → `penatajasaInap.getListTindakan`. */
  listRows: readonly LegacyRow[];
  /** `ambil_master_tindakan_inap` → `penatajasaInap.getTindakan`. */
  masterRows?: readonly LegacyRow[];
  /** `ambil_master_tindakan_verifikator` → `verifikator.getTindakan`, for the room fallback. */
  verifikatorMasterRows?: readonly LegacyRow[];
  /** `verifikator_getdatakunjungan` → `verifikator.getDataKunjungan`. */
  verifikatorDatakunjungan?: LegacyRow;
  /** `verifikator_getdatakunjungan_tab` → `verifikator.getDataKunjunganTab`. */
  verifikatorDatakunjunganTab?: LegacyRow;

  // ── day range ─────────────────────────────────────────────────────
  /**
   * `target_dates_override` — the room-day assignment from
   * `buildRoomDayAssignments`. `undefined` means "derive from the stay";
   * an empty array means "this stay owns no day", which triggers the
   * cleanup-then-stop branch (`ranap_v3.py:14134`).
   */
  targetDatesOverride?: readonly string[];

  // ── source-of-truth histories for the date-alignment rules ───────
  /** `poli_source` — `{ tindakan_rows }` of the originating poli transaction. */
  poliSource?: LegacyRow;
  /** `elektromedik_history` → `penatajasaInap.getHistoryKunjunganTab` (elektromedik unit). */
  elektromedikHistory?: readonly LegacyRow[];
  /** `_collect_lab_target_rows_for_inap(no_transaksi, lab_history)` → `penatajasaInap.getHistoryILab`. */
  labTargetRows?: readonly LegacyRow[];
  /** `pa_history` → `penatajasaInap.getHistoryILab` (PA unit). */
  paHistory?: readonly LegacyRow[];
  /** `getdetail_history_orderpa` row count per PA order. */
  paDetailCount?: DetailCountProvider;
  /** `rad_history` → `penatajasaInap.getHistoryIrad`. */
  radHistory?: readonly LegacyRow[];
  /** `getdetail_historyirad` row count per radiology order. */
  radDetailCount?: DetailCountProvider;

  // ── the rekapitulasi bug detector ─────────────────────────────────
  /**
   * `fetch_rekapitulasi_detail_hak_html` → `rekapitulasi.detailHakHtml`.
   * Parsed here by {@link getMalformedRekapJasaDates} and
   * {@link getMalformedRekapRoomChargeDates}.
   */
  rekapDetailHakHtml?: string;

  // ── pelaksana ─────────────────────────────────────────────────────
  /** `_resolve_room_pelaksana(room_name, kd_unit)` → `penatajasaInap.getCmbParamedisPelaksana`. */
  roomPelaksana?: string;
  /** `_get_room_pelaksana_option_names(kd_unit)` → same endpoint, normalised names. */
  roomPelaksanaOptionNames?: readonly string[];
  /** `ambil_paramedis_pelaksana(kd_unit)` rows — the pelaksana dropdown. */
  paramedisOptions?: readonly LegacyRow[];
  /** `getdetail_komponen_transaksi` per row. */
  komponenRows?: KomponenRowsProvider;
  /** `cekstatusbayar_tindakan` per row, consulted by `_boleh_hapus_tindakan`. */
  statusBayarTindakan?: RowStatusProvider;
  /** `cekstatus_verifikasi_tindakan` per row, consulted by `_ensure_tindakan_belum_terverifikasi`. */
  statusVerifikasiTindakan?: RowStatusProvider;

  // ── determinism ───────────────────────────────────────────────────
  /** `datetime.now()` inside `_build_update_datetime`; defaults to the real clock. */
  now?: Date;
  /** `DEBUG_MODE` — adds the legacy debug-only log lines. */
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// Small shared coercions
// ---------------------------------------------------------------------------

/**
 * Joins the parts of a composite key. The Python groups on real tuples, so no
 * separator collision is possible there; a control character that cannot occur
 * in a SIMRS field keeps that property here.
 */
const TUPLE_KEY_SEPARATOR = '\u001f';

/** Python truthiness for a dict: `None` and `{}` are both falsy. */
function nonEmptyRow(row: LegacyRow | null | undefined): LegacyRow | undefined {
  if (!row) return undefined;
  return Object.keys(row).length > 0 ? row : undefined;
}

/** `" ".join(str(value or "").upper().split())` — the collapsed comparison form. */
function collapseUpper(value: unknown): string {
  return (value === undefined || value === null ? '' : String(value)).toUpperCase().trim().replace(/\s+/g, ' ');
}

/** The row's own date, `tgl_jam` first then `tgl_transaksi`. */
function rowDatePart(row: LegacyRow): string {
  return datePart(str(row, 'tgl_jam', 'tgl_transaksi'));
}

/** `str(value or "-").strip() or "-"` — the legacy log placeholder. */
function dash(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text || '-';
}

// ---------------------------------------------------------------------------
// Action classification — `_match_action_key` … `_action_meta_candidates`
// ---------------------------------------------------------------------------

/**
 * `_match_action_key` (`ranap_v3.py:9414`) — which structural charge a row is,
 * or `''` for anything else.
 *
 * Order is load-bearing: jasa and DPJB win before the room test, and once a
 * `roomMeta` is known the *only* way to be a room charge is to match its
 * `kd_tindakan` or its normalised name — a lookalike room charge from another
 * ward classifies as `''` and is therefore cleaned up, not kept.
 */
export function matchActionKey(row: LegacyRow, roomMeta?: LegacyRow | null): TindakanActionKey | '' {
  const namaTindakan = str(row, 'nama_tindakan').toUpperCase();
  const kdTindakan = str(row, 'kd_tindakan');
  if (isJasaName(namaTindakan)) return 'jasa';
  if (isDpjbName(namaTindakan)) return 'dpjb';
  const meta = nonEmptyRow(roomMeta);
  if (meta) {
    const roomKd = str(meta, 'kd_tindakan');
    const roomName = normalizeTextKey(str(meta, 'nama_tindakan'));
    const rowName = normalizeTextKey(namaTindakan);
    if ((roomKd && kdTindakan && kdTindakan === roomKd) || (roomName && rowName === roomName)) {
      return 'room';
    }
    return '';
  }
  if (isRoomChargeName(namaTindakan)) return 'room';
  return '';
}

/**
 * `_row_matches_selected_action_meta` (`ranap_v3.py:9433`) — the row is that
 * action *and* (for jasa only) carries the exact name the chosen meta has, so
 * "JASA PELAYANAN KAT 2" is not mistaken for the plain "JASA PELAYANAN".
 */
export function rowMatchesSelectedActionMeta(
  row: LegacyRow,
  actionKey: TindakanActionKey,
  actionMeta?: LegacyRow | null,
  roomMeta?: LegacyRow | null,
): boolean {
  if (matchActionKey(row, roomMeta) !== actionKey) return false;
  if (actionKey === 'jasa') {
    const expectedName = collapseUpper(nonEmptyRow(actionMeta)?.['nama_tindakan']);
    if (!expectedName) return true;
    return collapseUpper(row['nama_tindakan']) === expectedName;
  }
  return true;
}

/** `_filter_action_rows` (`ranap_v3.py:9445`). Input order is preserved. */
export function filterActionRows(
  rows: readonly LegacyRow[],
  actionKey: TindakanActionKey,
  allowedDates: readonly string[] | ReadonlySet<string>,
  options: {
    roomMeta?: LegacyRow | null;
    actionMeta?: LegacyRow | null;
    strictMeta?: boolean;
  } = {},
): LegacyRow[] {
  const allowed = allowedDates instanceof Set ? allowedDates : new Set(allowedDates as readonly string[]);
  const hasil: LegacyRow[] = [];
  for (const row of rows) {
    if (options.strictMeta) {
      if (!rowMatchesSelectedActionMeta(row, actionKey, options.actionMeta, options.roomMeta)) continue;
    } else if (matchActionKey(row, options.roomMeta) !== actionKey) {
      continue;
    }
    if (allowed.size > 0 && !allowed.has(rowDatePart(row))) continue;
    hasil.push(row);
  }
  return hasil;
}

/** `_action_display_name` (`ranap_v3.py:9465`). */
export function actionDisplayName(actionKey: string): string {
  const labels: Record<string, string> = {
    jasa: 'jasa pelayanan',
    dpjb: 'dpjb',
    room: 'biaya ruang rawat inap',
  };
  const key = String(actionKey ?? '').trim();
  return labels[key] ?? key;
}

/**
 * `_action_meta_candidates` (`ranap_v3.py:9474`) — up to ten distinct names the
 * operator could have meant, printed when no meta resolves.
 */
export function actionMetaCandidates(
  actionKey: string,
  masterRows: readonly LegacyRow[],
  listRows: readonly LegacyRow[],
  roomMeta?: LegacyRow | null,
): string[] {
  const pool = [...masterRows, ...listRows];
  let rows: LegacyRow[] = [];
  if (actionKey === 'jasa') rows = pool.filter((row) => isJasaName(row['nama_tindakan']));
  else if (actionKey === 'dpjb') rows = pool.filter((row) => isDpjbName(row['nama_tindakan']));
  else if (actionKey === 'room') rows = pool.filter((row) => matchActionKey(row, roomMeta) === 'room');

  const seen = new Set<string>();
  const hasil: string[] = [];
  for (const row of rows) {
    const nama = str(row, 'nama_tindakan');
    if (!nama || seen.has(nama)) continue;
    seen.add(nama);
    hasil.push(nama);
  }
  return hasil.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Meta selection — `_score_room_charge_meta`, `_pick_tindakan_meta`
// ---------------------------------------------------------------------------

/** The five-part score tuple `_score_room_charge_meta` returns. */
export type RoomChargeMetaScore = readonly [number, number, number, number, string];

/**
 * `_score_room_charge_meta` (`ranap_v3.py:9272`) — how well a master row matches
 * this ward, as `(classMatch, matchedSegments, longestMatch, tokenOverlap, kdTindakan)`.
 * Sorted descending, so `kd_tindakan` is the final, deterministic tie-break.
 * A non-room-charge row scores `(-1,-1,-1,-1,'')`.
 */
export function scoreRoomChargeMeta(
  row: LegacyRow,
  roomName = '',
  roomSegments?: readonly string[],
): RoomChargeMetaScore {
  const nama = normalizeTextKey(row['nama_tindakan']);
  if (!nama || !isRoomChargeName(nama)) return [-1, -1, -1, -1, ''];

  const segments = [...(roomSegments ?? extractRoomSegments(roomName))];
  const roomClass = normalizeCareClassKey(roomName);
  const chargeClass = normalizeCareClassKey(row['nama_tindakan']);
  const classMatch = roomClass && chargeClass && roomClass === chargeClass ? 1 : 0;
  let matchedSegments = 0;
  let longestMatch = 0;
  for (const segment of segments) {
    const segmentKey = normalizeTextKey(segment);
    if (!segmentKey || !nama.includes(segmentKey)) continue;
    matchedSegments += 1;
    longestMatch = Math.max(longestMatch, segmentKey.length);
  }

  const roomTokens = normalizeTextKey(roomName)
    .split(' ')
    .filter((token) => token && token !== 'KELAS');
  const tokenOverlap = roomTokens.filter((token) => nama.includes(token)).length;
  return [classMatch, matchedSegments, longestMatch, tokenOverlap, str(row, 'kd_tindakan')];
}

/** Ascending tuple comparison, the Python `tuple.__lt__` semantics. */
function compareRoomChargeScore(left: RoomChargeMetaScore, right: RoomChargeMetaScore): number {
  for (let i = 0; i < 4; i += 1) {
    const a = left[i] as number;
    const b = right[i] as number;
    if (a !== b) return a < b ? -1 : 1;
  }
  if (left[4] === right[4]) return 0;
  return left[4] < right[4] ? -1 : 1;
}

/** `sorted(reverse=True)` — descending, ties keep their original order. */
function sortDescStable<T>(items: readonly T[], compare: (a: T, b: T) => number): T[] {
  return [...items].sort((a, b) => -compare(a, b));
}

/** Options for {@link pickTindakanMeta}, mirroring the Python keyword arguments. */
export interface PickTindakanMetaOptions {
  exactName?: string;
  roomCharge?: boolean;
  roomName?: string;
  preferredRoomClass?: string;
}

/**
 * `_pick_tindakan_meta` (`ranap_v3.py:9296`) — choose the master/list row that
 * defines a charge (its `kd_tindakan` and `harga`).
 *
 * Four disjoint modes, in the Python's order:
 *
 *  - `roomCharge`: de-duplicate `listRows + masterRows` on
 *    `(kd_tindakan, name, harga)`, then — if the ward is ISOLASI — prefer an
 *    ISOLASI-class candidate before falling back to the general score ladder.
 *  - `exactName === 'JASA PELAYANAN'`: prefer list rows over master rows, then
 *    the categorised "KAT n" variant for a BERSALIN/ANNISA ward on a numbered
 *    class, then the plain name, then the suffix, then a six-part sort.
 *  - `exactName === 'DOKTER DPJB'` / `'VISITE DOKTER SPESIALIS'`: master first,
 *    then list.
 *  - anything else: exact uppercase name match, master first then list.
 */
export function pickTindakanMeta(
  masterRows: readonly LegacyRow[],
  listRows: readonly LegacyRow[],
  options: PickTindakanMetaOptions = {},
): LegacyRow | undefined {
  const { exactName = '', roomCharge = false, roomName = '', preferredRoomClass = '' } = options;

  if (roomCharge) {
    const roomSegments = extractRoomSegments(roomName);
    const roomClass = normalizeCareClassKey(preferredRoomClass || roomName);
    const candidates: LegacyRow[] = [];
    const seen = new Set<string>();
    for (const row of [...listRows, ...masterRows]) {
      if (!isRoomChargeName(row['nama_tindakan'])) continue;
      const key = [
        str(row, 'kd_tindakan'),
        normalizeTextKey(row['nama_tindakan']),
        str(row, 'harga'),
      ].join(TUPLE_KEY_SEPARATOR);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(row);
    }
    if (candidates.length === 0) return undefined;
    if (roomClass === 'ISOLASI') {
      const isolasi = candidates.filter((row) => normalizeCareClassKey(row['nama_tindakan']) === 'ISOLASI');
      if (isolasi.length > 0) {
        return sortDescStable(isolasi, (a, b) =>
          compareRoomChargeScore(
            scoreRoomChargeMeta(a, roomName, roomSegments),
            scoreRoomChargeMeta(b, roomName, roomSegments),
          ),
        )[0];
      }
    }
    return sortDescStable(candidates, (a, b) =>
      compareRoomChargeScore(
        scoreRoomChargeMeta(a, roomName, roomSegments),
        scoreRoomChargeMeta(b, roomName, roomSegments),
      ),
    )[0];
  }

  const wanted = String(exactName ?? '').trim().toUpperCase();

  if (wanted === 'JASA PELAYANAN') {
    let candidates = listRows.filter((row) => isJasaName(row['nama_tindakan']));
    let fromListRows = true;
    if (candidates.length === 0) {
      candidates = masterRows.filter((row) => isJasaName(row['nama_tindakan']));
      fromListRows = false;
    }
    if (candidates.length === 0) return undefined;

    const normalizedExact = 'JASA PELAYANAN';
    const preferredClass = normalizeCareClassKey(preferredRoomClass || '');
    const roomNameKey = normalizeTextKey(roomName);
    const preferCategorizedJasa =
      (roomNameKey.includes('BERSALIN') || roomNameKey.includes('ANNISA')) &&
      ['KELAS 1', 'KELAS 2', 'KELAS 3'].includes(preferredClass);
    const preferredSuffix =
      ({
        'KELAS 1': 'JASA PELAYANAN KAT 1',
        'KELAS 2': 'JASA PELAYANAN KAT 2',
        'KELAS 3': 'JASA PELAYANAN KAT 3',
      } as Record<string, string>)[preferredClass] ?? '';

    if (preferCategorizedJasa && preferredSuffix) {
      for (const row of candidates) {
        if (collapseUpper(row['nama_tindakan']) === preferredSuffix) return row;
      }
    }
    for (const row of candidates) {
      if (collapseUpper(row['nama_tindakan']) === normalizedExact) return row;
    }
    if (preferredSuffix) {
      for (const row of candidates) {
        if (collapseUpper(row['nama_tindakan']) === preferredSuffix) return row;
      }
    }

    const ranked = [...candidates].sort((left, right) => {
      const key = (row: LegacyRow): readonly [number, number, number, number, number, string] => {
        const collapsed = collapseUpper(row['nama_tindakan']);
        const normalized = normalizeTextKey(row['nama_tindakan']);
        return [
          preferCategorizedJasa && preferredSuffix && collapsed === preferredSuffix ? 0 : 1,
          preferCategorizedJasa && normalized.includes('KAT') ? 0 : 1,
          !normalized.includes('KAT') ? 0 : 1,
          fromListRows ? 0 : 1,
          parseCurrencyInt(row['harga'], 0),
          str(row, 'kd_tindakan'),
        ];
      };
      const a = key(left);
      const b = key(right);
      for (let i = 0; i < 5; i += 1) {
        const x = a[i] as number;
        const y = b[i] as number;
        if (x !== y) return x < y ? -1 : 1;
      }
      if (a[5] === b[5]) return 0;
      return a[5] < b[5] ? -1 : 1;
    });
    return ranked[0];
  }

  if (wanted === 'DOKTER DPJB') {
    for (const row of masterRows) if (isDpjbName(row['nama_tindakan'])) return row;
    for (const row of listRows) if (isDpjbName(row['nama_tindakan'])) return row;
    return undefined;
  }

  if (wanted === 'VISITE DOKTER SPESIALIS') {
    const targetName = 'VISITE DOKTER SPESIALIS';
    for (const row of masterRows) if (collapseUpper(row['nama_tindakan']) === targetName) return row;
    for (const row of listRows) if (collapseUpper(row['nama_tindakan']) === targetName) return row;
    return undefined;
  }

  for (const row of masterRows) if (str(row, 'nama_tindakan').toUpperCase() === wanted) return row;
  for (const row of listRows) if (str(row, 'nama_tindakan').toUpperCase() === wanted) return row;
  return undefined;
}

/**
 * The meta-selection half of `tambah_biaya_ruang_verifikator`
 * (`ranap_v3.py:14914`): honour the preferred `kd_tindakan`, then the preferred
 * name, then fall back to the room-charge score ladder over the verifikator
 * master. The write and its logging stay in the executor.
 */
export function pickVerifikatorRoomMeta(
  verifikatorMasterRows: readonly LegacyRow[],
  preferredMeta?: LegacyRow | null,
  roomName = '',
): LegacyRow | undefined {
  const preferredKd = str(nonEmptyRow(preferredMeta), 'kd_tindakan');
  const preferredName = str(nonEmptyRow(preferredMeta), 'nama_tindakan').toUpperCase();
  if (preferredKd) {
    for (const row of verifikatorMasterRows) {
      if (str(row, 'kd_tindakan') === preferredKd) return row;
    }
  }
  if (preferredName) {
    for (const row of verifikatorMasterRows) {
      if (str(row, 'nama_tindakan').toUpperCase() === preferredName) return row;
    }
  }
  return pickTindakanMeta(verifikatorMasterRows, [], { roomCharge: true, roomName });
}

// ---------------------------------------------------------------------------
// Komponen / pelaksana helpers
// ---------------------------------------------------------------------------

/** `_get_komponen_detail_rows` (`ranap_v3.py:4290`), filtered by `kd_komponen`. */
export function getKomponenDetailRows(
  row: LegacyRow,
  komponenRows: KomponenRowsProvider | undefined,
  kdKomponen = '',
): LegacyRow[] {
  const detail = komponenRows ? komponenRows(row) : undefined;
  const rows = [...(detail ?? [])];
  const target = String(kdKomponen ?? '').trim();
  if (!target) return rows;
  return rows.filter((item) => str(item, 'kd_komponen') === target);
}

/** `_get_komponen_detail_item` (`ranap_v3.py:4321`) — the first matching component. */
export function getKomponenDetailItem(
  row: LegacyRow,
  komponenRows: KomponenRowsProvider | undefined,
  kdKomponen = '',
): LegacyRow {
  return getKomponenDetailRows(row, komponenRows, kdKomponen)[0] ?? {};
}

/**
 * `_get_komponen_paramedis_name` (`ranap_v3.py:4264`).
 *
 * Tri-state, and the caller depends on it: `undefined` = the component list is
 * empty (Python `None`), `''` = components exist but none names a paramedic,
 * otherwise the first usable name. `"-"`, `"None"` and `"null"` all read as no
 * name.
 */
export function getKomponenParamedisName(
  row: LegacyRow,
  komponenRows: KomponenRowsProvider | undefined,
  kdKomponen = '',
): string | undefined {
  const detailRows = getKomponenDetailRows(row, komponenRows, kdKomponen);
  if (detailRows.length === 0) return undefined;
  for (const item of detailRows) {
    const raw = item['nama_paramedis'];
    if (raw === undefined || raw === null) continue;
    const nama = String(raw).trim();
    if (nama && nama !== '-' && !['NONE', 'NULL'].includes(compactTextKey(nama))) return nama;
  }
  return '';
}

/**
 * `_resolve_jasa_pelaksana_component` (`ranap_v3.py:9495`) — which component of
 * a jasa row carries the performer. Scored `(is 98/29, names JASA or DOKTER,
 * already has a paramedic)`, highest wins, ties keep the server's order.
 */
export function resolveJasaPelaksanaComponent(
  row: LegacyRow,
  komponenRows: KomponenRowsProvider | undefined,
): LegacyRow {
  const detailRows = getKomponenDetailRows(row, komponenRows);
  if (detailRows.length === 0) return {};
  const score = (item: LegacyRow): readonly [number, number, number] => {
    const kdKomponen = str(item, 'kd_komponen');
    const namaKomponen = normalizeTextKey(item['nama_komponentarif']);
    const namaParamedis = str(item, 'nama_paramedis');
    const hasParamedis = Boolean(namaParamedis && !['NONE', 'NULL'].includes(compactTextKey(namaParamedis)));
    return [
      ['98', '29'].includes(kdKomponen) ? 1 : 0,
      namaKomponen.includes('JASA') || namaKomponen.includes('DOKTER') ? 1 : 0,
      hasParamedis ? 1 : 0,
    ];
  };
  return sortDescStable(detailRows, (a, b) => {
    const left = score(a);
    const right = score(b);
    for (let i = 0; i < 3; i += 1) {
      const x = left[i] as number;
      const y = right[i] as number;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  })[0] as LegacyRow;
}

/**
 * `_resolve_oksigen_pelaksana_component` (`ranap_v3.py:4307`) — the BHP
 * component of an oxygen line, else the first component with any code, else
 * `''` (which makes the caller skip the row entirely).
 */
export function resolveOksigenPelaksanaComponent(
  row: LegacyRow,
  komponenRows: KomponenRowsProvider | undefined,
): string {
  const detailRows = getKomponenDetailRows(row, komponenRows);
  if (detailRows.length === 0) return '';
  for (const item of detailRows) {
    if (normalizeTextKey(item['nama_komponentarif']).includes('BHP')) return str(item, 'kd_komponen');
  }
  for (const item of detailRows) {
    const kdKomponen = str(item, 'kd_komponen');
    if (kdKomponen) return kdKomponen;
  }
  return '';
}

/**
 * `_pick_intermediate_paramedis_name` (`ranap_v3.py:4328`) — the first dropdown
 * option that is not one of `excludeNames`, used by the two-step retry when a
 * direct pelaksana update is refused.
 *
 * `_tampung_pelaksana_checked`'s retry ladder (`ranap_v3.py:4440-4597` — write,
 * re-read, park the row on an intermediate paramedis, write again, then
 * confirm) is driven from `executors.ts` across re-plan passes, not from here: a
 * planner cannot see a write result, but a *later pass* can read the previous
 * pass's outcome out of `ctx.mutations`. This helper and
 * {@link resolveExactParamedisName} are what that ladder is built from.
 */
export function pickIntermediateParamedisName(
  paramedisOptions: readonly LegacyRow[] | undefined,
  excludeNames: readonly string[] = [],
): string {
  const excludeKeys = new Set(
    excludeNames.filter((item) => String(item ?? '').trim()).map((item) => normalizeParamedisDisplay(item)),
  );
  for (const item of paramedisOptions ?? []) {
    const namaParamedis = str(item, 'nama_paramedis');
    if (!namaParamedis) continue;
    if (excludeKeys.has(normalizeParamedisDisplay(namaParamedis))) continue;
    return namaParamedis;
  }
  return '';
}

/**
 * `_resolve_exact_paramedis_name` (`ranap_v3.py:4347`) — snap a desired name to
 * the exact spelling the dropdown uses. An exact normalised hit wins; a single
 * relaxed hit is accepted; two or more relaxed hits are ambiguous, so the
 * original text is kept rather than guessing.
 */
export function resolveExactParamedisName(
  desiredName: string,
  paramedisOptions: readonly LegacyRow[] | undefined,
): string {
  const rawName = String(desiredName ?? '').trim();
  if (!rawName) return '';
  const options = paramedisOptions ?? [];
  if (options.length === 0) return rawName;

  const desiredKey = normalizeParamedisDisplay(rawName);
  const exactMatches: string[] = [];
  const relaxedMatches: string[] = [];
  for (const item of options) {
    const namaStripped = str(item, 'nama_paramedis');
    if (!namaStripped) continue;
    if (normalizeParamedisDisplay(namaStripped) === desiredKey) {
      exactMatches.push(namaStripped);
      continue;
    }
    if (doctorNameMatchesRelaxed(namaStripped, rawName)) relaxedMatches.push(namaStripped);
  }
  if (exactMatches.length > 0) return exactMatches[0] as string;
  if (relaxedMatches.length === 1) return relaxedMatches[0] as string;
  return rawName;
}

/**
 * `_is_pelaksana_already_correct` (`ranap_v3.py:4377`).
 *
 * With a desired name: correct only when a name is present and matches. With an
 * empty desired name (DPJB, oksigen — the field must be *blank*): correct only
 * when the component carries no name at all. An empty component list is never
 * "already correct", so the caller will plan a write.
 */
export function isPelaksanaAlreadyCorrect(
  row: LegacyRow,
  komponenRows: KomponenRowsProvider | undefined,
  desiredName = '',
  kdKomponen = '',
): { alreadyCorrect: boolean; currentName: string } {
  const currentName = getKomponenParamedisName(row, komponenRows, kdKomponen);
  if (currentName === undefined) return { alreadyCorrect: false, currentName: '' };
  const currentKey = normalizeParamedisDisplay(currentName);
  const desiredKey = normalizeParamedisDisplay(desiredName);
  if (desiredKey) {
    return { alreadyCorrect: Boolean(currentKey) && currentKey === desiredKey, currentName };
  }
  return { alreadyCorrect: currentKey === '', currentName };
}

/** Tokens that disqualify a line from the generic room-pelaksana sweep. */
const GENERIC_ROOM_BLOCKED_TOKENS: readonly string[] = [
  'BIAYA ',
  'ADMINISTRASI',
  'PENDAFTARAN',
  'KARTU PASIEN',
  'DOKTER',
  'SPESIALIS',
  'LABORATORIUM',
  'RADIOLOGI',
  'ELEKTROMEDIK',
  'GIZI',
  'DEPO',
  'OBAT',
  'POLIKLINIK',
  'UGD',
  'IBS',
  'OPERASI',
  'BEDAH SENTRAL',
  'BANK DARAH',
];

/** Tokens that mark a line as nursing work the ward performs. */
const GENERIC_ROOM_INCLUDE_TOKENS: readonly string[] = [
  'PASANG',
  'PEMASANGAN',
  'PENGAMBILAN',
  'SAMPLING',
  'STABILISASI',
  'MEDIKASI',
  'INJEKSI',
  'INFUS',
  'INFUSE',
  'TRANSFUSI',
  'BIDAI',
  'OKSIGEN',
  'NEBULIZER',
  'SYRINGE',
  'SYRING ',
  'SUCTION',
  'BED SIDE',
  'MONITOR',
  'WSD',
  'NGT',
  'SONDE',
  'VACUM',
  'VACUUM',
  'BLUE LIGHT',
  'RJP',
  'PUNGSI',
  'DRAIN',
  'HEACTING',
  'DC',
];

/**
 * `_is_generic_room_pelaksana_candidate` (`ranap_v3.py:4600`) — should this
 * non-structural line be credited to the ward's nurse?
 *
 * The order of the early returns decides the answer, so it is preserved
 * verbatim: oxygen out (it has its own rule), the three structural charges out,
 * visite/konsultasi out, then the blocked-token sweep, then the include-token
 * sweep as a positive answer. Only if *neither* token list matches does it fall
 * through to the expensive check: a line already credited to some *other* known
 * ward nurse is re-pointed at this ward's nurse; anything else is left alone.
 */
export function isGenericRoomPelaksanaCandidate(
  row: LegacyRow,
  options: {
    roomPelaksana?: string;
    komponenRows?: KomponenRowsProvider;
    roomPelaksanaOptionNames?: readonly string[];
  } = {},
): boolean {
  const namaTindakan = normalizeTextKey(row['nama_tindakan']);
  const roomPelaksana = options.roomPelaksana ?? '';
  if (!namaTindakan || !roomPelaksana) return false;
  if (isOksigenBhpName(namaTindakan)) return false;
  if (['jasa', 'dpjb', 'room'].includes(matchActionKey(row))) return false;
  if (
    isVisiteSpesialisName(namaTindakan) ||
    isVisiteDrAnakScnName(namaTindakan) ||
    isKonsultasiTeleponName(namaTindakan)
  ) {
    return false;
  }
  if (GENERIC_ROOM_BLOCKED_TOKENS.some((token) => namaTindakan.includes(token))) return false;
  if (GENERIC_ROOM_INCLUDE_TOKENS.some((token) => namaTindakan.includes(token))) return true;

  const currentName = getKomponenParamedisName(row, options.komponenRows, '98');
  const currentKey = normalizeParamedisDisplay(currentName ?? '');
  const desiredKey = normalizeParamedisDisplay(roomPelaksana);
  if (!currentKey || currentKey === desiredKey) return false;

  const knownRoomKeys = new Set(options.roomPelaksanaOptionNames ?? []);
  return knownRoomKeys.has(currentKey);
}

/**
 * `_get_spesialis_action_key` (`ranap_v3.py:10191`) — the specialist-charge
 * bucket a row belongs to. The SCN test runs before the general visite test.
 */
export function getSpesialisActionKey(row: LegacyRow): 'visite_scn' | 'visite' | 'konsultasi' | '' {
  const nama = row['nama_tindakan'];
  if (isVisiteDrAnakScnName(nama)) return 'visite_scn';
  if (isVisiteSpesialisName(nama)) return 'visite';
  if (isKonsultasiTeleponName(nama)) return 'konsultasi';
  return '';
}

// ---------------------------------------------------------------------------
// Delete gating — `_row_allows_delete_by_hint`, `_boleh_hapus_tindakan`
// ---------------------------------------------------------------------------

/**
 * `_row_allows_delete_by_hint` (`ranap_v3.py:12270`) — the cheap, offline half
 * of the delete gate, read straight off the row.
 *
 * Any of four signals blocks the delete: the generic `flag`, a non-zero
 * `status_verifikasi`, a `status_bayar` outside `{0, BELUM, BELUM BAYAR}`, or a
 * `nama_jenispembayaran`/`jenis_bayar` outside `{-, 0, BELUM, BELUM BAYAR}`.
 */
export function rowAllowsDeleteByHint(row: LegacyRow): boolean {
  const flagText = String(row['flag'] ?? '').trim().toLowerCase();
  if (['1', 'true'].includes(flagText)) return false;
  const statusVerifikasiHint = String(row['status_verifikasi'] ?? '').trim();
  if (statusVerifikasiHint && !['0', 'false', 'False'].includes(statusVerifikasiHint)) return false;
  const statusBayar = compactTextKey(row['status_bayar']);
  if (statusBayar && !['0', 'BELUM', 'BELUMBAYAR'].includes(statusBayar)) return false;
  const jenisBayar = compactTextKey(row['nama_jenispembayaran'] ?? row['jenis_bayar']);
  if (jenisBayar && !['-', '0', 'BELUM', 'BELUMBAYAR'].includes(jenisBayar)) return false;
  return true;
}

/**
 * `_ensure_tindakan_belum_terverifikasi` (`ranap_v3.py:12286`), on the
 * `DRY_RUN` path.
 *
 * The Python calls `batal_verifikasi` to *make* a verified row editable; under
 * `DRY_RUN` it returns `False` instead, and so does this planner — it never
 * un-verifies anything, because it never writes. The escalation itself is not
 * dropped: `executors.ts` turns it into an approvable
 * `verifikator.batalVerifikasi` `MutationPlan` for the rows this function
 * refused, and the edit those rows needed is planned on the next pass, once the
 * un-verification has landed and read back. See `planBatalVerifikasi` there.
 *
 * Note that `_boleh_hapus_tindakan` always runs `rowAllowsDeleteByHint` first,
 * which already rejects every non-zero `status_verifikasi` hint, so the provider
 * is only consulted for rows whose hint was absent.
 */
export function ensureTindakanBelumTerverifikasi(
  row: LegacyRow,
  statusVerifikasiTindakan?: RowStatusProvider,
): boolean {
  const hint = String(row['status_verifikasi'] ?? '').trim();
  if (['', '0', 'false', 'False'].includes(hint)) return true;
  const status = String(statusVerifikasiTindakan?.(row) ?? '').trim();
  if (['', '0'].includes(status)) return true;
  return false; // DRY_RUN: no `batal_verifikasi` from a planner.
}

/** Why a row may not be deleted, or `''` when it may. */
export type DeleteBlockReason =
  | ''
  | 'tindakan dilindungi dan tidak boleh dihapus'
  | 'sudah bayar / verifikasi'
  | 'status bayar tindakan belum bisa dipastikan (butuh cekstatusbayar_tindakan)';

/**
 * `_boleh_hapus_tindakan` (`ranap_v3.py:12307`), returning *why* rather than a
 * bare boolean so the refusal can be logged the way the legacy logs it.
 *
 * Order is load-bearing: the protected-charge list, then the row hints, then
 * the verification gate, then — only when the `status` hint is inconclusive —
 * `cekstatusbayar_tindakan`. One deliberate deviation: when that last read is
 * required and no provider was supplied, this fails **closed** (the Python
 * would treat an unreachable endpoint's empty answer as "unpaid"). A plan that
 * declines to delete is safe; one that deletes a paid line is not.
 */
export function bolehHapusTindakan(
  row: LegacyRow,
  options: {
    statusBayarTindakan?: RowStatusProvider;
    statusVerifikasiTindakan?: RowStatusProvider;
  } = {},
): DeleteBlockReason {
  if (isProtectedNonDeletableCharge(row['nama_tindakan'])) {
    return 'tindakan dilindungi dan tidak boleh dihapus';
  }
  if (!rowAllowsDeleteByHint(row)) return 'sudah bayar / verifikasi';
  if (!ensureTindakanBelumTerverifikasi(row, options.statusVerifikasiTindakan)) {
    return 'sudah bayar / verifikasi';
  }
  const statusHint = String(row['status'] ?? '').trim();
  const statusBayarHint = compactTextKey(row['status_bayar']);
  const jenisBayarHint = compactTextKey(row['nama_jenispembayaran'] ?? row['jenis_bayar']);
  if (
    ['', '0', 'false', 'False'].includes(statusHint) &&
    (!statusBayarHint || ['0', 'BELUM', 'BELUMBAYAR'].includes(statusBayarHint)) &&
    (!jenisBayarHint || ['-', '0', 'BELUM', 'BELUMBAYAR'].includes(jenisBayarHint))
  ) {
    return '';
  }
  if (!options.statusBayarTindakan) {
    return 'status bayar tindakan belum bisa dipastikan (butuh cekstatusbayar_tindakan)';
  }
  const statusBayar = String(options.statusBayarTindakan(row) ?? '').trim();
  return ['', '0'].includes(statusBayar) ? '' : 'sudah bayar / verifikasi';
}

// ---------------------------------------------------------------------------
// The rekapitulasi corruption detectors
// ---------------------------------------------------------------------------

const TR_BLOCK_PATTERN = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const BOLD_CELL_PATTERN = /<td[^>]*>\s*<b>([\s\S]*?)<\/b>\s*<\/td>/gi;

function boldCells(block: string): string[] {
  const cells: string[] = [];
  BOLD_CELL_PATTERN.lastIndex = 0;
  let match = BOLD_CELL_PATTERN.exec(block);
  while (match) {
    cells.push(match[1] ?? '');
    match = BOLD_CELL_PATTERN.exec(block);
  }
  return cells;
}

function trBlocks(html: string): Array<{ whole: string; inner: string }> {
  const blocks: Array<{ whole: string; inner: string }> = [];
  TR_BLOCK_PATTERN.lastIndex = 0;
  let match = TR_BLOCK_PATTERN.exec(html);
  while (match) {
    blocks.push({ whole: match[0], inner: match[1] ?? '' });
    match = TR_BLOCK_PATTERN.exec(html);
  }
  return blocks;
}

/**
 * `_get_malformed_rekap_jasa_dates` (`ranap_v3.py:9514`) — the days where the
 * rekapitulasi renders a jasa line with its pelaksana printed **twice**
 * (".../PERAWAT X/PERAWAT X"), a known server bug whose only fix is to delete
 * and re-add the charge.
 */
export function getMalformedRekapJasaDates(html: string | undefined): MalformedRekapEntry[] {
  if (!html) return [];
  const hasil: MalformedRekapEntry[] = [];
  for (const block of trBlocks(html)) {
    if (!block.whole.toUpperCase().includes('JASA PELAYANAN')) continue;
    const cells = boldCells(block.whole);
    if (cells.length < 2) continue;
    const rowDate = datePart(stripHtmlText(cells[0]));
    const tindakanText = stripHtmlText(cells[1]);
    const parts = tindakanText
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part);
    if (parts.length < 3) continue;
    const last = parts[parts.length - 1] as string;
    const beforeLast = parts[parts.length - 2] as string;
    if (normalizeTextKey(last) !== normalizeTextKey(beforeLast)) continue;
    hasil.push({ date: rowDate, text: tindakanText, pelaksana: last });
  }
  return hasil;
}

/**
 * `_get_malformed_rekap_room_charge_dates` (`ranap_v3.py:9545`) — the days where
 * the rekapitulasi prints a pelaksana on a *room* charge, which it must never
 * do. Same remedy: delete so it can be re-added clean.
 */
export function getMalformedRekapRoomChargeDates(html: string | undefined): MalformedRekapEntry[] {
  if (!html) return [];
  const hasil: MalformedRekapEntry[] = [];
  for (const block of trBlocks(html)) {
    const cells = boldCells(block.inner);
    if (cells.length < 2) continue;
    const rowDate = datePart(stripHtmlText(cells[0]));
    const tindakanText = stripHtmlText(cells[1]);
    const parts = tindakanText
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part);
    if (parts.length < 2) continue;
    if (!isRoomChargeName(parts[0])) continue;
    hasil.push({ date: rowDate, text: tindakanText, pelaksana: parts[parts.length - 1] as string });
  }
  return hasil;
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/** One `label: value` pair inside a legacy log block. */
type LogDetail = readonly [string, unknown];

/** `_log_sync_detail_block` (`ranap_v3.py:1278`) — title, aligned pairs, rows. */
function syncDetailBlock(
  title: string,
  details: readonly LogDetail[] = [],
  rows?: readonly LegacyRow[],
  listGroups: ReadonlyArray<readonly [string, readonly unknown[]]> = [],
): string[] {
  const lines = [`- ${title}`];
  for (const [label, value] of details) {
    lines.push(`  ${dash(label).padEnd(9)}: ${dash(value)}`);
  }
  for (const [label, values] of listGroups) {
    const normalized = values.map((item) => dash(item)).filter((item) => item !== '-');
    if (normalized.length === 0) {
      lines.push(`  ${dash(label).padEnd(9)}: -`);
      continue;
    }
    lines.push(`  ${dash(label).padEnd(9)}:`);
    for (const item of normalized) lines.push(`    - ${item}`);
  }
  if (rows !== undefined) {
    if (rows.length === 0) lines.push('  Rows     : -');
    else {
      lines.push('  Rows     :');
      for (const row of rows) lines.push(`    - [${rowLogLabel(row)}]`);
    }
  }
  return lines;
}

/** `_log_room_sync_item` (`ranap_v3.py:14076`) — `- Title | key=value | …`. */
function roomSyncItem(title: string, details: readonly LogDetail[]): string {
  const parts = details.map(([key, value]) => `${key}=${dash(value)}`);
  return parts.length > 0 ? `- ${title} | ${parts.join(' | ')}` : `- ${title}`;
}

/**
 * The mutable working set. Applies each planned operation's assumed effect so
 * the later phases see what the Python's post-write `_refresh_listtindakan_inap`
 * would have returned.
 */
class WorkingRows {
  rows: LegacyRow[];

  constructor(rows: readonly LegacyRow[]) {
    this.rows = [...rows];
  }

  remove(row: LegacyRow): void {
    const index = this.rows.indexOf(row);
    if (index >= 0) this.rows.splice(index, 1);
  }

  /** Assume `update_tgl` landed: the row now carries `targetDatetime`. */
  redate(row: LegacyRow, targetDatetime: string): void {
    const index = this.rows.indexOf(row);
    if (index < 0) return;
    this.rows[index] = { ...row, tgl_jam: targetDatetime, tgl_transaksi: targetDatetime };
  }
}

type OpDraft = Omit<TindakanOp, 'sequence' | 'noTransaksi' | 'noRegistrasikunjungan'>;

/**
 * `sinkronkan_tindakan_harian_inap` (`ranap_v3.py:13964`) as a planner.
 *
 * Phases, in the Python's own order — the `ops` list must be applied in this
 * order or the later decisions no longer hold:
 *
 *  1. `_cleanup_exact_timestamp_duplicates_inap` — byte-identical duplicates.
 *  2. target-date derivation (`_iter_date_parts` + the observed-range widening).
 *  3. the no-assigned-day branch: clean up jasa/dpjb/room and stop.
 *  4. `_sinkronkan_tanggal_igd` — IGD/UGD charges to the SEP date.
 *  5. `_sinkronkan_tanggal_poliklinik` — poli charges to the SEP date.
 *  6. `_sinkronkan_tanggal_elektromedik` — to the elektromedik history dates.
 *  7. `_sinkronkan_tanggal_penunjang_generic` × lab, PA, radiology.
 *  8. `_sinkronkan_tanggal_depo_ibs` — depot lines to their IBS charge dates.
 *  9. `_sinkronkan_tanggal_biaya_obat_inap` — **disabled in the legacy**
 *     (`ranap_v3.py:12798` returns `False` before any logic runs), so this port
 *     emits nothing and records the BIAYA OBAT rows as untouched with that
 *     reason. Do not "fix" this without re-enabling the Python first.
 * 10. the empty-room-charge preflight (verifikator fallback add).
 * 11. `_rebalance_action_rows_inap` × jasa, dpjb, room.
 * 12. the per-day add loop × jasa, dpjb, room.
 * 13. `_cleanup_action_rows_inap` × jasa, dpjb, room.
 * 14. `_cleanup_out_of_range_rows_inap` × dpjb, room.
 * 15. `_repair_malformed_jasa_rekap_inap`, `_repair_malformed_room_charge_rekap_inap`.
 * 16. the pelaksana sweeps: jasa, DPJB (blank), oksigen (blank), then the
 *     generic ward/partus lines.
 */
export function planTindakanSync(args: PlanTindakanSyncArgs): TindakanSyncPlan {
  const kunjunganInap = args.kunjunganInap ?? {};
  const noTransaksi = str(kunjunganInap, 'no_transaksi');
  const noRegistrasikunjungan = str(kunjunganInap, 'no_registrasikunjungan');

  const ops: TindakanOp[] = [];
  const untouched: TindakanUntouchedRow[] = [];
  const issues: TindakanSyncIssue[] = [];
  const lines: string[] = [];
  const issueKeys = new Set<string>();
  let targetDates: string[] = [];

  const plan = (): TindakanSyncPlan => ({
    noTransaksi,
    noRegistrasikunjungan,
    targetDates: [...targetDates],
    ops,
    untouched,
    issues,
    lines,
  });

  /** `_register_sync_issue` — `phase: detail`, de-duplicated, capped at 240. */
  const registerIssue = (level: TindakanSyncIssue['level'], phase: string, detail = ''): void => {
    if (!noRegistrasikunjungan) return;
    const phaseText = String(phase ?? 'sync').trim() || 'sync';
    const message = (detail ? `${phaseText}: ${detail}` : phaseText).slice(0, 240);
    const key = `${level}|${message}`;
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push({ level, message });
  };

  const emit = (draft: OpDraft): TindakanOp => {
    const op: TindakanOp = {
      ...draft,
      noTransaksi,
      noRegistrasikunjungan,
      sequence: ops.length + 1,
    };
    ops.push(op);
    return op;
  };

  const leaveAlone = (row: LegacyRow, reason: string): void => {
    untouched.push({ row, reason });
  };

  /** The `if DEBUG_MODE` tail the `_log_room_sync_item` calls all share. */
  const debugDetails = (row: LegacyRow, kdKomponen: string): LogDetail[] =>
    args.debug
      ? [
          ['komponen', kdKomponen || '-'],
          ['row', rowLogLabel(row)],
        ]
      : [];

  if (!noTransaksi || !noRegistrasikunjungan) {
    // `ranap_v3.py:13967` — the legacy returns without a word.
    return plan();
  }

  const now = args.now ?? new Date();
  const datakunjungan = args.datakunjungan ?? {};
  const datakunjunganTab = args.datakunjunganTab ?? {};
  const datakunjunganTab2 = args.datakunjunganTab2 ?? {};
  const masterRows = args.masterRows ?? [];
  const komponenRows = args.komponenRows;
  const deleteGate = {
    statusBayarTindakan: args.statusBayarTindakan,
    statusVerifikasiTindakan: args.statusVerifikasiTindakan,
  };

  const kdUnit = str(datakunjungan, 'kd_unit') || str(kunjunganInap, 'kd_unit');
  const kdDetkelpenjamin =
    str(datakunjunganTab, 'kd_detkelpenjamin') ||
    str(datakunjungan, 'kd_detkelpenjamin') ||
    str(kunjunganInap, 'kd_detkelpenjamin') ||
    '15';
  const kdKamarperawatan =
    str(datakunjunganTab, 'kd_kamarperawatan') ||
    str(kunjunganInap, 'kd_kamarperawatan') ||
    str(datakunjunganTab2, 'kd_kamarperawatan') ||
    str(datakunjungan, 'kd_kamarperawatan');
  const kdParamedis =
    str(datakunjungan, 'kd_paramedis') ||
    str(kunjunganInap, 'kd_paramedis') ||
    str(datakunjunganTab2, 'kd_paramedis');
  const namaPasien = str(datakunjungan, 'nama_pasien') || str(kunjunganInap, 'nama_pasien');
  const dokterPasien = str(datakunjungan, 'nama_paramedis') || str(kunjunganInap, 'nama_paramedis');
  const isByny = isBynyPatient(namaPasien);
  const roomName = str(kunjunganInap, 'nama_unit') || str(datakunjungan, 'nama_unit');
  const roomSegments = extractRoomSegments(roomName);
  const roomPelaksana = String(args.roomPelaksana ?? '').trim();
  const tglSep = String(args.tglSep ?? '').trim();
  const tglMasukRuang = datePart(
    str(kunjunganInap, 'tgl_masuk') || str(datakunjungan, 'tgl_masuk') || tglSep,
  );
  let tglKeluarRuang = datePart(str(kunjunganInap, 'tgl_keluar') || str(datakunjungan, 'tgl_keluar'));

  const working = new WorkingRows(args.listRows ?? []);

  // ── Phase 1: `_cleanup_exact_timestamp_duplicates_inap` ───────────
  cleanupExactTimestampDuplicates();

  // ── Phase 2: target dates ────────────────────────────────────────
  if (!tglKeluarRuang) {
    const existingDates = working.rows
      .filter((row) => matchActionKey(row))
      .map((row) => rowDatePart(row))
      .filter((date) => date);
    tglKeluarRuang = existingDates.length > 0 ? maxOf(existingDates) : tglMasukRuang;
  }

  const rawTargetDates = iterDateParts(
    tglMasukRuang || tglSep,
    tglKeluarRuang || tglMasukRuang || tglSep,
  );
  if (args.targetDatesOverride !== undefined) {
    targetDates = uniqueSorted(args.targetDatesOverride);
  } else {
    targetDates = rawTargetDates;
    const observedStructuralDates = uniqueSorted(
      working.rows.filter((row) => matchActionKey(row)).map((row) => rowDatePart(row)),
    );
    const observedStructuralRange =
      observedStructuralDates.length > 0
        ? iterDateParts(
            observedStructuralDates[0] as string,
            observedStructuralDates[observedStructuralDates.length - 1] as string,
          )
        : [];
    const expandedTargetDates = uniqueSorted([
      ...targetDates,
      ...rawTargetDates,
      ...observedStructuralRange,
    ]);
    if (
      expandedTargetDates.length > 0 &&
      (targetDates.length === 0 || expandedTargetDates.length > uniqueSorted(targetDates).length)
    ) {
      if (observedStructuralRange.length > 0) {
        lines.push(
          `- Perluas target tanggal rawat inap | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
            `raw=${rawTargetDates.join(',') || '-'} | ` +
            `observed=${observedStructuralRange.join(',') || '-'} | final=${expandedTargetDates.join(',') || '-'}`,
        );
      }
      targetDates = expandedTargetDates;
    }
  }
  if (args.targetDatesOverride === undefined && targetDates.length === 0) {
    lines.push(`- Range tanggal rawat inap tidak valid untuk ${noTransaksi}`);
    registerIssue('ERROR', 'range_tanggal_rawat_inap', `trx=${noTransaksi} tidak valid`);
    return plan();
  }

  // ── meta selection ───────────────────────────────────────────────
  const roomBasedJasaClass = extractRoomClassKey(kunjunganInap);
  const roomMeta = pickTindakanMeta(masterRows, working.rows, {
    roomCharge: true,
    roomName,
    preferredRoomClass: roomBasedJasaClass,
  });
  const existingJasaClass = resolveExistingJasaCategoryClass(working.rows, targetDates);
  let jasaPreferredClass = existingJasaClass || roomBasedJasaClass;
  const roomMetaClass = normalizeCareClassKey(roomMeta?.['nama_tindakan']);
  if (
    ['KELAS 1', 'KELAS 2', 'KELAS 3'].includes(roomMetaClass) &&
    !['KELAS 1', 'KELAS 2', 'KELAS 3'].includes(jasaPreferredClass)
  ) {
    jasaPreferredClass = roomMetaClass;
  }
  if (args.debug && existingJasaClass) {
    lines.push(
      `- Deteksi kategori jasa dari list tindakan | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
        `room=${roomName || '-'} | kelas_jasa=${existingJasaClass} | ` +
        `kelas_ruang=${roomBasedJasaClass || '-'} | target_dates=${targetDates.join(',') || '-'}`,
    );
  }
  const actionMeta: Record<TindakanActionKey, LegacyRow | undefined> = {
    jasa: pickTindakanMeta(masterRows, working.rows, {
      exactName: 'JASA PELAYANAN',
      roomName,
      preferredRoomClass: jasaPreferredClass,
    }),
    dpjb: pickTindakanMeta(masterRows, working.rows, { exactName: 'DOKTER DPJB' }),
    room: roomMeta,
  };
  const jasaIsOptional = isByny;

  if (args.debug) {
    lines.push(
      `Sinkronisasi rawat inap | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
        `tanggal=${
          targetDates.length > 0
            ? `${targetDates[0] as string} s/d ${targetDates[targetDates.length - 1] as string}`
            : '<no-assigned-day>'
        } | room=${roomName || '-'} | ` +
        `room_segments=${roomSegments.join(',') || '-'} | pelaksana_jasa=${roomPelaksana || '-'}`,
    );
  }
  if (jasaIsOptional) {
    lines.push(
      `- Jasa pelayanan opsional | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
        `alasan=pasien BYNY | catatan=jasa pelayanan tidak selalu tersedia dari server, jadi tidak dipaksa wajib per tanggal`,
    );
  }

  // ── Phase 3: no assigned day at all ──────────────────────────────
  if (args.targetDatesOverride !== undefined && targetDates.length === 0) {
    lines.push(
      `- Transaksi rawat inap tanpa assigned day | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
        `room=${roomName || '-'} | aksi=cleanup room/jasa/dpjb lalu skip sinkronisasi harian`,
    );
    for (const actionKey of ['jasa', 'dpjb', 'room'] as const) {
      const cleanupRoomMeta = actionKey === 'room' ? actionMeta.room : undefined;
      const actionRows = filterActionRows(working.rows, actionKey, [], {
        roomMeta: actionKey === 'room' ? undefined : actionMeta.room,
      });
      cleanupActionRows(actionKey, actionRows, [], cleanupRoomMeta, actionMeta[actionKey]);
    }
    return plan();
  }

  const targetDateSet = new Set(targetDates);

  // ── Phases 4–8: the source-of-truth date alignment rules ─────────
  syncTanggalIgd();
  syncTanggalPoliklinik();
  syncTanggalElektromedik();
  if ((args.labTargetRows ?? []).length > 0) {
    lines.push(
      ...syncDetailBlock(
        'Target history BIAYA LABORATORIUM',
        [['Trx', noTransaksi]],
        undefined,
        [
          [
            'Targets',
            (args.labTargetRows ?? [])
              .map((item) => datePart(str(item, 'tgl_transaksi')))
              .filter((date) => date),
          ],
          ['Lab trx', (args.labTargetRows ?? []).map((item) => dash(str(item, 'no_transaksi')))],
        ],
      ),
    );
  }
  syncTanggalPenunjangGeneric(
    args.labTargetRows ?? [],
    (name) => name === 'BIAYA LABORATORIUM',
    'BIAYA LABORATORIUM',
  );
  syncTanggalPenunjangGeneric(
    args.paHistory ?? [],
    (name) => name.includes('BIAYA LABORATORIUM PA'),
    'BIAYA LABORATORIUM PA',
    args.paDetailCount,
  );
  syncTanggalPenunjangGeneric(
    args.radHistory ?? [],
    (name) => name.includes('BIAYA RADIOLOGI'),
    'BIAYA RADIOLOGI',
    args.radDetailCount,
  );
  syncTanggalDepoIbs();
  syncTanggalBiayaObat();

  // ── Phase 10: preflight — no room charge on the bill at all ──────
  const existingRoomRows = working.rows.filter((row) => isRoomChargeName(row['nama_tindakan']));
  if (existingRoomRows.length === 0) {
    lines.push(
      `- Preflight biaya ruang kosong | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
        `room=${roomName || '-'} | aksi=coba fallback verifikator`,
    );
    const fallbackMeta = pickVerifikatorRoomMeta(
      args.verifikatorMasterRows ?? [],
      actionMeta.room,
      str(kunjunganInap, 'nama_unit') || str(args.verifikatorDatakunjungan, 'nama_unit'),
    );
    if (fallbackMeta) {
      const verifikatorTab = args.verifikatorDatakunjunganTab ?? {};
      const verifikatorData = args.verifikatorDatakunjungan ?? {};
      emit({
        kind: 'tambah',
        endpointId: TINDAKAN_SYNC_ENDPOINTS.tambahVerifikator,
        actionKey: 'room',
        phase: 'tambah_biaya_ruang_verifikator',
        kdTindakan: str(fallbackMeta, 'kd_tindakan'),
        namaTindakan: str(fallbackMeta, 'nama_tindakan'),
        harga: str(fallbackMeta, 'harga'),
        kdUnit: str(verifikatorData, 'kd_unit') || str(kunjunganInap, 'kd_unit'),
        kdParamedis: str(verifikatorData, 'kd_paramedis') || str(kunjunganInap, 'kd_paramedis'),
        kdDetkelpenjamin:
          str(verifikatorData, 'kd_detkelpenjamin') || str(kunjunganInap, 'kd_detkelpenjamin') || '15',
        kdKamar:
          str(verifikatorTab, 'kd_kamarperawatan') ||
          str(verifikatorData, 'kd_kamarperawatan') ||
          str(kunjunganInap, 'kd_kamarperawatan'),
        reason: 'biaya ruang rawat inap belum ada sama sekali pada transaksi ini',
      });
    } else {
      lines.push(
        `- Fallback biaya ruang verifikator gagal: master tindakan tidak ditemukan | ` +
          `trx=${noTransaksi} | reg=${noRegistrasikunjungan} | kd_unit=${kdUnit || '-'} | ` +
          `kd_detkelpenjamin=${kdDetkelpenjamin || '-'}`,
      );
      registerIssue(
        'WARN',
        'tambah_biaya_ruang_verifikator',
        `trx=${noTransaksi} master tindakan tidak ditemukan`,
      );
    }
    // The Python re-picks the room meta from the refreshed rows
    // (`ranap_v3.py:14244`); the added row is invisible to a planner, so the
    // meta chosen above still stands and no re-pick is possible here.
  }

  // ── Phase 11: `_rebalance_action_rows_inap` ──────────────────────
  for (const actionKey of ['jasa', 'dpjb', 'room'] as const) {
    if (jasaIsOptional && actionKey === 'jasa') continue;
    const actionRows = filterActionRows(working.rows, actionKey, [], {
      roomMeta: actionMeta.room,
      actionMeta: actionMeta[actionKey],
      strictMeta: true,
    });
    rebalanceActionRows(actionKey, actionRows);
  }

  // ── Phase 12: the per-day add loop ───────────────────────────────
  for (const targetDate of targetDates) {
    for (const actionKey of ['jasa', 'dpjb', 'room'] as const) {
      const actionLabel = actionDisplayName(actionKey);
      const rowsOnDate = filterActionRows(working.rows, actionKey, [targetDate], {
        roomMeta: actionMeta.room,
        actionMeta: actionMeta[actionKey],
        strictMeta: true,
      });
      if (rowsOnDate.length > 0) continue;
      if (jasaIsOptional && actionKey === 'jasa') {
        lines.push(
          `- Skip tambah ${actionLabel} | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
            `tanggal=${targetDate} | alasan=pasien BYNY, jasa pelayanan tidak wajib tersedia per tanggal dari server`,
        );
        continue;
      }
      const meta = actionMeta[actionKey];
      if (!meta) {
        const candidates = actionMetaCandidates(actionKey, masterRows, working.rows, actionMeta.room);
        lines.push(
          `- Skip tambah ${actionLabel}: metadata tindakan tidak ditemukan | trx=${noTransaksi} | ` +
            `reg=${noRegistrasikunjungan} | kd_unit=${kdUnit || '-'} | ` +
            `kd_detkelpenjamin=${kdDetkelpenjamin || '-'} | candidates=${candidates.join(', ') || '-'}`,
        );
        registerIssue(
          'INFO',
          `tambah_${actionKey}`,
          `trx=${noTransaksi} tanggal=${targetDate} metadata tindakan tidak ditemukan`,
        );
        continue;
      }
      if (!kdKamarperawatan) {
        lines.push(
          `- Skip tambah ${actionLabel} | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
            `tanggal=${targetDate} | alasan=kd_kamarperawatan kosong`,
        );
        registerIssue(
          'INFO',
          `tambah_${actionKey}`,
          `trx=${noTransaksi} tanggal=${targetDate} kd_kamarperawatan kosong`,
        );
        continue;
      }
      lines.push(
        `- Tambah ${actionLabel} | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
          `tanggal=${targetDate} | kd_tindakan=${str(meta, 'kd_tindakan') || '-'} | ` +
          `harga=${str(meta, 'harga') || '-'} | kd_paramedis=${kdParamedis || '<empty>'} | ` +
          `kd_detkelpenjamin=${kdDetkelpenjamin || '-'} | kd_kamar=${kdKamarperawatan || '-'}`,
      );
      emit({
        kind: 'tambah',
        endpointId: TINDAKAN_SYNC_ENDPOINTS.tambah,
        actionKey,
        phase: 'sinkronkan_tindakan_harian_inap/tambah_tindakan_polis',
        kdTindakan: str(meta, 'kd_tindakan'),
        namaTindakan: str(meta, 'nama_tindakan'),
        harga: str(meta, 'harga'),
        kdUnit,
        kdParamedis,
        kdDetkelpenjamin,
        kdKamar: kdKamarperawatan,
        targetDate,
        targetDatetime: buildUpdateDateTime(targetDate, '', '00:00:01', now),
        reason: `${actionLabel} belum ada pada tanggal ${targetDate}`,
      });
      // `ranap_v3.py:14377` — the DRY_RUN branch: the write did not run, so no
      // new row appeared and the follow-up `update_tgl` is not planned.
      let detail =
        `- Dry run: tambah ${actionLabel} tidak membuat row baru karena write tidak dieksekusi | ` +
        `trx=${noTransaksi} | reg=${noRegistrasikunjungan} | tanggal=${targetDate}`;
      if (actionKey === 'room') {
        const existingRoomDates = uniqueSorted(
          filterActionRows(working.rows, 'room', [], { roomMeta: actionMeta.room }).map((item) =>
            rowDatePart(item),
          ),
        );
        detail =
          `${detail} | room=${roomName || '-'} | ` +
          `meta=${str(meta, 'nama_tindakan') || '-'}#${str(meta, 'kd_tindakan') || '-'} | ` +
          `existing_dates=${existingRoomDates.join(',') || '-'}`;
      }
      lines.push(detail);
    }
  }

  // ── Phase 13: `_cleanup_action_rows_inap` ────────────────────────
  for (const actionKey of ['jasa', 'dpjb', 'room'] as const) {
    const cleanupRoomMeta = actionKey === 'room' ? actionMeta.room : undefined;
    const actionRows = filterActionRows(working.rows, actionKey, [], {
      roomMeta: actionKey === 'room' ? undefined : actionMeta.room,
    });
    cleanupActionRows(actionKey, actionRows, targetDates, cleanupRoomMeta, actionMeta[actionKey]);
  }

  // ── Phase 14: `_cleanup_out_of_range_rows_inap` ──────────────────
  cleanupOutOfRangeRows('dpjb', (row) => isDpjbName(row['nama_tindakan']));
  cleanupOutOfRangeRows('biaya ruang rawat inap', (row) => isRoomChargeName(row['nama_tindakan']));

  // ── Phase 15: the rekapitulasi corruption repairs ────────────────
  repairMalformedRekap(
    getMalformedRekapJasaDates(args.rekapDetailHakHtml),
    (row) => isJasaName(row['nama_tindakan']),
    'jasa pelayanan',
    (entry) => `rekap menampilkan pelaksana ganda (${dash(entry.text)})`,
    '_repair_malformed_jasa_rekap_inap',
  );
  repairMalformedRekap(
    getMalformedRekapRoomChargeDates(args.rekapDetailHakHtml),
    (row) => isRoomChargeName(row['nama_tindakan']),
    'biaya ruang rawat inap',
    (entry) => `rekap menampilkan pelaksana pada biaya ruang (${dash(entry.text)})`,
    '_repair_malformed_room_charge_rekap_inap',
  );

  // ── Phase 16: the pelaksana sweeps ───────────────────────────────
  syncJasaPelaksana();
  syncDpjbPelaksana();
  syncOksigenPelaksana();
  syncGenericRoomPelaksana();

  return plan();

  // =========================================================================
  // Phase implementations
  // =========================================================================

  /** `_cleanup_exact_timestamp_duplicates_inap` (`ranap_v3.py:9962`). */
  function cleanupExactTimestampDuplicates(): void {
    const groups = new Map<string, { timestamp: string; rows: LegacyRow[] }>();
    for (const row of sortedRows(working.rows)) {
      const tglJam = str(row, 'tgl_jam', 'tgl_transaksi');
      if (!tglJam) continue;
      const key = [
        tglJam,
        str(row, 'kd_tindakan'),
        str(row, 'harga'),
        normalizeTextKey(row['nama_tindakan']),
      ].join(TUPLE_KEY_SEPARATOR);
      const bucket = groups.get(key);
      if (bucket) bucket.rows.push(row);
      else groups.set(key, { timestamp: tglJam, rows: [row] });
    }

    for (const bucket of groups.values()) {
      if (bucket.rows.length <= 1) continue;
      const ordered = sortedRows(bucket.rows);
      const keepRow = ordered[0] as LegacyRow;
      for (const row of ordered.slice(1)) {
        if (isBiayaDiitGiziName(row['nama_tindakan']) || isBiayaDiitGiziName(keepRow['nama_tindakan'])) {
          lines.push(
            ...syncDetailBlock(
              'Skip hapus duplikat timestamp identik',
              [
                ['Trx', noTransaksi],
                ['Reg', noRegistrasikunjungan],
                ['Timestamp', bucket.timestamp],
                ['Alasan', 'BIAYA DIIT GIZI dikecualikan'],
              ],
              undefined,
              [
                ['Keep', [rowLogLabel(keepRow)]],
                ['Drop', [rowLogLabel(row)]],
              ],
            ),
          );
          leaveAlone(row, 'BIAYA DIIT GIZI dikecualikan');
          continue;
        }
        const blocked = bolehHapusTindakan(row, deleteGate);
        if (blocked) {
          lines.push(
            ...syncDetailBlock(
              'Skip hapus duplikat timestamp identik',
              [
                ['Trx', noTransaksi],
                ['Reg', noRegistrasikunjungan],
                ['Timestamp', bucket.timestamp],
                ['Alasan', blocked],
              ],
              undefined,
              [
                ['Keep', [rowLogLabel(keepRow)]],
                ['Drop', [rowLogLabel(row)]],
              ],
            ),
          );
          leaveAlone(row, blocked);
          continue;
        }
        lines.push(
          `- Hapus duplikat timestamp identik | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
            `timestamp=${bucket.timestamp || '-'} | keep=[${rowLogLabel(keepRow)}] | drop=[${rowLogLabel(row)}]`,
        );
        emit({
          kind: 'hapus',
          endpointId: TINDAKAN_SYNC_ENDPOINTS.hapus,
          phase: '_cleanup_exact_timestamp_duplicates_inap',
          row,
          kdTindakan: str(row, 'kd_tindakan'),
          urutTindakan: str(row, 'urut_tindakan'),
          tglJam: str(row, 'tgl_jam'),
          reason: 'duplikat timestamp identik',
        });
        working.remove(row);
      }
    }
  }

  /**
   * `update_tgl_tindakan_inap` for a batch of rows, as one op per row sharing a
   * `batchKey`. The working set is advanced as if the write landed.
   */
  function planUpdateTgl(
    rows: readonly LegacyRow[],
    targetDatetime: string,
    reason: string,
    phase: string,
    kind: 'updateTgl' | 'rebalance' = 'updateTgl',
    actionKey?: TindakanActionKey,
  ): void {
    if (!targetDatetime || rows.length === 0) return;
    const batchKey = `${phase}#${targetDatetime}`;
    for (const row of rows) {
      // `update_tgl_tindakan_inap` drops rows without both identifiers.
      if (!str(row, 'kd_tindakan') || !str(row, 'urut_tindakan')) {
        leaveAlone(row, 'kd_tindakan atau urut_tindakan kosong, tidak bisa diupdate');
        continue;
      }
      emit({
        kind,
        endpointId: TINDAKAN_SYNC_ENDPOINTS.updateTgl,
        phase,
        row,
        actionKey,
        kdTindakan: str(row, 'kd_tindakan'),
        urutTindakan: str(row, 'urut_tindakan'),
        tglJam: str(row, 'tgl_jam'),
        kdKamar: kdKamarperawatan,
        targetDatetime,
        targetDate: datePart(targetDatetime),
        batchKey,
        reason,
      });
      working.redate(row, targetDatetime);
    }
  }

  /** `_sinkronkan_tanggal_igd` (`ranap_v3.py:12086`). */
  function syncTanggalIgd(): void {
    const targetDate = datePart(tglSep);
    const igdRows = working.rows.filter((row) => isIgdOriginChargeName(row['nama_tindakan']));
    if (!targetDate || igdRows.length === 0) return;
    const referensi = sortedRows(igdRows)[0] as LegacyRow;
    const targetDatetime = buildUpdateDateTime(
      targetDate,
      str(referensi, 'tgl_jam', 'tgl_transaksi'),
      '00:00:01',
      now,
    );
    if (igdRows.every((row) => rowDatePart(row) === targetDate)) return;
    const reason =
      'samakan tanggal BIAYA UGD/BIAYA IGD KEBIDANAN ke tanggal SEP/tanggal masuk rawat inap';
    lines.push(
      ...syncDetailBlock(
        'Update tanggal biaya origin IGD',
        [
          ['Trx', noTransaksi],
          ['Target', targetDatetime],
          ['Alasan', reason],
          ['Count', igdRows.length],
        ],
        igdRows,
      ),
    );
    planUpdateTgl(igdRows, targetDatetime, reason, '_sinkronkan_tanggal_igd');
  }

  /** `_sinkronkan_tanggal_poliklinik` (`ranap_v3.py:12122`). */
  function syncTanggalPoliklinik(): void {
    const poliRows = working.rows.filter((row) =>
      str(row, 'nama_tindakan').toUpperCase().includes('BIAYA POLIKLINIK'),
    );
    if (poliRows.length === 0) return;

    const targetDatetimes: string[] = [];
    const targetDate = datePart(tglSep);
    const sourceRows = rowsOf(args.poliSource?.['tindakan_rows']);
    for (const item of sourceRows) {
      const dtSource = str(item, 'tgl_transaksi', 'tgl_jam');
      if (targetDate && parseDateTimeFlexible(dtSource)) {
        targetDatetimes.push(buildUpdateDateTime(targetDate, dtSource, '00:00:01', now));
      }
    }
    if (targetDatetimes.length === 0 && targetDate) {
      targetDatetimes.push(buildUpdateDateTime(targetDate, '', '00:00:01', now));
    }
    if (targetDatetimes.length === 0) return;
    targetDatetimes.sort();

    const updates = new Map<string, LegacyRow[]>();
    sortedRows(poliRows).forEach((row, index) => {
      const targetDatetime = targetDatetimes[
        Math.min(index, targetDatetimes.length - 1)
      ] as string;
      if (rowDatePart(row) === datePart(targetDatetime)) return;
      const bucket = updates.get(targetDatetime);
      if (bucket) bucket.push(row);
      else updates.set(targetDatetime, [row]);
    });

    const reason = 'samakan tanggal BIAYA POLIKLINIK ke tanggal SEP/tanggal masuk rawat inap';
    for (const [targetDatetime, rows] of updates) {
      lines.push(
        ...syncDetailBlock(
          'Update tanggal BIAYA POLIKLINIK',
          [
            ['Trx', noTransaksi],
            ['Target', targetDatetime],
            ['Alasan', reason],
            ['Count', rows.length],
          ],
          rows,
        ),
      );
      planUpdateTgl(rows, targetDatetime, reason, '_sinkronkan_tanggal_poliklinik');
    }
  }

  /** `_sinkronkan_tanggal_elektromedik` (`ranap_v3.py:12171`). */
  function syncTanggalElektromedik(): void {
    const penunjangRows = working.rows.filter((row) =>
      str(row, 'nama_tindakan').toUpperCase().includes('ELEKTROMEDIK'),
    );
    const dates = expandTargetDates(args.elektromedikHistory ?? []);
    if (penunjangRows.length === 0 || dates.length === 0) return;
    const reason = 'samakan tanggal penunjang elektromedik ke tanggal history elektromedik';
    planPositionalRedate(
      penunjangRows,
      dates,
      reason,
      'Update tanggal penunjang elektromedik',
      '_sinkronkan_tanggal_elektromedik',
    );
  }

  /** `_sinkronkan_tanggal_penunjang_generic` (`ranap_v3.py:8537`). */
  function syncTanggalPenunjangGeneric(
    targetRows: readonly LegacyRow[],
    namePredicate: (upperName: string) => boolean,
    label: string,
    detailCountGetter?: DetailCountProvider,
  ): void {
    const penunjangRows = working.rows.filter((row) =>
      namePredicate(str(row, 'nama_tindakan').toUpperCase()),
    );
    const dates = expandTargetDates(targetRows, detailCountGetter);
    if (penunjangRows.length === 0 || dates.length === 0) return;
    planPositionalRedate(
      penunjangRows,
      dates,
      `samakan tanggal ${label} ke history penunjang terkait`,
      `Update tanggal ${label}`,
      '_sinkronkan_tanggal_penunjang_generic',
    );
  }

  /** `_sinkronkan_tanggal_depo_ibs` (`ranap_v3.py:12225`). */
  function syncTanggalDepoIbs(): void {
    const depoRows = working.rows.filter((row) => isDepoIbsName(row['nama_tindakan']));
    const biayaRows = working.rows.filter((row) => isBiayaIbsName(row['nama_tindakan']));
    if (depoRows.length === 0 || biayaRows.length === 0) return;
    const dates = sortedRows(biayaRows)
      .map((row) => rowDatePart(row))
      .filter((date) => date);
    if (dates.length === 0) return;
    planPositionalRedate(
      depoRows,
      dates,
      'samakan tanggal DEPO IBS ke tanggal BIAYA IBS/BEDAH SENTRAL/CATHLAB',
      'Update tanggal DEPO IBS',
      '_sinkronkan_tanggal_depo_ibs',
    );
  }

  /**
   * `_sinkronkan_tanggal_biaya_obat_inap` (`ranap_v3.py:12789`).
   *
   * The legacy body is disabled — `return False` sits above every line of it,
   * with the comment "Logic cek tanggal order & update tanggal obat
   * dinonaktifkan sementara karena masih kacau". So this plans nothing and only
   * records the BIAYA OBAT rows as untouched, which is the faithful behaviour.
   */
  function syncTanggalBiayaObat(): void {
    for (const row of working.rows) {
      if (str(row, 'nama_tindakan').toUpperCase() !== 'BIAYA OBAT') continue;
      leaveAlone(
        row,
        'sinkronisasi tanggal BIAYA OBAT dinonaktifkan sementara di ranap_v3.py karena masih kacau',
      );
    }
  }

  /**
   * The shared body of the elektromedik / penunjang / depo rules: the i-th
   * charge takes the i-th history date, and the last date repeats once the
   * charges outnumber it.
   */
  function planPositionalRedate(
    rows: readonly LegacyRow[],
    dates: readonly string[],
    reason: string,
    title: string,
    phase: string,
  ): void {
    const updates = new Map<string, LegacyRow[]>();
    sortedRows(rows).forEach((row, index) => {
      const targetDate = dates[Math.min(index, dates.length - 1)] as string;
      if (rowDatePart(row) === targetDate) return;
      const targetDatetime = buildUpdateDateTime(targetDate, '', '00:00:01', now);
      const bucket = updates.get(targetDatetime);
      if (bucket) bucket.push(row);
      else updates.set(targetDatetime, [row]);
    });
    for (const [targetDatetime, bucketRows] of updates) {
      lines.push(
        ...syncDetailBlock(
          title,
          [
            ['Trx', noTransaksi],
            ['Target', targetDatetime],
            ['Alasan', reason],
            ['Count', bucketRows.length],
          ],
          bucketRows,
        ),
      );
      planUpdateTgl(bucketRows, targetDatetime, reason, phase);
    }
  }

  /**
   * `_rebalance_action_rows_inap` (`ranap_v3.py:9911`).
   *
   * Every day that already has one row keeps its earliest; the surplus, plus
   * everything dated outside the range, becomes a movable pool. The pool is
   * then drained, in order, onto the target days that have nothing — so a
   * mis-dated charge is re-used rather than deleted and re-added.
   */
  function rebalanceActionRows(actionKey: TindakanActionKey, rows: readonly LegacyRow[]): void {
    const dates = targetDates.filter((date) => date);
    if (dates.length === 0) return;

    const actionLabel = actionDisplayName(actionKey);
    const grouped = groupRowsByDate(rows);
    const keepDates = new Set<string>();
    const movableRows: Array<{ sourceDate: string; row: LegacyRow }> = [];

    for (const [rowDate, dateRows] of Object.entries(grouped)) {
      const ordered = sortedRows(dateRows);
      if (targetDateSet.has(rowDate)) {
        keepDates.add(rowDate);
        for (const row of ordered.slice(1)) movableRows.push({ sourceDate: rowDate, row });
      } else {
        for (const row of ordered) movableRows.push({ sourceDate: rowDate, row });
      }
    }

    const missingDates = dates.filter((date) => !keepDates.has(date));
    while (missingDates.length > 0 && movableRows.length > 0) {
      const targetDate = missingDates.shift() as string;
      const { sourceDate, row } = movableRows.shift() as { sourceDate: string; row: LegacyRow };
      const targetDatetime = buildUpdateDateTime(
        targetDate,
        str(row, 'tgl_jam', 'tgl_transaksi'),
        '00:00:01',
        now,
      );
      const reason = targetDateSet.has(sourceDate)
        ? `duplikat tanggal ${sourceDate}`
        : `di luar range ${dates[0] as string} s/d ${dates[dates.length - 1] as string}`;
      lines.push(
        `- Geser ${actionLabel} ke tanggal kosong | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
          `from=${sourceDate || '-'} | to=${targetDatetime} | alasan=${reason} | row=[${rowLogLabel(row)}]`,
      );
      planUpdateTgl(
        [row],
        targetDatetime,
        reason,
        '_rebalance_action_rows_inap',
        'rebalance',
        actionKey,
      );
    }
  }

  /**
   * `_cleanup_action_rows_inap` (`ranap_v3.py:10034`).
   *
   * Per day: pick the row to keep (for `room` and `jasa`, the first one that
   * matches the selected meta — a wrong-ward room charge or a wrong-category
   * jasa is *not* kept, even if it is the only row there), then delete every
   * other row. Out-of-range days keep nothing.
   */
  function cleanupActionRows(
    actionKey: TindakanActionKey,
    rows: readonly LegacyRow[],
    dates: readonly string[],
    roomMetaArg: LegacyRow | undefined,
    actionMetaArg: LegacyRow | undefined,
  ): void {
    const dateSet = new Set(dates);
    const grouped = groupRowsByDate(rows);
    const actionLabel = actionDisplayName(actionKey);

    for (const [rowDate, dateRows] of Object.entries(grouped)) {
      const ordered = sortedRows(dateRows);
      let keepRow: LegacyRow | undefined;
      if (dateSet.has(rowDate) && ordered.length > 0) {
        if (actionKey === 'room' && nonEmptyRow(roomMetaArg)) {
          keepRow = ordered.find((row) => matchActionKey(row, roomMetaArg) === 'room');
        } else if (actionKey === 'jasa' && nonEmptyRow(actionMetaArg)) {
          keepRow = ordered.find((row) =>
            rowMatchesSelectedActionMeta(row, actionKey, actionMetaArg, roomMetaArg),
          );
        }
        if (keepRow === undefined && (actionKey !== 'jasa' || !nonEmptyRow(actionMetaArg))) {
          keepRow = ordered[0];
        }
      }

      const deleteRows =
        keepRow === undefined
          ? [...ordered]
          : ordered.filter(
              (row) =>
                !(
                  str(row, 'urut_tindakan') === str(keepRow as LegacyRow, 'urut_tindakan') &&
                  str(row, 'kd_tindakan') === str(keepRow as LegacyRow, 'kd_tindakan') &&
                  str(row, 'tgl_jam') === str(keepRow as LegacyRow, 'tgl_jam')
                ),
            );

      for (const row of deleteRows) {
        let reason: string;
        let keepLabel: string;
        if (dateSet.has(rowDate)) {
          if (actionKey === 'room' && nonEmptyRow(roomMetaArg) && matchActionKey(row, roomMetaArg) !== 'room') {
            reason =
              `bukan biaya ruang rawat inap aktif untuk tanggal ${rowDate} ` +
              `(expected=${dash(str(roomMetaArg as LegacyRow, 'nama_tindakan'))})`;
          } else if (
            actionKey === 'jasa' &&
            nonEmptyRow(actionMetaArg) &&
            !rowMatchesSelectedActionMeta(row, actionKey, actionMetaArg, roomMetaArg)
          ) {
            reason =
              `bukan jasa pelayanan aktif untuk tanggal ${rowDate} ` +
              `(expected=${dash(str(actionMetaArg as LegacyRow, 'nama_tindakan'))})`;
          } else {
            reason = `duplikat pada tanggal ${rowDate}`;
          }
          keepLabel = keepRow !== undefined ? rowLogLabel(keepRow) : '<none>';
        } else {
          reason =
            dates.length > 0
              ? `di luar range ${dates[0] as string} s/d ${dates[dates.length - 1] as string}`
              : 'tidak menjadi ruangan dominan untuk tanggal tersebut';
          keepLabel = '<none>';
        }

        const blocked = bolehHapusTindakan(row, deleteGate);
        if (blocked) {
          lines.push(
            ...syncDetailBlock(
              `Skip hapus ${actionLabel}`,
              [
                ['Trx', noTransaksi],
                ['Reg', noRegistrasikunjungan],
                ['Tanggal', rowDate],
                ['Alasan', `${reason}; ${blocked}`],
              ],
              undefined,
              [
                ['Keep', [keepLabel]],
                ['Drop', [rowLogLabel(row)]],
              ],
            ),
          );
          leaveAlone(row, `${reason}; ${blocked}`);
          continue;
        }

        lines.push(
          `- Hapus duplikat ${actionLabel} | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
            `tanggal=${rowDate || '-'} | keep=[${keepLabel}] | drop=[${rowLogLabel(row)}] | alasan=${reason}`,
        );
        emit({
          kind: 'hapus',
          endpointId: TINDAKAN_SYNC_ENDPOINTS.hapus,
          phase: '_cleanup_action_rows_inap',
          actionKey,
          row,
          kdTindakan: str(row, 'kd_tindakan'),
          urutTindakan: str(row, 'urut_tindakan'),
          tglJam: str(row, 'tgl_jam'),
          reason,
        });
        working.remove(row);
      }
    }
  }

  /** `_cleanup_out_of_range_rows_inap` (`ranap_v3.py:10142`). */
  function cleanupOutOfRangeRows(label: string, matcher: (row: LegacyRow) => boolean): void {
    const dateSet = new Set(targetDates.map((item) => String(item).trim()).filter((item) => item));
    if (dateSet.size === 0) return;
    const sorted = [...dateSet].sort();
    const minDate = sorted[0] as string;
    const maxDate = sorted[sorted.length - 1] as string;

    const matchedRows: LegacyRow[] = [];
    for (const row of sortedRows(working.rows)) {
      const rowDate = rowDatePart(row);
      if (!rowDate || dateSet.has(rowDate)) continue;
      if (!matcher(row)) continue;
      matchedRows.push(row);
    }

    for (const row of matchedRows) {
      const rowDate = rowDatePart(row);
      const reason = `di luar range ${minDate} s/d ${maxDate}`;
      const blocked = bolehHapusTindakan(row, deleteGate);
      if (blocked) {
        lines.push(
          `- Skip hapus ${label} di luar range | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
            `tanggal=${rowDate || '-'} | row=[${rowLogLabel(row)}] | alasan=${reason}; ${blocked}`,
        );
        leaveAlone(row, `${reason}; ${blocked}`);
        continue;
      }
      lines.push(
        `- Hapus ${label} di luar range | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
          `tanggal=${rowDate || '-'} | row=[${rowLogLabel(row)}] | alasan=${reason}`,
      );
      emit({
        kind: 'hapus',
        endpointId: TINDAKAN_SYNC_ENDPOINTS.hapus,
        phase: '_cleanup_out_of_range_rows_inap',
        row,
        kdTindakan: str(row, 'kd_tindakan'),
        urutTindakan: str(row, 'urut_tindakan'),
        tglJam: str(row, 'tgl_jam'),
        reason,
      });
      working.remove(row);
    }
  }

  /**
   * `_repair_malformed_jasa_rekap_inap` (`ranap_v3.py:9571`) and
   * `_repair_malformed_room_charge_rekap_inap` (`ranap_v3.py:9619`) — the
   * rekapitulasi shows the line corrupted, so delete it and let the add loop of
   * a later run re-create it.
   */
  function repairMalformedRekap(
    entries: readonly MalformedRekapEntry[],
    matcher: (row: LegacyRow) => boolean,
    label: string,
    reasonOf: (entry: MalformedRekapEntry) => string,
    phase: string,
  ): void {
    if (entries.length === 0) return;
    for (const entry of entries) {
      const rowDate = String(entry.date ?? '').trim();
      if (targetDateSet.size > 0 && rowDate && !targetDateSet.has(rowDate)) continue;
      const affectedRows = working.rows.filter((row) => matcher(row) && rowDatePart(row) === rowDate);
      if (affectedRows.length === 0) continue;
      for (const row of sortedRows(affectedRows)) {
        const blocked = bolehHapusTindakan(row, deleteGate);
        if (blocked) {
          lines.push(
            ...syncDetailBlock(
              `Skip repair ${label} rekap bug`,
              [
                ['Trx', noTransaksi],
                ['Reg', noRegistrasikunjungan],
                ['Tanggal', rowDate],
                ['Alasan', 'baris korup di rekap tetapi tidak bisa dihapus'],
              ],
              [row],
            ),
          );
          leaveAlone(row, `baris korup di rekap tetapi tidak bisa dihapus; ${blocked}`);
          continue;
        }
        const reason = reasonOf(entry);
        lines.push(
          `- Repair ${label} rekap bug | trx=${noTransaksi} | reg=${noRegistrasikunjungan} | ` +
            `tanggal=${rowDate || '-'} | alasan=${reason} | aksi=hapus untuk tambah ulang | ` +
            `row=[${rowLogLabel(row)}]`,
        );
        emit({
          kind: 'hapus',
          endpointId: TINDAKAN_SYNC_ENDPOINTS.hapus,
          phase,
          row,
          kdTindakan: str(row, 'kd_tindakan'),
          urutTindakan: str(row, 'urut_tindakan'),
          tglJam: str(row, 'tgl_jam', 'tgl_transaksi'),
          reason: `${reason} | aksi=hapus untuk tambah ulang`,
        });
        working.remove(row);
      }
    }
  }

  /** The jasa-pelayanan pelaksana sweep (`ranap_v3.py:14503`). */
  function syncJasaPelaksana(): void {
    const jasaRows = filterActionRows(working.rows, 'jasa', targetDates, {
      roomMeta: actionMeta.room,
      actionMeta: actionMeta.jasa,
      strictMeta: true,
    });
    if (jasaRows.length > 0 && !roomPelaksana) {
      lines.push(
        roomSyncItem('Jasa Pelayanan', [
          ['hasil', 'skip'],
          ['alasan', 'pelaksana jasa tidak ditemukan dari endpoint'],
        ]),
      );
      for (const row of jasaRows) leaveAlone(row, 'pelaksana jasa tidak ditemukan dari endpoint');
      return;
    }
    if (!roomPelaksana) return;

    for (const row of jasaRows) {
      const komponenItem = resolveJasaPelaksanaComponent(row, komponenRows);
      const kdKomponenJasa = str(komponenItem, 'kd_komponen') || '98';
      const hargaPersenJasa = str(komponenItem, 'harga_persen') || '100';
      const diskonJasa = str(komponenItem, 'diskon');
      const nilaiJasa = str(komponenItem, 'nilai');
      const { alreadyCorrect, currentName } = isPelaksanaAlreadyCorrect(
        row,
        komponenRows,
        roomPelaksana,
        kdKomponenJasa,
      );
      if (alreadyCorrect) {
        lines.push(
          roomSyncItem('Jasa Pelayanan', [
            ['tanggal', datePart(str(row, 'tgl_jam'))],
            ['pelaksana', currentName || roomPelaksana],
            ['hasil', 'sudah sesuai'],
            ...debugDetails(row, kdKomponenJasa),
          ]),
        );
        leaveAlone(row, 'pelaksana jasa pelayanan sudah sesuai');
        continue;
      }
      lines.push(
        roomSyncItem('Jasa Pelayanan', [
          ['tanggal', datePart(str(row, 'tgl_jam'))],
          ['pelaksana', roomPelaksana],
          ...debugDetails(row, kdKomponenJasa),
        ]),
      );
      emit({
        kind: 'setPelaksana',
        endpointId: TINDAKAN_SYNC_ENDPOINTS.tampungPelaksana,
        phase: '_tampung_pelaksana_checked/jasa',
        actionKey: 'jasa',
        row,
        kdTindakan: str(row, 'kd_tindakan'),
        urutTindakan: str(row, 'urut_tindakan'),
        tglJam: str(row, 'tgl_jam'),
        pelaksana: roomPelaksana,
        kdKomponen: kdKomponenJasa,
        harga: pelaksanaHarga(row),
        hargaPersen: hargaPersenJasa,
        diskon: diskonJasa,
        nilai: nilaiJasa,
        reason: `pelaksana jasa pelayanan harus ${roomPelaksana}${
          currentName ? ` (sekarang ${currentName})` : ''
        }`,
      });
    }
  }

  /** The DPJB sweep (`ranap_v3.py:14572`) — the pelaksana must be blank. */
  function syncDpjbPelaksana(): void {
    const dpjbRows = filterActionRows(working.rows, 'dpjb', targetDates, {
      roomMeta: actionMeta.room,
    });
    for (const row of dpjbRows) {
      const { alreadyCorrect, currentName } = isPelaksanaAlreadyCorrect(row, komponenRows, '', '29');
      if (alreadyCorrect) {
        lines.push(
          roomSyncItem('DPJB', [
            ['tanggal', datePart(str(row, 'tgl_jam'))],
            ['pelaksana', currentName || '<empty>'],
            ['hasil', 'sudah sesuai'],
            ...debugDetails(row, '29'),
          ]),
        );
        leaveAlone(row, 'pelaksana dpjb sudah kosong');
        continue;
      }
      lines.push(
        roomSyncItem('DPJB', [
          ['tanggal', datePart(str(row, 'tgl_jam'))],
          ['pelaksana', '<empty>'],
          ...debugDetails(row, '29'),
        ]),
      );
      emit({
        kind: 'setPelaksana',
        endpointId: TINDAKAN_SYNC_ENDPOINTS.tampungPelaksana,
        phase: '_tampung_pelaksana_checked/dpjb',
        actionKey: 'dpjb',
        row,
        kdTindakan: str(row, 'kd_tindakan'),
        urutTindakan: str(row, 'urut_tindakan'),
        tglJam: str(row, 'tgl_jam'),
        pelaksana: '',
        kdKomponen: '29',
        harga: pelaksanaHarga(row),
        reason: `pelaksana dpjb harus kosong${currentName ? ` (sekarang ${currentName})` : ''}`,
      });
    }
  }

  /** The oxygen-BHP sweep (`ranap_v3.py:14612`) — also blank. */
  function syncOksigenPelaksana(): void {
    const oksigenRows: LegacyRow[] = [];
    for (const row of working.rows) {
      const rowDate = rowDatePart(row);
      if (targetDateSet.size > 0 && !targetDateSet.has(rowDate)) continue;
      if (!isOksigenBhpName(row['nama_tindakan'])) continue;
      if (!resolveOksigenPelaksanaComponent(row, komponenRows)) continue;
      oksigenRows.push(row);
    }

    for (const row of oksigenRows) {
      const kdKomponenOksigen = resolveOksigenPelaksanaComponent(row, komponenRows) || '38';
      const komponenItem = getKomponenDetailItem(row, komponenRows, kdKomponenOksigen);
      const hargaKomponen = str(komponenItem, 'harga') || str(row, 'harga');
      const hargaPersenKomponen = str(komponenItem, 'harga_persen');
      const diskonKomponen = str(komponenItem, 'diskon');
      const nilaiKomponen = str(komponenItem, 'nilai');
      const { alreadyCorrect, currentName } = isPelaksanaAlreadyCorrect(
        row,
        komponenRows,
        '',
        kdKomponenOksigen,
      );
      if (alreadyCorrect) {
        lines.push(
          roomSyncItem('BHP OKSIGEN', [
            ['tanggal', datePart(str(row, 'tgl_jam'))],
            ['pelaksana', currentName || '<empty>'],
            ['hasil', 'sudah sesuai'],
            ...debugDetails(row, kdKomponenOksigen),
          ]),
        );
        leaveAlone(row, 'pelaksana bhp oksigen sudah kosong');
        continue;
      }
      lines.push(
        roomSyncItem('BHP OKSIGEN', [
          ['tanggal', datePart(str(row, 'tgl_jam'))],
          ['pelaksana', '<empty>'],
          ...debugDetails(row, kdKomponenOksigen),
        ]),
      );
      emit({
        kind: 'setPelaksana',
        endpointId: TINDAKAN_SYNC_ENDPOINTS.tampungPelaksana,
        phase: '_tampung_pelaksana_checked/oksigen',
        row,
        kdTindakan: str(row, 'kd_tindakan'),
        urutTindakan: str(row, 'urut_tindakan'),
        tglJam: str(row, 'tgl_jam'),
        pelaksana: '',
        kdKomponen: kdKomponenOksigen,
        harga: hargaKomponen,
        hargaPersen: hargaPersenKomponen,
        diskon: diskonKomponen,
        nilai: nilaiKomponen,
        reason: `pelaksana bhp oksigen harus kosong${currentName ? ` (sekarang ${currentName})` : ''}`,
      });
    }
  }

  /** The ward / partus sweep (`ranap_v3.py:14683`). */
  function syncGenericRoomPelaksana(): void {
    if (!roomPelaksana && !dokterPasien) return;
    const genericRoomRows: Array<{ row: LegacyRow; isPartusAction: boolean }> = [];
    for (const row of working.rows) {
      const rowDate = rowDatePart(row);
      if (targetDateSet.size > 0 && !targetDateSet.has(rowDate)) continue;
      if (getKomponenDetailRows(row, komponenRows, '98').length === 0) continue;
      const isPartusAction = isPartusDoctorActionName(row['nama_tindakan']);
      if (!isPartusAction) {
        if (!roomPelaksana) continue;
        if (
          !isGenericRoomPelaksanaCandidate(row, {
            roomPelaksana,
            komponenRows,
            roomPelaksanaOptionNames: args.roomPelaksanaOptionNames,
          })
        ) {
          continue;
        }
      }
      genericRoomRows.push({ row, isPartusAction });
    }

    for (const { row, isPartusAction } of genericRoomRows) {
      const syncLabel = isPartusAction ? 'Tindakan partus' : 'Tindakan ruangan';
      const desiredPelaksana = isPartusAction ? dokterPasien : roomPelaksana;
      if (isPartusAction && !desiredPelaksana) {
        lines.push(
          roomSyncItem(syncLabel, [
            ['tindakan', str(row, 'nama_tindakan')],
            ['tanggal', datePart(str(row, 'tgl_jam'))],
            ['hasil', 'skip'],
            ['alasan', 'dokter penanggungjawab pasien tidak ditemukan'],
            ...debugDetails(row, '98'),
          ]),
        );
        leaveAlone(row, 'dokter penanggungjawab pasien tidak ditemukan');
        continue;
      }
      const { alreadyCorrect, currentName } = isPelaksanaAlreadyCorrect(
        row,
        komponenRows,
        desiredPelaksana,
        '98',
      );
      if (alreadyCorrect) {
        lines.push(
          roomSyncItem(syncLabel, [
            ['tindakan', str(row, 'nama_tindakan')],
            ['tanggal', datePart(str(row, 'tgl_jam'))],
            ['pelaksana', currentName || desiredPelaksana],
            ['hasil', 'sudah sesuai'],
            ...debugDetails(row, '98'),
          ]),
        );
        leaveAlone(row, `pelaksana ${syncLabel.toLowerCase()} sudah sesuai`);
        continue;
      }
      lines.push(
        roomSyncItem(syncLabel, [
          ['tindakan', str(row, 'nama_tindakan')],
          ['tanggal', datePart(str(row, 'tgl_jam'))],
          ['pelaksana', desiredPelaksana],
          ...debugDetails(row, '98'),
        ]),
      );
      emit({
        kind: 'setPelaksana',
        endpointId: TINDAKAN_SYNC_ENDPOINTS.tampungPelaksana,
        phase: isPartusAction
          ? '_tampung_pelaksana_checked/partus'
          : '_tampung_pelaksana_checked/tindakan_ruangan',
        row,
        kdTindakan: str(row, 'kd_tindakan'),
        urutTindakan: str(row, 'urut_tindakan'),
        tglJam: str(row, 'tgl_jam'),
        pelaksana: desiredPelaksana,
        kdKomponen: '98',
        harga: pelaksanaHarga(row),
        reason: `pelaksana ${syncLabel.toLowerCase()} harus ${desiredPelaksana}${
          currentName ? ` (sekarang ${currentName})` : ''
        }`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Local list helpers
// ---------------------------------------------------------------------------

/** `sorted({...})` over trimmed, non-empty strings. */
function uniqueSorted(items: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const text = String(item ?? '').trim();
    if (text) seen.add(text);
  }
  return [...seen].sort();
}

/** `max(...)` over ISO date strings. */
function maxOf(items: readonly string[]): string {
  let best = '';
  for (const item of items) if (item > best) best = item;
  return best;
}
