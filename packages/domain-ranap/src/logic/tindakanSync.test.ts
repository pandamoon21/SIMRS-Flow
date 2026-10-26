import { describe, expect, it } from 'vitest';

import {
  actionDisplayName,
  actionMetaCandidates,
  bolehHapusTindakan,
  filterActionRows,
  getKomponenParamedisName,
  getMalformedRekapJasaDates,
  getMalformedRekapRoomChargeDates,
  getSpesialisActionKey,
  isGenericRoomPelaksanaCandidate,
  isPelaksanaAlreadyCorrect,
  matchActionKey,
  pickIntermediateParamedisName,
  pickTindakanMeta,
  pickVerifikatorRoomMeta,
  planTindakanSync,
  resolveExactParamedisName,
  resolveJasaPelaksanaComponent,
  resolveOksigenPelaksanaComponent,
  rowAllowsDeleteByHint,
  rowMatchesSelectedActionMeta,
  scoreRoomChargeMeta,
  TINDAKAN_SYNC_ENDPOINTS,
} from './tindakanSync.js';
import type { KomponenRowsProvider, PlanTindakanSyncArgs, TindakanOp } from './tindakanSync.js';
import type { LegacyRow } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fixed clock, so `_build_update_datetime`'s wall-clock stamp is assertable. */
const NOW = new Date(2026, 2, 1, 7, 30, 0);
/** What `buildUpdateDateTime(date, …, now = NOW)` produces. */
const stamp = (date: string): string => `${date} 07:30:00`;

const D1 = '2026-03-01';
const D2 = '2026-03-02';

const ROOM_NAME = 'AL FAJR KELAS 3';
const ROOM_PELAKSANA = 'PERAWAT AL FAJR';

/** The room-stay row (`gethistorykunjungan_tab` shape). */
const STAY: LegacyRow = {
  no_transaksi: 'T1',
  no_registrasikunjungan: 'RG1',
  kd_unit: 'RI',
  kd_kamarperawatan: 'K01',
  kd_paramedis: 'DR1',
  nama_unit: ROOM_NAME,
  nama_pasien: 'PASIEN SATU',
  nama_paramedis: 'dr. BUDI, Sp.PD',
  tgl_masuk: `${D1} 08:00:00`,
  tgl_keluar: `${D2} 10:00:00`,
};

/** `ambil_master_tindakan_inap` — the three structural charges this ward bills. */
const MASTER_ROWS: readonly LegacyRow[] = [
  { kd_tindakan: 'RM3', nama_tindakan: 'BIAYA KAMAR AL FAJR KELAS 3', harga: '250000' },
  { kd_tindakan: 'JS1', nama_tindakan: 'JASA PELAYANAN', harga: '50000' },
  { kd_tindakan: 'DP1', nama_tindakan: 'DOKTER DPJB', harga: '30000' },
];

/** One `get_listtindakan` row: unpaid, unverified, deletable. */
function charge(over: LegacyRow): LegacyRow {
  return {
    no_transaksi: 'T1',
    qty: '1',
    status: '0',
    status_bayar: '0',
    status_verifikasi: '0',
    ...over,
  };
}

function roomCharge(date: string, urut: string, time = '08:00:00', over: LegacyRow = {}): LegacyRow {
  return charge({
    kd_tindakan: 'RM3',
    nama_tindakan: 'BIAYA KAMAR AL FAJR KELAS 3',
    harga: '250000',
    urut_tindakan: urut,
    tgl_jam: `${date} ${time}`,
    ...over,
  });
}

function jasaCharge(date: string, urut: string, time = '08:00:00', over: LegacyRow = {}): LegacyRow {
  return charge({
    kd_tindakan: 'JS1',
    nama_tindakan: 'JASA PELAYANAN',
    harga: '50000',
    urut_tindakan: urut,
    tgl_jam: `${date} ${time}`,
    ...over,
  });
}

function dpjbCharge(date: string, urut: string, time = '08:00:00', over: LegacyRow = {}): LegacyRow {
  return charge({
    kd_tindakan: 'DP1',
    nama_tindakan: 'DOKTER DPJB',
    harga: '30000',
    urut_tindakan: urut,
    tgl_jam: `${date} ${time}`,
    ...over,
  });
}

/** A day that already carries all three structural charges. */
function coveredDay(date: string, urutBase: number): LegacyRow[] {
  return [
    roomCharge(date, String(urutBase)),
    jasaCharge(date, String(urutBase + 1)),
    dpjbCharge(date, String(urutBase + 2)),
  ];
}

/**
 * `getdetail_komponen_transaksi`: jasa carries the pelaksana on component 98,
 * DPJB on 29 (and must be blank), room charges carry none at all.
 */
function komponenFor(jasaParamedis = ''): KomponenRowsProvider {
  return (row) => {
    const nama = String(row['nama_tindakan'] ?? '').toUpperCase();
    if (nama.includes('JASA PELAYANAN')) {
      return [
        {
          kd_komponen: '98',
          nama_komponentarif: 'JASA PELAYANAN',
          nama_paramedis: jasaParamedis,
          harga_persen: '100',
        },
      ];
    }
    if (nama.includes('DPJB')) {
      return [{ kd_komponen: '29', nama_komponentarif: 'JASA DOKTER', nama_paramedis: '' }];
    }
    return [];
  };
}

function planArgs(over: Partial<PlanTindakanSyncArgs> = {}): PlanTindakanSyncArgs {
  return {
    noRm: '0-12-34-56',
    kunjunganInap: STAY,
    tglSep: D1,
    listRows: [],
    masterRows: MASTER_ROWS,
    targetDatesOverride: [D1, D2],
    komponenRows: komponenFor(),
    now: NOW,
    ...over,
  };
}

/** The assertion shape used throughout: kind, target, and ordering. */
function shape(ops: readonly TindakanOp[]): Array<Record<string, unknown>> {
  return ops.map((op) => ({
    sequence: op.sequence,
    kind: op.kind,
    kd: op.kdTindakan ?? '',
    urut: op.urutTindakan ?? '',
    target: op.targetDatetime ?? '',
  }));
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

describe('planTindakanSync — baseline', () => {
  it('plans nothing when every day already carries the right three charges', () => {
    const plan = planTindakanSync(
      planArgs({ listRows: [...coveredDay(D1, 1), ...coveredDay(D2, 4)] }),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.targetDates).toEqual([D1, D2]);
    expect(plan.issues).toEqual([]);
  });

  it('returns an empty plan without a transaksi or registrasi', () => {
    const plan = planTindakanSync(planArgs({ kunjunganInap: { nama_unit: ROOM_NAME } }));
    expect(plan).toEqual({
      noTransaksi: '',
      noRegistrasikunjungan: '',
      targetDates: [],
      ops: [],
      untouched: [],
      issues: [],
      lines: [],
    });
  });

  it('derives the target dates from the stay when no override is supplied', () => {
    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: undefined,
        listRows: [...coveredDay(D1, 1), ...coveredDay(D2, 4)],
      }),
    );
    expect(plan.targetDates).toEqual([D1, D2]);
    expect(plan.ops).toEqual([]);
  });
});

