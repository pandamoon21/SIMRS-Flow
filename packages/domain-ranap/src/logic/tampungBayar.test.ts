import { describe, it, expect } from 'vitest';

import type { LegacyRow } from './types.js';
import {
  DEFAULT_JENIS_PEMBAYARAN,
  DEFAULT_SHIFT_PEMBAYARAN,
  TAMPUNG_BAYAR_REFUSAL_REASONS,
  TAMPUNG_BAYAR_ROW_KEYS,
  buildTampungBayarDtBayar,
  buildTampungBayarPayload,
  collectTindakanTampungBayar,
  evaluateTampungBayarEligibility,
  isUnpaidTindakanRow,
  normalizeTampungBayarRow,
  projectTampungBayarRow,
  resolveBiayaAdministrasi,
  resolveBiayaAdministrasiDetail,
  serializeTampungBayarRow,
  serializeTampungBayarRows,
} from './tampungBayar.js';

/** A literal backslash, spelled without an escape so this file stays plain ASCII. */
const BACKSLASH = String.fromCharCode(92);

// ── the group: one registration, two rooms ──────────────────────

const ROOM_1: LegacyRow = {
  no_transaksi: '03-100326-000001',
  no_registrasikunjungan: 'R100',
  kd_unit: '0301',
  kd_detkelpenjamin: '15',
  nama_unit: 'MULTAZAM / KELAS 3',
  urut_masuk_ruang: '1',
  tgl_masuk: '2026-03-10 08:00:00',
  tgl_keluar: '2026-03-11 08:00:00',
};

const ROOM_2: LegacyRow = {
  no_transaksi: '03-110326-000002',
  no_registrasikunjungan: 'R100',
  kd_unit: '0302',
  nama_unit: 'AL KAUTSAR / KELAS 2',
  urut_masuk_ruang: '2',
  tgl_masuk: '2026-03-11 08:00:00',
  tgl_keluar: '2026-03-12 10:00:00',
};

/** Second line of room 1, billed first (`urut_tindakan` 1); `racik` is absent. */
const ROW_ADMIN: LegacyRow = {
  kd_tindakan: '2',
  tgl_transaksi: '2026-03-10 08:05:00',
  nama_tindakan: 'BIAYA ADMINISTRASI',
  harga: '150000',
  qty: '1',
  jumlah: '150000',
  jenis_bayar: '',
  status_bayar: '',
  urut_tindakan: '1',
  flag: '0',
  no_transaksi: '03-100326-000001',
  kd_detjenispembayaran: '',
  t_harga: '150000',
  t_jumlah: '150000',
  t_qty: '1',
  t_urut_tindakan: '1',
  kd_unit: '0301',
  diskon_rp: '0',
  diskon_persen: '0',
  // Not one of the twenty staged fields — must not reach the cashier.
  nama_paramedis: 'ADMIN RANAP',
};

const ROW_KAMAR_1: LegacyRow = {
  kd_tindakan: '16',
  tgl_transaksi: '2026-03-10 09:00:00',
  nama_tindakan: 'BIAYA KAMAR MULTAZAM KELAS 3',
  harga: '400000',
  qty: '1',
  jumlah: '400000',
  jenis_bayar: '',
  status_bayar: 'Belum',
  urut_tindakan: '2',
  flag: '0',
  no_transaksi: '03-100326-000001',
  kd_detjenispembayaran: '0',
  t_harga: '400000',
  t_jumlah: '400000',
  t_qty: '1',
  t_urut_tindakan: '2',
  kd_unit: '0301',
  diskon_rp: '0',
  diskon_persen: '0',
  racik: '0',
};

/** Already settled by an earlier receipt: `flag` is the backend's paid marker. */
const ROW_ALREADY_PAID: LegacyRow = {
  ...ROW_KAMAR_1,
  kd_tindakan: '17',
  nama_tindakan: 'BIAYA VISITE DOKTER',
  urut_tindakan: '3',
  flag: '1',
  status_bayar: 'Sudah Bayar',
  jenis_bayar: 'TUNAI',
};

