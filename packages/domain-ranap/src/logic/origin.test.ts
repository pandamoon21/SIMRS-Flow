/**
 * Patient-origin detection — behaviour pinned against `ranap_v3.py`.
 *
 * These scenarios decide whether the emergency-room or outpatient-clinic
 * charges get pulled into an inpatient bill: a group whose own charges prove
 * clinic entry, one that proves emergency entry, one carrying a hemodialysis
 * signal, and a newborn (BYNY) whose origin is deliberately not checked.
 */

import { describe, it, expect } from 'vitest';

import type { LegacyRow } from './types.js';
import { isBynyPatient } from './names.js';
import {
  buildSkippedOriginInfo,
  deriveIgdSourceSignal,
  detectGroupOriginFromRows,
  extractSepKeysFromRoomRows,
  resolveKunjunganSepKey,
} from './origin.js';

const NO_RM = '0-12-34-56';
const INAP_TRX = '03-2601040001';
const INAP_REG = 'RG2601040001';
const INAP_SEP = '1301R0010126V000111';
const DOCTOR = 'D0099';

const POLI_TRX = '01-2601040007';
const POLI_REG = 'RG2601040007';
const IGD_TRX = '02-2601040012';
const IGD_REG = 'RG2601040012';

/** An inpatient room row as `getlistkamar` returns it. */
function roomRow(overrides: LegacyRow = {}): LegacyRow {
  return {
    no_transaksi: INAP_TRX,
    no_registrasikunjungan: INAP_REG,
    kd_unit: 'RI01',
    nama_unit: 'MULTAZAM 1',
    nama_pasien: 'PASIEN DUA',
    nama_penjamin: 'BPJS NON PBI',
    tgl_masuk: '2026-01-04 14:20:00',
    kd_kamarperawatan: 'K-101',
    no_sjp: INAP_SEP,
    status_bayar: 'BELUM',
    ...overrides,
  };
}

/** The inpatient visit detail (`penatajasa_inap.getdatakunjungan`), keyed by trx. */
const DATA_KUNJUNGAN_BY_TRX: Readonly<Record<string, LegacyRow>> = {
  [INAP_TRX]: { no_sjp: INAP_SEP, kd_paramedis: DOCTOR, tgl_masuk: '2026-01-04 14:20:00' },
};

function poliVisit(overrides: LegacyRow = {}): LegacyRow {
  return {
    no_transaksi: POLI_TRX,
    no_registrasikunjungan: POLI_REG,
    nama_unit: 'POLIKLINIK PENYAKIT DALAM',
    nama_penjamin: 'BPJS NON PBI',
    tgl_masuk: '2026-01-04 09:10:00',
    status_bayar: 'BELUM',
    ...overrides,
  };
}

function igdVisit(overrides: LegacyRow = {}): LegacyRow {
  return {
    no_transaksi: IGD_TRX,
    no_registrasikunjungan: IGD_REG,
    nama_unit: 'IGD',
    nama_penjamin: 'BPJS NON PBI',
    tgl_masuk: '2026-01-04 05:00:00',
    status_bayar: 'BELUM',
    ...overrides,
  };
}

describe('buildSkippedOriginInfo', () => {
  it('skips origin detection for a BYNY (newborn) patient', () => {
    const patientName = 'BYNY PASIEN DUA';
    expect(isBynyPatient(patientName)).toBe(true);

    const info = buildSkippedOriginInfo({
      reason: 'pasien BYNY dapat berasal langsung, jadi origin asal tidak dicek',
      inferredType: 'langsung_byny',
    });
    expect(info.skipOriginCheck).toBe(true);
    expect(info.requiresPoliSource).toBe(false);
    expect(info.requiresIgdSource).toBe(false);
    expect(info.skipReason).toBe(
      'pasien BYNY dapat berasal langsung, jadi origin asal tidak dicek',
    );
    expect(info.inferredOrigin?.type).toBe('langsung_byny');
    expect(info.inferredOrigin?.reason).toBe(info.skipReason);
  });

  it('defaults the inferred type to "skip"', () => {
    const info = buildSkippedOriginInfo();
    expect(info.inferredOrigin?.type).toBe('skip');
    expect(info.skipReason).toBe('');
  });
});

