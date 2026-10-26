import { describe, expect, it } from 'vitest';

import {
  careClassRank,
  evaluateTitipanForRoomRow,
  extractRoomClassKey,
  extractSepClassKey,
  getTitipanKeteranganForGroup,
  normalizeCareClassKey,
  resolveSepClassKey,
} from './careClass.js';
import type { LegacyRow } from './types.js';

/** A BPJS SEP payload that entitles the patient to `kelas`. */
function sepFor(kelas: string): LegacyRow {
  return { no_sep: '1301R0110326V000123', tgl_sep: '2026-03-01', kelas_rawat: kelas };
}

const KELAS_3_ROOM: LegacyRow = {
  no_transaksi: 'RI2603010001',
  no_registrasikunjungan: 'RG26030001',
  nama_unit: 'AL FAJR KELAS 3',
  kd_kelasperawatan: '4',
};

const KELAS_1_ROOM: LegacyRow = {
  no_transaksi: 'RI2603010002',
  no_registrasikunjungan: 'RG26030001',
  nama_unit: 'MULTAZAM KELAS 1',
  kd_kelasperawatan: '2',
};

const ICU_ROOM: LegacyRow = {
  no_transaksi: 'RI2603010003',
  no_registrasikunjungan: 'RG26030001',
  nama_unit: 'ICU',
  kd_kelasperawatan: '8',
};

describe('normalizeCareClassKey', () => {
  it('folds the compact spellings of the billable ladder', () => {
    for (const value of ['3', 'III', 'kelas 3', 'KELAS III', 'Kelas_3', 'KELAS III A']) {
      expect(normalizeCareClassKey(value)).toBe('KELAS 3');
    }
    for (const value of ['2', 'II', 'kelas 2', 'KELAS II']) {
      expect(normalizeCareClassKey(value)).toBe('KELAS 2');
    }
    for (const value of ['1', 'I', 'kelas 1', 'KELAS I']) {
      expect(normalizeCareClassKey(value)).toBe('KELAS 1');
    }
    expect(normalizeCareClassKey('VIP')).toBe('VIP');
    expect(normalizeCareClassKey('vvip')).toBe('VVIP');
    expect(normalizeCareClassKey('VVP')).toBe('VVIP');
  });

  it('passes the non-billable classes through, renaming only NONKELAS', () => {
    for (const value of ['ICU', 'NICU', 'PICU', 'HCU', 'SCN', 'DELUXE', 'BERSALIN', 'ICCU']) {
      expect(normalizeCareClassKey(value)).toBe(value);
    }
    expect(normalizeCareClassKey('NON KELAS')).toBe('NON KELAS');
    expect(normalizeCareClassKey('nonkelas')).toBe('NON KELAS');
    expect(normalizeCareClassKey('ISOLASI')).toBe('ISOLASI');
  });

  it('treats any ISO* spelling as isolation', () => {
    expect(normalizeCareClassKey('ISOLASI COVID')).toBe('ISOLASI');
    expect(normalizeCareClassKey('ISO 1')).toBe('ISOLASI');
    // Reaches the `(^|\s)ISO($|\s)` probe rather than the compact prefix.
    expect(normalizeCareClassKey('RUANG ISO')).toBe('ISOLASI');
  });

  it('keeps the substring precedence that stops ICU swallowing PICU/NICU/ICCU', () => {
    expect(normalizeCareClassKey('RUANG PICU ANAK')).toBe('PICU');
    expect(normalizeCareClassKey('NICU LANTAI 2')).toBe('NICU');
    expect(normalizeCareClassKey('ICCU JANTUNG')).toBe('ICCU');
    expect(normalizeCareClassKey('RUANG ICU DEWASA')).toBe('ICU');
    expect(normalizeCareClassKey('SCN PERINATOLOGI')).toBe('SCN');
    expect(normalizeCareClassKey('VVIP MULTAZAM')).toBe('VVIP');
    expect(normalizeCareClassKey('VIP UTAMA')).toBe('VIP');
  });

  it('reads the class out of a full room label', () => {
    expect(normalizeCareClassKey('AL FAJR KELAS III')).toBe('KELAS 3');
    expect(normalizeCareClassKey('AL KAUTSAR KELAS II')).toBe('KELAS 2');
    expect(normalizeCareClassKey('KELAS I ANGGREK')).toBe('KELAS 1');
  });

  it('returns empty for anything unrecognisable', () => {
    expect(normalizeCareClassKey('')).toBe('');
    expect(normalizeCareClassKey('AL FAJR')).toBe('');
    expect(normalizeCareClassKey(null)).toBe('');
    expect(normalizeCareClassKey(undefined)).toBe('');
    expect(normalizeCareClassKey(0)).toBe('');
  });
});

