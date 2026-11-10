/**
 * What each rajal node's executor can conclude and touch, declared as data.
 *
 * Per node: every `StepResult` status + summary template the executor can
 * return (`…` = a value filled in at runtime), the issue codes and detail
 * findings it reports, the writes it can plan (with the plan's reason) and the
 * endpoints it reads. `ruleCatalog.ts` builds the Rules page catalog from this.
 *
 * Kept true by `domain-rajal.test.ts`: every fixture run records what the
 * executors return, and the suite fails on any status/summary, issue code or
 * planned write a node does not declare here. Change an executor's outcome,
 * change its entry here in the same commit.
 */
import type { DeclaredOutcomes } from '@simrs-flow/workflow-core';
import type { RajalNodeId } from './nodes.js';

export const RAJAL_OUTCOMES: Readonly<Record<RajalNodeId, DeclaredOutcomes>> = {
  load_config: {
    outcomes: [
      { status: 'failed', text: 'Cari otomatis butuh periode (dari dan sampai)' },
      { status: 'failed', text: 'Periode cari otomatis terbalik: … → …' },
      { status: 'failed', text: 'Belum ada No. RM' },
      { status: 'failed', text: 'Belum ada poli dipilih' },
      { status: 'success', text: 'Cari otomatis … → … (instalasi …)…' },
      { status: 'success', text: '… pasien, … poli' },
    ],
  },
  normalize_ids: {
    outcomes: [
      { status: 'success', text: '… No. RM unik' },
      { status: 'blocked', text: 'Gagal membaca laporan cari otomatis untuk …: … — tidak ada antrean ditemukan; laporan yang gagal dibaca bukan laporan kosong' },
      { status: 'blocked', text: 'Gagal membaca laporan cari otomatis untuk …: laporan_belum_bayar dijawab tanpa tabel laporan — laporan yang gagal dibaca bukan laporan kosong' },
      { status: 'skipped', text: 'Tidak ada yang ditagih: … berisi … baris belum bayar, tidak ada yang cocok dengan …' },
      { status: 'blocked', text: 'Ditemukan … pasien… pada …, melebihi batas … pasien untuk run ini — persempit periode, filter penjamin atau unit, atau naikkan batas dengan sengaja' },
      { status: 'success', text: '… No. RM unik dari … baris belum bayar' },
    ],
    reads: ['laporanBelumBayar.preview'],
  },
  resolve_clinics: {
    outcomes: [
      { status: 'failed', text: 'Tidak ada poli yang bisa ditentukan' },
      { status: 'skipped', text: 'Antrean hasil cari otomatis kosong — tidak ada poli untuk ditentukan' },
      { status: 'blocked', text: 'Laporan tidak memuat seksi poli yang bisa ditagih — semua judulnya kelompok penunjang/farmasi' },
      { status: 'success', text: 'Poli diproses: …' },
    ],
  },
  start_batch: {
    outcomes: [
      { status: 'success', text: 'Antrean … pasien dimulai' },
    ],
  },
  load_history: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada pasien dalam antrean' },
      { status: 'needs_review', text: 'Riwayat kunjungan gagal dibaca untuk …/… pasien: …' },
      { status: 'success', text: '… baris kunjungan dibaca untuk … pasien' },
    ],
    reads: ['kasir.getHistoryKunjungan'],
  },
  filter_records: {
    outcomes: [
      { status: 'blocked', text: 'Kunjungan penunjang belum ditransfer dan belum dibayar: …' },
      { status: 'needs_review', text: 'Tidak ada kunjungan yang jelas: … kunjungan cocok dengan dua poli terpilih — …' },
      { status: 'skipped', text: 'Tidak ada kunjungan yang cocok' },
      { status: 'needs_review', text: '… kunjungan cocok; …' },
      { status: 'success', text: '… kunjungan cocok' },
    ],
  },
  check_rencana_onko: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan' },
      { status: 'skipped', text: 'Tidak dicek — SIMRS tidak lagi menyediakan rencana onkologi; pastikan pasien kemoterapi secara manual' },
    ],
  },
  validate_exit_date: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan' },
      { status: 'blocked', text: 'Belum ada tanggal keluar pada … kunjungan: … — kunjungan belum ditutup' },
      { status: 'success', text: '… kunjungan sudah punya tanggal keluar' },
      { status: 'needs_review', text: '… — getdatacarakeluar_tab did not answer with a discharge record' },
      { status: 'needs_review', text: '… record(s) remain after exit-date check; …' },
    ],
    reads: ['poliklinik.getDataCaraKeluarTab'],
  },
  validate_transaction: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan' },
      { status: 'blocked', text: 'Transaksi … adalah Rawat Inap, bukan Rawat Jalan' },
      { status: 'needs_review', text: 'Tidak ada transaksi Rawat Jalan yang bisa ditagih — …' },
      { status: 'needs_review', text: '… transaksi Rawat Jalan; …' },
      { status: 'success', text: '… transaksi Rawat Jalan' },
    ],
    findings: [
      '… (instalasi …)',
    ],
    reads: ['kasir.getDataKunjunganTab', 'kasir.getDataTransaksi'],
  },
  validate_treatment: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan' },
      { status: 'blocked', text: 'Excluded treatment found on …: "…" (found: "…")' },
      { status: 'blocked', text: 'Excluded treatment found on …: …' },
      { status: 'blocked', text: 'Required treatment group … unsatisfied on …: none of … billed' },
      { status: 'blocked', text: 'Only …/… treatment row(s) matched on …; minimum …' },
      { status: 'blocked', text: 'Blocker tindakan: …' },
      { status: 'needs_review', text: 'Kunjungan poli belum dapat dipastikan pada …: tanggal/unit atau riwayat pasien tidak terbaca' },
      { status: 'needs_review', text: 'Daftar tindakan tidak terbaca pada …: …' },
      { status: 'needs_review', text: 'Daftar tindakan … tidak terbaca: jawaban tanpa baris' },
      { status: 'needs_review', text: 'Penunjang belum digolongkan pada …: …' },
      { status: 'needs_review', text: 'Tidak ada tindakan pada …' },
      { status: 'needs_review', text: 'Tidak ada tindakan yang cocok dengan aturan pada …' },
      { status: 'needs_review', text: '… record(s) remain after treatment check; … skipped — …' },
      { status: 'success', text: '…/… baris tindakan cocok dengan aturan pada … kunjungan' },
      { status: 'success', text: '… baris tindakan pada … kunjungan' },
    ],
    findings: [
      'Kunjungan poli belum dapat dipastikan pada …: tanggal/unit atau riwayat pasien tidak terbaca',
      'Daftar tindakan tidak terbaca pada …: …',
      'Daftar tindakan … tidak terbaca: jawaban tanpa baris',
      'Penunjang belum digolongkan pada …: …',
      "Excluded treatment found on …: \"…\" (found: \"…\")",
      'Required treatment group … unsatisfied on …: none of … billed',
      'Excluded treatment found on …: …',
      'Only …/… treatment row(s) matched on …; minimum …',
      'Tidak ada tindakan pada …',
      'Tidak ada tindakan yang cocok dengan aturan pada …',
    ],
    reads: ['poliklinik.getListTindakan'],
  },
  validate_radiology: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan' },
      { status: 'needs_review', text: '… kunjungan tersisa setelah cek …; … dilewati — …' },
      { status: 'blocked', text: 'Order radiologi belum ada pada …: … tindakan radiologi ditagih tetapi tidak ada order tanggal …' },
      { status: 'blocked', text: 'Order radiologi belum disetujui pada …: …/… order belum disetujui maupun dilayani' },
      { status: 'blocked', text: 'Hasil radiologi kurang pada …: … tindakan radiologi ditagih vs … transaksi hasil tanggal …' },
      { status: 'blocked', text: 'Hasil radiologi belum ada pada …: belum ada ekspertise pada transaksi radiologi …' },
      { status: 'success', text: 'Tidak ada tindakan radiologi yang ditagih' },
      { status: 'success', text: '… tindakan radiologi sudah ada hasilnya' },
      { status: 'blocked', text: 'Cek radiologi tidak bisa dijalankan pada …: No. RM tidak diketahui' },
      { status: 'blocked', text: 'Blocker Radiologi: …' },
    ],
    findings: [
      'Cek … tidak bisa dijalankan pada …: No. RM tidak diketahui',
    ],
    reads: ['poliklinik.getHistoryIrad', 'radiologi.getDataKunjungan', 'radiologi.getHasilPemeriksaan'],
  },
  validate_elektromedik: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan' },
      { status: 'needs_review', text: '… kunjungan tersisa setelah cek …; … dilewati — …' },
      { status: 'blocked', text: 'Hasil elektromedik kurang pada …: … tindakan elektromedik ditagih vs … transaksi hasil tanggal …' },
      { status: 'blocked', text: 'Hasil elektromedik belum ada pada …: belum ada uraian pada transaksi elektromedik …' },
      { status: 'success', text: 'Tidak ada tindakan elektromedik yang ditagih' },
      { status: 'success', text: '… tindakan elektromedik sudah ada hasilnya' },
      { status: 'blocked', text: 'Cek elektromedik tidak bisa dijalankan pada …: No. RM tidak diketahui' },
      { status: 'blocked', text: 'Blocker Elektromedik: …' },
    ],
    findings: [
      'Cek … tidak bisa dijalankan pada …: No. RM tidak diketahui',
    ],
    reads: ['elektromedikHasil.getDataPasien', 'elektromedikHasil.getListHasilPemeriksaan'],
  },
  validate_lab_pa: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan' },
      { status: 'needs_review', text: '… kunjungan tersisa setelah cek …; … dilewati — …' },
      { status: 'blocked', text: 'Order Lab PA belum ada pada …: … tindakan PA ditagih tetapi tidak ada order PA' },
      { status: 'blocked', text: 'Order Lab PA belum ada pada …: tidak ada order PA tanggal …' },
      { status: 'blocked', text: 'Order Lab PA belum lengkap pada …: order PA … tidak punya baris pemeriksaan' },
      { status: 'blocked', text: 'Hasil Lab PA belum ada pada …: order PA … belum punya hasil cetak' },
      { status: 'success', text: 'Tidak ada tindakan lab PA yang ditagih' },
      { status: 'success', text: '… tindakan lab PA sudah ada hasilnya' },
      { status: 'blocked', text: 'Cek lab pa tidak bisa dijalankan pada …: No. RM tidak diketahui' },
      { status: 'blocked', text: 'Blocker Lab PA: …' },
    ],
    findings: [
      'Cek … tidak bisa dijalankan pada …: No. RM tidak diketahui',
    ],
    reads: ['kemoterapi.getDetailHistoryOrderPa', 'kemoterapi.getHistoryOrderPa', 'pa.hasilCetak'],
  },
  validate_lab: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan' },
      { status: 'needs_review', text: '… kunjungan tersisa setelah cek …; … dilewati — …' },
      { status: 'blocked', text: 'Order laboratorium belum ada pada …: … tindakan lab ditagih tetapi tidak ada order lab tanggal …' },
      { status: 'blocked', text: "Hasil laboratorium belum ada pada …: order lab … melaporkan \"…\"" },
      { status: 'blocked', text: 'Hasil laboratorium belum ada pada …: order lab … menghasilkan cetakan LIS kosong' },
      { status: 'blocked', text: 'Hasil laboratorium belum ada pada …: order lab … galat GET: …' },
      { status: 'blocked', text: 'Hasil laboratorium belum ada pada …: order lab … …' },
      { status: 'success', text: 'Tidak ada tindakan laboratorium yang ditagih' },
      { status: 'success', text: '… tindakan laboratorium sudah ada hasilnya' },
      { status: 'blocked', text: 'Cek laboratorium tidak bisa dijalankan pada …: No. RM tidak diketahui' },
      { status: 'blocked', text: 'Blocker Laboratorium: …' },
    ],
    findings: [
      'Cek … tidak bisa dijalankan pada …: No. RM tidak diketahui',
      'Not PDF (…)',
      'Empty PDF (Content-Length: … ≤ …)',
      'PDF with data (Content-Length: … > …)',
      'PDF streamed (Transfer-Encoding: chunked)',
      'HTTP …',
      'Not a valid PDF',
      'Empty PDF (… ≤ … bytes)',
      'Valid PDF (… > … bytes)',
    ],
    reads: ['laboratoriumHasil.cetakLis', 'laboratoriumHasil.lisPdf', 'laboratoriumHasil.lisPdfHead', 'penatajasaInap.getHistoryILab'],
  },
  check_berkas: {
    outcomes: [
      { status: 'skipped', text: 'Cek berkas (OCR) tidak tersedia di host ini' },
      { status: 'skipped', text: 'Tidak ada kunjungan' },
      { status: 'needs_review', text: 'Berkas belum lengkap: … — periksa manual' },
      { status: 'success', text: 'Berkas lengkap untuk … kunjungan' },
    ],
    reads: ['eklaim.cetakSimplifikasi', 'uploadBerkas.getDataPiutang'],
  },
  validate_sep: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada transaksi' },
      { status: 'skipped', text: 'Validasi SEP dinonaktifkan untuk run ini' },
      { status: 'needs_review', text: '… SEP transaksi tersisa; … dilewati — …' },
      { status: 'needs_review', text: 'SEP tidak cocok pada …/… transaksi; koreksi direncanakan (dry-run)' },
      { status: 'success', text: '… SEP transaksi cocok dengan tanggal kunjungan dan poli tujuan' },
      { status: 'blocked', text: 'No kartu BPJS kosong untuk transaksi …' },
      { status: 'blocked', text: 'Multiple same-day SEP candidates for transaction … (…)' },
      { status: 'blocked', text: 'Tidak ada SEP … tanggal … untuk poli … pada transaksi …' },
      { status: 'blocked', text: 'Blocker SEP: …' },
      { status: 'failed', text: 'Riwayat SEP tidak terbaca pada …: …' },
    ],
    findings: [
      'No kartu BPJS kosong untuk transaksi …',
      'Riwayat SEP tidak terbaca pada …: …',
      'Multiple same-day SEP candidates for transaction … (…)',
      'Tidak ada SEP … tanggal … untuk poli … pada transaksi …',
    ],
    actions: [
      { endpointId: 'rekamMedis.simpanSep', text: 'Koreksi SEP pada transaksi …: … → …' },
    ],
    reads: ['pendaftaran.getDataKunjungan', 'pendaftaran.getDataPenjaminTab', 'pendaftaran.getRiwayatSep'],
    writes: ['rekamMedis.simpanSep'],
  },
  check_payment: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan' },
      { status: 'skipped', text: 'Sudah dibayar (… kunjungan)' },
      { status: 'success', text: '…/… kunjungan bisa dibayar' },
      { status: 'needs_review', text: 'Status bayar tidak terbaca pada …/… kunjungan: …' },
      { status: 'needs_review', text: '…/… payable record(s); payment state unreadable on …: …' },
    ],
  },
  check_verification: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan' },
      { status: 'success', text: '… kunjungan terverifikasi; siap dirancang pembayarannya' },
      { status: 'needs_review', text: 'Verifikasi belum berhasil untuk … kunjungan: …' },
      { status: 'needs_review', text: '…/… kunjungan perlu verifikasi sebelum pembayaran; write direncanakan (dry-run)' },
      { status: 'success', text: '… kunjungan bisa dibayar sudah terverifikasi; tidak ada blocker' },
      { status: 'blocked', text: 'Unserved order(s) on …: … outstanding…' },
      { status: 'blocked', text: 'Untransferred order(s) on …: … outstanding…' },
      { status: 'blocked', text: 'Unverified penunjang transaction on …: …' },
      { status: 'blocked', text: 'Blocker verifikasi: …' },
      { status: 'needs_review', text: 'Status verifikasi tidak terbaca pada …: "…"' },
      { status: 'needs_review', text: '… belum diverifikasi — Verifikasi dimatikan di Setup' },
      { status: 'needs_review', text: '…/… payable record(s) remain after verification checks; …' },
    ],
    findings: [
      '…: terpasang tapi belum terverifikasi read-after-write',
      '…: verifikasi ……',
      'Unserved order(s) on …: … outstanding…',
      'Untransferred order(s) on …: … outstanding…',
      'Unverified penunjang transaction on …: …',
      "Status verifikasi tidak terbaca pada …: \"…\"",
      '… belum diverifikasi — Verifikasi dimatikan di Setup',
    ],
    actions: [
      { endpointId: 'verifikator.simpanVerifikasi', text: 'Tutup verifikasi registrasi … sebelum pembayaran' },
    ],
    reads: ['kasir.cekOrderBelumTerlayani', 'kasir.cekOrderBelumTransfer', 'kasir.cekStatusVerifikasi', 'verifikator.cekTransaksiPenunjang'],
    writes: ['verifikator.simpanVerifikasi'],
  },
  submit_payment: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan untuk dibayar' },
      { status: 'skipped', text: 'Tampung bayar dimatikan di Setup — … kunjungan siap dibayar tidak dirancang' },
      { status: 'success', text: '…/… tampung bayar tertulis' },
      { status: 'needs_review', text: '…/… tampung bayar tertulis; … tidak tertulis — lihat rincian rencana' },
      { status: 'needs_review', text: '… pembayaran direncanakan' },
      { status: 'needs_review', text: '… pembayaran direncanakan (dry-run)' },
      { status: 'needs_review', text: '… pembayaran direncanakan; … ditahan — …' },
      { status: 'needs_review', text: '… pembayaran direncanakan (dry-run); … ditahan — …' },
    ],
    findings: [
      '…: baris kasir tidak terbaca (…)',
      '…: … baris kasir vs … baris tindakan poli — tidak dirancang',
    ],
    actions: [
      { endpointId: 'kasir.tampungBayar', text: 'Tampung bayar transaksi …' },
    ],
    reads: ['kasir.cekOrderBelumTerlayani', 'kasir.cekOrderBelumTransfer', 'kasir.cekStatusVerifikasi', 'kasir.getHistoryPembayaran', 'kasir.getListTindakan', 'poliklinik.getListTindakan', 'verifikator.cekTransaksiPenunjang'],
    writes: ['kasir.tampungBayar'],
  },
  confirm_result: {
    outcomes: [
      { status: 'success', text: 'Preview — tidak ada pembayaran untuk dikonfirmasi' },
      { status: 'success', text: '… pembayaran terverifikasi' },
      { status: 'needs_review', text: '… pembayaran terverifikasi; …' },
    ],
  },
  emit_patient_summary: {
    outcomes: [
      { status: 'success', text: 'Pasien diproses: … kunjungan ditinjau (preview)' },
      { status: 'success', text: 'Pasien diproses: … kunjungan; … dibayar' },
    ],
  },
  emit_batch_summary: {
    outcomes: [
      { status: 'success', text: 'Antrean selesai: … lolos, … dilewati dari … pasien; …' },
    ],
  },
};
