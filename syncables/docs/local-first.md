# Local-firstify an API with Syncables

Syncables lets an application work against a local copy of data that lives
behind an API. It reads each declared collection across its pages, stores the
assembled records, and gives you local `list` and `get` methods. Its write
methods update that local view before waiting for the provider. Pending changes
remain visible during refreshes and are sent in the background.

This is useful when you want to search or display data without another network
round trip, keep an editor usable offline, or import collections whose records
are spread across many API responses. The API stays where it is; your application
gains a local working copy.

## The four pieces

1. **An OpenAPI document** describes the provider's HTTP contract. Find one in
   [OpenAPI Directory](https://github.com/APIs-guru/openapi-directory), use the
   provider's own document, or describe the subset of a private API you need.
2. **Extensions** supply behavior that an ordinary endpoint description often
   leaves implicit. [Pagination Schemes](../../openapi-extensions/spec/pagination-schemes/README.md)
   describes continuation fields and where to send them; [CRUD Causality](../../openapi-extensions/spec/crud-causality/README.md)
   describes collections, record identities and mutation effects.
3. **Overlays** add those declarations to a document without maintaining a fork
   of every provider schema. The [overlays project](../../overlays/README.md)
   contains reusable provider metadata and catalogs of matching revisions.
4. **Syncables** interprets the composed document. You provide a transport and
   storage suited to your application, then use the same client interface
   across providers.

The directory, extensions and overlays are metadata dependencies. Syncables
does not require a directory service at runtime or download a catalog
automatically. You can ship the composed document with your application.

## Try the current source

This guide follows `main`; the [changelog](../README.md#changelog) identifies
which package version introduced each feature. The writable browser client
and recovery controls arrived in 0.19.0, and missing-record checks, deletion
feeds and read tombstones in 0.20.0. To run the examples against the current
source, use Node 22 and build this checkout:

```sh
git clone https://github.com/ontola/atomic-plugins.git
cd atomic-plugins/syncables
npm ci
npm run build:release
```

Save the following as `local-first-demo.mjs` in that `syncables/` directory,
then run `node local-first-demo.mjs`. It uses an invented Notes API implemented
by a custom transport, so it needs no account or credentials. Three records
are served in pages of two; an offline edit is visible locally before its
write reaches the provider.

```js
import assert from 'node:assert/strict';
import { createApiClient, prepareDocument } from 'syncables';

const note = {
  type: 'object',
  properties: { id: { type: 'string' }, title: { type: 'string' } },
};
const response = (schema) => ({
  200: {
    description: 'Success',
    content: { 'application/json': { schema } },
  },
});
const openapi = {
  openapi: '3.0.3',
  info: { title: 'Notes demo', version: '1.0.0' },
  servers: [{ url: 'https://notes.example' }],
  components: { schemas: { Note: note } },
  paths: {
    '/notes': {
      get: {
        parameters: [
          {
            name: 'offset',
            in: 'query',
            schema: { type: 'integer', minimum: 0 },
          },
        ],
        responses: response({
          type: 'object',
          properties: {
            items: { type: 'array', items: note },
            next: { type: 'string', nullable: true },
          },
        }),
      },
    },
    '/notes/{noteId}': {
      parameters: [
        {
          name: 'noteId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      patch: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { title: { type: 'string' } },
              },
            },
          },
        },
        responses: response(note),
      },
    },
  },
};
const overlay = {
  overlay: '1.0.0',
  info: { title: 'Notes sync behavior', version: '1.0.0' },
  actions: [
    {
      target: '$',
      update: {
        components: {
          crudResources: {
            note: {
              schema: { $ref: '#/components/schemas/Note' },
              identity: {
                urlTemplate: '/notes/{noteId}',
                bindings: { noteId: { field: 'id' } },
              },
              collections: { notes: { urlTemplate: '/notes' } },
            },
          },
          paginationSchemes: {
            next: {
              type: 'nextLink',
              response: { bodyFields: { next: { role: 'nextLink' } } },
            },
          },
        },
        paths: {
          '/notes': {
            get: {
              'x-pagination': [{ scheme: 'next' }],
              'x-crud': {
                action: 'list',
                resource: 'note',
                collection: 'notes',
              },
            },
          },
          '/notes/{noteId}': {
            patch: {
              'x-crud': { action: 'update', mode: 'patch', resource: 'note' },
            },
          },
        },
      },
    },
  ],
};

const provider = new Map([
  ['n1', { id: 'n1', title: 'First note' }],
  ['n2', { id: 'n2', title: 'Second note' }],
  ['n3', { id: 'n3', title: 'Third note' }],
]);
let offline = false;
let pagesRead = 0;
const transport = async ({ url, method, body }) => {
  if (offline) throw new Error('Offline');
  let result;
  if (method === 'GET' && url.pathname === '/notes') {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const items = [...provider.values()].slice(offset, offset + 2);
    result = {
      items,
      next:
        offset + 2 < provider.size
          ? `https://notes.example/notes?offset=${offset + 2}`
          : null,
    };
    pagesRead += 1;
  } else if (method === 'PATCH') {
    const id = decodeURIComponent(url.pathname.split('/').at(-1));
    result = { ...provider.get(id), ...JSON.parse(body), id };
    provider.set(id, result);
  } else {
    throw new Error('Unexpected demo request');
  }
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  };
};
const client = createApiClient(prepareDocument(openapi, [overlay]), {
  transport,
  credentialPrefix: false, // this demo does not use Node environment credentials
  retry: { baseDelayMs: 50, maxDelayMs: 100, maxAttempts: 10 },
});
const waitUntil = async (condition) => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Demo timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

