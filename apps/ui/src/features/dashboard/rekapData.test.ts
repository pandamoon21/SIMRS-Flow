import { describe, expect, it } from 'vitest';
import type { ProcessedPatient } from './patients.js';
import {
  EMPTY_REKAP_FILTER,
  deltaPct,
  filterExceptCategory,
  patientMatchesQuery,
  periodRange,
  previousRange,
  seriesOf,
  sortPatients,
  totalsOf,
} from './rekapData.js';

const p = (over: Partial<ProcessedPatient>): ProcessedPatient => ({
  noRm: '0-12-34-56', name: 'Pasien A', workflow: 'ranap', date: '2026-10-19', category: 'naik_kelas', nominal: 100,
  status: 'done', operator: 'Siti', time: '08:00', shift: 1, runId: 'rn_1', ...over,
});
const fmt = (n: number) => String(n);

describe('rekap periods', () => {
  // 2026-10-19 is a Monday.
  const now = new Date(2026, 9, 21, 10, 0);
  it('computes today / week (Monday start) / month / year ranges', () => {
    expect(periodRange('today', now)).toEqual(['2026-10-21', '2026-10-21']);
    expect(periodRange('week', now)).toEqual(['2026-10-19', '2026-10-21']);
    expect(periodRange('month', now)).toEqual(['2026-10-01', '2026-10-21']);
    expect(periodRange('year', now)).toEqual(['2026-01-01', '2026-10-21']);
    expect(periodRange('all', now)).toEqual(['', '']);
    expect(periodRange('week', new Date(2026, 9, 25))).toEqual(['2026-10-19', '2026-10-25']); // Sunday
  });

  it('finds the previous same-length window and the change against it', () => {
    expect(previousRange('2026-10-01', '2026-10-21')).toEqual(['2026-09-10', '2026-09-30']);
    expect(previousRange('', '')).toBeUndefined();
    expect(deltaPct(150, 100)).toBe(50);
    expect(deltaPct(5, 0)).toBeUndefined();
  });
});

describe('rekap series', () => {
  const rows = [p({ date: '2026-10-19', shift: 1, nominal: 10 }), p({ date: '2026-10-19', shift: 3, nominal: 5 }), p({ date: '2026-08-02', nominal: 7 })];
  it('splits a single day by shift', () => {
    expect(seriesOf(rows, '2026-10-19', '2026-10-19', fmt).points.map((x) => x.value)).toEqual([10, 0, 5]);
  });
  it('uses days up to ~2 months (gaps kept) and months beyond', () => {
    const days = seriesOf(rows, '2026-10-17', '2026-10-19', fmt);
    expect(days.unit).toBe('day');
    expect(days.points.map((x) => [x.key, x.value])).toEqual([['2026-10-17', 0], ['2026-10-18', 0], ['2026-10-19', 15]]);
    const months = seriesOf(rows, '2026-01-01', '2026-10-19', fmt);
    expect(months.unit).toBe('month');
    expect(months.points).toHaveLength(10);
    expect(months.points.find((x) => x.key === '2026-08')?.value).toBe(7);
  });
});

describe('rekap filters', () => {
  it('searches No. RM by digits and text fields, and filters the rest', () => {
    expect(patientMatchesQuery(p({}), '123456')).toBe(true);
    expect(patientMatchesQuery(p({}), 'siti')).toBe(true);
    expect(patientMatchesQuery(p({}), '111111')).toBe(false);
    const rows = [p({ noRm: 'a', workflow: 'rajal', shift: 2 }), p({ noRm: 'b', date: '2026-09-01' })];
    expect(filterExceptCategory(rows, { ...EMPTY_REKAP_FILTER, workflow: 'rajal' }).map((x) => x.noRm)).toEqual(['a']);
    expect(filterExceptCategory(rows, { ...EMPTY_REKAP_FILTER, from: '2026-10-01' }).map((x) => x.noRm)).toEqual(['a']);
    expect(filterExceptCategory(rows, { ...EMPTY_REKAP_FILTER, shift: '2' }).map((x) => x.noRm)).toEqual(['a']);
  });

  it('totals and sorts', () => {
    const rows = [p({ noRm: 'a', nominal: 5, category: 'titipan', status: 'needs_review' }), p({ noRm: 'b', nominal: 9 })];
    expect(totalsOf(rows)).toEqual({ count: 2, nominal: 14, titipan: 1, naikKelas: 1, attention: 1 });
    expect(sortPatients(rows, 'nominal', 'desc').map((x) => x.noRm)).toEqual(['b', 'a']);
  });
});
