# Asana and Airtable read-only overlays

These overlays describe provider behavior from the pinned OADs and official
provider references, checked 2026-10-08. They are metadata composition checks;
no provider account was connected.

## Asana

- OAD: `ontola/openapi-directory` commit
  `b58c91d9f59c6a10178916e7948793809edae46d`, `APIs/asana.com/1.0/openapi.yaml`.
- OAuth authorization code endpoints: `https://app.asana.com/-/oauth_authorize`
  and `https://app.asana.com/-/oauth_token`; Asana describes PKCE as supported
  conditionally, so the profile declares S256 support with optional PKCE.
- Selected GET operation/scope pairs: `/workspaces` and
  `/workspaces/{workspace_gid}` → `workspaces:read`;
  `/workspaces/{workspace_gid}/projects` and `/projects/{project_gid}` →
  `projects:read`; `/projects/{project_gid}/tasks` and `/tasks/{task_gid}` →
  `tasks:read`; `/users` and `/users/{user_gid}` → `users:read`.
- Read-only API scope limitations: task/project list and item reads are
  restricted to those operations; no write/delete operation receives this
  profile. Pagination uses the existing Asana cursor overlay, including its
  required `limit`, opaque `next_page.offset`, and response `data` envelope.
- References: [Asana OAuth](https://developers.asana.com/docs/oauth),
  [OAuth scopes and endpoints](https://developers.asana.com/docs/oauth-scopes),
  [Pagination](https://developers.asana.com/docs/pagination).

## Airtable

- OAD: `ontola/openapi-directory` commit
  `1f5368e0251bfbaa233860dc8131507c38a4f8b3`,
  `APIs/airtable.com/1.0-readonly/openapi.yaml`.
- OAuth authorization code endpoints:
  `https://airtable.com/oauth2/v1/authorize` and
  `https://airtable.com/oauth2/v1/token`. The official Airtable OAuth sample
  uses PKCE S256 and sends client credentials with HTTP Basic when a client
  secret is configured; it omits client authentication when the integration
  has no secret. The overlay declares those methods and requires PKCE.
- Selected GET operation/scope pairs: `/v0/meta/bases` and
  `/v0/meta/bases/{baseId}/tables` → `schema.bases:read`;
  `/v0/{baseId}/{tableIdOrName}` and its single-record path
  `/v0/{baseId}/{tableIdOrName}/{recordId}` → `data.records:read`.
- The bases list and records list copy the opaque `offset` to the same query
  parameter, preserve other query arguments and page their `bases` and `records`
  arrays. The record CRUD mapping uses the declared single-record GET and binds
  `recordId` from the record `id`.
- References: [Airtable OAuth reference](https://airtable.com/developers/web/api/oauth-reference),
  [Official OAuth example](https://github.com/Airtable/oauth-example),
  [Airtable Web API pagination and scopes](https://support.airtable.com/articles/6292134965-getting-started-with-airtable-s-web-api).
