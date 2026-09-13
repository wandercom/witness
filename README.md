# witness

Human-in-the-loop coordination primitive for the Exemplar stack.

witness surfaces decisions requiring human judgment, blocks execution
until approval/rejection, captures rationale, and writes audit. It's
the cross-stack home for the HITL pattern Reeve currently implements
ad-hoc inside the operator review queue. The operator review queue
becomes a CONSUMER of witness, not the implementation of it.

## Why witness exists

Every component in the Exemplar stack needs to ask for human approval
at some point:

- **scram** — operator confirmation for non-automatic kill actions.
- **covenant** — pre-flight checklist sign-off for prod deploys.
- **signet** — rule-change codeowner approval.
- **reeve** — operator review queue, role-change approval.
- **apprentice** — skill-feedback flows.

A Reeve-internal "operator review queue" can't serve those callers;
witness can. See `SPEC.md` and `ADR-001-extraction.md` for the full
charter.

## Architecture

V1 is a TypeScript library + thin HTTP server.

- **TypeScript library** (`@exemplar-stack/witness`): Reeve and other TS
  consumers embed witness directly. Pluggable persistence (in-memory
  store ships by default; pg store wired by the consumer).
- **HTTP server** (`@exemplar-stack/witness/server`): a thin Hono wrapper that
  exposes the TS API to non-TS clients (Python: scram, baton,
  sentinel).
- **Python client** (`witness-client`): async httpx client with
  Pydantic models matching the TS shapes.

## TypeScript usage

Install from the GitHub repo. The package's `prepare` script runs
`tsc → dist/` at install time, so consumers get a fully built
package with `.d.ts` files.

```json
{
  "dependencies": {
    "@exemplar-stack/witness": "git+https://github.com/wandercom/witness.git#v0.1.1"
  }
}
```

V2 may extract a standalone service if the operational footprint of
embedding witness in every TS consumer becomes a problem; storage
already lives in pg, so migration is mechanical.

## Two architecturally load-bearing decisions

### State-based two-person window via `context_hash`

ADR-001 (sim-vetted) rejects time-based two-person windows. Instead,
witness hashes a caller-supplied context snapshot (predicate state +
action payload) at decision creation; at second-operator answer time,
the hash is recomputed and compared. Match → second approval valid;
mismatch → decision closes in terminal status `context_changed`,
caller re-requests under fresh state.

This solves the "09:00 + 17:00" anti-pattern AND the "senior in a
meeting" case without an artificial timeout.

### ACK-required surface delivery

ADR-001 rejects an escalation cascade as multi-channel spam. Instead,
witness dispatches to all configured surfaces in parallel; the first
surface to ACK marks the decision delivered. If no surface ACKs
within 60 seconds (configurable), witness fires a fallback hook
(consumer wires this to PD high-urgency, SMS to on-call, etc.).

## Quickstart (TypeScript library)

Development checks use Vitest 5 and require Node.js 22.x (>=22.12), 24.x, or 26+. Use Node 22 LTS for the documented test commands; the package runtime requirement is unchanged.

```typescript
import { createWitness } from '@exemplar-stack/witness';

const witness = createWitness({
  policies: {
    'reeve.action.review':           { requiresTwoPerson: false },
    'scram.confirm-global-readonly': { requiresTwoPerson: true },
  },
  surfaces: {
    inbox: inboxSurface,
    slack: slackSurface,
  },
  fallback: async (info) => {
    await pdClient.page({ urgency: 'high', decisionId: info.decisionId });
  },
});

// Single-operator decision (no contextProvider needed):
const approval = await witness.ask({
  kind: 'reeve.action.review',
  input: { actionType: 'send_email_reply', to: 'c@example.com' },
  responseShape: { decision: 'string' },
  authorizedRoles: ['reeve.owner'],
  surfaces: ['inbox'],
});
console.log(approval.status, approval.decidedBy);

// Two-person decision (requires contextProvider):
const id = await witness.askAsync(
  {
    kind: 'scram.confirm-global-readonly',
    input: { reason: 'burn-rate spike' },
    responseShape: { decision: 'string' },
    authorizedRoles: ['scram.operator'],
    surfaces: ['inbox', 'pagerduty'],
    contextProvider: () => ({
      phase: getCurrentPhase(),
      offenders: getOffendingTenants(),
    }),
  },
  (approval) => { /* fires when both operators answer */ },
);
```

## Quickstart (Python client)

