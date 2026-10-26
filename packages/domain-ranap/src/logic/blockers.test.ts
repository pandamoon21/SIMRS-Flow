import { describe, it, expect } from 'vitest';

import type { LegacyRow } from './types.js';
import {
  checkMissingIgdDepoOrObatForVerification,
  collectBankDarahBlockers,
  collectCathlabBlockers,
  collectNamedManualUnitBlockers,
  findHangingRelatedTransactions,
  isGiziPenunjangBlocker,
  normalizePenunjangBlocker,
  penunjangBlockerLabel,
} from './blockers.js';

/** One room stay: 10 Mar → 12 Mar 2026, registration R100. */
const ROOM_ROWS: readonly LegacyRow[] = [
  {
    no_transaksi: '03-100326-000001',
    no_registrasikunjungan: 'R100',
    kd_kamarperawatan: 'K1',
    nama_unit: 'MULTAZAM / KELAS 3',
    tgl_masuk: '2026-03-10 08:00:00',
    tgl_keluar: '2026-03-12 10:00:00',
  },
];

const BANK_DARAH_SAME_REG: LegacyRow = {
  no_transaksi: '54-100326-000010',
  no_registrasikunjungan: 'R100',
  nama_unit: 'BANK DARAH',
  status_bayar: '',
  tgl_masuk: '2026-03-11',
};

const BANK_DARAH_OTHER_REG_IN_WINDOW: LegacyRow = {
  no_transaksi: '54-090326-000011',
  no_registrasikunjungan: 'R555',
  nama_unit: 'UNIT BANK DARAH RSU',
  status_bayar: 'BELUM',
  tgl_masuk: '2026-03-09',
};

const BANK_DARAH_OTHER_REG_OUT_OF_WINDOW: LegacyRow = {
  no_transaksi: '54-010326-000012',
  no_registrasikunjungan: 'R556',
  nama_unit: 'BANK DARAH',
  status_bayar: '',
  tgl_masuk: '2026-03-01',
};

const BANK_DARAH_PAID: LegacyRow = {
  no_transaksi: '54-110326-000013',
  no_registrasikunjungan: 'R100',
  nama_unit: 'BANK DARAH',
  status_bayar: 'SUDAH BAYAR',
  tgl_masuk: '2026-03-11',
};

const CATHLAB_ROW: LegacyRow = {
  no_transaksi: '55-110326-000020',
  no_registrasikunjungan: 'R100',
  nama_unit: 'CATHLAB',
  status_bayar: '',
  tgl_masuk: '2026-03-11',
};

function trxOf(rows: readonly LegacyRow[]): string[] {
  return rows.map((row) => String(row['no_transaksi']));
}

describe('collectBankDarahBlockers', () => {
  const kunjunganRows: readonly LegacyRow[] = [
    BANK_DARAH_SAME_REG,
    BANK_DARAH_OTHER_REG_IN_WINDOW,
    BANK_DARAH_OTHER_REG_OUT_OF_WINDOW,
    BANK_DARAH_PAID,
    CATHLAB_ROW,
  ];

  it('finds the unpaid blood-bank rows of this stay and of the group window', () => {
    const blockers = collectBankDarahBlockers({ kunjunganRows, roomRows: ROOM_ROWS });
    expect(trxOf(blockers)).toEqual(['54-100326-000010', '54-090326-000011']);
  });

  it('uses the Rules-page keywords when given; an empty list disables the blocker', () => {
    expect(trxOf(collectBankDarahBlockers({ kunjunganRows, roomRows: ROOM_ROWS, unitKeywords: ['cathlab'] })))
      .toEqual(trxOf(collectCathlabBlockers({ kunjunganRows, roomRows: ROOM_ROWS })));
    expect(collectBankDarahBlockers({ kunjunganRows, roomRows: ROOM_ROWS, unitKeywords: [] })).toEqual([]);
  });

  it('skips a transaction the pipeline already handled', () => {
    const blockers = collectBankDarahBlockers({
      kunjunganRows,
      roomRows: ROOM_ROWS,
      handledTransactions: new Set(['54-100326-000010', '54-090326-000011']),
    });
    expect(blockers).toEqual([]);
  });

  it('tightens the other-registration window with the tolerance', () => {
    const blockers = collectBankDarahBlockers({
      kunjunganRows,
      roomRows: ROOM_ROWS,
      toleranceDays: 0,
    });
    // Only the row on this stay's own registration survives a zero tolerance.
    expect(trxOf(blockers)).toEqual(['54-100326-000010']);
  });

  it('returns nothing without room rows or without dated room rows', () => {
    expect(collectBankDarahBlockers({ kunjunganRows, roomRows: [] })).toEqual([]);
    expect(
      collectBankDarahBlockers({
        kunjunganRows,
        roomRows: [{ no_registrasikunjungan: 'R100' }],
      }),
    ).toEqual([]);
  });

  it('de-duplicates on transaction, registration and unit', () => {
    const blockers = collectBankDarahBlockers({
      kunjunganRows: [BANK_DARAH_SAME_REG, { ...BANK_DARAH_SAME_REG }],
      roomRows: ROOM_ROWS,
    });
    expect(blockers).toHaveLength(1);
  });
});

