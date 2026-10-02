# Google Calendar ↔ Atomic calendar

Imports one Google calendar's single (non-recurring) events into an Atomic
table, as rows of the shared `event-v1` class (#177), and sends edits of five
fields back to Google after you review them.

## Supported path: the Calendar drive app

There is one supported way to run this plugin: the **drive app** in
[`app/`](app/). It runs in the host's null-origin plugin frame and reaches
Google only through the host's integration-proxy relay (`store.proxy`,
atomic-server#1657), for platform `google-calendar`. The frame names a
connection id, never a credential. The same shape as the Pets and Notion
drive apps.

1. **Install.** From the catalog: entry `calendar` (experimental; published but disabled pending launch: the catalog entry carries the module and its integrity with `enabled: false`, so the Integrations page does not offer it yet; the lanes' dev-server serves it enabled (`DEV_SERVER_ENABLE_APPS`), which is how the e2e installs it). Once enabled it is listed under the
   Integrations page's **Drive apps**. The host downloads
   `apps/calendar/<version>/ui.js` (`app/build.mjs`'s bundle, minified,
   129,735 bytes for 0.3.1) from GitHub Pages and refuses it unless it
   matches the entry's integrity hash (see
   [Publishing a drive app](../README.md#publishing-a-drive-app)). The e2e
   installs it that way, from the committed module the lane's dev-server
   serves. A release bumps `app/package.json` and the catalog's `version`,
   then runs `node integrations/tooling/apps.mjs write calendar`.
2. **Connect.** "Connect Google Calendar" asks the host to show its consent
   bar. On Connect, the page goes to the integration-proxy and comes back
   with a connection the page holds.
3. **Choose a calendar.** The app lists `users/me/calendarList` and imports
   the one you choose (the primary one is preselected). The choice, and the
   calendar's name, colour, access role and the account's address, are
   stored on the app's table. A table never switches calendars; use a second
   app for a second calendar. Read-only calendars are tagged, and their
   events never offer Edit.
4. **Sync now.** A full, paged scan of the calendar's events (see _Scope_),
   on open and on "Sync now". New events become rows; Google-side edits
   update rows that were not edited here. Reads never write to Google.
5. **Look and edit.** Agenda (the default below 720px) and Week (3, 5 or 7
   days by width, with a sidebar from 900px). An event opens in a drawer;
   Edit changes exactly the five mapped fields and saves to the row only
   ("Saved here · not sent to Google yet"). "Open in Google Calendar" asks
   the host to open the event's Google page. Rows edited outside the app
   (the host's table, its Calendar view, another device) show up the same
   way when the app next opens or syncs; see
   [Edits made outside the app](#edits-made-outside-the-app-compare-on-open).
6. **Review and send.** "Review N changes" lists each changed field
   (before → after), with Discard per event. Nothing is sent until you press
   "Send N changes"; each row then reports Sent, Changed in Google (a `412`,
   with Review again), or Unknown whether Google applied it.
7. **Conflicts.** A field changed both here and in Google is left as is
   until you pick "Keep mine" or "Use Google's" per field; a kept value goes
   to the review list, never straight to Google. An event gone from Google
   can be kept as a local event or, after an in-page confirmation, removed
   here. Nothing is ever deleted in Google.

The UI follows [`design/`](design/) (#89); see _Design decisions_ below for
where it differs from the mockups.

### What backs the catalog entry, and what does not

`catalog.json`'s `calendar` entry describes this drive app and installs it
(it was called `devonian-google-calendar`, with `requires-api-plugins`,
before the drive app was published). Its `capabilities` text names the
app's declared scope, which is written down once, in
[`app/operations.ts`](app/operations.ts): the three provider operations
(see [Proxy catalog](#proxy-catalog)), the Google OAuth scopes they need,
and the host `store` members the app calls. `app/relay.ts` refuses, before
anything reaches `store.proxy.request`, a request that matches none of
them. The entry point is the bundle's one export, `view()`
(`app/build.test.ts`). Two other things live in this folder, and neither is
a way to run the plugin:

- `adapter.ts` is the Google mapping (paging, skip rules, three-way
  reconciliation, minimal ETag-conditioned patches) that the drive app uses
  through `app/relay.ts`. Up to 0.1.3 it also carried a sandbox-plugin
  `manifest()`: a `secret:google-calendar` credential placeholder, a
  `create_event` action and a single-event read, none of which the app
  performs, and no `plugin.js` ever ran it. 0.1.4 removed it. The sandbox
  runtime (shape 2 in AGENTS.md) is not a supported path for this plugin,
  and the bundle now names no credential at all (`app/build.test.ts`).
- [`devonian/google-calendar/`](devonian/google-calendar/) is the Devonian
  lens of the retired LocalThought setup-dialog flow: an unhosted library
  (shape 3), kept and unit-tested in this lane, with no host at the pin and
  no catalog entry. Nothing installs it, and evidence gathered against that
  flow does not certify the drive app.

## Shared class: `event-v1` (#177)

From 0.2.0 the app's rows are the shared Event class,
`https://ontola.github.io/atomic-plugins/ontology/classes/event-v1`, which
`ontology-kit/` defines and GitHub Pages publishes (see
[`ontology-kit/README.md`](../../ontology-kit/README.md)). Its subjects are
inlined into the bundle from `ontology-kit/terms.mjs`; the views read the
shared fields by subject only, through `ontology-kit`'s strict resolver
(`app/fields.ts`), never by shortname, name or column.

- **First open** (`app/adopt.ts`; #177 §5, §6.2 items 3 and 12, spike S2).
  A catalog install at the pin makes the App with a class of its own
  ("Event"), so on its first open the app, inside its own subtree:
  1. moves its own table's rows onto `event-v1` in place: `isA` becomes
     `event-v1`, and each value written by 0.1.x under the app's own
     Properties (`location`, `start`, `end`, `atomic-calendar-day`, `-all-day`,
     `-end-day`, `-notes`) is copied to the shared property (unless the row
     already has one) and removed. The provider extras keep their subjects,
     so an edit not sent to Google yet is still found against its baseline
     after the update (#177 Q10: migrate where unsent edits could be lost);
  2. then sets its own table's `classtype` to `event-v1`, only once every row
     is done (a row the pass did not reach is done on the next open);
  3. adds `event-v1` to the App's `renders`, so the host's "+ Add view"
     offers the app on any `event-v1` table;
  4. declares its four row extras (`google-event-id`, `google-etag`,
     `google-link`, `sync-baseline`) as the App's `row-extras`
     (atomic-server #1849, in the pin): what an "Allow editing" grant on
     another table would also cover.

  Every step is skipped once done. The old class and Properties stay in
  the app's ontology, unused. The same update reaches an install made
  before 0.2.0 through the Integrations page's "Update to 0.2.0"; a new
  install starts on `event-v1`. Declared by `app/adopt.test.ts`; the e2e
  checks a fresh install only.

- **On a table that isn't its own.** Added through "+ Add view" to another
  `event-v1` table (one made with New table and the class URL pasted, #177
  S3), the app draws that table's events from their shared fields, read
  only, says "Not synced with Google Calendar", and makes no proxy request
  and no write to the table or its rows. From 0.3.0 it offers "Sync this
  table to Google Calendar"; see
  [Syncing a table the app didn't make](#syncing-a-table-the-app-didnt-make).
- **Incomplete rows** (0.3.1; ontology-kit's rule for every shared-class
  view: a row missing a required field is shown as incomplete, not skipped).
  `event-v1` requires Name and Day. A row without one is read through the
  resolver's `missing`, kept in the views, and listed in an "Incomplete rows"
  section above the Agenda and Week with "Incomplete: missing Day" (or Name,
  or both) and an "Open row" button (`store.openResource`) to fix it in the
  table; the drawer says the same. A row without a Day is drawn on no day,
  as the host's Calendar view draws it nowhere (the section is where it
  appears); one without a Name is drawn as "(untitled)" with the tag. A
  synced row that is incomplete is held back whole, like an invalid edit:
  nothing of it is sent, Google's edits to it are not applied, it is never
  "Not sent yet", and the review sheet lists it under "Not sent" with the
  reason. Unit (`app/view.test.ts`, `app/sync.test.ts`) and the hand-made
  table e2e below, which holds a row with an empty Name and checks the host
  refuses one without a Day. At the pin the server refuses a commit that lacks a required property of the row's class (`lib/src/resources.rs` `check_required_props`, presence only), so on this host a required field can be absent only as an empty string (`name` is a string; the resolver counts `''` as missing), through a lens, or on a host that did not check; a required date or timestamp cannot be empty there.
- **Gate.** The catalog entry stays `enabled: false` while the ontology base
  is on github.io (`ontology.mjs check`; card copy "Waits for the stable
  ontology domain."). Test-side installs (the e2e, the user-testing
  catalog) are not gated.
- **Pages.** The pinned server fetches an external term once, on first use,
  and keeps it; the browser reads it through its local-database worker after
  its signed request fails Pages' CORS preflight (one console error per term
  per session; #177 S1). A browser that has never seen the class, while
  Pages is down, shows the table with no columns (#177 H1, not fixed at the
  pin).

## Syncing a table the app didn't make

From 0.3.0 (#177 §6.2 item 14; the pattern for other plugins is in
[`../README.md`](../README.md#syncing-a-table-the-app-didnt-make)). On an
`event-v1` table that isn't the app's own, the "Not synced" banner offers
**Sync this table** ("Sync this table to Google Calendar"). Pressing it:

1. **Allow editing.** The app compares `store.rowAccess()` with the four
   row extras it declares (`google-event-id`, `google-etag`, `google-link`,
   `sync-baseline`, see [Shared class](#shared-class-event-v1-177)). When
   there is no grant, or one that doesn't cover them (for example "Allow
   editing" chosen in Add view before the app had ever opened), it calls
   `store.requestRowAccess()`: the host's own bar asks "Allow editing" or
   "Not now", and says the app keeps data of its own on rows. "Not now"
   leaves the table not synced, with the reason in the banner.
2. **A binding under the App.** The pinned host's row grant never writes
   the table itself (`app_row_grant.rs`), so the calendar choice can't be
   kept on it as it is on the app's own table. The app makes a resource
   under the App with `synced-table` (a Property of its own ontology,
   datatype `atomicURL`, the table's subject) and, once chosen,
   `google-calendar-id` and `google-calendar-meta`. It finds it with
   `store.query` on `synced-table` and accepts only a result whose parent is
   the App. One binding per table; a table never switches calendars.
3. **Connect and choose**, as on the app's own table, with copy naming the
   table ("Which calendar should Team events sync with?") and a "Not now"
   that removes a binding that has no calendar yet.
4. **The same sync.** Google's events become new rows of that table, with
   the extras on each row; compare on open, review before send, `If-Match`,
   and the conflict rules are those of the app's own table.

What differs from the app's own table:

- The table keeps its name; the app never writes it.
- Rows that were in the table before stay local only, untouched, and are
  counted as "made here" (#177 Q6, as on the app's own table). The first
  import does not match them against Google's events.
- **No deletes.** A grant never lets an app delete a row. For an event gone
  from Google, the conflict sheet offers "Keep as local event" (which takes
  the extras off the row, allowed) and says to delete the row in the table;
  "Remove local copy" is not offered.
- **A grant taken back** (the tab's menu, the view removed, the person who
  gave it losing write access): the app checks the grant on every open and
  before every sync, and then shows "Syncing with Google Calendar is
  paused" with Sync this table, which asks again and goes on with the same
  calendar. No request reaches the proxy while paused.
- Nothing runs while the app is closed, as everywhere (#177 H6, H11).

Not settled (questions for Michiel, see the PR): whether there should be a
"Stop syncing" that removes the binding (and what it does to the rows'
extras), whether rows already in the table should be offered for "Publish
to Google Calendar", and whether the same calendar may be synced into two
tables (nothing prevents it today; each table keeps its own baselines).

Declared by `app/syncTable.test.ts` (the fake store enforces the pin's
grant: columns plus declared extras, no table write, no delete) and one e2e
(below). Not live-verified.

## Mapping

| Google Calendar                            | `event-v1` property (shortname)                                           |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `summary`                                  | Name (Atomic's `name`)                                                    |
| `description` (missing becomes empty text) | Notes (`atomic-calendar-notes`)                                           |
| `location` (missing becomes empty text)    | Location (`atomic-calendar-location`)                                     |
| All-day `start.date` / `end.date`          | Start / End (`atomic-calendar-start`, `-end`; plain dates, End exclusive) |
| Timed `start.dateTime` / `end.dateTime`    | Start / End (offset-qualified)                                            |
| whether `start.date` is set                | All day (`atomic-calendar-all-day`)                                       |
| —                                          | Day (`atomic-calendar-day`): the date part of Start                       |
| —                                          | End day (`atomic-calendar-end-day`): see below; may be unset              |

`event-v1`'s Recurrence (`atomic-calendar-recurrence`) is not written or
sent; a value someone puts there is listed as "Kept here only".

Start and End are stored as the exact strings Google sent. They are never
converted to numbers or to `Date` for storage.

All day, Day, End day and Notes use the host's shared calendar field names,
`calendarFields` in atomic-server `browser/lib/src/calendar-date.ts` (read
at the pin in `.atomic-server-ref`). The host table's own Calendar view,
where Month hands off, places a row on its Day, the first `date` column.
Only when that column is `atomic-calendar-day` does it treat a row whose
All day is true as a range, drawn on every day from Day up to but not
including End day (`isAllDayOnDate`: `start <= day && day < end`). So End
day is exclusive, like Google's all-day end:

- all-day event: End day is Google's `end.date`, the day after the last day
  (a one-day event on the 24th has End day the 25th; the fixture's three-day
  event on the 10th to 12th has End day the 13th);
- timed event that ends on a later date than it starts: End day is the date
  part of End, in the event's own offset. The host view ignores it at this
  pin, and places a timed row on its Day only;
- timed event within one day: no End day (the property is removed if an
  edit makes an overnight event fit in one day).

Day and End day are derived on import and on every edit made in the app.
Edited in the host, they are read back into Start and End (see
[Edits made outside the app](#edits-made-outside-the-app-compare-on-open)).
Version 0.1.0 wrote
the shortnames `day` and `all-day`, no End day, and Google's description to
the core Description; the host view drew its all-day and multi-day events
on their first day only. A table first imported by 0.1.0 keeps those old
Properties (0.1.1 no longer writes them) and gets the new ones on its next
sync; installs of 0.1.0 were experimental, so nothing migrates the old
values beyond that re-import. 0.1.1 to 0.1.4 wrote the fields as Properties
of the app's own ontology, under the shortnames `location`, `start`, `end`
and `atomic-calendar-*`; 0.2.0 moves them onto `event-v1` on first open (see
[Shared class](#shared-class-event-v1-177)).

### Which days the Agenda and Week draw an event on

From 0.1.2 the app's own views draw every row on exactly the days the host
table's Calendar view draws it (Michiel's decision on
atomic-server#1803: the data keeps the host's format, and the app's views
follow the host, not Google's UI). `app/events.ts` imports the host's
`isAllDayOnDate` from `browser/lib/src/calendar-date.ts` and applies
`CalendarView.tsx`'s bucketing to the same columns, at the pin:

| Row                                                        | Host view and app views                    |
| ---------------------------------------------------------- | ------------------------------------------ |
| All day, End day after Day                                 | Day up to, not including, End day          |
| All day, End day equal to or before Day, or no date        | nowhere                                    |
| All day, no End day                                        | Day only                                   |
| Not all day (timed), any End day                           | Day only, End day ignored                  |
| No Day (or one that doesn't start with `YYYY-MM-DD`)       | nowhere                                    |
| Made with the host view's `+` (Day, End day, no Start/End) | Day, drawn as an all-day event (read-only) |

Consequences, which differ from 0.1.1 and from Google's own UI:

- A timed event that runs past midnight, or over several days, is drawn on
  its Day only: the Week's block stops at 24:00, and its label and
  accessible name give the real end ("22:00 to 01:30 on Friday 25
  September").
- The day and the clock times of a timed event are the ones in its stored
  offset (the date Day holds), not in the viewer's zone. For a viewer whose
  zone has the same offset as the event nothing changes. Otherwise, an event
  stored as `23:30-04:00` shows at 23:30 on its own date, as the host does,
  while the drawer still gives the time in the viewer's zone and, on a
  second line, in the event's own offset.
- Day and End day decide, not Start and End: a row whose Day or End day was
  edited in the host table moves in the app too.

Declared by unit tests (`app/events.test.ts`, one case per row of the table,
each checked against the host's `isAllDayOnDate`); the e2e checks the host
view's days for the fixture, not the app's views in another zone.

The Google side stays as Google has it: an all-day event whose `end.date`
equals its `start.date` (Google's UI shows one day) is read as that one
day, with End day the day after (#184), both by `project()` and by the
LocalThought lens in `devonian/google-calendar/lens/projection.ts`; a
write-back sends Google the exclusive end.

Each row also carries its binding, outside the table's columns: the Google
event id, the ETag last read, the event's Google link and the sync baseline,
as Properties of the app's own ontology, declared on the App as its
`row-extras`. The baseline is JSON of
the five fields as both sides last agreed, keyed by field (`title`,
`description`, …), not by column, so the renamed columns leave it as it
was. It is what lets a refresh tell a local edit from a Google edit.

## Edits made outside the app (compare on open)

Per #177 (Q4–Q7) and #192. The bookkeeping lives on each row, as provider
extras: `google-event-id`, `google-etag` and `sync-baseline`. The pin has
the host side of #177 H6: a per-table change list with tombstones
(`GET /changes`, atomic-server #1850; `browser/lib/src/table-changes.ts`)
and a durable `afterCommit` hook (#1851, only with `--plugin-after-commit`).
Neither is reachable from a drive app's frame store at the pin
(`view-client.js` has no operation for either, and the frame cannot sign a
request as the person), so the app still compares instead: every time it
opens, and on "Sync now", it reads Google and compares each synced row with
its baseline. Any difference is a local change, however it
was made: the host's table, the host's Calendar view, another view, another
device. It goes into the same "Review N changes" list as an edit made in the
app, and nothing is sent until you press Send. A send is a `PATCH` with
`If-Match`, and the baseline advances only once Google confirms it.

The rows keep the host's format, so the comparison reads them back through
the lens (`hostValue` in `app/sync.ts`):

| Edited in the host                             | Sent to Google (after review)                                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Name, Notes, Location                          | `summary`, `description`, `location`                                                                             |
| Start, End (Day and End day left as they were) | `start`, `end` as typed; Day and End day are derived again                                                       |
| Day or End day, all-day event                  | `start.date` = Day, `end.date` = End day (exclusive), so Google shows the days the host view shows               |
| End day cleared, all-day event                 | one day: `end.date` = the day after Day (the host view shows Day only)                                           |
| Day, timed event                               | same clock time and offset on the new Day; End moves by the same number of days                                  |
| End day, timed event                           | End on that date at its own time (Day's date when cleared)                                                       |
| All day turned on                              | all-day from Day to End day, or Day alone when there is no End day                                               |
| All day turned off, Start and End still dates  | **not sent**, listed: there are no times to send                                                                 |
| End day on or before Day, all-day event        | **not sent**, listed: the host view draws it nowhere (end == start is not read as one day here, unlike Google's) |
| Day or End day not a date                      | **not sent**, listed                                                                                             |
| Start or End and Day or End day, disagreeing   | **not sent**, listed: the app can't tell which one you meant                                                     |
| A column the app doesn't map (one you added)   | **never sent**; listed as "Kept here only" with how many synced events fill it                                   |

Only Day moved, with End day left as it was, changes the length of an
all-day event, since that is what the host view then shows. A row that is
listed as not sent is held back entirely: it is neither sent nor rewritten
by the sync (a Google edit to it waits too), until it is fixed in the table
or with the app's Edit. The core Description (0.1.0's column) counts as a
column the app doesn't map: Notes is what is sent.

- **Conflicts.** A field changed both here (in any view) and in Google since
  the baseline is a conflict, handled as any other (_Conflicts_ above):
  neither side is overwritten until you choose per field. A Day edit counts
  as a Start edit. A Google change to a different field lands in the row,
  and the local change is still reviewed.
- **Deleted rows are not noticed.** A synced row deleted in the host takes
  its baseline with it, so there is nothing left to compare: the next sync
  imports the Google event again as a new row, and the event stays in
  Google. Noticing a local deletion needs the host's per-table change list
  with tombstones (#177 H6b), which the pin has but a drive app's frame
  cannot read yet (see above). Declared limitation.
- **Only while the app is open.** Edits made while it is closed are found
  the next time it opens; nothing is sent in the background.

Declared by unit tests (`app/compare.test.ts`: one case per row of the
table, a both-sides conflict, a deletion, a hand-added row and an unmapped
column) and one e2e step (below). Not live-verified.

## Scope and policies

Declared, not live-verified (see _Verification_):

- **Bounded import.** Full scans only, never a date window. Pages of 250
  (`maxResults=250`, `singleEvents=false`, `showDeleted=true`), up to 100
  pages, which is 25,000 events. Past that the import fails with "Pilot
  supports at most 25,000 events per scan" and writes nothing. A partial scan
  is never taken for the whole calendar.
- **Recurrence.** Series masters and all their instances are not imported,
  and the status line counts them ("Not imported: N recurring, M
  cancelled"). No partial mapping of a recurring event.
- **Cancellation.** A cancelled event that was never imported is only
  counted. For an imported event, cancellation in Google is a _conflict_:
  "Event cancelled, recurring or inaccessible; no deletion inferred". The
  local row stays. Nothing is ever deleted on either side.
- **Two-way edits.** Title, description, location, start and end, including
  all-day ↔ timed. Three-way reconciliation against the baseline
  (`adapter.ts` → `reconcileRecord`):
  - A Google edit to a field not edited here updates the row.
  - A local edit to a field Google did not change is offered for review.
  - The same field changed on both sides is a conflict. Neither side is
    overwritten.
  - A local value that can't be sent (an empty title, an interval that isn't
    valid) is held back and listed. Neither side changes.
  - Rows made in the table (no Google event id) are counted, never sent:
    creating events is not supported. This is the app's answer to #177 Q6
    (hand-added rows are local only unless published explicitly); there is
    no "Publish to Google Calendar" yet, so for now they stay local.
- **Conditional writes.** Each approved edit is one `PATCH` of only the
  changed fields, with `If-Match` set to the ETag that same preview read. A
  `412` marks only that event "Changed in Google since this preview; not
  sent", and it is reviewed again after a refresh. The baseline advances only
  for events Google confirmed.
- **Uncertain writes.** `store.proxy.request` can throw after the frame
  sent a write, for example when the response is lost, so the app cannot
  know whether Google applied the change. It reports "Unknown whether Google
  applied it" and stops sending the rest of the batch. It does not retry.
  Since #54 phase 2 nothing is spent by a lost response (there are no
  connection codes), so the next refresh works on the same connection and
  shows what Google has: if the change landed, the event simply agrees. A
  refusal by the proxy itself (`{ error }` with a proxy code, such as
  `not_delegated`) was not sent to Google; the app says "Connect again"
  when the connection is gone or no longer this app's.
- **Notifications.** Writes use `sendUpdates=none` (`adapter.ts`, and the
  Devonian write-back in `devonian/google-calendar/sync.ts`), so guests are
  not emailed about edits made through the app. The review sheet says so;
  notify guests from Google if an edit should reach them. This settles
  design #89, §11 decision 3. `app/sync.test.ts`, `adapter.test.ts` and
  `devonian/google-calendar/sync.test.ts` assert the query parameter.
- **Out of scope** (separate work, per #101): creating and deleting events,
  editing recurring events, attendees, reminders, conferencing data, and
  multi-calendar product design.

## Proxy catalog

The operations the app uses, declared in [`app/operations.ts`](app/operations.ts)
and confirmed against the composed `google-calendar`
catalog document. The overlays in
[`../../overlays/APIs/googleapis.com/calendar/v3/`](../../overlays/APIs/googleapis.com/calendar/v3/)
are byte-identical to the ones GitHub Pages publishes, and the proxy fetches
those at runtime. The checked-in composition is
`integration-proxy/tests/identity-catalog/google-calendar-composed.yaml`.
Server base: `https://www.googleapis.com/calendar/v3`, so relay paths keep
`/calendar/v3`.

| Relay call                                              | Query the app sends                                                     | Catalog operation (scope)                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /calendar/v3/users/me/calendarList`                | `maxResults=250`, `pageToken`                                           | `calendarList.list` (`calendar.calendarlist.readonly`)                                           |
| `GET /calendar/v3/calendars/{calendarId}/events`        | `singleEvents=false`, `showDeleted=true`, `maxResults=250`, `pageToken` | `events.list` (`calendar.events`)                                                                |
| `PATCH /calendar/v3/calendars/{calendarId}/events/{id}` | `sendUpdates=none`, always with `If-Match`                              | `events.patch` (`calendar.events`), `412` declared, `sendUpdates` enum `all\|externalOnly\|none` |

Nothing else: no create, delete or single-event read, no other query
parameter, no other value for the fixed ones. `operationFor` in
`app/operations.ts` is that rule, and `app/relay.ts` applies it to every
intent before the host is asked. `app/operations.test.ts` reads each
declared operation out of the checked-in composition (its operation id, its
one scope under both security schemes, the parameters the app sends, the
`sendUpdates` enum and the `412`), checks that
`overlays/.../auth-overlay.yaml` asks Google for exactly those two scopes,
and runs the app's whole flow (calendar list, import, refresh, review,
send) against the fake store to check that it uses all three operations and
nothing else. The e2e checks the same declaration against what the mock
proxy actually received from the real plugin frame
(`POST /fixture/google-calendar/received`). These are checks against the
checked-in composition and the mock; what Google itself permits for the
account is only known from a live run (see _Verification_).

`integration-proxy/src/identity_catalog_tests.rs`
(`composed_google_calendar_permits_the_calendar_app_operations`) checks
these calls, with their query strings, through `Catalog::allows`,
`required_headers` and `validate_request` (it also allows a single-event
`GET`, which the app has not sent since 0.1.4 removed `adapter.ts`'s
`get`). `If-Match` is not a catalog
question: `proxy.rs` `upstream_request` forwards it for any allowed
operation, and `browser_cors()` allows it in and exposes `ETag` out. The
Heroku deployment (`localthought/integration-proxy`) is a wrapper around
this crate at `ontola/atomic-plugins@494eb8a`, which already has both.
Whether that deployment has Google OAuth configured for `google-calendar`
has not been checked here.

## Host requirements

- `store.proxy` with `ifMatch` (atomic-server#1657). The pin, `2f403624e`,
  has it: view-client.js passes `ifMatch` through, and the page sends it as
  `If-Match`. Without `store.proxy` the app says the host can't reach the
  proxy and fetches nothing.
- **Read-your-writes after an app save** (atomic-server#1690, in the pin).
  An app's `save` is committed by the server (`/app-write`); before #1690
  the page kept serving its old copy of the row to the app's next `get`.
  This app reconciles against the baseline it saved, so on an older host the
  refresh after a successful send reports a false conflict.
- After an uncertain request, the page keeps the spent connection listed
  (`proxyConnections.list` still returns it). The app falls back past it to
  the newest working connection. A host that pruned it would be simpler.
- **Shared class** (#177, from 0.2.0): app writes (`/app-write`) of a
  table `classtype`, a row `isA` and row properties whose subjects are on
  GitHub Pages, and an App `row-extras` property (atomic-server #1849).
  Checked at pin `a12b74a` by a throwaway spike through the frame protocol
  and by the e2e. Pages must be reachable the first time the server or a
  browser uses a term (see [Shared class](#shared-class-event-v1-177)).
- **Sync this table** (0.3.0): `store.rowAccess()` and
  `store.requestRowAccess()` (atomic-server #1740), and a row grant that
  covers the App's `row-extras` (#1849), both in pin `a12b74a`. Without
  them the button is not offered and the table stays read only.
- The `store` members the app calls are listed in `app/operations.ts`
  (`HOST_OPERATIONS`): `getApp`, `getData`, `getResource`, `query`, `newResource` and
  `proxy.request`/`.connections`/`.connect` on every host with the relay;
  `openExternal`, `openResource`, `getTheme`, `onThemeChange` and
  `proxy.disconnect` feature-detected (pin 007869464), and `rowAccess`
  and `requestRowAccess` feature-detected (pin a12b74a). `app/operations.test.ts`
  runs the controller's whole flow and mounts the view against a recording
  store, and checks that exactly those members were touched.

## Verification

From the repository root, with the AGENTS.md layout (`browser/` linked to
the pinned atomic-server checkout):

```sh
./browser/node_modules/.bin/vitest run --config integrations/calendar/vitest.config.ts
./browser/node_modules/.bin/tsc -p integrations/calendar/tsconfig.json
node integrations/tooling/run-lane.mjs calendar                 # typecheck, unit, e2e
node integrations/tooling/run-lane.mjs calendar --tier e2e
node --test integrations/localthought/mock-proxy.test.mjs
(cd integration-proxy && cargo test --lib composed_google_calendar_permits)
```

- **Unit, views** (`app/view.test.ts`, jsdom; `app/controller.test.ts`,
  `app/events.test.ts`, `app/contrast.test.ts`): every screen of the design
  against the fake store, the banner copy for each provider status, agenda
  grouping and week packing on the host Calendar view's days (exclusive
  End day, End day == Day, missing Day or End day, midnight crossings,
  events stored in another offset), local edits stored as offset-qualified
  strings, and the
  event tints' contrast for Google's 24 classic calendar colours.
- **Unit** (`app/sync.test.ts`, `adapter.test.ts`): the whole drive-app path
  against the stateful fixture in
  [`fixtures/google-calendar/scenario.mjs`](fixtures/google-calendar/scenario.mjs),
  through a fake `store.proxy` that behaves like the host's frame client and
  the proxy: a lost response spends nothing, a revoked delegation answers
  `403 not_delegated`. Covered: calendar list and selection; the
  paged import with its page cap; all-day, three-day and timed rows with
  the host's field names, including End day (exclusive for all-day, set
  and removed again for a timed event across midnight); recurring and
  cancelled skips; refresh; review; `If-Match` on send; `412`; both-changed
  conflicts; a lost response followed by a reconnect; cancellation after
  import; local-only and invalid rows. `app/compare.test.ts`: edits made
  outside the app, found on open (see the table above). `app/adopt.test.ts`:
  the first-open move of a table as 0.1.4 left it onto `event-v1`, with an
  unsent edit kept, idempotence, `row-extras` skipped on a host without it,
  and the read-only view of another `event-v1` table.
  `app/syncTable.test.ts`: Sync this table on another `event-v1` table
  (the grant asked for once, an older grant without extras asked again,
  Not now, the binding under the App, the table untouched, rows already
  there kept local, a row edit sent with `If-Match`, a reopen without a
  question, a revoked grant pausing without a proxy request, no delete).
  `app/build.test.ts` checks that the
  bundle is one ES module exporting only `view`, with no storage, `fetch` or
  credential of its own. `app/operations.test.ts`: the declared scope (see
  [Proxy catalog](#proxy-catalog)) against the relay, the composed proxy
  catalog, the auth overlay, and what the app does.
- **Host e2e** (`e2e/calendar.spec.ts`, lane `calendar`, tier `e2e`): the
  same path in the real plugin frame on the pinned host, with the mock
  integration proxy. Each test installs the app from the catalog's Drive
  apps section (the committed `apps/calendar/<version>/ui.js`, served by the
  lane's dev-server). The rows use the published GitHub Pages subjects, so
  the lane needs network access to `ontola.github.io`; `beforeAll` first
  checks Pages serves `event-v1` and its properties with the committed
  bytes (`ontology-kit/served.mjs`). After the import it checks that the
  table and every row are `event-v1` and that the App renders it. It connects through the consent bar, chooses a
  calendar, imports and checks the rows, then refreshes after a Google-side
  edit made through the mock's test drivers
  (`POST /fixture/google-calendar/…`). It then sends a reviewed edit
  (checking the fixture received that `If-Match`), sends into a `412`, and
  loses a `PATCH` response (Playwright lets the request reach the mock, then
  aborts the response), syncs again, and checks that the preview agrees.
  Then (#192) it sets the one-day all-day event's End day a day later as
  the signed-in user (a commit, as a table edit is; not through the table's
  cells), reloads the page so the app opens again, checks that the review
  lists End, sends it, and checks that the fixture received a `PATCH` of
  only `end.date`, with `If-Match`. A
  later test follows Month into the host table, adds its Calendar view, and
  checks that the fixture's three-day all-day event is drawn on the 10th,
  11th and 12th (not the 9th or 13th), the one-day all-day event on its day
  only, and the timed event on its day. Another test renders the imported
  calendar in 360, 720 and 1200px frames
  under the host's light and dark themes: no sideways scroll, no axe
  violations, and the theme switch restyles the frame without a reload.
  Another (#177) makes an `event-v1` table as the signed-in user, with one
  row that has only a Day, adds the app to it through "+ Add view"
  (read-only), and checks the "Not synced" banner and the row drawn as an
  all-day event, with no Edit. Another (#177 item 14) makes such a table
  with one row, adds the app Read-only, presses "Sync this table to Google
  Calendar", allows editing in the host's bar, connects, chooses the
  primary calendar and imports; checks the three events are rows of that
  table with the extras, the person's row untouched, the table's name and
  class unchanged and the calendar id on the binding under the App; then
  edits the three-day event's Notes as the signed-in user and checks the
  review lists it and the fixture received a `PATCH` of only
  `description`, with `If-Match`, and that the row's baseline moved.
  Screenshots are attached to the Playwright report. The first test ends by
  reading every request the mock proxy received from the frame
  (`POST /fixture/google-calendar/received`) and checking that each is one
  of the three declared operations, with its query and `If-Match`, and that
  all three were used.
- **Live check kit (not yet run).** `node integrations/tooling/live-check.mjs
calendar --i-understand-this-writes-to <calendar id>` runs this app's
  controller against one disposable Google calendar and writes evidence; see
  [The live-check kit](../LIVE_TESTING.md#the-live-check-kit).
- **Live: not verified.** No run against a real Google account exists for
  this path. Evidence from the retired LocalThought/Devonian flow does not
  count for it. To verify, with authorized credentials and a disposable
  calendar: deploy or point the host at an integration-proxy with Google
  OAuth configured for `google-calendar`, install the app as above, create
  one all-day event, one three-day all-day event, one timed event, one
  weekly series and one cancelled event, then run the e2e's steps by hand and record the outcomes. The one
  step that can't be forced against Google is the lost response.

## Design decisions

Where the implementation of [`design/`](design/) had to choose:

- **One calendar per app.** The picker (5.4) uses radio buttons, not the
  mockup's checkboxes: the table model binds one calendar per table (#101).
  The header shows that calendar's chip; it toggles visibility only.
  "Choose calendars" in the connection menu is disabled with that
  explanation. Multi-calendar import would need a per-row calendar id and
  one preview per calendar.
- **Month** (§11 decision 1) hands off: "Month ↗" (and `m`) opens this
  app's table in the host with `store.openResource`, where the table's own
  Calendar view shows the month, reading the rows by the host's calendar
  field names (see [Mapping](#mapping)). The app draws no month grid.
- **Outlook and Apple** are shown as "Not available yet" (§11 decision 2).
- **"Open in Google Calendar"** uses `store.openExternal`: the frame has no
  popup rights, so the host shows the destination and asks first. The link
  is Google's `htmlLink`, kept on each row on import (`google-link`,
  display only). The drawer shows the event's own UTC offset (from the
  stored string), not a named time zone, since `timeZone` is not imported.
- **Disconnect** in the connection menu calls `store.proxy.disconnect`: only
  this app's delegation goes; the connection (other apps may use it) and
  the rows stay.
- **Host operations are feature-detected.** `openExternal`, `openResource`,
  `proxy.disconnect` and `getTheme`/`onThemeChange` arrived at pin
  007869464; on an older host their controls are not shown, and dark mode
  is read from the luminance of `--t-color-bg-body`.
- **Last view is not remembered.** The null-origin frame has no usable
  `localStorage`, and the build test forbids storage; the default view is
  chosen by width on every open.
- **Week scroll** starts at 08:00 when now is within 08:00–18:00, otherwise
  one hour before now.
- **Theme.** `data-pl-theme` follows `store.getTheme()` and
  `store.onThemeChange()`; `--pl-pos` reads the host's `--t-color-success`.
- **Banner actions.** 403 and 404 offer Retry (there is no other calendar
  to choose in this app); after an uncertain write the action is Sync now.
- **Colour.** The week time line mixes `--pl-text` into `--pl-muted`, and
  pill text is mixed a quarter towards `--pl-text`: the plain tokens fall
  under 4.5:1 on their tinted backgrounds.
- **Shared chrome** (`app/ui/`) stays in this plugin; moving it to a shared
  kit is the maintainer's decision.

API reference: https://developers.google.com/calendar/api/v3/reference/events
