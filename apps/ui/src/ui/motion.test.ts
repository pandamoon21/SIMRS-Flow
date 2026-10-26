import { describe, expect, it } from 'vitest';
import { isWeakDevice, resolveMotion } from './motion.js';

describe('motion setting', () => {
  it('treats 4 GB or 4 cores as a weak office PC, and unknown as capable', () => {
    expect(isWeakDevice({ deviceMemory: 4, hardwareConcurrency: 8 })).toBe(true);
    expect(isWeakDevice({ deviceMemory: 8, hardwareConcurrency: 4 })).toBe(true);
    expect(isWeakDevice({ deviceMemory: 8, hardwareConcurrency: 12 })).toBe(false);
    expect(isWeakDevice({})).toBe(false);
    expect(isWeakDevice(undefined)).toBe(false);
  });

  it('auto picks lite on a weak device or dropping frames; an explicit choice always wins', () => {
    expect(resolveMotion('auto', false)).toBe('full');
    expect(resolveMotion('auto', true)).toBe('lite');
    expect(resolveMotion('auto', false, true)).toBe('lite');
    expect(resolveMotion('full', true, true)).toBe('full');
    expect(resolveMotion('off', false)).toBe('off');
  });
});
