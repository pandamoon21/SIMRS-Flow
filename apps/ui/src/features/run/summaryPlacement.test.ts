import { describe, expect, it } from 'vitest';
import {
  clampSummaryRect,
  placeSummary,
  summaryBottomReserve,
  summaryResizeBounds,
  SUMMARY_BOTTOM_RESERVE,
  SUMMARY_DEFAULT_HEIGHT,
  SUMMARY_EDGE_GAP,
  SUMMARY_MIN_SIZE,
  type SummaryBox,
  type SummaryRect,
} from './summaryPlacement.js';

// The measured canvas-wrap box at 1366x768 with 0.8 fit zoom (screen px / 0.8).
const canvas: SummaryBox = { width: 1650, height: 827 };

const inside = (rect: SummaryRect, box: SummaryBox) => {
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(box.width);
  expect(rect.y + rect.height).toBeLessThanOrEqual(box.height);
};

describe('placeSummary', () => {
  it('sits bottom-centre with every edge inside the canvas', () => {
    const rect = placeSummary(canvas, 240);
    expect(rect.x + rect.width / 2).toBeCloseTo(canvas.width / 2, 0);
    expect(rect.y + rect.height).toBe(canvas.height - SUMMARY_BOTTOM_RESERVE);
    expect(rect.height).toBe(240);
    inside(rect, canvas);
  });

  it('falls back to a default height before content is measured', () => {
    // The default is below the 180px minimum, so the minimum wins.
    expect(placeSummary(canvas, Number.NaN).height).toBe(SUMMARY_MIN_SIZE.height);
    expect(SUMMARY_DEFAULT_HEIGHT).toBeLessThan(SUMMARY_MIN_SIZE.height);
  });

  it('never exceeds the canvas or the minimum', () => {
    const tall = placeSummary(canvas, 5000);
    expect(tall.height).toBe(canvas.height - SUMMARY_BOTTOM_RESERVE - SUMMARY_EDGE_GAP);
    inside(tall, canvas);

    const tiny = placeSummary({ width: 200, height: 120 }, 40);
    expect(tiny.width).toBe(SUMMARY_MIN_SIZE.width);
    expect(tiny.height).toBe(SUMMARY_MIN_SIZE.height);
    // A canvas narrower than the minimum still yields a non-negative origin.
    expect(tiny.x).toBeGreaterThanOrEqual(0);
    expect(tiny.y).toBeGreaterThanOrEqual(0);
  });
});

describe('clampSummaryRect', () => {
  it('slides an overflowing box back inside, keeping its size', () => {
    const clamped = clampSummaryRect({ x: 1400, y: 700, width: 560, height: 220 }, canvas);
    expect(clamped.width).toBe(560);
    expect(clamped.height).toBe(220);
    expect(clamped.x).toBe(canvas.width - 560);
    expect(clamped.y).toBe(canvas.height - 220);
    inside(clamped, canvas);
  });

  it('shrinks a box larger than the canvas', () => {
    const clamped = clampSummaryRect({ x: 0, y: 0, width: 5000, height: 5000 }, canvas);
    expect(clamped).toEqual({ x: 0, y: 0, width: canvas.width, height: canvas.height });
  });

  it('keeps a box that already fits exactly where it is', () => {
    const rect = { x: 300, y: 200, width: 400, height: 200 };
    expect(clampSummaryRect(rect, canvas)).toEqual(rect);
  });

  it('a default placement is already clamped', () => {
    const placed = placeSummary(canvas, 180);
    expect(clampSummaryRect(placed, canvas)).toEqual(placed);
  });
});

describe('replay bar reserve', () => {
  // Measured at 1366x768: the replay bar is ~38 CSS px tall inside the canvas.
  const bar = 38;

  it('falls back to the main rule when no bar is measured', () => {
    expect(summaryBottomReserve(undefined)).toBe(SUMMARY_BOTTOM_RESERVE);
    expect(summaryBottomReserve(0)).toBe(SUMMARY_BOTTOM_RESERVE);
  });

  it('reserves the measured bar height plus the gap', () => {
    expect(summaryBottomReserve(bar)).toBe(bar + SUMMARY_EDGE_GAP);
  });

  it('places the default box above the replay bar', () => {
    const rect = placeSummary(canvas, 180, SUMMARY_MIN_SIZE, summaryBottomReserve(bar));
    expect(rect.y + rect.height).toBe(canvas.height - (bar + SUMMARY_EDGE_GAP));
    expect(canvas.height - (rect.y + rect.height)).toBeGreaterThanOrEqual(bar);
  });

  it('never lets a drag or a saved rect cover the bar', () => {
    const reserve = summaryBottomReserve(bar);
    const dragged = clampSummaryRect({ x: 0, y: canvas.height - 200, width: 500, height: 240 }, canvas, SUMMARY_MIN_SIZE, reserve);
    expect(dragged.y + dragged.height).toBe(canvas.height - reserve);
    const bounds = summaryResizeBounds(canvas, reserve);
    expect(bounds.height).toBe(canvas.height - reserve);
  });

  it('without a bar the canvas edge is the limit', () => {
    const bounds = summaryResizeBounds(canvas, 0);
    expect(bounds.height).toBe(canvas.height);
    const clamped = clampSummaryRect({ x: 0, y: 0, width: 400, height: 5000 }, canvas, SUMMARY_MIN_SIZE, 0);
    expect(clamped.y + clamped.height).toBe(canvas.height);
  });
});
