# Connection security

## Identity and request signatures (issue #54)

The proxy's account is an Atomic agent, `atomic:agent:<Ed25519 public key>`.
Ids are parsed by one function, accept the legacy `did:ad:agent:` prefix and
both base64 alphabets, and are canonicalized (`atomic:agent:` + unpadded
base64url) before any comparison or storage. Weak (small-order) keys are
refused and signatures are checked with `verify_strict`.

Every request that reads or changes a connection is signed with Atomic's v2
headers. The message covers the method, the full URL (the configured
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
signed `/connect/redeem`) may delete it, delegate it, or list it. A delegation
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
Rate-limit per owner, audit token use without logging secrets, and return
generic authentication errors.

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
sweeper and no route. Enabled, this release only creates the tables and runs
the sweeper: no webhook route is mounted, so nothing can reach the inbox
from outside. Step 3 adds the receiver and the consumer routes. The inbox
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
  never another owner's.
- **Abandonment ends retention.** A lease lasts 7 days from the last
  renewal. With events pending and no acknowledgement for 7 days, the
  subscription expires even while it is renewed. Both deadlines are
  enforced in the same transaction as any delivery, fetch,
  acknowledgement or renewal, and by the minute sweeper. So retention stops
  at the deadline even if the sweeper is down. An expired subscription
  releases its payloads at once and is closed in the same transaction. Its
  tombstone lasts at most 30 days, and at most 10,000 tombstones exist.
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
  access parameters) is stored before the provider is asked. Management
  moves to a remaining subscription's connection when its connection's
  subscription ends. The last subscription starts a cleanup job: backoff up
  to a day, a 30-day deadline, then a visible failure. Pending cleanups are
  capped at 20 per owner and 10,000 in all, so one owner's failing cleanups
  never block another's. Shared application hooks are never changed.
  Provider calls (and the access re-check before them) are step 3.

Concurrency: every write takes row locks in one order: subscriptions,
owners, the deployment row, then hooks, payloads and receipts. All writes
pass the deployment row, so they are serialized after their subscription
locks. That is the pilot's throughput bound. The inbox uses up to four
connections of its own, because the shared client cannot run transactions.

Not yet verified: physical bytes per row, sweep lag under load, and
behaviour with several proxy instances beyond what row locks guarantee
(tested with concurrent tasks against one database).
