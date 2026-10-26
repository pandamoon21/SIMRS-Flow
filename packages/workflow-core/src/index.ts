/**
 * @simrs-flow/workflow-core
 *
 * Headless, event-driven workflow engine. No UI, network, or Node-only deps.
 * The public surface is the contract shared by the runner, orchestrator,
 * domain packages, and React Flow UI.
 */

export * from './types.js';
export * from './ids.js';
export {
  evaluateExpectation,
  inferMatch,
  isEmptyish,
  looksLikeBackendError,
  numberOf,
  readField,
} from './expectations.js';
export type { Expectation, ExpectationMatch, ExpectationResult } from './expectations.js';
export { EventBus } from './eventBus.js';
export type { EventListener, EventBusOptions } from './eventBus.js';
export {
  initialRunState,
  applyEvent,
  reduceEvents,
  isTerminalStatus,
} from './reducer.js';
export {
  validateDefinition,
  indexNodes,
  outgoingEdges,
  edgeBetween,
  tryTopoSort,
  executionOrder,
} from './definition.js';
export type { ValidationProblem, ValidationResult } from './definition.js';
export { WorkflowRunner, runWorkflow } from './runner.js';
export type {
  RunnerOptions,
  RunResult,
  GateResolver,
  GateDecision,
  ReplanRequest,
  ReplanDecision,
  ReplanResolver,
} from './runner.js';
export { eventsToJsonl, jsonlToEvents, replayJsonl } from './jsonl.js';
export { REASONING_LABEL, reasoningEvidence, reasoningOf } from './reasoning.js';
export type { Reasoning, ReasoningItem } from './reasoning.js';
