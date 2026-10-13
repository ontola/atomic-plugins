# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`syncables` reads an OpenAPI document and produces two things from it:

- a **mock API server** (`createMockServer`) that implements the document,
  backed by an in-memory CRUD store per resource, seeded with fake data
  generated from the document's schemas;
- an **API client** (`createApiClient`) that talks to any server implementing
  that document and keeps a local copy of each resource collection in sync.

Both understand the [OpenAPI Pagination Schemes Extension](../openapi-extensions/spec/pagination-schemes/README.md)
when a document declares `components.paginationSchemes` (see below) —
the mock server paginates list responses accordingly, and the client walks
every page automatically.

The public API surface is defined entirely by `src/index.ts` re-exports —
check there first to see what's intended to be used from outside the package.

## Commands

Both npm and pnpm lockfiles are present; CI (`.github/workflows/nodejs.yml`) uses npm,
the README uses pnpm. Either works — stay consistent with whichever you touch.

```sh
npm run build          # tsc build to build/ (runs lint first via `prebuild`)
npm run build:watch    # tsc in watch mode
npm run build:release  # clean + tsc using tsconfig.release.json (no sourcemaps/comments)
npm test               # vitest run, config __tests__/vitest.config.ts
npm run test:watch     # vitest in watch mode
npm run test:coverage  # vitest with v8 coverage
npm run lint           # eslint .
npm run prettier       # format src/ and __tests__/ in place
npm run prettier:check # check formatting without writing
npm run clean          # rimraf coverage build tmp
```

Run a single test file or case with vitest directly, e.g.:

```sh
npx vitest run __tests__/unit/client/client.test.ts --config __tests__/vitest.config.ts
npx vitest run -t "keeps a local copy in sync" --config __tests__/vitest.config.ts
```

This package has no `main.ts`/CLI entrypoint — it's a library (`build/src/index.js`,
see `package.json` `exports`), so there's no `npm start`.

## Architecture

Data flows through four stages, each its own directory under `src/`:

1. **`openapi/`** — `load.ts` reads a document from a file path or an in-memory
   object (`js-yaml` parses both YAML and JSON) and passes it through
   `resolve-refs.ts`, which inlines all local `#/...` JSON-pointer `$ref`s
   in place (with cycle/diamond-ref handling — see the comment in that file).
   Everything downstream assumes refs are already resolved; `types.ts` holds
   the minimal OpenAPI type surface actually used (not a full spec typing).

2. **Resource discovery** — `read/model.ts` reads `components.crudResources`
   for both the one-off reader and local replica: named collections, identity
   fields, parent bindings, GET/POST list configuration and the Collection
   Object's `envelope.itemsField` (`ReadCollection.itemsField`, a dot-path
   the collection read passes to `walkPages`; without it `pageItems`
   locates the array, see "Pagination" below). `read/collections.ts`
   owns traversal and returns raw per-context collections with explicit
   completion/error status. `read/time-zone.ts` implements Filtering
   0.2.0-draft `x-time-zone` on list query parameters (the spec's
   `validate.py` client steps, with `Intl`): `zoneReader` reads each zone
   source once per `readCollections` through its budget and re-checks it at
   the end, `wallClockQuery` rewrites the query and computes the
   `ReadCoverage` set on `CollectionSnapshot.coverage` (and the client's
   `SyncResult.coverage`). For a `rangeWindow` read with a range whose
   window fields include such parameters, `wallClockWindows` gives
   `walkPages` the `windowValue` hook (wall-clock digits per zoned window
   parameter, from the same cached zone reads) and the outer range's
   coverage (`wallClockQuery` on the query with the range's ends in the
   window fields; a zoned `windowRange` field gives `noRangePredicate`);
   a finished windowed read keeps its spans with reason `incomplete`,
   while any other read that is not complete (failed, or an undocumented
   short-page end) gets `spans: null`.
   `read/read.ts` adds ontology/type projection.
   `read/produced-classes.ts` reads Produced Classes 0.1.1-draft
   (`x-produces`, `openapi-extensions/spec/produced-classes/`) as metadata
   only: `checkProduces`/`absoluteIri`/`sameSubject` port the spec's
   `validate.py` (keep them in step), `parseProduces` reads nothing from a
   declaration with any rule 2-6 violation, `discoverReadModel` puts a
   resource's classes on each of its collections (`ReadCollection.produces`,
   behind `ApiClient.produces`), `producedClasses`/`resourcesProducing`
   read a document (also a Swagger 2.0 root `x-crudResources`), and
   `lensFits` checks a caller-fetched lens's `target.class` and
   `source.record.{provider,resource}` (the fields of the catalog lenses in
   `ontology/lenses/`, `ontology-kit/lens.d.mts`). Nothing is fetched.
   `read/runtime-schemas.ts` is the consumer of the draft Runtime Schemas
   extension (`x-runtime-schema`, `openapi-extensions/spec/runtime-schemas/`,
   #398; the spec's `validate.py` `derive_class`/`read_members` are its
   reference; keep `deriveRuntimeClass`/`readRuntimeMembers` in step with
   them): after the collections, `readCollections` reads each
   describer the items' reference binds (`describerPath`), keyed per
   resource and path, through the read's `Budget`, plus at most one re-read
   when a member is unmatched (then, under `match: id` only, the items with
   an unmatched member are interpreted again), and returns `describers` and
   per-snapshot `runtimeMembers` (aligned with `items`). Under `match: key`
   the lookup covers every definition's name or id (`names`), skipping
   `duplicateNames`, so undescribed and duplicate-id members are not
   unmatched. Absent values stay absent (`MISSING`, never `null`); two
   members of one definition are `conflicting`; a describer that fails keeps
   its `error`, no class, and an entry in `errors`. `runtimeSchemasOf`
   checks the declaration (dot-paths through the spec's `SEGMENT` grammar,
   non-empty `types`, a `schema` per type) and a failure fails the
   resource's collections before any request. Describer errors are also
   in `describerErrors`; `sync()` subtracts them from `errors` before its
   "Read incomplete" check and returns them as `SyncResult.warnings`, with
   `describers`, and keeps each complete snapshot's members per scope
   (`runtimeMembersByScope`, in memory) for `runtimeMembers()`. An item
   without a class gets `noClass: true`. `readPlatform` maps snapshot items
   to records by object identity to set `ReadRecord.runtime`.

   For compatibility, the client opts into `resources/discover.ts` path-pair
   discovery when CRUD metadata is absent. The mock server still uses that
   legacy model. Legacy nested paths require `constants`; metadata-driven
   parent collections supply bindings automatically. This implements a
   subset of CRUD Causality, not all its request/patch/mint semantics.

3. **`mock-server/`** — `server.ts` is the request handler; it uses
   `routing/router.ts` (`findRoute`) to match an incoming path against the
   OpenAPI path templates. For a GET operation, it first checks whether a
   pagination scheme applies (see below) and, if so, serves it as a
   paginated list; otherwise it treats the match as a resource
   (`ResourceStore` in `store.ts`, one in-memory `Map` per collection path,
   CRUD semantics based on collection vs. item path and HTTP method) or
   falls back to serving the operation's documented example/generated schema
   response verbatim. Resource collections are lazily seeded with
   `SEED_COUNT` fake records (via `fake-data/generate.ts`) on first `GET`.

