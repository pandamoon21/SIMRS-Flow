import { describe, it, expect } from 'vitest';

import type { LegacyRow } from './types.js';
import {
  findExcludedTampungBayarCandidates,
  findPaidPaymentCandidates,
  findVerifiedPaymentCandidates,
  selectKunjunganPaymentCandidates,
} from './selection.js';

const TANGGAL = '2026-03-10';

/** The anchor: unpaid BPJS inpatient visit admitted on the target date. */
const ANCHOR: LegacyRow = {
  no_transaksi: '03-100326-000001',
  no_registrasikunjungan: 'R100',
  no_sep: 'SEP0001',
  nama_unit: 'MULTAZAM / KELAS 3',
  nama_penjamin: 'BPJS PBI',
  status_bayar: '',
  tgl_masuk: '2026-03-10 08:15:00',
};

const PAID_VISIT: LegacyRow = {
  no_transaksi: '03-100326-000002',
  no_registrasikunjungan: 'R200',
  nama_unit: 'AL KAUTSAR / KELAS 2',
  nama_penjamin: 'BPJS NON PBI',
  status_bayar: 'SUDAH BAYAR',
  tgl_masuk: '2026-03-10',
};

const NON_BPJS_VISIT: LegacyRow = {
  no_transaksi: '03-100326-000003',
  no_registrasikunjungan: 'R300',
  nama_unit: 'AL KAUTSAR / KELAS 2',
  nama_penjamin: 'UMUM',
  status_bayar: '',
  tgl_masuk: '2026-03-10',
};

const OUT_OF_TOLERANCE_VISIT: LegacyRow = {
  no_transaksi: '03-010326-000004',
  no_registrasikunjungan: 'R400',
  nama_unit: 'MULTAZAM / KELAS 3',
  nama_penjamin: 'BPJS PBI',
  status_bayar: '',
  tgl_masuk: '2026-03-01',
};

/** Another admission of the same patient — must not be merged in. */
const OTHER_EPISODE: LegacyRow = {
  no_transaksi: '03-080326-000005',
  no_registrasikunjungan: 'R500',
  no_sep: 'SEP0500',
  nama_unit: 'AL KAUTSAR / KELAS 2',
  nama_penjamin: 'BPJS PBI',
  status_bayar: '',
  tgl_masuk: '2026-03-08',
};

const DEPO_SAME_REG: LegacyRow = {
  no_transaksi: '04-100326-000010',
  no_registrasikunjungan: 'R100',
  nama_unit: 'DEPO FARMASI RANAP',
  nama_penjamin: 'BPJS PBI',
  status_bayar: '',
  tgl_masuk: '2026-03-11',
};

const RAWAT_JALAN_SAME_REG: LegacyRow = {
  no_transaksi: '01-100326-000020',
  no_registrasikunjungan: 'R100',
  nama_unit: 'POLIKLINIK ANAK',
  nama_penjamin: 'BPJS PBI',
  status_bayar: '',
  tgl_masuk: '2026-03-10',
};

const FOLLOWUP_IN_WINDOW: LegacyRow = {
  no_transaksi: '13-110326-000030',
  no_registrasikunjungan: 'R900',
  nama_unit: 'LABORATORIUM PK',
  nama_penjamin: 'BPJS PBI',
  status_bayar: '',
  tgl_masuk: '2026-03-11',
};

const FOLLOWUP_OUT_OF_WINDOW: LegacyRow = {
  no_transaksi: '13-200326-000031',
  no_registrasikunjungan: 'R901',
  nama_unit: 'LABORATORIUM PK',
  nama_penjamin: 'BPJS PBI',
  status_bayar: '',
  tgl_masuk: '2026-03-20',
};

const ALL_ROWS: readonly LegacyRow[] = [
  ANCHOR,
  PAID_VISIT,
  NON_BPJS_VISIT,
  OUT_OF_TOLERANCE_VISIT,
  OTHER_EPISODE,
  DEPO_SAME_REG,
  RAWAT_JALAN_SAME_REG,
  FOLLOWUP_IN_WINDOW,
  FOLLOWUP_OUT_OF_WINDOW,
];

function trxOf(rows: readonly LegacyRow[]): string[] {
  return rows.map((row) => String(row['no_transaksi']));
}

