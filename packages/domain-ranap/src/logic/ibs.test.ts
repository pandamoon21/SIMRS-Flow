import { describe, expect, it } from 'vitest';

import {
  buildIbsConsistencyAlert,
  detectIbsBedahContext,
  findDanglingOrderOkCandidates,
  validateIbsConsistency,
} from './ibs.js';
import type { LegacyRow } from './types.js';

const REG = 'R100';

/** One room stay, 10 Mar → 12 Mar 2026. */
const ROOM_ROWS: readonly LegacyRow[] = [
  {
    no_transaksi: '03-100326-000001',
    no_registrasikunjungan: REG,
    kd_kamarperawatan: 'K1',
    nama_unit: 'MULTAZAM / KELAS 3',
    tgl_masuk: '2026-03-10 08:00:00',
    tgl_keluar: '2026-03-12 10:00:00',
  },
];

const AL_AFIYAT_ROOM_ROWS: readonly LegacyRow[] = [
  { ...(ROOM_ROWS[0] as LegacyRow), nama_unit: 'AL-AFIYAT / KELAS 1' },
];

const REKAP_WITH_DEPO_IBS =
  '<table><tr><td>DEPO   IBS</td><td>Rp 1.250.000</td></tr>' +
  '<tr><td>DEPO FARMASI</td><td>Rp 90.000</td></tr></table>';

const REKAP_WITHOUT_DEPO_IBS = '<table><tr><td>DEPO FARMASI</td><td>Rp 90.000</td></tr></table>';

const BIAYA_IBS_ROW: LegacyRow = { nama_tindakan: 'BIAYA IBS KELAS 3', qty: '1' };
const ROOM_CHARGE_ROW: LegacyRow = { nama_tindakan: 'BIAYA KAMAR KELAS 3', qty: '3' };

// ── the mismatch check ───────────────────────────────────────────

describe('detectIbsBedahContext', () => {
  it('reads the pharmacy marker out of the rekapitulasi HTML, whitespace and all', () => {
    const context = detectIbsBedahContext({
      roomRows: ROOM_ROWS,
      rekapitulasiHtml: REKAP_WITH_DEPO_IBS,
      listTindakanRows: [ROOM_CHARGE_ROW],
    });

    expect(context).toEqual({
      reg: REG,
      hasDepoIbs: true,
      hasBiayaIbs: false,
      hasBedahContext: true,
      isAlAfiyatCase: false,
    });
  });

  it('recognises a bedah sentral charge and the AL AFIYAT ward', () => {
    const context = detectIbsBedahContext({
      roomRows: AL_AFIYAT_ROOM_ROWS,
      rekapitulasiHtml: REKAP_WITHOUT_DEPO_IBS,
      listTindakanRows: [{ nama_tindakan: 'TINDAKAN BEDAH SENTRAL' }],
    });

    expect(context.hasDepoIbs).toBe(false);
    expect(context.hasBiayaIbs).toBe(true);
    expect(context.hasBedahContext).toBe(true);
    expect(context.isAlAfiyatCase).toBe(true);
  });
});

describe('detectIbsBedahContext — Rules-page review wards', () => {
  it('replaces the AL AFIYAT default with the configured wards', () => {
    const args = { roomRows: AL_AFIYAT_ROOM_ROWS, rekapitulasiHtml: REKAP_WITHOUT_DEPO_IBS };
    expect(detectIbsBedahContext({ ...args, manualReviewRooms: ['multazam'] }).isAlAfiyatCase).toBe(false);
    expect(detectIbsBedahContext({ ...args, manualReviewRooms: ['al afiyat'] }).isAlAfiyatCase).toBe(true);
    expect(detectIbsBedahContext({ roomRows: ROOM_ROWS, manualReviewRooms: [] }).isAlAfiyatCase).toBe(false);
  });
});

