# openapi-extensions

A collection of OpenAPI extensions — each proposed for inclusion in the main [OpenAPI Specification](https://spec.openapis.org/oas/latest.html) — developed and maintained by [PonderSource](https://github.com/pondersource).

Each extension lives in its own directory under [`spec/`](spec/), with its own spec document, version, and (where available) reference implementation. Extensions are designed to be adoptable without modifying existing OpenAPI documents, typically via an [OpenAPI Overlay](https://spec.openapis.org/overlay/v1.0.0.html).

## Extensions

| Extension | Description | Spec |
|-----------|-------------|------|
| Pagination Schemes | Describes API pagination behaviour (`paginationSchemes`) so clients and tooling can navigate paginated responses without hand-written, API-specific logic. | [`spec/pagination-schemes`](spec/pagination-schemes/README.md) |
| CRUD Causality | Describes the create/read/update/delete effect of operations (`crudResources`, `x-crud`) — object URLs, server-added fields, collection membership, and cross-resource references — so tooling can derive an API's full state-transition behaviour, e.g. to drive a stateful mock server. | [`spec/crud-causality`](spec/crud-causality/README.md) |
| Authenticated Principal | Describes the current principal returned for an authenticated operation (`x-authenticated-principal`) — its identity authority, subject, lifecycle guarantees, and optional display claims — so consumers can discover a candidate identity key without guessing from profile data. | [`spec/authenticated-principal`](spec/authenticated-principal/README.md) |

## Proposals

- [Throttling](spec/throttling/README.md): announced request-count windows and shared partitions, without consumer scheduling policy (draft for issue #13).

- [Filtering and per-item Links](spec/filtering/README.md): API field predicates, authentication-dependent views, and minimal extensions to standard OpenAPI Links (draft for issue #17).
- [OAuth Authentication Scheme Details](spec/oauth-authentication-details/README.md): token-endpoint authentication capabilities, PKCE requirements, authorization-request parameters, and token-issuance semantics (draft for issues #14, #15, and #16).

## Adding a new extension

1. Create a new directory under `spec/` named after the extension (kebab-case).
2. Copy [`spec/TEMPLATE.md`](spec/TEMPLATE.md) to `spec/<extension-name>/README.md` and fill it in.
3. Add a row for it to the table above.
