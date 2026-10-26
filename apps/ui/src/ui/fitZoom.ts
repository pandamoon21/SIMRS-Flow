/**
 * Root zoom that keeps the 1920×1080 (1080p) layout on every desktop screen.
 * Below 1920px wide it scales down: 1536px (1920 at 125% Windows scaling) lands
 * exactly on 1920 CSS px; the 0.8 floor keeps text legible on 1366/1280 laptops.
 * Above 1080p it scales up by the smaller of the width and height ratios, so a
 * 1440p or 4K screen at 100% shows the same layout larger instead of a small
 * centred column, and an ultrawide (3440×1440) grows by its height, never
 * cropping the page vertically. At 1024px and below the UI is a tablet/phone
 * and the regular responsive breakpoints take over unzoomed.
 */
export const FIT_ZOOM_DESIGN_WIDTH = 1920;
export const FIT_ZOOM_DESIGN_HEIGHT = 1080;
export const FIT_ZOOM_MIN = 0.8;
export const FIT_ZOOM_MOBILE_MAX = 1024;

export function fitZoom(viewportWidth: number, viewportHeight = Number.POSITIVE_INFINITY): number {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  if (viewportWidth <= FIT_ZOOM_MOBILE_MAX) return 1;
  if (viewportWidth < FIT_ZOOM_DESIGN_WIDTH) return Math.max(FIT_ZOOM_MIN, round(viewportWidth / FIT_ZOOM_DESIGN_WIDTH));
  const up = Math.min(viewportWidth / FIT_ZOOM_DESIGN_WIDTH, viewportHeight / FIT_ZOOM_DESIGN_HEIGHT);
  return up > 1 ? round(up) : 1;
}

/**
 * The zoom actually applied to <html>. Pointer coords, innerWidth and
 * getBoundingClientRect are screen px; divide by this to get CSS px.
 */
export function pageZoom(): number {
  if (typeof document === 'undefined') return 1;
  return Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
}
