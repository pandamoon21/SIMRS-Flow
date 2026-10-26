/**
 * SEP (BPJS *Surat Eligibilitas Peserta*) matching — ported from `ranap_v3.py`.
 *
 * A SEP is the BPJS service-eligibility letter. No SEP, no verifiable bill:
 * `main()` refuses to continue when `sepValid` is false (unless the operator
 * explicitly set `skip_verifikasi_sep`, or the patient is a healthy newborn
 * riding the mother's SEP). Every decision here therefore mirrors the Python
 * byte-for-byte — the tolerance-day window, the preference for an exact date
 * match, the PPK-pelayanan filter, and the `matchType` labels.
 *
 * The Python originals fetch inside the decision functions. Every fetch is
 * hoisted into an explicit parameter so these functions stay pure:
 *
 *  - `pendaftaran/pendaftaran_pasien/get_datariwayatsep` → `sepRows`
 *  - `pendaftaran/pendaftaran_pasien/getdatakunjungan` +
 *    `pendaftaran/pendaftaran_pasien/getdatapenjamin_tab` (the BPJS card
 *    number `find_sep` resolves before searching) → `noKartuBpjs`
 *  - `pendaftaran/pendaftaran_pasien/getdata_sep_bpjs` → `sepDetails`
 *    (a `no_sep` → detail lookup) or `sepDetail` (a single row)
 *  - `pendaftaran/pendaftaran_pasien/getdatapenjamin_tab` → `penjaminTab`
 *
 * Nothing in this module reads the clock or the network.
 */

import type { LegacyRow } from './types.js';
import { str } from './types.js';
import { clampToleranceDays, datePart, parseDateFlexible } from './dates.js';
import { normalizeTextKey } from './scalars.js';

/**
 * `_TARGET_SEP_PPK_PELAYANAN` — the only *PPK pelayanan* (servicing facility)
 * whose SEPs may back a PKU Gombong inpatient bill. A SEP issued for another
 * hospital is rejected even when the card number and date line up.
 */
export const TARGET_SEP_PPK_PELAYANAN = 'PKU MUHAMMADIYAH GOMBONG';

/**
 * The outcome of a SEP search — mirrors the dict `find_sep` returns and the
 * dicts `main()` synthesizes for the newborn / skip-verification shortcuts.
 *
 * Python key → field:
 *  - `sepValid` → {@link SepResult.sepValid}
 *  - `sepOK` → {@link SepResult.sepOK}
 *  - `noKartuBPJS` → {@link SepResult.noKartuBPJS}
 *  - `sepItem` → {@link SepResult.sepItem}
 *  - `targetTanggal` / `matchedTanggal` → same names
 *  - `configuredToleranceDays` / `appliedToleranceDays` → same names
 *  - `matchType` → {@link SepResult.matchType}
 *  - `reason` / `results` → failure diagnostics
 *  - `sepOptional` / `sepOptionalReason` / `bynyBaseDate` → newborn path
 */
export interface SepResult {
  /** `sepValid` — may this bill be verified at all? Everything else is advisory. */
  sepValid: boolean;
  /** `sepOK` — the accepted `no_sep`. Empty string on the optional/skip paths. */
  sepOK?: string;
  /** `noKartuBPJS` — the 13-digit BPJS card number the search ran against. */
  noKartuBPJS?: string;
  /** `sepItem` — the winning SEP row, merged with its `getdata_sep_bpjs` detail. */
  sepItem?: LegacyRow;
  /** `targetTanggal` — the date we asked for (the inpatient admission date). */
  targetTanggal?: string;
  /** `matchedTanggal` — the `tgl_sep` actually accepted; differs on a tolerance hit. */
  matchedTanggal?: string;
  /** `configuredToleranceDays` — the clamped (0..7) tolerance the caller requested. */
  configuredToleranceDays?: number;
  /** `appliedToleranceDays` — days actually consumed; `0` on an exact match. */
  appliedToleranceDays?: number;
  /**
   * `matchType` — how the SEP was found. Values the Python can produce:
   * `"exact"` and `"tolerance"` (from `find_sep`); `"known_sep"`,
   * `"byny_known_sep"`, `"byny_kasir_sep"` (from
   * `_build_sep_result_from_known_sep`); `"byny_optional"` and
   * `"skip_sep_verification"` (synthesized by `main()`).
   */
  matchType?: string;
  /** `reason` — Indonesian operator-facing explanation, set only on failure. */
  reason?: string;
  /** `results` — the rows inspected, surfaced so the operator can eyeball them. */
  results?: readonly LegacyRow[];
  /** `sepOptional` — true when validity was granted without a real SEP. */
  sepOptional?: boolean;
  /** `sepOptionalReason` — `"byny_sehat_mengikuti_sep_orangtua"` or `"skip_verifikasi_sep"`. */
  sepOptionalReason?: string;
  /** `bynyBaseDate` — the newborn's birth/admission date used in place of `tgl_sep`. */
  bynyBaseDate?: string;
}

