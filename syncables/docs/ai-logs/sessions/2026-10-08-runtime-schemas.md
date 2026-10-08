# Session log — 2026-10-08: Runtime Schemas consumer (K16)

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the coordinator session):** The Runtime Schemas consumer
(K16). The spec is #398 (`claude/runtime-schemas`). In syncables: read
`x-runtime-schema` on a CRUD resource's references; fetch the describer
through `describedBy`, once per read, with at most one re-read; interpret
members by `match: id` or `key`, keeping `invalid`, `unmatched` and
`undescribed` apart; never guess a value (missing means no value, never
`null`). Expose the derived class and the members' values in the read
result with the smallest API that fits; fixture tests from the Notion
example only. Stay out of `src/pagination`.

**Assistant:** A new `read/runtime-schemas.ts`, ported from the spec's
reference functions (`derive_class`, `read_members`): it parses the
declaration and its reference (an unusable one goes to `errors`, and the
items are read without it), binds each item's describer path from the
reference bindings and the request context (none when a bound field is
absent, `null` or empty), reads each describer once per read through the
read's budget, derives its class, interprets the members, and reads a
describer once more when a member matched no definition, interpreting only
the items with an unmatched member again. `readCollections` returns
`describers` and each snapshot's `runtimeMembers` (aligned with `items`),
only when a read resource declares the extension; four types are exported.
A failed describer read leaves its items' members all unmatched, with the
error on the describer. Tests: 17 cases on the spec's §7.1 example
transcribed as a fixture. README (read section and Unreleased changelog) and
CLAUDE.md updated. Not done: writes, value conversion, and use of the
classes in `readPlatform` or the client's `sync()`.
