/**
 * SEP matching — behaviour pinned against `ranap_v3.py`.
 *
 * The scenarios below are the ones that decide whether a real bill gets
 * verified: an exact-date hit, a hit that only lands inside the tolerance
 * window, a history with no inpatient SEP at all, a SEP issued for another
 * hospital, and the known-SEP shortcut used for newborns.
 */

import { describe, it, expect } from 'vitest';

import type { LegacyRow } from './types.js';
import {
  TARGET_SEP_PPK_PELAYANAN,
  buildSepResultFromKnownSep,
  matchSepFromHistory,
  mergeSepHistoryItem,
  noKkRejectionReason,
  normalizeJenisSepKey,
  resolveJenisSepPasien,
  sepPpkMatchesTarget,
} from './sep.js';

const NO_KARTU = '0001234567890';
const SEP_RITL = '1301R0010126V000111';
const SEP_RJTL = '1301R0110126V000222';
const SEP_OTHER_PPK = '1302R0010126V000333';

/** A SEP history row as `get_datariwayatsep` returns it. */
function sepRow(overrides: LegacyRow = {}): LegacyRow {
  return {
    no_sep: SEP_RITL,
    tgl_sep: '2026-01-04',
    jns_pelayanan: 'RITL',
    ppkPelayanan: 'PKU MUHAMMADIYAH GOMBONG',
    no_kartu: NO_KARTU,
    nama_peserta: 'PASIEN DUA',
    ...overrides,
  };
}

describe('normalizeJenisSepKey', () => {
  it('collapses the inpatient spellings onto RITL', () => {
    expect(normalizeJenisSepKey('RITL')).toBe('RITL');
    expect(normalizeJenisSepKey('ritl')).toBe('RITL');
    expect(normalizeJenisSepKey('Rawat Inap')).toBe('RITL');
    expect(normalizeJenisSepKey('Rawat Inap Tingkat Lanjutan')).toBe('RITL');
  });

  it('collapses the outpatient spellings onto RJTL', () => {
    expect(normalizeJenisSepKey('RJTL')).toBe('RJTL');
    expect(normalizeJenisSepKey('rawat jalan tingkat lanjutan')).toBe('RJTL');
  });

  it('returns empty for anything unrecognised', () => {
    expect(normalizeJenisSepKey('')).toBe('');
    expect(normalizeJenisSepKey(undefined)).toBe('');
    expect(normalizeJenisSepKey('IGD')).toBe('');
  });
});

describe('sepPpkMatchesTarget', () => {
  it('accepts the target facility and its prefixed spellings', () => {
    expect(sepPpkMatchesTarget({ ppkPelayanan: 'PKU MUHAMMADIYAH GOMBONG' })).toBe(true);
    expect(sepPpkMatchesTarget({ ppkPelayanan: 'RS PKU MUHAMMADIYAH GOMBONG' })).toBe(true);
    expect(sepPpkMatchesTarget({ ppk_pelayanan: 'PKU Muhammadiyah Gombong' })).toBe(true);
  });

  it('rejects another facility and a missing facility', () => {
    expect(sepPpkMatchesTarget({ ppkPelayanan: 'RSUD Dr SOEDIRMAN KEBUMEN' })).toBe(false);
    expect(sepPpkMatchesTarget({})).toBe(false);
    expect(sepPpkMatchesTarget({ ppkPelayanan: '   ' })).toBe(false);
  });
});

describe('mergeSepHistoryItem', () => {
  it('overlays the SEP detail onto the history row', () => {
    const merged = mergeSepHistoryItem(sepRow({ ppkPelayanan: '' }), {
      [SEP_RITL]: { ppkPelayanan: 'PKU MUHAMMADIYAH GOMBONG', kelas_rawat: '3' },
    });
    expect(merged['ppkPelayanan']).toBe('PKU MUHAMMADIYAH GOMBONG');
    expect(merged['kelas_rawat']).toBe('3');
    expect(merged['nama_peserta']).toBe('PASIEN DUA');
  });

  it('returns the row untouched with no no_sep or no detail', () => {
    expect(mergeSepHistoryItem({ tgl_sep: '2026-01-04' })).toEqual({ tgl_sep: '2026-01-04' });
    expect(mergeSepHistoryItem(sepRow(), { [SEP_RITL]: {} })['tgl_sep']).toBe('2026-01-04');
  });
});

