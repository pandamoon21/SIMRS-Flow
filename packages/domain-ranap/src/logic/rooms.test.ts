import { describe, expect, it } from 'vitest';

import {
  buildRoomDayAssignments,
  buildRoomOwnerByDate,
  enrichRoomRowsWithActivityWindows,
  getRoomActivityWindow,
  getRoomGroupDateRange,
  getRoomRowsDateBounds,
  groupRowsByDate,
  groupRowsByDateAndPelaksana,
  groupRowsByPelaksana,
  normalizeRoomStays,
  pickRoomRowForDate,
} from './rooms.js';
import type { LegacyRow } from './types.js';

/** A room row as `gethistorykunjungan`/`get_dataruangperawatan` returns one. */
function room(noTransaksi: string, overrides: LegacyRow = {}): LegacyRow {
  return {
    no_transaksi: noTransaksi,
    no_registrasikunjungan: 'RG26030001',
    kd_unit: 'RI',
    kd_kamarperawatan: 'K01',
    ...overrides,
  };
}

const WARD_3 = 'AL FAJR KELAS 3';
const WARD_2 = 'AL KAUTSAR KELAS 2';

/** One stay, one ward, clean timestamps. */
const SINGLE_STAY: LegacyRow[] = [
  room('T1', {
    nama_unit: WARD_3,
    urut_masuk_ruang: '1',
    tgl_masuk: '2026-03-01 08:00:00',
    tgl_keluar: '2026-03-03 10:00:00',
  }),
];

/** Ward, then a transfer to a higher class — no overlap. */
const SEQUENTIAL_STAYS: LegacyRow[] = [
  room('T1', {
    nama_unit: WARD_3,
    urut_masuk_ruang: '1',
    tgl_masuk: '2026-03-01 08:00:00',
    tgl_keluar: '2026-03-03 10:00:00',
  }),
  room('T2', {
    nama_unit: WARD_2,
    urut_masuk_ruang: '2',
    tgl_masuk: '2026-03-03 10:00:00',
    tgl_keluar: '2026-03-05 12:00:00',
  }),
];

/**
 * Ward → ICU → back to the ward, with the ward row still claiming the whole
 * admission. Both ICU part-days are contested.
 */
const ICU_EXCURSION: LegacyRow[] = [
  room('T1', {
    nama_unit: WARD_3,
    urut_masuk_ruang: '1',
    tgl_masuk: '2026-03-01 08:00:00',
    tgl_keluar: '2026-03-05 10:00:00',
  }),
  room('T2', {
    nama_unit: 'ICU',
    urut_masuk_ruang: '2',
    tgl_masuk: '2026-03-02 20:00:00',
    tgl_keluar: '2026-03-03 06:00:00',
  }),
  room('T3', {
    nama_unit: WARD_3,
    urut_masuk_ruang: '3',
    tgl_masuk: '2026-03-03 06:00:00',
    tgl_keluar: '2026-03-05 10:00:00',
  }),
];

