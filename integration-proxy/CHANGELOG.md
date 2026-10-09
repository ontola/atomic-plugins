# Changelog

Releases of the `atomic-integration-proxy` crate. Earlier releases are
described in the README ("Deploying 0.2", and the "0.2.1 and later" notes).

## Unreleased

`Config` gains a public field (`webhooks`), a breaking change under Cargo's
0.x semver rules, so the next release is 0.4.0.

- Webhook inbox, step 2 of ontola/atomic-plugins#369: the bounded inbox of
  `openapi-extensions/spec/webhook-subscriptions` in PostgreSQL, off unless
  `WEBHOOKS_ENABLED=true` (new `Config::webhooks`, `WebhookConfig`,
  `WEBHOOK_INBOX_MAX_BYTES`). Enabled, it creates its tables and runs a
  sweeper every minute; it mounts no route, receives no delivery and
  registers no hook. Subscriptions, leases and the progress deadline,
  generations, cursors and gaps, per-owner receipts, subscription, owner and
  deployment budgets, shared payloads, tombstones and dedicated-hook cleanup
  jobs, with the limits the plan gives as pilot values. See SECURITY.md,
  "Webhook inbox".
- Rate-limit and conditional headers (docs/design/pieces.md P1-P3): the
  provider's `X-RateLimit-Limit`, `-Remaining`, `-Used`, `-Reset`,
  `-Resource`, `RateLimit`, `RateLimit-Policy`, `RateLimit-Limit`,
  `-Remaining`, `-Reset` and `Last-Modified` now come back to the caller and
  are CORS-exposed; the caller's `If-None-Match` and `If-Modified-Since` go
  upstream, and `Idempotency-Key` where the operation declares that header
  parameter, namespaced per connection on a no-credential connection. Every
  list is exact names only, and every `/proxy/…` response is now
  `Cache-Control: no-store`. A catalog-fixed value for a caller header now
  replaces the caller's instead of being sent next to it. See SECURITY.md,
  "Validating proxy".
- A composed catalog document with a `$ref` path item, or a path item that is
  not an object, is refused at load (naming the platform and path) instead of
  being read inconsistently; no catalog uses one.

## 0.3.0 (2026-10-06)

0.3.0 rather than 0.2.6 because `Config` gains public fields (below), a
breaking change under Cargo's 0.x semver rules. **Deploying 0.3.0 on Heroku
needs `TRUST_FORWARDED_FOR=heroku`.**

- HTTP bearer and basic tokens (Decision Inbox Q-086): a security scheme of
  `type: http` with `scheme: bearer` or `scheme: basic` is a user credential.
  The consent page asks for an API token (and, for one Basic layout, a
  username), calls the scheme's `x-api-key-details.keyCheck` with the
  `Authorization` header the proxied requests will carry, and seals the
  credential like an API key; a `401`/`403` asks again without spending the
  consent. Requests carry `Authorization: Bearer <token>` or
  `Authorization: Basic base64(username:password)`, only while the platform
  still resolves to an `http` scheme of the same kind (else
  `401 credential_refresh_failed`). A Basic scheme must declare where the
  token goes, in the new `x-api-key-details.basicCredentials`
  (`openapi-extensions/spec/api-key-details` 0.2.0-draft); one without it is
  not offered, and no layout asks for a password other than the token.
  Without an authentication profile an `http` scheme counts only when the
  document declares no `oauth2` and no `apiKey` scheme, so documents that
  resolved before resolve as before; a new `selection.httpSecurityScheme`
  picks one of several bearer/basic schemes, and an authentication profile
  may name one. No platform of the default catalog declares such a scheme
  as its credential, so none changes. Stored credentials now `Debug`-print
  without their secrets. No version set yet.
- Security (review of the above): one consent page makes at most 5 key
  checks, for API keys and `http` tokens alike. The fifth rejection spends
  the consent and answers `400` "Too many attempts to enter a key for this
  connection; start again from your hub", and later submissions of that
  consent are refused before any key check, also when submitted
  concurrently. Before, a rejected key showed the page again without limit,
  so one consent could try any number of keys or username and token pairs
  against the provider. The attempts are single-use records in
  `used_challenges` (`consent-key-check:<csrf>:<n>`, ten minutes), so no
  schema change. The cap bounds one consent page, not a client:
  `GET /connect` needs no signature, so a script can open new consent pages
  and make 5 checks with each; the per-network limit below bounds that.
