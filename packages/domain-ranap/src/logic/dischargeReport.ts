/**
 * Discharged-inpatient report — `rekam_medis/laporan_keluar_rwi_kasir/preview`.
 *
 * The run setup's "Ambil data" for rawat inap: the same report the cashier
 * prints (PASIEN KELUAR RAWAT INAP), filtered by discharge/admission period,
 * verification and payment state, and penjamin group. Pure: the orchestrator
 * fetches, this builds the query and reads the table.
 */

import { stripHtmlText } from './scalars.js';

/** `cmb_verifikasi` / `cmb_bayar` on the SIMRS form: '' = semua, '1' = sudah, '0' = belum. */
export type RanapReportFlag = '' | '0' | '1';

export interface RanapDischargeQuery {
  /** Discharge period (tgl keluar), ISO dates. */
  keluarFrom: string;
  keluarTo: string;
  /** Optional admission period (tgl masuk). */
  masukFrom?: string;
  masukTo?: string;
  verifikasi?: RanapReportFlag;
  bayar?: RanapReportFlag;
  /** `kd_kelpenjamin` (getcmbpenjamin): 1 UMUM, 2 BPJS, 3 ASURANSI, 4 KARYAWAN; '' = semua. */
  kelPenjamin?: string;
}

/** Penjamin groups from `laporan_keluar_rwi_kasir/getcmbpenjamin` (live, 2026-10). */
export const RANAP_REPORT_PENJAMIN_OPTIONS = [
  { code: '', label: 'Semua penjamin' },
  { code: '1', label: 'UMUM' },
  { code: '2', label: 'BPJS' },
  { code: '3', label: 'ASURANSI' },
  { code: '4', label: 'KARYAWAN' },
] as const;

export function buildRanapDischargeQuery(q: RanapDischargeQuery): Record<string, string> {
  return {
    txtperiode1_rmshpxkeluarri: q.keluarFrom,
    txtperiode2_rmshpxkeluarri: q.keluarTo,
    txtperiode1_rmshpxmasukri: q.masukFrom ?? '',
    txtperiode2_rmshpxmasukri: q.masukTo ?? '',
    // The SIMRS form itself sends the literal "undefined" for an unset combo.
    kd_paramedis: 'undefined',
    nama_paramedis: '',
    kd_statuskeluar: 'undefined',
    nama_statuskeluar: '',
    kd_kelpenjamin: q.kelPenjamin ?? '',
    kd_detkelpenjamin: '',
    ruang_pendek: '',
    verifikasi: q.verifikasi ?? '',
    bayar: q.bayar ?? '',
  };
}

export interface RanapDischargeRow {
  noRm: string;
  nama: string;
  ruang: string;
  jaminan: string;
  dpjp: string;
  /** `YYYY-MM-DD` — what the run's `tanggal` is matched against (tgl masuk ± toleransi). */
  tglMasuk: string;
  tglKeluar: string;
  verifikasi: string;
  bayar: string;
}

export interface RanapDischargeReport {
  /** False when no `table[border=1]` rendered — an unread report is not an empty one. */
  readable: boolean;
  rows: RanapDischargeRow[];
}

const RM_PATTERN = /^\d-\d{2}-\d{2}-\d{2}$/;

/**
 * Data rows are the 19-cell rows whose RM cell looks like a medrec; header,
 * footer and nested summary tables never do, so a flat `<tr>` scan is enough.
 * Columns: NO, NAMA, TGL LAHIR, UMUR, NO RM, RUANG, JAMINAN, DPJP, TGL MASUK,
 * TGL KELUAR, L/P, TG OPERASI, DIAG ×3, LAMA RAWAT, KET, VERIFIKASI, PROSES.
 * The live report inserts JAM KELUAR and one more column (21 cells); the
 * leading nine and the trailing two (VERIFIKASI, PROSES) stay put.
 */
export function parseRanapDischargeReport(html: string): RanapDischargeReport {
  if (!/<table\b[^>]*\bborder\s*=\s*["']?1/i.test(html)) return { readable: false, rows: [] };
  const rows: RanapDischargeRow[] = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripHtmlText(c[1]));
    if (cells.length < 19 || !RM_PATTERN.test(cells[4] ?? '')) continue;
    rows.push({
      noRm: cells[4]!,
      nama: cells[1] ?? '',
      ruang: cells[5] ?? '',
      jaminan: cells[6] ?? '',
      dpjp: cells[7] ?? '',
      tglMasuk: (cells[8] ?? '').slice(0, 10),
      tglKeluar: (cells[9] ?? '').slice(0, 10),
      // Status columns are read from the end: the live report (2026-10-20) has 21
      // cells — JAM KELUAR after TGL KELUAR plus one more before LAMA RAWAT — so
      // fixed indexes 17/18 returned "13 Hari" / "Atas Persetujuan Dokter".
      verifikasi: cells.at(-2) ?? '',
      bayar: cells.at(-1) ?? '',
    });
  }
  return { readable: true, rows };
}
