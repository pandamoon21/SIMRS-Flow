import { describe, expect, it } from 'vitest';
import { compactTrail, withoutRm } from './PatientLog.js';
import type { PatientTrail } from '../panels/terminalLog.js';

const at = (ok: boolean | null, planId?: string): PatientTrail['trail'][number] => ({ nodeId: 'n', index: 1, total: 2, label: 'Langkah', item: { label: 'x', ok, ...(planId ? { planId } : {}) } });

describe('patient log', () => {
  it('drops the No. RM the card header already shows, keeping the rest of the label', () => {
    expect(withoutRm('0-80-00-00 · 01-2000000 · POLI MATA', '0-80-00-00')).toBe('01-2000000 · POLI MATA');
    expect(withoutRm('0-80-00-00', '0-80-00-00')).toBe('0-80-00-00');
  });

  it('Ringkas keeps problems, planned writes and open items, and counts the passed ones', () => {
    const { shown, passed } = compactTrail([at(true), at(false), at(null), at(true, 'p1'), at(true)]);
    expect(shown.map((t) => [t.item.ok, t.item.planId])).toEqual([[false, undefined], [null, undefined], [true, 'p1']]);
    expect(passed).toBe(2);
  });
});
