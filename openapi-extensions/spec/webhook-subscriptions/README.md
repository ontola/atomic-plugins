# OpenAPI Webhook Subscriptions Extension

**Spec version:** 0.1.0-draft

---

## 1. Introduction

A receiver that verifies and routes provider webhook deliveries (the
[Webhook Deliveries extension](../webhook-deliveries/README.md)) holds them
until a consumer, often a laptop that sleeps, fetches and acknowledges them.
If it holds them for any subscriber that ever signed up, its storage grows
without bound; if it drops them silently, the consumer's copy drifts without
anyone knowing. This extension specifies the bounded middle:

- the records a receiver exposes to consumers: subscription, lease, cursor,
  generation, event, event page, gap marker and the
  `reconciliation-required` result;
- the lifecycle that makes an abandoned subscription stop costing storage,
  even while deliveries keep arriving;
- the limits that apply together, with the pilot values of
  [`docs/design/proxy-webhooks-and-two-way-sync.md`](../../../docs/design/proxy-webhooks-and-two-way-sync.md)
  as defaults;
- one root field, `x-webhook-subscriptions`, with which a receiver's own
  OpenAPI document announces the limits it enforces.

Unlike most extensions in this folder, the document that carries the field
describes the receiver (the integration proxy), not a provider. Its records
are JSON objects defined in [schema.json](schema.json), for use in that
document's `components.schemas`.

Status: a draft for ontola/atomic-plugins#369, step 1. No receiver
implements it. The routes in §7 are proposals, not existing endpoints. The
plan's limits are pilot starting values, not measured capacity; §9 lists
the limits the plan leaves open, with proposed values marked as such.

## 2. Overview

```text
consumer                                receiver
   | create subscription (connection, source, events)
   |------------------------------------->| access check through the connection
   |<---- subscription, reconciliation- --| state needs-reconciliation, reason initial,
   |      required (G1, barrier B1)       | capture starts at B1
   | full API read of the source          |
   | fetch after B1 (long poll) --------->|
   |<---- events, next cursor ------------|
   | store each event durably, then ack ->| reclaim acknowledged payloads
   | reconciliation-complete (G1, B1) --->| state active
   | ... fetch / ack, renew every 12 h ...|
   | (laptop sleeps past a limit)         | gap: generation G2, barrier B2
   | fetch ------------------------------>|
   |<---- events still retained, plus ----|
   |      reconciliation-required (G2,B2) |
```

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "SHOULD NOT", "MAY"
are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

- _Receiver_, _consumer_, _endpoint_, _source_ and _source binding_ are as
  in Webhook Deliveries §3 and §4.4.1.
- A _connection_ is a provider grant held at the receiver (an
  integration-proxy connection). A subscription belongs to exactly one
  connection and one _consumer_ agent, which is the connection's owner, a
  delegate of it, or a runtime acting for a delegated app, under the
  receiver's existing authorization model. Every consumer request is signed
  by that agent; an id in a URL is never a credential.
- _Pending_ means retained for a subscription and not yet acknowledged by it.
- Durations are integer seconds and sizes integer bytes. Timestamps are
  RFC 3339 in UTC with a `Z` suffix.
- _Opaque_ values (subscription ids, generations, cursors) are 1–512
  characters of base64url (`A–Z a–z 0–9 - _`) without padding. Consumers
  compare them only for equality and never parse or construct them.

## 4. Lifecycle

### 4.1 States

