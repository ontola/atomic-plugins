# GitHub issues ↔ Atomic kanban

A two-way sync for one repository and one ordinary Atomic kanban table. Provider
code (`adapter.ts`, `tracker-actions.ts`) stays here.

This folder also holds the plugin's other issue sources:

- `app/`: the **GitHub issues drive app**, the current host for the Devonian
  bridge (#100). See [Drive app](#drive-app-app) below.
- `devonian/github-issues/`: the in-browser Devonian GitHub issues lens and
  bridge (moved from the `devonian` package; see its README).
- `todoist.ts`: the read-only LocalThought projection of Todoist tasks onto
  an issue list (moved from `integrations/localthought/`), with
  `todoist.test.ts` and the fixture check `todoist-fixture.test.ts`.
- `todoist-app/`: the **Todoist drive app**, the host for `todoist.ts`
  (#99's host journey). See [Todoist drive app](#todoist-drive-app-todoist-app)
  below.

## Mapping

| GitHub                                    | Atomic      |
| ----------------------------------------- | ----------- |
| Issue title                               | Card title  |
| Markdown body (`null` becomes empty text) | Description |
| Open, without a workflow label            | Todo        |
| Open, with `atomic:doing`                 | Doing       |
| Open, with `atomic:blocked`               | Blocked     |
| Closed                                    | Done        |

Dragging a card to Done closes its issue; moving it back reopens it. Other labels
are preserved: the adapter adds/removes only `atomic:doing` and
`atomic:blocked` (#177 Q8), never replaces the whole label set. An open issue
with both is Blocked. Closing keeps the labels as they are. Create both
labels in the test repository before using Doing or Blocked.
Pull requests are excluded. Comments, assignees, milestones, GitHub Projects and
issue deletion are outside this first scope. A missing issue/card is a conflict,
not permission to delete the other side.

## Todoist: tasks that stop appearing

`todoist.ts` is read-only: the proxy's Todoist catalog grants `data:read`
and allows `GET` only (`/tasks`, `/tasks/{task_id}`, `/projects`,
`/projects/{project_id}`). Closing, editing or creating a task in an issue
list is never sent to Todoist, and the next import does not undo a local
edit on its own either; whatever imports the rows decides that.

`/tasks` lists **active** tasks only. A task that was imported and is
missing from a later read may have been completed, deleted, moved to a
project the connection cannot see, or the connection may have lost access.
Absence alone proves none of these, so the supported behaviour
(`reconcileTodoistTasks`, with `absentTodoistTasks` saying which ids to
check) is:

| Situation                                                        | `presence`    | `done`    | `last-seen` |
| ---------------------------------------------------------------- | ------------- | --------- | ----------- |
| In the active list                                               | `active`      | `false`   | this read   |
| Missing; `GET /tasks/{id}` returns it with `checked: true`       | `completed`   | `true`    | this read   |
| Missing; `GET /tasks/{id}` returns it with `is_deleted: true`    | `deleted`     | unchanged | unchanged   |
| Missing; `GET /tasks/{id}` answers 404                           | `unavailable` | unchanged | unchanged   |
| Missing; the check failed (network, 401/403, 5xx) or was not run | `unconfirmed` | unchanged | unchanged   |
| The read itself was partial or failed (`fetched.errors`)         | unchanged     | unchanged | unchanged   |
| Back in the active list after any of the above                   | `active`      | `false`   | this read   |

- "Unchanged" means the row keeps its last imported values, so
  `last-seen` says how old they are. No row is ever removed.
- `unavailable` is never shown as closed: Todoist does not say whether a
  404 means deleted or no longer reachable.
- `completed`, `deleted` and `unavailable` are not checked again until the
  task reappears; `active` and `unconfirmed` are checked on every complete
  read that misses them.
- `last-seen` is the caller's `seenAt`, an exact ISO 8601 string.

**Not verified.** Whether live Todoist API v1 returns a completed task from
`GET /tasks/{id}` with `checked: true`, rather than a 404, is not verified:
there is no recorded fixture yet (#46) and no credentials here. If it
answers 404, completed tasks will show as `unavailable`, which is still
not a false "completed". The cases above are covered by synthetic tests in
`todoist.test.ts`, and the host that runs them is the Todoist drive app
below: `todoist-app/sync.ts` calls `absentTodoistTasks`, looks the absent
tasks up through the host's proxy client, and calls
`reconcileTodoistTasks`. `fixtures/todoist/` serves SYNTHETIC rows
(`synthetic.mjs`, hand-written from Todoist's API documentation) until #46
records `api/`; its drivers model `completeTask` as "gone from `/tasks`,
`checked: true` by id", which is this fixture's assumption, not Todoist's
verified behaviour. The recording settles it: `record.mjs --completed-task
<id>` records what `GET /tasks/{id}` answers for a task completed by hand in
the test account (GET only, the token never written), `scenario.mjs` reads
that answer (`source().completed`) and makes a completed task answer 404 by
id when Todoist did, and `todoist-fixture.test.ts` fails on a recording that
left the question open or answered with neither. If the answer is 404, the
app shows completed tasks as `unavailable` (the row stays open, never a
false "completed"), and the e2e's step 3 expectation (`completed`, done)
must change to `unavailable` with the recording. Without a recording, the
tests prove the mechanism against an invented `api/` only.

## Todoist drive app (`todoist-app/`)

An iframe drive app, the same shape as `../money/moneybird/` (read-only, no
npm dependencies): one ES module (`todoist-app/build.mjs`, minified, 38,912
bytes for 0.2.0; `apps.mjs`'s `APP_FOLDERS` maps catalog id `todoist` to this
folder and publishes it as `apps/todoist/<version>/ui.js`) whose
`view({ root, store })` runs in the host's null-origin frame. It imports the
connected account's **active tasks** into its own table, nothing more; the
catalog entry `todoist` (`enabled: false`) installs it.

**Flow.** "Connect Todoist" asks the host for a connection
(`store.proxy.connect`, the host's consent bar, platform `todoist`). With a
connection, every open of the view and every "Sync now" runs one pass
(`sync.ts`): `GET /api/v1/projects` and `GET /api/v1/tasks` through
`store.proxy.request`, paged by `cursor` at `limit=200`, at most 50 pages
(past that the read is reported partial); then `GET /api/v1/tasks/{id}` for
each previously imported task that a complete read no longer lists; then
`reconcileTodoistTasks` from `../todoist.ts`, whose table above says what
each row becomes. All reads happen before any write, so a failed read
leaves the table as it was. The view puts the shared sync-status card first
(below), then the connect and sync buttons, then the table's tasks with
their status, presence, due day, priority, project and last-seen.

**Rows** are of the shared class `issue-v1` (#177), like the GitHub issues
app's: on first open the app adds the class to its App's `renders`, its
extras to `row-extras`, and sets its table's `classtype` (`drive.ts`;
shown on another Issue table it says so and imports nothing). Shared fields
go through `ontology-kit`'s strict resolver: `name` (the task's `content`),
task/v1 `status` (`done` only when Todoist returned `checked: true`, else
`todo`), `body` (the task's `description`) and `due-date` (the due day).
The provider extras, created once under the app's own ontology:
`todoist-task-id` (the row's identity), `todoist-presence`,
`todoist-last-seen`, `todoist-priority`, `todoist-project` and
`todoist-source` (the task as Todoist last sent it, JSON text). A pass that
finds nothing changed writes no row: `last-seen` is kept off active rows
(an active task's last sighting is the App's `todoist-last-sync`, one write
per complete read), and only a task no longer in the active list carries
its own `todoist-last-seen`.

**Local edits.** Todoist owns the imported columns: a local change to one
of them is overwritten at the next pass (#97's policy question; this plugin's
choice, the same as Moneybird's), and nothing is sent to Todoist. A row
made in the table by hand, with no Todoist task behind it, is left alone;
since 0.1.1 the view lists it too, with presence `local`.

**An incomplete row (0.1.1).** `issue-v1` requires Name. A row without one
is read through the resolver's `missing` and listed as "(no name)" with
"Incomplete: missing Name" and, where the host has `store.openResource`, an
"Open row" button to fill the column in the table (ontology-kit's rule for
every shared-class view: shown as incomplete, not skipped). Nothing is ever
sent to Todoist, so there is nothing to hold back; an imported row whose
Name was cleared in the table gets Todoist's `content` back at the next
pass, a hand-made one is completed in the table. Unit
(`todoist-app/sync.test.ts`) and the e2e's step 5 (a row with an empty
Name; the server refuses a commit without the property, see the GitHub
issues app's note on incomplete rows).

**The sync-status card (0.2.0).** The shared card of
[`integrations/sync-status/`](../sync-status/README.md) (Decision Inbox
Q-084) heads the view; `todoist-app/status.ts` maps the controller's state
onto it, pure, and `main.ts` renders it on every state change. It says, in
every state: "Read-only: edits here stay in Atomic. Nothing is sent to
Todoist. An edit here to an imported column (Name, Status, Description, Due
date) is overwritten at the next sync; a row added here is kept." (On a host
without the proxy client the note says instead that nothing is read or
overwritten until it can connect apps to Todoist. On another app's Issue
table, which this app never syncs and whose own app may send edits back, no
card is rendered at all: the view shows only the plain notice that it imports
into its own table.) Then the
last sync ("Synced 4 min ago", its added, updated and unchanged counts, "5
tasks from Todoist"), or a failed one with the plain next step (401/403
"Reconnect Todoist."; 5xx "try again in a moment") and when the last
complete read was ("Last good sync 2 days ago", from the App's
`todoist-last-sync`), so a gap is never hidden. The #99 results are counted
groups naming the tasks under "Which": completed in Todoist (closed here),
deleted, no longer reachable (kept open, not closed), could not be checked
(checked again next time); rows added here and incomplete rows (with "Open
row" on a single one) are listed the same way. A partial read is a warning
over an otherwise good sync that names the last complete read. A load that
fails (the host cannot answer which connection the app has) is a visible
error state, never "Loading…" for good. The card is not a live region: the one
`role="status"` line is kept, visually hidden, with the summary sentence
the e2e waits on. `build.mjs` bundles the card through
`cssRawPlugin` from `../../sync-status/build.mjs` (its CSS minified), and the
`issue-tracker` lane lists `integrations/sync-status/**` in its `paths`.

**Rate limits (0.2.0).** Todoist answers 429 with `Retry-After`
(delay-seconds or an IMF-fixdate, "Tue, 06 Oct 2026 12:00:00 GMT"), which
the host relays; any other shape counts as no header, and a wait is clamped
to a day. `read.ts`'s `rateLimited` wraps every GET of a pass: a
`Retry-After` of at most 10 s is waited out and the same request retried, at
most twice per request (so at most 20 s per request); a longer one, one retry
too many, or no usable header (60 s is assumed) throws `TodoistRateLimited`
with the time to try again, before any row is written. A 429 on a by-id check stops the pass the same way
rather than marking the task unconfirmed. The controller then retries the
whole (idempotent) pass by itself at that time when it is within 15 min, at
most 3 times in a row, and the card says "Todoist is rate-limiting; retrying
at 14:05."; otherwise, or after the third, it says "Todoist is rate-limiting;
the sync stopped." with "Try again after 14:05." "Sync now" cancels a waiting
retry and starts the count afresh. Every wait honours `Retry-After`; none is
unbounded. `dispose()` cancels a waiting retry and keeps a sync in flight
from scheduling one; the host has no teardown hook for a view yet, so only
tests call it. The same pattern as the calendar, Notion and Clockify apps, with
no shared code: it lives in this folder. Tested against fake transports only
(`read.test.ts`, `sync.test.ts`); Todoist's real limits and header form are
not verified (#46).

**Tests.** `todoist-app/sync.test.ts` (the pass against an in-memory store
and the fixture: provisioning, import, a refresh that writes no row, every
#99 case, a rate limit waited out or stopping the pass, and the controller's
automatic retry, its cap and its cancellation, with a scripted clock and
timer), `todoist-app/read.test.ts` (`parseRetryAfter` and `rateLimited`
against fake transports), `todoist-app/status.test.ts` (every state on the
card, and the words it then says), `todoist-app/build.test.ts` (the bundle,
its size limit and a typecheck), `todoist-fixture.test.ts` (the fixture
against `todoist.ts`), and the lane's `e2e/todoist.spec.ts`: install from
the catalog, connect, import five tasks as `issue-v1` rows, a reload that
leaves every row's properties byte-for-byte the same, a task completed in
Todoist that turns up `completed` and done, and one made unreachable that
turns up `unavailable` and still open, with the card's words at each step
(no 429 end to end). Run them with:

```sh
browser/node_modules/.bin/vitest run --config integrations/issue-tracker/vitest.config.ts todoist
node integrations/tooling/run-lane.mjs issue-tracker --tier e2e
```

**Not verified:** anything against a live Todoist account or the real
integration proxy (#46).

**Live check kit (not yet run).** `node integrations/tooling/live-check.mjs
todoist --i-understand-this-writes-to <project id>` runs this app's
controller against one disposable Todoist project (the driver seeds and
cleans up; the app stays read-only) and records what `GET /tasks/{id}`
answers for a completed task; see [The live-check
kit](../LIVE_TESTING.md#the-live-check-kit).

## Drive app (`app/`)

An iframe drive app, the same shape as `pets/app/` and `notion/app/`: one
ES module (`app/build.mjs` -> `dist/ui.js`, minified, 178,137 bytes for
0.4.0) whose `view({ root, store })` runs in the host's null-origin frame. It
hosts the Devonian bridge from `devonian/github-issues/` for **one repository
per table**: the app's own table, and each other Issue table it was asked
to sync (since 0.3.0, see [Syncing a table the app didn't
make](#syncing-a-table-the-app-didnt-make)), two-way for issue title, body
(Markdown), Todo/Doing/Blocked/Done status and comments.

**Flow.** The first screen offers GitHub Issues (Jira and Todoist are shown
as not available). "Connect" asks the host for a connection
(`store.proxy.connect`, the host's consent bar, platform `github-issues`).
The app then lists the repositories the connection can see
(`GET /user/repos`, up to 5 pages of 100, through `store.proxy.request`),
with repositories that have issues turned off disabled; if the proxy will
not list them, it asks for `owner/name` instead. Before import it spells out
what the board will do on GitHub. Choosing one creates the columns and binds
the repository to the app for good. Sync runs when the view opens, on "Sync
now" (or `G` `S`), after each edit made in the app, and after a transient
failure (4, 8, … up to 60 minutes, while the view is open).

**The view** follows `design/DESIGN.md` and `design/mockups.html` (#89):
a board (Todo / Doing / Blocked / Done, Done collapsed to the 20 most recently
updated) at 720 px and wider, a list below that, and an explicit
Board/List choice (`B`) that wins at every width; search and a label filter
shared by both; an issue panel (docked at 1000 px and wider, a drawer from
600 px, a full-screen sheet below) with the title, status, read-only labels,
the description (Write / Preview, a safe Markdown preview) and comments;
"New issue" (`N`); the sync pill and connection bar; the shared sync-status
card (below) first in every view of a table; one banner per problem; and
`?` for the keyboard shortcuts. Cards move by drag, by `1`/`2`/`3`/`4` on a
focused card or by their "Move to…" menu. The shared chrome (the `--pl-*`
aliases of the host's `--t-*` theme variables, pill, banner, empty state,
buttons) is in `app/ui/`, separate from the issue views, so it can move to a
shared package later. Layout and filters persist on the app's sync resource.

**The sync-status card (0.4.0, Q-084).** The shared card from
[`integrations/sync-status/`](../sync-status/README.md), mapped in
`app/status.ts` (pure; `app/status.test.ts` covers every `ViewState`) and
rendered first in the board, the list, the "other table" screen and the
no-proxy screen. It says when the last sync ran and how it went ("Synced 4
min ago", "Sync failed 2 min ago" with the reason, the next step and the last
good sync), what it did (rows and Messages added and updated here, the rest
unchanged), how many issues the table has and how many are synced with the
repository, and whether edits go back: **"Edits here are sent to GitHub after
you review them."** in the `ready` state, where that is true, and
**"Read-only: edits here stay in Atomic."** with the reason everywhere nothing
is sent (no host relay, a table that isn't synced or whose sync is paused, no
connection or repository yet). Its write queue counts the changes held for
review plus edits no pass has seen, with "Review and send"; `uncertain` is
only what really may have reached GitHub (a held write let through once
without an answer, a create GitHub never answered). Rows the sync leaves out
are grouped by reason, named under "Which": local-only rows, rows whose
status is outside the four tags, incomplete rows (with "Open row"). A GitHub
rate limit is a problem with its retry time (next paragraph). The card is not
a live region; the header's pill stays the one `role="status"`, and the
connection bar's line now only says what runs ("Checking GitHub for
changes…"), since the last sync and the changes waiting are the card's. The
card's CSS comes through `cssRawPlugin` from `integrations/sync-status/build.mjs`
(the app's own `?raw` plugin before 0.4.0) and is appended to the one
`<style>` element after the kit's and the app's rules. Not shown on the
connect and repository screens, which are setup steps with no table data.

**GitHub rate limits (0.4.0, `app/rateLimit.ts`).** GitHub signals its
primary limit as 403 or 429 with `x-ratelimit-remaining: 0` and
`x-ratelimit-reset`, and its secondary limit as 403 or 429 with `retry-after`
or, without one, a message asking to wait. Neither `x-ratelimit-*` header
reaches the app today: the integration proxy forwards only `content-type`,
`link`, `retry-after`, `etag`, `x-total-count` and `x-next-page`
(`integration-proxy/src/proxy.rs` `upstream_response_headers`), and the
host's frame client relays only `link`, `retry-after`, `etag` and
`content-type` (`view-client.js` `PROXY_HEADERS` at the pin). So a
primary-limit 403 is recognised by the body's `message` alone, a secondary
one by `retry-after` or its message, and a 429 always counts; the
`x-ratelimit-*` reading is there for a proxy and host that forward them. The
wait is `retry-after` (digits, or an RFC 9110 IMF-fixdate; nothing else),
else `x-ratelimit-reset`, else 60 s; never under 1 s, never over 60 min. A wait of
at most 20 s is slept out inside the pass and the same request repeated, at
most twice per request, each wait at least 1 s doubled per attempt, while the
card says "GitHub is rate-limiting; retrying at HH:MM". A longer wait, or
the retries used up, throws a `RateLimitError` with `notSent: true`: the
pass stops, the card shows the problem with the retry time, and `main.ts`
retries at GitHub's time (never sooner than 60 s after the failure, doubled
per consecutive rate-limited failure, up to 60 min; a pass that ends
rate-limited always re-arms the timer at the fresh time, `app/retry.ts`). A
write GitHub refused this way wrote nothing: `proxyTransport` drops its
journal entry instead of leaving it uncertain, and the Bridge drops the saved
operation (`bridge.mjs` `attempt`, on `notSent`), so what is still missing is
planned again next pass from both sides' current state, held for review like
a new write, and never shows as "may already be there" after a reload. An
operation may have been applied in part before the refused request (a create
with status Doing or Blocked is an issue POST and then a label POST; an
update is a fields PATCH and then label calls): a create whose issue POST got
its receipt is first bound to the issue it made, with the create's values as
the baseline (`Bridge.bindCreated`, as "It landed" does), so the next pass
finds the row bound and plans the missing label as a plain status update
instead of importing the issue as a second row; an applied PATCH simply
shows as the remote side agreeing with the edit. In the same view the
controller keeps the review approval for that retry, keyed by the row's
subject, the entity and its exact content (`review.mjs` `approvalKey`; the
provider id is left out, so the rest of a half-made create passes as the
update of the issue it made), so the retry sends exactly the reviewed rows
without a second review and a second row with the same content is held; a
reload, or any other outcome, drops the approval and the remaining change is
reviewed again ("Update #3: status Todo → Doing"), with the issue already on
GitHub without its label until then. An edit made while the limit lasts is
simply held with the rest. Not covered: an update that changed both text and
status and was interrupted after its PATCH reconciles the text as agreed and
holds the status; a multi-write operation interrupted by anything other than
a refusal (a lost answer) resumes as before, flagged to check GitHub.
Unit-tested with fake transports (`app/rateLimit.test.ts`,
`app/controller.test.ts`): 429, a secondary-limit 403, `retry-after` as
seconds and as a date, `x-ratelimit-reset`, the cap, the bounded retries,
and a write that survives a long limit. Never seen from real GitHub, so this
is declared, not verified, and the message match for a header-less 403 is
brittle by nature: a wording change at GitHub makes such a 403 a plain
"Sync failed", retried on the 4-minute ladder.

**Writes GitHub refused (0.4.1, #357, `proxy.mjs` `NOT_APPLIED`).** Before
0.4.1 the transport stored a receipt only for a 2xx answer, so a write
GitHub refused outright (a 422 for a title over 256 characters, say) left its
journal entry without one, and the next pass reported "Uncertain GitHub
write", asking the person to check GitHub for a change that could not be
there. Now a write answered 400, 404, 409, 410 or 422 is a refusal: GitHub
documents each as rejecting the whole request, with no partial effect.
`proxyTransport` drops the journal entry and rejects with `notSent`,
`refused: true`, the `status` and GitHub's `detail` (the body's `message` and
its `errors`, at most 300 characters), so the Bridge drops the saved
operation exactly as for a rate limit (a half-made create is first bound to
the issue it made, `Bridge.bindCreated`), and the next pass holds the change
for review again as a plain pending change, never as uncertain, in the same
view and after a reload. The controller reports it as `refused`: the pill
says "GitHub refused a change", the card's failed line says "GitHub refused a
change and applied nothing (HTTP 422: Validation Failed; title is too long
(maximum is 256 characters))." with "Edit the change here, then Review and
send it again; nothing is resent on its own.", the review approval is not
carried over (resending the same content would only be refused again), and
`retry.ts` arms no timer. Left as before, on purpose: 401 and 403 that are
not rate limits mean the connection or its permissions are the problem (the
pass fails or asks to reconnect, and the saved operation resumes flagged
`unconfirmed`, so a person looks before it is resent); 429 is the rate-limit
path; and a 5xx or a lost answer stays uncertain, since GitHub may have
applied the write before the answer was lost. Widening the set to 401/403 is
a follow-up question, not done here. Tested with the fake store's `refuse`
knob (`app/controller.test.ts`, "writes GitHub refused"), the transport's
tests (`devonian/github-issues/proxy.test.mjs`), the card
(`app/status.test.ts`) and the retry plan (`app/retry.test.ts`); no real
GitHub refusal has been observed through the drive app.

**The last sync, across reloads (0.4.0).** Each completed pass stamps the
sync resource's (or the binding's) `github-last-sync` property (an ISO 8601
date and time, as Todoist's `todoist-last-sync` does), so after a reload the
card still says "Synced 2 days ago" before the first pass, names that as the
last good sync when the first pass fails, and does not claim "0 synced with
…" from the rows it read back without a pass.

**What it writes, and where.** Everything goes into the app's own subtree
(the only place a drive app may write without a row grant). Since 0.2.0 the
rows are of the shared class `issue-v1` (#177 item 6, `ontology-kit/`), at
its published GitHub Pages subject:

- one row per issue in the app's table, of class `issue-v1`: the title in
  Atomic's `name`, the body in task/v1 `body`, the status as one of the
  task/v1 tags `todo`, `doing`, `blocked`, `done` in task/v1 `status`. The
  app reads these by subject through `ontology-kit/resolver.mjs`, never by
  shortname;
- on each row, three provider extras under the app's own ontology: GitHub
  issue number, GitHub source (JSON: url, author, labels, assignees,
  timestamps) and GitHub sync baseline (JSON: the title, body and status the
  app last agreed with GitHub). They are declared as the App's `row-extras`
  (atomic-server #1849), and so is Atomic's `localId` (since 0.3.0), which
  the Bridge sets on each row it imports so that a create a reload
  interrupted is found again instead of made twice. A comment's Message
  carries its own baseline;
- one Message per comment (`about` its row) in a "GitHub comments" folder
  under the app;
- one sync resource holding the bound repository, the time of the last
  completed pass (`github-last-sync`, 0.4.0) and the sync state as JSON
  text: the Bridge's snapshot without the per-record baselines, the
  transport's write journal, rows waiting to be published and the view
  preferences.

**The shared class.** On first open the app adds `issue-v1` to its App's
`renders` (so the host's "+ Add view" offers it on any table of that class),
lists its row extras in `row-extras`, and sets its own table's `classtype`
to `issue-v1`, through the frame store (#177 spike S2; a catalog Install
cannot do this yet, #177 H2). Since 0.3.0 that happens on the first open
itself, before a repository is chosen; 0.2.0 did it only once one was. The
table is then an ordinary `issue-v1` table that other views of the class can
read.

**Baselines on the rows (#177 decision 7).** The Bridge still keeps a
baseline per record in memory. At each checkpoint, a baseline that differs
from what its row holds is written onto the row, and the sync state is saved
without it. A row the Bridge itself writes (an import, or bringing in a
GitHub change) carries its baseline in that same write, so the first import
needs no extra writes; a change sent to GitHub costs one extra row write.
Reading a row puts its baseline back into the record. Not moved: the
Bridge's identity map and its copy of each record's values (the snapshot's
`graph`) stay in the sync state, so the state still grows with the issues'
text. If a row's baseline is missing or unreadable, the next pass treats
both sides as unknown; when they agree it writes the baseline back.
Not guarded: a write the Bridge makes to a row whose verify read then shows
a concurrent edit leaves the row's baseline at the written value, so that
edit is sent as a change instead of reported as a conflict.

**Local-only rows (#177 Q6, this plugin's choice).** A row with no GitHub
issue behind it is local only: the pass leaves it alone and the card is
marked "Local". "Publish to GitHub" in its issue panel asks for it to be
created; the next pass holds that create for review like any other write.
A card made with this app's own "New issue" form is published at once,
still only after review; a row added anywhere else (the table, another
view, another device) waits for "Publish to GitHub". Safer than 0.1.x,
which proposed a create for every row without a number.

**A status outside the four.** A row whose status is not exactly one of the
four task/v1 tags (another tag, or several) is shown as it is ("Status
here: …, not synced with GitHub") instead of failing the pass. For the sync
it keeps the status it last agreed with GitHub, so nothing is sent for it;
if GitHub's status changes, GitHub's value replaces it.

**An incomplete row (0.3.1).** `issue-v1` requires Name. A row without one
(or with a blank one) is read through the resolver's `missing` and shown as
"(no title)" with the tag "Incomplete: missing Name" on its card and list
row, with the same note in its panel and an "Open row" button
(`store.openResource`) to fill the column in the table; typing a title in the
panel completes it too. This is ontology-kit's rule for every shared-class
view: an incomplete row is shown, not skipped. Nothing of it is sent: a row
bound to a GitHub issue shows the Bridge what both sides last agreed on (so
no local change exists, and GitHub's own changes still come in and fill the
Name), a row not bound stays out of the Bridge, "Publish to GitHub" is
disabled for it, and a publish asked for earlier waits until it is complete.
The review panel lists such rows under "Not synced until complete". Before
0.3.1 a bound nameless row failed the whole pass ("Invalid Atomic issue").
Unit (`app/sync.test.ts`, `app/views.test.ts`) and the hand-made table e2e
(a row with an empty Name). At the pin the server refuses a commit that lacks a required property of the row's class (`lib/src/resources.rs` `check_required_props`, presence only), so on this host a required field can be absent only as an empty string (`name` is a string; the resolver counts `''` as missing), through a lens, or on a host that did not check; a required date or timestamp cannot be empty there.

**From 0.1.x.** An update from 0.1.x over an existing install (the host's
Update on the Integrations page keeps rows and schema) rewrites the table's
rows in place once, before the first pass: the app's own Status tags become
the task/v1 tags with the same shortname, `description` becomes task/v1
`body`, `isA` becomes `issue-v1`. The sync state is kept, and the
baselines it held move onto the rows at the first pass, so an edit made under
0.1.x and not sent yet is still found and offered for review (unit-tested
with the fake host only). The old Status property and class stay in the
app's ontology, unused. #177 Q10 says test installs are reinstalled and
re-synced; this pass exists so that unsent edits are not lost.

**First import (#206).** An issue or comment that is on GitHub, never
synced and not in the table is created from the list page GitHub returned
(`GET …/issues?state=all&per_page=100`, `GET …/issues/{n}/comments`): no
per-item GET, and no pending operation is checkpointed first. Pull requests
come back in the issue list and are skipped there, so neither they nor their
comments are fetched. The sync state holds every imported issue's text
(about 1.26 MB for 65 issues of about 4 KB and 106 comments), so it is
written every 25 imported records or 10 s, not before each one. Rows show on
the board as they are imported ("Importing… 40 issues so far"). After a
reload the import resumes: rows imported after the last state write bind
back by their issue number column, and comment Messages by the comment id
in their GitHub source, even when the host reads back an older sync state.
In `app/import.test.ts` (fake host, 65 issues + 141 pull requests + 106
comments), the import went from 581 proxy calls, 343 state writes and
280,004,627 bytes of state written to 68 proxy calls, 7 state writes and
6,186,807 bytes; the 187 table writes (one per imported row or Message,
plus set-up) are unchanged. How long one `/app-write` takes on the droplet
is not measured here. Later passes that bring in GitHub changes to issues
already in the table still read each changed item back and checkpoint
before writing it; for a few changed items that is fine, for hundreds it is
slow.

**Review before provider writes.** A pass never sends a create or update to
GitHub on its own. An edit in the app (a moved card, a title, a
description, a comment, a new issue) is written into the table at once and
its card shows "Waiting to send"; "Review and send" in the connection bar
lists what would go out. Every change the Bridge would send is held
(`devonian/github-issues/review.mjs`) and listed ("Update #1: status Todo →
Done (close it)"); "Send N changes to GitHub" approves exactly that content
for one pass. A change edited after review is held again. Imports into the
table are not gated, as for pets and notion. This is the app-level boundary
only: named actions, MCP exposure and the host-side approval journal of
[ACTIONS.md](../ACTIONS.md) remain #11's design, and this app does not
replace them.

**Recovery.**

- Same field changed on both sides since the last sync: sync pauses, the
  card is marked, and "Review conflict" shows each field's two values
  (`Bridge.describeConflict`). A side is chosen per field; "Apply and resume
  sync" settles only those fields (`Bridge.resolveConflict` with a
  `{ field: side }` choice) and syncs again. Keeping this table's side
  becomes a held write, reviewed like any other. The Bridge stops at the
  first conflicting record, so several conflicts are reviewed one at a time.
- GitHub answers 401, or the host no longer has the connection: "Reconnect
  GitHub". The refused connection is not offered again after the reload.
- A write whose response was lost: the next pass reads GitHub back first. If
  an update landed, the operation just completes. If not, it is offered for
  review again, marked as unconfirmed, with "Send again".
- A create (issue or comment) whose response was lost (design state 12,
  #156) is never resent on its own: the transport's journal refuses
  ("Uncertain GitHub write"). The next pass looks for GitHub records that
  are not on the board and carry exactly what the create sent (title and
  description; a comment's text). Those are not imported as new rows while
  the question is open, and the row is marked "Sent, but GitHub did not
  answer". The banner offers "It landed as #N" for each match (up to 3) and
  a link to check it. Choosing one binds the row to that issue (its number
  is written into the row) and sends nothing; the baseline is what the
  create sent, as GitHub creates it (Todo), so a status set here, or an
  edit made since on either side, comes up as a normal change. With no
  match, the banner offers "Send again": the app lists GitHub once more,
  refuses if a match has appeared, and otherwise drops the journal entry so
  the create is held for review like a new one. The choice is always a
  person's: an exact match is not bound automatically, because someone may
  have made the same issue by hand. An issue already bound to another row
  is refused. Not covered: a create that landed and was then edited on
  GitHub before the next pass is not offered (no exact match), and there is
  no field to type another issue number, so "Send again" would create a
  second issue; check GitHub before choosing it.
- An issue GitHub no longer has (state 13): "Keep here only" forgets its
  GitHub identity and clears the row's issue number, so it stays as a local
  row; "Remove from board" forgets it on both sides and deletes its row and
  comment Messages here (`app/sync.ts`, `AtomicIdentityMap.unbind` from
  devonian 0.8.0). Neither sends anything to GitHub.
- Atomic Server refusing a write: a banner with "Try again".
- GitHub rate-limiting: the card says "GitHub is rate-limiting; retrying at
  HH:MM", the pill "GitHub rate limit"; the pass is retried then, approved
  changes included (see "GitHub rate limits" above).
- GitHub refusing a write (400, 404, 409, 410, 422; 0.4.1): the pill says
  "GitHub refused a change", the card's failed line gives GitHub's words and
  "Edit the change here, then Review and send it again"; the change is held
  for review again, nothing is retried on a timer (see "Writes GitHub
  refused" above).
- Anything else (network, 5xx) shows on the pill, with "Retry now", and in
  the card's "Sync failed" line with the retry time, and is retried on a
  timer while the view is open. While sync is paused or failed the board
  still shows the table's rows.

**Host behaviour it relies on or works around** (atomic-server `bae5cdbe3`,
not re-read at the current pin `a12b74a`; read in `hostStore.ts`, `proxyConnections.ts`, `collection.ts`;
`app/frameStore.ts` has the detail):

- No credential reaches the app's code: the bridge's `proxyTransport` runs
  with a `dispatch` over `store.proxy.request` (since #54 phase 2 the host's
  frame client calls the proxy with a capability and its own key), and its
  write journal still guards uncertain writes. Host refusals that happen
  before anything is sent (no capability, no Ed25519 in this browser) are
  recognised by message, and the proxy's own refusals by their `error`
  code; neither is uncertain.
- A resolved `save`/`newResource` is an acknowledged `/app-write` commit.
- The frame's reads come from the host page's cache, which did **not** show
  the app's own save within 5 s in the e2e. The adapter corrects its reads
  for its own saves (per view) instead of waiting.
- `query` is answered from the page's local index first and can miss fresh
  resources; subjects the app has seen are remembered in its sync state.
- No IndexedDB, localStorage or Web Locks in the frame, so
  `background.mjs` is not used and nothing runs while the app is closed.

**Live check kit (not yet run).** `node integrations/tooling/live-check.mjs
issue-tracker --i-understand-this-writes-to <owner/name>` runs the GitHub
issues drive app's controller against one disposable repository and writes
evidence; see [The live-check kit](../LIVE_TESTING.md#the-live-check-kit).

**Not verified, or not supported:**

- Only against the mock proxy's seeded repository (`atomic-fixture/tracker`:
  two issues, one comment); once, by hand, against its synthetic
  `user-testing` scenario (see [Mock data for user
  testing](#mock-data-for-user-testing)); and, in `app/import.test.ts`, a
  synthetic 206-item repository against the in-memory fake host only.
  Nothing has run against live GitHub, the real
  integration proxy, or a repository beyond a handful of issues. The
  Collection pages at 500; larger repositories are not tested.
- Two tabs or devices syncing the same app at once are not guarded: the sync
  state syncs with the drive and `/app-write` has no compare-and-swap. One
  syncing view per app is assumed. (The design's alternative, a per-browser
  host storage op, needs atomic-server work.)
- The sync state grows with the write journal; it is not pruned.
- Comments made in the data-browser's own comment panel on a row are not
  synced: they live outside the app's subtree, which the app cannot write.
- The repository picker's `GET /user/repos` is not in the proxy's GitHub
  Issues document (localthought/openapi-directory `github-issues/1.1.4`
  lists `/repos/{owner}/{repo}/issues…` only), so against the real proxy
  the app most likely falls back to typing `owner/name`. The mock fixture
  answers it. Changing the bound repository means a new app.
- Labels (names and colours, without `atomic:doing`), assignees and
  GitHub's comment count are read into the row's GitHub source metadata
  and shown read-only; they are never sent back. Milestones and pull
  requests are not synced; deletion on either side is never propagated.
- Editing an existing comment has no control in the view yet (the Bridge
  syncs such edits made in the table).
- Host calls from atomic-server pin 007869464 are used when present and
  feature-detected otherwise: links ("Open on GitHub", "Check on GitHub",
  links in descriptions) go through `store.openExternal`, which shows the
  destination first (older hosts: `window.open`, which the sandbox may
  refuse); light/dark comes from `store.getTheme()`/`onThemeChange()`;
  `--pl-pos` is the host's `--t-color-success`; "Disconnect GitHub" in the
  connection menu calls `store.proxy.disconnect` (only this app's
  delegation goes; the table stays); and rows a query lists are read with
  `store.getMany` in batches of 100.
- Search, keyboard and drag were checked in jsdom and the e2e; drag and drop
  was not exercised in an automated test.
- **Install.** From the catalog: entry `issue-tracker` (experimental; published but disabled pending launch: the catalog entry carries the module and its integrity with `enabled: false`, so the Integrations page does not offer it yet; the lanes' dev-server serves it enabled (`DEV_SERVER_ENABLE_APPS`), which is how the e2e installs it). Once enabled it is listed under
  the Integrations page's **Drive apps**, which downloads
  `apps/issue-tracker/<version>/ui.js` from GitHub Pages and checks it
  against the entry's integrity hash (see
  [Publishing a drive app](../README.md#publishing-a-drive-app)). The e2e
  installs it that way, from the committed module the lane's dev-server
  serves. A new release needs a version bump in `app/package.json` and the
  catalog, then `node integrations/tooling/apps.mjs write issue-tracker`.

`app/package.json` pins `devonian@0.9.0` from npm (install it with
`pnpm install --frozen-lockfile` in `app/`), bundled as `devonian/atomic` plus
`reconcileRecord`. 0.9.0 only added `devonian/lenses`, which the app does not
import, so the bundle is byte-identical to the 0.8.0 one and the app version
is unchanged; `@tomic/lib` is shimmed as in notion. It lives in `app/`
rather than here because `certify.mjs` treats a `package.json` in a plugin
folder as a sandbox package. `syncables` is not used: the Bridge's GitHub
port already pages GitHub, and bundling the GitHub OpenAPI document for
syncables would only add size.

### Syncing a table the app didn't make

Since 0.3.0 (#177 §6.2 item 14), on the pattern calendar 0.3.0 set for
Google Calendar (#272). Opened as a view on an Issue table it did not make,
the app shows that the table isn't synced and offers **Sync this table to
GitHub**. Nothing is written before that is pressed. Pressing it:

1. makes sure the App declares its row extras (number, source, baseline and
   `localId`), then compares `store.rowAccess()`'s `extras` with them. When
   there is no grant, or it doesn't cover them (for example "Allow editing"
   chosen in Add view before the app ever declared its extras), it calls
   `store.requestRowAccess()`, and the host shows its own "Allow editing" /
   "Not now" bar. "Not now" leaves the table unsynced and says why;
2. makes a **binding** under the App: a resource of the app's sync class
   with `synced-table` (a new app Property, an `atomicURL`, the table's
   subject) and `localId` `github-issues:sync <table>`, so AtomicServer keeps
   one per table. The app finds it with `store.query` on `synced-table` and
   accepts only one whose parent is the App;
3. goes on as on the app's own table: connect (if needed), choose the
   repository, import. The repository, the sync state and a "GitHub
   comments" folder for that table's comments are kept on and under the
   binding. "Not now" on those two screens removes a binding that has no
   repository yet.

From then on it is the same sync as on the app's own table: compare on
open and on "Sync now", every change bound for GitHub held for review, the
same conflict rules, the baselines and issue numbers on the rows. Rows that
were in the table before stay local until "Publish to GitHub" on each
(#177 Q6). What differs from the app's own table:

- the table itself is never written: no rename after the repository, no
  `classtype` change. A row grant never covers the table;
- rows are never deleted: a grant doesn't cover `destroy`, so for an issue
  gone from GitHub only "Keep here only" is offered, and the banner says to
  delete the row in the table;
- the grant is checked on every open, before every pass and before every
  edit made in the app. Once it lapses (the view removed, the person who
  gave it loses write access, the app's key changes, or someone revokes it
  in the tab's menu), the app says syncing is paused and offers "Allow
  editing again"; it sends nothing to GitHub and writes nothing meanwhile.
  A row write the host refuses mid-pass for that reason shows the same
  pause;
- the binding keeps its repository for good, like the app's own sync
  resource: the table can't switch repositories.

Not verified: what an uninstall does with a binding; two tabs syncing the
same table (not guarded, as on the app's own table). Edits made in the
table while the app is closed are found only on its next open (#177 H6).

## Mock data for user testing

The mock proxy's github-issues fixture has a second, opt-in scenario for
trying the app by hand: start `integrations/localthought/mock-proxy.mjs`
with `MOCK_SCENARIO=user-testing`. Its data, in
`fixtures/github-issues/user-testing.mjs`, is synthetic: an invented studio's
repositories, none of it recorded from GitHub.

- `GET /user/repos` lists `acme-studio/website` (16 issues: 9 Todo, 3 Doing,
  4 Done; 7 comments by four invented people), `acme-studio/brand-guide`
  (2 issues) and `acme-studio/old-site` (issues turned off). The
  `atomic-fixture/*` repositories are not listed in this scenario.
- Labels are GitHub's `{ name, color }` objects (bug, enhancement, design,
  docs, maintenance, good first issue, planning); `atomic:doing` stays a
  plain name, as the fixture's label routes add it. Issues carry authors,
  assignees and dates spread over the past 50 days. It includes one title of
  about 160 characters, Markdown bodies with a task list, code blocks and
  links, and one issue with no body (`null`).
- The default scenario, which the e2e asserts, is unchanged.

Drivers for changes on the GitHub side mid-session, as
`POST /fixture/github-issues/<driver>` with a JSON array of arguments:
`updateIssue` (rename, close, relabel), `createIssue`, `createComment`,
`commentAs` (`[repo, number, login, body]`, a comment by someone else) and
`failNext` (`[status, count]`: the next `count` proxied requests answer 503,
429/403 as a rate limit, 422 as a validation refusal with GitHub's `errors`,
or 401). `reset` (`[repo]`) forgets one repository's
edits, so the next request reseeds it, and drops any pending `failNext`
failures; a spec calls it first, so a Playwright retry starts from the same
state as the first attempt.

For live GitHub, `fixtures/github-issues/seed-live-repo.mjs --repo
<owner>/<name> [--yes]` puts the same `acme-studio/website` issues, labels
(with `atomic:doing`) and comments into an empty, disposable repository. It
runs `gh api` as whichever account the GitHub CLI is signed in as, which
should be a dedicated test account. Everything is then authored by that
account, and nothing is assigned. Without `--yes` it only prints what it
would do. It was checked only for its refusals (bad arguments, a repository
that already has issues); no repository has been seeded with it yet.

Checked once, on 2026-09-25, against atomic-server `bc39dac4b` served by a
Vite dev build: connect, the picker and importing `acme-studio/website` all
worked. The import took about 33 s. `scenario.test.ts` covers the scenario
and the drivers.

## Verification

```sh
./browser/node_modules/.bin/vitest run --config integrations/issue-tracker/vitest.config.ts
./browser/node_modules/.bin/tsc -p integrations/issue-tracker/tsconfig.json
./browser/node_modules/.bin/tsc -p integrations/issue-tracker/app/tsconfig.json
node integrations/tooling/run-lane.mjs issue-tracker --tier e2e
```

The drive app's unit tests run against an in-memory host
(`app/fakeStore.ts`) and the same GitHub fixture the mock proxy serves,
including a host whose reads never show the app's own saves:
`app/sync.test.ts` and `app/controller.test.ts` the sync and the
controller (edits, comments, creates, conflict review, repository list,
view preferences), `app/model.test.ts` the derived view data (columns,
filters, pill, banners, markers, breakpoints), and, in jsdom,
`app/ui/kit.test.ts` the shared chrome and theme tokens and
`app/views.test.ts` the rendered view (keyboard and menu moves, the live
region, the detail panel, comments, New issue, focus return, empty states,
persistence, alerts, the conflict review). `app/build.test.ts` checks the
bundle and typechecks `app/`. The e2e (`e2e/issue-tracker.spec.ts`) covers
connect, picking the repository, import, reload with an unchanged refresh,
a reviewed update (closing #1), a title conflict settled for GitHub's side
in the review panel, a card moved with the `4` key and a comment, each
sent after review; then (0.2.0) that the table and its rows are `issue-v1`
and the App renders it, a row added in the table outside the app staying
local until "Publish to GitHub", its reviewed create, and moving it to
Blocked, which adds `atomic:blocked` on GitHub; then Disconnect GitHub and
connecting again through the host's "Use existing connection" with no
reload, after which the app syncs by itself (the unit tests also cover the
repository-picker case). A second e2e test (0.3.0) makes an `issue-v1`
table by hand with one row, adds GitHub issues to it as a Read-only view,
presses "Sync this table to GitHub", allows editing in the host's bar,
connects, imports a repository of its own (seeded through the mock's
`createIssue` driver), checks the rows, the untouched table and the binding
under the App, and sends a status edit made in the table after review. The
e2e reads `issue-v1` from its published GitHub
Pages subject, so it needs network access to `ontola.github.io`; its
`beforeAll` checks Pages serves the class first
(`node ontology-kit/served.mjs classes/issue-v1`). The 0.1.x in-place
rewrite and a status shown as it is are unit-tested only
(`app/controller.test.ts`), and so are, for another table
(`app/syncTable.test.ts`, against a fake host that enforces the pinned
row-grant scope): "Not now" in the host's bar, a grant from before the
extras were declared, Publish to GitHub, reopening, a revoked grant and
"Allow editing again", "Not now" before a repository, and no row deletion.

These check `adapter.ts`'s pagination, PR exclusion and mapping, the generic
event-to-JavaScript starter (`automation.test.ts`), the Todoist projection, and
every test under `devonian/github-issues/`. The latter import the npm
`devonian` that `app/package.json` pins, installed in `app/node_modules`
(`cd integrations/issue-tracker/app && pnpm install --frozen-lockfile`;
`run-lane.mjs` does it when it is missing).

API reference: https://docs.github.com/en/rest/issues/issues
Label operations: https://docs.github.com/en/rest/issues/labels
