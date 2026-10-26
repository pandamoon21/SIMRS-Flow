# Changelog

All notable changes to SIMRS-Flow. This project is pilot-stage; until it ships a
tagged release, entries are grouped under **Unreleased** and ordered newest
first. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Run "Log saja" view.** The Run page can show a run as a terminal log
  instead of the canvas (**Kanvas | Log** in the command bar, default in Run
  setup, remembered per browser): `── [x/y] Nama ──` dividers, executor lines
  untouched, `✓ [x/y] Nama · 1.0s` end lines, a closing
  `════ SELESAI · … ════` footer; a step list to jump through the log;
  search with No. RM matching with or without dashes; **Setujui / Tolak** and
  **Setujui rencana** cards for waiting gates and writes (same handlers as the
  Inspector) with a sticky **Menunggu keputusan (n)** bar; auto-approved
  decisions read *Disetujui otomatis*. UI only (`terminalLog.ts`,
  `RunLogView.tsx`); plan in `docs/run-log-mode-plan.md`.
- **Iur Naik Kelas page.** New rail entry listing the doctors' Google Form
  responses (iur pasien BPJS naik kelas): totals (IUR, pasien, rata-rata,
  billing), digit-tolerant search (No. RM `123456` finds `0-12-34-56`, plus
  name/doctor/case/tindakan/kode grouping), date presets and range on tgl
  pulang or tgl input, hak kelas / kelas ranap / dokter filters, a
  **Filter lanjutan** panel (kasus / tindakan / kode grouping / klaim
  "contains" with suggestions, IUR and billing ranges like `1 jt`), removable
  filter chips, sortable columns, **Export XLSX** and **Cetak / PDF**.
  The sheet is **stored server-side** (`NaikKelasStore`, `NAIK_KELAS_FILE`)
  and re-read automatically once per `NAIK_KELAS_REFRESH_HOURS` (default 24)
  or on **Ambil sekarang**; page views never hit Google. The source link is a
  server setting (**Pengaturan lanjutan**, shared by every operator; default
  `NAIK_KELAS_SHEET_URL`). Only Google Sheets links are accepted and only their
  CSV export URL is fetched. Routes: `GET /api/naik-kelas`,
  `POST /api/naik-kelas/refresh`, `POST /api/naik-kelas/source` (bearer).
- **Shared data-table kit** (`apps/ui/src/features/table/`): pager at the top
  and bottom with a jump-to-page box and rows-per-page, paging that no longer
  scrolls the page to the top, a viewport-high scroll box (sticky header,
  horizontal scrollbar always on screen, keyboard/Shift+wheel panning), print
  menu (A4 / F4 / Letter / Legal, landscape or portrait, column picker, font
  scaled to the sheet, auto-fit so no column falls off, page numbers), and a
  dependency-free XLSX writer. Used by Iur Naik Kelas and Rekapitulasi.
- **Rekapitulasi overhaul.** Hari / minggu / bulan / tahun ini cards always
  visible, period tabs + custom range, metrics with change vs the previous
  period, a chart that groups per shift (one day), per day (≤ 2 months) or
  per month, and a patient table with search, workflow/shift/status/operator
  filters, removable chips, sortable columns, the table kit, Salin, XLSX and
  print. The demo patient stub now spans ~400 days so these periods have data.
- **Responsive charts** (`SeriesChart`, Rekap + Overview): drawn at the real
  pixel width, y-axis with round rupiah ticks, x labels thin out and bar
  values hide when bars get narrow, keyboard-selectable bars, round dots on
  line/area charts at every width.
- Rule catalog shows a "belum selesai, masih dalam pengerjaan" notice.
- **Ranap "Ambil dari laporan pasien keluar".** Reads
  `rekam_medis/laporan_keluar_rwi_kasir/preview` (new read-only endpoint
  `laporanKeluarRanap.preview`, `GET /api/ranap/discharged`) with keluar/masuk
  period, verifikasi and bayar (semua/sudah/belum) and penjamin filters; the
  result list is searchable and **Pilih** fills No. RM and tanggal (tgl masuk).
- **No. RM quick find** on the rajal list and the ranap result: search by
  digits with or without dashes, **Pakai ini saja** / × per RM.
- **Rajal "Ambil dari laporan belum bayar".** List mode gets the legacy
  *Fetch*: period/instalasi/penjamin, **Semua poli** or **Poli terpilih**, and
  **Ambil data** fills the No. RM list, poli and visit range (`dateFrom`/`dateTo`)
  from the live unpaid-bill report. Poli are removable chips with **Hapus
  semua**; No. RM has **Kosongkan**. New read-only
  `GET /api/rajal/unpaid` (live session, preview client, re-login transport).
- The rajal Poli picker merges the poli headings of the current month's report
  with the static list, so new SIMRS clinics appear without a code change.
- SEP poli mapping for `GASTROENTEROHEPATOLOGI` → `GASTROENTEROLOGI-HEPATOLOGI`
  (from a live SEP) and `TB RO` → `PARU`; remaining unmapped poli are listed as
  gaps in `docs/legacy/rajal-parity.md`.
- **Rawat jalan tahapan canvas.** The rajal workflow renders as nine aligned,
  labelled columns (Persiapan, Tahap 1–8) with a portal header overlay, on a new
  pure module `apps/ui/src/features/canvas/rajalPresentation.ts`. The 21 real
  node ids, edges, executor refs, and mutation ownership are unchanged; only
  label/position/description are overridden in the UI.