| State                  | Behaviour                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provisioning`         | The receiver runs the access check and, for a dedicated hook, creates or adopts the hook (Webhook Deliveries §4.5.2), retrying under one stable operation identity. Nothing is captured yet.                                                                                                                                                                       |
| `needs-reconciliation` | Deliveries are captured from the current generation's barrier. The consumer must complete a reconciliation (§4.4) before the receiver calls its history continuous. A new subscription starts here with reason `initial`.                                                                                                                                          |
| `active`               | Deliveries are captured and history since the last completed reconciliation has no known gap.                                                                                                                                                                                                                                                                      |
| `expired`              | The lease or progress deadline passed (§4.3). Nothing new is captured; pending payloads are released in the same transaction; the consumer is detached. Transient: by the next sweep at the latest (`sweep.maxIntervalSeconds`) it moves on to `cleanup-pending` or `closed`, whose tombstone remembers that it expired. A consumer that returns subscribes again. |
| `cleanup-pending`      | The subscription was the last user of a dedicated hook that the receiver created; the receiver deletes it as a bounded cleanup job (§6).                                                                                                                                                                                                                           |
| `closed`               | Payload references, binding and cursor are gone. A tombstone (id, state, closing reason, timestamp) is kept for at most the tombstone TTL, within the tombstone cap (§6), so the consumer gets `expired` or `closed`, not "unknown".                                                                                                                               |

Transitions, and nothing else:

- `provisioning` → `needs-reconciliation` when the binding and hook are
  ready; → `closed` when provisioning fails within its bounded retries.
- `needs-reconciliation` → `active` on a reconciliation-complete for the
  current generation and barrier (§4.4).
- `active` → `needs-reconciliation` when a gap is recorded (§5).
- `active` or `needs-reconciliation` → `expired` at the lease or progress
  deadline; → `cleanup-pending` or `closed` when the consumer deletes the
  subscription, the connection is deleted, the consumer loses its standing
  (a delegation or runtime removed), or an access check fails (Webhook
  Deliveries §4.4.1: at renewal, before serving events, after a revocation;
  a check that cannot complete is not a failure).
- `expired` → `cleanup-pending` or `closed`, by the next sweep at the
  latest.
- `cleanup-pending` → `closed` when the hook is deleted or its cleanup
  deadline passes.

`cleanup-pending` applies only to a dedicated hook the receiver created and
no remaining `active` or `needs-reconciliation` subscription uses. A
subscription on a shared application hook goes straight to `closed`; the
hook is never touched (Webhook Deliveries §4.5.1).

Deleting the connection MUST stop reads for its subscriptions at once (the
next request fails) and start cleanup of the dedicated hooks this leaves
unused. A hook another connection's subscription still uses stays, and is
managed through that connection from then on (Webhook Deliveries §4.5.2). A
subscription's expiry or closing never revokes or deletes the connection.

### 4.2 Generations and cursors

A _generation_ is an opaque label for one stretch of history that the
receiver knows to be continuous. Every gap (§5) starts a new generation. A
_cursor_ is an opaque position in the subscription's event sequence, issued
by the receiver in a fetch response. The receiver assigns positions in
arrival order (not the provider's causal order) and never reuses one.

A cursor belongs to one subscription and one generation. A receiver MUST
refuse a cursor it did not issue to that subscription (`cursor-not-issued`),
a cursor beyond the last one it returned to the consumer
(`cursor-ahead`, a forged future position), and a generation that is
neither the current one nor the one the current gap marker names
(`obsolete-generation`). A receiver can meet this by storing issued
positions, or by authenticating cursors (a MAC over subscription id,
generation and position under a receiver key); it MUST NOT trust a position
a consumer could have edited.

### 4.3 Leases and renewal

A lease has three deadlines, all from the policy (§6):

| Field                | Default                                                                                                                    | Meaning                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `expiresAt`          | renewal + 604800 s (7 days)                                                                                                | Without a renewal by then, the subscription expires.                                                     |
| `renewAfter`         | renewal + 43200 s (12 hours)                                                                                               | When the consumer should renew next.                                                                     |
| `progressDeadlineAt` | the later of the last acknowledgement and the moment pending became non-empty, + 604800 s; `null` while nothing is pending | With pending events and no acknowledgement advancing by then, the subscription expires despite renewals. |

Only a signed renewal by the subscription's consumer renews a lease. A
delivery, an OAuth refresh, other requests through the connection, or a UI
that reads the subscription do not. A renewal carries the consumer's durable
checkpoint (the last cursor it stored, or `null`); a consumer with nothing
pending may renew without inventing progress. Every renewal repeats the
source access check (Webhook Deliveries §4.4.1); a failed check closes the
subscription, a check that cannot complete refuses the renewal.

`renewAfter` is a hint to the consumer, not the bound on access. The
receiver itself keeps the last passing access check younger than
`access.maxCheckAgeSeconds` whenever it serves events: a fetch finding it
older runs the check first, or is refused with `access-check-required`
(Webhook Deliveries §4.4.1). A consumer that lost access at the provider
therefore stops receiving events within that age, however it renews.

The receiver MUST enforce both deadlines on the request path (a delivery,
fetch, acknowledgement or renewal past a deadline finds the subscription
expired, and capture stops at once) and with a periodic sweeper. A failed
sweeper therefore cannot let ingress keep appending past a deadline. A
signature never bypasses retention, progress or quota rules.

### 4.4 Reconciliation

The `reconciliation-required` result (§5.2) gives the consumer a new
generation and its _barrier_: the cursor position from which the receiver
captures for that generation. The consumer then:

1. reads the source completely through the API (with its own connection);
2. fetches and processes the events after the barrier, which may report
   changes made during that read;
3. calls reconciliation-complete with the generation and barrier.

The receiver accepts it only for the current generation and its barrier,
after a passing access check; otherwise it answers `obsolete-generation` or
`barrier-mismatch`, and the consumer starts over with the newer result.
Several rounds may be needed when gaps keep occurring; periodic full reads
remain necessary regardless.

Reconciliation recovers the source's current state, not the intermediate
edits made during a gap. A consumer's user-facing status MUST say so, and its
reconciliation MUST keep its own pending local edits and conflicts rather
than replace them with the provider's state.

## 5. Gaps

### 5.1 When a gap is recorded

A receiver records a gap, and starts a new generation, in the same
transaction that would otherwise lose history: before it evicts a pending
event, when it refuses to retain a verified delivery routed to a
subscription, and when it cannot tell whether history is complete. Reasons:

| `reason`                                                                          | When                                                                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `initial`                                                                         | A new subscription; no history exists before its barrier.                                                                      |
| `subscription-events-limit`, `subscription-bytes-limit`, `subscription-age-limit` | A per-subscription limit (§6) was reached.                                                                                     |
| `owner-limit`                                                                     | The owner's aggregate budget was reached.                                                                                      |
| `deployment-limit`                                                                | The deployment's inbox budget was reached.                                                                                     |
| `oversized-delivery`                                                              | A verified delivery routed to the subscription was longer than the retention cap (`delivery.maxBodyBytes`).                    |
| `uncapturable-delivery`                                                           | A verified delivery routed to the subscription could not be parsed or stored.                                                  |
| `access-suspended`                                                                | Routing was suspended by a revocation (Webhook Deliveries §4.4.2) and resumed after a passing access check.                    |
| `receiver-restored`                                                               | The receiver's store was restored from a backup or otherwise lost writes.                                                      |
| `receipt-limit`                                                                   | A receipt cap left no receipt the receiver may evict (Webhook Deliveries §4.3), so the delivery was not stored for this owner. |

Consumers MUST treat an unknown `reason` like any other gap.

A gap marker is one record per subscription, replaced by the next gap; it is
not one row per dropped event. While a subscription is in
`needs-reconciliation`, a further gap only starts another generation and
replaces the marker.

At deployment saturation the receiver keeps every owner within its own
limits and MUST NOT evict one owner's pending events for another's without
recording the gap for the owner whose history it drops.

### 5.2 `reconciliation-required`

A fetch, acknowledgement or renewal whose subscription needs reconciliation
returns this result (on its own, or inside an event page next to events
still retained). A `Subscription` in `needs-reconciliation`, including a
newly created one, carries it as `reconciliationRequired`:

| Field          | Type                                            | Description                                                                                                                                                                 |
| -------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`       | `reconciliation-required`                       |                                                                                                                                                                             |
| `subscription` | opaque                                          |                                                                                                                                                                             |
| `state`        | `needs-reconciliation` \| `expired` \| `closed` |                                                                                                                                                                             |
| `action`       | `reconcile` \| `resubscribe`                    | `reconcile`: this subscription continues; reconcile against `generation` and `barrier`. `resubscribe`: it is over; create a new subscription, which returns its own result. |
| `generation`   | opaque                                          | With `reconcile` only: the new, current generation.                                                                                                                         |
| `barrier`      | cursor                                          | With `reconcile` only.                                                                                                                                                      |
| `gap`          | Gap Marker                                      | Why.                                                                                                                                                                        |

