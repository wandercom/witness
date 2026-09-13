// Surface dispatch + ACK-required delivery.
//
// Sim-vetted ADR-001 (section "Surface ACK pattern") rejects the
// escalation cascade ("dispatch to channel A; if no answer in
// timeout/2 dispatch to B; ...") as multi-channel spam. Correct fix:
// dispatch to all configured surfaces in parallel; the first surface
// to ACK marks the decision delivered. If no surface ACKs within the
// configured ackWindowMs (default 60s), witness fires the fallback
// (PD high-urgency, SMS to on-call, etc.).
//
// V1 ships a single `inboxSurface` stub that just logs. PagerDuty,
// Slack, email, and SMS are documented integration points (see
// docs/surface-integrations.md). Each future surface wires up two
// pieces:
//
//   1. A `SurfaceDispatcher` that delivers the decision (post a
//      message to Slack, page PD, send an email).
//   2. A webhook / callback the surface invokes to call witness's
//      `acknowledgeDelivery`. Slack might do this on a button click;
//      email on a reply; PD on first ack.

import { logger } from './logger.js';
import type {
  DecisionId,
  FallbackHook,
  SurfaceDispatcher,
  SurfaceName,
} from './types.js';

// ============================================================
// Default surface: in-memory inbox (V1 stub).
// ============================================================
//
// Witness's first consumer (Reeve operator queue) will register its
// own dispatcher that lights up the operator inbox row. Until then,
// this stub is what `surfaces: ['inbox']` in tests resolves to.

export const inboxSurface: SurfaceDispatcher = (info) => {
  logger.debug('[witness.surface.inbox] dispatch', {
    decisionId: info.decisionId,
    kind: info.kind,
    authorizedRoles: info.authorizedRoles,
  });
};

// ============================================================
// Documented stubs for future surfaces.
// ============================================================
//
// These are not registered by default; they exist so consumers see
// the contract before implementing. Real integrations live in
// downstream packages (e.g., @exemplar-stack/witness-slack, @exemplar-stack/witness-pd)
// to keep witness's core dep-free. Each stub throws to make
// "accidentally registered the stub" loud.

export const pagerdutySurfaceStub: SurfaceDispatcher = () => {
  throw new Error(
    'witness: PagerDuty surface is a documented stub. Implement and register your own dispatcher; see docs/surface-integrations.md.',
  );
};

export const slackSurfaceStub: SurfaceDispatcher = () => {
  throw new Error(
    'witness: Slack surface is a documented stub. Implement and register your own dispatcher; see docs/surface-integrations.md.',
  );
};

export const emailSurfaceStub: SurfaceDispatcher = () => {
  throw new Error(
    'witness: email surface is a documented stub. Implement and register your own dispatcher; see docs/surface-integrations.md.',
  );
};

export const smsSurfaceStub: SurfaceDispatcher = () => {
  throw new Error(
    'witness: SMS surface is a documented stub. Implement and register your own dispatcher; see docs/surface-integrations.md.',
  );
};

// ============================================================
// Dispatch + ACK fallback machinery.
// ============================================================

/**
 * Internal type carried inside the witness instance. Tracks the
 * pending fallback timer and whether the decision has been ACKed.
 */
export type AckTracker = {
  decisionId: DecisionId;
  timer: ReturnType<typeof setTimeout> | null;
  acked: boolean;
};

/**
 * Build a tracker for a freshly-dispatched decision. Returns the
 * tracker; the caller wires the timer's callback to fire the
 * fallback hook. The tracker's timer is null when ackWindowMs <= 0
 * (immediate fallback path) or > 0 with the timer scheduled.
 *
 * Caller is responsible for clearing the timer on ACK (see
 * markAcked) and for invoking `dispatchAll`.
 */
export function createAckTracker(decisionId: DecisionId): AckTracker {
  return { decisionId, timer: null, acked: false };
}

/**
 * Mark a tracker ACKed and clear its fallback timer.
 */
export function markAcked(tracker: AckTracker): void {
  tracker.acked = true;
  if (tracker.timer !== null) {
    clearTimeout(tracker.timer);
    tracker.timer = null;
  }
}

/**
 * Schedule the fallback hook to fire after ackWindowMs unless ACK
 * arrives first. Returns the same tracker for fluent chaining.
 */
export function scheduleFallback(
  tracker: AckTracker,
  ackWindowMs: number,
  fire: () => void | Promise<void>,
): AckTracker {
  if (ackWindowMs <= 0 || tracker.acked) return tracker;
  tracker.timer = setTimeout(() => {
    if (tracker.acked) return;
    void fire();
  }, ackWindowMs);
  // Don't keep the process alive just for fallback timers.
  if (typeof tracker.timer === 'object' && tracker.timer !== null && 'unref' in tracker.timer) {
    (tracker.timer as unknown as { unref: () => void }).unref();
  }
  return tracker;
}

/**
 * Dispatch a decision to every configured surface in parallel.
 * Surface failures are caught and logged; one bad surface must not
 * prevent the others from delivering.
 */
export async function dispatchAll(
  surfaces: ReadonlyArray<SurfaceName>,
  registry: Record<string, SurfaceDispatcher>,
  info: Parameters<SurfaceDispatcher>[0],
): Promise<void> {
  const work: Array<Promise<void>> = [];
  for (const name of surfaces) {
    const dispatcher = registry[name];
    if (!dispatcher) {
      logger.warn('[witness.surface] missing dispatcher', { surface: name, decisionId: info.decisionId });
      continue;
    }
    work.push(
      Promise.resolve()
        .then(() => dispatcher(info))
        .catch((err: unknown) => {
          logger.warn('[witness.surface] dispatch failed', {
            surface: name,
            decisionId: info.decisionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
    );
  }
  await Promise.allSettled(work);
}

/**
 * Default fallback hook: log and continue. Consumers should pass
 * their own; this stub is here so witness never silently drops a
 * "nobody saw it" event.
 */
export const defaultFallbackHook: FallbackHook = (info) => {
  logger.warn('[witness.fallback] no surface ACKed in ackWindowMs', {
    decisionId: info.decisionId,
    kind: info.kind,
    surfaces: info.surfaces,
    createdAt: info.createdAt,
  });
};
