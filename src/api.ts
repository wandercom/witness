// Public API surface for @exemplar-stack/witness.
//
// Five operations callers need:
//   - ask:    block until human answers (resolves on terminal status)
//   - askAsync: register and continue; receive Approval via callback
//   - listOpen: hot path for operator UIs ("show me my queue")
//   - answer: an operator records their decision (first or second)
//   - cancel: caller (or operator) abandons the request
//
// Plus the surface-side ACK endpoint:
//   - acknowledgeDelivery: a surface confirms the decision was seen
//
// Everything is implemented on top of three lower-level modules:
//   - persistence (decision rows)
//   - two-person  (state-based context_hash)
//   - surfaces    (dispatch + ACK fallback)
// Plus an optional Tessera audit hook.

import { randomUUID } from 'node:crypto';
import { getStore } from './persistence.js';
import {
  contextHash as computeContextHash,
  contextStillMatches,
} from './two-person.js';
import {
  type AckTracker,
  createAckTracker,
  defaultFallbackHook,
  dispatchAll,
  inboxSurface,
  markAcked,
  scheduleFallback,
} from './surfaces.js';
import { buildEvent, defaultTesseraClient } from './tessera.js';
import type {
  AnswerResult,
  Approval,
  AskArgs,
  CancelResult,
  Decision,
  DecisionId,
  SurfaceDispatcher,
  TesseraClient,
  TwoPersonPolicyMap,
  WitnessConfig,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACK_WINDOW_MS = 60 * 1000;

/**
 * Internal pending callback registry: askAsync's onAnswered handlers
 * keyed by decision id. ask() implements the synchronous version on
 * top of this same registry by registering a resolver.
 */
type Pending<TOutput> = {
  onAnswered: (a: Approval<TOutput>) => void;
  /** Optional context provider so answer() can recompute hash for two-person. */
  contextProvider?: () => unknown;
};

export class WitnessInstance {
  private readonly policies: TwoPersonPolicyMap;
  private readonly surfaces: Record<string, SurfaceDispatcher>;
  private readonly fallback: NonNullable<WitnessConfig['fallback']>;
  private readonly ackWindowMs: number;
  private readonly tessera: TesseraClient;
  private readonly now: () => number;

  // Pending in-process callbacks. Keyed by decisionId. NOT persisted
  // — process restart drops them, but the decision row remains; new
  // process callers re-register via answer() or read via listOpen().
  private readonly pending = new Map<DecisionId, Pending<unknown>>();
  // ACK trackers per pending decision.
  private readonly trackers = new Map<DecisionId, AckTracker>();
  // Context providers stored at ask-time so two-person second-answer
  // can re-hash. Kept separate from `pending` so listOpen handles
  // cross-process restarts gracefully (no provider after restart →
  // the second answer's context match is verified by the caller
  // passing currentContext to answer() instead).
  private readonly contextProviders = new Map<DecisionId, () => unknown>();

  constructor(config: WitnessConfig = {}) {
    this.policies = config.policies ?? {};
    this.surfaces = { inbox: inboxSurface, ...(config.surfaces ?? {}) };
    this.fallback = config.fallback ?? defaultFallbackHook;
    this.ackWindowMs = config.ackWindowMs ?? DEFAULT_ACK_WINDOW_MS;
    this.tessera = config.tessera ?? defaultTesseraClient();
    this.now = config.now ?? Date.now;
  }

  // ============================================================
  // Core ask path.
  // ============================================================

  /**
   * Block until a human answers. Resolves with the Approval payload
   * when the decision reaches a terminal status (approved, rejected,
   * cancelled, timeout, or context_changed). For two-person decisions,
   * this is the SECOND operator's answer.
   */
  async ask<TIn, TOut>(args: AskArgs<TIn, TOut>): Promise<Approval<TOut>> {
    return new Promise((resolve, reject) => {
      this.askAsync(args, (approval) => {
        if (approval.status === 'approved' || approval.status === 'rejected') {
          resolve(approval);
        } else {
          reject(new Error(`witness.ask resolved as ${approval.status}`));
        }
      }).catch(reject);
    });
  }

  /**
   * Create the decision, dispatch to surfaces, register the callback,
   * return the decision id immediately. The callback fires when the
   * decision closes (approved / rejected / cancelled / context_changed).
   */
  async askAsync<TIn, TOut>(
    args: AskArgs<TIn, TOut>,
    onAnswered: (a: Approval<TOut>) => void,
  ): Promise<DecisionId> {
    const policy = this.policies[args.kind] ?? { requiresTwoPerson: false };
    const requiresTwoPerson = policy.requiresTwoPerson;
    if (requiresTwoPerson && !args.contextProvider) {
      throw new Error(
        `witness: kind '${args.kind}' requires two-person but no contextProvider was supplied. ` +
          `State-based two-person windows require a deterministic context snapshot.`,
      );
    }
    const id = randomUUID();
    const createdAt = this.now();
    const timeoutAt = createdAt + (args.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const ctxHash = args.contextProvider ? computeContextHash(args.contextProvider()) : null;

    const decision: Decision<TIn, TOut> = {
      id,
      kind: args.kind,
      input: args.input,
      responseShape: args.responseShape,
      authorizedRoles: args.authorizedRoles,
      surfaces: args.surfaces,
      requiresTwoPerson,
      contextHash: ctxHash,
      timeoutAt,
      firstOperator: null,
      firstAt: null,
      firstRationale: null,
      firstAnswer: null,
      secondOperator: null,
      secondAt: null,
      secondRationale: null,
      secondAnswer: null,
      status: 'open',
      closedReason: null,
      createdAt,
      closedAt: null,
    };
    await getStore().insert(decision);
    await this.tessera.emit(
      buildEvent('witness.decision.created', id, args.kind, createdAt, {
        authorizedRoles: args.authorizedRoles,
        surfaces: args.surfaces,
        requiresTwoPerson,
        contextHashed: ctxHash !== null,
      }),
    );

    // Register callback + context provider for the lifetime of this decision.
    this.pending.set(id, {
      onAnswered: onAnswered as (a: Approval<unknown>) => void,
      contextProvider: args.contextProvider,
    });
    if (args.contextProvider) {
      this.contextProviders.set(id, args.contextProvider);
    }

    // Surface dispatch + ACK fallback.
    const tracker = createAckTracker(id);
    this.trackers.set(id, tracker);
    scheduleFallback(tracker, this.ackWindowMs, async () => {
      // Mark the row so consumers can see no surface ACKed.
      await getStore().update(id, { fallbackFiredAt: this.now() });
      await this.tessera.emit(
        buildEvent('witness.decision.fallback_fired', id, args.kind, this.now(), {
          surfaces: args.surfaces,
          ackWindowMs: this.ackWindowMs,
        }),
      );
      await Promise.resolve(
        this.fallback({
          decisionId: id,
          kind: args.kind,
          surfaces: args.surfaces,
          createdAt,
        }),
      );
    });
    // Fire-and-forget surface dispatch; the surface webhook will ACK.
    void dispatchAll(args.surfaces, this.surfaces, {
      decisionId: id,
      kind: args.kind,
      authorizedRoles: args.authorizedRoles,
      input: args.input,
      responseShape: args.responseShape,
    });
    return id;
  }

  // ============================================================
  // Surface ACK.
  // ============================================================

  /**
   * Called by a surface when a human picks the decision up in that
   * channel. Idempotent: multiple ACKs against the same decision
   * record only the first. Returns the recorded ACK or null if the
   * decision is already closed / cancelled.
   */
  async acknowledgeDelivery(args: {
    decisionId: DecisionId;
    surface: string;
    operator?: string;
  }): Promise<{ accepted: boolean; alreadyAcked: boolean }> {
    const row = await getStore().get(args.decisionId);
    if (!row) return { accepted: false, alreadyAcked: false };
    if (row.status !== 'open') return { accepted: false, alreadyAcked: false };
    const tracker = this.trackers.get(args.decisionId);
    if (tracker) markAcked(tracker);
    // Persist via store update; if some other process beat us to it,
    // store.update returns null (no expectedStatus mismatch since we
    // didn't pass one — first ack wins by virtue of being a no-op
    // on subsequent calls).
    const updated = await getStore().update(args.decisionId, {
      ackAt: this.now(),
      ackSurface: args.surface,
      ackOperator: args.operator,
    });
    return { accepted: updated !== null, alreadyAcked: false };
  }

  // ============================================================
  // Operator answer path.
  // ============================================================

  /**
   * Record an operator's answer to a decision. The first call closes
   * the decision for single-operator kinds; for two-person kinds, it
   * leaves the decision open with `firstOperator` populated and a
   * SECOND distinct-operator call closes it.
   *
   * `currentContext` (optional) is used for two-person kinds: if the
   * stored context_hash doesn't match a hash of `currentContext`, the
   * SECOND answer is rejected with reason `context_changed` and the
   * decision is closed in the `context_changed` terminal status.
   * Callers that registered a `contextProvider` at askAsync time can
   * omit `currentContext`; witness will invoke the registered
   * provider.
   */
  async answer(args: {
    decisionId: DecisionId;
    operator: string;
    answer: Record<string, unknown>;
    rationale: string;
    /** Optional caller-supplied current context (overrides registered contextProvider). */
    currentContext?: unknown;
  }): Promise<AnswerResult> {
    if (!args.rationale || args.rationale.trim().length === 0) {
      throw new Error('witness.answer: rationale is required');
    }
    const row = await getStore().get(args.decisionId);
    if (!row) throw new Error(`witness.answer: decision ${args.decisionId} not found`);
    if (row.status !== 'open') {
      throw new Error(`witness.answer: decision ${args.decisionId} is ${row.status}, not open`);
    }
    const isFirst = row.firstOperator === null;
    if (isFirst) {
      return this.recordFirst(row, args);
    }
    if (row.firstOperator === args.operator) {
      throw new Error(
        `witness.answer: operator ${args.operator} already answered as first; second must be a different operator.`,
      );
    }
    return this.recordSecond(row, args);
  }

  private async recordFirst(
    row: Decision,
    args: {
      decisionId: DecisionId;
      operator: string;
      answer: Record<string, unknown>;
      rationale: string;
    },
  ): Promise<AnswerResult> {
    const at = this.now();
    const decided = decisionFromAnswer(args.answer);
    if (row.requiresTwoPerson) {
      const updated = await getStore().update(args.decisionId, {
        expectedStatus: 'open',
        firstOperator: args.operator,
        firstAt: at,
        firstRationale: args.rationale,
        firstAnswer: args.answer,
      });
      if (!updated) throw new Error('witness.answer: optimistic update conflict');
      await this.tessera.emit(
        buildEvent('witness.decision.first_answered', row.id, row.kind, at, {
          operator: args.operator,
          decision: decided,
        }),
      );
      return { status: 'awaiting-second', decisionId: row.id };
    }
    // Single-operator kind: first answer closes it.
    const updated = await getStore().update(args.decisionId, {
      expectedStatus: 'open',
      firstOperator: args.operator,
      firstAt: at,
      firstRationale: args.rationale,
      firstAnswer: args.answer,
      status: decided,
      closedAt: at,
    });
    if (!updated) throw new Error('witness.answer: optimistic update conflict');
    const approval: Approval = {
      decisionId: row.id,
      decidedAt: at,
      decidedBy: args.operator,
      rationale: args.rationale,
      output: args.answer,
      status: decided,
    };
    await this.tessera.emit(
      buildEvent('witness.decision.closed', row.id, row.kind, at, {
        decision: decided,
        operator: args.operator,
        twoPerson: false,
      }),
    );
    this.firePending(row.id, approval);
    return { status: 'closed', approval };
  }

  private async recordSecond(
    row: Decision,
    args: {
      decisionId: DecisionId;
      operator: string;
      answer: Record<string, unknown>;
      rationale: string;
      currentContext?: unknown;
    },
  ): Promise<AnswerResult> {
    const at = this.now();
    // Verify state-based two-person window via context_hash.
    if (row.contextHash) {
      const provider = args.currentContext !== undefined
        ? () => args.currentContext
        : this.contextProviders.get(row.id);
      if (!provider) {
        throw new Error(
          `witness.answer: decision ${row.id} requires context for second-approval validation but none was provided.`,
        );
      }
      const matches = contextStillMatches(row.contextHash, provider());
      if (!matches) {
        // Reject this second answer; close the decision in context_changed.
        const updated = await getStore().update(row.id, {
          expectedStatus: 'open',
          status: 'context_changed',
          closedAt: at,
          closedReason: 'context_changed',
        });
        if (!updated) throw new Error('witness.answer: optimistic update conflict');
        await this.tessera.emit(
          buildEvent('witness.decision.context_changed', row.id, row.kind, at, {
            firstOperator: row.firstOperator,
            secondAttempt: args.operator,
            storedHash: row.contextHash,
          }),
        );
        const rejection: Approval = {
          decisionId: row.id,
          decidedAt: at,
          decidedBy: args.operator,
          rationale: 'context changed since first approval; re-request decision under current state',
          output: { decision: 'rejected' as const, reason: 'context_changed' },
          status: 'rejected',
        };
        // Fire pending callback with rejection so awaiting callers unblock.
        this.firePending(row.id, rejection);
        return { status: 'context_changed', decisionId: row.id, reason: 'context_changed' };
      }
    }
    const decided = decisionFromAnswer(args.answer);
    const updated = await getStore().update(row.id, {
      expectedStatus: 'open',
      secondOperator: args.operator,
      secondAt: at,
      secondRationale: args.rationale,
      secondAnswer: args.answer,
      status: decided,
      closedAt: at,
    });
    if (!updated) throw new Error('witness.answer: optimistic update conflict');
    const approval: Approval = {
      decisionId: row.id,
      decidedAt: row.firstAt ?? at,
      decidedBy: row.firstOperator ?? '',
      rationale: row.firstRationale ?? '',
      output: row.firstAnswer ?? args.answer,
      coDecidedBy: args.operator,
      coDecidedAt: at,
      coRationale: args.rationale,
      status: decided,
    };
    await this.tessera.emit(
      buildEvent('witness.decision.closed', row.id, row.kind, at, {
        decision: decided,
        firstOperator: row.firstOperator,
        secondOperator: args.operator,
        twoPerson: true,
      }),
    );
    this.firePending(row.id, approval);
    return { status: 'closed', approval };
  }

  // ============================================================
  // List + cancel.
  // ============================================================

  async listOpen(authorizedFor: string | ReadonlyArray<string>): Promise<ReadonlyArray<Decision>> {
    const roles = typeof authorizedFor === 'string' ? [authorizedFor] : authorizedFor;
    return getStore().query({ status: 'open', authorizedFor: roles });
  }

  async getDecision(id: DecisionId): Promise<Decision | null> {
    return getStore().get(id);
  }

  async cancel(args: {
    decisionId: DecisionId;
    operator: string;
    reason: string;
  }): Promise<CancelResult> {
    if (!args.reason || args.reason.trim().length === 0) {
      throw new Error('witness.cancel: reason is required');
    }
    const at = this.now();
    const updated = await getStore().update(args.decisionId, {
      expectedStatus: 'open',
      status: 'cancelled',
      closedAt: at,
      closedReason: args.reason,
    });
    if (!updated) {
      const current = await getStore().get(args.decisionId);
      if (!current) throw new Error(`witness.cancel: decision ${args.decisionId} not found`);
      throw new Error(`witness.cancel: decision ${args.decisionId} is ${current.status}, not open`);
    }
    await this.tessera.emit(
      buildEvent('witness.decision.cancelled', args.decisionId, updated.kind, at, {
        operator: args.operator,
        reason: args.reason,
      }),
    );
    const approval: Approval = {
      decisionId: args.decisionId,
      decidedAt: at,
      decidedBy: args.operator,
      rationale: args.reason,
      output: { decision: 'rejected' as const, reason: 'cancelled' },
      status: 'rejected',
    };
    this.firePending(args.decisionId, approval);
    return { decisionId: args.decisionId, status: 'cancelled' };
  }

  // ============================================================
  // Pending callback dispatch.
  // ============================================================

  private firePending(id: DecisionId, approval: Approval): void {
    const slot = this.pending.get(id);
    this.pending.delete(id);
    this.contextProviders.delete(id);
    const tracker = this.trackers.get(id);
    if (tracker) markAcked(tracker);
    this.trackers.delete(id);
    if (slot) {
      try {
        slot.onAnswered(approval);
      } catch (err) {
        // A misbehaving caller callback must not corrupt witness's state.
        // Log and move on; the decision row already reflects truth.
        // (logger import would be circular; intentionally no-op here.)
        void err;
      }
    }
  }

  // ============================================================
  // Test seam.
  // ============================================================

  __test_pendingSize(): number {
    return this.pending.size;
  }
}

/**
 * Map an answer payload to a terminal status. Convention: the answer
 * MAY include a string `decision` field with value `approved` or
 * `rejected`. If absent, default to `approved` (the operator
 * answering at all is treated as approval).
 */
function decisionFromAnswer(answer: Record<string, unknown>): 'approved' | 'rejected' {
  const v = answer['decision'];
  if (v === 'rejected') return 'rejected';
  if (v === 'approved') return 'approved';
  // Convenience: a boolean `approved` field also works.
  if (answer['approved'] === false) return 'rejected';
  return 'approved';
}