- **MULAI queue recap.** A `rajal.clinic-counts` evidence record is emitted by
  the visit filter on every return path (success, skipped, blocked,
  needs_review): unique patients per selected poli after the visit filters, with
  a cross-poli patient counted once per poli but once in the total. The MULAI
  card projects it with ready / waiting / unavailable states and labels a
  partial read as `data parsial`. No extra SIMRS request is made.
- **Richer run cards.** The Rajal card variant shows the static purpose, runtime
  status/duration, the recap or summary, up to two prioritised issues, mutation
  progress, and a review call-to-action. A native `nodrag` title button selects a
  node; the review button selects it and opens the inspector. Approvals remain in
  the inspector.
- `MockRunOptions.clinicCounts` on `mockEventStream` so the offline replay
  fixture can show the MULAI recap; off by default, existing streams unchanged.
- Optional `AUTO_APPROVE_WRITES=1` / `autoApprove: true` (write runs only) for
  supervised pilots, recorded with a synthetic second approver so the audit trail
  never reads as a two-human sign-off.
- Live-validation harness additions for the rajal endpoint reads.

### Changed

- **Flexible canvas, vertical.** A step's checks now hang one under another
  below it, each ✗ outcome to its right, instead of fanning six chips sideways;
  lanes are one list wide, IGD / POLI sit side by side, and folded columns hold
  5 steps so the run fits the screen.
- **Fixed canvas cards** size to their content and show an **Alasan** block:
  the step's real checks (✗ first, with what is wrong or planned), or the rule
  catalog lines — the matching "Lanjut bila" / "Dilewati bila" ticked once it
  ran, "Akan diputuskan" before. Redundant "X ok" summaries are hidden.
- **Run progress mark**: the spinner beside the run id is now a line-art cat
  walking over grass from the start to the finish flag by finished steps; it
  only walks while the run runs.
- **Confirmed write** buttons and badge use their own magenta, no longer the
  warning amber.
- Node labels read in full Indonesian (`Sinkronisasi Tindakan`,
  `Sinkronisasi Visite Dokter`, `Sinkronisasi Tanggal Masuk`,
  `Cek Transaksi Menggantung`, `Cek Awal Order Gizi`, rajal `Muat Konfigurasi`,
  `Validasi Radiologi`, …); workflows are `Rawat Inap / RANAP` and
  `Rawat Jalan / RAJAL`. Camera buttons are `Awal` / `Saat ini` / `Akhir`;
  `Saat ini` is disabled until a step has moved.

- Rawat jalan opens at a readable 0.85 zoom on the first tahapan column instead
  of shrinking the whole graph; **Center**/**Fit** frame all nine columns via
  `fitBounds`, and an operator interaction cancels the one-shot auto-camera for
  that run.
- Rajal cards are 280×240 (the MULAI card grows to fit every poli line); the
  card title clamps to two lines rather than one ellipsised line.
- Rajal canvas hiding of drag and preset controls on the default view so headers
  and edges stay aligned; rawat inap keeps its layout, presets, and interaction.
- Rajal runtime order preserved (onko → exit date → transaction → treatment →
  four penunjang checks → SEP → payment → verification → tampung bayar); legacy
  billing eligibility and request shapes are untouched.

### Fixed

- Rajal step summaries (and so the rule lines on canvas cards and in the log)
  were English; they now read in Indonesian like the ranap ones.
- Changing workflow or mode in Run setup kept naming the previous run in the
  command bar after its graph had been cleared; the run id is now dropped too.
- The run mark kept spinning after a run ended once the workflow or mode was
  changed (a reloaded definition sits at `created` with the old run id).
- **Ambil data** sits at the right edge in both the rajal and ranap forms.

- Orchestrator read routes kept running after answering 401: `requireRead`
  returned the (truthy) reply, so `if (!requireRead(..)) return reply` never
  returned early. It now returns `undefined` after sending the 401.
- Removing a rajal poli chip (or **Hapus semua**) now also drops the fetched
  No. RM seen only under that poli; hand-typed RM stay.
- Run setup fields in one row (e.g. Tanggal / Sampai) no longer sit at different
  heights when only one has a hint (`.run-field { align-content: start }`).
- Input placeholders were invisible in the light theme (dark-theme colour).
- Opening a past run (e.g. a failed rajal run from Overview → Recent
  attention) showed the empty Run setup's "Minimal satu No. RM wajib diisi" as
  a red error next to it; while a run is on screen that check now reads as a
  neutral "Untuk run baru — belum diisi".

- Rajal SEP poli lookup took the first substring hit in mapping order, so report
  headings mapped to the wrong poli ("POLI JANTUNG ANAK" → ANAK, the gastro unit →
  PENYAKIT DALAM). The longest matching key now wins, and a mapped clinic matches
  SEPs on its BPJS poli only — a same-day PENYAKIT DALAM SEP can no longer be
  accepted for the gastro bill.
- SEP verification now reads back through `pendaftaran.getRiwayatSep` instead of
  the dead `kasir.getDataTransaksi`.
- An empty-body HTTP 200 (e.g. `verifikator.cekTransaksiPenunjang`) is decoded as
  an empty object instead of throwing, matching legacy `postFetch`.
- Rawat inap penunjang window end and IGD `tgl_masuk` are formatted in WIB rather
  than via `toISOString`, and `kasirTotal` is computed per registration.
- Auto-approve no longer strands a `critical` plan that needs two distinct
  approvers, and a re-plan no longer leaves a node parked.

### Security

- The recap, card, tooltip, aria-label, and evidence never contain medical record
  numbers, patient names, or transaction ids.
