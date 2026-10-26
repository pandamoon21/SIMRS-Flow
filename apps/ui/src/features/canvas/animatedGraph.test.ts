import { describe, expect, it } from 'vitest';
import type { Edge, Node } from 'reactflow';
import { advanceMotion, movedBetween, newMotion } from './animatedGraph.js';

const node = (x: number, y: number, width?: number, id = 'a'): Node => ({ id, position: { x, y }, data: {}, ...(width !== undefined ? { style: { width } } : {}) });
const edge = (id: string): Edge => ({ id, source: 'a', target: 'b' });

describe('movedBetween', () => {
  it('flags a change of position or size, and ignores sub-pixel noise', () => {
    expect(movedBetween(node(0, 0), node(0, 0.3))).toBe(false);
    expect(movedBetween(node(0, 0), node(40, 0))).toBe(true);
    expect(movedBetween(node(0, 0, 100), node(0, 0, 160))).toBe(true);
  });
});

describe('advanceMotion', () => {
  const b = node(0, 0, undefined, 'b');

  it('snaps run-driven moves and glides only on a layout switch', () => {
    const m = newMotion([node(0, 0), b], [edge('a-b')], 'fixed');
    advanceMotion(m, [node(0, 80), b], [edge('a-b')], 'fixed', 1000);
    expect(m.gliding.size).toBe(0);
    expect(m.settling.size).toBe(0);
    advanceMotion(m, [node(300, 80), b], [edge('a-b')], 'flex', 2000);
    expect([...m.gliding.keys()]).toEqual(['a']);
    expect([...m.settling.keys()]).toEqual(['a-b']);
  });

  it('never keeps an exiting copy of an element that came back', () => {
    const m = newMotion([node(0, 0), b], [edge('a-b')], 'flex');
    advanceMotion(m, [b], [], 'flex', 1000);
    expect(m.leavingNodes.has('a')).toBe(true);
    expect(m.leavingEdges.has('a-b')).toBe(true);
    // Back within the exit window: rendering both would duplicate the React key.
    advanceMotion(m, [node(0, 0), b], [edge('a-b')], 'flex', 1100);
    expect(m.leavingNodes.size).toBe(0);
    expect(m.leavingEdges.size).toBe(0);
  });
});
