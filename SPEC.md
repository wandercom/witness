# witness — Human-in-the-Loop Coordination Primitive

## Charter

Surface decisions requiring human judgment, block execution until
approval/rejection is received, capture the human's rationale, and
escalate when no response arrives within the declared timeout.

witness is the cross-stack home for the human-in-the-loop pattern
Reeve currently implements ad-hoc inside the operator review queue.
The operator review queue becomes a CONSUMER of witness, not the
implementation of it.

The split matters because every component in the stack needs to ask
for human approval at some point: scram needs operator confirmation
for non-automatic kill actions; covenant's pre-flight checklist needs
human go/no-go before prod deploys; signet rule changes need
codeowner sign-off. A Reeve-internal "operator review queue" can't
serve those callers; witness can.

## Interface (proposed)

```typescript
export type Decision<TInput, TOutput> = {
  id: string;                          // stable ULID
  kind: string;                        // e.g., 'scram-confirm', 'covenant-frr', 'reeve-action-review'
  input: TInput;                       // the decision context (typed via covenant)
  // What the operator can answer.
  responseShape: SchemaObject;
  // How long until escalation.
  timeoutMs: number;
  // Where to surface the decision to the operator.
  surfaces: ReadonlyArray<'inbox' | 'pagerduty' | 'slack' | 'email'>;
  // Authorization: who can answer this. Codeowner-style.
  authorizedRoles: ReadonlyArray<string>;
  // Required: who to escalate to if timeout expires.
  escalateTo: ReadonlyArray<string>;
};

export type Approval<TOutput> = {
  decisionId: string;
  decidedAt: number;
  decidedBy: string;                   // operator id
  rationale: string;                   // required; surfaces in tessera audit
  output: TOutput;
};

export interface Witness {
  // Synchronous-style API. Callers await the human response.
  ask<TIn, TOut>(decision: Decision<TIn, TOut>): Promise<Approval<TOut>>;
  // Async-style API for callers that want to register a callback.
  askAsync<TIn, TOut>(
    decision: Decision<TIn, TOut>,
    onAnswered: (a: Approval<TOut>) => void,
  ): Promise<DecisionId>;
  // Listing and resolution surfaces — what the operator UI consumes.
  listOpen(authorizedFor: string): Promise<readonly Decision<unknown, unknown>[]>;
  answer(decisionId: string, operator: string, answer: unknown, rationale: string): Promise<void>;
  // Two-person rule support.
  requireSecond(decisionId: string, secondOperator: string, rationale: string): Promise<void>;
}
```

## Two-person rule

Some decisions (scram fires affecting multiple tenants, prod-deploy
go/no-go) require two distinct operators. witness supports this via
`requireSecond`: the first call to `answer` records the first
operator; if the decision's `kind` requires two-person, the decision
remains pending until a second `answer` arrives from a different
operator.

The two-person config is per-`kind`, not per-decision — operators
can't unilaterally relax it.

## Composition with the rest of the stack

- **scram** — non-automatic kill conditions invoke `witness.ask` with
  `kind: 'scram-confirm'`. Two-person required for non-tenant-scoped
  actions.
- **covenant** — pre-flight checklists for prod deploys are wrapped in
  a witness decision: covenant produces the checklist; witness presents
  it; the operator's go/no-go is the answer.
- **reeve** — operator review queue migrates to witness. Existing
  `flag_for_human_review` actions become witness decisions; the inbox
  is a consumer of `witness.listOpen`.
- **signet** — rule-change proposals require codeowner sign-off via
  witness.

## Storage

witness needs durable storage. Decisions can outlive the process that
created them (a decision posed at 23:00 may not be answered until
08:00 next morning). Storage: pg with a `witness_decisions` table.
Operator answers are immutable once written; subsequent edits go via a
new decision (auditable trail).

## Audit

Every answered decision writes to tessera with: decision id, decision
kind, decided-by operator id, rationale, two-person second operator
(if applicable), input snapshot, output. Tessera's hash chain ensures
the audit cannot be tampered with after the fact.

## Surface integration

witness does NOT own the UI. It exposes a query interface
(`listOpen`) and an answer endpoint (`answer`). Each surface (Reeve's
operator inbox, PagerDuty, Slack, email) consumes those interfaces and
renders decisions in its own UI. The reason for the split: each
surface has its own UX patterns; witness shouldn't be in the business
of rendering Slack-flavored Block Kit AND Reeve-flavored HTMX inbox
panels.

## Stack consumers

- **reeve** — operator review queue, action approval, role-change
  approval (already exists; migrates to witness).
- **scram** — kill-condition confirmation.
- **covenant** — pre-flight checklist sign-off.
- **signet** — rule-change codeowner approval.

## Open questions

1. How does witness handle delegation (operator A is on vacation;
   anyone in role X can answer)? Lean: `authorizedRoles` includes
   role-name, not operator-id; any operator with the role can answer.
2. What's the SLA for "I asked, when does escalation fire?" If the
   timeout fires, does the original caller block forever, get a
   timeout error, or get an automatic safe-default? Lean: caller
   provides a `defaultOnTimeout` or `errorOnTimeout` policy.
3. Two-person rule — if the kind requires two-person but only one
   answers within timeout, what happens? Lean: escalate; the
   first answer is treated as advisory; the decision stays open for
   the second person.

## Initial implementation plan

1. Spec lock: this doc + interface file.
2. First implementation lives at `reeve/src/witness/` as a private
   module alongside the existing operator review queue.
3. Migrate the operator review queue's primitives to witness (the UI
   stays as is; just the underlying call shape moves).
4. When scram lands and registers the first non-Reeve consumer,
   extract to `~/WanderRepos/repos/witness/`.

## Provenance

Spec'd 2026-05-05 from sim's NASA-bar review. The user's existing
operator review queue inspired the interface; witness formalizes it
as a cross-stack primitive.
