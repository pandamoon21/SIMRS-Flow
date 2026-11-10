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

describe('writeAcknowledged (pinned behaviour table)', () => {
  // Pinned before the endpoint-specific rule moved onto the endpoint registry;
  // every row must answer exactly as the hard-coded version did.
  const cases: Array<[unknown, string, { ok: boolean; reason: string }]> = [
    ['', 'kasir.tampungBayar', { ok: true, reason: 'empty acknowledgement' }],
    ['   ', 'kasir.tampungBayar', { ok: true, reason: 'empty acknowledgement' }],
    ['""', 'kasir.tampungBayar', { ok: true, reason: 'empty acknowledgement' }],
    ['1', 'kasir.tampungBayar', { ok: true, reason: 'acknowledged "1"' }],
    ['ok', 'verifikator.simpanVerifikasi', { ok: true, reason: 'acknowledged "ok"' }],
    ['True', 'verifikator.simpanVerifikasi', { ok: true, reason: 'acknowledged "True"' }],
    ['DRY_RUN', 'kasir.tampungBayar', { ok: true, reason: 'acknowledged "DRY_RUN"' }],
    ['success', 'kasir.tampungBayar', { ok: true, reason: 'acknowledged "success"' }],
    ['"Transfer sukses"', 'poliklinik.transferIgd', { ok: true, reason: 'acknowledged "Transfer sukses"' }],
    // The transfer notice is a generic rule today: it is accepted for any endpoint.
    ['transfer SUKSES ke kasir', 'kasir.tampungBayar', { ok: true, reason: 'acknowledged "transfer SUKSES ke kasir"' }],
    ['43', 'penatajasaInap.tambahTindakanPolis', { ok: true, reason: 'added as urut_tindakan 43' }],
    ['"43"', 'penatajasaInap.tambahTindakanPolis', { ok: true, reason: 'added as urut_tindakan 43' }],
    ['1', 'penatajasaInap.tambahTindakanPolis', { ok: true, reason: 'acknowledged "1"' }],
    ['4a', 'penatajasaInap.tambahTindakanPolis', { ok: false, reason: 'write answered "4a"' }],
    ['43', 'poliklinik.tambahTindakanPolis', { ok: false, reason: 'write answered "43"' }],
    ['43', 'verifikator.tambahTindakanPolis', { ok: false, reason: 'write answered "43"' }],
    ['43', 'kasir.updateTglMasuk', { ok: false, reason: 'write answered "43"' }],
    ['43', '', { ok: false, reason: 'write answered "43"' }],
    ['43', 'no.suchEndpoint', { ok: false, reason: 'write answered "43"' }],
    ['gagal', 'kasir.tampungBayar', { ok: false, reason: 'write answered "gagal"' }],
    [{ status: true }, 'kasir.tampungBayar', { ok: true, reason: 'status field is true' }],
    [{ status: 1 }, 'kasir.tampungBayar', { ok: true, reason: 'status field is true' }],
    [{ status: ' TRUE ' }, 'kasir.tampungBayar', { ok: true, reason: 'status field is true' }],
    [{ status: '1' }, 'kasir.tampungBayar', { ok: true, reason: 'status field is true' }],
    [{ status: false }, 'kasir.tampungBayar', { ok: false, reason: 'write reported status=false' }],
    [{ status: 0 }, 'penatajasaInap.tambahTindakanPolis', { ok: false, reason: 'write reported status=0' }],
    [{ data: 1 }, 'kasir.tampungBayar', { ok: true, reason: 'no failure signal in the response' }],
    [[1, 2], 'kasir.tampungBayar', { ok: true, reason: 'no failure signal in the response' }],
    [null, 'kasir.tampungBayar', { ok: true, reason: 'no failure signal in the response' }],
    [undefined, 'kasir.tampungBayar', { ok: true, reason: 'no failure signal in the response' }],
    [42, 'penatajasaInap.tambahTindakanPolis', { ok: true, reason: 'no failure signal in the response' }],
  ];
  it.each(cases)('%j via %s', (response, endpointId, expected) => {
    expect(writeAcknowledged(response, endpointId)).toEqual(expected);
  });
});
