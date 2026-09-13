# Two-person policy

witness supports per-`kind` two-person rules. When a kind is marked
`requiresTwoPerson: true`, a decision of that kind stays open after
the first operator answers; a SECOND distinct operator must answer
before the decision closes.

## State-based window (NOT time-based)

ADR-001 (sim-vetted) chose a state-based validity window over a
fixed time window. The argument:

- A 5-minute window is too short ("senior operator is in a meeting,
  emergency stays unresolved").
- A "no expiration" window is too lax ("emergency at 09:00,
  approved at 17:00 when the predicate state is no longer true").

The fix: at decision creation, witness hashes a caller-supplied
context snapshot (predicate state + action payload) into a SHA-256
hex digest. At second-operator answer time, witness re-computes the
hash from the current context. If the hashes match, the second
approval is valid; if they differ, the second answer is rejected
with reason `context_changed` and the decision closes in terminal
status `context_changed`. The consumer must re-request under fresh
state.

## Configuring policies (V1)

V1 policy is in code. Pass a `policies` map to `createWitness`:

```typescript
import { createWitness } from '@exemplar-stack/witness';

const witness = createWitness({
  policies: {
    'reeve.action.review':           { requiresTwoPerson: false },
    'scram.confirm-tenant-quarantine': { requiresTwoPerson: false },
    'scram.confirm-global-readonly': { requiresTwoPerson: true },
    'scram.confirm-rollback':        { requiresTwoPerson: true },
    'covenant.frr.preflight':        { requiresTwoPerson: true },
    'signet.rule-change':            { requiresTwoPerson: true },
  },
});
```

A kind missing from the map defaults to `requiresTwoPerson: false`.

## Configuring policies (V2 — YAML)

V2 plans a YAML file loaded at process startup. Sketch:

```yaml
policies:
  reeve.action.review:
    requires_two_person: false
  scram.confirm-global-readonly:
    requires_two_person: true
  covenant.frr.preflight:
    requires_two_person: true
```

YAML is V2 because:
1. V1 has one consumer (Reeve) with a small kind set; YAML adds
   schema-validation and parsing overhead for no win.
2. Operator-modifiable policy is a sensitive change; we want to lock
   the policy semantics in tests before exposing a config surface.

## Caller responsibilities

For two-person kinds, the caller MUST pass a `contextProvider`
function to `witness.askAsync`. The provider is invoked twice:

1. At decision creation time, to seed `context_hash`.
2. At second-operator answer time (if the caller didn't pass a
   `currentContext` to `answer()`), to recompute the hash and
   validate the window.

The provider must be deterministic — calling it twice in the same
predicate state must produce the same JSON. If the underlying state
is in pg, the typical pattern is:

```typescript
const id = await witness.askAsync(
  {
    kind: 'scram.confirm-global-readonly',
    input: { reason: 'burn-rate spike' },
    responseShape: { decision: 'string' },
    authorizedRoles: ['scram.operator'],
    surfaces: ['inbox', 'pagerduty'],
    contextProvider: () => ({
      phase: getCurrentPhase(),     // pure read
      offenders: getOffendingTenants(), // pure read
    }),
  },
  (approval) => { /* ... */ },
);
```

## Same-operator second answer

A second answer from the same operator who provided the first is
rejected with an error. The two-person rule requires two DISTINCT
humans; witness enforces this at the API boundary.
