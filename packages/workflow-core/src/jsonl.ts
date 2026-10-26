/**
 * JSONL serialization for events — the replay backbone.
 *
 * An event stream serialized to JSON Lines can be stored, shipped over SSE,
 * and later replayed through the reducer to reconstruct identical RunState.
 * This is what makes "replay produces the same visual state" testable.
 */

import { reduceEvents } from './reducer.js';
import type { ExecutionMode, RunState, WorkflowDefinition, WorkflowEvent } from './types.js';

/** Serialize events to a JSONL string (one event per line). */
export function eventsToJsonl(events: readonly WorkflowEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

/** Parse a JSONL string back into events, skipping blank lines. */
export function jsonlToEvents(jsonl: string): WorkflowEvent[] {
  return jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WorkflowEvent);
}

/** Replay a JSONL event log into a final RunState. */
export function replayJsonl(
  definition: WorkflowDefinition,
  jsonl: string,
  options: { runId?: string; mode?: ExecutionMode } = {},
): RunState {
  const events = jsonlToEvents(jsonl);
  const runId = options.runId ?? events[0]?.runId ?? 'replay';
  const mode = options.mode ?? 'preview';
  return reduceEvents(definition, runId, mode, events);
}
