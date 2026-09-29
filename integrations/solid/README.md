# Solid pod

Status: **partial implementation**, targeting the resource model of
[Solid Protocol 0.11.0](https://solidproject.org/TR/2024/protocol-20240512)
and the resource-server side of [Solid-OIDC](https://solidproject.org/TR/oidc).
This is not a conforming Solid server: WAC/ACP documents, notifications,
binary resources, collections in Turtle and a full SPARQL Update are not
implemented (see "Not implemented").

`plugin.mjs` is dependency-free QuickJS JavaScript exporting the host's
schema-version-3 `manifest`, `run(ctx)` and `handle(ctx, request)`. No
browser globals, Node imports, native libraries or sockets enter the bundle.

## What it does

One installation is one pod, on its own **installation origin**
(`https://<installation-slug>.<routes origin>/`, the storage root). Every
Solid resource and container is a `PlainText` atom directly under the
configured `storage` folder: `localId` holds `solid:<path>`, `name` the path,
`mimetype` the media type and `description` the exact bytes. Containers are
atoms whose path ends in `/`; the root is implicit.

| Method    | Resource                                                                                                                                                                                      | Container                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET, HEAD | stored bytes; RDF negotiated between `text/turtle` and expanded `application/ld+json`                                                                                                         | generated `ldp:BasicContainer` with `ldp:contains`, Turtle or JSON-LD; the root is also `pim:Storage`                                   |
| PUT       | create (201, with missing parent containers) or replace (204)                                                                                                                                 | create an empty container (201); replacing one answers 409                                                                              |
| POST      | —                                                                                                                                                                                             | create a child named by `Slug` (sanitized, made unique), a container with `Link: <ldp:BasicContainer>; rel="type"`; 201 with `Location` |
| PATCH     | `text/n3` (N3 Patch: one `solid:InsertDeletePatch` with `solid:where`/`inserts`/`deletes`) and `application/sparql-update` (`INSERT DATA`/`DELETE DATA` only); may create; RDF resources only | 409                                                                                                                                     |
| DELETE    | 204                                                                                                                                                                                           | only when empty (409 otherwise); the root answers 405                                                                                   |

Every response carries `Link` (`ldp:Resource`, and `Container`/`BasicContainer`,
`RDFSource`/`NonRDFSource`, `pim:Storage` as they apply, one header line
each), `WAC-Allow`, `Allow`, `Accept-Patch`/`Accept-Put` or `Accept-Post`,
`Vary: Accept, Authorization, Origin`, and
`Access-Control-Expose-Headers` for browser clients. ETags are strong: the
first 128 bits of SHA-256 over the media type and the exact representation.
`If-Match` (strong comparison) and `If-None-Match` are honoured on reads
(304/412) and writes (412).

### Who may do what

The host verifies `Authorization: DPoP <access token>` plus the `DPoP` proof
before this code runs (atomic-server `auth: dpop`; see "Host requirements")
and hands over `request.caller.webid`. A request without a token runs as the
host's **public** principal with `caller: null`, and the host refuses any
write it proposes. The pod's `access` config then decides, pod-wide:

```json
{
  "storage": "https://your-server.example/the-pod-folder",
  "access": {
    "owners": ["https://id.example/alice/profile/card#me"],
    "readers": ["https://id.example/bob/profile/card#me"],
    "appenders": [],
    "writers": [],
    "public": ["read"]
  }
}
```

Modes are `read`, `append` and `write` (`write` implies `append`; owners get
all three). GET/HEAD need `read`; PUT and DELETE need `write`; POST needs
`append`; PATCH needs `append` for inserts only, and `write` plus `read`
with deletes or `solid:where`. A missing mode is `401` with a
`WWW-Authenticate: DPoP` challenge when anonymous, `403` otherwise.
`WAC-Allow` reports exactly these decisions; `control` is never granted
because there are no ACL resources to control.

These grants only narrow what the host allows. Reads run as the
installation's agent (authenticated) or the public (anonymous), so a public
read also needs Atomic public read on the atoms (e.g. `read: publicAgent` on
the storage folder). Writes go only into the approved `storage` write target,
and only onto atoms this installation created.

### Reviewed import job

`run(ctx)` still imports one text/plain, Turtle or expanded JSON-LD document
from `parent` + `document` config as a reviewed create intent. It is stored
with `localId` `solid:/<id>`, so a pod whose `storage` is that `parent`
serves it at `/<id>`. Relative IRIs are rejected there (a job has no URL).

## RDF subset

Turtle ([RDF 1.1](https://www.w3.org/TR/turtle/)) supports `@prefix`/`PREFIX`,
`@base`/`BASE` and relative IRIs (resolved per RFC 3986 against the
resource's URL), `a`, predicate and object lists, labelled and anonymous
blank nodes (`_:x`, `[]`, `[ p o ]`), short and long strings with escapes,
language tags and datatypes, and bare integer/decimal/double/boolean forms,
whose lexical forms stay strings. Collections, dotted or escaped prefixed
names and other Turtle syntax are rejected. JSON-LD is the expanded form
only: named and blank node `@id`s, `@type`, and string literals with an
optional language or datatype; no contexts, lists, graphs or numbers.

Limits: request and stored bodies at most 32,768 UTF-8 bytes (the route
accepts up to 65,536 so the plugin can answer with a 413 of its own); at
most 128 subject nodes, 512 statements and 32,768 expanded bytes per parse
(the old prefix-expansion guard); generated representations at most 32,768
bytes; container listings at most 256 children (507 above); paths at most
1,024 characters and 16 segments, without `.`/`..` or empty segments.

## Host requirements

The resource server needs, from atomic-server:

- `plugin-routes` built in, `--plugin-routes read-write`, a `--routes-origin`
  (the installation origin), and the install review's route-write grant for
  the `storage` target.
- **`auth: dpop`**, `--solid-oidc-issuers`, the Solid response headers
  (`allow`, `accept-*`, `wac-allow`), `link`/`slug` request headers and
  multi-valued `Link`. These are on atomic-server branch
  `claude/plugin-solid-host` (on `claude/atomic-plugins-pin-candidate14`),
  **not in the pinned host**. On a host without them every route answers
  `501 route-auth-unavailable`, and the e2e skips with that reason.

What the host's DPoP verification covers and leaves out is documented in
atomic-server `server/src/plugins/route_dpop.rs`. In short: the operator
lists trusted issuers (no open issuer discovery); proofs are bound to the
method and the URL as the node's configuration names it (never `Host` or
`Forwarded`), are fresh (120 s back, 60 s ahead) and single-use; tokens are
checked for issuer, signature (issuer JWKS), expiry, `aud` containing
`solid`, `cnf.jkt` and a `webid` whose Turtle profile lists the issuer. No
server nonces, JSON-LD profiles, introspection or refresh.

## Not implemented

- WAC `.acl` or ACP resources, per-resource access, and `control`: access is
  the pod-wide `access` config.
- Binary resources: route bodies are UTF-8 text, and a handler cannot read a
  stored blob, so a non-UTF-8 PUT is refused by the host (400).
- Preconditions are checked by the handler against what it read, not inside
  the commit (atomic-plugins#167, section 1): two concurrent writers can both
  pass `If-Match`. Multi-atom writes (a resource with new parent containers)
  are not atomic either.
- Solid Notifications, `OPTIONS` answers beyond the host's CORS preflight,
  `describedby`/auxiliary resources, storage description, quotas beyond the
  host's route-write quotas, and SPARQL Update beyond `INSERT DATA`/
  `DELETE DATA`.
- An identity provider: the pod verifies tokens from an external issuer.

## Build and verification

```sh
node integrations/solid/build.mjs
node --test integrations/solid/plugin.test.mjs integrations/solid/turtle.test.mjs
node integrations/tooling/run-lane.mjs solid --tier node
node integrations/tooling/run-lane.mjs solid --tier e2e
```

The build creates `integrations/solid/dist/plugin.js` and `manifest.json`.
The Node tests run `handle`/`run` against a host double that applies the
verdict's intents the way route writes do: LDP create/read/replace/delete,
containers, Slug, WAC decisions, preconditions, N3 Patch and SPARQL Update,
negotiation, parser grammar and bounds, SHA-256 vectors, and seven selected
W3C Turtle cases ([provenance and license](fixtures/w3c/README.md)).

The e2e (`e2e/solid.spec.ts`) runs on a real atomic-server with
`--plugin-routes read-write`, publishes and installs this file, and drives
the pod with [@inrupt/solid-client](https://www.npmjs.com/package/@inrupt/solid-client)
4.0.0 using DPoP-bound tokens from a test issuer (`e2e/issuer.ts`), which
serves issuer metadata, JWKS and WebID profiles and mints tokens in process;
it is not an identity provider. The lane passes the issuer to the server
through `serverEnv` in `integrations/lanes.json`.

**Verified** (2026-09-29, `node integrations/tooling/run-lane.mjs solid`,
node and e2e tiers passing) against atomic-server `claude/plugin-solid-host`
at `6beefd276` (the DPoP code as later reformatted in `21ec49767`), built with
`--features wasm-plugins,plugin-routes`: root container with public read and
CORS, `createContainerAt`, `saveSolidDatasetAt` (PUT with `If-None-Match: *`,
then a SPARQL Update PATCH), `getSolidDataset` and `getContainedResourceUrlAll`,
`getEffectiveAccess`, `saveFileInContainer` with a Slug and `getFile`, N3
Patch with `solid:where`, JSON-LD negotiation, 412/304 on ETags, 403 for a
reader's write, 401 for anonymous writes and for tokens with a wrong
audience, an expired token, a WebID whose profile does not name the issuer,
and a Bearer token; deletes, including 409 for a non-empty container; and
the stored atoms listed by path in the data browser's folder view.

**Declared, not verified**: the skip against a host without `auth: dpop`
(no plugin-routes build of the previous pin was at hand), browser-based
Solid apps (their preflights go through the host's CORS layer), a real
identity provider's login, other Solid client libraries, and the Solid
conformance test harness.

The manifest declares every consumed configuration field with the
host-supported string/object schema; none is globally required, because
import-only and pod-only configurations are both valid.
