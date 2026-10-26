import { describe, it, expect } from 'vitest';

import type { LegacyRow } from './types.js';
import {
  REKAP_TOTAL_LABELS,
  buildRekapitulasiDetailHakParams,
  checkBalanceTotalTagihan,
  extractRekapTotal,
} from './balance.js';

/** The later stay, listed first on purpose — the params must still pick the earliest. */
const ROOM_LATE: LegacyRow = {
  no_transaksi: '03-110326-000002',
  no_registrasikunjungan: 'R100',
  kd_unit: '0302',
  nama_unit: 'AL KAUTSAR / KELAS 2',
  urut_masuk_ruang: '2',
  tgl_masuk: '2026-03-11 08:00:00',
  tgl_keluar: '2026-03-13 10:00:00',
};

const ROOM_EARLY: LegacyRow = {
  no_transaksi: '03-100326-000001',
  no_registrasikunjungan: 'R100',
  kd_unit: '0301',
  nama_unit: 'MULTAZAM / KELAS 3',
  urut_masuk_ruang: '1',
  tgl_masuk: '2026-03-10 08:00:00',
  tgl_keluar: '2026-03-11 08:00:00',
};

/** Hoisted `penatajasaInap.getDataKunjungan`. */
const DATAKUNJUNGAN: LegacyRow = {
  kd_unit: '0301',
  kd_detkelpenjamin: '15',
  nama_pasien: 'PASIEN DUA',
};

/** Hoisted `poliklinik.getDataKunjunganTab2`. */
const TAB2: LegacyRow = {
  kd_spesialisasi: '18',
  kd_ruangperawatan: 'RP07',
  kd_kamarperawatan: 'KM0703',
  kd_kelasperawatan: '3',
  kd_detkelpenjamin: '16',
};

/**
 * The rekapitulasi footer as the page renders it: a bolded label cell, then a
 * right-aligned bolded value cell, with the row markup wrapped across lines.
 */
function rekapHtml(totalBiaya: string, totalTagihan?: string): string {
  const rows = [
    `      <tr>
        <td colspan="6" align="right"><b>TOTAL BIAYA</b></td>
        <td align="right"><b>${totalBiaya}</b></td>
      </tr>`,
  ];
  if (totalTagihan !== undefined) {
    rows.push(`      <tr>
        <td colspan="6" align="right"><b>TOTAL TAGIHAN</b></td>
        <td align="right"><b>${totalTagihan}</b></td>
      </tr>`);
  }
  return `<html><body>
  <table class="rekap" border="0">
    <tbody>
      <tr>
        <td>BIAYA KAMAR MULTAZAM KELAS 3</td>
        <td align="right">150.000</td>
      </tr>
${rows.join('\n')}
    </tbody>
  </table>
</body></html>`;
}

