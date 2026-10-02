# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`syncables` reads an OpenAPI document and produces two things from it:

- a **mock API server** (`createMockServer`) that implements the document,
  backed by an in-memory CRUD store per resource, seeded with fake data
  generated from the document's schemas;
- an **API client** (`createApiClient`) that talks to any server implementing
  that document and keeps a local copy of each resource collection in sync.

Both understand the [OpenAPI Pagination Schemes Extension](https://github.com/pondersource/openapi-pagination-schemes-extension)
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
   fields, parent bindings and GET/POST list configuration. `read/collections.ts`
   owns traversal and returns raw per-context collections with explicit
   completion/error status. `read/read.ts` adds ontology/type projection.

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
   checks and budgets. Failed/incomplete collections do not replace or prune
   stored records. GET validators reuse raw cached response bodies.

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
   (`retry.maxAttempts` is optional). Creates reconcile server-assigned IDs;
   updates select declared PUT, otherwise PATCH, and currently send JSON
   records rather than JSON Patch. Read-only operations fail before local edits.

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
   or `idempotencyKeyHeader`) lets it retry with the same key. 429/503/4xx,
   and errors raised before the request reaches the transport (an
   `authenticate` adapter throwing), keep the backoff retry. A failed create
   (`retry.maxAttempts`) is parked like an uncertain one; failed updates and
   deletes are kept per record (`gaveUpWrites`), lose the fields a later
   settled write sets, and are not dropped by new writes. Settled writes
   rebase later queued updates' conflict bases and invalidate
   `lastSyncedItems`. See the README's "Uncertain creates".

   `outbox.ts` holds the durable outbox format: one versioned record
   (`syncables:outbox`/`outbox`, `outboxNamespace`; off without a supplied
   `storage`) in the same adapter with
   every unsettled write (queues, failed writes, states, conflict bases,
   idempotency keys, the confirmed record per written record, pending id-remap
   rebuilds). It is stored whole, serialized, before the visible record on
   `create`/`update`/`remove`, before each send (an in-flight mark) and after
   each outcome. A write whose own first store has not succeeded is left out of
   other calls' stores. `restore()` runs at construction (`ready()`; retried
   after a storage error, not after a version refusal); a write found in flight
   counts as an attempt (`retry.maxAttempts` applies), and a create without a
   key the client can still send becomes `uncertain`. Restored updates wait
   (`awaitingRefresh`) for a complete `sync()` of their scope before sending,
   unless a create precedes them; a settle on the same record during the read
   (`recordRevisions`) skips the release, three non-releasing syncs fail it,
   and `resolveWrite` retries or discards it (the miss count is stored). A
   released restored PUT update at the head of its record's queue, whose
   record the refresh lacks, fails (`lastKnown` keeps the last confirmed
   record; updates of the record, retries and `update()` seeding use any
   write's `lastKnown`, never the visible record) rather than sending a
   partial PUT. Only head writes fail or count misses: a failed write must
   never be newer than a queued one of the same record (`seq`, stored, lets
   the tests check this). In-memory updates are unchanged by
   that (#260's open remote-delete item). Writes not yet durable are skipped
   by `rebuild`. Unknown versions are refused, not
   overwritten. The README's
   "Durable outbox and restarts" has the stop-between-steps table; keep it in
   step with the code. Not stored: `lastSyncedItems`, the conditional cache and
   confirmed records without writes. Finer transient/permanent failure
   classification remains #260 work. A fully paginated list is
   not necessarily a consistent snapshot; the existing absence/pruning rule
   still depends on provider behavior.

`fake-data/generate.ts` (`generateFromSchema`) is shared by both the mock
server (seeding + example responses) and is the only place schema-to-value
synthesis logic lives — it prefers a schema's own `example`, then `enum`,
then handles `allOf`/`oneOf`/`anyOf`/type-based generation recursively. A
schema's own fixed `example` is reused verbatim on every call, so callers
generating more than one item from the same schema (resource seeding,
paginated list generation) must inject their own unique `id` afterward
rather than relying on the generated value to differ per item.

### Pagination (`src/pagination/`)

Implements the [OpenAPI Pagination Schemes Extension](https://github.com/pondersource/openapi-pagination-schemes-extension)
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
  `nextLink`-role headers) and derives `hasNextPage`.

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
  versions and outbox store failures).
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
