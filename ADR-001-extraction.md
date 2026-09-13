# ADR-001: witness architecture

**Status:** Accepted (2026-05-06; Claude/Codex/sim collaboration)
**Source spec:** `~/WanderRepos/repos/witness/SPEC.md`

## Context

witness is the human-in-the-loop coordination primitive. Surfaces
decisions requiring human judgment, blocks execution until
approval/rejection, captures rationale, escalates on timeout.

Reeve has an operator review queue today (`flag_for_human_review`
action) — that's witness's first consumer. The review-queue impl
becomes a witness consumer; the primitive itself extracts.

## Decision

**TypeScript, hosted standalone (or as a shared library —
configurable). Decision lifecycle in pg. Surface integrations
(operator inbox, PagerDuty, Slack, email) as separate consumers of
witness's listOpen + answer APIs. Two-person rule per `kind`.**

### Why TypeScript

- Reeve's operator queue is TS; first consumer. Same language
  reduces translation cost.
- Future TS consumers (Apprentice's skill-feedback flows, possible
  Chronicler review) all live in TS.
- Python consumers (Baton, Sentinel, scram) call witness via HTTP
  API — latency is acceptable for human-decision flows (witness is
  off-path; humans take seconds-to-hours).

### Library or service?

V1: **library**. The same TS module exports the API; Reeve embeds
witness as `@exemplar-stack/witness` and uses pg for storage. Python
consumers (scram for two-person rule) hit a small HTTP service
exposed by witness-server (a thin wrapper Reeve runs).

V2 if needed: standalone service with full HTTP API. Migration is
trivial because the storage already lives in pg.

### Repo layout

```
~/WanderRepos/repos/witness/
├── SPEC.md
├── ADR-001-extraction.md
├── package.json                # @exemplar-stack/witness
├── pyproject.toml              # for scram + Python consumers
├── ts/
│   ├── src/
│   │   ├── types.ts            # Decision, Approval, two-person policy
│   │   ├── persistence.ts      # pg writes/reads for witness_decisions
│   │   ├── api.ts              # public ask/answer/listOpen
│   │   ├── two-person.ts       # second-operator enforcement
│   │   ├── tessera.ts          # audit hook integration
│   │   └── index.ts
│   ├── tests/
│   ├── server/                 # optional HTTP wrapper for non-TS clients
│   │   └── http.ts             # Hono routes mirroring the TS API
│   └── package.json
├── py/
│   └── src/witness_client/
│       ├── __init__.py
│       ├── client.py           # HTTP client for Python consumers
│       └── types.py            # Pydantic models matching TS types
├── migrations/
│   └── 001_witness_decisions.sql
├── docs/
│   ├── two-person-policy.md
│   └── surface-integrations.md
└── README.md
```

### Schema

```sql
CREATE TABLE witness_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable kind identifier (e.g., 'reeve.action.review',
  -- 'scram.confirm', 'covenant.frr.preflight'). Drives policy.
  kind            text NOT NULL,
  -- Original input that triggered the decision. JSON; opaque to witness.
  input           jsonb NOT NULL,
  -- Schema for the response body — what shape the operator's answer
  -- must match.
  response_shape  jsonb NOT NULL,
  -- Roles authorized to answer (e.g., 'reeve.owner', 'scram.operator').
  authorized_roles text[] NOT NULL,
  -- Surface integrations to notify (inbox, pagerduty, slack, email).
  surfaces        text[] NOT NULL,
  -- Timeout for first answer.
  timeout_at      timestamptz NOT NULL,
  -- First operator's answer (when given).
  first_operator  text,
  first_at        timestamptz,
  first_rationale text,
  first_answer    jsonb,
  -- Second operator's answer (when two-person required).
  second_operator text,
  second_at       timestamptz,
  second_rationale text,
  -- Final disposition.
  status          text NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'approved', 'rejected', 'timeout', 'escalated')
  ),
  created_at      timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);

CREATE INDEX witness_decisions_open_idx
  ON witness_decisions (status, timeout_at)
  WHERE status = 'open';

CREATE INDEX witness_decisions_kind_idx
  ON witness_decisions (kind, created_at DESC);
```

### Two-person policy

Per `kind`, configured in code (V1) or in a YAML loaded at startup (V2):

```typescript
const TWO_PERSON_POLICY: Record<string, boolean> = {
  'reeve.action.review': false,           // single-operator OK
  'scram.confirm-tenant-quarantine': false,  // tenant-scoped
  'scram.confirm-global-readonly': true,  // cluster-wide; two-person
  'scram.confirm-rollback': true,         // canary rollback; two-person
  'covenant.frr.preflight': true,         // prod deploy gate; two-person
};
```

Enforcement: `answer()` records the FIRST answer. If the kind
requires two-person, decision stays `open` until a second operator
calls `answer()` with a DIFFERENT operator id. Only then status
flips to `approved` / `rejected`.

### Two-person window: STATE-BASED, not time-based (sim-vetted)