4. **`client/`** — `client.ts` is the browser-safe local-first core, exported
   by `syncables/browser`. `sync()` uses `readCollections`; `paginate()` uses
   the same `walkPages` as the reader, including POST-body cursors, next-link
   checks and budgets. Failed collections do not replace or prune stored
   records. A snapshot that ended without an error but is not complete
   (`notComplete`: range windows, an undocumented short-page end) goes to
   `upsertIncomplete`: its records are merged into the confirmed copy and
   rebuilt (per record, skipped when a write settled on it during the read;
   whole scope skipped when one settled on the scope), `lastSyncedItems` is
   dropped for the scope so a later complete read still prunes, and nothing
   is removed, held (`holdMissing`), checked or fed to a deletion feed. Each
   such collection is listed in `SyncResult.incomplete`.
   Tell before prune: in `performSync`, the records a
   complete read removes (not returned, no writes, not in
   `unavailableKept`, including ones a reused storage held) are passed to
   `options.onPresence` (awaited) before `confirmed` is replaced and the
   rebuild removes them; a throwing handler skips that snapshot
   (`SyncRound.presenceError`, thrown at the end; `skipped`, so
   `countRefreshMisses` does not count its held writes) so the next sync
   tells again; after the handler, a write that settled on the scope sends
   the snapshot down the stale path (upsert only); a record whose writes are
   all non-durable is not rebuilt there. Removals after a check
   (`releaseRefreshed`, `finishFeeds`, parent members) go through
   `rebuildTelling`, which tells each record the rebuild would remove (no
   confirmed copy, no kept mark, no durable write, stored now) first. The
   changes go on `SyncResult.presence` (`SyncRound.presence`). Presence
   marks (K4/K5): `keptMarks` (was `unavailableKept`; `presence`
   `unconfirmed`/`unavailable`/`deleted`, stored as the outbox's
   `unavailable` entries with `presence`/`source`) is the one map `rebuild`
   falls back to. In the candidate loop a vanished write-less record is
   `deleted` under `absent: deleted` (removed, or `setMark` under
   `retainDeleted`), `unconfirmed` (kept) when `lookupPlanned` or
   `route.absentRemoved`, else `removed`; `lookupPlanned` is the check gate
   (not `'none'`, an item GET or a declaration, and `absent: removed`,
   `'all'`, a parent of a `parentAbsent` collection, or nested writes). The
   lookups (per collection, previously unconfirmed first, then the read's
   new candidates; also when `!differs`) run in `releaseRefreshed`'s
   vanished loop (`checkVanished`), counted against
   `maxMissingRecordChecks` per sync across collections
   (`SyncRound.lookups`). Kept `unavailable` marks without queued or failed
   writes (`unsettled`) are re-read where `lookupPlanned` in a second pass,
   `recheckUnavailable` (from `SyncRound.unavailable`, before
   `finishFeeds`), oldest `checked` first across collections (`checkTime`,
   strictly increasing, stored with the mark; set by `checkVanished`'s
   `onChecked` only when `findEvidence` returned evidence, so a record the
   budget or a 429 left unread keeps its place), so they never take checks
   from unconfirmed or newly missing records; `reportMissing` turns
   the evidence into marks (`setMark`: changes go to the client-level
   `untoldMarks`, the latest per record, kept across syncs until told).
   `tell()` sends removals at once (dropping a held change of the same
   record) and the held mark changes at the end of a sync (skipped when the
   handler already threw in it); after a removal, records that gained a
   write or a confirmed copy get `pruned: false`. A `deleted` or `filtered`
   conclusion sets `clearing` on the mark: `rebuildTelling` drops it once
   the removal is told, or keeps the mark (not clearing) when the handler
   throws, so the record is checked again. `dropMark` drops a mark outside
   `tell`/`setMark` (a read returning the record, `settled`, a clearing
   mark on a record that stays) and
   its held change, replaced by `present` when the mark is `told` (set by
   a successful end tell and on restored marks; `setMark` keeps it from
   the mark before, or sets it when the change it replaces is a held
   `present`, the only trace of a told mark once that mark is dropped).
   `client.presence()` lists
   `keptMarks`. `seenAt` (in
   memory, set for every record a sync's reads return to that sync's start,
   dropped when `rebuild` removes the record) gives a new mark its
   `lastSeen`, which the mark keeps and stores. GET validators reuse raw cached response bodies.

   All reads and writes use `ApiClientOptions.transport`, or `fetchTransport`
   over supplied/global fetch. `auth.ts` holds credentials and an injected
   `authenticate(request, credentials)` adapter, plus API-key/bearer helpers.
   `node.ts`, exported by the main entry, adds environment fallback through
   `credentials.ts`: explicit fields override `SYNCABLES_*` values, with an
   optional prefix or disable switch. OAuth token acquisition, consent and
   persistence belong to the auth adapter. No environment loader is reachable
   from the browser entry.

   `storage.ts` holds the record-only `StorageAdapter`. Confirmed remote state
   and unresolved mutations are held separately in memory (the mutations also
   in the durable outbox, below); refresh and older
   acknowledgements replay remaining intent to derive the visible record.
   Metadata collection names and bound context identify storage namespaces;
   identical IDs in sibling parents stay separate. Legacy names remain paths.
   Writes are serialized per scoped record and retry with exponential backoff
   (`retry.maxAttempts` is optional). A POST on a collection's URL is its
   create (`createPath`) unless the resource has no identity in a CRUD
   Causality document (list-only, read-only: `list-only.test.ts`); an
   `x-crud` create of such a resource sets `createRefused` (rule 25), and
   `restore` parks a create queued for a route without one (`failed`; one
   in flight at the stop or already uncertain stays `uncertain` with its
   error and a note; `resolveWrite` `retry` throws). Creates reconcile
   server-assigned IDs; a declared `x-crud` create (`ClientRoute.create`, `created-identity.ts`)
   leaves `generated` `addedFields` out of the body (`createBody`) and reads
   the identity from its `url` source through the identity template in
   reverse (`createdIdentity`, after CRUD Causality 0.5.0's
   `created_identity()`); without one the 2xx create is `uncertain` with
   `unbound` (stored), never resent, and `resolveWrite` `retry` throws;
   a create's `followUps` (CRUD Causality 0.5.0 §4.7, `compound-create.ts`
   after the reference `missing_value`/`follow_up_request`, parsed into
   `CreateDeclaration.followUps`; one it cannot use sets
   `route.createRefused`) drop `omit` fields from the body, and once the
   create settles bound `drainQueue` puts `followUpWrites` (updates with
   `QueuedWrite.followUp`, stored as type `followUp`) at the head of the
   record's queue; `attemptWrite` computes the missing value against the
   confirmed record at send time (nothing missing: settled without a
   request), a refusal fails it `refused` and the following follow-ups
   `notSent` (a 403 is `permanent` by default for a follow-up,
   `WriteFailure.followUp`; `supersedesFollowUp` drops a failed follow-up
   once a settled write, in `supersede`, or a newer queued one, in
   `resolveWrite` `retry`, sets its field's first segment or deletes the
   record; `retry` refuses an `unknown` follow-up), an unknown outcome sets `awaitingRefresh` (read back first),
   and a `confirm`ed uncertain create queues them `awaitingRefresh`;
   updates use the item-path PUT or PATCH whose `x-crud` declares
   `action: update` for the resource (both declared: PUT; neither, or a
   legacy document: PUT, else PATCH; `clientRoutes`); the chosen operation's
   `x-crud` `mode`/`patchFormat` sets the body (`applyChanges`,
   `merge-patch.ts`): `jsonMergePatch` sends the changes alone and applies
   RFC 7396 locally, `jsonPatch` makes `update()` throw, anything else (and
   legacy documents) sends the full JSON record. Each update keeps its
   format (`QueuedWrite.updateBody`, stored); `rebuild` and sending use the
   write's, not the route's, and `restore` fails a mismatched update with
   the writes before it (`bodyMismatch`; behind a create the entry is
   unrestorable), and `resolveWrite` `retry` refuses it. On merge-patch
   writes, `detectConflicts` compares with the field after the patches
   (`patchedField`, in order) and `supersede`/`retry` strip nested members
   (`withoutSetBy`, `withoutPatched`). Read-only operations fail before local edits.
   `preconditions.ts` is the pure logic of the draft Write Preconditions
   extension (`x-write-precondition`,
   `openapi-extensions/spec/write-preconditions/`): `parsePrecondition`
   (defaults, or `{ refused }` for a declaration it cannot read),
   `versionOf`, `refusalOf`, `maySend`, `writeAnswer` and `resolveUnknown`,
   ports of the spec's `validate.py` functions of the same names; keep them
   in step (`unit/client/preconditions.test.ts` mirrors its `ClientTests`,
   and its `ValidationTests` through `parsePrecondition`, which refuses
   whatever `validate()` refuses, placement rules included when given a
   `PreconditionPlace`; it never falls back to a default on bad input).
   The client reads each write operation's declaration into
   `route.preconditions` (or `route.preconditionRefused`, which makes the
   write call throw). `attemptWrite` first runs `resolveByRead` for a write
   with `precondition: 'resolving'`, then `precheck`. `precheck` reads the
   object when the declaration needs it (`readObject`) and reads the source
   objects (`sourceObject`, cached per sync pass in `sourceCache`). It then
   calls `maySend` and gives the headers, plus the read under `readVerify`,
   which the full-record body is built on. In the catch, a `conflictStatus`
   answer or a `writeAnswer` 404/410 stops the write (`stopWrite`, gaveUp
   with `QueuedWrite.precondition`, stored). Otherwise
   `goneUnconfirmed` keeps the record and reports it `unavailable` with
   `source: 'write'`. `deletionConfirmed` takes a feed tombstone,
   `absentMeansDeleted` or `notFound: deleted`, and `route.gone` decides a
   410. An unknown outcome sets `resolving`, also on restore of an in-flight
   update or delete (not a follow-up, which preconditions skip). An unknown
   stored state reads as `resolving`. `sentVersion` is the raw version
   (string or number), stored for its rule 5. `resolveWrite` `retry` clears
   every state but `resolving`. A refused precondition read goes through
   `readRefused`: throttling sets `notBefore` and pauses buckets, and
   `auth` blocks, unless the read was sent before the latest renewal
   (then it is sent again). A source read's refusal is kept in
   `sourceErrors` by URL, with its epoch, and is not cached. The restore
   check `missingSources` includes `write` and `list`.

   `read/responses.ts` supplies an optional awaited `storeResponse` hook,
   available on client reads, `readCollections`, `readPlatform` and standalone
   pagination. It retains the original body text before interpretation and
   relevant data headers, excluding auth/cookie headers. Capture is outside
   the auth adapter so request URLs/bodies have not yet received credentials.
   It captures data-read responses only, including 304/errors/429 attempts.
   Hosts choose archival storage and retention; automatic replay is absent.

   Pending updates record the confirmed values of the fields they change;
   a refresh that shows another remote value for such a field records a
   `WriteConflict` (on `pendingWrites()` and `onConflict`) while the local
   value stays visible and is still sent. A create with no response, an
   unusable 2xx body or a 5xx other than 503 becomes `uncertain` and is not
   resent until `resolveWrite` (retry, discard, or confirm with the server
   id), unless an `Idempotency-Key` header (declared on the create operation
   or `idempotencyKeyHeader`) lets it retry with the same key. Errors
   raised before the request reaches the transport (an `authenticate`
   adapter throwing) keep the backoff retry. Non-2xx responses are
   classified (`classify`, `defaultWriteFailureClass`, overridable with
   `classifyWriteFailure`): `retry` (408/425/5xx; and any response that is
   throttling under the document's root `x-throttling`, draft Throttling
   extension, `src/throttling/throttling.ts`: `declaredThrottling` reads
   `headers` (roles and time units), `bodyFields` (0.3.0: the same roles by
   literal JSON dot-path, read from a throttling JSON body; a body wait of
   no time counts as absent) and `signals`, `classifyThrottling`
   gives the verdict the client attaches as `WriteFailure.throttling`, a
   matching signal or any 429; with `signalsDeclared` the old 403 header
   heuristic is off. The delay is max(backoff, the verdict's `retryAt`,
   the later of `retryAfter` and `reset` measured against both clocks, else
   `minDelaySeconds`, else the bucket window), stored on the write as
   `notBefore` (outbox) so a restart or `resolveWrite` retry keeps it; a
   hold (`notBefore` or a bucket pause) further away than
   `retry.maxRetryAfterMs` makes the write `gaveUp` with a `lastError`
   instead of retrying early; a `quotaExhausted` verdict, from a write or a
   read, pauses every request whose operation selects the bucket
   (`pausedBuckets`, stored as `throttlingPauses`; `pauseFor`,
   `pauseForOperation`, `operationBuckets`; the read transport waits within
   `limits.timeoutMs`), until the answer's time or else the write's backoff;
   `mayHaveApplied` ignores the verdict, so a 5xx create stays uncertain.
   Pacing (K2, `throttling/pacing.ts`): `declaredThrottling`'s `quotas`
   (Limit Objects with `requests`) feed a `Pacer` (`pace`, `paceFraction`,
   default 0.8). The `baseTransport` wrapper counts every request when it
   is sent (`take`), after waiting for room; it is not async, so a request
   with room adds no tick. Reads wait first in `waitOutPacing` within their
   limit (`RetryBeyondDeadline`). `drainQueue` holds a write for
   `pacingDelay` without the `maxRetryAfterMs` failure or an attempt.
   `pacingSleptUntil` takes a wait that did not move as waited out. For another
   retryable answer the delay is max(backoff, `Retry-After` capped at
   `retry.maxRetryAfterMs`), never below the backoff. The read `Budget`
   uses the same verdict to wait before retrying), `permanent` (other 4xx: failed
   at once, through the same path as `retry.maxAttempts`), `satisfied` (a
   delete's 404/410 settles it) and `auth` (401; 403 unless sent after a
   renewal before an accepted response, then `permanent`; `afterRenewal`
   and `authEpoch` are captured after the in-flight store, just before
   sending, and any response at the current epoch that `classify` does
   not report `refused` clears `afterRenewal`; `refused` also covers a
   response the classifier in use (`classOf`, called a second time with
   `afterRenewal: false` for requests sent after a renewal) calls
   `auth`). `onAuthFailure: 'retry'` turns `auth` into `retry` and drops a stored block on restore.
   A create classified `auth` that `mayHaveApplied` (custom classifier on a
   5xx) without a usable key goes the `retry` path, so it becomes
   `uncertain`.
   `auth` sets the client-wide
   `authBlock` (stored in the outbox, `onAuthBlocked`, `authBlocked()`): the
   write becomes `blocked` without counting an attempt, `drainQueue` sends
   nothing while it is set (also re-checked after the in-flight store:
   outcome `held`), `countRefreshMisses` does not count, `resolveWrite`
   `discard` drops a blocked head, and
   `authRenewed()` clears it, bumps `authEpoch` and restarts every queue. A
   401/403 for a request sent before the latest renewal (older epoch) is
   resent at once. A failed create (`retry.maxAttempts` or `permanent`) is
   parked like an uncertain one; failed updates and deletes are kept per
   record (`gaveUpWrites`), lose the fields a later
   settled write sets, and are not dropped by new writes. Settled writes
   rebase later queued updates' conflict bases and invalidate
   `lastSyncedItems`. See the README's "Uncertain creates".

   `outbox.ts` holds the durable outbox format: one versioned record
   (`syncables:outbox`/`outbox`, `outboxNamespace`; off without a supplied
   `storage`) in the same adapter with every unsettled write (queues, failed
   writes, states, conflict bases, idempotency keys, the confirmed record per
   written record, pending id-remap rebuilds). It is stored whole,
   serialized, before the visible record on `create`/`update`/`remove`,
   before each send (an in-flight mark) and after each outcome. A write whose
   own first store has not succeeded is left out of other calls' stores.
   `restore()` runs at construction (`ready()`; retried after a storage
   error, not after a version refusal); a write found in flight counts as an
   attempt (`retry.maxAttempts` applies), and a create without a key the
   client can still send becomes `uncertain`. Restored updates wait
   (`awaitingRefresh`) for a complete `sync()` of their scope before sending,
   unless a create precedes them; a settle on the same record during the
   read (`recordRevisions`) skips the release, three non-releasing syncs
   fail it, and `resolveWrite` retries or discards it (the miss count is
   stored). A complete read lacking a record with queued updates (restored
   or in memory, PUT or PATCH) holds them (`holdMissing`: `awaitingRefresh`
   on each update up to the first create, never on one with `sending`), at
   once in `performSync` and again in `releaseRefreshed`. When the record's
   queue head is such an update, idle (`evidenceHead`), `findEvidence` asks
   the route's `x-completeness: { absent: deleted }` (`declaredCompleteness`,
   draft spec in `openapi-extensions/spec/collection-completeness/`), else
   GETs the item through the sync's shared `Budget` (passed to
   `readCollections` as `budget`): 404/410 `deleted`, or `unavailable` when
   the record's resource states `notFound: unavailable` through any
   collection (a 410: its `gone`, `route.gone`, Collection Completeness
   0.3.0, when stated; `route.notFound`, resource-wide, from `resourceNotFound`
   over every collection's `rawCompleteness`, after the reference
   `resource_not_found`; conflicting or unrecognised values are
   `unavailable`, a value beside an unrecognised `absent` counts; undefined
   when not stated, which the Write Preconditions consumer must not take as
   a confirmed deletion; a route whose own Completeness Object has an
   unrecognised `absent` has `unrecognisedAbsent`, and what neither `gone`
   (a 410) nor `notFound` classifies is then `unavailable` (§7, after
   `classify_read`); 0.2.0 §4.3; `declaredCompleteness` parses `absent`
   and `parentAbsent`, and ignores a declaration with an unrecognised
   `absent`), 2xx with the record
   and the resource's `x-read-tombstone` marker (`declaredReadTombstone`,
   on the CRUD Resource Object, else, or when that one does not parse, the
   item GET operation, a Tombstone Object of the deletion-feeds draft; not
   stored itself, though with a feed the end-of-sync feed read may store a
   feed tombstone for the failed record) `deleted`, other 2xx
   with the record `filtered`, else `unknown`; budget spent (`BudgetExhausted`,
   `RetryBeyondDeadline`, a 429 handed back) means unchecked (held, a miss).
   For a collection with a deletion feed (`x-deletion-feed`,
   `declaredDeletionFeed`, draft spec in
   `openapi-extensions/spec/deletion-feeds/`), a record with a tombstone
   stored from an earlier feed read (`feedTombstones`, in the outbox, only
   for records with unsettled writes; dropped when a read or a `filtered`
   GET returns the record, a write to it settles with a 2xx, or a later
   item is not a tombstone; not stored by a feed read for a record a write
   settled on during the sync, or whose stored tombstone a read dropped
   earlier in it, `SyncRound.superseded`) goes to `SyncRound.undecided` with
   `stored`
   and no GET; unchecked, `unknown` and `unavailable` GET answers go there
   too (a feed tombstone stands over `unavailable`; without one, that
   answer applies).
   `finishFeeds`, after every collection's checks, reads each feed once
   (`readFeed`: `walkPages` through the same `Budget`, from the cursor in
   `feedCursors`, items counted per read against `maxRecords`;
   an incomplete or malformed read gives no tombstones and keeps the
   cursor, apart from a declared expired status) and settles them: a
   tombstone, or a stored one this complete read does not supersede with a
   later non-tombstone item, fails the heads as `deleted` (`source: 'feed'`,
   `failMissing`); else `unknown` fails as before, and unchecked or
   superseded stays held. Not read under
   `absent: deleted` or `missingRecordChecks: 'none'`.
   The declaration is dropped for a collection a `selection` narrows past its
   `listQuery` (or `x-list-query`), and an operation-level one counts only without a fixed
   query or body. An update in flight when `holdMissing` ran gets
   `holdIfQueued` (not stored) and is held if its outcome leaves it queued;
   a later complete read that returns the record, or `resolveWrite` `retry`
   on the record, clears the flag.
   `failWrite` and the waiting-path `discard` wake a removed head's drain.
   `deleted`/`unavailable`/`unknown` fail the head and each following held
   update (`failWrite`, `missingRecord`, stored; a sleeping drain is woken
   through `wakers`); `filtered` takes the returned record as confirmed (conflicts
   checked) and releases. A record settled on during the check (up to the
   end-of-sync feed read) is left to the next sync. `onMissingRecord` reports evidence; `missingRecordChecks`
   `'all'` also GETs `vanished` records without writes, `'none'` never GETs.
   For a nested collection whose Collection Object declares
   `parentAbsent` (`declaredCompleteness`, `route.parentAbsent`; mapped by
   the collection that supplies its path variable in `nestedUnder`, from
   `model.providers`, skipping variables `constants` fix; dropped with two
   or more parent resources), every parent
   record concluded `deleted` or `unavailable` (declaration, GET or feed, at
   the same three points as `reportMissing`) has `applyParentAbsent` conclude
   the records last read under it (`nestedScopes`: confirmed records and
   writes in scopes whose variable is the parent id) as `unavailable`,
   never `deleted` (any `parentAbsent` value), with `source: 'parent'` and
   the last known values as `record`, failing their heads through
   `failMissing` and skipping a member a write settled on since the sync
   began, or one this sync's read returned in the same scope
   (`SyncRound.returned`, by scope: a bare id under another parent is
   still marked); nothing is pruned. Records concluded `unavailable`
   (`reportMissing`) are kept in `unavailableKept` (stored as the outbox's
   `unavailable`) and `rebuild` falls back to them, so neither a vanished
   write-less record nor one whose writes were discarded is pruned; a read
   returning the record, a `filtered` or a `deleted` conclusion clears it.
   `update()`/`remove()` of a kept record are held (`awaitingRefresh`) for
   the next refresh. `holdMissing` and `evidenceHead` include deletes: a
   held delete is released (and woken) unless the evidence is
   `unavailable`, which fails it. `failMissing` on
   `unavailable` also fails the rest of the record's queue in order,
   deletes included, and parks a create in place (state `failed`,
   `missingRecord`), stopping at a head in flight, not stored or already
   parked. Each concluded nested scope is marked in `goneParents` (in
   memory, cleared by a complete read of the scope); `update()` into a
   marked scope, `remove()` into one, and `create()` into one, are
   enqueued held and concluded at once (`concludeNew`). An unrecognised
   `notFound` value is `unavailable`. Under `'pending'`, a `vanished`
   parent is GETed when `nestedWritesUnder` finds unsettled writes under
   it, with a revision check around the GET.
   `update()` holds a new edit of a record whose failed writes carry
   `missingRecord` and that `confirmed` lacks. `lastKnown` keeps the newest
   confirmed copy (`setLastKnown` on every refresh and settled response;
   update responses are merged over
   the record that was sent); updates, retries and `update()` seeding use
   it, never the visible record. It is stored once per record entry, and
   only when `confirmed` is absent, so the outbox grows by the changes per
   write, not by the record. Only head writes fail or count
   misses: a failed write must never be newer than a queued one of the same
   record (`seq`, stored, lets the tests check this; `expectFailedOlder` in
   the tests). Writes not
   yet durable are skipped by `rebuild`. Unknown versions are refused, not
   overwritten. The README's "Durable outbox and restarts" has the
   stop-between-steps table; keep it in step with the code. Not stored:
   `lastSyncedItems`, the conditional cache and confirmed records without
   writes. A fully paginated list is not necessarily a consistent snapshot;
   the existing absence/pruning rule still depends on provider behavior.

