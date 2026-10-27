# Google Keep lists: item-level sync and a checklist view

Status: the sync app is built (#593); its merge and replace check moved to syncables 0.24.0 (CRUD Causality 0.7.0 `unkeyedLists` and `replace`, #595). Follows the Google Keep drive app 0.1.0
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

The baseline is kept in two plain values, no JSON: the note row keeps the
list as both sides had it at the last sync, as a Markdown checklist
(**Keep list at last sync**), and each item row keeps which item of that
list it is (**Keep item at last sync**, an index; empty for an item added
here since). A fingerprint alone is not enough, because pairing Keep's
items with ours needs the old text. An item row deleted here is found by
the baseline item no row claims.

The items table is the one the view edits, so the view only ever writes
rows of one table and one class, which is the scope #1740 grants. It is
also the table a lens would map onto a native Grocery List (Name, Bought).

## A pass, for a list note

Built in `integrations/google-keep/app/lists.ts` (`mergeList`).

1. **Pair Keep's items with the baseline's.** Same text and tick first,
   then same text (the nearest index wins), then an unpaired item between
   the same two paired neighbours (its text edited in Keep). Unpaired
   baseline items were deleted in Keep; unpaired Keep items were added
   there. Weak spots: two items with the same text, or an item edited and
   moved in one sync. Those come out as a delete plus an add.
2. **Merge per item and per field.** Text, done and the item it is under:
   a field changed on one side takes that side. A field changed on both
   sides to different values keeps the drive's value, and the card counts
   it (decided here as the default; a per-item conflict view can come
   later). An item deleted on one side and edited on the other stays.
   Order is merged as moves: the drive's order, with each item Keep moved
   (and the drive did not) put after the item it follows in Keep.
3. **Write.** If the merged list differs from Keep's, it replaces the note
   (the same rules as text notes: never for a shared note or one with an
   attachment, within the pass's write cap), and the rows and baseline
   become the new note's list. Otherwise, or while a replacement is held
   back, the rows take the merge and the baseline becomes Keep's list.

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
3. **#1849** is not needed: the baseline values are written by the sync
   app, which owns the rows. But the view's edits need the sync app's
   item rows to be ones the grant covers: rows of the items table, of its
   class, and only the class's columns.

## Steps

- [x] Sync app: the items table and per-item merge, against the fixture
      (in 0.1.0, which is not released yet; #593).
- [ ] View app 0.1.0: read-only checklist on the items table.
- [ ] atomic-server: settle #1740 (and deleting under a grant) with Joep.
- [ ] View app: editing, once the grant exists.
