# Session log — 2026-10-05: deletion feeds

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), worker subagent of the atomic-plugins oversight session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` and `openapi-extensions/` (a new draft spec).
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; tests use invented data.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the oversight session):** Issue #325, part of the maintainer's
decision Q-072 ("both": the API document's declaration where there is one,
else one GET). Specify a small draft extension for deletion feeds (a
changed-since list with tombstones, a deleted-items endpoint, a
`status: deleted` marker in a change feed): how a tombstone is recognised,
how the cursor works, how it relates to CRUD Causality and Collection
Completeness, with a survey of real APIs from the overlays and precedence
against `x-completeness` and the item GET. In syncables, consult a declared
feed before the item GET within the same sync budget, reading it once per
sync from a cursor in durable storage, keeping the invariants of
#312/#313/#324, and report the feed as the evidence source. No overlay for a
real provider; invented fixtures only.

**Assistant:** Surveyed the documents that the YNAB, Google Calendar, Asana,
Box, Stripe, Todoist and Xero overlays extend, and specified
`openapi-extensions/spec/deletion-feeds/` (0.1.0-draft): `x-deletion-feed`
on a Collection Object or list operation, naming a GET operation, an
envelope, a cursor (`parameter`, `responseField`, `expiredStatuses`), a
tombstone marker (`field`, `values`) and `idField`; the last item about an
object decides. It ranks `absent: deleted`, then a tombstone, then the read
operation, and states when a feed read without a tombstone shows that an
object was not deleted. In syncables:

- `readFeed` reads the feed once per complete sync of a collection scope,
  through the sync's `Budget` and `walkPages` (which now yields each page's
  body, throws `PageStatusError` with the status, and takes an explicit
  `itemsField`), from the cursor stored in the outbox (`feedCursors`, within
  version 1). An incomplete or malformed read gives nothing and keeps the
  cursor; a declared expired status replaces or drops it.
- A missing record whose last feed item is a tombstone is `deleted` with
  `source: 'feed'`, without a GET; otherwise the GET decides as before. No
  `filtered` is taken from the feed alone: the update needs a fresh copy.
- Tests in `__tests__/unit/client/deletion-feeds.test.ts`; README, CLAUDE.md
  and the changelog's Unreleased entry updated.

Not verified against a real provider; no overlay declares `x-deletion-feed`.
