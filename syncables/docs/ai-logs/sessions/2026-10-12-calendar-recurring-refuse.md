# Session log — 2026-10-12: Calendar recurring series not written (K18 part 2)

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`: `overlays/` and `syncables/` (tests and docs only).
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** K18 part 2: recurring series are
not written. Start from the held branch `claude/write-preconditions-overlays`
(Write Preconditions overlays for Google Calendar and Notion, written before
the spec merged); check it against the merged spec and the client's parsing,
bring it onto main, make sure Calendar's update and delete carry
`refuseWhen: {field: recurrence, present: true}`, and add a syncables test:
a write to a recurring series is refused, a single event or an exception
goes through. Keep Notion's part if sound.

**Assistant:** The held overlays pass the merged spec's validator, and each
declaration parses with `parsePrecondition` under the placement rules. The
held Calendar overlay also refused `recurringEventId` present, which refuses
exceptions too; that follows the calendar app's scope (it leaves instances
out), not a provider state. Under the event list the K18 read uses
(`singleEvents=false`), an item with `recurringEventId` is an exception,
one event with its own id and etag. The revised overlay refuses only a
series' master event (`recurrence` present) on PATCH, PUT and DELETE,
keeping `ifMatch` on the body field `etag` with 412. Notion's part
(`readVerify`, refused when `in_trash` or `archived` is `true`) is
unchanged. The overlay test checks the single refusal, that an exception
and a cancelled exception are sent, and that Calendar's overlay composes
after either crud-causality overlay. A syncables test reads the overlay
file, applies it to a Calendar-shaped document and runs the client: a
series' update and delete are refused without a request; a single event
and an exception are sent with `If-Match`. With PUT and PATCH both on the
item path, the client sends the PUT, as it does for any such document.
