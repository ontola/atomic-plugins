# Session log — 2026-11-19: Flat entity tables and saved selections

- **Session:** Continuing the coordinating [Codex chat](codex://threads/01a1e36a-4b8c-7ad0-a15e-e2b79fb4171a), local to the maintainer's app.
- **Model/tool:** OpenAI GPT-6 in Codex; delegated library worker.
- **Scope:** Syncables browser-safe identity, saved read selections, response-proof authority guards, observations and tests. Atomic storage/UI and deployment are separate delegated work.
- **Data:** Invented generic fixtures and injected transports; no credentials or private provider records.

## Requests and steering

The maintainer explicitly requested implementation of one collection table per
principal/resource type, saved filters and independent per-filter sync rules.
The coordinator assigned additive reusable library APIs, retaining existing
collection readers and projection rather than implementing provider branches.
Identity must use exact CRUD resource keys and typed canonical bindings: root
and organization repository reads deduplicate, while issue numbers retain their
required repository context. Transport aliases and mutable names are separate.

The agreed read selections comprise bound recipes, related records and fanout
from actual source observations. Related selections retain raw/context/address
snapshots, but a host must replay the fresh source detail and verify canonical
identity before unlocking its Response Link. Trusted host origin replacements
are supported. Anonymous-only mode covers every discovery/detail/target read.
The coordinator added optional typed entity constraints to fanout, intersecting
actual source scope so opening one entity does not discard its saved filter.

The coordinating runtime applies latest explicit value/null by property;
absence never clears. The library emits raw/projected records, explicit field
evidence, representation/partition provenance and aggregate completeness. It
owns no Atomic merge, generation, pause or membership policy. The coordinator
initially requested a local candidate only, then explicitly authorized committing
the reviewed library paths, pushing this branch and opening a paired PR after
local checks. Merge, npm publication, deployment and shared server CI remain
with the coordinator.

## Substantive output

Implemented exported descriptions, typed identity, strict selection parsing,
shared durable keys, compile/observe permission guards, shared selection reads
and observation projection. Fanout consumes actual accepted source rows;
missing constrained entities never authorize descendants. Guard replay uses
existing paging and Link resolution with a bounded actual-response journal.
Mutable source addresses may change when a detail response retains canonical
identity. Unknown next-link query parameters require an actual replay-derived
next request, rather than broad permission for declared API query parameters.

Added an optional canonical record identity callback to the existing reader,
leaving legacy defaults intact, so differently typed IDs in one paginated read
are not conflated by string conversion. Reused projection and schema validation;
no published catalog or overlay was modified. Prepared version 0.30.0 for local
consumer review, not publication.

## Validation and review

Generic fixture regressions cover resource aliases, typed/scoped IDs, strict
bound recipes and parser boundaries, stable logical keys, actual-response
identity checks, recursive anonymous security, null/absent evidence, constrained
fanout, incomplete discovery, sibling failures, shared budgets and next-link
proof. A follow-up review normalized fanout entity constraints as a set using
locale-independent key comparison, duplicate elimination and rejection of
inconsistent identity objects. All 2123 library tests passed (85 skipped);
browser bundling, TypeScript, formatting and release build passed. Lint had
no errors. Maintainer/coordinator merge and publication remain separate.
