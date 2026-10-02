# Bounded live verification

Offline certification never enables live tests. A live run needs a dedicated
vendor test identity and a disposable repository or database shared only with
that identity. The personal Notion pilot is not a standing CI account.

Before a run, record provider, account owner, exact resource ID, bundle hash,
Atomic connection and approver. Issue a short-lived credential restricted to
that resource; keep it in the host secret store, never fixtures or reports.
Use a new Atomic drive and unique run prefix for every created record.

For the first automated canary, use this bounded sequence:

1. Verify the current full offline report matches the candidate bundle.
2. Inspect only the allowlisted repository/data source. Abort on unexpected
   schema, permissions, existing run prefix or an active background schedule.
3. Create one provider row, import it, edit one supported field in Atomic,
   then edit it in the provider and pull it back. Assert exact values each way.
4. Create one Atomic row and push it. Repeat the sync twice; assert exactly two
   remote records with the run prefix and stable bindings.
5. Stop after ten minutes or twenty provider mutations, whichever comes first.
   A timeout is a failure, never a successful or skipped certificate.
6. Close/archive only the two records recorded in this run's creation receipts.
   Never clean up by broad name search. Retain IDs when cleanup fails, and
   report failure so the owner can recover them. Revoke the run credential.

Keep polling disabled for this manual canary. A background variant needs an
explicitly authorized test window, durable expiry enforced by the host, and
verified schedule shutdown even when the runner crashes. A client-side timeout
alone does not bound a persistent server schedule.

Evidence must record assertions, candidate hash, provider API version, start/end
times and cleanup outcome without credentials or private row contents. A failed
assertion or incomplete cleanup prevents promotion. Provider errors should retain
status/request IDs where safe; never dump authentication headers.

Implementation status: the sequence above is the run contract for the sandbox
plugins and is not automated. The drive apps for Calendar, Timesheets and the
GitHub issues app have a manual live-check kit that Michiel runs with his own
disposable accounts (next section); no run has been recorded yet, so every
capability stays declared, not verified. Host-enforced expiry and live
adapters for the sandbox plugins remain to implement.
Notion's `atomic.live.test.ts` uses authored HTTP replies and is not
vendor-live evidence. GitHub issues sync now runs entirely in-browser via
Devonian, outside this Rust-sandbox live-test tier; see
`integrations/issue-tracker/devonian/github-issues/` (its README and
`github.live.test.ts`).

## The live-check kit

A manual kit for the drive apps, run by a person with their own disposable
accounts. Agent sessions have no provider credentials and must never handle
anyone's tokens, so no session runs it against a real provider; the offline
tests below are what a session can run.

One command per app:

```sh
node integrations/tooling/live-check.mjs <app> --i-understand-this-writes-to <id>
```

| App           | `<app>`         | `<id>` names                   | Credential (environment variable) |
| ------------- | --------------- | ------------------------------ | --------------------------------- |
| Calendar      | `calendar`      | the test calendar's id         | `GOOGLE_CALENDAR_ACCESS_TOKEN`    |
| Timesheets    | `timesheets`    | the test workspace's id        | `CLOCKIFY_API_KEY`                |
| GitHub issues | `issue-tracker` | the sandbox repo, `owner/name` | `GITHUB_TOKEN`                    |

Notion 0.2.0's writes (#8), Moneybird (#102) and Todoist (#46) have no kit
yet.

### How it runs

It runs the app's own controller and sync code (`integrations/<app>/app/`)
from Node, in a child Vitest process
(`integrations/<app>/vitest.live.config.ts`, which only includes
`live/check.live.ts`), against an in-memory `store`. Its `store.proxy` is a
relay stand-in (`relayStandIn` in `integrations/tooling/live-kit.mjs`): it
names one connection, `live-check`, and the provider client adds the
credential to each request itself, so the controller never sees it, as in
the host. No browser, no atomic-server and no integration proxy take part.
The kit's own setup, check and cleanup calls (the "driver") go through the
same client and the same scope check as the app's.

### Guard rails

All enforced in code and unit-tested offline.

- **Explicit target.** Without `--i-understand-this-writes-to <id>` the
  command exits with status 2 before it reads the credential or starts
  anything. The id names the one calendar, workspace or repository the run
  may write to. Every request that addresses another resource is refused
  before it is sent (`allowFor` in each `live/scenario.ts`).
- **Looks disposable.** The resource's own name must contain "test",
  "testing", "sandbox", "disposable", "scratch", "throwaway" or "live-check"
  as a whole word. Calendar: not the primary calendar, writable by the
  account, no existing events. Timesheets: at least two active projects, no
  running timer and no entries from 30 days back to 2 days ahead. GitHub: the
  token may push, issues are enabled, and every existing issue is a closed
  `livecheck-...` leftover of an earlier run. Anything else aborts with no
  write.
