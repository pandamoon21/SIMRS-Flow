import type { RuleCatalog, RuleCatalogEntry, WorkflowDefinition, WorkflowNodeDefinition } from '@simrs-flow/workflow-core';
import type { RuleValues } from '../../api/client.js';

export interface RuleRow {
  node: WorkflowNodeDefinition;
  entry: RuleCatalogEntry;
}

export interface RuleSection {
  id: string;
  label: string;
  description?: string;
  rows: RuleRow[];
}

/** Workflow nodes joined with their catalog entry, in canvas phase order (group when no phases). */
export function buildRuleSections(workflow: WorkflowDefinition, catalog: RuleCatalog): RuleSection[] {
  const entries = new Map(catalog.entries.map((e) => [e.nodeId, e]));
  const phases = workflow.layout?.phases ?? [];
  const groups = workflow.layout?.groups ?? [];
  const sections = new Map<string, RuleSection>();
  for (const p of phases) sections.set(p.id, { id: p.id, label: p.label, description: p.description, rows: [] });
  for (const node of workflow.nodes) {
    const entry = entries.get(node.id);
    if (!entry) continue;
    const key = (phases.length ? node.ui?.phase : undefined) ?? node.group;
    const section = sections.get(key) ?? { id: key, label: groups.find((g) => g.id === key)?.label ?? key, rows: [] };
    section.rows.push({ node, entry });
    sections.set(key, section);
  }
  return [...sections.values()].filter((s) => s.rows.length > 0);
}

/** Case-insensitive match over every text a row shows: label, id, outcomes, reasons, codes, endpoints. */
export function ruleRowMatches(row: RuleRow, query: string, writesOnly: boolean): boolean {
  if (writesOnly && row.entry.writes.length === 0) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const { node, entry } = row;
  const haystack = [
    node.id,
    node.label,
    node.ui?.description ?? '',
    ...entry.outcomes.map((o) => o.text),
    ...entry.findings,
    ...entry.issues.flatMap((i) => [i.code, i.text]),
    ...entry.actions.flatMap((a) => [a.endpointId, a.text]),
    ...entry.reads,
    ...entry.writes,
  ];
  return haystack.some((text) => text.toLowerCase().includes(q));
}

/** Writes the step can plan whose reason is decided at runtime (no literal `reason` in source). */
export function writesWithoutReason(entry: RuleCatalogEntry): string[] {
  return entry.writes.filter((w) => !entry.actions.some((a) => a.endpointId === w));
}

/** One entry per non-empty line, trimmed — the textarea format of a rule list. */
export function parseLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export type RuleField = 'bankDarahUnits' | 'cathlabUnits' | 'ibsManualReviewRooms' | 'skipTreatments' | 'treatmentGroups' | 'paymentConfig';

export const RULE_FIELD_LABEL: Record<RuleField, string> = {
  bankDarahUnits: 'Unit blocker Bank Darah',
  cathlabUnits: 'Unit blocker Cathlab',
  ibsManualReviewRooms: 'Ruang IBS review manual',
  skipTreatments: 'Larangan tindakan',
  treatmentGroups: 'Grup tindakan wajib',
  paymentConfig: 'Tampung bayar',
};

export const RULE_FIELD_DOMAIN: Record<RuleField, 'ranap' | 'rajal'> = {
  bankDarahUnits: 'ranap', cathlabUnits: 'ranap', ibsManualReviewRooms: 'ranap',
  skipTreatments: 'rajal', treatmentGroups: 'rajal', paymentConfig: 'rajal',
};

const fieldValue = (values: RuleValues, field: RuleField): unknown =>
  RULE_FIELD_DOMAIN[field] === 'ranap'
    ? values.ranap[field as keyof RuleValues['ranap']]
    : values.rajal[field as keyof RuleValues['rajal']];

/** Fields whose value differs, in display order — drives the "diubah" markers and the change count. */
export function diffRules(saved: RuleValues, draft: RuleValues): RuleField[] {
  return (Object.keys(RULE_FIELD_LABEL) as RuleField[])
    .filter((field) => JSON.stringify(fieldValue(saved, field)) !== JSON.stringify(fieldValue(draft, field)));
}

/**
 * Fast inline mirror of the orchestrator's checks (apps/orchestrator/src/rules.ts
 * validateRuleValues), keyed by field. The server stays the authority.
 */
export function ruleDraftErrors(values: RuleValues): Partial<Record<RuleField, string>> {
  const errors: Partial<Record<RuleField, string>> = {};
  const seen = new Set<string>();
  values.rajal.treatmentGroups.forEach((group, i) => {
    if (errors.treatmentGroups) return;
    const key = group.key.trim();
    if (!/^[A-Z]$/.test(group.group.trim().toUpperCase())) errors.treatmentGroups = `Baris ${i + 1}: grup harus satu huruf A–Z`;
    else if (!key || key.length > 40) errors.treatmentGroups = `Baris ${i + 1}: key wajib, maksimal 40 karakter`;
    else if (!group.name.trim() || group.name.trim().length > 120) errors.treatmentGroups = `Baris ${i + 1}: nama tindakan wajib, maksimal 120 karakter`;
    else if (seen.has(key)) errors.treatmentGroups = `Key "${key}" dipakai dua kali`;
    seen.add(key);
  });
  if (!/^\d{1,4}$/.test(values.rajal.paymentConfig.payerCode.trim())) errors.paymentConfig = 'Kode penjamin harus 1–4 digit';
  return errors;
}