describe('planTindakanSync — dates outside the allowed days', () => {
  it('moves a charge dated outside the stay onto the day that has none', () => {
    const plan = planTindakanSync(
      planArgs({
        listRows: [
          ...coveredDay(D1, 1),
          jasaCharge(D2, '5'),
          dpjbCharge(D2, '6'),
          roomCharge('2026-02-25', '7'),
        ],
      }),
    );
    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'rebalance', kd: 'RM3', urut: '7', target: stamp(D2) },
    ]);
    const [op] = plan.ops;
    expect(op?.endpointId).toBe(TINDAKAN_SYNC_ENDPOINTS.updateTgl);
    expect(op?.phase).toBe('_rebalance_action_rows_inap');
    expect(op?.reason).toBe(`di luar range ${D1} s/d ${D2}`);
    expect(op?.tglJam).toBe('2026-02-25 08:00:00');
    expect(plan.lines).toContain(
      `- Geser biaya ruang rawat inap ke tanggal kosong | trx=T1 | reg=RG1 | from=2026-02-25 | ` +
        `to=${stamp(D2)} | alasan=di luar range ${D1} s/d ${D2} | ` +
        `row=[nama=BIAYA KAMAR AL FAJR KELAS 3, kd=RM3, urut=7, tgl=2026-02-25 08:00:00, qty=1, harga=250000]`,
    );
  });

  it('deletes an out-of-range charge when every allowed day is already covered', () => {
    const plan = planTindakanSync(
      planArgs({
        listRows: [...coveredDay(D1, 1), ...coveredDay(D2, 4), roomCharge('2026-02-25', '7')],
      }),
    );
    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'hapus', kd: 'RM3', urut: '7', target: '' },
    ]);
    expect(plan.ops[0]?.endpointId).toBe(TINDAKAN_SYNC_ENDPOINTS.hapus);
    expect(plan.ops[0]?.phase).toBe('_cleanup_action_rows_inap');
    expect(plan.ops[0]?.reason).toBe(`di luar range ${D1} s/d ${D2}`);
  });

  it('rebalances the surplus when one day carries more rows than the stay allows', () => {
    const plan = planTindakanSync(
      planArgs({
        listRows: [
          ...coveredDay(D1, 1),
          roomCharge(D1, '4', '09:00:00'),
          jasaCharge(D2, '5'),
          dpjbCharge(D2, '6'),
        ],
      }),
    );
    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'rebalance', kd: 'RM3', urut: '4', target: stamp(D2) },
    ]);
    expect(plan.ops[0]?.reason).toBe(`duplikat tanggal ${D1}`);
    expect(plan.ops[0]?.actionKey).toBe('room');
  });
});

describe('planTindakanSync — duplicates', () => {
  it('drops one of two byte-identical charges and keeps the other', () => {
    const duplicate = roomCharge(D1, '4');
    const plan = planTindakanSync(
      planArgs({
        listRows: [...coveredDay(D1, 1), ...coveredDay(D2, 5), duplicate],
      }),
    );
    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'hapus', kd: 'RM3', urut: '4', target: '' },
    ]);
    expect(plan.ops[0]?.phase).toBe('_cleanup_exact_timestamp_duplicates_inap');
    expect(plan.ops[0]?.reason).toBe('duplikat timestamp identik');
    expect(plan.lines).toContain(
      `- Hapus duplikat timestamp identik | trx=T1 | reg=RG1 | timestamp=${D1} 08:00:00 | ` +
        `keep=[nama=BIAYA KAMAR AL FAJR KELAS 3, kd=RM3, urut=1, tgl=${D1} 08:00:00, qty=1, harga=250000] | ` +
        `drop=[nama=BIAYA KAMAR AL FAJR KELAS 3, kd=RM3, urut=4, tgl=${D1} 08:00:00, qty=1, harga=250000]`,
    );
    // Only one delete: the working set advanced, so the later cleanup no longer
    // sees the row it removed.
    expect(plan.ops.filter((op) => op.kind === 'hapus')).toHaveLength(1);
  });

  it('exempts BIAYA DIIT GIZI from the identical-timestamp cleanup', () => {
    const gizi = (urut: string): LegacyRow =>
      charge({
        kd_tindakan: 'GZ1',
        nama_tindakan: 'BIAYA DIIT GIZI',
        harga: '20000',
        urut_tindakan: urut,
        tgl_jam: `${D1} 11:00:00`,
      });
    const plan = planTindakanSync(
      planArgs({
        listRows: [...coveredDay(D1, 1), ...coveredDay(D2, 5), gizi('8'), gizi('9')],
      }),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.untouched.map((entry) => entry.reason)).toContain('BIAYA DIIT GIZI dikecualikan');
  });
});

