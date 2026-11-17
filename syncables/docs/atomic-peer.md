# Native account folders and collection tables (experimental)

`syncables atomic-peer` exposes accepted PostgreSQL collections as **one native
Atomic drive** for the selected owner. Account folders contain a table for each
selected API collection. The separately built native companion maintains signed
resources, persistent Loro state and native sync identities. An ordinary Atomic
client or server replica can receive that same drive over WebSocket.

```text
API → fetching daemon → PostgreSQL responses, snapshots and history
                                      ↓ accepted revisions + pinned OpenAPI
                               native Atomic projection
                                      ↓ WebSocket /ws
                               Atomic clients/replicas

SyncD drive
├── work (github)
│   ├── issues       [Table]
│   └── comments     [Table]
├── personal (keep)
│   └── notes        [Table]
└── Schemas          [native Classes and Properties]
```

The account identity is `(platform, account)`, so identical account labels on
different platforms cannot merge accidentally. Each configured collection alias
gets its own table, even when two aliases query the same API resource.

For an explicit projection of a selected record's nested list into typed owned
resources, see [Owned list components](owned-list-projection.md). This separate
consumer profile preserves the original body and does not change the default
compact collection projection.

## Build and run

Requirements: the daemon's separate local PostgreSQL database, Node 22.11+,
a current stable Rust toolchain and a C compiler. Nothing builds or starts the
native companion during npm installation or browser-library import.

```sh
cd syncables
cargo build --locked --release --manifest-path native-atomic-peer/Cargo.toml
npm ci
export SYNCABLES_DATABASE_URL=postgresql://localhost/syncables
node build/src/cli/main.js atomic-peer --config ./daemon.json \
  --peer-binary "$PWD/native-atomic-peer/target/release/syncables-atomic-peer" \
  --peer-directory /absolute/private/path/atomic-tables \
  --signer-file /absolute/private/path/authorized-owner-secret \
  --reader atomic:agent:READER_PUBLIC_KEY \
  --peer-port 9901
```

By default all collections in the config are selected. Each must already have
an accepted PostgreSQL snapshot; an accepted empty collection is valid and gets
an empty table. Use `--collections platform/account/name,platform/account/other`
for a subset, or the compatible singular `--collection platform/account/name`.
`--at FULL_REVISION_ID` or `--at tag:NAME` requires exactly one selected collection.

The fetching daemon runs independently. This companion polls the selected
PostgreSQL heads every second and publishes a new complete native graph when
one changes. It never logs into a provider or fetches an API. Missing source
heads and native process failures stop the companion instead of reporting stale
state as healthy. Offline recovery projects the current accepted heads; intermediate
source revisions remain in PostgreSQL rather than being replayed into native history.
Restart after editing the config or OpenAPI documents; their
bytes are pinned for this process and checked against accepted snapshot context.

The signer must be an explicitly authorized exported native Atomic agent
secret in an existing regular `0600` file. Its derived identity must match the
config's owner. The program does not search for keys or create an owner. Never
put a secret in argv, config, logs or issue comments. The private control stream
carries only the signer file path; no database URL, device/provider tokens or
owner private key is included in a native projection. The native key remains in
process memory and is not stored in the projection database.

The projection directory is dedicated to this owner and projection format,
created with `0700` permissions and no root symlinks. Preserve it across restarts:
rebuilding in a new directory creates a different drive and new native operation
identities. **Upgrade from the original JSON-wrapper or recursive nested-resource
prototype using a new directory.** The compact projection is `atomic-tables-v2`. Old directories are refused because their binding and
representation differ; old experimental drives are not silently rewritten.

On this pin, an existing matching owner/collection binding is read from its
authoritative Loro String and rewritten by a signed commit with a plain-text
prefix. This avoids the core's legacy guessing of a JSON-array String as a
resource list. The exact binding must match before migration; the drive and row
identities remain the same, and other owners or collections remain refused.

The peer binds `127.0.0.1`, with client URL `ws://127.0.0.1:9901/ws` and AUTH
origin `http://127.0.0.1:9901`. Only the owner and explicit reader agents may
read. Reader grants are replaced on restart; no public grant is created.
The listener has a 32-client limit, 64 MiB frame/control limits, bounded
handshake/send times and disconnects lagged subscribers. There is no public/TLS
listener, discovery registration or service installer. Stop with Ctrl-C.

## Native schema and values

Table row Classes declare native Properties through `requires` and `recommends`.
Each table sets its `classtype` and has an ordered default table View. The default
shows the title and up to nine source fields, prioritizing populated representations
before common identifiers, status and relationship fields; other columns remain available through the
column selector. Every field, including unfamiliar fields in observed records,
is projected rather than discarded to fit the first visible columns.

