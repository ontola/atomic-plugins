# GraphQL Integration operation bundles (experimental)

**Spec version:** 0.2.0-draft

## 1. Introduction

A GraphQL endpoint accepts many operations at the same HTTP method and path.
An HTTP allowlist therefore cannot establish which queries or writes a caller
may execute. This draft describes immutable schema and query bundles plus
caller-variable policy, validated before an executor can select an operation.
It is a companion contract hosted alongside the OpenAPI proposals; it is not
an OpenAPI extension or an OpenAPI Overlay standard.

This draft covers offline authoring, variable binding, collection metadata
and a bounded reference reader using an injected transport. Neither
integration-proxy nor syncables executes these bundles yet. Authentication,
catalog binding and production transport policy remain follow-up contracts
in the [implementation plan](../../../overlays/GRAPHQL_PLAN.md).
A valid bundle alone MUST NOT grant access to an endpoint or connection.

## 2. Overview

See [relay.json](examples/relay.json) and [offset.json](examples/offset.json),
with their adjacent synthetic SDL and operation documents. Both are invented
schemas, not provider snapshots or live-provider certifications.

A JSON manifest contains `version`, `endpoint`, `schema` and `operations`.
`collections` is the only additional root field in 0.2. All objects reject unknown fields so unsupported capabilities cannot silently
be ignored. Both versions accept SDL only, not introspection JSON. Version 0.1.0-draft
remains supported for operation-only manifests. Version 0.2.0-draft requires
a nonempty `collections` array; version 0.1 rejects that field.

## 3. Conventions

MUST, MUST NOT, REQUIRED, SHOULD and MAY have their RFC 2119 meanings. SHA-256
means a lowercase 64-character hexadecimal digest of the exact file bytes,
before parsing or normalizing line endings. No schema canonicalization is
assumed by this version.

## 4. Object definitions

| Object | Fields and constraints |
| --- | --- |
| Manifest | `version`: `0.1.0-draft` or `0.2.0-draft`; `endpoint`: absolute HTTPS URL without userinfo, query or fragment; `schema`: Artifact; `operations`: nonempty array of Operation. |
| Artifact | `path`: relative local file path; `sha256`: exact content digest. Resolving the path, including symlinks, MUST stay inside the manifest directory. No remote fetching. |
| Operation | `id`: unique GraphQL name; `document`: Artifact; `variables`: map from every declared variable name to its Policy. |
| Policy | Empty object allows a caller value subject to GraphQL input coercion. `fixed` supplies a trusted JSON value and forbids caller input for that variable, even if equal. Alternatively, `min` and/or `max` constrain an Int variable; endpoints are inclusive GraphQL Ints and `min` MUST NOT exceed `max`. |

The schema MUST pass GraphQL schema validation. Each document MUST contain
exactly one named `query`, with a name equal to its operation ID, plus any
used fragments. It MUST pass standard GraphQL document validation against
the pinned schema. Mutations, subscriptions, type-system definitions and all
executable directives are unsupported in this version. Forbidding directives
also excludes conditional fields and incremental execution until result-shape
and response policy are specified.

Variable policy MUST cover exactly the declared variables, including those
with document defaults. A fixed value MUST pass GraphQL coercion and MUST NOT
also declare bounds or a document default. Bounds apply only to scalar Int
or Int! variables; lists and other scalar types are unsupported for bounds.
Document defaults MUST satisfy policy. A bounded value MUST be present and
non-null after coercion; omission/null MUST NOT bypass a configured cap.

## 5. Composition and OpenAPI overlays

This contract uses whole immutable bundles rather than SDL patches. OpenAPI
Overlay JSONPath targets do not identify GraphQL schema coordinates or query
selections. A future patch format needs its own exact-target and compatibility
rules. Do not apply this draft to an OpenAPI document.

A future trusted catalog will bind the bundle to a connection, credentials,
operation permissions and deployment policy. The endpoint in a bundle is
metadata, not an SSRF authorization decision. An executor MUST validate that
binding separately and prevent bypass through an unrestricted HTTP proxy.

## 6. Variable binding reference

Given a selected, validated operation and untrusted caller-variable object:

1. Reject unknown variable names and any caller-supplied fixed variable.
2. Inject trusted fixed values, without mutating caller input.
3. Apply GraphQL input coercion, required-variable checks and document defaults.
4. Enforce bounds on the resulting values. Reject errors before any request.

Callers MUST NOT supply query text, fragments, endpoint overrides or a
replacement operation name. An executor MUST resolve the operation ID to the
pinned document. The reference implements this binding but sends no request.

## 7. Validation and acceptance

Run with the pinned [requirements](requirements.txt):

```sh
python -m unittest discover -v -p 'test_*.py'
python validate.py examples/relay.json examples/offset.json
```

