/**
 * Per-transaction lock (safety control #10).
 *
 * Golden rule from the runbook: "one run owns one transaction." A second
 * *write* run must not start against a transaction that an in-flight write run
 * already holds, or the two could race the same billing record and risk a
 * double-write. We derive a stable lock key from the run input and hold it for
 * the life of the run, releasing on completion or cancellation.
 *
 * The key derivation mirrors the identifiers the domains actually key on:
 *   - ranap: `no_transaksi` if present, else `noRm:tanggal`
 *   - rajal: each `patientId:date` (a batch can touch several patients)
 *   - rajal discovery: coarse report lock; patient ids are not known yet
 * Preview runs never lock — they cannot write.
 */

export type LockKey = string;

function conflicts(a: LockKey, b: LockKey): boolean {
  if (a === b) return true;
  if (a === 'rajal-discovery:*') return b.startsWith('rajal-rm:');
  if (b === 'rajal-discovery:*') return a.startsWith('rajal-rm:');
  return false;
}

/** Derive the lock keys a run would hold. Empty when nothing identifiable. */
export function deriveLockKeys(input: unknown): LockKey[] {
  if (!input || typeof input !== 'object') return [];
  const o = input as Record<string, unknown>;

  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;

  // Most specific first: an explicit transaction id.
  const noTransaksi = str(o.no_transaksi) ?? str(o.noTransaksi);
  if (noTransaksi) return [`tx:${noTransaksi}`];

  // Discovery wins over any stale typed list left in the request body.
  if (o.discovery && typeof o.discovery === 'object') return ['rajal-discovery:*'];

  // ranap identity: medical-record number + date.
  const noRm = str(o.noRm) ?? str(o.txtmedrec);
  const tanggal = str(o.tanggal) ?? str(o.date);
  if (noRm) return [`ranap-rm:${noRm}:${tanggal ?? '*'}`];

  // rajal batch: one key per patient + date.
  const patientIds = Array.isArray(o.patientIds)
    ? o.patientIds.filter((p): p is string => typeof p === 'string' && !!p.trim())
    : [];
  if (patientIds.length > 0) {
    const d = tanggal ?? '*';
    return patientIds.map((p) => `rajal-rm:${p.trim()}:${d}`);
  }

  return [];
}

export class TransactionLocks {
  /** lockKey → runId holding it. */
  private readonly held = new Map<LockKey, string>();

  /**
   * Try to acquire all keys for a run atomically. Returns the conflicting key
   * (held by another run) on failure, or undefined on success.
   */
  acquire(runId: string, keys: LockKey[]): LockKey | undefined {
    const conflict = keys.find((requested) =>
      [...this.held].some(([held, owner]) => owner !== runId && conflicts(requested, held)),
    );
    if (conflict) return conflict;
    for (const k of keys) this.held.set(k, runId);
    return undefined;
  }

  /** Release every key held by a run. */
  release(runId: string): void {
    for (const [k, owner] of this.held) {
      if (owner === runId) this.held.delete(k);
    }
  }

  /** Test/introspection: is this key currently held? */
  isHeld(key: LockKey): boolean {
    return this.held.has(key);
  }
}

/** Operator-facing name of a lock key (`tx:…`, `ranap-rm:RM:date`, `rajal-rm:RM:date`). */
export function lockKeyLabel(key: string): string {
  const [kind, id = '', date = ''] = key.split(':');
  if (kind === 'tx') return `transaksi ${id}`;
  if (kind === 'rajal-discovery') return 'pengambilan laporan rajal';
  if (kind === 'ranap-rm' || kind === 'rajal-rm') return `No RM ${id}${date && date !== '*' ? ` (${date})` : ''}`;
  return key;
}
