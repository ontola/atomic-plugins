# Syncables deletion-work verification and guide update — 2026-10-06

- **Session:** [Codex conversation](codex://threads/01a0fb75-f5eb-7293-9664-36d7bb89c7a2)
- **Tool/model:** OpenAI Codex, GPT-6-based coding agent; the exact deployed
  model version is not exposed in this session.
- **Scope:** Verify the remaining remote-deletion work requested by the
  maintainer, and update the local-first guide to match current Syncables.
- **Review/merge:** The maintainer previously delegated review and merge
  decisions (“i trust you, merge your pr when you see fit”). This log records
  agent review under that delegation, not human line-by-line review.
- **Redaction:** No credentials or personal provider records were used.
  Personal filesystem paths and tool-call plumbing are omitted.

## Human request and context

The maintainer asked how much work was complete and what remained. The
assistant reported its two merged PRs (#269 and #320) and named remote-deletion
handling and deletion evidence as remaining work. The maintainer replied
“ok go ahead”.

## Assistant work

After updating from main and reading current issue history, found that another
session had already completed those features in #324, #327 and #330, closing
#260 and #325. Corrected the earlier status in conversation and verified the
current source and regression coverage. Did not claim to have authored those
implementations or start a duplicate implementation.

The existing local-first guide still described package 0.18.0 and said deletion
feeds were unsupported. Updated it to name the 0.19.0 and 0.20.0 feature
boundaries and explain held updates, completeness declarations, deletion feeds,
read tombstones, item GET evidence, application callbacks and recovery controls.
Linked the draft specs and detailed reference. Preserved provider-dependent
limits and the distinction between invented-provider regressions and live
compatibility. This continuation changes documentation only.

## Validation

On current main before the documentation change, Node 22 validation passed:
387 tests across 23 files, lint, TypeScript build and source formatting. That
includes missing-record, deletion-feed, read-tombstone, ordering, read-budget
and restart regressions. Documentation links and heading anchors and the
existing runnable guide example were checked against the built package.
GitHub CI evidence is recorded in the PR body. No live provider testing or npm
publishing is part of this work.
