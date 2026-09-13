# Surface integrations

A *surface* is a channel where decisions are presented to humans.
witness V1 ships a single in-process `inbox` surface stub. Real
surfaces (Reeve operator inbox, PagerDuty, Slack, email, SMS) are
documented extension points implemented by consumers.

## Contract

Each surface implements two pieces:

1. A `SurfaceDispatcher` invoked by witness at decision creation. The
   dispatcher delivers the decision through its channel (post a
   message, page a person, send an email).
2. A callback into witness via `acknowledgeDelivery({ decisionId,
   surface, operator? })`. The callback marks the decision as
   delivered to a human; this is the ACK that prevents the fallback
   timer from firing.

```typescript
import { createWitness, type SurfaceDispatcher } from '@exemplar-stack/witness';

const slackSurface: SurfaceDispatcher = async (info) => {
  await slackClient.postMessage({
    channel: '#approvals',
    text: `Decision ${info.kind} pending`,
    blocks: buildBlocksForDecision(info),
  });
};

const witness = createWitness({
  surfaces: { inbox: inboxSurface, slack: slackSurface },
  fallback: async ({ decisionId, kind }) => {
    await pdClient.createIncident({
      title: `witness fallback: ${kind} not ACKed in 60s`,
      decisionId,
      urgency: 'high',
    });
  },
});
```

The Slack bot, on receiving a button click, calls back via the HTTP
endpoint:

```http
POST /v1/decisions/<id>/ack
{
  "surface": "slack",
  "operator": "U12345"
}
```

## ACK-required pattern (sim-vetted)

ADR-001 rejects an escalation cascade ("dispatch to channel A; if no
answer in T/2, dispatch to B; ...") as multi-channel spam. Correct
fix: dispatch to ALL configured surfaces in parallel; the first
surface to ACK marks the decision delivered. If no surface ACKs
within `ackWindowMs` (default 60s), witness fires a fallback hook
configured by the consumer (typically PagerDuty high-urgency or SMS
to on-call).

This separates "message sent" from "human knows." ACK is cheap (one
HTTP from the surface integration) and catches the "nobody's home"
case without spamming all channels.

## V1 ships

| Surface     | V1 status        | Notes                                       |
|-------------|------------------|---------------------------------------------|
| inbox       | Stub (logs only) | Reeve registers its own at integration time |
| pagerduty   | Documented stub  | Throws on dispatch; consumers register own  |
| slack       | Documented stub  | Throws on dispatch; consumers register own  |
| email       | Documented stub  | Throws on dispatch; consumers register own  |
| sms         | Documented stub  | Throws on dispatch; consumers register own  |

The stubs throw deliberately — registering a stub by mistake should
be loud, not silent.

## Adding a surface

1. Implement the `SurfaceDispatcher` function.
2. Register it under a unique name in `WitnessConfig.surfaces`.
3. Wire your channel's "human picked it up" event back to
   `witness.acknowledgeDelivery` (in-process via the TS API or via
   the HTTP endpoint).
4. Document the surface name in your consumer's README so callers
   passing `surfaces: [...]` to `ask` know what's available.

## Surface failures

Surface dispatchers that throw are caught and logged; one bad
surface must not stop other surfaces from delivering. This is by
design — surface failure is not the caller's concern.

## Future: surface registry

V2 plans a registry pattern so surfaces are pluggable per consumer
without changes to witness itself. Each surface lives in its own
package (`@exemplar-stack/witness-slack`, `@exemplar-stack/witness-pagerduty`) and
self-registers via a `register(witness)` call.
