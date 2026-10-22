# Standalone Syncables: local Git experiment

The source implementation adds a read-only standalone daemon to the existing
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

On a Mac using Homebrew, install/start PostgreSQL and add its tools to the
current terminal's path first. This supplies `createdb` if your shell cannot
find it:

```sh
brew install postgresql@17
brew services start postgresql@17
export PATH="$(brew --prefix postgresql@17)/bin:$PATH"
```

```sh
git clone --branch main \
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

The implementation from PR #675 is now on `main`. If you cloned its earlier
feature branch, update the source before trying real providers. From the
repository root:

```sh
git switch main
git pull --ff-only
cd syncables
npm ci
npm run build:release
```

### Copy the two files

Yes: the demo config is `examples/daemon/config.demo.json`, and its OpenAPI
document is `examples/daemon/github-issues.json`. Here, "composed OpenAPI
document" means the API description already contains the collection identity
and paging metadata the daemon needs. The supplied small GitHub document is
ready to use; you do not need to download or compose a full GitHub specification.

Use a directory outside the source checkout for real data, for example
`$HOME/.local/share/syncables-live`. Run these commands from the checkout's
`syncables/` directory, the directory containing its `package.json`:

```sh
mkdir -p "$HOME/.local/share/syncables-live"
chmod 700 "$HOME/.local/share/syncables-live"
cp -n examples/daemon/config.demo.json "$HOME/.local/share/syncables-live/config.json"
cp -n examples/daemon/github-issues.json "$HOME/.local/share/syncables-live/github-issues.json"
chmod 600 "$HOME/.local/share/syncables-live/"*.json
```

`cp -n` preserves any copies you have already edited. Keep both files together.
The config's `"document": "./github-issues.json"` resolves relative to the config
file, as does `"dataDirectory": "./local-data.git"`. The resulting layout is:

```text
~/.local/share/syncables-live/
  config.json             your edited config
  github-issues.json      GET collection/pagination description
  local-data.git/         created by sync; resources, schemas and history
```

`./data` at the repository root also works. Ignore it in Git before saving real
data there (for example, put `/data/` in `.git/info/exclude`), and set permissions
to 700. Check with `git check-ignore data/config.json` from the repository root.
Do not commit its config, copied documents, responses or nested Git repository.
The PostgreSQL response archive is separate and stays at the database selected
by `SYNCABLES_DATABASE_URL`; it is not placed in this directory.

### Connect and edit the copied config

With your existing local owner approval bridge running, list the connections
you approve for this test. This step needs no PostgreSQL connection and makes
no provider API call:

```sh
node build/src/cli/main.js auth-test \
  --issuer https://localthought.io --client-id syncables-cli \
  --scope 'connections:read proxy:read'
```

Open the complete approval link printed by the CLI and compare its user code
with the terminal. At `localthought.io/device`, click **Continue to owner
approval** to open the configured local bridge, normally
`http://127.0.0.1:11873/`. The public `/device` page is an instruction/link page,
not a form; the local bridge has the **User code** input and **Review request**
button. If the code is not prefilled, paste it there, review the client/scopes,
select the existing GitHub connection and approve. If the bridge cannot load,
restart your existing owner bridge in the authenticated local worker; the CLI
does not start it or need the owner's key. An expired request requires a new
CLI login attempt.
The output includes `owner` and each approved connection's `connection_id` and
`platform`. These identifiers are not owner keys or access tokens. Copy them
into `config.json`; keep credentials and owner signing keys out of that file.
For the previously tested `ontola/usertest-findings` repository, change:

| Config field | Value for the real GitHub test |
| --- | --- |
| `owner` | `owner` from connection discovery |
| `issuer` | `https://localthought.io` |
| `clientId` | `syncables-cli` |
| `collections[0].connection` | Approved `github-issues` connection ID |
| `collections[0].account` | `ontola` (local account label) |
| `collections[0].name` | `usertest-findings` (local collection label) |
| `collections[0].bindings` | `{"owner":"ontola","repo":"usertest-findings"}` |
| `collections[0].pollSeconds` | `0` for manual tests first |

Keep `platform` as `github-issues`, `document` as `./github-issues.json`,
`collection` as `issues` and `query` as `{"per_page":"100"}`. The profile's
fixed query reads `state=all`, so the list includes closed issues and pull
requests. Substitute your own namespace/repository in the labels and bindings
to test another repo. Its GitHub App installation must include that repository.
The top-level `owner` is your Atomic owner ID from discovery;
`bindings.owner` is the GitHub namespace, such as `ontola`.

