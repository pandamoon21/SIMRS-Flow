# Kelengkapan Berkas (OCR) — evaluasi & keputusan

Fitur ini membantu operator memverifikasi **kelengkapan berkas klaim** pada Run
(patient processor). Sumbernya adalah bundel PDF e-klaim SIMRS
(`eklaim/eklaim_idrg/cetak_simplifikasi`). Bundel itu tidak tersedia sebagai
data di API, jadi isinya dibaca dari PDF. Hasilnya hanya **notice**: langkah ini
tidak pernah memblokir run atau menulis apa pun, karena operator tetap
memeriksa berkas secara manual.

## Bentuk dokumen sumber (diukur 2026-10-20, data live)

- `rekam_medis/upload_berkas/getdatapiutang` (POST, JSON) — daftar kunjungan per
  No. RM/periode. Kolom `kd_instalasi`: `3` rawat inap, `1` rawat jalan. Satu
  baris memberi `no_sep`, `no_registrasikunjungan`, `tgl_masuk`, `tgl_keluar_rm`,
  `status_ttd`, `status_verifikasi`.
- `eklaim/eklaim_idrg/cetak_simplifikasi?no_sep&no_register&kd_instalasi` (GET,
  PDF). Dibuat oleh TCPDF (HTML2PDF) lalu Ghostscript.
  - **Halaman berteks** (resume, SEP, perincian biaya/obat, hasil lab, surat
    keterangan): teksnya asli, **tidak perlu OCR**.
  - **Halaman foto** yang digabungkan ke bundel (formulir bank darah/crossmatch,
    laporan polisi, lembar observasi, EKG): tanpa lapisan teks, 150–280 dpi.
  - Ukuran bervariasi: bundel 16–18 halaman ±0,3–0,9 MB; bundel 72 halaman
    10,4 MB (unduhnya ±46 detik dari SIMRS).

## Benchmark OCR (2026-10-20)

Halaman foto yang sama (sudah tegak, abu-abu, sisi terpanjang 2400 px).
Skor = kata kunci judul yang terbaca / jumlah kata kunci. Waktu per halaman di PC
pengembang (Windows, Node 25).

| Library | Laporan Polisi (ketikan) | Crossmatch (cetak + tulisan tangan) | Lembar Observasi (grid) | EKG (grafik) | Ukuran & teknologi | Lisensi |
|---|---|---|---|---|---|---|
| **tesseract.js 7** | 4/4 · 1,6 s | 5/5 · 1,4 s | **2/2** · 5,9 s | 0/5 | ±46 MB, WASM, tanpa native | Apache-2.0 |
| @gutenye/ocr-node 1.4 (PaddleOCR, onnx) | 3/4 · 1,9 s | 5/5 · 1,1 s | 0/2 · 2,6 s | 0/5 | ±325 MB (onnxruntime-node + sharp, native) | MIT |
| ppu-paddle-ocr 6.6 (PP-OCRv6 tiny) | 4/4 · **0,4 s** | **0/5** · 0,3 s | 1/2 · 0,4 s | 0/5 | ±300 MB native; model diunduh dari internet saat pertama jalan | MIT |
| scribe.js-ocr 0.16 | 4/4 · 4,4 s | 5/5 · 2,0 s | 2/2 · 9,8 s | 1/5 | ±83 MB, WASM | **AGPL-3.0** |

Catatan kualitatif:

- **Ketikan** (laporan polisi): tesseract keyakinan rata-rata 90%, nomor LP,
  tanggal, dan lokasi terbaca utuh.
- **Tulisan tangan** (isian crossmatch, lembar observasi): tidak bisa diandalkan
  di engine mana pun tanpa model AI. PaddleOCR sedikit lebih baik (nama terbaca
  sebagian), tapi nomor kantong dan tanggal tetap acak. Karena itu fitur ini
  hanya memakai **judul** dokumen.
- **EKG**: grafik, tidak ada judul yang terbaca. Dideteksi lewat pola grid
  kertas EKG dan ditandai "kemungkinan EKG".

### Pembaca PDF

| Library | Ukuran | Lisensi | Hasil di bundel 72 halaman |
|---|---|---|---|
| **unpdf 1.9** (pdf.js serverless) | 2 MB | MIT | teks semua halaman 0,3 s; gambar halaman foto 0,1 s; 17 halaman tanpa teks terdeteksi |
| pdfjs-dist 6.4 | 35 MB | Apache-2.0 | (unpdf memakai pdf.js yang sama, versi lebih ringan) |
| mupdf 1.28 | 14 MB | **AGPL-3.0** | tidak diuji (lisensi) |

## Keputusan

- **unpdf + tesseract.js** dengan data bahasa offline `@tesseract.js-data/ind` dan
  `@tesseract.js-data/eng` (tanpa CDN, karena host berada di LAN). Semuanya
  JavaScript/WASM, jadi sama di Windows dan Linux.
- OCR hanya untuk halaman tanpa teks. Halaman berteks dibaca langsung.
- Berjalan di host orchestrator, bukan di PC operator.
- Cache per **No. RM + tanggal masuk + tanggal pulang** (bukan per SEP), di
  `BERKAS_CACHE_DIR`. Hasil OCR per halaman disimpan dengan hash gambarnya, jadi
  bundel yang bertambah halaman hanya meng-OCR halaman baru.
- Opsi aktif/nonaktif per run di Setup; progres (unduh → teks → OCR n/m) tampil
  di command bar dan log.
- Langkah `check_berkas` (Kelengkapan Berkas) bergantung pada Evaluasi Titipan
  dan dideklarasikan sebelum cek kritis (Ringkasan Pra-Verifikasi, Cek Balance).
  Runner berhenti di blok kritis pertama, jadi notice berkas tetap keluar walau
  balance belum cocok. Hasilnya hanya `needs_review`/`success`, tidak pernah
  menahan gerbang.

## Rawat jalan (kd_instalasi=1)

Sampel 8 bundel rajal live (2026-10-20) berbentuk seragam: lembar e-klaim
(KEMENTERIAN KESEHATAN … JKN), perincian biaya rawat jalan, SEP, **lembar
verifikasi rawat jalan**, perincian obat, lalu hasil penunjang/foto (surat
pengantar, histopatologi, formulir lain).

- Dokumen wajib rajal: SEP, lembar verifikasi rawat jalan (pengganti resume
  ranap), perincian biaya; hasil radiologi/EKG bila ditagihkan. Titipan tidak
  berlaku.
- Langkah `check_berkas` rajal bergantung pada Validasi Tindakan dan
  dideklarasikan sebelum Validasi SEP, satu bundel per registrasi kunjungan
  untuk semua pasien di batch.
- Cache: No. RM + tanggal kunjungan + kode unit (poli berbeda di hari yang sama
  punya bundel sendiri).
- Aturan dokumen wajib (`evaluateBerkas`) dipakai bersama lewat subpath
  `@simrs-flow/berkas/evaluate` (murni, tanpa `fs`/WASM).
