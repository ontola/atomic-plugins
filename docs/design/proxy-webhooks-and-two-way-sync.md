# Proxy webhooks, subscription expiry and two-way sync

Status: proposed implementation plan, 8 October 2026. No webhook routes,
subscriptions or provider writes are enabled by this document. The lease and
quota values below are starting defaults for a pilot, not measured capacity.

## Goal and placement

Make provider changes reach a local Atomic sync daemon promptly, including
after the laptop has slept, and let authorized Atomic edits flow back to the
provider. Keep AtomicServer generic. Start with one GitHub Issues tracker;
provider behavior must still come from pinned API descriptions and overlays.

Host the public webhook receiver and a bounded durable inbox in
`integration-proxy`. It already owns provider connections, credential storage,
agent authorization and a PostgreSQL database. The daemon makes outbound signed
requests to consume events; no public laptop port or tunnel is required.

The proxy verifies, routes and temporarily retains events. The daemon decides
which API reads they cause, resolves pagination, applies native mappings and
handles outbound edits and conflicts. Syncables provides API mechanics;
Devonian/lenses provide mappings, with Reflector's orchestration reviewed for
reuse before implementing a parallel sync engine. This is independent of the
AtomicServer public plugin-route design in [server-plugin-routes.md](server-plugin-routes.md).

## A connection is not a permanent subscription

Authorizing OAuth must not automatically create a webhook or an unbounded
queue. A consumer explicitly subscribes to an authorized source scope after
its runtime and durable destination are ready. The subscription is separate
from the provider grant, and holds a renewable lease.

Proposed lifecycle:

| State | Behavior |
| --- | --- |
| provisioning | Bounded operation to create/attach a hook; retry by stable operation identity. |
| active | Accept scoped events while the consumer lease is valid. |
| needs-reconciliation | History has a gap; retain only bounded recent events and expose the gap. |
| expired | Stop retaining new payloads; expire existing backlog and detach the consumer. |
| cleanup-pending | Disable/delete a dedicated managed provider hook if no consumer needs it. |
| closed | Purge payloads, bindings and expired receipt/cleanup records according to policy. |

Start with a seven-day lease, renewed by a signed consumer heartbeat every
12 hours. Incoming webhooks, OAuth refresh, ordinary proxy traffic and merely
opening a UI do not renew it. A healthy consumer reports its durable checkpoint
and acknowledges events; a consumer with no pending events may renew without
inventing progress. If backlog exists and no acknowledgement advances for
seven days, expire the subscription despite heartbeats. A disconnected laptop
can therefore recover a short absence, but an abandoned or stuck consumer
cannot keep building proxy state indefinitely.

Lease expiry is enforced on the request path as well as by a periodic sweeper;
worker failure must not allow ingress to keep appending beyond the deadline.
Signing a request does not bypass retention, progress or quota policy.

### Returning after expiry

Return an explicit `reconciliation-required` result with an opaque generation,
gap reason and earliest available cursor. Never silently skip to the newest
event or pretend expired history can be replayed. Revalidate source access,
renew/create the subscription, establish a new capture barrier and perform a
complete API reconciliation. Then process events captured during that scan
and acknowledge its barrier. Multiple scans may be needed if the source has no
snapshot API; periodic reconciliation remains necessary.

This recovers current source state, not every intermediate edit during the
absence. The user-facing status must say so. A fresh scan must preserve pending
Atomic edits and conflicts rather than blindly replace them.

## Storage limits and deliberate gaps

The proxy is a bounded transport buffer. The append-only long-term history
lives in the user's Atomic drive after the daemon durably copies each event.
Proxy retention is not an indefinite event archive.

Proposed pilot policy (all limits applied together):

- Unacknowledged payloads: at most seven days, 10,000 events or 64 MiB per
  subscription, whichever limit is reached first. Acknowledged payloads can be
  reclaimed once all still-valid interested consumers have acknowledged them.
- Aggregate owner budget: 256 MiB, 50,000 pending references and 20 active
  subscriptions, across all connections/runtimes. A shared payload still counts
  logically against each benefiting owner's budget so sharing cannot bypass it.
- Deployment inbox budget: operator-configured, initially 1 GiB, plus separately
  bounded receipt, subscription and cleanup metadata. Count raw payload bytes
  and conservative row/index overhead; physical database space also needs
  measurement, maintenance and alerts. Backups have a documented expiry too.
- Deduplication receipts: 48-hour TTL and a hard count/byte budget. Expiry permits
  old redeliveries to be seen again; consumers remain idempotent. No forever-growing
  delivery-ID or tombstone table.
- Closed subscription tombstones and hook-cleanup jobs: at most 30 days, with
  hard count caps. Sweep in bounded batches at least every minute, expose GC lag
  and reject new subscriptions when capacity cannot be maintained.