describe('buildRekapitulasiDetailHakParams', () => {
  it('emits the endpoint field map in the Python key order', () => {
    const params = buildRekapitulasiDetailHakParams({
      noRm: '0-12-34-56',
      roomRows: [ROOM_LATE, ROOM_EARLY],
      datakunjungan: DATAKUNJUNGAN,
      datakunjunganTab2: TAB2,
    });

    expect(Object.keys(params)).toEqual([
      'nomedrec',
      'no_transaksi',
      'no_registrasikunjungan',
      'kd_spesialisasi',
      'kd_ruangperawatan',
      'kd_kamarperawatan',
      'kd_detkelpenjamin',
      'kd_klasifikasi',
      'periode1',
      'periode2',
      'selisih_biaya',
      'pelaksana',
      'tanpa_tgl',
      'kd_kelasperawatan',
      'params',
      'status_obat',
    ]);
    expect(params).toEqual({
      nomedrec: '0-12-34-56',
      // The earliest stay by tgl_masuk, not the first row supplied.
      no_transaksi: '03-100326-000001',
      no_registrasikunjungan: 'R100',
      kd_spesialisasi: '18',
      kd_ruangperawatan: 'RP07',
      kd_kamarperawatan: 'KM0703',
      // tab2 wins over getdatakunjungan for the payer.
      kd_detkelpenjamin: '16',
      kd_klasifikasi: '',
      periode1: '2026-03-10',
      periode2: '2026-03-13',
      selisih_biaya: '0',
      pelaksana: '0',
      tanpa_tgl: '0',
      kd_kelasperawatan: '3',
      params: 'belum_verif',
      status_obat: '',
    });
  });

  it('returns {} for an empty group so the caller skips the fetch', () => {
    expect(
      buildRekapitulasiDetailHakParams({ noRm: '0-12-34-56', roomRows: [] }),
    ).toEqual({});
  });

  it('ignores the tab2 row when kd_unit cannot be resolved, as the Python skips that call', () => {
    const params = buildRekapitulasiDetailHakParams({
      noRm: '0-12-34-56',
      roomRows: [{ ...ROOM_EARLY, kd_unit: '' }],
      datakunjungan: { kd_detkelpenjamin: '15' },
      datakunjunganTab2: TAB2,
    });

    expect(params['kd_spesialisasi']).toBe('');
    expect(params['kd_ruangperawatan']).toBe('');
    expect(params['kd_kamarperawatan']).toBe('');
    expect(params['kd_kelasperawatan']).toBe('');
    // Falls through to getdatakunjungan for the payer.
    expect(params['kd_detkelpenjamin']).toBe('15');
  });

  it('falls back to tgl_masuk for periode2 when a stay has no discharge', () => {
    const params = buildRekapitulasiDetailHakParams({
      noRm: '0-12-34-56',
      roomRows: [ROOM_EARLY, { ...ROOM_LATE, tgl_keluar: '' }],
    });
    expect(params['periode1']).toBe('2026-03-10');
    expect(params['periode2']).toBe('2026-03-11');
  });

  it('carries the caller-supplied params/status_obat through unchanged', () => {
    const params = buildRekapitulasiDetailHakParams({
      noRm: '0-12-34-56',
      roomRows: [ROOM_EARLY],
      paramsState: 'sudah_verif',
      statusObat: 'obat',
    });
    expect(params['params']).toBe('sudah_verif');
    expect(params['status_obat']).toBe('obat');
  });

  it('throws when no room row has a readable tgl_masuk (the Python ValueError)', () => {
    expect(() =>
      buildRekapitulasiDetailHakParams({
        noRm: '0-12-34-56',
        roomRows: [{ no_transaksi: '03-100326-000001', no_registrasikunjungan: 'R100' }],
      }),
    ).toThrow(/tgl_masuk/);
  });
});

describe('extractRekapTotal', () => {
  it('reads Indonesian thousands separators as whole rupiah', () => {
    const html = rekapHtml('12.500.000', '12.500.000');
    expect(extractRekapTotal(html, 'TOTAL BIAYA')).toBe(12500000);
    expect(extractRekapTotal(html, 'TOTAL TAGIHAN')).toBe(12500000);
  });

  it('strips a currency prefix and surrounding whitespace', () => {
    expect(extractRekapTotal(rekapHtml('Rp 12.500.000 '), 'TOTAL BIAYA')).toBe(12500000);
  });

  it('absorbs a decimal comma into the digits, as _parse_currency_int does', () => {
    // Legacy behaviour, pinned deliberately: the scrape has no notion of a
    // fractional part, so a "…,00" suffix inflates the value by 100. The page
    // prints whole rupiah, and both sides of the comparison are mangled the
    // same way, which is why the Python never noticed.
    expect(extractRekapTotal(rekapHtml('12.500.000,00'), 'TOTAL BIAYA')).toBe(1250000000);
  });

  it('matches the label case-insensitively and across newlines', () => {
    // re.I on the label; re.S so the scan crosses the line break before the cell.
    const html = `<tr><td colspan="6"><b>Total Tagihan</b></td>
      <td align="right"><b>9.000.000</b></td></tr>`;
    expect(extractRekapTotal(html, 'TOTAL TAGIHAN')).toBe(9000000);
  });

  it('returns 0 for a missing label, empty html, and an unbolded value cell', () => {
    expect(extractRekapTotal(rekapHtml('12.500.000'), 'TOTAL TAGIHAN')).toBe(0);
    expect(extractRekapTotal('', 'TOTAL BIAYA')).toBe(0);
    expect(extractRekapTotal('<b>TOTAL BIAYA</b><td>12.500.000</td>', 'TOTAL BIAYA')).toBe(0);
  });
});

