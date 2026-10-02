# Clockify

The supported path is the **drive app** in `app/` (below): catalog entry
`timesheets` (published but disabled pending launch: the catalog entry carries the module and its integrity with `enabled: false`, so the Integrations page does not offer it yet; the lanes' dev-server serves it enabled (`DEV_SERVER_ENABLE_APPS`), which is how the e2e installs it), installed once enabled from the Integrations page's **Drive apps** section
(experimental plugins shown), which downloads
`apps/timesheets/<version>/ui.js` from GitHub Pages and checks it against the
catalog's integrity hash (see
[Publishing a drive app](../README.md#publishing-a-drive-app)). Since 0.2.0
it writes reviewed edits back to Clockify (#123 M3, below), since 0.3.0
range edits and conflict resolutions (#123 M4), and since 0.4.0 it
coordinates two open copies (#123 M5: the send lease, range edits made
apart, two devices compacting the log); all are mock-tested only, so those
capabilities are declared, not verified. Since 0.5.0 its rows are the
shared `time-entry-v1` class, linked to rows of its own Projects and People
tables (#177 item 7, below), which keeps its catalog entry disabled until
the ontology moves to a stable domain. The first sections describe the Clockify
lens and the LocalThought extension flow it was written for; the pinned host
no longer has that flow.

Clockify runs entirely in the browser through LocalThought: no AtomicServer-side
code, no stored secret, no server-initiated calls to Clockify. The personal API
key (Preferences → **Manage API keys** → **Generate new** at
https://app.clockify.me/manage-api-keys) is entered on LocalThought's consent
page and sealed into a per-connection credential by the integration proxy. The
generic Syncables engine pages through `timeEntries` from the proxy's Clockify
catalog document; `localthought.ts` and the lens it re-exports from
`devonian/clockify/` are the only Clockify-specific code.

## What the lens does

- **Workspace and account picker.** The catalog document only lists time
  entries, so setup reads `/api/v1/workspaces` and `/api/v1/user` through the same
  proxy (`parameterOptions.ts`) and offers them as dropdowns; the account is
  filled in automatically since there is only one.
- **Rolling look-back.** Setup offers the past 7 or 30 days. The window is
  recomputed as `start`/`end` query overrides on every refresh, not frozen at
  installation.
- **Time Tracker projection.** Each completed `REGULAR` entry gets typed
  `start`/`end` timestamps and is named after its description. Running timers
  (no end) and breaks are skipped; the table's own timer owns anything without
  an end. Provider fields stay on the record.
- **Timer view.** The folder's table opens in a Timer view with a derived
  Duration, per-day totals and an "All entries" list — the same views the
  built-in Time Tracker template creates.

Refresh, conflict handling, limits and storage follow the generic LocalThought
flow (see `../localthought/README.md`): import only, local edits preserved,
nothing written back to Clockify.

## Not covered (v1 reductions, see `planning/timesheets.md`)

- Project and Person linked records: Clockify only returns raw `projectId` /
  `userId` strings on entries.
- Tags, tasks, rates, custom fields, active timers; regional/private API
  origins.
- Automatic migration of tables created by the retired server-side plugin.
  They stay readable; reconnect through the Integrations page to start a
  LocalThought folder.

Live account data must never be checked into fixtures.

## Drive-plugin app (`app/`)

`app/` is the replacement for the LocalThought extension path above:
Clockify as an Atomic **App** ("drive plugin"). `app/build.mjs` bundles it
into one minified ES module (`app/dist/ui.js`, about 161 KB, no imports) that
exports only `view({ root, store })`; the host stores it as the App's
entry-point source and runs it in a null-origin, `allow-scripts`-only iframe
(`plugin_ui.rs`). Plain DOM, no framework; one `<style>` element injected
into the view root.

- **Views** (#89, design on branch `claude/design-timesheets`). `app/ui/`
  renders the design's frames from `controller.ts`'s state and a
  `Timesheet` (`app/model/types.ts`) built from the observation log's
  mirror (`app/model/source.ts`), never from the table's rows: Week grid
  (project × day), Entries (by day), Projects (the whole window), a
  read-only entry drawer, the settings sheet, and the set-up, empty and
  error states. Below 560px of frame width the week becomes a strip of day
  tabs. `app/ui/theme.ts` maps every `--pl-*` token from the host's
  `--t-*` theme variables, so dark mode is the host's. `app/ui/theme.ts`,
  `components.ts` and `dom.ts` know nothing of Clockify: shared-kit
  candidates. View, week and open entry live in memory only.
  `app/ui/preview.ts` renders every frame from the mockup's sample data
  for the DOM tests and the e2e's screenshot and axe pass.

- **Connecting.** "Connect Clockify" calls
  `store.proxy.connect({ platform: 'clockify' })`. The host, not the frame,
  draws a consent bar; only a click there starts the PKCE handoff to the
  integration proxy, where the person enters their Clockify API key; the
  proxy keeps it, sealed. The host redeems the handoff (signed with the
  user's key, so the user owns the connection), delegates it to this app
  and navigates back. The app finds the connection with
  `store.proxy.connections({ platform: 'clockify' })`. The app's code and
  the drive never hold a key, token or capability (#21); the frame's
  requests are signed by the host's frame client.
  Connections live at the proxy under the user's agent, so another browser
  signed in as the same user finds the same connection (not tried in the
  e2e, which uses one browser).
- **Setup.** Once connected, the frame reads the account (`/api/v1/user`)
  and its workspaces (`/api/v1/workspaces`) through the proxy and asks for
  a workspace and a 7- or 30-day look-back. It stores only the workspace id,
  the account id and the look-back on the App resource, as three Properties
  (`clockify-workspace`, `clockify-account`, `clockify-lookback-days`).
  "Change settings" reopens the same form.
- **Shared classes** (#177 item 7, 0.5.0). Mock-tested only, like the
  rest; every class and property is declared, not verified:
  - _Rows_ are the shared `time-entry-v1` class
    (`https://ontola.github.io/atomic-plugins/ontology/classes/time-entry-v1`,
    `ontology-kit/source.json`): Atomic's `name` (the description),
    `work-start` and `work-end` (timestamps, ms), `work-billable`, and
    `work-project` and `work-person`, links (#177 Q11). `app/fields.ts`
    takes the subjects from `ontology-kit/terms.mjs`, which the build
    inlines, and every shared field is read and written through
    `ontology-kit`'s strict resolver: by exact subject, never by shortname
    or column.
  - _Projects and People_ are two more tables the app makes under its App
    on first use, "Projects" (`work-project-v1`) and "People"
    (`work-person-v1`), each row with only a `name` from the shared class
    (`app/links.ts`). The app owns them: a sync makes a row per active
    Clockify project it reads (archived ones only when an entry uses
    them) and per user an entry names, and sets their names to Clockify's,
    so a name changed in those tables is set back on the next sync. A
    project or user Clockify gave no name for (its list was refused) gets
    "Clockify project <id>" or "Clockify user <id>". They are found again
    by class among the App's children, so the App needs no pointer to them.
  - _Provider extras_ stay Properties of the app's own ontology, created by
    `app/schema.ts` under the App's `default-ontology` and found again by
    shortname (a host's `/app-write` rejects a property URL that does not
    resolve to a Property): on each time entry row `clockify-entry-id` and
    the sync bookkeeping below; `clockify-project-id` on project rows and
    `clockify-user-id` on person rows; the settings and the observation log
    on the App. None is a column. The time entry rows' five extras are
    declared on the App as `row-extras` (atomic-server #1849). The host's
    `timeTrackingSchema` names a `work-source-id`
    (`clockify:<workspace>:<entry id>`, #177 §2.4); it is not part of the
    shared ontology, so `clockify-entry-id` stays the row's identity.
  - _A project on a row_ is the linked project row: one with a
    `clockify-project-id` stands for that Clockify project; one without
    (added by hand, here or in a table of one's own) stands for "the active
    project with this name", resolved when the change is listed to send,
    as a project name typed into the table was up to 0.4.0 (two or no
    active projects of that name block the change). Removing the link is
    "no project". Who tracked an entry (`work-person`) is shown, never sent.
  - _First open_ (`app/adopt.ts`, as the calendar app's 0.2.0): an
    installation from before 0.5.0 has a row class of its own. Its rows
    move onto `time-entry-v1` in place, not re-projected from the log, so
    an unsent edit survives (#177 Q10): start, end and billable move to the
    shared properties, the old project id and name and user id and name
    become links (an unsent project name typed into the table becomes a
    link to a project row of that name without an id), `isA` becomes
    `time-entry-v1`, and the old properties are removed from the row. Only
    then the table's `classtype` becomes `time-entry-v1`, `time-entry-v1`
    is added to the App's `renders`, and `row-extras` is set. Each step is
    skipped once done. The old class and Properties stay in the app's
    ontology, unused.
  - _Another `time-entry-v1` table_: since the App renders the class, the
    host's "+ Add view" offers the app on any table of it, including one
    made by hand (New Table → use an existing class → paste the class URL
    above; its search does not find Pages classes, #177 H10). There the
    app shows that table's completed rows in its week, entries and
    projects views, read only, with "Not synced with Clockify", and syncs
    nothing: there is no observation log for that table, so no window,
    coverage or conflicts. "Sync this table to Clockify" (#177 §6.2 item 14) is not built.
  - _Not verified:_ the published terms are fetched from GitHub Pages by
    the server and the browser (the e2e needs ontola.github.io); a cold
    browser or server during a Pages outage fails as #177 spike S1 found
    (H1). Not tried: a drive with many projects (each sync reads every
    project row once and renames where Clockify's name differs). Tables
    the host's Time tracker template makes have a class of their own, so
    the app is not offered on them (a lens is #177 §3.1, not built).
- **Observation log** (#123 M1, design #97). Once set up, the app syncs on
  open and on "Sync now". Each pass records what it _saw_ in Clockify, not
  what Clockify "is":
  - `clockifyObserve.ts` reads the rolling look-back window, starting 24 h
    earlier (the margin), as one observation: all pages, with its scope
    (workspace, user, `start` in `[from, to)`) and the fields returned.
    Clockify reads the list's bounds as wall-clock time in the user's
    profile time zone, so each pass reads that zone (`GET /user` →
    `settings.timeZone`, `timeZone.ts`) and the workspace's `forceProjects`
    (`GET /workspaces`), sends local wall-clock bounds with a `Z`, and
    records the UTC span they cover. When a bound falls in a repeated DST
    hour, the span recorded is the smaller of the two readings; if the zone
    is unknown, 14 h is taken off each end.
    Each entry is kept canonically: exact instant strings, and every field
    the app does not interpret (`timeZone`, `duration`, …) verbatim in
    `extra`.
  - `observations.ts` (generic, pure) diffs it against the mirror (the
    mask-diff) and folds it in, ordered by `(receivedAt, id)`. An entry a
    complete read no longer returns is only an absence _candidate_; the
    next pass confirms it with `GET /time-entries/{id}`: Clockify's 400
    "Time entry doesn't belong to Workspace" (or a 404 from Clockify) is a
    deletion, 200 restores it (it was skipped between pages, or moved), and
    any other answer leaves the candidate with a warning.
  - `observationLog.ts` stores each non-empty diff as its own resource
    under a log head in the app's subtree, writes a snapshot every 50
    diffs or 256 KB, and keeps everything (nothing is pruned). A pass with
    no change stores no diff; it only confirms the coverage in the head.
    Saving the head re-reads it and merges what another copy saved since
    (M5, S28): tails are united, and a snapshot another copy wrote
    meanwhile is kept as a second tip (`others`) rather than replaced;
    opening a head with two tips replays every incremental they reach,
    and the next compaction writes one snapshot that merges them.
  - **Coverage.** Time in the window that no complete read covers is
    _unknown_, never "not worked". Starts are known from where reads
    looked; a moment counts as known only if starts are covered back by
    the longest entry seen (at least 24 h), so an entry longer than the
    margin leaves the window's first part unknown until an older range is
    read.
  - **Rows.** The table's rows follow the mirror: completed `REGULAR`
    entries through the one Clockify lens (`devonian/clockify/`; running
    timers and breaks skipped), by `clockify-entry-id` among the table's
    children, linked to their project and person rows. A row whose entry Clockify
    confirmed deleted is removed. Since 0.2.0 an edit made in the table is
    kept and listed to send (write-back, below), no longer overwritten
    (#177 Q5 reverses #97 answer 2); the table's description says so.
  - **Status line.** Created/updated/unchanged as before, plus rows
    removed, entries waiting for a re-check, how much of the window is not
    loaded, and whether the workspace requires a project on every entry
    (`forceProjects`: "worked, no project" cannot be written back there),
    each only when it applies.
    A sync writes nothing to Clockify. Requests are sequential; each is
    one relay round trip.
- **Write-back** (#123 M3, following #177 §4; 0.2.0). Mock-tested only:
  - _What can change:_ an entry's Name (its description), project,
    billable flag, start and end, in the entry drawer (Edit) or anywhere
    else the row can be edited (the table, another view, another device);
    and Delete entry ("did not work" for all of it). Changed start and end
    snap down to whole minutes (#97 answer 7), unless they line up with
    another entry's start or end in Clockify (a range edit's trim or
    extension meeting its neighbour). Range edits and conflicts: below
    (M4). Not editable: tags, tasks, custom fields.
  - _Not editable_ (`blockers` in the lens, checked when listing and again
    on the fresh read): running timers, breaks and other non-`REGULAR`
    entries, locked entries, entries with custom field values (the request
    shape is unverified), an end in the future, a start not before the end,
    no project under `forceProjects`, and an unknown or archived project.
  - _Bookkeeping on the row_ (#177 Q4), as provider extras that are not
    table columns: `clockify-sync-baseline` (JSON: the values the row and
    Clockify last agreed on), `clockify-outbox` (a marker written before a
    write and cleared once a read settled it) and `clockify-delete`.
  - _Finding changes_ is comparing each row with its baseline, on open and
    on every sync (the host has no change feed yet, #177 H6). A three-way
    `reconcileRecord` (the host's `plugin-reconcile.ts`, the calendar's
    engine) over baseline, row and Clockify takes a Clockify-only change
    into the row, keeps a row-only change and lists it, and for a field
    changed on both sides **keeps Clockify's value** (#177 §4.4), naming
    the dropped value under "Changes to send".
  - _Sending_, only from "Changes to send" (every send is reviewed while
    testing, #177 §4.3), per entry and one request at a time: the row is
    re-read (changed since the list: not sent); a fresh `GET` by id, the
    only concurrency check Clockify allows (no ETag or If-Match); the
    three-way check against it (a conflict sends nothing); the outbox
    marker; one full-replacement `PUT` that the lens
    (`devonian/clockify/lens/writeBack.ts` `putBody`) builds from the fresh
    full record, replacing only changed fields and always sending `start`,
    `end`, `billable`, `description`, `tagIds` and `type` (a project change
    drops `taskId`), or a `DELETE`; a verification `GET`. The baseline and
    row advance only after that read, to what Clockify then holds
    ("adjusted" if it differs from what was sent). Every read and write
    response goes into the observation log.
  - _Failures:_ a thrown call or a 5xx is uncertain (it may have been
    applied): the batch stops, the marker stays, and the next sync reads
    the entry back and settles it either way. A 4xx is shown and not
    retried. A 429 waits for `retry-after` (at most 60 s) once. A proxy
    refusal, or the proxy's 404 for a catalog without the write overlay,
    stops the batch with that reason.
  - _Known limits:_ a change made in Clockify between the fresh read and
    the write is overwritten (the verification read shows the result); a
    row deleted in the table is not noticed (needs the host's change list
    with tombstones, #177 H6b); changes are found only while the app is
    open. Two devices sending at once: see M5, below.
  - _Prerequisites, checked at the pin:_ the host's frame client allows
    `PUT` and `DELETE` to the proxy (`PROXY_METHODS` in
    `server/src/plugins/assets/view-client.js`, also at candidate14
    `1432e244a`), and the proxy catalog's Clockify entry lists the
    time-entry write overlay
    (`overlays/APIs/clockify.me/1.0.0-readonly/time-entry-write-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml`).
- **Range edits and conflict resolution** (#123 M4, §3.2–§3.4; 0.3.0).
  Mock-tested only:
  - _What:_ "Edit a time range…" marks `[from, to)` (profile time zone,
    whole minutes) as worked on a project, worked with no project (not
    offered under `forceProjects`), or not worked. Each conflict in the
    "Conflicts in Clockify" list offers its resolutions over its exact
    span (not snapped): "Keep <project>" per project claimed and "Did not
    work" for "unclear which project", "Did not work" for "unclear whether
    worked" (the break, holiday or time off itself stays Clockify's to
    change), and "Remove duplicate" for the same project twice.
  - _Planner_ (`devonian/clockify/lens/rangePlan.ts`, pure): for "did
    not work", every editable entry in the range loses the overlap
    (inside: deleted; sticking out: trimmed; spanning: split, the copy
    keeping description, task and tags). For "worked on P", other
    projects lose the overlap, except one entry covering exactly the range
    with no P entry in it, which changes project (one `PUT`, task
    dropped); overlapping P entries keep the earliest (by start, then id);
    each remaining gap extends a P entry ending at its start or beginning
    at its end (#97 answer 8), or becomes a new entry with an empty
    description and `billable` from the project's `billable` field, false
    when the project list does not say (#123 §7.1–§7.2, a default, see
    #227). Refused before anything is staged: an empty range or one
    ending in the future, a range outside the loaded window or over
    unknown time, a running timer, a locked entry or one with custom
    field values in it, a break, holiday or time off in a "worked" range,
    an unknown or archived project, and an entry in the range whose row
    already has an unsent change (send or discard it first).
  - _Staged on rows, sent after review_ (#177: bookkeeping on the row):
    a trim, extension or project change edits that entry's row, a
    deletion sets `clockify-delete`, and a new entry is a new row with no
    entry id that carries `clockify-create` (JSON: the split entry it
    copies, with its task and tags). They are listed under "Changes to
    send" like any other change and sent in the order of #123 §3.5:
    deletions and shrinks, then extensions and project changes, then
    creates, so an interrupted batch leaves a gap, never an overlap.
  - _Sending a create:_ the row is re-read; the range is read fresh (with
    the 24 h margin); if Clockify has any entry overlapping it by then,
    nothing is created and it is reported as a conflict, unless the only
    one is exactly what this row would create (same start, end and
    project) and no row is bound to it, which is an earlier send whose
    answer was lost: the row is bound to it. Otherwise the outbox marker,
    one `POST`, the new entry's id written to the row at once (a reload
    never creates it twice), and a verification `GET` before the baseline
    is set.
  - _Uncertain creates_ (#123 S15): a thrown call or a 5xx leaves the
    row's outbox marker and stops the batch. The next sync, before it
    makes rows for entries it has not seen, binds such a row to an entry
    no row is bound to with the same start, end and project (#97 §4.2);
    with none, the create did not arrive, the marker is cleared and it is
    listed again. Two matching entries: one is bound, the other gets its
    own row and shows as a duplicate, which "Remove duplicate" cleans up.
  - _Not done:_ dragging on the week grid (the form is the only way in).
    Since M5 each range edit is also recorded as an intent (below); a
    field edit is still only "row differs from its baseline".
- **Two open copies** (#123 M5, #97 §5.2 and §6.2; 0.4.0). Two devices,
  or two tabs, on one drive. Mock-tested only, through the in-memory
  store, with two copies of the drive merged per property (the later save
  wins) to model devices that edited apart; two real browsers have not
  been tried:
  - _Send lease_ (`app/lease.ts`, #97 answer 5): `clockify-lease` on the
    log head, `{ device, takenAt, until }`, 60 s. A send takes it (read,
    write, read back) and sends nothing while another copy holds one that
    has not expired ("Another open copy of this app … is sending"; every
    change stays listed, `not-sent`). It is renewed before each change and
    before each write when less than half is left, and given back at the
    end; a copy closed mid-send leaves it to expire. A copy that loses it
    mid-batch (stalled past 60 s, taken over) stops: the rest is
    `not-sent`. While another copy holds it, a sync leaves a create whose
    send is unconfirmed alone (that copy may be sending it now) and the
    status line says another copy is sending. The device id is new on
    every page load (the frame has no storage), so a reload counts as
    another copy. Advisory: `/app-write` has no compare-and-swap, so two
    copies taking it within one read-write round trip can both send; the
    worst case is a duplicate create, which the next sync shows as a
    duplicate and "Remove duplicate" repairs.
  - _Range edits as intents_ (`app/intents.ts`): each range edit or
    resolution is also one resource under the log head (`clockify-intent`,
    found by `clockify-intent-of`): its span, target, the rows it staged
    and the intents it replaces. Written once, never edited, so two
    devices never overwrite each other's intents even where their row
    edits collide. Status is derived: replaced when a later intent names
    it, open while one of its rows still has a change to send.
  - _S22:_ a range edit made where open range edits overlap it replaces
    them: their staged changes are put back first, then the new plan is
    staged. One that reaches outside the new range is not cut in two:
    the edit is refused until it is sent or discarded.
  - _S21:_ two open range edits that overlap, where neither replaced the
    other (made apart), are compared: the same target agrees (a second
    create of the same entry finds the first one's entry and stops);
    different targets are a conflict between your edits, listed with
    Clockify's conflicts on every device that holds both ("Your range
    edits disagree, not sent: … (here, 10:42) · … (another device or an
    earlier visit, 10:40)"), and none of their changes is sent until one
    of "Keep <project>" or "Did not work" is chosen over the whole span,
    which replaces both. No clock decides between them (#97 §5.2). Not
    shown on the week grid, only in the conflicts list.
  - _Not covered:_ two devices editing the same field of a row directly
    (drawer or table) apart: the row keeps the later save, as any
    Atomic resource does; no intent records a field edit.
  - _Two devices compacting the log_ (S28): see the observation log.
  - _Measured_ (2026-10-01, build VPS, Node 22, synthetic entries over a
    30-day window, mean of 20 runs; not a committed test): at
    600 entries a full fold plus the timesheet build takes 18 ms, the
    snapshot is 333 KB and a first sync's incremental 272 KB; at 2,000
    entries 58 ms, 1.11 MB and 907 KB. #97 §7 estimated under 10 ms and
    at most 300 KB / 1 MB, so both are somewhat over. atomic-server's
    JSON extractor limit, read from the pinned source (actix's default
    `JsonConfig`, 2 MiB; not exercised), would take a 2,000-entry
    snapshot as one `/app-write` with little room to spare once the JSON
    text is escaped; snapshots are not split per week yet.
- **Timeline lens** (#123 M2, read-only). Two stages over the mirror, full
  recompute on every build (not measured; #97 §3.2 estimates single-digit
  ms at 2,000 entries):
  - _Map_ (`devonian/clockify/lens/claims.ts`): each entry becomes at most
    one claim over `[start, end)` with the exact instant strings:
    `worked(P)`, `worked(none)` (no project: a label, not a conflict, #97
    answer 3), a running timer up to now (`open`), and `didNotWork` with a
    badge for `BREAK`, `HOLIDAY` and `TIME_OFF` (the last two are spec enum
    values, never seen live). Locked entries and entries with custom field
    values are flagged.
  - _Aggregate_ (`app/timeline/sweep.ts`): a sweep over the claims and the
    coverage gives non-overlapping segments per local day in the profile
    time zone, from the day holding the window's start up to now; DST days
    are 23 or 25 h. A segment is `unknown` where M1's coverage says so
    (absence candidates included; this wins over any claim), `didNotWork`
    where coverage is complete and no entry claims it, `worked`, `worked`
    - `duplicate` (same project twice), or `conflict`: "unclear which
      project" (different projects, "no project" included) or "unclear
      whether worked" (work overlapping a break, holiday or time off). Each
      segment lists why it would not be editable (running, locked, entry
      type, custom fields, and `worked(none)` under `forceProjects`).
      Sorted throughout, so equal mirrors give equal timelines.
  - _View model_: `app/model/source.ts` fills the #89 views' `Timesheet`
    hooks from it: `unknown` (the window's unknown spans) and `conflicts`
    (`app/timeline/types.ts` `TimelineConflict`: the views' `Conflict` plus
    kind, span, entries and candidates). `app/ui/coverage.ts` renders them
    as a "Not loaded" note and a "Conflicts in Clockify" list, whose
    resolve buttons (M4, above) appear once connected and synced.
- **Errors.** If the window's first page fails, the pass fails and rows
  are not touched ("Import failed: …. Rows already in the table are
  kept."). If a later page fails, what was read is kept as an incomplete
  observation (no absences, no coverage) and the pass fails the same way.
  A failing re-check `GET` is a warning; the candidate is re-checked next
  time. A 403/404 on projects or users is a warning, and rows keep raw ids.
- **Checked against a live account** (2026-09-24, findings on #123; the
  mock models them): the list's bounds as wall-clock time in the profile
  time zone, the filter on an entry's start in `[start, end)`, newest
  start first with `Last-Page`, a running timer from `PUT` without `end`,
  400 for GET of a deleted entry and 404 for DELETE of one, overlapping
  entries allowed, instants truncated to whole seconds, and 400 without a
  project under `forceProjects`.
- **Not verified live:** how Clockify resolves a bound inside a repeated or
  skipped DST hour (the app assumes the reading that covers least), that a
  deletion between pages really skips an entry (inferred from the order),
  custom fields, and locked entries. Whether atomic-server accepts a
  snapshot of ~1 MB (about 2,000 entries) in one commit is not checked.
  Two devices saving the log head at the same instant (within one
  read-write round trip) can still drop one's diffs from the head: there
  is no compare-and-swap on `/app-write`. The next sync's reads restore
  the mirror, but those diffs are no longer replayed.

```sh
# from an atomic-server checkout with this repo's integrations/ in place (AGENTS.md)
node integrations/tooling/run-lane.mjs timesheets               # typecheck + unit
node integrations/tooling/run-lane.mjs timesheets --tier e2e    # real host + mock proxy
node integrations/timesheets/app/build.mjs                      # -> app/dist/ui.js (git-ignored)
```

### What is verified, and how

- **Unit** (`app/*.test.ts`, mock fixture `fixtures/clockify/scenario.mjs`
  through an in-memory store that rejects unknown properties like the host
  does): setup, schema creation, window, paging, idempotency, updates,
  failures. The shared classes (#177): rows as `time-entry-v1` with
  project and person links and a Projects row per active project
  (`app/sync.test.ts`), the first open moving a 0.4.0 table in place with
  an unsent edit kept, and the app as a read-only view of another
  `time-entry-v1` table (`app/adopt.test.ts`). The observation log's #123 scenarios S1–S5, S8 and S27
  (`app/observationLog.test.ts`), and fold property tests over 40 seeded
  random observation sets (`app/observations.test.ts`): appending equals
  refolding, any permutation folds the same, snapshot + tail equals the
  full fold, two devices' diffs fold the same, fields equal the latest read.
  The timeline's #123 scenarios S1, S6 and S7 (display only), conflict
  kinds, `forceProjects`, the DST days of 29 March and 25 October 2026 in
  Europe/Amsterdam, the rendering hooks, and the merge property over 40
  seeded observation sets (any fold order and record order gives equal
  segments and conflicts) are in `app/timeline/timeline.test.ts`.
  Write-back (#123 M3): the lens's get/put, blockers and a PutGet property
  over 40 seeded edits against the mock's `PUT`
  (`devonian/clockify/lens/writeBack.test.ts`); bookkeeping on the row,
  compare on open, Clockify winning a both-sides change, and #123's S9
  (as a field edit), S13, S14, S16–S18, S20, S23–S26, deletes, project
  linked by hand (resolved by name) and `forceProjects`
  (`app/writeBack.test.ts`); the controller's edit/delete/discard/send
  (`app/controllerViews.test.ts`); and the drawer's edit form through to
  a send in the DOM (`app/ui/ui.test.ts`, frames N1 and N2).
  Range edits (#123 M4): the planner's cases, refusals, S11 and S12 as
  plans, and the §5.3 planner property over 200 seeded random mirrors of
  up to 20 entries (target holds over the range, nothing changes outside
  it, no instant is claimed more often mid-plan than before or after,
  every `PUT` carries `end`; `devonian/clockify/lens/rangePlan.test.ts`);
  S6 and S7 (resolution), S9 as a range split, S10, S11, S12, S15, a
  failed create sent again, a create refused where Clockify has time by
  then, Discard of a new row and the refusals, against the mock through
  the controller (`app/rangeEdit.test.ts`); and the resolve buttons and
  the range form through to a send in the DOM (`app/ui/ui.test.ts`).
  Two open copies (#123 M5): S21 (the same range, and the same entry,
  edited apart; held on both devices; resolved), equal edits made apart,
  S22 and its refusal, and the send lease (refused while held, sent once
  expired, kept through a batch longer than 60 s, lost mid-batch, a sync
  leaving another copy's unconfirmed create alone) in
  `app/multiDevice.test.ts`; S28 (two devices compacting at once, and one
  compacting while the other appends, in both orders) in
  `app/observationLog.test.ts`; the "between your edits" list text in
  `app/timeline/timeline.test.ts`.
- **Host e2e** (`e2e/clockify.spec.ts`, the `timesheets` lane's `e2e` tier)
  against the pinned atomic-server (`.atomic-server-ref`, which includes
  frame capabilities from atomic-server#1697) and the local mock proxy,
  which checks the proxy's 0.2 signatures: install from the catalog's
  Drive apps section (the committed `apps/timesheets/<version>/ui.js`, served
  by the lane's dev-server), connect through the consent bar, setup in the
  frame, Property and row writes through the
  real `/app-write`, 2 completed entries imported (running timer and break
  not), reopen with no duplicates, a changed entry updated in place, the
  window start moving forward between runs (from the mock's request log),
  7 → 30 days adding exactly the older entry, and a 503 that leaves the
  three rows readable in the table and recovers on reopen; then an M2
  "unclear which project" conflict and not-loaded time in the #89 views.
  A second test (#123 M3) edits an entry's description and project in
  the drawer, checks nothing is written before Send and that the edit
  survives a reload, sends it as one `PUT` through the host's frame
  client and the mock proxy's catalog check, reopens with the row in
  agreement, and sees the refusal of a proxy whose catalog lacks the
  write overlay. A third (#123 M4) resolves an "unclear which project"
  conflict with "Keep Atomic plugins" and marks a free hour "Worked on
  Research" in the range form, checks nothing is written before Send and
  that both survive a reload, sends them as a `DELETE` then a `POST`, and
  reopens with one row for the new entry and nothing left to send.
  From 0.5.0 (#177): `beforeAll` checks GitHub Pages serves
  `time-entry-v1`, `work-project-v1`, `work-person-v1` and their properties
  with the committed bytes (`ontology-kit/served.mjs`), since the real
  Pages subjects are used, never rewritten; the first test checks the
  table is `time-entry-v1` with the published columns and that a row
  links to its "Atomic plugins" project row and "Test Person" person row;
  a fourth makes a `time-entry-v1` table by hand, adds the app to it under
  Add view (read only) and sees its entry and linked project, with
  nothing written to that table.
  Provider changes
  and failures are driven through the mock proxy's local-only
  `POST /__fixture/clockify`.
- **Mock endpoints** (`app/fixture.test.ts`, #123 M0), modelled on
  Clockify behaviour checked against a live account on 2026-09-24 (the
  findings on #123), not on a recording:
  - lists: `start`/`end` are wall-clock time in the user's profile time
    zone (`GET /user` → `settings.timeZone`, Europe/Amsterdam by default
    here); a `Z` or offset is required but ignored; the filter is the
    entry's start in `[start, end)`; newest start first, with `Last-Page`;
  - `GET` one entry, and a 400 "Time entry doesn't belong to Workspace"
    for a deleted or unknown id; `DELETE` of a deleted one is a 404;
  - `POST`, and `PUT` as full replacement (`start` required, fields left
    out cleared, no `end` makes a running timer), instants truncated to
    whole seconds, a 400 without `projectId` when the workspace's
    `forceProjects` is on; overlapping entries are allowed;
  - not checked live, the mock's own choices: 400 on a locked entry, and
    how a wall-clock bound in a repeated or skipped DST hour resolves
    (as java.time's `atZone`);
  - a 404 for any operation the catalog document does not declare, as the
    proxy answers.

  Test switches on `POST /__fixture/clockify`: `settings` (`timeZone`,
  `forceProjects`), `forbid` (403 without applying), `catalog`
  (`readOnly`: the catalog before the write overlay), `applyThenDrop`,
  `failBefore`, `onNextRequest`, `deleteDuringPaging`, `add`, `delete`.
  The project list has a second active project and an archived one, so a
  project change and its refusal are testable.

- **Live check kit (not yet run).** `node integrations/tooling/live-check.mjs
timesheets --i-understand-this-writes-to <workspace id>` runs this app's
  controller against one dedicated Clockify test workspace, including the #123
  POST, split-copy and `billable` checks, and writes evidence; see
  [The live-check kit](../LIVE_TESTING.md#the-live-check-kit).
- **Not verified:** a real integration proxy or a real Clockify account.
  The `/api/v1/...` paths match the mock fixture, not a recorded live
  response. No live evidence is recorded, so every capability here is
  declared, not verified.

### Known host limits (atomic-server)

Read from the pinned atomic-server, and reproduced by the e2e where noted.

- **Stale reads after an app write**: fixed at the current pin. Earlier
  pins kept the page's pre-write copy of a row after an `/app-write`, so a
  second sync in the same page re-saved its own last write. The pin
  (`2f403624e`, with atomic-server#1690) re-reads a resource after an app
  saves it; the e2e now runs "Sync now" twice in one page without reopening.
- **Local-first reads on open** (reproduced, intermittently). The host
  reads memory, then its local database, then the server, so right after a
  reload the App can come back without settings saved moments before. The
  app subscribes to the App and, while it is still asking for settings,
  re-reads them when the host reports a change.
- **Removing a value.** Earlier pins dropped `resource.remove()` in the
  frame. The current pin sends it as an `/app-write` `remove`
  (atomic-server#1690). Since 0.5.0 the app removes values: the old fields
  of a row it moves onto `time-entry-v1`, and a row's project link when the
  project goes. The e2e reaches the first only on an install from before
  0.5.0, which it does not make; the unit tests model `remove` in the fake
  store.
- App writes are signed by the node that holds the app's key, so they work
  on one node only for now (#41).

### What still has to happen

Done since this list was written: the catalog install (Drive apps,
`apps/timesheets/0.1.0/ui.js`), and, from atomic-server 007869464 (in the
pin), Disconnect (`store.proxy.disconnect`), "Open Clockify" through
`store.openExternal` and "Open row in Atomic" through `store.openResource`,
each feature-detected. The data-browser's LocalThought-extension path was
removed upstream (`c707ca4ed`).

1. **Multiple devices**: done as #123 M5 (0.4.0), mock-tested only; not
   tried with two real browsers. Splitting snapshots per week, if a
   commit of ~1 MB turns out too large, is not done.
2. **Live evidence**: a run of the app against a live account through the
   real integration proxy, in a dedicated test workspace. For write-back
   that includes #123 §5.4's checks: full-replacement `PUT` (a field left
   out is cleared, `end` omitted makes a running timer), the status for
   writing a locked entry, the custom-field request shape, and the
   `start`/`end` list semantics once more; for M4, a `POST` of a new
   entry and of a split's copy (tags and task carried over), and what
   `billable` a project's list entry carries. Until then the card's
   capabilities are declared, not verified.
3. **Pruning** `localthought.ts` to what `app/` imports.