describe('extractSepClassKey', () => {
  it('reads an aliased field', () => {
    expect(extractSepClassKey({ kelas_rawat: '3' })).toBe('KELAS 3');
    expect(extractSepClassKey({ hakKelas: 'Kelas 2' })).toBe('KELAS 2');
    expect(extractSepClassKey({ 'nama hak kelas': 'VIP' })).toBe('VIP');
    expect(extractSepClassKey({ kdKelas: '1' })).toBe('KELAS 1');
  });

  it('descends into nested objects and arrays', () => {
    expect(extractSepClassKey({ data: { peserta: { kelas_perawatan: 'KELAS 2' } } })).toBe('KELAS 2');
    expect(extractSepClassKey({ response: { sep: [{ kelas: 'VVIP' }] } })).toBe('VVIP');
  });

  it('takes the first field in insertion order whose value looks like a class', () => {
    // Deliberate legacy quirk: plain scalars are candidates too, so a room name
    // that happens to normalise wins over a later, correctly named field.
    expect(extractSepClassKey({ nama_ruang: 'VIP MELATI', kelas_rawat: '3' })).toBe('VIP');
    expect(extractSepClassKey({ kelas_rawat: '3', nama_ruang: 'VIP MELATI' })).toBe('KELAS 3');
  });

  it('stops descending past five levels', () => {
    expect(extractSepClassKey({ a: { b: { c: { d: { e: 'VIP' } } } } })).toBe('VIP');
    expect(extractSepClassKey({ a: { b: { c: { d: { e: { f: 'VIP' } } } } } })).toBe('');
    // An aliased field is yielded before the recursion, so it reaches one deeper.
    expect(extractSepClassKey({ a: { b: { c: { d: { e: { kelas: 'VIP' } } } } } })).toBe('VIP');
  });

  it('ignores payloads with no class-shaped value', () => {
    expect(extractSepClassKey({})).toBe('');
    expect(extractSepClassKey({ no_sep: '1301R0110326V000123', nama_pasien: 'PASIEN DUA' })).toBe('');
    expect(extractSepClassKey(undefined as unknown as LegacyRow)).toBe('');
  });
});

describe('resolveSepClassKey', () => {
  it('reports the in-hand SEP item as the source', () => {
    expect(resolveSepClassKey(sepFor('KELAS 3'))).toEqual({ key: 'KELAS 3', source: 'sep_item' });
  });

  it('falls back to the SEP detail read, then to the penjamin tab', () => {
    const sepDetail = (noSep: string): LegacyRow => ({ no_sep: noSep, kelas_rawat: 'KELAS 2' });
    const penjaminTab = (noReg: string): LegacyRow => ({ no_reg: noReg, hak_kelas: 'KELAS 1' });

    expect(resolveSepClassKey({}, '1301R0110326V000123', 'RG26030001', { sepDetail, penjaminTab })).toEqual({
      key: 'KELAS 2',
      source: 'getdata_sep_bpjs',
    });
    expect(resolveSepClassKey({}, '', 'RG26030001', { penjaminTab })).toEqual({
      key: 'KELAS 1',
      source: 'getdatapenjamin_tab',
    });
  });

  it('reports nothing when no lookup can supply a class', () => {
    expect(resolveSepClassKey({}, '1301R0110326V000123', 'RG26030001')).toEqual({ key: '', source: '' });
    expect(resolveSepClassKey({}, '', '', { sepDetail: () => ({}) })).toEqual({ key: '', source: '' });
  });
});

