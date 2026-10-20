# Standalone Syncables: local Git experiment

This source branch adds a read-only standalone daemon to the existing
`syncables` executable. It stores original API response text and lossless,
content-addressed nested JSON nodes in a separate local PostgreSQL database.
The [JSON graph format and fixed vectors](json-graph-v1.md) define its persisted
node encoding. Its local data copy and bundled schemas live in a private bare Git
repository. [Versioned Atomic Data](../../docs/design/versioned-atomic-data.md)
defines the experiment and commit/tag resolution contract.

This implementation is unreleased. It reuses #567's CLI/archive work without
changing that draft branch. Device authorization uses the deployed
[integration-proxy contract](../../integration-proxy/DEVICE_AUTH.md). Owner
signing stays in the existing laptop bridge; the daemon receives device tokens.
The October 16 live GitHub read verified that protocol. The new daemon and
macOS Keychain adapter still need a laptop run against the deployed issuer.

## Build and try invented data

Requirements: Node 22.11+, Git 2.29+ with SHA-256 repositories, and a separate
local PostgreSQL database (tested with PostgreSQL 17). Nothing installs a
background service or changes Heroku configuration.

```sh
git clone --branch codex/syncables-daemon \
  https://github.com/ontola/atomic-plugins.git atomic-plugins-daemon
cd atomic-plugins-daemon/syncables
npm ci
npm run build:release
createdb syncables_local
export SYNCABLES_DATABASE_URL='postgresql://localhost/syncables_local'
npm run cli:mock
```

If local PostgreSQL requires authentication, supply the connection URL through
your environment/secret manager. It is restricted to loopback or local sockets.
Keep the database separate from integration-proxy and your Atomic server.
In a second terminal in the same package, set that database environment variable
and run:

```sh
node build/src/cli/main.js sync --config examples/daemon/config.demo.json --interactive
```

Open the printed mock approval URL and enter the displayed code. This grants
access only to invented data. The command prints a Git revision and record
count. `--interactive` keeps tokens in memory and works without macOS Keychain.
It requires a fresh explicit approval for every foreground process.

```sh
node build/src/cli/main.js browse --config examples/daemon/config.demo.json
node build/src/cli/main.js browse github-issues --config examples/daemon/config.demo.json
node build/src/cli/main.js browse github-issues/example/tasks --config examples/daemon/config.demo.json
node build/src/cli/main.js browse github-issues/example/tasks/1 --config examples/daemon/config.demo.json
node build/src/cli/main.js history 1 --collection github-issues/example/tasks --config examples/daemon/config.demo.json
```

Keep the configured `local-data.git` directory and PostgreSQL data private and
outside your source checkout for real use. The demo directory is gitignored.
There is no automatic pruning of response logs, inbox deliveries or Git history.

## Configure real collections

Copy the demo config and its composed OpenAPI document into a private directory.
Replace `owner`, `connection`, `issuer`, `clientId`, account labels and parent
bindings with your existing approved owner/connection. Use issuer
`https://localthought.io` and public client `syncables-cli`. Discover the owner
and approved connection IDs with the existing `auth-test` command in the
[CLI guide](cli.md); those identifiers are not owner keys.

Paths in the config resolve relative to the config file. Restart the foreground
daemon after editing its config or composed documents. Each collection has:

| Field | Meaning |
| --- | --- |
| `platform/account/name` | Three local labels forming its CLI selector. `platform` must match the approved connection. |
| `connection` | Existing integration-proxy connection ID. |
| `document` | Local composed OpenAPI JSON/YAML file with CRUD collection metadata and pagination. |
| `collection` | Unique collection name in `components.crudResources`. |
| `bindings` | Explicit parent path variables; this pilot does not recursively discover accounts/parents. |
| `query` | Declared query parameters. Fixed collection values and paging/checkpoint controls cannot be replaced. |
| `pollSeconds` | Default 300; 5–86400 for polling, 0 for initial fetch plus webhook/manual triggers. |

`dataDirectory` selects the private Git data repository. Config changes to
owner, connection, collection definition, bindings or query create a separate
data scope and bootstrap it. Changing a local label or poll interval does not
change source identity. This pilot caps config at 100 collections, each read
at 5,000 records/1,000 requests/120 seconds, each response at 8 MiB and a Git
snapshot at 16 MiB. Incomplete reads retain the previous published snapshot.

On macOS, with the existing approval bridge running:

```sh
syncables login --config /absolute/path/config.json
syncables sync --config /absolute/path/config.json
syncables sync --config /absolute/path/config.json --collections github-issues/work/issues
syncables daemon --config /absolute/path/config.json
syncables status --config /absolute/path/config.json
syncables logout --config /absolute/path/config.json
```

