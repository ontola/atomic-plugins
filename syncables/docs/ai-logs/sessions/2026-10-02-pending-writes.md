# Session log — 2026-10-02: pending-edit conflicts and uncertain creates

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), worker subagent of the atomic-plugins oversight session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; tests use invented data.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the oversight session):** Work on gaps 1 and 2 of #260 on a
branch from main. Reproduce "refresh overwrites an unconfirmed local edit"
with a deterministic fake transport and fix it if it still reproduces, keeping
pending local intent visible or exposing an explicit conflict, with same-field
conflicts observable. Make an ambiguous create (POST with a lost response) not
be retried blindly for providers without an idempotency contract: classify it
as uncertain, expose it, and let the app reconcile, retry or discard; retrying
with an idempotency key declared by the document or config is fine. Document
the failure classification. Out of scope: durable outbox, restart recovery,
deletion evidence, publishing.

**Assistant:** Wrote regression tests first. On main (after #269), the visible
overwrite in gap 1 no longer reproduced: refresh replays pending intent.
Same-field conflicts were not observable. Gap 2 reproduced: the lost POST was
resent and the fake provider held two records with nothing pending.

Implemented in `src/client/client.ts`:

- `pendingWrites()` entries gain `state` (`pending`, `uncertain`, `failed`)
  and, for updates, `conflicts`. A pending update stores the confirmed values
  of the fields it changes; a refresh with a different remote value that also
  differs from the local value records a `WriteConflict` and calls the new
  `onConflict` option once per observed value. The local value stays visible
  and is still sent.
- A create with no response, an unusable 2xx body, or a 5xx other than 503 is
  parked as `uncertain` and blocks later writes to that record. 429, 503 and
  other 4xx keep the existing backoff retry; updates and deletes are unchanged.
- `resolveWrite(resource, id, { action: 'retry' | 'discard' | 'confirm', id })`
  settles uncertain creates (confirm remaps the record and follow-up writes
  to the server id without resending) and `failed` writes.
- An `Idempotency-Key` header parameter on the create operation, or the
  `idempotencyKeyHeader` option, sends one key per create and reuses it on
  retries, which then stay automatic.

Updated README ("Refresh during a pending update", "Uncertain creates") and
CLAUDE.md. No live-provider or real-browser run was made.

## Turn 2

**Human (via the oversight session, relaying an automated review of PR #309):**
Fix five findings, each with a regression test: (1) a false conflict when two
queued edits to the same field are followed by a refresh that shows the first
one; (2) retrying a failed update overwrote a newer settled value, and the
stale value stayed visible; (3) one failed-write slot per record let a failed
create become unreachable, and the README state table did not match the code;
(4) an `authenticate` error before sending was treated as uncertain; (5)
conflict detection was skipped when a snapshot equalled the last one after a
write had settled.

**Assistant:** Added the tests first; six of them failed on the previous
commit. Changes: settled writes rebase later queued updates' conflict bases,
and a refresh value equal to an earlier queued value of this client is not a
conflict; failed updates and deletes are kept per record and lose the fields a
later settled write sets, and a retry drops fields that newer queued writes set
(or throws when nothing is left); a failed create stays parked at the head of
its queue; new writes no longer drop failed writes; errors raised before the
transport is called keep the normal retry; a settled write invalidates the
last-synced snapshot for its scope. README and CLAUDE.md now describe this
behaviour.
