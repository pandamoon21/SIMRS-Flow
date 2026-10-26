import { describe, it, expect } from 'vitest';

import type { LegacyRow } from './types.js';
import {
  buildVerifikasiSummaryRow,
  DEFAULT_USER_PROSES,
  VERIFIKASI_SUMMARY_HEADER,
} from './summary.js';

/** A two-room stay: KELAS 3 on 10 Mar, moved up to KELAS 2 until 12 Mar. */
const ROOM_ROWS: readonly LegacyRow[] = [
  {
    no_registrasikunjungan: 'R100',
    no_transaksi: '03-100326-000001',
    kd_unit: 'U01',
    nama_pasien: 'BY. NY. SITI',
    nama_penjamin: 'BPJS NON PBI',
    nama_unit: 'MULTAZAM / KELAS 3',
    tgl_masuk: '2026-03-10 08:00:00',
    tgl_keluar: '2026-03-11 08:00:00',
  },
  {
    no_registrasikunjungan: 'R100',
    no_transaksi: '03-100326-000001',
    kd_unit: 'U01',
    nama_unit: 'AL KAUTSAR / KELAS 2',
    tgl_masuk: '2026-03-11 08:00:00',
    tgl_keluar: '2026-03-12 10:00:00',
  },
];

/** A KELAS 3 entitlement — anything above it is a titipan. */
const SEP_KELAS_3: LegacyRow = { no_sep: '0301R0110326V000123', kelas_rawat: 'Kelas 3' };

describe('VERIFIKASI_SUMMARY_HEADER', () => {
  it('is the header main() prints, in order', () => {
    expect(VERIFIKASI_SUMMARY_HEADER.join('\t')).toBe(
      'nama pasien\tno rekam medis\tPBI/NON PBI\tuser_proses\tgrand total\ttanggal masuk\ttanggal keluar\tketerangan',
    );
  });
});

describe('buildVerifikasiSummaryRow', () => {
  it('puts every cell under its header column', () => {
    const { cells, tsv } = buildVerifikasiSummaryRow({
      noRm: '0123456',
      roomRows: ROOM_ROWS,
      namaPasien: 'BY. NY. SITI',
      namaPenjamin: 'BPJS NON PBI',
      sepItem: SEP_KELAS_3,
      bynyRmeStatus: { is_healthy: true },
      userProses: 'operator1',
      grandTotal: 'Rp 1.250.000',
      keterangan: 'HASIL LAB PK tanggal 2026-03-10',
    });

    expect(cells).toHaveLength(VERIFIKASI_SUMMARY_HEADER.length);
    const byColumn = Object.fromEntries(
      VERIFIKASI_SUMMARY_HEADER.map((name, index) => [name, cells[index]]),
    );
    expect(byColumn).toEqual({
      'nama pasien': 'BY. NY. SITI',
      'no rekam medis': '0123456',
      'PBI/NON PBI': 'NON PBI',
      user_proses: 'operator1',
      'grand total': '1250000',
      'tanggal masuk': '2026-03-10',
      'tanggal keluar': '2026-03-12',
      keterangan: 'TITIPAN; BAYI SEHAT; HASIL LAB PK tanggal 2026-03-10',
    });
    expect(tsv).toBe(cells.join('\t'));
  });

  it('falls back to the primary room row, the RM and the default operator', () => {
    const { cells } = buildVerifikasiSummaryRow({
      noRm: '0123456',
      roomRows: [{ nama_pasien: 'PASIEN DUA', nama_penjamin: 'BPJS PBI' }],
    });
    expect(cells).toEqual([
      'PASIEN DUA',
      '0123456',
      'PBI',
      DEFAULT_USER_PROSES,
      '0',
      '-',
      '-',
      '',
    ]);
  });

  it('prefers no_medicalrecord over no_rm and keeps an unknown payer verbatim', () => {
    const { cells } = buildVerifikasiSummaryRow({
      noRm: '0123456',
      noMedicalrecord: '0-12-34-56',
      roomRows: [{ nama_penjamin: 'JAMKESDA KEBUMEN' }],
    });
    expect(cells[1]).toBe('0-12-34-56');
    expect(cells[2]).toBe('JAMKESDA KEBUMEN');
    expect(cells[0]).toBe('-');
  });

  it('leaves the keterangan empty when nothing applies', () => {
    const { cells } = buildVerifikasiSummaryRow({
      noRm: '0123456',
      // Entitled to KELAS 3 and billed KELAS 3: no titipan.
      roomRows: [ROOM_ROWS[0] as LegacyRow],
      sepItem: SEP_KELAS_3,
      bynyRmeStatus: { is_healthy: false },
    });
    expect(cells[7]).toBe('');
  });

  it('accepts the hoisted penunjang keterangan as a list and de-duplicates it', () => {
    const { cells } = buildVerifikasiSummaryRow({
      noRm: '0123456',
      roomRows: ROOM_ROWS,
      namaPasien: 'BY. NY. SITI',
      sepItem: SEP_KELAS_3,
      keterangan: ['TITIPAN', 'HASIL RADIOLOGI tanggal 2026-03-11', 'HASIL RADIOLOGI tanggal 2026-03-11'],
    });
    expect(cells[7]).toBe('TITIPAN; HASIL RADIOLOGI tanggal 2026-03-11');
  });

  it('renders no row at all without room rows', () => {
    expect(buildVerifikasiSummaryRow({ noRm: '0123456', roomRows: [] })).toEqual({
      cells: [],
      tsv: '',
    });
  });
});
