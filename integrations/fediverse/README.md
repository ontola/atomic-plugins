# Fediverse

Status: **experimental; federation verified against a local peer fixture
only.** One ActivityPub actor per installation, for one Atomic drive: other
fediverse servers can find it (WebFinger), follow it (accepted
automatically), receive its public posts as signed deliveries, and send
replies, which are stored in the drive. Nothing here has been run against a
real Mastodon, GoToSocial or other fediverse server, and it needs an
atomic-server newer than the current pin (see [Host requirements](#host-requirements)).

The plugin is a QuickJS route handler (`handle(ctx, request)`, the host's
`http` trigger). It keeps no state between requests, never holds a key and
never opens a socket: followers and replies are Atomic resources it creates
under folders you choose, its key is host-held, and every outbound request
is a job in the host's durable delivery queue, signed by the host.

`plugin.js` (built from `plugin.mjs`, `sha256.mjs` and `manifest.json` by
`build.mjs`) is the release input.

## What it does

| Route (drive-host mount) | Auth | What |
| --- | --- | --- |
| `GET /.well-known/webfinger` | none | `acct:<username>@<host>` (or the actor URL) → the actor; `rel` filters links. Shared claim for `acct:` with `rels: ["self"]`. |
| `GET /.well-known/nodeinfo`, `/nodeinfo/2.1` | none | NodeInfo 2.1, `protocols: ["activitypub"]`, the number of public posts. |
| `GET /ap/actor` | none | A `Service` actor: name and summary from the profile resource, `inbox`, `outbox`, `followers`, and `publicKey` from the host-held `actor-key` (RSA-2048). |
| `GET /ap/outbox`, `/ap/objects/{id}`, `/ap/activities/{id}` | none | Public posts under `config.posts`, as `Create` activities, 10 per page, newest first. |
| `GET /ap/followers` | none (reads as the Installation) | An `OrderedCollection` with `totalItems` only: who follows is not published. |
| `POST /ap/outbox` | `atomic` (a version 2 Atomic request signature) | A configured publisher posts a Note: stored as a `Message` under `config.posts`, and a `Create` queued for each follower's inbox. |
| `POST /ap/inbox` | `http-signature`, verified by the host | Follow, Undo(Follow), Create(Note) replies, Delete. |

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
branch `claude/plugin-fediverse-host`:

- `auth: atomic` on routes (the publish route): a version 2 request
  signature over method, URL and body, each proof once; `request.caller =
  { agent }`.
- `request.caller.actor` on `http-signature` routes: the signer's actor
  `id`, `inbox` and `endpoints.sharedInbox` from the document the host
  fetched to verify the key (same origin as the key only).
- `match.rels` on shared WebFinger claims, so this plugin (`self`) and the
  remoteStorage plugin can answer for the same `acct:` on one host; the host
  merges their answers.
- For the e2e only: `ATOMIC_PLUGIN_E2E_LOOPBACK_PEERS` in debug builds, which
  lets deliveries and key fetches reach a peer on loopback with a
  self-signed certificate.

## Tests

```sh
node integrations/fediverse/build.mjs
node integrations/tooling/run-lane.mjs fediverse --tier node
ATOMIC_SERVER_ROUTES_BINARY=<a claude/plugin-fediverse-host build> \
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
implementation: interoperability with real servers is **declared, not
verified**.

Wire shapes follow the [W3C ActivityPub Recommendation](https://www.w3.org/TR/activitypub/),
[ActivityStreams vocabulary](https://www.w3.org/TR/activitystreams-vocabulary/),
[WebFinger (RFC 7033)](https://www.rfc-editor.org/rfc/rfc7033),
[NodeInfo 2.1](https://nodeinfo.diaspora.software/protocol.html) and
[draft-cavage-http-signatures-12](https://datatracker.ietf.org/doc/html/draft-cavage-http-signatures-12)
as Mastodon uses it. The read projection started as the Codex draft in
ontola/atomic-plugins#163; issues #137 and #135.
