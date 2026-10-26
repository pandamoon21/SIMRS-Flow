import { describe, expect, it } from 'vitest';
import { fitZoom } from './fitZoom.js';

describe('fitZoom', () => {
  it('scales laptops toward the 1080p layout and leaves phones/1080p+ alone', () => {
    expect(fitZoom(1920)).toBe(1);
    expect(fitZoom(2560)).toBe(1);
    expect(fitZoom(1536)).toBe(0.8);
    expect(fitZoom(1728)).toBe(0.9);
    expect(fitZoom(1366)).toBe(0.8);
    expect(fitZoom(1024)).toBe(1);
    expect(fitZoom(390)).toBe(1);
  });
});
