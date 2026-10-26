# Rawat Jalan Filter and Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make advanced rawat jalan filters default-open and compact, render treatment filters per row, and prevent `tampungBayar` when an excluded treatment is present.

**Architecture:** Keep UI changes localized to `RunInputForm.tsx` and `theme.css`. Keep workflow safety in `domain-rajal` executor logic, using the existing runner behavior where `blocked` on critical nodes stops downstream mutation planning.

**Tech Stack:** React + TypeScript, CSS, Vitest, npm workspaces.

## Global Constraints

- Startup safety and preview/write mutation rules must not be weakened.
- The runner remains headless; UI only projects event/input state.
- Use explicit `.js` extensions on relative TypeScript imports where present.
- Do not commit compiled output.

---

### Task 1: Add rawat jalan treatment safety tests

**Files:**
- Modify: `packages/domain-rajal/src/domain-rajal.test.ts`
- Modify: `packages/domain-rajal/src/executors.ts`

**Interfaces:**
- Consumes: `RajalInput.tindakanExcludeKeywords?: string[]`
- Produces: `validate_treatment` returns `blocked` when an excluded treatment exists.

- [x] Add a Vitest test named `blocks and avoids payment planning when an excluded treatment is present`.
- [x] Run `npx vitest run packages/domain-rajal/src/domain-rajal.test.ts -t "excluded treatment"` and confirm it fails because `validate_treatment` is not blocked.
- [x] Update `validateTreatment` to check exclude keywords against `allRows` before include filtering and return `blocked` with evidence.
- [x] Run the focused test and confirm it passes.

### Task 2: Add rawat jalan date filtering test

**Files:**
- Modify: `packages/domain-rajal/src/domain-rajal.test.ts`
- Modify: `packages/domain-rajal/src/executors.ts`

**Interfaces:**
- Consumes: `RajalInput.date: string`
- Produces: `filter_records` only matches records whose normalized `tgl_masuk` equals input date when `tgl_masuk` is present.

- [x] Add a Vitest test named `filters visit records by the requested rawat jalan date`.
- [x] Run `npx vitest run packages/domain-rajal/src/domain-rajal.test.ts -t "requested rawat jalan date"` and confirm it fails because both dates match.
- [x] Update `filterRecords` to include a date guard using `normalizeDate(r.tgl_masuk)`.
- [x] Run the focused test and confirm it passes.

### Task 3: Add UI helper test for per-row treatment input parsing

**Files:**
- Modify: `apps/ui/src/runInputForm.test.ts`
- Modify: `apps/ui/src/features/forms/RunInputForm.tsx`

**Interfaces:**
- Consumes: newline-separated treatment fields through existing `splitList`.
- Produces: `buildRajalInput` returns separate include/exclude keywords for newline-separated values.

- [x] Add a Vitest test named `parses per-row rajal treatment filters`.
- [x] Run `npx vitest run apps/ui/src/runInputForm.test.ts -t "per-row rajal treatment filters"` and confirm it passes or fails for the right reason. If it already passes, keep it as regression coverage for the UI layout change.
- [x] Change `RunInputForm.tsx` advanced rawat jalan markup so treatment fields are textareas in a vertical stack.
- [x] Keep the core `rajal-inputs` grid compact.

### Task 4: Verify compact default-open advanced filters

**Files:**
- Modify: `apps/ui/src/features/forms/RunInputForm.tsx`

**Interfaces:**
- Consumes: existing classes from `RunInputForm.tsx`: `run-advanced`, `advanced-stack`, `advanced-inputs`, `run-field`, and `run-input`.
- Produces: layout where advanced filters are default-open, core rawat jalan inputs remain compact, and treatment filters are entered per row via stacked textareas.

- [x] Use existing CSS classes for the default-open advanced layout and textarea controls.
- [x] Run `npm run typecheck`.
- [x] Run `npx vitest run packages/domain-rajal/src/domain-rajal.test.ts apps/ui/src/runInputForm.test.ts`.
- [x] Report workflow correctness finding for this slice; later batch/per-record parity work is tracked in `docs/legacy/rajal-parity.md`.
