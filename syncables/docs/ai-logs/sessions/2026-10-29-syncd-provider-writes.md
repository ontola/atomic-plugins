# SyncD explicit provider writes

Session: no shareable chat URL was supplied. This redacted repository record is
available at https://github.com/ontola/atomic-plugins/blob/codex/syncd-two-way-keep/syncables/docs/ai-logs/sessions/2026-10-29-syncd-provider-writes.md

Assistant: OpenAI Codex, GPT-6. AI-assisted implementation; no claim of independent
human review. The maintainer authorized continuing the goal and the repository's
standing instructions authorize tested commits, PR creation and merging.

## Substantive human prompts

The maintainer wanted the SyncD Google Keep integration to become two-way, asked
for the proper current Google Keep OpenAPI description, overlays and proxy
catalog, then expanded the request to refreshing every Google description in
ontola/openapi-directory. Those foundation changes were completed in prior PRs
(#466–#469 there and atomic-plugins#711). After discussing worker environment
settings, the maintainer said: “ok, please keep working towards your goal”.

## Substantive assistant work and explanations

Continued with explicit device `proxy:write` authorization and a PostgreSQL local
edit queue. Default scopes remain read-only. Write grants are independent of
read grants and restricted to explicitly approved connections and catalog
operations. Approval text names changes and permanent deletion. Refresh preserves
or narrows scope; old sessions cannot gain write authority through refresh.

Implemented local create/edit/delete queue commands, inspection, explicit send,
cancellation before dispatch, verified adoption of ambiguous creates, and an
explicit keep-both resolution for partial replacements. Writes require collection
opt-in. Keep replacement additionally requires consent to replacement and the
user's explicit ownership attestation; the profile cannot discover the current
Google user's ownership. No runtime provider-name branching was introduced.

The sender uses fresh precondition reads, merges disjoint object changes and
holds competing scalar/list edits. Attachment/collaborator replacement guards
come from the declaration. POST dispatch is recorded first; ambiguous outcomes
are never automatically reposted. A replacement identity is committed before
DELETE, and retirement rechecks the original and replacement. PostgreSQL lock
loss aborts HTTP. Accepted snapshots and read transports retain their existing
role. The revised Keep overlay uses template-derived create identity and explicit
resource-name path segment encoding; previous published overlays/catalogs remain
unchanged. The new catalog changes only Keep's CRUD overlay.

Explained the practical limits: Keep has no conditional DELETE, so the final
read/delete race remains; replacing changes provider identity and loses metadata
the API cannot copy. Competing checklist edits are held, rather than automatically
merged. Uncertain creates with no discoverable created object remain held for
manual investigation. Working-folder and Braid edit ingestion are future work.
No live provider mutation, release or deployment was performed.

## Validation

Invented-provider PostgreSQL tests cover durable intent/receipts, explicit UUID
idempotence, restart recovery, lost POST/DELETE responses, failed creates, remote
conflicts, attachment/sharing guards, write configuration withdrawal, credential
scope/connection restrictions, independent owners, concurrent collection senders
and actual termination of the PostgreSQL lock session. A packaged CLI smoke test
creates, pulls, replaces, pulls and deletes an invented Keep note through the
device protocol, in addition to the existing read/archive/Braid checks.

Final full Syncables run: 105 files, 1,855 tests passed. Focused
write/auth tests: 25 passed, including 19 new write-model/queue cases. Release
build, installed-tarball smoke, formatting, lint and typecheck passed. Both legacy/current Keep Python composition
suites passed (10 tests).

Proxy device tests passed (14). Full local Rust tests require the worker's CA
trust via reqwest native roots and the workflow's invented OAuth fixture
configuration. An initial correctly configured full run passed 301 tests but
hit the existing concurrent chained-owner-transfer assertion; that unrelated
case passed in isolation. A complete serial run then passed all 302 unit tests
and the documentation test. Clippy passed with warnings denied, and all 552
revision-pinned overlays/catalog selections passed the immutability/shape check.
Exact-head hosted CI results are recorded in the PR. No TLS verification or merge gate was bypassed.

This log omits internal tool plumbing and credential values. Only invented test
accounts and tokens appear in committed fixtures.
