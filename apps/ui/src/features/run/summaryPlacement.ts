/**
 * Placement and clamping for the post-run summary (Ringkasan).
 *
 * The summary is absolutely positioned inside `.canvas-wrap`, which is
 * `position: absolute; inset: 0` inside the live workspace. Its own size is
 * therefore its containing block, and every coordinate here is expressed in
 * canvas-wrap CSS px — never in the panel viewport that measures
 * `.run-split` plus the command-bar offset (that applied the offset twice and
 * pushed the bottom handles below the visible canvas).
 */

export interface SummaryRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The containing block's own box, in its own CSS px. */
export interface SummaryBox {
  readonly width: number;
  readonly height: number;
}

export interface SummaryMin {
  readonly width: number;
  readonly height: number;
}

export const SUMMARY_MIN_SIZE: SummaryMin = { width: 320, height: 180 };
/** Gap between the summary and the canvas edges. */
export const SUMMARY_EDGE_GAP = 8;
/**
 * Room kept free below the summary when there is no replay bar to measure. `main`
 * placed the summary with `bottom: 64px`, so that is the fallback reserve.
 */
export const SUMMARY_BOTTOM_RESERVE = 64;
/** Height the summary occupies before its content has been measured. */
export const SUMMARY_DEFAULT_HEIGHT = 104;

/**
 * Vertical room the summary must leave at the bottom of the canvas: the replay
 * bar's own height (measured, never hard-coded) plus the usual gap, or the
 * `main` fallback when the bar is not on screen.
 */
export function summaryBottomReserve(replayBarHeight: number | undefined): number {
  const h = Number.isFinite(replayBarHeight) && (replayBarHeight as number) > 0 ? (replayBarHeight as number) : 0;
  return h > 0 ? Math.ceil(h) + SUMMARY_EDGE_GAP : SUMMARY_BOTTOM_RESERVE;
}

/**
 * Default placement: bottom-centre of the canvas, sized to its content, with
 * every edge (and so every resize handle) inside the canvas.
 */
export function placeSummary(
  box: SummaryBox,
  contentHeight: number,
  min: SummaryMin = SUMMARY_MIN_SIZE,
  bottomReserve: number = SUMMARY_BOTTOM_RESERVE,
): SummaryRect {
  const reserve = Math.max(0, Number.isFinite(bottomReserve) ? bottomReserve : SUMMARY_BOTTOM_RESERVE);
  const width = Math.min(560, Math.max(min.width, box.width - 24));
  const height = Math.min(
    Math.max(min.height, Math.ceil(Number.isFinite(contentHeight) ? contentHeight : SUMMARY_DEFAULT_HEIGHT)),
    Math.max(min.height, box.height - reserve - SUMMARY_EDGE_GAP),
  );
  return {
    x: Math.max(0, Math.round((box.width - width) / 2)),
    y: Math.max(0, box.height - reserve - height),
    width,
    height,
  };
}

/**
 * Keep a (saved or resized) rect inside the canvas: size first, then position,
 * so an overflowing box slides in rather than losing an edge. Never returns a
 * rect larger than the box or with a handle outside it.
 */
export function clampSummaryRect(
  rect: SummaryRect,
  box: SummaryBox,
  min: SummaryMin = SUMMARY_MIN_SIZE,
  bottomReserve: number = 0,
): SummaryRect {
  const reserve = Math.max(0, Number.isFinite(bottomReserve) ? bottomReserve : 0);
  const usableHeight = Math.max(1, box.height - reserve);
  const width = Math.min(box.width, Math.max(Math.min(min.width, box.width), rect.width));
  const height = Math.min(usableHeight, Math.max(Math.min(min.height, usableHeight), rect.height));
  const x = Math.min(Math.max(0, box.width - width), Math.max(0, rect.x));
  const y = Math.min(Math.max(0, usableHeight - height), Math.max(0, rect.y));
  return { x, y, width, height };
}

/** The resize bounds for the summary: the canvas minus any bottom reserve. */
export function summaryResizeBounds(box: SummaryBox, bottomReserve: number) {
  const reserve = Math.max(0, Number.isFinite(bottomReserve) ? bottomReserve : 0);
  return { x: 0, y: 0, width: box.width, height: Math.max(1, box.height - reserve) };
}
