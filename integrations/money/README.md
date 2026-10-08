# Bank statements (MT940 and camt.053)

## Setup

This needs an atomic-server with the generic file entry point
(atomic-server#1653: manifest `accepts` and `destination`, and the Import tab
on a plugin's page; merged as atomic-server#1691). `bc39dac4b`,
the pin when this was first verified, includes it; see [Verified](#verified)
for the pins it was last run against, the current pin `a12b74a` included
(0.4.1, 2026-10-02).

The importer below is one of two ways in. Since 0.4.0 the Money app
(`app/`) also imports statements by itself, into a table of the shared
`bank-transaction-v1` class, after a catalog install: see
[Money app](#money-app-app) and [Shared class](#shared-class-bank-transaction-v1).
The importer stays for drives that use it, and the app works on its table
as before.

1. **Publish** (once per server, by whoever maintains it): create a Plugin,
   replace its source with this folder's `plugin.js`, name it "Bank
   statements", and choose Code → Publish to integration store. There is no
   generic path from this repo's catalog to a server's store for sandbox
   bundles (the catalog install of atomic-plugins#94, closed, covers drive
   apps only), so this step is manual.
2. **Find it**: Integrations → Show experimental plugins → Community
   plugins → Bank statements → Open → Create draft.
3. **Set up**: on the draft's Import tab, choose Set up. This creates the
   banking properties and the Bank transaction and Bank statement classes in
   the drive ontology, and two tables with default views beneath the
   importer: Bank transactions, and Imported statements (one row per
   statement with its reconciled opening and closing balances, through the
   manifest's `destination.tables`, atomic-server#1768). It stores
   `{ table, rowClass, properties, tables: { statements: { table, rowClass } } }`
   as the importer's config, under the key `money`. An importer set up before
   the statements table existed pauses on the missing `tables`; running Set
   up again adds only the missing table.
4. **Import**: choose an MT940 or camt.053 (ISO 20022 XML) file, then
   Preview import, then Apply. The format is detected from the file contents:
   XML is read as camt.053, and anything else as MT940. Nothing is written
   before Apply. Come back to the same Import tab for later files; "Open
   workspace" opens the table.

bunq exports: bank account → Settings → Export statement → MT940.
https://help.bunq.com/en-ie/articles/how-do-i-export-a-bank-statement

## Architecture

`plugin.ts` bundles both readers (`parser.ts` for MT940, `camt053.ts` for
camt.053, dispatched by `statement.ts`) and the mapping into `plugin.js`. The
sandbox has no DOMParser, so `camt053.ts` carries a small namespace-agnostic
XML reader of its own. File acquisition is host UI code: the manifest's
`accepts` entry makes atomic-server draw the file picker, check the size
(5,000,000 bytes, the camt.053 limit) and decode the file (UTF-8, else
Windows-1252). The host hands the result to `run()` as
`ctx.upload = { name, mediaType, size, text }`; `ctx.text` and
`ctx.trigger.payload.text`, which the removed host dialog used, are still
read for one release. Proposal generation runs in the server QuickJS/WASM
host, which supplies scoped query/read access. The manifest's `destination`
(`bankingSchema()` plus the table name, row class and default columns) is
what Set up creates; the plugin itself never creates schema.
No network operations or secrets are declared. File contents are runtime input,
not plugin source. Proposals and approved transactions contain financial data
and are handled by the user's AtomicServer; they are not sent to an LLM.

`app/` is a separate drive app (shape 1 in AGENTS.md), the Money view of a
Bank transactions table ([design](design/DESIGN.md), #89). It never runs in
the QuickJS sandbox. On the importer's table it never writes imported bank
fields: the importer above stays their only writer there. On a table of the
shared class `bank-transaction-v1` (its own table after a catalog install,
or one someone made) it imports statements itself, with the same readers and
identity rules, through the host's frame store (see
[Shared class](#shared-class-bank-transaction-v1)). `app/build.mjs` bundles
it to one ES module exporting `view({ root, store })`, with no stylesheet
file and no network code. It reads the table the host points it at
(`store.getData()`), finds the fields through the table's row class, and
subscribes to the table so rows from a new import appear without a reload.

Amounts are exact signed decimal **strings**, not floating point numbers.
Opening/closing balances are reconciled with integer arithmetic (up to five
fractional digits). Dates have no inferred time zone. Original :86: descriptions
are retained verbatim, including bank-specific structured codes. Bank account
identifiers are preserved, not assumed to be IBANs. Schema term descriptions
record these meanings; this is not a frozen or ISO 20022-certified schema.

Bank references identify transactions within an account, currency and export
format: importing the same period once as MT940 and once as camt.053 yields two
sets of rows, because the two formats carry different narratives and a shared
identity would surface that as a conflict instead. A changed reference payload
blocks the import. Without references, statement metadata and
line position identify records; content fingerprints block ambiguous overlap
with earlier exports. Identical legitimate rows within a statement are retained.
Import is append-only: local edits are not overwritten. Deleted imports may be
recreated on another import. Native `localId` identities are unique within the destination on one AtomicServer: a
concurrent duplicate create is rejected and must be previewed again. The shared
`importBaseline` records source values and protects local edits. Independent
offline peers still need collision resolution after synchronization.

## Supported scope and gaps

- Up to 500 entries; MT940 up to 512 KB (UTF-8 or Windows-1252 text), camt.053
  up to 5 MB (UTF-8 XML, which is what ISO 20022 mandates).
- MT940: :20:, :21:, :25:, :28:/28C:, :60F:/60M:, :61:, :86:, :62F:/62M:, :64:, :65:.
- camt.053 (.001.02 through .001.08 element names): one or more `Stmt` per
  `BkToCstmrStmt`; `Acct/Id` IBAN or `Othr/Id`; `OPBD` (or `PRCD`) and `CLBD`
  balances, reconciled against the booked `Ntry` amounts; `BookgDt`/`ValDt` as
  `Dt` or `DtTm`; `BkTxCd` domain/family/sub-family or proprietary code;
  `AcctSvcrRef` as bank reference, `EndToEndId` (when provided) or `NtryRef` as
  reference; counterparty name and account, `RmtInf` lines, `AddtlTxInf` and
  `AddtlNtryInf` as the narrative. Entries with a status other than `BOOK` are
  left out, since only booked entries move the booked balances. A batch entry
  with several `TxDtls` stays one row.
- Credit/debit reversals, optional booking dates (value date fallback), multiple
  statements/accounts, multiline transaction narratives.
- Unsupported fields, missing balances and reconciliation failures block import.
- JSON-shaped narratives are rejected because legacy storage reinterprets those
  strings. This needs a general text-preservation fix before enabling them.
- No live bank access, payments, CSV/PDF, counterparty extraction or categorization.
- Amount columns cannot yet use numeric table aggregation; an exact decimal
  datatype/table formatter is a follow-up.
- Historical: a supplied real bunq statement with 272 transactions passed
  preview, apply and zero-change reimport locally on 2026-09-11, through the
  since-removed `ImportMT940` upload dialog. Private bank data is not committed. Synthetic fixtures
  test format behavior; this does not establish compatibility with every bank's
  dialect.
- `money-category` and `money-note` (the person's own category and note,
  edited in the Money app) are declared on the Bank transaction class but
  never written by the importer, so a reimport leaves them alone
  (`plugin.test.ts`). The category is free text; a Category resource was
  the alternative (issues.md M-5) and is not built. Installations set up
  before these properties existed do not have them: running Set up again
  goes through `ensureSchema`, which creates missing terms by `localId`,
  but whether it also adds them to an existing class's `recommends` is not
  verified. Until the class declares both, the app shows Category and Note
  as unavailable instead of writing undeclared properties.
- Set up reuses the table and view (found by `localId` beneath the importer)
  when it runs again after a lost response. Schema creation goes through the
  host's `ensureSchema`, which finds existing terms by `localId`.
- The file entry point is generic (any plugin declaring `accepts`), but it
  takes one text file per preview; no bytes, no several files at once.
- Installation is Create draft from a published release. A reviewed
  Installation (Install instead of Create draft) has no Import tab at this
  host commit.

Reference: https://bankrec.westpac.com.au/docs/statements/mt940/

Tests: `./browser/node_modules/.bin/vitest run --config integrations/money/vitest.config.ts`
(`parser.test.ts` for MT940, `camt053.test.ts` for camt.053 and format
detection, `plugin.test.ts` for the manifest declaration and `ctx.upload`).
Bundle: `./browser/node_modules/.bin/esbuild integrations/money/plugin.ts --preserve-symlinks --bundle --format=esm --platform=neutral --target=es2022 > integrations/money/plugin.js`
Browser: `node integrations/tooling/run-lane.mjs money --tier e2e` runs
`e2e/money.spec.ts` against `ATOMIC_SERVER_CHECKOUT`'s `target/e2e` build.

## Money app (`app/`)

A drive app (DESIGN.md in [`design/`](design/DESIGN.md), #89) that shows a
Bank transactions table as a ledger. It is a view of the table it is opened
on (`store.getData()`): the table a catalog install gave it, the importer's
table (added there with Add view), or any table of the shared class
`bank-transaction-v1`; the table's own Table tab stays next to it. Whose
table it is decides how an import gets in (`controller.ts` `Source`):

| Table                                                                | Rows read as                                                           | Import                                                                                  | Category and note                              |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------- |
| The importer's Bank transactions (`own` to the importer)             | its drive-local `bank-transaction` class, through the lens (`rows.ts`) | through the importer, with the host's review (`store.importer.run`, atomic-server#1774) | after "Allow editing" (atomic-server#1788)     |
| The app's own table, from a catalog install                          | `bank-transaction-v1`, by published subject                            | the app's own writes (`app/write.ts`), no review step                                   | at once: the table is in the app's own subtree |
| Another table of `bank-transaction-v1`, through Add view (#177 §3.0) | `bank-transaction-v1`, by published subject                            | the app's own writes, after "Allow editing" (the grant covers its `row-extras`, #1849)  | after "Allow editing"                          |

- **Transactions**: account switcher (account + currency), a strip per
  account + currency (never summed across currencies) with the latest stored
  closing balance in the period and its date, or the period's net where no
  statement ends in it (never a balance computed from rows), money in and
  out; search over description and reference, period, direction and
  Uncategorised filters, a day-grouped ledger (a table at 560 px and wider,
  a list of buttons below), 200 rows at a time. Amounts are formatted from
  their exact strings (`app/amounts.ts`); sums use `parser.ts`'s `units()`.
- **Incomplete rows** (0.4.1; #177, ontology-kit's rule: show an incomplete
  row, never skip it). A row of the table's class that lacks one of the four
  required fields (account, currency, amount, value date; absent or the
  empty string) is listed in an "Incomplete rows" region above the ledger
  on the Transactions tab, outside its filters, with what it does have, the
  note ("Incomplete: missing Amount", the columns as the class names them)
  and, on a host with `openResource`, "Open row" to the row's page, where
  the column is filled. It is in no balance, total, account list, statement
  or import check: the controller keeps such rows in `state.incomplete`,
  apart from `state.rows`, which is all the ledger sums and `check.ts`
  compares, so an incomplete row with an import's source id is neither
  "already imported" nor a changed booking; the import writes a new row. A
  row completed in the host moves into the ledger on the table's next
  change notification; with only incomplete rows the region sits above the
  first-run invitation. Children of the table that are not of its class (a
  View, say) are not rows and are not listed. At the pin the server refuses
  a commit missing a required property and an empty string is not a date,
  so on this host such a row has an empty account, currency or amount, or
  comes from a lens or another writer. A row with all four fields but an
  amount that is not one stays in the ledger as "Not a valid amount".
- **Detail**: the bank's fields read-only with the verbatim narrative;
  category and note (`money-category`, `money-note`) saved on change. The
  host lets an app edit the rows of the table it views only after the
  person allows it (`rowAccess`/`requestRowAccess`, atomic-server#1788):
  the detail says so up front, saving asks in the host's bar while the typed
  text stays, and a refusal is shown with a way to ask again.
- **Import statement**: checks a chosen or dropped file in the browser
  with the importer's own readers and identity rules (`app/check.ts`,
  `identity.ts`), shows the reconciliation per statement and what is new,
  already imported or blocked, or a designed error, and then imports it:
  on the importer's table through the importer with the host's own review
  (`importer.run`, atomic-server#1774); on a `bank-transaction-v1` table by
  its own writes (`app/write.ts`), one row per new transaction with
  progress in the button, then one statement row. Nothing is written before
  Import. A write that fails midway leaves the rows written so far, which
  the next check of the same file recognises, so a retry writes the rest.
- **Imports**: the stored statements, with period, opening → closing,
  entries and import date: the importer's Imported statements table on its
  table, the app's own (under the App, see below) on a shared-class table;
  on a table without them, one row per statement the transactions came from.
- **Sources**: statement files; Moneybird and QuickBooks shown as not
  available yet.

Each host call is feature-detected (`getMany`, `getTheme`/`onThemeChange`,
`--t-color-success`, `openResource`, `rowAccess`, `importer.run`,
`getData().tables`), so on an older host the app falls back: rows one by
one, a pointer to the importer's Import tab instead of Import, the host's
refusal instead of a save, statements derived from the rows.

Evidence: unit tests with a fake store that models a current and an older
host and the three tables above (`app/*.test.ts`; `app/shared.test.ts` for
the shared class), screenshots and axe from `app/harness/screenshots.mjs`,
and the host E2E tests in `e2e/money.spec.ts` (see [Verified](#verified)):
the second installs the app from the catalog and imports the synthetic
MT940 and camt.053 into its own table by the app's own writes, checks the
rows the server holds (class, subjects, exact strings), the strip's closing
balance and the Imports tab, saves a category with no "Allow editing", and
checks the in-app check (nothing new; a changed transaction blocks); the
third sets up the importer, adds the installed app to its table through Add
view as a read-only view, imports through the host's review, and saves a
category after clicking the host's "Allow editing".

Catalog: the `money` entry in `integrations/catalog.json` carries the app
(`app-module` `apps/money/<version>/ui.js`, the same version as this
package; see [Publishing a drive app](../README.md#publishing-a-drive-app))
with `enabled: false`, so the Integrations page does not offer it. The gate
of `ontology-kit/` requires that while the shared ontology's base is on
github.io (the card's `limitation` says "Waits for the stable ontology
domain"). The install path itself works since 0.4.0 (the E2E installs from
the catalog's Drive apps section): a catalog Install creates the app with a
row class and table of its own (`createApp` without `rowClass`), and on
every open the app fixes what that leaves out, inside its own subtree
(`app/adopt.ts`; #177 spike S2): its own table's `classtype` becomes
`bank-transaction-v1`, so what it imports there are shared rows; its App's
`renders` lists `bank-transaction-v1` and every importer `bank-transaction`
class in the drive (found by shortname, since Set up mints it per drive), so
Add view offers it on the importer's table and on any table of the shared
class (`useDriveApps.ts` `appsForClass`, exact subject); and its `row-extras`
name the four bookkeeping Properties below. An importer set up after the
app's last open is picked up by the next one. Once the host lets a catalog
entry declare its row classes (#177 H2), the first two steps can go.

## Shared class (`bank-transaction-v1`)

Since 0.4.0 the Money app reads and writes the shared class
`bank-transaction-v1` from [`ontology/`](../../ontology-kit/README.md)
(#177 item 8): account, currency, amount (an exact decimal string), value
date, booking date, description, reference, and the person's own category
and note, at their published GitHub Pages subjects. The shortnames are money
0.3.0's, unchanged. No host change was needed: the app writes rows the way
the calendar, timesheets and issue-tracker apps do at the pin.

- **The importer is unchanged.** Its Set up still mints the drive-local
  `bank-transaction` class and properties from `bankingSchema()`: a
  manifest `destination` cannot name a published class at the pin (both
  manifest validators refuse `subject`; that host change is an issue for
  Joep, superseding draft PR #252). The app reads that class through a lens
  (`app/rows.ts` `importerLens`): the class's declared properties by
  shortname, mapped onto the same fields. The lens's `from` is money's own
  class, so it lives here, not in `ontology-kit/`.
- **The app's own terms** (`app/own.ts`), all under the App, the one place
  it may always write: four Properties in the App's own ontology for the
  bookkeeping that is not part of the shared class (`bank-source-id`,
  `bank-fingerprint`, `bank-statement`, `bank-transaction-code`), declared
  as the App's `row-extras`; a `bank-statement-record` class and an
  "Imported statements" table under the App, one row per imported statement
  with its reconciled balances, plus `money-table` (which table its
  transactions went to). Made on first open, found by shortname and class
  afterwards; a same-named Property with another datatype is an error.
- **Identity and dedupe** are the importer's (`identity.ts`): the app's
  rows carry the same `bank-source-id` and `bank-fingerprint`, so a reimport
  of an overlapping statement is recognised row by row, a changed booking
  blocks the file, and a reference-free overlap with an earlier import is
  refused, before anything is written. Not covered: two copies of the app
  importing the same file at the same moment can both write a row (the
  importer's server-side `localId` uniqueness has no equivalent for app
  writes); the next check shows such a row as "already imported" twice.
- **Reading is strict.** The shared fields are read by subject only, through
  `ontology-kit/resolver.mjs`: no lookup by shortname or column. An amount
  that is not an exact decimal with at most five fraction digits is shown
  as "Not a valid amount" and left out of every sum; it is never parsed as a
  float.
- **A table you make yourself** (#177 item 13). Until New Table's class
  search finds external classes (#177 H10) or a template uses the shared
  class (H3), make such a table by pasting the class URL:
  1. New → Table → "Use existing class", paste
     `https://ontola.github.io/atomic-plugins/ontology/classes/bank-transaction-v1`
     into the class field and press Enter (search does not find it; typing
     or pasting the URL does, #177 spike S3).
  2. On the new table: Add view → Bank statements (listed once the app has
     been opened once, see above). Import statement asks for "Allow
     editing" first; so does saving a category or note.

  Rows you add there need account, currency, amount and value date to be in
  the ledger; since 0.4.1 a row without one of them is listed as incomplete
  above it, with "Open row", instead of being skipped (see "Incomplete
  rows" under [Money app](#money-app-app)). This path has unit tests only;
  no E2E (the E2E's incomplete row is on the app's own table).

- **Needs GitHub Pages.** The server fetches each shared term once, on first
  use, and keeps it; the browser fetches it through its local-database
  worker (#177 spike S1, H1). A drive whose server never fetched a term
  cannot use it while Pages is down.
- **An older host** without an App ontology (`default-ontology`), row access
  or `importer.run` gets the 0.3.0 behaviour: reading, and a pointer to the
  importer's Import tab.

Build: `node integrations/money/app/build.mjs` (writes `app/dist/ui.js`,
minified, one module). Screenshots, axe and the render budget:
`node integrations/money/app/harness/screenshots.mjs --axe` (writes to
`app/dist/screenshots/`).

## Verified

At 0.4.1 (`plugin.js` sha256
`b58eb564459de4c7d73cc06adb89cd9207810e760f9daabb7423983ba5efbf99`, again
0.3.0's bundle with only the manifest's `version` changed; app module
`apps/money/0.4.1/ui.js`, 111,239 bytes) the four tests of
`e2e/money.spec.ts` and `moneybird.spec.ts` passed on 2026-10-02 against the
pin `a12b74a` (the build VPS's source build of it), in 4.1 minutes. What the
run adds over 0.4.0: after the camt.053 import, a `bank-transaction-v1` row
is committed by hand to the app's own table with an empty Amount (the only
incomplete row this host can hold, see "Incomplete rows" under
[Money app](#money-app-app)), and the app lists it through the table
subscription as "1 row is incomplete" with "Incomplete: missing Amount", the
Transactions count stays 4, the ledger does not show it, and "Open row"
leaves the app for that row's page. Not verified: an incomplete row on the
importer's table (the importer never writes one) or on a hand-made
shared-class table (unit tests only), and a row completed in the host while
the app stays open (unit test only).

At 0.4.0 (`plugin.js` sha256
`693f8535adb8920e92e3358349e635ebce45c4b60e48a38687609ae3015fc7b7`, which is
0.3.0's bundle with only the manifest's `version` changed; app module
`apps/money/0.4.0/ui.js`, 108,795 bytes) the three tests of
`e2e/money.spec.ts` and `moneybird.spec.ts` passed on 2026-10-02 against the
pin `a12b74a` (the build VPS's source build of it), fetching the shared terms
from the real GitHub Pages URLs; see the end of this section for the second
run on the kept lane store. What the run adds over 0.3.0: the app is
installed from the catalog (not test-side); on its own table it imports the
synthetic MT940 and camt.053 by its own writes, and the server then holds
rows of class `bank-transaction-v1` with the published property subjects and
the exact strings (`-12.34`, `2026-09-02`), its statement rows give the strip
`€107.66`, a category saves with no "Allow editing" bar, a reimport finds
nothing new and a changed booking is blocked; and Add view on the importer's
table offers the installed app (the importer's class found by shortname on
the app's first open), where the 0.3.0 flow runs unchanged. Not verified by
an E2E: importing into a hand-made `bank-transaction-v1` table after "Allow
editing" (unit tests only), and a host that serves the real catalog (the
lane's dev-server serves the committed `apps/money/0.4.0/ui.js`).

Earlier releases:

`e2e/money.spec.ts` passed on 2026-09-25 against the pinned atomic-server
`bc39dac4b` (earlier against `007869464`, `11264e83e` and `2f403624e`, which includes #1691,
the change for atomic-server#1653), with this package at version 0.2.0
(`plugin.js` sha256 `a8f84cd07899984529b505d2719e83b1ec4bed805c9e2459e895c0956f784efe`,
the bundle with the annotations, structured errors and the statements
table). Version 0.3.0 is that bundle with only the manifest's `version`
changed (#148 changed the importer's behaviour at 0.2.0: the statements
table and `tables` in `config.required`). At 0.3.0 (`plugin.js` sha256
`5d5ab941d41734d088e7be6da528b3decbfbf3db81e56cfae59e69558054733b`) both
E2E tests passed once on 2026-09-29 against pin `2567fc30b` and once
against pin `1432e244a`, which fixes atomic-server#1846 (both the published
e2e image). The
spec picks the release it just published by its id, so it also passes on a
lane store kept from earlier runs (checked twice in a row). It covers these
steps, all with the synthetic files in `fixtures/` and generated variants:

- publish, then discover under Community plugins, then create a draft;
- Set up, then an MT940 preview (2 new transactions and their statement,
  "Apply 3 changes", "1 statements reconciled"), then
  Apply, then a full page reload, then the rows in the table;
- a reimport of the same file: "2 previously imported transactions skipped",
  and nothing to apply;
- a local edit to an imported description, which survives the reimport. A
  statement whose already-imported transaction changed at the bank is shown
  as a conflict and blocked, and the edit is still there afterwards;
- camt.053 of the same period: 2 new rows (identities are per format), then
  a reimport skips both;
- these files are refused with an error message, no preview dialog, and no
  write (the first real import afterwards still proposes exactly 2):
  - an unbalanced statement ("does not reconcile");
  - a non-statement text file;
  - malformed XML;
  - an MT940 file over 512 KB;
  - 501 transactions ("at most 500");
  - a file over 5,000,000 bytes (refused by the host before it is read);
- an MT940 export in Windows-1252, whose "Café" narrative the host decodes
  correctly (checked in the preview).

Not verified: other banks' dialects beyond the fixtures (the 2026-09-11 bunq
check above was on the old host path), an Installation (as opposed to a
draft), and the host's server-side size refusal through the browser (it has
a Rust unit test in atomic-server, `uploads_need_a_declaration_and_respect_its_size`).

## Moneybird: read-only contacts, hours and financial mutations (`moneybird/`)

A second, independent thing in this folder (#102): a browser-only drive app,
the same shape as `integrations/pets/app/`. It is not part of the sandbox
bundle above and does not touch the Bank statements importer's table.

- **Scope.** Three collections of one administration the person chooses,
  each ticked or not when the administration is chosen: **contacts** (as
  0.1.x), **hours** (Moneybird time entries) and **financial mutations** (the
  transactions on its financial accounts). Every call is a GET through
  `store.proxy.request`; the connection lives at the integration proxy, owned
  by the user's agent and delegated to the app's (#54 phase 2). The frame
  holds no credential and makes no network call of its own
  (`moneybird/build.test.ts` checks the bundle). Nothing is written to
  Moneybird.
- **The sync-status card (0.3.0).** The shared card of Decision Inbox Q-084
  (`integrations/sync-status/`, adopted by Clockify first) comes first in the
  view, under the heading, in every state but loading and a table the app
  cannot sync. `moneybird/status.ts` maps the controller's state and its
  latest sync onto it, pure, with a test per state (`status.test.ts`); the
  DOM is checked in jsdom (`view.test.ts`). It says, in every state, that the
  app is read-only: "Read-only: edits here stay in Atomic. Nothing is sent to
  Moneybird, and the next sync overwrites edits made here in the columns it
  imports." (the #97 policy as it stands); on a table that is not synced, or
  whose sync is paused, that nothing here is overwritten either. After a
  sync: "Synced 2 min ago", "15 rows imported: 5 contacts, 4 time entries,
  6 mutations", "Last sync: 15 added, 0 updated, 0 unchanged". A collection
  whose refresh failed is a problem next to the ones that went on
  ("Contacts: refresh failed. Moneybird answered 503 for contacts page 2. The
  contacts imported earlier are kept; they last refreshed 3 h ago. Press Sync
  now to try again."); only when every chosen collection failed does the card
  say "Sync failed", naming the rows as kept and each collection's last good
  refresh this app knows. Those times are stored on the App or the binding as
  `moneybird-last-sync` (see Flow), so they survive a reload: the app syncs on
  open, and an open whose every collection fails still names the gap, and a
  table that holds imported rows never reads "Not synced yet" (before this
  page load's first sync the card shows the stored time, without counts).
  Skipped records are listed as ignored with their reason and names: a time
  entry "without a readable start (started_at) in Moneybird: not imported.",
  a mutation "with an amount Moneybird did not send as a decimal string: not
  imported, never approximated."; a refresh that wrote nothing but skipped
  something gets no counts line (it would read "nothing to read"). A wait for
  Moneybird's rate limit shows while it lasts, counting down (see Rate
  limits); while a sync runs, the previous sync's failures are not listed,
  since the running one settles them. After an error on a table the app is
  not bound to, the note claims only that nothing is sent. The
  `role="status"` line stays the one live region; while the card holds the
  same words it is visually hidden, not removed. The card's
  CSS is embedded by `cssRawPlugin` (`integrations/sync-status/build.mjs`)
  in `moneybird/build.mjs`; the money lane's `paths` list
  `integrations/sync-status/**`, so a card change runs this lane too.
- **Rate limits (0.3.0).** Moneybird announces 150 requests per 300 s per
  source IP (developer.moneybird.com, "Throttling";
  `overlays/APIs/moneybird.com/v2-readonly/throttling-*-overlay.yaml`, window
  algorithm unspecified). The source IP is the integration proxy's, shared by
  everyone who connects Moneybird through it, so the app's pacing promises
  nothing; it keeps one import from spending the whole quota at once.
  `moneybird/throttle.ts` wraps the reader for the whole sync (the three
  collections share one window): a sliding window of 120 requests per 300 s
  before the next request waits (a small sync never waits; the period-halving
  mutations read, up to 200 requests, does), and a `429` retried after
  `Retry-After` (delay-seconds, digits only, or an IMF-fixdate; anything
  else, `-1` or `1.5` say, is ignored) when Moneybird sends one, never less
  than the backoff, else after a backoff of 2 s doubling per retry; one wait
  is capped at 60 s (a longer `Retry-After` fails the read now, naming the
  asked wait), and one request is retried at most 5 times, after which the
  collection fails with "Wait a few minutes, then press Sync now." on the
  card. While a wait lasts the card is busy with "Moneybird is limiting
  requests (429): retrying in 4 s…" or "Pacing requests under Moneybird's
  limit: next in 13 s…", counting down every second.
  Verified with fake transports and a fake clock only (`throttle.test.ts`);
  the synthetic fixture never answers 429, and nothing is observed against
  Moneybird.
- **Where the rows go.** Contacts fill the table the install made, with a
  drive-local `Contact` class, as before. Hours and mutations are rows of the
  shared classes of #177 (`ontology-kit/`), so the other apps' views work on
  them: the first open makes, under the App, a "Moneybird hours" table
  (`time-entry-v1`), "Moneybird projects" (`work-project-v1`), "Moneybird
  people" (`work-person-v1`) and "Moneybird mutations"
  (`bank-transaction-v1`), found again by `classtype` on later opens
  (`moneybird/own.ts`). The Clockify timesheets app (0.6.x) can be added to
  the hours table through "+ Add view" and shows the entries in its week
  grid; the Money app to the mutations table and shows them in its ledger
  (both offer themselves on any table of their class; that these two views
  render Moneybird's rows is declared from their READMEs, not checked by an
  e2e here). The App's `renders` lists both shared classes and its
  `row-extras` the six extras below. Where a view is, is decided by the
  table's class and parent (`moneybird/binding.ts` `layout`), never by the
  parent alone, since the hours and mutations tables are children of the App
  too: the install's table (a drive-local class) is the contacts table and
  carries the collections choice; opened on its own hours or mutations table
  (Add view offers it there as well), the app syncs only that table's
  collection into it, with the App's administration and no grant; its
  projects and people tables are refused with a note. Only the own tables a
  sync writes are made: the contacts table's view makes the hours (with
  projects and people) and mutations tables it imports into; a view on a
  shared-class table makes only the projects and people tables hours link
  to, never an empty mutations table.
- **Syncing a table the app didn't make** ([the pattern](../README.md#syncing-a-table-the-app-didnt-make)):
  added through "+ Add view" on a `time-entry-v1` or `bank-transaction-v1`
  table of the person's own, the app shows "Not synced with Moneybird" and
  writes nothing until "Sync this table to Moneybird" is pressed; that asks
  the host's "Allow editing" (`store.requestRowAccess`), and the grant must
  cover the row extras. The binding is a resource under the App whose
  `moneybird-synced-table` names the table and which holds the
  administration; the one collection that table's class can hold is synced
  into it (hours there still link to the app's own Projects and People
  tables). The table itself is never written and no row is ever deleted. A
  lapsed grant pauses the sync ("Allow editing again"); a table of another
  class is refused (`moneybird/binding.ts`).
- **Flow.** Connect Moneybird (host consent bar, then the proxy's own
  connect page), then choose an administration (`GET /administrations.json`)
  and the collections (stored on the App, or on the binding, as
  `moneybird-administration` and `moneybird-collections`; an administration
  stored by 0.1.x without collections means contacts), then import. From
  0.3.0 the same resource also carries `moneybird-last-sync`, when each
  collection last refreshed without error
  (`contacts:<ISO 8601>,hours:<ISO 8601>`), written once per sync that
  refreshed anything, for the card: the one write a sync makes besides rows
  (the live check's S3 excludes exactly that save). Read when the home is
  known, before any state shows; a time later than now, or not in
  `toISOString`'s shape, is ignored. The view
  syncs once each time it opens, and on Sync now, each chosen collection on
  its own: one that fails is reported next to the others ("contacts: refresh
  failed: … Rows imported earlier are kept."). Every collection reads
  everything before writing anything, so a refresh that fails part-way
  writes nothing and the rows imported earlier stay.
- **Reads.** Contacts:
  `GET /{administration_id}/contacts.json?per_page=100&include_archived=true`;
  hours: `GET /{administration_id}/time_entries.json?per_page=100&filter=period:this_year,state:all`
  (passing any `filter` replaces Moneybird's defaults entirely, so both keys
  are spelled out; running timers stay out, as by default). Both follow
  `Link: <…>; rel="next"` only within their collection, for at most 200
  pages. Financial mutations: `GET /{administration_id}/financial_accounts.json`
  once (for the accounts' IBANs), then
  `GET /{administration_id}/financial_mutations.json?filter=period:this_year`,
  Moneybird's own period, the same the hours read uses. That list has **no
  pagination**: the pinned OpenAPI document gives it only `filter` and says
  it is "limited to 100 financial mutations" (developer.moneybird.com says
  the same and points at a synchronization API the read-only document does
  not carry). So an answer with 100 records or more is asked again as the
  two halves of the civil year (`filter=period:YYYYMMDD..YYYYMMDD`), down to
  single days, and a single day at the limit is an error ("Nothing was
  written") rather than a silently incomplete ledger. The halving windows
  take the civil year in Europe/Amsterdam (`civilYear()`): Moneybird's
  `this_year` runs on the administration's clock, which the app does not
  read, so the two agree except, around New Year, for an administration in
  another time zone. At most 200
  mutation requests per import (`MAX_MUTATION_REQUESTS`); an administration
  with a few hundred mutations a year needs about a dozen. No overlay was
  added for this: a `pageNumber` declaration would claim something Moneybird
  does not do.
- **Identity.** Each imported row carries `moneybird-source-id` =
  `moneybird:<administration>:<collection>:<id>` (`contact`, `time_entry`,
  `financial_mutation`, `project`, `user`). A repeated import with no change
  writes nothing, and two administrations do not collide. A record changed
  on Moneybird overwrites the imported columns, and a column Moneybird no
  longer sends is removed; local edits to them are not preserved yet (the
  policy is #97's question). A record that disappears is kept. Rows of the
  table with another or no identity (the person's own) are left alone.
- **Columns.** Contacts: `moneybird-id`, `-administration-id`,
  `-company-name`, `-firstname`, `-lastname`, `-email`, `-city`, `-country`,
  `-customer-id`, `-updated-at` (the exact ISO string Moneybird sent) as
  strings; `moneybird-archived` as a boolean; `moneybird-version` as an
  integer. The row name is the company, else the person, else the id.
  **Hours** (`time-entry-v1`, by published subject): `name` = description
  (else "Time entry <id>"), `work-start`/`work-end` = `started_at`/`ended_at`
  as epoch milliseconds (the class's `timestamp`), `work-billable`,
  `work-project` and `work-person` = links to the Projects and People rows
  made from the `project` and `user` objects each entry embeds (named as
  Moneybird names them; renamed there, renamed here); extras
  `moneybird-source-id`, `-updated-at`, `-paused-duration` (seconds; the
  Start–End span includes paused time, the class has no field for it). An
  entry without a readable `started_at` is counted as skipped, not written.
  **Mutations** (`bank-transaction-v1`): `bank-account` = the financial
  account's `identifier` (an IBAN when the bank gives one); when Moneybird
  lists no such account, `moneybird:<financial_account_id>`, prefixed because
  a Moneybird id is not a bank's account id, which the class asks for;
  `bank-currency`, `bank-amount` = Moneybird's `amount` **as the exact
  decimal string it sent** (never parsed to a float; a value that is not
  `-?\d+(\.\d{1,5})?` is skipped, never approximated), `bank-value-date` =
  `date`, `bank-description` = `message` verbatim, `bank-reference` =
  `account_servicer_transaction_id` else `batch_reference`, `name` = the
  contra account's name, else the message, else "Mutation <id>"; extras
  `moneybird-source-id`, `-version`, `-updated-at`, `-state` (unprocessed or
  processed), `-contra-account`. `bank-booking-date` is not written
  (Moneybird gives one date); `money-category` and `money-note` are never
  written. Not imported: the entry's contact and sales invoice; a mutation's
  payments, ledger account bookings, SEPA fields and settlement state.
- **Period.** Both hours and mutations ask Moneybird for `period:this_year`,
  its own default period, by the administration's clock. Earlier years are
  not imported; a stored choice of period is not built (a product question).

| What                                                                                                  | Fixture (synthetic)                                                                                  | Real Moneybird                                                             |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `administrations.json` list and choice                                                                | verified (unit, host E2E)                                                                            | not verified                                                               |
| contacts, the fields above, their datatypes                                                           | verified (unit, host E2E)                                                                            | not verified                                                               |
| `Link` rel="next" pagination, `include_archived`, the time entries filter                             | verified against the fixture's own pages of 2                                                        | not verified; the page size and headers are as documented, not as observed |
| hours as `time-entry-v1` rows linked to project and person rows                                       | verified (unit, host E2E against the published Pages subjects)                                       | not verified                                                               |
| mutations as `bank-transaction-v1` rows, exact amount strings, IBANs                                  | verified (unit, host E2E against the published Pages subjects)                                       | not verified                                                               |
| the 100-record limit: halving windows, refusing a full day                                            | verified against the fixture's own lowered limit (unit)                                              | not verified; the limit is as documented, not as observed                  |
| repeat import without duplicates, two administrations, removed columns                                | verified (unit, host E2E)                                                                            | not verified                                                               |
| one collection failing while the others go on; rows kept                                              | verified (fixture's synthetic 503 on contacts; unit, host E2E)                                       | not verified                                                               |
| "Sync this table to Moneybird" after Allow editing, binding, pause                                    | verified (unit against the fake grant; host E2E on a hand-made `bank-transaction-v1` table)          | not verified                                                               |
| 401/403 handling ("reconnect Moneybird")                                                              | unit only                                                                                            | not verified                                                               |
| the sync-status card: read-only wording, per-collection results, a failed collection, skipped records | verified (unit per state, jsdom; host E2E for the import, the failed refresh and the unsynced table) | not verified; the wording is a default, seen by no user tester yet         |
| 429 with `Retry-After`, the 60 s cap, 5 retries, pacing under 150/300 s                               | unit only, fake transports and clock                                                                 | not verified; the limit and header are as documented, not as observed      |

**The fixture is synthetic, not recorded.**
`fixtures/moneybird/synthetic.mjs` is hand-written from the pinned read-only
OpenAPI document (localthought/openapi-directory@85a61052) and its examples.
It has invented names, amounts and identifiers; its time entries and
mutations are dated in the current civil year in Europe/Amsterdam, because
the app imports this year's. `scenario.mjs` serves it to the mock proxy (registered as `moneybird`
in `localthought/fixtures/index.mjs`). It pages contacts and time entries by
2 whatever `per_page` asks, fails every second read of an administration's
contacts on page 2 with 503, and answers at most 100 mutations per period
window (a test lowers that); all three are test behaviour, not claims about
Moneybird. **A real recording needs someone with a Moneybird test
administration and API token**; the recorder is ready for them:

```sh
MONEYBIRD_TOKEN=<API token> node integrations/money/fixtures/moneybird/record.mjs
```

It makes GET requests only, on the five operations the app reads, as the
app sends them (`per_page` 2 by default so a few records span pages,
`include_archived=true`, `period:this_year`), writes `fixtures/moneybird/api/`
redacted per its exported `REDACTIONS` list (ids to stable 18-digit fakes
that keep references intact, names, addresses, e-mails, IBANs and messages
to stable fakes (one fake per real value, so a project nested in several
time entries keeps one name), the nested arrays the app never reads to
`[]`, any unrecognised string, and any number other than `version`,
`budget`, `paused_duration`, `max_transfer_amount` and `child_order`, to
`"redacted"` and listed in `api/meta.json` by its full path; inside a
nested object the list does not know (`sepa_fields`, say) everything is
redacted whatever its field names, and an object key that is not shaped
like a field name becomes `redacted-key-<n>`), and never writes the token. Once `api/meta.json` exists, `scenario.mjs` replays the
recording instead of `synthetic.mjs`, with the same page cap, outage and
mutation cap, and `this_year` meaning the recording's year;
`moneybird-fixture.test.ts` proves that replay against an invented `api/`
and, once recorded, checks the recorded rows hold what the app reads and
were recorded this civil year (the app asks for `period:this_year` by its
own clock, so a recording goes stale at New Year). `moneybird/moneybird.test.ts`
and `e2e/moneybird.spec.ts` import `synthetic.mjs`'s names and counts and
need their expectations updated to the recorded rows. What the recording
settles is the right-hand column of the table above; nothing in it moves
until then.

**Install.** From the catalog's Drive apps section, like the other drive
apps (see [Publishing a drive app](../README.md#publishing-a-drive-app)).
Version 0.3.0 is published at `apps/moneybird/0.3.0/ui.js` (0.2.0 had no
sync-status card and no rate-limit handling; 0.1.1 imported contacts only;
0.1.0 relayed paths without the `/api/v2` base path, which the proxy refuses
as not in the catalog; all kept because a published file never changes); its
version is recorded in `moneybird/package.json`, not in
this folder's `package.json` (that one is the Bank statements importer's).
`apps.mjs` finds the app here, not at `integrations/moneybird/app/`, through
its `APP_FOLDERS` map. The `moneybird` catalog entry stays `enabled: false`:
it bundles the github.io ontology base (`ontology-kit/README.md`, "Gate"),
and no real recording exists; the lane's dev-server serves it enabled for
`e2e/moneybird.spec.ts`, which installs it from the card. To release a new
version, bump `moneybird/package.json` and the catalog entry's `version`,
then run `node integrations/tooling/apps.mjs write moneybird`.

Tests: the money vitest command above includes `moneybird/*.test.ts`. The
host E2E is `e2e/moneybird.spec.ts` in the money lane's e2e tier: the full
journey with all three collections, and the Add view journey on a hand-made
`bank-transaction-v1` table. It first passed on 2026-09-24 against
atomic-server `2f403624e`, again on 2026-10-01 against the pin `a12b74a6783b`
after the connect page's button changed with the proxy's 0.2 protocol, and
with hours, mutations and the Add view journey on 2026-10-06 against the
same pin; the 0.3.0 run with the sync-status card assertions is recorded in
the PR that added them.

**Live check kit (not yet run).** `node integrations/tooling/live-check.mjs
moneybird --i-understand-this-writes-to <administration id>` runs the Moneybird
app's controller against one disposable administration (the driver seeds and
cleans up; the app stays read-only) and checks the `/api/v2` base path (#274)
against the real API; it imports the contacts collection only. See [The
live-check kit](../LIVE_TESTING.md#the-live-check-kit).
