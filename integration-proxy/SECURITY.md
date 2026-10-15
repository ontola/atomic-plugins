# Connection security

## Identity and request signatures (issue #54)

The proxy's account is an Atomic agent, `atomic:agent:<Ed25519 public key>`.
Ids are parsed by one function, accept the legacy `did:ad:agent:` prefix and
both base64 alphabets, and are canonicalized (`atomic:agent:` + unpadded
base64url) before any comparison or storage. Weak (small-order) keys are
refused and signatures are checked with `verify_strict`.

Connection administration uses Atomic v2 signatures. Reads additionally
accept opt-in, owner-approved device bearer sessions restricted to selected
connections and read scopes (DEVICE_AUTH.md). The signed message covers the method, the full URL (the configured
`BASE_URL` plus the path and query as received, never the `Host` header),
the timestamp and a SHA-256 of the body, under a fixed `atomic-request-v2`
prefix, so a captured request cannot be replayed with another body, method,
path or proxy. The proxy accepts v2 only and never falls back to Atomic's v1
message (`"{URL} {timestamp}"`), whose proofs are reusable for five minutes
and do not cover the body. Timestamps must be within ±5 minutes; a SHA-256 of
the canonical agent id and every accepted message is stored for ten minutes
and a second use is refused, including across instances (PostgreSQL
`used_challenges`). The record names the agent, so two agents that sign the
same request in the same millisecond do not collide, and one agent cannot
spend another's record in advance.

## Connections, delegations and runtimes

A connection row holds one provider credential sealed with
XChaCha20-Poly1305 under `ENCRYPTION_KEY`, with associated data binding the
envelope to its row id, so an envelope copied into another row does not
open. The row records its platform and owner. Only the owner (the agent that
signed `/connect/redeem`) may delete it or delegate it. Device sessions may
list only the connections the owner explicitly approved. A delegation
names an app agent; a runtime registered by the owner names a node's agent
that acts for a delegated app. Both are read on every proxied request, so
revocation is immediate. A connection unused for 90 days is deleted with its
delegations; only an authenticated request counts as use, so knowing a
connection id does not keep it alive. Connection ids are 256-bit random
values and are not secret: an unknown id answers `404 unknown_connection`
before any signature check.

Concurrent requests that find an OAuth token about to expire take a
per-connection refresh lease, so a rotating refresh token is spent once.

## Frame capabilities

A capability is signed by the connection owner over a fixed
`integration-proxy-capability-v2` prefix plus its JSON claims, so it cannot
be confused with a request signature. It is bound to the proxy (`aud`), a
connection and platform, an app agent that must hold a live delegation, and
a frame key (`cnf`); it lasts at most 15 minutes. The request that presents
it must be signed by `cnf`, so a leaked capability without the frame's
in-memory key is useless. What it does not prevent: while the frame is open,
plugin code can make requests of its own choosing within that scope and
lifetime. The v1 capability of draft PR #72 (a bearer token) is not accepted.

## Connecting a provider

`/connect` needs no login. Its consent screen names the platform and the
destination; approval requires a cookie-bound random CSRF token, is single
use, and checks `Origin` when present. Return addresses must be `https`,
loopback `http`, or the Atomic app's `atomic://` deep link, with no embedded
credentials, fragment, or pre-set `connection_code`/`error` parameters. The
provider callback is bound to the approving browser by a separate
`Secure`/`HttpOnly`/`SameSite=Lax` cookie and returns only a five-minute,
single-use handoff code bound to the hub's PKCE challenge, never a token.
`/connect/redeem` needs the PKCE verifier **and** a v2 signature; the signer
becomes the owner, so the page that started the flow must also hold the
user's key. A wrong verifier does not burn the handoff; concurrent second
redemptions fail. Responses are `no-store`.

The consent page's CSP allows form submissions only to the proxy itself (and,
for an API-key, http-token or no-credential platform, to the return address's origin,
where approval redirects), and one inline script identified by its SHA-256 hash; nothing
else runs. An OAuth approval answers with a page that continues to the
provider's authorization URL by `<meta>` refresh and button, sent with
`Referrer-Policy: no-referrer`, `no-store`, and a CSP with no script and
`frame-ancestors 'none'`; only an `http(s)` authorization URL is placed
there. The provider's own redirects after that are outside `form-action`, so
the proxy does not list, and cannot restrict, the origins a provider's
authorization passes through; the callback's state, browser binding and PKCE
checks are what bind the result. A spent consent leaves a
`platform_consent_used` cookie (encrypted, 10 minutes, holding only the
spent CSRF token) so that approving again says so; it grants nothing.

For an API-key platform the key is typed into the proxy's own consent page
and sealed like an OAuth token; it is never returned to the hub.

## HTTP bearer and basic tokens (Q-086, unreleased)