describe('matchSepFromHistory — exact date', () => {
  it('takes the same-day SEP with no tolerance consumed', () => {
    const result = matchSepFromHistory({
      sepRows: [sepRow({ no_sep: SEP_OTHER_PPK, tgl_sep: '2026-01-03' }), sepRow()],
      targetDate: '2026-01-04',
      noKartuBpjs: NO_KARTU,
      toleranceDays: 3,
    });
    expect(result.sepValid).toBe(true);
    expect(result.matchType).toBe('exact');
    expect(result.sepOK).toBe(SEP_RITL);
    expect(result.noKartuBPJS).toBe(NO_KARTU);
    expect(result.targetTanggal).toBe('2026-01-04');
    expect(result.matchedTanggal).toBe('2026-01-04');
    expect(result.appliedToleranceDays).toBe(0);
    expect(result.configuredToleranceDays).toBe(3);
    expect(result.reason).toBeUndefined();
  });

  it('prefers the exact hit over a nearer-listed tolerance candidate', () => {
    const result = matchSepFromHistory({
      sepRows: [sepRow({ no_sep: SEP_OTHER_PPK, tgl_sep: '2026-01-05' }), sepRow()],
      targetDate: '2026-01-04',
    });
    expect(result.matchType).toBe('exact');
    expect(result.sepOK).toBe(SEP_RITL);
  });

  it('merges the detail into the winning row', () => {
    const result = matchSepFromHistory({
      sepRows: [sepRow({ kelas_rawat: '' })],
      targetDate: '2026-01-04',
      sepDetails: { [SEP_RITL]: { kelas_rawat: '2', diagnosa: 'DENGUE FEVER' } },
    });
    expect(result.sepItem?.['kelas_rawat']).toBe('2');
    expect(result.sepItem?.['diagnosa']).toBe('DENGUE FEVER');
  });

  it('treats a timestamped tgl_sep on the same day as an exact hit', () => {
    // The exact branch compares parsed calendar days, not raw strings: a
    // `2026-01-04 00:00:00` row is the same day as the target, so it takes the
    // exact path rather than being demoted to a zero-day tolerance match.
    const result = matchSepFromHistory({
      sepRows: [sepRow({ tgl_sep: '2026-01-04 00:00:00' })],
      targetDate: '2026-01-04',
    });
    expect(result.sepValid).toBe(true);
    expect(result.matchType).toBe('exact');
    expect(result.appliedToleranceDays).toBe(0);
    expect(result.matchedTanggal).toBe('2026-01-04 00:00:00');
  });
});