describe('getRoomActivityWindow', () => {
  it('has no window without both transaction ids', () => {
    expect(getRoomActivityWindow({ no_registrasikunjungan: 'RG26030001' })).toEqual({
      start: null,
      end: null,
    });
    expect(getRoomActivityWindow({ no_transaksi: 'T1' })).toEqual({ start: null, end: null });
  });

  it('has no window when there are no tindakan rows', () => {
    expect(getRoomActivityWindow(room('T1'))).toEqual({ start: null, end: null });
    expect(getRoomActivityWindow(room('T1'), { activityRows: () => [] })).toEqual({
      start: null,
      end: null,
    });
  });

  it('lets jasa/dpjb/room charges define both ends, ignoring everything else', () => {
    const window = getRoomActivityWindow(room('T1'), {
      activityRows: () => [
        { nama_tindakan: 'BIAYA LABORATORIUM DARAH', tgl_jam: '2026-03-01 06:00:00' },
        { nama_tindakan: 'JASA PELAYANAN KAT 3', tgl_jam: '2026-03-01 09:30:00' },
        { nama_tindakan: 'BIAYA KAMAR KELAS 3', tgl_jam: '2026-03-03 07:00:00' },
        { nama_tindakan: 'BIAYA RADIOLOGI THORAX', tgl_jam: '2026-03-04 12:00:00' },
      ],
    });
    expect(window.start).toEqual(new Date(2026, 2, 1, 9, 30, 0));
    expect(window.end).toEqual(new Date(2026, 2, 3, 7, 0, 0));
  });

  it('falls back to every timestamped row when none is preferred', () => {
    const window = getRoomActivityWindow(room('T1'), {
      activityRows: () => [
        { nama_tindakan: 'BIAYA LABORATORIUM DARAH', tgl_jam: '2026-03-01 06:00:00' },
        { nama_tindakan: 'BIAYA RADIOLOGI THORAX', tgl_transaksi: '2026-03-04 12:00:00' },
        { nama_tindakan: 'BIAYA LABORATORIUM URINE', tgl_jam: 'tidak terbaca' },
      ],
    });
    expect(window.start).toEqual(new Date(2026, 2, 1, 6, 0, 0));
    expect(window.end).toEqual(new Date(2026, 2, 4, 12, 0, 0));
  });

  it('reads tindakan rows attached to the room row itself', () => {
    const window = getRoomActivityWindow(
      room('T1', { _list_tindakan: { rows: [{ nama_tindakan: 'DOKTER DPJP', tgl_jam: '2026-03-02 11:00:00' }] } }),
    );
    expect(window.start).toEqual(new Date(2026, 2, 2, 11, 0, 0));
    expect(window.end).toEqual(new Date(2026, 2, 2, 11, 0, 0));
  });
});

describe('enrichRoomRowsWithActivityWindows', () => {
  it('normalises a bare admission date to midnight without touching the input', () => {
    const input = room('T1', { tgl_masuk: '2026-03-01', tgl_keluar: '2026-03-02' });
    const [enriched] = enrichRoomRowsWithActivityWindows([input]);
    expect(enriched?.['_actual_tgl_masuk']).toBe('2026-03-01 00:00:00');
    expect(enriched?.['_actual_tgl_keluar']).toBe('2026-03-02 00:00:00');
    expect(input['_actual_tgl_masuk']).toBeUndefined();
  });

  it('prefers the observed window when the declared one carries no time of day', () => {
    const [enriched] = enrichRoomRowsWithActivityWindows(
      [room('T1', { tgl_masuk: '2026-03-01', tgl_keluar: '2026-03-03' })],
      {
        activityRows: () => [
          { nama_tindakan: 'JASA PELAYANAN KAT 3', tgl_jam: '2026-03-01 09:30:00' },
          { nama_tindakan: 'BIAYA KAMAR KELAS 3', tgl_jam: '2026-03-03 07:00:00' },
        ],
      },
    );
    expect(enriched?.['_actual_tgl_masuk']).toBe('2026-03-01 09:30:00');
    expect(enriched?.['_actual_tgl_keluar']).toBe('2026-03-03 07:00:00');
  });

  it('keeps a declared window that is already better than the observed one', () => {
    const [enriched] = enrichRoomRowsWithActivityWindows(
      [room('T1', { tgl_masuk: '2026-03-01 08:00:00', tgl_keluar: '2026-03-05 10:00:00' })],
      { activityRows: () => [{ nama_tindakan: 'BIAYA KAMAR KELAS 3', tgl_jam: '2026-03-03 07:00:00' }] },
    );
    expect(enriched?.['_actual_tgl_masuk']).toBe('2026-03-01 08:00:00');
    expect(enriched?.['_actual_tgl_keluar']).toBe('2026-03-05 10:00:00');
  });

  it('discards a discharge stamped at or before the admission', () => {
    const [enriched] = enrichRoomRowsWithActivityWindows(
      [room('T1', { tgl_masuk: '2026-03-01 08:00:00', tgl_keluar: '2026-03-01 06:00:00' })],
      { activityRows: () => [{ nama_tindakan: 'BIAYA KAMAR KELAS 3', tgl_jam: '2026-03-03 07:00:00' }] },
    );
    expect(enriched?.['_actual_tgl_keluar']).toBe('2026-03-03 07:00:00');
  });

  it('never overwrites an _actual_* value set by an earlier pass', () => {
    const [enriched] = enrichRoomRowsWithActivityWindows([
      room('T1', {
        _actual_tgl_masuk: '2026-03-01 08:00:00',
        _actual_tgl_keluar: '2026-03-03 10:00:00',
        tgl_masuk: '2026-02-28 07:00:00',
        tgl_keluar: '2026-03-09 09:00:00',
      }),
    ]);
    expect(enriched?.['_actual_tgl_masuk']).toBe('2026-03-01 08:00:00');
    expect(enriched?.['_actual_tgl_keluar']).toBe('2026-03-03 10:00:00');
  });
});

