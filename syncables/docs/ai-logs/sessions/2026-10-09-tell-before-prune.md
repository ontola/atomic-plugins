# Session log — 2026-10-09: tell before prune (K4/K5, first step)

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), "syncables worker 2" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only; stacked on #399 (`claude/syncables-completeness-outcomes`).
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; fixtures are invented.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the coordinator session):** Take over the K4/K5 consumer
(plan `plans/k4-k5-consumer.md`) with the coordinator's decisions: tell
before prune (the app always gets the deletion, as a presence mark or
event, before syncables prunes its local copy; prune by default, opt-in
`retainDeleted`), keep vanished records under `absent: removed` marked
until a lookup settles them, 50 lookups per sync by default,
`SyncResult.presence` with changed marks and `client.presence()` with the
full set. Make tell before prune the first PR, on its own. Also check
whether any drive app deletes or overwrites its Atomic rows because
syncables pruned its local copy without telling it.

**Assistant:** Check: no drive app uses `createApiClient` (the only
syncables code with a pruned local copy); pets and notion use
`readPlatform`, a one-off read, and neither deletes rows a read no longer
returns (notion leaves such pages in place, by design). This PR: in
`performSync`, the records a complete read removes from the local copy are
passed to a new `onPresence` handler, awaited, before anything is removed,
and listed on `SyncResult.presence` (`PresenceChange`: `deleted` under
`absent: deleted`, else `removed`, with the last values, `pruned: true`).
A failing handler applies nothing of that read; the next sync tells again.
Tests in `__tests__/unit/client/presence.test.ts`: the three declarations,
the record still local while the handler runs, an asynchronous handler, a
failing handler, nothing removed, a record with writes, a reused storage.
Retention, `retainDeleted`, presence marks, lookups and the cap come in the
next PRs.

## Turn 2 (2026-10-12): review blocker and points

**Human (via the coordinator session):** Blocker: the awaited handler sits
between the stale-snapshot check and `confirmed.set`, so a write that
settles while it runs is overwritten (a delete brings the record back, and
the next sync reports the app's own delete as `removed`; an update is
reverted). Also: a kept unavailable record later concluded `filtered` or
`deleted` is removed silently; a record whose only write is not durable yet
is not told but still dropped; the README's "nothing is applied" is not
literally true; a throwing handler lets held updates count refresh misses.

**Assistant:** After the handler, the scope's revision is checked again
and a newer write sends the snapshot down the stale path. Removals after a
check go through `rebuildTelling`, which tells before removing (in
`releaseRefreshed`, `finishFeeds` and for parent members). A record whose
writes are all still being stored is not rebuilt by the read. A scope whose
handler threw is skipped by `countRefreshMisses`. README reworded.
`PresenceChange.source` takes `MissingRecord`'s values. Tests for each
probe, all failing before the fix.
