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
