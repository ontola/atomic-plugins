# Changelog

Releases of the `atomic-integration-proxy` crate. Earlier releases are
described in the README ("Deploying 0.2", and the "0.2.1 and later" notes).

## 0.2.4 (2026-10-02)

- Default catalog: `overlays/catalog/2026-10-02.json`, selecting immutable
  overlay filenames with the OAD last-change SHA. The full Discord OAD is
  composed; connecting it awaits separate mixed-authentication support
  (ontola/atomic-plugins#258).

- Catalog loading checks an overlay's declared `extends` against the original
  catalog OAD before applying its actions. Relative URI references resolve
  against the overlay URL; legacy overlays without `extends` remain supported.

## 0.2.3

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
- The default catalog (`overlays/catalog/2026-10-02.json`) gains `pets`, a static,
  read-only demo API on GitHub Pages that uses this. 0.2.2 and earlier load
  that catalog and list `pets`, but their consent page answers "This platform
  is not available for connection".
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
