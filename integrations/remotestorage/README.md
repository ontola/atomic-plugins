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
includes the `claude/plugin-remotestorage-host` changes (not yet in any
pinned candidate).

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
  section 4). That is what lets browser apps PUT today.
- Documents are Files with blobs, not DocumentV2 rich text; imported text
  stays plain text (#167, section 6).

## Host requirements

| Needed | pin `2567fc30b` (`.atomic-server-ref`) | candidate14 `1432e244a` | `claude/plugin-remotestorage-host` |
| --- | --- | --- | --- |
| `plugin-routes` feature, `read-write`, routes origin, install review with route-write grant | yes | yes | yes |
| `installation-origin` mount, `webfinger` claim, `request.base` | yes | yes | yes |
| `body: blob`, `response.blob`, `response.current` preconditions | yes | yes | yes |
| `ctx.tokens.requestConsent` / `issue({ code })`, consent page, `auth: bearer` | yes | yes (consent answers need v2 signatures) | yes |
| `authOptional`: public reads and bearer reads on one route | no | no | **yes** |
| `{*rest}` matching a trailing slash (folders, `/storage/`) | no | no | **yes** |
| `Location` to the approved client after `issue({ code })` | no | no | **yes** |

Without the last three rows the manifest does not validate (`authOptional`
is an unknown field), and even without it folders could not be listed and
the token could not be handed back to the app.

## Validation

```sh
node integrations/remotestorage/build.mjs --check
node integrations/tooling/run-lane.mjs remotestorage --tier node
ATOMIC_SERVER_CHECKOUT=/path/to/atomic-server-at-plugin-remotestorage-host \
ATOMIC_SERVER_ROUTES_BINARY=/path/to/that/target/e2e/atomic-server \
  node integrations/tooling/run-lane.mjs remotestorage --tier e2e
```

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
  `storeFile`/`getFile`/`getListing`/`remove`, a binary document included.
  Then plain `fetch` checks public and private reads, scope refusals, `304`
  and `412`s, and that the documents are Files with blobs and route
  provenance under the configured folder. `e2e/import.spec.ts` runs the text
  importer through `/plugin-run` with real approval and persistence.

`verify-host.mjs` runs a checkout's own `validateManifest` and `parseVerdict`
on this manifest and an import verdict:

```sh
node --experimental-strip-types integrations/remotestorage/verify-host.mjs /path/to/atomic-server
```
