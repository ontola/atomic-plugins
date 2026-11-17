# Google Keep OAD and SyncD catalog preparation

- Assistant: OpenAI Codex, GPT-6.
- Date: 2026-10-29 (Europe/Amsterdam).
- Chat URL: unavailable in this execution context. This file is the durable
  session record; no private account data or credentials were accessed.

## Human requests

"I want to make my Google Keep integration of SyncD two-way. what is needed
for that?"

"ok start by using the proper OAD for google (keep) and make sure this is up
to date in ontola/openapi-directory, then check the overlays and update it
in the integration-proxy catalog."

During this work: "can you refresh all of google in ontola/openapi-directory
please?" The broader refresh continues separately; it does not expand this
catalog change to unrelated providers or enable provider writes.

## Substantive response and implementation

Explained that SyncD and its device grant are read-only, while the separate
Keep drive app has fixture-tested two-way logic. Keep has no update method:
edits require create/delete replacement, changing resource identity and
losing metadata the API cannot write. Durable local edits, an outgoing
queue, conflict handling and device write authorization remain follow-ups.

Refreshed Keep alone in ontola/openapi-directory PR #466, merged after its
gate passed. Compared the complete official Discovery revision 20261019
with the conversion. Preserved all seven methods, corrected OAuth-flow
alternatives, expanded attachment download to avoid overwriting notes.get,
and retained APIs.guru curation. Full OAS/typed-YAML validation, all 80 local
references and method/schema/scope inventories passed. Retrieval and
conversion provenance, including the web-reader normalization limit, is
recorded in the OAD rather than claiming original HTTP-byte hashes.

New immutable overlays pin the actual OAD last-change commit. They select
the four note operations for the existing OAuth profile, follow token
pagination through short/empty pages, declare note identity and generated
fields, and describe replacement guards and unkeyed checklists. A new
default catalog preserves all nine previous-default entries and adds Keep
only. Historical catalogs and published overlays remain unchanged.

Replaced the small hand-authored SyncD example with the exact full catalog
composition. Documented its regeneration command and the new document
scope/history behavior. Neither SyncD write-back nor proxy device write
grants are implemented. No running deployment or provider data was changed.

## Validation

Seven new composition/contract tests, three historical Keep profile tests,
and all ten overlay consumer tests pass. These cover real pinned metadata,
profile/path restrictions, replacement blocks, empty/malformed pages and
continuation through short/empty pages. Ordinary OAS, Pagination Schemes
and CRUD Causality validation pass without new findings. The committed
example must exactly equal the catalog composition.

Further pin/immutability checks and the Rust loader/allowlist regression run
before delivery; hosted CI results belong to the PR's exact current head.
No live Google verification is claimed.
