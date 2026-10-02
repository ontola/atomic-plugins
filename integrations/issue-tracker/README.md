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
  `todoist.test.ts` and the recorded-fixture check `todoist-fixture.test.ts`.

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
not a false "completed". The cases above are covered by synthetic fixture
tests in `todoist.test.ts`. **No host calls `reconcileTodoistTasks` yet.**
Nothing in atomic-server at the pin (`bae5cdbe3`) imports `todoist.ts` at
all, neither the projection nor this check (searched `browser/` and
`server/src`), so the `devonian-todoist` catalog entry describes a flow no
host runs today. The host journey that runs the check, and exercises these
states end to end, is still to be built.

## Drive app (`app/`)

An iframe drive app, the same shape as `pets/app/` and `notion/app/`: one
ES module (`app/build.mjs` -> `dist/ui.js`, minified, 154,931 bytes for
0.2.0) whose `view({ root, store })` runs in the host's null-origin frame. It
hosts the Devonian bridge from `devonian/github-issues/` for **one repository
per app install**, two-way for issue title, body (Markdown),
Todo/Doing/Blocked/Done status and comments.

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
"New issue" (`N`); the sync pill and connection bar; one banner per problem;
and `?` for the keyboard shortcuts. Cards move by drag, by `1`/`2`/`3`/`4` on a
focused card or by their "Move to…" menu. The shared chrome (the `--pl-*`
aliases of the host's `--t-*` theme variables, pill, banner, empty state,
buttons) is in `app/ui/`, separate from the issue views, so it can move to a
shared package later. Layout and filters persist on the app's sync resource.

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
  (atomic-server #1849). A comment's Message carries its own baseline;
- one Message per comment (`about` its row) in a "GitHub comments" folder
  under the app;
- one sync resource holding the bound repository and the sync state as JSON
  text: the Bridge's snapshot without the per-record baselines, the
  transport's write journal, rows waiting to be published and the view
  preferences.

**The shared class.** On first open the app adds `issue-v1` to its App's
`renders` (so the host's "+ Add view" offers it on any table of that class)
and sets its own table's `classtype` to `issue-v1`, through the frame store
(#177 spike S2; a catalog Install cannot do this yet, #177 H2). The table is
then an ordinary `issue-v1` table that other views of the class can read.
Opened as a view on an Issue table it did not make, the app shows a notice
and writes nothing: syncing an existing table ("Sync this table to GitHub",
#177 item 14) is not built.

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
plus set-up) are unchanged. How long one `/app-write` takes on the
user-testing server is not measured here. Later passes that bring in GitHub changes to issues
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
- Anything else (network, 5xx, rate limit) shows on the pill only, with
  "Retry now", and is retried on a timer while the view is open. While sync
  is paused or failed the board still shows the table's rows.

**Host behaviour it relies on or works around** (atomic-server `bae5cdbe3`,
read in `hostStore.ts`, `proxyConnections.ts`, `collection.ts`;
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

`app/package.json` pins `devonian@0.8.0` from npm (install it with
`pnpm install --frozen-lockfile` in `app/`), bundled as `devonian/atomic` plus
`reconcileRecord`; `@tomic/lib` is shimmed as in notion. It lives in `app/`
rather than here because `certify.mjs` treats a `package.json` in a plugin
folder as a sandbox package. `syncables` is not used: the Bridge's GitHub
port already pages GitHub, and bundling the GitHub OpenAPI document for
syncables would only add size.

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
429/403 as a rate limit, or 401).

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
repository-picker case). The e2e reads `issue-v1` from its published GitHub
Pages subject, so it needs network access to `ontola.github.io`; its
`beforeAll` checks Pages serves the class first
(`node ontology-kit/served.mjs classes/issue-v1`). The 0.1.x in-place
rewrite, a status shown as it is and the "other table" notice are unit-tested
only (`app/controller.test.ts`).

These check `adapter.ts`'s pagination, PR exclusion and mapping, the generic
event-to-JavaScript starter (`automation.test.ts`), the Todoist projection, and
every test under `devonian/github-issues/`. The latter import the `devonian`
package from source, so install its dependencies first
(`cd devonian && pnpm install --frozen-lockfile`).

API reference: https://docs.github.com/en/rest/issues/issues
Label operations: https://docs.github.com/en/rest/issues/labels
