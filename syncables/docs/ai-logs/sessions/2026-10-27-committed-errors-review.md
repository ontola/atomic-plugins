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
