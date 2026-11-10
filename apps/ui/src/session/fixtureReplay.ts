/**
 * Synthetic run data for "Data contoh": the sample input the orchestrator's
 * fixture transport runs on, and the client-side replay stream used when there
 * is no orchestrator (or for write mode, which a sample must never run).
 *
 * `@simrs-flow/test-fixtures` is reached only through dynamic `import()` here,
 * so the fixtures land in their own chunk, fetched the first time an operator
 * asks for sample data, never in the main bundle.
 */

import type { RunInput } from '@simrs-flow/api-contract';
import type { WorkflowDefinition, WorkflowEvent } from '@simrs-flow/workflow-core';

const loadFixtures = () => import('@simrs-flow/test-fixtures');

/** The happy-path input the orchestrator's fixture transport is built around. */
export async function sampleInput(domain: string): Promise<RunInput> {
  const { RAJAL_HAPPY_INPUT, RANAP_HAPPY_INPUT } = await loadFixtures();
  return domain === 'rajal' ? RAJAL_HAPPY_INPUT : RANAP_HAPPY_INPUT;
}

/** Run id of a client-side replay; no server run ever carries it. */
export const replayRunId = (workflowId: string) => `offline-${workflowId}`;

/** A deterministic demo stream for `definition`, with example checklists. */
export async function replayStream(definition: WorkflowDefinition): Promise<WorkflowEvent[]> {
  const { mockEventStream } = await loadFixtures();
  // The fixture takes the IGD branch so the flexible view shows a path taken and one not taken.
  const poli = definition.edges.find((edge) => edge.source === 'detect_origin' && edge.target === 'process_poli');
  return mockEventStream(definition, {
    runId: replayRunId(definition.id),
    exampleReasoning: true,
    ...(poli ? { branches: { [poli.id]: 'skip' as const }, skip: [poli.target] } : {}),
  });
}
