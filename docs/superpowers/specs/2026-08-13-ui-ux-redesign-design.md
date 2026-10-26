# SIMRS-Flow Hybrid Operational UI/UX Redesign

## Status

Approved design direction: incremental hybrid operational console.

## Goal

Make the SIMRS-Flow UI more polished, beautiful, comfortable, and operationally clear without rewriting the application or changing workflow execution semantics.

The redesign optimizes for the operator decision flow:

1. Understand what is happening.
2. See what needs attention.
3. Confirm the exact scope and safety mode.
4. Inspect evidence and outcomes.
5. Take an explicit, auditable action only when allowed.

## Product context and constraints

The current UI is a CoreUI presentation shell around a React Flow workflow canvas and a Zustand projection of the shared event stream. The event stream and reducer remain the only source of run state:

```text
WorkflowDefinition → Runner → WorkflowEvent → Store → React Flow/UI
```

The following behavior is out of scope for visual redesign and must remain unchanged:

- preview is the default mode;
- write mode is explicit per run;
- live pilot input remains limited to one patient/episode;
- mutation allowlists, read-before-write preconditions, read-after-write verification, locks, idempotency, and fail-closed behavior;
- critical gate and mutation two-person approval;
- armed cancellation behavior;
- per-user authentication and bearer-only write authorization;
- append-only redacted audit logging;
- replay determinism through the shared reducer and event cursor;
- SSE authentication and unnamed `data:` frames;
- no browser persistence of credentials, cookies, tokens, or patient identifiers.

No new backend contract, database, router, state store, dependency, or PHI persistence is part of this design.

## Chosen approach

### Hybrid operational console

Use a calmer, more spacious dark-clinical presentation for Overview, Start Run, History, and Settings. Keep Run Detail as a dark-console workspace for the React Flow canvas, log, evidence, and technical state.

Reuse the existing CoreUI components and CSS tokens. Refine the existing semantic colors rather than introducing a second design-token system. Use text labels and accessible semantics with color; never communicate an important state through color alone. Do not add an icon dependency for visual polish.

This is Approach A, incremental visual polish, with two low-risk ideas from an operational command center:

- make current-run status and required next action more prominent;
- make attention states easier to scan from Overview and History.

A full command center remains deferred because it would require more prop wiring and risks deriving duplicate state. A guided wizard plus router/deep links remains deferred because the current documentation explicitly postpones it until operator evidence demonstrates the need.

## Information architecture and screen behavior

### Authenticated shell

Keep `LoginGate` outside the authenticated shell. Improve the shell's visual hierarchy:

- clearer active navigation;
- quieter header treatment;
- visible page identity;
- useful operator/session context without exposing secrets;
- mobile navigation that remains usable without adding a router;
- contextual `Run detail` and `Review` labels that do not imply a valid run exists when there is no selected run.

The current local page state remains the navigation mechanism for this slice. No deep-link or route lifecycle work is included.

### Overview and History

Present operational information in this order:

1. status and attention;
2. workflow and human-readable label;
3. mode/source;
4. operator/time;
5. next action.

Improve metric cards, run rows, spacing, and empty/error states. Make the following distinctions explicit:

- active versus terminal;
- needs attention versus informational;
- historical versus live;
- replayable versus unreplayable;
- planned, applied, verified, invalidated, failed, or ambiguous mutation outcomes where those outcomes are already available.

Do not introduce polling, a search index, or a second run-status model. Continue deriving displayed state from existing API summaries and the shared store/reducer. Keep Settings read-only and exclude credentials, cookies, tokens, and raw SIMRS responses.

The existing Review page is currently a placeholder. This redesign may improve its wording and contextual presentation, but does not turn it into a new mutation workflow. Any future review action must use an existing backend gate contract and preserve two-person and critical-risk controls; it must not be improvised in the UI.

### Start Run

Reorganize the existing form visually into four stages:

1. workflow and source;
2. input and exact patient/episode scope;
3. execution mode;
4. final confirmation.

The form remains functionally the same. Advanced or risk-labelled options may be placed behind native disclosure controls already used by the form, but no safety-relevant option may be hidden without an explanation of its effect.

The confirmation surface must clearly show workflow, version, source, mode, scope summary, and the current operator. Preview remains the default. Confirmed write remains visually distinct but not easier to activate. Persistent warnings sit near the final action. Every blocked start explains the precise blocker.

### Run Detail

Strengthen the command/status area so the operator can immediately see:

- live versus historical;
- preview versus write;
- workflow and version;
- scope reference where approved for display;
- operator;
- run status and progress/current node;
- gate or mutation attention;
- connection/freshness state where the existing data supports it;
- whether cancellation is available.