/** A `no_sep` → `getdata_sep_bpjs` detail lookup, replacing the Python's fetch. */
export type SepDetailLookup = Readonly<Record<string, LegacyRow>>;

export { noKkRejectionReason } from '@simrs-flow/evomedis-client';

/** `str(x or "").strip()` on a bare value (the row-aware form lives in `types.ts`). */
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return (typeof value === 'string' ? value : String(value)).trim();
}

/**
 * Signed calendar-day difference, matching Python's `(a - b).days` for the
 * date-only `datetime`s `_parse_date_flexible` produces. Normalizing through
 * `Date.UTC` keeps the arithmetic DST-proof, which a raw millisecond subtract
 * is not.
 */
function calendarDiffDays(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ua - ub) / 86_400_000);
}

/**
 * `_normalize_jenis_sep_key` — collapse the many spellings of the BPJS service
 * class down to `"RITL"` (inpatient), `"RJTL"` (outpatient), or `""`.
 *
 * The exact-token set is kept as the Python wrote it even though
 * `normalizeTextKey` inserts spaces, so `"RAWATINAP"` can only ever match an
 * already-unspaced input; the substring checks below carry the spaced forms.
 */
export function normalizeJenisSepKey(value: unknown): string {
  const key = normalizeTextKey(value);
  if (!key) return '';
  if (key === 'RITL' || key === 'RAWATINAP' || key === 'RAWATINAPTINGKATLANJUTAN') return 'RITL';
  if (key === 'RJTL' || key === 'RAWATJALAN' || key === 'RAWATJALANTINGKATLANJUTAN') return 'RJTL';
  if (key.includes('RAWAT INAP')) return 'RITL';
  if (key.includes('RAWAT JALAN')) return 'RJTL';
  return '';
}

/**
 * `_sep_ppk_matches_target` — does this SEP name our hospital as the servicing
 * facility? Matching is deliberately loose in both directions (either key may
 * contain the other) because the history list and the SEP detail spell the
 * facility differently, sometimes with a `"RS "` prefix or a branch suffix.
 */
export function sepPpkMatchesTarget(
  item: LegacyRow,
  targetPpk: string = TARGET_SEP_PPK_PELAYANAN,
): boolean {
  const ppkValue = str(item, 'ppkPelayanan', 'ppk_pelayanan', 'ppk_pelayanan_sep', 'ppk');
  const ppkKey = normalizeTextKey(ppkValue);
  const targetKey = normalizeTextKey(targetPpk);
  if (!ppkKey || !targetKey) return false;
  return ppkKey === targetKey || ppkKey.includes(targetKey) || targetKey.includes(ppkKey);
}

/**
 * `_merge_sep_history_item` — overlay the full SEP detail onto a history row.
 * The history list omits `ppkPelayanan` for some payers, which is why the
 * search has to merge before it can apply the PPK filter.
 *
 * @param item the history row.
 * @param sepDetails caller supplies the result of
 *   `pendaftaran.getdata_sep_bpjs`, keyed by `no_sep`. Absent key → the row is
 *   returned unchanged, exactly as the Python does on an empty response.
 */
export function mergeSepHistoryItem(item: LegacyRow, sepDetails?: SepDetailLookup): LegacyRow {
  const baseItem: Record<string, unknown> = { ...item };
  const noSep = text(baseItem['no_sep']);
  if (!noSep) return baseItem;
  const sepDetail = sepDetails?.[noSep];
  if (sepDetail && Object.keys(sepDetail).length > 0) {
    return { ...baseItem, ...sepDetail };
  }
  return baseItem;
}