describe('extractRoomClassKey', () => {
  it('lets kd_kelasperawatan win over the room name', () => {
    expect(extractRoomClassKey({ kd_kelasperawatan: '4', nama_unit: 'VIP MELATI' })).toBe('KELAS 3');
    expect(extractRoomClassKey({ kd_kelasperawatan: '8' })).toBe('ICU');
    expect(extractRoomClassKey({ kd_kelasperawatan: '13' })).toBe('NON KELAS');
  });

  it('falls through the name fields in order when the code is unknown', () => {
    expect(extractRoomClassKey({ kd_kelasperawatan: '99', nama_unit: 'AL FAJR KELAS 3' })).toBe('KELAS 3');
    expect(extractRoomClassKey({ nama_unit: 'AL FAJR', nama_ruangperawatan: 'KELAS 2 BAWAH' })).toBe('KELAS 2');
    expect(extractRoomClassKey({ nama_ruangpendek: 'VVIP' })).toBe('VVIP');
    expect(extractRoomClassKey({ kd_kelas_bpjs: '1' })).toBe('KELAS 1');
  });

  it('returns empty when no field carries a class', () => {
    expect(extractRoomClassKey({ nama_unit: 'AL FAJR' })).toBe('');
    expect(extractRoomClassKey({})).toBe('');
  });
});

describe('careClassRank', () => {
  it('ranks only the billable ladder', () => {
    expect(careClassRank('KELAS 3')).toBe(1);
    expect(careClassRank('KELAS 2')).toBe(2);
    expect(careClassRank('KELAS 1')).toBe(3);
    expect(careClassRank('VIP')).toBe(4);
    expect(careClassRank('VVIP')).toBe(5);
  });

  it('scores critical care and unknowns as 0 so they are never compared', () => {
    for (const value of ['ICU', 'SCN', 'ISOLASI', 'NON KELAS', 'BERSALIN', '', null, undefined]) {
      expect(careClassRank(value)).toBe(0);
    }
  });
});

