import { describe, expect, it } from 'vitest';
import { ranapWorkflow } from './workflow.js';
import { RANAP_NEXT_ACTION, RANAP_NODE, readBerkasProgress, readTitipan } from './nodes.js';
import { RANAP_VERIFY_OFF } from './input.js';

describe('ranap node facts', () => {
  it('names exactly the nodes of the workflow, so a rename fails here', () => {
    expect(Object.values(RANAP_NODE).sort()).toEqual(ranapWorkflow.nodes.map((node) => node.id).sort());
  });

  it('gives next-action advice and verify-off switches only for real nodes', () => {
    const ids = new Set(ranapWorkflow.nodes.map((node) => node.id));
    for (const id of [...Object.keys(RANAP_NEXT_ACTION), ...Object.keys(RANAP_VERIFY_OFF)]) expect(ids.has(id)).toBe(true);
  });

  it('reads berkas progress from log data and ignores other data', () => {
    expect(readBerkasProgress({ berkasProgress: { phase: 'ocr', done: 2, total: 5, label: 'OCR 2/5' } })).toEqual({ phase: 'ocr', done: 2, total: 5, label: 'OCR 2/5' });
    expect(readBerkasProgress({ other: 1 })).toBeUndefined();
    expect(readBerkasProgress(undefined)).toBeUndefined();
  });

  it('reads titipan evidence', () => {
    expect(readTitipan([{ isTitipan: false }, { isTitipan: true }])).toBe(true);
    expect(readTitipan([{ isTitipan: false }])).toBe(false);
    expect(readTitipan(undefined)).toBe(false);
  });
});
