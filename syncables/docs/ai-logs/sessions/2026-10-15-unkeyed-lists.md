# Session log — 2026-10-15: replace and lists without item identity

- **Session:** https://claude.ai/code/session_01S2rsKRtSn9hMiuJ1fmZfV5 (a Claude Code thread in the maintainer's project, working on the Google Keep drive app, ontola/atomic-plugins#593).
- **Model/tool:** Claude Opus 5.5 in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`: `openapi-extensions/spec/crud-causality/`, `syncables/`, `integrations/google-keep/`.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human:** "ok i understand that Google Keep is a very crippled API that is
OK to read from but hard to write to. Can you somehow generalise the work
you did for this and move it into Syncables?"

**Assistant:** surveyed syncables' write client: `update()` throws without
an update operation, there is no create-then-delete fallback, and arrays are
only replaced whole; nothing in syncables, devonian or reflector merges a
list. Proposed (1) a CRUD Causality field for "replace by create, then
delete" with the objects that must not be replaced, (2) a field for list
fields whose items have no id, with the Keep app's list merge moved into
syncables, (3) the fingerprint baseline as a helper.

## Turn 2

**Human:** chose "All three" on a decision card.

**Assistant:** CRUD Causality 0.7.0: `replace` (§4.8, Replace and Block
Objects) and `unkeyedLists` (§4.9, the pairing passes), rules 27-29,
`replace_block` and `pair_items` in `validate.py`, the §7.8 example and
tests. syncables 0.24.0: `replace.ts` (`replaceOf`, `replaceBlock`),
`unkeyed-lists.ts` (`unkeyedListsOf`, `flattenList`, `nestList`,
`pairItems`, `mergeUnkeyedList`, generalised from the Keep app's
`mergeList`: any item fields, merged per top-level field) and
`fingerprint.ts`, exported from both entries, with tests mirroring the
Keep app's and the spec's. `createApiClient` is unchanged: replacing on
`update()` inside the durable outbox is left for later.
