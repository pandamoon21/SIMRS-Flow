import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER, exportTable, filterRows, normalizeKelas, parseRupiahInput, rowMatchesQuery, sortRows, summarize, type NaikKelasRow } from './naikKelas.js';

const row = (over: Partial<NaikKelasRow>): NaikKelasRow => ({
  timestamp: '2026-10-19T14:10:41', noRm: '0-11-22-33', nama: 'PASIEN, NY', hakKelas: 'I', kelasRanap: 'VIP',
  totalBilling: 1000, tindakan: 'ct scan kepala', kasus: 'bedah onko', dokter: 'dr. A', kodeGrouping: 'G-4-23-I',
  klaimBpjs: 'Klaim BPJS', klaimKelas1: 600, klaimKelas2: 0, iur: 400, tglPulang: '2026-10-16', ...over,
});

describe('iur naik kelas helpers', () => {
  it('finds a No. RM with or without dashes, and text in name/doctor/case', () => {
    const r = row({});
    expect(rowMatchesQuery(r, '112233')).toBe(true);
    expect(rowMatchesQuery(r, '0-11-22-33')).toBe(true);
    expect(rowMatchesQuery(r, 'pasien')).toBe(true);
    expect(rowMatchesQuery(r, 'ONKO')).toBe(true);
    expect(rowMatchesQuery(r, '999999')).toBe(false);
  });

  it('filters by date range on the chosen date column and by kelas spelled 1 or I', () => {
    const rows = [row({ noRm: 'a', hakKelas: '1' }), row({ noRm: 'b', hakKelas: 'II', tglPulang: '2026-10-01' }), row({ noRm: 'c', timestamp: '2026-09-30T08:00:00' })];
    expect(filterRows(rows, { ...EMPTY_FILTER, hakKelas: 'I' }).map((r) => r.noRm)).toEqual(['a', 'c']);
    expect(filterRows(rows, { ...EMPTY_FILTER, from: '2026-10-10' }).map((r) => r.noRm)).toEqual(['a', 'c']);
    expect(filterRows(rows, { ...EMPTY_FILTER, dateField: 'timestamp', to: '2026-09-30' }).map((r) => r.noRm)).toEqual(['c']);
    expect(normalizeKelas(' 2 ')).toBe('II');
    expect(normalizeKelas('Deluxe')).toBe('VIP');
    expect(normalizeKelas('PRESIDENT  SUITE')).toBe('VVIP');
  });

  it('filters by kasus / tindakan / kode grouping text and by IUR or billing range', () => {
    const rows = [
      row({ noRm: 'a', kasus: 'Bedah Onkologi', tindakan: 'kemoterapi', kodeGrouping: 'C-4-13-I', iur: 2_500_000, totalBilling: 9_000_000 }),
      row({ noRm: 'b', kasus: 'interna', tindakan: 'usg abdomen', kodeGrouping: 'B-4-13-I', iur: 400_000, totalBilling: null }),
    ];
    const pick = (f: Partial<typeof EMPTY_FILTER>) => filterRows(rows, { ...EMPTY_FILTER, ...f }).map((r) => r.noRm);
    expect(pick({ kasus: 'onko' })).toEqual(['a']);
    expect(pick({ tindakan: 'USG' })).toEqual(['b']);
    expect(pick({ kodeGrouping: 'b-4' })).toEqual(['b']);
    expect(pick({ iurMin: '1 jt' })).toEqual(['a']);
    expect(pick({ iurMax: '500rb' })).toEqual(['b']);
    // A blank value never satisfies a range.
    expect(pick({ billingMin: '1' })).toEqual(['a']);
    expect(parseRupiahInput('Rp 1.500.000')).toBe(1_500_000);
    expect(parseRupiahInput('1,5 jt')).toBe(1_500_000);
    expect(parseRupiahInput('')).toBeUndefined();
  });

  it('sorts numbers numerically with blanks last, and totals the IUR', () => {
    const rows = [row({ noRm: 'a', iur: 50 }), row({ noRm: 'b', iur: null }), row({ noRm: 'c', iur: 900 })];
    expect(sortRows(rows, { key: 'iur', dir: 'desc' }).map((r) => r.noRm)).toEqual(['c', 'a', 'b']);
    expect(sortRows(rows, { key: 'iur', dir: 'asc' }).map((r) => r.noRm)).toEqual(['a', 'c', 'b']);
    expect(summarize(rows)).toMatchObject({ count: 3, iur: 950 });
  });

  it('exports numbers as numbers in column order', () => {
    const { header, body } = exportTable([row({})]);
    expect(header[0]).toBe('Tgl pulang');
    expect(body[0]).toContain(400);
    expect(body[0]?.at(-1)).toBe('2026-10-19 14:10:41');
  });
});