Gap Marker:

| Field                     | Type             | Description                                                                                                                                              |
| ------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generation`              | opaque \| `null` | The generation that ended at the gap (`null` for `initial`).                                                                                             |
| `reason`                  | string           | §5.1.                                                                                                                                                    |
| `detectedAt`              | timestamp        |                                                                                                                                                          |
| `lastAcknowledged`        | cursor \| `null` | The consumer's last acknowledged cursor in that generation.                                                                                              |
| `earliestAvailableCursor` | cursor \| `null` | The earliest event of that generation still retained after `lastAcknowledged`, or `null` if none is. Such events are recent hints, not complete history. |

With `resubscribe`, `gap.reason` says why the subscription ended:
`lease-expired`, `progress-stalled`, `access-denied` (a failed access
check), `connection-deleted`, `standing-lost` (the consumer's delegation or
runtime was removed), `deleted` (by the consumer) or
`provisioning-failed`.

A receiver MUST NOT skip a consumer to the newest event silently, or
present expired history as replayable.

### 5.3 Ingress and durable acknowledgement

For a verified delivery the receiver answers the provider with 2xx only
after the transaction that retains the payload and its references, or that
records the gap in their place, has committed. If it can commit neither, it
answers 5xx, so the provider may retry. A verified delivery that no
subscription wants is answered 2xx and leaves no state for its source.
A verified delivery over the retention cap, or one that is otherwise
uncapturable, records a gap for the subscriptions its source routes to,
when its source can be identified securely (after verification). A body
over the verification cap is refused before it is verified, so nothing can
be recorded for it; the consumers' periodic full reads are the fallback.

A payload shared by several subscriptions is stored once and counted in
full against each subscription and owner it is retained for, so sharing
cannot be used to exceed a budget. It is reclaimed once every subscription
it was retained for has acknowledged it, expired or closed.

## 6. Limits: the `x-webhook-subscriptions` field

Placed at the root of the receiver's own OpenAPI document. Every limit
applies at the same time; reaching any one records a gap (§5) or refuses a
request, never silently drops history.

```yaml
x-webhook-subscriptions:
  policy:
    lease:
      durationSeconds: 604800
      renewAfterSeconds: 43200
      progressDeadlineSeconds: 604800
    access:
      maxCheckAgeSeconds: 43200
    subscription:
      maxPendingEvents: 10000
      maxPendingBytes: 67108864
      maxPendingAgeSeconds: 604800
    owner:
      maxPendingBytes: 268435456
      maxPendingReferences: 50000
      maxActiveSubscriptions: 20
    deployment:
      maxInboxBytes: 1073741824
    receipts:
      ttlSeconds: 172800
      maxCount: 200000
      maxCountPerOwner: 20000
    closed:
      tombstoneTtlSeconds: 2592000
      maxTombstones: 10000
    cleanup:
      deadlineSeconds: 2592000
      maxJobs: 10000
      maxJobsPerOwner: 20
    sweep:
      maxIntervalSeconds: 60
    delivery:
      maxVerifiedBytes: 26214400
      maxBodyBytes: 8388608
      maxJsonDepth: 64
    fetch:
      maxEvents: 100
      maxWaitSeconds: 25