- Security (Decision Inbox Q-097): key checks are also limited per client
  network and platform, across consent pages: at most
  `KEY_CHECK_LIMIT_PER_HOUR` (default 20, `0` turns it off) in any hour, as
  a sliding window held in PostgreSQL (new table `key_check_limits`, created
  at startup; one row per slot, so the limit holds across instances and for
  concurrent requests). A network is an IPv4 address or an IPv6 /64; the row
  key is an HMAC-SHA256 of the platform and network under `ENCRYPTION_KEY`,
  never the address. The limit is taken after input validation and before
  the consent's own key-check attempt; over it the answer is `429` "Too many
  key checks from your network for <Platform>; try again later" with
  `Retry-After`, with no upstream call and the consent not spent. The log
  line names the hashed bucket and the platform only. The client address is
  the TCP peer unless the new `TRUST_FORWARDED_FOR=heroku` (synonym
  `rightmost`) says to read the right-most `X-Forwarded-For` entry, the one
  Heroku's router or one reverse proxy appends; nothing to its left is read.
  **Deploying:** localthought.io must set `TRUST_FORWARDED_FOR=heroku`, or
  every client shares the router's limit (a startup warning says so when
  Heroku's `DYNO` is set without it); a self-hosted proxy behind Caddy or
  nginx sets `rightmost` (SELF_HOSTING.md). `serve` now records peer
  addresses (`into_make_service_with_connect_info`); a wrapper that serves
  `build_app` itself should too, or, under `none`, every client shares one
  limit. `Config` gains two public fields, `key_check_limit_per_hour` and
  `trust_forwarded_for` (new `TrustForwardedFor`,
  `DEFAULT_KEY_CHECK_LIMIT_PER_HOUR`), which breaks code that builds
  `Config` with a struct literal, as 0.2.1's `operator_*` fields did;
  `Config::from_env` callers are unaffected. Hence the 0.3.0 version. New dependency: `hmac` 0.12.
  Review fixes before merge: the limit is taken only when a key check will
  reach the provider (a declared `keyCheck`, and not a cookie API key);
  under `heroku` the header is split on bytes, and a missing or unparseable
  right-most entry counts against one fixed bucket, never the router's peer
  address; `KEY_CHECK_LIMIT_PER_HOUR` above 10,000 is refused at startup;
  the bucket HMAC uses a subkey derived from `ENCRYPTION_KEY`.
