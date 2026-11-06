# GraphQL Integration operation bundles (experimental)

**Spec version:** 0.1.0-draft

## 1. Introduction

A GraphQL endpoint accepts many operations at the same HTTP method and path.
An HTTP allowlist therefore cannot establish which queries or writes a caller
may execute. This draft describes immutable schema and query bundles plus
caller-variable policy, validated before an executor can select an operation.
It is a companion contract hosted alongside the OpenAPI proposals; it is not
an OpenAPI extension or an OpenAPI Overlay standard.

This first milestone covers offline authoring and variable binding only.
Neither integration-proxy nor syncables executes these bundles yet. Collection
metadata, authentication/catalog binding, response handling and transport
policy remain follow-up contracts in the [implementation plan](../../../overlays/GRAPHQL_PLAN.md).
A valid bundle alone MUST NOT grant access to an endpoint or connection.

## 2. Overview

See [relay.json](examples/relay.json) and [offset.json](examples/offset.json),
with their adjacent synthetic SDL and operation documents. Both are invented
schemas, not provider snapshots or live-provider certifications.

A JSON manifest contains `version`, `endpoint`, `schema` and `operations`.
All objects reject unknown fields so unsupported capabilities cannot silently
be ignored. This version accepts SDL only, not introspection JSON.

## 3. Conventions

MUST, MUST NOT, REQUIRED, SHOULD and MAY have their RFC 2119 meanings. SHA-256
means a lowercase 64-character hexadecimal digest of the exact file bytes,
before parsing or normalizing line endings. No schema canonicalization is
assumed by this version.

## 4. Object definitions

| Object | Fields and constraints |
| --- | --- |
| Manifest | `version`: exactly `0.1.0-draft`; `endpoint`: absolute HTTPS URL without userinfo, query or fragment; `schema`: Artifact; `operations`: nonempty array of Operation. |
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
