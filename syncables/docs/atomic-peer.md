# Read-only Atomic projection peer (experimental)

`syncables atomic-peer` exposes one accepted PostgreSQL collection as a native
Atomic drive. It follows the local fetching daemon's published revisions; it
never logs into a provider, fetches an API, or imports a raw response archive.
Git is independent of this path.

```text
API → fetching daemon → PostgreSQL snapshots/history
                             ↓ immutable revision
                      native Atomic projection store
                             ↓ WebSocket /ws
                      unmodified Atomic clients/replicas
```

## Build and run

The optional Rust companion is separate from the browser-safe library and npm
executable. Nothing builds, installs or starts it during npm installation/import.
Build from this repository with a current stable Rust toolchain and a C compiler:

```sh
cd syncables
cargo build --locked --release --manifest-path native-atomic-peer/Cargo.toml
npm ci
npm run build
```

First sync or migrate the chosen collection into PostgreSQL, as described in
[the daemon guide](daemon.md). Then run a separate foreground companion:

```sh
export SYNCABLES_DATABASE_URL=postgresql://localhost/syncables
syncables atomic-peer --config ./daemon.json \
  --collection example/work/notes \
  --peer-binary "$PWD/native-atomic-peer/target/release/syncables-atomic-peer" \
  --peer-directory /absolute/private/path/notes-projection \
  --signer-file /absolute/private/path/authorized-owner-secret \
  --reader atomic:agent:READER_PUBLIC_KEY \
  --peer-port 9901
```

The signer file must be an existing, explicitly authorized Atomic **exported
agent secret**, in a regular file with mode `0600`. The command neither searches
for keys nor creates an owner. Its derived native agent identity must match
`daemon.json`'s `owner`; legacy HTTP owner identities are not supported by this
prototype. Select this signing authority deliberately. Never paste the secret
into argv, config, issue comments or logs. Only the file path is passed in the
private control stream. Private key material stays in native process memory;
it is absent from the projection database and outgoing protocol messages.

The projection directory must be dedicated to this owner and collection, be
mode `0700`, and contain no symlinks at its root. The process creates it with
private permissions if absent. An existing different owner/collection or an
already open native database is refused. Keep it outside the repository and
back it up with PostgreSQL: removing it loses the existing drive and operation
identities. Rebuilding into a new directory creates a **different drive**.

The listener binds **127.0.0.1**, with `ws://127.0.0.1:9901/ws` as its client URL.
The signed AUTH origin must be `http://127.0.0.1:9901`. The owner and the explicit
comma-separated `--reader` native agent IDs may read. No public read grant is
created. Restart with a changed reader list to replace the grants. The 32-client
limit, 64 MiB frame/control limit, handshake/send timeouts, and disconnect on a
lagged publication stream bound this prototype. A disconnected replica catches
up with normal version-vector reconciliation. There is no public/TLS listener,
service installer, discovery registration or arbitrary browser-origin hosting.

Use `--at FULL_REVISION_ID` or `--at tag:NAME` to serve a fixed local revision.
Without it, the peer polls the selected scope's accepted PostgreSQL head every
second. A source head disappearance or native process failure stops the command;
it does not continue announcing stale data as healthy. Stop with Ctrl-C.
The fetching daemon and the companion can run independently; a companion
restart catches up on every reachable source revision after its checkpoint.
The source OAD/config is loaded at startup, as in the fetching daemon. Restart
both processes after changing those definitions. A retained collection alias
and original source subjects keep their mappings when its OAD scope changes.

## Identities and representation

The native companion pins `atomic_lib` to
`66880fc53f392771761bb4d967e1e443344a7e34`. It uses that core's redb backend,
self-verifying genesis certificates, signatures, schemas, Loro oplogs, version
vectors, ACL checks and frame codecs. It does not run AtomicServer's application,
plugin or search services. The core currently takes `atomic_lib::Db`; a new
PostgreSQL storage trait would require a much wider upstream refactor and its
own transactional/durability contract. A small embedded derived store makes the
prototype testable with the existing core. PostgreSQL remains authoritative for
fetched records, schemas and source history. redb holds an explicitly additional
native representation, rather than a second source of provider truth.

A dedicated native drive is minted once. Each `(owner, collection alias, source
subject)` has a persisted import identity within it, shared by records and
bundled schema resources. The same mapping is found after interruption; changes
update the existing Loro document. Genesis binds parent/drive metadata, and all
projection writes are signed locally by the selected owner. The built-in native
class and property definitions also have persistent identities. The command
prints the drive, acknowledged PostgreSQL revision and property identifiers.

Source JSON-AD is **not** silently reinterpreted as native Atomic properties.
Every source record or source schema is a native `source-resource` wrapper:

| Native property shortname | Meaning |
| --- | --- |
| `source-subject` | Original record/schema IRI, as text |
| `source-json-ad` | Exact JSON-AD text rendered from the pinned PostgreSQL object graph |
| `source-hash` | SHA-256 of those exact UTF-8 bytes |
| `source-revision` | PostgreSQL revision that last updated this wrapper |
| `source-types` | Native links to the wrappers of bundled source class definitions |