`fake-data/generate.ts` (`generateFromSchema`) is shared by both the mock
server (seeding + example responses) and is the only place schema-to-value
synthesis logic lives — it prefers a schema's own `example`, then `enum`,
then handles `allOf`/`oneOf`/`anyOf`/type-based generation recursively. A
schema's own fixed `example` is reused verbatim on every call, so callers
generating more than one item from the same schema (resource seeding,
paginated list generation) must inject their own unique `id` afterward
rather than relying on the generated value to differ per item.

### Pagination (`src/pagination/`)

Implements the [OpenAPI Pagination Schemes Extension](../openapi-extensions/spec/pagination-schemes/README.md)
(`components.paginationSchemes`), applied to third-party documents via
[OpenAPI Overlays](https://spec.openapis.org/overlay/v1.0.0.html)
(`src/openapi/overlay.ts`, `applyOverlay`/`loadOverlay` — an intentionally
minimal Overlay implementation: `update`/`remove` actions with plain
dot-path targets like `$.components`, not the full JSONPath grammar).

- `types.ts` mirrors the extension's spec objects verbatim.
- `validate.ts` checks a scheme against the spec's own rules (§9); an
  invalid scheme (e.g. a `type` outside `pageNumber`/`pageToken`/`nextLink`)
  is excluded from auto-detection rather than throwing — one broken scheme
  in a document shouldn't disable the rest.
- `autodetect.ts`'s `resolveEffectiveScheme(document, operation)` picks the
  scheme that applies to an operation: an explicit `x-pagination` entry
  first, else auto-detection by matching the scheme's declared query
  parameter/body field names against the operation's own (§6.2 default
  rules — a dimension with zero declared fields never vacuously matches).
  An explicit entry that cannot be applied (not an array of application
  objects, an undeclared or invalid scheme, or one its overrides make
  invalid) throws `PaginationSchemeError` instead of being dropped: a read
  that ignored it would return one page as the whole collection (#384). The
  client's conditional-cache check treats such an operation as paginated,
  and the mock server answers 500.
  Only the query-parameter and body-field dimensions are actually
  implemented — `AutoDetectObject.matchHeaders`/`matchResponseFields` and
  `RequestPaginationFieldsObject.headerFields` are part of the type surface
  (mirroring the spec) but nothing reads them yet, so a scheme that can only
  be auto-detected via a request/response header (e.g. a `Link`-header
  `nextLink` scheme, like GitHub's) needs an explicit `x-pagination` entry
  until that's implemented.
- `items.ts` locates which top-level response property actually holds the
  list of items — the extension itself only describes pagination metadata,
  not where items live, so this excludes whatever fields the scheme claims
  as metadata, then picks the remaining array-typed property (falling back
  to common envelope names: `items`/`data`/`results`/`records`/`content`).
  This is also what makes real enveloped responses (e.g. `{ data: [...],
  meta, pagination }`) work at all, pagination or not.
- `request-builder.ts` builds query parameters for a page from a `PageCursor`
  (offset/page/pageToken) and computes the next cursor from response state.
- `response-parser.ts` parses that state back out of a response
  (`bodyFields` keys may be dotted paths into nested objects, e.g.
  `pagination.total_count`; `headers` supports RFC 8288 `Link` parsing for
  `nextLink`-role headers) and derives `hasNextPage`. The `nextLink` value
  is kept raw (`nextLinkValue`, never coerced) with the field's
  `linkResolution` (`nextLinkResolution`).
- `window.ts` is the `rangeWindow` arithmetic of Pagination Schemes
  0.5.0 §4.6 (after the spec's `validate.py`): `parseBound`/`formatBound`
  for the five bound formats as exact strings, `windowWidth`, `halves`
  (the default split, `undefined` below `2 × minimumWidth`) and
  `windowRequest` (a template, or a start and an end field, per location).
  `walkPages` hands a `rangeWindow` scheme to `walkWindows` (in
  `read/pages.ts`), which needs `PageWalk.range`, splits full answers depth
  first, throws `WindowReadError` for a full window it cannot split, keeps an
  item once through `PageWalk.identity`, and sets `PageWalk.outcome` to not
  complete. `PageWalk.windowValue(parameter, bound)` converts each query
  window bound before it is sent (for a parameter read as wall-clock time,
  `x-time-zone`; the caller supplies it), each bound separately before a
  template is filled; converted bounds on one clock that end up out of
  order (a window inside a repeated hour) throw `WindowReadError`.
  `readCollections` turns a windowed read into `complete: false` with
  `notComplete`, and the client never applies such a snapshot. The
  validator checks §9 rules 12–16, `resolveEffectiveScheme` rule 17 (and
  never auto-detects a `rangeWindow` scheme); rule 18 is not checked here.
- Pagination Schemes 0.6.0: `request-builder.ts`'s `pageStart` is the
  `page` field's `start` (default 1), used for the first page, the next
  page and by the mock server. `walkPages` reads a `pageNumber` scheme's
  `shortPage`: before a page is handed on it throws `PageReadError` for
  more than the full size (`size`, or a reported `pageSize` field) or an
  item identity an earlier page of the read returned; after it, a page
  with fewer items ends the walk (`PageWalk.outcome` not complete unless
  `assurance: documented`; an error under `documented` when `totalPages` or
  `totalCount` says more follow, not complete otherwise), and a full page
  goes on to the next page number unless `totalPages` (a count: the last
  page is `start + totalPages − 1`) or `totalCount` ends it, which is
  complete whatever the assurance. `currentPage` is numbered like the
  `page` field (`deriveHasNextPage`'s `firstPage`). The page size sent is
  capped at the parameter's `maximum`. The validator checks §9 rules
  19–21, `resolveEffectiveScheme` rule 22.
- Pagination Schemes 0.7.0: an Envelope Object's `emptyWhenAbsent`
  (`declaredEnvelope` in `read/pages.ts`, from `PageWalk.itemsField`/
  `emptyWhenAbsent`, which a Collection Object's envelope sets through
  `ReadCollection.emptyWhenAbsent`, else the scheme's `response.envelope`)
  makes `itemsAt` return no items when the field is absent (`isAbsent`: an
  object along the path lacks the next segment); a present non-array is
  still an error. The validator checks rule 23. Tests:
  `unit/read/empty-when-absent.test.ts`. An `offset` field's `advance`
  (§4.3.2; `offsetAdvance` in `read/pages.ts`): `pageSize` steps the
  offset by `state.pageSize` (≥ 1), else the page size sent
  (`sendsPageSize`), ends at `totalCount` (without one, at an empty page)
  and throws `PageReadError` with neither (`integerRole`: a reported
  `pageSize` counts as an integer ≥ 1, `totalCount` as an integer ≥ 0, read
  from the body per response); `itemCount` (default) steps by the items
  the page held and ends at an empty page or `totalCount` (#495: before,
  without a `totalCount`, `hasNextPage` ended it after one page), unless
  the scheme declares a `nextLink` (`declaresRole`), which then leads under
  either advance (0.7.1): the offset cursor is not advanced while links
  are followed, so neither advance branch runs for such a scheme, and an
  absent or `null` link ends the read before `hasNextPage` is asked (not
  complete when that response's `totalCount` exceeds the items read). The repeat check (`seenIds` by `PageWalk.identity`,
  else the previous page's fingerprint when no item has an id) runs on
  every offset walk as well as on short-page walks. The validator checks rule 24,
  `resolveEffectiveScheme` rule 25. Tests: `unit/read/offset-advance.test.ts`.
- `links.ts` is `resolveLink`, the consumer side of Pagination Schemes
  0.4.0 §4.4.3–§4.4.4 (the spec's `resolve_link()` in its `validate.py`):
  `null`/`""` means no next page; a non-string, whitespace, a control
  character, a backslash, a non-ASCII character, three or more leading
  slashes, a scheme without `//host`, an empty authority, or a `#` in the
  raw value is refused (rule 2); the rest is resolved with WHATWG `new URL`
  against the request URL, the server URL as a directory (`base: server`)
  or the declared `url`, and refused unless it has the server's origin and
  no userinfo or fragment. `walkPages` requests exactly the returned `URL`
  object (§4.4.4 rule 4) and keeps its repeated-page check (rule 5); a
  `LinkRefused` ends the read with an error, never as the last page. The validator checks
  `linkResolution` (§9 rules 8–10) and accepts the roles added up to 0.4.0;
  `incrementalSync` schemes are still not implemented.

**Pagination is orthogonal to the collection/item resource model.** In
real APIs, the paths that pair into a "resource" (batch-get-by-IDs style,
e.g. Giphy's `/gifs`, Spotify's `/albums`) are often *not* the paginated
ones — real pagination usually lives on separate search/list endpoints
(`/gifs/trending`, `/artists/{id}/albums`) that have no sibling item path
and are therefore invisible to `discoverResources`. So pagination support
in both the mock server and `client.paginate()` operates on *any* GET
operation matched by a scheme, not just discovered resources; `sync()`
additionally upgrades a resource's collection GET to use it when it
qualifies, but falls back to today's single-request behavior otherwise.

### Browser read path (`src/read/`, `src/browser.ts`)

`package.json` exports a second entry, `syncables/browser` (`src/browser.ts`).
It holds the reader and local-first core for browser and iframe plugins. `read/model.ts`
discovers collections from `components.crudResources`, a read-only port of
reflector's `discoverResourceModel`. `read/pages.ts` walks the pages of one
operation with the `pagination/` modules above, including request-body
cursors for POST lists. `read/ontology.ts` derives terms typed with Atomic
Data datatypes. `read/collections.ts` owns shared raw traversal; `read/read.ts` adds
`readPlatform` and `paginate`. All requests go through an injected `Transport`
(`read/transport.ts`).

Nothing reachable from `src/browser.ts` may import a Node built-in or
`js-yaml`. This is why `applyOverlay` lives in `openapi/apply-overlay.ts`,
and `openapi/overlay.ts` only adds the file-reading `loadOverlay` on top of
it. `__tests__/unit/browser/bundle.test.ts` enforces the rule by bundling the
entry with esbuild `platform: 'browser'`. Keep `fs`/`http`/`node:crypto` in
`openapi/load.ts`, `openapi/overlay.ts` and `mock-server/`. `index.ts`
re-exports the shared APIs with the Node constructor/environment adapter, with `paginate` renamed `paginateOperation`.

Tests under `__tests__/unit/` mirror this `src/` layout one-to-one (e.g.
`unit/client/client.test.ts`, `unit/mock-server/server.test.ts`,
`unit/pagination/*.test.ts`), plus:
- `unit/client/unified.test.ts` covers custom transports, scoped metadata
  collections, POST paging, response capture, auth configuration and local
  intent across refresh/acknowledgement races.
- `unit/client/pending-writes.test.ts` covers #260 gaps 1 and 2: same-field
  conflicts during refresh, uncertain creates (lost responses, unusable 2xx,
  5xx), their `resolveWrite` resolutions and idempotency-key retries.
- `unit/client/durable-outbox.test.ts` covers restart recovery: a second
  client on a copy of the first one's storage taken mid-flight (resume order,
  in-flight creates/updates/deletes, failed/uncertain/conflict state, format
  versions and outbox store failures), plus the stored auth block and
  failure statuses.
- `unit/client/failure-classes.test.ts` covers write failure classes: the
  default table, permanent 4xx, satisfied deletes, `Retry-After`, the auth
  block and `authRenewed()`, and `classifyWriteFailure`.
- `unit/client/missing-records.test.ts` covers records a complete refresh no
  longer returns: the in-flight-head ordering case, PUT and PATCH, the
  evidence GET's 404/410/2xx/other answers, `x-completeness` declarations,
  the shared read budget, `missingRecordChecks`, and restarts.
- `unit/client/completeness-outcomes.test.ts` covers Collection Completeness
  0.2.0 §4.3, `notFound`: a 404 or 410 as `unavailable` (PUT and PATCH, the
  held write, the kept values, the report), the `deleted` default (no field,
  `deleted`, an unrecognised value, no declaration), the operation and
  legacy placements, no GET under `absent: deleted`, a later list or GET
  superseding the mark for new updates, the stored value across a restart,
  `missingRecordChecks: 'all'`, and precedence against a deletion feed; and
  §4.4, `parentAbsent`, on the spec's §6.1 task lists
  (`nestedTaskLists` in `__tests__/fixtures/deletion-declarations.ts`): the
  tasks of a list that answers 404 concluded unavailable without a request,
  a queued task update under a vanished list (the list GETed under the
  default checks, the update failed as unavailable, the list's return), no
  GET for a vanished list without writes under it, tasks unavailable (never
  deleted) under a declared-deleted parent (no GET at all), any
  `parentAbsent` value under parents concluded three ways, a moved member
  not marked, a resource-wide `notFound` through an undeclared collection
  (another collection, conflicting values, an unrecognised `absent`, an
  `x-crud` list operation, none stated), no parent marks under an
  unrecognised `absent`, `resourceNotFound` itself (wp-consumer R2), and no
  conclusion for a parent that still exists, without the field, or with it
  on the list operation; the #399 review:
  a DELETE behind an unavailable record's update failed rather than sent, a
  create into an unavailable parent's scope parked, a new edit of a member
  under an unavailable parent concluded at once and sent again after the
  parent returns, `record` on unavailable reports, and an unrecognised
  `notFound` read as `unavailable`.
- `unit/client/update-modes.test.ts` covers update bodies (`mode`,
  `patchFormat`, merge patches, conflicts, stored `updateBody`) and which
  operation updates: a declared PATCH over an undeclared PUT, the reverse,
  both declared, neither, another resource's `x-crud`, and a declared
  `jsonPatch` PATCH throwing.
- `unit/client/write-preconditions.test.ts` covers the client side of
  Write Preconditions: `ifMatch` (body version without a read, header
  version with one, `conflictStatus` and `header`), `refuseWhen`,
  `readVerify` (conflict, the body built on the read, a delete),
  unknown outcomes (applied, not applied, another change, an idempotent
  PUT resent, a restart), a write's own 404/410 (unconfirmed, confirmed
  three ways, `gone` over `notFound`, an update stopped), source objects
  (refused, unreadable then sent), `kind: none`, an unusable declaration
  and an unknown stored state.
- `unit/client/calendar-recurring-refuse.test.ts` reads the repository's
  Calendar write-preconditions overlay from `../overlays/` and applies its
  operation updates to a Calendar-shaped document (K18 part 2): the
  declarations parse under the placement rules, a series' master event
  (`recurrence`) is refused for update and delete without a request, and a
  single event and an exception are sent with `If-Match`.
- `unit/client/deletion-feeds.test.ts` covers `x-deletion-feed`: tombstones
  for records the GET left undecided (on the collection or list operation,
  `idField`, no `tombstone` field, a restore after a tombstone), stored
  tombstones across a restart, the cursor advancing and surviving a restart,
  paginated feeds, the budget (two collections, a new client per sync, the
  shared `maxRecords`), malformed and expired reads, and precedence against
  `x-completeness` and the GET.
- `unit/client/read-tombstones.test.ts` covers `x-read-tombstone`: a 2xx
  GET with and without the marker, PUT and PATCH, the placements (CRUD
  Resource Object, item GET operation, ignored on a collection, legacy
  documents), malformed declarations, the in-flight head and the budget,
  no storing, restarts, and precedence against `x-completeness` and stored
  and feed tombstones.
- `unit/client/deletion-declarations.test.ts` runs the deletion
  declarations as the draft specs' own examples
  (`__tests__/fixtures/deletion-declarations.ts`: Deletion Feeds §2,
  §7.1–§7.4 and the §6 overlays; Collection Completeness §2, §4.1, §6 and
  the §5 overlay; its §6.1 `nestedTaskLists` is used by
  `completeness-outcomes.test.ts`), each test naming the spec statement it checks, plus
  pending-edit recovery on those documents (a PUT in flight across a
  restart, with and without the record deleted meanwhile; a lost answer on
  a PUT and a POST; a refused write: 422, a delete's 404, a 403 block). The
  §2 tests, whose feed is the list itself and whose Collection Object
  declares `envelope: { itemsField: data.transactions }`, check that the
  collection read and the feed read share that envelope (#373), with the
  numeric cursor sent back in decimal form, a `deleted: true` tombstone
  found through the identity binding, and `"true"` not taken for `true`.
- `unit/client/compound-create.test.ts` covers compound creates on a
  GitHub-issues-shaped document after the held overlay
  (`__tests__/fixtures/compound-create.ts`): labels applied, dropped and
  added, an `omit` field, a refused follow-up (403 and 422: partly
  applied, the next `notSent`, no auth block, later writes going on, a
  401 still blocking, a custom classifier deciding, superseded by an update
  of its field) and its retry, an unknown outcome skipped or resent after the
  read, a restart, an unresolved bind, a refused declaration, a confirmed
  uncertain create, and no `followUps`; `compound-create-core.test.ts`
  the pure parts.
- `unit/client/list-tombstones.test.ts` covers Deletion Feeds 0.3.0-draft
  `x-list-tombstone` (`read/list-tombstones.ts`, after the reference
  `list_tombstone`; parsed into `ReadCollection.listTombstone`, filtered in
  `readCollections` into `CollectionSnapshot.tombstones`, and in `sync()`
  the `listTombstoned` ids of the sync's reads are `findEvidence`'s first
  evidence, `source: 'list'`) on the spec's §7.5 example
  (`__tests__/fixtures/list-tombstones.ts`); the client's `Tombstone`
  (feeds, read tombstones) is the same parsed object, so `except` applies
  everywhere, tested with read tombstones there too. A list tombstone's
  identity joins `readCollections`' repeated-identity check (a repeat fails
  the read), and a read that ends with an error keeps `tombstones` empty.
  In `performSync`'s pruning loop a write-less record in `listTombstoned` is
  `deleted` with `source: 'list'` like `absent: deleted` (removed, or
  `setMark` under `retainDeleted`; a kept mark goes to `recheck`), and the
  vanished loop does not count it against `maxMissingRecordChecks`;
  `upsertIncomplete` fails held heads of an incomplete read's list
  tombstones (`listEvidence`, `failMissing`, `rebuild`).
  `unit/client/list-tombstones-presence.test.ts` covers those paths
  (presence, `retainDeleted`, marks, the check limit, incomplete reads,
  repeated items, a restart), `completeness-outcomes.test.ts` a
  `parentAbsent` parent concluded by a list tombstone, and
  `deletion-declarations.test.ts` `except` on a deletion feed.
- `unit/client/runtime-classes.test.ts` covers the classes in
  `readPlatform` (`runtime`, `describers`) and `sync()` (`describers`,
  `runtimeMembers()`, `warnings` and `noClass` for an unreadable describer,
  a failed collection still throwing).
- `unit/read/produced-classes.test.ts` runs Produced Classes on the spec's
  example (read from `openapi-extensions/`), mirrors its `ValidationTests`
  through `checkProduces`, covers `resourcesProducing`, the read model and
  `ApiClient.produces`, and `lensFits` on the published lenses read from
  `ontology/lenses/`.
- `unit/read/runtime-schemas-reference.test.ts` mirrors the spec's
  `ReadingTests` (same TABLE and ROW) against `deriveRuntimeClass` and
  `readRuntimeMembers`, plus the declarations `runtimeSchemasOf` refuses.
- `unit/read/runtime-schemas.test.ts` runs Runtime Schemas on the spec's
  §7.1 example (`__tests__/fixtures/runtime-schemas.ts`): the derived class
  and values, a rename, one describer read per read and the one re-read,
  absent values, kept unknown options, invalid option shapes, undescribed
  types, duplicate ids, `memberType`, unreadable or unbound describers, and
  an unusable declaration.
- `unit/read/collections.test.ts` covers the Collection Object's
  `envelope.itemsField` in the collection read (#373): the model field, a
  nested dot-path, a missing or non-array path (an incomplete read with
  "No items array at <path>", never an empty one), no heuristic once an
  envelope is declared, and the unchanged heuristic without a declaration,
  or with one that is not a string (`null` and `""` mean the body root since
  #384). `unit/read/envelope.test.ts` covers #384 items 6, 7, 9 and 10a (a
  non-object item fails the read; `null`/`""` as the root; the body-root
  error text; the scheme's own `response.envelope`),
  `unit/client/envelope.test.ts` items 7 and 10b (a feed with
  `itemsField: null`; `ApiClient.paginate` through the Collection envelope),
  and `unit/pagination/links-conformance.test.ts` items 3, 4, 5 and 8 (raw
  userinfo, non-http(s) origins, the declared-url pattern, bracket-escaped
  dot-paths).
- `unit/throttling/body-fields.test.ts` mirrors the Throttling spec's
  `BodyFieldTests` and `BodyFieldFollowUpTests` (0.3.0 `bodyFields`, #463's
  rules) and the held Todoist overlay's test, on `bodyFieldsExample` and
  `todoistThrottling` in `__tests__/fixtures/throttling.ts`.
- `unit/throttling/pacing.test.ts` covers `Pacer` (sliding, unspecified,
  fixed with and without an anchor, several buckets, the minimum of one,
  the fraction's range) and `declaredThrottling`'s `quotas`;
  `unit/client/pacing.test.ts` the client: reads through the injected
  sleep, a wait past the read limit, the Moneybird 120 of 150, `pace:
  false` and `paceFraction`, a write held without failing or an attempt,
  concurrent drains counted at send time, and an operation whose
  selection leaves the bucket out.
- `unit/throttling/throttling.test.ts` mirrors the Throttling spec's
  `ClassifyTests` on its synthetic example (`__tests__/fixtures/throttling.ts`,
  which also holds the GitHub, Google and Moneybird snippets), plus
  `headerTime`, `declaredThrottling`'s leniency and `operationBuckets`;
  `unit/client/throttling.test.ts` runs those snippets through writes (the
  reset wait, the minimum delay, a non-matching 403 blocks, Retry-After,
  giving up past `maxRetryAfterMs`, a signalled 500 create staying
  uncertain, the stored `notBefore` across a restart, the backoff floor, the
  held-write cap, reads sharing the paused buckets, the bucket
  pause) and reads (the injected sleep, the deadline, the spec example
  through `sync()`), and the 403 heuristic without signals.
- `__tests__/fixtures/pets.ts`, a shared hand-written OpenAPI fixture used
  across multiple test files for CRUD-resource-shaped scenarios.
- `__tests__/fixtures/real-world/`, real OpenAPI documents and pagination
  overlays vendored unmodified from apis.guru and localthought/overlays
  (see the header comment in each file for provenance; the overlays have
  since moved into this monorepo's [`overlays/`](../overlays/), published at
  `https://ontola.github.io/atomic-plugins/overlays/`, and the vendored
  copies are byte-identical to the files there). `acceptance/*.test.ts`
  runs the full pipeline against these and deliberately documents real
  quirks rather than working around them — e.g. an enveloped (non-array)
  collection response, or a 405 on a collection that only supports `POST`.
  When extending these, keep that spirit: assert what actually happens
  against the unmodified real document, not an idealized result. (Giphy's
  overlay originally failed the extension's own validation — `type: offset`
  isn't a valid scheme type — which was fixed upstream in
  https://github.com/localthought/overlays/pull/139; the vendored copy
  reflects that fix.)

### Webhook inbox consumer (`src/inbox/`)

The daemon side of a webhook receiver (ontola/atomic-plugins#369 step 4,
`openapi-extensions/spec/webhook-subscriptions`). `sign.ts` uses
`node:crypto` and is exported from the Node entry only; `client.ts`,
`consumer.ts` and `reads.ts` are in `syncables/browser` too, and must run in
atomic-server's QuickJS sandbox, which has no `URL`, `URLSearchParams`,
`Buffer`, `TextDecoder` or `atob`: `url.ts` builds request URLs as strings
(a stand-in object where `URL` is missing), `reads.ts` decodes base64 UTF-8
itself, and `unit/inbox/sandbox.test.ts` runs the bundle in a bare `vm`
context. `acknowledge: 'next-step'` is for hosts whose writes become
durable only after the step (a scheduled sandbox run's intents): the cursor
to acknowledge and a finished reconciliation are stored with the step's
writes (`StoredSubscription.unacknowledged`, `.unconfirmedReconciliation`)
and sent at the start of the next step (`unit/inbox/deferred.test.ts`).
`sign.ts` signs requests with Atomic v2
signatures (`signedTransport`; tested against atomic-server's golden vectors
in `__tests__/fixtures/atomic-request-v2-vectors.json`, the copy
`integration-proxy` verifies). `client.ts` is `InboxClient` for the consumer
routes. `consumer.ts` is `InboxConsumer.step()`: an event is appended to the
caller's durable `InboxJournal` before it is acknowledged; a gap, a new
subscription or an expiry (410) is recorded and followed by the caller's full
`reconcile()` before `reconciled`. `reads.ts` (`scopedReads`) lists the paths
an event names in `x-webhook-deliveries`. Tests in `unit/inbox/` run against
`fake-inbox.ts`, an in-memory receiver with generations, barriers, a
retention limit and leases on a simulated clock.

## Conventions

- ESM throughout (`"type": "module"`); intra-package imports use explicit
  `.js` extensions (e.g. `from '../resources/discover.js'`) because
  `moduleResolution` is `node16`.
- `tsconfig.json` (base, used for dev/test) has `strict`, `noUnusedLocals`,
  `noUnusedParameters`, `noImplicitReturns` all on, and includes `src`,
  `__tests__`, `examples`. `tsconfig.release.json` extends it for
  `build:release`, restricted to `src`, excluding test files, without
  sourcemaps/comments.
- ESLint (`eslint.config.mjs`) uses `typescript-eslint` recommended rules plus
  `@typescript-eslint/explicit-function-return-type` as a warning, and a
  vitest plugin scoped to `__tests__/**`. Prettier config (`.prettierrc`) is
  applied via `eslint-config-prettier`, so ESLint won't fight Prettier.
- Node engine is pinned to `>= 22.11 < 23` (see `package.json`
  `engines`/`volta`).

## Generative AI disclosure (NLnet policy)

This project is NLnet-funded and follows [NLnet's Generative AI policy](https://nlnet.nl/foundation/policies/generativeAI/). If you (an AI coding assistant) make a commit here, keep it compliant:

- **Commit trailer.** Every commit produced with AI assistance carries a `Claude-Session: <url>` trailer (see the git commit instructions this session was given, or match the existing convention in `git log`).
- **Session log.** For any session that produces a commit, add or update a file under [`docs/ai-logs/sessions/`](docs/ai-logs/sessions) named `YYYY-MM-DD-<short-slug>.md`, following the format of existing entries there: session URL, model name/version, the substantive human prompts and substantive assistant outputs (not the harness's internal system prompt or tool-call plumbing — see [`docs/ai-logs/README.md`](docs/ai-logs/README.md) for what's in/out of scope). If the same session also touched the sibling project (`localthought/reflector`), it's fine to log only the syncables-relevant turns here and link to that repo's log for the rest.
- **Redact before committing.** Review the log for credentials, personal information (emails, etc.), and other session-identifying detail that isn't needed to understand what was asked and produced; mark redactions inline as `[redacted]` rather than deleting silently.
- **No retroactive backfill required.** Per the policy's exception for already-ongoing projects, don't try to reconstruct historical sessions that predate `docs/ai-logs/` — if you find an old `Claude-Session:` link with no matching log, add it to [`docs/ai-logs/pending-historical-sessions.md`](docs/ai-logs/pending-historical-sessions.md) instead of fabricating a transcript.
- **Keep the README in sync.** If how AI is used on this project changes in a way that makes the README's "Generative AI use" section inaccurate, update that section too.
- **Don't present AI output as unassisted human work,** and don't skip human review/testing before committing — both are conditions of the policy, not just house style.