- **Credentials.** Read from the environment variable, or from a hidden
  prompt on a terminal. Never from a file in the repo, never from a flag
  (flags land in shell history and `ps`). The child gets it through its
  environment only. Every line the command prints, including the child's
  output, and every byte of evidence passes through a redactor that removes
  the credential (also percent- and base64-encoded), Bearer, Google, GitHub
  and Notion token shapes, credential headers and email addresses. To keep it
  out of shell history: `read -rs GITHUB_TOKEN; export GITHUB_TOKEN`.
- **Budget.** At most 40 provider writes (`--max-mutations`) and 10 minutes
  (`--max-minutes`); a timeout is a failure, never a skip. The canary above
  allows 20 writes for its narrower sequence; this kit runs more scenarios
  and so allows more. Cleanup may exceed the budget by one write per record
  the run created, and two more minutes.
- **Cleanup.** Only records in the run's creation receipts (ids it chose, or
  ids the provider returned for its own POSTs), never a search by name.
  Failures are reported with the ids to remove by hand and fail the run.
- **Preflight only.** `--preflight-only` checks the credential and the target
  with reads, writes nothing and records evidence with status
  `preflight-only`.
- **Calendar writes** always carry `sendUpdates=none`, so no guest is emailed.

### What each run covers

Steps stop at the first failed step of the setup (Calendar: any step;
Timesheets and GitHub issues: S0 to S2), and the later scenarios of
Timesheets and GitHub issues run independently. The assertions are exact
(title, dates as strings, the `If-Match` header, which fields the app's
request carried). A few facts the app depends on are recorded as observations
instead of assertions, for example what `billable` Clockify stores.

