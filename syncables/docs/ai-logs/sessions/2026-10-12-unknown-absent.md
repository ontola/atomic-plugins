# Session log — 2026-10-12: an unrecognised absent fails closed

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** The #477 review found that under
an unrecognised `absent` with no `notFound`, `validate.py` gives
`unavailable` while syncables falls back to `deleted` (a 410 without `gone`
too). Check against the spec; if it agrees with Python, fail closed.

**Assistant:** The spec agrees: §7 says that under an unrecognised
`absent`, a `404` (or a `410` without a recognised `gone`) is classified by
a recognised `notFound`, "else as `unavailable`, never by the `deleted`
default", as `classify_read` does with the read collection's declaration.
Route discovery now gives a route whose own Completeness Object has an
unrecognised `absent`, when the resource states no `notFound`,
`notFound: unavailable` (with `unrecognisedAbsent` for the report's
detail). Tests: a 404 and a 410 under `absent: archived` are
`unavailable`; a recognised `notFound: deleted` beside it still decides.
Both new failure cases fail on main. `gone` itself is #477's (not on main
yet).
