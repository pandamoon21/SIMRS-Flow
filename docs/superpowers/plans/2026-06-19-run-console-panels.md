# Run Console Panels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SIMRS-Flow UI log usable during runs by improving the run console, adding safe clear-log behavior, and making Inspector/Run Console panels hideable.

**Architecture:** Keep the event stream and reducer immutable/auditable; the clear button only changes the UI projection baseline for the console. Panel visibility is local App UI state, while log filtering is in the zustand run store so replay/live views share behavior. Auto-scroll is handled inside `RunConsole` via a ref/effect against the rendered visible log list.

**Tech Stack:** React 18, React Flow, Zustand, TypeScript strict mode, Vitest, CSS grid/flex.

## Global Constraints

- Startup remains preview/dry-run by default; no safety model changes.
- Do not alter reducer audit/event semantics; clearing console logs must not delete events or reducer logs.
- Keep UI as a pure projection of `RunState` and store state; no browser automation/Playwright.
- Use explicit `.js` extensions on relative imports and `import type` for type-only imports.
- Preserve current user changes in `WorkflowCanvas.tsx`, `theme.css`, and `run.bat`.

---

## File Structure

- Modify `apps/ui/src/store/runStore.ts`: add `consoleClearedThroughSeq` and `clearConsole()` to track display-only clear baseline.
- Modify `apps/ui/src/runStore.test.ts`: verify logs are projected normally and clear baseline hides only already-rendered console logs without mutating event history.
- Modify `apps/ui/src/features/panels/RunConsole.tsx`: add header actions, clear button, log count summary, auto-scroll to latest visible line, and filtered visible logs.
- Modify `apps/ui/src/app/App.tsx`: add local state for Inspector/Run Console panel visibility and pass controls through the side panel.
- Modify `apps/ui/src/styles/theme.css`: add panel header action layout, side panel hidden layouts, console sizing, and log empty/counter styles.

---

### Task 1: Store-level console clear baseline

**Files:**
- Modify: `apps/ui/src/store/runStore.ts`
- Test: `apps/ui/src/runStore.test.ts`

**Interfaces:**
- Produces: `RunStoreState.consoleClearedThroughSeq: number`
- Produces: `RunStoreState.clearConsole(): void`
- Consumes: existing `state.lastSeq`, `events`, and `pushEvent()` behavior

- [ ] **Step 1: Write failing tests**

Append these tests inside `describe('runStore', () => { ... })` in `apps/ui/src/runStore.test.ts`:

```ts
  it('projects run logs from the mock event stream', () => {
    const stream = mockEventStream(ranapWorkflow, { runId: 'ui-logs' });
    useRunStore.getState().loadDefinition(ranapWorkflow, 'preview');
    for (const e of stream) useRunStore.getState().pushEvent(e);

    const { state } = useRunStore.getState();
    expect(state?.logs.length).toBeGreaterThan(0);
    expect(state?.logs.some((l) => l.message.includes('Mock run started'))).toBe(true);
    expect(state?.logs.some((l) => l.message.includes('Running'))).toBe(true);
  });

  it('clears only the console display baseline and preserves event history', () => {
    const stream = mockEventStream(ranapWorkflow, { runId: 'ui-clear-console' });
    useRunStore.getState().loadDefinition(ranapWorkflow, 'preview');
    for (const e of stream.slice(0, 6)) useRunStore.getState().pushEvent(e);

    const beforeClear = useRunStore.getState();
    const lastSeqBeforeClear = beforeClear.state!.lastSeq;
    expect(beforeClear.state!.logs.length).toBeGreaterThan(0);

    useRunStore.getState().clearConsole();
    expect(useRunStore.getState().consoleClearedThroughSeq).toBe(lastSeqBeforeClear);
    expect(useRunStore.getState().events).toHaveLength(6);
    expect(useRunStore.getState().state!.logs.length).toBe(beforeClear.state!.logs.length);

    useRunStore.getState().pushEvent(stream[6]!);
    const afterClear = useRunStore.getState();
    const visibleMessages = afterClear.state!.logs
      .filter((l) => l.seq > afterClear.consoleClearedThroughSeq)
      .map((l) => l.message);
    expect(visibleMessages).toEqual([stream[6]!.message]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/ui/src/runStore.test.ts`

Expected: FAIL because `clearConsole` and `consoleClearedThroughSeq` do not exist.

- [ ] **Step 3: Implement store baseline**

Update `RunStoreState` in `apps/ui/src/store/runStore.ts` to include:

```ts
  /** Highest event seq hidden from the run console by the display-only clear action. */
  consoleClearedThroughSeq: number;
  /** Hide already-rendered console log rows without mutating events or reducer state. */
  clearConsole: () => void;
```

Update the initial state and all run-loading resets:

```ts
  events: [],
  cursor: 0,
  playback: 'idle',
  consoleClearedThroughSeq: 0,
```

Set `consoleClearedThroughSeq: 0` in `loadDefinition`, `loadReplay`, and `reset`.

Add the action near the other store actions:

```ts
  clearConsole: () => set({ consoleClearedThroughSeq: get().state?.lastSeq ?? 0 }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/ui/src/runStore.test.ts`

Expected: PASS.

---

### Task 2: Run Console clear/autoscroll UI

**Files:**
- Modify: `apps/ui/src/features/panels/RunConsole.tsx`
- Modify: `apps/ui/src/styles/theme.css`

**Interfaces:**
- Consumes: `useRunStore((s) => s.consoleClearedThroughSeq)`
- Consumes: `useRunStore((s) => s.clearConsole)`
- Produces: a Clear log button that hides only log rows with `seq <= consoleClearedThroughSeq`

- [ ] **Step 1: Implement RunConsole behavior**

Replace `apps/ui/src/features/panels/RunConsole.tsx` with:

```tsx
/**
 * RunConsole — the run-wide log stream and a compact metric summary. Reads
 * the projected RunState logs from the store.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useRunStore } from '../../store/runStore.js';

export interface RunConsoleProps {
  onHide?: () => void;
}

export function RunConsole({ onHide }: RunConsoleProps) {
  const state = useRunStore((s) => s.state);
  const consoleClearedThroughSeq = useRunStore((s) => s.consoleClearedThroughSeq);
  const clearConsole = useRunStore((s) => s.clearConsole);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const logs = state?.logs ?? [];
  const visibleLogs = useMemo(
    () => logs.filter((l) => l.seq > consoleClearedThroughSeq),
    [logs, consoleClearedThroughSeq],
  );

  const counts = state
    ? Object.values(state.nodes).reduce<Record<string, number>>((acc, n) => {
        acc[n.status] = (acc[n.status] ?? 0) + 1;
        return acc;
      }, {})
    : {};

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [visibleLogs.length, state?.status]);

  return (
    <div className="panel run-console-panel">
      <div className="panel-head panel-head-actions">
        <span>Run Console {state ? `— ${state.status}` : ''}</span>
        <span className="panel-actions">
          <button className="btn compact" onClick={clearConsole} disabled={visibleLogs.length === 0}>
            Clear log
          </button>
          {onHide ? (
            <button className="btn compact" onClick={onHide}>
              Hide
            </button>
          ) : null}
        </span>
      </div>
      <div className="panel-body console-body">
        <div className="console-summary">
          {Object.entries(counts).map(([status, n]) => (
            <span className="badge" key={status}>
              {status}: {n}
            </span>
          ))}
          <span className="badge">logs: {visibleLogs.length}</span>
        </div>
        <div className="log-box run-log-box" aria-live="polite">
          {visibleLogs.length === 0 ? (
            <div className="empty">No logs to show. Start a run or wait for the next event.</div>
          ) : (
            visibleLogs.map((l) => (
              <div className={`log-line log-${l.severity}`} key={l.seq}>
                [{l.ts.slice(11, 19)}] {l.nodeId ? `${l.nodeId}: ` : ''}
                {l.message}
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add console styles**

Add these rules after the existing `.panel-head` / `.panel-body` block in `apps/ui/src/styles/theme.css`:

```css
.panel-head-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.panel-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

button.btn.compact {
  min-height: 28px;
  padding: 4px 8px;
  font-size: 11px;
}

