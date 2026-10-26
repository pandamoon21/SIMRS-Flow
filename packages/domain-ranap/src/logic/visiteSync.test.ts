import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KD_DETKELPENJAMIN,
  SPESIALIS_KD_KOMPONEN,
  SPESIALIS_OTHER_DOCTOR_MAX_TOTAL,
  SPESIALIS_SYNC_MAX_ITERATIONS,
  SPESIALIS_TARIF_BY_CLASS,
  bolehHapusSpesialisRow,
  collectSpesialisRowsForGroup,
  getCpptDoctorCandidatesForDate,
  getExpectedSpesialisTarif,
  getPatientParamedisGroupInfo,
  getSpesialisActionKey,
  getSpesialisExactName,
  getSpesialisPelaksanaName,
  getSpesialisRoomClass,
  getSpesialisV2MatchState,
  komponenDetailKey,
  looksLikeRoomLabelSpesialisPelaksana,
  looksLikeV2DoctorRow,
  needsSpesialisNameRepair,
  needsSpesialisRoomRelocation,
  needsSpesialisTarifRepair,
  pickCpptPelaksanaForEmptySpesialis,
  pickSpesialisKeepRow,
  pickSpesialisTindakanMeta,
  planVisiteSync,
  preserveSpesialisRow,
  resolveExactParamedisName,
  spesialisV2FallbackLine,
  tindakanStatusKey,
} from './visiteSync.js';
import type { PlanVisiteSyncArgs, VisiteOp } from './visiteSync.js';
import type { LegacyRow } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures — one registration, up to two stays, `verifikator_get_listtindakan`
// shaped rows (`{rows: [...]}`) so the envelope unwrapping is exercised too.
// ---------------------------------------------------------------------------

const REG = 'R-000001';
const TRX_1 = '03-100326-000001';
const TRX_2 = '03-110326-000002';
const DAY_1 = '2026-03-10';
const DAY_2 = '2026-03-11';
const DR_ANDI = 'dr. Andi Wibowo, Sp.PD';
const DR_BUDI = 'dr. Budi Santoso, Sp.B';
const DR_ANEST = 'dr. Rina Kartika, Sp.An';

/** `_build_update_datetime` stamps the wall clock onto the target date. */
const NOW = new Date(2026, 2, 15, 9, 30, 0);
const AT_0930 = (day: string): string => `${day} 09:30:00`;

/** Stay 1: MULTAZAM, the class is read off `nama_unit`. */
function stay1(kelas = 'KELAS 3', overrides: LegacyRow = {}): LegacyRow {
  return {
    no_transaksi: TRX_1,
    no_registrasikunjungan: REG,
    kd_unit: '401',
    kd_kamarperawatan: 'KMR-01',
    nama_unit: `MULTAZAM / ${kelas}`,
    urut_masuk_ruang: '1',
    tgl_masuk: `${DAY_1} 08:00:00`,
    tgl_keluar: `${DAY_1} 23:59:59`,
    ...overrides,
  };
}

/** Stay 2: ARROYAN, one day later — the owner of DAY_2. */
function stay2(overrides: LegacyRow = {}): LegacyRow {
  return {
    no_transaksi: TRX_2,
    no_registrasikunjungan: REG,
    kd_unit: '402',
    kd_kamarperawatan: 'KMR-02',
    nama_unit: 'ARROYAN / KELAS 2',
    urut_masuk_ruang: '2',
    tgl_masuk: `${DAY_2} 07:00:00`,
    tgl_keluar: `${DAY_2} 23:59:59`,
    ...overrides,
  };
}

function visiteRow(overrides: LegacyRow = {}): LegacyRow {
  return {
    kd_tindakan: 'TV-001',
    nama_tindakan: 'VISITE DOKTER SPESIALIS',
    urut_tindakan: '1',
    tgl_jam: `${DAY_1} 09:00:00`,
    harga: '50000',
    qty: '1',
    ...overrides,
  };
}

function konsultasiRow(overrides: LegacyRow = {}): LegacyRow {
  return {
    kd_tindakan: 'TK-001',
    nama_tindakan: 'KONSULTASI DOKTER SPESIALIS LEWAT TELEPON',
    urut_tindakan: '2',
    tgl_jam: `${DAY_1} 10:00:00`,
    harga: '30000',
    qty: '1',
    ...overrides,
  };
}

/** `verifikator_get_listtindakan` response envelope. */
function listPayload(rows: readonly LegacyRow[]): unknown {
  return { rows: [...rows], total: rows.length };
}

/** One `getdetail_komponen_transaksi` entry, keyed the way the planner reads it. */
function komponenDetail(
  entries: readonly { row: LegacyRow; trx: string; pelaksana: string }[],
): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const entry of entries) {
    map[komponenDetailKey({ ...entry.row, no_transaksi: entry.trx })] = [
      { kd_komponen: SPESIALIS_KD_KOMPONEN, nama_paramedis: entry.pelaksana },
    ];
  }
  return map;
}

const MASTER_VISITE: LegacyRow = {
  kd_tindakan: 'TV-001',
  nama_tindakan: 'VISITE DOKTER SPESIALIS',
  harga: '60000',
};
const MASTER_KONSULTASI: LegacyRow = {
  kd_tindakan: 'TK-001',
  nama_tindakan: 'KONSULTASI DOKTER SPESIALIS LEWAT TELEPON',
  harga: '30000',
};

function baseArgs(overrides: Partial<PlanVisiteSyncArgs> = {}): PlanVisiteSyncArgs {
  return {
    noRm: '00-12-34-56',
    roomRows: [stay1()],
    roomDayAssignments: { [TRX_1]: [DAY_1] },
    now: NOW,
    ...overrides,
  };
}

/** The shape assertions compare against — kind + reason + the corrected values. */
function summarize(ops: readonly VisiteOp[]): Array<Record<string, unknown>> {
  return ops.map((op) => ({
    sequence: op.sequence,
    kind: op.kind,
    endpointId: op.endpointId,
    noTransaksi: op.noTransaksi,
    reason: op.reason,
  }));
}

// ---------------------------------------------------------------------------
// Constants and the pure classifiers
// ---------------------------------------------------------------------------

describe('specialist tariff table', () => {
  it('pins the per-class visite tariff (a wrong number here is a wrong bill)', () => {
    expect(SPESIALIS_TARIF_BY_CLASS).toEqual({
      'KELAS 3': 50000,
      'KELAS 2': 75000,
      'KELAS 1': 75000,
    });
  });

  it('`_get_expected_spesialis_tarif` normalises the class first, and yields 0 off-table', () => {
    expect(getExpectedSpesialisTarif('KELAS 3')).toBe(50000);
    expect(getExpectedSpesialisTarif('kelas iii')).toBe(50000);
    expect(getExpectedSpesialisTarif('KELAS 2')).toBe(75000);
    expect(getExpectedSpesialisTarif('KELAS 1')).toBe(75000);
    expect(getExpectedSpesialisTarif('VIP')).toBe(0);
    expect(getExpectedSpesialisTarif('ICU')).toBe(0);
    expect(getExpectedSpesialisTarif('ISOLASI')).toBe(0);
    expect(getExpectedSpesialisTarif('')).toBe(0);
  });

  it('pins the loop bound and the per-doctor stay quota', () => {
    expect(SPESIALIS_SYNC_MAX_ITERATIONS).toBe(20);
    expect(SPESIALIS_OTHER_DOCTOR_MAX_TOTAL).toBe(3);
    expect(SPESIALIS_KD_KOMPONEN).toBe('29');
    expect(DEFAULT_KD_DETKELPENJAMIN).toBe('15');
  });
});