/** Arguments for {@link matchSepFromHistory}. */
export interface MatchSepFromHistoryArgs {
  /**
   * caller supplies the result of `pendaftaran.get_datariwayatsep` for the
   * patient's BPJS card. `find_sep` bails out with `sepValid: false` when the
   * endpoint returns a non-list; pass `[]` for that case.
   */
  sepRows: readonly LegacyRow[];
  /** `tanggal` — the inpatient admission date, already `YYYY-MM-DD`. */
  targetDate: string;
  /** `jns_pelayanan` — matched as a lowercase substring of the row's own value. Default `"RITL"`. */
  expectedService?: string;
  /** `tolerance_days` — clamped to 0..7 before use. Default `3`, as in `find_sep`. */
  toleranceDays?: number;
  /**
   * caller supplies the BPJS card number `find_sep` resolves up front from
   * `pendaftaran.getdatakunjungan` (`no_kk`; rejected when shorter than 9 digits
   * or prefixed `33`) falling back to `pendaftaran.getdatapenjamin_tab`
   * (`no_asuransi`), zero-padded to 13. `find_sep` aborts with "No kartu BPJS
   * kosong atau tidak ditemukan" when that yields nothing or all zeros — that
   * pre-flight check stays with the caller.
   */
  noKartuBpjs?: string;
  /** caller supplies the result of `pendaftaran.getdata_sep_bpjs`, keyed by `no_sep`. */
  sepDetails?: SepDetailLookup;
}

/**
 * The pure decision core of `find_sep` — given the SEP history the caller
 * already fetched, pick the SEP that backs this admission.
 *
 * Search order, unchanged from the Python:
 *  1. keep rows whose `jns_pelayanan` contains the expected service (RITL);
 *  2. merge each survivor with its detail when needed, then keep only rows
 *     whose PPK pelayanan is {@link TARGET_SEP_PPK_PELAYANAN}. If the service
 *     filter found rows but the PPK filter rejected all of them, fail *there*
 *     with the PPK reason — a different diagnosis from "no SEP on that date";
 *  3. an exact hit — a `tgl_sep` on the same calendar day as `targetDate`,
 *     whatever the spelling (`"2026-06-10"`, `"2026-06-10 00:00:00"`,
 *     `"10-06-2026"`) — wins outright (`matchType: "exact"`,
 *     `appliedToleranceDays: 0`). Both sides go through `parseDateFlexible`,
 *     so a timestamped row is no longer demoted to the tolerance path. An
 *     unparseable `targetDate` matches nothing here, as before;
 *  4. otherwise take the nearest row within the tolerance window
 *     (`matchType: "tolerance"`, `appliedToleranceDays` = days consumed).
 *     Ties keep history order, matching Python's stable sort;
 *  5. nothing within tolerance → `sepValid: false`.
 */