const ROW_KAMAR_2: LegacyRow = {
  kd_tindakan: '16',
  tgl_transaksi: '2026-03-11 09:00:00',
  nama_tindakan: 'BIAYA KAMAR AL KAUTSAR KELAS 2',
  harga: '700000',
  qty: '1',
  jumlah: '700000',
  jenis_bayar: '',
  status_bayar: '',
  urut_tindakan: '1',
  flag: '',
  no_transaksi: '03-110326-000002',
  kd_detjenispembayaran: '',
  t_harga: '700000',
  t_jumlah: '700000',
  t_qty: '1',
  t_urut_tindakan: '1',
  kd_unit: '0302',
  diskon_rp: '0',
  diskon_persen: '0',
  racik: '0',
};

/** Hoisted `penatajasaInap.getListTindakan`, keyed by no_transaksi. */
const LIST_TINDAKAN_BY_TRX: Record<string, readonly LegacyRow[]> = {
  // Deliberately out of billing order, to exercise the urut_tindakan tie-break.
  '03-100326-000001': [ROW_KAMAR_1, ROW_ALREADY_PAID, ROW_ADMIN],
  '03-110326-000002': [ROW_KAMAR_2],
};

// The exact wire form of each staged row, character for character.
const ADMIN_JSON =
  '{"kd_tindakan":"2","tgl_transaksi":"2026-03-10 08:05:00","nama_tindakan":"BIAYA ADMINISTRASI","harga":"150000","qty":"1","jumlah":"150000","jenis_bayar":"-","status_bayar":"Belum","urut_tindakan":"1","flag":"0","no_transaksi":"03-100326-000001","kd_detjenispembayaran":"0","t_harga":"150000","t_jumlah":"150000","t_qty":"1","t_urut_tindakan":"1","kd_unit":"0301","diskon_rp":"0","diskon_persen":"0","racik":""}';

const KAMAR_1_JSON =
  '{"kd_tindakan":"16","tgl_transaksi":"2026-03-10 09:00:00","nama_tindakan":"BIAYA KAMAR MULTAZAM KELAS 3","harga":"400000","qty":"1","jumlah":"400000","jenis_bayar":"-","status_bayar":"Belum","urut_tindakan":"2","flag":"0","no_transaksi":"03-100326-000001","kd_detjenispembayaran":"0","t_harga":"400000","t_jumlah":"400000","t_qty":"1","t_urut_tindakan":"2","kd_unit":"0301","diskon_rp":"0","diskon_persen":"0","racik":"0"}';

const KAMAR_2_JSON =
  '{"kd_tindakan":"16","tgl_transaksi":"2026-03-11 09:00:00","nama_tindakan":"BIAYA KAMAR AL KAUTSAR KELAS 2","harga":"700000","qty":"1","jumlah":"700000","jenis_bayar":"-","status_bayar":"Belum","urut_tindakan":"1","flag":"0","no_transaksi":"03-110326-000002","kd_detjenispembayaran":"0","t_harga":"700000","t_jumlah":"700000","t_qty":"1","t_urut_tindakan":"1","kd_unit":"0302","diskon_rp":"0","diskon_persen":"0","racik":"0"}';

describe('isUnpaidTindakanRow', () => {
  it('accepts a blank or "Belum" status_bayar', () => {
    expect(isUnpaidTindakanRow({ status_bayar: '' })).toBe(true);
    expect(isUnpaidTindakanRow({ status_bayar: 'Belum' })).toBe(true);
    expect(isUnpaidTindakanRow({ status_bayar: 'BELUM BAYAR' })).toBe(true);
    expect(isUnpaidTindakanRow({ status_bayar: 'Open', flag: '0' })).toBe(true);
  });

  it('rejects a row whose flag marks it settled, whatever the status says', () => {
    expect(isUnpaidTindakanRow({ flag: '1', status_bayar: 'Belum' })).toBe(false);
    expect(isUnpaidTindakanRow({ flag: 'true', status_bayar: '' })).toBe(false);
    expect(isUnpaidTindakanRow({ flag: true, status_bayar: '' })).toBe(false);
  });

  it('rejects a row already marked paid', () => {
    expect(isUnpaidTindakanRow(ROW_ALREADY_PAID)).toBe(false);
    expect(isUnpaidTindakanRow({ status_bayar: 'Sudah Bayar' })).toBe(false);
  });
});

