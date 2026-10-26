import { describe, expect, it } from 'vitest';
import { ranapRuleCatalog, ranapWorkflow } from '@simrs-flow/domain-ranap';
import { rajalRuleCatalog, rajalWorkflow } from '@simrs-flow/domain-rajal';
import type { RuleValues } from '../../api/client.js';
import { buildRuleSections, diffRules, parseLines, ruleDraftErrors, ruleRowMatches, writesWithoutReason } from './ruleCatalog.js';

describe('rule catalog page helpers', () => {
  it('places every workflow node in exactly one section', () => {
    for (const [workflow, catalog] of [[ranapWorkflow, ranapRuleCatalog], [rajalWorkflow, rajalRuleCatalog]] as const) {
      const ids = buildRuleSections(workflow, catalog).flatMap((s) => s.rows.map((r) => r.node.id));
      expect(ids.sort()).toEqual(workflow.nodes.map((n) => n.id).sort());
    }
  });

  it('searches reasons, issue codes and endpoints, and filters to writing steps', () => {
    const rows = buildRuleSections(ranapWorkflow, ranapRuleCatalog).flatMap((s) => s.rows);
    const ids = (q: string, writesOnly = false) => rows.filter((r) => ruleRowMatches(r, q, writesOnly)).map((r) => r.node.id);
    expect(ids('obat_pulang_unreadable')).toEqual(['validate_obat_pulang']);
    expect(ids('rekamMedis.simpanSep')).toContain('compare_sep');
    expect(ids('', true).every((id) => rows.find((r) => r.node.id === id)!.entry.writes.length > 0)).toBe(true);
    expect(ids('', true).length).toBeLessThan(rows.length);
  });

  it('lists writes whose reason is only known at runtime', () => {
    expect(writesWithoutReason({ nodeId: 'n', executorRef: 'x', outcomes: [], issues: [], findings: [], reads: [], writes: ['a.b', 'c.d'], actions: [{ endpointId: 'a.b', text: 'r' }] })).toEqual(['c.d']);
  });

  it('reads a rule list textarea as trimmed non-empty lines', () => {
    expect(parseLines(' BANK DARAH \r\n\n UTD\n')).toEqual(['BANK DARAH', 'UTD']);
  });
});

describe('rule draft diff and validation', () => {
  const base: RuleValues = {
    ranap: { bankDarahUnits: ['BANK DARAH'], cathlabUnits: ['CATHLAB'], ibsManualReviewRooms: ['AL AFIYAT'] },
    rajal: { treatmentGroups: [], skipTreatments: [], paymentConfig: { shift: '1', type: '1', payerCode: '2' } },
  };
  it('lists only the fields that changed, in display order', () => {
    const draft = structuredClone(base);
    draft.rajal.paymentConfig.payerCode = '3';
    draft.ranap.cathlabUnits = ['CATHLAB', 'CATH'];
    expect(diffRules(base, draft)).toEqual(['cathlabUnits', 'paymentConfig']);
    expect(diffRules(base, structuredClone(base))).toEqual([]);
  });
  it('mirrors the server checks for groups and payer code', () => {
    const draft = structuredClone(base);
    draft.rajal.treatmentGroups = [{ group: 'A', key: 'k', name: 'x' }, { group: 'B', key: 'k', name: 'y' }];
    draft.rajal.paymentConfig.payerCode = '12345';
    expect(ruleDraftErrors(draft)).toEqual({ treatmentGroups: 'Key "k" dipakai dua kali', paymentConfig: 'Kode penjamin harus 1–4 digit' });
    draft.rajal.treatmentGroups = [{ group: '1', key: 'k', name: 'x' }];
    expect(ruleDraftErrors(draft).treatmentGroups).toMatch(/A–Z/);
    expect(ruleDraftErrors(base)).toEqual({});
  });
});