describe('planTindakanSync — missing charges', () => {
  it('adds jasa, dpjb and the room charge, in that order, for an uncovered day', () => {
    const plan = planTindakanSync(planArgs({ listRows: coveredDay(D1, 1) }));
    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'tambah', kd: 'JS1', urut: '', target: stamp(D2) },
      { sequence: 2, kind: 'tambah', kd: 'DP1', urut: '', target: stamp(D2) },
      { sequence: 3, kind: 'tambah', kd: 'RM3', urut: '', target: stamp(D2) },
    ]);
    const roomOp = plan.ops[2];
    expect(roomOp?.endpointId).toBe(TINDAKAN_SYNC_ENDPOINTS.tambah);
    expect(roomOp?.row).toBeUndefined();
    expect(roomOp?.targetDate).toBe(D2);
    expect(roomOp?.harga).toBe('250000');
    expect(roomOp?.kdUnit).toBe('RI');
    expect(roomOp?.kdKamar).toBe('K01');
    expect(roomOp?.kdParamedis).toBe('DR1');
    expect(roomOp?.kdDetkelpenjamin).toBe('15');
    expect(roomOp?.reason).toBe(`biaya ruang rawat inap belum ada pada tanggal ${D2}`);
    expect(plan.lines).toContain(
      `- Tambah biaya ruang rawat inap | trx=T1 | reg=RG1 | tanggal=${D2} | kd_tindakan=RM3 | ` +
        `harga=250000 | kd_paramedis=DR1 | kd_detkelpenjamin=15 | kd_kamar=K01`,
    );
  });

  it('skips the jasa add for a BYNY patient but still adds dpjb and the room charge', () => {
    const plan = planTindakanSync(
      planArgs({
        kunjunganInap: { ...STAY, nama_pasien: 'BY. NY. SITI' },
        listRows: coveredDay(D1, 1),
      }),
    );
    expect(plan.ops.map((op) => op.kdTindakan)).toEqual(['DP1', 'RM3']);
    expect(plan.lines).toContain(
      `- Skip tambah jasa pelayanan | trx=T1 | reg=RG1 | tanggal=${D2} | ` +
        `alasan=pasien BYNY, jasa pelayanan tidak wajib tersedia per tanggal dari server`,
    );
  });

  it('refuses to add when kd_kamarperawatan is missing and records the gap', () => {
    const { kd_kamarperawatan: _drop, ...noKamar } = STAY;
    const plan = planTindakanSync(
      planArgs({ kunjunganInap: noKamar, listRows: coveredDay(D1, 1) }),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.issues).toEqual([
      { level: 'INFO', message: `tambah_jasa: trx=T1 tanggal=${D2} kd_kamarperawatan kosong` },
      { level: 'INFO', message: `tambah_dpjb: trx=T1 tanggal=${D2} kd_kamarperawatan kosong` },
      { level: 'INFO', message: `tambah_room: trx=T1 tanggal=${D2} kd_kamarperawatan kosong` },
    ]);
  });

  it('falls back to the verifikator add when the bill has no room charge at all', () => {
    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: [D1],
        listRows: [jasaCharge(D1, '1'), dpjbCharge(D1, '2')],
        verifikatorMasterRows: [
          { kd_tindakan: 'VRM3', nama_tindakan: 'BIAYA KAMAR AL FAJR KELAS 3', harga: '250000' },
        ],
        verifikatorDatakunjungan: { kd_unit: 'RI', kd_paramedis: 'DR1', kd_detkelpenjamin: '15' },
        verifikatorDatakunjunganTab: { kd_kamarperawatan: 'K01' },
      }),
    );
    const preflight = plan.ops[0];
    expect(preflight?.kind).toBe('tambah');
    expect(preflight?.endpointId).toBe(TINDAKAN_SYNC_ENDPOINTS.tambahVerifikator);
    expect(preflight?.phase).toBe('tambah_biaya_ruang_verifikator');
    expect(preflight?.kdTindakan).toBe('VRM3');
    expect(plan.lines).toContain(
      '- Preflight biaya ruang kosong | trx=T1 | reg=RG1 | room=AL FAJR KELAS 3 | aksi=coba fallback verifikator',
    );
  });
});

describe('planTindakanSync — pelaksana', () => {
  it('fixes an empty jasa pelaksana', () => {
    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: [D1],
        listRows: coveredDay(D1, 1),
        roomPelaksana: ROOM_PELAKSANA,
        komponenRows: komponenFor(''),
      }),
    );
    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'setPelaksana', kd: 'JS1', urut: '2', target: '' },
    ]);
    const [op] = plan.ops;
    expect(op?.endpointId).toBe(TINDAKAN_SYNC_ENDPOINTS.tampungPelaksana);
    expect(op?.pelaksana).toBe(ROOM_PELAKSANA);
    expect(op?.kdKomponen).toBe('98');
    expect(op?.hargaPersen).toBe('100');
    expect(op?.reason).toBe(`pelaksana jasa pelayanan harus ${ROOM_PELAKSANA}`);
  });

  it('fixes a wrong jasa pelaksana and names the current holder', () => {
    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: [D1],
        listRows: coveredDay(D1, 1),
        roomPelaksana: ROOM_PELAKSANA,
        komponenRows: komponenFor('PERAWAT AL KAUTSAR'),
      }),
    );
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0]?.reason).toBe(
      `pelaksana jasa pelayanan harus ${ROOM_PELAKSANA} (sekarang PERAWAT AL KAUTSAR)`,
    );
  });

  it('leaves a jasa pelaksana that already matches alone', () => {
    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: [D1],
        listRows: coveredDay(D1, 1),
        roomPelaksana: ROOM_PELAKSANA,
        komponenRows: komponenFor(ROOM_PELAKSANA),
      }),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.untouched.map((entry) => entry.reason)).toContain(
      'pelaksana jasa pelayanan sudah sesuai',
    );
    expect(plan.lines).toContain(
      `- Jasa Pelayanan | tanggal=${D1} | pelaksana=${ROOM_PELAKSANA} | hasil=sudah sesuai`,
    );
  });

  it('blanks a DPJB pelaksana that a name leaked into', () => {
    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: [D1],
        listRows: coveredDay(D1, 1),
        komponenRows: (row) =>
          String(row['nama_tindakan'] ?? '').includes('DPJB')
            ? [{ kd_komponen: '29', nama_komponentarif: 'JASA DOKTER', nama_paramedis: 'dr. BUDI' }]
            : [],
      }),
    );
    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'setPelaksana', kd: 'DP1', urut: '3', target: '' },
    ]);
    expect(plan.ops[0]?.pelaksana).toBe('');
    expect(plan.ops[0]?.kdKomponen).toBe('29');
    expect(plan.ops[0]?.reason).toBe('pelaksana dpjb harus kosong (sekarang dr. BUDI)');
  });

  it('blanks the BHP OKSIGEN pelaksana on its own component', () => {
    const oksigen = charge({
      kd_tindakan: 'OK1',
      nama_tindakan: 'BHP OKSIGEN PER JAM',
      harga: '15000',
      urut_tindakan: '4',
      tgl_jam: `${D1} 12:00:00`,
    });
    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: [D1],
        listRows: [...coveredDay(D1, 1), oksigen],
        komponenRows: (row) => {
          const nama = String(row['nama_tindakan'] ?? '').toUpperCase();
          if (nama.includes('OKSIGEN')) {
            return [
              {
                kd_komponen: '41',
                nama_komponentarif: 'BHP',
                nama_paramedis: 'PERAWAT LAIN',
                harga: '15000',
                harga_persen: '100',
              },
            ];
          }
          if (nama.includes('DPJB')) {
            return [{ kd_komponen: '29', nama_komponentarif: 'JASA DOKTER', nama_paramedis: '' }];
          }
          return [];
        },
      }),
    );
    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'setPelaksana', kd: 'OK1', urut: '4', target: '' },
    ]);
    expect(plan.ops[0]?.kdKomponen).toBe('41');
    expect(plan.ops[0]?.pelaksana).toBe('');
    expect(plan.ops[0]?.phase).toBe('_tampung_pelaksana_checked/oksigen');
  });

  it('credits a nursing action to the ward nurse', () => {
    const nursing = charge({
      kd_tindakan: 'TN1',
      nama_tindakan: 'PEMASANGAN INFUS',
      harga: '25000',
      urut_tindakan: '4',
      tgl_jam: `${D1} 13:00:00`,
    });
    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: [D1],
        listRows: [...coveredDay(D1, 1), nursing],
        roomPelaksana: ROOM_PELAKSANA,
        komponenRows: (row) => {
          const nama = String(row['nama_tindakan'] ?? '').toUpperCase();
          if (nama.includes('INFUS')) {
            return [{ kd_komponen: '98', nama_komponentarif: 'JASA PERAWAT', nama_paramedis: '' }];
          }
          if (nama.includes('JASA PELAYANAN')) {
            return [
              {
                kd_komponen: '98',
                nama_komponentarif: 'JASA PELAYANAN',
                nama_paramedis: ROOM_PELAKSANA,
                harga_persen: '100',
              },
            ];
          }
          if (nama.includes('DPJB')) {
            return [{ kd_komponen: '29', nama_komponentarif: 'JASA DOKTER', nama_paramedis: '' }];
          }
          return [];
        },
      }),
    );
    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'setPelaksana', kd: 'TN1', urut: '4', target: '' },
    ]);
    expect(plan.ops[0]?.pelaksana).toBe(ROOM_PELAKSANA);
    expect(plan.ops[0]?.phase).toBe('_tampung_pelaksana_checked/tindakan_ruangan');
  });

  it('skips the jasa sweep entirely when no ward pelaksana resolved', () => {
    const plan = planTindakanSync(
      planArgs({ targetDatesOverride: [D1], listRows: coveredDay(D1, 1) }),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.lines).toContain(
      '- Jasa Pelayanan | hasil=skip | alasan=pelaksana jasa tidak ditemukan dari endpoint',
    );
    expect(plan.untouched.map((entry) => entry.reason)).toContain(
      'pelaksana jasa tidak ditemukan dari endpoint',
    );
  });
});