describe('normalizeRoomStays', () => {
  it('keeps a clean single stay as declared', () => {
    const [stay] = normalizeRoomStays(SINGLE_STAY);
    expect(stay?._actual_tgl_masuk).toBe('2026-03-01 08:00:00');
    expect(stay?._actual_tgl_keluar).toBe('2026-03-03 10:00:00');
    expect(stay?._urut_masuk_ruang).toBe(1);
    expect(stay?._start_dt).toEqual(new Date(2026, 2, 1, 8, 0, 0));
    expect(stay?._end_dt).toEqual(new Date(2026, 2, 3, 10, 0, 0));
  });

  it('closes a still-admitted stay at the end of its admission day', () => {
    const [stay] = normalizeRoomStays([
      room('T1', { nama_unit: WARD_3, urut_masuk_ruang: '1', tgl_masuk: '2026-03-10 09:00:00' }),
    ]);
    expect(stay?._actual_tgl_keluar).toBe('2026-03-10 23:59:59');
  });

  it('bridges a still-admitted stay forward to the next admission', () => {
    const stays = normalizeRoomStays([
      room('T1', { nama_unit: WARD_3, urut_masuk_ruang: '1', tgl_masuk: '2026-03-10 09:00:00' }),
      room('T2', {
        nama_unit: WARD_2,
        urut_masuk_ruang: '2',
        tgl_masuk: '2026-03-12 08:00:00',
        tgl_keluar: '2026-03-13 10:00:00',
      }),
    ]);
    expect(stays[0]?._actual_tgl_keluar).toBe('2026-03-12 08:00:00');
    expect(stays[1]?._actual_tgl_keluar).toBe('2026-03-13 10:00:00');
  });

  it('clamps a discharge that runs past the next admission', () => {
    const stays = normalizeRoomStays(ICU_EXCURSION);
    expect(stays.map((stay) => [stay._actual_tgl_masuk, stay._actual_tgl_keluar])).toEqual([
      ['2026-03-01 08:00:00', '2026-03-02 20:00:00'],
      ['2026-03-02 20:00:00', '2026-03-03 06:00:00'],
      ['2026-03-03 06:00:00', '2026-03-05 10:00:00'],
    ]);
  });

  it('orders by urut_masuk_ruang before dates, pushing a contradicting start forward', () => {
    const stays = normalizeRoomStays([
      room('T2', {
        nama_unit: WARD_2,
        urut_masuk_ruang: '2',
        tgl_masuk: '2026-03-01 07:00:00',
        tgl_keluar: '2026-03-02 09:00:00',
      }),
      room('T1', {
        nama_unit: WARD_3,
        urut_masuk_ruang: '1',
        tgl_masuk: '2026-03-05 08:00:00',
        tgl_keluar: '2026-03-06 10:00:00',
      }),
    ]);
    expect(stays.map((stay) => stay['no_transaksi'])).toEqual(['T1', 'T2']);
    // Five whole days, until T2 starts strictly after T1.
    expect(stays[1]?.['_shifted_start_days']).toBe(5);
    expect(stays[1]?._actual_tgl_masuk).toBe('2026-03-06 07:00:00');
    // T1 is clamped to the shifted start; T2 has nothing after it, so it runs to
    // the end of its (new) admission day.
    expect(stays[0]?._actual_tgl_keluar).toBe('2026-03-06 07:00:00');
    expect(stays[1]?._actual_tgl_keluar).toBe('2026-03-06 23:59:59');
  });

  it('parks rows without urut_masuk_ruang behind the rows that declare one', () => {
    const stays = normalizeRoomStays([
      room('T1', { nama_unit: WARD_3, tgl_masuk: '2026-03-01 08:00:00', tgl_keluar: '2026-03-02 09:00:00' }),
      room('T2', {
        nama_unit: WARD_2,
        urut_masuk_ruang: '1',
        tgl_masuk: '2026-03-02 08:00:00',
        tgl_keluar: '2026-03-03 10:00:00',
      }),
    ]);
    expect(stays.map((stay) => stay['no_transaksi'])).toEqual(['T2', 'T1']);
    expect(stays[1]?.['_shifted_start_days']).toBe(2);
    expect(stays[1]?._actual_tgl_masuk).toBe('2026-03-03 08:00:00');
  });

  it('bridges a same-day stay to a next admission the shift pushed away', () => {
    const stays = normalizeRoomStays([
      room('T1', {
        nama_unit: WARD_3,
        urut_masuk_ruang: '1',
        tgl_masuk: '2026-03-05 08:00:00',
        tgl_keluar: '2026-03-05 12:00:00',
      }),
      room('T2', {
        nama_unit: WARD_2,
        urut_masuk_ruang: '2',
        tgl_masuk: '2026-03-01 07:00:00',
        tgl_keluar: '2026-03-01 09:00:00',
      }),
    ]);
    // Without the bridge rule T1 would still end at 12:00 on its admission day.
    expect(stays[0]?._actual_tgl_keluar).toBe('2026-03-06 07:00:00');
    expect(stays[1]?._actual_tgl_masuk).toBe('2026-03-06 07:00:00');
  });

  it('drops rows with no readable admission and leaves the input untouched', () => {
    const rows = [
      room('T1', { nama_unit: WARD_3, tgl_masuk: '', tgl_keluar: '2026-03-02 09:00:00' }),
      room('T2', { nama_unit: WARD_3, tgl_masuk: 'tidak terbaca' }),
      room('T3', { nama_unit: WARD_3, tgl_masuk: '2026-03-01 08:00:00' }),
    ];
    const stays = normalizeRoomStays(rows);
    expect(stays.map((stay) => stay['no_transaksi'])).toEqual(['T3']);
    expect(rows.every((row) => row['_start_dt'] === undefined)).toBe(true);
  });
});

