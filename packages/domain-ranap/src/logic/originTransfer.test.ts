/**
 * Origin-bill transfer (IGD/POLI → inpatient) and the pure choose-origin step.
 *
 * The IGD and POLI policies differ on purpose in places and by accident in
 * others; these tests pin each difference so a later unification is a visible,
 * deliberate change rather than a refactor side effect.
 */

import { describe, it, expect } from 'vitest';

import type { LegacyRow } from './types.js';
import {
  IGD_TRANSFER_POLICY,
  POLI_TRANSFER_POLICY,
  decideOriginTransfer,
  needsTransferDestination,
  pendingTransferRows,
  type OriginTransferFacts,
} from './originTransfer.js';
import {
  buildIgdOriginTarget,
  buildPoliOriginTarget,
  chooseOrigin,
  poliOriginCandidateWindow,
  scoreIgdOriginCandidate,
  scorePoliOriginCandidate,
  type IgdCandidateFacts,
} from './origin.js';

const NO_RM = '0-12-34-56';
const REG = 'RG2601040001';
const SOURCE_TRX = '02-2601040012';
const DEST_TRX = '03-2601040001';

const PENDING_ROWS: LegacyRow[] = [
  { kd_tindakan: '16', urut_tindakan: '2', tgl_transaksi: '2026-01-04 10:00:00' },
  { kd_tindakan: '38', urut_tindakan: '1', tgl_transaksi: '2026-01-04 09:00:00' },
  { kd_tindakan: '99', urut_tindakan: '3', flag: 'transfer' },
];
const ALL_TRANSFERRED: LegacyRow[] = [{ kd_tindakan: '38', urut_tindakan: '1', status_kirim: '1' }];

function facts(over: Partial<OriginTransferFacts> = {}): OriginTransferFacts {
  return {
    reg: REG,
    source: { no_transaksi: SOURCE_TRX, no_registrasikunjungan: 'RG-SRC', kd_unit: '302', kd_detkelpenjamin: '7' },
    pending: pendingTransferRows(PENDING_ROWS),
    destination: { no_transaksi: DEST_TRX, kd_unit: '1001' },
    biaya: '150000',
    ...over,
  };
}

describe('pendingTransferRows', () => {
  it('drops transferred rows and lists codes in legacy row order', () => {
    const { pending, kdTindakanList } = pendingTransferRows(PENDING_ROWS);
    expect(pending).toHaveLength(2);
    expect(kdTindakanList).toEqual(['38', '16']);
  });
});

describe('decideOriginTransfer — shared plan shape', () => {
  it('builds the transfer_tagihan_igd payload and one read-back per pending line', () => {
    const decision = decideOriginTransfer(IGD_TRANSFER_POLICY, facts({ destination: { no_transaksi: DEST_TRX, kd_unit: '1001', kd_detkelpenjamin: '3' } }));
    expect(decision.verdict).toBe('transfer');
    if (decision.verdict !== 'transfer') return;
    expect(decision.payload).toEqual({
      no_transaksi: SOURCE_TRX,
      no_transaksipoli: DEST_TRX,
      kd_unit_poli: '1001',
      Kd_DetKelPenjamin: '3',
      biaya: '150000',
      kd_unit: '302',
      kd_tindakan: "38','16",
    });
    expect(decision.readAfterWriteChecks.map((c) => c.description)).toEqual([
      'Tindakan IGD 38#1 terbaca sudah transfer',
      'Tindakan IGD 16#2 terbaca sudah transfer',
    ]);
    expect(decision.readAfterWriteChecks[0]).toMatchObject({
      endpointId: 'poliklinik.cekStatusTransfer',
      expected: '1',
      match: 'nonEmpty',
      payload: { no_transaksi: SOURCE_TRX, kd_tindakan: '38', urut_tindakan: '1' },
    });
  });

  it('refuses a blank amount for both origins', () => {
    expect(decideOriginTransfer(IGD_TRANSFER_POLICY, facts({ biaya: '  ' }))).toEqual({ verdict: 'missing', reason: 'biaya transfer IGD kosong' });
    expect(decideOriginTransfer(POLI_TRANSFER_POLICY, facts({ biaya: '' }))).toEqual({ verdict: 'missing', reason: 'biaya transfer POLI kosong' });
  });
});

