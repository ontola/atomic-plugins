# User-testing instance

An atomic-server test instance, where people try new Atomic features (the
drive apps, and parts of Atomic itself) on their own laptop and with their
own provider accounts. It replaces sessions on one
prepared laptop. It runs on one DigitalOcean droplet, set up on 2026-09-28
(Ubuntu 24.04, 2 vCPU, 4 GB, AMS3). This folder holds everything needed to
rebuild it.

| Host | What |
| --- | --- |
| `https://plugins.<base-domain>` | atomic-server, the published e2e image of the pinned commit (`server.sh`) |
| `https://catalog.<base-domain>/catalog.json` | the test catalog and the app modules it points at (`catalog.mjs`) |
| `https://logs.<base-domain>` | the log collector (`collector/`) |
| `https://plugins.<base-domain>/usertest/` | the moderated-session page (`page/`) and its voice moderator (`moderator/`, at `/usertest/api/`) |
| `https://<slug>.routes.<base-domain>` | a server plugin's installation origin, only with plugin routes on ([Trying server plugins](#trying-server-plugins-remotestorage)) |
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
`node usertest/check-live.mjs https://catalog.178-62-223-35.sslip.io/catalog.json`,
run after `catalog.mjs`, fails when an app was rebuilt into a version the
droplet already serves with other bytes. The deploy workflow below runs it
before it touches the droplet.

## Deploying from GitHub Actions

[`.github/workflows/usertest-deploy.yml`](../.github/workflows/usertest-deploy.yml)
runs the same steps from GitHub: it checks out atomic-server at
`.atomic-server-ref`, builds the catalog with `USERTEST_LOG_URL` set, runs
`check-live.mjs`, then `deploy.sh`. It runs only by hand (Actions → Deploy
user-testing instance → Run workflow). Each restart is an option, off by
default: the moderator (needed for `moderator/` changes; ends sessions in
progress), the collector, and atomic-server with `server.sh` (ends sessions
in progress; with a plugin-routes level). Afterwards it checks that the page,
the moderator's `/health`, the catalog and atomic-server answer.

Setting it up, once, needs a repository admin and root on the droplet:

1. Make a key used for nothing else, and allow it on the droplet:

   ```sh
   ssh-keygen -t ed25519 -N '' -C usertest-deploy -f usertest-deploy
   ssh root@178.62.223.35 'cat >> /root/.ssh/authorized_keys' < usertest-deploy.pub
   ```

2. Get the droplet's host keys, and compare their fingerprints
   (`ssh-keygen -lf`) with the droplet's own
   (`ssh root@178.62.223.35 'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f; done'`):

   ```sh
   ssh-keyscan 178.62.223.35 > usertest-known-hosts
   ```

3. In the repository's Settings → Environments, create `usertest` (and
   limit it to the `main` branch, and add required reviewers if you want an
   approval per deploy). Add the secrets `USERTEST_SSH_KEY` (the contents of
   `usertest-deploy`) and `USERTEST_SSH_KNOWN_HOSTS` (the contents of
   `usertest-known-hosts`). The variables `USERTEST_TARGET` and
   `USERTEST_BASE_DOMAIN` are optional; they default to `root@178.62.223.35`
   and `178-62-223-35.sslip.io`. Then delete the local `usertest-deploy`.

The key logs in as root, like a deploy from a laptop does. Anyone who can
push to a branch the `usertest` environment allows can deploy, so keep that
limited to `main`. Not run yet: the workflow has not deployed to the droplet.
The build and `check-live.mjs` were checked locally on 2026-09-30.

## Trying server plugins (remoteStorage)

Server plugins answer HTTP requests themselves (plugin routes). This
section is for trying [remoteStorage](../integrations/remotestorage/README.md)
by hand; testers don't need it, and it is off unless `server.sh` is started
with `USERTEST_PLUGIN_ROUTES`. As of 2026-09-29 none of this has run on the
droplet yet. Checked locally: the Caddyfile in Docker with Caddy 2.11.4 (a
certificate for an allowlisted routes host, a refused handshake for any
other; not with Ubuntu 24.04's packaged Caddy 2.6.2, which `deploy.sh`
validates against on the droplet), and that the `-plugin-routes` image of
the previous pin (`2567fc30b`) starts with these settings. That
candidate15 has what remoteStorage needs from the host was read from its
source, not run.

### What changes

- `server.sh` runs `ghcr.io/ontola/atomic-server-e2e:<sha>-plugin-routes`
  (the same commit built with the `plugin-routes` cargo feature, published
  by `.github/workflows/atomic-server-e2e-image.yml`) with
  `ATOMIC_PLUGIN_ROUTES=read-write` and
  `ATOMIC_ROUTES_ORIGIN=https://routes.<base-domain>`. The store volume is
  the same, so drives stay.