The tests cover both schema shapes, fragments/aliases, schema and operation
digests, escaping paths/symlinks, invalid fields and input types, ambiguous or
renamed operations, mutation/subscription rejection, unsupported directives,
unknown policy fields, fixed-variable injection, invalid caller input and
bounds/default bypasses. Fixtures may be changed by updating their hashes;
that makes a new bundle and does not authorize changing a published artifact.

## Reference implementation

[validate.py](validate.py) uses graphql-core 3.2.7 for the GraphQL parser,
schema/document validation and variable coercion. It is an offline Python
authoring reference, not a choice of parser for the Rust proxy or browser
reader. Their parser/runtime compatibility is still to be evaluated.

## 8. Collection contract (0.2.0-draft)

See [Relay collections](examples/relay-collections.json) and
[non-Relay collections](examples/offset-collections.json). A Collection Object
has exactly `id` (unique nonempty name), `operation` (a declared operation ID),
`items` (response path), `identity` (path relative to each item), and
`pagination` (Cursor or Offset Object). Paths are nonempty arrays of GraphQL
response keys, starting inside `data` (omit `data` itself); aliases therefore
use the alias, not the schema field name. The validator resolves fragments,
merged selections and schema coordinates before accepting a path.

Item paths MUST select a list of concrete objects, without crossing an
intermediate list. Identity MUST select an ID/String field on each item;
responses MUST supply a nonempty string identity, unique across the traversal.
Polymorphic/interface collections, compound identity and independent nested
connections remain unsupported and MUST fail validation.

Both pagination objects require `type`, `field` (the paginated field path),
`pageSizeArgument` and `pageSizeVariable`. The target field's argument MUST
bind directly to that variable in every merged selection. Its variable
policy MUST declare an inclusive positive `min` and a `max`. Items MUST
descend from the paginated field. The executor MUST apply GraphQL coercion
and variable policy on every request, preserving all non-paging inputs.

Cursor Objects additionally require exactly `cursorArgument`,
`cursorVariable`, `hasNextPage` and `endCursor`. The cursor argument MUST bind
to the named nullable String variable with no default/fixed value or bounds.
The two response paths MUST descend from `field` and select Boolean and
String respectively. A traversal starts with cursor null; a caller MUST NOT
supply the traversal-position variable. If `hasNextPage` is true, `endCursor`
MUST be a nonempty string not used previously. A missing field, null parent,
non-Boolean continuation flag or invalid cursor fails the traversal. When
`hasNextPage` is false, the end cursor may be null. Short pages do not imply
termination.

Offset Objects additionally require exactly `offsetArgument`,
`offsetVariable` and `termination: emptyPage`. The argument MUST bind to an
Int variable whose policy is exactly `min: 0`. Start at offset zero and add
the coerced requested page size each time; an empty array ends the traversal.
A short page MUST NOT end it. This is an explicit traversal contract for a
provider that supports that rule, not an inferred rule for arbitrary lists.

Page-size and position variables MUST differ. The reader rejects pages with
more items than requested, duplicate or missing identities, repeated/missing
cursors, and exceeded page/item limits. It MUST reject unknown collection IDs
and caller-supplied starting positions before invoking the transport.

## 9. Execution and response reference

[reader.py](reader.py) loads a validated bundle, executes a selected operation
ID with a trusted injected transport, and reads one explicit collection. The
transport receives the validated endpoint and `{query, operationName,
variables}` built from the pinned operation. No caller-provided query,
endpoint, fragments or operation replacement is accepted. The transport
returns `(status, raw JSON bytes)`; this is not a public HTTP API or a
connection authorization implementation.

Non-2xx status, transport failure, oversized/invalid JSON, GraphQL errors
(including HTTP 200 partial data), missing/null response paths, invalid item
shape or continuation metadata MUST fail the read. No automatic retries.
Transport exception details and provider error messages are not reflected in
the returned diagnostic. The reference checks raw response size after the
transport returns; a production transport MUST also bound streaming reads,
enforce timeouts and prevent redirects before materializing that body.

`ReadResult` retains only prior fully validated pages on failure and supplies
`traversal_complete: false` with an error. A valid terminal page produces
`traversal_complete: true`. **Neither outcome is deletion/absence evidence**:
`absence_evidence` is always false. Visibility, collection completeness and
snapshot consistency require independent contracts; a finished traversal
alone must never delete local records.

Reference limits are 100 pages, 10,000 items and 1,048,576 response bytes.
Callers may choose positive page/item limits. Checkpoints, retries, cost
scheduling, provider OAuth and connection authorization remain outside this
reference. The tests execute the pinned documents against synthetic GraphQL
schemas as well as testing response/error fixtures.