describe('decideOriginTransfer — IGD vs POLI policy differences', () => {
  it('kd_detkelpenjamin: IGD goes destination → 15, POLI goes destination → source → 15', () => {
    const igd = decideOriginTransfer(IGD_TRANSFER_POLICY, facts());
    const poli = decideOriginTransfer(POLI_TRANSFER_POLICY, facts());
    expect(igd.verdict === 'transfer' && igd.payload['Kd_DetKelPenjamin']).toBe('15');
    expect(poli.verdict === 'transfer' && poli.payload['Kd_DetKelPenjamin']).toBe('7');

    const noSource = facts({ source: { no_transaksi: SOURCE_TRX, kd_unit: '1' } });
    const poliDefault = decideOriginTransfer(POLI_TRANSFER_POLICY, noSource);
    expect(poliDefault.verdict === 'transfer' && poliDefault.payload['Kd_DetKelPenjamin']).toBe('15');
  });

  it('payload summary: igd_/poli_ keys, POLI adds the perubahan line', () => {
    const igd = decideOriginTransfer(IGD_TRANSFER_POLICY, facts());
    const poli = decideOriginTransfer(POLI_TRANSFER_POLICY, facts());
    if (igd.verdict !== 'transfer' || poli.verdict !== 'transfer') throw new Error('expected transfers');
    expect(igd.payloadSummary).toEqual({
      no_registrasikunjungan: REG,
      igd_trx: SOURCE_TRX,
      igd_reg: 'RG-SRC',
      no_transaksipoli: DEST_TRX,
      biaya: '150000',
      tindakan: 2,
    });
    expect(poli.payloadSummary).toMatchObject({ poli_trx: SOURCE_TRX, poli_reg: 'RG-SRC', tindakan: 2 });
    expect(String(poli.payloadSummary['perubahan'])).toContain(`→ tagihan rawat inap ${DEST_TRX}`);
  });

  it('nothing pending: IGD counts it settled, POLI skips', () => {
    const none = pendingTransferRows(ALL_TRANSFERRED);
    expect(decideOriginTransfer(IGD_TRANSFER_POLICY, facts({ pending: none }))).toEqual({ verdict: 'settled' });
    expect(decideOriginTransfer(POLI_TRANSFER_POLICY, facts({ pending: none }))).toEqual({ verdict: 'skip' });
  });

  it('nothing pending + incomplete destination: IGD reports the destination, POLI still skips', () => {
    const none = pendingTransferRows(ALL_TRANSFERRED);
    expect(decideOriginTransfer(IGD_TRANSFER_POLICY, facts({ pending: none, destination: undefined }))).toEqual({
      verdict: 'missing',
      reason: 'data transaksi tujuan IGD tidak lengkap',
    });
    expect(decideOriginTransfer(POLI_TRANSFER_POLICY, facts({ pending: none, destination: undefined, biaya: '' }))).toEqual({ verdict: 'skip' });
  });

  it('POLI does not need the destination read when nothing is pending; IGD always reads it', () => {
    const none = pendingTransferRows(ALL_TRANSFERRED);
    const some = pendingTransferRows(PENDING_ROWS);
    expect(needsTransferDestination(POLI_TRANSFER_POLICY, none)).toBe(false);
    expect(needsTransferDestination(POLI_TRANSFER_POLICY, some)).toBe(true);
    expect(needsTransferDestination(IGD_TRANSFER_POLICY, none)).toBe(true);
  });
});

describe('chooseOrigin', () => {
  const row = (trx: string): LegacyRow => ({ no_transaksi: trx });

  it('returns undefined for no candidates', () => {
    expect(chooseOrigin([])).toBeUndefined();
  });

  it('ranks on the tuple, element by element, numbers then strings descending', () => {
    expect(
      chooseOrigin([
        { score: [0, 1, -0, 'A'], row: row('a') },
        { score: [1, 0, -5, 'A'], row: row('b') },
        { score: [1, 0, -2, 'A'], row: row('c') },
      ]),
    ).toEqual(row('c'));
    expect(
      chooseOrigin([
        { score: [1, '02-2601040001'], row: row('old') },
        { score: [1, '02-2601040009'], row: row('new') },
      ]),
    ).toEqual(row('new'));
  });

  it('keeps discovery order on a full tie', () => {
    expect(
      chooseOrigin([
        { score: [1, 0], row: row('first') },
        { score: [1, 0], row: row('second') },
      ]),
    ).toEqual(row('first'));
  });
});

describe('IGD choose-origin scoring', () => {
  const target = buildIgdOriginTarget({
    noRm: NO_RM,
    roomRows: [{ no_transaksi: DEST_TRX, no_registrasikunjungan: REG, no_sjp: 'SEP-1' }],
    tanggal: '2026-01-04',
    toleranceDays: 2,
    dataKunjunganByTrx: {},
  });
  const base: IgdCandidateFacts = {
    parentIgd: SOURCE_TRX,
    rowReg: 'RG-IGD',
    sourceNoTransaksi: '',
    sourceDt: new Date(2026, 0, 4),
    linked: { no_transaksi: DEST_TRX, no_registrasikunjungan: REG },
    sourceRow: { kd_unit: '302', nama_unit: 'IGD' },
    signal: { hasHemodialisaSignal: false, matchedNames: [] },
  };

  it('rejects a candidate that is neither linked nor SEP-matched', () => {
    expect(scoreIgdOriginCandidate({ ...base, linked: { no_transaksi: '03-OTHER' } }, target)).toBeUndefined();
    expect(
      scoreIgdOriginCandidate({ ...base, linked: { no_transaksi: '03-OTHER' }, sourceRow: { no_sep: 'SEP-1' } }, target),
    ).toBeDefined();
  });

  it('applies tolerance on either side of the reference date, and none when a date is unreadable', () => {
    expect(scoreIgdOriginCandidate({ ...base, sourceDt: new Date(2026, 0, 6) }, target)).toBeDefined();
    expect(scoreIgdOriginCandidate({ ...base, sourceDt: new Date(2026, 0, 7) }, target)).toBeUndefined();
    expect(scoreIgdOriginCandidate({ ...base, sourceDt: new Date(2026, 0, 1) }, target)).toBeUndefined();
    const far = scoreIgdOriginCandidate({ ...base, sourceDt: null }, target);
    expect(far?.score[5]).toBe(-999);
  });

  it('prefers the elektromedik-linked, hemodialysis, same-day candidate', () => {
    const plain = scoreIgdOriginCandidate({ ...base, parentIgd: '02-B', sourceDt: new Date(2026, 0, 3) }, target)!;
    const hd = scoreIgdOriginCandidate(
      { ...base, parentIgd: '02-A', sourceDt: new Date(2026, 0, 3), signal: { hasHemodialisaSignal: true, matchedNames: ['HD'] } },
      target,
    )!;
    const sameDay = scoreIgdOriginCandidate({ ...base, parentIgd: '02-C' }, target)!;
    expect(chooseOrigin([plain, sameDay, hd])?.['no_transaksi']).toBe('02-A');
    expect(chooseOrigin([plain, sameDay])?.['no_transaksi']).toBe('02-C');
    expect(hd.row['matched_names']).toEqual(['HD']);
  });
});

