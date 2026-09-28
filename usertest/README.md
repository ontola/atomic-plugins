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
```

Docker publishes the server on `127.0.0.1` only, so ufw's rules are not
bypassed.

From a checkout of this repo, with the layout from `AGENTS.md`
(`node integrations/tooling/link-atomic-server.mjs`) and each app's
dependencies installed:

```sh
for a in calendar money notion timesheets; do (cd integrations/$a && pnpm install); done
(cd integrations/issue-tracker/app && pnpm install --frozen-lockfile)
node usertest/catalog.mjs
sh usertest/deploy.sh root@178.62.223.35
ssh root@178.62.223.35 sh /opt/usertest/server.sh 178-62-223-35.sslip.io
```

## Updating an app

1. Change the app, then bump its entry in `VERSIONS` in `catalog.mjs`.
2. Run `node usertest/catalog.mjs && sh usertest/deploy.sh root@178.62.223.35`.
3. On Integrations, testers who installed the old version see "Update to
   <version>".

Never rebuild into an existing version: the host refuses a module whose bytes
no longer match the hash in the catalog.

## For testers

1. Open `https://plugins.<base-domain>/app/dev-drive`. It creates an agent
   and a drive in the browser, without signup.
2. In Settings → Integration, set the plugin catalog URL to
   `https://catalog.<base-domain>/catalog.json`.
3. On Integrations, install an app and connect it with your own account.

Step 2 goes away once the planned `/usertest` page sets it.

## Logs

```sh
ssh root@178.62.223.35 docker logs --since 1h atomic-plugins
heroku logs -a integration-proxy -n 500   # needs access to the Heroku app
```

A plugin's errors happen inside its sandboxed frame and do not reach either
log yet. Collecting them is the next step (a Sentry-compatible collector on
the droplet).

## Privacy

Testers connect real accounts. Their data is on the droplet, in the Docker
volume `atomic-plugins-store`, and their provider tokens are in
localthought.io's database. Tell testers this before they start. Reset the
store with `docker rm -f atomic-plugins && docker volume rm atomic-plugins-store`,
then run `server.sh` again.