export function matchSepFromHistory(args: MatchSepFromHistoryArgs): SepResult {
  const { sepRows, targetDate, sepDetails } = args;
  const noKartuBpjs = text(args.noKartuBpjs);
  const expectedService = (args.expectedService ?? 'RITL').toLowerCase().trim();
  const toleranceDays = clampToleranceDays(args.toleranceDays ?? 3);
  const targetDt = parseDateFlexible(targetDate);

  const kandidatJns: LegacyRow[] = [];
  const kandidatPpk: LegacyRow[] = [];

  for (const item of sepRows) {
    const rowService = text(item['jns_pelayanan']).toLowerCase();
    if (!rowService.includes(expectedService)) continue;
    const normalizedItem: LegacyRow = { ...item };
    kandidatJns.push(normalizedItem);
    const mergedItem = sepPpkMatchesTarget(normalizedItem)
      ? normalizedItem
      : mergeSepHistoryItem(normalizedItem, sepDetails);
    if (sepPpkMatchesTarget(mergedItem)) kandidatPpk.push(mergedItem);
  }

  if (kandidatPpk.length === 0 && kandidatJns.length > 0) {
    return {
      sepValid: false,
      reason: `Tidak ada SEP ${expectedService.toUpperCase()} dengan PPK pelayanan ${TARGET_SEP_PPK_PELAYANAN}`,
      results: kandidatJns,
      noKartuBPJS: noKartuBpjs,
    };
  }

  // Same calendar day, however `tgl_sep` is spelled — `"2026-06-10"`,
  // `"2026-06-10 00:00:00"` and `"10-06-2026"` all hit. An unparseable
  // `targetDate` keeps the window search in charge, exactly as before.
  if (targetDt !== null) {
    for (const item of kandidatPpk) {
      const sepDt = parseDateFlexible(item['tgl_sep']);
      if (sepDt === null || calendarDiffDays(sepDt, targetDt) !== 0) continue;
      const mergedItem = mergeSepHistoryItem(item, sepDetails);
      return {
        sepValid: true,
        sepOK: text(mergedItem['no_sep']),
        noKartuBPJS: noKartuBpjs,
        sepItem: mergedItem,
        targetTanggal: targetDate,
        matchedTanggal: text(mergedItem['tgl_sep']),
        configuredToleranceDays: toleranceDays,
        appliedToleranceDays: 0,
        matchType: 'exact',
      };
    }
  }

  const kandidat: Array<{ selisihHari: number; item: LegacyRow }> = [];
  for (const item of kandidatPpk) {
    if (targetDt === null) continue;
    const sepDt = parseDateFlexible(item['tgl_sep']);
    if (sepDt === null) continue;
    const selisihHari = Math.abs(calendarDiffDays(sepDt, targetDt));
    if (selisihHari <= toleranceDays) kandidat.push({ selisihHari, item });
  }

  if (kandidat.length > 0) {
    // Stable ascending sort by distance — Python's `kandidat.sort(key=x[0])`.
    kandidat.sort((a, b) => a.selisihHari - b.selisihHari);
    const best = kandidat[0] as { selisihHari: number; item: LegacyRow };
    const mergedItem = mergeSepHistoryItem(best.item, sepDetails);
    return {
      sepValid: true,
      sepOK: text(mergedItem['no_sep']),
      noKartuBPJS: noKartuBpjs,
      sepItem: mergedItem,
      targetTanggal: targetDate,
      matchedTanggal: text(mergedItem['tgl_sep']),
      configuredToleranceDays: toleranceDays,
      appliedToleranceDays: best.selisihHari,
      matchType: 'tolerance',
    };
  }

  return {
    sepValid: false,
    reason:
      `Tidak ada SEP tanggal ${targetDate} (toleransi ${toleranceDays} hari) ` +
      `untuk Rawat Inap (RITL) di PPK ${TARGET_SEP_PPK_PELAYANAN}`,
    results: kandidatPpk.length > 0 ? kandidatPpk : sepRows,
    noKartuBPJS: noKartuBpjs,
  };
}

/** Arguments for {@link buildSepResultFromKnownSep}. */
export interface BuildSepResultFromKnownSepArgs {
  /** `no_sep` — a SEP number we already trust (from the kasir row or the inap row). */
  noSep: string;
  /** `target_date` — the date we are billing for. */
  targetDate?: string;
  /** `fallback_date` — usually `tgl_masuk`, used when the detail has no `tgl_sep`. */
  fallbackDate?: string;
  /** `no_kartu_bpjs` — preferred over anything the detail carries. */
  noKartuBpjs?: string;
  /** `tolerance_days` — recorded as `configuredToleranceDays`; never applied here. */
  toleranceDays?: number;
  /** `expected_service` — default `"RITL"`; a mismatch invalidates the shortcut. */
  expectedService?: string;
  /** `match_type` — default `"known_sep"`; callers pass `"byny_known_sep"` / `"byny_kasir_sep"`. */
  matchType?: string;
  /** caller supplies the result of `pendaftaran.getdata_sep_bpjs` for `noSep`. */
  sepDetail?: LegacyRow;
}

/**
 * `_build_sep_result_from_known_sep` — the shortcut for when the SEP number is
 * already known and the history search is unnecessary (or already failed).
 *
 * It still guards the service class: a SEP that resolves to RJTL cannot back an
 * inpatient bill, so a detected/expected mismatch returns `sepValid: false`.
 * `appliedToleranceDays` is always `0` — no window search happens here.
 *
 * A blank `noSep` returns `{ sepValid: false }`. The Python returns an empty
 * dict there; callers only read `sepValid`, so the effect is identical.
 */