describe('buildRoomDayAssignments', () => {
  it('gives every day of a single stay to that room', () => {
    expect(buildRoomDayAssignments(SINGLE_STAY)).toEqual({
      T1: ['2026-03-01', '2026-03-02', '2026-03-03'],
    });
  });

  it('returns an empty map for an empty group', () => {
    expect(buildRoomDayAssignments([])).toEqual({});
    expect(buildRoomDayAssignments([room('T1', { tgl_masuk: '' })])).toEqual({});
  });

  it('splits a transfer day by occupancy once the three-hour band is exceeded', () => {
    expect(buildRoomDayAssignments(SEQUENTIAL_STAYS)).toEqual({
      T1: ['2026-03-01', '2026-03-02'],
      T2: ['2026-03-03', '2026-03-04', '2026-03-05'],
    });
  });

  it('gives a shared day to the critical-care room however short the stay', () => {
    // 03-02: ward holds 20h, ICU holds 4h — ICU still wins on priority rank.
    // 03-03: ICU holds 6h, ward holds 18h — ICU wins again.
    expect(buildRoomDayAssignments(ICU_EXCURSION)).toEqual({
      T1: ['2026-03-01'],
      T2: ['2026-03-02', '2026-03-03'],
      T3: ['2026-03-04', '2026-03-05'],
    });
  });

  it('ranks isolation above an ordinary ward and critical care above isolation', () => {
    const isolationOverWard = buildRoomDayAssignments([
      room('T1', {
        nama_unit: WARD_3,
        urut_masuk_ruang: '1',
        tgl_masuk: '2026-03-01 08:00:00',
        tgl_keluar: '2026-03-02 20:00:00',
      }),
      room('T2', {
        nama_unit: 'ISOLASI COVID',
        urut_masuk_ruang: '2',
        tgl_masuk: '2026-03-02 20:00:00',
        tgl_keluar: '2026-03-04 10:00:00',
      }),
    ]);
    expect(isolationOverWard).toEqual({
      T1: ['2026-03-01'],
      T2: ['2026-03-02', '2026-03-03', '2026-03-04'],
    });

    const icuOverIsolation = buildRoomDayAssignments([
      room('T1', {
        nama_unit: 'ISOLASI COVID',
        urut_masuk_ruang: '1',
        tgl_masuk: '2026-03-01 08:00:00',
        tgl_keluar: '2026-03-02 20:00:00',
      }),
      room('T2', {
        nama_unit: 'ICU',
        urut_masuk_ruang: '2',
        tgl_masuk: '2026-03-02 20:00:00',
        tgl_keluar: '2026-03-03 06:00:00',
      }),
    ]);
    expect(icuOverIsolation).toEqual({ T1: ['2026-03-01'], T2: ['2026-03-02', '2026-03-03'] });
  });

  it('bills a still-admitted stay up to the day it is bridged to', () => {
    expect(
      buildRoomDayAssignments([
        room('T1', { nama_unit: WARD_3, urut_masuk_ruang: '1', tgl_masuk: '2026-03-10 09:00:00' }),
      ]),
    ).toEqual({ T1: ['2026-03-10'] });

    expect(
      buildRoomDayAssignments([
        room('T1', { nama_unit: WARD_3, urut_masuk_ruang: '1', tgl_masuk: '2026-03-10 09:00:00' }),
        room('T2', {
          nama_unit: WARD_2,
          urut_masuk_ruang: '2',
          tgl_masuk: '2026-03-12 08:00:00',
          tgl_keluar: '2026-03-13 10:00:00',
        }),
      ]),
    ).toEqual({
      T1: ['2026-03-10', '2026-03-11'],
      T2: ['2026-03-12', '2026-03-13'],
    });
  });

  it('bills only the admission day when the discharge is a bare date', () => {
    // A midnight discharge leaves zero seconds on its own date, and the boundary
    // fallback refuses to claim a day with no occupancy.
    expect(
      buildRoomDayAssignments([
        room('T1', { nama_unit: WARD_3, urut_masuk_ruang: '1', tgl_masuk: '2026-03-01', tgl_keluar: '2026-03-02' }),
      ]),
    ).toEqual({ T1: ['2026-03-01'] });
  });

  it('follows the shifted starts when urut_masuk_ruang contradicts the dates', () => {
    expect(
      buildRoomDayAssignments([
        room('T2', {
          nama_unit: WARD_2,
          urut_masuk_ruang: '2',
          tgl_masuk: '2026-03-01 07:00:00',
          tgl_keluar: '2026-03-02 09:00:00',
        }),
        room('T1', {
          nama_unit: WARD_3,
          urut_masuk_ruang: '1',
          tgl_masuk: '2026-03-05 08:00:00',
          tgl_keluar: '2026-03-06 10:00:00',
        }),
      ]),
    ).toEqual({ T1: ['2026-03-05'], T2: ['2026-03-06'] });
  });

  it('prepends the lead-in days when the anchor precedes the first admission', () => {
    const rows = [
      room('T1', {
        nama_unit: WARD_3,
        urut_masuk_ruang: '1',
        tgl_masuk: '2026-03-03 08:00:00',
        tgl_keluar: '2026-03-04 10:00:00',
      }),
    ];
    expect(buildRoomDayAssignments(rows, '2026-03-01')).toEqual({
      T1: ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'],
    });
  });

  it('ignores an anchor at or after the first admission', () => {
    const rows = [
      room('T1', {
        nama_unit: WARD_3,
        urut_masuk_ruang: '1',
        tgl_masuk: '2026-03-03 08:00:00',
        tgl_keluar: '2026-03-04 10:00:00',
      }),
    ];
    const expected = { T1: ['2026-03-03', '2026-03-04'] };
    expect(buildRoomDayAssignments(rows, '2026-03-03')).toEqual(expected);
    expect(buildRoomDayAssignments(rows, '2026-03-04')).toEqual(expected);
    expect(buildRoomDayAssignments(rows, '')).toEqual(expected);
    expect(buildRoomDayAssignments(rows)).toEqual(expected);
  });

  it('gives the lead-in days to the first stay only', () => {
    const assignments = buildRoomDayAssignments(ICU_EXCURSION, '2026-02-27');
    expect(assignments['T1']).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    expect(assignments['T2']).toEqual(['2026-03-02', '2026-03-03']);
    expect(assignments['T3']).toEqual(['2026-03-04', '2026-03-05']);
  });
});

