import { describe, expect, it } from 'vitest';
import { evaluateRajalBillRules, unclassifiedPenunjangRows } from './treatment.js';

const rows = (...names: string[]) => names.map((nama_tindakan) => ({ nama_tindakan }));
const none = { include: [], exclude: [], groups: [], skipTreatments: [] };

describe('evaluateRajalBillRules', () => {
  it('passes every row when no rule is set', () => {
    expect(evaluateRajalBillRules('T1', rows('PENDAFTARAN PASIEN', 'BIAYA OBAT'), none)).toEqual({ ok: true, rows: rows('PENDAFTARAN PASIEN', 'BIAYA OBAT') });
  });

  it('applies skip list, groups, exclude, include and minimum in legacy order', () => {
    const bill = rows('PENDAFTARAN PASIEN', 'BIAYA OBAT', 'ODC');
    expect(evaluateRajalBillRules('T1', bill, { ...none, skipTreatments: ['odc'] })).toEqual({
      ok: false, severity: 'hard', reason: 'Excluded treatment found on T1: "odc" (found: "ODC")',
    });
    expect(evaluateRajalBillRules('T1', bill, { ...none, groups: [{ group: 'A', key: 'hd', name: 'HAEMODIALISA' }] })).toEqual({
      ok: false, severity: 'hard', reason: 'Required treatment group A unsatisfied on T1: none of "HAEMODIALISA" billed',
    });
    expect(evaluateRajalBillRules('T1', bill, { ...none, exclude: ['OBAT'] })).toEqual({
      ok: false, severity: 'hard', reason: 'Excluded treatment found on T1: BIAYA OBAT',
    });
    expect(evaluateRajalBillRules('T1', bill, { ...none, include: ['OBAT'], minCount: 2 })).toEqual({
      ok: false, severity: 'hard', reason: 'Only 1/3 treatment row(s) matched on T1; minimum 2',
    });
    expect(evaluateRajalBillRules('T1', bill, { ...none, include: ['RONTGEN'] })).toEqual({
      ok: false, severity: 'review', reason: 'Tidak ada tindakan yang cocok dengan aturan pada T1',
    });
    expect(evaluateRajalBillRules('T1', [], none)).toEqual({ ok: false, severity: 'review', reason: 'Tidak ada tindakan pada T1' });
  });

  it('flags penunjang-looking rows no guard classifies', () => {
    expect(unclassifiedPenunjangRows(rows('PENUNJANG LAIN', 'USG', 'BIAYA OBAT'))).toEqual(rows('PENUNJANG LAIN'));
  });
});
