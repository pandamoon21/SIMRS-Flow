# Run page — wording proposal (draft for approval)

Rule set agreed for this review:

1. Operator-facing text in concise, standard Indonesian. Common English UI words stay:
   **Run, Preview, Log, Inspector, Console, Fit, Follow, Fixed, Flexible, Export, Reset, Run ID, Filter, Logout**,
   plus hospital terms: SEP, BPJS, No RM, IGD, IBS, titipan, naik kelas, tampung bayar, verifikasi, gate.
2. A status that needs the operator says what to do next.
3. One concept, one word everywhere (e.g. *Gerbang Akhir*, never "final gate" next to it).
4. No internal identifiers in operator text (endpoint ids such as `kasir.updateTglMasuk`, "in-memory", "ledger", "JSONL" outside the export button).

Status legend: **keep** (no change) · **change** (proposed).

## Run page chrome

| Where | Now | Proposed |
|---|---|---|
| Run source toggle | Fixture replay | **Data contoh** |
| Run source hint | Replay canned fixture data — never touches SIMRS | Memutar data contoh — tidak menyentuh SIMRS |
| Run source toggle | Live SIMRS | keep |
| Run source hint | Read from the live SIMRS instance with your operator session | Membaca SIMRS langsung dengan sesi login Anda |
| Mode hint | Dry run — mutations are surfaced as plans, nothing is written | Uji coba — perubahan hanya ditampilkan sebagai rencana, tidak ada yang ditulis |
| Mode hint | Writes require an allowlist, per-call approval, and verification | Setiap penulisan melewati daftar izin, persetujuan, dan verifikasi ulang |
| Mode hint | Write mode still requires allowlists, approvals, locks, and verification. | (same as above) |
| Start button | Start preview | **Mulai preview** |
| Start button | Start confirmed write | **Mulai run write** |
| Auto-approve toggle | Auto approve write run / Auto-approve gate & mutasi | **Setujui otomatis** · hint: Gate dan rencana penulisan disetujui atas nama Anda; precondition dan verifikasi tetap berjalan |
| Stop button | Stop run | **Hentikan** |
| Stop confirm | Klik lagi untuk stop | Klik lagi untuk menghentikan |
| Empty canvas | Pick a workflow and start a run to see the canvas. | Pilih alur lalu mulai run untuk melihat kanvas. |
| Empty state | No run yet / Configure a run to begin | Belum ada run · Atur run di panel Setup untuk mulai |
| Run header (opened from memory) | In-memory run detail | **Detail run** |
| Run header (opened from file) | Historical ledger replay | **Riwayat run** (tersimpan) |
| Panel toggles | Show/Hide console, inspector, run setup | Tampilkan/Sembunyikan Console, Inspector, Setup |
| Panel group label | Panel visibility | Panel |
| Panel move hint | Move console panel; arrow keys move | Geser panel Console; tombol panah untuk menggeser |
| Reset button title | Reset panel positions, sizes and visibility | Kembalikan posisi, ukuran, dan tampilan panel |
| Replay bar | Event 207 of 207 | **Event 207/207** |
| Replay bar | Pause replay / Continue replay / Replay from start / Replay position | Jeda / Lanjutkan / Putar dari awal / Posisi putar ulang |
| Canvas toolbar | Selected · title "Select a node first" | keep "Selected" · title: Pilih node dulu |
| Canvas toolbar | Centre the selected node | Ke node yang dipilih |
| Canvas toolbar aria | Canvas view controls / Canvas view | Kontrol tampilan kanvas |

## Inspector, Console, Review

| Now | Proposed |
|---|---|
| Select a node to inspect status, evidence, and plans. | Pilih node untuk melihat status, bukti, dan rencana. |
| Summary / Step / Node logs | Ringkasan / Langkah / Log node |
| Proposed mutations | Rencana perubahan |
| Gate awaiting approval / Gate awaiting operator decision. | Gate menunggu persetujuan |
| Confirm the exact plan and preconditions before deciding. | Periksa rencana dan syaratnya sebelum memutuskan. |
| Approve / Approve critical / Reject | Setujui / Setujui (kritis) / Tolak |
| Record your approval — critical gates may need a second operator depending on host config | Catat persetujuan Anda — gate kritis bisa butuh operator kedua (sesuai pengaturan host) |
| Reject this gate and stop the run here | Tolak gate ini dan hentikan run di sini |
| Copy TSV · Copy as tab-separated values | Salin TSV · Salin sebagai TSV untuk Excel |
| No warnings or errors so far. | Belum ada peringatan atau error. |
| Show only warnings and errors | Hanya peringatan dan error |
| Also show debug lines: … | (already Indonesian in Log view — use that text) |
| Total step time / Steps that reached a terminal state | Total waktu langkah / Langkah yang sudah selesai |
| Precondition failed / Preconditions not yet checked | Syarat tidak terpenuhi / Syarat belum dicek |
| Needs you | Menunggu Anda |