describe('matchSepFromHistory — tolerance window', () => {
  it('takes the nearest SEP inside the window and reports the days consumed', () => {
    const result = matchSepFromHistory({
      sepRows: [
        sepRow({ no_sep: '1301R0010126V000101', tgl_sep: '2026-01-01' }),
        sepRow({ no_sep: '1301R0010126V000106', tgl_sep: '2026-01-06' }),
      ],
      targetDate: '2026-01-04',
      noKartuBpjs: NO_KARTU,
      toleranceDays: 3,
    });
    expect(result.sepValid).toBe(true);
    expect(result.matchType).toBe('tolerance');
    expect(result.sepOK).toBe('1301R0010126V000106');
    expect(result.appliedToleranceDays).toBe(2);
    expect(result.configuredToleranceDays).toBe(3);
    expect(result.targetTanggal).toBe('2026-01-04');
    expect(result.matchedTanggal).toBe('2026-01-06');
  });

  it('matches a SEP before the admission just as readily as one after', () => {
    const result = matchSepFromHistory({
      sepRows: [sepRow({ tgl_sep: '2026-01-01' })],
      targetDate: '2026-01-04',
      toleranceDays: 3,
    });
    expect(result.sepValid).toBe(true);
    expect(result.appliedToleranceDays).toBe(3);
  });

  it('rejects a SEP one day past the window', () => {
    const result = matchSepFromHistory({
      sepRows: [sepRow({ tgl_sep: '2025-12-31' })],
      targetDate: '2026-01-04',
      toleranceDays: 3,
    });
    expect(result.sepValid).toBe(false);
    expect(result.reason).toContain('toleransi 3 hari');
  });

  it('clamps the configured tolerance to at most 7 days', () => {
    const result = matchSepFromHistory({
      sepRows: [sepRow({ tgl_sep: '2026-01-14' })],
      targetDate: '2026-01-04',
      toleranceDays: 30,
    });
    expect(result.sepValid).toBe(false);
    expect(result.reason).toContain('toleransi 7 hari');
  });

  it('keeps history order when two candidates are equidistant', () => {
    const result = matchSepFromHistory({
      sepRows: [
        sepRow({ no_sep: '1301R0010126V000102', tgl_sep: '2026-01-02' }),
        sepRow({ no_sep: '1301R0010126V000106', tgl_sep: '2026-01-06' }),
      ],
      targetDate: '2026-01-04',
      toleranceDays: 3,
    });
    expect(result.sepOK).toBe('1301R0010126V000102');
    expect(result.appliedToleranceDays).toBe(2);
  });
});

describe('matchSepFromHistory — no inpatient SEP', () => {
  it('fails when every SEP in the history is outpatient', () => {
    const rows = [
      sepRow({ no_sep: SEP_RJTL, jns_pelayanan: 'RJTL', tgl_sep: '2026-01-04' }),
      sepRow({ no_sep: '1301R0110126V000223', jns_pelayanan: 'RJTL', tgl_sep: '2026-01-06' }),
    ];
    const result = matchSepFromHistory({
      sepRows: rows,
      targetDate: '2026-01-04',
      noKartuBpjs: NO_KARTU,
    });
    expect(result.sepValid).toBe(false);
    expect(result.sepOK).toBeUndefined();
    expect(result.reason).toContain('Tidak ada SEP tanggal 2026-01-04');
    // Nothing survived the service filter, so the raw history is surfaced.
    expect(result.results).toEqual(rows);
    expect(result.noKartuBPJS).toBe(NO_KARTU);
  });

  it('fails on an empty history', () => {
    const result = matchSepFromHistory({ sepRows: [], targetDate: '2026-01-04' });
    expect(result.sepValid).toBe(false);
    expect(result.results).toEqual([]);
  });

  it('honours a non-default expected service', () => {
    const result = matchSepFromHistory({
      sepRows: [sepRow({ no_sep: SEP_RJTL, jns_pelayanan: 'Rawat Jalan (RJTL)' })],
      targetDate: '2026-01-04',
      expectedService: 'RJTL',
    });
    expect(result.sepValid).toBe(true);
    expect(result.matchType).toBe('exact');
  });
});

describe('matchSepFromHistory — PPK filter', () => {
  it('rejects an inpatient SEP issued by another hospital, with its own reason', () => {
    const rows = [
      sepRow({
        no_sep: SEP_OTHER_PPK,
        ppkPelayanan: 'RSUD Dr SOEDIRMAN KEBUMEN',
      }),
    ];
    const result = matchSepFromHistory({
      sepRows: rows,
      targetDate: '2026-01-04',
      noKartuBpjs: NO_KARTU,
    });
    expect(result.sepValid).toBe(false);
    expect(result.reason).toBe(
      `Tidak ada SEP RITL dengan PPK pelayanan ${TARGET_SEP_PPK_PELAYANAN}`,
    );
    expect(result.results).toHaveLength(1);
    expect(result.noKartuBPJS).toBe(NO_KARTU);
  });

  it('rescues a row whose PPK only appears in the SEP detail', () => {
    const result = matchSepFromHistory({
      sepRows: [sepRow({ ppkPelayanan: '' })],
      targetDate: '2026-01-04',
      sepDetails: { [SEP_RITL]: { ppkPelayanan: 'RS PKU MUHAMMADIYAH GOMBONG' } },
    });
    expect(result.sepValid).toBe(true);
    expect(result.matchType).toBe('exact');
  });
});

