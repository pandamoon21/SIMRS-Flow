import { describe, expect, it } from 'vitest';
import type { RajalRecordRow } from '../types.js';
import { keepSelectedClinicPatients, rajalClinicCandidates, resolveRajalSep } from './sepClinic.js';

const visit = (trx: string, unit: string, matchedClinic?: string): RajalRecordRow => ({
  no_transaksi: trx,
  no_registrasikunjungan: `R${trx}`,
  kd_unit: '1',
  nama_unit: unit,
  patientId: '0-12-34-56',
  ...(matchedClinic ? { matchedClinic } : {}),
});

const sep = (no: string, poli: string, date = '2026-01-10', jenis = 'RJTL') => ({ no_sep: no, poli_tujuan: poli, tgl_sep: date, jns_pelayanan: jenis });

describe('resolveRajalSep', () => {
  const base = { date: '2026-01-10', clinic: 'MATA', candidates: rajalClinicCandidates('MATA'), clinics: ['MATA', 'PARU'] };

  it('takes the same-day RJTL SEP whose poli matches the clinic', () => {
    const rows = [sep('S0', 'MATA', '2026-01-09'), sep('S1', 'MATA', '2026-01-10 00:00:00'), sep('S2', 'PARU')];
    expect(resolveRajalSep({ ...base, rows, sameDayVisits: [visit('T1', 'POLI MATA', 'MATA')] })).toEqual({ kind: 'direct', noSep: 'S1' });
  });

  it('ignores a non-RJTL row and finds nothing for a single visit', () => {
    expect(resolveRajalSep({ ...base, rows: [sep('S1', 'MATA', '2026-01-10', 'RITL')], sameDayVisits: [visit('T1', 'POLI MATA')] })).toEqual({ kind: 'none' });
  });

  it('borrows one sibling-clinic SEP, and refuses two', () => {
    const day = [visit('T1', 'POLI MATA', 'MATA'), visit('T2', 'POLI PARU', 'PARU')];
    expect(resolveRajalSep({ ...base, rows: [sep('S2', 'PARU')], sameDayVisits: day })).toEqual({ kind: 'sibling', noSep: 'S2' });
    expect(resolveRajalSep({ ...base, rows: [sep('S2', 'PARU'), sep('S3', 'PARU')], sameDayVisits: day })).toEqual({ kind: 'ambiguous', candidates: ['S2', 'S3'] });
  });
});

describe('keepSelectedClinicPatients', () => {
  it('keeps patients seen under a selected poli and those the report never mapped', () => {
    const map = { A: ['PENYAKIT DALAM'], B: ['MATA'] };
    expect(keepSelectedClinicPatients(['A', 'B', 'C'], map, ['DALAM'])).toEqual(['A', 'C']);
    expect(keepSelectedClinicPatients(['A', 'B'], map, [])).toEqual(['A', 'B']);
  });
});
