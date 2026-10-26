import { describe, expect, it } from 'vitest';
import { fitZoom } from './fitZoom.js';

describe('fitZoom', () => {
  it('scales laptops toward the 1080p layout and leaves phones/1080p alone', () => {
    expect(fitZoom(1920, 1080)).toBe(1);
    expect(fitZoom(1536)).toBe(0.8);
    expect(fitZoom(1728)).toBe(0.9);
    expect(fitZoom(1366)).toBe(0.8);
    expect(fitZoom(1024)).toBe(1);
    expect(fitZoom(390)).toBe(1);
  });

  it('scales large screens up by the tighter of width and height', () => {
    expect(fitZoom(2560, 1440)).toBe(1.333);
    expect(fitZoom(3840, 2160)).toBe(2);
    expect(fitZoom(3440, 1440)).toBe(1.333); // ultrawide: height-bound
    expect(fitZoom(2560, 1080)).toBe(1); // 21:9 1080p stays 1:1
    expect(fitZoom(1920, 1200)).toBe(1);
  });
});
