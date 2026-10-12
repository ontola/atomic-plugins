# Session log — 2026-10-12: Write Preconditions consumer, client wiring

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), "syncables worker 2" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only; based on the `gone` branch (#477) with the pure core (#486) merged in.
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the coordinator session):** Write Preconditions PR 2: wire the
pure core into the client, built on #477 (`gone`). Follow-ups from the #477
review: a conflict test for `gone`, and (after #466 lands) the README line
saying a 410 follows `gone`.

**Assistant:** The client reads `x-write-precondition` from the create,
update and delete operations. An unusable declaration makes the write call
throw instead of sending the write unconditionally. Before a send,
`precheck` does the reads the declaration needs (the item, and the source
objects of Refusal Objects, once per sync pass), and then `maySend`
decides: send with the version header, or stop as `conflict`, `refused` or
`source-unknown`. Under `readVerify`, a full-record PUT is built on the
read. A `conflictStatus` answer stops the write. An update's 404/410 stops
as `gone`. A delete's settles only when the deletion is confirmed (a feed
tombstone, `absent: deleted`, `notFound: deleted`, or `gone` for a 410);
otherwise the record is kept and reported `unavailable` with the new
`source: 'write'`. An unknown outcome is marked `resolving` and resolved by
a read before anything is sent again, also after a restart.
`PendingWriteInfo.precondition`, the outbox's `precondition` and
`sentVersion` are new; an unknown stored state is dropped on restore. 25
client tests in `write-preconditions.test.ts`, plus a conflicting-`gone`
test in `completeness-outcomes.test.ts`; README section, changelog,
CLAUDE.md. The README line on a 410 following `gone` waits for #466.

## Turn 2

**Human (via the coordinator session):** After the #486 review: merge the
stricter core in; a caller passing `current = null` must get `read-first`,
not a comparison; a bodiless DELETE must fail closed on every `when`;
handle both deliberately. The merge-patch expected-value rule lands here.

**Assistant:** Merged #486's fixes. The client passes each operation's
place to `parsePrecondition`, so the placement rules make the write call
throw too. `maySend` treats `null` like undefined (not read). `precheck`
passes no body for a DELETE, so each `when` fails closed. An
`unusable-version` answer fails the write with a `lastError`. Tests: an
object version, a bodiless DELETE refused through `when`, an unknown
merge-patch update settled by the values after the patch (`writtenOf`
through `patchedField`), a source that is not a resource, and `null`
passed to `maySend`; README updated.

## Turn 3

**Human (via the coordinator session):** #490 blockers: `resolveWrite`
`retry` cleared `resolving`, so a write of unknown outcome was resent with
no read (§4.5); `sentVersion` was stored as text and compared with
`sameJson`, so a numeric version made a false conflict; merge main (#480)
and skip preconditions for compound-create follow-ups. Nits: route the
precondition reads through throttling and the auth block; read an unknown
stored state as `resolving`; fix the restore test.

**Assistant:** Merged #486's fix and main (README, `completeness-outcomes`
test and five `client.ts` hunks; follow-ups skip the declaration, also on
restore). `retry` keeps `resolving`. `sentVersion` is the raw version.
`readRefused` handles a throttled or credential-refused object or source
read as the write's own answer would. An unknown stored state is read as
`resolving` (dropped on a create). Tests: the retry repro, a numeric
version, a throttled and a 401 read, the follow-up under a `readVerify`
update, and a restore test that starts from a real resolving write.
