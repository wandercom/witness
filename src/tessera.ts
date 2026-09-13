// Tessera audit hook integration.
//
// Tessera is the (planned) tamper-evident audit log of the Exemplar
// stack. Witness emits one event per decision lifecycle transition:
//   - decision.created
//   - decision.first_answered
//   - decision.closed (terminal: approved / rejected)
//   - decision.cancelled
//   - decision.context_changed
//   - decision.fallback_fired
//
// Real Tessera SDK doesn't exist yet (as of 2026-05). This file
// documents the contract and ships a no-op default + a stdout
// fallback so witness never silently drops audit. When @exemplar-stack/tessera
// publishes an SDK, consumers wire it via WitnessConfig.tessera.

import { logger } from './logger.js';
import type { TesseraClient, TesseraEvent } from './types.js';

/**
 * No-op client. Used when consumers explicitly disable audit (NOT the
 * default — see `defaultTesseraClient`).
 */
export class NoopTesseraClient implements TesseraClient {
  async emit(_event: TesseraEvent): Promise<void> {
    void _event;
  }
}

/**
 * Default audit client: writes Tessera events to the witness logger
 * at INFO. This is auditable (logs are persisted by the host) but
 * not tamper-evident — replace with a real Tessera SDK in production.
 */
export class StdoutTesseraClient implements TesseraClient {
  async emit(event: TesseraEvent): Promise<void> {
    logger.info('[tessera] event', {
      type: event.type,
      decisionId: event.decisionId,
      kind: event.kind,
      at: event.at,
      details: event.details,
    });
  }
}

/**
 * In-memory client. Useful for tests that want to assert Witness
 * emitted the right audit chain without setting up a real Tessera.
 */
export class InMemoryTesseraClient implements TesseraClient {
  readonly events: TesseraEvent[] = [];
  async emit(event: TesseraEvent): Promise<void> {
    this.events.push(event);
  }
  reset(): void {
    this.events.length = 0;
  }
}

export function defaultTesseraClient(): TesseraClient {
  return new StdoutTesseraClient();
}

/**
 * Helper: build a TesseraEvent for the given lifecycle transition.
 * Centralized so the API layer stays terse.
 */
export function buildEvent(
  type: TesseraEvent['type'],
  decisionId: string,
  kind: string,
  at: number,
  details: Record<string, unknown>,
): TesseraEvent {
  return { type, decisionId, kind, at, details };
}