describe('buildSepResultFromKnownSep', () => {
  it('accepts a known inpatient SEP and labels the match type', () => {
    const result = buildSepResultFromKnownSep({
      noSep: SEP_RITL,
      targetDate: '2026-01-04',
      fallbackDate: '2026-01-04',
      noKartuBpjs: NO_KARTU,
      toleranceDays: 3,
      matchType: 'byny_known_sep',
      sepDetail: { tgl_sep: '2026-01-03', jns_pelayanan: 'RITL', kelas_rawat: '3' },
    });
    expect(result.sepValid).toBe(true);
    expect(result.sepOK).toBe(SEP_RITL);
    expect(result.matchType).toBe('byny_known_sep');
    expect(result.noKartuBPJS).toBe(NO_KARTU);
    expect(result.targetTanggal).toBe('2026-01-04');
    expect(result.matchedTanggal).toBe('2026-01-03');
    expect(result.configuredToleranceDays).toBe(3);
    // The shortcut never searches a window, so nothing is ever consumed.
    expect(result.appliedToleranceDays).toBe(0);
  });

  it('fills in the service class and the date when the detail is empty', () => {
    const result = buildSepResultFromKnownSep({
      noSep: SEP_RITL,
      targetDate: '2026-01-04',
      fallbackDate: '2026-01-02 08:15:00',
    });
    expect(result.sepValid).toBe(true);
    expect(result.matchType).toBe('known_sep');
    expect(result.sepItem?.['jns_pelayanan']).toBe('RITL');
    expect(result.sepItem?.['tgl_sep']).toBe('2026-01-02');
    expect(result.matchedTanggal).toBe('2026-01-02');
  });

  it('refuses an outpatient SEP for an inpatient bill', () => {
    const result = buildSepResultFromKnownSep({
      noSep: SEP_RJTL,
      targetDate: '2026-01-04',
      sepDetail: { jns_pelayanan: 'RJTL' },
    });
    expect(result.sepValid).toBe(false);
    expect(result.reason).toBe(`SEP ${SEP_RJTL} terdeteksi sebagai RJTL, bukan RITL`);
    expect(result.sepOK).toBeUndefined();
  });

  it('falls back to the card number carried by the detail', () => {
    const result = buildSepResultFromKnownSep({
      noSep: SEP_RITL,
      sepDetail: { no_kartu_bpjs: NO_KARTU, jns_pelayanan: 'RITL', tgl_sep: '2026-01-04' },
    });
    expect(result.noKartuBPJS).toBe(NO_KARTU);
  });

  it('is invalid for a blank SEP number', () => {
    expect(buildSepResultFromKnownSep({ noSep: '   ' }).sepValid).toBe(false);
  });
});

describe('resolveJenisSepPasien', () => {
  it('trusts the kasir transaction first', () => {
    expect(
      resolveJenisSepPasien({
        currentJenisSep: 'Rawat Inap',
        noSep: SEP_RJTL,
        sepDetail: { jns_pelayanan: 'RJTL' },
      }),
    ).toEqual({ jenisSep: 'RITL', source: 'kasir' });
  });

  it('falls back to the SEP detail', () => {
    expect(
      resolveJenisSepPasien({
        noSep: SEP_RITL,
        sepDetail: { jenis_pelayanan: 'RITL' },
      }),
    ).toEqual({ jenisSep: 'RITL', source: 'pendaftaran:getdata_sep_bpjs' });
  });

  it('falls back to the pendaftaran penjamin tab', () => {
    expect(
      resolveJenisSepPasien({
        noRegistrasiKunjungan: 'RG2601040001',
        penjaminTab: { jnsPelayanan: 'RJTL' },
      }),
    ).toEqual({ jenisSep: 'RJTL', source: 'pendaftaran:getdatapenjamin_tab' });
  });

  it('accepts the pre-resolved pendaftaran shorthand', () => {
    expect(resolveJenisSepPasien({ jenisSepFromPendaftaran: 'RITL' })).toEqual({
      jenisSep: 'RITL',
      source: 'pendaftaran:getdatapenjamin_tab',
    });
  });

  it('reports no source when nothing resolves', () => {
    expect(resolveJenisSepPasien({})).toEqual({ jenisSep: '', source: '' });
    expect(resolveJenisSepPasien({ noSep: SEP_RITL, sepDetail: {} })).toEqual({
      jenisSep: '',
      source: '',
    });
  });
});

