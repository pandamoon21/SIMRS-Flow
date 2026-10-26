/**
 * @simrs-flow/evomedis-client
 *
 * Typed, safety-gated client for EvoMedis/SIMRS.
 */

export {
  ENDPOINTS,
  getEndpoint,
  endpointLabel,
  mutatingEndpointIds,
  isMutating,
} from './endpoints.js';
export type {
  EndpointDef,
  EndpointId,
  EndpointKind,
  EndpointRisk,
  EndpointApi,
  ResponseShape,
} from './endpoints.js';

export { EvoMedisClient } from './client.js';
export type { ClientMode, ClientOptions, CallOptions, CallRecord } from './client.js';

export { Session } from './session.js';
export type { SessionConfig } from './session.js';

export {
  FetchTransport,
  FixtureTransport,
} from './transport.js';
export type {
  Transport,
  TransportRequest,
  TransportResponse,
  FixtureEntry,
} from './transport.js';

export {
  parseJson,
  parseText,
  looksLikeLogin,
  looksLikePhpError,
  normalizeDate,
  noKkRejectionReason,
  normalizeCardNumber,
} from './parsers.js';

export {
  EvoMedisError,
  UnknownEndpointError,
  MutationBlockedInPreviewError,
  MutationNotAllowlistedError,
  MutationNotApprovedError,
  SessionExpiredError,
  LoginFailedError,
  UnexpectedResponseError,
  TransportError,
  describeResponse,
} from './errors.js';
