/**
 * Run status in the Run command bar, in two parts:
 * - RunSpinner, beside the run id: one of a few small CSS spinners, picked anew
 *   for every run, that settles into a status mark (✓ ✕ ❚❚ ■) when it stops.
 * - RunTrack, in the bar's free space between the run id and the badges: a
 *   faint line-art traveller (cat, car, ambulance or cyclist, also picked per
 *   run) moving from the start flag to the finish flag by the share of steps
 *   that have finished. It only animates while the run is running.
 * Motion is transform/opacity only on small elements, so it stays on the
 * compositor on office PCs.
 */

import type { CSSProperties } from 'react';
import type { RunState } from '@simrs-flow/workflow-core';

export type GlyphState = 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'stopped';

export function glyphStateOf(runId: string | undefined, status: RunState['status'] | undefined): GlyphState {
  if (!runId) return 'idle';
  switch (status) {
    // `created` is also a freshly (re)loaded definition with the last run id still set;
    // only a run that has started moves.
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'stopped';
    default:
      return 'idle';
  }
}

const TERMINAL_STEP = new Set(['success', 'failed', 'skipped', 'blocked', 'needs_review']);

/** Share of steps that have finished, 0..1; a completed run is always at the finish. */
export function trackProgressOf(state: Pick<RunState, 'status' | 'nodes'> | undefined): number {
  if (!state) return 0;
  if (state.status === 'completed') return 1;
  const nodes = Object.values(state.nodes);
  if (nodes.length === 0) return 0;
  return nodes.filter((node) => TERMINAL_STEP.has(node.status)).length / nodes.length;
}

export const SPINNERS = ['ring', 'dots', 'bars', 'orbit', 'square', 'pulse'] as const;
export const TRAVELLERS = ['cat', 'car', 'ambulance', 'cyclist'] as const;
export type SpinnerKind = (typeof SPINNERS)[number];
export type Traveller = (typeof TRAVELLERS)[number];

/** Seed in [0, 1) → a spinner and a traveller; independent enough that the pair varies too. */
export function variantOf(seed: number): { spinner: SpinnerKind; traveller: Traveller } {
  const n = Math.floor(Math.abs(seed) * 1_000_000);
  return { spinner: SPINNERS[n % SPINNERS.length]!, traveller: TRAVELLERS[Math.floor(n / SPINNERS.length) % TRAVELLERS.length]! };
}

const MARK: Partial<Record<GlyphState, string>> = {
  done: 'M5 10.5l3.2 3.2L15 7',
  failed: 'M6.5 6.5l7 7M13.5 6.5l-7 7',
  paused: 'M8 6v8M12 6v8',
  stopped: 'M7 7h6v6H7z',
};

export function RunSpinner({ state, kind }: { state: GlyphState; kind: SpinnerKind }) {
  const mark = MARK[state];
  return (
    <span className={`run-spinner is-${state}`} data-kind={kind} aria-hidden="true">
      {state === 'running' ? (
        <span className="rs-anim">{kind === 'dots' || kind === 'bars' ? <><i /><i /><i /></> : <i />}</span>
      ) : (
        <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle className="rs-rim" cx="10" cy="10" r="8.4" />
          {mark ? <path d={mark} /> : <circle cx="10" cy="10" r="2" fill="currentColor" stroke="none" />}
        </svg>
      )}
    </span>
  );
}

