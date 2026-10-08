# openapi-extensions

A collection of OpenAPI extensions — each proposed for inclusion in the main [OpenAPI Specification](https://spec.openapis.org/oas/latest.html) — developed and maintained by [PonderSource](https://github.com/pondersource).

This folder is now maintained in [ontola/atomic-plugins](https://github.com/ontola/atomic-plugins/tree/main/openapi-extensions), next to the overlays, proxy and sync engine that implement these extensions. It was migrated from the standalone [pondersource/openapi-extensions](https://github.com/pondersource/openapi-extensions) repo with its history intact; issue and PR numbers in older commits and specs (`#13`, `#24`, ...) refer to that repo. Its CI workflow is staged at [`.github/workflows/openapi-extensions-ci.yml`](.github/workflows/openapi-extensions-ci.yml) in this folder, until it is moved to the repository root (see AGENTS.md).

Each extension lives in its own directory under [`spec/`](spec/), with its own spec document, version, and (where available) reference implementation. Extensions are designed to be adoptable without modifying existing OpenAPI documents, typically via an [OpenAPI Overlay](https://spec.openapis.org/overlay/v1.0.0.html).

## Extensions

| Extension | Description | Spec |
|-----------|-------------|------|
| Pagination Schemes | Describes API pagination behaviour (`paginationSchemes`) so clients and tooling can navigate paginated responses without hand-written, API-specific logic. Since 0.4.0, next and previous links may be relative references, resolved against the request URL, the server URL or a declared base (`linkResolution`), and are never followed off the server's origin. | [`spec/pagination-schemes`](spec/pagination-schemes/README.md) |
| CRUD Causality | Describes the create/read/update/delete effect of operations (`crudResources`, `x-crud`) — object URLs, server-added fields, collection membership, and cross-resource references — so tooling can derive an API's full state-transition behaviour, e.g. to drive a stateful mock server. | [`spec/crud-causality`](spec/crud-causality/README.md) |
| Authenticated Principal | Describes the current principal returned for an authenticated operation (`x-authenticated-principal`) — its identity authority, subject, lifecycle guarantees, and optional display claims — so consumers can discover a candidate identity key without guessing from profile data. | [`spec/authenticated-principal`](spec/authenticated-principal/README.md) |

## Proposals

- [Throttling](spec/throttling/README.md): announced request-count windows and shared partitions, without consumer scheduling policy; since 0.2.0-draft also the rate-limit response headers' roles and units (`headers`) and the responses that mean throttling (`signals`: status, header and JSON-body predicates, `throttled` or `quotaExhausted`) (draft for issue #13 and ontola/atomic-plugins pieces.md K6/K7).

- [Filtering and per-item Links](spec/filtering/README.md): API field predicates, authentication-dependent views, and minimal extensions to standard OpenAPI Links (draft for issue #17); since 0.2.0-draft also date-time parameters an API reads as wall-clock time in a zone that a fixed name or another operation's response gives (`x-time-zone`; ontola/atomic-plugins pieces.md K12).
- [API Key Details](spec/api-key-details/README.md): a help link and a key-check operation for an `apiKey` security scheme or an `http` `bearer`/`basic` scheme (`x-api-key-details`), so a client can link to where a key or token is made and test a pasted one before storing it, plus, for HTTP Basic, which half of the credential the pasted token is (`basicCredentials`), so a client never has to ask for an account password (0.2.0-draft, for ontola/atomic-plugins#121 and Decision Inbox Q-086).
- [Authentication Profiles](spec/authentication-profiles/README.md): named profiles (`x-authentication-profiles`), each one security scheme and exactly the operations that accept it on its own, so a consumer that selects one can use a document that declares several credential kinds without sending a credential where it is not accepted (draft for ontola/atomic-plugins#258).
- [Collection Completeness](spec/collection-completeness/README.md): states that a complete read of a collection returns every member, and whether an object absent from it was deleted or only left the collection (`x-completeness`), so a sync client can tell a deleted record from a filtered one (draft for ontola/atomic-plugins#260).
- [Deletion Feeds](spec/deletion-feeds/README.md): names the operation that reports a collection's deletions (`x-deletion-feed`): a change list with tombstones, a deleted-items endpoint or an event log, how a tombstone is recognised, and the cursor that limits a read to changes since the previous one, so a sync client can tell a deleted record from a filtered one without reading each record; and the marker with which a resource's own read answers 2xx for a deleted object (`x-read-tombstone`) (draft for ontola/atomic-plugins#325 and #328).
- [OAuth Authentication Scheme Details](spec/oauth-authentication-details/README.md): token-endpoint authentication capabilities, PKCE requirements, authorization-request parameters, and token-issuance semantics (draft for issues #14, #15, and #16).
- [Webhook Deliveries](spec/webhook-deliveries/README.md): how a receiver verifies a provider's webhook delivery (HMAC-SHA256 over the raw body, signature and optional signed-timestamp headers, where the secret comes from, constant-time comparison), recognises a redelivery by its delivery id, routes it to a source only through bindings established by an access check with each subscriber's own connection, registers and deletes dedicated hooks without ever touching a shared application hook, and which resources and collections an event names for scoped reads (`x-webhook-deliveries`), with neutral examples and synthetic GitHub fixtures (0.1.0-draft, for ontola/atomic-plugins#369).
- [Webhook Subscriptions](spec/webhook-subscriptions/README.md): the records a webhook receiver exposes to its consumers (subscription, lease, cursor, generation, gap marker, `reconciliation-required`), the lifecycle that stops an abandoned subscription from costing storage, and the limits it enforces, announced on the receiver's own document (`x-webhook-subscriptions`) with the proxy-webhooks plan's pilot values as defaults (0.1.0-draft, for ontola/atomic-plugins#369).

## Adding a new extension

1. Create a new directory under `spec/` named after the extension (kebab-case).
2. Copy [`spec/TEMPLATE.md`](spec/TEMPLATE.md) to `spec/<extension-name>/README.md` and fill it in.
3. Add a row for it to the table above.
