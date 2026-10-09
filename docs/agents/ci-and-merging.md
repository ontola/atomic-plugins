# CI and merging

## The `CI` gate

`.github/workflows/ci.yml` ends in one job named `CI`, which needs every other
job except `publish-image` and fails if any of them failed or was cancelled.
A skipped job counts as a pass: lanes are path-gated. That job is the required
check. Per-lane jobs (`Lane: pets (e2e)`) exist only on runs that selected
them, so never wait on one by name.

## Reading check runs

Read the check runs **for the PR's current head SHA**, not the PR's checks
summary:

```sh
HEAD=$(git rev-parse origin/<branch>)   # or the PR's head.sha from the API
# GitHub API:  GET /repos/ontola/atomic-plugins/commits/$HEAD/check-runs?check_name=CI
```

`gh pr checks` once showed the previous head's results twice. After a push,
the PR's head as GitHub reports it can lag behind the branch; compare it with
`git rev-parse` before trusting a green result. The next push re-syncs it.

## Merging (rule 12)

An atomic-plugins PR whose `CI` gate is green on its current head may be
merged by the session that made it (#227 rule 12, Michiel, 2026-09-30).
Never bypass the gate with admin rights. Rule 12 doesn't cover atomic-server
(only the trekmeester merges `develop`) or deploys and publishing (rule 10).

The required `CI` gate does **not** include GitGuardian, which is a separate
check. #276 was merged with `CI` green and GitGuardian red (2026-10-02).
Merge only when `gh pr checks <N>` shows nothing but pass and skipping, and
compare it with the head SHA as above. A red check that isn't `CI` is a
reason to wait, not a reason to merge.

- **A GitGuardian hit on an invented test value:** replace the value with a
  plainly fake, low-entropy string. The offline fake Clockify key in #278 was
  base64 of a made-up phrase and still read as a high-entropy secret; #283
  replaced it. Say so on #227: someone with access to the ontola GitGuardian
  workspace has to mark the incident.
- **A real secret:** a commit doesn't fix it. Report it on #227 (rule 6) and
  don't rewrite shared history to hide it.
- **A branch whose history carries a flagged commit** keeps failing the check
  after the value is fixed. On your own branch, rebuild it: branch from
  `origin/main`, cherry-pick the real commits, and `git push
  --force-with-lease`. Only on a branch nobody else has checked out. #280 went
  this way.

## Merge conflicts and stale branches

- **`apps.mjs check --published origin/main` or `ontology.mjs check
  --published origin/main` says "<n> file(s) published at origin/main are
  not on this branch, which is behind it (<the first three paths>…)".**
  `main` published another app version or term after the branch parted from
  it. Merge `origin/main`. Don't restore files by hand, and never change a
  published file. A missing file is "was deleted … restore it" when the
  branch point (`git merge-base HEAD origin/main`) has it: the branch had
  the file and lost it. Where the checks cannot find a branch point (no
  merge-base, or a shallow clone such as CI's checkout), every missing file
  is "was deleted", with "if the branch is behind origin/main, merge it
  first instead" added: merge first, then restore only what is still
  reported.
- **`integrations/READINESS.md`** (one wide table) **and the `VERSIONS` map in
  `usertest/catalog.mjs`** are edited by almost every plugin PR, so parallel
  PRs conflict on every merge. Recipe: take `main`'s version of the file,
  put the PR's own rows (or version bumps) back in, then run
  `browser/node_modules/.bin/oxfmt -c browser/.oxfmtrc.json integrations`
  (the table is column-padded). Then diff against `origin/main` and check
  that only your rows differ. Never `git checkout --theirs` (or `--ours`) on a
  whole shared file: that lost the Moneybird entry once (#242).

## Stacked PRs

- Merge only PRs based on `main`. A PR stacked on another waits until the
  lower one has merged.
- Then retarget the upper PR to `main`, merge `main` into it (no rebase or
  force-push on a branch others may have checked out), and wait for a new
  green `CI` on that new head before merging. #224 (Willow, on #223) went
  this way.
- The lower PR's green run says nothing about the upper one: the upper PR's
  lanes are chosen from its own diff against its base.

## Flaky tests

"Flaky" is not a root cause. When a lane fails intermittently:

1. Find where the race is. If it's in atomic-server (the host), file or
   comment on the atomic-server issue with the run id.
2. To unblock the merge queue meanwhile, mark only that test `test.fixme`,
   with a comment that names the atomic-server issue, the failing run and
   when to remove it. Example: `integrations/money/e2e/money.spec.ts` in
   #210 and #225, for the host's "New app" race.
3. Remove the `fixme` in the pin PR that carries the host fix; the test is
   that fix's regression check (`efa7825`, candidate17b and atomic-server#1920).

Never delete a test or skip it without a link to the issue that brings it
back.

## `build-sidecars`

Lanes that start an operator sidecar declare it in `integrations/lanes.json`
(`sidecars`; only `nextgraph` on 2026-09-30). For those runs:

- The `changes` job lists the sidecars
  (`node integrations/tooling/lanes.mjs sidecars`), and `build-sidecars`
  runs once per sidecar, with a 120-minute timeout.
- It tags the image `ghcr.io/ontola/atomic-sidecar-<name>:<source>`, where
  `<source>` is the sha256 of `git ls-files -s integrations/<name>/sidecar`.
  It pulls that tag if it exists. Otherwise it builds with Buildx and a GHA
  cache (scope `sidecar-<name>`), and pushes the image unless the run is from
  a fork. A cold NextGraph build (nextgraph-rs and RocksDB) took over 45
  minutes.
- It hands the image to the lane as an artifact (`sidecar-image-<name>`),
  and the spec gets its tag in `<NAME>_SIDECAR_IMAGE`
  (`NEXTGRAPH_SIDECAR_IMAGE`). The spec fails fast in CI when that is unset.
- The `CI` gate fails if `build-sidecars` fails.

`ghcr.io/ontola/atomic-sidecar-nextgraph` was made public on 2026-09-30
(Q-054). An anonymous manifest fetch worked; an anonymous layer pull was not
verified from the cloud (see the ghcr gotcha in
[working-model.md](working-model.md#gotchas)).

## Plugin-routes lanes

Lanes that set `pluginRoutes` need atomic-server built with
`--features wasm-plugins,plugin-routes`. CI's `build-server-plugin-routes`
job does that (or pulls `ghcr.io/ontola/atomic-server-e2e:<sha>-plugin-routes`);
locally see AGENTS.md, "The plugin-routes feature build".