describe('planTindakanSync — charges that must not be deleted', () => {
  it('keeps a protected charge through the identical-timestamp cleanup', () => {
    const lab = (urut: string): LegacyRow =>
      charge({
        kd_tindakan: 'LB1',
        nama_tindakan: 'BIAYA LABORATORIUM',
        harga: '75000',
        urut_tindakan: urut,
        tgl_jam: `${D1} 10:00:00`,
      });
    const plan = planTindakanSync(
      planArgs({
        listRows: [...coveredDay(D1, 1), ...coveredDay(D2, 5), lab('8'), lab('9')],
      }),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.untouched).toContainEqual({
      row: lab('9'),
      reason: 'tindakan dilindungi dan tidak boleh dihapus',
    });
    expect(plan.lines.join('\n')).toContain('Alasan   : tindakan dilindungi dan tidak boleh dihapus');
  });

  it('never deletes a row the delete hint forbids', () => {
    const verified = jasaCharge(D1, '4', '08:00:00', { status_verifikasi: '1' });
    const plan = planTindakanSync(
      planArgs({
        listRows: [...coveredDay(D1, 1), ...coveredDay(D2, 5), verified],
      }),
    );
    expect(plan.ops.filter((op) => op.kind === 'hapus')).toEqual([]);
    const reasons = plan.untouched
      .filter((entry) => entry.row === verified)
      .map((entry) => entry.reason)
      .filter((reason) => reason.includes('bayar'));
    expect(reasons).toEqual([
      'sudah bayar / verifikasi',
      `duplikat pada tanggal ${D1}; sudah bayar / verifikasi`,
    ]);
  });

  it('fails closed when the paid-status read is needed but not supplied', () => {
    const unclear = roomCharge(D1, '4', '09:00:00', { status: '2' });
    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: [D1],
        listRows: [...coveredDay(D1, 1), unclear],
      }),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.untouched.map((entry) => entry.reason)).toContain(
      `duplikat pada tanggal ${D1}; status bayar tindakan belum bisa dipastikan (butuh cekstatusbayar_tindakan)`,
    );
  });

  it('deletes the same row once cekstatusbayar_tindakan reports it unpaid', () => {
    const unclear = roomCharge(D1, '4', '09:00:00', { status: '2' });
    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: [D1],
        listRows: [...coveredDay(D1, 1), unclear],
        statusBayarTindakan: () => '0',
      }),
    );
    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'hapus', kd: 'RM3', urut: '4', target: '' },
    ]);
  });
});

