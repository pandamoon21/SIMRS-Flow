import { describe, expect, it } from 'vitest';
import { RESIZE_CURSOR, RESIZE_DIRS, resizeRect, resizeRectWithin, type ResizeDir } from './panelResize.js';

const rect = { x: 100, y: 200, width: 300, height: 400 };
const min = { width: 120, height: 100 };

describe('resizeRect', () => {
  it('exposes all eight handles with the right cursor', () => {
    expect(RESIZE_DIRS).toEqual(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
    expect(RESIZE_CURSOR.n).toBe('ns-resize');
    expect(RESIZE_CURSOR.s).toBe('ns-resize');
    expect(RESIZE_CURSOR.e).toBe('ew-resize');
    expect(RESIZE_CURSOR.w).toBe('ew-resize');
    expect(RESIZE_CURSOR.ne).toBe('nesw-resize');
    expect(RESIZE_CURSOR.sw).toBe('nesw-resize');
    expect(RESIZE_CURSOR.nw).toBe('nwse-resize');
    expect(RESIZE_CURSOR.se).toBe('nwse-resize');
  });

  it('east and south only change size', () => {
    expect(resizeRect(rect, 'e', 30, 0, min)).toEqual({ x: 100, y: 200, width: 330, height: 400 });
    expect(resizeRect(rect, 's', 0, 40, min)).toEqual({ x: 100, y: 200, width: 300, height: 440 });
  });

  it('west moves the origin and keeps the right edge fixed', () => {
    const next = resizeRect(rect, 'w', -50, 0, min);
    expect(next).toEqual({ x: 50, y: 200, width: 350, height: 400 });
    expect(next.x + next.width).toBe(rect.x + rect.width);
  });

  it('north moves the origin and keeps the bottom edge fixed', () => {
    const next = resizeRect(rect, 'n', 0, -60, min);
    expect(next).toEqual({ x: 100, y: 140, width: 300, height: 460 });
    expect(next.y + next.height).toBe(rect.y + rect.height);
  });

  it('corners move both axes and keep both opposite edges fixed', () => {
    const sw = resizeRect(rect, 'sw', -20, 30, min);
    expect(sw).toEqual({ x: 80, y: 200, width: 320, height: 430 });
    expect(sw.x + sw.width).toBe(rect.x + rect.width);

    const nw = resizeRect(rect, 'nw', -20, -30, min);
    expect(nw).toEqual({ x: 80, y: 170, width: 320, height: 430 });
    expect(nw.x + nw.width).toBe(rect.x + rect.width);
    expect(nw.y + nw.height).toBe(rect.y + rect.height);

    expect(resizeRect(rect, 'ne', 25, -25, min)).toEqual({ x: 100, y: 175, width: 325, height: 425 });
    expect(resizeRect(rect, 'se', 25, 25, min)).toEqual({ x: 100, y: 200, width: 325, height: 425 });
  });

  it('clamps width on the west side without letting the origin cross the right edge', () => {
    const next = resizeRect(rect, 'w', 500, 0, min);
    expect(next.width).toBe(min.width);
    expect(next.x + next.width).toBe(rect.x + rect.width);
    expect(next.x).toBe(rect.x + rect.width - min.width);
  });

  it('clamps height on the north side without letting the origin cross the bottom edge', () => {
    const next = resizeRect(rect, 'n', 0, 500, min);
    expect(next.height).toBe(min.height);
    expect(next.y + next.height).toBe(rect.y + rect.height);
  });

  it('clamps on the east and south sides by growing no further than min', () => {
    expect(resizeRect(rect, 'e', -1000, 0, min).width).toBe(min.width);
    expect(resizeRect(rect, 's', 0, -1000, min).height).toBe(min.height);
    expect(resizeRect(rect, 'nw', 1000, 1000, min)).toEqual({ x: rect.x + rect.width - min.width, y: rect.y + rect.height - min.height, width: min.width, height: min.height });
  });

  it('never grows below one pixel and ignores non-finite deltas', () => {
    expect(resizeRect({ x: 0, y: 0, width: 10, height: 10 }, 'e', -50, 0, { width: 0, height: 0 }).width).toBe(1);
    expect(resizeRect(rect, 'e', Number.NaN, 0, min)).toEqual(rect);
  });

  it('a zero delta is a no-op for every direction', () => {
    for (const dir of RESIZE_DIRS as ResizeDir[]) expect(resizeRect(rect, dir, 0, 0, min)).toEqual(rect);
  });
});

describe('resizeRectWithin', () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 800 };

  it('caps an east drag at the bounds and leaves the west edge alone', () => {
    const next = resizeRectWithin({ x: 800, y: 100, width: 150, height: 200 }, 'e', 200, 0, min, bounds);
    expect(next.width).toBe(200);
    expect(next.x).toBe(800);
  });

  it('caps a south drag at the bounds and leaves the north edge alone', () => {
    const next = resizeRectWithin({ x: 100, y: 700, width: 200, height: 50 }, 's', 0, 300, min, bounds);
    expect(next.height).toBe(100);
    expect(next.y).toBe(700);
  });

  it('trims the west edge against the left bound while the right edge stays fixed', () => {
    const next = resizeRectWithin({ x: 10, y: 100, width: 300, height: 200 }, 'w', -200, 0, min, bounds);
    expect(next.x).toBe(0);
    expect(next.width).toBe(310);
    expect(next.x + next.width).toBe(310);
  });

  it('trims the north edge against the top bound while the bottom edge stays fixed', () => {
    const next = resizeRectWithin({ x: 100, y: 10, width: 300, height: 200 }, 'n', 0, -200, min, bounds);
    expect(next.y).toBe(0);
    expect(next.y + next.height).toBe(210);
  });
});

describe('resizeRectWithin at a bound', () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 800 };

  it('does not collapse a box already flush with the bottom bound', () => {
    const flush = { x: 100, y: 620, width: 300, height: 180 };
    const next = resizeRectWithin(flush, 'sw', -40, -20, min, bounds);
    // Invariants that matter for the operator: the box stays large (never snaps
    // to the 100px minimum on a 20px gesture), stays inside the bound, and the
    // right edge stays fixed.
    expect(next.height).toBeGreaterThanOrEqual(min.height);
    expect(Math.abs(next.height - flush.height)).toBeLessThanOrEqual(40);
    expect(next.y + next.height).toBeLessThanOrEqual(bounds.height);
    expect(next.x + next.width).toBe(flush.x + flush.width);
  });

  it('does not collapse a box already flush with the right bound', () => {
    const flush = { x: 680, y: 100, width: 320, height: 200 };
    // +20 on y grows down (room to 800); +40 on x would pass the right bound, so
    // width stays as it was instead of snapping to the minimum.
    const next = resizeRectWithin(flush, 'se', 40, 20, min, bounds);
    expect(next.width).toBe(320);
    expect(next.height).toBe(220);
    expect(next.x + next.width).toBe(1000);
  });

  it('still shrinks a box that is inside the bounds', () => {
    const next = resizeRectWithin({ x: 100, y: 100, width: 300, height: 200 }, 's', 0, 60, min, bounds);
    expect(next.height).toBe(260);
  });
});
