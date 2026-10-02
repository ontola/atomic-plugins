# Session log — 2026-10-02: durable outbox and restart recovery

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), worker subagent of the atomic-plugins oversight session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; tests use invented data.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the oversight session):** Next slice of #260: a durable outbox
with restart recovery. Persist the write queues, failed writes, uncertain
state, conflict bases and idempotency keys through the client's existing
storage adapter, so a new client on the same storage resumes them. On restart,
pending writes resume in order; writes in flight when the process died count
as uncertain unless they are idempotent; failed and uncertain writes stay
visible and resolvable; local ids of unconfirmed creates and their follow-ups
survive. Version the storage format and tolerate a missing or older record.
Make atomicity explicit: the worst case after a stop between the outbox write
and the network call must be "uncertain", never a silent duplicate or loss;
document it in the README. Out of scope: 401/403/422 classification, remote
deletes, deletion evidence, version bumps and publishing. Test with
deterministic fake transports and an in-memory storage shared across two
client instances, including a crash mid-request.

**Assistant:** Added `src/client/outbox.ts` (the versioned record format and
its reader) and changed `src/client/client.ts`:

- The whole outbox is one record (`syncables:outbox`/`outbox`, configurable
  with `outboxNamespace`, `false` to disable, off by default when no `storage`
  is supplied), stored through a serialized
  chain so the stored state is always one consistent snapshot. It holds the
  queues and failed writes per record with state, attempts, last error,
  conflict bases and conflicts, idempotency keys, the confirmed record the
  writes replay on, and records still to be rebuilt after an id remap.
- `create`/`update`/`remove` store the outbox before updating the visible
  record and before resolving; if that store fails they reject and nothing is
  queued. Before each request the write is stored as in flight; if that store
  fails nothing is sent and the attempt counts as failed. Outcomes are stored
  before visible records are rebuilt.
- A new client restores the outbox at construction (`ready()`, awaited by the
  other async methods), rebuilds the visible records it names and resumes the
  queues. A write found in flight counts as an attempt; a create without an
  idempotency key becomes `uncertain`, one with a key is resent with it,
  updates and deletes are resent.
- A missing record is an empty outbox; a record of another version is left
  unchanged and `ready()` rejects; entries for unknown collections are kept and
  written back.

Tests in `__tests__/unit/client/durable-outbox.test.ts` copy the first
client's storage at the moment of the "crash" and build a second client on
the copy. README ("Durable outbox and restarts", with a table of what a stop
between steps leaves), CLAUDE.md and the changelog describe it. No live
provider, real browser storage or concurrent clients were tested.

## Turn 2

**Human (via the oversight session, relaying a verified review of PR #312):**
Fix six findings, each with a regression test: (1) a restored in-flight create
with a stored key was resent without it when the current document or options
no longer send the header; (2) a transient storage error during restore left
the client unusable; (3) a rejected create could reach storage through another
create's store; (4) restored updates sent a stale full record before any
refresh, overwriting untouched remote fields and skipping conflict checks
(decision: they wait for one successful `sync()` of their collection); (5)
rebuild entries for unknown collections and malformed entries were dropped;
(6) a restored in-flight attempt ignored `retry.maxAttempts`.

**Assistant:** Added the tests first (all eight new or changed ones failed on
the previous commit). Changes: a key counts only with a header to send it in;
a failed restore is retried by the next call unless the version was refused,
and storing the restored state no longer fails the restore; a store includes
only writes whose own first store succeeded, plus the write it is for, which
is marked stored inside that store; restored updates carry `awaitingRefresh`
(listed on `pendingWrites()`) until a complete read of their collection, unless
a create precedes them; unknown and malformed entries are kept and retried;
`retry.maxAttempts` turns a restored in-flight write `failed` (or `uncertain`
for a create without a usable key). README and CLAUDE.md updated.

## Turn 3

**Human (via the oversight session, relaying a second verified review of PR
#312):** Fix, with a regression test each: (1) a restored update could wait
forever when its collection never reads completely; let `resolveWrite` retry
(send now) or discard it, and fail it after three syncs that do not release
it; (2) a pending update whose record is missing from a complete refresh sent
a partial PUT; fail it instead, retrying on the last confirmed record; (3) a
create whose store failed could still become visible through a concurrent
sync; (4) expose `awaitingRefresh` only on pending entries; (5) release
per record instead of skipping a whole collection when any write settles
during the read.

**Assistant:** All six new tests failed on the previous commit. Added
per-record settle counters, a release step that takes over fresh records and
checks them for conflicts, a miss counter that fails a waiting update after
three syncs, `resolveWrite` support for waiting updates, a `lastKnown` record
(also stored in the outbox) for updates whose record a refresh lacks, and
skipping of not-yet-stored writes in visible rebuilds. README, JSDoc and
CLAUDE.md updated.

## Turn 4

**Human (via the oversight session, relaying a third review of PR #312):**
Failing in-memory pending updates on a missing record lost the newest edit
(an in-flight update settling stripped a queued, now failed, one). Narrow the
missing-record failure to restored updates waiting for a refresh, at release,
when the update is its record's first unsettled write and a PUT; restore the
earlier in-memory behaviour. Seed a new `update` from a failed write's last
known record, not from the visible record. Store the refresh miss count.

**Assistant:** Added four tests (all failed on the previous commit),
including the reviewer's scenario, which now ends at the newest value on the
server. Removed the in-memory failure, moved the check into the release step
with the head/PUT conditions, changed `update()` seeding, and stored
`refreshMisses` in the outbox. README and CLAUDE.md updated; the in-memory
remote-delete case is named as still open in #260.

## Turn 5

**Human (via the oversight session, relaying a fourth review of PR #312):**
A second restored update behind a failed one was still sent as a partial PUT,
and a retried failed update without its own last known record dropped
fields; a waiting update behind a pending delete could fail out of the middle
of its queue and be dropped silently when the delete settled; a retry kept
the stored miss count. Fix each with a test, plus a test of the invariant that
no failed write is newer than a queued write of the same record.

**Assistant:** All four new tests failed on the previous commit. The
missing-record failure now applies to the head of the queue regardless of
failed writes; updates and retries fall back to any last known record of the
same record; misses are counted only at the head; retry clears the count.
Writes carry a stored queue order (`seq`), which the tests use to check the
invariant after each step (a mutation removing the head check is caught).

## Turn 6

**Human (via the oversight session, relaying a fifth review of PR #312):**
The last known record was never refreshed, so a record that reappeared with
newer values and vanished again had a retry or a new update revert those
values; and a retried write kept its old queue order. Fix both with tests.

**Assistant:** Both new tests failed on the previous commit. The last known
record is now set on all of a record's unsettled updates whenever a refresh
replaces the collection (from the new read, or from the confirmed copy just
before it for a record the read lacks), when a write response confirms the
record, and when a write fails on a missing record (overwriting). Retried
copies get a new queue order, and the invariant check runs after the retry
and after a later failure.