describe('validateIbsConsistency', () => {
  it('passes a group where the depot line and the surgical charge agree', () => {
    const result = validateIbsConsistency({
      roomRows: ROOM_ROWS,
      rekapitulasiHtml: REKAP_WITH_DEPO_IBS,
      listTindakanRows: [ROOM_CHARGE_ROW, BIAYA_IBS_ROW],
    });

    expect(result.ok).toBe(true);
    expect(result.modality).toBe('IBS');
    expect(result.noTransaksi).toBe(REG);
    expect(result.severity).toBe('info');
    expect(result.approve).toBe('n/a');
    expect(result.reason).toBe('');
    expect(result.issues).toEqual([]);
    expect(result.summary).toBe(`IBS ${REG} | depo_ibs=ada | biaya_ibs=ada`);
    expect(buildIbsConsistencyAlert(result)).toBeNull();
  });

  it('passes a group that never went to theatre at all', () => {
    const result = validateIbsConsistency({
      roomRows: ROOM_ROWS,
      rekapitulasiHtml: REKAP_WITHOUT_DEPO_IBS,
      listTindakanRows: [ROOM_CHARGE_ROW],
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(`IBS ${REG} | depo_ibs=tidak ada | biaya_ibs=tidak ada`);
  });

  it('fails with an ERROR when the IBS depot dispensed but nothing was billed', () => {
    const result = validateIbsConsistency({
      roomRows: ROOM_ROWS,
      rekapitulasiHtml: REKAP_WITH_DEPO_IBS,
      listTindakanRows: [ROOM_CHARGE_ROW],
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('warn');
    expect(result.needsAttention).toBe(true);
    expect(result.severity).toBe('error');
    expect(result.reason).toBe('IBS mismatch | depo_ibs=ada | biaya_ibs=tidak ada');
    expect(buildIbsConsistencyAlert(result)).toEqual({
      reg: REG,
      level: 'ERROR',
      message: 'IBS mismatch | depo_ibs=ada | biaya_ibs=tidak ada',
      blocking: true,
    });
  });

  it('softens the same mismatch to a WARN in an AL AFIYAT ward, still blocking', () => {
    const result = validateIbsConsistency({
      roomRows: AL_AFIYAT_ROOM_ROWS,
      rekapitulasiHtml: REKAP_WITH_DEPO_IBS,
      listTindakanRows: [ROOM_CHARGE_ROW],
    });

    expect(result.ok).toBe(false);
    expect(result.severity).toBe('warn');
    expect(result.reason).toBe(
      'IBS mismatch | depo_ibs=ada | biaya_ibs=tidak ada | ruang AL AFIYAT perlu cek manual',
    );
    expect(buildIbsConsistencyAlert(result)).toEqual({
      reg: REG,
      level: 'WARN',
      message:
        'IBS mismatch | depo_ibs=ada | biaya_ibs=tidak ada | ruang AL AFIYAT perlu cek manual',
      blocking: true,
    });
  });

  it('fails with an ERROR when surgery was billed but no depot line exists', () => {
    const result = validateIbsConsistency({
      roomRows: AL_AFIYAT_ROOM_ROWS,
      rekapitulasiHtml: REKAP_WITHOUT_DEPO_IBS,
      listTindakanRows: [BIAYA_IBS_ROW],
    });

    // The AL AFIYAT exemption covers only the depot-without-charge direction.
    expect(result.ok).toBe(false);
    expect(result.severity).toBe('error');
    expect(result.reason).toBe('IBS mismatch | depo_ibs=tidak ada | biaya_ibs=ada');
  });
});

// ── dangling OK orders ───────────────────────────────────────────

const CLEANABLE_ORDER: LegacyRow = {
  no_order: 'OK-0001',
  no_transaksi: '',
  tgl_order: '2026-03-11 09:00:00',
};

const USED_ORDER: LegacyRow = {
  no_order: 'OK-0002',
  no_transaksi: '04-110326-000500',
  tgl_order: '2026-03-11 12:00:00',
};

const OUT_OF_RANGE_ORDER: LegacyRow = {
  no_order: 'OK-0003',
  no_transaksi: '',
  tgl_transaksi: '2026-02-02 09:00:00',
};

describe('findDanglingOrderOkCandidates', () => {
  it('reports nothing to do when every in-range OK order has a transaction', () => {
    const plan = findDanglingOrderOkCandidates({
      roomRows: ROOM_ROWS,
      okHistoryRows: [USED_ORDER],
      hasBedahContext: true,
    });

    expect(plan.reg).toBe(REG);
    expect(plan.dateRange).toEqual({ start: '2026-03-10', end: '2026-03-12' });
    expect(plan.danglingRows).toEqual([]);
    expect(plan.hasUsedOkRows).toBe(true);
    expect(plan.candidates).toEqual([]);
    expect(plan.alerts).toEqual([]);
    expect(plan.requiresManualReview).toBe(false);
  });

  it('ignores dangling orders that fall outside the stay', () => {
    const plan = findDanglingOrderOkCandidates({
      roomRows: ROOM_ROWS,
      okHistoryRows: [OUT_OF_RANGE_ORDER],
      hasBedahContext: true,
    });

    expect(plan.danglingRows).toEqual([]);
    expect(plan.candidates).toEqual([]);
  });

  it('flags a dangling order for cleanup once the stay really went to theatre', () => {
    const plan = findDanglingOrderOkCandidates({
      roomRows: ROOM_ROWS,
      okHistoryRows: [CLEANABLE_ORDER, USED_ORDER],
      hasBedahContext: true,
      listTindakanOkByOrder: {
        'OK-0001': { rows: [{ kd_tindakan: 'OP1', nama_tindakan: 'APPENDEKTOMI' }], total: 1 },
      },
      statusTerlayaniByOrder: { 'OK-0001': '0' },
      statusKirimByOrder: { 'OK-0001': '0' },
    });

    expect(plan.danglingRows).toHaveLength(1);
    expect(plan.requiresManualReview).toBe(false);
    expect(plan.alerts).toEqual([]);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]).toMatchObject({
      noOrder: 'OK-0001',
      orderDate: '2026-03-11',
      roomNoTransaksi: '03-100326-000001',
      detailCount: 1,
      verdict: 'cleanup',
      actions: ['hapusOrder'],
    });
  });

  it('cancels the send before deleting an order that was already sent', () => {
    const plan = findDanglingOrderOkCandidates({
      roomRows: ROOM_ROWS,
      okHistoryRows: [CLEANABLE_ORDER],
      hasBedahContext: true,
      listTindakanOkByOrder: { 'OK-0001': [{ kd_tindakan: 'OP1' }] },
      statusTerlayaniByOrder: { 'OK-0001': '' },
      statusKirimByOrder: { 'OK-0001': '1' },
    });

    expect(plan.candidates[0]?.verdict).toBe('cleanup');
    expect(plan.candidates[0]?.actions).toEqual(['batalKirim', 'hapusOrder']);
  });

  it('sends the whole group to manual review with no surgical context and no live OK order', () => {
    const plan = findDanglingOrderOkCandidates({
      roomRows: ROOM_ROWS,
      okHistoryRows: [CLEANABLE_ORDER],
      hasBedahContext: false,
    });

    expect(plan.requiresManualReview).toBe(true);
    expect(plan.candidates).toEqual([]);
    expect(plan.alerts).toEqual([
      {
        reg: REG,
        level: 'WARN',
        message:
          'Order OK menggantung perlu cek manual | tidak ada konteks bedah sentral/OK aktif',
        // A dangling-OK warning does not block verification on its own; only the
        // IBS mismatch itself does.
        blocking: false,
      },
    ]);
  });

  it('inspects the orders anyway when another in-range OK order is live', () => {
    const plan = findDanglingOrderOkCandidates({
      roomRows: ROOM_ROWS,
      okHistoryRows: [CLEANABLE_ORDER, USED_ORDER],
      hasBedahContext: false,
      listTindakanOkByOrder: { 'OK-0001': [{ kd_tindakan: 'OP1' }] },
      statusTerlayaniByOrder: { 'OK-0001': '0' },
      statusKirimByOrder: { 'OK-0001': '0' },
    });

    expect(plan.requiresManualReview).toBe(false);
    expect(plan.candidates[0]?.verdict).toBe('cleanup');
  });

  it('refuses an order that has already been served', () => {
    const plan = findDanglingOrderOkCandidates({
      roomRows: ROOM_ROWS,
      okHistoryRows: [CLEANABLE_ORDER],
      hasBedahContext: true,
      listTindakanOkByOrder: { 'OK-0001': [{ kd_tindakan: 'OP1' }] },
      statusTerlayaniByOrder: { 'OK-0001': '1' },
      statusKirimByOrder: { 'OK-0001': '1' },
    });

    expect(plan.candidates[0]).toMatchObject({
      verdict: 'manual',
      reason: 'status terlayani=1',
      actions: [],
    });
    expect(plan.alerts).toEqual([
      {
        reg: REG,
        level: 'WARN',
        message: 'Skip hapus order OK menggantung | no_order=OK-0001 | status terlayani=1',
        blocking: false,
      },
    ]);
  });

  it('refuses an order whose OK tindakan list is empty', () => {
    const plan = findDanglingOrderOkCandidates({
      roomRows: ROOM_ROWS,
      okHistoryRows: [CLEANABLE_ORDER],
      hasBedahContext: true,
      listTindakanOkByOrder: { 'OK-0001': { rows: [], total: 0 } },
      statusTerlayaniByOrder: { 'OK-0001': '0' },
      statusKirimByOrder: { 'OK-0001': '0' },
    });

    expect(plan.candidates[0]).toMatchObject({
      verdict: 'manual',
      reason: 'detail tindakan OK kosong',
      detailCount: 0,
    });
    expect(plan.alerts[0]?.message).toBe(
      'Order OK menggantung perlu cek manual | no_order=OK-0001 | detail tindakan OK kosong',
    );
  });

  it('refuses an order whose date belongs to no room stay', () => {
    const plan = findDanglingOrderOkCandidates({
      // An unparseable admission means `normalizeRoomStays` drops the stay, so no
      // room can own the order date.
      roomRows: [{ no_transaksi: '03-100326-000001', no_registrasikunjungan: REG, tgl_masuk: '' }],
      okHistoryRows: [CLEANABLE_ORDER],
      hasBedahContext: true,
      listTindakanOkByOrder: { 'OK-0001': [{ kd_tindakan: 'OP1' }] },
    });

    expect(plan.candidates[0]).toMatchObject({
      verdict: 'manual',
      roomNoTransaksi: '',
      reason: 'transaksi rawat inap untuk tanggal order tidak ditemukan',
      actions: [],
    });
    expect(plan.alerts[0]?.message).toBe(
      'Order OK menggantung perlu cek manual | no_order=OK-0001 | transaksi rawat inap tidak ditemukan',
    );
  });

  it('refuses an order sent under an unrecognised flag value', () => {
    const plan = findDanglingOrderOkCandidates({
      roomRows: ROOM_ROWS,
      okHistoryRows: [CLEANABLE_ORDER],
      hasBedahContext: true,
      listTindakanOkByOrder: { 'OK-0001': [{ kd_tindakan: 'OP1' }] },
      statusTerlayaniByOrder: { 'OK-0001': '0' },
      statusKirimByOrder: { 'OK-0001': '2' },
    });

    expect(plan.candidates[0]).toMatchObject({
      verdict: 'manual',
      reason: 'status kirim=2',
      actions: [],
    });
    expect(plan.alerts[0]?.message).toBe(
      'Skip hapus order OK menggantung | no_order=OK-0001 | status kirim=2',
    );
  });

  it('treats an undated OK order as in range', () => {
    const plan = findDanglingOrderOkCandidates({
      roomRows: ROOM_ROWS,
      okHistoryRows: [{ no_order: 'OK-0009', no_transaksi: '' }],
      hasBedahContext: true,
      listTindakanOkByOrder: { 'OK-0009': [{ kd_tindakan: 'OP1' }] },
      statusTerlayaniByOrder: { 'OK-0009': '0' },
      statusKirimByOrder: { 'OK-0009': '0' },
    });

    expect(plan.danglingRows).toHaveLength(1);
    // With no order date the first stay of the group owns it.
    expect(plan.candidates[0]?.roomNoTransaksi).toBe('03-100326-000001');
    expect(plan.candidates[0]?.verdict).toBe('cleanup');
  });
});