describe('getSpesialisActionKey', () => {
  it('probes SCN before the generic visite — order changes the answer', () => {
    expect(getSpesialisActionKey({ nama_tindakan: 'VISITE DR ANAK SCN' })).toBe('visite_scn');
    expect(getSpesialisActionKey({ nama_tindakan: 'VISITE DOKTER SPESIALIS' })).toBe('visite');
    expect(getSpesialisActionKey({ nama_tindakan: 'VISITE DOKTER SPESIALIS KE 2' })).toBe('visite');
    expect(getSpesialisActionKey({ nama_tindakan: 'KONSULTASI DOKTER SPESIALIS LEWAT TELEPON' })).toBe(
      'konsultasi',
    );
    expect(getSpesialisActionKey({ nama_tindakan: 'BIAYA KAMAR KELAS 3' })).toBe('');
  });

  it('`_get_spesialis_exact_name` maps each key back to its canonical name', () => {
    expect(getSpesialisExactName('visite')).toBe('VISITE DOKTER SPESIALIS');
    expect(getSpesialisExactName('visite_scn')).toBe('VISITE DR ANAK SCN');
    expect(getSpesialisExactName('konsultasi')).toBe(
      'KONSULTASI DOKTER SPESIALIS LEWAT TELEPON',
    );
    expect(getSpesialisExactName('')).toBe('');
  });
});

describe('repair triggers', () => {
  it('`_needs_spesialis_name_repair` fires on a suffixed name only', () => {
    const row = (nama: string): LegacyRow => ({ _action_key: 'visite', nama_tindakan: nama });
    expect(needsSpesialisNameRepair(row('VISITE DOKTER SPESIALIS'))).toBe(false);
    expect(needsSpesialisNameRepair(row('VISITE  DOKTER   SPESIALIS'))).toBe(false);
    expect(needsSpesialisNameRepair(row('VISITE DOKTER SPESIALIS KE 2'))).toBe(true);
    expect(needsSpesialisNameRepair({ _action_key: 'konsultasi', nama_tindakan: 'X' })).toBe(false);
  });

  it('`_needs_spesialis_tarif_repair` needs a price and an on-table class', () => {
    const row = (harga: string, kelas: string): LegacyRow => ({
      _action_key: 'visite',
      harga,
      _source_room_row: { nama_unit: `MULTAZAM / ${kelas}` },
    });
    expect(needsSpesialisTarifRepair(row('50000', 'KELAS 1'))).toBe(true);
    expect(needsSpesialisTarifRepair(row('75000', 'KELAS 1'))).toBe(false);
    expect(needsSpesialisTarifRepair(row('0', 'KELAS 1'))).toBe(false);
    expect(needsSpesialisTarifRepair(row('50000', 'VIP'))).toBe(false);
    expect(needsSpesialisTarifRepair({ ...row('50000', 'KELAS 1'), _action_key: 'konsultasi' })).toBe(
      false,
    );
  });

  it('`_needs_spesialis_room_relocation` is consultations only', () => {
    const row = (actionKey: string): LegacyRow => ({
      _action_key: actionKey,
      _row_date: DAY_1,
      no_transaksi: TRX_1,
      _source_room_row: { no_transaksi: TRX_1 },
      _owner_room_row: { no_transaksi: TRX_2 },
    });
    expect(needsSpesialisRoomRelocation(row('konsultasi'))).toBe(true);
    expect(needsSpesialisRoomRelocation(row('visite'))).toBe(false);
    expect(needsSpesialisRoomRelocation(row('visite_scn'))).toBe(false);
    expect(
      needsSpesialisRoomRelocation({
        ...row('konsultasi'),
        _owner_room_row: { no_transaksi: TRX_1 },
      }),
    ).toBe(false);
  });

  it('`_get_spesialis_room_class` prefers the source stay, then the owner, then the row', () => {
    expect(
      getSpesialisRoomClass({
        _source_room_row: { nama_unit: 'MULTAZAM / KELAS 3' },
        _owner_room_row: { nama_unit: 'ARROYAN / KELAS 1' },
      }),
    ).toBe('KELAS 3');
    expect(
      getSpesialisRoomClass({ _source_room_row: {}, _owner_room_row: { nama_unit: 'VIP-2' } }),
    ).toBe('VIP');
    expect(getSpesialisRoomClass({ nama_unit: 'ICU' })).toBe('ICU');
    expect(getSpesialisRoomClass({})).toBe('');
  });
});

describe('preserveSpesialisRow', () => {
  it('protects an anaesthetist visite and consultation, but not `visite_scn`', () => {
    expect(preserveSpesialisRow({ _action_key: 'visite', _is_anest: true })).toBe(true);
    expect(preserveSpesialisRow({ _action_key: 'konsultasi', _is_anest: true })).toBe(true);
    expect(preserveSpesialisRow({ _action_key: 'visite_scn', _is_anest: true })).toBe(false);
    expect(preserveSpesialisRow({ _action_key: 'visite', _is_anest: false })).toBe(false);
  });
});

describe('looksLikeRoomLabelSpesialisPelaksana', () => {
  it('spots the ward name masquerading as the performing doctor', () => {
    expect(
      looksLikeRoomLabelSpesialisPelaksana({
        _pelaksana: 'MULTAZAM',
        _source_room_name: 'MULTAZAM / KELAS 3',
      }),
    ).toBe(true);
    expect(
      looksLikeRoomLabelSpesialisPelaksana({
        _pelaksana: 'PERAWAT ARROYAN',
        _owner_room_name: 'ARROYAN / KELAS 2',
      }),
    ).toBe(true);
    expect(
      looksLikeRoomLabelSpesialisPelaksana({
        _pelaksana: DR_ANDI,
        _source_room_name: 'MULTAZAM / KELAS 3',
      }),
    ).toBe(false);
    expect(looksLikeRoomLabelSpesialisPelaksana({ _pelaksana: '' })).toBe(false);
  });
});

describe('getSpesialisPelaksanaName', () => {
  it('reads component 29 only, and treats "-"/"None"/"null" as unset', () => {
    const row = visiteRow({ no_transaksi: TRX_1 });
    const key = komponenDetailKey(row);
    expect(
      getSpesialisPelaksanaName(row, {
        [key]: [
          { kd_komponen: '01', nama_paramedis: 'PERAWAT MULTAZAM' },
          { kd_komponen: '29', nama_paramedis: DR_ANDI },
        ],
      }),
    ).toBe(DR_ANDI);
    expect(getSpesialisPelaksanaName(row, { [key]: [{ kd_komponen: '29', nama_paramedis: '-' }] })).toBe(
      '',
    );
    expect(
      getSpesialisPelaksanaName(row, { [key]: [{ kd_komponen: '29', nama_paramedis: 'None' }] }),
    ).toBe('');
    expect(getSpesialisPelaksanaName(row, { [key]: [{ kd_komponen: '01', nama_paramedis: 'X' }] })).toBe(
      '',
    );
    expect(getSpesialisPelaksanaName(row, {})).toBe('');
  });
});

