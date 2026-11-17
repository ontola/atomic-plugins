# GraphQL collection reader

`syncables/graphql` is a browser-safe, dependency-free collection reader for
[GraphQL Integration 0.2.0-draft](../../openapi-extensions/spec/graphql-integration/README.md).
It accepts a collection description from a validated bundle and an injected
operation-ID executor. It does not load schemas or query documents, establish
authentication, select endpoints, or grant connection access.

```ts
import { readGraphQLCollection } from 'syncables/graphql';

const result = await readGraphQLCollection(validatedCollection, {
  variables: { name: 'demo', first: 100 },
  execute: async ({ operationId, variables }) => {
    // Your trusted executor resolves the pinned query and enforces the
    // operation's variable policy and the connection's permissions.
    return executeApprovedOperation(operationId, variables);
  },
});
```

The executor returns `{ status, body }`, with raw JSON response text. Query
text and endpoints are absent from the callback request. Server-side pinned
operation/variable validation remains mandatory: this reader's input checks
are not a substitute for authorization. Integration-proxy has no GraphQL
operation route yet, so the example callback is an application-supplied
interface, not an existing proxy method.

Supply the collection's page-size variable explicitly as a positive GraphQL
Int; the executor enforces the manifest's min/max and fixed variables.
Do not supply its cursor/offset variable: traversal starts with null/zero.
Cursor reads obey the declared continuation flag and require cursor progress.
Offset reads require `termination: emptyPage`, advance by requested page size,
and continue through short pages. Inputs are cloned for each call.

The defaults are 100 pages, 10,000 items and 1,048,576 response bytes, with
positive overrides under `limits.maxPages`, `maxItems`, `maxResponseBytes`.
The reader rejects malformed/oversized responses, HTTP failures, GraphQL
errors even with partial data/HTTP 200, null parents, missing fields,
invalid/duplicate identities, oversized pages and failed cursor progress.
It retains prior accepted pages with `traversalComplete: false` and an error;
an entire invalid page is discarded. It neither retries nor schedules costs.

`absenceEvidence` is always false. `traversalComplete: true` establishes only
that the traversal reached its declared terminator, not that unseen records
were deleted or that the data is a consistent snapshot. The result is not a
REST `CollectionSnapshot` and is not wired into the local replica's pruning.
Consumers may import the returned records, but must not infer deletion from
their absence. Polymorphic IDs and nested independent traversals are outside
the current contract.

The callback must enforce network deadlines and streaming body limits before
returning; the reader checks the UTF-8 size of already-materialized text. Use
a connection-authorized executor that enforces pinned operation IDs,
variable policy, redirect restrictions and transport limits. The unit tests
read the contract's cursor/offset fixtures and verify browser bundling.
