# Bank statements (MT940 and camt.053)

## Setup

This needs an atomic-server with the generic file entry point
(atomic-server#1653: manifest `accepts` and `destination`, and the Import tab
on a plugin's page; merged as atomic-server#1691). `bc39dac4b`,
the pin when this was first verified, includes it; see [Verified](#verified)
for the pins it was last run against, the current pin `a12b74a` included
(0.4.0, 2026-10-02).

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

  Rows you add there need account, currency, amount and value date to show
  in the ledger (a row without them is not shown; the #177 rule "show it as
  incomplete" is not built yet). This path has unit tests only; no E2E.

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

## Moneybird: read-only contacts (`moneybird/`)

A second, independent thing in this folder (#102): a browser-only drive app,
the same shape as `integrations/pets/app/`. It is not part of the sandbox
bundle above and does not touch the Bank transactions table.

- **Scope.** One collection, contacts, of one administration the person
  chooses. Every call is a GET through `store.proxy.request`; the
  connection lives at the integration proxy, owned by the user's agent and
  delegated to the app's (#54 phase 2). The frame holds no credential and
  makes no network call of its own (`moneybird/build.test.ts` checks the
  bundle). Nothing is written to Moneybird.
- **Deferred.** The catalog card used to advertise contacts, sales invoices,
  purchase invoices, financial mutations "and the other collections". None of
  those but contacts is imported. `financial_mutations.json` has no
  pagination overlay (`overlays/APIs/moneybird.com/v2-readonly/pagination-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml`)
  and needs a period `filter`, so it is the likely next collection, but it is
  not attempted here.
- **Flow.** Connect Moneybird (host consent bar, then the proxy's own
  connect page), then choose an administration
  (`GET /administrations.json`; the choice is
  stored on the App resource as `moneybird-administration`), then import. It
  reads `GET /{administration_id}/contacts.json?per_page=100&include_archived=true`
  and follows `Link: <…>; rel="next"` only within that collection, for at
  most 200 pages. It reads every page before writing, so a refresh that fails
  part-way writes nothing and the rows imported earlier stay. The view syncs
  once each time it opens, and on Sync now.
- **Identity.** Each row carries `moneybird-source-id` =
  `moneybird:<administration>:contact:<id>`. A repeated import with no change
  writes nothing, and two administrations do not collide. A contact changed on
  Moneybird overwrites the imported columns; local edits to them are not
  preserved yet (the policy is #97's question). A contact that disappears is
  kept.
- **Columns.** `moneybird-id`, `-administration-id`, `-company-name`,
  `-firstname`, `-lastname`, `-email`, `-city`, `-country`, `-customer-id`,
  `-updated-at` (the exact ISO string Moneybird sent) as strings;
  `moneybird-archived` as a boolean; `moneybird-version` as an integer. The
  row name is the company, else the person, else the id. Null or absent
  values are left unset.

| What                                                  | Fixture (synthetic)                                | Real Moneybird                                                             |
| ----------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| `administrations.json` list and choice                | verified (unit, host E2E)                          | not verified                                                               |
| contacts, the fields above, their datatypes           | verified (unit, host E2E)                          | not verified                                                               |
| `Link` rel="next" pagination, `include_archived`      | verified against the fixture's own pages of 2      | not verified; the page size and headers are as documented, not as observed |
| repeat import without duplicates, two administrations | verified (unit, host E2E)                          | not verified                                                               |
| failed refresh keeps rows                             | verified (fixture's synthetic 503; unit, host E2E) | not verified                                                               |
| 401/403 handling ("reconnect Moneybird")              | unit only                                          | not verified                                                               |

**The fixture is synthetic, not recorded.**
`fixtures/moneybird/synthetic.mjs` is hand-written from the pinned read-only
OpenAPI document (localthought/openapi-directory@85a61052) and its examples.
It has invented names and identifiers. `scenario.mjs` serves it to the mock
proxy (registered as `moneybird` in `localthought/fixtures/index.mjs`). It
pages by 2 whatever `per_page` asks, and fails every second read of an
administration on page 2 with 503; both are test behaviour, not claims about
Moneybird. **A real recording needs someone with a Moneybird test
administration and API token**; the steps are in `scenario.mjs`'s header.

**Install.** From the catalog's Drive apps section, like the other drive
apps (see [Publishing a drive app](../README.md#publishing-a-drive-app)).
Version 0.1.1 is published at `apps/moneybird/0.1.1/ui.js` (0.1.0 relayed paths without the `/api/v2` base path, which the proxy refuses as not in the catalog; kept because a published file never changes); its version is
recorded in `moneybird/package.json`, not in this folder's `package.json`
(that one is the Bank statements importer's). `apps.mjs` finds the app here,
not at `integrations/moneybird/app/`, through its `APP_FOLDERS` map. The
`moneybird` catalog entry stays `enabled: false` until a real recording
exists, so the published catalog does not list it; the lane's dev-server
serves it enabled for `e2e/moneybird.spec.ts`, which installs it from the
card. To release a new version, bump `moneybird/package.json` and the
catalog entry's `version`, then run
`node integrations/tooling/apps.mjs write moneybird`.

Tests: the money vitest command above includes `moneybird/*.test.ts`. The
host E2E is `e2e/moneybird.spec.ts` in the money lane's e2e tier. It first
passed on 2026-09-24 against atomic-server `2f403624e`, and again on
2026-10-01 against the pin `a12b74a6783b`, after the connect page's button
changed with the proxy's 0.2 protocol.

**Live check kit (not yet run).** `node integrations/tooling/live-check.mjs
moneybird --i-understand-this-writes-to <administration id>` runs the Moneybird
app's controller against one disposable administration (the driver seeds and
cleans up; the app stays read-only) and checks the `/api/v2` base path (#274)
against the real API; see [The live-check
kit](../LIVE_TESTING.md#the-live-check-kit).
