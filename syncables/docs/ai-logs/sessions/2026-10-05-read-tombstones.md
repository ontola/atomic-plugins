# Session log — 2026-10-05: read tombstones

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), worker subagent of the atomic-plugins oversight session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` and `openapi-extensions/` (the Deletion Feeds draft).
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; tests use invented data.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the oversight session):** Issue #328, part of the maintainer's
decision Q-072. Google Calendar's `events.get` returns a cancelled (deleted)
event as a 2xx with `status: cancelled`, so without a feed syncables'
missing-record GET classifies a deleted event as `filtered` and sends a
held update on it. Let a document declare that an item read also returns
tombstones, reusing the `tombstone { field, values }` marker, either in
Deletion Feeds or a sibling extension, and say how that interacts with §4.3
(which requires 404/410) and with restorable states. In syncables, a 2xx
whose body matches the marker gives `deleted` (`source: 'read'`, with the
GET's status), keeping the invariants of #312/#313/#324/#327/#329 and the
precedence of stored and feed tombstones; decide whether to store such a
tombstone. No Google Calendar overlay (it needs live evidence); invented
fixtures only.

**Assistant:** Extended Deletion Feeds to 0.2.0-draft with a second field,
`x-read-tombstone`: a Tombstone Object on a CRUD Causality Resource Object,
else on the resource's `read` operation (not on a Collection Object, since
the item read belongs to the resource). A 2xx read whose body is about the
object and carries the marker is a read tombstone, which §4.3 now counts
like a 404 or 410; the provider must document the marked state as deletion.
Consumers treat every read tombstone as possibly restorable: a later read
without the marker supersedes it, it SHOULD NOT be kept in place of a new
read, and writes queued before it SHOULD NOT be sent without a decision.
There is no `restorable` field, since it would change no consumer rule.
§1.1, §5, §6, a new §7.4, §8, §9 and the reference implementation note were
updated. In syncables, `findEvidence` returns `deleted` (`source: 'read'`,
the 2xx status) for a 2xx with the record and the marker; the declaration
is parsed by `declaredReadTombstone` with the feed's Tombstone Object
parser. Read tombstones are not stored: the next check reads the record
again, which shows a restore. A new test file covers both answers, PUT and
PATCH, the placements, malformed declarations, the in-flight head, the
budget, no storing with a restore afterwards, restarts, and precedence
against `x-completeness` and stored and feed tombstones. README, CLAUDE.md
and the Unreleased changelog entry were updated.

## Turn 2

**Human (via the oversight session):** Review of PR #330: §9 still forbids
tombstone values for states that stay readable, contradicting §4.3/§4.4; the
supersede rules should require a list read that returns the object without
the marker; Collection Completeness §4.2 should mention read tombstones;
"not stored" overstates, since a feed read can store a feed tombstone for
the failed record; and a malformed resource-level declaration should fall
back to the operation's.

**Assistant:** Reworded §9 and the two supersede rules, added the note to
Collection Completeness §4.2, and described the feed-stored tombstone in the
README, CLAUDE.md and the reference implementation note.
`declaredReadTombstone` now falls back to the item GET operation's
declaration when the resource's does not parse. Two tests added: the
fallback, and a feed tombstone stored after a read-tombstone failure being
used before any GET in the next sync.