describe('CPPT candidate reads', () => {
  const V1 = [
    { tgl_entry: `${DAY_1} 07:10:00`, nama_paramedis: DR_ANDI },
    { tgl_entry: `${DAY_1} 12:00:00`, nama_paramedis: DR_ANDI },
    { tgl_entry: `${DAY_2} 07:00:00`, nama_paramedis: DR_BUDI },
  ];

  it('`_get_cppt_doctor_candidates_for_date` de-duplicates and filters by date', () => {
    const info = getCpptDoctorCandidatesForDate('RM1', REG, DAY_1, {
      cpptV1RowsByNoReg: { [REG]: V1 },
    });
    expect(info).toEqual({ names: [DR_ANDI], source: 'v1', available: true });
  });

  it('falls back to v2 only when v1 is empty, and then keeps doctor rows only', () => {
    const info = getCpptDoctorCandidatesForDate('RM1', REG, DAY_1, {
      cpptV1RowsByNoReg: { [REG]: [] },
      cpptV2RowsByNoReg: {
        [REG]: [
          { tgl_entry: DAY_1, nama_paramedis: 'Siti', jabatan_paramedis: 'PERAWAT' },
          { tgl_entry: DAY_1, nama_paramedis: DR_BUDI, jabatan_paramedis: 'DOKTER SPESIALIS' },
        ],
      },
    });
    expect(info).toEqual({ names: [DR_BUDI], source: 'v2', available: true });
  });

  it('reports unavailable when neither source has rows, or the key triple is incomplete', () => {
    expect(getCpptDoctorCandidatesForDate('RM1', REG, DAY_1, {})).toEqual({
      names: [],
      source: '',
      available: false,
    });
    expect(
      getCpptDoctorCandidatesForDate('', REG, DAY_1, { cpptV1RowsByNoReg: { [REG]: V1 } }),
    ).toEqual({ names: [], source: '', available: false });
  });

  it('`_looks_like_v2_doctor_row` accepts a DOKTER jabatan or a DR/SP in the name', () => {
    expect(looksLikeV2DoctorRow({ jabatan_paramedis: 'DOKTER UMUM', nama_paramedis: 'X' })).toBe(true);
    expect(looksLikeV2DoctorRow({ nama_paramedis: 'dr. Andi' })).toBe(true);
    expect(looksLikeV2DoctorRow({ nama_paramedis: 'Andi, Sp.PD' })).toBe(true);
    expect(looksLikeV2DoctorRow({ jabatan_paramedis: 'BIDAN', nama_paramedis: 'Siti' })).toBe(false);
  });

  it('`_get_spesialis_v2_match_state` gives null when no CPPT is readable', () => {
    const row: LegacyRow = {
      _no_rm: 'RM1',
      no_registrasikunjungan: REG,
      _pelaksana: DR_ANDI,
      _row_date: DAY_1,
    };
    expect(getSpesialisV2MatchState(row, {}).state).toBeNull();
    expect(
      getSpesialisV2MatchState(row, { cpptV1RowsByNoReg: { [REG]: V1 } }),
    ).toMatchObject({ state: true, count: 2, source: 'v1' });
    expect(
      getSpesialisV2MatchState({ ...row, _pelaksana: DR_BUDI }, {
        cpptV1RowsByNoReg: { [REG]: V1 },
      }),
    ).toMatchObject({ state: false, count: 0, source: 'v1' });
  });

  describe('spesialisV2FallbackLine (`_log_spesialis_v2_fallback`, ranap_v3.py:11406)', () => {
    const candidate = (pelaksana: string, day = DAY_1): LegacyRow => ({
      _no_rm: 'RM1',
      no_registrasikunjungan: REG,
      _action_key: 'visite',
      _pelaksana: pelaksana,
      _row_date: day,
    });
    const lookups = { cpptV1RowsByNoReg: { [REG]: V1 } };

    it('prints one `name@date=ya|tidak|unknown` entry per candidate', () => {
      expect(spesialisV2FallbackLine([candidate(DR_ANDI), candidate(DR_BUDI)], lookups)).toBe(
        `  - Fallback visite CPPT | reg=${REG} | aksi=visite | source=v1 | ` +
          `kandidat=${DR_ANDI}@${DAY_1}=ya || ${DR_BUDI}@${DAY_1}=tidak`,
      );
    });

    it('says nothing for fewer than two candidates', () => {
      // `len(rows or []) < 2` — nothing collided, so there is nothing to explain.
      expect(spesialisV2FallbackLine([candidate(DR_ANDI)], lookups)).toBeUndefined();
      expect(spesialisV2FallbackLine([], lookups)).toBeUndefined();
    });

    it('says nothing when no candidate has a readable CPPT state', () => {
      // `if not has_known_state: return` — the line would read `unknown` for
      // everything and assert nothing.
      expect(spesialisV2FallbackLine([candidate(DR_ANDI), candidate(DR_BUDI)], {})).toBeUndefined();
    });

    it('renders an unreadable candidate as unknown and joins the sources sorted', () => {
      // `str(row.get("_cppt_doctor_date_match_source") or "unknown")` — a row
      // the state getter could not address at all still contributes a source,
      // and the set is printed `",".join(sorted(...))`.
      const line = spesialisV2FallbackLine(
        [candidate(DR_ANDI), { ...candidate(DR_BUDI), _pelaksana: '' }],
        lookups,
      );
      expect(line).toContain('source=unknown,v1');
      expect(line).toContain(`kandidat=${DR_ANDI}@${DAY_1}=ya || -@${DAY_1}=unknown`);
    });
  });
});

describe('pickCpptPelaksanaForEmptySpesialis', () => {
  const lookups = {
    cpptV1RowsByNoReg: {
      [REG]: [
        { tgl_entry: DAY_1, nama_paramedis: DR_ANDI },
        { tgl_entry: DAY_1, nama_paramedis: DR_BUDI },
      ],
    },
  };
  const row: LegacyRow = {
    _no_rm: 'RM1',
    no_registrasikunjungan: REG,
    _row_date: DAY_1,
    _action_key: 'visite',
  };

  it('refuses to guess when two candidates remain', () => {
    expect(pickCpptPelaksanaForEmptySpesialis({ row, rows: [], lookups }).name).toBe('');
  });

  it('commits on a single relaxed match against the patient’s own doctor', () => {
    const patientInfo = {
      allNames: [DR_BUDI],
      allKeys: new Set(['DR BUDI SANTOSO SP B']),
      primaryName: DR_BUDI,
      primaryKey: 'DR BUDI SANTOSO SP B',
      patientName: 'TN. X',
      isByny: false,
    };
    expect(pickCpptPelaksanaForEmptySpesialis({ row, rows: [], patientInfo, lookups }).name).toBe(
      DR_BUDI,
    );
  });

  it('commits on a single same-day performer already on another row of the same action', () => {
    const sibling: LegacyRow = { _action_key: 'visite', _row_date: DAY_1, _pelaksana: DR_ANDI };
    expect(pickCpptPelaksanaForEmptySpesialis({ row, rows: [sibling], lookups }).name).toBe(DR_ANDI);
  });

  it('prefers a lone paediatrician for `visite_scn` before anything else', () => {
    const scnLookups = {
      cpptV1RowsByNoReg: {
        [REG]: [
          { tgl_entry: DAY_1, nama_paramedis: 'dr. Cahya, Sp.A' },
          { tgl_entry: DAY_1, nama_paramedis: DR_BUDI },
        ],
      },
    };
    expect(
      pickCpptPelaksanaForEmptySpesialis({
        row: { ...row, _action_key: 'visite_scn' },
        rows: [],
        lookups: scnLookups,
      }).name,
    ).toBe('dr. Cahya, Sp.A');
  });
});

describe('getPatientParamedisGroupInfo', () => {
  it('takes the LAST stay’s doctor as the patient’s own, and collects the rest', () => {
    const info = getPatientParamedisGroupInfo({
      roomRows: [stay1(), stay2()],
      dataKunjunganByNoTransaksi: {
        [TRX_1]: { nama_paramedis: DR_ANDI, nama_pasien: 'By. Ny. SITI' },
        [TRX_2]: { nama_paramedis: DR_BUDI },
      },
    });
    expect(info.primaryName).toBe(DR_BUDI);
    expect(info.primaryKey).toBe('DR BUDI SANTOSO SP B');
    expect(info.allNames).toEqual([DR_ANDI, DR_BUDI]);
    expect(info.patientName).toBe('By. Ny. SITI');
    expect(info.isByny).toBe(true);
  });

  it('falls back to `ambil_datatransaksi` on the latest stay when no stay names a doctor', () => {
    const info = getPatientParamedisGroupInfo({
      roomRows: [stay1(), stay2()],
      dataKunjunganByNoTransaksi: { [TRX_1]: { nama_paramedis: '-' } },
      dataTransaksiByNoTransaksi: { [TRX_2]: { nama_paramedis: DR_ANEST } },
    });
    expect(info.primaryName).toBe(DR_ANEST);
    expect(info.allNames).toEqual([DR_ANEST]);
  });
});