- Security: a new API key, bearer token or Basic credential records the
  security scheme it was entered for (and, for Basic, the declared layout
  without its field label; for an API key, the scheme's `in` and `name`),
  and is sent only while the platform resolves to that same scheme and
  layout or placement; otherwise `401 credential_refresh_failed`
  (connect again). Rows written before carry no binding and are sent as
  before (the kind check still applies).
- A bearer token must now be RFC 6750 `b64token` (`[A-Za-z0-9-._~+/]+=*`),
  with `:` also allowed before the padding for Asana-style personal access
  tokens (`2/<id>/<id>:<secret>`, from Asana's documentation; not checked
  with a live token). It was any visible ASCII.
- **Rollback note.** Once a connection row of kind `http_bearer` or
  `http_basic` exists, rolling back to 0.2.5 or earlier makes requests on
  that connection fail with `500` (the older proxy cannot deserialize the
  credential), and redeeming such a handoff issued in the five minutes
  before the rollback answers `400 invalid_handoff`; `GET /connections` and
  deletion do not deserialize
  credentials and keep working. Delete those connections, or roll forward.
  Rows of kind `api_key` with the new `scheme`/`placement` fields are still
  read by 0.2.5 (serde ignores the unknown fields), so API-key connections
  survive a rollback. An API-key handoff redeemed by 0.2.5 is re-serialized
  without those fields, so that connection stays unbound after rolling
  forward and is sent as before (harmless).

## 0.2.5 (2026-10-05)

Published to crates.io on 2026-10-05 (tag `integration-proxy-v0.2.5`) and
deployed to localthought.io on 2026-10-06 (Heroku v86; catalog switch v87).

- Authentication profiles (ontola/atomic-plugins#258): a catalog entry may
  select `authenticationProfile`, naming one of the composed document's
  `components.x-authentication-profiles`
  (`openapi-extensions/spec/authentication-profiles`, 0.1.0-draft). The
  document may then declare several kinds of security scheme. The proxy uses
  the profile's one scheme (`oauth2` authorization code, or `apiKey` with its
  help link and key check), asks only for the OAuth scopes of the operations
  the profile covers, and answers `404` for every other operation without
  sending a credential. An unresolvable profile, or one combined with
  `oauthSecurityScheme`/`apiKeySecurityScheme`, is refused. Without a
  profile selection nothing changes: mixed kinds stay refused.
- Security: a stored OAuth token is sent only while its platform still
  resolves to an OAuth scheme (an API-key connection already required its
  kind). `Catalog::oauth_provider` now resolves exactly as
  `Catalog::security_scheme` does, so token exchange and refresh use the
  selected scheme or profile.
- Default catalog: `overlays/catalog/2026-10-02-auth-profiles.json`. It
  differs from `2026-10-02.json` only in Discord, which now lists the
  `auth-v2` overlay revision and selects the `discordUser` profile: the
  proxy offers a Discord connection again, with the scopes `identify` and
  `guilds` and the two reads they cover. Composition-tested against the
  pinned full OAD; not verified with a live Discord account. 0.2.4 can load
  the new catalog (it ignores the new selection key), and keeps refusing
  Discord there.

- Security: the single-use record of a signed request now names its signer.
  The `used_challenges` key was `atomic-request-v2:{sha256(message)}`, over
  the signed message alone, so two agents that signed the same method, URL,
  body and millisecond collided (the second got `401 replayed`), and anyone
  who could predict another agent's request URL and millisecond could spend
  that key first with their own valid signature and so refuse the other
  agent's request. The key is now
  `atomic-request-v2-agent:{sha256(agent + "\n" + message)}`, where `agent`
  is the canonical id derived from the public key, so every spelling of one
  agent (`did:ad:agent:`, either base64 alphabet) still spends one key and
  the same agent sending the same signed request twice is still refused.
  No migration: rows in the old format expire ten minutes after they were
  written. Until then, during a rolling deploy or right after a restart, a
  request is also refused while its old-format key is still recorded, so a
  request accepted by the previous release just before the deploy cannot be
  accepted again just after it. This release never writes old-format keys;
  the check can be removed in a later release.

## 0.2.4 (2026-10-02)

- Default catalog: `overlays/catalog/2026-10-02.json`, selecting immutable
  overlay filenames with the OAD last-change SHA. The full Discord OAD is
  composed; connecting it awaits separate mixed-authentication support
  (ontola/atomic-plugins#258).

- Catalog loading checks an overlay's declared `extends` against the original
  catalog OAD before applying its actions. Relative URI references resolve
  against the overlay URL; legacy overlays without `extends` remain supported.

- An `apiKey` security scheme may declare `x-api-key-details`
  (`openapi-extensions/spec/api-key-details`, 0.1.0-draft). The consent page
  then shows the scheme's `description` and a link to its `helpUrl`, and
  `POST /connect/authorize` calls its `keyCheck` operation once with the
  pasted key before sealing it. `401`/`403` shows the consent page again
  with "did not accept that API key", without spending the consent; any
  other non-2xx, a redirect or no answer within 10 seconds stores nothing
  and answers `400`. A declared response label is sealed with the
  connection and returned as `label` by `POST /connect/redeem` and
  `GET /connections`. A malformed `x-api-key-details` makes the platform
  unavailable for connection rather than skipping the check. The schema
  gains a nullable `agent_connections.label_envelope` column
  (`ADD COLUMN IF NOT EXISTS` at startup). The default catalog's `clockify`
  entry declares a help link and `GET /v1/user` as its key check.
  (ontola/atomic-plugins#121)

## 0.2.3 (2026-09-30)

- A catalog platform whose composed OpenAPI document declares top-level
  `security: []`, no security scheme, and no operation that requires one now
  connects without a credential. The consent page asks for nothing, the
  connection seals only the platform name, and requests are forwarded with no
  `Authorization` or key. Signatures, frame capabilities, owner and delegation
  checks, the access policy and the catalog allowlist apply as before. A
  document with no `security` at all is still refused, so a platform whose
  auth overlay is missing is never connected without credentials. If the
  catalog later gives such a platform a scheme, its existing connections
  answer `401 credential_refresh_failed` (connect again).
  (ontola/atomic-plugins#174)
- The default catalog (`overlays/catalog.json`) gains `pets`, a static,
  read-only demo API on GitHub Pages that uses this. 0.2.2 and earlier load
  that catalog and list `pets`, but their consent page answers "This platform
  is not available for connection".
- `CHANGELOG.md` is packaged with the crate.

## 0.2.2 (2026-09-29, tag `integration-proxy-v0.2.2`)

- For an OAuth platform, `POST /connect/authorize` continues to the provider
  with a page (a `<meta>` refresh and a button, sent with
  `Referrer-Policy: no-referrer`), not a `303` redirect. The consent page's
  CSP `form-action` covers a form submission's whole redirect chain, so a
  provider whose authorization endpoint redirects to another origin of its
  own (Notion's API host to its app host) was blocked. The consent page's
  `form-action` is now `'self'` for OAuth platforms; an API-key approval
  still redirects to `redirect_uri` and keeps that origin.
  (ontola/atomic-plugins#207)
- Approving a consent page a second time (back button, double click) answers
  "You already approved this connection …" instead of "expired".
- The consent page's one inline script, allowed by its SHA-256 hash in the
  CSP, disables the approve button on submit.
- An unusable API key is refused before the consent is spent, so correcting
  it and approving again works.