await client.sync();
assert.equal(pagesRead, 2);
assert.equal((await client.list('notes')).length, 3);

offline = true;
await client.update('notes', 'n1', { title: 'Edited offline' });
assert.equal((await client.get('notes', 'n1')).title, 'Edited offline');
assert.equal(provider.get('n1').title, 'First note');
await waitUntil(() => client.pendingWrites().some((w) => w.attempts > 0));

offline = false;
await waitUntil(() => client.pendingWrites().length === 0);
assert.equal(provider.get('n1').title, 'Edited offline');
console.log(
  'Two pages assembled; offline edit applied locally and then remotely.',
);
```

The transport is the demo's provider boundary. In a real integration, keep the
collection and pagination declarations, adapt them to the actual contract, and
use authenticated HTTP or a proxy transport. The rest of the application still
reads `notes` locally and calls `update` to edit it.

## Apply the workflow to a real API

### 1. Choose and prepare the API description

Find the API in [OpenAPI Directory](https://github.com/APIs-guru/openapi-directory)
or start from a provider-maintained description. Use a document with OpenAPI 3
`servers`, `paths` and schemas. Syncables resolves local `#/...` references;
bundle external references and convert a Swagger 2 document before passing it
in. Resolve server URL variables to an actual HTTP(S) base URL.

Choose the collections your app needs, rather than copying every operation.
A paginated search endpoint can be a collection even if there is no matching
item endpoint. A stable record identity is essential; it may be `number` or
another field rather than `id`. Read-only endpoints can provide a useful local
copy without enabling writes.

### 2. Add the missing behavior through overlays