| App           | Steps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar      | S0 preflight. S1 seed five events (all-day, three-day all-day, timed, weekly series, one cancelled) with chosen ids. S2 import: picker, three rows, series skipped. S3 a second sync changes nothing. S4 a Google-side edit pulled in. S5 a reviewed edit sent: only the changed fields, `If-Match`, `sendUpdates=none`. S6 a write after a Google-side change answers 412 and is reviewed again. S7 both sides changed one field: a conflict, resolved "Use Google's" and "Keep mine" (held for review, then sent). S8 events deleted in Google: kept as local or removed here, and the app sends no DELETE.        |
| Timesheets    | S0 preflight. S1 seed a tag and four entries. S2 import, rows equal Clockify's. S3 re-sync unchanged. S4 a Clockify-side edit pulled in. S5 a reviewed edit sent as a full-replacement `PUT` that keeps every other field. S6 a project and `billable` edit (#123). S7 changed on both sides: Clockify wins. S8 a delete sent from the app, and one made in Clockify (confirmed by the second sync's GET by id). S9 a range edit inside one entry: a `PUT` trims it and `POST`s create the middle and a copy of the rest, which must carry description and tag (#123). S10 "did not work" over one entry deletes it. |
| GitHub issues | S0 preflight. S1 seed two issues, labels and a comment. S2 import: title, status, body, labels, comments, URLs. S3 re-sync unchanged. S4 a GitHub-side edit pulled in. S5 a reviewed title edit held, then sent. S6 a status move to Done closes the issue and a comment is added, both after review. S7 a new issue made in the table is created once. S8 a conflict on the title pauses the sync; resolved to GitHub's side and to this side. S9 an issue closed on GitHub shows as Done.                                                                                                                          |

Not covered, and written into every evidence file's `notCovered`: a lost
write response, a revoked or expired credential (401) and rate limits; the
consent bar, the integration proxy and its OAuth; the host, the frame and the
table (the controller runs against an in-memory store). Per app: Calendar
recurring events beyond being skipped and calendars over 250 events;
Timesheets tasks, custom fields, locked entries, running timers and
`forceProjects`; GitHub issues an issue deleted or transferred away (the REST
API cannot delete an issue), assignees, milestones and pull requests. The
GitHub run closes the issues it made as `not_planned` and deletes its
comments; the closed issues stay, which later runs accept as `livecheck-...`
leftovers.

### Evidence

Each run writes `<app>-<UTC stamp>.json` and `.md` to
`integrations/live-evidence/<app>/` (`--out <dir>` to change it). Fields, as
the contract above asks: provider and API version, the candidate (app
version, source commit, whether the package had uncommitted changes, the
published bundle's path and SHA-256), the exact target id, start and end
times, every request (method, path, status, whether `If-Match` was sent, the
body's key names only; no bodies and no headers), the limits and writes used,
each step's assertions, the cleanup outcome (created, deleted, leftover) and
`notCovered`. It records no credential, and no personal data beyond the test
account's own invented content. The file says it ran the app's source, not the
published bundle and not the host's frame.

A failed assertion or incomplete cleanup is a failed run. Committing the files
is a deliberate step by whoever ran it. Nothing reads them yet:
`integrations/evidence.json` and `certify.mjs` still say `live: not-run`, and
catalog copy stays "declared, not verified" until a person reads a passing run
and decides what it supports.

### Prepare, then run

Set up the repository layout once (see [Local setup](README.md#local-setup)):

```sh
export ATOMIC_SERVER_CHECKOUT=~/.cache/atomic-plugins/atomic-server/$(cat .atomic-server-ref)
node integrations/tooling/link-atomic-server.mjs
(cd devonian && pnpm install --frozen-lockfile)                        # GitHub issues only
(cd integrations/issue-tracker/app && pnpm install --frozen-lockfile)  # GitHub issues only
```

**Calendar.** In a throwaway Google account, create a new secondary
calendar named for example "Atomic live-check test" and leave it empty.
Its id is under Settings, "Integrate calendar" (it ends in
`@group.calendar.google.com`). Get an OAuth access token for that account
with the scopes `https://www.googleapis.com/auth/calendar.events` and
`https://www.googleapis.com/auth/calendar.calendarlist.readonly` (for
example from Google's OAuth 2.0 Playground; an access token lasts about an
hour, which is enough for a run).

```sh
read -rs GOOGLE_CALENDAR_ACCESS_TOKEN; export GOOGLE_CALENDAR_ACCESS_TOKEN
node integrations/tooling/live-check.mjs calendar \
  --i-understand-this-writes-to 'abcdef0123@group.calendar.google.com' --preflight-only
node integrations/tooling/live-check.mjs calendar \
  --i-understand-this-writes-to 'abcdef0123@group.calendar.google.com'
```

**Timesheets.** In a Clockify account of its own, create a workspace named
for example "Atomic live-check test" with two active projects and no time
entries. Its id is in the workspace's URL. The API key (Profile settings,
API) belongs to the user, who can see every workspace of the account; the
run still only touches the one named. Prefer an account that has no other
workspace.

```sh
read -rs CLOCKIFY_API_KEY; export CLOCKIFY_API_KEY
node integrations/tooling/live-check.mjs timesheets \
  --i-understand-this-writes-to 64f0c0ffee0123456789abcd --preflight-only
node integrations/tooling/live-check.mjs timesheets \
  --i-understand-this-writes-to 64f0c0ffee0123456789abcd
```

**GitHub issues.** Create a new repository on a dedicated test account whose
name contains "test", for example `atomic-live-check-test`, with Issues
enabled and nothing in it. Create a fine-grained personal access token that
can reach only that repository, with Issues: Read and write and Metadata:
Read.

```sh
read -rs GITHUB_TOKEN; export GITHUB_TOKEN
node integrations/tooling/live-check.mjs issue-tracker \
  --i-understand-this-writes-to some-test-account/atomic-live-check-test --preflight-only
node integrations/tooling/live-check.mjs issue-tracker \
  --i-understand-this-writes-to some-test-account/atomic-live-check-test
```

Revoke the credential afterwards.

### Offline tests

```sh
node --test integrations/tooling/live-kit.node-test.mjs
./browser/node_modules/.bin/vitest run --config integrations/calendar/vitest.config.ts integrations/calendar/live
./browser/node_modules/.bin/vitest run --config integrations/timesheets/vitest.config.ts integrations/timesheets/live
./browser/node_modules/.bin/vitest run --config integrations/issue-tracker/vitest.config.ts integrations/issue-tracker/live
```

These cover refusing without the confirm flag, a name that does not look
disposable, another resource, the primary calendar, a non-empty target, the
budget, redaction of the credential from evidence, logs and child output,
cleanup, and the whole scenario of each app against an in-memory Google, the
mock proxy's Clockify fixture and its GitHub fixture. They show that the
script does what its assertions say. They are not evidence about the
providers, and a first real run may fail an assertion that the fakes could not
anticipate; read the failed assertion before deciding whether the app or the
script is wrong. The lane `unit` tiers run the three `live/*.test.ts` files;
`live-kit.node-test.mjs` is not named `*.test.mjs` on purpose: the tooling job lists its test files in `ci.yml` and checks that every `*.test.mjs` is listed, and a worker session cannot push workflow changes. Rename it and add it to that list to run it in CI.
