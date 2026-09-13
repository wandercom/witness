// Public types for @exemplar-stack/witness.
//
// witness is a coordination primitive — it surfaces a decision, blocks
// the caller until a human answers, captures rationale, and writes
// audit. The types here are the contract every consumer of witness
// (Reeve operator queue, scram, covenant, signet) speaks.
//
// Two architectural decisions show up in these types:
//
// 1. State-based two-person window via `context_hash` (NOT a fixed
//    time window). The caller may pass a `context_provider` so
//    witness can hash predicate state at decision creation and
//    recompute on second-approval. Mismatch rejects the second
//    approval with reason "context_changed".
//
// 2. Surface ACK pattern. `ask` dispatches to all configured surfaces
//    in parallel; the FIRST surface to call back via
//    `acknowledgeDelivery` marks the decision delivered. If no surface
//    ACKs within the configured window, witness fires the fallback
//    (PagerDuty / SMS / whatever the "break glass" channel is).

/**
 * Stable ULID-style decision identifier. Opaque to callers; minted by
 * the persistence layer at decision creation.
 */
export type DecisionId = string;

/**
 * A surface a decision can be dispatched to. V1 ships an in-memory
 * `inbox` surface; PagerDuty / Slack / email / SMS are documented
 * extension points (see ts/src/surfaces.ts and docs/surface-integrations.md).
 */
export type SurfaceName = 'inbox' | 'pagerduty' | 'slack' | 'email' | 'sms' | (string & {});

/**
 * Result of a surface ACK call. Records which channel + which operator
 * (if known) saw the decision first.
 */
export type SurfaceAck = {
  decisionId: DecisionId;
  surface: SurfaceName;
  /** Optional: surface knew which human picked it up (Slack reaction, PD ack). */
  operator?: string;
  /** When the ACK was received. */
  ackedAt: number;
};

/**
 * The fallback fires when no configured surface ACKs within the
 * `ackWindowMs` after dispatch. Consumers wire this to whatever their
 * "break glass" channel is — PD high-urgency, SMS to on-call, etc.
 */
export type FallbackHook = (info: {
  decisionId: DecisionId;
  kind: string;
  surfaces: ReadonlyArray<SurfaceName>;
  createdAt: number;
}) => void | Promise<void>;

/**
 * Two-person policy for a given `kind`. V1 keeps policy in code; V2
 * may load from YAML at startup. The `requiresTwoPerson` flag is
 * snapshotted into the decision row at creation so policy changes
 * mid-flight can't relax an in-progress decision.
 */
export type TwoPersonPolicy = {
  /** When true, two distinct operators must answer for the decision to close. */
  requiresTwoPerson: boolean;
};

/**
 * The set of two-person policies indexed by `kind`. Defaults to
 * single-operator (false) for any kind not listed.
 */
export type TwoPersonPolicyMap = Readonly<Record<string, TwoPersonPolicy>>;

/**
 * A pending or completed decision. Exposed in `listOpen` and persisted
 * to the witness_decisions table.
 */
export type Decision<TInput = unknown, TOutput = unknown> = {
  id: DecisionId;
  kind: string;
  input: TInput;
  /** JSON-Schema-shaped object describing the answer's required shape. */
  responseShape: Record<string, unknown>;
  authorizedRoles: ReadonlyArray<string>;
  surfaces: ReadonlyArray<SurfaceName>;
  /** Snapshot of policy at creation time. */
  requiresTwoPerson: boolean;
  /** Hex SHA-256 over canonical JSON of context, if a context_provider was supplied. */
  contextHash: string | null;
  /** Soft escalation hint. UI / fallback hooks may consult this. */
  timeoutAt: number;
  /** First operator's answer (when given). */
  firstOperator: string | null;
  firstAt: number | null;
  firstRationale: string | null;
  firstAnswer: TOutput | null;
  /** Second operator's answer (when two-person policy applies). */
  secondOperator: string | null;
  secondAt: number | null;
  secondRationale: string | null;
  secondAnswer: TOutput | null;
  status: DecisionStatus;
  closedReason: string | null;
  createdAt: number;
  closedAt: number | null;
};

/**
 * Terminal and in-flight statuses.
 *
 * - `open`: dispatched; awaiting first answer (or, if two-person, awaiting second).
 * - `approved` / `rejected`: terminal; an operator gave the answer.
 *   The interpretation of "approved" vs "rejected" is encoded in the
 *   first/second `firstAnswer` payload — witness flips status based on
 *   the `decision` field if present, else `approved`. Consumers
 *   typically pass a boolean `approved` field in their answer.
 * - `cancelled`: caller (or operator) cancelled the request before resolution.
 * - `timeout`: declared a soft timeout; consumer policy decides.
 * - `context_changed`: second approval was rejected because the
 *   context_hash recomputed at second-answer time did not match the
 *   creation hash. The decision is closed; consumer must re-request.
 */