describe('collectSpesialisRowsForGroup', () => {
  it('decorates each specialist charge with its source stay, day owner and performer', () => {
    const visite = visiteRow({ tgl_jam: `${DAY_2} 09:00:00` });
    const rows = collectSpesialisRowsForGroup({
      noRm: 'RM1',
      roomRows: [stay1(), stay2()],
      roomDayAssignments: { [TRX_1]: [DAY_1], [TRX_2]: [DAY_2] },
      listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]), [TRX_2]: listPayload([]) },
      komponenDetailByRow: komponenDetail([{ row: visite, trx: TRX_1, pelaksana: DR_ANDI }]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      _action_key: 'visite',
      _row_date: DAY_2,
      no_transaksi: TRX_1,
      _source_room_name: 'MULTAZAM / KELAS 3',
      _owner_room_name: 'ARROYAN / KELAS 2',
      _pelaksana: DR_ANDI,
      _pelaksana_key: 'DR ANDI WIBOWO SP PD',
      _is_anest: false,
    });
  });

  it('skips non-specialist charges and stays with no transaction id', () => {
    const rows = collectSpesialisRowsForGroup({
      noRm: 'RM1',
      roomRows: [stay1(), { nama_unit: 'ORPHAN' }],
      roomDayAssignments: { [TRX_1]: [DAY_1] },
      listTindakanByNoTransaksi: {
        [TRX_1]: listPayload([{ nama_tindakan: 'BIAYA KAMAR KELAS 3', urut_tindakan: '9' }]),
      },
    });
    expect(rows).toEqual([]);
  });
});

describe('pickSpesialisKeepRow', () => {
  const row = (urut: string, tglJam: string, pelaksanaKey: string): LegacyRow => ({
    no_transaksi: TRX_1,
    urut_tindakan: urut,
    tgl_jam: tglJam,
    _pelaksana_key: pelaksanaKey,
  });

  it('prefers the patient’s own doctor, then CPPT confirmation, then time, then urut', () => {
    const patient = row('5', `${DAY_1} 20:00:00`, 'DR PATIENT');
    const other = row('1', `${DAY_1} 06:00:00`, 'DR OTHER');
    expect(pickSpesialisKeepRow([other, patient], new Set(['DR PATIENT']))).toBe(patient);
    // Without the preference, the earlier timestamp wins over the lower urut.
    expect(pickSpesialisKeepRow([patient, other])).toBe(other);
  });

  it('breaks a time tie on urut, and sorts an unreadable date last', () => {
    const early = row('7', `${DAY_1} 08:00:00`, 'K');
    const late = row('2', `${DAY_1} 08:00:00`, 'K');
    const undated = row('1', '', 'K');
    expect(pickSpesialisKeepRow([early, late, undated])).toBe(late);
    expect(pickSpesialisKeepRow([undated, early])).toBe(early);
  });

  it('lets a CPPT-confirmed row beat an earlier unconfirmed one', () => {
    const confirmed: LegacyRow = {
      no_transaksi: TRX_1,
      urut_tindakan: '9',
      tgl_jam: `${DAY_1} 20:00:00`,
      _no_rm: 'RM1',
      no_registrasikunjungan: REG,
      _row_date: DAY_1,
      _pelaksana: DR_ANDI,
      _pelaksana_key: 'DR ANDI WIBOWO SP PD',
    };
    const unconfirmed: LegacyRow = { ...confirmed, urut_tindakan: '1', tgl_jam: `${DAY_1} 06:00:00`, _pelaksana: DR_BUDI };
    const lookups = { cpptV1RowsByNoReg: { [REG]: [{ tgl_entry: DAY_1, nama_paramedis: DR_ANDI }] } };
    expect(pickSpesialisKeepRow([unconfirmed, confirmed], new Set(), lookups)).toBe(confirmed);
  });
});

describe('bolehHapusSpesialisRow', () => {
  it('allows a row with no paid/verified hint at all', () => {
    expect(bolehHapusSpesialisRow(visiteRow())).toBe(true);
  });

  it('refuses a protected charge, a paid row and a verified row', () => {
    expect(bolehHapusSpesialisRow({ nama_tindakan: 'BIAYA LABORATORIUM' })).toBe(false);
    expect(bolehHapusSpesialisRow(visiteRow({ status_bayar: 'SUDAH' }))).toBe(false);
    expect(bolehHapusSpesialisRow(visiteRow({ status_verifikasi: '1' }))).toBe(false);
    expect(bolehHapusSpesialisRow(visiteRow({ flag: '1' }))).toBe(false);
    expect(bolehHapusSpesialisRow(visiteRow({ nama_jenispembayaran: 'TUNAI' }))).toBe(false);
  });

  it('probes `cekstatusbayar` only when the row hints are inconclusive', () => {
    const row = visiteRow({ status: '1' });
    expect(bolehHapusSpesialisRow(row)).toBe(true); // absent lookup reads as ''
    expect(
      bolehHapusSpesialisRow(row, { statusBayarByTindakan: { [tindakanStatusKey(row)]: '1' } }),
    ).toBe(false);
    expect(
      bolehHapusSpesialisRow(row, { statusBayarByTindakan: { [tindakanStatusKey(row)]: '0' } }),
    ).toBe(true);
  });
});

describe('pickSpesialisTindakanMeta', () => {
  it('matches VISITE DOKTER SPESIALIS on the collapsed name, master list first', () => {
    const master = [{ kd_tindakan: 'M1', nama_tindakan: 'VISITE  DOKTER  SPESIALIS' }];
    const list = [{ kd_tindakan: 'L1', nama_tindakan: 'VISITE DOKTER SPESIALIS' }];
    expect(pickSpesialisTindakanMeta(master, list, 'VISITE DOKTER SPESIALIS')).toBe(master[0]);
    expect(pickSpesialisTindakanMeta([], list, 'VISITE DOKTER SPESIALIS')).toBe(list[0]);
    expect(pickSpesialisTindakanMeta([], [], 'VISITE DOKTER SPESIALIS')).toBeUndefined();
  });

  it('matches any other exact name case-insensitively', () => {
    const master = [MASTER_KONSULTASI];
    expect(
      pickSpesialisTindakanMeta(master, [], 'KONSULTASI DOKTER SPESIALIS LEWAT TELEPON'),
    ).toBe(MASTER_KONSULTASI);
    expect(pickSpesialisTindakanMeta(master, [], 'VISITE DR ANAK SCN')).toBeUndefined();
  });
});