describe('planTindakanSync — source-driven date alignment', () => {
  it('re-dates IGD, poliklinik, elektromedik and depo-IBS rows in the legacy order', () => {
    const igd = charge({
      kd_tindakan: 'UG1',
      nama_tindakan: 'BIAYA UGD LEVEL 1',
      harga: '90000',
      urut_tindakan: '10',
      tgl_jam: '2026-02-20 09:00:00',
    });
    const poli = charge({
      kd_tindakan: 'PL1',
      nama_tindakan: 'BIAYA POLIKLINIK ANAK',
      harga: '40000',
      urut_tindakan: '11',
      tgl_jam: '2026-02-21 09:00:00',
    });
    const elektro = charge({
      kd_tindakan: 'EL1',
      nama_tindakan: 'BIAYA PENUNJANG ELEKTROMEDIK',
      harga: '60000',
      urut_tindakan: '12',
      tgl_jam: '2026-02-22 09:00:00',
    });
    const depo = charge({
      kd_tindakan: 'DI1',
      nama_tindakan: 'DEPO IBS',
      harga: '30000',
      urut_tindakan: '13',
      tgl_jam: '2026-02-23 09:00:00',
    });
    const biayaIbs = charge({
      kd_tindakan: 'IB1',
      nama_tindakan: 'BIAYA IBS',
      harga: '500000',
      urut_tindakan: '14',
      tgl_jam: `${D1} 08:30:00`,
    });
    const obat = charge({
      kd_tindakan: 'OB1',
      nama_tindakan: 'BIAYA OBAT',
      harga: '12000',
      urut_tindakan: '15',
      tgl_jam: '2026-02-24 09:00:00',
    });

    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: [D1],
        listRows: [...coveredDay(D1, 1), igd, poli, elektro, depo, biayaIbs, obat],
        elektromedikHistory: [{ tgl_transaksi: `${D2} 09:00:00`, no_transaksi: 'E9' }],
      }),
    );

    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'updateTgl', kd: 'UG1', urut: '10', target: stamp(D1) },
      { sequence: 2, kind: 'updateTgl', kd: 'PL1', urut: '11', target: stamp(D1) },
      { sequence: 3, kind: 'updateTgl', kd: 'EL1', urut: '12', target: stamp(D2) },
      { sequence: 4, kind: 'updateTgl', kd: 'DI1', urut: '13', target: stamp(D1) },
    ]);
    expect(plan.ops.map((op) => op.phase)).toEqual([
      '_sinkronkan_tanggal_igd',
      '_sinkronkan_tanggal_poliklinik',
      '_sinkronkan_tanggal_elektromedik',
      '_sinkronkan_tanggal_depo_ibs',
    ]);
    expect(plan.ops[0]?.reason).toBe(
      'samakan tanggal BIAYA UGD/BIAYA IGD KEBIDANAN ke tanggal SEP/tanggal masuk rawat inap',
    );
    expect(plan.ops[1]?.reason).toBe(
      'samakan tanggal BIAYA POLIKLINIK ke tanggal SEP/tanggal masuk rawat inap',
    );
    expect(plan.ops[2]?.reason).toBe(
      'samakan tanggal penunjang elektromedik ke tanggal history elektromedik',
    );
    expect(plan.ops[3]?.reason).toBe(
      'samakan tanggal DEPO IBS ke tanggal BIAYA IBS/BEDAH SENTRAL/CATHLAB',
    );
    // `_sinkronkan_tanggal_biaya_obat_inap` is disabled in `ranap_v3.py`.
    expect(plan.untouched).toContainEqual({
      row: obat,
      reason:
        'sinkronisasi tanggal BIAYA OBAT dinonaktifkan sementara di ranap_v3.py karena masih kacau',
    });
  });

  it('re-dates lab and radiology rows to their history dates', () => {
    const lab = charge({
      kd_tindakan: 'LB1',
      nama_tindakan: 'BIAYA LABORATORIUM',
      harga: '75000',
      urut_tindakan: '10',
      tgl_jam: '2026-02-20 09:00:00',
    });
    const rad = charge({
      kd_tindakan: 'RD1',
      nama_tindakan: 'BIAYA RADIOLOGI THORAX',
      harga: '150000',
      urut_tindakan: '11',
      tgl_jam: '2026-02-21 09:00:00',
    });
    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: [D1],
        listRows: [...coveredDay(D1, 1), lab, rad],
        labTargetRows: [{ no_transaksi: 'L9', tgl_transaksi: `${D1} 09:00:00` }],
        radHistory: [{ no_transaksi: 'R9', tgl_transaksi: `${D2} 09:00:00` }],
      }),
    );
    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'updateTgl', kd: 'LB1', urut: '10', target: stamp(D1) },
      { sequence: 2, kind: 'updateTgl', kd: 'RD1', urut: '11', target: stamp(D2) },
    ]);
    expect(plan.ops[0]?.reason).toBe(
      'samakan tanggal BIAYA LABORATORIUM ke history penunjang terkait',
    );
    expect(plan.ops[1]?.reason).toBe('samakan tanggal BIAYA RADIOLOGI ke history penunjang terkait');
    expect(plan.lines).toContain('- Target history BIAYA LABORATORIUM');
  });

  it('leaves an IGD row that is already on the SEP date alone', () => {
    const igd = charge({
      kd_tindakan: 'UG1',
      nama_tindakan: 'BIAYA UGD LEVEL 1',
      harga: '90000',
      urut_tindakan: '10',
      tgl_jam: `${D1} 06:00:00`,
    });
    const plan = planTindakanSync(
      planArgs({ targetDatesOverride: [D1], listRows: [...coveredDay(D1, 1), igd] }),
    );
    expect(plan.ops).toEqual([]);
  });
});

describe('planTindakanSync — rekapitulasi corruption repair', () => {
  const REKAP_HTML = `
    <table>
      <tr><td><b>${D1}</b></td><td><b>JASA PELAYANAN / KELAS 3 / PERAWAT AL FAJR / PERAWAT AL FAJR</b></td></tr>
      <tr><td><b>${D1}</b></td><td><b>BIAYA KAMAR AL FAJR KELAS 3 / PERAWAT AL FAJR</b></td></tr>
    </table>`;

  it('deletes the corrupted jasa and room rows so they can be re-added', () => {
    const plan = planTindakanSync(
      planArgs({
        targetDatesOverride: [D1],
        listRows: coveredDay(D1, 1),
        rekapDetailHakHtml: REKAP_HTML,
      }),
    );
    expect(shape(plan.ops)).toEqual([
      { sequence: 1, kind: 'hapus', kd: 'JS1', urut: '2', target: '' },
      { sequence: 2, kind: 'hapus', kd: 'RM3', urut: '1', target: '' },
    ]);
    expect(plan.ops.map((op) => op.phase)).toEqual([
      '_repair_malformed_jasa_rekap_inap',
      '_repair_malformed_room_charge_rekap_inap',
    ]);
    expect(plan.ops[0]?.reason).toContain('rekap menampilkan pelaksana ganda');
    expect(plan.ops[1]?.reason).toContain('rekap menampilkan pelaksana pada biaya ruang');
  });
});

// ---------------------------------------------------------------------------
// The decision helpers
// ---------------------------------------------------------------------------

