# Google Tasks

A read-only drive app that imports the Google task lists a person ticks into
its own table of the shared `issue-v1` class
([#355](https://github.com/ontola/atomic-plugins/issues/355)). It is the
Todoist app (`../issue-tracker/todoist-app/`, 0.2.0) adapted to the Tasks API
v1: the same shape, the same shared sync-status card, the same bounded
rate-limit handling, in its own folder with nothing imported from Todoist's.

- `app/`: the drive app. `main.ts` (the view), `controller.ts` (the state
  machine), `sync.ts` (one import pass), `read.ts` (the three reads and the
  rate-limit handling), `tasks.ts` (the pure mapping and what happens to a
  task that stops appearing), `drive.ts` (the app's own properties and the
  `issue-v1` provisioning), `status.ts` (the card mapping), `store.ts` (the
  host's types), `build.mjs`. Version in `app/package.json`; the built module
  is `apps/google-tasks/<version>/ui.js`.
- `fixtures/google-tasks/`: the SYNTHETIC mock-proxy fixture (no recording).
- `e2e/google-tasks.spec.ts`: the host journey against the mock proxy.

```sh
node integrations/tooling/run-lane.mjs google-tasks --tier typecheck
node integrations/tooling/run-lane.mjs google-tasks --tier unit
node integrations/tooling/run-lane.mjs google-tasks --tier e2e   # needs the pinned atomic-server binary
```

## What it does

**Flow.** "Connect Google Tasks" asks the host for a connection
(`store.proxy.connect`, the host's consent bar, platform `google-tasks`).
With a connection, every open of the view, every "Sync now" and every tick
or untick of a task list runs one pass (`sync.ts`): `GET
/tasks/v1/users/@me/lists` through `store.proxy.request`, then for each
ticked list `GET /tasks/v1/lists/{tasklist}/tasks` with
`showCompleted=true&showHidden=true&maxResults=100`, paged by `pageToken`
(at most 50 pages per read; past that the read is reported partial); then
`GET /tasks/v1/lists/{tasklist}/tasks/{task}` for each previously imported
task that a complete read no longer lists (at most 50 per pass); then
`reconcileTasks` (`tasks.ts`). All reads happen before any write, so a
failed read leaves the table as it was. The view puts the shared sync-status
card first, then the connect and sync buttons, the task lists as checkboxes,
and the table's tasks with their status, presence, due day, list, parent
task and last-seen.

**Which lists.** None at first: the first sync reads the lists and the card
says "No task list chosen." The ticked ids are kept on the App resource as
`google-tasks-lists` (JSON text). Unticking a list keeps its rows as last
read, unchecked and listed as such on the card; ticking it again syncs them.

**Rows** are of the shared class `issue-v1` (#177), like the Todoist app's:
on first open the app adds the class to its App's `renders`, its extras to
`row-extras`, and sets its table's `classtype` (`drive.ts`; shown on another
Issue table it says so and imports nothing). Shared fields go through
`ontology-kit`'s strict resolver: `name` (the task's `title`; `""` when
Google sent none, so the row is listed as incomplete, never skipped),
task/v1 `status` (`done` when Google's `status` is `completed`, else
`todo`), `body` (the task's `notes`) and `due-date` (the date part of
Google's RFC 3339 `due`, whose time part Google documents as always
midnight UTC and carrying no information: the exact string `2026-03-02`,
never shifted into a local time zone). The provider extras, created once
under the app's own ontology: `google-tasks-task-id` (the row's identity),
`google-tasks-list-id` and `google-tasks-list`, `google-tasks-presence`,
`google-tasks-last-seen`, `google-tasks-parent` (a subtask's parent task id:
the table is flat) and `google-tasks-source` (the task as Google last sent
it, JSON text). A pass that finds nothing changed writes no row: the one
write is the App's `google-tasks-last-sync`.

**Completed and hidden tasks are imported** (a done row), because Google
keeps listing them and its own apps hide a task the moment it is completed,
so without `showHidden=true` a completion made in Google would look like a
disappearance. What leaves a read is a task deleted in Google (`showDeleted`
stays false), moved to another list, or in a deleted list.

## A task that stops appearing

Absence alone is never read as completion or deletion. After a complete
read of a list, a previously imported task missing from it is looked up by
id once:

| Google answers by id                        | Presence      | Row                                               |
| ------------------------------------------- | ------------- | ------------------------------------------------- |
| 200 with `deleted: true`                    | `deleted`     | kept as last read, not closed, `last-seen` set    |
| 404                                         | `unavailable` | kept with the last values Google sent, not closed |
| the task itself (hidden, say)               | `present`     | takes Google's current values                     |
| an error, or no lookup (the per-pass cap)   | `unconfirmed` | last known values; checked again at the next sync |
| its list is gone from a complete lists read | `unavailable` | no lookup made                                    |

A partial read (the page cap) settles nothing, and the App's
`google-tasks-last-sync` is not moved. A task back in a read is `present`
again. No row is ever removed, and nothing is sent to Google.
`last-seen` is set only on a task that is not `present`: a present task was
seen at the App's last sync.

**Not verified** against Google: that a deleted task answers 200 with
`deleted: true` by id (the reference documents the field; the fixture models
it), that a task completed in Google's own apps comes back `hidden: true`,
and the exact fields of real responses. The live run is Decision Inbox
Q-098.

## The sync-status card

The shared card of [`integrations/sync-status/`](../sync-status/README.md)
(Q-084) heads the view; `app/status.ts` maps the controller's state onto it,
pure, and `main.ts` renders it on every state change. What it gets right:

- Read-only in every state: "Read-only: edits here stay in Atomic. Nothing
  is sent to Google Tasks. An edit here to an imported column (Name, Status,
  Description, Due date) is overwritten at the next sync; a row added here is
  kept." On a host without the proxy client the note promises no next sync
  ("nothing is read or overwritten until this Atomic Server can connect apps
  to it"). On another app's Issue table, which this app never syncs and
  whose own app may send edits back, no card is rendered at all: the view
  shows only the plain notice.
- A failed load is a visible `error` state on the card, never only on the
  hidden status line.
- The last good sync (`google-tasks-last-sync`, a strict ISO 8601 UTC string;
  a future time or junk is ignored) is read before any state renders, so a
  table holding imported rows never reads "Not synced yet", also when
  `disconnected`. A failed sync names it ("Last good sync 2 days ago"); the
  status line says "Tasks imported earlier are kept." only when rows were
  imported before.
- Each row is in at most one group (deleted, unavailable, unconfirmed, in an
  unticked list, added here, incomplete); the app has no write queue, so
  nothing is counted twice. A later successful sync replaces every warning.
- A rate limit says whether the app retries by itself and when, or that the
  sync stopped and when to try again.

## Rate limits

Google answers a quota overrun with 429, or with 403 whose body names
`rateLimitExceeded` or `userRateLimitExceeded` (or `RESOURCE_EXHAUSTED`);
`read.ts` treats both the same. `Retry-After` is read only as delay-seconds
or an IMF-fixdate; anything else counts as absent (default 60 s). The wait
before a retry is `max(asked, 1 s × 2^attempt)`, clamped to a day. A wait of
at most 10 s is sat out inline, at most twice per request (so at most 20 s
per request). A longer wait, or one retry too many, stops the pass before
any write (`GoogleRateLimited`); the controller retries once at that time
when it is within 15 minutes, at most 3 times in a row, then stops and says
when to try again. "Sync now" cancels a waiting retry; nothing is scheduled
while a pass is busy or after `dispose()`. Unit-tested against fake
transports with a pinned clock (`read.test.ts`, `sync.test.ts`).

The integration proxy forwards only some upstream response headers to the
frame (`integration-proxy/src/proxy.rs` `upstream_response_headers`:
`content-type`, `link`, `retry-after`, `etag`, `x-total-count`,
`x-next-page`), and the host's frame client fewer still; the app relies on
`retry-after` only, and copes without it.

## The proxy side

The real integration proxy composes a platform from a dated catalog. Google
Tasks is in `overlays/catalog/2026-10-06-google-tasks.json` (the 2026-10-02
auth-profiles catalog plus one platform): the pinned OAD, the published
pagination overlay (#354) and a new auth overlay
(`overlays/APIs/googleapis.com/tasks/v1/auth-7ca47c7…-overlay.yaml`) that
declares `googleOnline`/`googleOffline` with the one scope
`https://www.googleapis.com/auth/tasks.readonly` and narrows every operation
to it, as Calendar's does. Nothing composes it yet: a proxy picks it up only
through `CATALOG_PATH`, with `OAUTH_GOOGLE_TASKS_CLIENT_ID` and
`OAUTH_GOOGLE_TASKS_CLIENT_SECRET` set and the Tasks API and that scope
enabled on the Google Cloud project. That deployment is Michiel's (Q-098).

## Why its own pager, not syncables

The reads are nested per task list with fixed flags, followed by by-id
lookups and rate-limit handling on the relayed `retry-after` header, and the
Tasks API has a pagination overlay but no CRUD causality overlay; an own
pager (`read.ts`, 100 rows a page, 50 pages a read) is smaller than
bundling a composed document for `syncables/browser`. The Todoist and
Moneybird apps made the same choice.

## What is verified

- Unit (`app/*.test.ts`, 70 tests): the mapping, the reader and its rate
  limits, every card state, the import pass and the controller, with the
  clock pinned (`vi.useFakeTimers({ toFake: ['Date'] })`).
- Host E2E (`e2e/google-tasks.spec.ts`, the `google-tasks` lane): catalog
  install of 0.1.0, connect through the host's consent bar and the mock
  proxy, the lists read with nothing imported, a ticked list's 5 rows as
  `issue-v1` at the published subjects, a reload that writes no row, a task
  completed in Google turning up done, a deleted one marked deleted and kept,
  a row with an empty Name shown as incomplete, and the card's words at each
  step. Against the SYNTHETIC fixture only.
- Nothing against a real Google account or the real integration proxy. The
  catalog entry stays `enabled: false` until Michiel's live run (Q-098) and
  the stable ontology domain.