Keep the current canvas, inspector, console, replay control, and cancellation contract. Improve layout and panel hierarchy only:

- consistent panel headers and actions;
- readable evidence and mutation summaries;
- explicit gate and approval wording;
- visible precondition, verification, ambiguous-write, and fail-closed explanations;
- responsive behavior that avoids forcing evidence and a full log into an unreadable tablet/mobile stack.

The existing RunConsole debug/problem filters, auto-follow behavior, and “Jump to latest” action must remain. Streaming announcements should remain concise and should not turn the entire changing log into noisy screen-reader output.

Workflow nodes should retain visible status and risk text while gaining keyboard-operable semantics and accessible names. A future list/table fallback for users who cannot pan or zoom is desirable but is not required for this visual slice unless the existing component can support it without a second state model.

## File scope

Primary files:

- `apps/ui/src/styles/theme.css`
- `apps/ui/src/styles/workflow.css`
- `apps/ui/src/app/DashboardShell.tsx`
- `apps/ui/src/features/dashboard/DashboardHome.tsx`
- `apps/ui/src/features/history/RunHistory.tsx`
- `apps/ui/src/features/run/RunStartPage.tsx`
- `apps/ui/src/features/run/RunDetailPage.tsx`

Targeted changes may be needed in:

- `apps/ui/src/features/panels/NodeInspector.tsx`
- `apps/ui/src/features/panels/RunConsole.tsx`
- `apps/ui/src/features/canvas/WorkflowNode.tsx`
- focused UI tests under `apps/ui/src`

Do not modify workflow-core, domain packages, orchestrator safety enforcement, API authentication, mutation gate, audit ledger, or package dependencies for this redesign.

## Delivery phases

### Phase 0 — baseline

- Run current UI tests, typecheck, lint, and build.
- Verify the offline fixture replay path and record the behavior baseline.
- Confirm no safety assertions or existing semantic error messages are changed.

### Phase 1 — tokens and shell

- Refine existing colors, spacing, card rhythm, borders, elevation, typography, active navigation, header, focus states, and responsive shell behavior.
- Preserve current contrast overrides, 44px interactive targets, and reduced-motion rules.

### Phase 2 — Overview, History, Settings

- Improve status/attention hierarchy, human-readable labels, replayability explanation, health presentation, empty states, and row actions.
- Keep all data derived from existing API/reducer contracts.

### Phase 3 — Start Run

- Apply the four-stage visual hierarchy.
- Make scope, source, mode, preview default, write warning, and blocker reason unmistakable.
- Keep unsafe scope settings out of browser persistence.

### Phase 4 — Run Detail

- Improve command bar, status/freshness context, panel headers, gate/mutation attention, canvas/panel responsive layout, node accessibility, and concise live announcements.
- Preserve cancellation arming and all existing inspector/console capabilities.

### Phase 5 — validation

- Run existing tests plus a small focused test only where new non-trivial presentation logic needs one.
- Manually validate sanitized fixture states: running, completed, failed, blocked, gate waiting, mutation planned/applied/verified/ambiguous, historical unreplayable, unauthorized, and live-scope-blocked.
- Check keyboard navigation, visible focus, 44px targets, reduced motion, narrow mobile layout, and status text independent of color.

## Acceptance criteria

- `npm test --workspace @simrs-flow/ui`, `npm run typecheck`, `npm run lint`, and `npm run build` remain green.
- Offline fixture replay still works and remains deterministic.
- Preview is still the default; write remains explicit.
- The one-patient live blocker and its safety meaning remain intact.
- Gate approve/reject, armed cancel, bearer-only writes, mutation approval, preconditions, read-after-write verification, ambiguous outcomes, audit, and redaction semantics are unchanged.
- Important statuses are conveyed through text and/or accessible labels as well as color.
- Keyboard focus is visible and primary interactive targets remain at least 44px.
- Reduced-motion behavior remains supported.
- Historical unreplayable runs remain visibly non-replayable, explain why, and remain exportable.
- No new secret, raw response, or patient identifier is persisted in browser storage.

## Deferred work and triggers

- Add React Router/deep links when operators demonstrate a need to bookmark, refresh, share, or reliably return to a run URL.
- Add an operational command center when observation shows that Overview/History cannot surface next actions without duplicated state or excessive navigation.
- Add a search index only after measured JSONL history/search latency justifies it.
- Add a guided wizard only after usability observation shows that the current staged presentation still causes novice errors.
- Add a dedicated icon library only when an approved existing dependency is insufficient and the accessibility/visual gain justifies its maintenance cost.
