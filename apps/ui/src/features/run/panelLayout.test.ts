import { describe, expect, it } from 'vitest';
import { clampPanelLayout, defaultPanelLayout, parsePanelLayout } from './panelLayout.js';

const desktop = { width: 1200, height: 800 };

describe('floating Run panel layout', () => {
  it('starts compact with only setup open', () => {
    const layout = defaultPanelLayout(desktop);
    expect(layout.panels.setup.open).toBe(true);
    expect(layout.panels.inspector.open).toBe(false);
    expect(layout.panels.console.open).toBe(false);
  });

  it('places default panels side by side without overlap on laptop widths', () => {
    for (const width of [1024, 1200, 1440]) {
      const { setup, inspector, console } = defaultPanelLayout({ width, height: 700 }).panels;
      expect(setup.x + setup.width).toBeLessThanOrEqual(console.x);
      expect(console.x + console.width).toBeLessThanOrEqual(inspector.x);
    }
  });

  it('starts below the measured command bar on phone and desktop', () => {
    for (const [viewport, setupHeight] of [[{ width: 390, height: 789, top: 316 }, 465], [{ width: 1440, height: 900, top: 80 }, 720], [{ width: 1366, height: 680, top: 80 }, 572]] as const) {
      const layout = defaultPanelLayout(viewport);
      for (const panel of Object.values(layout.panels)) {
        expect(panel.y).toBeGreaterThanOrEqual(viewport.top);
        expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height);
      }
      expect(layout.panels.setup.height).toBe(setupHeight);
    }
  });

  it('restores and re-clamps saved panels as command bar height changes', () => {
    const saved = defaultPanelLayout(desktop);
    saved.panels.setup.y = 0;
    saved.panels.inspector.y = 12;
    const phone = { width: 390, height: 789, top: 316 };
    const restored = parsePanelLayout(JSON.stringify(saved), phone)!;
    expect(restored.panels.setup.y).toBe(316);
    expect(restored.panels.inspector.y).toBe(316);
    expect(restored.panels.setup.height).toBe(473);
    const tallerBar = clampPanelLayout(restored, { ...phone, top: 370 });
    for (const panel of Object.values(tallerBar.panels)) {
      expect(panel.y).toBeGreaterThanOrEqual(370);
      expect(panel.y + panel.height).toBeLessThanOrEqual(phone.height);
    }
    expect(clampPanelLayout(tallerBar, { ...phone, top: 370 })).toEqual(tallerBar);
    const cramped = clampPanelLayout(tallerBar, { ...phone, height: 390, top: 370 });
    expect(cramped.panels.setup.y).toBe(370);
    expect(cramped.panels.setup.height).toBe(20);
  });

  it('round-trips only geometric data, rejecting incompatible or malformed records', () => {
    const initial = defaultPanelLayout(desktop);
    expect(parsePanelLayout(JSON.stringify(initial), desktop)).toEqual(initial);
    expect(parsePanelLayout(JSON.stringify({ ...initial, version: 2 }), desktop)).toBeUndefined();
    const injected = JSON.stringify({ ...initial, panels: { ...initial.panels, setup: { ...initial.panels.setup, patientId: 'secret' } } });
    expect(parsePanelLayout(injected, desktop)).toEqual(initial);
    expect(JSON.stringify(parsePanelLayout(injected, desktop))).not.toContain('secret');
    expect(parsePanelLayout(JSON.stringify({ ...initial, panels: { ...initial.panels, setup: { ...initial.panels.setup, width: 'bad' } } }), desktop)).toBeUndefined();
    expect(parsePanelLayout(JSON.stringify({ ...initial, order: ['setup', 'setup', 'console'] }), desktop)).toBeUndefined();
    expect(parsePanelLayout('{', desktop)).toBeUndefined();
    expect(JSON.stringify(initial)).not.toContain('patient');
  });

  it('keeps every panel header and size in a 390px viewport after resize or restore', () => {
    const layout = defaultPanelLayout(desktop);
    layout.panels.setup.x = 5000;
    layout.panels.inspector.y = -100;
    layout.panels.console.width = 800;
    const mobile = { width: 390, height: 640 };
    const clamped = clampPanelLayout(layout, mobile);
    expect(parsePanelLayout(JSON.stringify(layout), mobile)).toEqual(clamped);
    for (const panel of Object.values(clamped.panels)) {
      expect(panel.width).toBeGreaterThanOrEqual(220);
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(390);
      expect(panel.y).toBeGreaterThanOrEqual(0);
      expect(panel.y + panel.height).toBeLessThanOrEqual(640);
    }
  });
});
