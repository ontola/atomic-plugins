# Session log — 2026-10-14: Throttling 0.5.0 plan tiers, the pacer side

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`: `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** (2026-10-13) implement the pacer
side of #548's plan tiers on its draft, local only until its review is
back. Later: #548's review rejected "the most restrictive average rate" as
unsafe (a long-window tier allows big bursts). The merged rule: without a
configured plan, keep within every tier at once, each counted separately;
a plan no tier names likewise; the quota fallback is the configured tier's
window, else the longest; tiers name their plans in `plans`. Rework the
parked branch on main, with a test where a long-window tier would allow a
burst a shorter tier refuses.

**Assistant:** rebuilt from main (the first version, which picked the
strictest tier by name, is kept as a local branch). `parseTiers`,
`limitsInForce` and `fallbackWindow` port the spec's validator checks and
reference functions; `declaredThrottling(document, plan)` puts a plan's
tier into `quotas` and every tier otherwise into the new `tieredQuotas`,
with `fallbackWindow` in `windows`; `Pacer` takes `tieredQuotas` as an
optional third argument and checks one request log per bucket against
every quota. The option is `throttlingPlan` (one plan per account, as the
spec's `plans` name it) on the client, `readCollections`, `readPlatform`
and `paginate`. Tests in `unit/throttling/plan-tiers.test.ts`: the
reference functions, unparseable tiers, the declaration with and without
a plan, the fallback window, a burst the hourly tier alone would allow and
the per-second tier refuses, the hourly average the per-second tier alone
would exceed, and the client with and without a plan. README, CLAUDE.md,
changelog.