describe('projectTampungBayarRow / serializeTampungBayarRow', () => {
  it('keeps exactly the twenty staged fields, in order, and drops the rest', () => {
    const projected = projectTampungBayarRow(ROW_ADMIN);
    expect(Object.keys(projected)).toEqual([...TAMPUNG_BAYAR_ROW_KEYS]);
    expect(Object.keys(projected)).toHaveLength(20);
    expect(projected['nama_paramedis']).toBeUndefined();
    // A field the row never had becomes "".
    expect(projected['racik']).toBe('');
  });

  it('serializes one row exactly as json.dumps(separators=(",", ":")) does', () => {
    expect(serializeTampungBayarRow(normalizeTampungBayarRow(ROW_ADMIN))).toBe(ADMIN_JSON);
    // Projection then normalisation is the order _collect_tindakan_tampung_bayar uses.
    expect(serializeTampungBayarRow(ROW_ADMIN)).toContain('"jenis_bayar":""');
  });

  it('escapes non-ASCII characters like ensure_ascii=True', () => {
    const emDash = String.fromCharCode(0x2014);
    const serialized = serializeTampungBayarRow({
      ...ROW_ADMIN,
      nama_tindakan: `INFUS RL 500 ML ${emDash} DEPO`,
    });
    expect(serialized).toContain(`"nama_tindakan":"INFUS RL 500 ML ${BACKSLASH}u2014 DEPO"`);
    expect(serialized).not.toContain(emDash);
  });

  it('preserves the JSON type of a numeric or null field', () => {
    const serialized = serializeTampungBayarRow({ ...ROW_ADMIN, qty: 2, harga: null });
    expect(serialized).toContain('"harga":null');
    expect(serialized).toContain('"qty":2');
  });

  it('serializes the row array with no whitespace', () => {
    expect(serializeTampungBayarRows([])).toBe('[]');
    expect(
      serializeTampungBayarRows([normalizeTampungBayarRow(projectTampungBayarRow(ROW_ADMIN))]),
    ).toBe(`[${ADMIN_JSON}]`);
  });
});

describe('normalizeTampungBayarRow', () => {
  it('forces the four settlement fields and keeps their original positions', () => {
    const normalized = normalizeTampungBayarRow(ROW_ALREADY_PAID);
    expect(normalized['jenis_bayar']).toBe('-');
    expect(normalized['status_bayar']).toBe('Belum');
    expect(normalized['flag']).toBe('0');
    expect(normalized['kd_detjenispembayaran']).toBe('0');
    // Every other field survives untouched.
    expect(normalized['nama_tindakan']).toBe('BIAYA VISITE DOKTER');
  });

  it('appends the four fields in the Python assignment order when absent', () => {
    expect(Object.keys(normalizeTampungBayarRow({ kd_tindakan: '2' }))).toEqual([
      'kd_tindakan',
      'jenis_bayar',
      'status_bayar',
      'flag',
      'kd_detjenispembayaran',
    ]);
  });
});

