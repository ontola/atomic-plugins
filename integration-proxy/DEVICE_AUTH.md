# Device authentication for CLI clients

Issue [#565](https://github.com/ontola/atomic-plugins/issues/565) adds a Local
Thought OAuth authorization server for public CLI clients. This authorizes the
CLI to use an existing Atomic owner's selected provider connections. Provider
OAuth and credentials remain at the proxy. The CLI needs outbound HTTPS, no
callback listener, no client secret, and no Atomic signing key.

This document describes the implementation in this branch. It does not claim
a crates.io release, a localthought.io deployment, an integrated production
owner hub, or verified live GitHub access. The separate Syncables scaffold is
[#567](https://github.com/ontola/atomic-plugins/pull/567), for #566.

## Operator configuration and public clients

Device authentication is disabled by default. Register public client IDs and
fixed display names with `DEVICE_CLIENTS`, a JSON object, and configure an
owner approval hub with `DEVICE_APPROVAL_URL`:

```sh
export DEVICE_CLIENTS='{"syncables-cli":"Syncables CLI"}'
export DEVICE_APPROVAL_URL='https://owner-hub.example/device-approval'
```

`syncables-cli` is the documented pilot ID, enabled only when registered by the
operator. There is no dynamic registration. Configuration admits at most 20
clients; IDs contain 1–80 ASCII letters, digits, `_` or `-`; display names have
1–100 characters without control characters. Removing a client from
configuration prevents its outstanding grants, refreshes and access tokens
from being used on that instance. Use the same configuration and `BASE_URL`
on every proxy instance. `DEVICE_APPROVAL_URL` must be HTTPS, without userinfo,
query or fragment; loopback HTTP is allowed for local development.

Configuration is also available as the public `Config::device: DeviceConfig`.
The proxy validates it when building the app. This adds a public `Config`
field and therefore belongs in the next 0.4.0 release, alongside `webhooks`.
Device/session tables are initialized with the existing security schema; API
routes refuse device authentication when no client is registered.

## Discovery and CLI contract

`GET {BASE_URL}/.well-known/oauth-authorization-server` returns RFC 8414
metadata. `issuer` is the canonical `BASE_URL`, including any configured path
prefix. Every endpoint below is relative to that issuer. Access tokens are
opaque; their audience is this exact issuer, not a provider API. API tokens
are accepted only in `Authorization: Bearer <access_token>`, never in a cookie,
query parameter, or request body. Retired bearer connection codes remain
unsupported. No JWT introspection or ID token is supplied.

The machine-readable fixture is [device-contract.json](tests/fixtures/device-contract.json).
It contains schema/contract information, not reusable device or token secrets.
The companion mock's proposed discovery + form POST + bearer GET protocol is
compatible with these routes. Use `--client-id syncables-cli --scope
'connections:read proxy:read'` once this service is actually deployed with
that client registered. The mock's approval is not owner authentication.

| Route | Authentication and behavior |
| --- | --- |
| `GET /.well-known/oauth-authorization-server` | Public discovery when enabled. |
| `POST /oauth/device/code` | Form `client_id`, optional `scope`; public client. |
| `POST /oauth/device/token` | Form `client_id`, `grant_type`, `device_code` or `refresh_token`. |
| `POST /oauth/device/revoke` | Form `client_id`, `token`; possession of access or refresh token. |
| `GET /device?user_code=…` | Public instructions/link to configured owner hub; this page never authenticates an owner. |
| `POST /device/challenge` | Atomic v2 owner signature over JSON `{"user_code": "…"}`. |
| `POST /device/approve` | Atomic v2 owner signature over JSON `{"challenge":"…","approve":true,"connections":["…"]}`. |
| `GET /device/sessions` | Atomic v2 owner signature; lists only that owner's client sessions. |
| `DELETE /device/sessions/{session_id}` | Atomic v2 owner signature; revokes that individual session. |
| `GET /connections` | Device bearer: filtered connection discovery, or existing Atomic owner signature. |
| `GET /proxy/{connection_id}/{platform}/{path}` | Device bearer: approved read, or existing signature/capability authentication. |

Token/form responses use `Cache-Control: no-store` and `Pragma: no-cache`.
Device JSON/form request bodies are limited to 8 KiB. Duplicate form fields
are invalid. The token endpoint rejects `client_secret`; public clients must
use `token_endpoint_auth_methods_supported: ["none"]`.

### Requested permissions

- `connections:read`: discover only the connections explicitly selected by
  the approving owner. The response includes canonical `owner`, `client_id`,
  non-secret `session_id`, and `connections` with `connection_id`, `platform`,
  `owner` and optional `label`. It includes no credentials, delegations or
  runtimes. A new connection is never implicitly included.
- `proxy:read`: GET and HEAD through those connections, subject to the
  existing live connection ownership/idle expiry, owner `AccessPolicy`,
  provider credential binding, catalog operation/security restrictions,
  validation and pacing. HEAD must itself be allowed by the catalog.
- `proxy:write` is reserved for future upstream writes. It is not issued in
  this pilot: requesting it (or administrative scopes) returns `invalid_scope`.

Default scope is `connections:read proxy:read`. Approval selects 1–20
connections currently owned by the authenticated owner. This pilot does not
issue device grants for connections merely delegated to an app. Connections
retain their existing canonical Atomic owner identity. A device client is a
restricted session of that owner, not a new owner/account/cache namespace.
The bearer path does not grant connection deletion, delegation/runtime
changes, webhook administration or provider connect/redeem authority.

### Device grant and polling

`POST /oauth/device/code` returns `device_code`, `user_code`,
`verification_uri`, `verification_uri_complete`, `expires_in: 600`, and
`interval: 5`. The user code is ten characters from an unambiguous 32-symbol
alphabet, displayed with a hyphen (50 bits of entropy). Hyphens and case are
normalized for lookup. The CLI prints the verification URI/code, but must
never print the device code or bearer/refresh secrets.

Poll after waiting at least the interval. Form fields:

```text
client_id=syncables-cli
grant_type=urn:ietf:params:oauth:grant-type:device_code
device_code=<in-memory device code>
```

Errors are JSON `{"error":"<code>"}`. OAuth failures use HTTP 400:
`authorization_pending`, `slow_down`, `access_denied`, `expired_token`,
`invalid_grant`, `invalid_client`, `invalid_scope`, `invalid_request`, or
`unsupported_grant_type`. Each too-early poll returns `slow_down` and increases
the persisted interval by five seconds; wait the increased interval before
every subsequent poll. Denial/expiry end polling. Missing, wrong-client,
wrong-audience or already-redeemed grants return `invalid_grant`. Expired
grant hashes are retained for one hour so concurrent cleanup does not turn
an immediately expired grant into an unknown grant; after cleanup the error
is `invalid_grant`.

A successful poll returns `access_token`, `token_type: "Bearer"`,
`expires_in: 600`, `refresh_token`, granted `scope`, canonical `owner`,
`client_id`, and `session_id`. Grant redemption and session creation are one
transaction: only one poll can redeem it, even across instances.

### Refresh, logout and revocation

Access tokens last ten minutes. The session/refresh family has a fixed maximum
lifetime of 30 days from approval redemption; refresh does not extend it.
Refresh with form `client_id`, `grant_type=refresh_token`, `refresh_token`.
Scope changes during refresh are refused. A refresh consumes the old token,
issues a new access/refresh pair for the same owner, client, connections and
scope, and invalidates every previous access token in that family.

Reuse of any consumed refresh token immediately revokes the entire family.
For simultaneous refreshes with the same token, exactly one may return a
pair; the second returns `invalid_grant` and revokes the family, including
that new pair. Clients must serialize refresh and must not retry a refresh
whose result was lost: start a new login. A family is also revoked after
5,000 rotations, bounding retained reuse-detection records.

Logout posts the current access token or any family refresh token to
`/oauth/device/revoke`. Revocation is idempotent and returns HTTP 200 even
for an unknown token or a token registered to another client. It ends the
entire individual session immediately on all instances. An owner can list
and revoke sessions using the signed routes above. A rotated/expired access
token that has already been removed is unknown; use a refresh token to revoke.

Resource errors retain the proxy's JSON `{"error", "message"}` shape:
HTTP 401 `invalid_token` (expired, revoked, wrong audience, or removed client),
HTTP 403 `insufficient_scope` (unapproved connection, method or discovery),
HTTP 403 `access_denied` (owner policy), and existing catalog/proxy errors.
Bearer errors include `WWW-Authenticate`. Connection deletion or idle expiry
removes it from discovery and prevents subsequent proxy use, even while a
session token remains otherwise live. Requests already authorized/in flight
are not cancelled by revocation.

## Concrete browser owner integration

There is no existing Local Thought owner login to reuse. The owner hub must
supply its existing Atomic v2 signer. Mount
[static/device-approval.mjs](static/device-approval.mjs) in that trusted hub:

```js
import { mountDeviceApproval } from './device-approval.mjs';
mountDeviceApproval({
  root: document.getElementById('approval'),
  proxyUrl: 'https://localthought.io', // trusted configuration, not URL input
  userCode: new URL(location.href).searchParams.get('user_code') || '',
  signRequest: async ({ method, url, body }) => {
    // Return x-atomic-* headers, signed by this hub's existing owner agent.
    // Use the existing Atomic v2 message and hash the exact UTF-8 body.
    return existingOwnerSigner(method, url, body);
  },
});
```

On an explicit Review click, the module sends the signed challenge request.
The proxy verifies the signature and replay record and checks that owner's
policy before looking up the user code. The response includes a two-minute
challenge, fixed client name, requested scope, canonical owner and current
owned connection choices. The module shows those details, requires explicit
connection selections (none preselected), and offers Approve and Deny. Each
decision is another signed request binding the challenge, decision and exact
selection. Approval challenges are single-use, bound to the authenticated
signer and grant, checked against the database clock, and consumed together
with the pending grant under a row lock. A user code, submitted owner ID,
CORS origin or CLI client ID is never owner authentication.

Production owner-hub wiring is a deployment prerequisite, not supplied by an
AtomicServer pin bump in this PR. The local bridge below provides a concrete
browser path for first dogfooding without assuming a Local Thought login.
It uses the existing owner's key on the owner's machine, not in the CLI or
proxy. Only use a trusted operator/hub/module. Deployments should also avoid
logging request bodies, authorization headers and verification-page query
strings; the proxy's tracing spans record method/path without query strings.

## Runnable dogfooding

Requires Node 22+, an isolated PostgreSQL, a proxy configured with the existing
catalog/provider credentials, and an existing provider connection owned by
the Atomic key used by the local bridge. Keep the real owner seed outside the
repository and command history. Run these on the owner's machine; a remote
CLI can use the same HTTPS issuer separately.

1. Run the proxy from this checkout with its usual `DATABASE_URL`,
   `ENCRYPTION_KEY`, catalog and provider configuration, plus:

   ```sh
   export BASE_URL=http://127.0.0.1:11874 PORT=11874
   export DEVICE_CLIENTS='{"syncables-cli":"Syncables CLI"}'
   export DEVICE_APPROVAL_URL=http://127.0.0.1:11873
   cargo run --manifest-path integration-proxy/Cargo.toml
   ```

2. Run the local owner bridge in another terminal. It signs only the two
   approval endpoints, binds loopback, checks Host/Origin and a random CSRF
   token, and never prints/sends the owner private key:

   ```sh
   read -r -s -p 'Existing owner Ed25519 seed (base64url): ' ATOMIC_OWNER_SEED
   export ATOMIC_OWNER_SEED
   export DEVICE_PROXY_URL=http://127.0.0.1:11874
   node integration-proxy/examples/device-login/owner-bridge.mjs
   unset ATOMIC_OWNER_SEED
   ```

   The printed public owner must match the existing connection's owner.
   Do not generate a replacement owner for an existing connection. This is
   a local test bridge, not a production account/login service.

3. Run the outbound-only CLI example in a third terminal:

   ```sh
   DEVICE_PROXY_URL=http://127.0.0.1:11874 \
   DEVICE_PROBE_PATH='/repos/example/tasks/issues?per_page=1' \
   node integration-proxy/examples/device-login/login.mjs
   ```

   Open the printed verification URL, continue to owner approval, review the
   fixed client name and permissions, select a connection, and approve.
   The example lists approved connections, reports the optional provider GET
   status without printing its body or credentials, and revokes its session.
   Set `DEVICE_CONNECTION_ID` when several connections were selected. Replace
   the example provider path with one the selected catalog permits. Neither
   a mock success nor a local fixture is live GitHub evidence.

## Bounds and verification

All limits are enforced with PostgreSQL state across instances. Existing
trusted-client-address configuration (`TRUST_FORWARDED_FOR`) applies. Wrappers
should supply `ConnectInfo<SocketAddr>`; otherwise clients share the unknown
network bucket. Failed attempts count, too.

| Limit | Value |
| --- | --- |
| Device requests per client network | 20/minute |
| Poll/refresh token requests per client network | 120/minute |
| Revocation requests per client network | 60/minute |
| Challenge requests per client network | 30/minute |
| Challenges/decisions per authenticated owner | 20/minute |
| Simultaneous unexpired challenges on a grant | 20; a fresh challenge replaces that owner's previous one |
| Retained device grants | 10,000 total, including expiry tombstones |
| Retained sessions | 100,000 total; at most 20 unrevoked sessions per owner |
| Refresh hashes per session | 5,000 maximum |
| Connection selections | 1–20 |
| Device transaction pool | 4 connections per instance; 5s acquire/connect, 10s lock, 30s statement timeout |

Expired rows are cleaned on grant/session allocation. Hashes of device/user
codes, approval challenges and access/refresh tokens are persisted; bearer
secrets are never stored in plaintext. Provider credentials retain the
existing encrypted storage. No proxy-side request/response archive is added.
Existing provider-header allowlisting consumes the Local Thought token and
injects only the connection's provider credential upstream.

```sh
cargo fmt --manifest-path integration-proxy/Cargo.toml --all -- --check
cargo clippy --manifest-path integration-proxy/Cargo.toml --all-targets --all-features -- -D warnings
TEST_DATABASE_URL='postgres://postgres@127.0.0.1:15439/connect_test?sslmode=disable' \
  cargo test --manifest-path integration-proxy/Cargo.toml device:: -- --include-ignored
```

CI runs the complete suite including the existing signed/capability tests and
the PostgreSQL device tests. The latter exercise separate security stores to
prove single approval/redemption, refresh reuse and immediate revocation
across instances, plus owner signature/selection checks, denial, expiry,
polling intervals, rate limits, scoped discovery and provider token isolation.

To include the headless browser dogfooding check, install Playwright in a local
test harness and its Chromium browser, then set `DEVICE_BROWSER_TEST=1`,
`DEVICE_PLAYWRIGHT_MODULE` to that package's absolute `index.mjs` path and, when
needed, `PLAYWRIGHT_BROWSERS_PATH` before the same `cargo test device::` command.
This test starts the actual loopback proxy, an invented provider and the owner
bridge, and approves through Chromium before probing and revoking the session.