export function buildSepResultFromKnownSep(args: BuildSepResultFromKnownSepArgs): SepResult {
  const cacheKey = text(args.noSep);
  if (!cacheKey) return { sepValid: false };

  const sepItem: Record<string, unknown> = { ...(args.sepDetail ?? {}) };
  const expectedServiceKey = normalizeJenisSepKey(args.expectedService ?? 'RITL');
  const detectedService = normalizeJenisSepKey(
    str(sepItem, 'jns_pelayanan', 'jnsPelayanan', 'jenis_sep', 'jenis_pelayanan') ||
      expectedServiceKey,
  );
  if (detectedService && expectedServiceKey && detectedService !== expectedServiceKey) {
    return {
      sepValid: false,
      reason: `SEP ${cacheKey} terdeteksi sebagai ${detectedService}, bukan ${expectedServiceKey}`,
    };
  }
  if (expectedServiceKey && !str(sepItem, 'jns_pelayanan')) {
    sepItem['jns_pelayanan'] = expectedServiceKey;
  }

  const matchedDate =
    datePart(sepItem['tgl_sep']) || datePart(args.fallbackDate) || datePart(args.targetDate);
  if (matchedDate && !str(sepItem, 'tgl_sep')) {
    sepItem['tgl_sep'] = matchedDate;
  }

  const noKartu = text(args.noKartuBpjs) || str(sepItem, 'no_kartu', 'no_bpjs', 'no_kartu_bpjs');

  return {
    sepValid: true,
    sepOK: cacheKey,
    noKartuBPJS: noKartu,
    sepItem,
    targetTanggal: datePart(args.targetDate) || matchedDate,
    matchedTanggal: matchedDate,
    configuredToleranceDays: clampToleranceDays(args.toleranceDays ?? 0),
    appliedToleranceDays: 0,
    matchType: text(args.matchType) || 'known_sep',
  };
}

/** Arguments for {@link resolveJenisSepPasien}. */
export interface ResolveJenisSepPasienArgs {
  /** `current_jenis_sep` — whatever the kasir transaction already recorded. */
  currentJenisSep?: string;
  /** `no_sep` — presence of a SEP number enables the detail lookup below. */
  noSep?: string;
  /** caller supplies the result of `pendaftaran.getdata_sep_bpjs` for `noSep`. */
  sepDetail?: LegacyRow;
  /** `no_registrasikunjungan` — presence enables the penjamin-tab lookup below. */
  noRegistrasiKunjungan?: string;
  /** caller supplies the result of `pendaftaran.getdatapenjamin_tab` for the registration. */
  penjaminTab?: LegacyRow;
  /**
   * Shorthand for callers that carry only the resolved service class from the
   * pendaftaran penjamin tab rather than the whole row. It stands in for
   * `penjaminTab` and is consulted last, reported under the same
   * `"pendaftaran:getdatapenjamin_tab"` source. Unlike `penjaminTab` it is not
   * gated on `noRegistrasiKunjungan` — supplying it *is* the evidence that the
   * pendaftaran lookup happened.
   */
  jenisSepFromPendaftaran?: string;
}

const JENIS_SEP_KEYS = ['jns_pelayanan', 'jnsPelayanan', 'jenis_sep', 'jenis_pelayanan'] as const;

/**
 * `_resolve_jenis_sep_pasien` — decide whether this patient's SEP is inpatient
 * (RITL) or outpatient (RJTL), and report which source settled it.
 *
 * Precedence: the kasir transaction, then the SEP detail, then the pendaftaran
 * penjamin tab. `source` carries the Python's own labels (`"kasir"`,
 * `"pendaftaran:getdata_sep_bpjs"`, `"pendaftaran:getdatapenjamin_tab"`) and is
 * `""` when nothing resolved.
 */
export function resolveJenisSepPasien(args: ResolveJenisSepPasienArgs): {
  jenisSep: string;
  source: string;
} {
  const fromKasir = normalizeJenisSepKey(args.currentJenisSep);
  if (fromKasir) return { jenisSep: fromKasir, source: 'kasir' };

  if (text(args.noSep)) {
    for (const key of JENIS_SEP_KEYS) {
      const jenisSep = normalizeJenisSepKey(args.sepDetail?.[key]);
      if (jenisSep) return { jenisSep, source: 'pendaftaran:getdata_sep_bpjs' };
    }
  }

  if (text(args.noRegistrasiKunjungan)) {
    for (const key of JENIS_SEP_KEYS) {
      const jenisSep = normalizeJenisSepKey(args.penjaminTab?.[key]);
      if (jenisSep) return { jenisSep, source: 'pendaftaran:getdatapenjamin_tab' };
    }
  }

  const shorthand = normalizeJenisSepKey(args.jenisSepFromPendaftaran);
  if (shorthand) return { jenisSep: shorthand, source: 'pendaftaran:getdatapenjamin_tab' };

  return { jenisSep: '', source: '' };
}
