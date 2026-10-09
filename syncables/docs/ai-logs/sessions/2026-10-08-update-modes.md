# Session log — 2026-10-08: update modes (CRUD Causality 0.4.0 `mode`/`patchFormat`)

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), "syncables worker 2" subagents of the atomic-plugins coordinator session. The first worker stopped on a usage limit with the work uncommitted; a second worker took over its worktree and finished it. No shareable URL is exposed to the workers.
- **Model/tool:** Claude in Claude Code (the second worker: Claude Opus 5.5, `claude-opus-5-5`).
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only; based on `main`.
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; the fixtures are invented.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the coordinator session):** K11: read the chosen update
operation's `x-crud` (`action: update`, same resource; PUT still preferred,
else PATCH). `mode: replace` keeps the full record; `mode: patch,
patchFormat: jsonMergePatch` sends the changes alone (RFC 7396), with
`application/merge-patch+json` when `requestBody.content` declares it, and
applies RFC 7396 locally (`null` removes, nested objects merge) in rebuild,
the sent record and `update()`'s result; `jsonPatch` throws a clear error;
`custom` or no `patchFormat` keeps the full record; legacy documents are
unchanged. Add `mergePatch`, exported from both entries, fixture tests
(including two queued merge-patch edits that must not lose a `null` removal
across a restart), and docs.

**Assistant (first worker):** `src/client/merge-patch.ts` (`mergePatch`,
`mergePatchRecord`); `ClientRoute` gains `updateBody`, `updateContentType`
and `updateRefused`, set in `clientRoutes` from the update operation's
`x-crud`; `applyChanges` replaces the shallow spread in `rebuild`, the send
path and `update()`; the send path posts `write.changes` alone for a merge
patch; `update()` throws `updateRefused`. Most of
`__tests__/unit/client/update-modes.test.ts` written. Stopped before
committing.

**Assistant (second worker):** Rebased the work onto `main`. Added a guard
so a legacy document (whose collections are keyed by path) never takes a
merge-patch body from an `x-crud` naming that path, with a test that fails
without the guard. Queued edits are not coalesced in this client: each
update stays its own outbox entry with its own `changes`, so the required
`null`-removal case is covered by replaying two queued edits, before and
after a restart, and checking both bodies and the result. README (Writing
section, missing-records passage, Unreleased changelog) and CLAUDE.md
updated. Not verified: any real provider's merge-patch endpoint; a nested
merge patch reports a conflict on the whole top-level field.

## Turn 2

**Human (via the coordinator session):** Review fixes for the PR. Blocker:
conflict detection compared a refresh with the raw patch value, so the
client's own `null` removal or nested patch, read back before its response,
was reported as a conflict, also on later queued writes. Should-fix:
superseding and `retry` stripped whole top-level fields, dropping a failed
nested change that was never sent; the body format was not stored with the
write, so a restart under a changed document reinterpreted queued updates.
Nits: `__proto__` in `mergePatch`; document that a `null` in an update
response is stored as a value; note PUT-over-merge-patch as a follow-up.

**Assistant:** `detectConflicts` computes each merge-patch write's field
value after the patch (`patchedField`, applied in order from the first
write's base) and compares the refresh with that and with earlier writes'
results. `withoutSetBy`/`withoutPatched` strip nested members in
`supersede` and the `retry` path. Each update stores `updateBody`
(`mergePatch`, absent for a full record; added within outbox version 1);
`rebuild` and sending use the write's format; `restore` fails a mismatched
update and the writes queued before it, or keeps the entry unrestorable
behind a create; `retry` refuses such a write. `mergePatch` defines members
instead of assigning them. Tests for each. An earlier, unpushed commit that
merged update responses by RFC 7396 was dropped, as the review asked to
keep storing a response's `null` as a value.

## Turn 3

**Human (via the coordinator session):** Re-review blocker: a false
conflict still fires when an earlier merge patch failed, because the
expected value was chained through failed writes the provider never
applied (repro: `{meta:{a:'X'}}` refused 422, `{meta:{c:'3'}}` applied with
its response held, `sync()`). Nits: a mismatched failed head restored under
another format should get the format `lastError`; a README line that a
nested remote change is reported on the whole field.

**Assistant:** `detectConflicts` now computes, for every write first, the
values its patch gives the field (on its own base, and chained only through
queued writes, never failed ones), and accepts a remote value equal to any
of this client's writes' values. Failed updates restored under a mismatched
format get the format `lastError`. README "Refresh during a pending update"
says merge-patch conflicts are per top-level field. Tests: the repro, and
the restored failed update's `lastError`.

## Turn 4

**Human (via the coordinator session):** CI fails on `unified.test.ts >
uses the reader rate-limit policy and captures each attempt` (1999 instead
of 2000); find the root cause.

**Assistant:** The read `Budget` measures the wait from the clock when it
sleeps, so one millisecond between receiving the 429 and sleeping gives
1999 (reproduced with a clock that ticks per call). The code is right; the
test now freezes `Date.now`. Main merged in.