describe('resolveExactParamedisName', () => {
  const registry = {
    '401': [{ nama_paramedis: 'dr. Andi Wibowo, Sp.PD' }, { nama_paramedis: 'dr. Budi Santoso, Sp.B' }],
    undefined: [{ nama_paramedis: 'dr. Cahya, Sp.A' }],
  };

  it('prefers an exact normalised match, then a unique relaxed one', () => {
    expect(resolveExactParamedisName('DR ANDI WIBOWO SP PD', '401', registry)).toBe(DR_ANDI);
    expect(resolveExactParamedisName('Andi Wibowo', '401', registry)).toBe(DR_ANDI);
  });

  it('falls back to the `undefined` bucket, then to the name as given', () => {
    expect(resolveExactParamedisName('DR CAHYA SP A', '999', registry)).toBe('dr. Cahya, Sp.A');
    // Relaxed matching needs two shared tokens of three characters or more, so
    // a single surname is *not* enough and the name passes through unchanged.
    expect(resolveExactParamedisName('Cahya', '999', registry)).toBe('Cahya');
    expect(resolveExactParamedisName('dr. Zulfa', '401', registry)).toBe('dr. Zulfa');
    expect(resolveExactParamedisName('dr. Zulfa', '401')).toBe('dr. Zulfa');
    expect(resolveExactParamedisName('', '401', registry)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// planVisiteSync — the ordered op list
// ---------------------------------------------------------------------------

describe('planVisiteSync — empty performer filled from CPPT', () => {
  it('emits one setPelaksana naming the CPPT doctor', () => {
    const visite = visiteRow();
    const plan = planVisiteSync(
      baseArgs({
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) },
        cpptV1RowsByNoReg: { [REG]: [{ tgl_entry: `${DAY_1} 07:00:00`, nama_paramedis: DR_ANDI }] },
      }),
    );

    expect(summarize(plan.ops)).toEqual([
      {
        sequence: 1,
        kind: 'setPelaksana',
        endpointId: 'poliklinik.tampungPelaksana',
        noTransaksi: TRX_1,
        reason: 'Ganti pelaksana visite dokter spesialis dari CPPT',
      },
    ]);
    expect(plan.ops[0]).toMatchObject({
      pelaksana: DR_ANDI,
      kdKomponen: '29',
      kdTindakan: 'TV-001',
      urutTindakan: '1',
      noRegistrasikunjungan: REG,
    });
    expect(plan.status).toBe('changed');
    expect(plan.untouched).toEqual([]);
  });

  it('resolves the performer to the exact registry spelling before writing it', () => {
    const visite = visiteRow();
    const plan = planVisiteSync(
      baseArgs({
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) },
        cpptV1RowsByNoReg: { [REG]: [{ tgl_entry: DAY_1, nama_paramedis: 'ANDI WIBOWO' }] },
        paramedisPelaksanaByKdUnit: { '401': [{ nama_paramedis: DR_ANDI }] },
      }),
    );
    expect(plan.ops.map((op) => op.kind)).toEqual(['setPelaksana']);
    expect(plan.ops[0]?.pelaksana).toBe(DR_ANDI);
  });
});

describe('planVisiteSync — CPPT offers nobody', () => {
  it('deletes the visite with the legacy "no CPPT doctor" reason', () => {
    const visite = visiteRow();
    const plan = planVisiteSync(
      baseArgs({ listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) } }),
    );

    expect(summarize(plan.ops)).toEqual([
      {
        sequence: 1,
        kind: 'hapus',
        endpointId: 'penatajasaInap.hapusTindakan',
        noTransaksi: TRX_1,
        reason: `pelaksana visite dokter spesialis tidak valid dan tidak ada dokter CPPT pada tanggal ${DAY_1}`,
      },
    ]);
    expect(plan.ops[0]).toMatchObject({
      kdTindakan: 'TV-001',
      urutTindakan: '1',
      tglJam: `${DAY_1} 09:00:00`,
    });
    expect(plan.status).toBe('changed');
  });

  it('deletes with the "candidates are not unique" reason when CPPT names several', () => {
    const visite = visiteRow();
    const plan = planVisiteSync(
      baseArgs({
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) },
        cpptV1RowsByNoReg: {
          [REG]: [
            { tgl_entry: DAY_1, nama_paramedis: DR_ANDI },
            { tgl_entry: DAY_1, nama_paramedis: DR_BUDI },
          ],
        },
      }),
    );
    expect(plan.ops.map((op) => op.kind)).toEqual(['hapus']);
    expect(plan.ops[0]?.reason).toBe(
      `pelaksana visite dokter spesialis tidak valid dan kandidat dokter CPPT tidak tunggal (${DR_ANDI}, ${DR_BUDI})`,
    );
  });

  it('leaves the row untouched when the delete gate refuses it', () => {
    const visite = visiteRow({ status_bayar: 'SUDAH' });
    const plan = planVisiteSync(
      baseArgs({ listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) } }),
    );
    expect(plan.ops).toEqual([]);
    // The refused delete lets the gauntlet fall through to the later
    // "pelaksana kosong" stage, which refuses the same row for its own reason.
    expect(plan.untouched).toEqual([
      {
        row: expect.objectContaining({ urut_tindakan: '1' }) as unknown,
        reason: `pelaksana visite dokter spesialis tidak valid dan tidak ada dokter CPPT pada tanggal ${DAY_1}; sudah bayar / verifikasi`,
      },
      {
        row: expect.objectContaining({ urut_tindakan: '1' }) as unknown,
        reason: 'pelaksana visite dokter spesialis kosong; sudah bayar / verifikasi',
      },
    ]);
    expect(plan.status).toBe('ok');
  });
});

describe('planVisiteSync — consultation deduped against a same-day visite', () => {
  it('deletes the consultation, keeps the visite, and names the doctor in the reason', () => {
    const visite = visiteRow();
    const konsultasi = konsultasiRow();
    const plan = planVisiteSync(
      baseArgs({
        roomRows: [stay1('KELAS 3', { nama_paramedis: DR_ANDI })],
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite, konsultasi]) },
        komponenDetailByRow: komponenDetail([
          { row: visite, trx: TRX_1, pelaksana: DR_ANDI },
          { row: konsultasi, trx: TRX_1, pelaksana: DR_ANDI },
        ]),
      }),
    );

    expect(summarize(plan.ops)).toEqual([
      {
        sequence: 1,
        kind: 'hapus',
        endpointId: 'penatajasaInap.hapusTindakan',
        noTransaksi: TRX_1,
        reason: `dokter DR ANDI WIBOWO SP PD sudah memiliki visite pada tanggal ${DAY_1}, konsultasi dihapus`,
      },
    ]);
    expect(plan.ops[0]).toMatchObject({ kdTindakan: 'TK-001', urutTindakan: '2' });
    expect(plan.status).toBe('changed');
  });
});

