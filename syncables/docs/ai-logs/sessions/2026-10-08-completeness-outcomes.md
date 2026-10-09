# Session log — 2026-10-08: Collection Completeness 0.2.0 read outcomes

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the second "syncables area worker" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Fable 5.1 (`claude-fable-5-1`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; every provider in the fixtures is invented.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the coordinator session):** Implement the consumer side of
Collection Completeness 0.2.0-draft (PR #387, stacked on the CRUD Causality
0.4.0 fixed-reads PR #382) in `syncables/`: `notFound` (§4.3: what a 404 or
410 from reading an absent object means, `deleted` by default or
`unavailable`; an unavailable record is never reported as deleted, keeps its
last values with a mark, has no queued write sent without a decision, and a
later read supersedes the mark) and `parentAbsent` (§4.4: the members of a
nested collection whose parent object is concluded gone become deleted or
unavailable without being read). Use the spec's `classify_read()` and
`members_of_gone_parent()` as the reference. Keep today's 404/410 → deleted
as the default. Fixture tests only, including that an unavailable record's
queued write is held, not sent. Commit per unit with the required
`Claude-Session` trailer and a session log; no publish, no workflow changes.

**Assistant (first commit, `notFound`):** `declaredAbsence` became
`declaredCompleteness`, which parses the Completeness Object's `absent` and
`notFound` from the same placement as before (the Collection Object, else
the list operation of a collection without a fixed query or body); an
unrecognised `notFound` value takes the spec's default, `deleted`. The route
carries `notFoundMeansUnavailable`, and `findEvidence` classifies a 404 or
410 as the new evidence `unavailable` under it, `deleted` otherwise. The
evidence fails the held updates like `deleted` and `unknown`, with
`missingRecord: 'unavailable'` and a `lastError` that says the record is
unavailable, not deleted, and that `resolveWrite` decides; the visible
record keeps its last known values with the edits on top. A collection with
a deletion feed treats the answer as undecided until the end-of-sync feed
read, so a tombstone (positive evidence of deletion) stands over it and,
without one, the answer applies. The outbox accepts the new value within
version 1. `MissingRecordFailure` is exported. Sixteen fixture tests in
`__tests__/unit/client/completeness-outcomes.test.ts`: PUT and PATCH on 404
and 410 (the write not sent, the values kept, the report), the default with
no field, `notFound: deleted`, an unrecognised value and no declaration, the
operation and legacy placements, no GET under `absent: deleted`, a later
list read and a later 2xx GET superseding the mark for new updates while the
failed ones wait for the decision, the stored value across a restart,
`missingRecordChecks: 'all'`, and the feed precedence both ways. README
(the evidence table and a `notFound` paragraph, the outbox note, an
Unreleased changelog entry) and CLAUDE.md updated. Not verified against a
real provider; no overlay declares `notFound` yet.

**Assistant (second commit, `parentAbsent`):** `declaredCompleteness` also
parses `parentAbsent`, from a Collection Object only. The client maps each
nested collection declaring it to the collection that supplies its path
variable (the read model's providers; a variable `constants` fixes is
skipped). At the three points where a parent record's evidence becomes
final (the GET or declaration for a record with held writes, the GET of a
vanished record, the end-of-sync feed read), a `deleted` or `unavailable`
conclusion is applied to the records last read under it in each such
nested collection, following the spec's `members_of_gone_parent`: `deleted`
only for `parentAbsent: deleted` under a deleted parent, else
`unavailable`. Each member is reported with `source: 'parent'` and its
context, and its held updates fail through the existing path; a member a
write settled on since the sync began is left alone; nothing is pruned; a
`filtered` or `unknown` parent concludes nothing. One policy addition: the
default `missingRecordChecks: 'pending'` GETs a vanished parent record
without writes of its own when a nested collection declaring `parentAbsent`
has unsettled writes under it, so a queued edit of a task in a vanished list
is held and failed instead of sent. Nine tests on the spec's §6.1 task lists
(the `nestedTaskLists` fixture, the spec's `examples/nested-tasks.yaml`
with a PUT on tasks): the §6.1 bullets, a queued task update under a
vanished list and the list's return, no GET for a vanished list without
writes under it, `parentAbsent: deleted` under a declared-deleted parent
(no request at all) and under an unavailable one, no conclusion for a
parent that still exists, without the field, with an unrecognised value,
or with it on the list operation. README, CLAUDE.md and the changelog
updated. Not recursive (a record concluded through `parentAbsent` is not
itself a gone parent); not verified against a real provider.

## Turn 2

**Human (via the coordinator session):** The work is pushed as a draft PR
and under review. #387 is getting a blocker fix: `parentAbsent: deleted`
will require an explicit `notFound` on the parent's collections declared
`absent: removed` (since `notFound` is not allowed with `absent: deleted`);
check whether the parsing assumes otherwise. Then go on with K11: read
`x-crud` `mode` and `patchFormat` for updates on a new branch from main.

**Assistant:** Rebased the two commits onto the rebased spec branch and
merged `main` again. The spec branch's re-review commit adds two document
rules: `parentAbsent` needs exactly one parent resource, and
`parentAbsent: deleted` needs `notFound` stated on the parent's
collections. The consumer now follows both without trusting the document:
a nested collection whose path variables two or more other resources bind
has its `parentAbsent` ignored, and `parentAbsent: deleted` is read as
`unavailable` unless every `absent: removed` Collection Object of the
parent resource states `notFound` (`parentStatesNotFound`; `absent:
deleted` collections pass, since they may not carry `notFound`). Two tests:
a parent `absent: removed` without `notFound` whose 404 concludes the list
deleted by the default but its tasks only unavailable, and a two-parent
collection (`/owners/{ownerId}/lists/{listId}/tasks`) that draws no
conclusion. README, CLAUDE.md and the changelog updated.

