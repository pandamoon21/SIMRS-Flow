# Run — mode "Log saja" (plan / handoff)

Status: **dikerjakan** (2026-10-20) — `apps/ui/src/features/panels/terminalLog.ts`,
`apps/ui/src/features/run/RunLogView.tsx`, toggle di `RunPage.tsx`. Disetujui 2026-10-19. Hasil sesi tanya-jawab
dengan pemilik produk. Dokumen ini cukup untuk mulai implementasi tanpa
mengulang keputusan di bawah.

## Tujuan

Halaman **Run** bisa menampilkan hasil run sebagai **log terminal** (atas ke
bawah) alih-alih kanvas node. Start tetap lewat **Run setup** seperti sekarang;
yang berubah hanya cara melihat hasil. Tidak ada perubahan pada engine,
executor, orchestrator, atau jalur mutasi.

## Keputusan

| # | Pertanyaan | Keputusan |
|---|---|---|
| 1 | Untuk apa? | **Web dulu.** Otomatisasi batch terjadwal (A) dan CLI operator (B) masuk roadmap. |
| 2 | Di mana memilih mode? | **Keduanya:** default dipilih di Run setup ("Tampilan hasil: Kanvas / Log"), dan bisa diganti kapan saja lewat toggle **Kanvas \| Log** di command bar. Pilihan terakhir diingat per browser (localStorage). |
| 3 | Persetujuan gate / mutasi di mode log? | **Kartu keputusan di aliran log** (Setujui / Tolak) + bilah "Menunggu keputusan (n)" yang menempel di atas log; klik baris tahap membuka **Inspector** yang sudah ada. |
| 4 | Auto-approve? | **Pakai yang sudah ada** (`autoApprove`, mode write, approver sintetis `auto-approve`). Di log, keputusan otomatis tampil sebagai kartu bertanda **"Disetujui otomatis"**. Auto-approve berbasis risiko → roadmap. |
| 5 | Selain log, apa yang tampil? | **Dua kolom**: daftar tahap sempit di kiri (nama + ikon status; klik = lompat ke tahap di log, klik ganda = Inspector), log di kanan; **kartu ringkasan** di akhir saat run selesai. Layar sempit: daftar tahap jadi dropdown di atas log. Panel Setup / Inspector tetap mengambang; Console tidak lagi panel tapi area utama. |
| 6 | Log per pasien? | **Tidak sekarang.** Log terminal kronologis biasa. Pemilahan per pasien → roadmap (butuh executor menandai log dengan No. RM). |
| 7 | Bentuk log | Seperti contoh di bawah — disetujui. |

## Bentuk log (disetujui)

```
18:42:01 ── [1/33] Normalisasi input ─────────────────────
Proses pengerjaan billing rawat inap untuk no rm 0-90-00-01 dimulai
Filter penjamin aktif
    Accepted: BPJS PBI, BPJS NON PBI
18:42:01 ✓ [1/33] Normalisasi input · 12 ms
18:42:01 ── [2/33] Ambil kunjungan ───────────────────────
Mencari kunjungan yang bisa diproses...
+ Ditemukan 1 kunjungan yang bisa di payment:
    1. Unit         : RUANG ARAFAH KELAS 3
       - No RM      : 0-90-00-01
18:42:03 ✓ [2/33] Ambil kunjungan · 1,8 dtk
   ⋮
18:43:40 ⏸ [27/33] Gerbang Akhir · menunggu keputusan   [Setujui] [Tolak]
   ⋮
════ SELESAI · 33/33 tahap · 4 masalah · 1m 40s ════
```

Aturan:

- **Isi pesan executor tidak diubah dan tidak diberi awalan apa pun.** Format
  legacy (`docs/legacy/ranap-log-format.md`) menjajarkan titik dua di dalam teks;
  menambahkan jam/nama tahap di depan baris merusak kolom. Jam dan nama tahap
  hanya ada di **baris pembatas**.
- `[x/y]` = posisi tahap dalam urutan topologis (padanan "processing x/y"
  legacy). y = jumlah node workflow (33 ranap, 21 rajal).
- Penanda baris akhir tahap: `✓` selesai · `✗` gagal · `■` terblokir (berhenti)
  · `⚠` perlu ditinjau · `↷` dilewati · `⏸` menunggu persetujuan · `●` berjalan.
  Durasi dari `startedAt`/`finishedAt` node.
- Tahap yang **dilewati tanpa log** cukup satu baris `↷ [x/y] Nama · dilewati`
  (tanpa pembatas), supaya log tidak dipenuhi pembatas kosong.
- Severity per baris tetap diwarnai (warn kuning, error merah, debug redup).
  Filter yang sudah ada di Console (Mode debug, Hanya masalah, Bersihkan)
  dipertahankan.
