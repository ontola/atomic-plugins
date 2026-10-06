# Notion ↔ Atomic

Everything Notion-specific lives in this folder. atomic-server keeps no
Notion code (branch `claude/remove-notion-code`). There are two paths:

- **Drive plugin on syncables and Devonian** (`app/`, two-way after
  review since 0.2.0; a sync-status view, not a browsing view, since 0.3.0,
  per #177 Q9). This is the direction for #8 and #68: an iframe
  plugin that reads Notion through
  `syncables/browser` over the host's integration-proxy relay, and maps it to
  Atomic rows through a Devonian lens (`devonian/notion/`). It is the one
  with an entry point: the `notion` catalog entry (experimental; published but disabled pending launch: the catalog entry carries the module and its integrity with `enabled: false`, so the Integrations page does not offer it yet; the lanes' dev-server serves it enabled (`DEV_SERVER_ENABLE_APPS`), which is how the e2e installs it) installs it
  from the Integrations page's **Drive apps**, downloading
  `apps/notion/<version>/ui.js` from GitHub Pages and checking it against the
  entry's integrity hash (see
  [Publishing a drive app](../README.md#publishing-a-drive-app)). Its version
  is this folder's `package.json` version, shared with the sandbox plugin, so
  a release of either bumps both. After a bump, write the module with:
  `node integrations/tooling/apps.mjs write notion`.
- **Sandbox plugin** (`plugin.ts`, two-way, the pilot). It runs in atomic-server's
  QuickJS/WASM plugin runtime. It has no entry point in the data-browser
  today. Its field and view coverage is wider than the drive app's (page
  creation, property renames, table/board views), but nothing can run it.

API version `2026-03-11` throughout. Planning notes from the pilot moved
here from atomic-server and are under [`planning/`](planning/).

## Drive plugin on syncables (`app/`)

This plugin works the way `timesheets/app/` (#20) and `pets/app/` (#52) do.
It is one ES module whose `view({ root, store })` reads through
`syncables/browser` over `store.proxy`, the host's relay to the integration
proxy. No credential ever reaches the frame.

- `app/main.ts`, `controller.ts`: "Connect Notion" asks the host to connect
  (`store.proxy.connect`). Once a connection exists, the app reads the rows
  already in the drive (`rows.ts`, to compare them with their baselines) and
  syncs in the background when the last sync is unknown or older than 15
  minutes, and on "Sync now". The controller's states (importing, syncing,
  no databases, reconnect needed, rate limited, failed) are classified by
  HTTP status (`errors.ts`). The last sync record (counts, per-database
  schema with option names and colours, grouped warnings) is a JSON string
  property, `notion-sync-record`, on the data table resource (`record.ts`).
- `app/view/`, `app/ui/`: a small **sync-status view** (#177 Q9, since
  0.3.0): header with the status pill and "Sync now"; a connection bar with
  the database count, "Sync details" and a menu (Choose pages in Notion,
  Open data table, Disconnect Notion…); the state's banner; the "N changes
  not sent to Notion yet" strip with its Review sheet (`view/review.ts`);
  then, since 0.5.0, the shared sync-status card first
  (`integrations/sync-status/`, Q-084; the mapping is `view/status.ts`,
  pure, one unit test per state in `view/status.test.ts`): when the last
  sync ran and how it went (a failed sync names the last good one), its
  added/updated/unchanged counts, the row total, whether edits go back
  ("Edits here are sent to Notion after you review them.", or read-only
  with the reason when there is no connection or no proxy), the write queue
  (changes waiting, held back by a conflict or a refused value, the last
  Send's failures with their reasons, a PATCH that stood but could not be
  confirmed here, sends without an answer, sends that wrote nothing), the
  record's warnings and a "N notes from the last sync" line that opens Sync
  details; and right below it the databases block (`view/parts.ts`,
  `renderDatabases`): the databases the table syncs with and their row
  counts, when the last sync ran and how long it took, and an "Open table"
  button. Notion's writes do not go through syncables' `pendingWrites()`,
  so the card is fed from the review list and the send outcomes, as in
  Clockify.
  People browse and edit the rows with the host's own table and views; the
  app renders no rows. The #89 browsing views of 0.1.0–0.2.0 (table, board,
  list, database chips, side peek, search, sort; `design/DESIGN.md`,
  `design/mockups.html`) were removed in 0.3.0. `app/ui/` is the shared
  plugin shell (`pl-*` tokens mapped from the host's `--t-*` theme), kept
  free of Notion specifics so it can move to a shared kit.
- `app/transport.ts`: syncables' `Transport` over `store.proxy.request`. It
  sends the provider path (`/v1/search`), the method and the JSON body, and
  refuses any URL outside the document's `https://api.notion.com/v1`.
- `app/sync.ts`: host I/O only; every Notion-to-Atomic mapping is in the
  lens (see [Lens](#lens-devoniannotion) below).
  - `readPlatform` over the bundled `catalog/notion.json` lists every data
    source shared with the connection (`POST /v1/search`), then pages through
    each one's pages (`POST /v1/data_sources/{id}/query`, `start_cursor` in
    the body).
  - Pages go through `notionProjection` one data source at a time, and
    `notionColumns` derives the columns from what was read.
  - It finds or creates one Property per column under the row class's
    ontology and binds the lens to them.
  - Per page: an existing row (found by the Notion page id column) is seeded
    into the lens store, the page is `ingest`ed through the data source's
    Devonian `AtomicLens`, and the lens row's values are written back to the
    host row, removals included. New pages become new rows.
- `app/changes.ts`, `app/send.ts`, `app/view/review.ts`: two-way edits
  after review (#8, #177 Q4–Q7), described in
  [Edits and sending them to Notion](#edits-and-sending-them-to-notion).
- `app/options.ts`: Notion options as the host's select columns and Tags
  (0.4.0; see the limits below for the shape), and the translation between
  option ids and Tag subjects that `sync.ts`, `rows.ts` and `send.ts` apply
  at the host boundary.
- `app/build.mjs`: `dist/ui.js`, minified (JS and CSS), 124,966 bytes for
  0.5.0 (115,818 for 0.4.2; 113,988 for 0.4.1; 113,536 for 0.4.0; 107,509 for 0.3.0; 133,028 for 0.2.0, with the browsing views), including the catalog
  document, syncables' read path, devonian's Atomic Data API and the shared
  sync-status card with its `card.css` (through `cssRawPlugin` from
  `integrations/sync-status/build.mjs`). `@tomic/lib` is shimmed, as in timesheets (`Datatype` and
  `validateDatatype` only; `build.test.ts` pins both to the real library).
- Dependencies: `syncables@0.19.0` and `devonian@0.6.1` from npm, exact
  versions in `package.json`, locked in `pnpm-lock.yaml`, installed into this
  folder's `node_modules/` (`pnpm install --frozen-lockfile` here; CI's
  "Install plugin npm dependencies" step does it for every
  `integrations/*/pnpm-lock.yaml`). This repo's `syncables/` and `devonian/`
  sources are not used. Only devonian's `src/atomic/` is imported, by path
  (`devonian/notion/lens/devonian-atomic.ts`): the package root also exports
  `DevonianClient`/`DevonianTable`, which import `node:events` and Automerge
  and cannot go into the bundle, and 0.6.1's `exports` has no subpath for
  `src/atomic/`.
- `catalog/`: the composed catalog document, its provenance and
  `generate.py`. The overlays themselves are in
  `overlays/APIs/notion.com/2026-03-11/`; see [`catalog/README.md`](catalog/README.md).
- `fixtures/notion/`: an authored mock-proxy fixture serving
  `catalog/notion.json`. It pages the query two rows at a time, so the last
  row is only reachable by sending `next_cursor` back in the body, and
  applies page `PATCH`es as Notion documents them (no other write).

What it does not do, and what is not verified:

- It updates existing pages only. A row added in the table has no Notion
  page id and is never sent (#177 Q6: hand-added rows stay local; there is
  no "Publish to Notion"). Nothing is deleted on either side: a page that
  disappears or is archived in Notion is left in place here, and a row
  deleted here is imported again on the next sync (the host has no change
  list with tombstones yet, #177 H6).
- A value cleared in Notion (empty number, URL, select) is removed from its
  row on the next import, unless the row changed that field itself (see
  below). A value the lens cannot read losslessly (formatted text) leaves the
  row's value as it was, is listed in the warnings, and is never sent.
- Select, status and multi-select columns are the host's own select
  columns since 0.4.0 (`app/options.ts`): the Property `isA`
  SelectProperty, datatype `resourceArray`, `classtype` Tag, `allowsOnly`
  listing one Tag per Notion option in Notion's order, `max` 1 for select
  and status. Each Tag is a child of the column's Property with `shortname`
  (a slug of the option name), `name` (Notion's name), `color` (a hex for
  Notion's colour name) and `notion-option-id`. The host's table shows the
  Tags' names as coloured chips and its cell editor offers exactly those
  Tags; a rename or recolour in Notion updates the Tag on the next sync and
  rewrites no row, so the value stays keyed by the option id. The lens, the
  baseline, the review and the send still work in option ids; `options.ts`
  translates at the host boundary. 0.1.0–0.3.0 stored the ids themselves
  (the table showed UUIDs); the first 0.4.0 sync upgrades such a column in
  place and rewrites its rows, and an edit made before that upgrade (a raw
  id in a cell) is still read as that option, so nothing waiting for review
  is lost. The pinned host's select cell does not enforce `max`: a status
  cell given two Tags is held back in the review ("takes one option").
  Whether the host's chips and cell editor behave as the e2e shows against
  a real Notion schema is not verified.
- All shared data sources go into one table, with their columns merged. A
  "Data source" column says where each row came from.
- The columns are the four fixed ones (Notion page id, Data source, Notion
  URL, Last edited in Notion) plus one per Notion property the lens
  projects (`notion-<hex of the property id>`). Nothing else: syncables also
  derives one term per field of the Page schema (`object`, `id`,
  `created-time`, `last-edited-time`, `title`, `properties`, `parent`,
  `url`, `archived`, `in-trash`), and 0.1.0–0.4.0 made a column of each,
  named by its raw term path (`…/property/object`), always empty
  ([#303](https://github.com/ontola/atomic-plugins/issues/303)). Since
  0.4.1 `notionColumns` takes only the projection's own terms, and the
  first sync of an upgraded install retires such a column: off the class's
  `recommends` and the ontology's `properties`, then destroyed. Only a
  Property with exactly that auto-made name and shortname, and only when
  no current column binds it; a column a person added (another name) and
  the rows are left alone. Verified in the fake store and the e2e, not on
  an upgraded live install.
- The e2e shows the pinned host lets the app add Properties under its
  ontology and add them to its class's `recommends` (it checks the column
  datatypes). Only the fake store covers later edits to them.
- It depends on `store.proxy` (`request`, `connections`, `connect`). Since
  #54 phase 2 (ontola/atomic-server#1697, pinned) the host's frame client
  calls the proxy itself with a capability and its own key.
  Without it, the app says so and fetches nothing.
- The e2e runs against the mock proxy (see below). Nothing here has run against live Notion
  or a real proxy.
- "Open table" and the menu's "Open data table" use `store.openResource`;
  "Disconnect Notion…" uses `store.proxy.disconnect` (rows are kept); rows
  load with `store.getMany` in batches of 100; the host's `colorScheme` sets
  the app's `color-scheme`. All since atomic-server 007869464, and each is
  feature-detected: on an older host the app falls back (no Open table
  button or menu entry, one `getResource` per row). The app opens no links
  itself since 0.3.0: a row's "Notion URL" column is in the host's table.

## Edits and sending them to Notion

Since 0.2.0, per #177's decisions (Q4–Q7: edits made anywhere reach the
provider, bookkeeping on the row, compare on open, review before send). Not
verified against live Notion or the real integration proxy.

- **Bookkeeping on the row.** Each synced row carries
  `notion-sync-baseline`: JSON of the data source id and, per editable
  column, the value Notion and the row last agreed on. Its Property is in
  the app's ontology but not in the row class's `recommends`, so it is not a
  column. Keys are the column shortnames, which come from Notion's stable
  property ids, so renames on either side leave it as it was. A row imported
  by 0.1.0 has none; its first 0.2.0 sync takes Notion's values (as 0.1.0
  always did) and writes one. The baseline holds option ids for select
  cells, whatever Tag the cell holds (`options.ts`).
- **Compare on open.** Whenever the app reads the rows (on open, after a
  table change it is subscribed to, after a sync), it compares each row with
  its baseline (`changes.ts`, no request to Notion). Any difference is an
  edit, wherever it was made: the app's table, another view, another
  device. A renamed row counts as a title edit. "N changes in M rows not
  sent to Notion yet" then shows above the rows.
- **Sync is three-way per field** (`sync.ts`, `compareOnSync`): a field only
  Notion changed takes Notion's value; a field only the row changed is kept
  and stays in the review; a field both changed to the same value is
  agreed; a field both changed differently is a conflict, and neither side
  is overwritten. Fixed columns (page id, URL, last edited, data source)
  always follow Notion.
- **Review before send.** "Review changes" lists each row's fields as
  before → after, with option names and colours from the last sync's
  schema, and Discard per row. A conflict shows Notion's value with "Keep
  mine" (the baseline moves to Notion's value, so the row's value is sent
  over it) and "Use Notion's". A value Notion would refuse (an option id the
  schema does not have, the wrong type) is held back and named. Nothing is
  sent until "Send N changes".
- **Sending** (`send.ts`), one row at a time: `GET /v1/pages/{id}`, then
  `PATCH /v1/pages/{id}` with only the changed properties, keyed by Notion's
  property id, values from the lens's reverse mapping
  (`notionPropertyValue`: text in 2000-character parts, options by id).
  It is not sent, and says why, when the page is gone, archived or in trash
  (the row is kept); when Notion changed a field to send since the baseline
  (it becomes a conflict); when Notion holds formatted text in it (never
  overwritten with plain text); or when Notion refuses it (400). The
  baseline and the row advance only from the page Notion answers with.
- **Limits.** Notion has no conditional page updates (no ETag or If-Match),
  so an edit made in Notion between the GET and the PATCH, one round trip,
  is overwritten. A PATCH whose answer is lost is reported as "Unknown
  whether Notion applied it" and the batch stops; the next sync shows what
  Notion has. A proxy refusal, a 429 or a 5xx also stops the batch. Nothing
  is sent while the app is closed (no `afterCommit` hook at the pin).
  Conflicts are kept in memory until the next sync finds them again from
  the baselines. The Notion integration needs Notion's "Update content"
  capability; whether a given OAuth connection has it is not verified.

Declared by unit tests (`app/twoway.test.ts`: reconcile cases, compare on
open, sync merges, send, conflict both ways, archived page, formatted text,
refused option, lost answer, discard; `app/view.test.ts`'s S15/S16 block)
and the e2e (below). Not live-verified.

**Live check kit (not yet run).** `node integrations/tooling/live-check.mjs
notion --i-understand-this-writes-to <data source id>` runs this app's
controller, including a reviewed edit sent as a `PATCH`, against one
disposable data source and writes evidence; see [The live-check
kit](../LIVE_TESTING.md#the-live-check-kit).

## E2E

`e2e/notion.spec.ts` drives the drive plugin the same way the pets spec does:
an install from the catalog's Drive apps section (the committed
`apps/notion/<version>/ui.js`, served by the lane's dev-server), then Connect, the
host's consent bar and the mock proxy's consent page, then the shared
sync-status card ("Synced", "3 rows in this table", "Edits here are sent to
Notion after you review them."; later "Sync failed" with the last good sync
and, after Disconnect, "Read-only: edits here stay in Atomic.") and the
databases block (the database, no table in the frame), the 3 rows in
the host's table with their Status and Tags shown by option name (0.4.0),
and the columns' datatypes and select-column shape. It then walks the app's states
against the fixture's scenarios (`setScenario`, `renameOption` drivers): a
second database on the card with its own count, sync details, a renamed
option (seen in the host's table, then in the Review sheet after a Status
edit made in the host by setting the option's Tag, then discarded), rate limited, failed, nothing shared and revoked access, "Open
table", and Disconnect, saving a screenshot of each as a test artefact. It
runs against the shared mock proxy's `notion` fixture (`fixtures/notion/`),
so the lane has `platforms: ["notion"]` and `tiers: ["live", "e2e"]`. It
needs an `.atomic-server-ref` with frame capabilities
(ontola/atomic-server#1697; the pin `11264e83e` has it). Since 0.2.0 it also
edits a row's Points from the host page (a user's commit, the way the
calendar and issue-tracker specs edit rows outside their apps), reloads,
finds the edit under "Review changes" with no Sync, sends it and checks the
fixture's page (`getPage` driver); then makes a conflict with the `editPage`
driver and resolves it with "Use Notion's". The fixture applies
`PATCH /v1/pages/{id}` as Notion documents it (400 for unknown options,
archived pages, wrong type keys).

## Lens (`devonian/notion/`)

Every Notion-to-Atomic transformation the drive plugin uses is here, in
three layers. Nothing in it touches the network or the host store.

`lens/projection.ts`, `notionProjection`, maps the data-source pages
syncables read (`resource: 'page'`) to typed values. Each value is keyed by
`notionFieldShortname(propertyId)`, a hex encoding of the case-sensitive
Notion property id.

- Covered: plain title/rich text, number, checkbox, url, email, phone,
  select/status option id, and sorted multi-select option ids.
- Notion `null` leaves the key absent; `0`, `false` and `[]` are kept.
- Formatted text, mentions and links are left unprojected and listed in
  `errors`. So are archived or trashed pages (`in_trash` or `in-trash`).
- The raw `properties` object passes through.
- It throws on a page outside the given data source, or on a property whose
  type changes during one fetch.
- `notionPropertyValue` is the reverse of `notionFieldValue`: text split into
  2000-character parts (more than 100 parts throws), options by id, and an
  absent value as Notion's empty for the type.

`lens/columns.ts` is the schema: `NOTION_FIXED_COLUMNS` (page id, data
source, URL, last edited), then one column per projected property, named
after the Notion property (`notionColumns`), and data-source titles.

`lens/atomic.ts`, `NotionRowLenses`, is the Devonian lens proper: one
`AtomicLens` from the npm `devonian` package per data source, over an
`AtomicStore` and `AtomicIdentityMap` scoped by the data source's Notion URL
and keyed by page id.

- `read` (page to row): sets the name, the fixed columns and every projected
  value; unsets a property Notion holds empty; leaves a property with no
  lossless plain value alone.
- `write` (row to page): the page with each bound property replaced by the
  row's value and every other property passed through. It throws rather
  than overwrite formatted text it never read, and refuses to create pages.
  Nothing calls it against Notion yet.
- The lens store uses its own subjects and property URLs under
  `https://notion-lens.invalid`. devonian accepts only HTTP(S) and DID
  identifiers, and atomic-server's are `atomic:...`, so `seed` and `toHost`
  translate to and from the host's Property subjects. The host row keeps its
  own identity (the page-id column). The identity map lives for one import
  and is not persisted.

`localthought.ts` re-exports the projection together with
`notionDataSourceQuery`.

## Sandbox plugin (`plugin.ts`, two-way pilot)

`plugin.ts`/`model.ts` are unchanged. They run in atomic-server's generic
QuickJS/WASM plugin runtime. They have had no UI entry point there since
atomic-server `4bab16ee6` removed `ConnectNotion`, and a catalog install runs
neither the installer (`atomic.ts`) nor a sync (#68). The live tier still
runs. `host/` (`async-plugin.ts`, `browser-sync.ts`) is its browser host,
moved here from `localthought/` because Notion was its only user.

The drive app's two-way edits (0.2.0, above) cover page property updates:
`PATCH /v1/pages/{id}` through the same relay, page-id identity, and a
missing page treated as a conflict. They are not journalled: the review is
the gate, and a lost answer stops the batch rather than being retried. The
lens's whole-page `write` is still not called; the app maps per field with
`notionPropertyValue`. What the pilot has and the drive app does not: page
creation, property and view renames, table/board view sync. Retire
`plugin.ts` only once the drive app's writes have live evidence.

### Supported subset

- Row creation and editing in both directions: plain title/text, number,
  checkbox, URL, email/phone and existing select/multi-select/status options.
- Stable Notion page, property and option IDs. Property renames sync
  separately from row values and do not rename shared canonical Atomic
  properties.
- Atomic's display name and the mapped title column reconcile against a
  shared baseline. Conflicting local edits to both are reported, not
  silently resolved.
- Existing compatible table/board views: name, visible columns and their
  order, and mapped option grouping. View renames and column edits have
  independent baselines.

A patch contains only the mapped properties that changed. Null removes an
optional Atomic value; false, zero and empty arrays keep their distinct
meanings. Long plain text is chunked without truncation. Sync pauses before
any unsafe write on: rich text formatting or mentions, changed field types,
option identity/name drift, unknown option values, and missing pages.
Uncertain remote creates use host journals and cannot be blindly retried.

### Explicit limits

- A restricted, disposable personal Notion database passed a live UI import
  and title edits in both directions through the sandbox. Broader field and
  view fidelity is uncertified.
- One selected data source. New fields, views and options need a reviewed
  mapping refresh, which is not implemented.
- Filtered/sorted views, status-group boards, subtasks and subgroups are
  skipped at setup. Formula, rollup, relation, date, file and person fields
  are preserved in Notion and not synced.
- Full scans, a 100-page cap, and no incremental checkpoints or webhook
  intake. Rate limits pause the run.

## Tests

From the repository root, with the AGENTS.md layout, after installing this
folder's npm dependencies once:

```sh
(cd integrations/notion && pnpm install --frozen-lockfile)
./browser/node_modules/.bin/vitest run --config integrations/notion/vitest.config.ts
./browser/node_modules/.bin/tsc -p integrations/notion/tsconfig.json
node --test integrations/localthought/mock-proxy.test.mjs
node integrations/notion/app/build.mjs
./browser/node_modules/.bin/esbuild integrations/notion/plugin.ts --preserve-symlinks --bundle --format=esm --platform=neutral --target=es2022 --outfile=integrations/notion/plugin.js
```

Optional sandbox installer test against a disposable local AtomicServer, with
simulated Notion metadata and no external Notion calls:

```sh
ATOMIC_NOTION_TEST_SERVER=http://localhost:9898 ./browser/node_modules/.bin/vitest run --config integrations/notion/vitest.config.ts
```

Sources: [page values](https://developers.notion.com/reference/page-property-values),
[data source queries](https://developers.notion.com/reference/query-a-data-source),
[search](https://developers.notion.com/reference/post-search),
[view configuration](https://developers.notion.com/guides/data-apis/working-with-views).