describe('collectTindakanTampungBayar', () => {
  it('sweeps both rooms, drops the settled row, and sorts by date/trx/urut', () => {
    const rows = collectTindakanTampungBayar({
      noRm: '0-12-34-56',
      roomRows: [ROOM_1, ROOM_2],
      listTindakanByTrx: LIST_TINDAKAN_BY_TRX,
    });

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row['nama_tindakan'])).toEqual([
      'BIAYA ADMINISTRASI',
      'BIAYA KAMAR MULTAZAM KELAS 3',
      'BIAYA KAMAR AL KAUTSAR KELAS 2',
    ]);
    expect(rows.every((row) => row['status_bayar'] === 'Belum')).toBe(true);
    expect(rows.every((row) => row['nama_paramedis'] === undefined)).toBe(true);
  });

  it('skips a stay that has no transaction or no registration number', () => {
    const rows = collectTindakanTampungBayar({
      noRm: '0-12-34-56',
      roomRows: [{ ...ROOM_1, no_registrasikunjungan: '' }, ROOM_2],
      listTindakanByTrx: LIST_TINDAKAN_BY_TRX,
    });
    expect(rows.map((row) => row['no_transaksi'])).toEqual(['03-110326-000002']);
  });

  it('returns nothing when no hoisted tindakan rows were supplied', () => {
    expect(
      collectTindakanTampungBayar({
        noRm: '0-12-34-56',
        roomRows: [ROOM_1, ROOM_2],
        listTindakanByTrx: {},
      }),
    ).toEqual([]);
  });

  it('sorts an unreadable transaction date last', () => {
    const rows = collectTindakanTampungBayar({
      noRm: '0-12-34-56',
      roomRows: [ROOM_1],
      listTindakanByTrx: {
        '03-100326-000001': [{ ...ROW_ADMIN, tgl_transaksi: '' }, ROW_KAMAR_1],
      },
    });
    expect(rows.map((row) => row['nama_tindakan'])).toEqual([
      'BIAYA KAMAR MULTAZAM KELAS 3',
      'BIAYA ADMINISTRASI',
    ]);
  });
});

describe('buildTampungBayarDtBayar', () => {
  it('pins the nested payment form exactly', () => {
    expect(
      buildTampungBayarDtBayar({
        grandTotal: 1250000,
        shiftPembayaran: '2',
        jenisPembayaran: '14',
      }),
    ).toBe(
      'cmbshift_pembayaran=2&cmbjenis_pembayaran=14&txtdiskonpn_pembayaran=&txtdiskonrp_pembayaran=&txtpembulatan_pembayaran=&cmbkartu_pembayaran=&txtjumlah_pembayaran=1250000&txtjmltagihan_pembayaran=1250000&txtjmldibayar_pembayaran=0',
    );
  });

  it('falls back to shift 1 / jenis 14 and a zero total', () => {
    expect(buildTampungBayarDtBayar({ grandTotal: 0 })).toBe(
      'cmbshift_pembayaran=1&cmbjenis_pembayaran=14&txtdiskonpn_pembayaran=&txtdiskonrp_pembayaran=&txtpembulatan_pembayaran=&cmbkartu_pembayaran=&txtjumlah_pembayaran=0&txtjmltagihan_pembayaran=0&txtjmldibayar_pembayaran=0',
    );
    expect(DEFAULT_SHIFT_PEMBAYARAN).toBe('1');
    expect(DEFAULT_JENIS_PEMBAYARAN).toBe('14');
  });

  it('passes the kasir grand-total text through verbatim, separators and all', () => {
    expect(buildTampungBayarDtBayar({ grandTotal: '1.250.000' })).toContain(
      'txtjumlah_pembayaran=1.250.000&txtjmltagihan_pembayaran=1.250.000',
    );
  });

  it('encodes like urlencode/quote_plus, so a space becomes +', () => {
    expect(
      buildTampungBayarDtBayar({ grandTotal: '0', jenisPembayaran: 'TUNAI PIUTANG' }),
    ).toContain('cmbjenis_pembayaran=TUNAI+PIUTANG');
  });
});