describe('getRoomGroupDateRange', () => {
  it('spans the declared dates without repairing them', () => {
    expect(getRoomGroupDateRange(SEQUENTIAL_STAYS)).toEqual({ start: '2026-03-01', end: '2026-03-05' });
  });

  it('falls back to the other end of each row and to empty for no rows', () => {
    expect(getRoomGroupDateRange([room('T1', { tgl_keluar: '2026-03-04 10:00:00' })])).toEqual({
      start: '2026-03-04',
      end: '2026-03-04',
    });
    expect(getRoomGroupDateRange([])).toEqual({ start: '', end: '' });
    expect(getRoomGroupDateRange([room('T1')])).toEqual({ start: '', end: '' });
  });
});

describe('getRoomRowsDateBounds', () => {
  it('spans the repaired stay windows', () => {
    expect(getRoomRowsDateBounds(ICU_EXCURSION)).toEqual({ start: '2026-03-01', end: '2026-03-05' });
  });

  it('uses the end-of-day fallback for a still-admitted stay', () => {
    expect(
      getRoomRowsDateBounds([
        room('T1', { nama_unit: WARD_3, urut_masuk_ruang: '1', tgl_masuk: '2026-03-10 09:00:00' }),
      ]),
    ).toEqual({ start: '2026-03-10', end: '2026-03-10' });
  });

  it('is empty when no row has a readable admission', () => {
    expect(getRoomRowsDateBounds([room('T1', { tgl_masuk: '' })])).toEqual({ start: '', end: '' });
  });
});

