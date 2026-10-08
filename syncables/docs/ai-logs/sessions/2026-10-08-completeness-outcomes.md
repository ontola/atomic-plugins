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
