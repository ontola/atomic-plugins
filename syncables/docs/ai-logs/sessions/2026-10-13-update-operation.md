# Session log — 2026-10-13: the update operation follows x-crud

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** The client sends a PUT whenever
the item path has one, even when only the PATCH carries `x-crud: update`.
Investigate first and report before changing anything.

**Assistant:** `clientRoutes` chose PUT if the item path had one, else
PATCH, and read `x-crud` only for the body of the chosen operation; creates
and deletes already follow `x-crud`. The README and CLAUDE.md called it
"declared PUT". Composing every platform of every dated catalog, Google
Calendar's events (the `app-crud-causality` overlay declares the PATCH; the
document also has a PUT) were the only mismatch. Two overlay findings
(Calendar's update without `mode`, GitHub's `patchFormat: merge`) went to
the overlays workers. Proposed: a declared operation wins; both declared,
PUT; neither, today's fallback; legacy unchanged.

## Turn 2

**Human (via the coordinator session):** Confirmed; a declared `jsonPatch`
PATCH beside an undeclared PUT follows the document (`update()` throws).
Implement with the five tests and fix the wording.

**Assistant:** `clientRoutes` now picks the declared operation as proposed.
Six tests in `update-modes.test.ts` (declared PATCH over an undeclared PUT,
the reverse, both, neither, another resource's `x-crud`, the `jsonPatch`
case); the two behaviour changes fail on the code before. README, CLAUDE.md
and an Unreleased changelog bullet updated.