describe('collectCathlabBlockers', () => {
  it('finds only the cathlab row', () => {
    const blockers = collectCathlabBlockers({
      kunjunganRows: [BANK_DARAH_SAME_REG, CATHLAB_ROW],
      roomRows: ROOM_ROWS,
    });
    expect(trxOf(blockers)).toEqual(['55-110326-000020']);
  });

  it('needs at least one keyword', () => {
    expect(
      collectNamedManualUnitBlockers({
        kunjunganRows: [CATHLAB_ROW],
        roomRows: ROOM_ROWS,
        unitKeywords: ['   '],
      }),
    ).toEqual([]);
  });
});

describe('findHangingRelatedTransactions', () => {
  const roomRowsByReg = { R100: ROOM_ROWS };

  it('collects same-registration rows plus dated follow-ups in the window', () => {
    const sameReg: LegacyRow = {
      no_transaksi: '03-100326-000001',
      no_registrasikunjungan: 'R100',
      nama_unit: 'MULTAZAM / KELAS 3',
      status_bayar: '',
      tgl_masuk: '2026-03-10',
    };
    const labInWindow: LegacyRow = {
      no_transaksi: '13-110326-000030',
      no_registrasikunjungan: 'R900',
      nama_unit: 'LABORATORIUM PK',
      status_bayar: '',
      tgl_masuk: '2026-03-11',
    };
    const labOutOfWindow: LegacyRow = {
      no_transaksi: '13-250326-000031',
      no_registrasikunjungan: 'R901',
      nama_unit: 'LABORATORIUM PK',
      status_bayar: '',
      tgl_masuk: '2026-03-25',
    };
    const poliNotFollowup: LegacyRow = {
      no_transaksi: '01-110326-000032',
      no_registrasikunjungan: 'R902',
      nama_unit: 'POLIKLINIK BEDAH',
      status_bayar: '',
      tgl_masuk: '2026-03-11',
    };
    const paidLab: LegacyRow = { ...labInWindow, no_transaksi: '13-110326-000033', status_bayar: 'LUNAS' };

    const hanging = findHangingRelatedTransactions({
      kunjunganRows: [labInWindow, sameReg, labOutOfWindow, poliNotFollowup, paidLab],
      roomRowsByReg,
    });

    // Sorted by tgl_masuk, and tagged with the group they belong to.
    expect(trxOf(hanging)).toEqual(['03-100326-000001', '13-110326-000030']);
    expect(hanging.every((row) => row['_hanging_reg'] === 'R100')).toBe(true);
  });

  it('skips handled transactions and de-duplicates per group', () => {
    const lab: LegacyRow = {
      no_transaksi: '13-110326-000030',
      no_registrasikunjungan: 'R900',
      nama_unit: 'LABORATORIUM PK',
      status_bayar: '',
      tgl_masuk: '2026-03-11',
    };
    expect(
      findHangingRelatedTransactions({
        kunjunganRows: [lab, { ...lab }],
        roomRowsByReg,
      }),
    ).toHaveLength(1);
    expect(
      findHangingRelatedTransactions({
        kunjunganRows: [lab],
        roomRowsByReg,
        handledTransactions: ['13-110326-000030'],
      }),
    ).toEqual([]);
  });

  it('keeps an undated follow-up row, which never fails the window test', () => {
    const undatedLab: LegacyRow = {
      no_transaksi: '13-000000-000034',
      no_registrasikunjungan: 'R903',
      nama_unit: 'LABORATORIUM PK',
      status_bayar: '',
      tgl_masuk: '',
    };
    const hanging = findHangingRelatedTransactions({
      kunjunganRows: [undatedLab],
      roomRowsByReg,
    });
    expect(trxOf(hanging)).toEqual(['13-000000-000034']);
  });

  it('ignores empty groups and undated groups', () => {
    expect(findHangingRelatedTransactions({ kunjunganRows: [], roomRowsByReg: {} })).toEqual([]);
    expect(
      findHangingRelatedTransactions({
        kunjunganRows: [BANK_DARAH_SAME_REG],
        roomRowsByReg: { R100: [], R200: [{ no_registrasikunjungan: 'R200' }] },
      }),
    ).toEqual([]);
  });
});