The validity window for a partial two-person approval is NOT a
fixed time window (5min/forever both wrong). Instead: each decision
stores `context_hash` (hash of predicate state + action payload) at
creation. When the second operator answers, witness re-computes the
context_hash from CURRENT state. If it matches, approval is valid.
If it differs, the second answer is REJECTED with "context changed
since first approval; re-request decision."

This solves both edge cases:
- **The "09:00 + 17:00" anti-pattern**: If the emergency that
  triggered the decision is over by 17:00, context_hash differs and
  the second approval fails. Operators must re-request under
  current state.
- **The "senior in meeting" case**: As long as the underlying
  emergency persists (predicate state + action payload unchanged),
  the approval window stays open indefinitely. No artificial
  timeout pressure.

Implementation: requesters pass a `context_provider: () => any`
function to witness.ask. witness hashes the context's JSON
representation at decision creation and at second-approval time.
Approval is rejected if hashes differ.

### Surface ACK pattern (sim-vetted)

Sim rejected "escalate to next surface after timeout/2" as multi-
channel spam. Correct fix: **first surface to ACK marks delivered**.

Flow:
1. witness.askAsync dispatches the decision to all configured
   surfaces (Slack, email, PagerDuty).
2. Each surface, on receiving the dispatch, calls
   `POST /v1/decisions/<id>/ack` to mark the decision as "seen by a
   human in this channel."
3. If no surface ACKs within 60 seconds, witness fires a fallback
   (SMS to on-call, PagerDuty high-urgency incident, whatever the
   "break glass" channel is).
4. Once any surface ACKs, witness logs the channel + operator id;
   the decision proceeds normally toward `answer()`.

This separates "message sent" from "human knows." ACK is cheap
(single HTTP from Slack bot / email webhook / PD integration) and
catches the "nobody's home" case without spamming all channels.

### API (TypeScript surface)

```typescript
export interface Witness {
  ask<TIn, TOut>(decision: Decision<TIn, TOut>): Promise<Approval<TOut>>;
  askAsync<TIn, TOut>(
    decision: Decision<TIn, TOut>,
    onAnswered: (a: Approval<TOut>) => void,
  ): Promise<DecisionId>;
  listOpen(authorizedFor: string): Promise<readonly Decision<unknown, unknown>[]>;
  answer(args: {
    decisionId: string;
    operator: string;
    answer: unknown;
    rationale: string;
  }): Promise<{ status: 'awaiting-second' | 'closed'; approval?: Approval<unknown> }>;
  cancel(decisionId: string, operator: string, reason: string): Promise<void>;
}
```

### Surface integrations

witness exposes `listOpen(authorizedFor)` and `answer(args)`. Each
surface (Reeve's HTMX inbox, a future PagerDuty webhook, a Slack
slash command, an email-reply parser) is a separate consumer.
Witness doesn't render UI; that's the surface's job.

### Reeve integration (Wave 3)

Reeve's existing `flag_for_human_review` action:
1. Today: writes a row to Reeve's `actions` table; operator UI reads
   from that table.
2. After migration: writes a witness decision via
   `witness.askAsync(...)`; operator UI reads from
   `witness.listOpen(authorizedFor: tenant.owner)`. Same UX, new
   storage.

Existing actions table doesn't go away — it stores the
post-approval action lifecycle. witness owns the human-decision
gate; actions table owns the resulting work.

## Consequences

**Positive**
- One primitive for all stack-wide HITL flows (Reeve review,
  scram two-person, covenant FRR sign-off).
- Audit-trail in tessera (every answered decision).
- Surface decoupling: any UI/notification system consumes the same
  API.

**Negative**
- One more pg table; one more dep for Reeve to migrate to.
- Two-person policy management in code (V1) means policy changes
  require deploy. V2 externalizes.

## Migration plan

1. Init `~/WanderRepos/repos/witness/`.
2. Schema migration applied (decide: shared with Reeve's DB OR
   dedicated witness DB).
3. Implement TS API + persistence + two-person.
4. Implement HTTP wrapper at `ts/server/http.ts` for Python clients.
5. Build Python client at `py/src/witness_client/`.
6. Reeve migration (Wave 3 task): refactor `flag_for_human_review`
   to call witness.askAsync; operator UI consumes
   witness.listOpen.
7. scram integration (Wave 2 dependency): scram dispatch fires
   witness.ask for two-person actions before dispatching.

## Open questions

- DB hosting: dedicated witness DB or co-located with Reeve's? Lean
  co-located in V1 (one less Postgres to operate); extract when a
  second non-Reeve consumer needs it.
- Surface registration: V1 has Reeve inbox only. PagerDuty / Slack /
  email surfaces are stubs documented in
  `docs/surface-integrations.md`; implement when first consumer
  needs them.
- Operator authentication: witness assumes the caller passes
  authenticated operator id. Auth is the surface's responsibility,
  not witness's. Document the contract.