describe('POLI choose-origin window and scoring', () => {
  const kunjunganInap: LegacyRow = { no_transaksi: DEST_TRX, no_registrasikunjungan: REG, tgl_masuk: '2026-01-04' };
  const target = buildPoliOriginTarget({
    noRm: NO_RM,
    kunjunganInap,
    dataInap: { nama_rujukanasal: 'POLI PENYAKIT DALAM', kd_paramedis: 'D1' },
    tanggal: '',
    toleranceDays: 3,
  });
  const histRow = (trx: string, date: string): LegacyRow => ({ no_transaksi: trx, no_registrasikunjungan: `R-${trx}`, tgl_masuk: date, nama_unit: 'X' });

  it('takes only 01- visits with a registration, on or before the reference date, within tolerance', () => {
    expect(poliOriginCandidateWindow(histRow('01-A', '2026-01-04'), target)).toMatchObject({ diffDays: 0 });
    expect(poliOriginCandidateWindow(histRow('01-A', '2026-01-01'), target)).toMatchObject({ diffDays: -3 });
    expect(poliOriginCandidateWindow(histRow('01-A', '2025-12-31'), target)).toBeUndefined();
    expect(poliOriginCandidateWindow(histRow('01-A', '2026-01-05'), target)).toBeUndefined();
    expect(poliOriginCandidateWindow(histRow('02-A', '2026-01-04'), target)).toBeUndefined();
    expect(poliOriginCandidateWindow({ no_transaksi: '01-A', tgl_masuk: '2026-01-04' }, target)).toBeUndefined();
  });

  it('accepts on link or fallback match, ranks link over unit over doctor, then the smaller gap', () => {
    const score = (trx: string, date: string, linked: LegacyRow | undefined, detail: LegacyRow) => {
      const row = histRow(trx, date);
      return scorePoliOriginCandidate(row, poliOriginCandidateWindow(row, target)!, linked, detail, target);
    };
    // Nothing matches: rejected.
    expect(score('01-N', '2026-01-03', undefined, { nama_unit: 'POLI MATA', kd_paramedis: 'D9' })).toBeUndefined();
    // Doctor match alone needs the exact date (no KONSULTASI in the referral).
    expect(score('01-D', '2026-01-03', undefined, { nama_unit: 'POLI MATA', kd_paramedis: 'D1' })).toBeUndefined();
    const doctorSameDay = score('01-D', '2026-01-04', undefined, { nama_unit: 'POLI MATA', kd_paramedis: 'D1' })!;
    const unit = score('01-U', '2026-01-02', undefined, { nama_unit: 'POLI PENYAKIT DALAM' })!;
    const linked = score('01-L', '2026-01-01', { no_transaksi: DEST_TRX }, {})!;
    expect(chooseOrigin([doctorSameDay, unit, linked])?.['no_transaksi']).toBe('01-L');
    expect(chooseOrigin([doctorSameDay, unit])?.['no_transaksi']).toBe('01-U');

    const unitFar = score('01-U1', '2026-01-01', undefined, { nama_unit: 'POLI PENYAKIT DALAM' })!;
    const unitNear = score('01-U2', '2026-01-03', undefined, { nama_unit: 'POLI PENYAKIT DALAM' })!;
    expect(chooseOrigin([unitFar, unitNear])?.['no_transaksi']).toBe('01-U2');
  });

  it('source kd_detkelpenjamin falls back from the visit detail to the linked transaction', () => {
    const row = histRow('01-L', '2026-01-04');
    const window = poliOriginCandidateWindow(row, target)!;
    const c = scorePoliOriginCandidate(row, window, { no_transaksi: DEST_TRX, kd_detkelpenjamin: '4' }, {}, target)!;
    expect(c.row['kd_detkelpenjamin']).toBe('4');
  });
});
