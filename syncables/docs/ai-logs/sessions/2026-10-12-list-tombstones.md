# Session log — 2026-10-12: list tombstones (K18)

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`: `openapi-extensions/` (spec branch), then `syncables/` and `overlays/`.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** K18's remaining part, list
tombstones: Google Calendar's `showDeleted=true` returns `status:
cancelled` items in a full list read, and Deletion Feeds §8 lists
`showDeleted` as not covered. Spec first (Deletion Feeds 0.3.0-draft, with
validator, tests and an example; cover restores and the recurring-exception
question within §4.4/§9's rule), then the syncables consumer stacked on it,
and a Calendar overlay revision if the evidence supports it.

**Assistant:** The spec branch adds §4.5 `x-list-tombstone`: a Tombstone
Object's `field`/`values` with `except` conditions on the item, for marked
states the provider documents as something else; list tombstones are not
members and are restorable. The pinned Calendar document separates
cancelled exceptions (which clients "should store") from deleted events, and
an exception carries `recurringEventId`, so `except: [{ field:
recurringEventId, present: true }]` keeps them members soundly; a condition
on another object (the parent's state) is ruled out. Here: syncables parses
the declaration into the read model, `readCollections` leaves list
tombstones out of `items` and lists their ids in `tombstones`, and `sync()`
uses them as the first missing-record evidence (`source: 'list'`, no GET).
Tests on the spec's example. A Calendar overlay declares it on the event
list operation, with a test that composes it after the catalog's Calendar
overlays and checks the pinned document's wording. README, CLAUDE.md, the
spec's reference-implementation note and the overlays README updated.

## Turn 2

**Human (via the coordinator session):** #489 merged and declares
Calendar's read tombstone with no exception, so a cancelled recurring
exception read by GET counts as deleted, while the list rule keeps it.
Give every Tombstone Object the same `except`, add a Calendar read-tombstone
revision with the exception (keeping #489's immutable file), give #489's
README section and §1.1 the one reading, and merge main.

**Assistant:** In the spec branch, `except` moved to the Tombstone Object
(§4.3), with the rule there; §4.4's read tombstone and §4.5 use it; §1.1
gives Calendar one reading; the validator checks `except` on every Tombstone
Object and gains `tombstone()` and `read_tombstone()`. Here: the client's
Tombstone is the same parsed object as the list tombstone, so feed items
and read tombstones honour `except` (tests: a cancelled exception read by
GET is `filtered`, a deleted event `deleted`, an unparseable `except`
marks nothing). `read-tombstone-v2-32237fa5…` declares the read tombstone
with the exception; its test checks it equals the list declaration and
reads both cases. The overlays README section is one section for both,
superseding #489's reading. Merged main.

## Turn 3

**Human (via the coordinator session):** #504 review. Blockers: merge
main (conflicts in both READMEs and `client.ts`); the 0.2.0 rule is still
stated unqualified in §4.3, §4.4 and §9 and contradicts `except`; a list
tombstone of a record without writes is told `removed`, not `deleted`, and
pruned even under `retainDeleted`, and it counts against
`maxMissingRecordChecks`. Should fix: tombstones of incomplete reads are
said to count but `findEvidence` runs only for complete reads; say what a
list tombstone and a member with the same id in one read mean. Nits: a
duplicated line in the overlays README, a nonempty `except`, one fallback
rule for an unparseable declaration, one supersede wording, §8 scoped to
feeds, the `singleEvents=true` caveat, the stricter dot-path in the
changelog, and missing tests.

**Assistant:** Merged main (`source` gains both `list` and `write`).
The spec qualifies each statement of the rule with "for items that no
`except` condition excludes", states that `except` is nonempty, places read
and list tombstones by one rule (a declaration that does not parse is
ignored and the other placement's applies), words superseding the same way
in §4.4 and §4.5 ("not as a tombstone"), scopes §8's restores bullet to
feeds, and adds to §4.5 that an object one read returns twice is a repeated
item: the read is not complete and neither copy is evidence. In syncables:
a write-less record returned only as a list tombstone is concluded
`deleted` with `source: 'list'` (removed, or marked under
`retainDeleted`), a kept mark is settled the same way, and no check is
counted; a read that ends without an error but is not complete fails held
updates or deletes of its list tombstones and removes nothing; a list
tombstone's identity joins the repeated-identity check, and a read that
ends with an error reports no tombstones; the list operation's declaration
applies when the Collection Object's does not parse; `list` was missing
from the sources a stored mark is restored with, and is added. Tests for
each, which fail on the code before (one restart test checked separately).
The Calendar overlay comment, the spec example and the overlays README say
that with `singleEvents=true` nothing in the list reports a deleted series.
