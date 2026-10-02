# remoteStorage

Status: **experimental**, catalog entry `enabled: false`. A remoteStorage
server ([draft-dejong-remotestorage-22](https://datatracker.ietf.org/doc/draft-dejong-remotestorage/))
that runs as a QuickJS plugin route on AtomicServer and keeps documents as
Atomic Files. Its bundle also keeps the earlier reviewed importer for JSON
text exports.

What it needs from the host, and at which atomic-server commit each part
exists, is in [Host requirements](#host-requirements). In short: it installs
only on a server built with the `plugin-routes` feature, started with
`--plugin-routes read-write` and a `--routes-origin`, and at a commit that
includes the `claude/plugin-remotestorage-host` changes: pin candidate15
(`59ddfe7`) and every later candidate, including the current pin,
candidate19 (`a12b74a`).

## What it does

- **Discovery.** A shared `webfinger` claim (`acct:` resources) on the
  installation's own origin, `https://<slug>.<routes origin host>`. The user
  address is `name@<slug>.<routes origin host>`; `config.user` restricts the
  name, otherwise any name answers. The JRD links the storage root
  (`<origin>/storage`) and the OAuth endpoint (`<origin>/oauth`), and says
  that byte ranges, tokens in query parameters and web authoring are not
  supported.
- **Authorization.** `GET /oauth` takes the implicit grant
  (`response_type=token`, the only one supported) with `redirect_uri`,
  `scope` (`notes:rw contacts:r`, or `*:r` / `*:rw`) and `state`. It asks the
  host for consent (`ctx.tokens.requestConsent`) and redirects to the host's
  consent page on the API origin, where someone who manages the Installation
  sees the app's origin and the exact scopes and clicks Allow or Deny. The
  host sends the answer to `GET /oauth/callback`, which redeems the one-time
  code (`ctx.tokens.issue({ code })`) for a bearer token with exactly the
  approved scopes and redirects to `redirect_uri#access_token=…`. The app's
  origin is the token's `client`; a callback whose redirect names another
  origin revokes the token instead. Tokens do not expire; they are listed and
  revoked on the Installation page (host `/plugin-route-tokens`).
- **Storage.** `GET`/`HEAD` and `PUT`/`DELETE` on `/storage/{*rest}`:
  - A token's scopes decide access per category, `r` or `rw`; `*` covers
    every category and is needed for `/` and `/public/`. Documents under
    `/public/<category>/` are readable without a token; public folder
    listings are not. No token is `401`, a token outside its scope `403`.
  - A document is a File directly under the folder named in `config.table`,
    with the bytes in the host's blob store (`body: blob`): `name` and
    `filename` (the last path segment), `localId` (`remotestorage:` + SHA-256
    of the path, the identity the host keeps unique), `blob`, `filesize`,
    `mimetype` (the `Content-Type` of the PUT, served back unchanged) and
    `downloadURL` (the document's URL, which also records its path). Folders
    are not resources: they are the documents' path prefixes.
  - A document's ETag is its BLAKE3 blob hash, set by the host. `If-Match` and
    `If-None-Match` on GET, HEAD, PUT and DELETE are answered by the host
    against the blob the handler reports (`response.current`); a failed
    precondition is `412` (`304` for GET/HEAD) and nothing is stored.
  - Folder listings are `application/ld+json` folder descriptions with each
    item's ETag, `Content-Type` and `Content-Length`; a folder's ETag is the
    SHA-256 of its listing, so it changes with any document below it. An
    empty or missing folder is an empty listing.
  - A document and a folder cannot share a path (`409`). A PUT or DELETE on a
    folder path is `400`.
  - Every storage response allows any origin without credentials and exposes
    `ETag`, `Content-Type`, `Content-Length` and `WWW-Authenticate`.
- **Imports.** `run(ctx)` imports a JSON export of text documents (at most
  128 per upload, 256 KiB each) as reviewed `create`/`set` intents: ordinary
  resources with the text in `description` and an `importBaseline`. The
  storage serves these read-only (ETag: SHA-256 of the source), lists them,
  and answers `409` to a PUT or DELETE on one; an import never replaces a
  document an app stored. An imported document edited in Atomic since is a
  `503` and is left out of listings until it is imported again.

The source uses no Node or browser APIs; everything it calls is in the host's
QuickJS prelude (`ctx.query`, `ctx.read`, `ctx.tokens`).

## Install

On a server with the host requirements below:

1. Create a folder for the documents.
2. Publish the bundle (`plugin.js`) to the node's store and open it in the
   store. The review lists the public endpoints and the `documents` write
   target. Check **Incoming items**, and set the config:

   ```json
   { "table": "<the folder's subject>", "user": "me" }
   ```

3. Connect an app with `me@<slug>.<routes origin host>`. The slug is the
   first 32 hex characters of the BLAKE3 hash of the Installation's subject
   (see `routeSlug` in `e2e/server.spec.ts`).

## Limits

Declared, not measured in production:

- 1,000 resources in the folder: every listing and every write reads them
  all (one `ctx.read` each) within the route's 3,000 ms deadline.
- 16 MiB per document (`maxBodyBytes`, the host's default blob limit), and
  the host's route quotas (creates per caller per hour, bytes per day).
- `redirect_uri` at most 400 characters, and `redirect_uri` plus `state` at
  most 512 characters of JSON (the host's limit on consent `state`).
- Paths: at most 32 segments and 2,048 characters; no `.`/`..`, empty
  segments, encoded `/`, backslash, `%`, `?`, `#` or control characters in a
  decoded segment.

## Not supported, or not atomic

- **A denied request is not reported to the app.** The host only lets a route
  redirect to a client a person approved in that same request, so after
  Deny the callback answers `403` on the routes origin instead of sending
  `#error=access_denied` back.
- **Preconditions are checked just before the write, not inside the commit**
  (#167, section 1). Two writers racing on one path can both pass `If-Match`.
  Two concurrent creates of one path cannot both succeed: the host refuses
  the second create's duplicate `localId` (a `500 route-write-failed`, not a
  `412`).
- **Stored bytes are not garbage-collected**: the host keeps a blob after a
  refused write or a DELETE (#167, section 2).
- The OAuth code flow with PKCE, tokens in query parameters (RFC 6750 2.3),
  byte ranges (RFC 7233), `Last-Modified` in listings, and web authoring.
- Preflight `OPTIONS` requests are answered by the server's global CORS layer
  (any origin, any method and header), not per declared route (#167,
  section 4). That is what lets browser apps PUT today, but the preflight
  carries no `Access-Control-Expose-Headers`.
- The server's `Compress` middleware compresses storage responses when the
  client sends `Accept-Encoding`: the body is then not the stored bytes the
  ETag names, and `Content-Length` is dropped (#167, section 4). Browsers
  decode it transparently.
- `Content-Range` on a PUT is not refused with `400`: the host does not pass
  that header to the handler, which stores the body as a whole document
  (#167, section 4).
- An empty `Authorization:` header on a public read is a `401`: an
  `authOptional` route treats any `Authorization` header as credentials
  (#167, section 3). Browsers and remotestorage.js send no header instead.
- Documents are Files with blobs, not DocumentV2 rich text; imported text
  stays plain text (#167, section 6).

## Host requirements

| Needed                                                                                      | candidate14 `1432e244a`                  | candidate15 `59ddfe7` and later, including the pin, candidate19 `a12b74a` |
| ------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| `plugin-routes` feature, `read-write`, routes origin, install review with route-write grant | yes                                      | yes                                                                       |
| `installation-origin` mount, `webfinger` claim, `request.base`                              | yes                                      | yes                                                                       |
| `body: blob`, `response.blob`, `response.current` preconditions                             | yes                                      | yes                                                                       |
| `ctx.tokens.requestConsent` / `issue({ code })`, consent page, `auth: bearer`               | yes (consent answers need v2 signatures) | yes                                                                       |
| `authOptional`: public reads and bearer reads on one route                                  | no                                       | yes                                                                       |
| `{*rest}` matching a trailing slash (folders, `/storage/`)                                  | no                                       | yes                                                                       |
| `Location` to the approved client after `issue({ code })`                                   | no                                       | yes                                                                       |
| a handler's `access-control-expose-headers` reaching the browser (apps read `ETag`)         | no                                       | yes                                                                       |

The last four rows are the `claude/plugin-remotestorage-host` commits
(`ed1f03d76`, on candidate14), which every pin candidate from candidate15 on
contains. Without them the manifest does not validate (`authOptional` is an
unknown field); folders could not be listed, the token could not be handed
back to the app, and a browser app could not read revisions. The e2e passed
at candidate15 (#214) and again at the pin, candidate19 `a12b74a`, on
2026-10-01. The candidate14 column is from reading the source, not from
running this plugin there.

## Validation

```sh
node integrations/remotestorage/build.mjs --check
node integrations/tooling/run-lane.mjs remotestorage --tier node
node integrations/tooling/run-lane.mjs remotestorage --tier e2e
# with the remoteStorage API test suite (opt-in, needs Docker or Ruby 2.7):
git clone https://github.com/remotestorage/api-test-suite /tmp/rs-api-suite
REMOTESTORAGE_API_SUITE=/tmp/rs-api-suite \
  node integrations/tooling/run-lane.mjs remotestorage --tier e2e
```

The e2e tier needs the pin built with `--features wasm-plugins,plugin-routes`
(`run-lane.mjs` builds it on first use; see AGENTS.md, "The plugin-routes
feature build"), or `ATOMIC_SERVER_ROUTES_BINARY` naming such a binary, for
example one copied out of
`ghcr.io/ontola/atomic-server-e2e:<pin>-plugin-routes`.

- **node** (`plugin.test.mjs`): the manifest against this repo's port of the
  host's manifest rules; WebFinger; the OAuth request, callback and refusals;
  scopes; PUT/DELETE intents and `current`; listings and ETags; imports and
  their interplay with stored documents; path validation; and that the
  committed `plugin.js` is the reproducible bundle and runs without Node
  APIs. An in-memory `ctx`: unit evidence, not host persistence.
- **e2e** (`e2e/server.spec.ts`), on atomic-server built with the feature at
  `--plugin-routes read-write`: installs the unchanged bundle through the
  store's review dialog, then drives **remotestorage.js 2.0.0-beta.10**
  (npm `remotestoragejs`, pinned in `e2e/package.json`) from another origin
  through discovery, the host's consent page (Allow), and its own
  `storeFile`/`getFile`/`getListing`/`remove`, a binary document included
  (remotestorage.js 2.0.0-beta.10 hands a binary document back as a decoded
  string, because its binary-or-text check tests an `ArrayBuffer` as a
  string; the spec checks the exact bytes with `fetch`). Then plain `fetch` checks public and private reads, scope refusals, `304`
  and `412`s, and that the documents are Files with blobs and route
  provenance under the configured folder. `e2e/import.spec.ts` runs the text
  importer through `/plugin-run` with real approval and persistence.
- **api-suite** (`e2e/api-suite.spec.ts`): the protocol's own test suite,
  opt-in; skipped unless `REMOTESTORAGE_API_SUITE` names a checkout of it.
  See below.

## remoteStorage API test suite

[remotestorage/api-test-suite](https://github.com/remotestorage/api-test-suite)
is the protocol's server test suite (Ruby, minitest; written for drafts 03
to 05, "valid for later versions but missing specs for some newer
features"). `e2e/api-suite.spec.ts` installs the unchanged bundle in two
drives (the second installation is the suite's "other user", since a drive
installs a plugin once), gets the suite's three tokens through the real
OAuth flow and the host's consent page (`api-test:rw`, `api-test:r`, `*:rw`),
and runs `rake test`. By default the suite runs in Docker
(`ruby:2.7-bullseye`, host network), because it pins Ruby 2.6/2.7-era gems
(json 1.8.6); `REMOTESTORAGE_API_SUITE_RUBY=local` uses `bundle` from `PATH`
instead. The spec fails when a test outside its `KNOWN_FAILURES` fails, or
when one of those starts passing, so this section has to follow. It also
checks the two compression failures directly: without `Accept-Encoding` a
document GET has the exact `Content-Length`, `Content-Type`,
`Cache-Control: no-cache` and the PUT's ETag; with `Accept-Encoding: gzip`
it comes back gzipped, without `Content-Length`.

Run on 2026-10-01 with suite commit `55cc9a2` (2022-02-11), plugin 0.3.0, and
the pin, candidate19 `a12b74a`, built with `wasm-plugins,plugin-routes` (the
binary from `ghcr.io/ontola/atomic-server-e2e:<pin>-plugin-routes`):
**46 of 53 tests pass, 7 fail, 0 errors.** None of the failures is in the
plugin. Each is host behaviour that #167 tracks:

| Test (describe > it)                                         | Why it fails                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OPTIONS::GET > returns a valid response                      | #167 §4, per-route OPTIONS: the server's global CORS layer answers the preflight, without `Access-Control-Expose-Headers`. That is the first failing assertion; the later ones are not reached.                        |
| OPTIONS::PUT and DELETE > returns a valid response           | The same.                                                                                                                                                                                                              |
| PUT with Content-Range > returns a 400                       | #167 §4: `content-range` is not among the request headers the host passes to a handler, so the plugin cannot see it and stores the body (`200`).                                                                       |
| GET a JSON object > works                                    | #167 §4: Ruby sends `Accept-Encoding: gzip, deflate` by default, the server's `Compress` middleware gzips the response, and `Content-Length` is gone. Without `Accept-Encoding` the headers are right (checked above). |
| GET a JSON object while accepting compressed content > works | #167 §4: the same middleware answers with `Content-Encoding: br`. A handler may not set `Content-Encoding` to opt out.                                                                                                 |
| in a public folder::GET without a token > works              | #167 §3: the suite sends an empty `Authorization:` header, and an `authOptional` route treats any `Authorization` header as credentials (`401`). A request without the header gets `200` (`server.spec.ts`).           |
| in a public folder::HEAD without a token > works             | The same.                                                                                                                                                                                                              |

The 46 that pass cover PUT and nested folders, document and folder ETags
changing with an update, the two `409` conflicts, `If-Match` and
`If-None-Match` on PUT, GET, HEAD and DELETE (`412`, `304`, several ETags),
a binary JPG with its exact `Content-Type` and bytes, `404`s, folder and
root listings, the root token, the other user's storage (`401`), read-only
tokens (`403` on writes), public documents and listings, and DELETE.