In the same terminal, define a helper that selects the real config instead of
the demo config. This replaces the earlier demo `cli` shell function:

```sh
export SYNCABLES_DATABASE_URL='postgresql://localhost/syncables_local'
cli() {
  node build/src/cli/main.js "$@" \
    --config "$HOME/.local/share/syncables-live/config.json"
}
cli sync --collections github-issues/ontola/usertest-findings --interactive \
  --message "First snapshot of the real repository"
cli browse github-issues/ontola/usertest-findings
cli history --collection github-issues/ontola/usertest-findings
```

This fetches the configured collection, not just one page. To check access
before that full fetch, use `auth-test --path` as shown in the [CLI guide](cli.md).
`--interactive` uses a fresh approval for each foreground process. After the
first successful read, use `cli login` to save a separately approved session in
macOS Keychain and run `cli sync`/`cli daemon` without `--interactive`.

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

## Add a Google Keep trial

Use the same daemon and private config directory. A Google Keep provider
connection must already exist at `localthought.io`, under the same Atomic owner
as your GitHub connection. The device approval page must offer it for selection.
Google Keep API access is for a Google Workspace account; use the account that
owns the notes you intend to read. The CLI's `connections:read proxy:read`
grant is separate from the Google OAuth authorization held by the proxy.

If no Keep connection is available, connect the account using the existing
Google Keep Drive app (`Integrations → Drive apps → Show experimental plugins`,
install Google Keep, then `Connect Google Keep`). Keep "Send edits to Google
Keep" off. If the platform is unavailable or OAuth configuration is missing,
the authenticated local worker must finish the provider setup first: Keep API
enabled, Workspace authorization, the `OAUTH_GOOGLE_KEEP_CLIENT_ID` and
`OAUTH_GOOGLE_KEEP_CLIENT_SECRET` server settings, redirect
`https://localthought.io/oauth/google-keep/callback`, and a catalog containing
`google-keep`. Preserve existing platforms when selecting a catalog. No owner
key or Google client secret belongs in the daemon config. This guide does not
establish that the deployed Keep setup has been completed.

Once the connection exists, rerun the connection-discovery command above and
approve Keep. From the checkout's `syncables/` directory, copy its GET-only
collection description:

```sh
cp -n examples/daemon/google-keep.json "$HOME/.local/share/syncables-live/google-keep.json"
chmod 600 "$HOME/.local/share/syncables-live/google-keep.json"
```

Append this object to `collections` in the private `config.json`, replacing the
connection placeholder with the approved `google-keep` connection ID:

```json
{
  "platform": "google-keep",
  "account": "workspace",
  "name": "notes",
  "connection": "REPLACE_WITH_APPROVED_GOOGLE_KEEP_CONNECTION_ID",
  "document": "./google-keep.json",
  "collection": "notes",
  "bindings": {},
  "query": { "pageSize": "100" },
  "pollSeconds": 0
}
```

To probe one page before importing the account's full note collection, approve
the Keep connection for this command (select it explicitly with `--connection`
if you approve multiple connections):

```sh
node build/src/cli/main.js auth-test \
  --issuer https://localthought.io --client-id syncables-cli \
  --scope 'connections:read proxy:read' \
  --path '/v1/notes?pageSize=1'
```

This prints status and response size, not note contents. A successful device
login alone does not establish successful Google API access. Using the real
`cli` helper defined above, fetch and inspect:

```sh
cli sync --collections google-keep/workspace/notes --interactive \
  --message "First read-only Google Keep snapshot"
cli browse google-keep/workspace/notes --filter '/title="My test list"'
cli history --collection google-keep/workspace/notes
```

Replace `My test list` with the title you want to inspect. The title filter is
a local browse filter: the sync reads all pages of the
approved account's default non-trashed note collection and archives their
responses. Keep's API cannot limit list results by title. Its `name` field
(`notes/NOTE_ID`) is the stable item ID. For one note's history, pass that whole
ID: `cli history 'notes/NOTE_ID' --collection google-keep/workspace/notes`.
For item browsing, encode its slash in the path:
`cli browse google-keep/workspace/notes/notes%2FNOTE_ID`. Resource/schema pinning
and intent messages work exactly as for GitHub.

