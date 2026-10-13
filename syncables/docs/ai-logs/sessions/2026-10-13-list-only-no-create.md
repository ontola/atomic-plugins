# Session log — 2026-10-13: no create on a list-only resource

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** #524 review: CRUD Causality 0.6.0
says a resource without `identity` is read-only, but syncables still sends
`create()` for it when its collection URL has a POST (`clientRoutes`'
heuristic `createPath`). Skip the heuristic when the document has
`crudResources` and the collection has no item URL, with a test, as a
separate PR for 0.22.1.

**Assistant:** `clientRoutes` takes the collection POST as the create only
when the collection has an item URL (or the document is legacy); an
`x-crud` create still counts. Tests: a list-only resource reads its
collection and `create()` throws without a request (fails on the code
before); a resource with an identity, and one with an `x-crud` create,
still POST. Changelog bullet for 0.22.1 and CLAUDE.md.

## Turn 2

**Human (via the coordinator session):** #531 review nits: an `x-crud`
create of a resource without identity breaks rule 25, so refuse it too; a
create queued by 0.22.0 for a now list-only resource fails as `uncertain`
with "Cannot read properties of undefined (reading 'replace')", so fail it
cleanly; the heuristic only applied to collections read by GET; fold in
the `idField` doc comment. Merge main.

**Assistant:** An `x-crud` create of a resource without identity sets
`createRefused`, so `create()` throws without a request. On restore, a
queued create whose route has no create (or a refused one) is parked:
`failed` (an `uncertain` one stays uncertain) with "declares no create
operation; not sent: discard it"; `resolveWrite` `retry` throws and
`discard` drops it. The new restore test fails on the code before (it sent
the POST). The changelog names collections read by GET and the `idField`
documentation; main was already merged.

## Turn 3

**Human (via the coordinator session):** Delta review: a create in flight
at the stop with a usable idempotency key becomes `failed` and loses its
"may have been in flight" error, though it may have applied; keep it
`uncertain` with its error and append the note, with a test. Mention the
rule-25 message in the changelog; wrap CLAUDE.md. Merge main, keeping
#525's Produced Classes bullet first.

**Assistant:** On restore, a parked create that was in flight at the stop
(or already uncertain) stays `uncertain`, its error kept and "declares no
create operation; not sent again: confirm it with the server's id if it
applied, or discard it" appended; any other is `failed` ("…; not sent
again: discard it"). Test: a POST that never answers, then a new client on
the same storage with the resource list-only (fails on the previous code).
Changelog and CLAUDE.md updated; main merged with the bullets in order.