describe('normalizePenunjangBlocker', () => {
  it('reads an object response and blocks when any field is filled', () => {
    const blocker = normalizePenunjangBlocker({
      nama_unit: 'INSTALASI GIZI',
      no_transaksi: '18-100326-000050',
      data: 'order gizi belum dikirim',
      total: '2',
    });
    expect(blocker).toMatchObject({
      hasBlocker: true,
      namaUnit: 'INSTALASI GIZI',
      noTransaksi: '18-100326-000050',
      data: 'order gizi belum dikirim',
      total: 2,
    });
  });

  it('does not block on an empty object', () => {
    expect(normalizePenunjangBlocker({}).hasBlocker).toBe(false);
    expect(normalizePenunjangBlocker({ total: '0' }).hasBlocker).toBe(false);
  });

  it('blocks on a bare notice string and strips the HTML error page', () => {
    const blocker = normalizePenunjangBlocker(
      'Order radiologi belum dikirim\n<!DOCTYPE html><html>trace</html>',
    );
    expect(blocker.hasBlocker).toBe(true);
    expect(blocker.data).toBe('Order radiologi belum dikirim');
    expect(blocker.namaUnit).toBe('');
  });

  it('does not block on an empty or null response', () => {
    expect(normalizePenunjangBlocker('').hasBlocker).toBe(false);
    expect(normalizePenunjangBlocker(null).hasBlocker).toBe(false);
  });
});

describe('isGiziPenunjangBlocker', () => {
  it('recognises gizi by unit, by data text, and by the 18- prefix', () => {
    expect(isGiziPenunjangBlocker(normalizePenunjangBlocker({ nama_unit: 'INSTALASI GIZI' }))).toBe(true);
    expect(isGiziPenunjangBlocker(normalizePenunjangBlocker({ data: 'order gizi' }))).toBe(true);
    expect(
      isGiziPenunjangBlocker(normalizePenunjangBlocker({ no_transaksi: '18-100326-000050' })),
    ).toBe(true);
    expect(
      isGiziPenunjangBlocker(normalizePenunjangBlocker({ nama_unit: 'LABORATORIUM PK' })),
    ).toBe(false);
  });
});

describe('penunjangBlockerLabel', () => {
  it('renders the log line with dashes for the blank fields', () => {
    expect(penunjangBlockerLabel(normalizePenunjangBlocker({ nama_unit: 'CATHLAB', total: 3 }))).toBe(
      'nama_unit=CATHLAB | no_transaksi=- | data=- | total=3',
    );
    expect(penunjangBlockerLabel(null)).toBe('-');
  });
});

describe('checkMissingIgdDepoOrObatForVerification', () => {
  const kunjunganWithDepo: readonly LegacyRow[] = [
    {
      no_transaksi: '04-100326-000010',
      nama_unit: 'DEPO IGD',
      tgl_transaksi: '2026-03-10 09:00:00',
    },
  ];

  it('does nothing when the stay did not come through IGD', () => {
    expect(
      checkMissingIgdDepoOrObatForVerification({
        kunjunganRows: kunjunganWithDepo,
        roomRows: ROOM_ROWS,
        originInfo: { requires_igd_source: false },
      }),
    ).toEqual({ hasBlocker: false, periode: '', hasDepoIgd: false, hasBiayaObat: false });
    expect(
      checkMissingIgdDepoOrObatForVerification({
        kunjunganRows: kunjunganWithDepo,
        roomRows: ROOM_ROWS,
      }).hasBlocker,
    ).toBe(false);
  });

  it('blocks when neither a DEPO IGD visit nor a BIAYA OBAT charge exists', () => {
    const result = checkMissingIgdDepoOrObatForVerification({
      kunjunganRows: [
        {
          no_transaksi: '04-100326-000010',
          nama_unit: 'DEPO FARMASI RANAP',
          tgl_transaksi: '2026-03-10',
        },
      ],
      roomRows: ROOM_ROWS,
      originInfo: { requires_igd_source: true },
      listTindakanRows: [{ nama_tindakan: 'BIAYA KAMAR KELAS 3' }],
    });
    expect(result).toEqual({
      hasBlocker: true,
      periode: '2026-03-10 s/d 2026-03-12',
      hasDepoIgd: false,
      hasBiayaObat: false,
    });
  });

  it('clears the blocker when a DEPO IGD visit falls inside the stay', () => {
    const result = checkMissingIgdDepoOrObatForVerification({
      kunjunganRows: kunjunganWithDepo,
      roomRows: ROOM_ROWS,
      originInfo: { requiresIgdSource: true },
    });
    expect(result.hasDepoIgd).toBe(true);
    expect(result.hasBlocker).toBe(false);
  });

  it('ignores a DEPO IGD visit outside the stay dates', () => {
    const result = checkMissingIgdDepoOrObatForVerification({
      kunjunganRows: [{ nama_unit: 'DEPO IGD', tgl_transaksi: '2026-02-20' }],
      roomRows: ROOM_ROWS,
      originInfo: { requires_igd_source: true },
    });
    expect(result.hasDepoIgd).toBe(false);
    expect(result.hasBlocker).toBe(true);
  });

  it('clears the blocker when the stay was billed BIAYA OBAT', () => {
    const result = checkMissingIgdDepoOrObatForVerification({
      kunjunganRows: [],
      roomRows: ROOM_ROWS,
      originInfo: { requires_igd_source: true },
      listTindakanRows: [{ nama_tindakan: 'biaya obat' }],
    });
    expect(result.hasBiayaObat).toBe(true);
    expect(result.hasBlocker).toBe(false);
  });
});
