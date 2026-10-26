/**
 * Deterministic-friendly id and time helpers.
 *
 * The runner injects a clock and id factory so runs can be made
 * reproducible in tests (and so replay stays stable).
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A fixed clock for tests; advances by `stepMs` on each call. */
export function fixedClock(startIso = '2026-01-01T00:00:00.000Z', stepMs = 1000): Clock {
  let t = new Date(startIso).getTime();
  return {
    now() {
      const d = new Date(t);
      t += stepMs;
      return d;
    },
  };
}

export type IdFactory = () => string;

/** Counter-based id factory — stable and dependency-free. */
export function counterIdFactory(prefix = 'evt'): IdFactory {
  let n = 0;
  return () => `${prefix}_${(++n).toString(36).padStart(6, '0')}`;
}

/**
 * Best-effort unique id for runtime use (not for replay determinism).
 * Avoids Math.random by combining time and a process counter.
 */
let runCounter = 0;
export function generateRunId(clock: Clock = systemClock): string {
  const ts = clock.now().getTime().toString(36);
  const c = (++runCounter).toString(36).padStart(4, '0');
  return `run_${ts}_${c}`;
}
