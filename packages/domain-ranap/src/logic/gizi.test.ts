import { describe, expect, it } from 'vitest';

import { normalizePenunjangBlocker } from './blockers.js';
import type { PenunjangBlocker } from './blockers.js';
import {
  GIZI_RECOVERY_MAX_ATTEMPTS,
  collectOrderGiziTransactionsForGroup,
  planGiziBlockerRecovery,
  planOrderGiziRecovery,
  planOrderGiziSend,
} from './gizi.js';
import type { OrderGiziRecoveryPlan, OrderGiziTransaction } from './gizi.js';
import type { LegacyRow } from './types.js';

const REG = 'R100';
const ROOM_TRX_1 = '03-100326-000001';
const ROOM_TRX_2 = '03-110326-000002';
const ORDER_A = '18-100326-000010';
const ORDER_B = '18-110326-000011';

/** Two consecutive stays of one registration: 10 Mar and 11 Mar 2026. */
const ROOM_ROWS: readonly LegacyRow[] = [
  {
    no_transaksi: ROOM_TRX_1,
    no_registrasikunjungan: REG,
    kd_unit: '401',
    nama_unit: 'MULTAZAM / KELAS 3',
    urut_masuk_ruang: '1',
    tgl_masuk: '2026-03-10 08:00:00',
    tgl_keluar: '2026-03-11 07:00:00',
  },
  {
    no_transaksi: ROOM_TRX_2,
    no_registrasikunjungan: REG,
    nama_unit: 'ARROYAN / KELAS 2',
    urut_masuk_ruang: '2',
    tgl_masuk: '2026-03-11 07:00:00',
    tgl_keluar: '2026-03-12 10:00:00',
  },
];

const KUNJUNGAN_INAP: LegacyRow = {
  no_transaksi: ROOM_TRX_1,
  no_registrasikunjungan: REG,
};

function giziBlocker(overrides: Partial<PenunjangBlocker> = {}): PenunjangBlocker {
  return normalizePenunjangBlocker({
    nama_unit: 'INSTALASI GIZI',
    no_transaksi: ORDER_A,
    data: 'Order gizi belum selesai',
    total: 1,
    ...renameForPayload(overrides),
  });
}

/** Build the raw response shape `normalizePenunjangBlocker` expects. */
function renameForPayload(overrides: Partial<PenunjangBlocker>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (overrides.namaUnit !== undefined) payload['nama_unit'] = overrides.namaUnit;
  if (overrides.noTransaksi !== undefined) payload['no_transaksi'] = overrides.noTransaksi;
  if (overrides.data !== undefined) payload['data'] = overrides.data;
  if (overrides.total !== undefined) payload['total'] = overrides.total;
  return payload;
}

// ── candidate collection ─────────────────────────────────────────

describe('collectOrderGiziTransactionsForGroup', () => {
  it('walks the stays in order, de-duplicating orders across the group', () => {
    const items = collectOrderGiziTransactionsForGroup({
      roomRows: ROOM_ROWS,
      kdUnitByNoTransaksi: { [ROOM_TRX_2]: '402' },
      historyByNoTransaksi: {
        [ROOM_TRX_1]: {
          rows: [
            { no_transaksi: ORDER_A, tgl_order: '2026-03-10' },
            { no_transaksi: '', tgl_order: '2026-03-10' },
          ],
        },
        [ROOM_TRX_2]: {
          rows: [
            { no_transaksi: ORDER_A, tgl_order: '2026-03-11' },
            { no_transaksi: ORDER_B, tgl_order: '2026-03-11' },
          ],
        },
      },
    });

    expect(items).toEqual<OrderGiziTransaction[]>([
      {
        noTransaksiOrderGizi: ORDER_A,
        sourceNoTransaksi: ROOM_TRX_1,
        sourceRoom: 'MULTAZAM / KELAS 3',
        tglOrder: '2026-03-10',
      },
      {
        noTransaksiOrderGizi: ORDER_B,
        sourceNoTransaksi: ROOM_TRX_2,
        sourceRoom: 'ARROYAN / KELAS 2',
        tglOrder: '2026-03-11',
      },
    ]);
  });

  it('skips a stay with no kd_unit from either the row or the fallback', () => {
    const items = collectOrderGiziTransactionsForGroup({
      roomRows: ROOM_ROWS,
      historyByNoTransaksi: {
        [ROOM_TRX_1]: { rows: [{ no_transaksi: ORDER_A }] },
        [ROOM_TRX_2]: { rows: [{ no_transaksi: ORDER_B }] },
      },
    });

    // The second stay declares no kd_unit, so its history query is never built.
    expect(items.map((item) => item.noTransaksiOrderGizi)).toEqual([ORDER_A]);
  });
});

