/**
 * Sanitized rawat jalan fixtures. Synthetic data only.
 * Covers one matching outpatient BPJS record that is unpaid and unverified.
 */

import type { FixtureEntry } from '@simrs-flow/evomedis-client';

export const RAJAL_HAPPY_INPUT = {
  patientIds: ['012345'],
  clinics: ['PENYAKIT DALAM'],
  date: '2026-06-10',
};

/**
 * The same run started by auto-fetch instead of a typed list: no `patientIds`,
 * no `clinics`, a period and the report filters. `maxPatients` is raised above
 * the one-patient pilot default because the fixture report deliberately holds
 * more than one patient.
 */
export const RAJAL_DISCOVERY_INPUT = {
  date: '2026-06-10',
  discovery: {
    instalasi: '1',
    from: '2026-06-10',
    to: '2026-06-10',
    penjamin: 'BPJS',
    maxPatients: 5,
  },
};

const historyRows = [
  {
    no_registrasikunjungan: 'REG-RJ-1',
    no_transaksi: '01-200001',
    kd_unit: 'P01',
    nama_unit: 'POLI PENYAKIT DALAM',
    status_bayar: 'Belum',
    nama_penjamin: 'BPJS PBI',
    tgl_masuk: '2026-06-10',
  },
];

/** One data row of the unpaid-bill report: thirteen cells, legacy's column order. */
function reportRow(cells: readonly string[]): string {
  return `<tr>${cells.map((cell) => `<td align="center">${cell}</td>`).join('')}</tr>`;
}

/**
 * `laporan/laporan_belum_bayar/preview` markup, reduced to the structure
 * `parseLaporanHTML` actually keys on (rajal_v23.js:514):
 *
 *  - the report lives in the **first** `table[border="1"]`; a layout table
 *    precedes it, and a second bordered table follows, so picking the wrong one
 *    is observable;
 *  - a `colspan="13"` row with a `<b>` is a unit heading;
 *  - a `colspan="12"` row is a subtotal and is skipped;
 *  - a data row has ≥13 cells and an integer in cell 0. Cells 1, 2, 3 and 5 are
 *    transaksi, medrec, name and penjamin;
 *  - one cell is commented out, exactly as the live report does between the
 *    discharge time and the sex column — counting it would shift every index.
 */
export const RAJAL_UNPAID_REPORT_HTML = `<html><body>
<table width="100%"><tr><td><b>LAPORAN PASIEN BELUM BAYAR</b></td></tr></table>
<table border="1" cellspacing="0">
  <tr><th>No</th><th>No Transaksi</th><th>No RM</th></tr>
  <tr><td colspan="13"><b>POLI PENYAKIT DALAM</b></td></tr>
  ${reportRow([
    '1',
    '01-200001',
    '0-01-23-45',
    'PASIEN SATU',
    '1990-01-01',
    'BPJS PBI',
    'Dokter A',
    '2026-06-10 08:00:00',
    '2026-06-10 09:00:00',
    'L',
    '-',
    'Belum diverifikasi',
    'belum',
  ])}
  <tr><td align="center">2</td><td align="center">01-200002</td><td align="center">0-67-89-01</td><td align="center">PASIEN DUA</td><td align="center">1985-05-05</td><td align="center">UMUM</td><td align="center">Dokter B</td><td align="center">2026-06-10 08:30:00</td><td align="center">2026-06-10 09:30:00</td><!--<td align="center">09:30:00</td>--><td align="center">P</td><td align="center">-</td><td align="center">Belum diverifikasi</td><td align="center">belum</td></tr>
  <tr><td colspan="12" align="right">Sub Total</td><td align="right">300.000</td></tr>
  <tr><td colspan="13"><b>POLI MATA</b></td></tr>
  ${reportRow([
    '3',
    '01-200003',
    '0-01-23-45',
    'PASIEN SATU',
    '1990-01-01',
    'BPJS NON PBI',
    'Dokter C',
    '2026-06-10 10:00:00',
    '2026-06-10 11:00:00',
    'L',
    '-',
    'Belum diverifikasi',
    'belum',
  ])}
  <tr><td colspan="13"><b>LABORATORIUM KLINIK</b></td></tr>
  ${reportRow([
    '4',
    '13-400001',
    '0-99-88-77',
    'PASIEN TIGA',
    '1970-07-07',
    'BPJS PBI',
    'Analis',
    '2026-06-10 10:15:00',
    '2026-06-10 10:45:00',
    'P',
    '-',
    'Belum diverifikasi',
    'belum',
  ])}
</table>
<table border="1"><tr><td colspan="13"><b>TABEL LAIN</b></td></tr></table>
</body></html>`;

/**
 * The report for a period with nothing outstanding: the table *renders*, it
 * just carries no data row. This is the only shape that proves the period is
 * empty — a reply with no bordered table at all is an unread report, not an
 * empty one, and the discovery step blocks on it.
 */