describe('selectKunjunganPaymentCandidates', () => {
  it('accepts the valid episode and rejects paid / non-BPJS / out-of-tolerance rows', () => {
    const selected = selectKunjunganPaymentCandidates({
      rows: ALL_ROWS,
      tanggal: TANGGAL,
      toleranceDays: 3,
    });

    // Original row order is preserved.
    expect(trxOf(selected)).toEqual([
      '03-100326-000001', // anchor
      '04-100326-000010', // depo, same reg
      '13-110326-000030', // lab followup inside the group window
    ]);
    expect(trxOf(selected)).not.toContain('03-100326-000002'); // already paid
    expect(trxOf(selected)).not.toContain('03-100326-000003'); // UMUM
    expect(trxOf(selected)).not.toContain('03-010326-000004'); // 9 days away
    expect(trxOf(selected)).not.toContain('03-080326-000005'); // other episode
    expect(trxOf(selected)).not.toContain('01-100326-000020'); // rawat jalan
    expect(trxOf(selected)).not.toContain('13-200326-000031'); // outside the window
  });

  it('returns nothing when no inpatient row is near the target date', () => {
    expect(
      selectKunjunganPaymentCandidates({
        rows: [OUT_OF_TOLERANCE_VISIT, DEPO_SAME_REG, FOLLOWUP_IN_WINDOW],
        tanggal: TANGGAL,
        toleranceDays: 3,
      }),
    ).toEqual([]);
  });

  it('returns nothing when the target date is unparseable', () => {
    expect(
      selectKunjunganPaymentCandidates({ rows: ALL_ROWS, tanggal: 'kemarin', toleranceDays: 3 }),
    ).toEqual([]);
  });

  it('anchors on the newest inpatient row and keeps only its SEP', () => {
    const olderSameSep: LegacyRow = {
      no_transaksi: '03-090326-000009',
      no_registrasikunjungan: 'R101',
      no_sep: 'SEP0001',
      nama_unit: 'MULTAZAM / KELAS 3',
      nama_penjamin: 'BPJS PBI',
      status_bayar: '',
      tgl_masuk: '2026-03-09',
    };
    const selected = selectKunjunganPaymentCandidates({
      rows: [OTHER_EPISODE, olderSameSep, ANCHOR],
      tanggal: TANGGAL,
      toleranceDays: 3,
    });
    expect(trxOf(selected)).toEqual(['03-090326-000009', '03-100326-000001']);
  });

  it('joins two inpatient rows that share only the admission date', () => {
    const sameDateNoSep: LegacyRow = {
      no_transaksi: '03-100326-000006',
      no_registrasikunjungan: 'R600',
      nama_unit: 'SCN / KELAS 3',
      nama_penjamin: 'BPJS PBI',
      status_bayar: '',
      tgl_masuk: '2026-03-10',
    };
    const selected = selectKunjunganPaymentCandidates({
      rows: [ANCHOR, sameDateNoSep],
      tanggal: TANGGAL,
      toleranceDays: 3,
    });
    expect(trxOf(selected)).toEqual(['03-100326-000001', '03-100326-000006']);
  });

  it('pulls a related row in through the anchor SEP when its reg differs', () => {
    const sameSepOtherReg: LegacyRow = {
      no_transaksi: '19-100326-000040',
      no_registrasikunjungan: 'R700',
      no_sep: 'SEP0001',
      nama_unit: 'INSTALASI BEDAH SENTRAL',
      nama_penjamin: 'BPJS PBI',
      status_bayar: 'BELUM',
      tgl_masuk: '2026-04-30',
    };
    const selected = selectKunjunganPaymentCandidates({
      rows: [ANCHOR, sameSepOtherReg],
      tanggal: TANGGAL,
      toleranceDays: 3,
    });
    expect(trxOf(selected)).toEqual(['03-100326-000001', '19-100326-000040']);
  });

  it('clamps the tolerance to 7 days', () => {
    const eightDaysLate: LegacyRow = { ...ANCHOR, tgl_masuk: '2026-03-18' };
    const sevenDaysLate: LegacyRow = { ...ANCHOR, tgl_masuk: '2026-03-17' };
    expect(
      selectKunjunganPaymentCandidates({ rows: [eightDaysLate], tanggal: TANGGAL, toleranceDays: 30 }),
    ).toEqual([]);
    expect(
      selectKunjunganPaymentCandidates({ rows: [sevenDaysLate], tanggal: TANGGAL, toleranceDays: 30 }),
    ).toHaveLength(1);
  });

  it('accepts every payer when the keyword list is empty', () => {
    const selected = selectKunjunganPaymentCandidates({
      rows: [NON_BPJS_VISIT],
      tanggal: TANGGAL,
      toleranceDays: 3,
      acceptedPenjaminKeywords: [],
    });
    expect(trxOf(selected)).toEqual(['03-100326-000003']);
  });

  it('uses the injected SEP resolver in place of the legacy lookup calls', () => {
    const noSepAnchor: LegacyRow = { ...ANCHOR, no_sep: '' };
    const otherRegSameSep: LegacyRow = {
      no_transaksi: '18-100326-000050',
      no_registrasikunjungan: 'R800',
      nama_unit: 'INSTALASI GIZI',
      nama_penjamin: 'BPJS PBI',
      status_bayar: '',
      tgl_masuk: '2026-05-30',
    };
    const seenNoRm: string[] = [];
    const selected = selectKunjunganPaymentCandidates({
      rows: [noSepAnchor, otherRegSameSep],
      tanggal: TANGGAL,
      toleranceDays: 3,
      noRm: '0123456',
      resolveSepKey: (_row, noRm) => {
        seenNoRm.push(noRm);
        return 'SEP-FETCHED';
      },
    });
    expect(trxOf(selected)).toEqual(['03-100326-000001', '18-100326-000050']);
    expect(new Set(seenNoRm)).toEqual(new Set(['0123456']));
  });
});

