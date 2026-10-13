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
