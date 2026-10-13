# Session log — 2026-10-13: Throttling 0.5.0 plan tiers (pacer side)

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only (on top of the spec branch of #548).
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** Prepare the pacer side of
Throttling 0.5.0 plan tiers (#548): read `tiers`, choose the configured
tier or else the most restrictive, and fall back to the tier's window on
quota answers. Branch from #548's head; local only until its review is
back.

**Assistant:** `selectTier` (after the spec's `select_tier`): the tier the
caller names by its exact `name`, else the lowest `requests` per window
second (compared exactly, a tie to the longer window); undefined when any
tier does not parse, since the failed one might be the strictest.
`declaredThrottling(document, throttlingTiers)` reads a limit with `tiers`
through it into `windows` and `quotas` (so pacing and a `quotaExhausted`
fallback use the tier) and records the tier in force; a limit whose tiers
do not parse is left out, as other unparseable entries are. The
`throttlingTiers` option reaches it from `createApiClient`,
`readCollections`, `readPlatform` and `paginate`. Tests on the spec's
Clockify example: the tier choice, the tie rule, unparseable tiers, the
`quotaExhausted` window, and the client's pacing with and without a
configured tier. Changelog for 0.23.0.
