export type PanelName = 'setup' | 'inspector' | 'console';
export type PanelGeometry = { x: number; y: number; width: number; height: number; open: boolean };
export type PanelLayout = { version: 1; panels: Record<PanelName, PanelGeometry>; order: PanelName[] };
export type PanelViewport = { width: number; height: number; top?: number };
export const PANEL_LAYOUT_KEY = 'simrs-flow.run.panels.v1';
const names: readonly PanelName[] = ['setup', 'inspector', 'console'];
/** Smallest floating-panel size the layout allows; resize handles clamp to it. */
export const PANEL_MIN = { width: 220, height: 150 } as const;
const margin = 8;
const minWidth = PANEL_MIN.width;
const minHeight = PANEL_MIN.height;
const top = 100;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function clampPanelLayout(layout: PanelLayout, viewport: PanelViewport): PanelLayout {
  const w = Number.isFinite(viewport.width) ? Math.max(1, viewport.width) : 1;
  const h = Number.isFinite(viewport.height) ? Math.max(1, viewport.height) : 1;
  const safeTop = Math.min(h - 1, Math.max(0, Number.isFinite(viewport.top) ? viewport.top! : 0));
  const panels = {} as Record<PanelName, PanelGeometry>;
  for (const name of names) {
    const panel = layout.panels[name];
    const width = Math.min(w, Math.max(Math.min(minWidth, w), panel.width));
    const height = Math.min(h - safeTop, Math.max(Math.min(minHeight, h - safeTop), panel.height));
    panels[name] = {
      x: Math.min(w - width, Math.max(0, panel.x)),
      y: Math.min(h - height, Math.max(safeTop, panel.y)),
      width, height, open: panel.open,
    };
  }
  return { version: 1, panels, order: [...layout.order] };
}

export function defaultPanelLayout(viewport: PanelViewport): PanelLayout {
  const w = Math.max(1, viewport.width);
  const h = Math.max(1, viewport.height);
  const panelTop = Math.max(w <= 520 ? 180 : top, viewport.top ?? 0);
  // Console sits in the gap between the setup (left) and inspector (right) columns
  // when it fits, so no two default panels overlap; otherwise it spans the bottom.
  const gap = w - 316 - 364;
  const sideBySide = gap >= minWidth;
  // Side-by-side columns never meet the console, so on tall screens they may grow.
  const columnHeight = (cap: number) => Math.min(sideBySide ? 720 : cap, h - panelTop - 8);
  return clampPanelLayout({
    version: 1,
    panels: {
      setup: { x: margin, y: panelTop, width: 300, height: columnHeight(480), open: true },
      // Starts below the canvas toolbar (Center/Fit/Follow) that shares the top-right corner.
      inspector: { x: Math.max(margin, w - 356), y: panelTop + 48, width: 348, height: columnHeight(440) - 48, open: false },
      console: sideBySide
        ? { x: 316, y: Math.max(panelTop, h - 224), width: Math.min(540, gap), height: 210, open: false }
        : { x: margin, y: Math.max(panelTop, h - 224), width: Math.min(540, w - 16), height: 210, open: false },
    },
    order: ['setup', 'inspector', 'console'],
  }, viewport);
}

export function parsePanelLayout(raw: string | null, viewport: PanelViewport): PanelLayout | undefined {
  if (!raw || raw.length > 2048) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1 ||
      !('panels' in value) || typeof value.panels !== 'object' || value.panels === null ||
      !('order' in value) || !Array.isArray(value.order) || value.order.length !== names.length ||
      !names.every((name) => (value.order as unknown[]).filter((item) => item === name).length === 1)) return undefined;
    const panels = value.panels as Record<string, unknown>;
    for (const name of names) {
      const p = panels[name];
      if (typeof p !== 'object' || p === null ||
        !('x' in p) || !finite(p.x) || !('y' in p) || !finite(p.y) ||
        !('width' in p) || !finite(p.width) || !('height' in p) || !finite(p.height) ||
        !('open' in p) || typeof p.open !== 'boolean' || p.width <= 0 || p.height <= 0) return undefined;
    }
    const safe = {} as PanelLayout['panels'];
    for (const name of names) {
      const p = panels[name] as PanelGeometry;
      safe[name] = { x: p.x, y: p.y, width: p.width, height: p.height, open: p.open };
    }
    return clampPanelLayout({ version: 1, panels: safe, order: value.order as PanelName[] }, viewport);
  } catch { return undefined; }
}