- Baris penutup run: `════ SELESAI|GAGAL|DIBATALKAN · n/y tahap · m masalah · durasi ════`.
- Font monospace, mengikuti tema (terang/gelap) — bukan selalu gelap.
- Auto-follow ekor log hanya saat sudah di bawah; pil "Ke terbaru" saat tidak
  (perilaku RunConsole sekarang dipakai ulang).
- **Pencarian di log**: kotak cari dengan sorot + ‹ › antar hasil; No. RM
  cocok dengan/tanpa strip (`rmMatches` dari RunInputForm bisa dipakai ulang).

### Kartu keputusan

- Muncul di posisi tahap yang menunggu (`gate_waiting` atau mutasi `proposed`),
  berisi ringkasan + nominal/rencana (sumber sama dengan Inspector) dan tombol
  **Setujui / Tolak** (gate) atau **Setujui rencana** (mutasi).
- Memanggil handler yang sudah ada di `App.tsx` (`approveGate`, `rejectGate`,
  `approveMutation`) — **tidak ada jalur persetujuan baru**. Aturan dua operator
  untuk gate kritis, preconditions, dan verifikasi tetap di server.
- Setelah diputuskan, kartu menjadi satu baris tetap: `✓ Disetujui oleh <op>`
  / `✗ Ditolak oleh <op>` / `✓ Disetujui otomatis (auto-approve)`.
- Bilah lengket "Menunggu keputusan (n)" di atas log, klik = gulir ke kartu
  pertama yang menunggu.

## Rencana implementasi (perkiraan file)

UI saja; tidak ada perubahan orchestrator / domain.

1. `apps/ui/src/features/panels/terminalLog.ts` (baru, murni + test): dari
   `RunState` + `WorkflowDefinition` → daftar baris `{ kind: 'divider' | 'line'
   | 'end' | 'decision' | 'footer', … }` berurutan; nomor `[x/y]` dari urutan
   topologis (`rankSteps` / urutan runner); aturan "dilewati tanpa log = 1 baris".
   Test: urutan, nomor, penanda per status, baris footer, pesan tidak diubah
   (kolom tetap sejajar), keputusan auto vs manual.
2. `apps/ui/src/features/run/RunLogView.tsx` (baru): dua kolom (daftar tahap +
   log), bilah keputusan, kotak cari, ringkasan akhir (pakai ulang komponen
   ringkasan run yang ada). Virtualisasi tidak perlu dulu (log satu pasien
   ratusan baris); catat `ponytail:` bila batch membuatnya ribuan.
3. `RunPage.tsx`: toggle **Kanvas | Log** di command bar; mode `log` merender
   `RunLogView` di tempat kanvas dan menyembunyikan panel Console (isinya sudah
   jadi area utama). Setup / Inspector tetap.
4. `RunInputForm.tsx` (atau bagian Run setup di `RunPage`): pilihan "Tampilan
   hasil: Kanvas / Log" sebagai default; disimpan ke localStorage yang sama
   dengan toggle.
5. `App.tsx`: teruskan handler approve/reject ke `RunLogView`; buka Inspector
   untuk node yang diklik.
6. CSS: font mono, baris pembatas, warna severity, kartu keputusan, dua kolom
   (container query untuk layar sempit). Tanpa animasi berulang (ramah PC kantor).
7. Docs: `docs/runbook.md` (cara pakai mode log), CHANGELOG.

Kriteria selesai: replay fixture ranap & rajal tampil lengkap di mode log;
gate bisa disetujui/ditolak dari kartu; run write dengan auto-approve
menampilkan kartu "Disetujui otomatis"; ganti Kanvas ↔ Log di tengah run tidak
kehilangan apa pun; typecheck/lint/test hijau; dicek di browser terang & gelap,
lebar 1366 dan ≤ 900 px.

## Roadmap (di luar lingkup sekarang)

- **A. Batch terjadwal** (Windows Task Scheduler / cron): CLI tipis yang
  memanggil API orchestrator (`POST /api/runs`, SSE events, `export.jsonl`),
  bukan engine in-process — supaya lock per pasien, ledger, gate, dan allowlist
  tetap lewat satu titik penegakan. Output terminal memakai `terminalLog.ts` yang
  sama; exit code dari status run.
- **B. CLI operator**: alat yang sama, mode interaktif untuk satu pasien.
- **Log per pasien**: executor rajal/ranap menandai entri log dengan No. RM
  (field terstruktur, bukan teks) → pengelompokan Tahap → Pasien dan
  "processing pasien x/y".
- **Auto-approve berbasis risiko**: aturan ambang nominal/jenis yang sekarang
  hanya ada di UI Review dipindah ke server dan ditegakkan di mutation gate.