describe('matchActionKey / rowMatchesSelectedActionMeta / filterActionRows', () => {
  it('classifies jasa and dpjb before consulting the room meta', () => {
    expect(matchActionKey({ nama_tindakan: 'JASA PELAYANAN KAT 2' })).toBe('jasa');
    expect(matchActionKey({ nama_tindakan: 'DOKTER DPJP' })).toBe('dpjb');
    expect(matchActionKey({ nama_tindakan: 'BIAYA KAMAR VIP 1' })).toBe('room');
    expect(matchActionKey({ nama_tindakan: 'BIAYA LABORATORIUM' })).toBe('');
  });

  it('only accepts the room charge the chosen meta names', () => {
    const meta: LegacyRow = { kd_tindakan: 'RM3', nama_tindakan: 'BIAYA KAMAR AL FAJR KELAS 3' };
    expect(matchActionKey({ kd_tindakan: 'RM3', nama_tindakan: 'apa saja' }, meta)).toBe('room');
    expect(matchActionKey({ nama_tindakan: 'BIAYA KAMAR AL FAJR KELAS 3' }, meta)).toBe('room');
    expect(matchActionKey({ kd_tindakan: 'RM2', nama_tindakan: 'BIAYA KAMAR VIP 1' }, meta)).toBe('');
    // An empty dict is falsy in Python, so it must not act as a meta.
    expect(matchActionKey({ nama_tindakan: 'BIAYA KAMAR VIP 1' }, {})).toBe('room');
  });

  it('holds a jasa row to the exact name of the selected meta', () => {
    const actionMeta: LegacyRow = { nama_tindakan: 'JASA PELAYANAN KAT 2' };
    expect(
      rowMatchesSelectedActionMeta({ nama_tindakan: 'JASA PELAYANAN KAT 2' }, 'jasa', actionMeta),
    ).toBe(true);
    expect(rowMatchesSelectedActionMeta({ nama_tindakan: 'JASA PELAYANAN' }, 'jasa', actionMeta)).toBe(
      false,
    );
    expect(rowMatchesSelectedActionMeta({ nama_tindakan: 'JASA PELAYANAN' }, 'jasa')).toBe(true);
  });

  it('filters by action and date, preserving input order', () => {
    const rows = [jasaCharge(D2, '2'), jasaCharge(D1, '1'), dpjbCharge(D1, '3')];
    expect(filterActionRows(rows, 'jasa', [D1, D2]).map((row) => row['urut_tindakan'])).toEqual([
      '2',
      '1',
    ]);
    expect(filterActionRows(rows, 'jasa', [D1]).map((row) => row['urut_tindakan'])).toEqual(['1']);
    expect(filterActionRows(rows, 'dpjb', []).map((row) => row['urut_tindakan'])).toEqual(['3']);
  });

  it('labels the actions the way the operator log does', () => {
    expect(actionDisplayName('jasa')).toBe('jasa pelayanan');
    expect(actionDisplayName('dpjb')).toBe('dpjb');
    expect(actionDisplayName('room')).toBe('biaya ruang rawat inap');
    expect(actionDisplayName('lain')).toBe('lain');
  });

  it('lists at most ten distinct candidate names', () => {
    const master = Array.from({ length: 12 }, (_unused, index) => ({
      nama_tindakan: `JASA PELAYANAN KAT ${index}`,
    }));
    expect(actionMetaCandidates('jasa', master, [])).toHaveLength(10);
    expect(actionMetaCandidates('dpjb', MASTER_ROWS, [])).toEqual(['DOKTER DPJB']);
    expect(actionMetaCandidates('lain', MASTER_ROWS, [])).toEqual([]);
  });
});

describe('scoreRoomChargeMeta / pickTindakanMeta', () => {
  it('scores class match, segment hits, longest segment and token overlap', () => {
    expect(scoreRoomChargeMeta({ nama_tindakan: 'BIAYA LABORATORIUM' }, ROOM_NAME)).toEqual([
      -1, -1, -1, -1, '',
    ]);
    expect(
      scoreRoomChargeMeta(
        { kd_tindakan: 'RM3', nama_tindakan: 'BIAYA KAMAR AL FAJR KELAS 3' },
        ROOM_NAME,
      ),
    ).toEqual([1, 1, 'AL FAJR KELAS 3'.length, 3, 'RM3']);
  });

  it('prefers the room charge that matches the ward class', () => {
    const master: LegacyRow[] = [
      { kd_tindakan: 'RM1', nama_tindakan: 'BIAYA KAMAR AL FAJR KELAS 1', harga: '450000' },
      { kd_tindakan: 'RM3', nama_tindakan: 'BIAYA KAMAR AL FAJR KELAS 3', harga: '250000' },
    ];
    expect(
      pickTindakanMeta(master, [], { roomCharge: true, roomName: ROOM_NAME })?.['kd_tindakan'],
    ).toBe('RM3');
  });

  it('prefers an ISOLASI room charge for an isolation ward', () => {
    const master: LegacyRow[] = [
      { kd_tindakan: 'RM3', nama_tindakan: 'BIAYA KAMAR AL FAJR KELAS 3', harga: '250000' },
      { kd_tindakan: 'RMI', nama_tindakan: 'BIAYA KAMAR ISOLASI', harga: '400000' },
    ];
    expect(
      pickTindakanMeta(master, [], { roomCharge: true, roomName: 'AL FAJR / ISOLASI' })?.[
        'kd_tindakan'
      ],
    ).toBe('RMI');
  });

  it('prefers the categorised jasa for a bersalin ward on a numbered class', () => {
    const master: LegacyRow[] = [
      { kd_tindakan: 'JS0', nama_tindakan: 'JASA PELAYANAN', harga: '50000' },
      { kd_tindakan: 'JS2', nama_tindakan: 'JASA PELAYANAN KAT 2', harga: '60000' },
    ];
    expect(
      pickTindakanMeta(master, [], {
        exactName: 'JASA PELAYANAN',
        roomName: 'RUANG BERSALIN KELAS 2',
        preferredRoomClass: 'KELAS 2',
      })?.['kd_tindakan'],
    ).toBe('JS2');
    // Any other ward takes the plain name first.
    expect(
      pickTindakanMeta(master, [], {
        exactName: 'JASA PELAYANAN',
        roomName: ROOM_NAME,
        preferredRoomClass: 'KELAS 3',
      })?.['kd_tindakan'],
    ).toBe('JS0');
  });

  it('prefers list rows over master rows for jasa', () => {
    const list: LegacyRow[] = [{ kd_tindakan: 'JSL', nama_tindakan: 'JASA PELAYANAN', harga: '1' }];
    expect(
      pickTindakanMeta(MASTER_ROWS, list, { exactName: 'JASA PELAYANAN' })?.['kd_tindakan'],
    ).toBe('JSL');
  });

  it('takes DPJB and the exact-name fallback from the master first', () => {
    expect(pickTindakanMeta(MASTER_ROWS, [], { exactName: 'DOKTER DPJB' })?.['kd_tindakan']).toBe(
      'DP1',
    );
    expect(
      pickTindakanMeta([], [{ kd_tindakan: 'V1', nama_tindakan: 'VISITE DOKTER SPESIALIS' }], {
        exactName: 'VISITE DOKTER SPESIALIS',
      })?.['kd_tindakan'],
    ).toBe('V1');
    expect(pickTindakanMeta(MASTER_ROWS, [], { exactName: 'TIDAK ADA' })).toBeUndefined();
  });

  it('honours the preferred kd then the preferred name in the verifikator fallback', () => {
    const master: LegacyRow[] = [
      { kd_tindakan: 'A', nama_tindakan: 'BIAYA KAMAR AL FAJR KELAS 1' },
      { kd_tindakan: 'B', nama_tindakan: 'BIAYA KAMAR AL FAJR KELAS 3' },
    ];
    expect(pickVerifikatorRoomMeta(master, { kd_tindakan: 'A' })?.['kd_tindakan']).toBe('A');
    expect(
      pickVerifikatorRoomMeta(master, { nama_tindakan: 'BIAYA KAMAR AL FAJR KELAS 3' })?.[
        'kd_tindakan'
      ],
    ).toBe('B');
    expect(pickVerifikatorRoomMeta(master, {}, ROOM_NAME)?.['kd_tindakan']).toBe('B');
    expect(pickVerifikatorRoomMeta([], { kd_tindakan: 'A' })).toBeUndefined();
  });
});

