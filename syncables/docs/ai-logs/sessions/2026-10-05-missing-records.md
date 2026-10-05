# Session log — 2026-10-05: records a refresh no longer returns

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), worker subagent of the atomic-plugins oversight session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` and `openapi-extensions/` (a new draft spec).
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; tests use invented data.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the oversight session):** The last part of #260, as the
maintainer decided. Q-071 "fail": an unsent edit made in the running client
whose record a complete refresh no longer returns must become `failed`, not
be sent as the last known copy plus the edit; an earlier attempt (reverted)
lost the newest edit by failing a queued write behind one in flight, so only
the head of a record's queue may fail, and only when no earlier write of the
record is in flight; updates behind a create are not affected; decide PATCH.
Q-072 "both": tell a deleted record from a filtered one by the API
document's declaration where there is one (check `openapi-extensions/spec/`,
else specify the smallest new extension as a 0.1.0-draft), otherwise by one
GET of the record (404/410 deleted, 2xx filtered with a fresh copy, anything
else unknown), bounded by the sync budget, not for records without a pending
write unless the app opts in; expose the result without deleting anything
locally; store new per-write state in the outbox. Cover the in-flight-head
case, PUT and PATCH, declared and undeclared collections, 404/410/2xx/5xx,
the budget and restarts.

**Assistant:** No existing extension states that a list is complete (the
Filtering proposal says a missing annotation means "not described"), so it
specified `openapi-extensions/spec/collection-completeness/` (0.1.0-draft):
`x-completeness: { absent: deleted | removed }` on a CRUD Causality
Collection Object or a list operation; deletion feeds are left out. In
`src/client/client.ts`:

- A complete read that lacks a record with queued updates holds them
  (`awaitingRefresh`), up to the record's first create and never one in
  flight. When the head is such an update and idle, the client checks the
  record: the declaration, else a GET through the sync's own `Budget`
  (`readCollections` gained a `budget` option). `deleted` and `unknown` fail
  the head and the held updates after it (`missingRecord`, stored in the
  outbox, version 1); `filtered` takes the returned record as confirmed,
  checks conflicts and releases them. Records the budget did not cover wait
  for the next sync. A head that was between retries is failed and its
  drain woken, so a later retry does not wait out the old backoff.
- PATCH is treated like PUT: the client's PATCH body also carries the whole
  last known record.
- `onMissingRecord` and `missingRecordChecks` (`pending`, `all`, `none`); a
  new `update()` of a record still known missing is held too.
- Tests in `__tests__/unit/client/missing-records.test.ts`, four existing
  tests updated to the new behaviour, README, CLAUDE.md and the local-first
  guide updated.

Not verified against a real provider; no overlay declares `x-completeness`.