// ---------------------------------------------------------------------------
// Audit gaps: card rejection, unreadable history, skip/BYNY waivers.
//
// Only the decisions that live in `sep.ts` can be pinned here. The two the
// executor owns — the unreadable-history timeout and both waivers — are
// reported as untestable at this level; see the trailing `describe` comments
// for the exact `executors.ts` lines that hold them.
// ---------------------------------------------------------------------------

describe('no kartu BPJS — no_kk rejection (find_sep pre-flight)', () => {
  it('rejects an empty no_kk and falls back to the payer tab', () => {
    expect(noKkRejectionReason('')).toBe('panjang < 9');
    expect(noKkRejectionReason('   ')).toBe('panjang < 9');
    expect(noKkRejectionReason(undefined)).toBe('panjang < 9');
    expect(noKkRejectionReason(null)).toBe('panjang < 9');
  });

  it('rejects a no_kk shorter than nine digits', () => {
    expect(noKkRejectionReason('12345678')).toBe('panjang < 9');
    expect(noKkRejectionReason('00012345')).toBe('panjang < 9');
  });

  it('rejects a Central Java NIK prefixed 33', () => {
    // 16-digit NIK, and the 13-digit card-shaped case — the prefix alone decides.
    expect(noKkRejectionReason('3305011234567890')).toBe('berawalan 33 (NIK)');
    expect(noKkRejectionReason('3301234567890')).toBe('berawalan 33 (NIK)');
  });

  it('accepts a real card number, including the 33 check being prefix-only', () => {
    expect(noKkRejectionReason('0009876543210')).toBe('');
    expect(noKkRejectionReason('1234567890')).toBe('');
    // "33" mid-string is not a NIK prefix.
    expect(noKkRejectionReason('0001233456789')).toBe('');
  });

  it('checks the length rule before the prefix rule', () => {
    // "33" is only two characters, so the length rule must fire first —
    // otherwise the executor would log the wrong reason for it.
    expect(noKkRejectionReason('33')).toBe('panjang < 9');
  });

  it('accepts the payer-tab fallback that replaces a rejected no_kk', () => {
    // The only exported card helper sep.ts reaches is the throwaway probe above;
    // what the fallback *produces* is a normalized 13-digit card, which
    // `matchSepFromHistory` then echoes back as `noKartuBPJS`.
    const noKk = '3305011234567890';
    expect(noKkRejectionReason(noKk)).not.toBe('');
    const result = matchSepFromHistory({
      sepRows: [sepRow()],
      targetDate: '2026-01-04',
      toleranceDays: 3,
      noKartuBpjs: NO_KARTU,
    });
    expect(result.sepValid).toBe(true);
    expect(result.noKartuBPJS).toBe(NO_KARTU);
    expect(result.noKartuBPJS).not.toBe(noKk);
  });
});

