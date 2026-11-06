# OpenAPI-derived linked Atomic resources

`syncables braid --braid-view atomic` serves an experimental
`syncd-braid-atomic-v1` representation of accepted PostgreSQL snapshots. It
uses the same config, explicit collection selection and reader token as the
raw Braid listener. No provider request, login, write or history migration is
performed. `--braid-view raw` remains the default and keeps its existing wire
format and version namespace.

```sh
syncables braid --config /absolute/path/config.json \
  --collections google-keep/account/notes --braid-view atomic
```

The envelope still contains a collection, immutable source revision and a map
of JSON-AD resource **text** strings. That transport encoding protects numeric
lexemes; it is not a JSON-string column in an imported table. In the generated
source-record table, `source-id` has Atomic datatype `string` and `source-json`
has datatype `atomicURL`, pointing to a typed resource in another table.

## Schema and values

`recursiveAtomicProjector` is exported from `syncables/daemon`. Supply the raw,
unexpanded pinned OpenAPI document, its byte hash, the CRUD resource name and a
source namespace. It compiles local `$ref`s (including recursive components)
and generates Class, Property and Table resources before examining records.
Class and Property identities depend on the OAD hash and JSON Pointer, not
display labels, installation IDs or observed values. Every declared object,
array and array-entry class has a table, including in an empty collection.

For Google Keep, a source-record references a Note. Its body references a
Section; the section's list references a ListContent. Its listItems references
an array resource. Each array has a length and references occurrence rows;
each occurrence has an integer index and a typed value. ListItem.checked is
a boolean because the OAD declares it as one. TextContent is a separate typed
object. Shared component refs reuse classes, while separate object occurrences
keep separate rows.

The profile currently supports objects, arrays, primitive types, local refs,
required/optional fields and OpenAPI 3.0 nullable fields. Original schema
definitions, defaults, readOnly annotations and remaining constraints are
retained as structured schema metadata under
`urn:syncables:atomic:v1:definition`; retaining them does not establish full
OpenAPI validation. Present primitive types, required fields and disallowed
additional properties are checked. Composed schemas and unsupported types fail
explicitly instead of selecting a branch. External refs are not fetched.

Objects and arrays are always linked resources. Undeclared additional values
are retained through typed value nodes, without adding observed fields to the
declared class. Null is recorded separately from an absent property, using
`null-properties` or an array occurrence's `null` marker. Empty objects and
empty arrays remain resources. Array occurrences preserve order and duplicate
values. Numeric tokens are emitted without Number coercion. Resource/schema
definitions are the only structured metadata; source objects and arrays do
not become JSON-valued columns.

Value identities are source-record/path identities. An array element without
an OAD identity is an occurrence at an index, not a claim of stable provider
identity across insertions or reordering. Projection is bounded to 100,000
visited values and depth 128, in addition to the Braid 32 MiB response bound.
Properties and schemas are not inferred as provider relationships.

## Versions and consumers

The Braid version namespace includes the representation and generated schema
fingerprint. Raw and linked views, and changed projection schemas, cannot reuse
one another's versions. A historical snapshot is projected only against its
pinned OAD hash. Source snapshots and their existing resource strings remain
unchanged in PostgreSQL.

The existing native Atomic peer's `atomic-tables-v2` projection is unchanged;
this new representation is an explicit opt-in API for consumers such as the
NextGraph adapter. Consumers should preserve the resource graph and schema
identities instead of constructing a provider-specific replacement ontology.

Google Keep View 0.3.0 accepts the exact generated Note class for its pinned
Keep document and traverses these references directly. It registers that class
for Add view. This path is read-only; it does not use the sync app's editable
note/item ontology or its provider write-back machinery.
