# The user-testing server

[`usertest/README.md`](../../usertest/README.md) is the full reference:
hosts, setup from scratch, moderated sessions, findings, logs and privacy.
This page is the short runbook, and what needs whose OK.

Since 2026-10-02 the instance runs on claude-build (`188.245.144.252`), the
same Hetzner server where Claude Code sessions work on these repos, with base
domain `usertest.michielbdejong.com`. Until then it ran on a DigitalOcean
droplet (`178.62.223.35`, `178-62-223-35.sslip.io`), now destroyed. Log in as
`claude@188.245.144.252` and use `sudo`; root SSH login is off, except for the
deploy workflow's key. A session running on claude-build runs the `sudo`
commands below directly, without `ssh`. Builds there run with a lower CPU and
IO weight than the user-testing containers (usertest/README.md, "Sharing the
server with builds").

## What needs an OK

- **Deploys to the user-testing server** have Michiel's standing OK.
- **Restarting the moderator or atomic-server ends sessions in progress.**
  Warn on [#227](https://github.com/ontola/atomic-plugins/issues/227) first,
  and restart only when no session is running.
- **Cloud sessions have no SSH to the server.** Until the deploy workflow
  below is set up, hand server steps to Michiel on #227, with the exact
  commands. Sessions on claude-build can run the `sudo` steps themselves.

## What changes need

| Changed | Deploy | Restart |
| --- | --- | --- |
| `usertest/page/` only | `deploy.sh` | none |
| an app's source | bump `VERSIONS` in `usertest/catalog.mjs`, `catalog.mjs`, `check-live.mjs`, `deploy.sh` | none |
| `usertest/sample-data/`, or a fixture it imports | bump `SAMPLE_VERSION` in `usertest/catalog.mjs`, `catalog.mjs`, `check-live.mjs`, `deploy.sh` | none |
| `usertest/moderator/` (session plans included) | `deploy.sh` | moderator (`moderator/run.sh`) |
| `/etc/*.env` on the server | none | the container that reads it |
| `usertest/collector/` | `deploy.sh` | collector (`collector/run.sh`) |
| atomic-server version or plugin routes | `deploy.sh` if `server.sh` changed | atomic-server (`server.sh`) |

Say in the PR which row applies.

## Commands

From a checkout of this repo, set up as in AGENTS.md:

```sh
USERTEST_LOG_URL=https://logs.usertest.michielbdejong.com/log node usertest/catalog.mjs
node usertest/check-live.mjs https://catalog.usertest.michielbdejong.com/catalog.json
sh usertest/deploy.sh root@188.245.144.252   # root: the deploy workflow's key only
ssh claude@188.245.144.252 sudo sh /opt/usertest/moderator/run.sh
ssh claude@188.245.144.252 sudo USERTEST_PLUGIN_ROUTES=read-write sh /opt/usertest/server.sh usertest.michielbdejong.com [<sha>]
```

- **Env files are read when a container is created.** `moderator/run.sh`
  passes `/etc/anthropic.env`, `/etc/usertest-moderator.env`,
  `/etc/usertest-salt.env` and `/etc/github-findings.env` with `--env-file`,
  so after editing one, run `moderator/run.sh` again; a `docker restart`
  keeps the old values.
- **`server.sh`** runs `ghcr.io/ontola/atomic-server-e2e:<sha>`, or its
  `-plugin-routes` variant when `USERTEST_PLUGIN_ROUTES` is `read-only` or
  `read-write` (default `off`). Without `<sha>` it uses the
  `.atomic-server-ref` that `deploy.sh` copied next to it (on 2026-10-02
  claude-build ran `a12b74a6…`, routes `off`). With routes on it passes
  `ATOMIC_TRUSTED_PROXIES=172.17.0.1`, which candidate16 and later need
  (atomic-server#1903). The image must already be published for that SHA.
  On 2026-09-30 the old droplet ran candidate15 with routes `read-write` (from
  the hand-over; not verified from here).
- **Routes allowlist.** Caddy gets a certificate for an installation origin
  only when a file named after the host exists:

  ```sh
  ssh claude@188.245.144.252 sudo touch /etc/caddy/routes-allowed/<slug>.routes.usertest.michielbdejong.com
  ```

  atomic-server's TLS `ask` endpoint (atomic-server#1922, in candidate19)
  should replace this once the server runs it; not deployed on 2026-09-30.
- **Refiling findings** for a session (re-runs the analysis):

  ```sh
  ssh claude@188.245.144.252 sudo docker exec usertest-moderator node analyze.mjs <session-id> --file
  ```

  Issues go to the private `ontola/usertest-findings`. Nothing is public until
  Michiel labels a finding `approved`.
- **Before a page PR:** `node usertest/e2e/run.mjs` (headless, fake media;
  not in CI). For `usertest/sample-data/` or `catalog.mjs`:
  `node --test usertest/sample-data/samples.test.mjs` and
  `node usertest/e2e/samples.mjs` (the pinned atomic-server; not in CI). Never open the page in Michiel's browser to test it (#227
  rule 9).

## The deploy workflow

`.github/workflows/usertest-deploy.yml` (#226, merged 2026-09-30) runs the
same steps from Actions → **Deploy user-testing instance** → Run workflow:
it builds the catalog at `.atomic-server-ref`'s browser checkout, runs
`check-live.mjs`, then `deploy.sh`. Restarting the moderator, the collector
or atomic-server (with a plugin-routes level) are separate inputs, off by
default. Its atomic-server restart runs `server.sh` without a SHA, so the
deployed `.atomic-server-ref`. Afterwards it checks that the page, the moderator's `/health`,
the catalog and atomic-server answer.

It needs a one-time setup by Michiel (Q-056): the `usertest` GitHub
environment with `USERTEST_SSH_KEY` and `USERTEST_SSH_KNOWN_HOSTS`, steps in
[usertest/README.md](../../usertest/README.md#deploying-from-github-actions).
On 2026-09-30 that was not done yet, and the workflow had not run. Once it
works, sessions deploy through it, still warning on #227 before a restart.
