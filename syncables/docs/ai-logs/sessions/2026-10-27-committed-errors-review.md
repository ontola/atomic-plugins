# Session log — 2026-10-27: committedErrors complexity review

- **Session:** Codex task `/root/syncables_review`, delegated by the parent
  PR-readiness session. No shareable session URL was exposed to the worker.
- **Model/tool:** OpenAI GPT-6 in Codex.
- **Repository touched:** `ontola/atomic-plugins`: `syncables/` only.
- **Redactions:** No credentials or private records were used. Tool plumbing
  and local execution paths are omitted.

## Request

**Human, through the parent session:** Make all open PRs ready for trekmeester
to merge easily, including the remaining review comments.

## Changes

**Assistant:** Addressed the complexity review of PR #667. The restart test
uses the existing `InMemoryStorageAdapter`, and three create-retry scenarios
share one table-driven setup. `committedValue` delegates common identity
checks to `segmentProblem` and retains the committed-error-specific control,
URL delimiter and non-negative integer rules. The committed-create comment
now documents `committedCreate`, rather than its adjacent helper.

Sharing validation also rejects lone Unicode surrogates that the previous
committed-error parser accepted. New high- and low-surrogate cases failed
against the previous parser; the ordinary identity binding already refused
these values. The existing changelog fragment records this correction.

## Validation

On Node 22.23.4, all 90 unit-test files and 1,745 tests passed, including
the shared-storage restart, uncertain-create retry, applied-but-unbound
binding, and new malformed-Unicode cases. Package TypeScript checking,
ESLint, and the full Prettier check passed. The two surrogate regressions
failed against the previous parser before the shared validation was applied.

No PR was merged, and no package was published by this worker.

## Current-main integration

Merged main b65af73b without rewriting the source branch. The only conflict was the README extension table: retain main’s Pagination Schemes 0.10.2 row and this PR’s CRUD Causality 0.8.0 committedErrors row. All other main changes merged automatically.

On the combined tree, Node 22.23.4 passed 1,864 tests across 105 files with an isolated PostgreSQL database; TypeScript, ESLint and the package formatting check passed. No runtime bypass, release or deployment was used.