// ── sending ──────────────────────────────────────────────────────

const ORDER_ITEMS: readonly OrderGiziTransaction[] = [
  {
    noTransaksiOrderGizi: ORDER_A,
    sourceNoTransaksi: ROOM_TRX_1,
    sourceRoom: 'MULTAZAM / KELAS 3',
    tglOrder: '2026-03-10',
  },
];

describe('planOrderGiziSend', () => {
  it('plans a send for an order with pending detail lines and a free schedule', () => {
    const plan = planOrderGiziSend({
      roomRows: ROOM_ROWS,
      orderItems: ORDER_ITEMS,
      cekOrderGiziResponse: '1',
      detailByOrder: {
        [ORDER_A]: {
          rows: [
            { urut_order: '1', status_kirim: 'Belum', nama_jadwal: 'PAGI' },
            { urut_order: '2', status_kirim: '', nama_jadwal: 'SIANG' },
          ],
        },
      },
      jadwalByOrder: { [ORDER_A]: '1' },
    });

    expect(plan.reg).toBe(REG);
    expect(plan.cekOrderGizi).toBe(1);
    expect(plan.historyMissing).toBe(false);
    expect(plan.willSend).toBe(true);
    expect(plan.toSend).toEqual([
      {
        action: 'kirim',
        noTransaksiOrderGizi: ORDER_A,
        reason: 'pending=2 | cek_jadwal=1',
      },
    ]);
    expect(plan.alreadySent).toEqual([]);
    expect(plan.blocked).toEqual([]);
  });

  it('treats an empty cek_jadwal response as permission to send', () => {
    const plan = planOrderGiziSend({
      roomRows: ROOM_ROWS,
      orderItems: ORDER_ITEMS,
      detailByOrder: { [ORDER_A]: { rows: [{ urut_order: '1', status_kirim: 'Belum' }] } },
      jadwalByOrder: {},
    });

    expect(plan.willSend).toBe(true);
    expect(plan.toSend[0]?.reason).toBe('pending=1 | cek_jadwal=-');
  });

  it('leaves an order alone when every detail line already reads "sudah"', () => {
    const plan = planOrderGiziSend({
      roomRows: ROOM_ROWS,
      orderItems: ORDER_ITEMS,
      cekOrderGiziResponse: '0',
      detailByOrder: {
        [ORDER_A]: {
          rows: [
            { urut_order: '1', status_kirim: 'Sudah' },
            { urut_order: '2', status_kirim: 'SUDAH' },
          ],
        },
      },
      jadwalByOrder: { [ORDER_A]: '1' },
    });

    expect(plan.willSend).toBe(false);
    expect(plan.toSend).toEqual([]);
    expect(plan.alreadySent).toEqual([
      {
        action: 'none',
        noTransaksiOrderGizi: ORDER_A,
        reason: 'order gizi sudah terkirim | detail=2',
      },
    ]);
  });

  it('defers an order the kitchen schedule refuses', () => {
    const plan = planOrderGiziSend({
      roomRows: ROOM_ROWS,
      orderItems: ORDER_ITEMS,
      detailByOrder: { [ORDER_A]: { rows: [{ urut_order: '1', status_kirim: 'Belum' }] } },
      jadwalByOrder: { [ORDER_A]: '0' },
    });

    expect(plan.willSend).toBe(false);
    expect(plan.blocked).toEqual([
      { action: 'none', noTransaksiOrderGizi: ORDER_A, reason: 'cek_jadwal=0' },
    ]);
  });

  it('skips an order whose detail list came back empty', () => {
    const plan = planOrderGiziSend({
      roomRows: ROOM_ROWS,
      orderItems: ORDER_ITEMS,
      detailByOrder: { [ORDER_A]: { rows: [], total: 0 } },
    });

    expect(plan.willSend).toBe(false);
    expect(plan.blocked[0]?.reason).toBe('detail order gizi kosong');
  });

  it('reports the data gap when SIMRS counts an order the history does not show', () => {
    const plan = planOrderGiziSend({
      roomRows: ROOM_ROWS,
      orderItems: [],
      cekOrderGiziResponse: '2',
    });

    expect(plan.historyMissing).toBe(true);
    expect(plan.cekOrderGizi).toBe(2);
    expect(plan.actions).toEqual([]);
    expect(plan.willSend).toBe(false);
  });

  it('yields an empty plan for a group with no room rows', () => {
    const plan = planOrderGiziSend({
      roomRows: [],
      orderItems: ORDER_ITEMS,
      cekOrderGiziResponse: '3',
      detailByOrder: { [ORDER_A]: { rows: [{ urut_order: '1', status_kirim: 'Belum' }] } },
    });

    expect(plan.reg).toBe('');
    expect(plan.historyMissing).toBe(false);
    expect(plan.actions).toEqual([]);
    expect(plan.willSend).toBe(false);
  });
});