// ---------------------------------------------------------------------------
// Untestable at this level — documented, not faked.
//
// 1. Unreadable SEP history. `executors.ts:1460-1462` returns
//    `fail('Riwayat SEP BPJS tidak terbaca …')` when `getRiwayatSep` yields
//    `undefined` (timeout/failure) and only calls `matchSepFromHistory` on a
//    successful read. There is no exported "was this read successful" decision
//    in sep.ts: `sepRows` is an array, so the `undefined` distinction cannot
//    survive the type. Pinned only indirectly below (an empty history is
//    "no SEP", not "unreadable").
//
// 2. `skipVerifikasiSep`. `executors.ts:1494-1512` builds the
//    `sepOptional` / `matchType: 'skip_sep_verification'` result inline; no
//    pure builder exists in sep.ts. Only the *input* it reacts to is exported.
//
// 3. BYNY waiver. `resolveSepFallback` (`executors.ts:8171-8256`) does the
//    `03-` filter, the healthy-newborn RME check and the
//    `sepOptionalReason: 'byny_sehat_mengikuti_sep_orangtua'` synthesis in the
//    network shell. Its pure building block, `buildSepResultFromKnownSep` with
//    `matchType: 'byny_known_sep'`, is already pinned above.
// ---------------------------------------------------------------------------

