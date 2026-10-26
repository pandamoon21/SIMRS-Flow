/**
 * Root zoom that keeps the 1920px (1080p) layout on smaller desktop screens.
 * 1536px (1920 at 125% Windows scaling) lands exactly on 1920 CSS px; the 0.8
 * floor keeps text legible on 1366/1280 laptops. At 1024px and below the UI is
 * a tablet/phone and the regular responsive breakpoints take over unzoomed.
 */
export const FIT_ZOOM_DESIGN_WIDTH = 1920;
export const FIT_ZOOM_MIN = 0.8;
export const FIT_ZOOM_MOBILE_MAX = 1024;

export function fitZoom(viewportWidth: number): number {
  if (viewportWidth <= FIT_ZOOM_MOBILE_MAX || viewportWidth >= FIT_ZOOM_DESIGN_WIDTH) return 1;
  return Math.max(FIT_ZOOM_MIN, Math.round((viewportWidth / FIT_ZOOM_DESIGN_WIDTH) * 1000) / 1000);
}

/**
 * The zoom actually applied to <html>. Pointer coords, innerWidth and
 * getBoundingClientRect are screen px; divide by this to get CSS px.
 */
export function pageZoom(): number {
  if (typeof document === 'undefined') return 1;
  return Number.parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
}