/** Each traveller is drawn with its feet/wheels on y=0, centred on x=0, facing right. */
function TravellerArt({ kind }: { kind: Traveller }) {
  switch (kind) {
    case 'cat':
      return (
        <>
          <g className="rt-body">
            <path d="M-8 -9.5q-4.5-1.2-4.2-6.4" />
            <rect x="-8.5" y="-11" width="14" height="6" rx="3" className="rt-fill" />
            <circle cx="7.6" cy="-12.2" r="3.4" className="rt-fill" />
            <path d="M5.4 -14.6l.5-2.8 1.9 1.9M8.5 -15.3l1.3-2.4 1 2.6" />
            <circle className="rt-eye" cx="9" cy="-12.6" r=".55" />
          </g>
          <path className="rt-leg rt-leg-a" d="M-6 -5.4V0M3.4 -5.4V0" />
          <path className="rt-leg rt-leg-b" d="M-3.6 -5.4V0M5.6 -5.4V0" />
        </>
      );
    case 'car':
      return (
        <g className="rt-body">
          <path d="M-7 -7.5l3-4.6h8.2l3.4 4.6" className="rt-fill" />
          <rect x="-12" y="-7.6" width="24" height="5.4" rx="2" className="rt-fill" />
          <path d="M0 -12v4.4" />
          <circle className="rt-wheel" cx="-6.6" cy="-2.4" r="2.4" />
          <circle className="rt-wheel" cx="6.6" cy="-2.4" r="2.4" />
          {/* One path per wheel: a shared path rotates about the midpoint between the wheels. */}
          <path className="rt-spoke" d="M-6.6 -4.8v4.8M-9 -2.4h4.8" /><path className="rt-spoke" d="M6.6 -4.8v4.8M4.2 -2.4h4.8" />
        </g>
      );
    case 'ambulance':
      return (
        <g className="rt-body">
          <rect x="-13" y="-12" width="17" height="9.6" rx="1.2" className="rt-fill" />
          <path d="M4 -9.2h4.4l3.6 3.4v3.4H4z" className="rt-fill" />
          <path className="rt-cross" d="M-4.5 -10.2v5.4M-7.2 -7.5h5.4" />
          <circle className="rt-beacon" cx="-4.5" cy="-13.6" r="1.2" />
          <circle className="rt-wheel" cx="-8" cy="-2.4" r="2.4" />
          <circle className="rt-wheel" cx="7" cy="-2.4" r="2.4" />
          <path className="rt-spoke" d="M-8 -4.8v4.8M-10.4 -2.4h4.8" /><path className="rt-spoke" d="M7 -4.8v4.8M4.6 -2.4h4.8" />
        </g>
      );
    case 'cyclist':
      return (
        <g className="rt-body">
          <circle className="rt-wheel" cx="-6.5" cy="-3.6" r="3.6" />
          <circle className="rt-wheel" cx="6.5" cy="-3.6" r="3.6" />
          <path className="rt-spoke" d="M-6.5 -7.2v7.2M-10.1 -3.6h7.2" /><path className="rt-spoke" d="M6.5 -7.2v7.2M2.9 -3.6h7.2" />
          <path d="M-6.5 -3.6l3.8-6h7l2.2 6M-2.7 -9.6l-1-1.6h2.6M4.1 -9.6l.9-2.4h2" />
          <path d="M-1.6 -11.2l2.2-6.4 3 1.4" />
          <circle cx="1.6" cy="-19.6" r="1.9" className="rt-fill" />
          <path className="rt-leg rt-leg-a" d="M.2 -15l-2.2 5.4" />
        </g>
      );
  }
}

const RUNNER_W = 30;

export function RunTrack({ state, progress = 0, traveller }: { state: GlyphState; progress?: number; traveller: Traveller }) {
  const p = Math.max(0, Math.min(1, progress));
  return (
    <span className={`run-track is-${state}`} data-traveller={traveller} aria-hidden="true" style={{ '--p': p, '--rw': `${RUNNER_W}px` } as CSSProperties}>
      <span className="rt-ground" />
      <svg className="rt-flag rt-flag-start" viewBox="0 0 10 22" width="10" height="22" fill="none" strokeLinecap="round">
        <path d="M1.5 22V2" /><path className="rt-flag-cloth" d="M1.5 2.5l7 2.6-7 2.6z" />
      </svg>
      <svg className="rt-flag rt-flag-finish" viewBox="0 0 10 22" width="10" height="22" fill="none" strokeLinecap="round">
        <path d="M1.5 22V2" /><rect className="rt-flag-cloth" x="1.5" y="2.5" width="7.5" height="5.6" /><path d="M1.5 5.3h7.5M5.25 2.5v5.6" />
      </svg>
      {/* The lane spans the track; translateX(p·100%) of the lane minus p·runner width keeps the runner inside it. */}
      <span className="rt-lane">
        <svg className="rt-runner" viewBox={`${-RUNNER_W / 2} -22 ${RUNNER_W} 23`} width={RUNNER_W} height="23" fill="none" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <TravellerArt kind={traveller} />
        </svg>
      </span>
    </span>
  );
}
