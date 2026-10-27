# Checked-out collections and OpenAPI-scoped item classes

- Session: codex://threads/01a11a49-4322-7813-aa0d-2f70ada2be33
- Assistant: OpenAI Codex, GPT-6.
- Date: 2026-10-22

## Human requests

The user questioned the extra clone needed to inspect a bare data repository,
then asked: "ok, implement that and make my existing Keep and GitHub snapshots
available as normal checked-out folders, preserving their history".
They asked whether schemas and hash-nested HTTP response bodies were stored,
and requested classes namespaced to the OAD that represent the actual API item.
They also asked about mismatched responses and OAD changes within a session,
then asked whether existing software exposes Git repositories over Braid.
They compared Statebus and Statecraft and clarified that repository boundaries,
lack of resource-level forks, and duplicate storage across response archives and
extracted records are reasons to consider replacing Git.
Private account identifiers, record contents and connection IDs: [redacted].

## Substantive responses and implementation

Explained that PostgreSQL retains original response text and lossless nested
JSON graphs; Git versions extracted JSON-AD records and bundled class/property
schemas. Current reads check envelopes, IDs and paging, not full response schema
conformance. Daemons retain the startup document; changed document bytes create
another source/checkpoint scope rather than automatically migrating history.

Implemented automatic detached Git worktrees per collection, an optional root,
and a local-only checkout command for existing snapshots. The implementation
checks ownership, registrations, local edits, branches, history and symlinks,
and uses non-forced Git checkout. Local edits are checked before provider reads;
a late checkout failure reports the already saved snapshot separately.

Added OpenAPI-content-hash/CRUD-resource class IRIs, their Class resources and
provenance property schemas. A local migration commit adds types/schemas while
preserving old commits/tags and lossless original payloads. The specific type
identifies the declared API resource; it is not a conformance certificate.
Document hashing and loading now use the same bytes.

Researched Redwood's Braid-backed Git remote helper and Git integration demo,
BraidFS filesystem synchronization, and braid-http protocol primitives. Reported
Redwood's pre-alpha status and that SHA-256 repository compatibility is untested.
No Braid service was installed or private data published.

## Validation

Tests cover multiple collections and preserved histories, later checkout updates,
tracked/untracked/local-commit protection, unmanaged folders and symlinks, archive
ownership and changed scopes, document-specific types, offline idempotent schema
migration, and large numeric lexemes. PostgreSQL runtime coverage checks automatic
working folders and blocks source reads for a dirty checkout. Live migration
verification remains recorded outside the repository; no personal data is copied
into test fixtures or this log.

Live local migration produced clean working folders for 111 Keep notes and 21
GitHub issues. All earlier commits remain ancestors; original payload graph
hashes are unchanged. Repeating the local-only command creates no extra commit.
No provider request or owner-key access was needed for this migration.

The complete test suite passed: 1,815 tests in 102 files, using a separate local
PostgreSQL test database. Following final changes, all 31 daemon tests passed.
Release build, lint, formatting, changelog validation, and whitespace checks pass.

For the subsequent architecture discussion, distinguished reactive state and
subscription interfaces from durable content-addressed storage. Proposed sharing
one JSON object graph between response archives and resource revisions, adding
resource-level histories and forks, and retaining Git as an optional export.
This is a design proposal; the implemented Git snapshots still store expanded
JSON records separately from PostgreSQL graph nodes.

## Maintainer review and publishing authorization

After the completed changes were staged for review, the maintainer replied:
"yeah ok go ahead. you can also edit claude.md, just say it's ok to push and
merge code when it's green". Updated CLAUDE.md to authorize committing, pushing,
opening a PR, and merging within the agreed task after applicable tests and
required checks pass, without an additional confirmation at each step. AI
disclosure and repository merge gates remain required.
