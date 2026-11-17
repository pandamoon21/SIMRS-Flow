/**
 * What each ranap node's executor can conclude and touch, declared as data.
 *
 * Per node: every `StepResult` status + summary template the executor can
 * return (`…` = a value filled in at runtime), the issue codes and detail
 * findings it reports, the writes it can plan (with the plan's reason) and the
 * endpoints it reads. `ruleCatalog.ts` builds the Rules page catalog from this.
 *
 * Kept true by `domain-ranap.test.ts`: every fixture run records what the
 * executors return, and the suite fails on any status/summary, issue code or
 * planned write a node does not declare here. Change an executor's outcome,
 * change its entry here in the same commit.
 */
import type { DeclaredOutcomes } from '@simrs-flow/workflow-core';
import type { RanapNodeId } from './nodes.js';

export const RANAP_OUTCOMES: Readonly<Record<RanapNodeId, DeclaredOutcomes>> = {
  normalize_input: {
    outcomes: [
      { status: 'failed', text: 'No RM wajib diisi' },
      { status: 'failed', text: 'Rawat inap memproses satu pasien per run; diterima … No RM' },
      { status: 'failed', text: 'Input No RM tidak valid | input=… | alasan=…' },
      { status: 'failed', text: 'Input tanggal tidak valid | input=… | alasan=…' },
      { status: 'success', text: '… medrec, …, toleransi ±… hari' },
    ],
  },
  load_visits: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan yang ditemukan' },
      { status: 'skipped', text: 'Tidak ada kunjungan yang bisa diproses dari … baris history' },
      { status: 'success', text: '… kunjungan dari … baris history' },
    ],
    reads: ['kasir.getHistoryKunjungan', 'penatajasaInap.getHistoryKunjunganTab'],
  },
  reject_verified: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan untuk diperiksa' },
      { status: 'blocked', text: 'Status verifikasi tidak terbaca dari SIMRS — run dihentikan. Jalankan ulang run.' },
      { status: 'success', text: 'Tidak ada transaksi terverifikasi dari … kunjungan' },
      { status: 'blocked', text: '… kunjungan sudah terverifikasi' },
    ],
    issues: [
      { code: 'verifikasi_unreadable', text: 'Read kasir.cekStatusVerifikasi gagal' },
    ],
    reads: ['kasir.cekStatusVerifikasi'],
  },
  reject_paid: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada kunjungan untuk diperiksa' },
      { status: 'blocked', text: 'Riwayat pembayaran tidak terbaca dari SIMRS — run dihentikan. Jalankan ulang run.' },
      { status: 'success', text: 'Tidak ada riwayat pembayaran dari … kunjungan' },
      { status: 'blocked', text: '… kunjungan sudah memiliki riwayat pembayaran' },
    ],
    issues: [
      { code: 'pembayaran_unreadable', text: 'Read kasir.getHistoryPembayaran gagal' },
    ],
    reads: ['kasir.getHistoryPembayaran'],
  },
  validate_sep: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada registrasi untuk divalidasi' },
      { status: 'failed', text: 'Riwayat SEP BPJS tidak terbaca (timeout/gagal) — ulangi run; SEP belum dapat dinilai' },
      { status: 'needs_review', text: 'SEP opsional diterima (…)' },
      { status: 'success', text: 'SEP cocok tepat tanggal' },
      { status: 'success', text: 'SEP cocok dalam toleransi … hari' },
      { status: 'failed', text: 'SEP RITL tidak ditemukan untuk …' },
      { status: 'failed', text: 'No kartu BPJS kosong atau tidak ditemukan' },
      { status: 'failed', text: 'Tidak ada SEP … dengan PPK pelayanan …' },
      { status: 'failed', text: 'Tidak ada SEP tanggal … (toleransi … hari) untuk Rawat Inap (RITL) di PPK …' },
      { status: 'failed', text: 'SEP … terdeteksi sebagai …, bukan …' },
    ],
    issues: [
      { code: 'sep_optional', text: 'SEP diterima tanpa verifikasi: …' },
    ],
    findings: [
      'No kartu BPJS kosong atau tidak ditemukan',
      'Tidak ada SEP … dengan PPK pelayanan …',
      'Tidak ada SEP tanggal … (toleransi … hari) untuk Rawat Inap (RITL) di PPK …',
      'SEP … terdeteksi sebagai …, bukan …',
      'single_id_not_found',
      'ringkasan_pulang_not_found',
    ],
    reads: ['penatajasaInap.getDataKunjungan', 'pendaftaran.getDataKunjungan', 'pendaftaran.getDataPenjaminTab', 'pendaftaran.getDataSepBpjs', 'pendaftaran.getRiwayatSep', 'rme.getRingkasanPulangLast', 'rme.getSingleId'],
  },
  load_kasir: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada transaksi untuk dibaca' },
      { status: 'failed', text: 'Data transaksi kasir tidak terbaca | alasan=cookies/session kemungkinan sudah expired' },
      { status: 'success', text: '… baris tagihan dari … transaksi' },
    ],
    reads: ['kasir.getDataTransaksi', 'penatajasaInap.getDataKunjunganTab', 'penatajasaInap.getListTindakan', 'pendaftaran.getDataKunjungan', 'pendaftaran.getDataPenjaminTab', 'pendaftaran.getDataSepBpjs', 'poliklinik.getDataTransaksi'],
  },
  compare_sep: {
    outcomes: [
      { status: 'skipped', text: 'Data SEP atau identitas kasir belum tersedia' },
      { status: 'skipped', text: 'Validasi SEP dilewati' },
      { status: 'skipped', text: 'Validasi SEP opsional dilewati' },
      { status: 'needs_review', text: 'SEP kasir tidak terbaca; SEP pendaftaran … — konfirmasi manual di SIMRS sebelum koreksi' },
      { status: 'needs_review', text: 'SEP mismatch — rencana koreksi ke …' },
      { status: 'success', text: 'SEP kasir sesuai dengan pendaftaran' },
    ],
    actions: [
      { endpointId: 'rekamMedis.simpanSep', text: 'Koreksi SEP kasir … menjadi …' },
    ],
    reads: ['kasir.getDataTransaksi'],
    writes: ['rekamMedis.simpanSep'],
  },
  detect_byny: {
    outcomes: [
      { status: 'success', text: 'Bukan pasien BYNY (bayi baru lahir)' },
      { status: 'needs_review', text: 'Pasien BYNY sakit memerlukan SEP mandiri BPJS' },
      { status: 'success', text: 'Pasien BYNY sehat — SEP mengikuti orang tua' },
      { status: 'success', text: 'Pasien BYNY perlu evaluasi SEP' },
    ],
    issues: [
      { code: 'byny_sep', text: 'Bayi sakit dengan penjamin BPJS memerlukan SEP mandiri' },
    ],
    findings: [
      'single_id_not_found',
      'ringkasan_pulang_not_found',
    ],
    reads: ['rme.getRingkasanPulangLast', 'rme.getSingleId'],
  },
  collect_elektromedik: {
    outcomes: [
      { status: 'success', text: 'Tidak ada transaksi penunjang elektromedik aktif' },
      { status: 'success', text: '… record elektromedik dari … transaksi aktif' },
    ],
    reads: ['elektromedik.getHistoryKunjungan'],
  },
  build_rooms: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada transaksi rawat inap (03-) pada kunjungan terpilih' },
      { status: 'success', text: '… ruang dalam … grup rawat inap' },
    ],
    reads: ['penatajasaInap.getDataKunjungan', 'penatajasaInap.getDataKunjunganTab', 'penatajasaInap.getHistoryKunjunganTab', 'poliklinik.getDataKunjunganTab2'],
  },
  sync_tgl_masuk: {
    outcomes: [
      { status: 'skipped', text: 'Tanggal masuk awal rawat inap sudah sesuai tanggal SEP' },
      { status: 'needs_review', text: 'Rencana koreksi tanggal masuk awal … grup rawat inap' },
    ],
    actions: [
      { endpointId: 'kasir.updateTglMasuk', text: 'Selaraskan tanggal masuk awal rawat inap … menjadi …' },
    ],
    reads: ['kasir.getHistoryKunjungan'],
    writes: ['kasir.updateTglMasuk'],
  },
  load_charges: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'needs_review', text: '… grup dengan list tindakan yang tidak terbaca' },
      { status: 'success', text: '… baris tindakan dari … transaksi ruang' },
    ],
    issues: [
      { code: 'list_tindakan_read', text: 'List tindakan rawat inap gagal dibaca untuk … grup' },
    ],
    reads: ['penatajasaInap.getListTindakan'],
  },
  evaluate_titipan: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada ruang untuk dievaluasi' },
      { status: 'needs_review', text: '… ruang terdeteksi TITIPAN: …' },
      { status: 'needs_review', text: '…/… ruang belum dapat dievaluasi (…)' },
      { status: 'success', text: '… ruang sesuai hak kelas SEP' },
    ],
    issues: [
      { code: 'titipan', text: 'Kelas ruang di atas hak SEP: …' },
      { code: 'titipan_unevaluated', text: 'Kelas SEP atau kelas ruang tidak terbaca untuk … ruang' },
    ],
    findings: [
      'kelas_sep_tidak_terbaca',
      'kelas_ruang_tidak_terbaca',
      'byny_scn_beda_kelas',
      'sep_kelas_3_dirawat_di_kelas_lebih_tinggi',
      'kelas_rawat_di_atas_kelas_sep',
    ],
  },
  preflight_gizi: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'needs_review', text: 'Preflight order gizi gagal untuk … grup' },
      { status: 'needs_review', text: 'Rencana kirim … order gizi yang belum terkirim' },
      { status: 'needs_review', text: '… order gizi terblokir dan perlu recovery' },
      { status: 'success', text: 'Preflight gizi bersih' },
    ],
    issues: [
      { code: 'gizi_preflight_error', text: '… grup gagal preflight order gizi' },
      { code: 'gizi_blocked', text: '… order gizi tidak dapat dikirim otomatis' },
    ],
    findings: [
      'detail order gizi kosong',
      'order gizi sudah terkirim | detail=…',
      'cek_jadwal=…',
      'pending=… | cek_jadwal=…',
    ],
    actions: [
      { endpointId: 'penatajasaInap.kirimOrderGizi', text: 'Kirim order gizi … (…)' },
    ],
    reads: ['penatajasaInap.cekJadwalGizi', 'penatajasaInap.cekOrderGizi', 'penatajasaInap.getDataOrderGizi', 'penatajasaInap.getHistoryOrderGizi'],
    writes: ['penatajasaInap.kirimOrderGizi'],
  },
  detect_origin: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'needs_review', text: '… grup tanpa asal masuk yang bisa dipastikan: …' },
      { status: 'success', text: 'Asal masuk: … IGD, … Poliklinik' },
    ],
    issues: [
      { code: 'origin_unknown', text: '… grup rawat inap tidak memiliki asal masuk yang jelas' },
    ],
    findings: [
      'pasien BYNY dapat berasal langsung, jadi origin asal tidak dicek',
    ],
    reads: ['penatajasaInap.getDataKunjungan', 'poliklinik.getDataKunjungan', 'poliklinik.getDataTransaksi', 'poliklinik.getHistoryKunjungan', 'poliklinik.getListTindakan'],
  },
  process_igd: {
    outcomes: [
      { status: 'skipped', text: 'Bukan pasien masuk via IGD' },
      { status: 'success', text: 'Tagihan IGD asal sudah tertransfer untuk … grup' },
      { status: 'needs_review', text: 'IGD asal tidak ditemukan untuk … grup' },
      { status: 'needs_review', text: 'Rencana perapihan … tagihan IGD asal' },
    ],
    issues: [
      { code: 'igd_source_missing', text: '… grup origin IGD tanpa transaksi asal' },
    ],
    findings: [
      'data transaksi tujuan … tidak lengkap',
      'biaya transfer … kosong',
    ],
    actions: [
      { endpointId: 'poliklinik.transferIgd', text: 'Transfer tagihan IGD asal ke tagihan rawat inap (reg …)' },
    ],
    reads: ['poliklinik.cekJumlahTransfer', 'poliklinik.cekStatusOrder', 'poliklinik.cekStatusTransfer', 'poliklinik.getDataTransaksi', 'poliklinik.getListTindakan'],
    writes: ['poliklinik.transferIgd'],
  },
  process_poli: {
    outcomes: [
      { status: 'skipped', text: 'Bukan pasien masuk via Poliklinik' },
      { status: 'needs_review', text: 'POLI asal tidak ditemukan/lengkap untuk … grup' },
      { status: 'skipped', text: 'Tagihan Poliklinik asal sudah sesuai…' },
      { status: 'needs_review', text: 'Rencana perapihan … tagihan Poliklinik asal…' },
      { status: 'needs_review', text: 'Rencana perapihan … baris tagihan Poliklinik asal…' },
    ],
    issues: [
      { code: 'poli_source_missing', text: '… grup origin Poliklinik tanpa transaksi asal/lengkap' },
      { code: 'replan_exhausted', text: '…' },
    ],
    findings: [
      'data transaksi tujuan … tidak lengkap',
      'biaya transfer … kosong',
    ],
    actions: [
      { endpointId: 'poliklinik.updateTgl', text: 'Samakan tanggal … POLI ke tanggal … (… → …)' },
      { endpointId: 'poliklinik.batalTransfer', text: 'Batal transfer POLI asal agar tanggal tagihan bisa disinkronkan (reg …)' },
      { endpointId: 'laboratorium.batalTransfer', text: 'Batal transfer Lab PK terkait POLI asal karena status transfer inkonsisten (reg …)' },
      { endpointId: 'laboratorium.bukaBhp', text: 'Buka transaksi Lab PK terkait POLI asal sebelum transfer (reg …)' },
      { endpointId: 'laboratorium.tutupBhp', text: 'Tutup transaksi Lab PK terkait POLI asal sebelum transfer (reg …)' },
      { endpointId: 'laboratorium.transferLab', text: 'Transfer Lab PK terkait POLI asal ke tagihan rawat inap (reg …)' },
      { endpointId: 'poliklinik.transferIgd', text: 'Transfer tagihan POLI asal ke tagihan rawat inap (reg …)' },
    ],
    reads: ['kemoterapi.getHistoryOrderPa', 'laboratorium.cekStatusBayar', 'laboratorium.cekStatusBayarTransfer', 'laboratorium.cekStatusTransfer', 'laboratorium.cekStatusTransferPoliTujuan', 'laboratorium.cekStatusVerifikasi', 'laboratorium.cekTransaksiTerbuka', 'laboratorium.cekTutupTransaksi', 'laboratorium.getHistoryKunjungan', 'laboratorium.getListTindakan', 'laboratorium.getTotal', 'laboratoriumHasil.getDetailTransaksi', 'penatajasaInap.getDetailHistoryIrad', 'penatajasaInap.getHistoryILab', 'penatajasaInap.getHistoryIok', 'poliklinik.cekJumlahTransfer', 'poliklinik.cekStatusBayar', 'poliklinik.cekStatusOrder', 'poliklinik.cekStatusTransfer', 'poliklinik.cekStatusVerifikasi', 'poliklinik.getDataTransaksi', 'poliklinik.getHistoryIrad', 'poliklinik.getListTindakan'],
    writes: ['laboratorium.batalTransfer', 'laboratorium.bukaBhp', 'laboratorium.transferLab', 'laboratorium.tutupBhp', 'poliklinik.batalTransfer', 'poliklinik.transferIgd', 'poliklinik.updateTgl'],
  },
  transfer_elektromedik: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada penunjang elektromedik untuk ditransfer' },
      { status: 'skipped', text: 'Semua … tagihan elektromedik sudah termasuk dalam transfer IGD asal' },
      { status: 'needs_review', text: 'Data kunjungan elektromedik tidak lengkap untuk … transaksi' },
      { status: 'needs_review', text: 'Rencana transfer … tagihan elektromedik' },
    ],
    issues: [
      { code: 'elektromedik_incomplete', text: 'Transaksi elektromedik tanpa tujuan transfer: …' },
    ],
    actions: [
      { endpointId: 'elektromedik.transferTagihan', text: 'Transfer tagihan elektromedik … ke tagihan rawat inap' },
    ],
    reads: ['elektromedik.cekStatusBayar', 'elektromedik.getDataKunjungan', 'elektromedik.getListTindakan'],
    writes: ['elektromedik.transferTagihan'],
  },
  scan_hanging_trx: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'success', text: 'Tidak ada transaksi terkait yang menggantung' },
      { status: 'needs_review', text: '… transaksi terkait masih menggantung' },
    ],
    issues: [
      { code: 'hanging_trx', text: '… transaksi terkait belum ditransfer atau dibayar' },
    ],
  },
  check_manual_blockers: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'needs_review', text: 'Blocker verifikasi manual: …' },
      { status: 'success', text: 'Tidak ada blocker verifikasi manual' },
    ],
    issues: [
      { code: 'manual_blocker', text: 'Transaksi … harus ditransfer manual lebih dulu' },
    ],
  },
  detect_blockers: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'needs_review', text: 'Blocker penunjang: …' },
      { status: 'needs_review', text: 'Blocker penunjang gizi: … — dapat dipulihkan otomatis' },
      { status: 'success', text: 'Tidak ada blocker penunjang' },
    ],
    issues: [
      { code: 'penunjang_blocker', text: '…' },
      { code: 'gizi_blocker', text: '…' },
    ],
    reads: ['verifikator.cekTransaksiPenunjang'],
  },
  sync_tindakan: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada ruang untuk disinkronkan' },
      { status: 'success', text: 'Tindakan harian sudah sesuai untuk … transaksi ruang…' },
      { status: 'needs_review', text: 'Rencana … perbaikan tindakan harian untuk … transaksi ruang (asumsi write berhasil — perlu re-plan setelah eksekusi)…' },
    ],
    issues: [
      { code: 'replan_exhausted', text: '…' },
      { code: 'tindakan_sync_issue', text: '… catatan sinkronisasi tindakan' },
    ],
    actions: [
      { endpointId: 'penatajasaInap.hapusTindakan', text: 'duplikat timestamp identik' },
      { endpointId: 'verifikator.tambahTindakanPolis', text: 'biaya ruang rawat inap belum ada sama sekali pada transaksi ini' },
      { endpointId: 'penatajasaInap.tambahTindakanPolis', text: '… belum ada pada tanggal …' },
      { endpointId: 'penatajasaInap.hapusTindakan', text: '… | aksi=hapus untuk tambah ulang' },
      { endpointId: 'poliklinik.tampungPelaksana', text: 'pelaksana jasa pelayanan harus ……' },
      { endpointId: 'poliklinik.tampungPelaksana', text: 'pelaksana dpjb harus kosong…' },
      { endpointId: 'poliklinik.tampungPelaksana', text: 'pelaksana bhp oksigen harus kosong…' },
      { endpointId: 'poliklinik.tampungPelaksana', text: 'pelaksana … harus ……' },
      { endpointId: 'verifikator.batalVerifikasi', text: 'Batal verifikasi registrasi … agar … baris tindakan yang sudah terverifikasi bisa diperbaiki (…)' },
    ],
    reads: ['kasir.cekStatusVerifikasi', 'kemoterapi.getDetailHistoryOrderPa', 'kemoterapi.getHistoryOrderPa', 'laboratoriumHasil.getDetailTransaksi', 'penatajasaInap.cekStatusBayar', 'penatajasaInap.cekStatusVerifikasi', 'penatajasaInap.getCmbParamedisPelaksana', 'penatajasaInap.getDataKunjungan', 'penatajasaInap.getDataKunjunganTab', 'penatajasaInap.getDetailHistoryIrad', 'penatajasaInap.getDetailKomponenTransaksi', 'penatajasaInap.getHistoryILab', 'penatajasaInap.getHistoryIok', 'penatajasaInap.getListTindakan', 'penatajasaInap.getTindakan', 'poliklinik.getDataKunjunganTab2', 'poliklinik.getHistoryIrad', 'rekapitulasi.detailHakHtml', 'verifikator.getDataKunjungan', 'verifikator.getDataKunjunganTab', 'verifikator.getTindakan'],
    writes: ['penatajasaInap.hapusTindakan', 'penatajasaInap.tambahTindakanPolis', 'penatajasaInap.updateTgl', 'poliklinik.tampungPelaksana', 'verifikator.batalVerifikasi', 'verifikator.tambahTindakanPolis'],
  },
  sync_visite: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'success', text: 'Visite/konsultasi spesialis sudah sesuai untuk … grup…' },
      { status: 'needs_review', text: 'Rencana … perbaikan visite/konsultasi — … grup perlu re-plan setelah eksekusi…' },
      { status: 'needs_review', text: 'Rencana … perbaikan visite/konsultasi spesialis (asumsi write berhasil)…' },
    ],
    issues: [
      { code: 'visite_sync_issue', text: '… catatan sinkronisasi visite' },
      { code: 'replan_exhausted', text: '…' },
      { code: 'visite_incomplete', text: 'Rencana visite belum lengkap untuk … grup — execute, re-read, re-plan' },
    ],
    actions: [
      { endpointId: 'verifikator.batalVerifikasi', text: 'Batal verifikasi registrasi … agar … baris tindakan yang sudah terverifikasi bisa diperbaiki (…)' },
    ],
    reads: ['cppt.riwayat', 'kasir.cekStatusVerifikasi', 'kasir.getDataTransaksi', 'penatajasaInap.cekStatusBayar', 'penatajasaInap.cekStatusVerifikasi', 'penatajasaInap.getCmbParamedisPelaksana', 'penatajasaInap.getDataKunjungan', 'penatajasaInap.getDetailKomponenTransaksi', 'penatajasaInap.getListTindakan', 'penatajasaInap.getTindakan', 'ringkasanPasien.loadTglMasuk', 'rme.getSingleId', 'rme.loadCpptAwal', 'rme.loadCpptSoap'],
    writes: ['penatajasaInap.hapusTindakan', 'penatajasaInap.tambahTindakanPolis', 'penatajasaInap.updateTgl', 'poliklinik.tampungPelaksana', 'verifikator.batalVerifikasi'],
  },
  validate_ibs: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'needs_review', text: '… grup dengan IBS yang perlu diperiksa' },
      { status: 'needs_review', text: 'Validasi IBS tidak dapat dipastikan — data pembanding tidak terbaca' },
      { status: 'success', text: 'IBS konsisten untuk … grup' },
    ],
    issues: [
      { code: 'ibs', text: '…' },
      { code: 'ibs_unreadable', text: 'Read gagal: …' },
    ],
    reads: ['penatajasaInap.getDataKunjungan', 'penatajasaInap.getListTindakan', 'poliklinik.getDataKunjunganTab2', 'rekapitulasi.detailHakHtml'],
  },
  validate_penunjang: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'needs_review', text: '… grup dengan hasil penunjang yang belum lengkap' },
      { status: 'needs_review', text: 'Hasil penunjang tidak dapat dipastikan — history penunjang tidak terbaca' },
      { status: 'success', text: 'Hasil penunjang lengkap (… pemeriksaan diperiksa)' },
    ],
    issues: [
      { code: 'penunjang_hasil', text: '… grup memiliki hasil penunjang yang perlu dicek' },
      { code: 'penunjang_unreadable', text: 'Read gagal: …' },
    ],
    findings: [
      'detail history kosong',
      'hasil_ok=0/…',
      'LIS/raw/pdf belum valid',
      'approve=…',
      'pdf hasil tidak ada',
      'PDF membalas data tidak ada',
      'hasil/berkas/studyuid kosong',
      'pdf hasil error',
      'detail tindakan kosong',
      'detail hasil/pdf belum mengikat transaksi',
      'data hasil tidak ada',
      'hasil belum lengkap/tidak ada',
      'hasil belum dapat dibaca',
    ],
    reads: ['elektromedik.cekStatusBayar', 'elektromedik.getListTindakan', 'elektromedikHasil.getListHasilPemeriksaan', 'kemoterapi.getDetailHistoryOrderPa', 'kemoterapi.getHistoryOrderPa', 'laboratorium.getHistoryKunjungan', 'laboratoriumHasil.cetakLis', 'laboratoriumHasil.getDataKunjungan', 'laboratoriumHasil.getDataTransaksi', 'laboratoriumHasil.getDetailTransaksi', 'laboratoriumHasil.getHasilPemeriksaan', 'penatajasaInap.getDetailHistoryILab', 'penatajasaInap.getDetailHistoryIrad', 'penatajasaInap.getHistoryILab', 'penatajasaInap.getHistoryIok', 'poliklinik.getHistoryIrad', 'radiologi.getBerkas', 'radiologi.getDataKunjungan', 'radiologi.getHasilPemeriksaan'],
  },
  validate_obat_pulang: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'needs_review', text: 'Obat pulang tidak dapat dipastikan — data pembanding tidak terbaca' },
      { status: 'needs_review', text: '… grup dengan biaya obat yang belum cocok' },
      { status: 'success', text: 'Obat pulang tervalidasi untuk … grup' },
    ],
    issues: [
      { code: 'obat_pulang_unreadable', text: 'Read gagal: …' },
      { code: 'obat_pulang', text: '…' },
    ],
    findings: [
      '…: … baris tanpa no_referensi (tidak dapat dicocokkan otomatis)',
      '…: … baris',
    ],
    reads: ['penatajasaInap.getDetailHistoryObat', 'penatajasaInap.getHistoryObat', 'penatajasaInap.getListTindakan', 'verifikator.getDetailTransaksi'],
  },
  check_berkas: {
    outcomes: [
      { status: 'skipped', text: 'Cek berkas (OCR) tidak tersedia di host ini' },
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'needs_review', text: 'Berkas e-klaim belum ditemukan untuk registrasi ini — periksa manual' },
      { status: 'needs_review', text: 'Berkas belum lengkap: … — periksa manual' },
      { status: 'success', text: 'Berkas lengkap: … dokumen wajib ditemukan' },
    ],
    issues: [
      { code: 'berkas_index', text: '…' },
      { code: 'berkas_kurang', text: '…' },
    ],
    reads: ['eklaim.cetakSimplifikasi', 'uploadBerkas.getDataPiutang'],
  },
  preverify_summary: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'blocked', text: 'Verifikasi ditahan — … grup masih punya blocker' },
      { status: 'needs_review', text: '…/… grup masih punya blocker verifikasi' },
      { status: 'success', text: 'Pra-verifikasi bersih untuk … grup' },
    ],
    issues: [
      { code: 'preverify_blocked', text: '…' },
    ],
  },
  recover_gizi: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'skipped', text: 'Tidak ada blocker gizi yang perlu dipulihkan' },
      { status: 'needs_review', text: 'Rencana … aksi recovery order gizi' },
    ],
    findings: [
      'detail order gizi kosong',
      'detail order gizi masih berstatus sudah kirim',
      'jadwal=… |jenis=… |tgl_order=…',
      'tidak ada detail dengan urut_order',
      'blocker bukan gizi | …',
      'recovery order gizi tidak menemukan detail yang bisa dihapus',
      'dry_run tidak mengubah state',
      'butuh pembacaan blocker berikutnya',
      'blocker sudah clear',
      'blocker tidak berubah | …',
      'blocker gizi belum clear setelah … attempt',
      'Recovery order gizi (…): …',
    ],
    reads: ['penatajasaInap.cekJadwalGizi', 'penatajasaInap.getDataOrderGizi', 'verifikator.cekTransaksiPenunjang'],
    writes: ['penatajasaInap.batalKirimOrderGizi', 'penatajasaInap.hapusDetailOrderGizi', 'penatajasaInap.kirimOrderGizi'],
  },
  check_balance: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'blocked', text: 'Total tagihan belum balance untuk … grup' },
      { status: 'needs_review', text: 'Total tagihan belum balance untuk …/… grup' },
      { status: 'success', text: 'Total tagihan balance untuk … grup' },
    ],
    issues: [
      { code: 'balance', text: '…' },
    ],
    findings: [
      '…: parameter rekapitulasi tidak dapat dibentuk',
      '…: grand total kasir tidak terbaca',
      '…: selisih …',
    ],
    reads: ['kasir.getJumlahBayar', 'penatajasaInap.getDataKunjungan', 'poliklinik.getDataKunjunganTab2', 'rekapitulasi.detailHakHtml'],
  },
  final_gate: {
    outcomes: [
      { status: 'success', text: 'Siap verifikasi … grup rawat inap — menunggu persetujuan' },
    ],
  },
  execute_verifikasi: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'success', text: 'Verifikasi terkonfirmasi untuk … grup rawat inap…' },
      { status: 'needs_review', text: 'Verifikasi terkonfirmasi untuk …/… grup rawat inap — ……' },
      { status: 'blocked', text: 'Verifikasi dilewati untuk … grup — …' },
      { status: 'skipped', text: 'Rencana verifikasi 0 grup rawat inap…' },
      { status: 'needs_review', text: 'Rencana verifikasi … grup rawat inap… — …' },
    ],
    issues: [
      { code: 'verifikasi_unconfirmed', text: '…' },
      { code: 'verifikasi_skipped', text: '…' },
      { code: 'replan_exhausted', text: 'Verifikasi … grup belum terkonfirmasi saat batas re-plan tercapai' },
    ],
    actions: [
      { endpointId: 'verifikator.simpanVerifikasi', text: 'Finalisasi verifikasi registrasi …' },
    ],
    reads: ['kasir.cekStatusVerifikasi', 'verifikator.cekStatusKeluar', 'verifikator.cekTransaksiPenunjang'],
    writes: ['verifikator.simpanVerifikasi'],
  },
  tampung_bayar: {
    outcomes: [
      { status: 'skipped', text: 'Belum ada grup rawat inap' },
      { status: 'skipped', text: 'Tampung bayar dinonaktifkan untuk run ini' },
      { status: 'needs_review', text: 'Rencana tampung bayar … grup' },
      { status: 'skipped', text: 'Tampung bayar ditolak: …' },
      { status: 'skipped', text: 'Tidak ada yang bisa ditampung bayar' },
    ],
    findings: [
      '…: verifikasi tidak dijalankan untuk registrasi ini',
      '…: verifikasi belum terkonfirmasi (status=…)',
      '…: masih ada error sinkronisasi (…)',
    ],
    actions: [
      { endpointId: 'kasir.tampungBayar', text: 'Tampung bayar registrasi … sebesar …' },
    ],
    reads: ['kasir.cekOrderBelumTerlayani', 'kasir.cekOrderBelumTransfer', 'kasir.cekStatusVerifikasi', 'kasir.getHistoryPembayaran'],
    writes: ['kasir.tampungBayar'],
  },
  emit_summary: {
    outcomes: [
      { status: 'skipped', text: 'Tidak ada grup untuk dirangkum' },
      { status: 'success', text: 'Preview — tidak ada write yang dijalankan, jadi tidak ada baris ringkasan (… grup diperiksa, … rencana verifikasi dibuat)' },
      { status: 'success', text: 'Ringkasan … dari … grup rawat inap' },
      { status: 'success', text: 'Ringkasan … dari … grup rawat inap — … registrasi belum terverifikasi…' },
    ],
  },
};
