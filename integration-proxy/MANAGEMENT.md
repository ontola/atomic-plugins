# Reusable grant management and notification-only IAP

The management page at `GET /manage` is a credential-free view. It works with
any client that supplies the documented message transport, not only SyncD.
It does not authenticate an owner by itself. Existing signed Atomic owner
management APIs continue to work.

## Explicit device permissions

These are additional opt-in permissions. Default device logins remain
`connections:read proxy:read`; refreshing cannot add permissions.

| Scope | Authority |
| --- | --- |
| `connections:manage` | List delegations, delegate/undelegate apps, and delete only explicitly selected connections. Does not authorize provider requests, connecting/redeeming new accounts, runtimes or owner transfer. |
| `sessions:manage` | List and revoke the authenticated owner's IAP device sessions, including other clients' sessions. No other owner's session is accessible. |
| `notifications:consume` | Subscribe, receive, acknowledge, renew and reconcile notifications on selected connections, only on a notification-only receiver. Does not grant provider data requests. |

The approval screen names each authority. Client session management is
account-wide; connection and notification authority is connection-scoped.
Deleting a connection stops all its delegated apps. Removing a delegation is
effective on the next request. Revoking a session stops its access/refresh
family. Provider refresh tokens are never returned to a client.

`GET /connections` with connection-management permission returns selected
connection metadata and delegations, no credentials. Without that permission,
it retains the restricted discovery shape. `GET /device/sessions` and
`DELETE /device/sessions/{id}` accept `sessions:manage` or an existing owner
signature. Connection deletion and delegation routes accept
`connections:manage` or an owner signature. CORS permits the authorization
headers; every operation still checks tokens, selection, ownership and access
policy. Insufficient device management authority returns 403.

## Embedding

Use an iframe with a distinct IAP origin:

```html
<iframe src="https://integrations.atomic.place/manage?parent_origin=https%3A%2F%2Fclient.example"
  sandbox="allow-scripts allow-same-origin allow-modals"
  referrerpolicy="no-referrer" title="IAP access management"></iframe>
```

The page posts messages to the exact configured parent origin:

```js
{ channel: 'iap-management-v1', id: '1', request: { action: 'overview' } }
```

The parent MUST verify both `event.origin` and
`event.source === iframe.contentWindow`, validate the request, and execute only
fixed allowed management operations using its own authenticated transport.
Never accept arbitrary URLs, methods, bodies to sign, or code to execute.
Return the result only to that exact frame and IAP origin:

```js
{ channel: 'iap-management-v1', id: '1', ok: true, result: overview }
```

Errors use `ok: false`, without provider errors or secrets. `overview` contains
`connections`, `sessions`, `sessionId`, `canManageConnections` and
`canManageSessions`. Actions are `overview`, `disconnect` (`connection`),
`delegate`/`revoke-delegation` (`connection`, `agent`) and `revoke-session`
(`session`). The page also sends optional `event: 'resize', height` messages;
validate/clamp the number. Never send tokens or private keys to the frame.
`syncables/src/daemon/management.ts` implements the fixed API mapping.

The same rendering module is exported as
`mountManagement({ root, request })` from `/management.mjs` for a trusted host
that prefers mounting the view directly. Embedding isolates IAP's code from
client data and is SyncD's default. Provider OAuth remains a top-level flow.

## Notification-only storage

Set both `WEBHOOKS_ENABLED=true` and `WEBHOOK_NOTIFICATIONS_ONLY=true` on a
fresh inbox database. The verified provider body is used transiently for
signature verification and declared routing, then discarded before `ingest`.
Only catalog-derived routing context, event/action, source identifiers,
delivery identifiers, receipt times and a fixed `{"notification":true}` body
are retained. The mode is bound to the database at startup: changing it is
refused. Existing raw-payload inboxes cannot be silently relabeled; use a new
inbox database and resubscribe/reconcile. Do not mix old binaries that ignore
this policy with notification-only deployments.

The current payload wire format remains compatible: its fixed JSON body is a
hint to fetch current data, not a provider record. Consumer device grants are
refused on receivers that retain provider payloads. Selection, current owner
access, subscription standing and periodic provider access checks still apply.
The SyncD consumer stores work durably before acknowledging, renews leases and
performs a full read after any gap. Provider read authority is separate.

This source change does not publish a crate or deploy IAP. Before a public
rollout, publish a reviewed proxy release, bump the SaaS wrapper's manifest
and lockfile, configure a trusted owner approval hub and public client IDs,
configure hooks/secrets and notification-only storage, then test locally and
through the deployed origin. The existing SaaS tester-only gate remains.
