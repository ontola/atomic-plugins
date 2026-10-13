# The build VPS (`claude-build`)

Since 2026-10-02 the coordinator session runs on Michiel's build VPS,
`claude-build` (Hetzner, Ubuntu 24.04, 8 cores, 15 GB RAM, about 300 GB disk),
not in a cloud session
([#227, handover and takeover comments](https://github.com/ontola/atomic-plugins/issues/227#issuecomment-5948946987)).
It is bridged to claude.ai with `claude remote-control`, which runs inside the
tmux session `ap`. The coordinator's workers (subagents in worktrees, and
short-lived sessions) run on the same machine, so they share its CPU, RAM,
disk and ports. This page is true as of 2026-10-02.

## What runs here, and how to tell

- `hostname` prints `claude-build`.
- `get_session` reports `environment_kind: "bridge"` for the coordinator.
- `CLAUDE_CODE_REMOTE` is unset. The SessionStart hook (AGENTS.md, "Claude
  Code cloud sessions") only runs when it is `true`, so it does **not** run on
  its own here. Run it by hand when the environment needs a refresh (a new
  pin, a new plugin lockfile):

  ```sh
  CLAUDE_CODE_REMOTE=true .claude/hooks/session-start.sh
  ```

  It honours an exported `ATOMIC_SERVER_CHECKOUT`; export your pin's
  per-SHA checkout below first, or it builds its own under
  `~/.cache/atomic-plugins/atomic-server`, which is not warmed here.
- The user-testing stack and Michiel's dashboard run on the same host. See
  [Shared server](#shared-server-hands-off).

## Paths

| Path | What |
| --- | --- |
| `/home/claude/work/atomic-plugins` | the repo checkout; workers use worktrees under `.claude/worktrees/` |
| `~/.cache/atomic-plugins/atomic-server/<sha>` | atomic-server at one pinned SHA (a branch's `.atomic-server-ref`), one detached worktree per SHA, `pnpm install`ed with `@tomic/lib` built. It is `ATOMIC_SERVER_CHECKOUT` for every branch with that pin, and only for those. Read-only once built: never commit in it, move it, or point a branch with another pin at it |
| `~/.cache/atomic-plugins/atomic-server/<sha>/target/e2e/atomic-server` | that SHA's e2e binary, with `target/e2e/.built-for-atomic-plugins` next to it holding the commit it was built from (the stamp) |
| `/home/claude/work/atomic-server` | a full clone of ontola/atomic-server, for `git worktree add` and for `server-build.mjs`'s `ATOMIC_SERVER_REPO` |
| `/home/claude/work/atomic-server-pin` | **retired, don't use.** One shared checkout for every branch: `link-atomic-server.mjs` moved it whenever workers' branches carried different pins (three times in 13 minutes on 2026-10-09), and its binary stayed the old pin's |
| `~/.cache/atomic-plugins/atomic-server/<sha>-plugin-routes` | the plugin-routes build, where `server-build.mjs` looks (AGENTS.md, "The plugin-routes feature build") |
| `/home/claude/.cache/atomic-plugins/heavy.lock` | the lock for heavy runs |

Use the checkout of your own branch's pin, never another:

```sh
SHA=$(cat .atomic-server-ref)                       # from your worktree root
export ATOMIC_SERVER_CHECKOUT=$HOME/.cache/atomic-plugins/atomic-server/$SHA
cat "$ATOMIC_SERVER_CHECKOUT/target/e2e/.built-for-atomic-plugins"  # must print $SHA
node integrations/tooling/link-atomic-server.mjs --no-fetch
```

Without the export, the tools pick the same directory themselves when it
exists (`serve.mjs`'s `serverCheckout()`); the export still makes it explicit,
and is the only way to point a branch at a checkout for another pin.

- **One checkout per SHA.** A branch on an older or newer pin (one stacked
  on an unmerged PR, say) uses that SHA's directory, not main's. Pointing it
  at another pin's checkout makes `link-atomic-server.mjs` move that checkout
  under whoever else is using it, and their lanes then run one pin's
  `browser/` against another pin's binary. `link-atomic-server.mjs` (without
  `--no-fetch`, which skips this check) refuses to move a checkout named
  after another commit (`<sha>` or `<sha>-<variant>`, #462): it stops before fetching and prints this pin's
  own `ATOMIC_SERVER_CHECKOUT` path. A checkout not named after a commit
  (`/tmp/atomic-server`, CI's) still moves.
- **Read-only once built.** Never commit in it, check out another commit in
  it, or rebuild it in place.
- **No binary?** The SHA isn't built here yet. Build it once, under
  the heavy lock and from one session only, with AGENTS.md's "Shared pinned
  atomic-server build" recipe, which ends by writing the stamp. Or run the
  published image (`ATOMIC_SERVER_IMAGE`; AGENTS.md, "Or run the published
  image instead of building") and skip the build. A binary without a stamp
  was built without the recipe's last line: tell the coordinator rather than
  stamping someone else's build blind.
- **Always write the stamp.** `serve.mjs` (#412) refuses a binary whose stamp
  names another commit than its checkout, and prints the build lines. A
  binary without a stamp is trusted, so a build that skips the stamp is never
  caught when its checkout moves. On 2026-10-12 the `e922179` (candidate21)
  build had none; it was given its own SHA under the heavy lock after
  checking that the binary embeds that commit.

## Docker

Docker works on this host, and ghcr pulls work, unlike in cloud sessions
(see [working-model.md](working-model.md), "Gotchas"). So the image route in
AGENTS.md ("Or run the published image instead of building") is available,
and so is a copy-out of the plugin-routes binary, which avoids a source build
of about 10 minutes plus the disk of a second `target/`:

```sh
SHA=$(cat .atomic-server-ref)
DIR=$HOME/.cache/atomic-plugins/atomic-server/$SHA-plugin-routes
mkdir -p "$DIR"
docker create --name worker-routes-bin "ghcr.io/ontola/atomic-server-e2e:$SHA-plugin-routes"
docker cp worker-routes-bin:/usr/local/bin/atomic-server "$DIR/atomic-server"
docker rm worker-routes-bin
export ATOMIC_SERVER_ROUTES_BINARY=$DIR/atomic-server
```

The image only exists for a SHA that CI has built with the `plugin-routes`
feature (`.github/workflows/atomic-server-e2e-image.yml`); for any other SHA
the pull fails and `server-build.mjs` builds from source. The binary is linked
against glibc 2.36, which this Ubuntu 24.04 host satisfies. Name every
container you start with a `worker-` prefix and remove only those.

## Docker on the shared host

- Name every container `worker-<topic>-…`. Remove only containers with that
  prefix, plus the anonymous volumes they created (`docker inspect` lists
  them). On 2026-10-02 a worker removed a dangling volume that wasn't its own
  (#227): it was unattached, so nothing running lost data, but it could have
  been another session's.
- Never `docker system prune`, `docker volume prune` or `docker image prune`,
  and don't remove an image you didn't pull for your own run.
- Hands off `usertest-moderator`, `usertest-collector` and `atomic-plugins`
  ([Shared server](#shared-server-hands-off)).
- Publish ports on `127.0.0.1` only.
- **This VPS's firewall drops traffic from Docker bridge networks to the
  host.** A peer on the default bridge can't reach atomic-server on the host,
  so peer harnesses use `--network host`, with every listener on 127.0.0.1 in
  the 199xx range: Mastodon, Akkoma and Nextcloud
  (`integrations/fediverse/e2e/mastodon.mjs` and `akkoma.mjs`,
  `integrations/open-cloud-mesh/e2e/nextcloud.mjs`), and the remoteStorage
  API suite container. The Bluesky PDS harness (`integrations/atproto/e2e/pds.ts`)
  instead puts its TLS terminator in the PDS container's network namespace
  and relays to atomic-server over a Unix socket.
- Stop a harness's containers when the run ends. `FEDIVERSE_MASTODON_KEEP=1`
  and `FEDIVERSE_AKKOMA_KEEP=1` leave the stack up on purpose; stop it
  yourself afterwards.

## Heavy runs

One machine, 15 GB RAM: any e2e tier and any cargo build runs one at a time,
machine-wide. Wrap it in the lock:

```sh
mkdir -p /home/claude/.cache/atomic-plugins
flock /home/claude/.cache/atomic-plugins/heavy.lock \
  node integrations/tooling/run-lane.mjs calendar --tier e2e
```

`flock` waits until the holder exits. With three or four workers the lock is
the throughput bottleneck, and a worker waiting an hour for it is normal
(2026-10-02), not a hang: don't kill it or start a second build. When
choosing what to run in parallel, mix e2e-heavy tasks with unit-only or
documentation-only ones instead of starting four e2e-heavy workers. Unit, typecheck and node tiers, lint and
`oxfmt` don't need it. Lane ports (19xxx) are fine to use; see below for the
ports that are not.

## What the `gh` token can't do

The token on this host lacks the `workflow` scope, so a push that adds or
changes a file under `.github/workflows/` is refused. Don't edit those files.
When CI needs a change (a new test file in `ci.yml`'s list, say), put the
patch, or the staged workflow file, in the PR body (or on #227) and make the
code work without it; Michiel or a session with the scope applies it. See also
[ci-and-merging.md](ci-and-merging.md).

## Shared server, hands off

The host also runs things Michiel and testers depend on:

- **User testing** at `usertest.michielbdejong.com`: the containers
  `usertest-moderator` and `usertest-collector` and the `atomic-plugins`
  container (the user-testing atomic-server, from the pinned e2e image), on
  `127.0.0.1:8082`, `8081` and `8080` respectively. Welcome page, catalog and
  logs are on `*.usertest.michielbdejong.com`. Restarting the moderator or the
  server ends running test sessions; the rule on #227 is to warn there first,
  and to restart only when no session is running. Deploys are done by
  hand on this host under Michiel's standing OK (Decision Inbox Q-104),
  after checking that no session is running
  ([usertest-droplet.md](usertest-droplet.md), "On the build VPS").
  `usertest-deploy.yml` still targets the DigitalOcean droplet, destroyed
  on 2026-10-02, so it cannot deploy here.
- **Michiel's dashboard** at https://dev.michielbdejong.com (`localhost:8090`),
  behind Cloudflare Access. It holds the Decision Inbox (Q-064: the questions
  of #227's inbox migrate there, keeping their `Q-###` ids).

Rules for every session on this host:

- Never stop, restart, remove or reconfigure `usertest-moderator`,
  `usertest-collector` or `atomic-plugins`.
- Keep ports 8080, 8081, 8082 and 8090 free: start no server or forward there.
- Never run `docker system prune` or `docker volume prune`, and never
  `docker rm` or `docker stop` a container you didn't start.

## Briefing a worker

The coordinator's brief for a worker follows the same shape each time. Keep it
when writing one:

- **Worktree.** One worktree per task from fresh `origin/main` (`git fetch
  origin main && git checkout -B claude/<topic> origin/main`), never the main
  checkout. A subagent's worktree is isolated; don't `cd` out of it.
- **Environment.** The per-SHA `ATOMIC_SERVER_CHECKOUT` export and
  `link-atomic-server.mjs` above, for the worker's own branch's pin; the e2e
  binary is ready once its stamp names that SHA. Workers never start their
  own build of a SHA (the coordinator builds it once, or they use the
  image), and never use another pin's checkout; heavy runs under `flock`.
- **Scratchpad.** The session's scratchpad directory for plans
  (`plans/<topic>.md`, written before code, after checking sibling plans) and
  any other temporary files. Give each worker a file-name prefix (for example
  `docs-`) so two workers never write the same name.
- **Rules.** The board rules in [working-model.md](working-model.md); no
  `--no-verify`; stage paths explicitly and check `git diff --cached --stat`
  for data or secrets; no `.github/workflows/` edits; the freeze below.
- **Reports back.** A worker doesn't push, open PRs, merge or comment: the
  coordinator does every GitHub write. It commits in its worktree and
  reports the branch, the commit SHAs, what changed, a PR title and body draft
  (`Closes #N` where it fully resolves an issue), the checks it ran with exact
  results, what it didn't verify, and "Question for Michiel" items.
- **atomic-server freeze.** No atomic-server PRs and no new pin candidates
  (#227, 2026-10-01). A host need goes in the report as an issue draft for
  Joep, for example atomic-server#1952.