## Turn 3

**Human (via the coordinator session):** The Opus review of the draft PR
(#399) found three blockers and nits. B1: a parent collection without
`x-completeness`, or with a defaulted `notFound`, cascades a permission 404
into `deleted` for its members (the resource's first collection is the
provider). Cascade `deleted` only from an `absent: deleted` declaration, a
read or feed tombstone, or a 404 under an explicit `notFound: deleted`;
otherwise `unavailable`; mark defaulted evidence. B2: a DELETE queued behind
an update of an unavailable record is sent without a decision; fail or hold
the rest of the queue, deletes included, and a create into an unavailable
parent's nested scope. B3: `stillMissing` relies on absence from the
confirmed records, which `parentAbsent` never prunes, so a new edit of a
member goes out as a full PUT. Nits: an unrecognised `notFound` as
`unavailable`; a revision check on the vanished parent's immediate cascade;
a README line on a lone queued DELETE; `record` on `unavailable` reports.

**Assistant:** `declaredCompleteness` keeps `notFoundExplicit`, the route
carries it, and a 404/410 read as `deleted` without a stated `notFound` is
marked `Evidence.defaulted`; `applyParentAbsent` cascades a deletion only
from an undefaulted `deleted`, so a parent whose collection declares nothing
(or omits `notFound`) makes its members `unavailable`. The static
`parentStatesNotFound` check was dropped in favour of that. `failMissing`
on `unavailable` fails the rest of the record's queue in order, deletes
included, and parks a create in place with `missingRecord`, stopping at a
head in flight, not yet stored or already parked; `resolveWrite` retry on a
parked head clears the mark. Each concluded nested scope is marked in
memory (`goneParents`, cleared by a complete read of the scope); `update()`
into a marked scope, and `create()` into one whose parent is unavailable,
are enqueued held and concluded at once (`concludeNew`), so neither is sent
on a record the caller cannot read; a create under a deleted parent is still
sent. An unrecognised `notFound` is read as `unavailable`; the vanished
parent's cascade skips a record a write settled on during the GET;
`unavailable` reports carry the last known values as `record`; the README
says a lone queued DELETE is not checked. Six tests added or changed (a 404
under the default with the provider collection undeclared, the DELETE
behind the update, the parked create, the new edit of a member and its
sending after the parent returns, the unrecognised value, `record` in the
reports). The mark is not stored: after a restart a member without writes is
not marked until the parent is concluded again (documented).

## Turn (2026-10-09): follow #387 round 6

**Human (via the coordinator session):** Merge `origin/main` into #399 and
port the delta plan for #387 round 6, without waiting for #387's approval:
`parentAbsent` gives only `unavailable`; `notFound` is resource-wide,
including undeclared collections; an unrecognised `absent` is ignored, but
a stated `notFound` still counts (round 7); a test for the Write
Preconditions consumer's `deletionConfirmed` reading (plan R2); keep
`openapi-extensions/` equal to main; the cross-scope id check if small.

**Assistant (syncables worker 2):** Merged main (throttling and envelope
conflicts, kept both) and reset `openapi-extensions/` to main's (the
#387 spec files leave this PR). `rawCompleteness` finds a collection's
declaration (Collection Object, its list path's operation, or an `x-crud`
list operation of it); `declaredCompleteness` ignores one with an
unrecognised `absent` and reads any `parentAbsent` as `unavailable`;
`resourceNotFound` (after `resource_not_found`, but also counting a
`notFound` beside an unrecognised `absent`) gives every route of a resource
`route.notFound`, replacing `notFoundMeansUnavailable`/`notFoundExplicit`.
The deleted cascade and `Evidence.defaulted` are gone; a create into a gone
parent's scope is always parked. `SyncRound.returned` keeps the ids this
sync read per collection, and a member returned under another parent is not
marked. Tests rewritten and added (resource-wide cases, any `parentAbsent`
under three parent conclusions, the moved member, an unrecognised `absent`,
`resourceNotFound` for R2). README, CLAUDE.md and the changelog follow.

## Turn (2026-10-09): review blockers and nits

**Human (via the coordinator session):** Blockers: `remove()` into a gone
parent's scope was sent at once; the moved-member exemption matched bare
ids across parents (exempt only on the full identity; the probe: the same
id under L1 and L2). Nits: a list operation's `notFound` counts for
fixed-query collections; a lone DELETE of a directly unavailable record
must be checked before sending; under the K4/K5 decisions, a vanished,
write-less record concluded unavailable is kept, marked, not pruned, and a
later `update()` of it is held. Also spec §4.3: after a discard, an
unavailable record keeps its last known values until a later read settles
it.

**Assistant:** `unavailableKept` (stored in the outbox as `unavailable`)
holds every record concluded unavailable, set in `reportMissing` and
cleared by a read that returns it or a `filtered`/`deleted` conclusion;
`rebuild` falls back to it, so neither a vanished record nor a discarded
one is pruned. `update()`/`remove()` of a kept record are held for the next
refresh; `remove()` into a gone parent's scope is concluded at once.
`holdMissing`/`evidenceHead` include deletes, and a held delete is released
(and woken) unless the evidence is unavailable. `SyncRound.returned` is
keyed by scope. `rawCompleteness` takes the operation's declaration for
`notFound` even with fixed reads. Tests for each, the existing
vanished-record test now expects the record kept, and the moved-member test
became the review's probe. Not done: telling the app before pruning in
general (records pruned by a complete read without any check) is the
K4/K5 work; kept records are not looked up again by themselves.
