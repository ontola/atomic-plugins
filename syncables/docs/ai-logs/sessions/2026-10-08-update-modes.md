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
