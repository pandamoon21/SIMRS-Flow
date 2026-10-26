# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are hospital billing staff (kasir / verifikator) at RS PKU Gombong. They run the
day-to-day billing verification and payment-staging work from the hospital's PCs during
working hours. Each operator logs in with their own EvoMedis account.

## Product Purpose

SIMRS-Flow automates billing operations against the EvoMedis / SIMRS web app by calling its
HTTP endpoints directly. It covers two domains:

- **ranap** (inpatient): verification plus `tampung bayar` (payment staging).
- **rajal** (outpatient): a batch workflow for unpaid bills.

Success means an operator can process a patient faster than by hand in SIMRS. The product
must never write wrong data. Every write is planned, approved, verified and recorded.

## Positioning

A safety-first operator console, not a blind bot:

- Runs are previews (dry runs) by default.
- Every mutation is an explicit, allowlisted plan that needs approval.
- Critical steps need two distinct operators.
- Every event lands in a redacted, append-only audit ledger.

The operator watches the workflow happen on a live graph and stays the decision-maker.

## Operating Context

- **Pilot stage:** one Windows host, LAN only, one patient or episode per live run.
- **Verification step:** after a run, operators compare the result against the SIMRS
  Verifikator page, as the runbook in `docs/runbook.md` describes.
- **Screens:** operators use desktop PCs at 1080p, small laptops at 1366×768, and some
  displays smaller than 1366×768. Tablets and phones are used occasionally.
- **Offline use:** fixture replay mode lets the UI run fully without SIMRS.

## Capabilities and Constraints

- **Pages:**
  - Overview
  - Rekapitulasi (billing recap)
  - Run: setup, a live React Flow workflow graph, inspector, console, gate and mutation
    approval
  - History
  - Review: approval queue plus automation and risk rules
  - Rules: an editable catalog of ranap and rajal rules
  - Settings & health
- **Safety gates live in the orchestrator, not the UI.** The UI speaks HTTP/SSE only and
  never touches SIMRS directly. Approve and reject actions need an authenticated operator.
- **No patient-count limit per live run** for rajal; ranap is one patient per run.
- **Placeholder data:** dashboard numbers, `/api/billing/summary`, `/api/patients`, presence
  and sticky notes are demo or process-memory data. Treat them as placeholders, not real
  figures.
- **Domain vocabulary is binding:** rajal/ranap, kunjungan, no RM, resep/obat, penunjang,
  poli, SEP, titipan/kelas, tampung bayar, verifikator, visite, gizi, IBS.

## Brand Commitments

Interface language is a deliberate mix:

- Technical and control labels stay in English (Run, Preview, Inspector, Console, Approve).
- Hospital-domain terms, statuses and operator-facing messages are in Bahasa Indonesia
  (Rawat Inap, Tampung Bayar, Berjalan, Tahap, error explanations).

Keep this split. Do not translate either side wholesale.

## Evidence on Hand

- **Real artifacts:** the workflow definitions and node labels in `packages/domain-*`, the
  rule catalog, and the endpoint registry in `docs/api-catalog.md`.
- **Fixtures only:** synthetic patient fixtures live in `packages/test-fixtures`. No real
  patient data may appear in UI, screenshots, docs or examples.
- **No fabrication:** there are no testimonials, metrics or adoption figures. Do not invent
  them.

## Product Principles

1. **The operator decides.** Automation proposes and shows its evidence; writes happen only
   on explicit, informed approval.
2. **State must never mislead.** Run, gate and mutation status must be unambiguous, current,
   and never conveyed by color alone.
3. **Every supported screen is a work screen.** The full task must work on screens from below
   1366×768 up to 1080p, and monitoring and approval must work on a tablet or phone.
4. **Preview is the safe default.** Live and write paths are visibly distinct and harder to
   reach than preview.
5. **Patient data is protected.** Redact before display, logging or export; synthetic data
   only outside live runs.

## Accessibility & Inclusion

- Keep visible labels, keyboard focus and keyboard-operable panels.
- Statuses carry text, not only color.
- Layouts must hold on low-resolution displays (below 1366×768) without horizontal page
  scroll.