describe('checkBalanceTotalTagihan', () => {
  it('balances when the kasir grand total equals both rekapitulasi totals', () => {
    const result = checkBalanceTotalTagihan({
      rekapHtml: rekapHtml('12.500.000', '12.500.000'),
      kasirTotals: { grand_total: '12500000' },
      roomRows: [ROOM_EARLY, ROOM_LATE],
    });

    expect(result.balanced).toBe(true);
    expect(result.reason).toBe('balance');
    expect(result.kasirTotal).toBe(12500000);
    expect(result.rekapTotal).toBe(12500000);
    expect(result.difference).toBe(0);
    expect(result.reg).toBe('R100');
    expect(result.details).toEqual([
      { label: 'TOTAL BIAYA', value: 12500000, difference: 0 },
      { label: 'TOTAL TAGIHAN', value: 12500000, difference: 0 },
    ]);
  });

  it('reports the difference when the rekapitulasi tagihan lags the kasir', () => {
    const result = checkBalanceTotalTagihan({
      rekapHtml: rekapHtml('12.500.000', '12.450.000'),
      kasirTotals: { grand_total: 'Rp 12.500.000' },
      roomRows: [ROOM_EARLY],
    });

    expect(result.balanced).toBe(false);
    expect(result.reason).toBe('total_belum_balance');
    expect(result.kasirTotal).toBe(12500000);
    expect(result.rekapTotal).toBe(12450000);
    expect(result.difference).toBe(50000);
    expect(result.details).toEqual([
      { label: 'TOTAL BIAYA', value: 12500000, difference: 0 },
      { label: 'TOTAL TAGIHAN', value: 12450000, difference: 50000 },
    ]);
  });

  it('refuses when the page has no TOTAL TAGIHAN at all (a truncated page reads as 0)', () => {
    const result = checkBalanceTotalTagihan({
      rekapHtml: rekapHtml('12.500.000'),
      kasirTotals: { grand_total: '12500000' },
      roomRows: [ROOM_EARLY],
    });

    expect(result.balanced).toBe(false);
    expect(result.reason).toBe('total_belum_balance');
    expect(result.rekapTotal).toBe(0);
    expect(result.difference).toBe(12500000);
    expect(result.details[1]).toEqual({
      label: 'TOTAL TAGIHAN',
      value: 0,
      difference: 12500000,
    });
  });

  it('refuses a zero kasir grand total even against a zero rekapitulasi', () => {
    const result = checkBalanceTotalTagihan({
      rekapHtml: rekapHtml('0', '0'),
      kasirTotals: { grand_total: '0' },
      roomRows: [ROOM_EARLY],
    });

    expect(result.balanced).toBe(false);
    expect(result.reason).toBe('grand_total_kasir_nol');
  });

  it('refuses an empty room group before looking at any total', () => {
    const result = checkBalanceTotalTagihan({
      rekapHtml: rekapHtml('12.500.000', '12.500.000'),
      kasirTotals: { grand_total: '12500000' },
      roomRows: [],
    });

    expect(result.balanced).toBe(false);
    expect(result.reason).toBe('room_rows_kosong');
    expect(result.reg).toBe('');
  });

  it('accepts the kasir total as a bare number or string', () => {
    const html = rekapHtml('12.500.000', '12.500.000');
    expect(checkBalanceTotalTagihan({ rekapHtml: html, kasirTotals: 12500000 }).balanced).toBe(
      true,
    );
    expect(
      checkBalanceTotalTagihan({ rekapHtml: html, kasirTotals: '12.500.000' }).balanced,
    ).toBe(true);
    expect(checkBalanceTotalTagihan({ rekapHtml: html, kasirTotals: undefined }).reason).toBe(
      'grand_total_kasir_nol',
    );
  });

  it('compares exactly the two labels the Python looks up, in order', () => {
    expect(REKAP_TOTAL_LABELS).toEqual(['TOTAL BIAYA', 'TOTAL TAGIHAN']);
    const result = checkBalanceTotalTagihan({
      rekapHtml: rekapHtml('12.500.000', '12.500.000'),
      kasirTotals: 12500001,
    });
    // One rupiah out is out: the Python allows no tolerance.
    expect(result.balanced).toBe(false);
    expect(result.details.map((detail) => detail.label)).toEqual([...REKAP_TOTAL_LABELS]);
  });
});
