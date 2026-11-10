import { describe, expect, it } from 'vitest';
import { ranapRuleCatalog } from './ruleCatalog.js';
import { ranapWorkflow } from './workflow.js';

// Whether the declarations are *true* is checked at runtime by the last test
// in domain-ranap.test.ts; this only checks the catalog's shape.
describe('ranap rule catalog', () => {
  it('has one entry per node, in workflow order, and lists the planned writes', () => {
    expect(ranapRuleCatalog.entries.map((e) => e.nodeId)).toEqual(ranapWorkflow.nodes.map((n) => n.id));
    expect(ranapRuleCatalog.entries.map((e) => e.executorRef)).toEqual(ranapWorkflow.nodes.map((n) => n.executorRef));
    expect(ranapRuleCatalog.entries.some((e) => e.writes.length > 0)).toBe(true);
  });

  it('declares no template that matches anything, and no outcome twice', () => {
    for (const entry of ranapRuleCatalog.entries) {
      for (const { text } of entry.outcomes) expect(text.replace(/[…\s]/g, ''), entry.nodeId).not.toBe('');
      const keys = entry.outcomes.map((o) => `${o.status}|${o.text}`);
      expect(new Set(keys).size, entry.nodeId).toBe(keys.length);
    }
  });
});
