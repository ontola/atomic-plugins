# User-testing instance

An atomic-server test instance, where people try the drive apps on their own
laptop and with their own provider accounts. It replaces sessions on one
prepared laptop. It runs on one DigitalOcean droplet, set up on 2026-09-28
(Ubuntu 24.04, 2 vCPU, 4 GB, AMS3). This folder holds everything needed to
rebuild it.

| Host | What |
| --- | --- |
| `https://plugins.<base-domain>` | atomic-server, the published e2e image of the pinned commit (`server.sh`) |
| `https://catalog.<base-domain>/catalog.json` | the test catalog and the app modules it points at (`catalog.mjs`) |
| `https://logs.<base-domain>` | the log collector (`collector/`) |
| `https://plugins.<base-domain>/usertest/` | the moderated-session page (`page/`) and its voice moderator (`moderator/`, at `/usertest/api/`) |
| `https://localthought.io` | the integration proxy, shared with everyone else (not on the droplet) |

The base domain is currently `178-62-223-35.sslip.io`. sslip.io resolves
`<anything>.<a-b-c-d>.sslip.io` to the IP address `a.b.c.d`, so no DNS setup
is needed. Drives are tied to the host name. Moving to a real domain later
means fresh drives.

## What differs from the published catalog

`catalog.mjs` starts from `integrations/catalog.json` and makes every drive
app installable: Google Calendar, GitHub issues, Bank statements, Clockify,
Notion and Pets. It also sets `experimental: false`, so testers need no
toggle. The published catalog keeps these disabled until launch. Apps not yet
in `apps/` are built from this checkout and served from the droplet. Pets
uses its published module.

Known limits, as of 2026-09-28:

- Pets cannot connect: localthought.io has no `pets` platform (#174).
- The calendar app does not import recurring events.
- The e2e image exposes test-only routes (`/app/prunetests`,
  `/app/sandbox`).
- `ATOMIC_HOST_MODE=open`: anyone with the URL can create a drive. Stop the
  container between session days.

## Setting it up from scratch

On a fresh Ubuntu 24.04 droplet, as root:

```sh
apt-get update && apt-get install -y docker.io caddy
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
printf 'BASE_DOMAIN=%s\nACME_EMAIL=%s\n' 178-62-223-35.sslip.io you@example.org > /etc/caddy/usertest.env
mkdir -p /var/lib/usertest-logs
```

Docker publishes the server on `127.0.0.1` only, so ufw's rules are not
bypassed.

From a checkout of this repo, with the layout from `AGENTS.md`
(`node integrations/tooling/link-atomic-server.mjs`) and each app's
dependencies installed:

```sh
for a in calendar money notion timesheets; do (cd integrations/$a && pnpm install); done
(cd integrations/issue-tracker/app && pnpm install --frozen-lockfile)
USERTEST_LOG_URL=https://logs.178-62-223-35.sslip.io/log node usertest/catalog.mjs
sh usertest/deploy.sh root@178.62.223.35
ssh root@178.62.223.35 sh /opt/usertest/collector/run.sh
ssh root@178.62.223.35 sh /opt/usertest/moderator/run.sh   # needs /etc/anthropic.env
ssh root@178.62.223.35 sh /opt/usertest/server.sh 178-62-223-35.sslip.io
```

## Updating an app

1. Change the app, then bump its entry in `VERSIONS` in `catalog.mjs`.
2. Run `USERTEST_LOG_URL=https://logs.178-62-223-35.sslip.io/log node usertest/catalog.mjs`,
   then `sh usertest/deploy.sh root@178.62.223.35`.
3. On Integrations, testers who installed the old version see "Update to
   <version>".

Never rebuild into an existing version: the host refuses a module whose bytes
no longer match the hash in the catalog.

## Moderated sessions

A tester needs only the invite link,
`https://plugins.<base-domain>/usertest/?code=<USERTEST_CODE>`, and Chrome
or Edge. The code is in `/etc/usertest-moderator.env` on the droplet;
`moderator/run.sh` creates it on first run. The page:

1. explains the session, what is recorded and where it goes, and asks for
   consent;
2. stores the test catalog URL in the browser, opens a fresh drive
   (`/app/dev-drive`) in a second window, and starts recording the shared
   screen and the microphone;
3. listens with the browser's speech recognition (Chrome sends the audio to
   Google), sends a turn to the moderator after a pause, a minute of silence
   or a new error in the collector log, and speaks the answer with the
   browser's speech synthesis.

