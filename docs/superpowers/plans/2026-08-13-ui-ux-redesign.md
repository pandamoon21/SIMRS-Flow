# SIMRS-Flow UI/UX Redesign — Implementation Plan

> **Source design:** `docs/superpowers/specs/2026-08-13-ui-ux-redesign-design.md`
>
> **Rule:** implement one phase at a time. After each phase, run its check gate before continuing. No backend, workflow-core, reducer, mutation-gate, auth, audit, router, database, dependency, or second state model changes are allowed in this plan.

## Current baseline and test reality

The UI has six test files and 57 unit cases under `apps/ui/src`. Tests run in the root Vitest configuration with `environment: node`; there is no DOM/React Testing Library harness. Do not add snapshots or a browser test framework for this visual pass.

Before editing, restore/install dependencies if required, then record fresh results for:

```bash
npm test --workspace @simrs-flow/ui
npm run typecheck
npm run lint
npm run build
```

If dependencies are unavailable, record that as a blocked baseline rather than claiming a pass. Historical green results are not fresh evidence.

## Phase 0 — Baseline and invariants

### Goal

Capture executable behavior before visual changes and establish the safety invariants that every later phase must preserve.

### Files to inspect

- `apps/ui/src/app.test.ts`
- `apps/ui/src/apiClient.test.ts`
- `apps/ui/src/runInputForm.test.ts`
- `apps/ui/src/runHistory.test.ts`
- `apps/ui/src/logView.test.ts`
- `apps/ui/src/runStore.test.ts`
- `packages/test-fixtures/src/mockEvents.ts`
- `docs/superpowers/specs/2026-08-13-ui-ux-redesign-design.md`

### Steps

1. Run the four baseline commands above.
2. Verify the existing pure coverage for auth/error handling, live one-patient blockers, armed cancel labels, input builders, history attention/replay labels, log projection, and replay seeking.
3. Manually capture the sanitized offline fixture replay path: login gate → Overview → Start preview → Run detail → replay/seek.
4. Record the exact current safety wording that must not change semantically.
5. Do not add tests in this phase; baseline is evidence, not a feature.

### Check gate

- Baseline command results are recorded.
- Offline fixture replay remains deterministic.
- No source files changed.
- If `node_modules` or `vitest` is missing, stop and report the environment blocker before implementation.

## Phase 1 — Theme tokens and authenticated shell

### Goal

Create the hybrid visual foundation without changing page state, navigation semantics, or run state.

### Files

- `apps/ui/src/styles/theme.css`
- `apps/ui/src/styles/workflow.css`
- `apps/ui/src/app/DashboardShell.tsx`
- optionally `apps/ui/src/app/App.tsx` only if contextual nav labels require an existing selected-run prop; prefer avoiding this wiring
- `apps/ui/src/app.test.ts` only if a new pure label helper is introduced

### Steps

1. Reuse existing CSS variables and CoreUI overrides; consolidate rather than introduce a second token namespace.
2. Refine page gutters, card rhythm, borders, elevation, typography, heading/eyebrow hierarchy, and action spacing.
3. Make active navigation and current page identity clearer.
4. Keep the operator/session area useful but secret-free.
5. Make contextual `run`/`review` navigation wording explicit when no run is selected; do not make unavailable actions appear active.
6. Preserve visible focus rings, reduced-motion rules, text-plus-color status, and minimum 44px targets.
7. Improve sidebar/header behavior at desktop, tablet, and mobile widths without adding a router.

### Check gate

- Run the baseline command set.
- Manually verify active nav, sidebar toggle, page identity, keyboard focus, 44px targets, reduced motion, and mobile shell.
- Confirm no App/store/API behavior changed.

## Phase 2 — Overview, History, and Settings scanability

### Goal

Make status, attention, replayability, and next action easy to scan while using existing API summaries and pure helpers.

### Files

- `apps/ui/src/features/dashboard/DashboardHome.tsx`
- `apps/ui/src/features/history/RunHistory.tsx`
- `apps/ui/src/features/settings/SettingsHealth.tsx` only for presentation if needed
- `apps/ui/src/styles/theme.css`
- `apps/ui/src/runHistory.test.ts` only for new non-trivial pure derivations

### Steps

1. Preserve `splitRuns`, `needsAttention`, `statusColor`, `displayTime`, and `openRunTitle` contracts.
2. Present each run in the order: status/attention → human workflow label → mode/source → operator/time → next action.
3. Improve metric-card consistency, attention emphasis, empty states, loading states, and error states.
4. Explain replayable versus historical/unreplayable without implying that an unreplayable run can be opened.
5. Keep Settings read-only and expose only safe operational fields.
6. Do not add polling, filters requiring new API semantics, search indexes, patient persistence, or a parallel status selector.
7. Keep the Review placeholder wording-only unless an existing backend review contract is explicitly available; do not add mutation actions in this phase.
8. Add pure tests only if new mapping/label logic is introduced. Do not add DOM snapshots.

### Optional focused tests

- `statusColor` for completed, failed, interrupted, paused, unreplayable, running, and default statuses;
- `displayTime` for missing, invalid, and valid ISO values;
- any new pure attention/next-action selector.

### Check gate

- Existing UI tests and build commands pass.
- Manual sanitized states: active, terminal, needs attention, replayable, unreplayable, empty, API error, unauthorized, health online/degraded.
- No raw credentials, tokens, cookies, raw SIMRS responses, or new PHI persistence.

## Phase 3 — Start Run hierarchy and safety clarity

### Goal

Make the existing run form feel guided without turning it into a wizard or changing its validation/persistence contract.

### Files

