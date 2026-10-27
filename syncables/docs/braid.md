# SyncD's read-only Braid interface

SyncD can serve accepted PostgreSQL collection snapshots over Braid-HTTP.
An ordinary GET returns the current snapshot; a subscription follows accepted
revisions. The listener uses `braid-http` 1.4.10's HTTP multiresponse framing
and works with its unmodified Node/browser client. This is an experimental
read-only subset, not a general writable Braid server.

The `syncables braid` command runs separately from `syncables daemon`. Run
both to follow ongoing provider ingestion, or run only Braid to serve existing
snapshots while offline. Braid never fetches providers, logs in, signs Atomic
commits, updates working folders or changes the stored head. PostgreSQL is
authoritative; Git and the Atomic adapter are independent.

This feature is in current source, not the published npm release. Follow the
[daemon build instructions](daemon.md#build-and-try-invented-data) first.

## Start the listener

Use the same `SYNCABLES_DATABASE_URL` and daemon config as your stored data.
Explicitly select the collection aliases this listener may serve. Generate
a dedicated reader token, and keep it out of source control and URLs:

```sh
export SYNCABLES_BRAID_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"

syncables braid --config /absolute/path/config.json \
  --collections github-issues/example/tasks \
  --braid-port 9888
```

For a source build without a linked executable, replace `syncables` with
`node build/src/cli/main.js` from the package directory. The command prints
the selected aliases and resource URLs, never the token. It listens only on
`127.0.0.1`; use the printed address, including its numeric host. SIGINT or
SIGTERM closes subscriptions and the database pool. No service is installed.

The token must contain 32–256 printable non-space ASCII characters. It grants
read access to every collection explicitly selected by this process. Use a
different listener/token for a different selection of readers or collections.
Restart the process with a new token to revoke the old one and close its
existing streams. Provider tokens and owner signing keys are not Braid tokens.

Collection scopes are derived from the config and pinned OpenAPI/profile
bytes at startup, as for source syncing. Changing that scope requires a
restart and a new initial snapshot; old versions do not cross into it.

## Read or subscribe

The resource path is `/collections/` followed by the URL-encoded complete
`platform/account/collection` alias. For example:

```sh
curl -i \
  -H "Authorization: Bearer $SYNCABLES_BRAID_TOKEN" \
  'http://127.0.0.1:9888/collections/github-issues%2Fexample%2Ftasks'

curl -N \
  -H "Authorization: Bearer $SYNCABLES_BRAID_TOKEN" \
  -H 'Subscribe: ?1' \
  'http://127.0.0.1:9888/collections/github-issues%2Fexample%2Ftasks'
```

GET returns HTTP 200, `Content-Type: application/json`, a quoted `Version`
token and the causal `Parents`. A subscription returns HTTP 209 with
`Content-Type: application/http-history` and full-body updates framed by
`braid-http`. `Subscribe: true` is also accepted for older clients. No patches
or multiplexing are supported; use `multiplex: false` with Braid clients.
Optional `Heartbeats: 1s` through `60s` is supported (integer seconds without
the suffix are also accepted); idle streams otherwise receive a heartbeat
every 15 seconds.

Each body has this shape, using invented data:

```json
{
  "format": "syncd-braid-collection-v1",
  "collection": "github-issues/example/tasks",
  "revision": "<PostgreSQL snapshot revision ID>",
  "resources": {
    "urn:example:issue:1": "{\"@id\":\"urn:example:issue:1\",\"urn:example:amount\":9007199254740993123.00100}",
    "urn:example:issue-class": "{\"@id\":\"urn:example:issue-class\",\"urn:example:label\":\"Issue\"}"
  }
}
```

The `resources` object maps subject IRIs to **JSON-AD text strings**, including
bundled schemas. This preserves the stored numeric lexemes through a normal
JSON parse of the envelope. Parse the inner text only with a parser suitable
for the precision your application requires. Whitespace follows the stored
JSON graph's renderer; this is not a replay of original HTTP response bytes.
Internal snapshot context, provider cursors, connection configuration and
response archives are not part of this representation.

A body is a complete collection view at one immutable revision. Replace the
previous view only after applying the entire body. An absent subject means
it is absent from that view, not that the provider has globally deleted it.
Older PostgreSQL snapshots retain earlier values and membership. An incomplete
or failed source read never appears as a new accepted Braid snapshot.

## Resume and reset

Save an update's `Version` only after your application has applied its body.
Reconnect with that single quoted token in `Parents`. The server replays
every subsequent revision in order along the current single-parent history,
then follows new heads. If the client is already current, the stream waits
without repeating that body. Polling the durable head every second also
detects changes published during subscription setup or by another process.
No separate in-memory publication queue is required for restart recovery.

Versions are scoped to the collection alias, source scope and representation
format. Treat them as opaque; they are neither raw JSON hashes nor Git commit
IDs. Reappearing values can have different versions. An ordinary GET with a
`Version` header retrieves that accepted historical revision within the same
bounded current ancestry.

An unknown version, changed scope, merge/divergent history, or a replay gap
longer than 256 revisions returns **HTTP 409 with `Braid-Reset: true`** before
opening a stream. Discard the resume token and request a new full snapshot
without `Parents`. This recovers current state; it does not promise replay of
every historical transition across that gap. A live stream interrupted by a
history change closes; the next request makes the reset requirement explicit.

This example uses the unmodified `braid-http` client from an application that
has installed it. Replace the endpoint with the printed URL:

```js
import { fetch as braidFetch } from 'braid-http';
import { setTimeout as delay } from 'node:timers/promises';

const endpoint = 'http://127.0.0.1:9888/collections/github-issues%2Fexample%2Ftasks';
let parents = []; // Restore your last durably applied Version here.
for (;;) {
  const response = await braidFetch(endpoint, {
    subscribe: true,
    parents,
    multiplex: false,
    retry: false,
    headers: { Authorization: `Bearer ${process.env.SYNCABLES_BRAID_TOKEN}` },
  });
  if (response.status === 409 && response.headers.get('Braid-Reset') === 'true') {
    await response.body?.cancel();
    parents = [];
    continue;
  }
  if (response.status !== 209) {
    throw new Error(`Braid returned ${response.status}`);
  }
  try {
    for await (const update of response.subscription) {
      const snapshot = JSON.parse(update.body_text);
      console.log(snapshot.revision, Object.keys(snapshot.resources).length);
      // In a real app, persist/apply snapshot before advancing this cursor.
      parents = update.version;
    }
  } catch {
    // A closed connection keeps the last successfully applied cursor.
  }
  await delay(1000);
}
```

## Access and limits

Every read/subscription requires the bearer token. No browser origin is
allowed by default. To allow one reader application, start with
`--braid-origin https://reader.example`: this enables exact-origin CORS GET
preflights and exposes version headers, while still requiring the token.
Cookies are not authentication and credentialed CORS is not enabled. An HTTPS
browser's local-network or mixed-content policy may additionally restrict
loopback HTTP; this feature does not configure browser policy or a TLS proxy.

The listener admits at most 16 simultaneous readers, limits each encoded
snapshot to 32 MiB, and closes a client that cannot drain an update within
five seconds. Only revision IDs are retained while planning a replay; bodies
are reconstructed and sent one at a time. There is no unbounded per-client
update queue. Database failure closes an active stream; reconnect with the
last applied version after recovery. GET failures return a generic HTTP 503
without database connection details. A collection with no accepted head is 404;
an oversized initial body is 413 and exhausted reader capacity is 503.

PUT, PATCH, POST and DELETE are rejected with 405. Writable Braid, per-record
URLs, patch formats, multiple-parent resume frontiers and provider writeback
remain later work. Git import/export and native AtomicSync have their own
representations and checkpoints; serving this interface does not implement
either protocol on Braid URLs.
