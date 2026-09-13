// Public surface for @exemplar-stack/witness.
//
// V1: TypeScript library + thin HTTP server.
//   - Library: `import { createWitness } from '@exemplar-stack/witness';`
//   - Server: `import { buildHttpServer } from '@exemplar-stack/witness/server';`
//
// Consumers in TypeScript (Reeve operator queue, future TS clients)
// embed the library directly. Consumers in Python (scram, baton,
// sentinel) hit the HTTP server and use the @exemplar-stack/witness-client
// Python package.

export type {
  AnswerResult,
  Approval,
  AskArgs,
  CancelResult,
  Decision,
  DecisionId,
  DecisionStatus,
  FallbackHook,
  SurfaceAck,
  SurfaceDispatcher,
  SurfaceName,
  TesseraClient,
  TesseraEvent,
  TwoPersonPolicy,
  TwoPersonPolicyMap,
  WitnessConfig,
} from './types.js';

export { WitnessInstance } from './api.js';
export type { DecisionStore, DecisionQuery, DecisionUpdate } from './persistence.js';
export { setStore, getStore, __resetInMemoryStore } from './persistence.js';
export { contextHash, canonicalJson, contextStillMatches } from './two-person.js';
export {
  inboxSurface,
  pagerdutySurfaceStub,
  slackSurfaceStub,
  emailSurfaceStub,
  smsSurfaceStub,
  defaultFallbackHook,
} from './surfaces.js';
export {
  NoopTesseraClient,
  StdoutTesseraClient,
  InMemoryTesseraClient,
  defaultTesseraClient,
  buildEvent,
} from './tessera.js';
export { setLogger } from './logger.js';
export type { Logger } from './logger.js';

import { WitnessInstance } from './api.js';
import type { WitnessConfig } from './types.js';

/**
 * Build a witness instance with the given configuration. Callers
 * typically build one per process and reuse it. The default
 * configuration ships an in-memory store + inbox surface + stdout
 * Tessera; production consumers swap each via WitnessConfig.
 */
export function createWitness(config: WitnessConfig = {}): WitnessInstance {
  return new WitnessInstance(config);
}
