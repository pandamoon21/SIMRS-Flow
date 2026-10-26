/**
 * UI run store.
 *
 * Holds the projected RunState and drives it purely from WorkflowEvents — the
 * same reducer the engine uses. This guarantees the UI is a faithful
 * projection of the event stream, whether events arrive live over SSE or are
 * replayed from a recorded JSONL log.
 */

import { create } from 'zustand';
import {
  initialRunState,
  applyEvent,
  type ExecutionMode,
  type RunState,
  type WorkflowDefinition,
  type WorkflowEvent,
} from '@simrs-flow/workflow-core';

export type PlaybackMode = 'idle' | 'live' | 'replay';

interface RunStoreState {
  definition?: WorkflowDefinition;
  state?: RunState;
  /** Full event log for the current run (for replay + inspector). */
  events: WorkflowEvent[];
  /** Index up to which events have been applied (replay scrubbing). */
  cursor: number;
  /** Highest event seq hidden from the run console by the display-only clear action. */
  consoleClearedThroughSeq: number;
  playback: PlaybackMode;
  selectedNodeId?: string;

  /** Load a definition and reset state to pristine. */
  loadDefinition: (def: WorkflowDefinition, mode: ExecutionMode) => void;
  /** Append a live event and apply it immediately. */
  pushEvent: (event: WorkflowEvent) => void;
  /** Append several live events with one store update (one render), in order. */
  pushEvents: (events: readonly WorkflowEvent[]) => void;
  /** Load a recorded event log for replay (does not apply yet). */
  loadReplay: (def: WorkflowDefinition, events: WorkflowEvent[], mode: ExecutionMode) => void;
  /** Advance/seek the replay cursor and re-project state. */
  seek: (cursor: number) => void;
  /** End a fixture replay at the current cursor with a synthetic run.cancelled. */
  cancelReplay: () => void;
  /** The orchestrator no longer knows this run (restart, in-memory ledger): end it with a synthetic run.failed. */
  markRunLost: (message: string) => void;
  /** Step one event forward in replay. */
  stepForward: () => void;
  /** Hide already-rendered console log rows without mutating events or reducer state. */
  clearConsole: () => void;
  setPlayback: (mode: PlaybackMode) => void;
  selectNode: (nodeId?: string) => void;
  reset: () => void;
}

function project(def: WorkflowDefinition, runId: string, mode: ExecutionMode, events: WorkflowEvent[], upTo: number): RunState {
  let s = initialRunState(def, runId, mode);
  for (let i = 0; i < upTo && i < events.length; i++) {
    s = applyEvent(s, events[i]!);
  }
  return s;
}

export const useRunStore = create<RunStoreState>((set, get) => ({
  events: [],
  cursor: 0,
  consoleClearedThroughSeq: 0,
  playback: 'idle',

  loadDefinition: (def, mode) => {
    set({
      definition: def,
      state: initialRunState(def, 'pending', mode),
      events: [],
      cursor: 0,
      consoleClearedThroughSeq: 0,
      playback: 'live',
      selectedNodeId: undefined,
    });
  },

  pushEvent: (event) => get().pushEvents([event]),

  pushEvents: (batch) => {
    const { definition, state, events } = get();
    if (!definition || batch.length === 0) return;
    let next = state ?? initialRunState(definition, batch[0]!.runId, 'preview');
    for (const event of batch) next = applyEvent(next, event);
    const all = events.concat(batch);
    set({ state: next, events: all, cursor: all.length });
  },

  loadReplay: (def, events, mode) => {
    set({
      definition: def,
      events,
      cursor: 0,
      consoleClearedThroughSeq: 0,
      playback: 'replay',
      state: project(def, events[0]?.runId ?? 'replay', mode, events, 0),
      selectedNodeId: undefined,
    });
  },

  seek: (cursor) => {
    const { definition, events } = get();
    if (!definition) return;
    const clamped = Math.max(0, Math.min(cursor, events.length));
    set({
      cursor: clamped,
      state: project(definition, events[0]?.runId ?? 'replay', get().state?.mode ?? 'preview', events, clamped),
    });
  },

  markRunLost: (message) => {
    const { definition, events, state } = get();
    const last = events.at(-1);
    if (!definition || !last || !state || ['completed', 'failed', 'cancelled'].includes(state.status)) return;
    const lost: WorkflowEvent = {
      schema: last.schema,
      eventId: `${last.eventId}-lost`,
      seq: last.seq + 1,
      ts: new Date().toISOString(),
      runId: last.runId,
      workflowId: last.workflowId,
      workflowVersion: last.workflowVersion,
      type: 'run.failed',
      source: last.source,
      message,
    };
    set({ state: applyEvent(state, lost), events: [...events, lost], cursor: events.length + 1 });
  },

  cancelReplay: () => {
    const { definition, events, cursor, state } = get();
    const kept = events.slice(0, cursor);
    const last = kept.at(-1);
    if (!definition || !last) return;
    // A fixture replay has no server run to cancel, so the projection would sit
    // in "running" forever; end it the way a live stream does, with run.cancelled.
    const cancelled: WorkflowEvent = {
      schema: last.schema,
      eventId: `${last.eventId}-cancel`,
      seq: last.seq + 1,
      // Fixture timestamps are synthetic; stay on their clock so durations stay sane.
      ts: new Date(Date.parse(last.ts) + 1).toISOString(),
      runId: last.runId,
      workflowId: last.workflowId,
      workflowVersion: last.workflowVersion,
      type: 'run.cancelled',
      source: last.source,
      message: 'Dihentikan operator',
    };
    const next = [...kept, cancelled];
    set({ events: next, cursor: next.length, state: project(definition, last.runId, state?.mode ?? 'preview', next, next.length) });
  },

  stepForward: () => {
    const { cursor, events } = get();
    if (cursor < events.length) get().seek(cursor + 1);
  },

  clearConsole: () => set({ consoleClearedThroughSeq: get().state?.lastSeq ?? 0 }),
  setPlayback: (mode) => set({ playback: mode }),
  selectNode: (nodeId) => set({ selectedNodeId: nodeId }),
  reset: () =>
    set({
      definition: undefined,
      state: undefined,
      events: [],
      cursor: 0,
      consoleClearedThroughSeq: 0,
      playback: 'idle',
      selectedNodeId: undefined,
    }),
}));
