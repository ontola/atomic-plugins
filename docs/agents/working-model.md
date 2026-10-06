# Working model

## The board

[#227](https://github.com/ontola/atomic-plugins/issues/227) is the
coordination board for every Claude session on Michiel's Atomic projects
(ontola/atomic-server, ontola/atomic-plugins, ontola/atomic-saas). Its body
holds the rules; its comments are the shared log. Cloud sessions can't message
each other, so they report there. The rules, in short (the issue body is
authoritative):

- **Michiel decides product questions only.** Engineering choices are the
  session's; write the reasoning in the PR or issue.
- **Questions for Michiel** go to the coordinator ("the big boss"), who puts
  them in his decision inbox with a stable id (`Q-###`). Post "Question for
  Michiel: …" on #227; don't number questions yourself.
- **Never merge into atomic-server `develop`.** Only the trekmeester (Joep's
  agent) does, in batches.
- **atomic-server freeze (Michiel, 2026-10-01).** No new atomic-server PRs and
  no new pin candidates; only shepherd the open ones. A host need becomes an
  **issue for Joep** on atomic-server (for example atomic-server#1952), drafted
  in the worker's report. Atomic-plugins stays on the current pin. The
  coordinator session can't file in ontola/atomic-server, so it collects the
  drafts on #227 for someone with access (see
  [Issue drafts for Joep](#issue-drafts-for-joep)).
- **Pin bumps** (`.atomic-server-ref` → a candidate) are pre-approved. See
  [pins.md](pins.md).
- **Never `git commit --no-verify`.** Fix or report a failing hook. This repo
  has no git hooks of its own (no `core.hooksPath`, nothing in `.git/hooks`
  as cloned). Rule 5's "Fresh Worktrees" warm-up is not in this repo's
  AGENTS.md; presumably it is atomic-server's (not verified).
- **Never commit test data or secrets:** no `.lane-store/`, data or config
  directories, `node.key`, `*.redb`, `.env` or credentials. Stage paths
  explicitly and check `git status` and `git diff --cached --stat`. Report a
  leak on #227 instead of rewriting history.
- **Pickup comment** on an issue before working on it; check for others'.
- **Invented data only** in fixtures, seeds, screenshots and recordings.
- **Mic, camera and screen permission pages are tested headlessly** with fake
  media (see `usertest/e2e/run.mjs`), never opened in Michiel's browser.
- **Outward actions beyond PRs and issue comments** (droplet or
  localthought.io deploys, publishing packages, posting outside these repos)
  need Michiel's OK; see [usertest-droplet.md](usertest-droplet.md) and
  [proxy-release.md](proxy-release.md) for what is standing.
- **Push work in progress** to your own `claude/*` branch at least hourly.
- **Rule 12:** an atomic-plugins PR with a green `CI` gate may be merged by
  the session that made it (Michiel, 2026-09-30). It doesn't cover
  atomic-server or deploys and publishing. See
  [ci-and-merging.md](ci-and-merging.md).

## Sessions

Since 2026-09-30 ([#227 comment](https://github.com/ontola/atomic-plugins/issues/227#issuecomment-5911922325)):

- **Light work** (CI triage, reviews, small fixes, rule-12 merges, pin bumps):
  the coordinator, through its own sub-agents. Since 2026-10-02 the
  coordinator runs on the build VPS `claude-build`, not in the cloud
  (Q-064; see [build-vps.md](build-vps.md)); its workers share that machine.
- **Heavy or long work** (anything that builds atomic-server or runs its e2e,
  multi-hour features): a **temporary session** started by the coordinator
  with a brief. It posts a pickup on #227, does its one piece of work, pushes,
  reports on #227 with the PR link, and stops. It doesn't archive itself: the
  coordinator archives it after checking the branch is pushed and the PR is
  merged or the task finished.

Report one comment per milestone on #227: what landed (PR and issue numbers),
what's next, what's blocked or needs a decision. Keep it short.

## Worktrees

- A worker makes an early WIP commit on its branch (within about 15 minutes
  of its first edits), so its worktree is never mistaken for an empty one.
- Remove a worktree only after its worker has reported. Never
  `git worktree remove --force --force`: the second `--force` overrides the
  lock a live worker's session holds, and deletes its uncommitted work.
  A plain `git worktree remove` (or one `--force`) is enough for a finished
  one.
- Delete a finished worktree's `target/` first if it has one (see "Disk"
  under [Gotchas](#gotchas)).

## Issue drafts for Joep

Host needs found while the atomic-server freeze is in force, drafted on #227
on 2026-10-02 for someone with ontola/atomic-server access to file as written.
Check whether one was filed before drafting a new one.

| # | Title | Comment |
| --- | --- | --- |
| 1 | Plugin manifest: accept an optional `subject` on destination properties and classes (optional, low priority since #287) | [comment](https://github.com/ontola/atomic-plugins/issues/227#issuecomment-5956793767) |
| 2 | Plugin routes: verify ES256 (P-256) JWKs for OCM signatures, and take the signer domain from `keyid` | [comment](https://github.com/ontola/atomic-plugins/issues/227#issuecomment-5956793767) |
| 3 | Plugin routes: one-segment path wildcards in delivery operations | [comment](https://github.com/ontola/atomic-plugins/issues/227#issuecomment-5956793767) |
| 4 | Plugin routes: sign key fetches for `auth: http-signature` (authorized fetch) | [comment](https://github.com/ontola/atomic-plugins/issues/227#issuecomment-5956793767) |
| 5 | WebFinger by actor URL is never routed to a plugin | [comment](https://github.com/ontola/atomic-plugins/issues/227#issuecomment-5957551120) |
| 6 | (Minor) host-meta takes its scheme from the connection | [comment](https://github.com/ontola/atomic-plugins/issues/227#issuecomment-5957551120) |
| 7 | TLS certificates for host names bound with `/bind-drive` | [comment](https://github.com/ontola/atomic-plugins/issues/227#issuecomment-5958060279) |
| 8 | Signed proxy requests can collide with themselves in the same millisecond | [comment](https://github.com/ontola/atomic-plugins/issues/227#issuecomment-5958959871) |

Earlier, atomic-server#1952 (record app connections for server-side use) was
filed the same way. The update on draft 1 is in
[this comment](https://github.com/ontola/atomic-plugins/issues/227#issuecomment-5957770752).

## Opt-in real-peer e2es

Specs that run against a real peer implementation in Docker (or Ruby), skipped
unless their variable is set. None of them runs in CI, so their results are
declared evidence from a local run, not a gate. All start containers, so
[the Docker rules](build-vps.md#docker-on-the-shared-host) apply, and each
runs under the heavy lock (the e2e tier does).

| Peer | Variable | Run | Documented in |
| --- | --- | --- | --- |
| Nextcloud 35 (OCM, #138, PR #256) | `OCM_NEXTCLOUD_E2E=1`; `OCM_NEXTCLOUD_PORT` (default 18443) | `node integrations/tooling/run-lane.mjs open-cloud-mesh --tier e2e` | `integrations/open-cloud-mesh/README.md`, "Against a real Nextcloud"; `e2e/nextcloud.spec.ts` |
| Mastodon (#137) | `FEDIVERSE_MASTODON_E2E=1`; `FEDIVERSE_MASTODON_PORT`; `FEDIVERSE_MASTODON_KEEP=1` | `node integrations/tooling/run-lane.mjs fediverse --tier e2e` | `integrations/fediverse/README.md`, "Against a real Mastodon" |
| Akkoma (#137, PR #286) | `FEDIVERSE_AKKOMA_E2E=1`; `FEDIVERSE_AKKOMA_PORT` (default 19953); `FEDIVERSE_AKKOMA_KEEP=1` | same lane | `integrations/fediverse/README.md`, "Against a real Akkoma" |
| Bluesky PDS (AT Protocol, PR #288) | `ATPROTO_PDS_E2E=1` | `node integrations/tooling/run-lane.mjs atproto --tier e2e` | `integrations/atproto/README.md`; `e2e/pds.ts` |
| remoteStorage api-test-suite | `REMOTESTORAGE_API_SUITE=<checkout of remotestorage/api-test-suite>`; `REMOTESTORAGE_API_SUITE_RUBY=local` to use `bundle` from `PATH` instead of Docker | see `integrations/remotestorage/README.md`, "remoteStorage API test suite" | `integrations/remotestorage/README.md` |

Every one of these lanes runs on the plugin-routes server build
(AGENTS.md, "The plugin-routes feature build"), which `run-lane.mjs` selects from
`pluginRoutes` in `lanes.json`. Nothing tests these variables, so read the
spec's header comment for the current ports and image tags before relying on
the table.

## Worker checks

Before handing work over, run what CI's "Lint, tooling tests, certification"
job and the affected lanes run (`.github/workflows/ci.yml`). From the repo
root, after `node integrations/tooling/link-atomic-server.mjs`:

```sh
node integrations/tooling/run-lane.mjs <lane> --tier unit      # and typecheck, node, e2e as the lane has them
node --test integrations/tooling/*.test.mjs integrations/localthought/*.test.mjs ontology-kit/*.test.mjs
node integrations/tooling/apps.mjs check --published origin/main
node ontology-kit/ontology.mjs check --published origin/main
node integrations/tooling/certify.mjs --layer js
(cd browser && pnpm --filter @tomic/lib build) && browser/node_modules/.bin/tsc -p integrations/tsconfig.e2e.json --noEmit
browser/node_modules/.bin/oxlint -c browser/.oxlintrc.json --ignore-pattern '**/plugin.js' integrations ontology-kit
browser/node_modules/.bin/oxfmt -c browser/.oxfmtrc.json --check integrations ontology-kit
```

The `node --test` globs matched exactly the files CI lists by name on
2026-09-30; a new test file runs in CI only once it is added to that list in
`ci.yml`. oxlint
must report 0 errors. `usertest/` changes: `node usertest/e2e/run.mjs` (not
in CI; see [usertest-droplet.md](usertest-droplet.md)).

The rules each worker got, beyond the checks: fetch `origin/main` first; plan
before code; keep a plugin inside its folder (shared code only in
`integrations/tooling/`, `ontology/`, `ontology-kit/` and, for the
sync-status card, `integrations/sync-status/`); `// @wc-ignore-file`
on every `.ts`; hedged "declared, not verified" wording in docs; heavy runs
(atomic-server builds, e2e) one at a time.

## Gotchas

- **Node 22 for the tooling tests.** Node 26 breaks one TAP-format test.
  CI's tooling job uses the runner's Node; `usertest-deploy.yml` pins 22.
- **Disk.** An atomic-server `target/` is 10–30 GB per worktree. Check `df`
  before a build, and delete finished worktrees' `target/`. Share one build
  per pinned SHA (AGENTS.md, "Shared pinned atomic-server build"). Don't
  share `CARGO_TARGET_DIR` between worktrees on different atomic-server
  bases: cargo can reuse a stale crate and report bogus missing-method errors.
- **zsh doesn't word-split** `set -- $var` or unquoted `$var` in `for`
  loops. Run such loops with `bash -c`.
- **ghcr from the cloud.** On 2026-09-30 the cloud environment's egress policy
  denied `pkg-containers.githubusercontent.com`, ghcr's blob host, so cloud
  sessions could fetch image manifests but not pull layers
  (`atomic-server-e2e` included), and the containers have no Docker daemon.
  Build from source there: the SessionStart hook does that for the pin (see
  AGENTS.md, "Claude Code cloud sessions").
- **atomic-server from the cloud.** A cloud session may have no
  ontola/atomic-server access through the GitHub API. atomic-server is
  public, so an anonymous clone through the session's git proxy works:
  `GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --branch <branch> https://github.com/ontola/atomic-server`.
- **Screenshots.** Sessions can't upload images to GitHub. List filenames in
  the PR, or say they're missing.