describe('evaluateTitipanForRoomRow', () => {
  it('flags TITIPAN when a KELAS 3 SEP is in a higher-class room', () => {
    const evaluation = evaluateTitipanForRoomRow({
      roomRow: KELAS_1_ROOM,
      sepItem: sepFor('KELAS 3'),
    });
    expect(evaluation).toEqual({
      isTitipan: true,
      result: 'TITIPAN',
      reason: 'sep_kelas_3_dirawat_di_kelas_lebih_tinggi',
      sepClass: 'KELAS 3',
      sepClassSource: 'sep_item',
      roomClass: 'KELAS 1',
      roomName: 'MULTAZAM KELAS 1',
    });
  });

  it('flags TITIPAN for every class above KELAS 3', () => {
    for (const [namaUnit, roomClass] of [
      ['AL KAUTSAR KELAS 2', 'KELAS 2'],
      ['MULTAZAM KELAS 1', 'KELAS 1'],
      ['VIP MELATI', 'VIP'],
      ['VVIP MULTAZAM', 'VVIP'],
    ] as const) {
      const evaluation = evaluateTitipanForRoomRow({
        roomRow: { nama_unit: namaUnit },
        sepItem: sepFor('3'),
      });
      expect([evaluation.roomClass, evaluation.result, evaluation.reason]).toEqual([
        roomClass,
        'TITIPAN',
        'sep_kelas_3_dirawat_di_kelas_lebih_tinggi',
      ]);
    }
  });

  it('reports "sesuai" when the room class matches the SEP class', () => {
    const evaluation = evaluateTitipanForRoomRow({
      roomRow: KELAS_3_ROOM,
      sepItem: sepFor('KELAS 3'),
    });
    expect(evaluation.isTitipan).toBe(false);
    expect(evaluation.result).toBe('NORMAL');
    expect(evaluation.reason).toBe('sesuai');
  });

  it('does not flag critical care, because those classes are unranked', () => {
    const evaluation = evaluateTitipanForRoomRow({
      roomRow: ICU_ROOM,
      sepItem: sepFor('KELAS 3'),
    });
    expect(evaluation.result).toBe('NORMAL');
    expect(evaluation.reason).toBe('sesuai');
    expect(evaluation.roomClass).toBe('ICU');
  });

  it('asks for a manual check when the room outranks a non-KELAS-3 SEP', () => {
    const evaluation = evaluateTitipanForRoomRow({
      roomRow: KELAS_1_ROOM,
      sepItem: sepFor('KELAS 2'),
    });
    expect(evaluation.isTitipan).toBe(false);
    expect(evaluation.result).toBe('PERLU CEK MANUAL');
    expect(evaluation.reason).toBe('kelas_rawat_di_atas_kelas_sep');
  });

  it('does not flag a room below the SEP class', () => {
    const evaluation = evaluateTitipanForRoomRow({
      roomRow: KELAS_3_ROOM,
      sepItem: sepFor('VIP'),
    });
    expect(evaluation.result).toBe('NORMAL');
    expect(evaluation.reason).toBe('sesuai');
  });

  it('flags a BYNY in an SCN room whose class differs from the SEP', () => {
    const evaluation = evaluateTitipanForRoomRow({
      roomRow: { nama_unit: 'SCN PERINATOLOGI' },
      sepItem: sepFor('KELAS 3'),
      namaPasien: 'BYNY. PASIEN DUA',
    });
    expect(evaluation.isTitipan).toBe(true);
    expect(evaluation.reason).toBe('byny_scn_beda_kelas');
    expect(evaluation.roomClass).toBe('SCN');
  });

  it('checks the BYNY/SCN rule before the KELAS 3 upgrade rule', () => {
    const evaluation = evaluateTitipanForRoomRow({
      roomRow: { nama_unit: 'SCN VIP' },
      sepItem: sepFor('KELAS 3'),
      namaPasien: 'BYNY PASIEN DUA',
    });
    expect(evaluation.roomClass).toBe('VIP');
    expect(evaluation.reason).toBe('byny_scn_beda_kelas');
  });

  it('leaves a non-BYNY patient in an SCN room alone', () => {
    const evaluation = evaluateTitipanForRoomRow({
      roomRow: { nama_unit: 'SCN PERINATOLOGI' },
      sepItem: sepFor('KELAS 3'),
      namaPasien: 'PASIEN DUA',
    });
    expect(evaluation.result).toBe('NORMAL');
    expect(evaluation.reason).toBe('sesuai');
  });

  it('leaves a BYNY in an SCN room alone when the classes match', () => {
    const evaluation = evaluateTitipanForRoomRow({
      roomRow: { nama_unit: 'SCN PERINATOLOGI' },
      sepItem: { kelas_rawat: 'SCN' },
      namaPasien: 'BYNY PASIEN DUA',
    });
    expect(evaluation.result).toBe('NORMAL');
    expect(evaluation.reason).toBe('sesuai');
  });

  it('notes a healthy newborn riding the parent SEP', () => {
    const evaluation = evaluateTitipanForRoomRow({
      roomRow: KELAS_3_ROOM,
      sepItem: sepFor('KELAS 3'),
      namaPasien: 'BYNY PASIEN DUA',
      bynyRmeStatus: { is_healthy: true },
    });
    expect(evaluation.result).toBe('NORMAL');
    expect(evaluation.reason).toBe('bayi_sehat_mengikuti_sep_orang_tua');
  });

  it('cannot evaluate an unreadable SEP class', () => {
    const evaluation = evaluateTitipanForRoomRow({ roomRow: KELAS_1_ROOM, sepItem: {} });
    expect(evaluation).toEqual({
      isTitipan: false,
      result: 'TIDAK DAPAT DIEVALUASI',
      reason: 'kelas_sep_tidak_terbaca',
      sepClass: '-',
      sepClassSource: '-',
      roomClass: 'KELAS 1',
      roomName: 'MULTAZAM KELAS 1',
    });
  });

  it('cannot evaluate an unreadable room class', () => {
    const evaluation = evaluateTitipanForRoomRow({
      roomRow: { no_transaksi: 'RI2603010009', nama_unit: 'AL FAJR' },
      sepItem: sepFor('KELAS 3'),
    });
    expect(evaluation.result).toBe('TIDAK DAPAT DIEVALUASI');
    expect(evaluation.reason).toBe('kelas_ruang_tidak_terbaca');
    expect(evaluation.roomClass).toBe('-');
    expect(evaluation.roomName).toBe('AL FAJR');
  });

  it('accepts a pre-resolved SEP class and reports where it came from', () => {
    expect(
      evaluateTitipanForRoomRow({ roomRow: KELAS_1_ROOM, sepClassKey: 'KELAS 3' }),
    ).toMatchObject({ reason: 'sep_kelas_3_dirawat_di_kelas_lebih_tinggi', sepClassSource: 'provided' });
    expect(
      evaluateTitipanForRoomRow({
        roomRow: KELAS_1_ROOM,
        sepClassKey: '3',
        sepClassSource: 'getdatapenjamin_tab',
      }),
    ).toMatchObject({ sepClass: 'KELAS 3', sepClassSource: 'getdatapenjamin_tab' });
  });

  it('uses the room row registration number as the penjamin-tab fallback key', () => {
    const seen: string[] = [];
    const evaluation = evaluateTitipanForRoomRow({
      roomRow: KELAS_1_ROOM,
      sepItem: {},
      lookups: {
        penjaminTab: (noReg) => {
          seen.push(noReg);
          return { hak_kelas: 'KELAS 3' };
        },
      },
    });
    expect(seen).toEqual(['RG26030001']);
    expect(evaluation.sepClassSource).toBe('getdatapenjamin_tab');
    expect(evaluation.reason).toBe('sep_kelas_3_dirawat_di_kelas_lebih_tinggi');
  });
});

