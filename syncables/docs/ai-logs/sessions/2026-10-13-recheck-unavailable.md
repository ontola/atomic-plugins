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