describe('resolveKunjunganSepKey', () => {
  it('uses the row own SEP when it has one', () => {
    expect(resolveKunjunganSepKey({ no_sep: INAP_SEP }, NO_RM)).toBe(INAP_SEP);
  });

  it('falls back to the kasir transaction, then the inpatient visit', () => {
    const row = { no_transaksi: INAP_TRX, no_registrasikunjungan: INAP_REG, kd_unit: 'RI01' };
    expect(
      resolveKunjunganSepKey(row, NO_RM, { dataTransaksi: { no_sep: INAP_SEP } }),
    ).toBe(INAP_SEP);
    expect(
      resolveKunjunganSepKey(row, NO_RM, { dataKunjungan: { no_sep: INAP_SEP } }),
    ).toBe(INAP_SEP);
  });

  it('returns empty without a medical-record number or a SEP anywhere', () => {
    const row = { no_transaksi: INAP_TRX, no_registrasikunjungan: INAP_REG, kd_unit: 'RI01' };
    expect(resolveKunjunganSepKey(row, '', { dataTransaksi: { no_sep: INAP_SEP } })).toBe('');
    expect(resolveKunjunganSepKey(row, NO_RM)).toBe('');
  });
});

describe('extractSepKeysFromRoomRows', () => {
  it('collects and de-duplicates every SEP the group can be tied to', () => {
    const keys = extractSepKeysFromRoomRows(
      [roomRow(), roomRow({ no_transaksi: '03-2601060002', no_sjp: '', no_sep: INAP_SEP })],
      NO_RM,
      { ...DATA_KUNJUNGAN_BY_TRX, '03-2601060002': { no_sep: '1301R0010126V000112' } },
    );
    expect(keys).toEqual([INAP_SEP, '1301R0010126V000112']);
  });

  it('ignores the hoisted visit detail when there is no medical-record number', () => {
    expect(extractSepKeysFromRoomRows([roomRow({ no_sjp: '' })], '', DATA_KUNJUNGAN_BY_TRX)).toEqual(
      [],
    );
  });
});

describe('deriveIgdSourceSignal', () => {
  it('flags hemodialysis charges and de-duplicates the names', () => {
    const signal = deriveIgdSourceSignal([
      { nama_tindakan: 'BIAYA HEMODIALISA CITO' },
      { nama_tindakan: 'BIAYA HEMODIALISA CITO' },
      { nama_tindakan: 'BIAYA UGD DEWASA' },
      { nama_tindakan: '' },
    ]);
    expect(signal.hasHemodialisaSignal).toBe(true);
    expect(signal.matchedNames).toEqual(['BIAYA HEMODIALISA CITO']);
  });

  it('reports no signal for an ordinary IGD charge list', () => {
    expect(deriveIgdSourceSignal([{ nama_tindakan: 'BIAYA UGD DEWASA' }])).toEqual({
      hasHemodialisaSignal: false,
      matchedNames: [],
    });
  });
});

describe('detectGroupOriginFromRows — evidence in the inpatient charges', () => {
  it('treats a BIAYA POLIKLINIK line as proof of clinic entry', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: [
        { nama_tindakan: 'BIAYA KAMAR MULTAZAM 1' },
        { nama_tindakan: 'BIAYA POLIKLINIK PENYAKIT DALAM' },
      ],
    });
    expect(info.requiresPoliSource).toBe(true);
    expect(info.requiresIgdSource).toBe(false);
    expect(info.skipOriginCheck).toBe(false);
    expect(info.inferredOrigin).toBeUndefined();
  });

  it('treats a BIAYA UGD line as proof of emergency entry', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: [{ nama_tindakan: 'BIAYA UGD DEWASA' }],
    });
    expect(info.requiresIgdSource).toBe(true);
    expect(info.requiresPoliSource).toBe(false);
  });

  it('treats a hemodialysis line as proof of emergency entry', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: [{ nama_tindakan: 'BIAYA HAEMODIALISA CITO' }],
    });
    expect(info.requiresIgdSource).toBe(true);
  });

  it('requires nothing when the charge list is silent and there is no history', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: [{ nama_tindakan: 'BIAYA KAMAR MULTAZAM 1' }],
    });
    expect(info.requiresPoliSource).toBe(false);
    expect(info.requiresIgdSource).toBe(false);
    expect(info.inferredOrigin).toBeUndefined();
  });

  it('never runs the history scan once the charges already answered', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: [{ nama_tindakan: 'BIAYA POLIKLINIK ANAK' }],
      noRm: NO_RM,
      kunjunganRows: [roomRow(), igdVisit()],
      dataKunjunganByTrx: DATA_KUNJUNGAN_BY_TRX,
      igdSignalByTrx: { [IGD_TRX]: { hasHemodialisaSignal: true, matchedNames: ['BIAYA HEMODIALISA'] } },
    });
    expect(info.requiresPoliSource).toBe(true);
    expect(info.requiresIgdSource).toBe(false);
    expect(info.inferredOrigin).toBeUndefined();
  });
});

