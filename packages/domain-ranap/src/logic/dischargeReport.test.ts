import { describe, expect, it } from 'vitest';
import { buildRanapDischargeQuery, parseRanapDischargeReport } from './dischargeReport.js';

const row = (rm: string, masuk: string) =>
  `<tr><td>1</td><td>PASIEN A, TN</td><td>1964-07-10</td><td>62 Th</td><td>${rm}</td><td>ICU</td><td>BPJS NON PBI</td><td>dr. X</td>` +
  `<td>${masuk} 23:07:32</td><td>2026-10-19 04:00:00</td><td>P</td><td></td><td>-</td><td>-</td><td>-</td><td>2 Hari</td><td>Pulang</td><td>Belum diverifikasi</td><td>belum</td></tr>`;

describe('parseRanapDischargeReport', () => {
  it('reads patient rows and skips header, footer and nested tables', () => {
    const html = `<table border="1"><tr><td colspan="19"><table><tr><td>RS</td></tr></table></td></tr>
      <tr><td>NO</td><td>NAMA PASIEN</td></tr>${row('0-90-00-02', '2026-10-18')}${row('0-90-00-03', '2026-10-08')}
      <tr><td colspan="8"><table><tr><td>Jumlah</td></tr></table></td></tr></table>`;
    const report = parseRanapDischargeReport(html);
    expect(report.readable).toBe(true);
    expect(report.rows.map((r) => [r.noRm, r.tglMasuk, r.ruang, r.verifikasi])).toEqual([
      ['0-90-00-02', '2026-10-18', 'ICU', 'Belum diverifikasi'],
      ['0-90-00-03', '2026-10-08', 'ICU', 'Belum diverifikasi'],
    ]);
  });

  it('reads verifikasi/bayar from the last two cells of the 21-cell live row', () => {
    const live = `<table border="1"><tr><td>1</td><td>PASIEN B</td><td>1972-01-05</td><td>54 Th</td><td>0-12-34-56</td><td>INAYAH</td><td>BPJS PBI</td><td>dr. Y</td>` +
      `<td>2026-10-07 11:00:01</td><td>2026-10-19 15:14:00</td><td>15:14:00</td><td>P</td><td></td><td>-</td><td>-, -</td><td>-, -</td><td>NO RM</td><td>13 Hari</td><td>Atas Persetujuan Dokter</td><td>Terverikasi</td><td>sudah_payment</td></tr></table>`;
    expect(parseRanapDischargeReport(live).rows[0]).toMatchObject({ tglMasuk: '2026-10-07', tglKeluar: '2026-10-19', verifikasi: 'Terverikasi', bayar: 'sudah_payment' });
  });

  it('treats a page without the report table as unreadable, not empty', () => {
    expect(parseRanapDischargeReport('<html>login</html>')).toEqual({ readable: false, rows: [] });
  });

  it('builds the SIMRS query with verifikasi/bayar flags', () => {
    const q = buildRanapDischargeQuery({ keluarFrom: '2026-10-01', keluarTo: '2026-10-19', verifikasi: '0', bayar: '' });
    expect(q).toMatchObject({ txtperiode1_rmshpxkeluarri: '2026-10-01', verifikasi: '0', bayar: '', kd_paramedis: 'undefined' });
  });
});
