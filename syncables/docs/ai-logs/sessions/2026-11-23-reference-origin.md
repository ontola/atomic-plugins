# Session log — 2026-11-23: Stored reference navigation

- **Session:** Continuing the maintainer's [Codex chat](codex://threads/01a1e36a-4b8c-7ad0-a15e-e2b79fb4171a).
- **Model and tool:** OpenAI GPT-6 in Codex.
- **Scope:** Generic saved read selections rooted at stored embedded records.
- **Delegation:** Separate library implementation and architecture review;
  Atomic storage, native views and permission checks remain in atomic-server.
- **Data:** Invented test records and injected transports. No credentials or
  private provider data are included.

## Requests and substantive output

The maintainer requested navigation from an organization resource to filtered
repositories and issues, ordinary stored-data views without provider reads on
opening, and continued completion of the integration. Earlier instructions
authorized consuming the actual npm Syncables library and publishing its needed
updates after checks pass.

Inspection found that embedded organization records already have canonical
numeric identities and useful supplied fields, but no originating collection
read. The existing saved-selection shape required that read. The coordinator
rejected synthesizing one or using mutable address-only filters, because these
would misrepresent evidence or lose the existing detail identity check.

The library now accepts an omitted `OriginRecord.read` for a stored reference.
An explicitly supplied read remains strictly validated. Compilation always
re-derives the entity identity from the current catalog, raw record and typed
context. Existing relationship and response-Link identity validation remains
in force. Selection keys continue to use canonical identity and relationship
selectors; reading a target does not fabricate an origin observation or history.

Regressions exercise serialization, rejection of invalid supplied reads, direct
and two-hop navigation, stable identity keys, current-origin replacement and a
wrong-identity detail response stopping before the target collection request.
The coordinator reviews the implementation and paired native acceptance before
publication; exact validation and publication results are recorded in the PR.
