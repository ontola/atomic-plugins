# Bidirectional Lenses for Data Portability
## Work in Progress

[API docs](https://ontola.github.io/atomic-plugins/devonian/docs/): TypeDoc
output committed in [`docs/`](docs/index.html), last generated 2025-10-14 in
localthought/devonian and imported unchanged on 2026-09-22. It covers only the
legacy row API
(`DevonianClient`, `DevonianIndex`, `DevonianLens`, `DevonianTable`), not
`AtomicStore`, `AtomicIdentityMap`, `AtomicLens`, `BackgroundSync`, the
reflection engine or `devonian/lenses`; for those, read this README and the
guides in `docs/*.md`.

[![A Tiktaalik leaving its pond in search for another one](https://cdn.mos.cms.futurecdn.net/fi8nrWxvEb5sowf5jkQ8RY-700-80.jpg.webp)](https://www.livescience.com/43596-devonian-period.html)

Inspired by [the Cambria Project](https://github.com/inkandswitch/cambria-project), Devonian uses TypeScript transformations to bridge differences in data shape and primary key assignment between independent systems of record. Scoped identity maps record which external records correspond; they do not track causality or resolve conflicts.

Already familiar with Cambria? Start with [Devonian for Cambria users](docs/from-cambria.md), which explains the value algebra, connector API, identity maps and current limits.

## Which API to use

Devonian is pre-1.0: a minor version may change an API. Each part below is
covered by deterministic tests with fakes. Every entry point and the
background scheduler also run in headless Chromium, the scheduler with a
service worker (see "Entry points and browser support"). No part has been
run against a live provider, Firefox or Safari.

| Part (import) | What it does | Tested guarantees | What it does not do | The host's responsibilities |
|---|---|---|---|---|
| **Native Atomic Data** (`devonian/atomic`): `AtomicStore`, `AtomicIdentityMap`, `AtomicLens` | Imports, creates, updates and deletes between Atomic Data resources and one platform's records through a connector; subject URLs are identities | Scoped identities (connector and entity, string and number ids apart); unmanaged fields kept; explicit removal; a failure does not poison the queue; one lens's calls in call order (`__tests__/atomic/*.test.ts`) | Durable storage (the store is in memory), cross-lens or cross-process locking, stale-event rejection, conflict resolution, signed Atomic Commits, Atomic Server transport | Snapshot after awaited work and reload before replay ([Persistence and restart](docs/atomic-data.md#persistence-and-restart), [Recovering from a crash](docs/atomic-data.md#recovering-from-a-crash)); one lock for every lens that touches the same resources ([Concurrency](docs/atomic-data.md#concurrency-and-next-milestones)); ordering delayed events ([Event ordering](docs/atomic-data.md#event-ordering)); a connector that honours the idempotency key, or reconciles its creates ([Recovering from a crash](docs/atomic-data.md#recovering-from-a-crash)) |
| **Value lenses** (`devonian/lenses`, 0.9.0) | Pure, synchronous field and custom mappings between a source and an editable view | Declared ownership, unchanged-value preservation, detached copies, example-based GetPut, PutGet and stable put (`__tests__/unit/lenses.test.ts`) | Any I/O, identity, ordering or conflict handling; laws over all values (examples only) | Running a lens inside its own read/write path ([Value lenses](docs/value-lenses.md)) |
| **Reflection** (`devonian/reflect`) | Copies new records both ways between two `syncables` clients, agrees open/closed state, reflects comments, suppresses echoes | Echo suppression, no duplicates across restarts through `IdMap` plus a marker scan, a serialised runner (`__tests__/unit/reflect/*.test.ts`) | Field updates beyond state, deletions, OAuth, overlays or documents of its own | Building the two `ApiClient`s, persisting `IdMap` and `KvStore` (`File*` only in Node) |
| **Background scheduler** (`devonian/background`): `BackgroundSync` | Runs a sync pass on a persisted schedule from a tab, a service worker or Node | Due-time, pause and backoff state across restarts; one pass at a time under a lease (`__tests__/unit/background/*.test.ts`); in Chromium, one Web Locks lease and one IndexedDB schedule across two tabs and across a reload, the lease released when its tab closes, and a service worker `sync` event running a pass (`__tests__/real-browser/background.spec.ts`) | Choosing the browser's cadence (Periodic Background Sync is Chromium-only); locking across contexts without Web Locks (the in-process fallback lets two tabs run at once, shown in Chromium) | Supplying the key-value store (IndexedDB in a browser) and classifying permanent failures |
| **Legacy row API** (exported from the `devonian` root, which also re-exports the APIs above except reflection): `DevonianLens`, `DevonianTable`, `DevonianClient`, `DevonianIndex` | Copies **additions** between two tables, with foreign-id bookkeeping | Additions and foreign ids (`__tests__/unit/DevonianTable.test.ts`, `DevonianIndex.test.ts`); `__tests__/examples/extractEntity.test.ts` also shows that a changed record arrives as a new addition and is copied as a new record | **Updates and deletions**: `DevonianLens` only listens for additions, so a changed record a client emits again is copied as a **duplicate**, and a deletion is not copied; none is planned in #259 | Migrating to the native API for anything more (see "How the legacy row API works") |
| **Automerge storage** | Experimental storage for the row API | Its own unit test only | Reachable from no entry point (`storage/Automerge.ts` is not exported) | None: not for use |

**Recommendation.** New integrations use the native Atomic Data API, with value
lenses for field mapping inside connector transformations. Use reflection for
bridging two `syncables`-backed issue trackers. Keep the legacy row API only
where it already runs.

## Native Atomic Data API

New integrations can use `AtomicStore`, `AtomicIdentityMap`, and `AtomicLens` with Atomic Data resources as their native format. Resources use subject URLs and typed property URLs; platform JSON stays in connector transformations. JSON-AD snapshots include scoped external identity mappings. The awaitable lens supports creation, updates and deletion, with explicit field removal and no automatic write-back on import.

See the [Atomic Data guide](docs/atomic-data.md) for the API, supported JSON-AD profile, persistence, connector contracts, and limitations. The [Atomic Extract Entity example](examples/AtomicExtractEntity.ts) maps flattened orders to linked Order and Customer resources. The original row API remains available; existing applications are not automatically migrated. Signed Atomic Commits and live Atomic Server transport are follow-up work.

## Value lens algebra

The `devonian/lenses` entry (new in 0.9.0, and also exported from the root) composes pure,
synchronous field and custom mappings. Explicit source ownership, unchanged-value
preservation and executable round-trip checks let a provider expose an editable
view while retaining fields and representations the view cannot express. GitHub
and Clockify prototypes live in their integration folders and have deterministic
contract tests; current production apps do not import them yet. See [Value lenses](docs/value-lenses.md) for the API, examples,
supported domains and adoption boundary.

## Reflection engine (`devonian/reflect`)

`devonian/reflect` is a generic, bidirectional reflection engine for two [`syncables`](https://github.com/localthought/syncables)-backed systems of record: it copies new records each way, keeps open/closed state in agreement, and reflects comments — all via a hidden origin marker embedded in the record body, so a copy is never mistaken for an original and never bounced back onward (echo suppression), and never duplicated across restarts (an `IdMap` plus a destination marker scan).

It was extracted from [`localthought/reflector`](https://github.com/localthought/reflector)'s own reflect loop — reflector's live GitHub-issue-tracker bridge — per the decision recorded in [`localthought/atomic-plugins#6`](https://github.com/localthought/atomic-plugins/issues/6), so other hosts can reuse the same engine instead of each keeping their own copy:

- `ReflectionEngine` takes two `ReflectionSide`s (each a `syncables` `ApiClient` the host already built — with its own OAuth/overlay/document handling — plus a `collectionUrl`/`idField`, a `comments(issueId)` factory, and a `setState(id, state)` writer) and an `IdMap`, and runs one `reflect()` pass. It has no notion of OpenAPI, overlays, or auth of its own — that stays with the host.
- `ReflectionRunner` wraps any `{ reflect(): Promise<ReflectionSummary> }` with a background interval loop, an on-demand `reflectNow()` serialized with that loop, and a `status()` for a health/monitoring endpoint.
- `marker.ts`'s `embedMarker`/`parseMarker`/`stripMarker` are namespaced (`<!-- <namespace>:origin ... -->`, defaulting to `devonian`) so a host with its own established wire format (e.g. reflector's `<!-- reflector:origin ... -->`, for backward compatibility with markers already in production) can keep it.
- `IdMap`/`KvStore` (each with `InMemory*`/`File*` implementations) persist the id-map and the last-agreed state ledger a host needs across restarts.

`FileIdMap` and `FileKvStore` write JSON files with `node:fs` and are Node-only. Bundlers that resolve the `browser` export condition get a build of `devonian/reflect` without them (`build/src/reflect/browser.js`); importing either name there fails at bundle time rather than at run time. In a browser, persist by subclassing `InMemoryIdMap`/`InMemoryKvStore` over IndexedDB or similar.

## Entry points and browser support

Every entry point resolves to compiled JS in `build/` with matching `.d.ts`
(`npm run build` runs before every publish), and every one bundles for the
browser without Node built-ins or polyfills:

| Import | Contents |
|---|---|
| `devonian` | Everything below except `devonian/reflect`, plus the row API (`DevonianTable`, `DevonianLens`, `DevonianClient`, `DevonianIndex`), `effect` schemas and `reconcileRecord` |
| `devonian/atomic` | Only the native Atomic Data API (`AtomicStore`, `AtomicIdentityMap`, `AtomicLens`, resource helpers). Runtime dependency: the optional `@tomic/lib` peer |
| `devonian/background` | `BackgroundSync` and its service-worker helpers |
| `devonian/lenses` (0.9.0) | Dependency-free synchronous field, custom and composed value lenses, with contract checks |
| `devonian/reflect` | The reflection engine; `FileIdMap`/`FileKvStore` only outside the `browser` condition (see above) |

`DevonianClient` and `DevonianTable` extend `DevonianEventEmitter`, a small
synchronous emitter with the `node:events` methods they use, instead of
`node:events` itself. A client that extends Node's `EventEmitter` is still
accepted where a `DevonianClient` is expected, but `DevonianClient` and
`DevonianTable` instances are no longer `instanceof` Node's `EventEmitter`.
Automerge is not reachable from any entry point (`storage/Automerge.ts` is
not exported), so no Automerge WASM is loaded.

`__tests__/browser/bundle.test.ts` checks this: it bundles each `exports`
subpath with esbuild `platform: 'browser'`, failing on any Node built-in, and
runs a small driver per entry point in a `node:vm` context that has browser
globals (timers, `structuredClone`, `TextEncoder`, `URL`, `crypto`) and no
`process`, `Buffer`, `require` or `global`. CI runs it against `src/` and,
after `pnpm build`, against `build/`.

`__tests__/real-browser/` runs in Chromium's new headless mode under
Playwright (`pnpm build && pnpm run test:real-browser`; it needs `pnpm exec
playwright install chromium` once). The same drivers, bundled from `build/`,
must give the same results as in the `node:vm` context
(`entry-points.spec.ts`). `background.spec.ts` checks `devonian/background`
with the browser's own Web Locks, IndexedDB and a service worker:
- Two tabs share one lease: a tick finds it taken.
- They share one schedule: the next tick is not due.
- A tab closed mid-pass leaves no stale lease.
- The schedule survives a reload and a new page (IndexedDB).
- The in-process fallback leases (`processLocks()`, what `defaultLocks()`
  uses without Web Locks) do not exclude another tab: two passes run at
  once.
- `registerBackgroundSync` registers one-shot sync and reports Periodic
  Background Sync's refusal ("Permission denied." for a site that is not an
  installed app).
- The worker's `sync` event runs one pass.

Not verified: Periodic Background Sync firing, Firefox, Safari and mobile
browsers.

## Background sync scheduler

`BackgroundSync` (exported from the package root, no Node or DOM imports, so it also loads in a service worker) runs a sync pass on a persisted schedule shared by every context that can trigger it: a tab's timer (`start(pollMs)`), a service worker's `periodicsync`/`sync` events (`registerBackgroundSync` and `handleBackgroundSyncEvent`), or a Node process.

- State (`nextDueAt`, `failures`, `lastError`, `paused`, with ISO 8601 times) lives in a host-supplied async key-value store under the schedule's `name`, so it survives restarts. The reflect `KvStore`s fit, and in a browser you would use IndexedDB.
- `tick()` runs a pass only if one is due, the schedule is not paused and nobody holds the lease, and it re-reads the state inside the lease. `syncNow()` waits for the lease and ignores the due time. `withLock(fn)` puts other work that must not overlap a pass under the same lease. Leases default to Web Locks (`navigator.locks`), falling back to `processLocks()`, which is in-process only.
- Transient failures back off exponentially, capped by `maxBackoffMs`. Failures that `isPermanent` classifies as needing a person pause the schedule until `resume()`.

The GitHub issues lens (now in ontola/atomic-plugins' `integrations/issue-tracker/devonian/github-issues/`) wraps it as `createBackgroundSync`. Its README describes the browser support limits: Periodic Background Sync is Chromium-only and the browser sets the cadence. Coverage: unit tests with fakes, and in headless Chromium two tabs and a service worker sharing the lease and the schedule (`__tests__/real-browser/background.spec.ts`); Periodic Background Sync firing is not verified.

## Local Identifiers and IdMaps
What I think none of the other lens projects are currently offering is a built-in way to deal with the mapping of local identifiers.

In Tubs I'm not using Devonian to track schema evolution in a single system of record, but to create bridge bots between multiple systems of record (APIs of SaaS platforms).

For instance if I'm bridging a GitHub issue tracker with a Jira one, and in the GitHub issue tracker a new issue has appeared, then this issue will have a GitHub-local identifier, for instance `15`. My bridge bot will be woken up by a webhook, fetch the JSON for issue 15, and do an API call to Jira to create a corresponding issue in the Jira tracker. I will add `{ github: 15 }` in a custom field in the metadata. Now the Jira API will respond with the Jira-local identifier, for instance `37`, and I will add a metadata comment `{ jira: 37 }` to the GitHub issue.

This way, if I kill my bridge bot and restart it on a different server, it will find back these "foreign IDs" notes in the metadata, and know how these issues were already synced, instead of thinking they are unrelated issues that still need to be synced.

## Comparison with other lens projects
### Cambria
Cambria's lens language translates documents, JSON Patch edits and schemas, with a graph connecting schema versions. Devonian uses application-written TypeScript mappings and scoped identities for bridges between systems with their own IDs and write APIs. It does not generate schemas or provide Cambria's schema-version graph. See [Devonian for Cambria users](docs/from-cambria.md) for the comparison and concrete examples.

### Jonathan Edwards 'Edit History'
In [Braid meeting 106](https://braid.org/meeting-106) (from 48:30), Jonathan Edwards presented his experiment that treats a schema conversion as an edit operation in a spreadsheet. This also uses a DSL with operations like `split-table` and `join`. I have yet to study this further to understand the benefits of using a DSL over using a Turing-complete language. I think it has something to do with applying a schema change in a distributed database, but I'll update this section as soon as I understand more of it.

### Express Schema
Jonathan Schickling pointed me to [Effect Schema Transformations](https://effect.website/docs/schema/transformations/#async-transformations) which looks like it can do a lot of the things I want to, including transformations that require an API call. I will try using it and update this section with my findings. Maybe it means I don't need to create my own lens project and I can just use Effect Schema instead. :)

### Lens VM
[Source Inc.](https://source.network/) are working on [Lens VM](https://github.com/lens-vm/lens-vm.org/blob/master/content/about.md) which uses WASM to define lenses and content ID's to identify database rows. I will try this out as soon as there is a bit more documentation. 

I think Lens VM also has a concept of foreign IDs and id maps, but I think it is tied to content IDs, which might be too restrictive when syncing issue trackers and other types of data.

For instance in a bank account statement, if I transfer 100 euros from my savings account to my current account, and then do the same again on the same day, some CSV export formats will meaningfully represent this as two identical rows in the CSV file (date, amount, from, to), and refering to these rows by content ID would incorrectly collapse them into a single row.

## How the legacy row API works
**Additions only.** `DevonianLens` listens for additions (`add-from-client`) on both tables and nothing else. A changed record that a client emits again arrives as another `add-from-client` and is copied as a **new record**, a duplicate (`__tests__/examples/extractEntity.test.ts`, "can then replicate an update from linked to comprehensive", asserts exactly that); a deletion is not copied. No update or delete support is planned in #259. For anything more, migrate to the native API:

- **Records:** a table row becomes an Atomic Data resource in an `AtomicStore`, with property URLs for its fields.
- **Foreign ids:** `DevonianIndex` and `ForeignIds` become `AtomicIdentityMap` mappings, scoped by connector and entity.
- **Translation:** the left-to-right and right-to-left functions become the `AtomicLens` options `read` (platform record to resource patch) and `write` (resource to platform record), optionally built from value lenses.
- **New:** `ingest` and `ingestDelete` take platform changes in; `publish` and `delete` send creates, updates and deletions, with explicit field removal.
- **Two platforms:** an `AtomicLens` joins **one** platform to the native store, where a `DevonianLens` joined two tables. Bridging two platforms takes one lens per platform on the same store, and the host calls `publish` on the other lens after an `ingest`: an import never writes back on its own.

The [Atomic Extract Entity example](examples/AtomicExtractEntity.ts) is the native counterpart of the example below.

The core is in DevonianLens which is very simple: it links corresponding database tables on different systems of record (e.g. bridging a Slack channel with a Matrix room, copying over messages from one to the other), and calls a 'left to right' translation function when a change happens on the left, then add the result on the right. Here is an implementation of the ['Extract Entity' challenge](https://arxiv.org/pdf/2309.11406):
```ts
new DevonianLens<AcmeComprehensiveOrderWithoutId, AcmeLinkedOrderWithoutId, AcmeComprehensiveOrder, AcmeLinkedOrder>(
      this.acmeComprehensiveOrderTable,
      this.acmeLinkedOrderTable,
      async (input: AcmeComprehensiveOrder): Promise<AcmeLinkedOrder> => {
        const customerId = await this.acmeCustomerTable.getPlatformId({
          name: input.customerName,
          address: input.customerAddress,
          foreignIds: {},
        }, true);
        const linkedId = this.index.convertId('order', 'comprehensive', input.id.toString(), 'linked');
        const ret = {
          id: linkedId as number,
          item: input.item,
          quantity: input.quantity,
          shipDate: input.shipDate,
          customerId: customerId as number,
          foreignIds: this.index.convertForeignIds('comprehensive', input.id.toString(), input.foreignIds, 'linked'),
        };
        return ret;
      },
      async (input: AcmeLinkedOrder): Promise<AcmeComprehensiveOrder> => {
        const comprehensiveId = this.index.convertId('order', 'linked', input.id.toString(), 'comprehensive');
        const customer = await this.acmeCustomerTable.getRow(input.customerId);
        const ret = {
          id: comprehensiveId as number,
          item: input.item,
          quantity: input.quantity,
          shipDate: input.shipDate,
          customerName: customer.name,
          customerAddress: customer.address,
          foreignIds: this.index.convertForeignIds('linked', input.id.toString(), input.foreignIds, 'comprehensive'),
        };
        return ret;
      },
    );
```

Apart from the translation of differently named JSON fields, when copying a message from Slack to Matrix, it will be assigned a newly minted primary key on Matrix, and the bridge needs to keep track of which Slack message ID corresponds to which Matrix message ID.
The `DevonianIndex` class keeps track of different identifiers an object may have on different platforms, and generates a `ForeignIds` object for each platform. If a platform API offers a place for storing custom metadata, the `ForeignIds` object can be stored there.

## Link with Automerge
**Experimental, and not reachable from any entry point** (`storage/Automerge.ts` is not exported; see "Entry points and browser support"). The row API's in-memory storage resolves a conflicting update by the last write; the [Automerge](https://automerge.org) storage was an experiment in handling such conflicts more gracefully, without an example that shows it working.

## Usage
Pick the part from "Which API to use" above; each row links to its guarantees and to what the host must do. Devonian is pre-1.0, so pin an exact version. The [examples folder](examples/) has a native Atomic Data example ([AtomicExtractEntity.ts](examples/AtomicExtractEntity.ts)) and the legacy row API's. Live provider behaviour, and browsers other than Chromium, are not verified; the roadmap for durability, ordering and browser checks is [ontola/atomic-plugins#259](https://github.com/ontola/atomic-plugins/issues/259).

## Contributing
Devonian lives in [ontola/atomic-plugins](https://github.com/ontola/atomic-plugins) (`devonian/`); open an issue or pull request there. Its working rules are in [AGENTS.md](AGENTS.md).
```sh
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm prettier
pnpm typedoc
git commit
```

## Publishing

Publishing to npm is automated: bump `version` in `package.json` as part of a
PR, and once that PR merges to `main`,
[`devonian-publish.yml`](../.github/workflows/devonian-publish.yml) (in the
repository root) runs lint, the format check and the test suite and publishes the new version — nobody runs `npm publish`
by hand. `npm publish`'s own `prepublishOnly` script (`clean` then `build`)
guarantees the published tarball's `build/` always matches the version being
published, rather than whatever was left on disk from an earlier build.

Auth is npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC) rather than a stored token: the package's Settings → Trusted Publisher
page on npmjs.com is configured to trust this exact repo and workflow
filename (`devonian-publish.yml`), and the workflow's `id-token: write` permission
lets GitHub Actions mint a short-lived, run-scoped publish credential — there
is no long-lived secret to rotate or leak. If that trusted-publisher
configuration is ever missing or points at the wrong workflow, publishing
fails with an auth error and the version bump merges but never reaches the
registry.
The native resource API accepts HTTP(S) and DID identities, including AtomicServer `did:ad:` resources, properties and links. Identity allocation still uses an HTTP(S) base; bind existing DID resources explicitly. See [Atomic Data API](docs/atomic-data.md).

### Passive platform lenses

This package no longer ships any platform lens. The Google Calendar, GitHub
issues, Clockify and Notion lenses moved into the plugin that uses each one,
in the ontola/atomic-plugins repository:
`integrations/calendar/devonian/google-calendar/`,
`integrations/issue-tracker/devonian/github-issues/`,
`integrations/timesheets/devonian/clockify/` and
`integrations/notion/devonian/notion/`. Those that need Devonian import it
through the package root (`reconcileRecord` is exported from it for that
reason).

See [the platform lens boundaries](docs/atomic-data.md#passive-platform-lenses)
for the forward and reverse mappings and their scope.

## 0.9.0

Added: the `devonian/lenses` entry point (also exported from the package
root), a dependency-free, synchronous, browser-safe value lens algebra:
`fieldLens`, `customLens`, `readOnlyLens`, `recordLens` and `composeLenses`,
with declared source ownership, unchanged-value preservation, explicit
removal (`unset`), detached copies, `lensEqual` and the example-based law
checker `checkLensLaws` (GetPut, PutGet, stable put). See
[Value lenses](docs/value-lenses.md), and
[Devonian for Cambria users](docs/from-cambria.md) for how it relates to
Cambria. No existing export changed; 0.8.0 code keeps working.

The provider lenses that use it (GitHub issues, Clockify, Raindrop, Solid
bookmarks, Todoist) live in their plugin folders in ontola/atomic-plugins and
are not part of this package; no published drive app imports them yet.

## 0.8.0

Added: `AtomicIdentityMap.unbind(scope, subject)` (in `devonian` and
`devonian/atomic`) forgets which external record a native resource
corresponds to in one scope, and returns that external ID, or `undefined`
when none was bound. It removes only the identity mapping resource: the
native resource, the external record and the resource's mappings in other
scopes stay, and no connector is called. It is for a record that is gone
from the external system while its native copy should stay local-only (the
GitHub issues drive app's "Keep here only"). Afterwards, publishing the
resource through an `AtomicLens` creates a new external record, and
ingesting the same external record again binds it back to the subject
`subjectFor` allocates for it; keeping the two apart is the caller's
decision. See [External identities](docs/atomic-data.md#external-identities).

## 0.7.0

Added: browser support for every entry point (see
[Entry points and browser support](#entry-points-and-browser-support)).
`DevonianClient` and `DevonianTable` extend the new, exported
`DevonianEventEmitter` instead of `node:events` `EventEmitter`; they are no
longer `instanceof` Node's `EventEmitter`. New subpaths `devonian/atomic` and
`devonian/background`. `devonian/reflect` gains a `browser` export condition
without the Node-only `FileIdMap`/`FileKvStore`. The package root now
resolves to compiled JS (`build/src/main.js` with `.d.ts`) instead of
`src/main.ts`, so consumers no longer typecheck devonian's sources under
their own tsconfig. `sideEffects: false` is set for tree-shaking.

**Breaking:** the `devonian/platform-lenses/github-issues*`,
`devonian/platform-lenses/clockify*`, `devonian/platform-lenses/notion*` and
`devonian/platform-lenses/google-calendar*` entry points are removed from
`exports`, and `platform-lenses/` is no longer in the published `files`.
0.6.1 and earlier on npm still ship them. There are no compatibility shims:
import the lens from its plugin folder in ontola/atomic-plugins instead (see
above).

Added: `reconcileRecord`, `acknowledgedBaseline` and their `Sync*` types are
exported from the package root.

For existing Atomic schema targets, new provider lens prototypes and a Solid/Media
Kraken bridge assessment, see [ontology/API lenses](../docs/design/ontology-api-lenses.md).