The profile follows `nextPageToken`, including after a short or empty page,
and accepts Google's omitted `notes` field as an empty array. Malformed fields,
failed pages and interrupted reads do not publish a partial snapshot. Each
manual fetch is a full reconciliation. List bodies and attachment metadata are
kept within the note's original JSON; attachment files are not downloaded.
The daemon makes GET requests only and does not apply the Drive app's two-way
mapping or replace/edit/delete Keep notes.

For a second history entry, make an intentional change to a chosen issue/note
in its provider UI, then rerun that collection's `cli sync --interactive` with
a new `--message`. The daemon observes that change; it never performs it.
Inspect `cli history ITEM_ID --collection ...` and use `--at FULL_COMMIT_ID`
to compare the old and new local resources. After Keychain login, omit
`--collections` to fetch both configured collections in one run. Select both
connections when approving `cli login`; adding a config entry does not extend
an existing session's connection grant. Starting
`cli daemon` with `pollSeconds: 0` does not add periodic polling; change the
desired collection to 300 and restart to poll it every five minutes.

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

## Browsing history and recording intent

Collection history includes every published snapshot. Item history filters by
the item's stable subject; use `--subject IRI` instead of an item ID to inspect
any resource or schema. All history commands return a pinned `commit`, the
existing `revisions` list, and `entries` with commit ID, parent IDs, author
timestamp (`date`) and full commit message. `--at` limits history to that
snapshot and its ancestors. Dates describe local commits, not provider edits.

```sh
syncables history --collection github-issues/example/tasks --config /path/config.json
syncables history 1 --collection github-issues/example/tasks --config /path/config.json
syncables history --subject urn:syncables:class:source-record \
  --collection github-issues/example/tasks --config /path/config.json
syncables resource urn:syncables:class:source-record --at FULL_COMMIT_ID \
  --collection github-issues/example/tasks --config /path/config.json
syncables browse github-issues/example/tasks/1 --at FULL_COMMIT_ID \
  --config /path/config.json
```

When running from source, replace `syncables` with
`node build/src/cli/main.js`. For the demo, use
`examples/daemon/config.demo.json` as the config path.

Record your reason for a fetch with `--message`:

```sh
syncables sync --config /path/config.json \
  --message "Capture a baseline before experimenting with the schema"
syncables daemon --config /path/config.json \
  --message "Keep my selected work collections available offline"
```

The supplied text appears under `Intent (user supplied)` in each successful
snapshot's Git commit message. A daemon's message applies to every successful
snapshot made by that process; it is not saved as configuration. Messages
accept multiline text up to 8192 UTF-8 bytes. They remain in local Git history,
so keep credentials out of them. A default summary and generated trailers record
the collection alias, manual/scheduled trigger, archive run ID, full/bootstrap/
delta strategy and resulting record count. Scheduled means the scheduler chose
the run: polling, startup, retries and queued webhook hints can coalesce; it
does not identify an individual webhook. A direct library call is marked
`direct`. Existing commits retain their original messages without rewriting.

This is intent provenance attached to successful observations. It is not an
event-sourced command log: failed/cancelled requests have archive/job evidence
but no successful Git snapshot, and messages are not executable instructions
or proof of a provider-side change. The archive run ID links to local response
evidence (`syncables cache replay --owner OWNER --run RUN_ID`). A full unchanged
fetch still records its new run context. For direct `GitAtomicStore` users, an
explicit `AtomicSnapshot.message` also creates a commit when the tree is
unchanged; without a message, identical trees reuse the previous commit.
Intent-only commits appear in collection history, while resource/schema history
shows commits that changed that subject's content or presence. Bundled schemas
usually have only their initial revision until their definitions change.

The configured `dataDirectory` is a bare Git repository, so ordinary Git tools
can inspect it without a checkout:

```sh
git --git-dir=/absolute/path/local-data.git log --all --date=iso --format=fuller
git --git-dir=/absolute/path/local-data.git show --stat FULL_COMMIT_ID
git --git-dir=/absolute/path/local-data.git diff OLD_COMMIT_ID NEW_COMMIT_ID
git --git-dir=/absolute/path/local-data.git show FULL_COMMIT_ID:context.json
```

Use the full 64-character IDs returned by the CLI. `log --all` includes every
collection scope; the CLI selects the configured collection for you. Resource
filenames hash their subject IRIs, so the CLI is the easier way to select one.
Inspect the repository read-only; leave its refs and files under daemon control.

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
