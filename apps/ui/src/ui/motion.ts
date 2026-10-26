/**
 * Native motion helpers — no animation library. CSS owns most motion (tokens in
 * theme.css); these cover the few cases CSS cannot: honouring reduced motion in
 * JS-driven moves, View Transitions around React state swaps, and a one-shot
 * status pulse.
 */
import { flushSync } from 'react-dom';

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