```

| Field                               | Plan default                                            | Meaning                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lease.durationSeconds`             | 604800 (7 days)                                         | §4.3 `expiresAt`.                                                                                                                                                                                                                                                                             |
| `lease.renewAfterSeconds`           | 43200 (12 hours)                                        | §4.3 `renewAfter`. Less than `durationSeconds`.                                                                                                                                                                                                                                               |
| `lease.progressDeadlineSeconds`     | 604800 (7 days)                                         | §4.3 `progressDeadlineAt`.                                                                                                                                                                                                                                                                    |
| `access.maxCheckAgeSeconds`         | **open** (proposed 43200, the renewal interval)         | The oldest a passing access check may be when events are served (§4.3). At most 86400.                                                                                                                                                                                                        |
| `subscription.maxPendingEvents`     | 10000                                                   | Pending events per subscription.                                                                                                                                                                                                                                                              |
| `subscription.maxPendingBytes`      | 67108864 (64 MiB)                                       | Pending payload bytes per subscription.                                                                                                                                                                                                                                                       |
| `subscription.maxPendingAgeSeconds` | 604800 (7 days)                                         | Age of the oldest pending event.                                                                                                                                                                                                                                                              |
| `owner.maxPendingBytes`             | 268435456 (256 MiB)                                     | Across all of one owner's subscriptions, connections and runtimes.                                                                                                                                                                                                                            |
| `owner.maxPendingReferences`        | 50000                                                   | Pending event references across one owner's subscriptions.                                                                                                                                                                                                                                    |
| `owner.maxActiveSubscriptions`      | 20                                                      | Subscriptions in `provisioning`, `needs-reconciliation` or `active`; not `expired`, `cleanup-pending` or `closed`, so a slow hook cleanup never blocks the owner's new subscriptions. Creating one more is refused (`quota-exceeded`).                                                        |
| `deployment.maxInboxBytes`          | 1073741824 (1 GiB)                                      | Operator-configured; raw payload bytes plus a conservative per-row overhead the receiver states.                                                                                                                                                                                              |
| `receipts.ttlSeconds`               | 172800 (48 hours)                                       | Delivery-id receipts (Webhook Deliveries §4.3). MUST exceed twice the largest `toleranceSeconds` of any profile served; at least 1800 always does.                                                                                                                                            |
| `receipts.maxCount`                 | **open** (proposed 200000)                              | Hard cap for the deployment. At a cap the oldest evictable receipts expire early, never one younger than twice the largest `toleranceSeconds`; when none is evictable, the delivery is recorded as a `receipt-limit` gap for the owners concerned and answered 2xx (Webhook Deliveries §4.3). |
| `receipts.maxCountPerOwner`         | **open** (proposed 20000)                               | Hard cap for one owner's receipts, with the same rule, so that one owner's traffic never uses up the receipts of others. At most `receipts.maxCount`.                                                                                                                                         |
| `closed.tombstoneTtlSeconds`        | 2592000 (30 days)                                       | Upper bound for tombstones of expired and closed subscriptions.                                                                                                                                                                                                                               |
| `closed.maxTombstones`              | **open** (proposed 10000)                               | At the cap the oldest tombstones are purged early.                                                                                                                                                                                                                                            |
| `cleanup.deadlineSeconds`           | 2592000 (30 days)                                       | Hook cleanup jobs give up and are recorded as failed after this.                                                                                                                                                                                                                              |
| `cleanup.maxJobs`                   | **open** (proposed 10000)                               | At the cap new subscriptions that would need a new dedicated hook are refused (`capacity-unavailable`); other subscriptions are not affected.                                                                                                                                                 |
| `cleanup.maxJobsPerOwner`           | **open** (proposed 20)                                  | The same, counted per owner (the owner whose connection manages the hook), so one owner's failing cleanups never block everyone else's dedicated subscriptions. At most `cleanup.maxJobs`.                                                                                                    |
| `sweep.maxIntervalSeconds`          | 60                                                      | The sweeper runs at least this often, in bounded batches.                                                                                                                                                                                                                                     |
| `delivery.maxVerifiedBytes`         | **open** (proposed 26214400, GitHub's documented 25 MB) | The verification cap: larger bodies are refused before they are read (Webhook Deliveries §4.2.1).                                                                                                                                                                                             |
| `delivery.maxBodyBytes`             | **open** (proposed 8388608)                             | The retention cap: a verified body longer than this is recorded as an `oversized-delivery` gap, not retained. At most `delivery.maxVerifiedBytes` and `subscription.maxPendingBytes`.                                                                                                         |
| `delivery.maxJsonDepth`             | **open** (proposed 64)                                  | Deeper bodies are uncapturable.                                                                                                                                                                                                                                                               |
| `fetch.maxEvents`                   | **open** (proposed 100)                                 | Events per page.                                                                                                                                                                                                                                                                              |
| `fetch.maxWaitSeconds`              | **open** (proposed 25)                                  | Longest long-poll wait.                                                                                                                                                                                                                                                                       |

A receiver rejects new subscriptions (`capacity-unavailable`) when it cannot
keep its sweeps and cleanup within these bounds, and exposes its sweep lag.
Operator metrics use bounded labels, never delivery ids, source keys or
payload content. Backups that contain payloads expire too; their retention is
the operator's to state.

Rate limits on verification work, subscription creation, renewal and fetch,
and concurrency limits on ingress, are required by the plan but not given
numbers there; this version does not declare them (§9).

## 7. Records and proposed routes

[schema.json](schema.json) defines, under `$defs`: `Policy`, `Subscription`,
`Lease`, `Event`, `EventPage`, `Acknowledgement`, `Renewal`,
`ReconciliationComplete`, `ReconciliationRequired`, `GapMarker` and
`Error`; [examples/records.json](examples/records.json) has invented
instances of each, for the Example Tracker of the Webhook Deliveries
examples. [examples/receiver.yaml](examples/receiver.yaml) is a receiver
document with the field and these proposed routes, all signed by the
consumer agent except the provider-facing one:

| Route (proposed)                                                      | Request                                     | Answer                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /webhooks/{endpointId}`                                         | A provider delivery                         | 2xx after commit (§5.3); never signed by a consumer.                             |
| `POST /connections/{connectionId}/subscriptions`                      | source kind, access parameters, event types | `Subscription`: `provisioning`, or `needs-reconciliation` with `reason: initial` |
| `GET /subscriptions/{subscriptionId}`                                 |                                             | `Subscription`                                                                   |
| `DELETE /subscriptions/{subscriptionId}`                              |                                             | `Subscription` (`cleanup-pending` or `closed`)                                   |
| `POST /subscriptions/{subscriptionId}/renew`                          | `Renewal`                                   | `Subscription`, or `ReconciliationRequired`                                      |
| `GET /subscriptions/{subscriptionId}/events?generation=&after=&wait=` |                                             | `EventPage`                                                                      |
| `POST /subscriptions/{subscriptionId}/ack`                            | `Acknowledgement`                           | `Acknowledgement` (the current acknowledged cursor)                              |
| `POST /subscriptions/{subscriptionId}/reconciled`                     | `ReconciliationComplete`                    | `Subscription`                                                                   |

Fetch returns events after `after` (or from the barrier or the earliest
retained event when omitted), at most `fetch.maxEvents`, waiting up to
`min(wait, fetch.maxWaitSeconds)` when there are none. Server-sent events
may later signal that data is available, using the same cursors.

An event carries an allowlisted envelope and the raw body: `cursor`,
`generation`, `deliveryId`, `eventType`, `action`, `receivedAt`, `source`
(kind and key), and `payload` with `mediaType`, `bytes`, `sha256` (hex, of
the raw body) and `body` (the raw body, base64). No provider header,
signature or secret is passed on.

Acknowledgement is monotonic: acknowledging a cursor at or before the
acknowledged one changes nothing and returns the current one; a later cursor
moves it and releases everything up to it. A consumer acknowledges only what
it has stored durably (the plan: a Webhook deliveries row and its raw
payload in Atomic). Deliveries can be duplicated (after receipt expiry or
with `redelivery: newId`) and arrive out of provider order; consumers MUST
be idempotent per delivery id and read the API for the current state.

Error codes: `unknown-subscription`, `obsolete-generation`,
`cursor-not-issued`, `cursor-ahead`, `barrier-mismatch`, `quota-exceeded`,
`capacity-unavailable`, `access-denied`, `access-check-required`,
`rate-limited`, `expired`, `closed`.

## 8. Validation

[validate.py](validate.py) checks a receiver document's
`x-webhook-subscriptions.policy` against [schema.json](schema.json) and the
rules a schema cannot express:

- `lease.renewAfterSeconds` < `lease.durationSeconds`;
- `subscription.maxPendingBytes` ≤ `owner.maxPendingBytes` ≤
  `deployment.maxInboxBytes`, and `subscription.maxPendingEvents` ≤
  `owner.maxPendingReferences`;
- `delivery.maxBodyBytes` ≤ `delivery.maxVerifiedBytes` and ≤
  `subscription.maxPendingBytes`;
- `access.maxCheckAgeSeconds` ≤ 86400 and ≤ `lease.durationSeconds`;
- `receipts.maxCountPerOwner` ≤ `receipts.maxCount` and
  `cleanup.maxJobsPerOwner` ≤ `cleanup.maxJobs`;
- `receipts.ttlSeconds` ≥ 1800 (twice the largest tolerance Webhook
  Deliveries allows; the actual tolerances are in other documents);
- `sweep.maxIntervalSeconds` ≤ 60, `closed.tombstoneTtlSeconds` and
  `cleanup.deadlineSeconds` ≤ 2592000.

It checks records too: a `reconcile` result has a generation and barrier and
a `resubscribe` result has neither; an `initial` gap has no generation; an
event's `bytes` and `sha256` match its base64 `body`; an event page's events
are in its generation and have distinct cursors; a subscription in
`needs-reconciliation` carries its barrier; and `progressDeadlineAt` is
`null` exactly when nothing is pending.

```sh
cd openapi-extensions/spec/webhook-subscriptions
python3 -m unittest test_validate -v
python3 validate.py examples/receiver.yaml examples/records.json
```

## 9. Open points

- **Unnumbered limits.** `access.maxCheckAgeSeconds`, `receipts.maxCount`,
  `receipts.maxCountPerOwner`, `closed.maxTombstones`, `cleanup.maxJobs`,
  `cleanup.maxJobsPerOwner`, `delivery.maxVerifiedBytes`,
  `delivery.maxBodyBytes`, `delivery.maxJsonDepth`, `fetch.maxEvents` and
  `fetch.maxWaitSeconds` have proposed values only.
  Rate and concurrency limits are not declared at all.
- **Row overhead.** How the receiver counts per-row and index overhead in
  `deployment.maxInboxBytes` is to be measured (plan, step 7).
- **Dirty-scope summary.** The plan allows a bounded summary of changed
  scopes next to a gap; this version has no record for it.
- **Fetching the old generation.** Whether retained events of a gapped
  generation stay fetchable until acknowledged, or are released at once, is
  left to the receiver; consumers must handle both.
- **Initial state.** Starting new subscriptions in `needs-reconciliation`
  (reason `initial`) is a deliberate departure from the plan's table, which
  goes from `provisioning` to `active`; the plan now records it. Deliveries
  are routed in that state (Webhook Deliveries §4.4.1), so nothing is lost
  during the first reconciliation.
- **Receipts and redelivery windows.** Receipts live 48 hours; a provider
  redelivery after that (GitHub allows three days) reaches consumers again,
  who are idempotent per delivery id.
- **Fan-out bound.** The plan bounds event fan-out; how many subscriptions
  one source may have is not declared.
- **SSE.** Notification over server-sent events is deferred.

## Reference Implementation

None yet. Planned in the integration proxy for ontola/atomic-plugins#369,
steps 2 and 3, behind a configuration switch that is off by default.