Use `node build/src/cli/main.js` instead of `syncables` when running from source.
`login` saves device access/refresh tokens in macOS Keychain, never in Git,
PostgreSQL, config or argv. Background runs reload them and serialize refresh
rotation through a PostgreSQL lock. A non-secret guard commits before refresh
and clears after the rotated credentials are saved. A crash or uncertain
response requires another explicit login, even if Keychain refuses deletion.
A foreground in-memory grant cannot unblock stale saved credentials. `logout` removes local credentials and
revokes the device session; revocation failure is reported. No owner key is
requested. Persistent credential storage on other operating systems is deferred;
`--interactive` remains available for foreground experiments.

The daemon runs in the foreground until SIGINT/SIGTERM. A second daemon for
the owner refuses to start. One-shot and daemon reads share collection locks;
a concurrent one-shot reports an already-running collection. Losing the daemon's
database lock stops it, so restart after PostgreSQL recovers. Automatic launchd
installation, IPC/attaching to a running job, and service management are deferred.

## Incremental behavior and local history

For a declared `incrementalSync` scheme this daemon supports one query
`syncToken`, normal page-token traversal, and one terminal `nextSyncToken` in
the body or headers. Bootstrap reads a full snapshot; subsequent reads apply
returned observations and declared list tombstones. Data and checkpoint publish
in the same Git commit after responses are durable. Missing terminal tokens,
failed pages and interruptions never advance the checkpoint. HTTP 410 on a
saved token retries a fresh bootstrap once. A new device session bootstraps.
Only use this with a provider contract that guarantees complete changes and
configured deletion markers; omission from a delta is not deletion.

Other supported GET collections perform explicit **full reconciliations** on
each trigger. Hash deduplication saves storage, not network calls. Range-window
coverage, timestamp/high-water incremental strategies, conditional collection
fetches, deletion feeds and time-zone conversion are deferred. Library readers
still reject `incrementalSync`; the standalone adapter implements this subset.
Declared blocked responses pause automatic reads until a new trigger/manual run;
retry deadlines survive the failed read in scheduling state. Backoff is per
collection in this pilot; shared quota pacing across collections is deferred.

All source records are projected as JSON-AD: stable `@id`, a source-record class,
a string source ID, and original JSON in `urn:syncables:property:source-json`.
Three class/property definitions are stored alongside them in every snapshot.
This preserves original numeric text, including integers beyond JavaScript's
safe range. Typed provider lenses, full core-schema closure import and semantic
schema validation are deferred. Missing schema resources are explicit errors;
the resolver never fetches a newer schema silently.

Each browse resolves head once and returns a `commit`. Reuse it with `--at`
for subsequent pages, items and schemas, or create a collection-scoped tag:

```sh
syncables tag baseline --collection github-issues/work/issues --config /path/config.json
syncables browse github-issues/work/issues --at tag:baseline \
  --filter '/state="open"' --order-by '/number:desc' --page 1 --page-size 50 \
  --config /path/config.json
syncables resource urn:syncables:class:source-record \
  --collection github-issues/work/issues --at tag:baseline --config /path/config.json
```

`--at` accepts a full 64-character commit or `tag:NAME`. Tags cannot be moved
through this CLI. `resource IRI` fetches any resource or schema in that scope;
`history [ITEM_ID]` lists revision commits, including removal. Browse item IDs
containing `/` must be percent-encoded in the final path component. Filtering
uses a JSON Pointer and scalar equality against the original source JSON;
ordering uses a pointer and optional `:asc`/`:desc`, then stable subject order.
Types sort by type name; missing values sort as `undefined`. Filtering/ordering
unsafe numeric values is refused; returned resource text remains lossless.

## Queued webhooks

A tunnel such as localtunnel exposes a receiver but does not provide a durable
queue while the laptop sleeps. Hookdeck and Webhook Relay offer hosted webhook
capture/queueing and delivery to a local client; confirm current retention,
retry and plan limits when configuring one. No hosted relay is required for
polling, and no relay account is provisioned by this implementation.

Set `webhookPort` in config and inject a random secret of at least 32 characters
as `SYNCABLES_WEBHOOK_TOKEN`. The daemon listens only on `127.0.0.1`. Configure
your trusted relay to verify provider signatures, preserve a stable delivery ID,
route the collection and add the shared Bearer secret:

```text
POST /webhooks/github-issues%2Fwork%2Fissues
Authorization: Bearer <SYNCABLES_WEBHOOK_TOKEN>
x-syncables-delivery-id: <stable relay/provider delivery ID>
```

The receiver does not directly validate provider signatures or register provider
subscriptions. Its authentication contract is a trusted, authenticated relay.
Do not expose it as an unauthenticated provider receiver. Request bodies are
limited to 1 MiB and archived as hints, never applied directly as data. A 204
acknowledges the committed PostgreSQL inbox entry and scheduling update.
Redeliveries are deduplicated per owner/collection/delivery ID. Hints arriving
during a read remain pending for another read; polling reconciles missed hints.
The relay must retry non-2xx responses and queue while the laptop is offline.

Remote Atomic, remoteStorage, NextGraph, Jazz and atproto destinations remain
planned, as do outgoing writes/outbox and promotion of the local copy to an
authoritative source. The existing replication commands save configuration only.
