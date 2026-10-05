# Devonian for Cambria users

Devonian applies bidirectional mapping to data portability between independent
systems of record. If you know Cambria, the familiar part is presenting the same
data in different shapes and carrying edits back without losing information.
The additional problem is keeping track of which records correspond when each
system assigns its own identifiers and accepts writes through its own API.

This guide describes the source in this repository. The `devonian/lenses` value
algebra and its GitHub and Clockify prototypes are **unreleased** additions in
[PR #271](https://github.com/ontola/atomic-plugins/pull/271); npm 0.8.0 does not
contain that entry point. The native Atomic Data API is already available in
0.8.0. Devonian remains a work in progress.

## Start with the concepts you already know

Cambria describes transformations in a YAML/JSON lens language and can translate
documents, JSON Patch edits and JSON Schema descriptions through those lenses.
Devonian lets application code supply TypeScript transformations. Its value
algebra offers a small set of combinators around those functions. It does not
derive schema translations or generate types from them.
[Cambria's API overview](https://github.com/inkandswitch/cambria-project#cambria)
describes those three translation targets.

The Cambria research project connects schema versions in a lens graph and
selects translation paths through it. Devonian currently has explicit value
lens composition and application-created connector lenses; it does not register
schema versions or find a path between them. Cambria also addresses API
compatibility, so there is overlap in where the libraries can be useful.
[Cambria's research essay](https://www.inkandswitch.com/cambria/) explains its
schema graph and distributed compatibility goals.

| Familiar concept                           | Devonian counterpart                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| A relationship between two data shapes     | A value lens with `get(source)` and `put(view, previousSource)`                                                      |
| Lens operators                             | TypeScript combinators such as `fieldLens`, `customLens`, `recordLens` and `composeLenses`                           |
| Information absent from one representation | The previous source passed to `put`, with explicit ownership of the fields that may change                           |
| Translating edits                          | Computing an updated value, or a native Atomic patch; no general JSON Patch translation API                          |
| Schema/type artifacts from a lens          | Application-written TypeScript types and validators; a separate `AtomicSchema` property catalog for native resources |
| Record correspondence across systems       | Scoped external IDs bound to a native resource by `AtomicIdentityMap`                                                |

The correspondence in this table is conceptual, not a migration API for Cambria
lens files. There is no Cambria importer.

## One name, three APIs

Several Devonian APIs use the word _lens_. Choose according to the work you
need to do:

- **`ValueLens<Source, View>`**, from the unreleased `devonian/lenses`, maps
  supplied values synchronously. It has no connector, identity map or scheduler.
- **`AtomicLens<External>`**, from `devonian/atomic`, imports external records
  into native resources and publishes native edits through a connector. It owns
  the sequence of connector calls and identity operations.
- **`DevonianLens`**, in the original row API, links event-driven tables using
  asynchronous translation functions. It remains for compatibility. The native
  API is the documented starting point for new integrations needing resources,
  identity and explicit create/update/delete operations.

`devonian/reflect` is a separate, specialized engine for reflecting records,
open/closed state and comments between two syncables-backed sides. It is not the
value algebra or a general schema evolution engine. Its origin markers and ID
ledger serve that reflection workflow.

## A mapping retains the previous representation

Here is a complete example using the unreleased value algebra. The source is a
provider object; the editable view exposes only its title and body.

```ts
import {
  checkLensLaws,
  customLens,
  fieldLens,
  recordLens,
} from 'devonian/lenses';

interface ProviderIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
}

interface IssueView {
  name: string;
  body: string;
}

const issue = recordLens<ProviderIssue, IssueView>({
  name: fieldLens<ProviderIssue, 'title'>('title'),
  body: customLens<ProviderIssue, string>({
    reads: ['body'],
    writes: ['body'],
    get: (source) => source.body ?? '',
    put: (body) => ({ set: { body } }),
  }),
});

const previous: ProviderIssue = {
  number: 15,
  title: 'Before',
  body: null,
  labels: ['bug'],
};
const edited = { ...issue.get(previous), name: 'After' };
const updated = issue.put(edited, previous);
// { number: 15, title: 'After', body: null, labels: ['bug'] }

const laws = checkLensLaws(issue, previous, edited);
// { getPut: true, putGet: true, stablePut: true }
```

The body appears as an empty string in the view. Because it was not edited,
putting that view back retains the source's `null`. The issue number and labels
also survive. A pair of conversions that rebuilt the whole object from the view
would need to recover those details separately.

`customLens` skips its writer when the view is unchanged, using structural
equality by default. An unchanged put therefore preserves representations rather
than normalizing them. Callbacks and outputs receive detached copies. This
initial API targets structured-cloneable, JSON-like objects, arrays and primitive
values; application-specific value types need appropriate equality and domain
handling.

Ownership is checked at the top level: the body mapping may write `body` only.
Property deletion requires an explicit `unset` patch. A record lens rejects
overlapping write ownership. These checks help prevent accidental data loss;
they do not prove that arbitrary TypeScript callbacks are lawful. `reads` is
dependency metadata, not a restriction on what a callback can inspect.

## Some fields form one editable concept

The provider prototypes illustrate why field-by-field renaming is insufficient:

- GitHub status combines `state` with workflow labels. A status edit owns those
  fields together. A title edit preserves the existing labels, including their
  metadata and spelling. The view supports Todo, Doing, Blocked and Done.
- Clockify project selection also controls the task. Changing the project
  removes the old `taskId`; leaving the project unchanged retains it. Start and
  end belong to a grouped interval, with validation for supported time edits.

Use one custom component for coupled writes and a whole-view validator for
constraints across components. Disjoint write ownership alone is insufficient
when one component reads fields another changes. `composeLenses(outer, inner)`
supports a source-to-middle-to-view chain, but the application must ensure the
inner edits remain in the outer lens's supported domain.

Unlike a restricted operation language, arbitrary callbacks can express
provider-specific mappings directly. They also put more responsibility on the
author: write both directions, specify the supported edits, and test preservation
and round trips. Devonian does not infer an inverse from a forward callback.

The law checker evaluates three examples: reading then putting preserves the
source; putting then reading recovers the desired view; putting the same edit
again is stable. It is not a proof over all inputs. It does not check the stronger
law that two different successive puts equal only the last put. For example,
switching a Clockify project away and back cannot recover a discarded task from
the current source alone. Unsupported edits may throw.

## Record identity is a second problem

Suppose GitHub assigns an issue number `15`, and a second tracker assigns the
corresponding issue `37`. Renaming fields does not establish that these records
are the same issue. Devonian's native API gives the issue a subject identity and
binds each system's external ID to it:

```ts
import { AtomicIdentityMap, AtomicSchema, AtomicStore } from 'devonian/atomic';

const store = new AtomicStore(new AtomicSchema());
const identities = new AtomicIdentityMap(store, 'https://example.com/bridge');
const subject = 'https://example.com/issues/shared';
const github = { scope: 'https://github.com/example/project', entity: 'issue' };
const other = {
  scope: 'https://tracker.example/projects/demo',
  entity: 'issue',
};

identities.bind(github, 15, subject);
identities.bind(other, '37', subject);
const nativeId = identities.lookup(github, 15); // subject
const otherId = identities.externalId(other, subject); // '37'
```

This example binds identity only; it does not create a populated native issue or
either external record. In a connector flow, `AtomicLens` records the external
ID returned by a successful create.

The key includes connector scope, entity type and ID type/value. Numeric `15`
and string `'15'` differ, as do issue `15` in two repositories. Matching content
never establishes identity: two identical transactions can be two real records.
Native resources use HTTP(S) or DID subjects, with property identities expressed
as URLs or DIDs.

An identity map records correspondence, not causality. It is not a vector clock
and cannot tell which edit is newer or resolve simultaneous edits. Its mapping
resources are included in JSON-AD snapshots; the host must persist those
snapshots to retain correspondence across restarts.

## From values to connector writes

An `AtomicStore` holds native resources and validates properties against a local
`AtomicSchema`. An `AtomicLens` joins that store and identity map to one external
connector. Its `read(external, subject)` transformation returns native patches;
its `write(resource, previous)` transformation returns an external object.
Updates receive the fetched previous object; creates receive `undefined`.

The host calls `await lens.ingest(record)` for a fetched record or webhook. The
lens applies the projection and binds the external identity without writing back
to the provider. After a native edit, the host explicitly calls
`await lens.publish(subject)`. The lens looks up the external ID and performs an
update, or creates an external record and binds its returned ID. Calls to one
lens instance are queued and failures reject to the caller.

You can use a value lens inside these transformations, but that is application
wiring: convert its result into managed native patches and handle the create
case separately. The algebra does not automatically turn a view into a resource
or send an HTTP request. Omitted patch properties survive; removal is explicit.

The native projection may also return related resource patches and identity
bindings. The [Extract Entity example](../examples/AtomicExtractEntity.ts) uses
this to turn a flattened order into linked Order and Customer resources, using
an explicit customer ID. Those local changes are applied transactionally. If a
shared Customer changes, the application must select and publish the affected
orders; there is no graph dependency subscription engine.

Fetching pages, authentication, scheduling, provider conflict checks and review
flows belong to the surrounding application. Syncables can supply OpenAPI-driven
data access; it does not supply Devonian's mapping or identity policy.

## What a successful round trip does not establish

Keep transformation tests and synchronization guarantees separate:

- A store snapshot includes resources and identity mappings, but the store is
  in memory. The host owns checkpointing and recovery. Checkpoint after awaiting
  in-flight operations.
- A connector create receives a stable idempotency key. The connector must
  deduplicate retries, including after a restart. A lost response cannot be
  repaired generically when a provider lacks that facility; it needs a recovery
  policy specific to the connector.
- One lens's queue is not a distributed lock or a lock over direct store edits.
  There is no built-in revision-clock conflict resolution, stale-event rejection
  or guarantee of distributed convergence in the native API.
- Atomic Data resources do not imply signed Atomic Commits, live Atomic Server
  transport or permissions enforcement. Those protocols are not implemented by
  this API. Browser bundle checks also do not establish a working service-worker
  deployment.

Devonian supplies building blocks for a bridge whose identity, preservation and
write policy you can inspect. The surrounding application must still specify how
that bridge behaves under concurrent edits, retries and failures.

## Where to go next

- [Value lenses](value-lenses.md): the unreleased combinators, equality,
  ownership and supported-edit contracts.
- [Native Atomic Data API](atomic-data.md): resource schemas, scoped IDs,
  connector contracts, deletion and persistence.
- [GitHub prototype](../../integrations/issue-tracker/devonian/github-issues/lens/algebra.ts)
  and [Clockify prototype](../../integrations/timesheets/devonian/clockify/lens/algebra.ts):
  concrete provider mappings with preservation and law tests next to them. They
  are repository examples, not package exports or current production app paths.
- [Package README](../README.md): entry points, the reflection engine,
  background scheduling and the legacy row API.
