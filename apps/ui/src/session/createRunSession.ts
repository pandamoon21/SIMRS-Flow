/**
 * The app's run session, wired to the real orchestrator client, the run store
 * and the lazily loaded fixtures. Tests build {@link RunSession} with fakes.
 */

import { api } from '../api/client.js';
import { useRunStore } from '../store/runStore.js';
import { replayStream, sampleInput } from './fixtureReplay.js';
import { RunSession, type RunProjection, type RunSessionHooks } from './runSession.js';

/** The run store seen through the operations a session drives. */
export function runStoreProjection(store = useRunStore): RunProjection {
  const s = () => store.getState();
  return {
    loadDefinition: (def, mode) => s().loadDefinition(def, mode),
    loadReplay: (def, events, mode) => s().loadReplay(def, events, mode),
    pushEvents: (events) => s().pushEvents(events),
    seek: (cursor) => s().seek(cursor),
    cancelReplay: () => s().cancelReplay(),
    markRunLost: (message) => s().markRunLost(message),
    cursor: () => s().cursor,
    eventCount: () => s().events.length,
  };
}

export function createRunSession(hooks: RunSessionHooks): RunSession {
  return new RunSession({ api, store: runStoreProjection(), fixtures: { sampleInput, replayStream }, hooks });
}