.console-body {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.console-summary {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: var(--space-2);
}

.run-log-box {
  flex: 1;
  border: 1px solid rgba(71, 192, 255, 0.16);
  border-radius: var(--radius-md);
  scroll-behavior: smooth;
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

---

### Task 3: Hideable Inspector and Run Console panels

**Files:**
- Modify: `apps/ui/src/app/App.tsx`
- Modify: `apps/ui/src/features/panels/NodeInspector.tsx`
- Modify: `apps/ui/src/styles/theme.css`

**Interfaces:**
- Produces: `NodeInspectorProps.onHide?: () => void`
- Produces: App-local `showInspector` and `showRunConsole` state
- Consumes: `RunConsoleProps.onHide?: () => void` from Task 2

- [ ] **Step 1: Add hide button to NodeInspector**

Update `NodeInspectorProps` in `apps/ui/src/features/panels/NodeInspector.tsx`:

```ts
export interface NodeInspectorProps {
  onApproveGate?: (nodeId: string) => void;
  onRejectGate?: (nodeId: string) => void;
  onHide?: () => void;
}
```

Change the component signature:

```ts
export function NodeInspector({ onApproveGate, onRejectGate, onHide }: NodeInspectorProps) {
```

Replace both panel headers with action headers.

For the empty selection branch:

```tsx
        <div className="panel-head panel-head-actions">
          <span>Inspector</span>
          {onHide ? (
            <button className="btn compact" onClick={onHide}>
              Hide
            </button>
          ) : null}
        </div>
```

For the selected node branch:

```tsx
      <div className="panel-head panel-head-actions">
        <span>Inspector — {def?.label}</span>
        {onHide ? (
          <button className="btn compact" onClick={onHide}>
            Hide
          </button>
        ) : null}
      </div>
```

- [ ] **Step 2: Add App panel visibility state and toggles**

In `apps/ui/src/app/App.tsx`, add local state after the existing `runId` state:

```ts
  const [showInspector, setShowInspector] = useState(true);
  const [showRunConsole, setShowRunConsole] = useState(true);
```

Replace the side panel block:

```tsx
        <div className="side">
          <NodeInspector onApproveGate={onApproveGate} onRejectGate={onRejectGate} />
          <RunConsole />
        </div>
```

with:

```tsx
        <div
          className={`side ${!showInspector ? 'hide-inspector' : ''} ${!showRunConsole ? 'hide-console' : ''}`}
        >
          <div className="panel-toggle-row">
            {!showInspector ? (
              <button className="btn compact" onClick={() => setShowInspector(true)}>
                Show Inspector
              </button>
            ) : null}
            {!showRunConsole ? (
              <button className="btn compact" onClick={() => setShowRunConsole(true)}>
                Show Run Console
              </button>
            ) : null}
          </div>
          {showInspector ? (
            <NodeInspector
              onApproveGate={onApproveGate}
              onRejectGate={onRejectGate}
              onHide={() => setShowInspector(false)}
            />
          ) : null}
          {showRunConsole ? <RunConsole onHide={() => setShowRunConsole(false)} /> : null}
        </div>
```

- [ ] **Step 3: Add responsive side-panel styles**

In `apps/ui/src/styles/theme.css`, replace the current `.side` rule with:

```css
.side {
  min-width: 0;
  min-height: 0;
  border-left: 1px solid var(--border);
  background: var(--bg-1);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) minmax(160px, 0.75fr);
  overflow: hidden;
}

.side.hide-inspector {
  grid-template-rows: auto minmax(160px, 1fr);
}

.side.hide-console {
  grid-template-rows: auto minmax(0, 1fr);
}

.side.hide-inspector.hide-console {
  grid-template-rows: auto;
  align-content: start;
}

.panel-toggle-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: var(--space-2);
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
}

.panel-toggle-row:empty {
  display: none;
}
```

Update the `@media (max-width: 1024px)` `.side` rule to include the toggle row:

```css
  .side {
    border-left: 0;
    border-top: 1px solid var(--border);
    grid-template-columns: minmax(0, 1fr) minmax(260px, 0.9fr);
    grid-template-rows: auto minmax(0, 1fr);
  }

  .side .panel-toggle-row {
    grid-column: 1 / -1;
  }
```

Update the `@media (max-width: 720px)` `.side` rule:

```css
  .side {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(180px, 1fr) minmax(160px, 0.9fr);
  }
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

---

### Task 4: Verification pass

**Files:**
- Verify: `apps/ui/src/runStore.test.ts`
- Verify: `apps/ui/src/features/panels/RunConsole.tsx`
- Verify: `apps/ui/src/features/panels/NodeInspector.tsx`
- Verify: `apps/ui/src/app/App.tsx`
- Verify: `apps/ui/src/styles/theme.css`

**Interfaces:**
- Consumes: all changes from Tasks 1-3
- Produces: test/typecheck result summary for the user

- [ ] **Step 1: Run focused UI store tests**

Run: `npx vitest run apps/ui/src/runStore.test.ts`

Expected: PASS, including log projection and display-only clear tests.

- [ ] **Step 2: Run UI-related tests**

Run: `npx vitest run apps/ui/src/runStore.test.ts apps/ui/src/runInputForm.test.ts apps/ui/src/apiClient.test.ts`

Expected: PASS.

- [ ] **Step 3: Run project typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run: `git diff -- apps/ui/src/store/runStore.ts apps/ui/src/runStore.test.ts apps/ui/src/features/panels/RunConsole.tsx apps/ui/src/features/panels/NodeInspector.tsx apps/ui/src/app/App.tsx apps/ui/src/styles/theme.css`

Expected: diff contains only UI/store/test changes for console clear, scroll/autoscroll, and hideable panels.

---

## Self-Review

- Spec coverage: plan covers legacy-like live log stream visibility, scroll/autoscroll, clear log button, run console/log verification, and hideable Inspector/Run Console panels.
- Placeholder scan: no TBD/TODO/fill-in-later language remains; code snippets include exact replacements or additions.
- Type consistency: `consoleClearedThroughSeq`, `clearConsole`, `onHide`, `showInspector`, and `showRunConsole` names are consistent across tasks.
