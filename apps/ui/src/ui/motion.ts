/**
 * Native motion helpers — no animation library. CSS owns most motion (tokens in
 * theme.css); these cover the few cases CSS cannot: honouring reduced motion in
 * JS-driven moves, View Transitions around React state swaps, and a one-shot
 * status pulse.
 */
import { flushSync } from 'react-dom';

export function reducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'off') return true;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Animation setting, per PC: `full` everything, `lite` drops the decorative
 * loops that keep running during a run (skyline, run track, breathing dots),
 * `off` no motion at all, `auto` picks `lite` on a weak device or when frames
 * keep dropping. Status colours, lines and progress never depend on it.
 */
export type MotionSetting = 'auto' | 'full' | 'lite' | 'off';
export type MotionMode = Exclude<MotionSetting, 'auto'>;
export const MOTION_KEY = 'simrs-flow.motion';

export function readMotionSetting(): MotionSetting {
  try {
    const v = localStorage.getItem(MOTION_KEY);
    return v === 'full' || v === 'lite' || v === 'off' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** A weak office PC: 4 GB or less, or 4 logical cores or fewer (when the browser says). */
export function isWeakDevice(nav: { deviceMemory?: number; hardwareConcurrency?: number } | undefined): boolean {
  if (!nav) return false;
  return (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) || (nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency <= 4);
}

export function resolveMotion(setting: MotionSetting, weak: boolean, droppingFrames = false): MotionMode {
  if (setting !== 'auto') return setting;
  return weak || droppingFrames ? 'lite' : 'full';
}

let framesDropping = false;

export function applyMotion(setting: MotionSetting = readMotionSetting()): MotionMode {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as { deviceMemory?: number; hardwareConcurrency?: number });
  const mode = resolveMotion(setting, isWeakDevice(nav), framesDropping);
  if (typeof document !== 'undefined') document.documentElement.dataset.motion = mode;
  return mode;
}

export function saveMotionSetting(setting: MotionSetting): MotionMode {
  try { localStorage.setItem(MOTION_KEY, setting); } catch { /* per-PC preference only */ }
  return applyMotion(setting);
}

/**
 * `auto` on a device that looked capable: sample 5 s of frames once a minute and
 * step down to `lite` for this session when over a quarter of them took > 50 ms.
 * ponytail: session-only; persist it if operators keep landing on the same PC.
 */
export function watchFrameDrops(): void {
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') return;
  const sample = () => {
    if (framesDropping || readMotionSetting() !== 'auto' || document.visibilityState === 'hidden') return;
    let last = performance.now();
    let frames = 0;
    let slow = 0;
    const end = last + 5000;
    const tick = (t: number) => {
      if (t - last > 50) slow += 1;
      frames += 1;
      last = t;
      if (t < end) requestAnimationFrame(tick);
      else if (frames > 20 && slow / frames > 0.25) { framesDropping = true; applyMotion(); }
    };
    requestAnimationFrame(tick);
  };
  window.setInterval(sample, 60_000);
}

/** Duration for JS-driven moves (React Flow camera, scroll) that CSS media queries cannot reach. */
export function motionMs(ms: number): number {
  return reducedMotion() ? 0 : ms;
}

/** Cross-fades a React state swap; falls back to a plain update when unsupported or reduced. */
export function withViewTransition(update: () => void): void {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function' || reducedMotion()) {
    update();
    return;
  }
  document.startViewTransition(() => flushSync(update));
}

export type PulseTone = 'success' | 'danger' | 'warning' | 'accent';

/** One-shot ring that marks a status change without moving layout. */
export function pulse(element: Element | null | undefined, tone: PulseTone): void {
  if (!element || typeof (element as HTMLElement).animate !== 'function' || reducedMotion()) return;
  const color = `var(--${tone})`;
  (element as HTMLElement).animate(
    [
      { boxShadow: `0 0 0 0 color-mix(in srgb, ${color} 55%, transparent)` },
      { boxShadow: `0 0 0 10px color-mix(in srgb, ${color} 0%, transparent)` },
    ],
    { duration: 420, easing: 'cubic-bezier(.16, 1, .3, 1)' },
  );
}
