# Local PostgreSQL cache and replay

This second stage of #566 adds opt-in local storage to the existing CLI and an
additive Node-only `syncables/postgres` entry point. The request/response archive
is on the user's laptop, **not at localthought.io**. Root and browser imports
do not load PostgreSQL or Zstandard and do not connect to a database.

## Prepare the source

From the scaffold branch's `syncables/` directory:

```sh
git pull --ff-only
npm ci
npm run build:release
```

Node 22.11 or newer works; CI tests Node 22, 24 and 26 with PostgreSQL 17.

## Create a separate local database

If you already run local PostgreSQL, create a dedicated database and set
`SYNCABLES_DATABASE_URL` to it. The CLI creates only the `syncables_cache`
schema inside that database. It does not install or start PostgreSQL.

One macOS/Homebrew setup is:

```sh
brew install postgresql@17
brew services start postgresql@17
"$(brew --prefix postgresql@17)/bin/createdb" syncables_cli
export SYNCABLES_DATABASE_URL=postgresql://localhost/syncables_cli
node build/src/cli/main.js cache init
```

Run the database-creation step once. If your role uses a password, supply the
connection URL through your usual secret/environment configuration; do not put
it in command arguments, replication definitions or committed files. The CLI
accepts loopback or local Unix-socket PostgreSQL destinations, checks schema
version and performs initialization under a transaction/advisory lock.

## Record a read and observe a cache hit

Start the same mock from the first stage in terminal 1:

```sh
npm run cli:mock
```

In terminal 2, set the database variable above and run:

```sh
node build/src/cli/main.js auth-test \
  --issuer http://127.0.0.1:11872 \
  --client-id syncables-cli-demo \
  --path '/repos/example/tasks/issues?per_page=1' \
  --archive --repeat 2 --max-age 60
```

Approve the displayed device code as before. The first response reports
`origin: upstream`, the second `origin: cache`, and the command prints the
completed archive run ID and owner. Tokens remain in memory; PostgreSQL holds
data and public identity references, not the Local Thought token.

The mock's invented response is repetitive enough to demonstrate compression.
Inspect owner-scoped runs and storage:

```sh
node build/src/cli/main.js cache runs --owner atomic:agent:demo
node build/src/cli/main.js cache stats --owner atomic:agent:demo
```

`payloads`, `raw_bytes` and `stored_bytes` are decimal strings so byte totals
remain exact. Identical payloads share one compressed body within an owner;
request attempts and cache hits still have separate history records.
These byte totals count payloads, not PostgreSQL metadata, indexes or WAL.

## Replay with the API offline

Stop the mock with Ctrl-C. Open another terminal, set the same local database
variable, and use the completed run ID:

```sh
node build/src/cli/main.js cache replay \
  --owner atomic:agent:demo --run '<completed-run-id>'
```

This reproduces recorded response statuses and body sizes without a token or
upstream connection. Bodies are decoded only in memory. The library transport
returns the actual recorded text and headers, so Syncables can reconstruct
collections by paging through the same recorded request sequence.

An unfinished/failed run, missing payload, mismatched request or mutation fails
explicitly. A recorded HTTP error remains an HTTP error; a recorded transport
failure is replayed as a failure. A completed **run** means its request trace was
durably finished, not that an arbitrary provider collection was complete.

## Use the transport from the library

```ts
import { readCollections } from 'syncables';
import {
  PostgresArchive,
  createCachingTransport,
  createReplayTransport,
} from 'syncables/postgres';

const archive = new PostgresArchive(process.env.SYNCABLES_DATABASE_URL!);
await archive.initialize();
const scope = {
  owner: verifiedOwner,
  connection: approvedConnectionId,
  authorizationContext: grantRevision,
};
const run = await archive.createRun(scope, 'Refresh issue collection');
const transport = createCachingTransport({
  archive, scope, run, upstream: authenticatedProviderTransport,
  mode: 'live',
});
const result = await readCollections(document, { transport });
await archive.finishRun(scope.owner, run, result.errors.length === 0);

const replay = await createReplayTransport({ archive, owner: scope.owner, run });
const reconstructed = await readCollections(document, { transport: replay });
await archive.close();
```

The caller supplies trusted owner/connection/grant context; local PostgreSQL
credentials grant access to the private archive. This is application-level
namespace isolation, not a public multi-tenant database endpoint. Replay has no
upstream transport and accepts only the next matching bodyless GET.

## Storage and recovery behavior

- Immutable payloads are UTF-8 text, SHA-256-deduplicated per owner and Zstandard
  level 3 compressed when beneficial; tiny/uncompressible bodies stay plain.
  Checksums, stored sizes and frame content size are checked before hydration.
  The default maximum body size is 8 MiB.
- Runs and individual attempts are durable. An attempt is recorded before
  dispatch and its response/payload/cache-head update commits before returning
  data to Syncables. A crash or storage failure can leave an explicit pending
  attempt and recording run, rather than a silently applied response.
- Cache keys include owner, connection, authorization context, full URL/method
  and non-credential request headers. Conditional headers are kept in replay
  identity but excluded from representation identity. They always reach upstream.
  Freshness checks read metadata only; a stored body is decompressed when it is
  actually served or replayed, rather than on every cache miss/live refresh.
- A raw 304 retains its empty body; when an ETag/If-None-Match matches the stored
  200 response, its effective body reference is recorded separately. A missing
  matching body remains unresolved; it is never fabricated.
- Refreshes use expiring PostgreSQL leases without holding a transaction across
  the network request. A late worker cannot overwrite a newer cache head or
  release another worker's lease. Independent requests can execute in parallel.
- Live mode fetches/revalidates; simultaneous identical refreshes can share the
  newly fetched response. Cache mode requires an explicit acceptable age.
  `no-store`, `no-cache`, `Vary: *` and credential-varying responses are not served
  as fresh cache hits. Private opt-in history still records those responses.

## Current stage limits

- Bodyless GETs only. POST-based reads and writes are refused; outgoing durable
  mutation intent will be added in the PostgreSQL outbox stage.
- Tokens are still command-local. Each CLI login uses a new authorization
  context, so fresh cache hits are demonstrated within that invocation. Old runs
  remain replayable. Cross-login cache reuse needs a stable verified grant
  revision or an explicit revalidation policy after #565's contract is ready.
- Exact ordered run replay; collection definitions, range coverage and mapping
  checkpoints are the next layer. This does not promise a provider-wide snapshot.
- No retention/garbage collection yet, so this is a bounded dogfooding stage.
- Existing Syncables pacing/budgets still count transport calls, including cache
  hits. The daemon and cache-result accounting extension come later.
- Replication definitions still configure only Atomic/NextGraph/remoteStorage;
  their actual runtime protocols and launchd installation are not implemented.

## Tests

The PostgreSQL tests run against a real disposable database in every CI matrix
job. To run them locally, set `SYNCABLES_TEST_DATABASE_URL` to a dedicated test
database and run `npm test`. With no test database configured, those database
cases are skipped; codec and ordinary library tests still run. Tests use invented
owners and data, and clean up only their own rows.
