# GraphQL integration metadata plan

Status: proposal, 2026-11-06. No GraphQL runtime support is implemented by
this document. Start with a read-only GitHub GraphQL pilot and synthetic
fixtures; use a second schema with a different pagination shape before
claiming a generic contract.

## Recommended model

Keep the immutable catalog and provider-neutral runtime. Add a GraphQL
sidecar manifest paired with a pinned schema and pinned operation documents.
Use GraphQL schema coordinates (`Query.repository`, `Issue.id`) for schema
metadata and operation IDs plus selection paths for read behavior. Do not
apply OpenAPI JSONPath overlays to SDL: GraphQL fields, arguments and
selection sets need GraphQL validation.

Use introspection JSON or SDL as the schema source; record its digest,
retrieval provenance, API version and relevant request headers. Normalize to
a canonical schema representation for validation, while retaining the
original bytes. Introspection may be disabled: checked-in vendor SDL is an
acceptable explicitly pinned source. Schema knowledge alone supplies neither
authentication requirements nor collection completeness.

Separate three artifacts:

- Schema snapshot: types, fields, arguments, nullability and directives.
- Operation documents: reviewed named queries, fixed selections/fragments,
  variable definitions and immutable content hashes.
- Integration manifest: endpoint and auth policy, allowed operations,
  variable bindings, collections, pagination, identity, completeness,
  throttling/cost hints and provenance. Keep consumer-specific filters in
  catalog selection, as with REST today.

Initially version the whole manifest; introduce coordinate-targeted patches
only if reuse requires them. If patches are added, require exact target
matches, ordered deterministic application, schema digest matching and
explicit dependency/conflict checks. Specify this new contract under
`openapi-extensions/` following the repository's spec-first process, clearly
labeling the GraphQL contract's scope rather than calling it an OpenAPI
Overlay standard.

## Execution and authorization

A method/path allowlist on `POST /graphql` cannot enforce read-only access.
Add a generic GraphQL executor accepting a catalog operation ID and typed
variables. The server retrieves the pinned document; callers cannot replace
its query text, fragments, operation name or endpoint. Validate variables
against both GraphQL input types and catalog constraints (including tenant
bindings, page-size caps and fixed filters). Apply authorization to operation
IDs and connection grants. Reject unknown variables and operations.

Keep existing REST catalog entries compatible. Introduce an explicit
protocol discriminator and separately validated GraphQL entry shape; decide
exact names in the contract PR. Reuse credential storage, OAuth refresh and
connection ownership, while keeping provider data out of proxy runtime code.
Do not enable the existing unrestricted HTTP proxy route for a GraphQL-only
connection: it would bypass the operation policy. Test every connection access
path. Require HTTPS, configured endpoint/header policy, existing body limits
and redirect protections.

Pilot queries only. Reject mutations, subscriptions, batches, arbitrary query
text and incremental `@defer`/`@stream` transport in the first version.
Persisted-query provider support is optional; server-side pinned documents
provide the allowlist even when the provider does not support persisted queries.

## Read and sync contract

For each collection declare the operation ID, parent/input variable mapping,
item selection, stable identity (including `__typename` for polymorphic IDs),
response cursor and continuation bindings. A Relay-shaped example maps
`data.repository.issues.nodes` to items, `pageInfo.hasNextPage` to continuation,
and `pageInfo.endCursor` to the next request's `after` variable. Validate these
paths against the operation's result shape, including fragments and aliases.
Result paths refer to response keys; schema coordinates refer to schema names.

Support one explicitly named connection per traversal initially. Nested
connections need independent parent-bound traversals, not a single global
cursor. Require cursor progress, preserve filters and ordering, bound page
sizes, and fail on missing continuation data. Do not infer completion from a
short page. Add offset pagination only with its own declared termination rule.

Handle HTTP status and GraphQL `errors` together. HTTP 200 with errors is not
an unconditional success. Partial data, authorization failures and null
bubbling must not mark a collection complete or trigger deletion. Initially
fail the traversal on any GraphQL errors; later permit partial results only
with a specified error-path policy and explicit incomplete outcome. Keep
identity/visibility limits and snapshot consistency separate from pagination.
No deletion inference until an independently justified completeness or
tombstone contract exists.

