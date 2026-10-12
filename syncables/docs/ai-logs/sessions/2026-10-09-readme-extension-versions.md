# Session log — 2026-10-09: README extension versions audit

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** A small `syncables/README` audit:
make sure every extension version it claims to read matches what is on
main.

**Assistant:** Compared the README's claims with each spec's
`**Spec version:**` on main and with the extension fields `src/` reads.
Pagination Schemes 0.5.0, CRUD Causality 0.4.0 and Throttling 0.2.0-draft
matched; Collection Completeness and Deletion Feeds were named without a
version (0.1.0-draft and 0.2.0-draft on main, which is what the code reads,
`x-read-tombstone` included). Added a table of the versions read and what
each covers (and does not: `incrementalSync`, header/response-field
auto-detection, CRUD request/patch/mint semantics, pacing against `limits`),
with the specifications Syncables does not read; versions on the two draft
mentions; the read limits' retry line, which still said only a 429 is
retried, now names declared throttling signals too. CLAUDE.md's two links
to the old pondersource repository point at the spec in this repository.
The changelog is left as written.
