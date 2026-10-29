# Google Keep View

A table view of the Google Keep sync app's locally stored notes and list
items. Install **Google Keep View** from Integrations → Drive apps (under
**Show experimental plugins**), then open it. It discovers existing Google
Keep notes tables; if there are several, choose one. Opening the view once
registers the discovered note and item classes so the host can offer it
under **Add view** on those tables. No Google account or connection is needed
by this view; the separate **Google Keep** app imports and syncs the data.

Notes appear as a responsive grid of cards, with a list layout toggle and
search across titles, note text and all checklist items. Unchecked items
appear first in each note, followed by a collapsible completed section with
struck-through text. Positions within each section and child indentation are
preserved; sorting the display never writes new positions. Text, trashed or
missing notes, and sync holds remain visible. The host's light/dark theme is
respected. The Keep API does not expose colours, labels or pins, so the view
does not invent them.

To tick items, open **Google Keep list items**, add **Google Keep View** as a
view, and allow it to edit that table's rows. The view rechecks the host's
grant before each save and writes only the item's Done column. Notes tables
and the standalone view remain read-only. It never changes the sync app's
settings, calls Google, creates or deletes rows, or starts syncing. Sending
edits to Google remains the sync app's job, under its existing settings and
replacement-note limits.

Declared evidence: unit tests for mapping, table isolation, unchecked-first
ordering, search, grants and DOM interactions; a synthetic Chromium test for
checkbox edits, search, layout, mobile overflow and dark mode. A host catalog
installation test is included separately. No Google live evidence is claimed.

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