Describe cost budgets, response extensions and retry signals explicitly;
GraphQL limits often charge query cost rather than request count. Reuse
throttling concepts where compatible, but do not reinterpret REST request
buckets as cost units. Unknown errors remain errors, not automatic retries.
Keep cursor/checkpoint scope bound to operation hash, variables and schema
revision. Mutations later need their own idempotency, result identity,
causality and ambiguous-outcome recovery design before enabling writes.

## Delivery sequence and acceptance

1. **Contract and fixtures:** document manifest/schema/operation formats and
   compatibility; add a minimal Relay schema and a non-Relay schema, pinned
   named operations and positive/negative manifest fixtures. Choose the
   GraphQL parser/validator after checking package/runtime compatibility.
   Acceptance: unknown fields, invalid selections, variable type mismatches,
   ambiguous operation names and mismatched schema hashes fail validation.
2. **Catalog and proxy:** implement protocol-discriminated loading and the
   operation-ID executor, reusing generic auth plumbing. Acceptance: query
   replacement, mutation injection, raw-proxy bypass, fixed-variable override,
   unauthorized operations and endpoint override all fail; REST tests pass.
3. **Reader adapter:** normalize results into the existing collection/page
   contract used by syncables, with explicit complete/incomplete outcomes.
   Acceptance: two-page reads, empty final pages, repeated/missing cursors,
   aliases/fragments, nullable parents, polymorphic IDs, HTTP 200 errors and
   rate exhaustion behave correctly in synthetic end-to-end tests.
4. **Provider pilot:** author pinned GitHub schema/operations/manifest outside
   runtime code and publish an opt-in dated candidate catalog. Verify schema
   composition and cost handling offline, then a real read-only grant and
   bounded read when test credentials are available. Record live evidence
   separately; preserve existing REST selections for rollback.
5. **Generalize:** validate a second provider, add nested traversal only with
   independent cursor tests, and finalize compatibility/version negotiation.
   Unsupported manifest capabilities must fail explicitly rather than silently
   degrade. Review writes and subscriptions as separate follow-up designs.

Completion means a catalog-driven GraphQL read passes through proxy policy
and the collection reader without provider branches, with reproducible pins
and error/completeness behavior verified. Publishing metadata alone does not
meet that criterion.

## Implementation progress (2026-11-06)

**Contract and fixtures:** GraphQL Integration 0.2.0-draft now validates
exact-byte SDL/query pins and introspection response snapshots, named query
operations, variable policy, collection/result paths, schema coordinates and
argument-to-variable pagination bindings. Aliases and fragments are resolved.
The synthetic Relay/non-Relay bundles cover cursor and explicit empty-page
offset traversal. Concrete object identities only are supported; polymorphic
identity, nested independent traversals and runtime parser selection remain
open. Version 0.1 operation-only manifests remain supported.

**Execution reference:** the Python reference executes pinned operation IDs
through an injected transport and enforces variable policy. It handles
response errors, cursor/identity failures and page/item/body limits. This
reference provides no catalog route, credentials or connection authorization.

**Reader adapter:** the browser-safe `syncables/graphql` subpath consumes
validated collection descriptions through an injected operation-ID executor.
It preserves inputs and earlier accepted pages, rejects partial GraphQL errors
and invalid progress, and enforces explicit page sizes and read limits.
Traversal completion is separate from absence evidence; the result is not
wired into REST local-replica pruning. See [usage](../syncables/docs/graphql.md).

**Next implementation milestone:** production protocol-discriminated catalog
loading, pinned-operation execution, connection authorization and raw-proxy
bypass prevention in integration-proxy. The TypeScript adapter still requires
an application-supplied executor. These parts must be implemented together
before exposing a GraphQL connection. Real-provider grants, cost policy,
polymorphic IDs and the provider pilot remain open. The plan's overall
completion criterion is not yet met.

Validation: 26 Python contract/reference tests and all four example manifests
pass. The 18 TypeScript reader tests pass, including browser bundling. Full
Syncables build/lint, formatting and changelog checks pass; 1,955 unit tests
pass and 67 optional tests skip with no local database/native-peer setup.