## Server-side event messages (shown in Log / Console)

| Now | Proposed |
|---|---|
| Run run_x created in preview mode / Started in preview mode | Run dibuat (preview) / Run dimulai (preview) |
| Run cancelled | Run dihentikan |
| Completed 34/34 nodes | 34/34 langkah selesai |
| {node} awaiting approval | {node} menunggu persetujuan |
| Preview mode — gate held | Preview — gate ditahan, tidak ada yang ditulis |
| {node} disabled | {node} dimatikan di Setup |
| {node} skipped — upstream dependency unmet | {node} dilewati — langkah sebelumnya belum terpenuhi |
| {node} re-planning (pass 2/3) | {node} merencanakan ulang (putaran 2/3) |
| … asked for another pass and did not get one — … | {node} butuh putaran tambahan tetapi batas putaran habis — … |
| Mutation kasir.updateTglMasuk approved by X | **Ubah tanggal masuk** disetujui oleh X |
| Mutation … applied (…) | **…** diterapkan ke SIMRS |
| Mutation … verified (2 read-after-write check(s)) | **…** terverifikasi (2 cek ulang) |
| Mutation … applied but NOT verified — … | **…** sudah ditulis tapi BELUM terverifikasi — cek manual di SIMRS: … |
| Mutation … refused — … / was not applied — … | **…** tidak dijalankan — … |
| Mutation … rejected by SIMRS — … | **…** ditolak SIMRS — … |
| Mutation approval 1/2 by X … second approver required | Persetujuan 1/2 oleh X — butuh operator kedua |

Endpoint ids are replaced by the endpoint registry's human label (one source of truth, `endpoints.ts`).

## Node labels

| Now | Proposed | Why |
|---|---|---|
| Normalisasi Input | Periksa Input | operators "check", they don't "normalise" |
| Tolak Sudah Verifikasi | Cek Sudah Diverifikasi | the step checks; rejecting is its outcome |
| Tolak Sudah Bayar | Cek Sudah Dibayar | same |
| Validasi SEP | Cek SEP | read-only check |
| Bandingkan & Koreksi SEP | keep | |
| Deteksi BYNY | Cek Bayi Baru Lahir (BYNY) | spell out once |
| Proses POLI | Proses Poliklinik | consistent casing with "Proses IGD" |
| Cek Balance | Cek Keseimbangan Tagihan | |
| Eksekusi Verifikasi | Jalankan Verifikasi | |
| Phase "Bisa Dipayment?" | Siap Dibayar? | no hybrid word |

## Dashboard (outside Run, same rule)

| Now | Proposed |
|---|---|
| Overview · See what is running, what needs attention, and whether this host is ready. | keep "Overview" · Pantau run yang berjalan, yang perlu perhatian, dan kesiapan host. |
| Start a run | Mulai run |
| Needs attention / Recent attention | Perlu perhatian / Perhatian terbaru |
| Active work | Run berjalan |
| No active runs. Start a preview when ready. | Tidak ada run berjalan. |
| No completed runs yet. | Belum ada run selesai. |
| View history / Open | Lihat riwayat / Buka |
| Host online / Host status unknown | Host aktif / Status host tidak diketahui |
| Loading operational status… / Loading session… / Loading | Memuat status… / Memuat sesi… / Memuat |
| Gate outcomes / Pending | Hasil gate / Menunggu |
| Settings & health · Host & browser | Pengaturan & kesehatan · Host & browser |
| Run history · Open this run on the canvas · Download the redacted JSONL audit trail | Riwayat run · Buka di kanvas · Unduh jejak audit (JSONL) |
| No replayable event log was recorded for this run | Run ini tidak punya log event yang bisa diputar ulang |