- `apps/ui/src/features/run/RunStartPage.tsx`
- `apps/ui/src/features/forms/RunInputForm.tsx`
- `apps/ui/src/styles/theme.css`
- `apps/ui/src/runInputForm.test.ts` and/or `apps/ui/src/app.test.ts` only for new pure helpers

### Steps

1. Keep the existing functional controls and builders.
2. Visually group the page as: workflow/source → input/scope → execution mode → final confirmation.
3. Keep Preview selected by default and retain existing CTA wording semantics.
4. Make write warnings persistent and adjacent to the final action; do not make write easier to activate than preview.
5. Show workflow, version, source, mode, scope summary, and operator in the confirmation surface where existing props support them.
6. Display the exact start blocker near the disabled action.
7. Keep advanced debug/payment/treatment/SEP controls behind existing native disclosure patterns where safe, with risk/context copy; do not remove validation or silently normalize input.
8. Preserve localStorage boundaries: safe rajal filters may remain, but never patient IDs, mode, source, discovery cap, credentials, tokens, or raw responses.
9. Use native date/number controls and existing CoreUI components.

### Optional focused tests

Only add pure checks if presentation changes introduce behavior:

- CTA label/summary for preview versus write;
- malformed storage is ignored;
- saved filters exclude patient identifiers, mode, and discovery cap;
- blocker text remains exact and actionable.

### Check gate

- Run UI tests, typecheck, lint, and build.
- Keyboard-switch workflow/source/mode and verify visible focus.
- Manually test invalid RM/date/period input, multi-patient live input, discovery cap >1, preview default, write warning, blocker explanation, and safe refresh persistence.

## Phase 4 — Run Detail workspace, accessibility, and live-state hierarchy

### Goal

Improve the highest-risk interaction surface without changing event projection, gate semantics, mutation controls, or replay behavior.

### Files

- `apps/ui/src/features/run/RunDetailPage.tsx`
- `apps/ui/src/features/canvas/WorkflowCanvas.tsx`
- `apps/ui/src/features/canvas/WorkflowNode.tsx`
- `apps/ui/src/features/panels/NodeInspector.tsx`
- `apps/ui/src/features/panels/RunConsole.tsx`
- `apps/ui/src/styles/workflow.css`
- `apps/ui/src/styles/theme.css`
- `apps/ui/src/runStore.test.ts`, `apps/ui/src/logView.test.ts`, or a small new pure helper test only when new non-trivial derivation is added

### Steps

1. Make the command bar expose existing context: live/historical, preview/write, workflow/version, scope where approved, operator, run status, progress/current node, gate/mutation attention, and cancellation availability.
2. Keep cancel armed confirmation exactly as a two-step interaction; do not weaken disabled historical behavior.
3. Preserve NodeInspector evidence, mutation payload summaries, preconditions, verification results, ambiguous-write warnings, and fail-closed reasons. Do not display raw payloads or secrets.
4. Preserve RunConsole debug/problems filters, auto-follow, and Jump to latest. If accessibility is adjusted, use a concise live summary instead of announcing the entire changing log.
5. Fix collapsed-panel accessibility: hidden interactive descendants must be unmounted, inert, or removed from the accessibility tree/tab order.
6. Replace clickable-only workflow node semantics with keyboard-operable controls/handlers and accessible names containing label, status, and risk. Keep visible status text and color.
7. Prevent active-node auto-centering from unexpectedly yanking an operator after manual pan/zoom; use an explicit follow-live affordance only if it can be derived from existing store state without new run state.
8. Improve responsive panel layout: avoid simultaneously squeezing full inspector and console into a short mobile region; use existing hide/restore controls or a simple one-panel-at-a-time presentation without adding a dependency.
9. Preserve deterministic positions and event-cursor rendering. Do not introduce a second projection model or topology mutation.

### Optional focused tests

- detail context/next-action pure formatter;
- accessible status/risk label formatter;
- visible-log filter if extracted;
- deterministic layout helper if changed.

Do not create React snapshots or a DOM harness for this phase unless a separate approved testing decision changes the repo test architecture.

### Check gate

- Run the full command set.
- Manually validate sanitized fixture states: running, completed, failed, blocked, gate waiting, planned/applied/verified/invalidated/failed/ambiguous mutation, historical unreplayable, unauthorized/session expiry, and live scope blocked.
- Verify keyboard node focus/activation, visible focus, panel collapse tab order, concise screen-reader announcements, narrow layout, reduced motion, evidence readability, and no approval/cancel bypass.

Important limitation: `packages/test-fixtures/src/mockEvents.ts` does not directly cover every failed/blocked/gate/ambiguous state. Use sanitized event traces or API fixture harnesses for those manual states; do not claim the default mock stream covers them.

## Phase 5 — Final validation and handoff

### Steps

1. Run:

```bash
npm test --workspace @simrs-flow/ui
npm run typecheck
npm run lint
npm run build
```

2. Compare current results with the Phase 0 baseline.
3. Run the manual fixture/accessibility matrix from Phases 2–4.
4. Review the diff for accidental changes outside `apps/ui` and focused UI tests/styles.
5. Confirm safety docs and behavior remain aligned; do not update them to hide a regression.
6. Record deferred work explicitly: router/deep links, full command center, search index, guided wizard, and new icon library.

### Definition of done

- Automated checks pass with fresh evidence.
- Offline replay is deterministic.
- The visual hierarchy clearly distinguishes preview, write, live, historical, attention, gate, mutation, and verification states.
- Keyboard/focus/responsive/reduced-motion checks pass.
- All existing safety semantics remain intact.
- No new dependency, backend contract, store, router, database, secret storage, or PHI persistence was introduced.
