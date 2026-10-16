# Resume the Syncables CLI/cache draft

- Tool/model: Codex (OpenAI, GPT-6).
- Session: codex://threads/01a1438a-9d88-71ee-b46a-d1dd0643907a
- Scope: update draft PR #567 against current main and assess its readiness.

## Substantive user requests

The user asked how to test Syncables with real providers and how usable its
executable was, then recalled a prior chat about a standalone daemon syncing
with AtomicServer or another personal data store. After the assistant found
the earlier chat, issue #566 and draft PR #567, the user said "ok go" to
resuming and assessing that draft.

## Substantive assistant output and changes

The assistant initially assessed only main/npm and corrected that assessment
after finding the separate CLI branch. The draft implements device login,
read-only probing, local PostgreSQL archival/caching/replay and replication
definitions; native replication and daemon installation remain later stages.

Merged main at 18e42516 into the draft, keeping current Syncables 0.24.0 and
its newer pagination, throttling and read behavior. Resolved package-script
and changelog conflicts. Further validation and review follow-up are recorded
below. Test data and credentials are invented; no provider data is committed.

Addressed the complexity review by sharing the proxy-prefix and fresh-response
checks and importing readdir with the other filesystem functions. Retained
explicit live/cache modes and bounded lease/wait controls: live mode deliberately
refreshes sequential requests even when maxAgeMs is supplied. A database test
now verifies that distinction. Kept the historical disclosure log because the
repository requires it, and moved the draft's changelog bullets into fragments.

Added a CLI auth test against integration-proxy's checked-in device contract,
including the documented public client, scopes, endpoints, connection discovery
and proxy route. CI reruns Syncables when that fixture changes. Updated the
live guide with the published client/scopes and operator approval requirements.

## Validation

On Node 24.19.0 with disposable PostgreSQL 17, the merged full suite passed
1,636 tests in 87 files. After adding the two regression/contract cases, the
affected CLI, PostgreSQL and client selection passed 797 tests in 39 files.
Lint, formatting, TypeScript compilation, release build and changelog-fragment
validation passed.

Installed an npm tarball into an isolated directory: Node/browser/PostgreSQL
imports and executable help passed, and all three backend definitions could
be added/listed. The installed executable completed mock device approval,
recorded one upstream read and one cache hit, then replayed both after stopping
the mock API and restarting PostgreSQL. Its invented 4,360-byte response used
one 100-byte compressed payload (payload bytes only).

Live localthought.io/GitHub authorization was not verified: localthought.io is
outside this cloud environment's allowed outbound hosts, and the remote web
reader could not access discovery. This does not establish the current live
deployment's status. Persistent auth, coverage/outbox, daemon installation and
runtime Atomic/NextGraph/remoteStorage replication remain later stages of #566.

GitHub's full Syncables matrix passed on Node 22, 24 and 26. The required
repository CI exposed a missing lockfile update in the original scaffold:
the issue-tracker lane installs Syncables with pnpm, while the draft had
updated only package-lock.json. Regenerated pnpm-lock.yaml with CI's pnpm
10.15.1 and verified an isolated frozen install before republishing the fix.
