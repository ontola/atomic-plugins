# Session log — 2026-10-13: re-check kept unavailable records

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** Pick the most valuable gap from
the syncables README's "not verified" or known-limit notes, or a TODO,
that needs no live account and touches neither throttling nor pagination
`incomplete`. Plan first.

**Assistant:** Chose the README's "Not yet: a kept record without writes
is not looked up again by itself". In `performSync` only `unconfirmed`
marks were re-read; a record kept `unavailable` stayed kept until a list
read returned it. Now a kept `unavailable` mark without writes is re-read
where `lookupPlanned` (the rule for vanished records), after unconfirmed
records and the read's new candidates, within `maxMissingRecordChecks`,
also on an unchanged read. A 404 under `notFound: unavailable` keeps it
(nothing told again: `setMark` tells only a changed presence); a 2xx
shows it exists outside the collection, so it leaves the copy (`removed`);
an answer concluding deletion removes it (`deleted`). Two existing tests
change with it (one more report and the third sync's 50 checks). New
tests: both check settings, a 410 under `gone: deleted`, no re-read under
`'none'`, and the order under a limit of one; three fail on the code
before.

## Review fixes (#553)

The coordinator relayed two blockers from #553's review, both confirmed
with probes. (1) Held writes: the unchanged-read path and the vanished
loop skipped only records with queued writes, so a record with a failed
write held as unavailable (`failMissing`) was re-read, its mark cleared
and `present` told while the failed write still said
`missingRecord: 'unavailable'`. Both now skip `unsettled` records (queued
or failed writes). (2) Starvation under `maxMissingRecordChecks`: the
unavailable set was read in a fixed order and a 404 keeps the mark, so a
limit of one re-read the same record every sync; and the per-sync limit
let one collection's unavailable re-checks take the checks of later
collections' unconfirmed and newly missing records (a regression of this
PR). Each mark now has `checked` (an ISO time, strictly increasing,
stored in the outbox), and the re-reads moved to a second pass,
`recheckUnavailable`, after every collection's other checks and before
`finishFeeds`, oldest-checked first across collections. The vanished
loop's body became `checkVanished`, shared by both passes. Docs: the
order per collection and the limit per sync, held writes excluded, the
"least likely to have changed" comment dropped, and `onMissingRecord`
called again on every re-check. New tests
(`recheck-unavailable-fairness.test.ts`): held writes on an unchanged and
a changed read, rotation with a limit of one across a restart, and a
later collection's newly missing record checked before an earlier
collection's unavailable one; three fail on the code before.

## Delta review fix (#553)

B1: the check time was set before `findEvidence`, which returns nothing
without a read when the request budget or a 429 stops it, so unread
records got the newest time and the same leading records were read every
sync (the reviewer saw `pets/1` read six times under `maxRequests: 3`).
`checkVanished` now calls `onChecked` only when `findEvidence` returned
evidence. New test with `limits.maxRequests: 3`, which fails on the code
before. Nits: a write queued during the GET also keeps the mark
(`unsettled` beside the revision check); the docs say an unread record
keeps its place; a long README line wrapped; the redundant
`round.returned` check dropped.

## Follow-up nits (after #553 merged)

N1: the unchanged-read path routed a kept mark only where the collection
makes checks, so a mark a new list tombstone settles stayed when the
members were unchanged and checks were off; it now goes to `vanished`
whatever `lookupPlanned` says, as on a changed read (test under
`missingRecordChecks: 'none'`, unchanged and changed read; the unchanged
one fails on the code before). N2: the changelog notes that the
`unsettled()` check also keeps `unconfirmed` marks with failed writes out
of an unchanged read's checks.