// ── recovery ─────────────────────────────────────────────────────

const TWO_ORDER_ITEMS: readonly OrderGiziTransaction[] = [
  ORDER_ITEMS[0] as OrderGiziTransaction,
  {
    noTransaksiOrderGizi: ORDER_B,
    sourceNoTransaksi: ROOM_TRX_2,
    sourceRoom: 'ARROYAN / KELAS 2',
    tglOrder: '2026-03-11',
  },
];

describe('planOrderGiziRecovery', () => {
  it('cancels the send, then deletes every detail line in chronological order', () => {
    const plan = planOrderGiziRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      orderItems: ORDER_ITEMS,
      detailByOrder: {
        [ORDER_A]: {
          rows: [
            {
              urut_order: '2',
              urut_tindakan: '2',
              status_kirim: 'Sudah',
              tgl_jam: '2026-03-10 12:00:00',
              nama_jadwal: 'SIANG',
              nama_jenismakan: 'BUBUR',
              tgl_order: '2026-03-10',
            },
            {
              urut_order: '1',
              urut_tindakan: '1',
              status_kirim: 'Sudah',
              tgl_jam: '2026-03-10 06:00:00',
              nama_jadwal: 'PAGI',
              nama_jenismakan: 'NASI',
              tgl_order: '2026-03-10',
            },
          ],
        },
      },
    });

    expect(plan.noTransaksi).toBe(ROOM_TRX_1);
    expect(plan.reg).toBe(REG);
    expect(plan.targetOrder).toBe(ORDER_A);
    expect(plan.willRecover).toBe(true);
    expect(plan.actions.map((action) => action.action)).toEqual([
      'batalKirim',
      'hapusDetail',
      'hapusDetail',
    ]);
    // `sortedRows` puts the 06:00 line first even though the payload did not.
    expect(plan.actions.map((action) => action.urutOrder)).toEqual([undefined, '1', '2']);
    expect(plan.actions[1]?.reason).toBe('jadwal=PAGI | jenis=NASI | tgl_order=2026-03-10');
  });

  it('skips the cancel when no detail line was ever sent', () => {
    const plan = planOrderGiziRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      orderItems: ORDER_ITEMS,
      detailByOrder: {
        [ORDER_A]: { rows: [{ urut_order: '1', status_kirim: 'Belum' }] },
      },
    });

    expect(plan.actions.map((action) => action.action)).toEqual(['hapusDetail']);
  });

  it('tries the order the blocker named first, whatever the history order', () => {
    const plan = planOrderGiziRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      orderItems: TWO_ORDER_ITEMS,
      preferredOrderTrx: ORDER_B,
      detailByOrder: {
        [ORDER_A]: { rows: [{ urut_order: '1', status_kirim: 'Belum' }] },
        [ORDER_B]: { rows: [{ urut_order: '9', status_kirim: 'Belum' }] },
      },
    });

    expect(plan.candidateOrders).toEqual([ORDER_B, ORDER_A]);
    expect(plan.targetOrder).toBe(ORDER_B);
    // The Python returns as soon as one order yields a deletion.
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.urutOrder).toBe('9');
    expect(plan.skipped).toEqual([]);
  });

  it('moves past an empty order and records why', () => {
    const plan = planOrderGiziRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      orderItems: TWO_ORDER_ITEMS,
      detailByOrder: {
        [ORDER_A]: { rows: [] },
        [ORDER_B]: { rows: [{ urut_order: '1', status_kirim: 'Belum' }] },
      },
    });

    expect(plan.skipped).toEqual([
      { action: 'none', noTransaksiOrderGizi: ORDER_A, reason: 'detail order gizi kosong' },
    ]);
    expect(plan.targetOrder).toBe(ORDER_B);
  });

  it('recovers nothing when no detail line carries a urut_order', () => {
    const plan = planOrderGiziRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      orderItems: ORDER_ITEMS,
      detailByOrder: { [ORDER_A]: { rows: [{ status_kirim: 'Belum', nama_jadwal: 'PAGI' }] } },
    });

    expect(plan.willRecover).toBe(false);
    expect(plan.targetOrder).toBe('');
    expect(plan.actions).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe('tidak ada detail dengan urut_order');
  });

  it('recovers nothing when the group has no order history at all', () => {
    const plan = planOrderGiziRecovery({ kunjunganInap: KUNJUNGAN_INAP, orderItems: [] });
    expect(plan.willRecover).toBe(false);
    expect(plan.candidateOrders).toEqual([]);
  });
});

