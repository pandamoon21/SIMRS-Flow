/**
 * Pure rectangle math for floating-panel resize handles.
 *
 * A panel is described by its top-left origin plus size. Resizing from the
 * east/south edges only changes the size; the west/north handles have to move
 * the origin so the opposite edge stays visually fixed — the operator grabbing
 * the bottom-left corner expects the right edge to stay put, not to slide.
 *
 * Deltas arrive in CSS px (the caller divides pointer deltas by the root
 * fit-zoom first). `min` is the panel's smallest allowed size; on a w/n side the
 * clamp must also stop the origin from running past the fixed opposite edge.
 */

/** Which handles a floating panel exposes. */
export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface ResizeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ResizeMin {
  readonly width: number;
  readonly height: number;
}

export const RESIZE_DIRS: readonly ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** CSS `cursor` each handle shows. */
export const RESIZE_CURSOR: Readonly<Record<ResizeDir, string>> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};


/**
 * Apply a resize of `dir` by (`dx`, `dy`) CSS px to `rect`.
 *
 * Invariants:
 * - east/south edges move by the pointer delta; north/west edges move by the
 *   negated delta.
 * - the edge *opposite* an active handle never moves.
 * - width/height never drop below `min`; when a north/west handle would push
 *   past `min`, the origin stops so the opposite edge stays where it was.
 */
export function resizeRect(rect: ResizeRect, dir: ResizeDir, dx: number, dy: number, min: ResizeMin): ResizeRect {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  let { x, y, width, height } = rect;
  const minW = Math.max(1, min.width);
  const minH = Math.max(1, min.height);
  const right = x + width;
  const bottom = y + height;

  if (dir.includes('w')) {
    width = Math.max(minW, width - dx);
    x = right - width;
  } else if (dir.includes('e')) {
    width = Math.max(minW, width + dx);
  }

  if (dir.includes('n')) {
    height = Math.max(minH, height - dy);
    y = bottom - height;
  } else if (dir.includes('s')) {
    height = Math.max(minH, height + dy);
  }

  return { x, y, width, height };
}

/**
 * Resize a panel and keep it inside `bounds` without moving the edge the
 * operator is not dragging. Shrinking against the top/left bound trims that
 * edge; growing past the right/bottom bound is capped at the bound. The fixed
 * edge stays fixed in every case.
 */
export function resizeRectWithin(
  rect: ResizeRect,
  dir: ResizeDir,
  dx: number,
  dy: number,
  min: ResizeMin,
  bounds: ResizeRect,
): ResizeRect {
  // Integer bounds: a rect already flush with an edge must read as exactly flush,
  // not a fraction over, or `resizeRect`'s newer size is then clamped back to the
  // old one and the drag looks dead.
  const bLeft = Math.floor(bounds.x);
  const bTop = Math.floor(bounds.y);
  const bRight = Math.ceil(bounds.x + bounds.width);
  const bBottom = Math.ceil(bounds.y + bounds.height);
  const minW = Math.max(1, min.width);
  const minH = Math.max(1, min.height);
  const base = resizeRect(rect, dir, dx, dy, min);
  let { x, y, width, height } = base;

  // East/south growth stops at the bound but never shrinks below the current size
  // (a box already flush with the edge keeps its size when pulled outward).
  // Within a bound slack the handle tracks the pointer 1:1; at the bound it stops.
  if (dir.includes('e') && x + width > bRight) width = Math.max(minW, Math.min(width, bRight - x));
  // West growth stops at the left bound; the right edge stays fixed.
  if (dir.includes('w') && x < bLeft) { width = Math.max(minW, x + width - bLeft); x = bLeft; }

  if (dir.includes('s') && y + height > bBottom) height = Math.max(minH, Math.min(height, bBottom - y));
  if (dir.includes('n') && y < bTop) { height = Math.max(minH, y + height - bTop); y = bTop; }

  return { x, y, width, height };
}