describe('buildTampungBayarPayload', () => {
  const payload = buildTampungBayarPayload({
    noRm: '0-12-34-56',
    roomRows: [ROOM_1, ROOM_2],
    listTindakanByTrx: LIST_TINDAKAN_BY_TRX,
    shiftPembayaran: '2',
    jenisPembayaran: '14',
    jumlahBayarKasir: { grand_total: '1250000' },
  });

  it('produces the tampung_bayar form fields, in the endpoint key order', () => {
    expect(Object.keys(payload.fields)).toEqual([
      'no_reg',
      'no_transaksi',
      'kd_unit',
      'ck_retur',
      'kd_penjamin',
      'dt_bayar',
      'tindakan',
    ]);
    expect(payload.fields['no_reg']).toBe('R100');
    expect(payload.fields['no_transaksi']).toBe('03-100326-000001');
    expect(payload.fields['kd_unit']).toBe('0301');
    expect(payload.fields['ck_retur']).toBe('false');
    expect(payload.fields['kd_penjamin']).toBe('15');
    expect(payload.fields['dt_bayar']).toBe(
      'cmbshift_pembayaran=2&cmbjenis_pembayaran=14&txtdiskonpn_pembayaran=&txtdiskonrp_pembayaran=&txtpembulatan_pembayaran=&cmbkartu_pembayaran=&txtjumlah_pembayaran=1250000&txtjmltagihan_pembayaran=1250000&txtjmldibayar_pembayaran=0',
    );
  });

  it('serializes the three unpaid rows into tindakan, in wire order', () => {
    expect(payload.fields['tindakan']).toBe(
      `[${ADMIN_JSON},${KAMAR_1_JSON},${KAMAR_2_JSON}]`,
    );
    expect(payload.rowCount).toBe(3);
    expect(payload.rowSource).toBe('penatajasa_inap');
  });

  it('reports the derived totals and the summary block', () => {
    expect(payload.buildable).toBe(true);
    expect(payload.grandTotal).toBe(1250000);
    expect(payload.grandTotalText).toBe('1250000');
    expect(payload.summary).toEqual({
      reg: 'R100',
      trx: '03-100326-000001',
      kdUnit: '0301',
      kdPenjamin: '15',
      shiftPembayaran: '2',
      jenisPembayaran: '14',
      grandTotal: '1250000',
      count: 3,
    });
  });

  it('falls back to the kasir shift, the getdatakunjungan unit, and penjamin 15', () => {
    const fallback = buildTampungBayarPayload({
      noRm: '0-12-34-56',
      roomRows: [{ ...ROOM_1, kd_unit: '', kd_detkelpenjamin: '' }],
      listTindakanByTrx: LIST_TINDAKAN_BY_TRX,
      shiftBayarKasir: '3',
      datakunjungan: { kd_unit: '0309' },
      jumlahBayarKasir: { total: '550000' },
    });
    expect(fallback.fields['kd_unit']).toBe('0309');
    expect(fallback.fields['kd_penjamin']).toBe('15');
    expect(fallback.summary.shiftPembayaran).toBe('3');
    // grand_total absent, so `total` is used.
    expect(fallback.grandTotalText).toBe('550000');
  });

  it('prefers the kasir line list and stages it whole, unfiltered and unprojected', () => {
    const fromKasir = buildTampungBayarPayload({
      noRm: '0-12-34-56',
      roomRows: [ROOM_1, ROOM_2],
      listTindakanByTrx: LIST_TINDAKAN_BY_TRX,
      listTindakanKasir: { rows: [ROW_ADMIN, ROW_ALREADY_PAID], total: 2 },
      jumlahBayarKasir: { grand_total: '1250000' },
    });

    expect(fromKasir.rowSource).toBe('kasir');
    expect(fromKasir.rowCount).toBe(2);
    // The settled row is NOT dropped on this path, only reset to unpaid.
    expect(fromKasir.rows[1]?.['nama_tindakan']).toBe('BIAYA VISITE DOKTER');
    expect(fromKasir.rows[1]?.['flag']).toBe('0');
    // ...and fields outside the twenty survive, because the kasir path does not project.
    expect(fromKasir.rows[0]?.['nama_paramedis']).toBe('ADMIN RANAP');
  });

  it('is not buildable when no room stay can be normalised', () => {
    const empty = buildTampungBayarPayload({
      noRm: '0-12-34-56',
      roomRows: [],
      listTindakanByTrx: LIST_TINDAKAN_BY_TRX,
    });
    expect(empty.buildable).toBe(false);
    expect(empty.fields).toEqual({});
    expect(empty.rows).toEqual([]);
    expect(empty.rowSource).toBe('none');
  });
});