export type DecisionStatus =
  | 'open'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'timeout'
  | 'context_changed';

/**
 * Approval payload returned to a caller awaiting the human decision.
 * Mirrors the row's first/second answer in a single shape.
 */
export type Approval<TOutput = unknown> = {
  decisionId: DecisionId;
  decidedAt: number;
  decidedBy: string;
  rationale: string;
  output: TOutput;
  /** Set when two-person policy applied — the second operator's id. */
  coDecidedBy?: string;
  coDecidedAt?: number;
  coRationale?: string;
  status: 'approved' | 'rejected';
};

/**
 * Arguments to `witness.ask` / `witness.askAsync`.
 *
 * `contextProvider`, when supplied, is invoked at decision creation
 * (to seed `context_hash`) AND at second-operator answer time (to
 * verify the underlying state hasn't shifted). State-based two-person
 * windows live or die by this hook.
 */
export type AskArgs<TInput = unknown, TOutput = unknown> = {
  kind: string;
  input: TInput;
  responseShape: Record<string, unknown>;
  authorizedRoles: ReadonlyArray<string>;
  surfaces: ReadonlyArray<SurfaceName>;
  /** Soft escalation hint, ms from now. Defaults to 24h. */
  timeoutMs?: number;
  /**
   * Optional supplier of "predicate state + payload" to hash. Required
   * if the kind's two-person policy is true; ignored otherwise. Must
   * be deterministic — calling twice with the same world should
   * produce the same JSON.
   */
  contextProvider?: () => unknown;
  /** Phantom field carried through to typed approval. Not transmitted. */
  __outputType?: TOutput;
};

/**
 * Configuration for a witness instance. Most consumers will use
 * `createWitness({ ... })` from index.ts; this type is the source of
 * truth for what they may pass.
 */
export type WitnessConfig = {
  /** Per-kind two-person policy. Missing entries default to single-operator. */
  policies?: TwoPersonPolicyMap;
  /**
   * Surfaces to dispatch to. The map's keys are surface names
   * (`inbox`, `slack`, ...); each is a function invoked at dispatch
   * time. Any surface that learns a human saw the decision should
   * call witness.acknowledgeDelivery. The default config ships only
   * a no-op `inbox` surface; consumers register their own.
   */
  surfaces?: Record<string, SurfaceDispatcher>;
  /**
   * Fired if no surface ACKs within `ackWindowMs`. Wire to PD / SMS.
   */
  fallback?: FallbackHook;
  /** ACK window in ms. Default 60_000. */
  ackWindowMs?: number;
  /** Optional Tessera audit hook (see tessera.ts). */
  tessera?: TesseraClient;
  /** Test seam: override the clock. Defaults to Date.now. */
  now?: () => number;
};

/**
 * A surface dispatcher is invoked when a decision is created. It is
 * responsible for delivering the notification to its channel; the
 * channel — when a human picks up the decision — calls back via
 * witness.acknowledgeDelivery to mark the decision delivered.
 *
 * Returning a Promise is fine; witness does not await it. Surfaces
 * that need to fail loudly should log and not throw — surface failure
 * is not the caller's concern.
 */
export type SurfaceDispatcher = (info: {
  decisionId: DecisionId;
  kind: string;
  authorizedRoles: ReadonlyArray<string>;
  input: unknown;
  responseShape: Record<string, unknown>;
}) => void | Promise<void>;

/**
 * Tessera audit client contract. Witness emits one event per
 * answered/closed decision. If no Tessera SDK is wired, the default
 * `noopTessera()` client logs to stdout — Witness must not fail
 * because audit is unconfigured.
 */
export interface TesseraClient {
  emit(event: TesseraEvent): Promise<void>;
}

/**
 * The audit event Witness emits to Tessera. Tessera's hash chain
 * makes this tamper-evident; we don't replicate the chain here.
 */
export type TesseraEvent = {
  type:
    | 'witness.decision.created'
    | 'witness.decision.first_answered'
    | 'witness.decision.closed'
    | 'witness.decision.cancelled'
    | 'witness.decision.context_changed'
    | 'witness.decision.fallback_fired';
  decisionId: DecisionId;
  kind: string;
  at: number;
  /** Free-form details. The shape depends on `type`; consumers are robust to additions. */
  details: Record<string, unknown>;
};

/**
 * Result of the `answer()` API. Witness reports whether the decision
 * is now closed (single-operator answered, or second of two-person)
 * versus still awaiting the second approver.
 */
export type AnswerResult<TOutput = unknown> =
  | { status: 'awaiting-second'; decisionId: DecisionId }
  | { status: 'closed'; approval: Approval<TOutput> }
  | { status: 'context_changed'; decisionId: DecisionId; reason: 'context_changed' };

/**
 * Result of `cancel()`.
 */
export type CancelResult = {
  decisionId: DecisionId;
  status: 'cancelled';
};
