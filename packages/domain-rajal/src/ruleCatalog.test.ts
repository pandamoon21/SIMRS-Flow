import { describe, expect, it } from 'vitest';
import { rajalRuleCatalog } from './ruleCatalog.js';
import { rajalWorkflow } from './workflow.js';

// Whether the declarations are *true* is checked at runtime by the last test
// in domain-rajal.test.ts; this only checks the catalog's shape.
describe('rajal rule catalog', () => {
  it('has one entry per node, in workflow order, and lists the planned writes', () => {
    expect(rajalRuleCatalog.entries.map((e) => e.nodeId)).toEqual(rajalWorkflow.nodes.map((n) => n.id));
    expect(rajalRuleCatalog.entries.map((e) => e.executorRef)).toEqual(rajalWorkflow.nodes.map((n) => n.executorRef));
    expect(rajalRuleCatalog.entries.some((e) => e.writes.length > 0)).toBe(true);
  });

  it('declares no template that matches anything, and no outcome twice', () => {
    for (const entry of rajalRuleCatalog.entries) {
      for (const { text } of entry.outcomes) expect(text.replace(/[…\s]/g, ''), entry.nodeId).not.toBe('');
      const keys = entry.outcomes.map((o) => `${o.status}|${o.text}`);
      expect(new Set(keys).size, entry.nodeId).toBe(keys.length);
    }
  });
});
