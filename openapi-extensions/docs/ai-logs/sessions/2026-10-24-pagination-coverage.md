# Pagination coverage and independent temporal guarantees

- Session: codex://threads/01a11a49-4322-7813-aa0d-2f70ada2be33
- Assistant: OpenAI Codex, GPT-6.
- Date: 2026-10-24

## Human request

"ok, implement #686 in the pagination schemes extension, keeping coverage,
freshness, snapshot consistency and closed-prefix guarantees separate"

The existing discussion requires coverage of selected API views, potentially
stale responses and mixed snapshots, the limits of unchanged polling results,
and stronger append-only behavior without mistaking allocated IDs for ordered
visibility. No private account or provider data is needed for this task.

## Substantive work

Versioned Pagination Schemes as 0.11.0 with four separately declared, opt-in
contracts: coverage, freshness, consistency and closedPrefix. Coverage uses
existing strict unique-field item cursors or rangeWindow semantics. Freshness
retains independent unknown/eventual/bounded promises and a response versus
snapshot-start scope. Coherence distinguishes unknown, response snapshots and
explicit carried/verified read-snapshot tokens. Closed prefixes describe later
first visibility, without implying immutable values or append-only membership.

Added schema definitions, semantic validation after overrides, evidence scope
and provenance requirements, two synthetic OpenAPI examples, and a per-response
Python reference observer. It derives exact ascending/descending intervals,
handles unknown/initial/empty/terminal bounds, refuses capped/truncated or
contradictory evidence, and retains component observations separately. Snapshot
composition requires one logical read and actual request pinning; equal tokens
across unrelated reads are not global snapshot identities. Continuation checks
also refuse skipped last-item cursors, alternative cursors and conflicting body
bindings. Raw observations are not promoted to a completed whole read.

The normative text separates sampling from event history, stale observations
from authoritative state, and auto-increment allocation from commit/index
visibility. Existing documents and traversal flags retain their meaning.
Unsupported ordering/snapshot protocols, richer finality and lifecycle/property
annotations are explicit boundaries. Syncables/PostgreSQL coverage consumption
and persistence remain follow-up work; no provider overlays or live services
are upgraded or accessed by this specification task.

## Verification

Tests cover declarations and contradictory combinations, backward compatibility,
exact large IDs, gaps, non-unique/broken order, field escaping, query/header/body
bindings and local parameter refs, empty/final tails, explicit unordered windows,
caps, errors and incomplete markers, scoped evidence, stale unchanged reads,
concurrent delete/insert across snapshots, pending-to-booked/late visibility,
independent guarantees, and snapshot pinning/composition failures. Final
review also made retirement require coverage and closure in the same coherent
view: a later watermark cannot retroactively validate an older stale read.
A regression retains that older coverage and later closure separately.

Pinned Python requirements were installed in a temporary environment. All 450
tests across 13 extension folders passed, together with all 32 validator example
documents. Pagination contributes 148 tests. Checked 42 local documentation links,
JSON snippets and whitespace. Repository CI and merge gates apply to the PR.
No secrets, private snapshots or owner keys were accessed.
