# Syncables daemon to native Atomic peer (#684)

- Session: codex://threads/01a16979-c3bd-74c1-984d-e550ea9ff075
- Assistant: OpenAI Codex, GPT-6.
- Date: 2026-10-23

## Human requests

"Bridge from Syncables Daemon to Atomic, see recent issue in github"

The user then identified the issue: "684?". The assistant confirmed
ontola/atomic-plugins#684, read its native-peer requirements and the merged
PostgreSQL history implementation (#683), and continued implementation.

The repository's existing authorization covers committing, pushing and opening
a PR within this task, subject to its CI/merge gates. No live collection, drive
or signing authority was selected in this chat. The assistant asked for an
explicit collection/reader and an available authorized local signer for the
separate live acceptance check. The user replied: "i think you have an atomic
server skill that allows you to inspect the contents of a drive?" The assistant
located `docs/skills/atomic-drive/SKILL.md` in the AtomicServer checkout and ran
its public `identity` helper. The helper reported missing bootstrap configuration
in this cloud environment. The assistant read its setup guide and asked whether
the public configuration was available at another path or only on the laptop.
No owner key or provider credential was sought or displayed.

## Substantive output and decisions

The implementation adds an optional Rust companion, pinning the existing
Atomic core rather than reimplementing its signatures, protocol or permission
logic. PostgreSQL accepted revisions are the authoritative input; the redb
store is an explicitly additional native representation containing durable
identity mappings, self-verifying genesis, signed changes, Loro history,
version vectors, a pending projection journal and a completion checkpoint.

The Node CLI's foreground `atomic-peer` command follows one collection's local
accepted history and feeds pinned source revisions to the native process.
It passes no database/provider credentials to that process. An explicitly
selected private exported owner secret supplies signing authority; explicit
reader agents and the owner receive read grants. The listener is loopback-only.
No remote deployment, provider mutation, new device login, service installation
or public publication is performed by these commands.

Source records and bundled source schemas have stable native wrapper identities.
Exact source JSON-AD is stored as native string data, with content hashes,
source/revision provenance and native links between bundled schema wrappers.
This preserves numeric lexemes and arbitrary JSON without claiming native typed
column conversion. Membership removal retains the source document/history;
reappearance updates its previous native identity. Native replication copies
this same drive; importing into a separate existing drive remains different work.

The shared sync engine handles authentication, read permissions, retrieval,
version-vector reconciliation and delta export. A transport allowlist rejects
all incoming mutations, including a valid owner-signed commit, and removes pull
requests for consumer edits. The companion implements subscriptions and reconnect
using the native wire format, advertises only its supported capabilities, and
checks read grants even on the core's hash-match/filtered sync paths.

Repeated native-replica tests exposed an initial import ordering issue when the
legacy Resource genesis helper omitted drive metadata from its signed state.
The implementation now uses the core's current self-verifying genesis API with
schema validation, which binds parent and drive into the certificate and allows
unmodified replicas to ingest resources in any order.

Before native modification, the pending source revision is durably journaled.
Required documents are flushed before the completed collection marker, then
journal removal is flushed before acknowledgement. Reads are excluded during
publication and remain refused after a partial failure. Restart always replays
the pinned revision before listening, including an interrupted operation whose
marker had already landed.

## Validation and remaining acceptance

Automated fixtures are invented. Tests exercise the unmodified Atomic sync
receiver and official WebSocket client against the real native process, plus
PostgreSQL-to-native publication. They cover exact JSON/numbers, schema changes,
initial/unchanged/delta sync, stable identities, membership removal/reappearance,
offline catch-up, process kill/reconnect, pending-journal recovery, owner/scope
fencing, denied reads, all incoming mutation tags and failed-origin auth.

The full PostgreSQL-backed TypeScript suite passed all 1,825 tests in 104 files,
including the real native process acceptance. Five native compatibility tests
passed (four core replica/security/recovery cases and one real-process official
WebSocket client case). Rust formatting/Clippy, TypeScript lint/formatting,
release compilation, changelog checks and the installed-tarball smoke passed. Final review added explicit
reauthentication coverage: authorized identity changes retain subscriptions;
unauthorized or failed authentication clears them. All five native tests and
Clippy passed again after that change. Final check
counts and PR state are recorded in the PR description. A selected live
collection/reader test remains pending user-provided selection and authorized
signing access; the issue must remain open while that acceptance step is missing.