describe('planVisiteSync — wrong tariff for the room class', () => {
  it('deletes then re-adds at the class tariff, re-dates it and re-attaches the doctor', () => {
    const visite = visiteRow({ harga: '50000' });
    const plan = planVisiteSync(
      baseArgs({
        roomRows: [stay1('KELAS 1', { nama_paramedis: DR_ANDI })],
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) },
        masterTindakanByNoTransaksi: { [TRX_1]: [MASTER_VISITE] },
        komponenDetailByRow: komponenDetail([{ row: visite, trx: TRX_1, pelaksana: DR_ANDI }]),
        dataKunjunganByNoTransaksi: { [TRX_1]: { kd_paramedis: 'PM-01', nama_paramedis: DR_ANDI } },
      }),
    );

    expect(summarize(plan.ops)).toEqual([
      {
        sequence: 1,
        kind: 'hapus',
        endpointId: 'penatajasaInap.hapusTindakan',
        noTransaksi: TRX_1,
        reason: 'tarif visite dokter spesialis 50000 tidak sesuai untuk KELAS 1',
      },
      {
        sequence: 2,
        kind: 'repairTarif',
        endpointId: 'penatajasaInap.tambahTindakanPolis',
        noTransaksi: TRX_1,
        reason: 'repair tarif visite dokter spesialis 50000 menjadi 75000 untuk KELAS 1',
      },
      {
        sequence: 3,
        kind: 'updateTgl',
        endpointId: 'penatajasaInap.updateTgl',
        noTransaksi: TRX_1,
        reason: 'kembalikan tanggal visite dokter spesialis setelah repair tarif',
      },
      {
        sequence: 4,
        kind: 'setPelaksana',
        endpointId: 'poliklinik.tampungPelaksana',
        noTransaksi: TRX_1,
        reason: 'Tampung ulang pelaksana visite dokter spesialis',
      },
    ]);
    expect(plan.ops[1]).toMatchObject({
      kdTindakan: 'TV-001',
      correctedNamaTindakan: 'VISITE DOKTER SPESIALIS',
      correctedHarga: 75000,
      correctedHargaRaw: '75000',
      correctedRoomClass: 'KELAS 1',
      kdUnit: '401',
      kdKamarperawatan: 'KMR-01',
      kdDetkelpenjamin: '15',
      kdParamedis: 'PM-01',
    });
    expect(plan.ops[2]).toMatchObject({
      targetDatetime: AT_0930(DAY_1),
      dependsOnSequence: 2,
    });
    expect(plan.ops[3]).toMatchObject({ pelaksana: DR_ANDI, dependsOnSequence: 2 });
    // The created row cannot be addressed until it is read back.
    expect(plan.status).toBe('incomplete');
  });

  it('skips the repair when the master price already matches the row', () => {
    const visite = visiteRow({ harga: '75000' });
    const plan = planVisiteSync(
      baseArgs({
        roomRows: [stay1('KELAS 1', { nama_paramedis: DR_ANDI })],
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) },
        masterTindakanByNoTransaksi: { [TRX_1]: [MASTER_VISITE] },
        komponenDetailByRow: komponenDetail([{ row: visite, trx: TRX_1, pelaksana: DR_ANDI }]),
      }),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.status).toBe('ok');
  });

  it('records "metadata VISITE DOKTER SPESIALIS tidak ditemukan" instead of a blind delete', () => {
    // The row's own name is non-standard, so neither the master list (empty)
    // nor the transaction's own list can supply the canonical metadata — which
    // is the only way `_pick_tindakan_meta` can come back empty here.
    const visite = visiteRow({ nama_tindakan: 'VISITE DOKTER SPESIALIS KE 2', harga: '50000' });
    const plan = planVisiteSync(
      baseArgs({
        roomRows: [stay1('KELAS 1', { nama_paramedis: DR_ANDI })],
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) },
        masterTindakanByNoTransaksi: { [TRX_1]: [] },
        komponenDetailByRow: komponenDetail([{ row: visite, trx: TRX_1, pelaksana: DR_ANDI }]),
      }),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.untouched).toEqual([
      {
        row: expect.objectContaining({ urut_tindakan: '1' }) as unknown,
        reason: 'metadata VISITE DOKTER SPESIALIS tidak ditemukan',
      },
    ]);
  });
});

describe('planVisiteSync — non-standard action name', () => {
  it('deletes the suffixed row and re-adds the canonical VISITE DOKTER SPESIALIS', () => {
    const visite = visiteRow({ nama_tindakan: 'VISITE DOKTER SPESIALIS KE 2', harga: '50000' });
    const plan = planVisiteSync(
      baseArgs({
        roomRows: [stay1('KELAS 3', { nama_paramedis: DR_ANDI })],
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) },
        masterTindakanByNoTransaksi: { [TRX_1]: [MASTER_VISITE] },
        komponenDetailByRow: komponenDetail([{ row: visite, trx: TRX_1, pelaksana: DR_ANDI }]),
      }),
    );

    expect(plan.ops.map((op) => op.kind)).toEqual([
      'hapus',
      'repairTarif',
      'updateTgl',
      'setPelaksana',
    ]);
    expect(plan.ops[0]?.reason).toBe(
      'nama tindakan visite dokter spesialis tidak standar (VISITE DOKTER SPESIALIS KE 2)',
    );
    expect(plan.ops[1]).toMatchObject({
      correctedNamaTindakan: 'VISITE DOKTER SPESIALIS',
      correctedHarga: 50000,
      correctedRoomClass: 'KELAS 3',
      reason:
        'repair nama visite dokter spesialis tidak standar (VISITE DOKTER SPESIALIS KE 2) menjadi VISITE DOKTER SPESIALIS untuk KELAS 3',
    });
    expect(plan.ops[2]?.reason).toBe(
      'kembalikan tanggal visite dokter spesialis setelah repair nama',
    );
  });
});

describe('planVisiteSync — charge sitting on the wrong room', () => {
  // `_needs_spesialis_room_relocation` fires for `konsultasi` only, so the
  // relocation scenario is a consultation billed against the stay that did not
  // own its date.
  const konsultasi = konsultasiRow({ tgl_jam: `${DAY_2} 10:00:00` });

  function relocationArgs(overrides: Partial<PlanVisiteSyncArgs> = {}): PlanVisiteSyncArgs {
    return baseArgs({
      roomRows: [stay1(), stay2()],
      roomDayAssignments: { [TRX_1]: [DAY_1], [TRX_2]: [DAY_2] },
      listTindakanByNoTransaksi: {
        [TRX_1]: listPayload([konsultasi]),
        [TRX_2]: listPayload([]),
      },
      masterTindakanByNoTransaksi: { [TRX_2]: [MASTER_KONSULTASI] },
      komponenDetailByRow: komponenDetail([{ row: konsultasi, trx: TRX_1, pelaksana: DR_ANDI }]),
      dataKunjunganByNoTransaksi: { [TRX_2]: { kd_paramedis: 'PM-02' } },
      ...overrides,
    });
  }

  it('adds it to the owner room, re-dates it, re-attaches the doctor, then deletes the source', () => {
    const plan = planVisiteSync(relocationArgs());

    expect(summarize(plan.ops)).toEqual([
      {
        sequence: 1,
        kind: 'relocateRoom',
        endpointId: 'penatajasaInap.tambahTindakanPolis',
        noTransaksi: TRX_2,
        reason: `pindah konsultasi dokter spesialis lewat telepon dari ruang MULTAZAM / KELAS 3 ke ruang owner ARROYAN / KELAS 2 pada tanggal ${DAY_2}`,
      },
      {
        sequence: 2,
        kind: 'updateTgl',
        endpointId: 'penatajasaInap.updateTgl',
        noTransaksi: TRX_2,
        reason: 'samakan tanggal konsultasi dokter spesialis lewat telepon ke room owner yang benar',
      },
      {
        sequence: 3,
        kind: 'setPelaksana',
        endpointId: 'poliklinik.tampungPelaksana',
        noTransaksi: TRX_2,
        reason: 'Tampung pelaksana konsultasi dokter spesialis lewat telepon di ruang owner',
      },
      {
        sequence: 4,
        kind: 'hapus',
        endpointId: 'penatajasaInap.hapusTindakan',
        noTransaksi: TRX_1,
        reason: `dipindah ke ruang owner ARROYAN / KELAS 2 pada tanggal ${DAY_2}`,
      },
    ]);
    expect(plan.ops[0]).toMatchObject({
      kdTindakan: 'TK-001',
      correctedNamaTindakan: 'KONSULTASI DOKTER SPESIALIS LEWAT TELEPON',
      correctedHarga: 30000,
      correctedRoomClass: 'KELAS 2',
      kdUnit: '402',
      kdKamarperawatan: 'KMR-02',
      kdParamedis: 'PM-02',
      noRegistrasikunjungan: REG,
    });
    expect(plan.ops[1]?.targetDatetime).toBe(AT_0930(DAY_2));
    expect(plan.status).toBe('incomplete');
  });

  it('just deletes the source when the owner room already has that day’s row', () => {
    const existing = konsultasiRow({ urut_tindakan: '4', tgl_jam: `${DAY_2} 11:00:00` });
    const plan = planVisiteSync(
      relocationArgs({
        listTindakanByNoTransaksi: {
          [TRX_1]: listPayload([konsultasi]),
          [TRX_2]: listPayload([existing]),
        },
        komponenDetailByRow: komponenDetail([
          { row: konsultasi, trx: TRX_1, pelaksana: DR_ANDI },
          { row: existing, trx: TRX_2, pelaksana: DR_ANDI },
        ]),
      }),
    );
    expect(plan.ops.map((op) => op.kind)).toEqual(['hapus']);
    expect(plan.ops[0]).toMatchObject({
      noTransaksi: TRX_1,
      urutTindakan: '2',
      reason: `dipindah ke ruang owner ARROYAN / KELAS 2 karena row target tanggal ${DAY_2} sudah ada`,
    });
  });
});

