# Run canvas redesign — first attempt

## Tujuan dan batas

Operator harus langsung mengetahui **status dan posisi proses saat ini** tanpa memilih node. Diagram Run adalah bidang utama pada desktop maupun layar sempit, dengan struktur Rawat Jalan dan Rawat Inap sedekat mungkin dengan flow asli pembuatnya:

- [Flow asli Rawat Jalan](../../references/evomedis-helper-rajal-v1.png)
- [Flow asli Rawat Inap](../../references/evomedis-helper-ranap-v4.png)

Kedua gambar menjadi acuan urutan, percabangan, dan penggabungan; jika berbeda dari eksekusi sekarang, presentasi harus jujur terhadap implementasi terbaru. Tahap 1 mengubah **presentasi Run saja**. Tahap 2 adalah audit terpisah atas selisih flow asli dan logika domain, lalu perubahan eksekusi hanya sesudah review keselamatan dan tes tersendiri. Jangan menyamakan referensi historis dengan langkah yang telah dijalankan.

## Diagram dan informasi

- Rawat Jalan dan Rawat Inap menampilkan seluruh struktur sejak awal, termasuk cabang Rawat Inap yang panjang. Kamera awal fokus pada langkah aktif, atau langkah awal jika run belum bergerak, pada zoom yang masih terbaca. **Fit** dan minimap menunjukkan gambaran penuh; **Center**, **Selected**, dan **Follow** tetap tersedia. Follow yang dimatikan tidak menggeser kamera saat progres berubah.
- Kartu node eksekusi berisi nama langkah, status dalam teks, dan satu ringkasan hasil/masalah terpenting. Detail, isu, bukti, dan tindakan tetap di inspector. Jalur yang ditempuh lebih tegas; cabang lain tetap tampak lebih redup, bukan hilang. Perbedaan status tidak hanya mengandalkan warna. Arah dan sambungan panah harus terbaca pada percabangan dan penggabungan, tanpa melintasi kartu.
- Langkah pada gambar asli yang belum punya padanan node eksekusi boleh ditambahkan sebagai **node penjelas bertanda “Alur referensi”**. Node ini tidak diberi status sukses/gagal, event eksekusi, tombol persetujuan, atau tindakan mutasi. Jangan membuat node tersebut terlihat seperti operasi yang benar-benar dijalankan. Catat setiap ketidakcocokan untuk audit tahap 2.
- Pertahankan sumber kebenaran status dari event workflow yang sudah ada. Perubahan visual tidak mengubah DAG, store, mutation gate, endpoint, maupun mekanisme persetujuan.

## Panel melayang dan responsivitas

- Hanya **sidebar Run**, **console**, dan **inspector** yang menjadi panel melayang; navigasi aplikasi (Overview/Run/History dan lainnya) tidak berubah. Ketiganya dapat dipindah melalui header dan diubah ukuran melalui pegangan yang jelas. Panel yang diklik maju ke depan. Drag/resize panel tidak menyeret atau memilih node di canvas.
- Saat membuka Run, sidebar Run tampil ringkas; console dan inspector tertutup, masing-masing dengan pembuka yang mudah ditemukan. Memilih node otomatis membuka inspector tanpa memindahkan atau mengubah ukurannya. Peristiwa yang memerlukan tindakan operator hanya menandai node dan affordance notifikasi; tidak membuka panel dengan sendirinya.
- Simpan posisi dan ukuran panel **per browser/perangkat**; sediakan **Reset tata letak** yang mengembalikan posisi, ukuran, dan keadaan terbuka default. Setelah viewport berubah, jepit ukuran/posisi agar header serta kontrol panel tetap berada di layar. Pada layar sempit diagram tetap tampilan utama, bukan diganti daftar; panel berukuran cukup untuk dibaca tetapi dapat ditutup agar canvas mudah dijangkau. Kontrol kamera/minimap tidak tertutup permanen oleh panel.
- Sediakan operasi panel yang dapat diakses tanpa drag presisi: tombol buka/tutup, fokus keyboard yang terlihat, pegangan resize yang dapat dijangkau, dan reset. Preferensi reduced-motion mematikan gerakan dekoratif namun tetap menunjukkan status dan progres.

## Kegagalan dan batas keselamatan

Jika layout tersimpan tak valid, penyimpanan browser tak tersedia, atau viewport mengecil, gunakan layout default/terjepit tanpa menghalangi canvas; jangan kehilangan data run. Jika status/evidence node belum tersedia, tampilkan keadaan menunggu/tidak tersedia, bukan hasil yang direka. Node penjelas tidak dapat dipakai untuk keputusan klinis atau persetujuan. Tidak ada koneksi SIMRS live maupun operasi tulis untuk memvalidasi desain ini.

## Verifikasi dan kriteria penerimaan

- Tes pemetaan node eksekusi vs node referensi, status/jalur aktif, target kamera, serta batas ukuran/posisi/reset panel. Pertahankan tes workflow yang sudah ada; tahap 1 tidak boleh mengubah hasil run.
- QA browser offline untuk kedua domain pada desktop dan layar sempit, tema terang/gelap, keyboard dan sentuh, serta reduced-motion. Periksa cabang/merge pada gambar referensi, label dan arah panah, status yang terbaca pada zoom kerja, kamera Follow off/on, keempat kontrol kamera, dan minimap.
- Periksa beberapa panel terbuka/bertumpuk, drag dan resize, pemulihan setelah reload, viewport mengecil/membesar, dan Reset tata letak. Pastikan tidak ada panel atau kontrol yang terjebak di luar viewport.
- Tahap 2 baru dapat dimulai setelah inventaris selisih flow asli versus workflow aktual; setiap perubahan semantik billing/verifikasi harus melewati tes deterministik dan review safety tersendiri.