The generator uses the resolved OpenAPI list-response item schema when available,
including envelope paths, declared fields and date/URI formats. Observed fields
complete sparse or missing table views without changing the declared Class. This is
a presentation mapping, not a claim of complete OpenAPI validation. Declared
columns exist for empty collections.

Declared Classes and Properties are shared across accounts and operations using
the same pinned OAD and declared `components.crudResources` resource. Collection
aliases, bound path values and current records do not define a Class. The
resource's declared schema supplies its fields, with the selected response schema
as a fallback. Tables and their membership remain scoped to each
account/collection. A changed source OAD gets a separate schema namespace.

- Strings and booleans become native values. Declared date-time strings become
  millisecond timestamps when valid; declared dates and URIs retain their types.
- Safe integers and exactly round-tripping finite decimal values become native
  numbers. Values outside JavaScript's safe integer range, non-finite ranges or
  decimal precision become **exact numeric text**, never rounded numbers. Original
  numeric spelling remains in PostgreSQL even for ordinary native numbers.
- Each API record is one row resource. Unannotated nested objects and arrays stay as native
  inline JSON on that row, including comments, checklists, duplicate array values,
  array order and nested nulls. Top-level null fields are omitted. Compound fields
  do not create additional Classes or resources. Explicit embedded-resource
  declarations can instead produce links as described below. Where declared, each JSON
  Property retains its OpenAPI sub-schema in `jsonSchema`; this does not itself
  imply a schema-aware editing form. The candidate23 browser uses supported
  schemas for compact readable cell previews and retains the full JSON editor.
- Identity fields are labeled `API ID (<field>)` so a provider's `name` identifier
  cannot be confused with Atomic's required display name. Imported `permissions`
  is labeled `Source permissions`: its values are provider metadata and never
  create Atomic read/write grants.

Source subject, source ID, source revision, source hash and OpenAPI document hash
are plain native provenance fields. **Original JSON responses, source JSON-AD
wrappers and raw schema documents are not exported into this drive.** Field-level
JSON schemas may be carried as Property metadata. PostgreSQL owns the
original responses, immutable revisions and schema history. The Atomic drive is
a derived representation for browsing, queries and native replication.

Top-level row identities are stable per `(collection alias, source subject)`;
account folders and tables also have persisted identities. Schema identities
follow the resource key above, so another account does not duplicate a Class. A changed record updates the existing Loro document. Fields that
become absent/null are removed only when previously managed by this projection.
Resources no longer in the current graph are moved to a `previous-members`
folder. They are retained for identity/history and reappearance restores the
same native row. Collection absence is not treated as provider deletion.

## Explicit embedded resources and offline reprojection

The experimental [Embedded Resources declaration](../../openapi-extensions/spec/embedded-resources/README.md)
describes a field as one embedded representation, or an array of representations,
of another declared CRUD resource. The target's identity bindings and the source
request context identify each target. An OAD `$ref` supplies a schema shape only;
it never implies an entity relationship.

Declared embeddings produce native `atomicURL` or `resourceArray` Properties
with a target Class. Repeated targets share a resource within the account and
API identity scope. The account's related tables are marked as referenced
subsets, not complete API collections. Extraction is bounded and nonrecursive;
unannotated comments remain on the issue. Provider permission fields never grant
Atomic access, and embedding extraction makes no API requests.

Missing/null single values produce no link; an empty array produces an empty
resource list. If any array member cannot be identified, the complete field
falls back to JSON with diagnostics. Embedded summaries supply partial fields;
conflicting observations are reported rather than arbitrarily overwriting one
another. Bare null fields from these summaries or explicit JSON fallbacks are
recorded as sorted field paths in `embedded-null-fields` metadata, because a
native top-level null means property removal. Nested nulls remain inline JSON.
Accepted source JSON remains in PostgreSQL.

To apply relationship metadata to already accepted data, create a separately
source-hash-bound projection contract:

```sh
node examples/daemon/prepare-github-relationships.mjs \
  /absolute/path/to/accepted-github-oad.json \
  /absolute/private/path/github-projection.json
# Add to the atomic-peer command:
# --projection-contract /absolute/private/path/github-projection.json
```

The file holds `{ "sourceDocumentHash": "…", "overlay": { … } }`, or an array
of such contracts for different source documents. Projection overlays can add
explicit CRUD relationship/target metadata. They cannot change servers,
authentication, operations, existing identities, collection reads or accepted
snapshot provenance. The original document hash and revision remain intact;
the table records a separate projection-contract hash. Changing the contract
and restarting the peer reprojects the same accepted data without another
provider read. Invalid contracts fail before the native peer allocates a drive.

The example is a local experiment, not a change to the integration proxy's
published catalog. Public schema generation and shared schema URLs are separate
work. A switch from JSON to a relation creates a new Property identity; the
existing populated Property's datatype is not mutated.

## Publication and read-only protocol

