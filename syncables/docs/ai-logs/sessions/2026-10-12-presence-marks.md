# Session log — 2026-10-12: presence marks (K4/K5, second step)

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), "syncables worker 2" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only; stacked on #451 (tell before prune).
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; fixtures are invented.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the coordinator session):** PR 2 of the K4/K5 consumer, as
designed: one map of presence marks (`unconfirmed`, `unavailable`, and
`deleted` under `retainDeleted`) stored in the outbox; under `absent:
removed`, or wherever a check will be made (including `'all'`), keep a
vanished record `unconfirmed` before its check, so the "removed, then
unavailable, then back" sequence goes away; unconfirmed records checked
first next sync, also when the list is unchanged; checks of records without
writes capped at `maxMissingRecordChecks` (default 50); `client.presence()`
for the full set, `SyncResult.presence`/`onPresence` for changes;
`parentAbsent` without writes. Fold in the #451 nits: a write queued inside
the handler must keep its record out of the prune and out of `pruned:
true`; a test for the `parent` path; README wording.

**Assistant:** `unavailableKept` became `keptMarks` with a `presence`;
`setMark` records changes on the running sync (`SyncRound.untold`), told
once per record (its latest change) with the next removal or at the end;
the candidate loop keeps `absent: removed` (and planned-check) records
`unconfirmed` and queues their checks, `absent: deleted` ones are removed
or kept `deleted`; `lookupPlanned` gates the checks, the vanished loop
counts them against the limit, and unconfirmed marks are checked again when
the read is unchanged; `reportMissing` turns evidence into marks; a read
returning a marked record tells `present`. After the handler, a record
that gained a write is not removed and its change says `pruned: false`.
Exported `PresenceMark`/`PresenceMarkValue`; `ApiClient.presence()`; options
`retainDeleted`, `maxMissingRecordChecks`. Tests in
`presence-marks.test.ts` (the Google Tasks table, the cap and its order,
the other declarations, a restart, a write queued in the handler, parent
members told `source: 'parent'`); existing tests updated for the two
behaviour changes (a vanished parent is now checked by default; `'all'`
keeps before checking).

## Turn 2

**Human (via the coordinator session):** Review blocker: records that
cannot be checked were queued for a check every sync (`recheck` and the
unchanged-read branch skipped `lookupPlanned`), used up the limit and were
reported to `onMissingRecord` each time. Nits: hold mark changes to the end
of the sync so each record is told once; a check-order test and the shared
limit documented; the stale `SyncResult.presence` JSDoc; two misplaced
JSDoc blocks; `rebuildTelling` matched a change's scope without its
context; a `filtered` change carried the stored values; document that
retained `deleted` marks are never cleaned up; accept an unknown stored
`presence`; the README on an older client rewriting the outbox.

**Assistant:** Both recheck paths filter by `lookupPlanned`, and the limit
counts only checks that make a request. `tell()` sends removals at once and
holds mark changes to the end of the sync (a removal drops a held change of
the same record). `rebuildTelling` keeps each change's scope by position
and puts the freshly read record on a `filtered` removal. An unknown stored
`presence` is read as `unavailable`. JSDoc and README fixed. Tests: the
`'none'` repro, the check order, told once with a feed settling a record
after another removal, the fresh record, an unknown stored value; four of
them fail on the code before.

## Turn 3

**Human (via the coordinator session):** Blocker: held mark changes were
lost when the sync threw or the handler threw at the end, since they lived
on the round; keep them at client level, latest per record, and carry them
into the next sync. Nits: stale comments; the handler called again at the
end after it threw; a `filtered`/`deleted` check result deleting the mark
before the removal was told, so a refused removal lost it; tests for the
no-item-GET case and the same id in two contexts.

**Assistant:** `untoldMarks` (client level, latest per record) replaces
`SyncRound.untold`; the end tell is skipped when the handler threw in the
sync, and what is not told waits for a later sync. A `deleted` or
`filtered` conclusion sets `clearing` on the mark; `rebuildTelling` drops
it once the removal is told, or keeps the mark when the handler throws.
Tests: the two probes (the handler throwing at the end, storage failing
mid-sync), a refused removal checked again, no item GET, and the same id
under two lists in one `rebuildTelling` call (a feed settling both, an
update queued in the handler for one); four fail before the fix.

## Turn 4

**Human (via the coordinator session):** Blocker: a held change is told
after its mark was dropped without telling (`settled()`, and a clearing
mark on a record that stays in `rebuildTelling`). Drop the held entry
wherever a mark is dropped outside `tell`/`setMark`, or replace it with
`present` when the app had been told the mark; add the reviewer's repro.
Nits: reuse `stays`; the "checked again" comment holds only for
`unconfirmed`. Merge main (README changelog conflict, keep both).

**Assistant:** `dropMark` does this for both places. A mark carries `told`
(set when the end tell succeeds, kept across `setMark`, set on restore);
a delete the app made is not told back as `present`. Tests: the repro (an
untold `unconfirmed` mark, an update, the check finding the record: nothing
told for it, `presence()` empty) and its told counterpart (`present`
told); both fail before the fix. `rebuildTelling` reuses `stays`, and the
comment names the `unconfirmed` case.

## Turn 5

**Human (via the coordinator session):** #466 nits, after it merged: the
read path that settles a mark should call `dropMark` instead of telling
`present` unconditionally, and add a test for the `settled()` path if it
can be reached.

**Assistant:** A read that returns a marked record now goes through
`dropMark`: `present` is told only when the app was told a mark of the
record; an untold mark's held change is just dropped. Tests: an untold
`unconfirmed` mark that the next read settles tells nothing (fails before
the change), a told one tells `present`, and the `settled()` path,
reached by a `resolveWrite` `retry` of an update held on an `unavailable`
record: the mark goes at once and `present` is told at the end of the
next sync that lists the record.
