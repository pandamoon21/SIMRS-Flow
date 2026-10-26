# Rawat Jalan Filter and Workflow Verification Design

## Goal
Improve the rawat jalan input UX so advanced filters are visible by default but compact, make treatment filters easier to read per row, and ensure excluded treatments stop processing before `kasir.tampungBayar` is planned.

## UI design
`apps/ui/src/features/forms/RunInputForm.tsx` keeps the main `Input Rawat Jalan` row compact with only the core fields: No. RM batch, Poli, and Tanggal. The advanced rawat jalan section remains directly under the core row but changes from a closed `<details>` block to a default-open section. Its summary/header stays visible and compact.

Inside the advanced section:
- Penunjang checks remain compact toggle pills.
- `Penjamin diterima` may stay on one row because it is usually short.
- `Wajib ada tindakan`, `Tindakan yang di-skip`, and `Minimal tindakan` render in a vertical stack so treatment filters are not compressed into one horizontal row.
- Copy clarifies that the skip filter is a stop condition: if any listed treatment exists, the record is not processed.

## Workflow behavior design
`packages/domain-rajal/src/executors.ts` changes `validateTreatment` so excluded treatment keywords are checked against all raw treatment rows before include filtering. If any excluded keyword matches, the node returns `blocked` with evidence and, because `validate_treatment` is critical in the workflow, the runner stops before `submit_payment` can plan `kasir.tampungBayar`.

The existing include/minimum behavior remains:
- Include keywords, when provided, select the treatment rows that must be present.
- `tindakanMinCount` blocks if matched rows are below the operator minimum.
- Empty matched rows still need review.

## Verification design
Tests cover both behavior and the workflow limitation discovered during review:
- A domain-rajal test proves an excluded treatment blocks `validate_treatment` and no payment mutation is planned.
- A domain-rajal test proves rawat jalan date input is used when filtering matching records.
- A UI helper test proves newline separated treatment filters are parsed as individual keywords, supporting per-row entry.

## Workflow correctness finding

Historical note: this finding was true for the 2026-06-19 filter slice. It is
superseded by [`../../legacy/rajal-parity.md`](../../legacy/rajal-parity.md),
which tracks the current batch/per-record status. This spec remains as the
archive of that slice, not the live parity ledger.
