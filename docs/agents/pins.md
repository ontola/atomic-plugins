# Pins and candidates

## What is pinned

`.atomic-server-ref` holds one full atomic-server commit SHA. CI, the lanes,
`link-atomic-server.mjs` and `usertest-deploy.yml` all check out that
commit. On 2026-10-09 it is candidate21, `e922179e2e16f38ceb5e027479a49f59b22c9539`
(candidate20 `0fa9c07` plus the host lens catalog behind the split-pieces flag,
`28da8f0d2`, pinned to `lenses/v1`, and `e922179e2`, in which the demo view and
integration frame fall back to `isA` and the name property instead of
`getClasses()` and `title`).

The pin is always a **candidate**: a commit on an atomic-server branch
`claude/atomic-plugins-pin-candidateN`, never `develop`. A candidate
combines the plugin-host work atomic-plugins needs before atomic-server's
`develop` has it. The atomic-server side builds them:

- host branches that were based on a candidate: `git merge --no-ff`;
- PRs based on `develop`: `git cherry-pick -x` of the PR's own commits only,
  never a merge of `develop` (it has many commits the candidates lack);
- hand edits during a merge or pick are named in the commit message.

A candidate is usable once atomic-server's CI is green on it. Green
candidates took 155–166 minutes of CI in September 2026. Which candidate is
green, and which to avoid, is posted on
[#227](https://github.com/ontola/atomic-plugins/issues/227).

`claude/atomic-plugins-pin` in atomic-server points at the pinned candidate.
It is **only ever fast-forwarded**, never force-pushed:

```sh
git push origin <candidate-sha>:refs/heads/claude/atomic-plugins-pin
```

That fails unless it is a fast-forward, which is the point. Pin bumps are
pre-approved (#227 rule 4), and since 2026-10-08 so are building and tagging
new candidates (Decision Inbox Q-104, [working-model.md](working-model.md)),
which lifts the freeze's "no new pin candidates". A cloud session without atomic-server push access
hands this step to the coordinator.

## Where atomic-server work branches from

- **Host work for server plugins** (a new `ctx` API, manifest fields, route
  handling): branch `claude/plugin-<name>-host` from the **latest candidate**,
  not from `feat/plugin-debug`, which lacks the plugin-routes code. The
  branch is folded into the next candidate with `--no-ff`.
- **Other atomic-server fixes:** a PR against `develop` (for example
  atomic-server#1933). The atomic-plugins hand-over said `feat/plugin-debug`
  for these; the atomic-server worker used `develop`. Not verified which is
  current; ask on #227 if it matters.
- Never merge into `develop` (#227 rule 3).

## The pin PR

On an atomic-plugins branch, once the candidate is green:

1. Write the full SHA into `.atomic-server-ref`, then re-run
   `node integrations/tooling/link-atomic-server.mjs`.
2. Refresh `integrations/tooling/fixtures/plugin-manifest/` from the
   candidate's `testdata/plugin-manifest/`. `source.json` there lists which
   files are copied (not all of them; the afterCommit fixtures were never
   copied up to candidate17b) and names the commit. Copy byte for byte, then
   set `commit` and `commitNote` in `source.json`. Without atomic-server API
   access:

   ```sh
   GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --branch claude/atomic-plugins-pin-candidateN \
     https://github.com/ontola/atomic-server /tmp/as-candidate
   diff -r /tmp/as-candidate/testdata/plugin-manifest integrations/tooling/fixtures/plugin-manifest
   ```

   `node --test integrations/tooling/manifest-http.test.mjs` runs this repo's
   port against them. If the host changed the manifest rules, port the change
   to `integrations/tooling/manifest-http.mjs` in the same PR.
3. Remove any `test.fixme` whose linked host fix the candidate carries; that
   test is its regression check (see
   [ci-and-merging.md](ci-and-merging.md#flaky-tests)).
4. `node integrations/tooling/apps.mjs check --published origin/main`. A pin
   bump can change esbuild's output, and then a drive app needs a new version
   (see [catalog-and-pages.md](catalog-and-pages.md)).
   The user-testing builds change with it: `node --test
   integrations/tooling/apps.test.mjs` fails on any app whose bytes moved.
   Bump that app's entry in `VERSIONS` (or `SAMPLE_VERSION`) in
   `usertest/catalog.mjs` and run `node usertest/catalog.mjs --record`. The
   same holds for a devonian or syncables bump in a plugin's `package.json`
   that changes an app's bundle.
5. Commit as `pin candidateN (<short sha>)…` and say in the body what the
   candidate adds and whether the fixtures changed, like `efa7825`.
6. Lanes that set `pluginRoutes` need the `-plugin-routes` build of the new
   SHA (AGENTS.md, "The plugin-routes feature build"). CI builds it, or pulls
   `ghcr.io/ontola/atomic-server-e2e:<sha>-plugin-routes` once main has
   published it.

The droplet doesn't follow the pin. `usertest/server.sh` defaults to
candidate15 (`59ddfe788…`), and its comment calling that "main's
.atomic-server-ref" is out of date since the candidate16 pin. Moving the
droplet is a separate step; see [usertest-droplet.md](usertest-droplet.md).
