# syncables

This code is open source and is authored and maintained by Michiel de Jong,
using Claude Code and Codex as tools. Michiel directs development and authorizes
merges; the session logs record when he delegates review and merge decisions.
Lockfiles are produced by npm and pnpm.
This work was [funded by NLNet](https://nlnet.nl/project/TUBS/).

Reads an OpenAPI document and gives you:

- a **mock API server** that implements it, backed by a real (in-memory)
  CRUD store per resource, seeded with fake data generated from the
  document's schemas;
- an **API client** that talks to any server implementing that OpenAPI
  document and keeps a local copy of each resource collection in sync.

## Usage

```sh
pnpm install
pnpm build
pnpm test
```

```ts
import { loadOpenApiDocument, createMockServer, createApiClient } from 'syncables';

const document = await loadOpenApiDocument('./petstore.yaml');

const server = createMockServer(document);
const { url } = await server.listen();

const client = createApiClient(document, { baseUrl: url });
await client.sync(); // pulls every discovered resource collection into local storage

const pets = await client.list('/pets');
```

When `components.crudResources` is present, the client and reader use its
collection names, identity bindings and nested collection graph. Without
that metadata, the client retains legacy discovery by paired collection
and item paths, e.g. `/pets` and `/pets/{petId}`; the mock server still uses
that legacy model. The browser reader requires CRUD metadata. This is a
subset of CRUD Causality, not a complete implementation of its write semantics.

## Keeping in sync

`sync()` can be called on a timer: it conditionally re-fetches using
`ETag`/`Last-Modified` (or a fallback comparison against the previous sync
when a server doesn't support conditional requests) and only touches local
storage for items that actually changed.

```ts
const handle = client.startPolling({
  intervalMs: 30_000,
  onSync: (result) => console.log('changed:', result.changed),
  onError: (error) => console.error('sync failed:', error),
});

// later
handle.stop();
```

## Writing

`create`/`update`/`remove` are local-first: they update local storage
immediately and return, then apply themselves against the server in the
background. Confirmed provider state is separate from pending local intent;
refreshes and older write responses replay remaining mutations rather than
replacing newer local edits. Updates use the item's declared PUT, or PATCH
when PUT is absent. Both currently send JSON records, not JSON Patch documents.
An update's response is merged over the record it sent, so a provider that
answers with only some fields (or only bookkeeping such as `updatedAt`) does
not shrink the confirmed record or revert the edit. The trade-off: a field
that the provider removed in that response, rather than omitted, stays in the
local copy until the next refresh, and is sent again in later PUT or PATCH
bodies until then; a strict provider could reject those, for example after a
field rename.

Writes retry with exponential backoff, unlimited by default; set
`retry.maxAttempts` to bound attempts. Unsettled writes are kept in a durable
outbox in the client's storage adapter, so a client built later on the same
storage resumes them (see [Durable outbox and restarts](#durable-outbox-and-restarts)).
Finer transient/permanent failure classification remains work in
[#260](https://github.com/ontola/atomic-plugins/issues/260).

```ts
const pet = await client.create('/pets', { name: 'Milo', tag: 'cat' });
// `pet` is already in local storage — the POST to the server is still
// happening (and retrying, if needed) in the background.

client.pendingWrites('/pets'); // writes not yet confirmed by the server
```

Each entry of `pendingWrites()` has a `state`:

| `state` | Meaning | What the client does |
| --- | --- | --- |
| `pending` | Queued, in flight or waiting for a retry | Retries automatically |
| `uncertain` | A create may or may not have reached the server | Nothing, until `resolveWrite` |
| `failed` | Retries stopped at `retry.maxAttempts` | Nothing, until `resolveWrite` (see below) |

A new `create`/`update`/`remove` does not drop a failed write. A failed create
holds back later writes to the record, like an uncertain one. A failed update
or delete does not; later writes go ahead, and once one of them settles, it
replaces the fields it set in the failed update. A failed update with no
fields left, and a failed delete followed by any settled write, are dropped.
Whatever is left stays listed, and visible locally, until `resolveWrite`.

### Refresh during a pending update

A refresh (`sync()`) never hides a pending local edit: the visible record is
the newest confirmed remote record with the pending changes replayed on top.
When a refresh shows that a field with a pending update also changed remotely
(its remote value differs from the value the client had confirmed when the
edit was made, or when an earlier write to that field settled, and from every
value this client has queued, or holds as failed, for that field), the client
records a conflict.
A refresh that shows an earlier queued edit applied, before or after its
response arrives, is not a conflict.
The local value stays visible, the queued write still sends it (local wins on
acknowledgement), and the conflict is observable in two ways:

```ts
const client = createApiClient(doc, {
  onConflict: ({ resource, id, field, base, remote, local }) => {
    // called once per newly observed remote value
  },
});
client.pendingWrites('/pets')[0]?.conflicts; // [{ field, base, remote, local, ... }]
```

The conflict is listed until its write settles or is discarded, and is
dropped if a later refresh shows the remote value equal to the local one. To
keep the remote value instead, call `update` again with it. Not covered: a
remote deletion under a pending update (the edit stays visible and is sent; a
PUT then carries the last confirmed copy of the record with the edit on top),
conflicts
that arrive only in a write's own response, and deletes. The remote-deletion
case remains open in [#260](https://github.com/ontola/atomic-plugins/issues/260);
only restored updates handle it, as below.

### Uncertain creates

POST is not idempotent in general, so the client does not resend a create
whose outcome it cannot know. A create becomes `uncertain`, and is not retried
automatically, when:

- the transport throws, so no response arrived (the request may have been
  processed). An `authenticate` adapter that throws before the request is
  handed to the transport does not count: nothing was sent, so the create
  keeps the ordinary retry;
- the server answered 2xx but the body is not JSON or has no record identity;
- the server answered a 5xx other than 503, which can follow a committed create
  (a gateway error or timeout, for example).

A 503 or 429 conventionally means the request was not processed, and other 4xx
responses mean it was refused; those keep the automatic backoff retry. Updates
(PUT, or PATCH with the full record) and deletes are resent as before. This
classification is a convention, not a guarantee: a provider that commits a
create and then answers 503 can still get a duplicate.

Writes to the same record queue behind an uncertain create. The local record
stays visible. Settle it with `resolveWrite`:

```ts
await client.sync(); // look for the record on the server
const local = client.pendingWrites('/pets').find((w) => w.state === 'uncertain');
// The app decides what "the same record" means, for example by field values:
if (local)
  await client.resolveWrite('/pets', local.id, { action: 'confirm', id: 'server-id' });
// or: { action: 'retry' }   send the POST again (may duplicate)
// or: { action: 'discard' } drop it and the writes queued behind it
```

`confirm` moves the local record and its queued follow-up writes to the server
id without sending anything. `retry` and `discard` also apply to `failed`
writes. A failed create behaves like an uncertain one. Failed updates and
deletes of the record are retried or discarded together. A retried one is
queued behind any newer writes to the record, without the fields those set, so
an older edit cannot overwrite a newer one. `retry` drops the failed writes
that newer queued writes make obsolete (a failed delete, once any newer write
is queued); if none are left, it throws and changes nothing.

When the create operation (or its path item) declares an `Idempotency-Key`
header parameter, the client sends a fresh key with each create and reuses it
on every retry, and an uncertain create is retried automatically instead. Set
`idempotencyKeyHeader: 'X-Some-Header'` to use another header for every create
when the provider documents one elsewhere, or `false` to never send one. Whether
the provider actually deduplicates on that key is the provider's contract; it is
not verified here. A 2xx response with an unusable body stays `uncertain`
even with a key.

### Durable outbox and restarts

When a `storage` adapter is passed, the client keeps every unsettled write in
one record of it: namespace `syncables:outbox`, id `outbox`. Without
`storage`, the default `InMemoryStorageAdapter` ends with the client, so no
outbox is kept. The outbox holds, per record, the queued writes in order, the
failed writes, each write's state, attempts and last error, the conflict
bases and conflicts of pending updates, idempotency keys, the confirmed remote
record the writes are replayed on, and local ids of creates the server has not
confirmed (with the writes queued behind them). A client built on the same
storage restores it before anything else:

```ts
const client = createApiClient(doc, { storage, transport });
await client.ready(); // restores the outbox; other async methods wait for it too
client.pendingWrites(); // pending, uncertain and failed writes from before the restart
```

Pending writes then resume in their stored order per record (the backoff
delay is not stored; the first resend is immediate), with one exception:
a restored update waits for a `sync()` that reads its collection completely.
Updates send the whole record, and the confirmed record stored before the stop
may be old: sending it would overwrite remote changes to fields the update
never touched. After the refresh the update is replayed on the current remote
record and checked for conflicts (`onConflict`) like any pending update.

If that refresh does not return the record (deleted remotely, or filtered out
of the read), a restored update that would be sent as a PUT, and is at the
head of its record's queue, becomes `failed` with `lastError` "not in the
refreshed collection" instead of sending only its own fields as the whole
record. Failing the head keeps the order (failed writes are always older than
queued ones), and the next restored update of the record, now the head, fails
the same way, so several offline edits of a vanished record all fail and none
is sent. The edit stays visible on the last confirmed record, and a later
`update` of the record is built on that record, not on the failed edits.
"Last confirmed record" is the newest copy a refresh or a write response
confirmed: a record that reappears with other values and then vanishes again
leaves those newer values as the base, never an older copy.
`resolveWrite` `retry` sends them on that record, which any of the record's
writes may have kept, including for an older failed write; when the client
never had one, it sends the update's fields as they are, which a PUT applies
as the whole record. A PATCH update is sent (it carries only its changes). A
restored update queued behind a write that is not an update (a delete, say)
is released and sent once that write settles.

While it waits, its `pendingWrites()` entry is `pending`
with `awaitingRefresh: true` (only pending entries carry it), and writes
queued behind it wait too. A refresh during which a write to the same record
settles does not release it; writes to other records of the collection do not
matter. Updates queued behind a restored create do not wait: they replay on
the create's response. Restored creates and deletes do not wait.

A waiting update can be settled with `resolveWrite`: `retry` sends it now, on
the confirmed record stored before the stop, and `discard` drops it (writes
queued behind it stay). After three `sync()` calls that ran without releasing
it while it was at the head of its record's queue (the collection failed or
was incomplete, or a write to the record kept settling), it becomes `failed`
with `lastError` "Waiting for a complete refresh of <collection>", so a
collection that never reads completely cannot hold it back unseen. Writes
queued behind it then go ahead. A waiting update behind other queued writes
does not count misses until it is the head, since failing it there would make
a failed write newer than queued ones. `retry` resets the count.

Uncertain and failed writes stay listed, visible locally and resolvable with
`resolveWrite`, and are not resent. Retrying a restored failed update sends it
at once, as does retrying any failed write of a record whose queued updates are
waiting. `pendingWrites()` lists restored writes only after
`ready()` resolves. If reading the outbox fails (a storage error), `ready()`
and the methods that wait for it reject, and the next call tries the restore
again.

The outbox is written as a whole, in one `put`, at each step below, and
calls are serialized, so the stored record is always one consistent state.
What a process stop between steps leaves:

| Step | A stop before the next step leaves | On restart |
| --- | --- | --- |
| 1. `create`/`update`/`remove` stores the outbox with the write | Nothing recorded, nothing sent; the call had not resolved | Nothing to do |
| 2. The visible record is updated, the call resolves | The write is recorded; the visible record may be stale | Visible records of every stored write are rebuilt |
| 3. The outbox marks the write as in flight, then the request is sent | The request may or may not have reached the server | See below |
| 4. The outcome is stored (settled write removed, follow-ups moved to the server id) | The visible record may still be under the local id | The stored list of records to rebuild is finished |

A write found marked in flight on restart counts as one failed attempt, with
`lastError` saying the process stopped. A create without an idempotency key
becomes `uncertain`: it is not resent, so a create the server did apply is not
duplicated, and `resolveWrite` confirms, retries or discards it as for any
uncertain create. A create with a stored idempotency key is resent with that
key, but only if the client can still send it: when the current document no
longer declares the header, or `idempotencyKeyHeader` is `false`, the create
becomes `uncertain` too. Deletes are resent, and updates (PUT, or PATCH with
the full record) are resent after the refresh described above. If the
restored attempt reaches `retry.maxAttempts`, the write becomes `failed`
instead (a create without a usable key stays `uncertain`). If storing the
in-flight mark fails, the request is not sent; that counts as a failed
attempt and is retried with backoff.

So the worst case after a stop is `uncertain`, not a duplicate or a silent
loss. The limits of that claim:

- A `create`, `update` or `remove` call that had not resolved may or may not be
  in the outbox. Check `pendingWrites()` after `ready()` before repeating it.
  If storing the outbox fails, the call rejects, the write is not queued, and
  no other call's store includes it: a write reaches storage, as outbox or as
  visible record, only once its own first store has succeeded.
- After the write is queued, a failed outbox store (after an outcome, in
  `sync`, or in `resolveWrite`) does not fail the operation: the stored record
  stays at the previous state until the next successful store, which writes
  the whole state again. A stop in that window restores that older state, at
  worst a write marked in flight (handled as above) or a resolution to redo.
- The guarantee is only as strong as the adapter's `put`: it must store the
  whole record or nothing, and keep what it acknowledged.
- The whole outbox is serialized and stored at each step (about three stores
  per write, more on retries and id remaps). Its size is one copy of each
  written record's confirmed state (or last known copy) plus, per unsettled
  write, its own changes and bookkeeping: measured on 2026-10-02 with a
  10 KB record, 1 queued update gave a 10.3 KB outbox and 20 gave 12.3 KB
  (about 107 bytes per extra small update). Bytes written per step therefore
  grow with the number of unsettled writes and records. Throughput was not
  measured; it is meant for hundreds of unsettled writes, not a bulk import.
- Only one client may use a storage at a time. Two clients on one outbox (two
  tabs, say) overwrite each other's record and may both send a write; there is
  no lock.
- An idempotency key prevents a duplicate only if the provider honours it.
- A restored update is sent only after a refresh, but the provider can still
  change the record between that read and the request, as without a restart.
  A resent delete that was already applied gets whatever the provider answers
  (often 404) and is retried like any other 4xx.
- Not stored: the last synced snapshot and conditional-request cache (the
  next `sync()` reads everything again) and confirmed records without writes.

The record has a `version` (now `1`). Storage without an outbox record, such
as storage written by an earlier syncables, starts with an empty outbox. A
record with another version is left unchanged and `ready()` rejects, as do
the methods that wait for it, rather than overwrite writes this client cannot
read. Entries for a collection the current document lacks (queued writes and
pending rebuilds), and entries that do not parse, are kept and written back
unchanged; the next client tries them again. Set `outboxNamespace` to
store the outbox under another namespace (it must not equal a collection
name), or to `false` to keep writes in memory only.

## One engine in Node and browsers

The Node `syncables` and browser `syncables/browser` entries both export
`createApiClient`, `readCollections`, `readPlatform` and the same transport
contract. `readCollections` assembles unmodified provider records per bound
collection and marks each result `complete` or incomplete with an error.
`readPlatform` uses it and adds ontology/datatype interpretation. The local
replica uses it to refresh storage. `paginate` (Node: `paginateOperation`)
and `client.paginate` share the same page walker.

| Capability | Node entry | Browser entry |
| --- | --- | --- |
| One-off raw/typed collection reads | Yes | Yes |
| Local-first client, CRUD and polling | Yes | Yes |
| Custom transport or direct fetch for the client | Yes | Yes |
| Constructor credentials and auth adapters | Yes | Yes |
| Environment credential fallback | Yes | No |
| Optional raw read-response storage hook | Yes | Yes |
| Mock HTTP server and file/YAML loaders | Yes | No |

An explicit `baseUrl` overrides the document's server. Paths are appended to
its base path, matching the browser reader (for example, base `/v3` plus
`/calendars`). Legacy callers using an origin-only base keep the same URLs.

```ts
import { createApiClient } from 'syncables/browser'; // also exported by 'syncables'

const client = createApiClient(document, {
  transport: hostTransport, // proxy, direct HTTP, or a deterministic test transport
  storage: recordStorage,  // optional; default is in memory
  constants: { workspaceId: 'example-workspace' }, // required root bindings, if any
});
await client.sync();
const events = await client.list('events', { calendarId: 'example-calendar' });
await client.update('events', 'example-event', { summary: 'Changed' }, {
  calendarId: 'example-calendar',
});
```

Collection names identify metadata-driven resources; a unique collection URL
is also accepted. Legacy resources retain their path names. Per-call context
binds nested collections; `constants` supplies defaults. The storage resource
key for a nested collection is `JSON.stringify([collectionName, contextValues])`,
where values follow the collection's path-variable order. Equal IDs under
different parents stay separate. Collection names must be globally unique.
CRUD metadata is authoritative when supplied. Creates use a declared POST
on a GET collection or an explicit POST `x-crud` create operation; a POST
list is never automatically treated as a create. Unsupported writes are
refused before changing local storage.

Client reads now use the same default request/record/time limits and bounded
429 handling as the reader, replacing the old silent 50-page stop. A failed,
malformed or budget-limited collection does not replace or prune its local
copy; other complete collections may still refresh before `sync()` rejects.
`readCollections` and `readPlatform` retain partial results for one-off imports.
Full-list absence still follows the existing client deletion rule; reaching
the last page does not prove the provider offered a consistent snapshot.

## Transports and direct authentication

`transport` handles every client GET/POST/PUT/PATCH/DELETE. Without it, the
client adapts `options.fetch` or global `fetch`; supplying both `transport`
and `fetch` is an error. Integration-proxy is optional. A transport that
already authenticates needs no credential options.

```ts
import { apiKeyAuth, createApiClient } from 'syncables';

const client = createApiClient(document, {
  credentials: { apiKey: 'application-key' },
  authenticate: apiKeyAuth('X-API-Key'), // or apiKeyAuth('key', 'query')
});
```

The Node constructor falls back to `SYNCABLES_API_KEY`,
`SYNCABLES_OAUTH_CLIENT_ID`, `SYNCABLES_OAUTH_CLIENT_SECRET` and
`SYNCABLES_ACCESS_TOKEN`. Explicit fields win over environment values.
`credentialPrefix: 'SECOND_'` selects a different prefix;
`credentialPrefix: false` disables fallback. `credentialsFromEnv(explicit,
prefix)` is also exported by the Node entry. The browser entry never reads
environment variables.

`bearerAuth` adds a supplied `accessToken`. For OAuth, supply
`authenticate(request, credentials)`: it receives the constructor/environment
`clientId` and `clientSecret` and returns an authenticated request, possibly
after obtaining/refreshing a user token. OAuth consent, grant selection and
token persistence are the adapter's responsibility; loading application
credentials alone does not log a user in. Credentials without an authentication
adapter are rejected. Keep confidential client credentials in server-side
configuration. Authentication happens after the data-read capture boundary.

## Optional raw read-response storage

```ts
const client = createApiClient(document, {
  transport,
  storeResponse: async (response) => responseArchive.append(response),
});
```

`storeResponse` also works on `readCollections`, `readPlatform`, and standalone
`paginate`. It is awaited before parsing a response and receives the original
response body text, pre-authentication URL/method/list request body, status,
receive time and these response headers when present: Content-Type, ETag,
Last-Modified, Link and Retry-After. It captures each read response, including
429 attempts, errors and actual 304 responses; the client's cached body is
used only for collection assembly. It does not capture write or OAuth-token
responses. No request headers, cookies or authorization response headers are
saved. A supplied transport must return provider responses in this contract;
Syncables cannot recover information the transport already transformed.

The caller supplies storage and retention (latest responses or history).
The body remains the text returned by the transport, before JSON parsing,
field filtering or date conversion; it is not original HTTP wire bytes. A
capture failure fails that collection read. Raw archives do not persist the
mutation queue or provide an automatic replay/resume mechanism.

## Reading in a browser: `syncables/browser`

`syncables/browser` provides the shared reader and local replica for code
that runs in a browser or a sandboxed iframe. It imports no Node built-ins and no
`js-yaml`. The one-off reader takes a `Transport` function, e.g. a plugin
host's `request()` into an integration proxy; the client accepts that same
transport or direct fetch. A test bundles it with esbuild `platform: 'browser'`
and fails on any Node built-in import. It does not include the mock
server, environment loader or file-path loaders, so pass documents and
overlays as parsed objects.

```ts
import {
  prepareDocument,
  describePlatform,
  readPlatform,
  type Transport,
} from 'syncables/browser';

const document = prepareDocument(openapiJson, [paginationOverlay, crudOverlay]);
describePlatform(document); // { parameters, collections, upstream }

const transport: Transport = async ({ url, method, headers, body }) =>
  host.request({ path: url.pathname + url.search, method, headers, body });
// -> { status, headers, body } with the body as text

const { records, ontology, errors } = await readPlatform(document, {
  platform: 'notion',
  constants: {}, // values for describePlatform(document).parameters
  transport,
});
```

- **Collections** come from `components.crudResources` (the
  [CRUD Causality Extension](https://github.com/ontola/atomic-plugins/tree/main/openapi-extensions/spec/crud-causality),
  usually added by an overlay). A nested collection runs once per parent
  record, with its path variables filled in through `identity.bindings`. On a
  collection, `x-list-query` adds fixed query parameters, `x-list-method: POST`
  lists with a POST instead of a GET, and `x-list-body` adds fixed JSON body
  fields.
- **Pagination** follows the operation's pagination scheme: page numbers or
  offsets, page tokens or cursors, and next links in the body or a `Link`
  header. A cursor declared in `request.bodyFields` travels in the JSON body
  of a POST. Notion's `/v1/search` and `/v1/databases/{id}/query` work this
  way (`start_cursor` in the request, `next_cursor` in the response). A next
  link to another origin, or a page that repeats, stops that collection with
  an error.
- **Records and ontology**: `deriveOntology` makes one class per resource and
  one property per field, typed with Atomic Data datatype URLs. Each record's
  `values` are keyed by property shortname, and `date-time` strings are
  converted to epoch milliseconds.
- **Limits** (`DEFAULT_READ_LIMITS`): 10,000 requests, 5,000 records and 30
  minutes per read, plus at most 3 retries of a 429 per request, each after
  its `Retry-After`. When a limit is reached, the read stops. It keeps the
  records read so far and reports the stop in `errors`.

`paginate(document, { transport, path, method, pathParams, query, body,
pageSize })` walks every page of one operation, without `crudResources`.
The main `syncables` entry exports the same functions, with `paginate`
renamed `paginateOperation` so it doesn't clash with `ApiClient.paginate`.

## Changelog

- **Unreleased**: Shared browser/Node local-first client, resource traversal
  and pagination; injected read/write transports; constructor and Node
  environment credentials with supplied auth adapters; optional original
  read-response storage; scoped nested collections and POST lists; pending
  intent preserved during refresh and older acknowledgements; incomplete
  collections no longer prune the local replica. `pendingWrites()` entries
  gain `state` and `conflicts`; same-field refresh conflicts are reported
  (`onConflict`); ambiguous creates become `uncertain` instead of being
  resent, with `resolveWrite` to retry, discard or confirm them, and
  `Idempotency-Key` retries (`idempotencyKeyHeader`). Unsettled writes are
  kept in a durable outbox in a supplied storage adapter (`syncables:outbox`,
  `outboxNamespace`) and resumed by a later client on the same storage
  (`ready()`); a create in flight when the process stopped becomes
  `uncertain`. With `storage`, `create`/`update`/`remove` store the outbox before they
  resolve, and the request leaves after one more outbox store. A restored
  update waits for a `sync()` of its collection (`awaitingRefresh`).

- **0.18.0**: Adds the `syncables/browser` entry point: a browser-safe read
  path with an injected transport. Adds request-body pagination, with
  `buildBody` and body-field `offset`/`page` roles in `nextCursor`.
  `applyOverlay` moves to a module without file-system access. The Node API
  is unchanged, and `syncables` also exports the read-path functions.

## NLnet milestone 1

This package is the reference implementation for
[milestone 1](https://github.com/tubsproject/syncables/blob/main/nlnet-milestones.md#1-syncables)
of the project's NLnet grant, which is split into two parts:

- **Part a) Read-only version** — `createApiClient`'s [`sync()`/`paginate()`](#keeping-in-sync)
  pull a full local-first copy of a resource collection (walking pagination in
  full, then re-fetching conditionally on later calls) into a pluggable
  `StorageAdapter`, from nothing but the OpenAPI document — see `discoverResources`
  (`src/resources/discover.ts`) for how "syncable" resources are found in it.
- **Part b) Full bidirectional version** — the [`create`/`update`/`remove`](#writing)
  methods make that copy writable, not just readable: each write lands in local
  storage immediately, then applies itself against the server in the background
  through a per-record retry queue (`src/client/client.ts`), so the local
  copy can be both pulled *and* pushed, as the milestone describes.

## Generative AI use

syncables is developed with **Claude Code** (Anthropic) and **Codex** (OpenAI).
The maintainer directs design and decides how changes are reviewed, tested and
merged. Explicitly delegated agent review and merge decisions are recorded in
the corresponding session log.

As an NLnet-funded project, it records AI-assisted work with reference to
[NLnet's Generative AI policy](https://nlnet.nl/foundation/policies/generativeAI/):

- Commits produced with AI assistance carry a `Claude-Session: <url>`
  trailer identifying the session that produced them. The legacy trailer name
  is retained for compatibility; Codex commits also carry `Codex-Session`,
  and the log names the actual tool/model. Codex session links may be local
  `codex://threads/` links rather than public transcripts.
- [`docs/ai-logs/`](docs/ai-logs) holds prompt/output disclosure logs for
  sessions going forward, redacted for secrets and personal information, per
  the policy's terms for a project that was already ongoing before the
  policy took effect (no retroactive backfill of every past session; known
  historical session links are indexed as pending in
  [`docs/ai-logs/pending-historical-sessions.md`](docs/ai-logs/pending-historical-sessions.md)).
- AI-drafted content is identified as assisted work; the disclosure log
  records the maintainer's review or delegation and the validation performed.