describe('pickRoomRowForDate', () => {
  it('returns the room that owns the day', () => {
    expect(pickRoomRowForDate(ICU_EXCURSION, '2026-03-01')?.['no_transaksi']).toBe('T1');
    expect(pickRoomRowForDate(ICU_EXCURSION, '2026-03-03')?.['no_transaksi']).toBe('T2');
    expect(pickRoomRowForDate(ICU_EXCURSION, '2026-03-04')?.['no_transaksi']).toBe('T3');
  });

  it('falls back to the first stay for a date outside the group', () => {
    expect(pickRoomRowForDate(ICU_EXCURSION, '2026-04-01')?.['no_transaksi']).toBe('T1');
    expect(pickRoomRowForDate(ICU_EXCURSION, '')?.['no_transaksi']).toBe('T1');
  });

  it('returns undefined when the group has no usable stay', () => {
    expect(pickRoomRowForDate([], '2026-03-01')).toBeUndefined();
    expect(pickRoomRowForDate([room('T1', { tgl_masuk: '' })], '2026-03-01')).toBeUndefined();
  });

  it('hands back the normalised row, not the raw one', () => {
    const picked = pickRoomRowForDate(ICU_EXCURSION, '2026-03-02');
    expect(picked?._actual_tgl_masuk).toBe('2026-03-02 20:00:00');
    expect(picked?._actual_tgl_keluar).toBe('2026-03-03 06:00:00');
  });
});