describe('SEP failure modes that stay distinguishable inside sep.ts', () => {
  it('reports an empty history as "no SEP on that date", never as unreadable', () => {
    // `matchSepFromHistory` only ever sees a list; the executor is responsible
    // for turning a `undefined` transport read into the "tidak terbaca" failure
    // (executors.ts:1461). A list that is empty — including the `rowsOf(non-list)`
    // normalization of a malformed payload — must read as a real absence.
    const result = matchSepFromHistory({
      sepRows: [],
      targetDate: '2026-01-04',
      noKartuBpjs: NO_KARTU,
    });
    expect(result.sepValid).toBe(false);
    expect(result.matchType).toBeUndefined();
    expect(result.sepOptional).toBeUndefined();
    expect(result.reason).toContain('Tidak ada SEP tanggal 2026-01-04');
    expect(result.reason).not.toContain('tidak terbaca');
  });

  it('never lends a failure result skip/BYNY waiver markers', () => {
    // Both waivers are applied by the executor on top of a failed `SepResult`.
    // The pure core must hand back a plainly invalid result so a waiver can only
    // ever be an explicit, logged executor decision.
    const result = matchSepFromHistory({
      sepRows: [sepRow({ jns_pelayanan: 'RJTL', tgl_sep: '2026-01-04' })],
      targetDate: '2026-01-04',
    });
    expect(result.sepValid).toBe(false);
    expect(result.sepOK).toBeUndefined();
    expect(result.sepOptional).toBeUndefined();
    expect(result.sepOptionalReason).toBeUndefined();
  });

  it('preserves filtered-out rows for the operator to inspect on failure', () => {
    // The executor surfaces `result.reason` verbatim; the rows it inspected must
    // survive so an operator can tell a wrong-PPK SEP from a missing one.
    const rows = [sepRow({ ppkPelayanan: 'RSUD Dr SOEDIRMAN KEBUMEN' })];
    const result = matchSepFromHistory({
      sepRows: rows,
      targetDate: '2026-01-04',
      toleranceDays: 3,
    });
    expect(result.reason).toBe(
      `Tidak ada SEP RITL dengan PPK pelayanan ${TARGET_SEP_PPK_PELAYANAN}`,
    );
    expect(result.results).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------
// Exact branch on parsed calendar days.
//
// `tgl_sep` reaches us in whatever spelling BPJS returned: bare date, date
// plus `00:00:00`, or a `d-m-Y` variant. The exact branch parses both sides
// with `parseDateFlexible` and compares calendar days, so a same-day row keeps
// `matchType: 'exact'` / `appliedToleranceDays: 0` instead of falling through
// to the tolerance path. `matchedTanggal` still echoes the raw `tgl_sep`.
//
// `10/06/2026` is intentionally not pinned: `parseDateFlexible` accepts
// `%Y-%m-%d`, `%d-%m-%Y`, `%Y/%m/%d`, `%d-%b-%Y` and `%d %b %Y` (plus the
// datetime forms), but not slash-separated `d/m/Y`, so such a row parses to
// `null` and stays on the tolerance/failure path exactly as before.
// ---------------------------------------------------------------------------

describe('matchSepFromHistory — exact date across tgl_sep spellings', () => {
  it('takes the exact branch for a timestamped same-day tgl_sep', () => {
    const result = matchSepFromHistory({
      sepRows: [sepRow({ tgl_sep: '2026-06-10 00:00:00' })],
      targetDate: '2026-06-10',
      noKartuBpjs: NO_KARTU,
      toleranceDays: 3,
    });
    expect(result.sepValid).toBe(true);
    expect(result.matchType).toBe('exact');
    expect(result.appliedToleranceDays).toBe(0);
    expect(result.configuredToleranceDays).toBe(3);
    expect(result.targetTanggal).toBe('2026-06-10');
    // The raw value mirrors legacy, the comparison does not use it.
    expect(result.matchedTanggal).toBe('2026-06-10 00:00:00');
    expect(result.sepOK).toBe(SEP_RITL);
  });

  it('takes the exact branch for a dd-mm-yyyy same-day tgl_sep', () => {
    // The slash form `10/06/2026` is not parseable by `parseDateFlexible`;
    // the hyphen form is, and must land on the exact branch.
    const result = matchSepFromHistory({
      sepRows: [sepRow({ tgl_sep: '10-06-2026' })],
      targetDate: '2026-06-10',
    });
    expect(result.sepValid).toBe(true);
    expect(result.matchType).toBe('exact');
    expect(result.appliedToleranceDays).toBe(0);
    expect(result.matchedTanggal).toBe('10-06-2026');
  });

  it('still lets an unparseable slash date through the tolerance window unchanged', () => {
    // `10/06/2026` parses to null, so it cannot take the exact branch and must
    // resolve (or fail) via the tolerance path exactly as it did before.
    const result = matchSepFromHistory({
      sepRows: [sepRow({ tgl_sep: '10/06/2026' })],
      targetDate: '2026-06-10',
      toleranceDays: 3,
    });
    expect(result.sepValid).toBe(false);
    expect(result.reason).toContain('Tidak ada SEP tanggal 2026-06-10');
  });

  it('resolves a timestamped row one day off through tolerance', () => {
    const result = matchSepFromHistory({
      sepRows: [sepRow({ tgl_sep: '2026-06-11 00:00:00' })],
      targetDate: '2026-06-10',
      toleranceDays: 3,
    });
    expect(result.sepValid).toBe(true);
    expect(result.matchType).toBe('tolerance');
    expect(result.appliedToleranceDays).toBe(1);
    expect(result.matchedTanggal).toBe('2026-06-11 00:00:00');
  });

  it('prefers a timestamped exact hit over a nearer-listed tolerance row', () => {
    // The neighbouring row is a real string prefix match for the day before,
    // but the same-day timestamped row must still win outright.
    const result = matchSepFromHistory({
      sepRows: [
        sepRow({ no_sep: SEP_OTHER_PPK, tgl_sep: '2026-06-09' }),
        sepRow({ tgl_sep: '2026-06-10 00:00:00' }),
      ],
      targetDate: '2026-06-10',
      toleranceDays: 3,
    });
    expect(result.matchType).toBe('exact');
    expect(result.sepOK).toBe(SEP_RITL);
    expect(result.appliedToleranceDays).toBe(0);
  });

  it('keeps an unparseable targetDate out of the exact branch', () => {
    // Preserved behaviour: with no target instant there is no calendar day to
    // compare against, so the exact branch matches nothing and the tolerance
    // path reports the existing failure.
    const result = matchSepFromHistory({
      sepRows: [sepRow({ tgl_sep: '2026-06-10' })],
      targetDate: 'bukan tanggal',
      toleranceDays: 3,
    });
    expect(result.sepValid).toBe(false);
    expect(result.matchType).toBeUndefined();
    expect(result.reason).toContain('Tidak ada SEP tanggal bukan tanggal');
  });

  it('does not match the same weekday in a different year', () => {
    // Calendar-day equality, not "same month/day text": a 2025 row is a real
    // different day and must stay on the tolerance path (here, out of range).
    const result = matchSepFromHistory({
      sepRows: [sepRow({ tgl_sep: '2025-06-10 00:00:00' })],
      targetDate: '2026-06-10',
      toleranceDays: 3,
    });
    expect(result.sepValid).toBe(false);
  });
});
