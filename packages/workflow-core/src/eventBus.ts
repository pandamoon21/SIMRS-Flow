/**
 * Event bus — the single channel through which the runner communicates.
 *
 * The bus stamps the envelope fields (schema, eventId, seq, ts) so callers
 * only provide the meaningful payload. Subscribers receive fully-formed
 * events. Nothing here knows about React or HTTP.
 */

import { EVENT_SCHEMA, type WorkflowEvent, type WorkflowEventInput } from './types.js';
import { type Clock, type IdFactory, systemClock, counterIdFactory } from './ids.js';

export type EventListener = (event: WorkflowEvent) => void;

export interface EventBusOptions {
  clock?: Clock;
  idFactory?: IdFactory;
}

export class EventBus {
  private listeners = new Set<EventListener>();
  private seq = 0;
  private readonly clock: Clock;
  private readonly idFactory: IdFactory;
  private readonly history: WorkflowEvent[] = [];

  constructor(options: EventBusOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.idFactory = options.idFactory ?? counterIdFactory('evt');
  }

  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit an event, filling in envelope fields. Returns the full event. */
  emit(input: WorkflowEventInput): WorkflowEvent {
    const event: WorkflowEvent = {
      schema: EVENT_SCHEMA,
      eventId: this.idFactory(),
      seq: ++this.seq,
      ts: this.clock.now().toISOString(),
      ...input,
    };
    this.history.push(event);
    for (const listener of this.listeners) {
      // Listeners must not throw; isolate failures so one bad subscriber
      // cannot break the run or other subscribers.
      try {
        listener(event);
      } catch {
        // Intentionally swallowed — a logging subscriber failing must not
        // abort execution. Use a dedicated error sink if you need visibility.
      }
    }
    return event;
  }

  /** All events emitted so far, in order. */
  getHistory(): readonly WorkflowEvent[] {
    return this.history;
  }

  /** Current sequence counter. */
  get lastSeq(): number {
    return this.seq;
  }
}