describe('findVerifiedPaymentCandidates', () => {
  it('flags a verified visit with its marker fields and skips unverified ones', () => {
    const statuses: Record<string, string> = {
      '03-100326-000001': '1',
      '03-100326-000002': '0',
      '03-100326-000003': '',
    };
    const verified = findVerifiedPaymentCandidates(
      [ANCHOR, PAID_VISIT, NON_BPJS_VISIT],
      (trx) => statuses[trx] ?? '',
    );
    expect(verified).toHaveLength(1);
    expect(verified[0]?.['no_transaksi']).toBe('03-100326-000001');
    expect(verified[0]?.['_status_verifikasi_kasir']).toBe('1');
    expect(verified[0]?.['_is_premium_room_guard']).toBe(false);
  });

  it('marks a premium room and only asks about each transaction once', () => {
    const calls: string[] = [];
    const premium: LegacyRow = { ...ANCHOR, nama_unit: 'MULTAZAM PLATINUM' };
    const verified = findVerifiedPaymentCandidates([premium, { ...premium }], (trx) => {
      calls.push(trx);
      return 'VERIFIED';
    });
    expect(calls).toEqual(['03-100326-000001']);
    expect(verified).toHaveLength(1);
    expect(verified[0]?.['_is_premium_room_guard']).toBe(true);
  });

  it('ignores rows without a transaction number', () => {
    expect(findVerifiedPaymentCandidates([{ no_transaksi: '' }], () => '1')).toEqual([]);
  });
});

describe('findPaidPaymentCandidates', () => {
  it('attaches the receipt count and the last kwitansi', () => {
    const paid = findPaidPaymentCandidates([ANCHOR, DEPO_SAME_REG], (row) =>
      row['no_transaksi'] === '03-100326-000001'
        ? [{ no_kwitansi: 'KW-1' }, { no_kwitansi: 'KW-2' }]
        : [],
    );
    expect(paid).toHaveLength(1);
    expect(paid[0]?.['_payment_history_count']).toBe(2);
    expect(paid[0]?.['_last_kwitansi']).toBe('KW-2');
    expect(paid[0]?.['_is_premium_room_guard']).toBe(false);
  });

  it('needs both a transaction and a registration number', () => {
    expect(
      findPaidPaymentCandidates([{ no_transaksi: '03-1', no_registrasikunjungan: '' }], () => [
        { no_kwitansi: 'KW-1' },
      ]),
    ).toEqual([]);
  });
});

describe('findExcludedTampungBayarCandidates', () => {
  const roomRows: readonly LegacyRow[] = [{ no_registrasikunjungan: 'R100' }];

  it('blocks ambulance and kamar-jenazah rows inside the group registrations', () => {
    const ambulance: LegacyRow = {
      no_transaksi: '51-100326-000060',
      no_registrasikunjungan: 'R100',
      nama_unit: 'AMBULANCE',
    };
    const jenazah: LegacyRow = {
      no_transaksi: '52-100326-000061',
      no_registrasikunjungan: 'R100',
      nama_unit: 'INSTALASI KAMAR JENAZAH',
    };
    const blocked = findExcludedTampungBayarCandidates(
      [ANCHOR, ambulance, { ...ambulance }, jenazah],
      roomRows,
    );
    expect(trxOf(blocked)).toEqual(['51-100326-000060', '52-100326-000061']);
  });

  it('ignores an excluded unit from another registration', () => {
    const otherReg: LegacyRow = {
      no_transaksi: '51-100326-000062',
      no_registrasikunjungan: 'R999',
      nama_unit: 'AMBULANCE',
    };
    expect(findExcludedTampungBayarCandidates([otherReg], roomRows)).toEqual([]);
  });

  it('returns nothing when the group has no registration', () => {
    expect(findExcludedTampungBayarCandidates([ANCHOR], [])).toEqual([]);
  });
});