Look for matching metadata in the [overlays catalog](../../overlays/README.md#directory-layout-and-oad-revisions).
Its dated catalogs record the base document URL and an ordered list of overlays.
Use the pinned document revision the overlays target, and keep that selection
with your app. The catalogs here use the maintained
[Ontola OpenAPI Directory fork](https://github.com/ontola/openapi-directory).
An overlay written for one revision may not fit a newer provider description.

For each selected collection, describe:

- `components.crudResources`: the collection URL, item URL when applicable,
  and bindings from path variables to record identity fields.
- `components.paginationSchemes` and the list operation's `x-pagination`:
  continuation fields and their request/response locations. Syncables supports
  page numbers/offsets, tokens/cursors, and next links, including POST-body
  cursors. Missing pagination metadata can leave you with only the first page.
- Supported mutations: the collection's create operation and the item's
  PUT/PATCH/DELETE operations. Explicit `x-crud` create operations can identify
  a separate create path. A POST used to list records is not automatically a
  create. Syncables implements a subset of CRUD Causality; an arbitrary action
  endpoint does not become a supported mutation just by annotating it.

In Node, `loadOverlay` parses a local YAML or JSON file, and `prepareDocument`
applies overlays in order before resolving references:

```js
import { loadOverlay, loadOpenApiDocument, prepareDocument } from 'syncables';

const base = await loadOpenApiDocument('./api.yaml');
const document = prepareDocument(base, [
  await loadOverlay('./pagination-overlay.yaml'),
  await loadOverlay('./crud-overlay.yaml'),
]);
```

This loader example assumes overlays compatible with Syncables' small Overlay
implementation: root (`$`) and simple dot-path targets, with `update`/`remove`
actions. It does not support bracket selectors, filters or wildcards, which
some catalog overlays use. For those, compose the original document with a
full Overlay processor or integration-proxy and load the resulting document;
`prepareDocument` does not fetch a catalog, follow `extends`, or verify revision
matches. In browsers, pass parsed document/overlay objects instead of file
paths; the browser entry has no YAML loader.

### 3. Connect directly or through a transport

For a direct API-key connection in Node:

```js
import { apiKeyAuth, createApiClient } from 'syncables';

const client = createApiClient(document, {
  authenticate: apiKeyAuth('X-API-Key'),
  // Credentials fall back to SYNCABLES_API_KEY in Node.
  // Alternatively: credentials: { apiKey: yourApplicationKey }
});
```

Use the key's actual header name, or `apiKeyAuth('key', 'query')` when the API
uses a query parameter. `bearerAuth` accepts an `accessToken`. For OAuth,
supply `authenticate(request, credentials)` to obtain/refresh a token and
return an authenticated request. Node can load application credentials from
`SYNCABLES_OAUTH_CLIENT_ID` and `SYNCABLES_OAUTH_CLIENT_SECRET`, and a token from
`SYNCABLES_ACCESS_TOKEN`; constructor fields take precedence. Browser clients
accept explicit credentials but do not read environment variables. Keep
confidential application credentials in server-side configuration.

The [auth extensions](../../openapi-extensions/README.md#proposals) describe
provider requirements for runtimes such as integration-proxy. Syncables itself
does not turn an OAuth declaration into a consent flow or manage token storage.
An application client id/secret alone does not authenticate a user.

With integration-proxy or another host, pass its transport instead. The
following is an adapter sketch: `host.request` belongs to your host and must
return `{ status, headers, body }`, with `body` as text.

```js
import { createApiClient } from 'syncables/browser';

const client = createApiClient(document, {
  transport: ({ url, method, headers, body }) =>
    host.request({
      path: url.pathname + url.search,
      method,
      headers,
      body,
    }),
  storage: recordStorage,
});
```

All client reads and writes use that transport. A transport can hold its own
authentication; no separate credential option is needed. Without a transport,
the client uses supplied or global `fetch`. Direct browser calls still depend
on the provider allowing CORS; a host transport can provide the network access.
An optional `baseUrl` overrides `servers[0].url`; include the API's base path
once, with operation paths relative to it.

### 4. Read locally, edit locally, refresh explicitly

After constructing the client:

```js
await client.ready(); // restores an outbox when storage was supplied
await client.sync(); // reads each selected collection across its pages
const records = await client.list('notes'); // no provider request
await client.update('notes', records[0].id, { title: 'New title' });
console.log(client.pendingWrites('notes')); // delivery state, not a success receipt

const polling = client.startPolling({
  intervalMs: 30_000,
  onSync: ({ changed }) => console.log('Refresh changed:', changed),
  onError: (error) => console.error('Refresh incomplete:', error),
});
// Stop scheduling refreshes when this view no longer needs them:
polling.stop();
```

Use your document's collection names and fields; `notes` is the demo's name.
`create` and `remove` work the same way when the API declares supported create
and delete operations. A create may initially have a local id that is replaced
by the provider's id after acknowledgement. Handle an empty collection before
using its first record. Polling schedules reads; stopping it does not cancel
queued writes or a read already in progress.

Nested collections can be read once per parent, with path bindings supplied by
the parent records. Supply root values through `constants` and pass the needed
context to local reads/writes, such as `client.list('events', { calendarId })`.
Equal record ids under different parents remain separate. Use
`describePlatform(document)` to inspect collections and required root parameters.

## Choose what survives a restart

The default `InMemoryStorageAdapter` is useful for a session or a demo. For
offline data across restarts, implement the exported `StorageAdapter` against
IndexedDB, SQLite or your application's database. It has four async methods:
`list(resource)`, `get(resource, id)`, `put(resource, id, value)` and
`delete(resource, id)`. Those backends are integration choices, not bundled
Syncables adapters.

When you supply storage, the client also stores its unsettled writes in a
reserved outbox namespace. `ready()` restores it and background delivery
resumes; restored updates wait for a complete refresh of their collection.
Your adapter must make each `put` atomic and retain acknowledged records.
Use one client per storage/outbox at a time; there is no multi-tab lock. For
the exact guarantees and recovery behavior, see
[Durable outbox and restarts](../README.md#durable-outbox-and-restarts).

You can also keep original API read responses alongside the assembled records:

```js
const client = createApiClient(document, {
  transport,
  storage: recordStorage,
  storeResponse: async (response) => responseArchive.append(response),
});
```

Here `recordStorage`, `transport` and `responseArchive` are provided by your app.
The optional hook receives original response text before parsing, including
individual pages, read errors and retries, plus selected metadata. It is awaited;
a storage error fails the read. You choose latest-only storage or history and
retention. An archive complements the assembled local copy and durable outbox;
it does not add automatic archive replay. See
[raw-response storage](../README.md#optional-raw-read-response-storage) for the contract.

## Design the app around delivery state

A local edit is usable immediately; it is not yet proof that the provider
accepted it. Display `pendingWrites()` where that distinction matters:

| State       | Application response                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `pending`   | Keep showing the local edit while delivery or a retry runs.                                                 |
| `uncertain` | A create may already exist remotely. Reconcile it, then use `resolveWrite` to confirm, retry or discard it. |
| `failed`    | Explain the refusal or exhausted retries; offer a deliberate correction, retry or discard.                  |
| `blocked`   | Renew refused credentials, then call `authRenewed()` to resume delivery.                                    |

Same-field remote changes can be reported through `onConflict` and the pending
write's `conflicts`; the local edit stays visible and the queued write still
sends it. A provider-supported idempotency key can make create retries safer.
The [writing reference](../README.md#writing) explains those controls, failure
classification and their provider-dependent assumptions.

## Handle a record that disappears from a collection

A record missing from a fully read collection may have been deleted, filtered
out, or become inaccessible. Syncables holds its queued PUT/PATCH updates while
it checks the evidence. An update already in flight completes; if its outcome
leaves it queued, it is held before another send. The local edit remains visible.

Evidence can come from three declarations or from an item read:

- A collection's [`x-completeness: { absent: deleted }`](../../openapi-extensions/spec/collection-completeness/README.md)
  states that absence means deletion within its declared scope. It is not used
  when a query selection narrows that scope beyond the declaration.
- A collection's [`x-deletion-feed`](../../openapi-extensions/spec/deletion-feeds/README.md)
  identifies a GET operation that reports deletions, optionally from a cursor
  or timestamp query parameter. Syncables follows its pages, reads it once per
  complete collection/context at the end of the sync, and keeps cursors and
  relevant tombstones in the outbox when persistent storage is supplied.
- A resource's [`x-read-tombstone`](../../openapi-extensions/spec/deletion-feeds/README.md#44-read-tombstones)
  describes a deletion marker in a successful item response, such as
  `{ "id": "n1", "status": "deleted" }`. Without the declaration, a matching
  2xx record looks like an existing record.
- An item GET can show that the record is still available, or answer 404/410.
  It uses the same request/time budget as collection and feed reads.

The declaration must match the provider's contract; an ordinary status field
does not automatically become a tombstone. The exact evidence order, feed
cursor rules and draft-extension limitations are in the
[missing-record reference](../README.md#records-a-refresh-no-longer-returns).

| Evidence                          | Outcome for held updates                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `deleted`                         | Fail with `missingRecord: 'deleted'`; retain the local edit for deliberate resolution.                               |
| `filtered`                        | Use the matching live record returned by GET as the confirmed copy, check conflicts and resume delivery.             |
| `unknown`                         | Fail with `missingRecord: 'unknown'`; leave the decision visible to the application.                                 |
| Check deferred by the read budget | Keep updates held for a later sync; repeated non-releasing syncs eventually fail them as described in the reference. |

Expose these outcomes alongside ordinary delivery state:

```js
const client = createApiClient(document, {
  transport,
  storage: recordStorage,
  missingRecordChecks: 'pending', // default: records with queued updates
  onMissingRecord: ({ resource, id, evidence, source }) => {
    console.log('Missing record:', { resource, id, evidence, source });
  },
});
await client.sync();
const missingEdits = client
  .pendingWrites()
  .filter((write) => write.missingRecord);
```

Here the transport and storage come from your application. Use
`missingRecordChecks: 'all'` to also report missing records without queued
writes, or `'none'` to disable item/feed checks; an applicable completeness
declaration still counts. A failed edit can be retried or discarded with
`resolveWrite`. Retrying is a deliberate application decision: a provider may
reject it again or let a write restore the record. New edits of a record known
to be missing are held and checked too.

Feed responses that fail, are malformed, or exceed a read budget do not supply
new tombstones or advance a normal cursor. Cursor-expiry responses follow the
declared expiry rule. Read tombstones are checked only in missing-record item
reads; collection records and write responses do not trigger that check.
Current regression tests cover these paths, ordering and restarts with invented
providers. No provider overlay currently declares these deletion extensions;
live provider compatibility remains to be established.

## What "any API" requires

Syncables is driven by descriptions rather than a built-in provider switch.
For an API with expressible collection, pagination, identity and JSON mutation
semantics, adding metadata can unlock the same local-first interface. Private
and self-hosted APIs can use the same approach; a directory listing is optional.

The description must still match the provider's actual behavior. Syncables
does not implement every CRUD Causality feature, arbitrary action/upload
protocols or CRDT merging. Custom request/response shapes may need a transport
adapter or a separate write integration. Validate supported reads and writes
against the provider before relying on them.

A failed or incomplete collection read leaves its previous local copy intact;
other complete collections may refresh before `sync()` rejects. Default read
budgets are 10,000 requests, 5,000 records and 30 minutes, configurable through
`limits`; exceeding a budget is an incomplete read, not a full snapshot.
Following all pages does not prove the provider supplied a consistent snapshot
or that an absent record was deleted. Use the
[missing-record controls](#handle-a-record-that-disappears-from-a-collection)
and provider declarations to expose deletion evidence when a local update's
record disappears.

For a one-off import, use `readCollections` for raw assembled collections or
`readPlatform` for ontology/datatype projection. For ongoing local reads,
edits, polling and recovery, use `createApiClient`.
