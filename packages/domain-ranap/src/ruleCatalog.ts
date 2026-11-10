/**
 * The ranap rule catalog: the node declarations in `outcomes.ts`, in workflow
 * order, with the metadata of every endpoint they touch. Pure data, served
 * through the `contract` subpath to the Rules page and the orchestrator.
 */

import { buildRuleCatalog } from '@simrs-flow/workflow-core';
import type { RuleCatalog } from '@simrs-flow/workflow-core';
import { ENDPOINTS } from '@simrs-flow/evomedis-client/endpoints';
import { RANAP_OUTCOMES } from './outcomes.js';
import { ranapWorkflow } from './workflow.js';

export const ranapRuleCatalog: RuleCatalog = buildRuleCatalog(ranapWorkflow, RANAP_OUTCOMES, ENDPOINTS);
