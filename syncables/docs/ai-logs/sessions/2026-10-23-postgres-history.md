# PostgreSQL snapshot history and optional Git export

- Session: codex://threads/01a11a49-4322-7813-aa0d-2f70ada2be33
- Assistant: OpenAI Codex, GPT-6.
- Date: 2026-10-23

## Human requests

The user proposed making PostgreSQL the basis for hash-addressed objects,
identifier indexes, changing values and schemas, presence/absence, annotations
and collection membership. Following discussion, they proposed making Git an
optional export: a CLI command exporting a subtree with messages and branches.
They requested: "ok implement that, migrate my existing Keep and GitHub history
to postgres and add the git export command. preserve the original repos until
we've verified the exports".

Personal account identifiers, connection IDs and private records: [redacted].
The existing authorization permits committing, pushing, opening a PR and merging
when applicable tests and required CI are green.

## Substantive response and implementation

PostgreSQL now stores immutable collection snapshot revisions, parent DAGs,
resource membership indexes, context, messages, author/committer metadata,
CAS-published heads and tags. Structured values reuse the same owner-scoped
JSON graph node table as archived responses, preserving numeric lexemes. Raw
response bytes remain separately archived for exact replay. A storage interface
keeps sync independent of Git; the CLI uses PostgreSQL by default.

The explicit Git migration reads marked legacy histories without changing their
refs or worktrees. It validates owners, trees and ancestry and publishes the DAG,
ref metadata and old-ID mapping transactionally. Unchanged reruns cannot rewind
new PostgreSQL heads. Existing installations are directed to migrate before
starting a new history. Snapshot folders use a separate workspace root, manifest
hashes, directory staging and retained previous folders for recovery. Local
changes block publication; late failures retain the saved database revision.

Git export creates a new normal SHA-256 repository, reproduces full collection
history or an item projection, preserves empty commits and parent/merge edges,
and exports branches and lightweight/annotated tags. Original commit headers are
retained so a full imported Syncables history can round-trip with identical Git
IDs. Projection refuses signatures it would invalidate. Failed exports remain
available for inspection and cannot modify the source archive or database.

This is the collection-history milestone. Cross-collection composed workspace
DAGs, field projections, mount occurrence locks and independent component forks
remain future work; the documentation makes this boundary explicit.

## Validation

Added PostgreSQL integration tests for exact branch/merge/annotated-tag round
trips, migration idempotence after new syncs, changed-ref refusal, transactional
owner rejection, stale-head/cancellation protection, owner isolation, numeric
lexemes, disappearance/reappearance, normal folders, local edits and symlinks,
and CLI migration/checkout/export without authentication. Existing daemon tests
now run against PostgreSQL snapshot storage. The installed-tarball smoke also
exercises local checkout and Git export. A test exposed a scheduling/publication
advisory-lock collision; the publication lock now uses a separate namespace.

Live verification and final validation results are recorded privately outside
the source tree. No provider calls or owner key access are needed for migration
or export; private records are never copied into fixtures or this log.

Live migration verification imported six revisions: four snapshots for 21 GitHub
records and two for 111 Keep notes. Each latest snapshot includes six bundled
schemas. Full exports reproduced every original Git commit ID, proving identical
trees, parent edges and commit metadata. The original refs, clean worktrees and
config were unchanged. New PostgreSQL folders matched all original snapshot
files byte for byte. Repeating migration was idempotent. A private pre-migration
PostgreSQL backup was retained. No provider request or owner key access occurred.

The full test suite passed (1,821 tests in 103 files), as did release build,
lint, formatting, changelog validation and the installed tarball smoke with
PostgreSQL sync/checkout and Git export. New concurrency coverage confirms a
single winning CAS publication; native sync no longer needs Git.

A final full-suite run exposed an existing conditional-sync test race: create()
returns its optimistic record before the background request is acknowledged.
The test now waits for pendingWrites() to settle before expecting the following
read to observe the remote change. No application behavior or test expectation
was weakened and no test was skipped.

Concurrent integration tests also exposed repeated CREATE INDEX IF NOT EXISTS
DDL acquiring table locks in the opposite order to snapshot writes. History
initialization now uses a schema-version marker and only executes the DDL once
under its schema advisory lock. Existing initialized databases do not reacquire
those index table locks during client startup.

The user asked for a link documenting fetch storage and whether subsequent
mirroring into an Atomic drive is planned. Added a sequential fetch-to-storage
walkthrough and a concrete, explicitly unimplemented one-way mirror milestone:
pinned revisions, stable native identity/schema projection, local signing,
durable acknowledgments/checkpoints, membership/deletion distinction and retry
verification. No Atomic drive was modified and no replication runtime added.

Final review corrected a bootstrap guard edge case: retaining an already imported
archive must not block a newly configured collection or OAD scope. The guard
checks the completed archive import, with CLI regression coverage that reaches
an invented login failure for a new scope without accessing any credentials.

The user subsequently proposed exposing a subset of the Atomic server at the
sync level. Inspected the local atomic-server sync engine and wire protocol,
then documented this alternative: virtual source drive, maintained Loro state,
read-only native protocol, library reuse, and same-drive replication versus
copying into another drive. The current core's concrete Db dependency means a
PostgreSQL adapter or an embedded projection store is additional implementation
work. This discussion did not authorize or add a new server runtime.

Extended projection refusal coverage to SHA-256 Git commit signature headers and
SSH-style annotated tag envelopes, alongside the existing unsigned round-trip
tests. Full exports preserve these envelopes byte for byte; projections that
would invalidate them fail without changing the PostgreSQL/source histories.
The fixtures contain plainly invented envelopes and test projection policy,
not cryptographic signature validity.
