# Session log — 2026-10-02: shared reader and local replica

- **Session:** [Codex chat](codex://threads/01a0fb75-f5eb-7293-9664-36d7bb89c7a2), local to the maintainer's Codex app.
- **Model/tool:** GPT-6-based Codex; the precise deployed model variant is not exposed to this session.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Personal filesystem paths and tool plumbing are omitted. No credentials or private provider data are included; tests use invented data.
- **Review/merge authorization:** Michiel explicitly delegated the final review and merge decision to Codex in turn 8 below. Codex performed code review and automated validation; this log does not claim a human line-by-line review.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human:** “have a look at the recently opened syncables issue. how do you think we can evolve Syncables from where it stands now?”

**Assistant:** Read issue #260 and the current source. Recommended separating provider observations, pending local intent and visible state; explicit incomplete reads; a durable outbox; provider-supported recovery for uncertain creates; shared browser/Node resource discovery and transport; later incremental synchronization. Distinguished Syncables replication from Devonian mapping and Reflector orchestration.

## Turn 2

**Human:** Suggested optional storage of raw API responses while retaining Syncables' ability to join collection pages and provide a local-first copy.

**Assistant:** Proposed raw observations beneath an assembled provider copy and a visible projection that replays pending local mutations. Suggested preserving response text before transformation and making storage/retention configurable. Raw archives would not replace a durable outbox.

## Turn 3

**Human:** Required operation both with and without integration-proxy; direct application credentials should come from constructor arguments or environment variables.

**Assistant:** Proposed proxy, direct HTTP and custom transports. Distinguished OAuth application credentials from user tokens; explicit constructor fields would override Node environment values. OAuth consent/token acquisition and refresh would remain in an authentication adapter.

## Turn 4

**Human:** “what is the browser reader?”

**Assistant:** Explained the existing `syncables/browser` entry: injected transport, collection discovery and pagination, returning records/ontology/errors. At that point it did not include the persistent local-copy/write-queue client.

## Turns 5–6

**Human:** “nice, i like the custom transport option. ok yes please unify them” and “go ahead and work on this”.

**Assistant implementation:**

- Extracted shared raw collection traversal (`readCollections`), retaining the typed `readPlatform` projection and a shared pagination walker.
- Exported the browser-safe local-first client/storage. Retained legacy paired-path calls and added metadata-driven named/nested collections, per-call context and POST-body pagination.
- Routed reads and writes through a supplied transport or adapted fetch. Added API-key/bearer helpers, custom authentication callbacks, constructor credentials and Node-only environment fallback.
- Added optional awaited raw data-read response storage before parsing/typing, including error/429/304 responses and excluding auth/cookie headers. It does not archive write/token responses or automatically replay an archive.
- Kept confirmed provider state separate from pending intent; preserved local edits through refresh, older acknowledgements and ID remapping. Incomplete collections do not prune the local replica.
- Added regression tests and browser bundle/runtime checks. Corrected an existing mock fixture whose later test edited an undefined ID after its collection had been emptied.
- Documented compatibility boundaries and remaining #260 work: durable outboxes, uncertain-create recovery, failure classification, explicit same-field conflicts and provider-dependent deletion evidence.

## Turn 7

**Assistant status:** Reported a local, uncommitted implementation, 150 passing tests, lint/format/type/build/release checks and compiled browser CRUD without fetch/process. No real-browser or live-provider verification was claimed.

## Turn 8

**Human:** “i trust you, merge your pr when you see fit”.

**Assistant:** Accepted authorization to review, commit, open the PR and merge after CI. Final code review found a queue-handoff edge case: remapping a create onto an identity with a write in flight could replace the worker's queue and resend that write. Kept the owned queue instance and added a regression test. Added this disclosure log and updated the AI-use description to identify Codex and the explicit review/merge delegation. The PR records the final validation and CI evidence; #260 remains open for the separately scoped recovery work.

**Final review before merge:** After the first CI run passed, a storage-adapter review found that a new client instance could retain stale persisted records after a complete sync. Added a failing regression test, then included existing adapter identities when rebuilding a complete snapshot. Incomplete reads still retain persisted records, and the acknowledgement revision check runs after the asynchronous adapter read.

**Final local validation:** 152 tests passed across 17 files. Lint, TypeScript build and formatting checks passed. Release compilation and package-content checks passed; the browser bundle also exercised CRUD with an injected transport and without Node globals or global fetch. These checks do not establish live-provider behavior.
