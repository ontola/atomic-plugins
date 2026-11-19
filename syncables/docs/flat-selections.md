# Entity tables and saved read selections

`syncables/browser` separates the exact CRUD resource key (one consumer table)
from a collection recipe (one way to read that type). `describeEntityTypes`
groups collection descriptions by exact resource and provides catalog-derived
`relationships` selectors for navigation from an existing saved filter. Existing
collection inputs, entrypoints, presentation and schema metadata remain available.
No provider names or payload-field guesses participate in the model.

`resolveEntityIdentity(document, {resource, record, context})` fills only the
variables in the resource's CRUD identity. Explicit field bindings preserve JSON
string versus integer types. Carried path variables use their declared path schema
when one unambiguous datatype is available. Safe integers are required. The key is
a canonical JSON tuple of resource, template and ordered typed bindings; extra
read context never enters it. A resource without canonical identity cannot be
projected as a flat entity. Repositories reached from two organization/root
collections therefore share a row; an issue number scoped to two repositories
has two identities.

A JSON `ReadSelection` has `version:1`, `resource`, and one `source`:

- `{kind:'bound', bound}` selects one current catalog collection recipe.
- `{kind:'related', origin, via}` selects a declared relationship from one entity.
  `origin` holds `{entity,record,context,read}`. Its raw snapshot and old read address
  are hints, never evidence that a provider has returned a matching detail record.
- `{kind:'fanout', from, via, entities?}` runs a relationship for actual accepted
  source observations. Optional typed entity constraints intersect those actual
  observations; they never introduce a missing entity or expand the source scope.

`via` is `{collection,kind:'identity'|'responseLink',reference?,link?}`. Build it
from `describeEntityTypes(...).relationships` or an actual row's catalog
navigation, rather than parsing paths. For example, opening a repository from an
organization-filtered repository view saves a fanout over that existing view,
constrained to the repository identity. Its issues retain organization provenance.

`parseReadSelection` rejects unknown keys and bounds recursive selection depth.
`readSelectionKey` supplies the shared durable logical key. It excludes origin
snapshots, labels, transport addresses and page-size defaults; it includes typed
entity constraints, normalized as a deterministic set of typed canonical keys.
Duplicate constraints do not change the key; inconsistent identity objects fail.
Bound selections support catalog-fixed query/body recipes,
not arbitrary user filters. Changed semantic query/body parameters fail validation.
Future semantic field predicates require an explicit separate metadata/API contract.

`compileReadSelection(document, selection, options)` synchronously returns
`{key,resource,selection,allows,observe}` for a host-local authority guard. Options
include trusted replacement `origins`, `publicOnly`, `querySelection` and
`maxPartitions` (default 64, maximum 256). `allows(TransportRequest)` is pure;
`observe(request, TransportResponse)` is asynchronous and takes raw JSON text in
`response.body`. Only actual accepted provider responses unlock descendant scopes.
A Response Link source is re-read and must identify the selected canonical parent
before its target is enabled. The guard replays the existing reader against its
bounded response journal, so paging and Link resolution are not reimplemented.
Unclassified next-link query parameters require the actual replayed next request.
Public mode checks effective anonymous security on discovery, detail and target
operations. Instantiate a new guard per run/current catalog. Never accept a frame's
compiled guard or its response journal as host authority.

`readSelection` uses the same plan and existing `readBoundCollection` paging,
projection and Link resolver. Its injected transport receives all requests. One
request/deadline/record budget spans discovery and every target partition. The
result contains terminal `observations`, discovery/target `partitions`, `errors`
and aggregate `complete`. Accepted partial observations survive an error, but
incomplete discovery or any failed partition keeps the whole selection incomplete.
An empty complete discovery is complete with no invented descendant reads.

`projectEntityObservation` returns raw data, canonical identity, typed projected
values, read/relationship/detail provenance and explicit `value`/`null`/`absent`
field evidence keyed by ontology shortname. It reuses `projectReadRecord` datatype
conversion and required-field validation. Consumers own generations, run ordering,
rule pause state, membership and field merging. An absent property is not a clear;
partial or paused scopes are not evidence of remote deletion. A latest-explicit-
value/null policy can use the emitted evidence without parsing schemas or making
another provider read. `representationKey` and `partitionKey` retain audit context;
they are not entity identity.
