import { describe, expect, it } from 'vitest';
import { writeAcknowledged } from './mutationGate.js';

describe('writeAcknowledged (live shapes 2026-10-15)', () => {
  it('accepts the JSON-quoted transfer notice', () => {
    expect(writeAcknowledged('"Transfer sukses"', 'poliklinik.transferIgd').ok).toBe(true);
  });
  it('accepts the new urut_tindakan answered by tambah_tindakan_polis', () => {
    expect(writeAcknowledged('43', 'penatajasaInap.tambahTindakanPolis')).toEqual({ ok: true, reason: 'added as urut_tindakan 43' });
  });
  it('does not treat a bare number as success for other endpoints', () => {
    expect(writeAcknowledged('43', 'kasir.updateTglMasuk').ok).toBe(false);
  });
  it('still fails a backend error page', () => {
    const refused = writeAcknowledged('<!DOCTYPE html><title>Database Error</title><h1>A Database Error Occurred</h1><p>Error Number: 1062</p>', 'penatajasaInap.tambahTindakanPolis');
    expect(refused.ok).toBe(false);
    // The page's own words travel with the refusal, so a live failure can be diagnosed.
    expect(refused.reason).toBe('write answered with a backend error page — Database Error A Database Error Occurred Error Number: 1062');
  });
});
