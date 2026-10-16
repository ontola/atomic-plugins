# Fediverse

Status: **experimental; one follow, post and reply round trip verified
against a real Mastodon (4.7.3) and a real Akkoma (3.20.1) on loopback, in
opt-in tests.** One
ActivityPub actor per installation, for one Atomic drive: other fediverse
servers can find it (WebFinger), follow it (accepted automatically), receive
its public posts as signed deliveries, and send replies, which are stored in
the drive. Only those two versions have been tried, on test certificates
and a non-default port, never on the public internet; GoToSocial cannot
follow it yet (see [Against a real Mastodon](#against-a-real-mastodon),
[Against a real Akkoma](#against-a-real-akkoma) and
[Known host gaps](#known-host-gaps)). It needs a server built with the
`plugin-routes` feature (see [Host requirements](#host-requirements)).

The plugin is a QuickJS route handler (`handle(ctx, request)`, the host's
`http` trigger). It keeps no state between requests, never holds a key and
never opens a socket: followers and replies are Atomic resources it creates
under folders you choose, its key is host-held, and every outbound request
is a job in the host's durable delivery queue, signed by the host.

`plugin.js` (built from `plugin.mjs`, `sha256.mjs` and `manifest.json` by
`build.mjs`) is the release input.

## What it does

| Route (drive-host mount)                                    | Auth                                            | What                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/webfinger`                                | none                                            | `acct:<username>@<host>` (or the actor URL) → the actor; `rel` filters links. Shared claim for `acct:` with `rels: ["self"]`, so the host routes only `acct:` resources here (see [Known host gaps](#known-host-gaps)). |
| `GET /.well-known/nodeinfo`, `/nodeinfo/2.1`                | none                                            | NodeInfo 2.1, `protocols: ["activitypub"]`, the number of public posts.                                                                                                                                                 |
| `GET /ap/actor`                                             | none                                            | A `Service` actor: name and summary from the profile resource, `inbox`, `outbox`, `followers`, `webfinger` (FEP-2c59, see below), and `publicKey` from the host-held `actor-key` (RSA-2048).                            |
| `GET /ap/outbox`, `/ap/objects/{id}`, `/ap/activities/{id}` | none                                            | Public posts under `config.posts`, as `Create` activities, 10 per page, newest first.                                                                                                                                   |
| `GET /ap/followers`                                         | none (reads as the Installation)                | An `OrderedCollection` with `totalItems` only: who follows is not published.                                                                                                                                            |
| `POST /ap/outbox`                                           | `atomic` (a version 2 Atomic request signature) | A configured publisher posts a Note: stored as a `Message` under `config.posts`, and a `Create` queued for each follower's inbox.                                                                                       |
| `POST /ap/inbox`                                            | `http-signature`, verified by the host          | Follow, Undo(Follow), Create(Note) replies, Delete.                                                                                                                                                                     |

The actor names its own handle in `webfinger` (`<username>@<host>`, with
the port when `origin` has one; [FEP-2c59](https://codeberg.org/fediverse/fep/src/branch/main/fep/2c59/fep-2c59.md)).
Mastodon 4.7.3 reads it instead of deriving `preferredUsername@<host of the
actor id>`, which drops the port; without it, an actor on a non-default port
cannot pass Mastodon's WebFinger check (seen in the Mastodon e2e).

### Inbox

The host verifies the signature (draft-cavage-12 or RFC 9421, `Digest`,
`Date` within 5 minutes) before the plugin runs, and fetches the signer's
key itself. The plugin then requires the activity's `actor` to be the key's
owner (`401` otherwise), and:

- **Follow** of this actor is **accepted automatically**
  (`manuallyApprovesFollowers: false`). The follower is stored as a Bookmark
  (`name` = actor id, `url` = inbox, `localId` = the Follow's id) under
  `config.followers`, and an `Accept` is queued to the follower's inbox with
  idempotency key `accept:<follow id>`. A repeated Follow re-sends the
  Accept and stores nothing new. The inbox comes from the actor document the
  host fetched to verify the signature (`request.caller.actor`), preferring
  `endpoints.sharedInbox`; never from the activity.
- **Undo** of a Follow, and **Delete** of the actor itself, destroy that
  actor's follower resources. Nobody can undo another actor's follow.
- **Create** of a Note whose `inReplyTo` is one of this actor's posts is
  stored as a `Message` under `config.replies`: `description` = the content
  as plain text (tags dropped, entities decoded, at most 8,192 characters),
  `name` = the author, `url` = the Note's id, `replyTo` = the post. The
  Note's id must be on the sender's host and its `attributedTo` the sender.
  A Note already stored (same id) is not stored twice. Anything else that is
  not a reply to this actor is answered `202` and not stored.
- **Delete** of a stored reply, by its author, destroys it.
- Every other type is answered `202` and ignored.

Route writes are the host's: only into the three approved folders, only
changing what this installation created, within the host's quotas (100
creates per remote caller per hour, 10,000 per installation per day by
default).

### Posts and publishing

A post is a readable child of `config.posts` with class `Message` or
`PlainText` (projected as a `Note`, its description HTML-escaped) or
`Document`/`DocumentV2` (an `Article` with only its name and a link). Its id
is its `localId` when that is a slug, otherwise the first 32 hex characters
of the SHA-256 of its subject. Its time is exact: posts this plugin stores
have a `localId` of `<milliseconds>-<suffix>`, which carries it; others use
the host's `createdAt`, and without one a resource is not a post. The GET
routes read as the public agent, so only publicly readable posts appear.

`POST /ap/outbox` takes a `Note` or `Create{Note}` with `content` (plain
text, at most 8,192 characters) and an optional `name`. Only agents in
`config.publishers` may post (`403` otherwise), and only while the posts
folder itself lists the public agent in `read` (`409` otherwise): a
delivered post cannot be recalled. It answers `201` with the object URL in
`Location` and `queued`, the number of inboxes a `Create` was queued for
(one per distinct inbox, idempotency key `create:<id>:<inbox>`).

A resource you create in the posts folder in the data browser appears in
the outbox but is **not pushed** to followers: only posts made through
`POST /ap/outbox` are delivered. There is no Update or Delete federation of
posts yet.

## Limits

Exact, and all enforced by the plugin unless marked host:

- 50 children of the posts folder per request; a larger folder answers `503`.
- 100 followers; one post is queued for at most 100 distinct inboxes (the
  host also caps one verdict at 100 deliveries and an installation at 1,000
  per day by default).
- 1,000 stored replies scanned for duplicates and deletes.
- Inbox bodies 262,144 bytes, outbox bodies 16,384 bytes (host).
- Deliveries only to an HTTPS inbox whose path is exactly `/inbox`: the
  manifest's operation is `https://*/inbox`, and the host matches operation
  paths exactly. That is the shared inbox Mastodon, Pleroma/Akkoma and
  Misskey publish. **A follower whose server has no shared inbox at `/inbox`
  (GoToSocial, for one) is refused with `422`** until the host can match a
  path wildcard such as `https://*/users/{segment}/inbox`.
- Deliveries are retried by the host with backoff for up to 12 attempts or
  72 hours.
- The host fetches a signer's key with an unsigned `GET` (host). A server
  that serves actor documents only to signed requests (GoToSocial always;
  Mastodon with `AUTHORIZED_FETCH=true`) cannot have its requests verified,
  so its Follow is refused with `401`. See [Known host gaps](#known-host-gaps).

## Configuration

```json
{
  "origin": "https://alice.example",
  "username": "news",
  "profile": "https://alice.example/profile",
  "posts": "https://alice.example/posts",
  "followers": "https://alice.example/followers",
  "replies": "https://alice.example/replies",
  "publishers": ["https://alice.example/agents/alice"]
}
```

- `origin` is the drive host the routes are mounted on (`drive-host`
  mount: a host mapped to the drive with `/bind-drive`). Every protocol id
  is under it, so treat it and `username` as permanent: this plugin has no
  account migration. HTTPS, except `http://localhost` and
  `http://*.localhost`, which only the tests use.
- `profile` and `posts` must be readable by the public agent; `followers`
  should not be. The install review asks you to approve writes into
  `posts`, `followers` and `replies`; the plugin's agent gets `write` on
  those three folders only.

## Host requirements

Public surfaces need the `plugin-routes` Cargo feature, `--plugin-routes
read-write`, and the installer's approval. Beyond what
`claude/atomic-plugins-pin-candidate14` has, this plugin needs atomic-server
branch `claude/plugin-fediverse-host`, which pin candidate16 (`38306758`,
the `.atomic-server-ref` this plugin landed with) includes:

- `auth: atomic` on routes (the publish route): a version 2 request
  signature over method, URL and body, each proof once; `request.caller =
{ agent }`.
- `request.caller.actor` on `http-signature` routes: the signer's actor
  `id`, `inbox` and `endpoints.sharedInbox` from the document the host
  fetched to verify the key (same origin as the key only).
- `match.rels` on shared WebFinger claims, so this plugin (`self`) and the
  remoteStorage plugin can answer for the same `acct:` on one host; the host
  merges their answers.
- For the e2e only, in debug builds (release builds ignore them):
  `ATOMIC_PLUGIN_E2E_LOOPBACK_PEERS=true` lets deliveries and key fetches
  reach a peer on loopback, and `ATOMIC_PLUGIN_E2E_PEER_CA` names a CA
  certificate that is then the only trusted root for loopback peers. The
  peer's certificate is still verified, hostname included.

## Against a real Mastodon

`e2e/mastodon.spec.ts` (opt-in) runs one round trip with a real Mastodon,
through Mastodon's own client API and federation, on atomic-server built
with `plugin-routes` at `--plugin-routes read-write`:

```sh
FEDIVERSE_MASTODON_E2E=1 node integrations/tooling/run-lane.mjs fediverse --tier e2e
```

`e2e/mastodon.mjs` starts the official image `ghcr.io/mastodon/mastodon:v4.7.3`
(Puma and Sidekiq) with `postgres:17-alpine` and `redis:7-alpine`, on the
host network with every listener on 127.0.0.1 (ports 19930, 19932, 19939),
no volumes, removed afterwards. A TLS proxy in the test process on
`127.0.0.1:19943` fronts both Mastodon (`https://mastodon.localhost:19943`)
and atomic-server (`https://fedi-<run>.localhost:19943`, forwarded to the
lane's port with `Host` unchanged), with a certificate from a throwaway test
CA. Mastodon trusts only that CA (`SSL_CERT_FILE`) and is allowed to reach
loopback (`ALLOWED_PRIVATE_ADDRESSES`); atomic-server trusts it through the
lane's `ATOMIC_PLUGIN_E2E_PEER_CA` seam. Accounts are invented (`alice`,
created in Rails with an API token). Needs Docker; set
`FEDIVERSE_MASTODON_IMAGE` to try another version. The proxy, the test CA
and the HTTPS client are in `e2e/stack.mjs`, and the round trip through the
Mastodon client API is in `e2e/client-api.ts`; both are shared with the
Akkoma e2e. The proxy adds `X-Forwarded-Proto: https` to what it forwards
to atomic-server, as a TLS-terminating reverse proxy would.

**Result, 2026-10-02:** passed with Mastodon 4.7.3 (`/api/v2/instance`
`version` `4.7.3`) on atomic-server at the pin `a12b74a6` (the
`ghcr.io/ontola/atomic-server-e2e:a12b74a6…-plugin-routes` binary). Steps:

1. alice searches for the actor's URL; Mastodon fetches the actor and
   checks `news@fedi-<run>.localhost:19943` with WebFinger, and shows the
   account as a bot named after the profile resource.
2. alice follows; the host verifies Mastodon's signed Follow, the plugin
   stores the follower and queues an Accept, and Mastodon reports the
   relationship as `following: true`.
3. The drive posts through `/ap/outbox`; the host delivers the signed Create
   to Mastodon's shared inbox, and the Note is in alice's home timeline
   (`<p>Hello Mastodon, from an Atomic drive</p>`, public).
4. alice replies (without mentioning the actor); Mastodon delivers the
   Create to the actor's inbox and the plugin stores it under `replies`
   with `replyTo` the post.
5. alice unfollows; Mastodon sends `Undo(Follow)` and the follower is
   removed.

What Mastodon 4.7.3 sent and accepted, from the proxy's log (attached to the
test as `mastodon-traffic.json`):

- **Discovery.** Mastodon fetched `GET /ap/actor` (`Accept:
application/ld+json; profile="https://www.w3.org/ns/activitystreams",
application/activity+json, text/html;q=0.1`), then `GET
/.well-known/webfinger?resource=acct:news@<host>:19943` (`Accept:
application/jrd+json, application/json`, unsigned), then `GET /ap/outbox`
  and `GET /ap/followers` (`Accept: application/activity+json,
application/ld+json`). It did this again after the Follow. It made **no
  NodeInfo request** in this run. Search by handle does not work with a
  port: `@news@<host>:19943` matches no account (Mastodon's mention syntax
  has no port), so the test searches by URL.
- **Its GETs are signed** by its instance actor (`keyId=".../actor#rsa-…"`,
  draft-cavage, `algorithm="rsa-sha256"`, `headers="host date
(request-target)"`); the plugin's GET routes are `auth: none` and ignore
  that.
- **Its inbox POSTs** are draft-cavage-12 only (no RFC 9421 seen; per its
  source, Mastodon's `Request` retries with RFC 9421 only after a cavage
  attempt fails), `algorithm="rsa-sha256"`,
  `headers="host date content-type digest (request-target)"`, `Digest:
SHA-256=…`, `Content-Type: application/activity+json`, keyed by
  `https://<mastodon>/ap/users/<numeric id>#rsa-<hex>` (not `#main-key`;
  actor ids are `/ap/users/<numeric id>`).
- **`Host` has no port.** Mastodon's HTTP client sends `Host: fedi-<run>.localhost`
  for `https://fedi-<run>.localhost:19943/...`, and signs that value. The
  host binds drives by host name, so the request reaches the drive and the
  signature verifies; anything that compared `Host` with `origin` would
  refuse it.
- **HTTPS only.** WebFinger is always `https://<domain>/.well-known/webfinger`
  and Mastodon refuses private and loopback addresses unless allowed.
- **Shared inbox.** Mastodon's actor has `endpoints.sharedInbox`
  `https://<mastodon>/inbox`, so the host's deliveries (Accept, Create)
  went there, signed `headers="(request-target) host date digest"`, `Accept:
*/*`; Mastodon answered `202`. The host's key fetch of alice's actor was an
  unsigned `GET` with `Accept: application/activity+json,
application/ld+json; profile=…, application/json`, answered `200`.
- **The reply** was a `Create` of a `Note` with `inReplyTo` the post's
  object id, `attributedTo` alice, `to` Public, `cc` her followers, and no
  `tag`: Mastodon delivers a reply to the replied-to account's inbox
  without a mention.

Not tried: Mastodon with `AUTHORIZED_FETCH=true` (expected to fail the same
way GoToSocial does), other Mastodon versions, a real domain on port 443,
media, edits and deletes of posts.

## Against a real Akkoma

`e2e/akkoma.spec.ts` (opt-in) runs the same round trip (`e2e/client-api.ts`)
with a real Akkoma, through Akkoma's Mastodon client API and federation:

```sh
FEDIVERSE_AKKOMA_E2E=1 node integrations/tooling/run-lane.mjs fediverse --tier e2e
```

Akkoma publishes no current container image: the `akkoma/akkoma` tags on
Docker Hub stop in June 2024, and its Docker guide builds an image from
source. `e2e/akkoma.mjs` therefore runs its official binary distribution,
the OTP release zip (`https://akkoma-updates.s3-website.fr-par.scw.cloud/stable/akkoma-amd64-musl.zip`,
or `arm64-musl`; downloaded at each start, about 25 MB), on the official
`alpine:3.22` image, with `postgres:17-alpine`. Both run on the host network
with every listener on 127.0.0.1 (ports 19950 and 19951), no volumes, and
Erlang distribution off (`RELEASE_DISTRIBUTION=none`, so no epmd); they are
removed afterwards. The shared TLS proxy on `127.0.0.1:19953` fronts Akkoma
(`https://akkoma.localhost:19953`) and atomic-server. Akkoma's HTTP client
trusts the system CA bundle, which the container replaces with the test CA
after installing its packages. The account (`alice@invented.example`) is
registered through Akkoma's own API: registration is open, without captcha
or e-mail confirmation, on this throwaway instance only. Akkoma's fetch of a
new peer's NodeInfo is turned off (`:instances_nodeinfo`), because it drops
the port (below) and would reach whatever else listens on 127.0.0.1:443.
`FEDIVERSE_AKKOMA_RELEASE` names another release URL or a local zip;
`FEDIVERSE_AKKOMA_KEEP=1` keeps the stack for inspection.

**Result, 2026-10-02:** passed with Akkoma 3.20.1 (`/api/v1/instance`
`version` `2.7.2 (compatible; Akkoma 3.20.1-0-gbc62dd8--stable-)`; release
zip `akkoma-amd64-musl.zip`, SHA-256
`02c1db1b0a32d2f7ca4806967461f19387da0ba5186f925bc3156798aa1cc0e2`,
`Last-Modified` 2026-09-27) on atomic-server at the pin `a12b74a6` (the
`-plugin-routes` binary). The same run passed `mastodon.spec.ts` and
`fediverse.spec.ts`. Steps: alice resolves the actor's URL; follows, and
Akkoma records the follow as accepted once the Accept arrives; the Note
published through `/ap/outbox` is in her home timeline
(`<p>Hello Akkoma, from an Atomic drive</p>`, public); her reply is stored
under `replies` with `replyTo` the post; she unfollows and the follower is
removed.

What Akkoma 3.20.1 sent, and how it differs from Mastodon 4.7.3 (from the
proxy's log, attached as `akkoma-traffic.json`):

- **Actor ids.** Local actors are `https://<akkoma>/users/by-id/<flake id>`
  (`/users/<nickname>` redirects there with `301`); the shared inbox is
  `https://<akkoma>/inbox`, where the host delivered the Accept and the
  Create. Akkoma answered those deliveries `200` with
  `application/json; charset=utf-8` (Mastodon: `202`).
- **Inbox signatures.** draft-cavage, `algorithm="rsa-sha256"`, like
  Mastodon, but `headers="(request-target) content-length date digest host"`
  (`content-length` signed, no `content-type`), and keyed by the user's
  `#main-key` (Mastodon: `#rsa-<hex>` under `/ap/users/<id>`). `Digest:
SHA-256=…`, `Content-Type: application/activity+json`. No RFC 9421 seen.
  The host verified all of them.
- **Signed GETs.** Akkoma signs its fetches of the actor and `/ap/followers`
  with its instance fetch actor (`keyId="https://<akkoma>/internal/fetch#main-key"`,
  `headers="(request-target) date host"`), `Accept: application/ld+json;
profile="https://www.w3.org/ns/activitystreams", application/activity+json`.
  It did not fetch `/ap/outbox`; it fetched `/ap/followers` three times
  (on resolving, after its Follow, and after its reply).
- **WebFinger by URL, through host-meta.** After fetching the actor, Akkoma
  asks `/.well-known/host-meta` (unsigned, no `Accept`; the host answers it,
  as XRD), follows its LRDD template, and asks WebFinger for the actor's URL
  (`resource=https://…/ap/actor`, `Accept: application/xrd+xml,application/jrd+json`),
  never for the `acct:` handle. The host answers that `404`: it routes only
  `acct:` resources to this plugin (see [Known host gaps](#known-host-gaps)).
  Akkoma logs "Invalid WebFinger … Using safe fallback" and names the
  account `preferredUsername@<host of the actor id>`. On port 443 that is
  the right handle; here it is `news@fedi-<run>.localhost`, without the
  port. Mastodon asks for the `acct:` handle and keeps the port.
- **The port is dropped elsewhere too.** Akkoma's mention tag for the actor
  is `@news@fedi-<run>.localhost`, and its NodeInfo fetch of a new instance
  goes to `https://<host without port>/.well-known/nodeinfo` (seen as a
  failed TLS handshake with another service on 127.0.0.1:443 before it was
  turned off). Its search refuses a handle with a port, as Mastodon's does.
- **Other fetches.** `GET /` with `Accept: text/html`, to find the instance's
  favicon. The host's unsigned key fetch of alice's actor (`Accept:
  application/activity+json, application/ld+json; profile=…,
application/json`) was answered `200`: authorized fetch is off by default.
- **The reply** is a `Create` of a `Note` with `inReplyTo` the post,
  `to` the actor and Public, `cc` her followers, a `Mention` tag for the
  actor, `context`/`conversation` set to the post's id, plain `content`
  (no `<p>`), `contentMap` and `source`. **The Undo** embeds the whole Follow
  (with `state: "accept"`), not just its id. The plugin handled both.

No plugin change was needed for Akkoma. Not tried: Pleroma, other Akkoma
versions, Akkoma with `authorized_fetch_mode`, a real domain on port 443.

## Known host gaps

Under the atomic-server freeze these are issue drafts for atomic-server, not
pull requests:

- **Per-actor inbox paths.** The manifest's `deliver` operation is `https://*/inbox`
  and the host matches operation paths exactly, so a follower whose inbox is
  `/users/<name>/inbox` and no shared inbox at `/inbox` is refused with
  `422`. GoToSocial is expected to be one (its inboxes are per account);
  that was not checked here, because GoToSocial 0.22.1 serves actor
  documents only to signed requests.
- **WebFinger by actor URL.** A shared `webfinger` claim has one
  `resourcePrefix`, and a manifest may claim `webfinger` once, so this
  plugin gets only `acct:` resources. Akkoma 3.20.1 asks WebFinger for the
  actor's URL (`resource=https://<host>/ap/actor`) and gets `404`; it then
  falls back to `preferredUsername@<host>`, which loses a non-default port
  and logs a spoofing warning. The plugin itself answers the URL form.
- **Unsigned key fetches.** GoToSocial 0.22.1 answered an unsigned `GET` of
  an actor with `401` ("http request wasn't signed or http signature was
  invalid"), checked on 2026-10-02 against `superseriousbusiness/gotosocial:latest`
  on loopback. The host fetches signers' keys unsigned, so it cannot verify
  any request from such a server.

## Tests

```sh
node integrations/fediverse/build.mjs
node integrations/tooling/run-lane.mjs fediverse --tier node
node integrations/tooling/run-lane.mjs fediverse --tier e2e
```

The node tier checks the handler's decisions against an in-memory host. The
e2e tier runs the bundle on a real atomic-server at `--plugin-routes
read-write` against `e2e/peer.ts`, an HTTPS ActivityPub peer on loopback
with its own RSA key: discovery, a host-verified signed Follow answered by
a signed Accept that the peer verifies against the actor's published key,
refusal of unsigned, tampered and impersonating requests, a publish over
`auth: atomic` delivered as a signed Create, a reply stored in the drive,
and Undo. It is a fixture written for this test, not an independent
implementation. `e2e/mastodon.spec.ts` is the opt-in run against a real
Mastodon described [above](#against-a-real-mastodon), and
`e2e/akkoma.spec.ts` the one against a real Akkoma
([above](#against-a-real-akkoma)); interoperability with any other server,
or with either on the public internet, is **declared, not verified**.

Wire shapes follow the [W3C ActivityPub Recommendation](https://www.w3.org/TR/activitypub/),
[ActivityStreams vocabulary](https://www.w3.org/TR/activitystreams-vocabulary/),
[WebFinger (RFC 7033)](https://www.rfc-editor.org/rfc/rfc7033),
[NodeInfo 2.1](https://nodeinfo.diaspora.software/protocol.html) and
[draft-cavage-http-signatures-12](https://datatracker.ietf.org/doc/html/draft-cavage-http-signatures-12)
as Mastodon uses it. The read projection started as the Codex draft in
ontola/atomic-plugins#163; issues #137 and #135.