describe('evaluateTampungBayarEligibility', () => {
  const KUNJUNGAN_OK: LegacyRow[] = [
    { no_registrasikunjungan: 'R100', no_transaksi: '03-100326-000001', nama_unit: 'MULTAZAM / KELAS 3' },
    { no_registrasikunjungan: 'R100', no_transaksi: '03-110326-000002', nama_unit: 'AL KAUTSAR / KELAS 2' },
  ];

  it('passes a clean two-room group', () => {
    const verdict = evaluateTampungBayarEligibility({
      kunjunganRows: KUNJUNGAN_OK,
      roomRows: [ROOM_1, ROOM_2],
      historyPembayaran: [],
      orderBelumTerlayani: { total: '0' },
      orderBelumTransfer: { total: 0 },
    });
    expect(verdict.eligible).toBe(true);
    expect(verdict.reason).toBe('');
    expect(verdict.excludedRows).toEqual([]);
    expect(verdict.premiumRooms).toEqual([]);
  });

  it('refuses a MULTAZAM PLATINUM room before anything else', () => {
    const verdict = evaluateTampungBayarEligibility({
      kunjunganRows: KUNJUNGAN_OK,
      roomRows: [ROOM_1, { ...ROOM_2, nama_unit: 'MULTAZAM PLATINUM 02' }],
      historyPembayaran: [{ no_kwitansi: 'KW-1' }],
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe(
      'room MULTAZAM PLATINUM memerlukan penjamin/deposit/manual billing di kasir',
    );
    expect(verdict.reason).toBe(TAMPUNG_BAYAR_REFUSAL_REASONS.premiumRoom);
    expect(verdict.premiumRooms).toEqual(['MULTAZAM PLATINUM 02']);
  });

  it('refuses when a selected visit sits in an excluded unit', () => {
    const verdict = evaluateTampungBayarEligibility({
      kunjunganRows: [
        ...KUNJUNGAN_OK,
        {
          no_registrasikunjungan: 'R100',
          no_transaksi: '05-100326-000009',
          nama_unit: 'AMBULANCE',
        },
      ],
      roomRows: [ROOM_1, ROOM_2],
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe('ada transaksi terpilih yang tidak boleh ikut tampung bayar');
    expect(verdict.detail).toBe('AMBULANCE (05-100326-000009)');
    expect(verdict.excludedRows.map((row) => row['no_transaksi'])).toEqual([
      '05-100326-000009',
    ]);
  });

  it('refuses on an unbuildable payload, unserved orders, then untransferred orders', () => {
    const unbuildable = buildTampungBayarPayload({
      noRm: '0-12-34-56',
      roomRows: [],
      listTindakanByTrx: {},
    });
    expect(
      evaluateTampungBayarEligibility({
        kunjunganRows: KUNJUNGAN_OK,
        roomRows: [ROOM_1],
        payload: unbuildable,
      }).reason,
    ).toBe('payload tidak dapat dibentuk');

    const terlayani = evaluateTampungBayarEligibility({
      kunjunganRows: KUNJUNGAN_OK,
      roomRows: [ROOM_1],
      orderBelumTerlayani: { total: '2', nama_unit: 'LABORATORIUM' },
      orderBelumTransfer: { total: '1', nama_unit: 'RADIOLOGI' },
    });
    expect(terlayani.reason).toBe('masih ada order belum terlayani');
    expect(terlayani.detail).toBe('2 (LABORATORIUM)');

    const transfer = evaluateTampungBayarEligibility({
      kunjunganRows: KUNJUNGAN_OK,
      roomRows: [ROOM_1],
      orderBelumTerlayani: { total: '0' },
      orderBelumTransfer: { total: '1', nama_unit: 'RADIOLOGI' },
    });
    expect(transfer.reason).toBe('masih ada order belum transfer');
    expect(transfer.detail).toBe('1 (RADIOLOGI)');
  });

  it('refuses a visit that already has a receipt', () => {
    const verdict = evaluateTampungBayarEligibility({
      kunjunganRows: KUNJUNGAN_OK,
      roomRows: [ROOM_1],
      historyPembayaran: [{ no_kwitansi: 'KW-1' }, { no_kwitansi: 'KW-2' }],
    });
    expect(verdict.reason).toBe('riwayat pembayaran sudah ada');
    expect(verdict.detail).toBe('2 (KW-2)');
  });

  it('honours the legacy mode flags in dry_run / debug / enable order', () => {
    const base = { kunjunganRows: KUNJUNGAN_OK, roomRows: [ROOM_1] };
    expect(
      evaluateTampungBayarEligibility({ ...base, dryRun: true, debugTampungBayar: true })
        .reason,
    ).toBe('dry_run aktif');
    expect(evaluateTampungBayarEligibility({ ...base, debugTampungBayar: true }).reason).toBe(
      'debug_tampung_bayar aktif',
    );
    expect(evaluateTampungBayarEligibility({ ...base, enableTampungBayar: false }).reason).toBe(
      'enable_tampung_bayar nonaktif',
    );
  });
});

describe('resolveBiayaAdministrasi', () => {
  it('charges a newborn 250 000 in ICU and in VVIP, 50 000 anywhere else', () => {
    expect(
      resolveBiayaAdministrasiDetail({
        namaPasien: 'BY. NY. PASIEN DUA',
        namaUnit: 'R. ICU',
        defaultHarga: '75000',
      }),
    ).toMatchObject({ harga: '250000', reason: 'byny_icu', isByny: true, isIcu: true });

    expect(
      resolveBiayaAdministrasiDetail({
        namaPasien: 'By.Ny. PASIEN DUA',
        namaUnit: 'MULTAZAM / VVIP',
        defaultHarga: '75000',
      }),
    ).toMatchObject({ harga: '250000', reason: 'byny_vvip', isVvip: true, isVip: false });

    expect(
      resolveBiayaAdministrasi({
        namaPasien: 'BY. NY. PASIEN DUA',
        namaUnit: 'MULTAZAM / KELAS 3',
        defaultHarga: '150000',
      }),
    ).toBe(50000);
  });

  it('charges 250 000 for an adult in ICU, VIP or VVIP', () => {
    expect(
      resolveBiayaAdministrasi({
        namaPasien: 'PASIEN DUA',
        namaUnit: 'AL KAUTSAR / VIP 1',
        defaultHarga: '75000',
      }),
    ).toBe(250000);
    expect(
      resolveBiayaAdministrasiDetail({
        namaPasien: 'PASIEN DUA',
        namaUnit: 'AL KAUTSAR / VIP 1',
        defaultHarga: '75000',
      }),
    ).toMatchObject({ reason: 'icu_vip_or_vvip', isVip: true, isVvip: false });
  });

  it('charges 150 000 for KELAS I/II/III', () => {
    for (const unit of ['MULTAZAM / KELAS 3', 'AL KAUTSAR KELAS II', 'ARAFAH / KELAS I']) {
      expect(
        resolveBiayaAdministrasiDetail({
          namaPasien: 'PASIEN DUA',
          namaUnit: unit,
          defaultHarga: '75000',
        }),
      ).toMatchObject({ harga: '150000', reason: 'kelas_1_2_3', isClass: true });
    }
  });

  it('falls back to 150 000 when the master tariff is missing or zero', () => {
    expect(
      resolveBiayaAdministrasiDetail({
        namaPasien: 'PASIEN DUA',
        namaUnit: 'MULTAZAM',
        defaultHarga: 0,
      }),
    ).toMatchObject({
      harga: '150000',
      reason: 'manual_fallback_zero_master_standard_room',
    });
    expect(
      resolveBiayaAdministrasi({ namaPasien: 'PASIEN DUA', namaUnit: 'MULTAZAM', defaultHarga: '' }),
    ).toBe(150000);
  });

  it('keeps the master tariff for a standard room that has one', () => {
    expect(
      resolveBiayaAdministrasiDetail({
        namaPasien: 'PASIEN DUA',
        namaUnit: 'MULTAZAM',
        defaultHarga: 'Rp 75.000',
      }),
    ).toMatchObject({ harga: 'Rp 75.000', reason: 'default_master' });
    expect(
      resolveBiayaAdministrasi({
        namaPasien: 'PASIEN DUA',
        namaUnit: 'MULTAZAM',
        defaultHarga: 'Rp 75.000',
      }),
    ).toBe(75000);
  });
});
