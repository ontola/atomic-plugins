# Session log — 2026-10-13: bind unbound creates from a read (opt-in)

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`: `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** pick another syncables gap that
needs no live account and touches neither throttling, pagination
`incomplete` nor the unavailable re-check; plan first.

**Assistant:** chose the README's "Finding it automatically is not
implemented" for unbound creates (CRUD Causality 0.5.0 §4.3.2: a 2xx that
did not identify the record). Plan: opt-in, bind from the first complete
read after the create's answer when exactly one new, write-less record
equals every sent field and no other create claims it; one chance, in
memory.

## Turn 2

**Human (via the coordinator session):** plan the data-safety cases: two
identical creates, and a record created elsewhere with the same fields.

**Assistant:** two identical creates bind neither (a shared candidate, or
two candidates each). The residual risk: our record filtered out of the
list while someone else's identical one shows, a single candidate bound
to a stranger's record. Proposed (a) opt-in plus documentation or (b) also
requiring a field the app declares unique.

## Turn 3

**Human (via the coordinator session):** go with (b), an option such as
`uniqueFields: { resource: [field] }`; without such a field nothing binds;
document the residual risk; test both identical-create cases, the
stranger record with another unique value, and a restart.

**Assistant:** `matchUnboundCreates: { uniqueFields }` (collection names,
resolved at construction; an unknown one throws). A create is remembered
only when its body carries a listed field (not the id field, not `null` or
`""`) and its scope had a complete read before the answer; `matchUnbound`
binds it as `resolveWrite(confirm)` does and lists it on
`SyncResult.matched`. README (rules, what stays unbound, the residual risk
of a value that is not in fact unique), CLAUDE.md, changelog. Tests in
`match-unbound.test.ts`: a bind with a queued edit sent to the server id,
both identical-create cases, the stranger record, no unique value (three
ways), a record that existed before, one chance, no read before, a
restart, an unknown collection. Removing the unique-value or the
shared-candidate rule fails two of them.

## Review fixes (#559)

B1, reproduced by the reviewer: `completeScopes` took the scope when the
snapshot arrived, before it was applied, so after a read the presence
handler refused (or a stale one, or a create answered in between on a
first sync) the create's `known` ids were empty and a record that already
existed counted as new and was bound. The scope is now added only where
the read is applied (`confirmed.set`, and an unchanged read). New test:
the presence handler throws on the first sync, the create matches a record
that read returned; nothing binds (fails on the code before). Nits: the
README states the window (from the last applied complete read before the
answer to the first complete read after it) and says "applied"; ids
another create was confirmed with are not candidates; a comment on
draining mid-sync.
