# Google Keep lists: item-level sync and a checklist view

Status: proposed, nothing built. Follows the Google Keep drive app 0.1.0
(`integrations/google-keep/`, #593), which syncs a list note as one Markdown
checklist and treats any change on both sides as a conflict.

## Goal

A list note edited on both sides merges item by item. If someone moves an
item in Keep and someone else ticks the same item in the drive, the result
is the item moved and ticked. A checklist editor lets people tick, add,
edit, indent and reorder items in the drive.

Decided (Michiel, 2026-10-15): two plugins. **Google Keep** syncs. **Google
Keep View** is a table view that edits the checklist.

## What the Keep API gives us

Checked against the pinned OpenAPI document
(`APIs/googleapis.com/keep/v1/openapi.yaml` at
`091431739208d017c11b0b0589ab33293f8b3690`) and Google's reference:

- Calls: list, get, create and delete a note, plus the permissions batch
  calls. There is no update, and no item-level call.
- A `ListItem` is `text`, `checked` and `childListItems` (one level). It has
  no id, no position and no timestamp. The note's `name` is the only id.
- A note has `createTime`, `updateTime` and `trashTime`. There is no history
  or change feed, and no webhook. We poll, and we compare Keep's current
  note with the last version we stored.

So every write is a whole replacement note, and on Keep's side item
identity has to be inferred.

## What the host gives an app

- An app sees resources as property maps (`get`/`set`/`save`). It cannot
  read Loro history, older versions or frontiers, and cannot write a native
  Loro list (`view-client.js`, `hostStore.ts`). An array value is written
  as a new `LoroList` every time (`lib/src/loro.rs`). So the baseline and
  item identity must live in ordinary resources and properties.
- An app may only write under its own App (`refuseOutsideApp`,
  `hostStore.ts`). A separate view app can read the Keep tables but not
  write them. atomic-server#1740 decided the fix: an "Allow editing" grant,
  given by a person when adding the app as a view, scoped to that table.
  Its PR (#1788) was closed as stale on 2026-10-13 and was triaged risky
  (rows signed by an app key outside the rights walk). Even as built, its
  scope never allows `destroy`, so a view could not delete an item.

## Data model

The sync app owns two tables:

| Table      | Row class          | Columns                                                                                      |
| ---------- | ------------------ | -------------------------------------------------------------------------------------------- |
| Keep notes | `google-keep-note` | Name (title), Description (a text note's text), kind, presence, hold, sync fingerprint       |
| Keep items | `google-keep-item` | Name (the item's text), Done (boolean), Note (the note's row), Under (parent item), Position |

Each item row also keeps what Keep had at the last sync, as plain columns
written only by the sync app: **Keep text**, **Keep done** and **Keep
position** (with **Keep under**). No JSON. These are the baseline the merge
needs; a fingerprint is not enough, because matching Keep's items to ours
needs the old text.

The items table is the one the view edits, so the view only ever writes
rows of one table and one class, which is the scope #1740 grants. It is
also the table a lens would map onto a native Grocery List (Name, Bought).

## A pass, for a list note

1. **Match Keep's items to ours.** Diff the stored baseline (Keep text,
   done, position) against Keep's current items: exact matches first, then
   the same text with a different tick, then position. Unmatched baseline
   items were deleted in Keep; unmatched Keep items were added there. Weak
   spots: two items with the same text, or an item edited and moved in one
   sync. Those fall back to delete plus add.
2. **Merge per item and per field.** For each item, compare text, done,
   parent and position with the baseline on both sides. A field changed on
   one side takes that side. A field changed on both sides to different
   values is a conflict on that item only. Order is merged as moves: an item
   moved on one side keeps that position.
3. **Write.** Apply Keep's changes to the item rows. If the drive changed
   anything, send the merged list as a replacement note (the same rules as
   0.1.0: never for a shared note or one with an attachment), then record
   the new baseline on every item.

## The view plugin

- A drive app whose App `renders` `google-keep-item`. The host offers it as
  a view tab on the items table (`appsForClass`).
- Shows each note's items as a checklist; tick, edit, add, indent and drag
  to reorder.
- Read-only until the host grants it row edits. It reads the table it is
  shown on, so it needs nothing from the sync app's code.

## Depends on atomic-server

1. **#1740, Allow editing.** Without it the view is read-only. Reopen or
   redo #1788 against `develop`, addressing its triage. atomic-server is
   frozen, so this needs Joep.
2. **Deleting a row under a grant.** #1788 never allows `destroy`. Either
   the grant covers deleting rows of the table's class, or the view marks an
   item removed and the sync app deletes it.
3. **#1849** is not needed: the baseline columns are written by the sync
   app, which owns the rows.

## Steps

- [ ] Sync app 0.2.0: the items table and per-item merge, behind the
      fixture (extend it with moves, indents and duplicate items).
- [ ] View app 0.1.0: read-only checklist on the items table.
- [ ] atomic-server: settle #1740 (and deleting under a grant) with Joep.
- [ ] View app: editing, once the grant exists.