describe('planVisiteSync — preserved anaesthetist row', () => {
  it('reports it as untouched with the legacy reason and plans nothing', () => {
    const visite = visiteRow();
    const plan = planVisiteSync(
      baseArgs({
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) },
        komponenDetailByRow: komponenDetail([{ row: visite, trx: TRX_1, pelaksana: DR_ANEST }]),
      }),
    );

    expect(plan.ops).toEqual([]);
    expect(plan.untouched).toEqual([
      {
        row: expect.objectContaining({ _pelaksana: DR_ANEST, _is_anest: true }) as unknown,
        reason: 'dokter anestesi dipertahankan, tidak dihapus atau direwrite',
      },
    ]);
    expect(plan.status).toBe('ok');
  });

  it('still deletes an anaesthetist `visite_scn` in a non-ICU room', () => {
    const scn = visiteRow({ nama_tindakan: 'VISITE DR ANAK SCN', kd_tindakan: 'TS-001' });
    const plan = planVisiteSync(
      baseArgs({
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([scn]) },
        komponenDetailByRow: komponenDetail([{ row: scn, trx: TRX_1, pelaksana: DR_ANEST }]),
      }),
    );
    expect(plan.ops.map((op) => op.kind)).toEqual(['hapus']);
    expect(plan.ops[0]?.reason).toBe(
      'pelaksana anestesi tidak diperbolehkan di ruang non-ICU (MULTAZAM / KELAS 3)',
    );
  });
});

describe('planVisiteSync — patient has no visite at all', () => {
  it('adds one for the patient’s own doctor on the last owned day', () => {
    const plan = planVisiteSync(
      baseArgs({
        roomDayAssignments: { [TRX_1]: [DAY_1, DAY_2] },
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([]) },
        masterTindakanByNoTransaksi: { [TRX_1]: [MASTER_VISITE] },
        dataKunjunganByNoTransaksi: {
          [TRX_1]: { kd_paramedis: 'PM-01', nama_paramedis: DR_ANDI, nama_pasien: 'TN. BUDI' },
        },
      }),
    );

    expect(summarize(plan.ops)).toEqual([
      {
        sequence: 1,
        kind: 'tambah',
        endpointId: 'penatajasaInap.tambahTindakanPolis',
        noTransaksi: TRX_1,
        reason: `pasien belum memiliki visite dokter spesialis, tambah visite dokter pasien ${DR_ANDI} pada tanggal ${DAY_2}`,
      },
      {
        sequence: 2,
        kind: 'updateTgl',
        endpointId: 'penatajasaInap.updateTgl',
        noTransaksi: TRX_1,
        reason: 'pindahkan visite dokter pasien ke tanggal terakhir perawatan',
      },
      {
        sequence: 3,
        kind: 'setPelaksana',
        endpointId: 'poliklinik.tampungPelaksana',
        noTransaksi: TRX_1,
        reason: 'Tampung pelaksana visite dokter pasien',
      },
    ]);
    expect(plan.ops[0]).toMatchObject({
      kdTindakan: 'TV-001',
      correctedNamaTindakan: 'VISITE DOKTER SPESIALIS',
      // The Python sends the master price here, not the class tariff.
      correctedHarga: 60000,
      correctedHargaRaw: '60000',
      correctedRoomClass: 'KELAS 3',
      kdParamedis: 'PM-01',
    });
    expect(plan.ops[1]?.targetDatetime).toBe(AT_0930(DAY_2));
    expect(plan.ops[2]?.pelaksana).toBe(DR_ANDI);
    expect(plan.status).toBe('incomplete');
  });

  it('does not add one when the patient’s doctor already has a visite in range', () => {
    const visite = visiteRow();
    const plan = planVisiteSync(
      baseArgs({
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) },
        masterTindakanByNoTransaksi: { [TRX_1]: [MASTER_VISITE] },
        komponenDetailByRow: komponenDetail([{ row: visite, trx: TRX_1, pelaksana: DR_ANDI }]),
        dataKunjunganByNoTransaksi: { [TRX_1]: { kd_paramedis: 'PM-01', nama_paramedis: DR_ANDI } },
      }),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.status).toBe('ok');
  });

  it('exempts a newborn in Amanah that already has VISITE DR ANAK SCN', () => {
    const scn = visiteRow({ nama_tindakan: 'VISITE DR ANAK SCN', kd_tindakan: 'TS-001' });
    const plan = planVisiteSync(
      baseArgs({
        roomRows: [stay1('KELAS 3', { nama_unit: 'AMANAH / KELAS 3' })],
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([scn]) },
        masterTindakanByNoTransaksi: { [TRX_1]: [MASTER_VISITE] },
        komponenDetailByRow: komponenDetail([{ row: scn, trx: TRX_1, pelaksana: 'dr. Cahya, Sp.A' }]),
        dataKunjunganByNoTransaksi: {
          [TRX_1]: { kd_paramedis: 'PM-01', nama_paramedis: DR_ANDI, nama_pasien: 'By. Ny. SITI' },
        },
      }),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.issues).toEqual(
      expect.arrayContaining([
        {
          level: 'INFO',
          message:
            'Skip tambah visite dokter pasien | alasan=bayi di ruang Amanah dengan VISITE DR ANAK SCN tidak wajib punya VISITE DOKTER SPESIALIS',
        },
      ]),
    );
  });
});

describe('planVisiteSync — duplicate specialist rows', () => {
  it('keeps the row `_pick_spesialis_keep_row` chooses and deletes the other', () => {
    // Same doctor, same day; the later timestamp loses even though its urut is lower.
    const early = visiteRow({ urut_tindakan: '7', tgl_jam: `${DAY_1} 08:00:00` });
    const late = visiteRow({ urut_tindakan: '2', tgl_jam: `${DAY_1} 20:00:00` });
    const plan = planVisiteSync(
      baseArgs({
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([late, early]) },
        komponenDetailByRow: komponenDetail([
          { row: early, trx: TRX_1, pelaksana: DR_ANDI },
          { row: late, trx: TRX_1, pelaksana: DR_ANDI },
        ]),
      }),
    );

    expect(summarize(plan.ops)).toEqual([
      {
        sequence: 1,
        kind: 'hapus',
        endpointId: 'penatajasaInap.hapusTindakan',
        noTransaksi: TRX_1,
        reason:
          'pelaksana yang sama selain dokter pasien maksimal 1x per hari untuk visite dokter spesialis',
      },
    ]);
    expect(plan.ops[0]).toMatchObject({ urutTindakan: '2', tglJam: `${DAY_1} 20:00:00` });
    expect(plan.status).toBe('changed');
  });

  it('uses the patient-doctor quota wording when the performer is the attending doctor', () => {
    const early = visiteRow({ urut_tindakan: '1', tgl_jam: `${DAY_1} 08:00:00` });
    const late = visiteRow({ urut_tindakan: '2', tgl_jam: `${DAY_1} 20:00:00` });
    const plan = planVisiteSync(
      baseArgs({
        roomRows: [stay1('KELAS 3', { nama_paramedis: DR_ANDI })],
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([early, late]) },
        komponenDetailByRow: komponenDetail([
          { row: early, trx: TRX_1, pelaksana: DR_ANDI },
          { row: late, trx: TRX_1, pelaksana: DR_ANDI },
        ]),
      }),
    );
    expect(plan.ops.map((op) => op.kind)).toEqual(['hapus']);
    expect(plan.ops[0]).toMatchObject({
      urutTindakan: '2',
      reason: 'dokter pasien maksimal 1x per hari untuk visite dokter spesialis',
    });
  });

  it('caps a non-attending doctor at three rows across the whole stay', () => {
    const days = ['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13'];
    const rows = days.map((day, index) =>
      visiteRow({ urut_tindakan: String(index + 1), tgl_jam: `${day} 09:00:00` }),
    );
    const plan = planVisiteSync(
      baseArgs({
        roomRows: [stay1('KELAS 3', { tgl_keluar: '2026-03-13 23:59:59' })],
        roomDayAssignments: { [TRX_1]: days },
        listTindakanByNoTransaksi: { [TRX_1]: listPayload(rows) },
        komponenDetailByRow: komponenDetail(
          rows.map((row) => ({ row, trx: TRX_1, pelaksana: DR_ANDI })),
        ),
      }),
    );
    expect(plan.ops.map((op) => op.kind)).toEqual(['hapus']);
    expect(plan.ops[0]).toMatchObject({
      urutTindakan: '4',
      reason:
        'pelaksana yang sama selain dokter pasien maksimal total 3x selama perawatan untuk visite dokter spesialis',
    });
  });
});

