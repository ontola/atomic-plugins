# Changelog

Releases of the `atomic-integration-proxy` crate. Earlier releases are
described in the README ("Deploying 0.2", and the "0.2.1 and later" notes).

## Unreleased

Not yet published to crates.io or deployed.

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
