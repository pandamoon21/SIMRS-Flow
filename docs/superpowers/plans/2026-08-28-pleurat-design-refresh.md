# Plan: Transfer pleurat.com Design Language → SIMRS-Flow Dashboard

## Context

User ingin UI/UX sekelas pleurat.com diterapkan ke dashboard SIMRS-Flow. Analisis
dilakukan langsung dari live site via computed styles (bukan tebakan visual):
design tokens, type scale, motion system, dan pola interaksi diekstrak dari CSS
aktual. Dokumen ini adalah rencana implementasinya.

## 1. Hasil analisis pleurat.com (dari computed styles)

### Design tokens (diekstrak langsung dari `:root`)

| Token | Nilai | Peran |
|---|---|---|
| `--bg` | `#050711` | Background sangat gelap, hampir hitam kebiruan |
| `--ink` | `#EFEDE2` | Teks utama — **warm white/ivory**, bukan putih murni |
| `--ink-2/3/4` | `#B7B5AA / #7d7c72 / #4a4a44` | 3 tingkat teks sekunder (warm gray) |
| `--accent` | `#C0EB3A` (lime) | Satu accent only — dipakai hemat (~8 elemen) |
| `--accent-2` | `#E2F79A` | Tint lime untuk hover/soft |
| `--line` | `rgba(239,237,226,.13)` | Border hairline dari ink, bukan warna solid |
| `--line-2` | `rgba(239,237,226,.06)` | Divider lebih halus |
| `--band-paper` | `#f3f5fa` / `#fffdf3` | **Light band** — section terang sebagai kontras dramatis |
| `--radius-card` | `18px` | Konsisten, sedikit membulat |
| `--radius-pill` | `100px` | Untuk chip/pill |
| `--ease-std` | `cubic-bezier(.22,1,.36,1)` | Standard easing (ease-out kuint) |
| `--ease-spring` | `cubic-bezier(.34,1.56,.64,1)` | Spring untuk feedback |
| `--dur-1/2/3` | `.2s / .32s / .55s` | 3 durasi motion, tidak ada yang acak |
| `--lift` | `-2px` | Hover lift konsisten |
| `--focus-ring` | `#C0EB3A` | Focus ring pakai accent |

### Type scale (fluid, clamp-based)

```
--fs-micro: 10.8px        (label eyebrow, uppercase tracking)
--fs-2xs:   13.2px
--fs-xs:    15px          (body kecil)
--fs-sm:    18px
--fs-md:    21px
--fs-h5..h1: clamp() berlapis (28.8 → 64.8px)
--fs-display: clamp(50.4px, 4.92vw, 76.8px)
--fs-ghost: clamp(180px, 28vw, 420px)  (angka dekoratif besar)
```
Semua heading `font-weight: 500`, `letter-spacing: -1.17px` hingga `-1.55px`
(tight tracking = identitas). Font tunggal: **General Sans** + system-ui fallback;
monospace ui-monospace dipakai untuk 107 elemen data/terminal.

### Layout

- Max-width `1228.8px`, section pad `clamp(96px, 15vh, 200px)` — napas sangat besar
- Grid asimetris: `612px / 452px` (bukan 50/50), baris data `319px + 3×228px`
- 6 section, scroll ~11 viewport, satu narasi top-to-bottom
- **Light band**: chart section punya bg `#fffdf3` (sticky pin) di tengah dark
  page — kontras "paper on dark" sebagai focal point

### Motion & interaksi

- 90 hover rules, 164 elemen transitioned — semua via token durasi/ease di atas
- `--lift: -2px` pada hover card; spring ease untuk feedback
- **18 media reduced-motion rules** (22 total rule) — motion dihormati
- Signature: SVG walk-cycle character ("walker says hi"), 10 kolom curtain
  repeating-gradient texture (grain halus, bukan gradient warna)
- 0 backdrop-blur, hanya 5 box-shadow — **flat, tanpa glow**; depth dari kontras
  paper-vs-dark, bukan shadow

### Karakter yang membuatnya tidak generic

