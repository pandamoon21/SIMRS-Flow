import { describe, expect, it } from 'vitest';
import { REFERENCE_NOTES, edgeDisplayState } from './canvasPresentation.js';

describe('canvas-only branch display', () => {
  it('does not infer traversal from completed fan-out edges', () => {
    expect(edgeDisplayState('completed', 'success', 'success')).toBe('adjacent');
    expect(edgeDisplayState('completed', 'success', 'pending')).toBe('idle');
    expect(edgeDisplayState('completed', 'success', 'skipped')).toBe('skipped');
    expect(edgeDisplayState('completed', 'success', 'queued')).toBe('idle');
    expect(edgeDisplayState('skipped', 'success', 'pending')).toBe('skipped');
    expect(edgeDisplayState('skipped', 'success', 'skipped')).toBe('skipped');
  });

  it('shows each reached arm of a merge independently', () => {
    expect(edgeDisplayState('completed', 'success', 'running')).toBe('adjacent');
    expect(edgeDisplayState('active', 'success', 'pending')).toBe('idle');
    expect(edgeDisplayState('completed', 'skipped', 'running')).toBe('skipped');
    expect(edgeDisplayState('active', 'success', 'running')).toBe('active');
  });
});

describe('historical context is not executable', () => {
  it('uses only documented Rajal/Ranap anchors and distinct reference ids', () => {
    expect(REFERENCE_NOTES.rajal.map((note) => note.anchor)).toEqual([
      'filter_records', 'validate_treatment', 'validate_sep', 'check_verification',
    ]);
    expect(REFERENCE_NOTES.ranap.map((note) => note.anchor)).toEqual(['detect_origin']);
    expect(new Set([...REFERENCE_NOTES.rajal, ...REFERENCE_NOTES.ranap].map((note) => `reference:${note.id}`)).size).toBe(5);
    expect(REFERENCE_NOTES.rajal.find((note) => note.id === 'sep-update')?.detail).toContain('memerlukan persetujuan');
  });
});
