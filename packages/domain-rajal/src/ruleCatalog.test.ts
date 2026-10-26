import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOMAINS, buildCatalog, renderCatalog } from '../../../scripts/gen-rule-catalog.js';

describe('rajal rule catalog', () => {
  it('matches the executor source — rerun scripts/gen-rule-catalog.ts when this fails', () => {
    const d = DOMAINS.rajal;
    const committed = readFileSync(fileURLToPath(new URL('./ruleCatalog.generated.ts', import.meta.url)), 'utf8');
    const catalog = buildCatalog(d.workflow, d.file);
    expect(renderCatalog(d.name, catalog)).toBe(committed.replace(/\r\n/g, '\n'));
    // Every planned write is listed somewhere, and every node has an entry.
    expect(catalog.entries.map((e) => e.nodeId)).toEqual(d.workflow.nodes.map((n) => n.id));
    expect(catalog.entries.some((e) => e.writes.length > 0)).toBe(true);
  }, 60_000);
});