- Each server-plugin Installation answers on its own origin,
  `https://<slug>.routes.<base-domain>`, where `<slug>` is 32 hex characters
  (the start of the BLAKE3 hash of the Installation's subject).
  atomic-server picks the Installation by the `Host` header. sslip.io
  resolves these names to the droplet like any other.
- Caddy (`Caddyfile`, `*.routes.<base-domain>`) proxies those hosts to
  atomic-server with the `Host` header unchanged. sslip.io has no wildcard
  certificate, so Caddy gets one certificate per host from Let's Encrypt on
  the first TLS handshake (on-demand TLS), but only for a host listed in
  `/etc/caddy/routes-allowed/` (a file named after the host). Without that
  list, anyone could make Caddy request certificates for made-up slugs and
  use up the Let's Encrypt rate limits that `plugins.`, `catalog.` and
  `logs.` renew under.
- From atomic-server candidate16 on (atomic-server#1903), plugin routes only
  honour `X-Forwarded-Host`/`-Proto` from a trusted proxy. So `server.sh`
  passes `-e ATOMIC_TRUSTED_PROXIES=172.17.0.1` whenever plugin routes are
  on (Caddy reaches the container from the Docker bridge gateway).
  candidate15, which the droplet ran until then, has no such setting and
  doesn't read the variable.
- Without a SHA argument, `server.sh` runs the pinned commit: `deploy.sh`
  copies `.atomic-server-ref` to `/opt/usertest/`, and the deploy workflow
  also passes that SHA explicitly. Its images are published once the pin is
  on main (`atomic-server-e2e-image.yml`). A redeploy followed by a server restart
  therefore moves the droplet to the new pin; pass an older SHA as the
  second argument to stay on it.

### Turning it on

From a checkout of this repo (`deploy.sh` needs `usertest/out/`, see
[Setting it up from scratch](#setting-it-up-from-scratch)); it installs the
new Caddyfile, creates `/etc/caddy/routes-allowed/` and restarts Caddy:

```sh
sh usertest/deploy.sh root@178.62.223.35
ssh root@178.62.223.35 USERTEST_PLUGIN_ROUTES=read-write sh /opt/usertest/server.sh 178-62-223-35.sslip.io
ssh root@178.62.223.35 docker logs atomic-plugins 2>&1 | grep 'Plugin routes are on'
```

The last line should say `Plugin routes are on (read-write); installation
origins are subdomains of https://routes.178-62-223-35.sslip.io.`
Restarting atomic-server interrupts moderated sessions in progress. To turn
routes off again, run `server.sh` without the variable: Installations of
server plugins then stay in the drive but answer nothing.

### Installing remoteStorage

In the same browser you will use for the app:

1. Open `https://plugins.178-62-223-35.sslip.io/app/dev-drive` (or your
   existing test drive). Create a folder for the documents and copy its
   subject.
2. New → Plugin. Edit it and name it `remoteStorage`. In the source field,
   **first click the `</>` button (Edit raw markdown)**, then replace the
   text with the contents of
   [`integrations/remotestorage/plugin.js`](../integrations/remotestorage/plugin.js)
   (the raw file) and save without switching back. On its **Code** tab,
   click **Publish to integration store**.

   The source is a Markdown property, and the Edit form opens it in the
   rich-text editor. Code pasted there is saved as that editor's Markdown
   serialization, not as pasted: brackets get backslashes, and fences and
   blank lines are added. Publishing then fails with a QuickJS syntax
   error such as `plugin source: expecting ';' at plugin:437:1`, seen on
   the droplet on 2026-09-30. The file itself parses as a module in QuickJS
   and quickjs-ng. Re-saving it through the rich-text editor was reproduced
   in Node with TipTap 3 and candidate15's editor extensions: 1078 lines in,
   1116 out, and QuickJS rejects the result. If the **Code** tab shows `\[`
   or ```` ``` ```` in the source, edit it again in raw mode.
3. On Integrations, open the remoteStorage release. In the review, check
   **Incoming items**, set the config to
   `{ "table": "<the folder's subject>", "user": "me" }` and click
   **Install**.
4. On the Installation page, **Endpoints** lists the route URLs, all on
   `https://<slug>.routes.178-62-223-35.sslip.io`. Allow that host once:

   ```sh
   ssh root@178.62.223.35 touch /etc/caddy/routes-allowed/<slug>.routes.178-62-223-35.sslip.io
   curl -s "https://<slug>.routes.178-62-223-35.sslip.io/.well-known/webfinger?resource=acct:me@<slug>.routes.178-62-223-35.sslip.io"
   ```

   The first request waits a few seconds for the certificate. The answer is
   a JRD whose `links` name the storage root and the OAuth endpoint on that
   host. No restart or reload is needed: Caddy asks its own loopback
   endpoint (`127.0.0.1:8083`) on each new host name.

### Connecting an app

The user address is `me@<slug>.routes.178-62-223-35.sslip.io`. Any
remoteStorage web app should do, for example
[Inspektor](https://inspektor.5apps.com/) (browses and edits everything in
the storage, so it asks for `*:rw`). Paste the address into the app's
connect widget; it redirects to atomic-server's consent page on
`plugins.178-62-223-35.sslip.io`, which shows the app's origin and the
scopes. Click **Allow** (you must be the agent that manages the
Installation, which is why step 1 used the same browser). The app gets its
token and can read and write; each document shows up as a File in the
folder. Tokens are listed and revoked on the Installation page.

Not verified: that apps built on remotestorage.js 1.x (most published apps,
Inspektor included) work with this server. The lane's e2e ran
remotestorage.js 2.0.0-beta.10. A denied request is not reported back to the
app (see the plugin's README, "Not supported, or not atomic").

To connect from a page on your laptop instead, serve any remotestorage.js
demo on `http://localhost:<port>`; the storage answers CORS for any origin.

## Moderated sessions

A session tests one feature of Atomic: a drive app, or a part of Atomic
itself (the calendar view on tables, say). A tester needs only the invite
link, `https://plugins.<base-domain>/usertest/?code=<USERTEST_CODE>&session=<plan>`,
and Chrome or Edge. `<plan>` names a session plan in
[`moderator/sessions/`](moderator/sessions/): which feature to test and which
tasks to give. The page lists every plan in a "What do you want to test?"
menu (`GET /usertest/api/plans`, titled by each plan's first heading), and
`<plan>` only preselects one, so the tester can switch before starting;
without it the menu starts on `calendar`. A switch is written back into the
address bar, so a reload keeps it. A `<plan>` the moderator doesn't know
stays in the menu, and starting with it fails with the list of known plans.
The code is in `/etc/usertest-moderator.env` on the droplet;
`moderator/run.sh` creates it on first run. The page:

1. explains the session, lets the tester pick what to test, says what is
   recorded and where it goes, and asks for consent; it tests the invite code as soon as it loads (`GET /check`);
2. runs a sound check before Start: "Test microphone" asks for the
   microphone and shows its level, and passes once it hears the tester;
   an optional check shows what the speech recognizer made of a sentence;
   "Test speakers" plays a line in the moderator's voice for the chosen
   language, names the voice, and offers the other voices for that language
   with "Try this voice"; a picked voice is kept for the browser session
   (`sessionStorage`). Nothing is recorded during the check. Start stays off until the
   microphone check passed or the tester chose "Type instead". The
   microphone the check opened is the one recorded; screen sharing is still
   asked for at Start, since sharing starts the recording;
3. stores the test catalog URL in the browser, opens a fresh drive
   (`/app/dev-drive`) in a second window, and starts recording the shared
   screen and the microphone;
4. listens with the browser's speech recognition (Chrome sends the audio to
   Google), sends a turn to the moderator after a pause, a minute of silence
   or a new error in the collector log, and speaks the answer with the
   browser's speech synthesis;
5. has a box for typed answers under the controls, for testers who can't
   talk out loud or whose microphone doesn't work. Voice stays the default.
   A typed answer is sent at once (Enter) and reaches the moderator marked
   `[Tester, typed]`. Without a microphone (none, broken or refused) or
   without speech recognition (a browser other than Chrome or Edge), the
   session still starts, typed only, and records the screen without sound.

Each way the start can fail has its own message, in both languages: invite
code rejected (only when the moderator answers 403, which it does for a
wrong or missing code and nothing else), no code in the link, unknown
session plan (400), no more sessions today (429), microphone blocked (with
how to allow it again in Chrome or Edge), no microphone, speech recognition
not supported, screen sharing cancelled, and test server unreachable (no
answer, or 5xx, with a Try again button). A microphone or screen problem is
never reported as a code problem.

The voice is picked by `page/voices.js`: the exact language (`en-US`,
`nl-NL`) before the same base language (`nl-BE`); within that, voices named
Natural, Neural, Online, Premium, Enhanced or Siri, then Google's own
("Google Nederlands"), then network voices (`localService: false`, Chrome and
Edge), then the rest. Robotic and novelty voices (eSpeak, Fred, Albert,
Zarvox, Bad News, Trinoids and the other old macOS ones) are never picked or
offered. Chrome and Edge list voices only after `voiceschanged`, so the page
waits for it, up to 3 s, unless it already has a good exact-language voice,
and switches to a better voice that arrives later from the next line on
(unless the tester picked one). Rate and pitch are 1.0. The ranking is
checked against stubbed voice lists, not yet by ear in each browser: how
good the best voice sounds depends on the tester's browser and OS.

`e2e/run.mjs` checks the sound check and these messages headlessly: it runs
the moderator with a dummy code against a stand-in for the Claude API and
drives Chromium's new headless mode with fake media devices, or with the
microphone denied. A cancelled screen picker is simulated (headless Chromium
cannot deny one); real speech recognition and whether the speaker test is
audible are not covered.

```sh
npm ci --prefix usertest/moderator
npm ci --prefix usertest/e2e && npx --prefix usertest/e2e playwright install chromium
node usertest/e2e/run.mjs
# with a Chromium other than Playwright's download:
CHROMIUM_PATH=/path/to/chromium node usertest/e2e/run.mjs
```

The page is in English or Dutch (Nederlands), picked with the buttons at the
top, by `&lang=nl` in the invite link, or remembered from a previous visit.
The choice switches the page's texts, the speech recognizer, the
moderator's voice (a `nl-NL` voice, else `nl-BE`, else the browser's
default; never an English voice reading Dutch)
and the language the moderator speaks, also mid-session: switching back to
English restores all of it from the next line on. Session plans stay in
English; each turn tells Claude the language in a `[Language]` line, so the
cached system prompt does not change. The Atomic app in the second window
stays in English: the data-browser has no Dutch translation yet (it has
English, Spanish, French and German). To add a language, see the top of
`page/i18n.js`. Checked on 2026-09-29 with a stub in place of the Claude API
and a macOS Dutch voice; not yet with a Dutch-speaking tester, so the speech
recognition of Dutch is not verified.

The moderator (`moderator/server.mjs`) asks Claude (`claude-opus-5`, effort
`low`, server-side refusal fallback on) for the next line, following the
interview script in `moderator/script.md` and the session's plan: short spoken questions, mostly
listening (`[WAIT]`), no help unless the tester is stuck and asks. Each turn
includes the collector's error, warning, feedback and sync lines since the
previous turn. Measured on 2026-09-28: about 3 seconds per turn, and the
script served from the prompt cache after the first turn.

A turn only includes its own tester's log lines. The collector tags each
line with `client`, a salted hash (`/etc/usertest-salt.env`) of the sender's
address; the moderator keeps the hashes its tester's page came from. So
sessions can run at the same time. atomic-server's own lines are always
included.

### Findings and triage

When a session ends (the tester ends it, or the moderator says `[END]`),
`moderator/analyze.mjs` sends the transcript, the log lines and up to 12
screenshots to Claude (`claude-opus-5`, effort `high`). It writes anonymized
findings, `findings.json` and `findings.md`, into the session folder. No
name, email address or calendar content goes in; the prompt forbids it and
`scrub()` removes the tester's name, email addresses and URL queries. With
`/etc/github-findings.env` it files each finding as an issue in the private
repo `ontola/usertest-findings`. That token is a fine-grained GitHub token
with Issues read/write on that one repository only, created and saved by a
person. Nothing reaches a public repository until Michiel labels it
`approved` there.

For a session that ended without the page saying so (a closed window):

```sh
ssh root@178.62.223.35 docker exec usertest-moderator node analyze.mjs <id> [--file]
```

Measured on 2026-09-28 on session 1 (about 11 minutes): 34 s, about 2,000
input and 2,400 output tokens, 6 findings.

Per session, `/var/lib/usertest-sessions/<id>/` holds `meta.json` (with
`input`, `voice` or `typed` for how the session started, `typedTurns`,
`lang`, the current language, and `langChanges`, each switch with its time),
`transcript.jsonl` (both sides, with the log lines each turn saw, token
usage, and `input: "typed"` or `"voice"` and `lang` per tester turn), `screen-NNN.jpg` per turn, `recording.webm`, and after the analysis
`findings.json`, `findings.md` and, when filed, `filed.json`. Limits: the invite code on every request, at
most 120 turns per session and 20 sessions per UTC day. The moderator keeps
sessions in memory, so restarting it ends the sessions in progress.

Not verified yet: a full session by a real tester, and Edge. The plan menu
(2026-09-30) was not run in a browser against the droplet's moderator. The typed-answer
box was checked against the moderator with a stub in place of the Claude API
(2026-09-29), not yet in a browser session with screen sharing.

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
