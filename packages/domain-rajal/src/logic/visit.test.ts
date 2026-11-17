import { describe, expect, it } from 'vitest';
import { classifyRajalInstalasi, isRajalBillableCandidate, rajalEffectiveRange, recordVisitDate } from './visit.js';

describe('rajal visit verdicts', () => {
  it('uses the discovery period as the range when no explicit range is set', () => {
    expect(rajalEffectiveRange({ date: '2026-01-05' })).toEqual({ from: '2026-01-05', to: '2026-01-05' });
    expect(rajalEffectiveRange({ date: '2026-01-05', discovery: { from: '2026-01-01', to: '2026-01-03' } })).toEqual({ from: '2026-01-01', to: '2026-01-03' });
    expect(rajalEffectiveRange({ date: '2026-01-05', dateFrom: '2026-01-02', discovery: { from: '2026-01-01', to: '2026-01-03' } }).from).toBe('2026-01-02');
  });

  it('admits only unpaid, accepted-penjamin rows dated inside the range', () => {
    const range = { from: '2026-01-01', to: '2026-01-31' };
    const row = { status_bayar: 'Belum ', nama_penjamin: 'BPJS NON PBI', tgl_masuk: '2026-01-10 08:00:00' };
    expect(isRajalBillableCandidate(row, range, ['BPJS'])).toBe(true);
    expect(isRajalBillableCandidate({ ...row, status_bayar: 'Sudah' }, range, ['BPJS'])).toBe(false);
    expect(isRajalBillableCandidate({ ...row, nama_penjamin: 'UMUM' }, range, ['BPJS'])).toBe(false);
    expect(isRajalBillableCandidate({ ...row, tgl_masuk: '2026-02-01' }, range, ['BPJS'])).toBe(false);
    // An undated row never matches (fail closed).
    expect(isRajalBillableCandidate({ ...row, tgl_masuk: '' }, range, ['BPJS'])).toBe(false);
  });

  it('classifies the installation code', () => {
    expect(classifyRajalInstalasi('1')).toBe('rajal');
    expect(classifyRajalInstalasi(' 2 ')).toBe('inpatient');
    expect(classifyRajalInstalasi('3')).toBe('other');
    expect(classifyRajalInstalasi(undefined)).toBe('other');
  });

  it('falls back to the batch date for an undated visit', () => {
    expect(recordVisitDate({ tgl_masuk: '2026-01-10 08:00:00' }, '2026-01-01')).toBe('2026-01-10');
    expect(recordVisitDate({}, '2026-01-01')).toBe('2026-01-01');
  });
});