1. **Warm ink on near-black** (#EFEDE2 di #050711) — bukan cool gray on black
2. **Satu accent (lime) dipakai hemat** — sisa halaman itu netral
3. **Light paper band** di tengah dark page — dramatis dan memecah monoton
4. Tight tracking + weight 500 di semua heading — satu suara tipografis
5. Terminal/data aesthetic (mono, uppercase micro labels, status READY/LIVE)
   yang dicampur editorial typography
6. Micro-detail: numbered sections (1/4 OPENED), breadcrumb mono
   (PORTFOLIO / WORKSPACE), chip status (BENCH · LIVE)

## 2. What transfers to SIMRS-Flow (dan apa tidak)

### Transfer (dashboard adalah operational tool, bukan portfolio)

| Aspek pleurat | Adaptasi SIMRS-Flow |
|---|---|
| Warm ivory ink on near-black | `--ink: #EFEDE2` di canvas `#0A0E1A`-ish; mengganti cool gray yang sekarang |
| 3-tingkat ink ramp | Ganti `--ink-muted` tunggal dengan ramp (primary/secondary/tertiary notes) |
| Satu accent hemat | SIMRS sudah punya semantic colors (success/warning/danger) — accent netral dipakai untuk **focus & interaksi**, bukan dekorasi |
| Tight tracking + w500 headings | H1/H2 dashboard dapat tracking `-0.5px..-1px`, weight 500-600 |
| Fluid clamp type scale | Ganti px statis dengan clamp() agar seragam dari 1280 sampai ultrawide |
| Section pad besar | Page-stack pad dashboard dinaikkan; breathing room di antara cards |
| Terminal/mono aesthetic | Run console & JSONL export view sudah cocok — dinaikkan jadi first-class (mono font, uppercase micro labels, status chips) |
| Status chip pattern (BENCH · LIVE) | Badge status run: `PREVIEW · DRY`, `WRITE · GATED`, `HISTORICAL · LEDGER` |
| Numbered sections (1/4) | Start run: step indicator "1 / 2" yang sudah ada, dipoles dengan mono micro |
| Light band contrast | Tidak dipakai sebagai section terang; diadaptasi jadi **"paper panel"** untuk Run Summary/confirm box di Start run — area keputusan penting visually distinct |
| Motion tokens (3 durasi, 2 ease, lift) | Semua hover/transition dashboard migrasi ke token ini |
| Reduced-motion rules | Sudah ada di theme.css — diperluas mengikuti pola pleurat |
| Hairline borders dari ink-alpha | Ganti border solid `--line` dengan `rgba(ink,.13)` |

### TIDAK ditransfer (beralasan)

- **Lime accent `#C0EB3A`** — identitas brand pleurat; SIMRS pakai semantic
  colors untuk status medis-billing. Accent netral baru (warm amber seperti
  `sv-btn--amber` #F3B44A) bisa jadi interaksi-only color, tapi bukan lime.
- **SVG walk-cycle character, curtain grain** — playful portfolio flourish,
  tidak sesuai konteks klinis; texture grain ringan boleh (opacity sangat rendah)
  jika diinginkan nanti.
- **Light band section** penuh — dashboard butuh konsistensi dark untuk operator
  jangka panjang; cukup paper panel untuk confirm/summary box.
- **11-viewport scroll** — dashboard adalah tool padat, bukan narasi.

## 3. Implementation plan (phases, per anti-ui-slop discipline)

Fase berurutan, satu commit per fase, check gate tiap fase (test+typecheck+lint+
build+screenshot before/after). Tidak ada perubahan backend/auth/reducer/kontrak.

### Phase 0 — Baseline & evidence (0.5 jam)

- Screenshot semua halaman current state (login, overview, start, detail, history,
  settings, mobile 390px) sebagai evidence before.
- File: `.omo/evidence/pleurat-refresh/` (sudah jadi konvensi repo).

### Phase 1 — Token foundation (theme.css only) (1–2 jam)

Ganti nilai token existing (tidak menambah sistem baru):

```css
:root {
  /* Warm ink ramp — ganti cool gray */
  --ink: #EFEDE2;           /* was #edf8fb (cool) */
  --ink-muted: #B7B5AA;     /* was #91a4b7 */
  --ink-faint: #7d7c72;     /* NEW: tertiary */
  --canvas: #050711;        /* was #07111b — lebih deep */
  --surface-0: #0A0E1E;
  --surface-1: #0F1526;
  --surface-2: #151C30;
  --line: rgba(239, 237, 226, .13);   /* was #2a3b4f */
  --line-2: rgba(239, 237, 226, .06);

  /* Interaction accent (bukan brand) — dari sv-btn--amber */
  --accent: #F3B44A;        /* was #24c8ff — warm amber, interaksi/hover/focus */
  --accent-soft: rgba(243, 180, 74, .14);

  /* Status tetap semantic (success/warning/danger tidak berubah peran) */

  /* Motion tokens */
  --ease-std: cubic-bezier(.22, 1, .36, 1);
  --ease-spring: cubic-bezier(.34, 1.56, .64, 1);
  --dur-1: .2s;  --dur-2: .32s;  --dur-3: .55s;
  --lift: -2px;

  /* Radius konsisten */
  --radius-card: 14px;   /* sedikit lebih kecil dari pleurat utk density operasional */
  --radius-pill: 100px;
}
```

- Type scale → clamp() untuk h1/h2/page-heading; heading tracking `-0.5px`,
  weight 600 (dashboard butuh sedikit lebih tebal dari portfolio untuk glance).
- Update semua konsumen `--line`, `--ink-muted` (mereka otomatis ikut via token).
- Kontras diverifikasi: `#EFEDE2` di `#050711` ≈ 16.8:1; `#B7B5AA` di surface
  ≈ 8+:1 — masih AA/AAA.
- Gate: full check suite + screenshot compare.

### Phase 2 — Micro-labels & terminal voice (Run console, badges, history) (2 jam)

- Micro label (10.8px, uppercase, letter-spacing .08em, mono) untuk:
  metric card labels, panel headers (INSPECTOR, RUN CONSOLE), table headers.
- Status chips jadi compound: `STATUS · DETAIL` (contoh: `COMPLETED · LEDGER`,
  `RUNNING · LIVE`, `PLANNED · GATE`).
- Run console: bg surface-0, mono font untuk timestamps & sequence, breadcrumb
  `RUN / <runId>` style mono di command bar.
- Gate: visual check History + Run detail; tests tetap hijau (kata "completed"
  di test mungkin berubah — cek dulu test snapshot).

### Phase 3 — Paper panel untuk keputusan (Start run confirm box) (1–1.5 jam)

- Confirm/summary box ("2. Confirm run") jadi **paper panel**: bg `#FFFDF3`,
  ink `#16140E`, radius 14px, border hairline `rgba(22,20,14,.15)`.
- Ini focal point Start run — area di mana operator memutuskan preview vs write.
- Inside paper panel: tombol Start preview/write jadi amber `#F3B44A` (bg) dengan
  ink `#16140E`, radius 0 (matching pleurat's sharp CTA), hover `--lift`.
- Kontras paper panel: ink `#16140E` di `#FFFDF3` ≈ 14:1 ✅.
- Gate: screenshot + keyboard nav di confirm box.

### Phase 4 — Motion polish (1–1.5 jam)

- Semua card/panel hover: `transform: translateY(var(--lift))` +
  `transition: transform var(--dur-2) var(--ease-std)`.
- Button/interactive feedback: spring ease (`--ease-spring`) untuk press states.
- Sidebar nav item: hover bg `--accent-soft`, active indicator 2px amber left bar.
- Panel show/hide (Inspector/Console): slide+fade pakai `--dur-2` (bukan instant).
- **18-ish reduced-motion rules**: tiap rule baru disertai override di
  `@media (prefers-reduced-motion: reduce)` (pola pleurat).
- Gate: manual motion check + reduced-motion via `agent-browser set media reduced-motion`.

### Phase 5 — Layout breathing & alignment (1 jam)

- Section pad antara blocks: naik dari `g-3` (12px) ke skala `16/24/40`
  (8pt-based, dashboard density tetap).
- Metric cards: internal pad `20px 22px`, label micro di atas, value 30px w600,
  note `--ink-faint` 11px — matching pleurat card anatomy (30/24/34 ratio).
- Grid asimetris untuk Overview: `7fr / 5fr` (sudah ada — pertahankan).
- Gate: screenshot mobile 390 + desktop 1280.

### Phase 6 — Aksesibilitas & finish gate (1 jam)

- Focus ring: 2px `--accent` outline + offset 2px (sudah ada pola ini —
  warna diganti amber), visible di paper panel (amber gelap variant).
- Verify semua pasangan kontras di dark & paper surface (sama seperti audit
  sebelumnya, hitung dari computed styles).
- Jalankan ulang finish gate anti-ui-slop penuh: product specificity, interaction
  completeness, responsive, design-system integrity.
- Update `.omo/evidence/pleurat-refresh/` dengan after screenshots.

### Phase 7 — Dokumentasi & handoff (0.5 jam)

- Update `docs/ui-ux-improvement-plan.md` — catat desain language baru & tokens.
- Commit per fase, Conventional Commits (`feat(ui): ...` / `style(ui): ...`).
- Report akhir: before/after screenshots + token diff + checks.

## 4. Total estimasi

~7–9 jam kerja terbagi 7 fase kecil, masing-masing independently shippable.
Fase 1–2 memberi 80% transformasi visual; fase 3 (paper panel) adalah
signature moment; fase 4–6 adalah polish yang membuatnya terasa mahal.

## 5. Resiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Tests meng-hardcode warna/status text | Cek dulu sebelum fase 2; update test bareng perubahan |
| CoreUI components override token | Pleurat style di-layer lewat theme.css overrides (pola yang sudah dipakai repo untuk alerts) |
| Kontras amber di dark kurang untuk teks kecil | Amber hanya untuk bg CTA & focus ring, bukan text color di dark |
| User sebenarnya mau lime accent persis | Tanyakan di handoff — default: amber, lime bisa ditukar 1 token |
