import { describe, expect, it } from 'vitest';
import { fallbackPatients } from './patients.js';
import { fallbackBillingSummary } from './billing.js';
import { EMPTY_REKAP_FILTER, categoryCounts, filterExceptCategory, periodRange } from './rekapData.js';

describe('Rekapitulasi', () => {
  const now = new Date('2026-10-18T05:00:00.000Z');
  const { patients } = fallbackPatients(now);

  it('counts tabs inside the other active filters', () => {
    const all = categoryCounts(patients);
    expect(all.all).toBe(patients.length);
    expect(all.titipan + all.naik_kelas + all.normal).toBe(all.all);

    const date = patients[0]!.date;
    const scoped = categoryCounts(filterExceptCategory(patients, { ...EMPTY_REKAP_FILTER, from: date, to: date }));
    expect(scoped.all).toBe(patients.filter((p) => p.date === date).length);
    expect(scoped.all).toBeLessThan(all.all);
  });

  it('demo data spans a year, so week / month / year periods are populated', () => {
    for (const id of ['week', 'month', 'year'] as const) {
      const [from, to] = periodRange(id, now);
      expect(patients.some((p) => p.date >= from && p.date <= to)).toBe(true);
    }
  });

  it('marks placeholder data as demo so the page can say so', () => {
    expect(fallbackPatients(now).demo).toBe(true);
    expect(fallbackBillingSummary(now).demo).toBe(true);
  });
});
