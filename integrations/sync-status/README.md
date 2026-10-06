# Shared sync-status card

Shared code, not a plugin (Decision Inbox Q-084, status-only, 2026-10-06):
the one card a drive app puts above its data to say, in plain words,

- when the last sync ran and how it went ("Synced 4 min ago", "Sync failed
  just now", "Not synced yet", or what is running now);
- what it did: rows in the table, and the last sync's added, updated,
  unchanged and removed counts;
- whether edits made in Atomic go back to the provider: "Edits here are sent
  to Clockify after you review them." or "Read-only: edits here stay in
  Atomic.";
- the write queue: changes waiting to be sent, those held back, those the
  provider refused or that errored (with the row and the reason), and sends
  without an answer;
- rows left out or not writable, grouped by reason, with the rows named
  under "Which";
- problems with a plain next step, each with an optional action.

It is modelled on the Notion app's status view (#177 Q9) and was adopted by
Clockify first (`integrations/timesheets/`, 0.7.0), because its user testers
could not tell whether the app writes back (usertest-findings #6), got no
feedback from "Sync now" (#7) and did not know what to do about "Not loaded"
(#14). Its scope is the card: no wider UI kit, and no fake host.

## Files

| File                                | Holds                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `card.ts`                           | The `SyncStatus` model, `statusLines` (the words, as data, for tests and screen-reader text) and `renderSyncStatus(doc, status, { now, buttonClass })`    |
| `card.css`                          | Its styles, from the `--pl-*` tokens of the #89 plugin CSS with light fallbacks; an app imports it as `syncStatusCss` and appends it to its one `<style>` |
| `card.test.ts`                      | The render states in jsdom: never synced, synced, busy, failed, pending and failed writes, ignored rows, read-only against write-back, a problem's action |
| `tsconfig.json`, `vitest.config.ts` | The `sync-status` lane's typecheck and unit tiers (`node integrations/tooling/run-lane.mjs sync-status --tier unit`)                                      |

## Using it from an app

```ts
import { renderSyncStatus, syncStatusCss } from '../../../sync-status/card.js';

root.append(
  renderSyncStatus(doc, status, { now: Date.now(), buttonClass: 'btn sec' }),
);
```

The app maps its own state onto a `SyncStatus` in its own folder
(`timesheets/app/ui/status.ts` is the first), bundles the card with esbuild
like `ontology-kit`'s resolver, minifies `card.css` with esbuild's CSS
minifier (timesheets' `build.mjs` does, through its `?raw` plugin), and
lists `integrations/sync-status/**` in its lane's `paths` in
`integrations/lanes.json`, so a card change runs the app's lane too.

The card is a `<section aria-label="Sync status">` with a visually hidden
heading, never a live region: the app's one `role="status"` stays the only
one. Its buttons are `type="button"` and carry `data-k` from their action's
`key`, for apps that restore focus by key after a re-render.

A `WriteFailure` with `written: true` (the provider write stood; a
verification read or saving the row failed afterwards) is listed apart from
the others, as "written … but could not be finished here; the next sync
reads it back", never as "nothing was written". `writes` also takes
`notWritten`, sends that wrote nothing for another
reason (the provider changed the same field, the row changed after the
review, the record is gone): one line pointing at the app's own review, so a
clean "Synced" headline never sits over a send that did nothing. A failed
`last` takes `lastGood`, when a sync last succeeded, so a days-long gap is
named with the failure ("Last good sync 3 days ago.").

### Mapping a syncables client's `pendingWrites()`

For an app whose writes go through `syncables/browser` (Pets, Notion) rather
than its own client, `writes` is: `pending` the entries with `state:
'pending'` or `'blocked'`; `held` those with `awaitingRefresh: true`;
`failed` the `state: 'failed'` entries, with `title` from the record and
`reason` from `lastError`; `uncertain` the `state: 'uncertain'` ones. Not yet
done for any app: Notion, calendar, issue-tracker and money adopt the card in
follow-ups. Moneybird (`integrations/money/moneybird/status.ts`, 0.3.0) has
its own client and is read-only, so it sets no `writes`; its per-collection
results go in `rowsScope`, a failed collection is a `neg` problem next to
the ones that went on, and skipped records are `ignored` groups.

## What is verified

The card's own render states pass in jsdom (`card.test.ts`, 17 tests, 2026-10-06).
Clockify's mapping passes in `timesheets/app/ui/status.test.ts`, its DOM in
`ui.test.ts`, and the `timesheets` e2e checks the card after the first
import, after a vanished timer ("not loaded yet") and on a read-only table.
Moneybird's mapping passes in `money/moneybird/status.test.ts`, its DOM in
`view.test.ts`, and the `money` lane's `moneybird.spec.ts` checks the card
before any sync, after the import, after a failed contacts refresh and on an
unsynced table.
Nothing here has been seen by a user tester yet: the wording is a sensible
default, not a verified fix for findings #6, #7 and #14.
