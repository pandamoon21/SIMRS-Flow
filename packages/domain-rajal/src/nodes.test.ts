import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { rajalWorkflow } from './workflow.js';
import { RAJAL_NEXT_ACTION, RAJAL_NODE, RAJAL_PATIENT_OUTCOMES_EVIDENCE, RAJAL_PENUNJANG_NODES, readPatientOutcomes } from './nodes.js';

describe('rajal node facts', () => {
  it('names exactly the nodes of the workflow, so a rename fails here', () => {
    expect(Object.values(RAJAL_NODE).sort()).toEqual(rajalWorkflow.nodes.map((node) => node.id).sort());
  });

  it('gives advice and penunjang switches only for real nodes', () => {
    const ids = new Set(rajalWorkflow.nodes.map((node) => node.id));
    for (const id of [...Object.keys(RAJAL_NEXT_ACTION), ...RAJAL_PENUNJANG_NODES.map((n) => n.id)]) expect(ids.has(id)).toBe(true);
  });

  it('matches the evidence label emit_batch_summary emits', () => {
    // The executor still spells the label inline; this pins the reader to it until it adopts the constant.
    const source = readFileSync(new URL('./executors.ts', import.meta.url), 'utf8');
    expect(source).toContain(`label: '${RAJAL_PATIENT_OUTCOMES_EVIDENCE}'`);
  });

  it('reads outcome rows from an evidence list', () => {
    const rows = [{ patientId: '0-12-34-56', status: 'lolos', clinics: ['MATA'], transactions: ['T1'], reason: '' }];
    expect(readPatientOutcomes([{ label: 'other', data: {} }, { label: RAJAL_PATIENT_OUTCOMES_EVIDENCE, data: { rows } }])).toEqual(rows);
    expect(readPatientOutcomes([{ label: RAJAL_PATIENT_OUTCOMES_EVIDENCE, data: { rows: 'x' } }])).toBeUndefined();
    expect(readPatientOutcomes(undefined)).toBeUndefined();
  });
});
