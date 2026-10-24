# SyncD naming and Git, Braid and AtomicSync interfaces

- Assistant: OpenAI Codex, GPT-6.
- Session: codex://threads/01a16c3e-b400-72ab-9192-11591d76d06b
- Date: 2026-10-24

## Human request

"please update the atomic-plugins docs for syncables to document SyncD as my
shorthand name for the stand-alone Syncables Daemon we have been building.
Can SyncD expose a Braid interface in the same way it exposes a git interface
and an AtomicSync interface? Would be nice to have those three actually"

## Substantive response and work

Documented SyncD as Michiel's shorthand in the repository/package READMEs,
daemon guide, CLI guide, stack explainer and daemon design. The npm package,
library imports and executable remain syncables.

Explained that Git, Braid and AtomicSync can coexist as adapters over the same
PostgreSQL snapshots/history. Current source has explicit Git import/export;
there is no Git network server, Braid endpoint or AtomicSync peer. Retained the
distinction between mirroring records into an existing Atomic drive and native
replication of a SyncD-backed drive with the same identity.

Outlined a proposed read-only Braid milestone: scoped collection resources,
stable version/parent mappings, full-body updates and subscriptions after
durable publication, reconnect/restart recovery, authorization and client
compatibility checks. Writable adapters require shared edit/conflict/outbox
policies. Checked the Braid-HTTP v04 draft and braid-http README as primary
references. No protocol implementation or provider data access is part of this
documentation task.

## Validation

Validated all eight newly added local links, including seven fragment targets.
Changelog validation (`npm run changelog -- --check`) and `git diff --check`
pass. Reviewed protocol terminology against the Braid primary references and
implementation status against the existing snapshot store and CLI. Runtime
tests were not run for the initial documentation-only changes.

## Follow-up request and implementation

The maintainer then requested: "ok build the Braid one. a worker called
'SyncD to Atomic' will build the atomic one".

Implemented a separate `syncables braid` command and Node-only daemon export.
It serves explicitly selected accepted PostgreSQL collection snapshots over
authenticated loopback GETs and Braid subscriptions using braid-http 1.4.10.
Pinned that dependency to preserve the package's Node 22.11 minimum; later
versions add an undici dependency requiring Node 22.19. The main/browser
entrypoints do not import this adapter. Atomic runtime work stays separate.

Collection envelopes carry JSON-AD text strings and bundled schemas, preserving
numeric lexemes without exposing internal snapshot context or response archives.
Version/parent tokens bind scope, collection alias and representation format.
Committed heads/history are the durable publication log, including catch-up
after process restarts and publications during initial subscription setup.
Replay follows bounded single-parent history; unknown parents, merges or long
gaps explicitly require a fresh full snapshot. Added exact-origin optional
browser access, mutation rejection, reader/body/replay bounds, slow-reader
disconnects and cleanup on shutdown. No provider data or live grants were read.

Added an unmodified-client/PostgreSQL compatibility suite and extended the
installed-tarball smoke to serve and subscribe while the mock provider is
stopped. The Braid guide includes commands, representation, recovery behavior
and precise limits. Existing repository authorization permits committing,
pushing and opening a PR, with merging gated on applicable checks.

All 1,835 tests in 104 files pass against a separate disposable local PostgreSQL
18 database. The 12 new Braid cases exercise the unmodified braid-http client,
exact numeric text and schemas, multiple subscribers, unchanged state,
removal/reappearance, restart replay, initial-subscribe races, failed source
publication, access controls, malformed input, browser CORS, database failure,
history reset and transport limits. The installed tarball passes sync, the
foreground daemon/webhook, offline Braid GET/subscription, graceful shutdown,
local history/browsing and isolated import checks. TypeScript checking,
lint/formatting, release build and changelog validation pass.
