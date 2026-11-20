# Session log — 2026-11-20: Catalog-declared record links

- **Session:** [Coordinating Codex chat](codex://threads/01a1e36a-4b8c-7ad0-a15e-e2b79fb4171a), local to the maintainer's app.
- **Model/tool:** OpenAI GPT-6 in Codex, with delegated library and specification work.
- **Scope:** Shared linked-record metadata/projection and a new immutable GitHub overlay/catalog. Atomic storage, views and permissions are implemented separately in atomic-server.
- **Data:** Invented generic fixtures and public API definitions; no credentials or private provider records included.

## Requests and steering

The maintainer requested Atomic links for catalog-declared foreign-key
relationships in general, including supplied nested records such as a
repository's owner. They observed that GitHub often embeds linked-record
details to save another request. They also asked to revisit ordinary Table
navigation after these links work. Earlier authorization permits the
coordinator to merge the paired plugins work and publish npm versions once
the required exact-head checks pass.

## Substantive output

The implementation reuses the existing Embedded Resources extension rather
than inventing provider-specific Atomic mappings. It adds explicit scalar
reference and polymorphic object forms, typed canonical resolution, partial
field evidence, reference-only entity descriptions and actual-journal
observation deltas. Resolution makes no extra request and does not recursively
expand references. Invalid metadata, unsafe identities, unknown discriminators
and mixed-invalid arrays fail closed; ordinary undeclared objects stay JSON.

The fresh GitHub overlay declares user/organization owners and issue/comment
authors using durable numeric identities. Mutable address references remain
navigation-only; no stable label identity is guessed. Existing published
catalog and overlay revisions remain unchanged. Atomic-specific materialization
uses the host's actual response journal, retaining the selected-table iframe
write boundary and the proxy credential vault.

## Validation and review

Focused generic fixtures cover typed and contextual identities, absent/null
fields, object arrays, polymorphism, descriptor tampering, metadata rejection,
no-fetch behavior, old daemon compatibility and unchanged journal replay.
The coordinator reviews the combined source, runs package/spec/catalog checks,
and follows exact-head CI before merging or publishing. Final test counts and
release evidence are recorded in the paired pull request; this log does not
claim an unrun gate or live OAuth verification.

A prepublication composed-catalog audit found that the daemon's legacy parser
rejected explicit representation/discriminator metadata before reading any
history. Five new actual-catalog regressions failed before the correction. The
daemon now consumes the shared validated descriptors, preserving its existing
fixed-object links and retaining unsupported polymorphic/identity values inline
with diagnostics. It does not guess targets. The full package suite then passed
2,154 tests with 85 existing skips; typecheck, lint and formatting also passed.

## Live pagination follow-up

Real verification of the authorized feature found that a related Issues read
used the provider's default page size despite a catalog override. The shared
reader correctly recomputed the canonical bound recipe but discarded its return
in the related-read branch. It now retains that recipe for reading, provenance
and scope. This adds no host adapter or provider-specific branch.

Two regressions using the actual composed GitHub catalog failed before the fix,
then passed for direct-related and fanout reads, including next-page requests,
current query defaults, compiled authorization and actual-journal observations.
The complete package suite passed 2,156 tests with 85 existing skips; typecheck
and lint passed. The patch release is 0.31.1. The Atomic app separately adjusts
its bounded request budget; no reader proof or credential boundary is relaxed.