describe('planVisiteSync — dates outside the stay', () => {
  it('deletes a specialist row dated outside the assigned days, before any other repair', () => {
    const stray = visiteRow({ tgl_jam: '2026-03-20 09:00:00', urut_tindakan: '3' });
    const plan = planVisiteSync(
      baseArgs({
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([stray]) },
        komponenDetailByRow: komponenDetail([{ row: stray, trx: TRX_1, pelaksana: DR_ANDI }]),
      }),
    );
    expect(plan.ops.map((op) => op.kind)).toEqual(['hapus']);
    expect(plan.ops[0]?.reason).toBe(
      `tanggal 2026-03-20 di luar range rawat inap (${DAY_1} s/d ${DAY_1})`,
    );
  });
});

describe('planVisiteSync — nothing to do', () => {
  it('returns an empty plan for a group with no stays', () => {
    const plan = planVisiteSync({ noRm: 'RM1', roomRows: [], roomDayAssignments: {}, now: NOW });
    expect(plan).toEqual({
      noRegistrasikunjungan: '',
      ops: [],
      untouched: [],
      issues: [],
      lines: [],
      status: 'ok',
    });
  });

  it('reports the operator log header and the "no change" footer', () => {
    const visite = visiteRow();
    const plan = planVisiteSync(
      baseArgs({
        roomRows: [stay1('KELAS 3', { nama_paramedis: DR_ANDI })],
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) },
        masterTindakanByNoTransaksi: { [TRX_1]: [MASTER_VISITE] },
        komponenDetailByRow: komponenDetail([{ row: visite, trx: TRX_1, pelaksana: DR_ANDI }]),
      }),
    );
    expect(plan.ops).toEqual([]);
    expect(plan.lines[0]).toBe('+ Data:');
    expect(plan.lines[1]).toBe(`   - Dokter pasien : ${DR_ANDI}`);
    expect(plan.lines.at(-2)).toBe('+ Status:');
    expect(plan.lines.at(-1)).toBe(
      '   - Hasil         : tidak ada perubahan, data visite/konsultasi sudah sesuai',
    );
  });
});

describe('planVisiteSync — consultation with no performer', () => {
  it('fills it with the patient’s own doctor', () => {
    const konsultasi = konsultasiRow();
    const plan = planVisiteSync(
      baseArgs({
        roomRows: [stay1('KELAS 3', { nama_paramedis: DR_ANDI })],
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([konsultasi]) },
      }),
    );
    expect(summarize(plan.ops)).toEqual([
      {
        sequence: 1,
        kind: 'setPelaksana',
        endpointId: 'poliklinik.tampungPelaksana',
        noTransaksi: TRX_1,
        reason: 'Isi pelaksana konsultasi dokter spesialis lewat telepon',
      },
    ]);
    expect(plan.ops[0]?.pelaksana).toBe(DR_ANDI);
  });

  it('deletes it when the patient has no attending doctor at all', () => {
    const konsultasi = konsultasiRow();
    const plan = planVisiteSync(
      baseArgs({ listTindakanByNoTransaksi: { [TRX_1]: listPayload([konsultasi]) } }),
    );
    expect(plan.ops.map((op) => op.kind)).toEqual(['hapus']);
    expect(plan.ops[0]?.reason).toBe(
      'dokter penanggungjawab pasien tidak ditemukan untuk konsultasi dokter spesialis lewat telepon',
    );
  });

  it('deletes it when the attending doctor already has a consultation that day', () => {
    const empty = konsultasiRow({ urut_tindakan: '2' });
    const filled = konsultasiRow({ urut_tindakan: '3', tgl_jam: `${DAY_1} 12:00:00` });
    const plan = planVisiteSync(
      baseArgs({
        roomRows: [stay1('KELAS 3', { nama_paramedis: DR_ANDI })],
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([empty, filled]) },
        komponenDetailByRow: komponenDetail([{ row: filled, trx: TRX_1, pelaksana: DR_ANDI }]),
      }),
    );
    expect(plan.ops[0]).toMatchObject({
      kind: 'hapus',
      urutTindakan: '2',
      reason: `konsultasi dokter penanggungjawab pasien sudah ada pada tanggal ${DAY_1}`,
    });
  });
});

describe('planVisiteSync — operator reasoning', () => {
  it('marks a missing DPJP visite ✗ and names the add op that fixes it', () => {
    const plan = planVisiteSync(
      baseArgs({
        roomDayAssignments: { [TRX_1]: [DAY_1, DAY_2] },
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([]) },
        masterTindakanByNoTransaksi: { [TRX_1]: [MASTER_VISITE] },
        dataKunjunganByNoTransaksi: { [TRX_1]: { kd_paramedis: 'PM-01', nama_paramedis: DR_ANDI } },
      }),
    );
    expect(plan.reasoning).toEqual({
      title: `Rawat 2 hari (${DAY_1} – ${DAY_2})`,
      items: [{ label: `Visite DPJP ${DR_ANDI}`, ok: false, detail: `belum ada — tambah tgl ${DAY_2}`, opSequence: 1 }],
    });
  });

  it('keeps a valid visite ✓ and the DPJP ✓ when nothing needs fixing', () => {
    const visite = visiteRow();
    const plan = planVisiteSync(
      baseArgs({
        listTindakanByNoTransaksi: { [TRX_1]: listPayload([visite]) },
        masterTindakanByNoTransaksi: { [TRX_1]: [MASTER_VISITE] },
        komponenDetailByRow: komponenDetail([{ row: visite, trx: TRX_1, pelaksana: DR_ANDI }]),
        dataKunjunganByNoTransaksi: { [TRX_1]: { kd_paramedis: 'PM-01', nama_paramedis: DR_ANDI } },
      }),
    );
    expect(plan.reasoning?.items.map((item) => item.ok)).toEqual([true, true]);
    expect(plan.reasoning?.items[0]?.label).toMatch(new RegExp(`Visite .* · tgl ${DAY_1}`));
  });

  it('marks a removed visite ✗ with the delete op and its reason', () => {
    const plan = planVisiteSync(baseArgs({ listTindakanByNoTransaksi: { [TRX_1]: listPayload([visiteRow()]) } }));
    expect(plan.reasoning?.items[0]).toMatchObject({ ok: false, opSequence: 1 });
    expect(plan.reasoning?.items[0]?.detail).toMatch(/^dihapus: pelaksana visite dokter spesialis tidak valid/);
  });
});