`source-json-ad` is a **native string**. This is a deliberate lossless first
projection: nested JSON, null versus absence, unknown properties, numeric
lexemes, integers above 2^53, decimals and numbers beyond f64's range survive
unchanged. Consumers needing numeric values must use a lossless JSON parser;
ordinary `JSON.parse` can round them. Typed native columns/editing and a native
reimplementation of the source schema's validation are outside this prototype.
Original source links, OAD document hashes, API resource annotations and schema
content remain in the source text; the type-wrapper links are additive.

The drive's `members` and `schemas` properties identify the current collection's
records and bundled schemas. Its `source-context`, `source-scope` and
`source-revision` pin the accepted source revision and OAD provenance. A wrapper
unchanged across source revisions may retain its older revision reference;
its content hash still matches the current PostgreSQL object. Historical source
revisions remain in PostgreSQL; native history records the projected changes.
Source messages/authorship are retained by PostgreSQL, rather than attributed
to the owner as original provider authorship.

A missing member is removed from `members`; its native document, source data
and history are retained. Reappearance reuses the same native identity. This
is collection absence, not proof of provider deletion. No native destroy is
issued based on absence, even when a source object carries deletion evidence.
The prototype conveys such evidence in the lossless source data only.

Native replication copies the **same drive**. To put this data in a different
existing drive requires another explicitly scoped import/projection, or a
reference/mount. The `replication add --backend atomic` destination definition
continues to be configuration only. Direct pushing into a configured target
would need its own managed-subtree mappings, conflicting-edit policy and
acknowledgement/checkpoint handling. This source peer gives readers native
subscriptions without taking on that target-write authority.

## Durability and protocol subset

Before modifying native documents, the companion durably journals the pending
source revision. Identity/genesis creation is durable independently of the final
collection publication. The complete source revision is pinned while its objects
are read; another source sync cannot change them underneath this projection.
All required native documents are flushed before the drive's completion marker
is saved and flushed. The pending journal is then removed and flushed before
acknowledgement or subscription notifications. A write lock excludes protocol
reads during publication. Failure leaves the peer unable to serve data until
recovery; startup replays the current pinned revision before listening, including
when an interrupted run already wrote its final marker. Replays reuse identities
and do not regenerate unrelated documents. Preserve the native store on failure.

A completion marker means native state is durable at the source. Native wire
sync is not a collection-wide transaction in the consumer. Consumers must wait
for reconciliation and resolve the marker's members/schemas before displaying a
completed revision; they can verify every wrapper against its source hash.

Implemented frames are `AUTH`, `HELLO`, `GET`, `GET_MANY`, `SUB`/`UNSUB`, `SYNC`
(including sparse vectors and hash probes) and `KEEPALIVE`. AUTH is origin-bound,
with Atomic's timestamp window and per-connection nonce. The core checks read
permissions, and the wrapper additionally gates even filtered/hash-match syncs
on drive access. GET never fetches an unknown resource from the network.
Incoming `COMMIT`, `SYNC_PUSH`, `UPDATE`, `DESTROY`, blob, call and ephemeral
frames are refused, including owner-signed writes. Reconciliation never asks a
reader to push consumer edits. Only implemented capabilities are advertised.

Initial sync and reconnect use the unchanged core engine and its signed native
state. Subsequent reconciliation transfers Loro deltas. Live subscriptions send
changed resource snapshots after durable publication, with the drive completion
notification last. There is no provider writeback, merging consumer edits,
bidirectional sync, arbitrary component fork, search or application hosting.
The supported source limits are the existing 50,000-resource / 16 MiB snapshot
stage limits; each native control operation has a five-minute timeout.

## Verification

From `syncables/`:

```sh
cargo fmt --manifest-path native-atomic-peer/Cargo.toml -- --check
cargo clippy --locked --manifest-path native-atomic-peer/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path native-atomic-peer/Cargo.toml
cargo build --locked --manifest-path native-atomic-peer/Cargo.toml
SYNCABLES_TEST_DATABASE_URL=postgresql://localhost/syncables_cache_test \
SYNCABLES_ATOMIC_PEER_BINARY="$PWD/native-atomic-peer/target/debug/syncables-atomic-peer" \
  npx vitest run __tests__/unit/daemon/atomic-peer.test.ts --config __tests__/vitest.config.ts
```

The native tests use an **unmodified Atomic core replica** and official
`WsClient`: initial/unchanged/delta sync, schemas and number lexemes, stable
identities, membership absence/reappearance, subscriptions, denied access,
wrong-origin/failed reauthentication, process kill/reconnect and interrupted
projection recovery. PostgreSQL tests pin accepted revisions, check owner/scope
isolation, feed the real native process and verify offline catch-up with the same
drive. All fixtures are invented. A live provider collection/reader test still
requires an explicitly selected collection and locally authorized signer; the
automated suite neither searches for owner keys nor accesses provider credentials.
