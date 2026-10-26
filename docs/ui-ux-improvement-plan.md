# UI/UX Improvement Plan

1. Audit layar utama dan alur pengguna.
2. Catat masalah prioritas tinggi.
3. Rapikan layout, spacing, dan hierarchy.
4. Standarkan warna, typography, dan komponen.
5. Perbaiki state loading, empty, dan error.
6. Tingkatkan aksesibilitas dasar.
7. Validasi dengan build dan lint.

Alternatif lebih malas: mulai dari 1-2 halaman paling sering dipakai dulu, bukan seluruh UI.

## 2026-08-28 — Pleurat design-language refresh (implemented)

Items 3, 4, dan 6 di atas diimplementasikan lewat refresh design language yang
di-adaptasi dari pleurat.com (analisis + plan:
[`superpowers/plans/2026-08-28-pleurat-design-refresh.md`](superpowers/plans/2026-08-28-pleurat-design-refresh.md)).

Design contract baru:

- **Palette**: warm ivory ink (`--ink #efede2`, ramp muted `#b7b5aa`, faint
  `#7d7c72`) di canvas near-black `#050711`; hairline borders dari alpha
  (`rgba(239,237,226,.13)`); interaction accent **lime `#c0eb3a`** dengan
  hover/active variants. Status colours tetap semantic (success/warning/danger).
- **Light theme (paper)**: `html[data-theme='light']` menukar seluruh token ke
  paper band (`#f6f2e8` / `#fffdf3`, ink `#16140e`). Toggle di header shell,
  persist di `localStorage['simrs-flow-theme']`. Eyebrow/label memakai
  `--label-ink` (lime di dark, olive `#4a5a14` di light) agar terbaca di keduanya.
- **Type**: heading weight 500, tracking -.045em, clamp scale; micro-labels dan
  badges mono ui-monospace 10.8–11px uppercase.
- **Motion**: token `--dur-1/2/3`, `--ease-std/spring`, `--lift`; card hover
  lift, button press scale; dibungkus `prefers-reduced-motion` global.
- **Paper panel**: confirm box Start run selalu paper (`#fffdf3`) — focal point
  keputusan di kedua theme.

Evidence (before/after): `.omo/evidence/pleurat-refresh/`.

## 2026-08-28 — Pleurat design-language refresh (implemented)

Items 3, 4, dan 6 di atas diimplementasikan lewat refresh design language yang
di-adaptasi dari pleurat.com (analisis + plan:
`superpowers/plans/2026-08-28-pleurat-design-refresh.md`).

Design contract baru:

- **Palette**: warm ivory ink (`--ink #efede2`, ramp muted `#b7b5aa`, faint
  `#7d7c72`) di canvas near-black `#050711`; hairline borders dari alpha
  (`rgba(239,237,226,.13)`); interaction accent **lime `#c0eb3a`** dengan
  hover/active variants. Status colours tetap semantic (success/warning/danger).
- **Light theme (paper)**: `html[data-theme='light']` menukar seluruh token ke
  paper band (`#f6f2e8` / `#fffdf3`, ink `#16140e`). Toggle di header shell,
  persist di `localStorage['simrs-flow-theme']`. Eyebrow/label memakai
  `--label-ink` (lime di dark, olive `#4a5a14` di light) agar terbaca di keduanya.
- **Type**: heading weight 500, tracking -.045em, clamp scale; micro-labels dan
  badges mono ui-monospace 10.8-11px uppercase.
- **Motion**: token `--dur-1/2/3`, `--ease-std/spring`, `--lift`; card hover
  lift, button press scale; dibungkus `prefers-reduced-motion` global.
- **Paper panel**: confirm box Start run selalu paper (`#fffdf3`) — focal point
  keputusan di kedua theme.

Evidence (before/after): `.omo/evidence/pleurat-refresh/`.
