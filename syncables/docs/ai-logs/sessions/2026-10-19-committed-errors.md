# Session log — 2026-10-19: CRUD Causality 0.8.0 committedErrors

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`: `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** the coverage list is nearly
exhausted; propose the next most valuable syncables unit, then do it.

**Assistant:** Proposed CRUD Causality 0.8.0 `committedErrors` (§4.3.3),
the one spec feature the README listed as not read, because it is a
data-safety gap: `mayHaveApplied` treats a `503` as not processed, so a
Notion create answered `503` after it saved the page was retried and
created a second page. `createDeclaration` now reads the usable entries
(rules 30–31; ignored beside `followUps`, rule 32), `committedIdentity`
ports `committed_identity()` with its usable-value rule, and the write
loop checks a create's error response first: a match settles the create
as applied and bound to that id, or applied but unbound when the id
field's variable is not named. Tests in
`unit/client/committed-errors.test.ts` (19: the reference's matching
rules, the first match, refused entries, and three client runs; the
applied-and-bound run fails on the code before). README section and spec
table (CRUD Causality 0.8.0), a fragment. No overlay declares
`committedErrors` yet; Notion's would follow separately.

## Turn 2

**Human (via the coordinator session):** #667's review: arm
`unboundKnown` for an applied-but-unbound create, keeping the named
identity; treat a listed but unmatched status as may-have-applied;
refuse array steps in identity paths, as `get_path` does; client tests
for applied-but-unbound, an update with a matching body, an
`x-throttling` 503 beside a match, and a restart; note JSON `5.0`.

**Assistant:** `rememberUnbound` (shared with the 2xx path) arms
`unboundKnown`, and the fields the error named are merged into the
create's data and shown on the local record. A status listed in
`committedErrors` makes the create's failure `appliedMaybe`. Identity
paths walk own object properties only (`objectPath`). Seven new tests
(an array step, `5.0`, uncertain and resent-under-key for a listed
unmatched status, an update, the throttling signal, a restart) and the
unbound create bound by `matchUnboundCreates`; three fail on the
previous head.