describe('detectGroupOriginFromRows — history fallback', () => {
  const silentCharges: readonly LegacyRow[] = [{ nama_tindakan: 'BIAYA KAMAR MULTAZAM 1' }];

  it('infers clinic entry from a same-day visit sharing the SEP and the doctor', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: silentCharges,
      noRm: NO_RM,
      kunjunganRows: [roomRow(), poliVisit()],
      dataKunjunganByTrx: DATA_KUNJUNGAN_BY_TRX,
      poliDetailByTrx: { [POLI_TRX]: { no_sjp: INAP_SEP, kd_paramedis: DOCTOR } },
    });
    expect(info.requiresPoliSource).toBe(true);
    expect(info.requiresIgdSource).toBe(false);
    expect(info.inferredOrigin).toMatchObject({
      type: 'poli',
      trx: POLI_TRX,
      reg: POLI_REG,
      unit: 'POLIKLINIK PENYAKIT DALAM',
      sepMatch: true,
      doctorMatch: true,
      exactDate: true,
      unpaidHint: true,
      hasHemodialisaSignal: false,
      diffDays: 0,
    });
  });

  it('infers emergency entry and carries the hemodialysis signal through', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: silentCharges,
      noRm: NO_RM,
      kunjunganRows: [roomRow(), igdVisit()],
      dataKunjunganByTrx: DATA_KUNJUNGAN_BY_TRX,
      poliDetailByTrx: {},
      igdSignalByTrx: {
        [IGD_TRX]: deriveIgdSourceSignal([
          { nama_tindakan: 'BIAYA HEMODIALISA CITO' },
          { nama_tindakan: 'BIAYA UGD DEWASA' },
        ]),
      },
    });
    expect(info.requiresIgdSource).toBe(true);
    expect(info.requiresPoliSource).toBe(false);
    expect(info.inferredOrigin).toMatchObject({
      type: 'igd',
      trx: IGD_TRX,
      reg: IGD_REG,
      sepMatch: false,
      doctorMatch: false,
      exactDate: true,
      hasHemodialisaSignal: true,
      matchedNames: ['BIAYA HEMODIALISA CITO'],
    });
  });

  it('ranks a SEP match above a doctor + same-day clinic visit', () => {
    const igdSepOnly = igdVisit({
      no_transaksi: '02-2601030004',
      no_registrasikunjungan: 'RG2601030004',
      tgl_masuk: '2026-01-03 22:40:00',
    });
    const poliDoctorOnly = poliVisit({
      no_transaksi: '01-2601040008',
      no_registrasikunjungan: 'RG2601040008',
      nama_unit: 'POLIKLINIK ANAK',
      tgl_masuk: '2026-01-04 08:00:00',
    });
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: silentCharges,
      noRm: NO_RM,
      kunjunganRows: [roomRow(), poliDoctorOnly, igdSepOnly],
      dataKunjunganByTrx: DATA_KUNJUNGAN_BY_TRX,
      poliDetailByTrx: {
        '02-2601030004': { no_sjp: INAP_SEP },
        '01-2601040008': { kd_paramedis: DOCTOR },
      },
    });
    expect(info.inferredOrigin).toMatchObject({
      type: 'igd',
      trx: '02-2601030004',
      sepMatch: true,
      doctorMatch: false,
      exactDate: false,
      diffDays: -1,
    });
    expect(info.requiresIgdSource).toBe(true);
    expect(info.requiresPoliSource).toBe(false);
  });

  it('anchors the reference date on the earliest room row', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow({ no_transaksi: '03-2601060002', tgl_masuk: '2026-01-06 10:00:00' }), roomRow()],
      listTindakanRows: silentCharges,
      noRm: NO_RM,
      // Only the 2026-01-04 admission date makes this visit an exact-date match;
      // anchoring on 2026-01-06 would leave it with no signal at all.
      kunjunganRows: [poliVisit()],
      dataKunjunganByTrx: DATA_KUNJUNGAN_BY_TRX,
      poliDetailByTrx: {},
    });
    expect(info.inferredOrigin).toMatchObject({ type: 'poli', exactDate: true, diffDays: 0 });
    expect(info.requiresPoliSource).toBe(true);
  });

  it('recognises IGD from the unit name when the transaction prefix is unusual', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: silentCharges,
      noRm: NO_RM,
      kunjunganRows: [
        igdVisit({
          no_transaksi: '04-2601040020',
          no_registrasikunjungan: 'RG2601040020',
          nama_unit: 'IGD Lantai 1',
        }),
      ],
      dataKunjunganByTrx: DATA_KUNJUNGAN_BY_TRX,
      poliDetailByTrx: { '04-2601040020': { no_sjp: INAP_SEP } },
    });
    expect(info.inferredOrigin).toMatchObject({ type: 'igd', trx: '04-2601040020', sepMatch: true });
    expect(info.requiresIgdSource).toBe(true);
  });

  it('rejects a visit with no SEP, doctor or same-day signal', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: silentCharges,
      noRm: NO_RM,
      kunjunganRows: [
        poliVisit({
          no_transaksi: '01-2601020003',
          no_registrasikunjungan: 'RG2601020003',
          nama_unit: 'POLIKLINIK GIGI',
          tgl_masuk: '2026-01-02 10:00:00',
        }),
      ],
      dataKunjunganByTrx: DATA_KUNJUNGAN_BY_TRX,
      poliDetailByTrx: {
        '01-2601020003': { no_sjp: '1301R0110126V000999', kd_paramedis: 'D0501' },
      },
    });
    expect(info.inferredOrigin).toBeUndefined();
    expect(info.requiresPoliSource).toBe(false);
    expect(info.requiresIgdSource).toBe(false);
  });

  it('rejects a visit that postdates the admission even with a matching SEP', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: silentCharges,
      noRm: NO_RM,
      kunjunganRows: [poliVisit({ tgl_masuk: '2026-01-05 09:00:00' })],
      dataKunjunganByTrx: DATA_KUNJUNGAN_BY_TRX,
      poliDetailByTrx: { [POLI_TRX]: { no_sjp: INAP_SEP, kd_paramedis: DOCTOR } },
    });
    expect(info.inferredOrigin).toBeUndefined();
    expect(info.requiresPoliSource).toBe(false);
  });

  it('rejects a visit older than the tolerance window', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: silentCharges,
      noRm: NO_RM,
      kunjunganRows: [poliVisit({ tgl_masuk: '2025-12-20 09:00:00' })],
      dataKunjunganByTrx: DATA_KUNJUNGAN_BY_TRX,
      poliDetailByTrx: { [POLI_TRX]: { no_sjp: INAP_SEP, kd_paramedis: DOCTOR } },
      toleranceDays: 7,
    });
    expect(info.inferredOrigin).toBeUndefined();
  });

  it('does not scan the history without a medical-record number', () => {
    const info = detectGroupOriginFromRows({
      roomRows: [roomRow()],
      listTindakanRows: silentCharges,
      kunjunganRows: [roomRow(), poliVisit()],
      dataKunjunganByTrx: DATA_KUNJUNGAN_BY_TRX,
      poliDetailByTrx: { [POLI_TRX]: { no_sjp: INAP_SEP, kd_paramedis: DOCTOR } },
    });
    expect(info.inferredOrigin).toBeUndefined();
    expect(info.requiresPoliSource).toBe(false);
  });
});