When a limit is reached, atomically mark the affected subscription generation
as needing reconciliation before evicting history. Retain a bounded gap marker,
not one row per dropped event. Keep recent events within budget; consumers may
also use a bounded dirty-scope summary to reduce redundant reads, but it must
not be represented as complete event history. Coalescing that summary does not
alter raw events already retained in Atomic.

If the receiver can durably record the gap, it may acknowledge a verified
delivery without retaining its full payload. If neither the payload nor the
gap can be durably committed, return failure. Define and test this contract;
never acknowledge successful durable ingestion before the transaction commits.
At global saturation preserve fairness and enforce existing caps; do not let
one busy owner evict unrelated owners' history without signaling their gaps.

Rate-limit verification work, subscription creation, renewals and ingress;
bound body size, parsing depth, concurrent requests and event fan-out. Oversized
or otherwise uncapturable deliveries trigger reconciliation where their source
can be securely identified, with periodic scans as the fallback. Operator
metrics use bounded labels rather than per-delivery IDs or private payloads.

## Dedicated hooks versus shared app hooks

There are two ownership models; lifecycle metadata must distinguish them.

1. A **dedicated managed hook** is created for an authorized scope. Save its
   provider ID and management credential reference. Reuse it where subscriptions
   legitimately share the same source/verification profile; delete or deactivate
   it when its last valid subscription expires. Delete only hooks the proxy owns.
2. A **shared application hook** serves many installations/connections. Never
   disable the application-wide webhook because one consumer expires. Verify
   incoming deliveries, route only to active authorized subscriptions, and
   discard payloads with no interested consumer without creating per-source
   orphan state. Sharing a hook must not imply sharing payload visibility.