The moderator (`moderator/server.mjs`) asks Claude (`claude-opus-5`, effort
`low`, server-side refusal fallback on) for the next line, following the
interview script in `moderator/script.md`: short spoken questions, mostly
listening (`[WAIT]`), no help unless the tester is stuck and asks. Each turn
includes the collector's error, warning, feedback and sync lines since the
previous turn. Measured on 2026-09-28: about 3 seconds per turn, and the
script served from the prompt cache after the first turn.

Per session, `/var/lib/usertest-sessions/<id>/` holds `meta.json`,
`transcript.jsonl` (both sides, with the log lines each turn saw, and token
usage) and `recording.webm`. Limits: the invite code on every request, at
most 120 turns per session and 20 sessions per UTC day. The moderator keeps
sessions in memory, so restarting it ends the sessions in progress.

Not verified yet: a full session by a real tester, and Edge.

## Without the moderator

1. Open `https://plugins.<base-domain>/app/dev-drive`. It creates an agent
   and a drive in the browser, without signup.
2. In Settings → Integration, set the plugin catalog URL to
   `https://catalog.<base-domain>/catalog.json`.
3. On Integrations, install an app and connect it with your own account.

## Logs

The collector (`collector/server.mjs`, no dependencies, run in a
`node:22-alpine` container by `collector/run.sh`) writes one JSON line per
event to `/var/lib/usertest-logs/<UTC date>.jsonl`. It has two entrances:

- **Sentry's envelope endpoint.** `server.sh` sets `SENTRY_DSN` (project 1,
  atomic-server) and `SENTRY_DSN_BROWSER` (project 2, the data-browser, which
  atomic-server injects into the page at runtime). This reports uncaught
  errors in the page and the server's `error!` events. It also switches on
  the sidebar's Feedback form, whose messages arrive as `type: feedback`.
- **`POST /log`**, a JSON object or an array of them, for anything else. A
  drive app's errors stay inside its sandboxed frame: the host shows them
  there and reports nothing. The calendar app hands its failures, a line
  per finished sync and anything uncaught to a hook (`app/report.ts`), and
  `catalog.mjs` prepends the hook that posts here when `USERTEST_LOG_URL`
  is set. The app itself makes no network request.

Verified on 2026-09-28: an error thrown in the data-browser arrived within
seconds with its stack and URL.

```sh
ssh root@178.62.223.35 'tail -f /var/lib/usertest-logs/$(date -u +%F).jsonl'
ssh root@178.62.223.35 docker logs --since 1h atomic-plugins
heroku logs -a integration-proxy -n 500   # needs access to the Heroku app
```

Both endpoints are public, like any Sentry DSN, and nothing checks who
sends. Bodies over 1 MB are refused.

## Privacy

Testers connect real accounts. Their data is on the droplet, in the Docker
volume `atomic-plugins-store`, and their provider tokens are in
localthought.io's database. Error reports can contain what was on screen
(titles in messages, URLs), and they stay in `/var/lib/usertest-logs`.
Moderated sessions add screen and microphone recordings and transcripts in
`/var/lib/usertest-sessions`; the transcripts also went through Google's
speech recognition and Anthropic's API. Delete a session's folder after
analysis. Tell testers this before they start. Reset the
store with `docker rm -f atomic-plugins && docker volume rm atomic-plugins-store`,
then run `server.sh` again.
