import { describe, it, expect } from 'vitest';
import { deriveLockKeys, TransactionLocks } from '../src/locks.js';

describe('deriveLockKeys', () => {
  it('prefers an explicit transaction id', () => {
    expect(deriveLockKeys({ no_transaksi: '03-1', noRm: '012345' })).toEqual(['tx:03-1']);
    expect(deriveLockKeys({ noTransaksi: '03-2' })).toEqual(['tx:03-2']);
  });

  it('falls back to medrec + date for ranap', () => {
    expect(deriveLockKeys({ noRm: '012345', tanggal: '2026-06-10' })).toEqual(['ranap-rm:012345:2026-06-10']);
    expect(deriveLockKeys({ txtmedrec: '012345' })).toEqual(['ranap-rm:012345:*']);
  });

  it('produces one key per patient for a rajal batch', () => {
    expect(deriveLockKeys({ patientIds: ['111', '222'], date: '2026-06-10' })).toEqual([
      'rajal-rm:111:2026-06-10',
      'rajal-rm:222:2026-06-10',
    ]);
  });

  it('holds a coarse lock for rajal discovery before patients are known', () => {
    expect(deriveLockKeys({ discovery: { from: '2026-06-10', to: '2026-06-10' } })).toEqual([
      'rajal-discovery:*',
    ]);
    expect(deriveLockKeys({ patientIds: ['111'], discovery: { from: '2026-06-10' } })).toEqual([
      'rajal-discovery:*',
    ]);
  });

  it('returns no keys for unidentifiable input', () => {
    expect(deriveLockKeys(undefined)).toEqual([]);
    expect(deriveLockKeys({})).toEqual([]);
    expect(deriveLockKeys({ patientIds: [] })).toEqual([]);
    expect(deriveLockKeys('nope')).toEqual([]);
  });
});

describe('TransactionLocks', () => {
  it('acquires and releases keys', () => {
    const locks = new TransactionLocks();
    expect(locks.acquire('run1', ['tx:1'])).toBeUndefined();
    expect(locks.isHeld('tx:1')).toBe(true);
    locks.release('run1');
    expect(locks.isHeld('tx:1')).toBe(false);
  });

  it('reports a conflict when another run holds a key', () => {
    const locks = new TransactionLocks();
    locks.acquire('run1', ['tx:1']);
    expect(locks.acquire('run2', ['tx:1'])).toBe('tx:1');
    // run2 acquired nothing — a partial acquire must not leak.
    locks.release('run1');
    expect(locks.acquire('run2', ['tx:1'])).toBeUndefined();
  });

  it('is idempotent for the same run', () => {
    const locks = new TransactionLocks();
    expect(locks.acquire('run1', ['tx:1'])).toBeUndefined();
    expect(locks.acquire('run1', ['tx:1', 'tx:2'])).toBeUndefined();
    expect(locks.isHeld('tx:2')).toBe(true);
  });

  it('does not acquire any key when one conflicts (atomicity)', () => {
    const locks = new TransactionLocks();
    locks.acquire('run1', ['tx:2']);
    expect(locks.acquire('run2', ['tx:1', 'tx:2'])).toBe('tx:2');
    expect(locks.isHeld('tx:1')).toBe(false); // tx:1 must not have been taken
  });

  it('makes rajal discovery conflict with rajal patient locks only', () => {
    const locks = new TransactionLocks();
    expect(locks.acquire('discovery', ['rajal-discovery:*'])).toBeUndefined();
    expect(locks.acquire('rajal', ['rajal-rm:111:2026-06-10'])).toBe('rajal-rm:111:2026-06-10');
    expect(locks.acquire('ranap', ['ranap-rm:111:2026-06-10'])).toBeUndefined();
  });
});

describe('lockKeyLabel', () => {
  it('names a lock the way an operator would', async () => {
    const { lockKeyLabel } = await import('./locks.js');
    expect(lockKeyLabel('tx:03-1')).toBe('transaksi 03-1');
    expect(lockKeyLabel('ranap-rm:0-12-34-56:2026-06-10')).toBe('No RM 0-12-34-56 (2026-06-10)');
    expect(lockKeyLabel('ranap-rm:0-12-34-56:*')).toBe('No RM 0-12-34-56');
    expect(lockKeyLabel('rajal-discovery:*')).toBe('pengambilan laporan rajal');
  });
});