The companion pins immutable source revisions while reading their objects.
It journals a pending graph before editing any native resource, durably records
allocated identities and property ownership, then flushes all resources before
publishing the drive completion marker. The journal is removed and flushed
before acknowledgement or subscription notifications. A write lock excludes
protocol reads during publication. Restart replays the whole selected graph,
even when an interrupted publication had already saved its completion marker.

An ordinary replica still receives resources through the native sync protocol,
not a collection-wide transaction. Wait for reconciliation before displaying a
complete collection. Table provenance identifies each collection's accepted
PostgreSQL revision; the drive marker identifies the combined graph.

The companion pins `atomic_lib` at
`30994948b5adadd765ecfcdccdf0aad14ef5be1a` and uses its redb backend, genesis
certificates, signatures, Loro state, permissions and wire codecs. Implemented
frames are AUTH, HELLO, GET/GET_MANY, SUB/UNSUB, SYNC and KEEPALIVE. All incoming
mutations are refused, including owner-signed commits. Capabilities advertise
only this subset. Search, plugins, application hosting, provider writeback and
merging consumer edits are outside this peer.

The native companion is an independent Cargo package with its own lockfile;
it does not share AtomicServer's workspace or follow a moving host branch.
An `atomic_lib` pin update is an explicit compatibility change: update both
`native-atomic-peer/Cargo.toml` and its `Cargo.lock`, then run the locked Rust
checks and PostgreSQL-to-native-process tests below. Keep `.atomic-server-ref`
on the same tested revision so browser and companion protocol changes are
validated together. CI's `Native Atomic peer compatibility` job enforces that
the current package builds and replicates against its selected immutable core.

Genesis uses the core's `Commit::create_did` certificate path. On this pin,
`Resource::save_as_genesis` still uses the legacy commit-signature identity
path, omitting the inline creator certificate and inherited drive stamp.
Substituting that API fails the existing replication test's verified-creator
assertion. The small `create_certified_genesis` adapter therefore remains until
the resource API provides equivalent certified genesis behavior.

The read-only session adapter still supplies transport-specific gates that this
core does not expose as one policy: issued-nonce origin authentication, explicit
frame allowlisting, collection-only subscriptions/reconciliation, local-only
GETs, and a SYNC response that never asks a consumer to push. Do not replace it
with an unrestricted frame-handler call. A future core read-only policy should
cover all of those gates before this adapter delegates them; the compatibility
tests exercise owner-signed write refusal as well as reader isolation.

This core pin uses full version-vector reconciliation and does not advertise
sparse sync. Native datatype and required-property validation remain enabled;
the pin has no Class value-constraint validation API. Generated Classes use
`requires` and `recommends`, and `jsonSchema` remains field metadata. Replicas
import accepted row state through this same core's sync admission rules.
An interrupted projection refuses reads with the pin's generic error code and
an explicit `Projection recovery required` message until replay completes.

The previous wrapper-oriented programmatic `runAtomicPeer` path remains for
prototype compatibility tests; the CLI uses `runAtomicTablesPeer` and the new
owner-scoped table projection format.

## Dedicated drive versus an existing-drive import

Native sync replicates **the same drive and resource identities**. A dedicated
SyncD drive makes its source ownership, reader permissions, checkpoints and
rebuild lifecycle explicit. A server may host that replica alongside personal
and team drives. Starting this peer does not install continuous replication on
that server; a client/replication connection must separately be configured.

Copying data beneath a folder on an existing drive is an import into another
ownership namespace. It can be useful for local annotations and application
integration, but needs destination identity mappings, edit ownership/conflict
rules and acknowledgement checkpoints. It is not achieved by moving a replicated
drive's root into a folder. The `replication add --backend atomic` definitions
remain configuration only. Existing-drive import can be built as a separate
adapter, while references between drives avoid duplicating the source records.

## Verification

```sh
cargo fmt --manifest-path native-atomic-peer/Cargo.toml -- --check
cargo clippy --locked --manifest-path native-atomic-peer/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path native-atomic-peer/Cargo.toml
cargo build --locked --manifest-path native-atomic-peer/Cargo.toml
SYNCABLES_TEST_DATABASE_URL=postgresql://localhost/syncables_cache_test \
SYNCABLES_ATOMIC_PEER_BINARY="$PWD/native-atomic-peer/target/debug/syncables-atomic-peer" \
  npx vitest run __tests__/unit/daemon/atomic-peer.test.ts \
    __tests__/unit/daemon/atomic-tables.test.ts --config __tests__/vitest.config.ts
```

Tests use invented signers and data: multiple accounts/collections, empty declared
schemas, numeric precision, inline nested JSON, identifier labels, owner/scope isolation, stable
identities, unchanged/delta reconciliation, absence/reappearance, publication
recovery and PostgreSQL updates/restart. Native acceptance uses the unmodified
Atomic core replica and official WebSocket client. Real provider credentials
and owner keys are not accessed by these tests.