A `type: http` security scheme with `scheme: bearer` or `scheme: basic` is a
user credential of its own kind (README, "HTTP tokens"). Without an
authentication profile it is used only in a document that declares no
`oauth2` and no `apiKey` scheme, so every document that resolved to OAuth or
an API key before still does, and no `http` scheme is ever combined with
another credential. It reuses the API
key's controls: the token is typed into the proxy's consent page, never into
the hub or a plugin frame; the declared key check is called once before
anything is stored (`401`/`403` asks again without spending the consent,
anything else stores nothing); one consent page makes at most 5 key checks,
for API keys and tokens alike (the fifth rejection spends the consent; the
attempt records are single-use rows in `used_challenges`, so the cap holds
across instances and concurrent submissions). The cap bounds one consent
page, not a client: `GET /connect` needs no signature, so a script can open
new consent pages and make 5 checks with each; the per-network limit
(below, "Key checks per client network") bounds that. The
credential is sealed in the same
XChaCha20-Poly1305 envelope bound to its connection row, and no response
returns it. On a proxied request the proxy builds the `Authorization` header
itself (reqwest marks it sensitive), only for a catalog-allowlisted
operation (and, with a profile, only a covered one), and only while the
platform still resolves to an `http` scheme of the same kind and, for a
credential stored with a binding (every new API key, bearer token and Basic
credential), the same scheme name it was entered for, and the same declared
Basic layout or, for an API key, the same `in` and `name` (header names
compared case-insensitively); otherwise it answers
`401 credential_refresh_failed`. A catalog change that moves a platform to
another scheme, moves an API key to another header or query parameter, or
changes which half of a Basic credential is the token or a fixed half,
therefore does not send an old credential where it was not entered. Credentials stored before the binding
existed have none and are checked by kind only. The caller's `Authorization` is
never forwarded: anything but `Capability …` is refused with
`401 unsupported_authorization`, and a capability is consumed by the proxy.
Upstream cookies and credentials are not passed back. `StoredCredential`'s
`Debug` output names only the kind and platform; the crate's own logging
records neither, and `tower-http`'s `TraceLayer` is used with its default,
which does not record headers. A test, run alone in a child process,
records every `tracing` event at `TRACE` (the proxy's, `tower-http`'s and
`hyper-util`'s) during a Basic consent, key check, redeem and proxied
request, and finds neither half of the credential nor its base64 form;
`log`-crate records of dependencies are not part of that capture.

Risks that remain, and what the proxy does about them:

- **Account-wide tokens.** Personal access tokens are usually not scoped:
  one token can act as the person on their whole account, including
  operations the catalog does not list. The catalog allowlist (methods and
  paths, and a profile's coverage) limits what *this proxy* sends, not what
  the token could do elsewhere if it leaked from the proxy's database and
  `ENCRYPTION_KEY` together. The consent page says the token is stored
  encrypted on this proxy; it does not say how much the token can do,
  because the proxy cannot know. Revoking it is the person's job, at the
  provider; deleting the connection deletes the proxy's copy only.
- **No expiry or refresh.** Like an API key, a token stays usable until the
  provider revokes it or the connection is deleted (or idles out, by default after 90
  days without an authenticated request).
- **Basic with a password.** HTTP Basic sends a password-shaped secret on
  every request. If that is the person's real account password, the proxy
  holds a credential that can usually also log in, change the password and
  bypass the provider's second factor. The proxy therefore only offers a
  Basic scheme whose `x-api-key-details.basicCredentials` declares where
  the **API token** goes: as the username with a fixed password (for example
  `token:api_token` or `sk_…:`), or as the password with a fixed or typed
  username (an email address next to an API token). No layout asks the
  person for a password other than the token, and a Basic scheme without the
  declaration is not offered at all. This is a declaration by the overlay
  author, checked against the provider's documentation, not something the
  proxy can verify: an overlay that declared a provider's account password
  as `token` would make the consent page ask for it under the label "API
  token". Overlays are trusted as much as they already are to name the
  API's server. Prefer a bearer personal access token wherever the provider
  offers one.
- **Typed usernames.** A username typed next to the token (an email
  address) is sealed with the token; it is not treated as a secret on the
  page (a plain text field) and it is not returned.

## Key checks per client network (Q-097, unreleased)

A key check sends whatever was typed on the consent page to the provider
from the proxy's own address. The per-consent cap above does not stop a
script from opening consent pages (`GET /connect` needs no signature) and
using the proxy to test stolen or guessed API keys, tokens, or username and
token pairs, with the proxy's address, not the script's, in the provider's
logs and rate limits. So key checks (API keys and `http` bearer and basic
tokens alike) are also limited per client network and platform:

- **Limit.** At most `KEY_CHECK_LIMIT_PER_HOUR` (default 20; `0` turns it
  off; at most 10,000, larger values stop the proxy at startup, because each
  check may scan the network's slots) in any hour, as a sliding window: each check takes one of that many
  slots, a row `(bucket, slot)` in `key_check_limits` with the primary key on
  both, which frees one hour after it was taken. Only one request can take
  a slot, so the limit holds across instances and for concurrent requests;
  a burst of 30 concurrent submissions with a limit of 5 makes exactly 5
  checks (`connect::tests::postgres_key_checks_are_limited_per_network_and_platform`).
  Expired rows are deleted on the next key check.
- **Order.** The limit is taken only when a key check will reach the
  provider: the scheme declares `x-api-key-details.keyCheck`, and an API key
  is not a cookie (which is never checked). Connecting a platform without a
  key check uses no allowance. It is taken after the input is validated (a
  malformed key or token costs nothing) and before the consent's own key-check
  attempt and any upstream call. Over the limit the answer is `429` "Too
  many key checks from your network for <Platform>; try again later", with
  `Retry-After` (seconds until a slot frees) and `no-store`; nothing is
  sent to the provider, and the consent is neither spent nor charged an
  attempt, so the same page works once the network is under the limit
  again (within the consent's ten minutes). A slot is taken even when the
  consent then turns out to be spent or out of attempts; that costs the
  submitting network only.
- **What is stored and logged.** The bucket is a hex HMAC-SHA256 of the
  platform and the network under a subkey derived from `ENCRYPTION_KEY`
  (`HMAC-SHA256(ENCRYPTION_KEY, "integration-proxy-key-check-limit-v1")`, so
  the encryption key itself serves only XChaCha20-Poly1305). A row or log
  line does not reveal the address, and the IPv4 space cannot be hashed
  through to find one without the key; the platform is logged next to the
  bucket on purpose. The proxy logs "key check limit reached"
  with the bucket and the platform, never the address or anything typed.
  Rows live at most an hour (the window), plus until the next key check
  sweeps them.
- **Network.** An IPv4 address, or an IPv6 address's /64 (a subscriber
  usually gets a whole /64, so per-address counting would let one client
  rotate addresses); an IPv4-mapped IPv6 address counts as its IPv4 address.
- **Client address.** `TRUST_FORWARDED_FOR=none` (the default) counts the
  TCP peer address and ignores `X-Forwarded-For`. `heroku` (synonym
  `rightmost`) counts only the right-most `X-Forwarded-For` entry, the one
  Heroku's router appends to whatever the client sent; entries to its left
  are never read. The header line is split on bytes and only that last
  entry is decoded, so a non-UTF-8 byte the client sends earlier on the line
  does not make it unreadable. When that entry is missing or not an address
  (`ip`, `ip:port`, `[ipv6]`, `[ipv6]:port`; a bare zone index is not
  accepted, a bracketed numeric zone with a port counts as its /64), the check
  counts against one fixed shared bucket, `unparseable`: never the peer
  address (on Heroku, a router address many clients share) and never an
  entry further left. localthought.io runs on
  Heroku and must set `heroku`: there the peer is always the router, and
  without it every client shares one limit (the proxy warns at startup when
  Heroku's `DYNO` variable is set without it). A self-hosted proxy with
  nothing in front keeps `none`; behind exactly one reverse proxy that
  appends the client address (SELF_HOSTING.md), `rightmost`. Setting
  `heroku` or `rightmost` with nothing in front is a misconfiguration: a
  client then writes the right-most entry itself and chooses its bucket,
  so it can take a new one for every check, and it can also write a
  victim's address and use up that network's allowance, locking the
  people there out of key checks for that platform for an hour. If
  no address can be told at all (a wrapper that serves `build_app` without
  connect info, under `none`), every such check shares one bucket, `unknown`,
  and each one logs a warning: the limit then fails closed, for everyone.
- **Shared addresses.** Everyone behind one address (an office, a
  university, carrier-grade NAT on mobile networks, a VPN exit) shares one
  limit per platform, so a busy shared address, or one abuser behind it,
  can make honest people there wait up to an hour. 20 per hour is meant to
  make that unlikely: a person connecting a platform makes one to three key
  checks (a typo, a key copied from the wrong place), so 20 is several
  people's worth per platform per hour, while a script testing keys gets 20
  guesses per hour per address instead of 5 per consent page without end.
  Other platforms are not affected. An operator with many users behind one
  address can raise the limit; an attacker with many addresses (a botnet,
  many IPv6 /64s) is slowed, not stopped.
- **What it does not cover.** OAuth connections make no key check and are
  not limited; proxied requests (which need a signed agent) are not rate
  limited either.

A platform whose composed document declares top-level `security: []`, no
security scheme, and no operation that requires one (0.2.3 and later)
connects on consent alone: the connection seals only the platform name and
requests are forwarded with no credential. Everything else is unchanged: the
redeem and every proxied request are signed (or carry a frame capability),
the owner/delegation checks and the access policy apply, and only the
catalog's methods and paths under its server URL are forwarded, so such a
platform is not an open relay. A document that merely lacks security (for
example a base OAD whose auth overlay is missing) is refused as before. If
the catalog later gives the platform a scheme, existing connections answer
`401 credential_refresh_failed` until the person connects again.

A document that declares several kinds of security scheme (a bot token and
OAuth, say) is refused unless its trusted catalog entry selects an
authentication profile (`selection.authenticationProfile`; README,
"Authentication profiles"). The profile's one scheme is the only one the
connection holds, its OAuth scopes come only from the operations it covers,
and every other operation of the document is refused before anything is
sent upstream, so a person's OAuth token never reaches an operation that
accepts only a bot token. A request cannot choose or change the profile. An
OAuth connection whose platform no longer resolves to OAuth answers
`401 credential_refresh_failed`.

## Admission

An `AccessPolicy` is asked about the connection owner at redeem and on every
signed request (delegates and frames are judged as their owner). The default
allows everyone except `REVOKED_SUBJECTS`, optionally only `ALLOWED_AGENTS`.
The atomic.place account and tier lookup (ontola/atomic-saas#138) is not
implemented here.

## Not verified

- No real client has signed against this proxy yet; the wire format is
  aligned with the atomic-server v2 work in progress, not tested against it.
- WebCrypto Ed25519 in plugin frames was tested by hand in Chromium only
  (issue #54); Safari's engine and Firefox are unconfirmed.
- Other programs on the same machine can reach a loopback proxy; the
  signature requirement is the control, as decision 12 of #54 expects.
- The key-check limit's `heroku` mode follows Heroku's documentation (the
  router appends the connecting client's address to `X-Forwarded-For`); it
  was tested with constructed headers, not behind Heroku's router, and not
  with a request that carries several `X-Forwarded-For` lines through it.
  The Caddy and nginx behaviour SELF_HOSTING.md relies on for `rightmost`
  was likewise not tried.

## OAuth (#9)

The following are the requirements this deployment targets; see "Release
gate" below for what is still outstanding rather than already implemented.

Register a distinct redirect URI per provider and validate it exactly. The
OAuth state and PKCE verifier are single-use PostgreSQL rows; the callback is
bound to the approving browser by an encrypted, short-lived, `Secure`,
`HttpOnly`, `SameSite=Lax` cookie. Request narrowly scoped
tokens, never put access tokens, refresh tokens, or encrypted token bundles in
URLs, HTML, logs, referrers, or error messages.

An encrypted token bundle needs authenticated encryption (for example,
XChaCha20-Poly1305 or AES-256-GCM), a fresh random nonce for every encryption,
key versioning, and associated data binding it to the connection row. A server-secret HMAC is not encryption. Prefer an
opaque, short-lived reference with server-side storage if revocation and
replay prevention are required.

## Validating proxy (#10)

The proxy must select its upstream only from a server-owned catalog entry;
never accept an upstream URL or host from the client. Resolve and validate the
requested method, path, parameters, body, and content type against the
published OAD before contacting the provider. Reject unknown paths and methods,
strip client-supplied `Authorization`, `Host`, forwarding, and proxy headers,
and apply request size, timeout, redirect, and response-size limits.

Refresh tokens only at the provider token endpoint configured for that
platform. Store rotated tokens atomically before returning a replacement
credential. Do not forward the upstream's cookies or authorization headers.
Rate-limit per owner (not implemented: no limit on proxied requests per
owner exists yet), audit token use without logging secrets, and return
generic authentication errors.

A composed document with a `$ref` path item (or a path item that is not an
object) is refused when the catalog loads, so every check that reads a path
item in place (the allowlist, fixed headers, request validation, pacing, and
the scope and profile walk) sees the same operations, and a `$ref` cannot
add operations to the allowlist unnoticed.

Implemented today: the requested path is rejected if it contains a `.` or
`..` segment before catalog validation, so it cannot normalize to a
different path than the one authorized (see `proxy::contains_traversal_segment`).
Upstream requests use a bounded connect/read timeout and disable automatic
redirects, so a redirect cannot send a request to a destination the catalog
never validated. The upstream response body is read incrementally and capped
at 10 MiB instead of being buffered in full before the limit is checked.
Request validation against the OAD (`Catalog::validate_request`) is a bounded
subset: it checks that declared *required* query parameters are present,
that an enum-constrained query parameter's value is one of the declared
values, and that a request body's presence and content type match the
operation's declared `requestBody`. It does not validate full JSON Schema
for bodies or non-enum query parameter values.

Headers cross the proxy only by exact name (`proxy::upstream_request`,
`proxy::upstream_response_headers`); no prefix or pattern is matched, so a
provider's `Set-Cookie`, `WWW-Authenticate`, `X-OAuth-Scopes` or an
`x-ratelimit-*`-looking name outside the list never reaches the caller, and
the caller's `Cookie`, `Authorization`, `Host` and forwarding headers never
reach the provider. Both lists are single constants: the response list is
also exactly what CORS exposes (`proxy::forwarded_response_headers`), the
request list exactly what CORS allows besides `Authorization`,
`Idempotency-Key` and the signature headers (`proxy::CALLER_HEADERS`). Where
the catalog fixes a value for one of the caller's headers, the catalog's
value is sent and the caller's is dropped, so no header is sent twice.

Every response from `/proxy/…`, forwarded or refused, carries
`Cache-Control: no-store`, whatever the provider sent: a forwarded
`Last-Modified` would otherwise let a browser cache a proxied `GET`
heuristically.

- **Rate-limit response headers** (`X-RateLimit-Limit`, `-Remaining`,
  `-Used`, `-Reset`, `-Resource`, `RateLimit`, `RateLimit-Policy`,
  `RateLimit-Limit`, `-Remaining`, `-Reset`). They are numbers, times and
  bucket names describing the quota that the forwarded request itself was
  counted against. With a user credential that is the caller's own
  connection's quota, which the person could read by calling the provider
  with the same credential. They carry no credential, no account id and no
  other tenant's data. One exception is worth knowing: where the provider
  counts by source address (a no-credential connection, or a quota
  partitioned by `sourceIp` in Throttling), the address is the proxy's,
  shared by every tenant, and `remaining`/`used` then show how much all
  tenants together used in the window. That is an aggregate count with no
  identity attached, and a caller could already infer exhaustion from a
  forwarded `429` with `Retry-After`. Forwarding it lets a client pace
  itself instead of hammering the shared bucket (pieces.md P4 would pace it
  at the proxy).
- **`Last-Modified`** is representation metadata, like `ETag`.
- **`If-None-Match` and `If-Modified-Since`** only make the provider answer
  `304` with no body. The proxy keeps no response cache, so a conditional
  request cannot make one tenant's response serve another's.
- **`Idempotency-Key`** goes only to an operation whose composed document
  declares a header parameter of that name (on the operation or its path
  item, `$ref`s resolved), and never next to a fixed value the catalog sets.
  A fixed value is any header parameter with a `schema.default` or a
  one-value `schema.enum`, required or optional (`Catalog::required_headers`),
  and it replaces a caller's header of the same name.
  A provider scopes keys to the account that sends them. With a credential,
  that is the connection's own account, and the key goes unchanged. A
  no-credential connection sends no account, so every tenant would share one
  key space and tenant B, sending tenant A's key, could be answered with A's
  stored response. There the proxy sends
  `base64url(HMAC-SHA256(subkey, connection_id ‖ 0x00 ‖ key))` instead, under
  a subkey derived from `ENCRYPTION_KEY`
  (`HMAC-SHA256(ENCRYPTION_KEY, "integration-proxy-idempotency-key-v1")`):
  stable for one connection and key, so a retry still matches; different for
  every other connection; and not reversible to the caller's key. Rotating
  `ENCRYPTION_KEY` changes every namespaced key: a create retried across
  the rotation reaches the provider with a new key and may be applied twice.
- **Outside the signature.** The v2 request signature covers the method,
  the full URL, the timestamp and a hash of the body, not these request
  headers (nor `Content-Type` and `If-Match` before them). That is acceptable
  because (1) TLS keeps anyone on the path from changing them; (2) a signed
  request is accepted once, so a captured request cannot be resent with
  other headers; (3) only the signer's own environment could set different
  ones, and it can sign whatever it likes anyway; and (4) the most a changed
  value can do is turn a read into a `304`, a write into a `412`, or make a
  create match one of the same connection's earlier keys (on a no-credential
  connection the key is namespaced per connection, above). None of them
  widens what the catalog allows or which credential is sent.

## Pacing under provider quotas (P4, unreleased)

The proxy paces its own requests under `x-throttling` buckets partitioned by
`sourceIp` or by nothing (README, "Pacing under provider quotas"). Without
it, one tenant could spend a quota the provider counts on the proxy's
address and every other tenant of that platform would be refused by the
provider. What it changes for safety:

- **Only authenticated requests count.** The log is taken after
  authentication, delegation, the access policy and the catalog checks, so
  nobody without a connection can fill a bucket. A tenant with a connection
  still can, by sending up to the bucket's limit itself: the pacing keeps
  the proxy's traffic under the provider's limit; it is not fair between
  tenants, and nothing on this release bounds one tenant's share. (A
  per-owner limit on proxied requests is proposed separately, and would not
  bound this either: an owner is any agent key, and anyone can make more.)
- **No-credential platforms.** A platform whose document needs no
  credential (`security: []`) lets almost anyone create a connection: the
  consent page asks for nothing and the owner is whichever agent signs. So
  on such a platform anyone can spend its `sourceIp` bucket and keep other
  tenants' requests refused with `429 provider_quota` for as long as they
  keep sending. The only bound is the access policy: `ALLOWED_AGENTS` (an
  allowlist of owners) or a deployment's own `AccessPolicy`;
  `REVOKED_SUBJECTS` refuses known keys only, and anyone can make a new one.
- **Bounded memory.** One log per declared bucket, keyed by platform and
  bucket id from the server-owned catalog, never by anything a caller
  sends; each log holds at most `requests` timestamps, and buckets above
  10,000 are not paced.
- **Nothing is learned about other tenants** beyond what a provider's `429`
  already shows: a `provider_quota` refusal says the shared bucket is full
  and when it frees, not who filled it.
- **Fails open.** A malformed or unknown declaration paces nothing; the
  provider's own limit still applies.

## Key rotation (#410, unreleased)

`POST /agents/transfer` moves an owner's connections and runtimes to a new
agent id and retires the old one (README, routes).

- **Scope: planned rotation only.** The user holds both keys: the old one
  signs the request, the new one signs the proof. **A lost or compromised
  key is out of scope.** If the old key is lost, nothing can sign a
  transfer; if it is compromised, its holder can already use, delegate and
  delete its connections, and could transfer them first. In both cases:
  delete the connections (while the key still works) and connect again with
  the new key. Recovery without the old key is to go through the SaaS
  account (atomic-saas#138), not through this route.
- **Both keys agree.** The proof binds the old id, the new id, this proxy's
  origin and the outer request's timestamp. The outer request is v2 signed,
  accepted once and within five minutes, so a proof cannot be replayed,
  used at another proxy, or attached to another request.
- **Admission.** The old agent passes the access policy as any signer
  does, and so must the new one before anything moves.
- **All or nothing, and serialized.** One transaction retires the old id
  and moves its connections and runtimes; a collision (the new agent already
  has a runtime with the same agent) undoes all of it, the retirement
  included. The transaction holds a transaction-scoped advisory lock per
  owner (`hashtextextended(id, 0)`, both ids, in sorted order) and checks
  retirement under them. Every write that adds to what an owner holds
  (a connection at redeem, a runtime, a delegation, which is also bound to
  the connection's owner) takes the same lock and the same check. So two
  transfers sharing an id (A→B and B→C on two instances) run one after the
  other, and a write by the old key either lands before the move, and moves
  with it, or is refused as retired.
- **Afterwards.** The old id is refused as an owner everywhere: the access
  check every signed route makes about the connection owner (or the signer
  about to become one) refuses a retired id first (`403 agent_retired`).
  That covers management calls, `/connect/redeem`, transfers (from or to
  it), `/proxy` requests by any caller of a connection that still names it,
  and the webhook routes. Capabilities it signed fail at once for moved
  connections, because the owner key changed. Delegated app agents keep
  working: delegations name the connection and the app, not the owner.
- **Webhooks.** While the old agent has a webhook subscription that is not
  yet closed (live or in cleanup; subscriptions, receipts and usage are
  keyed by owner), the transfer is refused with `409 transfer_blocked`. The
  check runs inside the transfer's transaction, after it has taken the old
  owner's connection rows `FOR UPDATE`; a subscription takes its connection
  row `FOR SHARE` first, so it either committed before the check or finds
  the connection moved. The table is checked whenever it exists, so a
  deployment that turned `WEBHOOKS_ENABLED` off keeps its old subscriptions
  in mind.
- **Device sessions** (RFC 8628 CLI logins, DEVICE_AUTH.md) belong to the
  owner that approved them and do not move with a transfer. Every use of
  one asks the access check about that owner, so after the transfer they
  answer `403 agent_retired`; the user approves the CLI again with the new
  key. Neither key can revoke the old sessions (the owner-signed session
  routes refuse the retired id, and the new id does not own them), so they
  stay inert until they expire, at most 30 days after approval; the CLI that
  holds one can still end it with `/oauth/device/revoke`.
- **Stranded rows.** With the locks above, no connection should end up
  owned by a retired id. One that does anyway (written by an older binary
  during a rolling deploy, which knows nothing of `retired_agents`) is
  inert: every use is refused, so nothing refreshes its `last_used_at`, and
  it is deleted after 90 idle days like any other.
- **Audit.** The `retired_agents` row (old id, successor, time) and a log
  line with the counts moved, not the ids.

## Release gate

Provider callback URLs and credential variable names are now deterministic
from catalog platform names. Path-traversal rejection, upstream redirect
disabling, and the bounded OAD request validation above are implemented.
The remaining gate for #9 and #10 is provider registration, full JSON Schema
body validation, further SSRF hardening (e.g. blocking requests to internal
network ranges), rate limiting of proxied requests (key checks are limited
per client network, above), and an external review of the token envelope
format before live credentials are handled.

## Webhook inbox (#369, unreleased)

Off by default. With `WEBHOOKS_ENABLED` unset there are no inbox tables, no
sweeper and no webhook route. Enabled, the tables, the sweeper and the
routes exist (README, "Routes"); the receiver is described below. The inbox
follows `openapi-extensions/spec/webhook-subscriptions` and the storage rules
of `webhook-deliveries`, with the plan's pilot limits
(`src/webhooks/policy.rs`, checked against the spec's schema by a test).

What the store guarantees (`src/webhooks/store.rs`, PostgreSQL tests in
`src/webhooks/tests.rs`):

- **Bounded retention.** A subscription keeps at most 10,000 events,
  64 MiB, and 7 days of pending events. One owner keeps at most 256 MiB,
  50,000 references and 20 live subscriptions. The deployment keeps at most
  `WEBHOOK_INBOX_MAX_BYTES`, counted as payload bytes plus 512 bytes per
  payload row and 128 per reference. These row overheads are estimates
  until measured (plan, step 7). Every limit records a gap before history
  is lost: eviction drops the receiving subscription's own oldest events,
  never another owner's. A delivery routed to several subscriptions of one
  owner is counted against that owner once per subscription, each time
  before the next subscription is checked, so the owner's budget holds
  however many of its subscriptions one delivery reaches.
- **Abandonment ends retention.** A lease lasts 7 days from the last
  renewal. With events pending and no acknowledgement for 7 days, the
  subscription expires even while it is renewed. Both deadlines are
  enforced in the same transaction as any delivery, fetch,
  acknowledgement or renewal, and by the minute sweeper. So retention stops
  at the deadline even if the sweeper is down. A subscription past a
  deadline is expired by the first request or sweep that touches it
  (within a minute while the sweeper runs): that transaction releases its
  payloads and closes it. Its tombstone lasts at most 30 days, and at most
  10,000 tombstones exist.
- **Access.** A subscription is created only by the caller after a
  passing access check. Its connection must belong to the hook's platform
  and to the subscriber. No events are served while the last passing check
  is older than 12 hours. A failed check closes the subscription.
  Deliveries are routed only to subscriptions whose connection still
  exists. Deleting the connection stops reads at once; the sweeper releases
  the rest.
- **Receipts.** Receipts are kept per owner, and only for deliveries routed
  to that owner. Caps: 20,000 per owner, 200,000 in all. A receipt younger
  than 1,800 seconds is never evicted. At a cap with nothing evictable, the
  delivery is stored for no subscription of that owner, a `receipt-limit`
  gap is recorded, and the delivery still counts as accepted, so other
  owners are unaffected.
- **Durable before acknowledged.** Ingest is one transaction. Only its
  `Ok` may become a 2xx. A failure, including a lost database connection,
  rolls everything back, receipt included, so the provider's retry is
  accepted as new.
- **Cursors** carry an HMAC under a subkey of `ENCRYPTION_KEY`
  (`integration-proxy-webhook-cursor-v1`). A cursor that was edited, came
  from another subscription, was never returned, or belongs to an obsolete
  generation is refused.
- **Dedicated hooks.** The record (endpoint, sealed secret, bound key,
  access parameters) is stored before the provider is asked, and a
  subscription must be for the hook's own source. Management stays with
  its connection while that connection has a live subscription on the
  hook, and otherwise moves to the connection of another live
  subscription, never to a deleted connection. A hook nothing uses any
  more gets a cleanup job, also while still provisioning (the provider may
  have created it; the job lists, then deletes), and so does one with no
  live subscription an hour after it was created. A provider answer that
  arrives after cleanup started is recorded for it, and one that arrives
  after cleanup gave up (while the closed record still exists) starts a
  new cleanup. Not covered: an answer that arrives after the closed record
  was purged by the sweeper (30 days after closing at the earliest) finds
  no record and is refused; that hook is left at the provider for the
  person or operator to remove. Cleanup: backoff up to a day, a 30-day
  deadline, then a visible failure. New dedicated hooks are refused while
  the owner holds 20, or the deployment 10,000, that are not closed. Each
  such hook has at most one cleanup job, so these bound the jobs too,
  except in two cases: when management of a hook moves to another owner,
  that owner can hold more than 20; and a late provider answer reopens a
  cleanup job for a hook that no longer counted. Both are rare, and each
  adds one job per such hook. One owner's failing cleanups never block
  another's new hooks. Shared application hooks are never changed.

Concurrency: every write takes row locks in one order: subscription rows
by id, owner rows by owner, the deployment row, then (as needed) receipt
rows, one hook row and payload rows. A write that takes no subscription or
owner lock starts at the deployment row. All writes pass the deployment
row, so they are serialized after their subscription locks; that is the
pilot's throughput bound. The sweeper deletes owner rows one at a time.
The inbox uses up to four connections of its own, because the shared
client cannot run transactions; each has a 10-second `lock_timeout` and a
30-second `statement_timeout`, so nothing waits without bound. A sweep
runs every step even when one fails (receipts first), and records its time
only when all succeeded; until a first sweep, the store's start time
stands in, so a sweeper that never runs also stops new subscriptions.

Not yet verified: physical bytes per row, sweep lag under load, and
behaviour with several proxy instances beyond what row locks guarantee
(tested with concurrent tasks against one database).

### Receiver and consumer routes (#369 step 3)

`src/webhooks/{ingress,verify,metadata,provider,routes}.rs`; tests in
`src/webhooks/route_tests.rs` against PostgreSQL and a stand-in provider,
including the spec's synthetic GitHub fixtures replayed through the same
generic code.

- **Generic.** A platform takes part only through its composed document's
  `x-webhook-deliveries`; nothing names a provider. What a document cannot
  express in Webhook Deliveries 0.1.0-draft (other algorithms, handshakes,
  non-JSON bodies) is refused.
- **Bounded before authentication.** Before any body byte is read, the
  endpoint id must have its 43-character shape, a declared
  `Content-Length` over the verification cap (25 MiB) is refused (`413`),
  and the endpoint's hook is looked up, at most one lookup at a time, apart
  from the deliveries' own database slots, so a flood of unknown ids cannot
  starve verified deliveries. Then the body is read, at most the cap,
  within 10 seconds (`408`; a broken upload is `400`), by at most 8
  requests at once and 4 per endpoint (so at most 8 x 25 MiB is held, and
  one endpoint cannot hold every slot); at most 2 deliveries use the
  database at once, so consumer routes and the sweeper always find one of
  the inbox's four connections. Every wait is bounded: a slot or pooled
  connection not free within a few seconds is a `503`.
- **Verification before parsing.** The endpoint's profile and secret are
  looked up, the HMAC-SHA256 over the exact bytes is compared in constant
  time (`Mac::verify_slice`), and only then is anything in the body or the
  delivery headers read. Refused deliveries are logged at most once per
  ten seconds, with a count. A missing, repeated or malformed signature, a
  timestamp outside its tolerance, and a missing secret are all `401`, and
  write nothing. A body nested deeper than 64 levels is not parsed.
- **Routing.** A delivery reaches a subscription only through a binding
  that an access check with that subscriber's own connection established:
  the key comes from the provider's answer, never from the subscriber or
  the delivery. Access parameters are percent-encoded as one path segment
  each, and `.`, `..` and missing parameters are refused. The check is sent
  like a proxied request (catalog allowlist, credential binding, no
  redirects, no caller headers), and a 401 forces one token refresh before
  it counts. After a refresh that succeeded, the next minute's 401s on that
  connection refresh nothing: they use the stored token if another call
  replaced it meanwhile, and are otherwise unknown (never a failed check),
  so concurrent checks on one connection spend one refresh token. A failed
  refresh does not start that minute. A refresh the token endpoint refuses
  with `invalid_grant` (in a `400` or `401`), on a 401 or because the token
  expired, is a failed check, and so is a credential with no refresh token.
  Anything else is unknown, never a failed check: another token error such
  as `invalid_client` (the proxy's own configuration), a refresh that cannot
  complete, a connection that cannot be loaded from the database, or a 2xx
  answer that is not JSON. A revocation delivery suspends the bindings it names until
  the next check: a failure closes them, a pass resumes with an
  `access-suspended` gap.
- **Consumers.** Every route is signed by the subscription's consumer, and
  that consumer's standing on the connection is checked on every request,
  also for a closed subscription, so a former consumer reads nothing. A
  removed delegation closes the subscription on its next request. Deleting
  a connection locks its row first, then ends its subscriptions and starts
  hook cleanup in the same transaction; creating a subscription takes the
  same row (shared) first, so one created during a deletion never outlives
  it. Long polls are woken only by their own subscription's deliveries,
  and at most 4 per consumer and 256 in all wait at once; past that a poll
  is answered `429` with `Retry-After`. A poll whose client goes away
  leaves nothing registered. No events are served on an access check older than
  12 hours: the receiver runs the check itself first.
- **No provider writes.** Subscriptions use the platform's shared
  application hook only. Dedicated hooks are not created by this release,
  so their deletion (a provider write) can only concern hooks a later
  release creates. That deletion re-runs the managing connection's access
  check with the hook's recorded parameters and requires the bound key
  before any `list` or `delete`. Not handled yet: when the managing
  connection is deleted and no other subscription's connection takes
  over, the cleanup fails visibly (no credential is kept for it); a later
  release creating dedicated hooks has to decide whether to keep narrow
  cleanup material.

- **Rate limits.** On `POST /webhooks/…` the limits count refusals only.
  Anyone can point a provider's hooks at junk URLs, or send junk to a real
  endpoint, so the provider's own delivery addresses collect refusals too;
  a limit that refused them would drop real deliveries, which GitHub does
  not retry. A client network (120 a minute) counts the refusals it caused
  (unknown or malformed ids, failed verification, oversized bodies; not
  `400` or `408`, which a provider's own broken or slow upload causes).
  Once over, its requests for ids that are malformed or name no endpoint
  get `429` after the lookup, and it is held to a short queue for the
  lookup itself (below). An endpoint (600 a minute) counts its failed verifications,
  and once over answers further ones `429` instead of `401`; random ids
  never take an endpoint's key. Neither saves the verification work: the
  ingress gate's lookup, read and database slots bound that. Subscription
  requests are limited per owner (20 an hour) before their access check
  reaches the provider; every request counts, a client's retry of the same
  subscription included. Over a limit: `429` with `Retry-After`, nothing
  written. The windows are fixed, in memory and per instance; at most
  10,000 keys are held per limit, and while all of them are live a new key
  passes uncounted (a shared overflow window would let whoever fills the
  map block every other key). Values come from
  `WEBHOOK_INGRESS_LIMIT_PER_NETWORK`, `WEBHOOK_INGRESS_LIMIT_PER_ENDPOINT`
  and `WEBHOOK_SUBSCRIBE_LIMIT_PER_OWNER`, read only with the inbox on.
  Behind a proxy such as Heroku's router, `TRUST_FORWARDED_FOR` must be
  set (`heroku`), or every sender is one network: the router's.
  There is one endpoint-lookup slot. Requests from networks over their
  limit may wait for or hold it, but at most 2 of them at a time across all
  such networks; while 2 do, any further request from a network over its
  limit gets `429` at once. The slot's semaphore is fair, so a released
  slot goes to the requests already waiting in order, and those 2 cannot
  jump ahead of other networks' requests. What holds: a flood from
  networks over their limit cannot hold up deliveries from other networks,
  and a real delivery from a network over its limit still gets through
  whenever fewer than 2 of its kind are waiting for or holding the slot. What remains:
  - A provider whose delivery addresses also carry junk (anyone can point
    the provider's hooks at junk ids, so its network goes over the limit)
    has its real deliveries compete for those 2 places with the junk. Under
    a sustained flood through the provider's own addresses, a real delivery
    can find both taken and get `429`, which GitHub does not retry; the
    periodic full reads are the fallback.
  - Many networks that each stay under the limit (120 refusals a minute
    each, for example a client rotating IPv6 /64s) can still keep the slot
    busy, and a delivery that waits 3 s for it gets `503`, which GitHub
    does not retry either.

Not yet verified: any real provider's deliveries (only the synthetic
fixtures), and how the limits behave across several instances (each counts
its own).

## Local Thought device client sessions

See [DEVICE_AUTH.md](DEVICE_AUTH.md) for the complete #565 contract and limits.
The opt-in RFC 8628 path authenticates the approving Atomic owner with signed,
replay-protected challenge and approval requests; a user code or submitted owner
ID is not authentication. CLI bearer tokens resolve to that same canonical
owner with an explicit connection/read scope. They never confer owner
administration. Connections, AccessPolicy and catalog permissions are checked
live on each request. Device/approval/token secrets are stored as hashes in
PostgreSQL; grants are single-use and refresh families rotate under row locks.
Refresh-token reuse revokes the family across instances. The local owner bridge
is a dogfooding example, not a production login. Device routes omit query strings
from tracing, and consume bearer headers before the provider request is built.
No provider credential is returned by device/token/connection-discovery routes.
