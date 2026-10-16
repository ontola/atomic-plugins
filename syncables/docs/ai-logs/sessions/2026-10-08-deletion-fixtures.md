# Session log — 2026-10-08: deletion declarations as spec fixtures

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Fable 5.1 (`claude-fable-5-1`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; every provider in the fixtures is invented.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the coordinator session):** Two batch-1 pieces for the
syncables package, as separate branches. First, the consumer side of
pieces.md P1: use `x-ratelimit-*` response headers when a response carries
them, following what the Throttling spec in `openapi-extensions/spec/` says
about header roles, and stop rather than invent a field if the spec does
not define them. Second, the Codex handover's suggestion: fixture-based
validation of the deletion declarations (Deletion Feeds and Collection
Completeness, as syncables reads them) and of pending-edit recovery (a
write in flight across a restart, a lost answer, a refused write). Fixtures
only, no live providers, no behaviour change beyond a clear bug fix, and
any fix named explicitly. Report with the package's own lint, typecheck,
test and build results.

**Assistant:** Stopped on the first piece: the Throttling draft
(0.1.0-draft) says in so many words that it "adds no header-role mapping or
competing RateLimit wire format" and that header names alone do not
establish units or meaning, and pieces.md K6/K7 list that header-role
extension as still to be written. Reported this instead of inventing a
field.

For the second piece, added `__tests__/fixtures/deletion-declarations.ts`,
which completes the specs' own examples into runnable OpenAPI documents
(Deletion Feeds §2 YNAB-shaped change list whose feed is the list itself,
§7.1 calendar change list with `syncToken` and a 410, §7.2 event log with
`idField: resource.gid` and a 412 that carries a fresh token, §7.3
deleted-items endpoint without a `tombstone`, §7.4 read tombstone, the two
§6 overlays; Collection Completeness §2 in both placements, §6 nested
`projectTasks` with items at `/tasks/{taskId}`, the §4.1 fixed-query
issue tracker, the §5 overlay), and
`__tests__/unit/client/deletion-declarations.test.ts` (25 tests), each
test naming the spec statement it checks, plus pending-edit recovery on
those documents: a PUT in flight across a restart (replayed on the
refreshed record; failed on a 404 when the record was deleted meanwhile,
with the stored feed cursor sent again), a lost answer (a PUT whose
transport throws is retried, a POST becomes `uncertain` and is confirmed
to the server id, and the state survives a restart), and a refused write
(422 fails at once, a delete's 404 is satisfied, a 403 blocks the client
until `authRenewed()`).

No behaviour was changed. The fixtures showed one gap, filed as #373 and
left for its own change, since it is a feature of the CRUD Causality
consumer side rather than a bug: the collection read locates items at a
top-level array property or a common envelope name, not at the Collection
Object's `envelope.itemsField` dot-path (which the feed read does use), so
the §2 example's list (`{ data: { transactions: [...] } }`) is not read
completely and its feed is not read. The §2 test states the spec's
behaviour and is marked `it.fails` until #373. CLAUDE.md's test inventory
was updated.

**Review (Opus, PR #372):** the first version of the §2 test asserted
today's behaviour as expected, locking the gap in, and its fixture's
Collection Object declared no `envelope` of its own (only the feed did), so
the fake's `{ data: { transactions } }` body was inconsistent with CRUD
Causality's default. Fixed as above (the Collection Object's `envelope`
added, the test rewritten as the spec's behaviour and marked `it.fails`),
plus: the §7.2 412 test now puts a tombstone in the 412 body and checks it
is not used; the two restart tests release the first client's hung PUTs so
no timer is left behind; the session trailer uses the
`claude-code://sessions/<id>` form.

## Turn 2

**Human (via the coordinator session):** Issue #373: read the CRUD
Causality Collection Object's `envelope.itemsField` (and any other envelope
fields the spec defines) in the collection read, in `src/read/model.ts` and
`src/read/pages.ts`. No new spec is needed. Keep it bounded and backward
compatible (no envelope means today's behaviour), flip the §2 `it.fails`
test to passing, and add tests for a nested path, a missing path (a clear
error, not a silent empty read), and the feed read staying consistent. Base
on the fixtures PR's head if it has not merged.

**Assistant:** Based the work on the fixtures PR (#372, not yet merged).
`ReadCollection` gained `itemsField`, read from the Collection Object's
`envelope.itemsField` when it is a non-empty string (omitted, `null`, an
empty string or a non-string leave it absent); `readCollections` passes it
to `walkPages`, which already took an `itemsField` for the feed read, so
the collection read and the feed read of one operation now share the
declaration. Without it, `pageItems` locates the array as before. The
error for a declared path that holds no array now names the declaration
("No items array at <path> (the declared envelope.itemsField)"); such a
read is incomplete and `sync()` rejects, never an empty collection. The
Envelope Object has no field other than `itemsField` (and `x-*`), so
nothing else was read; the same object's placement on a pagination
scheme's `response.envelope` is not in syncables' pagination types and was
left out, as a possible follow-up. New
`__tests__/unit/read/collections.test.ts` (the model field, a nested path,
missing and non-array paths, no heuristic once declared, the unchanged
heuristic without a declaration), and the §2 `it.fails` test became three
passing tests (list and feed through the shared envelope with the numeric
cursor sent back in decimal form; a `deleted: true` tombstone found through
the identity binding; `"true"` is not `true`). README (collection
declarations, an Unreleased changelog entry) and CLAUDE.md updated.
