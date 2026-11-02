# Google Keep View

A Keep-style view of account folders, individual notes and imported checklist
tables. Install the separate **Google Keep View** entry from Integrations →
Drive apps (under **Show experimental plugins**), then open it once. Installing
**Google Keep** alone installs the connection and sync app, not this view.
If the experimental checkbox is hidden, open `/app/integrations?preview=plugins`
first. Existing installations update from the same catalog entry. On a host
with resource-view support, the view installation stays in Integrations rather
than ordinary drive contents, and a new view installation needs no Items table.

The view discovers imported checklist tables with a text column (**Array item**,
**Text** or **Name**) and a boolean **Checked** or **Done** column, as well as
the sync app's notes. It resolves each table's own properties and registers its
class so the host can offer **Google Keep View** under **Add view**. If several
tables are available, choose one in the view. No Google connection or another
copy of the notes is needed. Open the view again, or Refresh it, after importing
another list so it becomes available on that table too.

The **Google Keep <account>** folder opens as cards. Opening a card navigates
to the existing note resource, where only that checklist or text note appears.
The renderer resolves the sync installation through the note class and its
ontology, so moving the notes container into the drive does not lose its hidden
list-item data. Resource-page context grants no checkbox editing access.

Notes appear as a responsive grid of cards, with a list layout toggle and
search across titles, note text and all checklist items. Unchecked items
appear first in each note, followed by an initially collapsed completed section with the actual count and
struck-through text. Positions within each section and child indentation are
preserved; sorting the display never writes new positions. Text, trashed or
missing notes, and sync holds remain visible. The host's light/dark theme is
respected. The Keep API does not expose colours, labels or pins, so the view
does not invent them.

To tick items, open the imported checklist or **Google Keep list items** table,
add **Google Keep View** as a view, and allow it to edit that table's rows. The
view rechecks the host's grant before each save and writes only the actual
Checked or Done column. Account folders, individual note pages, notes tables and the standalone view
remain read-only. It never changes the sync app's
settings, calls Google, creates or deletes rows, or starts syncing. Sending
edits to Google remains the sync app's job, under its existing settings and
replacement-note limits.

Declared evidence: unit tests for both data models, discovery and class
registration, table isolation, unchecked-first ordering, search, grants and DOM
interactions, resource-target isolation, folder reuse and a 485-completed-item
checklist; synthetic Chromium tests for checkbox edits, search, layout,
mobile overflow, dark mode, folder-card navigation and single-note pages. The host E2E covers catalog installation and
adding the view to an imported checklist through Add view, including a granted
edit to its Checked column. No Google live evidence is claimed.

```sh
node integrations/tooling/link-atomic-server.mjs
node integrations/tooling/run-lane.mjs google-keep-view --tier typecheck
node integrations/tooling/run-lane.mjs google-keep-view --tier unit
# Synthetic browser test, without a server:
browser/e2e/node_modules/.bin/playwright test --config integrations/google-keep-view/browser.config.ts
# Host catalog installation and synthetic browser test (needs the server binary):
node integrations/tooling/run-lane.mjs google-keep-view --tier e2e
```

Placement A: one ES module in the host's iframe. No credentials, provider
requests, persistent browser storage or background polling. Table subscriptions
refresh the display after edits; Refresh retries discovery or a failed read.