describe('komponen and pelaksana helpers', () => {
  const jasaRow: LegacyRow = { nama_tindakan: 'JASA PELAYANAN', kd_tindakan: 'JS1' };

  it('reads the first usable paramedis name, tri-state', () => {
    expect(getKomponenParamedisName(jasaRow, () => [], '98')).toBeUndefined();
    expect(
      getKomponenParamedisName(jasaRow, () => [{ kd_komponen: '98', nama_paramedis: '-' }], '98'),
    ).toBe('');
    expect(
      getKomponenParamedisName(
        jasaRow,
        () => [
          { kd_komponen: '98', nama_paramedis: 'None' },
          { kd_komponen: '98', nama_paramedis: 'PERAWAT AL FAJR' },
        ],
        '98',
      ),
    ).toBe('PERAWAT AL FAJR');
  });

  it('picks the jasa component that carries the performer', () => {
    const komponen: KomponenRowsProvider = () => [
      { kd_komponen: '11', nama_komponentarif: 'SARANA' },
      { kd_komponen: '98', nama_komponentarif: 'JASA PELAYANAN', nama_paramedis: 'PERAWAT X' },
    ];
    expect(resolveJasaPelaksanaComponent(jasaRow, komponen)['kd_komponen']).toBe('98');
    expect(resolveJasaPelaksanaComponent(jasaRow, () => [])).toEqual({});
  });

  it('prefers the BHP component for oxygen, then any coded component', () => {
    expect(
      resolveOksigenPelaksanaComponent({}, () => [
        { kd_komponen: '11', nama_komponentarif: 'SARANA' },
        { kd_komponen: '41', nama_komponentarif: 'BHP ALAT' },
      ]),
    ).toBe('41');
    expect(
      resolveOksigenPelaksanaComponent({}, () => [{ kd_komponen: '11', nama_komponentarif: 'SARANA' }]),
    ).toBe('11');
    expect(resolveOksigenPelaksanaComponent({}, () => [])).toBe('');
  });

  it('decides "already correct" for both a wanted and a blank pelaksana', () => {
    const withName: KomponenRowsProvider = () => [
      { kd_komponen: '98', nama_paramedis: 'PERAWAT AL FAJR' },
    ];
    const blank: KomponenRowsProvider = () => [{ kd_komponen: '98', nama_paramedis: '' }];
    expect(isPelaksanaAlreadyCorrect(jasaRow, withName, ROOM_PELAKSANA, '98')).toEqual({
      alreadyCorrect: true,
      currentName: 'PERAWAT AL FAJR',
    });
    expect(isPelaksanaAlreadyCorrect(jasaRow, blank, ROOM_PELAKSANA, '98').alreadyCorrect).toBe(false);
    expect(isPelaksanaAlreadyCorrect(jasaRow, blank, '', '98').alreadyCorrect).toBe(true);
    expect(isPelaksanaAlreadyCorrect(jasaRow, () => [], '', '98')).toEqual({
      alreadyCorrect: false,
      currentName: '',
    });
  });

  it('gates the generic ward sweep on the blocked and include token lists', () => {
    const options = { roomPelaksana: ROOM_PELAKSANA, komponenRows: () => [] };
    expect(isGenericRoomPelaksanaCandidate({ nama_tindakan: 'PEMASANGAN NGT' }, options)).toBe(true);
    expect(isGenericRoomPelaksanaCandidate({ nama_tindakan: 'BIAYA OBAT' }, options)).toBe(false);
    expect(isGenericRoomPelaksanaCandidate({ nama_tindakan: 'BHP OKSIGEN' }, options)).toBe(false);
    expect(isGenericRoomPelaksanaCandidate({ nama_tindakan: 'JASA PELAYANAN' }, options)).toBe(false);
    expect(isGenericRoomPelaksanaCandidate({ nama_tindakan: 'VISITE DOKTER SPESIALIS' }, options)).toBe(
      false,
    );
    expect(isGenericRoomPelaksanaCandidate({ nama_tindakan: 'PEMASANGAN NGT' }, {})).toBe(false);
  });

  it('re-points an untokenised action only when another known ward nurse holds it', () => {
    const held = (name: string): KomponenRowsProvider => () => [
      { kd_komponen: '98', nama_paramedis: name },
    ];
    const base = {
      roomPelaksana: ROOM_PELAKSANA,
      roomPelaksanaOptionNames: ['PERAWAT AL KAUTSAR', 'PERAWAT AL FAJR'],
    };
    expect(
      isGenericRoomPelaksanaCandidate(
        { nama_tindakan: 'RAWAT LUKA SEDANG' },
        { ...base, komponenRows: held('PERAWAT AL KAUTSAR') },
      ),
    ).toBe(true);
    expect(
      isGenericRoomPelaksanaCandidate(
        { nama_tindakan: 'RAWAT LUKA SEDANG' },
        { ...base, komponenRows: held('dr. BUDI') },
      ),
    ).toBe(false);
    expect(
      isGenericRoomPelaksanaCandidate(
        { nama_tindakan: 'RAWAT LUKA SEDANG' },
        { ...base, komponenRows: held(ROOM_PELAKSANA) },
      ),
    ).toBe(false);
  });

  it('snaps a desired name to the dropdown spelling', () => {
    const options: LegacyRow[] = [
      { nama_paramedis: 'PERAWAT AL FAJR' },
      { nama_paramedis: 'dr. BUDI SANTOSO, Sp.PD' },
    ];
    expect(resolveExactParamedisName('perawat al fajr', options)).toBe('PERAWAT AL FAJR');
    expect(resolveExactParamedisName('TIDAK ADA', options)).toBe('TIDAK ADA');
    expect(resolveExactParamedisName('', options)).toBe('');
    expect(resolveExactParamedisName('PERAWAT AL FAJR', [])).toBe('PERAWAT AL FAJR');
  });

  it('picks an intermediate paramedis that is not excluded', () => {
    const options: LegacyRow[] = [{ nama_paramedis: 'PERAWAT AL FAJR' }, { nama_paramedis: 'BIDAN A' }];
    expect(pickIntermediateParamedisName(options, ['PERAWAT AL FAJR'])).toBe('BIDAN A');
    expect(pickIntermediateParamedisName(options)).toBe('PERAWAT AL FAJR');
    expect(pickIntermediateParamedisName([], ['x'])).toBe('');
  });

  it('buckets the specialist charges, SCN before the general visite', () => {
    expect(getSpesialisActionKey({ nama_tindakan: 'VISITE DR ANAK SCN' })).toBe('visite_scn');
    expect(getSpesialisActionKey({ nama_tindakan: 'VISITE DOKTER SPESIALIS' })).toBe('visite');
    expect(
      getSpesialisActionKey({ nama_tindakan: 'KONSULTASI DOKTER SPESIALIS LEWAT TELEPON' }),
    ).toBe('konsultasi');
    expect(getSpesialisActionKey({ nama_tindakan: 'BIAYA OBAT' })).toBe('');
  });
});