export const RAJAL_UNPAID_REPORT_EMPTY_HTML = `<html><body>
<table width="100%"><tr><td><b>LAPORAN PASIEN BELUM BAYAR</b></td></tr></table>
<table border="1" cellspacing="0">
  <tr><th>No</th><th>No Transaksi</th><th>No RM</th></tr>
  <tr><td colspan="12" align="right">Sub Total</td><td align="right">0</td></tr>
</table>
</body></html>`;

export const rajalFixtures: Record<string, FixtureEntry> = {
  'kasir.getHistoryKunjungan': { text: JSON.stringify({ rows: historyRows }) },
  // The visit lookup feeds the BPJS card resolution (`no_kk` absent here, so
  // the guarantor tab answers instead).
  'pendaftaran.getDataKunjungan': { text: JSON.stringify({ nama_pasien: 'PASIEN RAJAL' }) },
  // Legacy's two per-record blockers, both read straight from the endpoints the
  // userscript reads: no chemotherapy plan, and a closed visit.
  'kasir.getRencanaOnko': { text: JSON.stringify({ isi_perencanaan: 'Kontrol rutin' }) },
  'poliklinik.getDataCaraKeluarTab': {
    text: JSON.stringify({ tgl_keluar: '2026-06-10 12:30:00', cara_keluar: 'Diijinkan Pulang' }),
  },
  // The three pre-verification blockers legacy checks before it will pay
  // (source lines 1005-1011). A clean registration answers `{}` / total 0.
  'kasir.cekOrderBelumTerlayani': { text: JSON.stringify({ total: 0 }) },
  'kasir.cekOrderBelumTransfer': { text: JSON.stringify({ total: 0 }) },
  'verifikator.cekTransaksiPenunjang': { text: JSON.stringify({}) },
  // SEP validation resolves the BPJS card from the guarantor tab (the visit
  // record carries no `no_kk`), then matches a same-day RJTL SEP whose
  // `poli_tujuan` maps to the selected clinic. The resolved SEP equals the
  // transaction's, so the happy path needs no SEP correction.
  'pendaftaran.getDataPenjaminTab': { text: JSON.stringify({ no_asuransi: '1234567890123' }) },
  'pendaftaran.getRiwayatSep': {
    text: JSON.stringify([
      { tgl_sep: '2026-06-10', jns_pelayanan: 'RJTL', poli_tujuan: 'PENYAKIT DALAM', no_sep: '0123456789012345' },
    ]),
  },
  // The visit tab is the transaction-type discriminator: kd_instalasi '1' =
  // Rawat Jalan. `getDataTransaksi` only supplies the current SEP here.
  'kasir.getDataKunjunganTab': { text: JSON.stringify({ kd_instalasi: '1', no_registrasikunjungan: 'REG-RJ-1' }) },
  'kasir.getDataTransaksi': { text: JSON.stringify({ jenis_sep: 'Rawat Jalan', no_sep: '0123456789012345' }) },
  // The billed lines come from the poli-side controller (the kasir billing
  // endpoints are dead on the live backend). Rows carry the line total and the
  // per-line paid flag that check_payment/submit_payment derive state from.
  'poliklinik.getListTindakan': {
    text: JSON.stringify({
      rows: [
        { nama_tindakan: 'PENDAFTARAN PASIEN', jumlah: '50000', flag: 'Belum', urut_tindakan: '1' },
        { nama_tindakan: 'BIAYA OBAT', jumlah: '100000', flag: 'Belum', urut_tindakan: '2' },
      ],
    }),
  },
  // The cashier grid's rows (live shape: the 20 kasir fields) — what tampung
  // bayar sends as `tindakan`. Same lines as the poli list above.
  'kasir.getListTindakan': {
    text: JSON.stringify({
      rows: [
        { kd_tindakan: '1', tgl_transaksi: '2026-06-10 00:00:00', nama_tindakan: 'PENDAFTARAN PASIEN', harga: '50000', qty: '1', jumlah: '50000', jenis_bayar: '-', status_bayar: 'Belum', urut_tindakan: '1', flag: '0', no_transaksi: '01-200001', kd_detjenispembayaran: '0', t_harga: '50000', t_jumlah: '50000', t_qty: '1', t_urut_tindakan: '1', kd_unit: 'P01', diskon_rp: '0', diskon_persen: '0', racik: '0' },
        { kd_tindakan: '2', tgl_transaksi: '2026-06-10 00:00:00', nama_tindakan: 'BIAYA OBAT', harga: '100000', qty: '1', jumlah: '100000', jenis_bayar: '-', status_bayar: 'Belum', urut_tindakan: '2', flag: '0', no_transaksi: '01-200001', kd_detjenispembayaran: '0', t_harga: '100000', t_jumlah: '100000', t_qty: '1', t_urut_tindakan: '2', kd_unit: 'P01', diskon_rp: '0', diskon_persen: '0', racik: '0' },
      ],
    }),
  },
  'kasir.cekStatusVerifikasi': { text: '0' },
  'laporanBelumBayar.preview': { text: RAJAL_UNPAID_REPORT_HTML },
};
