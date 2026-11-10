import { describe, expect, it } from 'vitest';
import { buildRuleCatalog, matchesTemplate, recordStepResults, undeclaredOutcomes } from './outcomes.js';
import type { RecordedStepResult } from './outcomes.js';
import type { WorkflowDefinition } from './types.js';

const workflow = {
  id: 'wf',
  nodes: [
    { id: 'a', executorRef: 'x.a' },
    { id: 'b', executorRef: 'x.b' },
  ],
} as unknown as WorkflowDefinition;

const endpoints = {
  'r.read': { kind: 'read', riskLevel: 'low', description: 'read' },
  'w.write': { kind: 'mutate', riskLevel: 'high', description: 'write' },
} as const;

describe('matchesTemplate', () => {
  it('treats … as any text and whitespace runs as one space', () => {
    expect(matchesTemplate('… kunjungan cocok', '3 kunjungan cocok')).toBe(true);
    expect(matchesTemplate('… kunjungan cocok', '3 kunjungan  cocok\n')).toBe(true);
    expect(matchesTemplate('… kunjungan cocok', '3 kunjungan cocok; 1 dilewati')).toBe(false);
    expect(matchesTemplate('Order (… → …)', 'Order (a → b)')).toBe(true);
    expect(matchesTemplate('Tidak ada…', 'Tidak ada')).toBe(true);
  });
});

describe('buildRuleCatalog', () => {
  it('orders entries by node and copies only the endpoints in use', () => {
    const catalog = buildRuleCatalog(workflow, {
      b: { outcomes: [{ status: 'success', text: 'b' }], reads: ['r.read'] },
      a: { outcomes: [{ status: 'success', text: 'a' }] },
    }, endpoints);
    expect(catalog.entries.map((e) => e.nodeId)).toEqual(['a', 'b']);
    expect(catalog.entries[0]).toMatchObject({ executorRef: 'x.a', issues: [], reads: [], writes: [] });
    expect(Object.keys(catalog.endpoints)).toEqual(['r.read']);
  });

  it('refuses a missing node, a stray node, an unknown endpoint and a write that is a read', () => {
    const ok = { outcomes: [{ status: 'success' as const, text: 'x' }] };
    expect(() => buildRuleCatalog(workflow, { a: ok }, endpoints)).toThrow(/b declares no outcomes/);
    expect(() => buildRuleCatalog(workflow, { a: ok, b: ok, c: ok }, endpoints)).toThrow(/unknown node/);
    expect(() => buildRuleCatalog(workflow, { a: { ...ok, reads: ['nope'] }, b: ok }, endpoints)).toThrow(/not a known endpoint/);
    expect(() => buildRuleCatalog(workflow, { a: { ...ok, writes: ['r.read'] }, b: ok }, endpoints)).toThrow(/not a mutating/);
    expect(() => buildRuleCatalog(workflow, { a: { ...ok, actions: [{ endpointId: 'w.write', text: 'x' }] }, b: ok }, endpoints)).toThrow(/not a declared write/);
  });
});

describe('recordStepResults + undeclaredOutcomes', () => {
  it('records each result under its node and lists what no declaration covers', async () => {
    const records: RecordedStepResult[] = [];
    const registry = recordStepResults(workflow, {
      'x.a': () => ({ status: 'success', summary: '2 kunjungan cocok' }),
      'x.b': () => ({
        status: 'needs_review',
        summary: 'Rencana 1',
        issues: [{ code: 'odd', message: 'm', severity: 'warn' }],
        proposedMutations: [{ endpointId: 'w.write' } as never],
      }),
    }, (r) => records.push(r));
    await registry['x.a']!({} as never);
    await registry['x.b']!({} as never);
    expect(records.map((r) => r.nodeId)).toEqual(['a', 'b']);
    expect(undeclaredOutcomes({
      a: { outcomes: [{ status: 'success', text: '… kunjungan cocok' }] },
      b: { outcomes: [{ status: 'skipped', text: 'Rencana …' }] },
    }, records)).toEqual([
      { nodeId: 'b', kind: 'outcome', value: 'needs_review: Rencana 1' },
      { nodeId: 'b', kind: 'issue', value: 'odd' },
      { nodeId: 'b', kind: 'write', value: 'w.write' },
    ]);
  });
});
