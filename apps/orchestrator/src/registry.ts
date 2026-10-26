/**
 * Workflow registry — maps workflow ids to their definition and an executor
 * factory. The orchestrator looks workflows up here when creating a run.
 *
 * Executors are built per-run because they close over a per-run client
 * (mode, transport, audit sink). In preview/demo mode without a configured
 * SIMRS, we fall back to a fixture-backed client so the UI works offline.
 */

import type { BerkasReaderPort } from '@simrs-flow/domain-ranap';
import type { ExecutorRegistry, WorkflowDefinition } from '@simrs-flow/workflow-core';
import {
  EvoMedisClient,
  FixtureTransport,
  type ClientMode,
  type CallRecord,
  type Transport,
} from '@simrs-flow/evomedis-client';
import { ranapWorkflow, createRanapExecutors } from '@simrs-flow/domain-ranap';
import { rajalWorkflow, createRajalExecutors } from '@simrs-flow/domain-rajal';
import { ranapFixtures, rajalFixtures } from '@simrs-flow/test-fixtures';

export interface ExecutorFactoryArgs {
  mode: ClientMode;
  /** Optional explicit transport; defaults to a fixture transport per domain. */
  transport?: Transport;
  onCall?: (record: CallRecord) => void;
  baseUrlV1?: string;
  baseUrlV2?: string;
  cookie?: string;
  /** Endpoint ids permitted to mutate in write mode (safety control #3). */
  mutationAllowlist?: string[];
  /** Claim bundle reader for the opt-in Kelengkapan Berkas step (live runs only). */
  berkas?: BerkasReaderPort;
}

export interface WorkflowEntry {
  definition: WorkflowDefinition;
  buildExecutors: (args: ExecutorFactoryArgs) => ExecutorRegistry;
  /**
   * Client used by `RunService`'s mutation gate to replay a plan's
   * preconditions and apply it. Built from the same args as the executors', so
   * the allowlist, mode and transport are identical — the gate cannot end up
   * with a laxer client than the run it belongs to.
   */
  createClient: (args: ExecutorFactoryArgs) => EvoMedisClient;
}

function makeClient(
  fixtures: Record<string, any>,
  args: ExecutorFactoryArgs,
): EvoMedisClient {
  const transport = args.transport ?? new FixtureTransport(fixtures);
  return new EvoMedisClient(
    {
      baseUrlV1: args.baseUrlV1 ?? 'https://simrs.invalid/offline/index.php',
      baseUrlV2: args.baseUrlV2,
      cookie: args.cookie ?? 'ci_session=offline-fixture',
    },
    {
      mode: args.mode,
      transport,
      onCall: args.onCall,
      mutationAllowlist: args.mutationAllowlist,
    },
  );
}

/**
 * `RanapDeps` for one run.
 *
 * `baseUrlV2` is forwarded separately from the client's own config because
 * `EvoMedisClient` keeps its `Session` private and silently falls back to
 * `baseUrlV1` for a `v2` endpoint — so `createRanapExecutors` has to be told
 * independently whether a v2 API exists before it issues the CPPT v2 reads.
 * Passing the client but not this left v2 off in the shipped orchestrator even
 * on a deployment that has one.
 *
 * An **absent** value stays absent: the property is omitted rather than set to
 * `undefined`, so `fetchCpptV2Rows` issues no read and `cpptV2RowsByNoReg` is
 * left out of the planner's arguments entirely. That is "no opinion about the
 * CPPT", not "v2 answered with nothing" — the difference decides whether a
 * specialist row without a matching note is deleted.
 */
function ranapDeps(args: ExecutorFactoryArgs): { client: EvoMedisClient; baseUrlV2?: string; berkas?: BerkasReaderPort } {
  const baseUrlV2 = args.baseUrlV2?.trim();
  return {
    client: makeClient(ranapFixtures, args),
    ...(baseUrlV2 ? { baseUrlV2 } : {}),
    ...(args.berkas ? { berkas: args.berkas } : {}),
  };
}

export const WORKFLOWS: Record<string, WorkflowEntry> = {
  [ranapWorkflow.id]: {
    definition: ranapWorkflow,
    buildExecutors: (args) => createRanapExecutors(ranapDeps(args)),
    createClient: (args) => makeClient(ranapFixtures, args),
  },
  [rajalWorkflow.id]: {
    definition: rajalWorkflow,
    buildExecutors: (args) => createRajalExecutors({ client: makeClient(rajalFixtures, args), ...(args.berkas ? { berkas: args.berkas } : {}) }),
    createClient: (args) => makeClient(rajalFixtures, args),
  },
};

export function listWorkflows(): WorkflowDefinition[] {
  return Object.values(WORKFLOWS).map((w) => w.definition);
}

export function getWorkflow(id: string): WorkflowEntry | undefined {
  return WORKFLOWS[id];
}