// ── the recovery loop ────────────────────────────────────────────

function recoveryPlan(willRecover: boolean, order = ORDER_A): OrderGiziRecoveryPlan {
  return {
    noTransaksi: ROOM_TRX_1,
    reg: REG,
    preferredOrder: order,
    candidateOrders: [order],
    targetOrder: willRecover ? order : '',
    actions: willRecover
      ? [{ action: 'hapusDetail', noTransaksiOrderGizi: order, urutOrder: '1', reason: 'x' }]
      : [],
    skipped: [],
    willRecover,
  };
}

describe('planGiziBlockerRecovery', () => {
  it('exposes the legacy attempt cap', () => {
    expect(GIZI_RECOVERY_MAX_ATTEMPTS).toBe(5);
  });

  it('does nothing when there is no blocker', () => {
    const plan = planGiziBlockerRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      blockers: [normalizePenunjangBlocker({})],
    });

    expect(plan.outcome).toBe('clear');
    expect(plan.cleared).toBe(true);
    expect(plan.steps).toEqual([]);
  });

  it('refuses to touch a blocker that is not gizi', () => {
    const plan = planGiziBlockerRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      blockers: [
        normalizePenunjangBlocker({
          nama_unit: 'BANK DARAH',
          no_transaksi: '54-100326-000010',
          total: 1,
        }),
      ],
    });

    expect(plan.outcome).toBe('not-gizi');
    expect(plan.cleared).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.reason).toContain('nama_unit=BANK DARAH');
  });

  it('plans one attempt against the order the blocker names', () => {
    const plan = planGiziBlockerRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      blockers: [giziBlocker()],
      recoveryPlans: [recoveryPlan(true)],
    });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.attempt).toBe(1);
    expect(plan.steps[0]?.preferredOrderTrx).toBe(ORDER_A);
    expect(plan.steps[0]?.actions).toHaveLength(1);
    // Only one observation was supplied, so the loop cannot know the outcome.
    expect(plan.outcome).toBe('pending');
    expect(plan.needsMoreObservations).toBe(true);
  });

  it('reports the blocker cleared once a later observation is empty', () => {
    const plan = planGiziBlockerRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      blockers: [giziBlocker(), normalizePenunjangBlocker({})],
      recoveryPlans: [recoveryPlan(true)],
    });

    expect(plan.outcome).toBe('cleared');
    expect(plan.cleared).toBe(true);
    expect(plan.steps).toHaveLength(1);
  });

  it('stops when a recovery pass finds nothing to delete', () => {
    const plan = planGiziBlockerRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      blockers: [giziBlocker(), giziBlocker({ noTransaksi: ORDER_B })],
      recoveryPlans: [recoveryPlan(false)],
    });

    expect(plan.outcome).toBe('no-recovery');
    expect(plan.cleared).toBe(false);
    expect(plan.steps).toHaveLength(1);
  });

  it('stops after the first pass in preview, because nothing really changed', () => {
    const plan = planGiziBlockerRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      blockers: [giziBlocker(), normalizePenunjangBlocker({})],
      recoveryPlans: [recoveryPlan(true)],
      dryRun: true,
    });

    expect(plan.outcome).toBe('dry-run');
    expect(plan.cleared).toBe(false);
    expect(plan.steps).toHaveLength(1);
    expect(plan.reason).toBe('dry_run tidak mengubah state');
  });

  it('stops when the blocker comes back unchanged', () => {
    const plan = planGiziBlockerRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      blockers: [giziBlocker(), giziBlocker()],
      recoveryPlans: [recoveryPlan(true), recoveryPlan(true)],
    });

    expect(plan.outcome).toBe('stalled');
    expect(plan.cleared).toBe(false);
    expect(plan.steps).toHaveLength(1);
    expect(plan.reason).toContain('blocker tidak berubah');
  });

  it('stops when a later blocker belongs to another unit', () => {
    const plan = planGiziBlockerRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      blockers: [
        giziBlocker(),
        normalizePenunjangBlocker({ nama_unit: 'CATHLAB', no_transaksi: '55-1', total: 1 }),
      ],
      recoveryPlans: [recoveryPlan(true)],
    });

    expect(plan.outcome).toBe('not-gizi');
    expect(plan.steps).toHaveLength(1);
  });

  it('respects the attempt cap when every pass produces a new blocker', () => {
    const blockers = Array.from({ length: GIZI_RECOVERY_MAX_ATTEMPTS + 1 }, (_unused, index) =>
      giziBlocker({ data: `Order gizi sisa ${index}`, total: index + 1 }),
    );
    const plan = planGiziBlockerRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      blockers,
      recoveryPlans: blockers.map(() => recoveryPlan(true)),
    });

    expect(plan.outcome).toBe('exhausted');
    expect(plan.cleared).toBe(false);
    expect(plan.steps).toHaveLength(GIZI_RECOVERY_MAX_ATTEMPTS);
    expect(plan.steps.map((step) => step.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.reason).toBe('blocker gizi belum clear setelah 5 attempt');
  });

  it('honours a lower cap', () => {
    const blockers = Array.from({ length: 4 }, (_unused, index) =>
      giziBlocker({ data: `sisa ${index}`, total: index + 1 }),
    );
    const plan = planGiziBlockerRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      blockers,
      recoveryPlans: blockers.map(() => recoveryPlan(true)),
      maxAttempts: 2,
    });

    expect(plan.steps).toHaveLength(2);
    expect(plan.outcome).toBe('exhausted');
    expect(plan.maxAttempts).toBe(2);
  });

  it('recognises a gizi blocker by its 18- transaction prefix alone', () => {
    const plan = planGiziBlockerRecovery({
      kunjunganInap: KUNJUNGAN_INAP,
      blockers: [normalizePenunjangBlocker({ no_transaksi: ORDER_A })],
      recoveryPlans: [recoveryPlan(true)],
    });

    expect(plan.outcome).toBe('pending');
    expect(plan.steps[0]?.preferredOrderTrx).toBe(ORDER_A);
  });
});