```python
from witness_client import WitnessClient

async with WitnessClient(base_url="http://localhost:8787") as w:
    decision_id = await w.ask(
        kind="scram.confirm-global-readonly",
        input={"reason": "burn-rate spike"},
        response_shape={"decision": "string"},
        authorized_roles=["scram.operator"],
        surfaces=["inbox", "pagerduty"],
        context_snapshot={"phase": "emergency", "tenants": ["a", "b"]},
    )
    # ... later, when first operator answers:
    result = await w.answer(
        decision_id=decision_id,
        operator="op-1",
        answer={"decision": "approved"},
        rationale="burn rate confirmed; quarantining",
    )
    # result.status == "awaiting-second" for two-person kinds
```

## Repo layout

```
~/WanderRepos/repos/witness/
  SPEC.md                     # charter
  ADR-001-extraction.md       # architecture lock (sim-vetted)
  README.md                   # this file
  package.json                # @exemplar-stack/witness (TS package, root-level)
  tsconfig.json
  tsconfig.build.json         # `prepare` emits dist/ via this
  migrations/
    001_witness_decisions.sql # canonical schema for the pg-backed store
  src/
    types.ts                  # Decision, Approval, WitnessConfig, ...
    persistence.ts            # pluggable DecisionStore (default: in-memory)
    two-person.ts             # canonicalJson + SHA-256 context_hash
    surfaces.ts               # dispatch + ACK + fallback machinery
    tessera.ts                # audit hook integration
    logger.ts                 # minimal structured logger
    api.ts                    # WitnessInstance (ask / askAsync / listOpen / answer / cancel)
    index.ts                  # public surface
  server/
    http.ts                   # Hono routes for non-TS clients
  tests/
    test_two_person_state_based.test.ts
    test_surface_ack.test.ts
    test_api.test.ts
  py/
    pyproject.toml
    src/witness_client/
      __init__.py
      types.py                # Pydantic models matching TS types
      client.py               # async httpx client
    tests/
      conftest.py             # spawns the TS server for the test session
      test_client.py          # roundtrip tests
  docs/
    two-person-policy.md      # state-based window contract; V1 in code, V2 YAML
    surface-integrations.md   # surface contract + V1 stubs vs real
```

## Workflow

```bash
# Install + test (TS)
npm install
npm test

# Install + test (Python)
cd py
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest

# Run the HTTP server locally
cd ts && npx tsx server/http.ts
curl http://localhost:8787/v1/health
```

## Two-person policy YAML format (planned for V2)

```yaml
# witness-policies.yaml — loaded at process startup
policies:
  reeve.action.review:
    requires_two_person: false
  scram.confirm-tenant-quarantine:
    requires_two_person: false
  scram.confirm-global-readonly:
    requires_two_person: true
  covenant.frr.preflight:
    requires_two_person: true
```

V1 uses code-defined policy passed to `createWitness({ policies: ... })`;
see `docs/two-person-policy.md` for the contract.

## Surface integration extension points

V1 ships a logging `inbox` stub. PagerDuty, Slack, email, SMS are
documented stubs that throw on dispatch — register your own
`SurfaceDispatcher` per the contract in
`docs/surface-integrations.md`.

## Audit (Tessera)

Witness emits one Tessera event per decision lifecycle transition
(`witness.decision.created`, `.first_answered`, `.closed`,
`.cancelled`, `.context_changed`, `.fallback_fired`). The default
client logs to stderr; production consumers wire a real Tessera SDK
when one ships. See `src/tessera.ts` for the contract.

## Deployment story

V1: embed in your TS consumer process. The witness library is
in-process; persistence is pluggable (default in-memory; consumers
register a pg-backed store via `setStore({...})`). The thin HTTP
server is a separate process for Python clients.

V2 (when needed): standalone service exposing only the HTTP API.
Storage already lives in pg; migration is mechanical.

## Roadmap

- **V1 (this commit):** TS library + HTTP server + Python client +
  in-memory store + Tessera stubs + state-based two-person + ACK
  fallback.
- **Wave 2 (scram):** scram dispatch fires `witness.ask` for
  two-person actions before dispatching kills.
- **Wave 3 (Reeve migration):** Reeve operator review queue migrates
  to witness. UI unchanged; underlying call shape moves.
- **V2:** YAML policy loader, real Tessera SDK wiring, optional
  standalone service mode, surface-package registry.

## License

MIT. See LICENSE (TBD).
