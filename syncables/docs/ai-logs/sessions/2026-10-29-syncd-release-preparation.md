# SyncD / Keep release preparation

Session: no public chat URL supplied; this repository record is available at
https://github.com/ontola/atomic-plugins/blob/codex/syncd-keep-release-0-26/syncables/docs/ai-logs/sessions/2026-10-29-syncd-release-preparation.md

Assistant: OpenAI Codex, GPT-6. This is AI-assisted release preparation, not an
Opus review or an assertion of independent human approval.

## Human request

After the assistant reported merged two-way SyncD support (#713), with deployment
and a live scratch-note trial still needed, the maintainer said:
“ok please continue”.

## Assistant work and explanation

Read the standing release recipe and current environment readiness, checked
registry versions and the Heroku wrapper's exact dependency, and verified the
merged implementation's CI/publication state. Prepared syncables 0.26.0 and
atomic-integration-proxy 0.4.1 release metadata and consolidated the unreleased
notes around the final PostgreSQL/CLI implementation. Existing versioned
artifacts and provider behavior were not changed.

The release rules require Opus-reviewed, merged, green main, with Heroku work
through the coordinator worker. This cloud worker has no Opus or Heroku access.
Requested that review/rollout through the existing #227 board and prepared a
concrete rollout handoff. No release tag, package publication, auto-publishing
release merge, Heroku change or live Google mutation was performed.

The handoff explicitly preserves the actual production catalog before updating
Keep: the new ten-entry source default must not silently replace a production
selection containing additional providers. It covers registry-backed wrapper
locking, fresh write approval, a dedicated local trial database to avoid sending
unrelated queued edits, operating only on the returned id of a newly created
scratch note, uncertain-create recovery, and rollback limitations.

Local candidate validation passed: 1,858 tests in 105 files against a dedicated
PostgreSQL test database, full TypeScript build, lint, formatting, changelog
validation, and the installed 0.26.0 tarball's nested-checklist create/pull/
replace/pull/delete smoke. Proxy fmt, Clippy with warnings denied and packaging/
verification of the actual 0.4.1 crate passed with the locked dependency graph.
The release handoff's relative links resolve and the diff is whitespace-clean.
Exact-head hosted CI/review outcomes are recorded in the release PR. The existing
implementation had already passed Node 22/24/26 and the full proxy suite before
this release-only preparation.

Only invented fixture data is used locally. Credential values and private note
contents are omitted.