For the GitHub pilot prefer the existing Atomic Server GitHub App's shared
webhook, if its operator configures one. OAuth user authorization and app
installation are distinct; connecting once need not create a repository hook.
GitHub repository-hook management requires separate Webhooks write permission;
the pilot's Issues write/Metadata read grant does not supply that permission.
See [GitHub App webhooks](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
and [repository hook API](https://docs.github.com/en/rest/repos/webhooks).

Deletion can fail after credential revocation. Bound retries with backoff and
a 30-day deadline; expose cleanup failure and manual operator/user instructions,
then expire the cleanup record under policy. A verified late delivery is discarded
without growing state. The remaining upstream hook may still consume ingress
CPU/network, so rate limits and provider/operator cleanup are needed even when
local storage is bounded. Reconcile provisioning after crashes so a successful
hook creation with a lost response does not create duplicate orphan hooks.

OAuth credential retention is a separate policy. Expiring a webhook lease does
not silently revoke/delete a reusable provider connection. Conversely, explicit
connection deletion must immediately revoke subscription reads and start managed
hook cleanup, preserving only the narrowly authorized cleanup material for its
bounded lifetime. Deciding when to expire unused OAuth grants is follow-up work.

## Generic metadata and authorization

Use standard OpenAPI webhook/callback descriptions for payloads where they fit.
Before executable work, specify any missing verification, delivery identity,
source routing, registration/deletion and authorization semantics under
`openapi-extensions/`, then publish provider declarations through `overlays/` and
a new immutable catalog. Do not add `if platform == ...` behavior to the proxy
or execute catalog-supplied code. Reusable verification primitives may include
raw-body HMAC and bounded handshake mechanisms; explicit secret sources and
trusted metadata select them.

Provider signature verification establishes delivery authenticity, not an
Atomic caller's right to read it. Route using trusted installation and source
scope bindings, established by a successful access check. Revalidate access at
subscription/renewal and periodically while active; invalidate promptly on
revocation/removal events. Never fan out merely because owners authorized the
same app or share a provider account. Shared app deliveries must still respect
each connection's current selected-repository access.

Subscription ownership/delegation uses the proxy's existing owner, app, runtime
and capability model, with explicit source/event permissions. Each consumer has
its own cursor; removing a delegation stops reads immediately and cannot leave
a valid renewing lease. Endpoint IDs are routing identifiers, not bearer grants.
Secrets remain encrypted at the proxy. No private webhook payloads go through a
public relay. Verify the original raw bytes before trusting routing fields.

GitHub uses HMAC-SHA256 and a delivery ID; validation must use constant-time
comparison. Its guidance asks for acknowledgement within ten seconds and notes
that a redelivery retains the delivery ID. See
[validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
and [delivery practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).

## Protocol and records to specify

Proposed routes, not existing endpoints:

- Provider-facing receipt/handshake endpoint with verification-profile routing.
- Signed create/read/renew/delete subscription operations scoped to a connection.
- Signed bounded event fetch using subscription ID, generation and cursor.
  Start with long polling; SSE can later notify that data is available using the
  same durable cursor protocol.
- Signed monotonic acknowledgement through an issued cursor, rejecting forged
  future cursors and obsolete generations. A cursor belongs to one subscription.
- Signed reconciliation-complete operation tied to the established capture barrier.

Database records: hook binding and ownership; subscription and lease/progress;
immutable event payload/hash plus allowlisted envelope; per-consumer event
references and cursor; expiring dedup receipt; bounded gap state; cleanup job.
Use foreign keys, transactional quota accounting, indexed expiry and bounded GC.
Deduplicate only within the correct hook/provider identity namespace. Record
delivery attempts separately only within a bounded operational policy.

Receipt order is proxy arrival order, not guaranteed provider causal order.
Support duplicates and out-of-order events. The daemon first writes a Webhook
deliveries row and its raw payload to Atomic, then acknowledges that cursor;
the separately durable work item can recover processing after a crash. Resulting
API requests cite that event in `why`. Concurrent edits require an authoritative
API read rather than trusting an old webhook as the newest source state.

## Two-way pilot in the daemon

Start with updates to existing issue title, description and open/closed state.
New issues/comments, labels and deletion follow after their recovery semantics
are tested. Normal team notes remain local. Publish explicit writable mappings;
never infer writes from arbitrary edits to imported JSON or executable content.

Persist the last synchronized source baseline, current local editable fields,
Atomic revision/commit attribution and a durable outbound operation identity.
Do not let incoming imports overwrite pending local edits. Compare baseline,
local edit and freshly fetched remote state field by field: disjoint changes
merge, identical changes converge, competing changes become visible conflicts.
Detect changes by revision/data rather than signer alone; several processes can
use the same agent. Serialize operations per source resource and verify the local
revision again before applying acknowledgements; newer local edits remain pending.

Journal outbound intent before dispatch and the complete response before applying
the acknowledgement. `why` links the causal Atomic revision and operation. Send
only the intended PATCH fields through the catalog-allowlisted Local Thought
route. Advance the baseline from the authoritative response/follow-up read so
returning webhooks do not enqueue the same edit again. Record conflicts and
operation status in Atomic; keep authentication outside the journal.

Read-before-write alone cannot guarantee freedom from lost updates: a GitHub edit
can race between the read and PATCH. Use conditional writes only when the provider
actually supports them. The GitHub pilot must document this remaining race,
minimize the window and verify the result; it must not promise transactional
cross-system merging. Provider ordering and webhook arrival cannot fix that race.

An ambiguous write outcome enters an indeterminate state and is reconciled
before retry. Do not blindly retry POST creation without supported idempotency
or reliable identity recovery. Evaluate Syncables' pinned outbox, retry and PATCH
behavior with fixtures before reuse; API write support alone is not conflict
handling. Outbound writes use the connected provider identity, not automatically
the identity of whichever teammate edited an Atomic row. Make that attribution
and the enabled fields explicit in configuration before enabling writes.

## Implementation sequence and acceptance

1. **Specify contracts.** Agree on metadata, source authorization, cursor/gap
   behavior and pilot limits; validate neutral examples plus GitHub fixtures.
   Keep the receiver disabled until the generic metadata contract is agreed.
2. **Bounded inbox first.** Implement transactions, quotas, lease/progress expiry,
   GC and cleanup before opening public ingress. Prove one-time signup followed
   by permanent abandonment stops retention even while events keep arriving.
3. **Verified ingress and consumption.** Add raw-body verification, scoped routing,
   dedup, fetch/ack and long polling; test isolation, revocation, concurrent quota
   races, shared payload GC, oversized deliveries and DB outage before acknowledgement.
4. **Daemon inbound integration.** Persist events/work in Atomic before ack,
   trigger scoped reads, retain timer reconciliation and expose gaps/conflicts.
   Test sleeping beyond retention, crashes around ack and snapshot capture races.
5. **Outbound pilot.** Add baseline, edit queue and restricted issue PATCH mapping;
   test disjoint/competing edits, echo suppression, newer local edits during a
   write, rate limits, failed/indeterminate writes and credential revocation.
6. **Controlled live trial.** Configure the shared app hook and scoped subscription;
   verify a GitHub edit reaches Atomic and an authorized test edit reaches GitHub.
   Exercise lease expiry and returning-user reconciliation with a short test policy.
   This plan itself performs no webhook registration or live provider write.
7. **Measure before expansion.** Record physical bytes per event/reference, GC lag,
   ingress/egress rates and privacy-safe quota/gap counters. Review quotas and
   retention costs before enabling all Ontola trackers or promising longer replay.

Release criteria include a fixed upper bound on inactive-consumer storage,
explicitly visible history gaps, no cross-connection event leakage, no shared
hook removal on individual expiry, and recovery after both laptop and proxy
restarts. Infinite replay and a permanently append-only proxy buffer are outside
this proposal; long-term append-only Atomic history still needs its own measured
storage and archival policy.
