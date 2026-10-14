# Google Keep

A drive app that syncs the connected Google account's Keep notes with its
own table, both ways, every minute while the app is open in anyone's
browser. It is the Google Tasks app (`../google-tasks/app/`) made two-way:
the same shape, the same shared sync-status card, the same bounded
rate-limit handling, in its own folder with nothing imported from it.

- `app/`: the drive app. `main.ts` (the view), `controller.ts` (the state
  machine and the one-minute timer), `lease.ts` (one open browser syncs at a
  time), `sync.ts` (one pass), `notes.ts` (the pure mapping and the plan of
  a pass), `read.ts` (the four Keep calls and the rate-limit handling),
  `drive.ts` (the app's own class and properties), `status.ts` (the card
  mapping), `store.ts` (the host's types), `build.mjs`. Version in
  `app/package.json`; the built module is `apps/google-keep/<version>/ui.js`.
- `fixtures/google-keep/`: the SYNTHETIC mock-proxy fixture (no recording).
- `e2e/google-keep.spec.ts`: the host journey against the mock proxy.

```sh
node integrations/tooling/run-lane.mjs google-keep --tier typecheck
node integrations/tooling/run-lane.mjs google-keep --tier unit
node integrations/tooling/run-lane.mjs google-keep --tier e2e   # needs the pinned atomic-server binary
```

## Who can connect

Google offers the Keep API to **Google Workspace** accounts only. A personal
Google account's consent ends in `invalid_scope`; the card says so before
connecting. The proxy's Google client needs the
`https://www.googleapis.com/auth/keep` scope (read and write; there is no
narrower scope that allows creating notes). No live account has been
connected yet.

## What a row is

There is no shared note class in `ontology/`, so on first open the app
creates a `google-keep-note` Class in the App's own ontology and makes its
table of that class. A row is one note:

| Column                | Holds                                                                                |
| --------------------- | ------------------------------------------------------------------------------------ |
| Name                  | The note's title (may be empty)                                                      |
| Description           | A text note's text, or a list note as a Markdown checklist (below)                   |
| Keep note             | The note's resource name, `notes/<id>`: the row's identity                           |
| Keep note kind        | `text` or `list`                                                                     |
| Keep presence         | `present`, `trashed`, `deleted` or `unconfirmed`                                     |
| Keep sync held        | Why an edit here is not sent: `conflict`, or a reason (shared, attachment, too long) |
| Keep sync fingerprint | A short digest of the title and text both sides had at the last sync (the baseline)  |

A list note's checklist, one line per item, a child item (Keep allows one
level) indented by two spaces:

```markdown
- [x] Imaginary passport
- [ ] Made-up charger
  - [ ] Fictional adapter
```

A row made here becomes a list note when every non-empty line of its
Description is a checkbox line, a text note otherwise.

## A pass

Reads first (every page of `GET /v1/notes`, then `GET /v1/notes/{id}` for
each note that left the list); a failed read writes nothing. Then the row
and what Keep sent are each compared with the row's sync fingerprint: a
digest of the kind, the trimmed title and the body as compared, taken
when both sides last agreed. A change Keep makes to what a row does not
hold (colour, a pin) leaves the fingerprint as it is.

| Keep changed | Row changed | Result                                                                 |
| ------------ | ----------- | ---------------------------------------------------------------------- |
| no           | no          | nothing written                                                        |
| yes          | no          | the row takes Keep's version                                           |
| no           | yes         | the note is replaced by the row's version (below)                      |
| yes          | yes         | a conflict: nothing written but the mark; the view offers both choices |

A row made here becomes a new note. A note that is new in Keep becomes a
row. A row deleted here is not imported again, and is not deleted in Keep:
the view lists it under "Deleted here, still in Google Keep" with "Bring
back" and "Delete in Keep" (which asks first). At most 25 notes are created
or replaced per pass; the rest wait for the next.

**Replacing a note.** The Keep API has create, get, list and delete, and no
update. An edit made here is sent as a new note with the row's title and
body, then the old note is deleted. That drops what the API cannot write:
colour, labels, pins, reminders and the note's place in Keep's order. A
note that is shared (more than one live permission) or has an attachment is
never replaced, since the new note would lose its collaborators or images:
its row is marked as held back instead. If the delete fails, the old note
is retried at later passes and never imported meanwhile.

**A note that leaves the list** (Keep's list leaves out trashed notes) is
looked up by id once: `trashed: true` marks the row trashed, 404 deleted, a
failure unconfirmed. Edits to such a row are not sent. Restoring the note in
Keep brings the row back to present. No row is ever removed by a pass.

**One account per table.** The first pass records the account the notes
name (the one address on every note's permissions). A later connection to
another account stops with "This table syncs with …", writing nothing.

## While the app is open

The host runs a drive app only in its frame, so the app syncs when its view
is open: on open, on "Sync now" and every minute after. Nothing syncs while
no one has it open. Everyone with access to the drive may have it open at
once, so a pass first takes a lease on the App (`google-keep-lease`), waits
1.5 s for the drive to settle and goes ahead only if the lease is still its
own; another browser shows "Another open browser is syncing". A row is
re-read just before its note is created, so a row another browser has just
sent is not sent twice. The lease narrows concurrent passes, it does not
rule them out on a drive slower than the wait.

## Evidence

Declared, unit-tested (49 tests: the mapping, the plan, a pass against the
fixture through a fake host store, the lease and the controller, the card)
and **Host E2E** on the synthetic fixture: catalog install, connect, the five
notes imported, a reload that writes nothing, an edit made in Keep pulled, a
list edited here replacing its note, a shared note held back, a conflict
settled for the row's version, a row created in Keep, a trashed note marked.
Nothing verified against Google: what Keep returns for shared notes, the
permissions of a Workspace account's notes, and what `GET` answers for a
trashed note are modelling choices of the fixture (see its header).