describe('buildRoomOwnerByDate', () => {
  it('inverts a day-assignment map onto the rows as supplied', () => {
    const assignments = buildRoomDayAssignments(SEQUENTIAL_STAYS);
    const ownerByDate = buildRoomOwnerByDate(SEQUENTIAL_STAYS, assignments);
    expect(Object.keys(ownerByDate).sort()).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
    ]);
    expect(ownerByDate['2026-03-02']?.['no_transaksi']).toBe('T1');
    expect(ownerByDate['2026-03-03']?.['no_transaksi']).toBe('T2');
    expect(ownerByDate['2026-03-02']).toBe(SEQUENTIAL_STAYS[0]);
  });

  it('skips assignments whose transaction is not in the group', () => {
    expect(buildRoomOwnerByDate(SINGLE_STAY, { T9: ['2026-03-01'] })).toEqual({});
    expect(buildRoomOwnerByDate([], {})).toEqual({});
  });
});

describe('groupRowsByDate', () => {
  const rows: LegacyRow[] = [
    { nama_tindakan: 'B', tgl_jam: '2026-03-02 09:00:00', urut_tindakan: '2' },
    { nama_tindakan: 'A', tgl_jam: '2026-03-01 08:00:00', urut_tindakan: '1' },
    { nama_tindakan: 'C', tgl_transaksi: '2026-03-02 07:00:00' },
    { nama_tindakan: 'D' },
  ];

  it('buckets by date with each bucket in chronological order', () => {
    const grouped = groupRowsByDate(rows);
    expect(Object.keys(grouped)).toEqual(['2026-03-01', '2026-03-02', '']);
    expect(grouped['2026-03-01']?.map((row) => row['nama_tindakan'])).toEqual(['A']);
    expect(grouped['2026-03-02']?.map((row) => row['nama_tindakan'])).toEqual(['C', 'B']);
    expect(grouped['']?.map((row) => row['nama_tindakan'])).toEqual(['D']);
  });
});

describe('groupRowsByDateAndPelaksana', () => {
  it('keys on date and performer, preferring the pre-computed fields', () => {
    const grouped = groupRowsByDateAndPelaksana([
      { nama_tindakan: 'VISITE', tgl_jam: '2026-03-01 08:00:00', _pelaksana_key: 'DR ANDI' },
      { nama_tindakan: 'VISITE', tgl_jam: '2026-03-01 09:00:00', _pelaksana_key: 'DR BUDI' },
      { nama_tindakan: 'VISITE', tgl_jam: '2026-03-01 10:00:00', _pelaksana_key: 'DR ANDI' },
      { nama_tindakan: 'VISITE', tgl_jam: '2026-03-01 11:00:00', _row_date: '2026-03-02', _pelaksana_key: 'DR ANDI' },
      { nama_tindakan: 'BIAYA KAMAR KELAS 3', tgl_jam: '2026-03-01 12:00:00' },
    ]);
    expect(Object.keys(grouped).sort()).toEqual([
      '2026-03-01|',
      '2026-03-01|DR ANDI',
      '2026-03-01|DR BUDI',
      '2026-03-02|DR ANDI',
    ]);
    expect(grouped['2026-03-01|DR ANDI']).toHaveLength(2);
    expect(grouped['2026-03-02|DR ANDI']).toHaveLength(1);
  });
});

describe('groupRowsByPelaksana', () => {
  it('buckets on the performer key alone', () => {
    const grouped = groupRowsByPelaksana([
      { tgl_jam: '2026-03-01 08:00:00', _pelaksana_key: 'DR ANDI' },
      { tgl_jam: '2026-03-02 08:00:00', _pelaksana_key: 'DR ANDI' },
      { tgl_jam: '2026-03-02 09:00:00' },
    ]);
    expect(Object.keys(grouped)).toEqual(['DR ANDI', '']);
    expect(grouped['DR ANDI']).toHaveLength(2);
    expect(grouped['']).toHaveLength(1);
  });
});