describe('delete gating', () => {
  it('blocks on flag, verifikasi, status bayar and jenis pembayaran hints', () => {
    expect(rowAllowsDeleteByHint({})).toBe(true);
    expect(rowAllowsDeleteByHint({ flag: '1' })).toBe(false);
    expect(rowAllowsDeleteByHint({ status_verifikasi: '1' })).toBe(false);
    expect(rowAllowsDeleteByHint({ status_verifikasi: 'False' })).toBe(true);
    expect(rowAllowsDeleteByHint({ status_bayar: 'SUDAH BAYAR' })).toBe(false);
    expect(rowAllowsDeleteByHint({ status_bayar: 'BELUM BAYAR' })).toBe(true);
    expect(rowAllowsDeleteByHint({ nama_jenispembayaran: 'TUNAI' })).toBe(false);
    expect(rowAllowsDeleteByHint({ jenis_bayar: '-' })).toBe(true);
  });

  it('refuses the protected charges first of all', () => {
    expect(bolehHapusTindakan({ nama_tindakan: 'BIAYA LABORATORIUM' })).toBe(
      'tindakan dilindungi dan tidak boleh dihapus',
    );
    expect(bolehHapusTindakan({ nama_tindakan: 'BHP OKSIGEN' })).toBe(
      'tindakan dilindungi dan tidak boleh dihapus',
    );
    expect(bolehHapusTindakan({ nama_tindakan: 'BIAYA UGD LEVEL 1' })).toBe(
      'tindakan dilindungi dan tidak boleh dihapus',
    );
  });

  it('allows a clean row and consults cekstatusbayar only when the hint is unclear', () => {
    expect(bolehHapusTindakan(roomCharge(D1, '1'))).toBe('');
    expect(bolehHapusTindakan(roomCharge(D1, '1', '08:00:00', { status: '2' }))).toBe(
      'status bayar tindakan belum bisa dipastikan (butuh cekstatusbayar_tindakan)',
    );
    expect(
      bolehHapusTindakan(roomCharge(D1, '1', '08:00:00', { status: '2' }), {
        statusBayarTindakan: () => '1',
      }),
    ).toBe('sudah bayar / verifikasi');
    expect(
      bolehHapusTindakan(roomCharge(D1, '1', '08:00:00', { status: '2' }), {
        statusBayarTindakan: () => '',
      }),
    ).toBe('');
  });
});

describe('rekapitulasi HTML parsers', () => {
  it('finds a jasa row whose pelaksana is printed twice', () => {
    const html = `
      <tr><td><b>${D1}</b></td><td><b>JASA PELAYANAN / KELAS 3 / PERAWAT A / PERAWAT A</b></td></tr>
      <tr><td><b>${D1}</b></td><td><b>JASA PELAYANAN / KELAS 3 / PERAWAT A / PERAWAT B</b></td></tr>
      <tr><td><b>${D1}</b></td><td><b>JASA PELAYANAN / PERAWAT A</b></td></tr>`;
    expect(getMalformedRekapJasaDates(html)).toEqual([
      {
        date: D1,
        text: 'JASA PELAYANAN / KELAS 3 / PERAWAT A / PERAWAT A',
        pelaksana: 'PERAWAT A',
      },
    ]);
    expect(getMalformedRekapJasaDates(undefined)).toEqual([]);
  });

  it('finds a room charge that should never carry a pelaksana', () => {
    const html = `
      <tr><td><b>${D2}</b></td><td><b>BIAYA KAMAR AL FAJR KELAS 3 / PERAWAT A</b></td></tr>
      <tr><td><b>${D2}</b></td><td><b>BIAYA LABORATORIUM / PETUGAS LAB</b></td></tr>
      <tr><td><b>${D2}</b></td><td><b>BIAYA KAMAR AL FAJR KELAS 3</b></td></tr>`;
    expect(getMalformedRekapRoomChargeDates(html)).toEqual([
      {
        date: D2,
        text: 'BIAYA KAMAR AL FAJR KELAS 3 / PERAWAT A',
        pelaksana: 'PERAWAT A',
      },
    ]);
    expect(getMalformedRekapRoomChargeDates('')).toEqual([]);
  });
});

describe('pelaksanaHarga', () => {
  it('sends the line total: SIMRS divides tampung_pelaksana harga by qty (live 2026-10-27)', async () => {
    const { pelaksanaHarga } = await import('./tindakanSync.js');
    expect(pelaksanaHarga({ harga: '7500', qty: '2', jumlah: 15000 })).toBe('15000');
    expect(pelaksanaHarga({ harga: '15000', qty: '2' })).toBe('30000');
    expect(pelaksanaHarga({ harga: '15000', qty: '1', jumlah: 15000 })).toBe('15000');
    expect(pelaksanaHarga({ harga: '70000' })).toBe('70000');
    expect(pelaksanaHarga({ harga: '' })).toBe('');
  });
});