describe('getTitipanKeteranganForGroup', () => {
  it('stamps TITIPAN when any room in the group outranks a KELAS 3 SEP', () => {
    expect(getTitipanKeteranganForGroup([KELAS_3_ROOM, KELAS_1_ROOM], sepFor('KELAS 3'))).toBe('TITIPAN');
  });

  it('stays empty when every room matches the SEP class', () => {
    expect(getTitipanKeteranganForGroup([KELAS_3_ROOM, KELAS_3_ROOM], sepFor('KELAS 3'))).toBe('');
  });

  it('stays empty for a critical-care room, and for a rank-only mismatch', () => {
    expect(getTitipanKeteranganForGroup([ICU_ROOM], sepFor('KELAS 3'))).toBe('');
    // The rank comparison is a `PERLU CEK MANUAL` in the per-row evaluation but
    // never produces a group keterangan.
    expect(getTitipanKeteranganForGroup([KELAS_1_ROOM], sepFor('KELAS 2'))).toBe('');
  });

  it('stamps TITIPAN for a BYNY in an SCN room of a different class', () => {
    expect(
      getTitipanKeteranganForGroup([{ nama_unit: 'SCN PERINATOLOGI' }], sepFor('KELAS 3'), {
        namaPasien: 'BYNY PASIEN DUA',
      }),
    ).toBe('TITIPAN');
    expect(
      getTitipanKeteranganForGroup([{ nama_unit: 'SCN PERINATOLOGI' }], sepFor('KELAS 3')),
    ).toBe('');
  });

  it('stays empty when the SEP class is unreadable', () => {
    expect(getTitipanKeteranganForGroup([KELAS_1_ROOM], {})).toBe('');
  });

  it('skips rows with no room name or no room class', () => {
    expect(
      getTitipanKeteranganForGroup([{ nama_unit: '', kd_kelasperawatan: '2' }, { nama_unit: 'AL FAJR' }], sepFor('3')),
    ).toBe('');
  });

  it('resolves the SEP class through the group registration number', () => {
    const seen: string[] = [];
    const keterangan = getTitipanKeteranganForGroup([KELAS_1_ROOM], {}, {
      lookups: {
        penjaminTab: (noReg) => {
          seen.push(noReg);
          return { hak_kelas: '3' };
        },
      },
    });
    expect(seen).toEqual(['RG26030001']);
    expect(keterangan).toBe('TITIPAN');
  });
});
