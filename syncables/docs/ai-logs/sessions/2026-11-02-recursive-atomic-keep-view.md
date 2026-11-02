# Recursive Atomic projection and Google Keep View

Session: codex://threads/01a19cc4-6c36-7ff3-a198-70a7e84cf1d7
Assistant: OpenAI Codex, GPT-6. Human: Michiel de Jong.

## Substantive human prompts

The user requested investigation and reuse of the Google Keep custom view in
ELFA, with availability based on its intended Atomic Schema. They specified
that the source Atomic Schema must follow the OpenAPI description, including
the boolean type of `body.list.listItems[i].checked`. They then required the
imported source-record table to contain source-id as a string and source-json
as a reference to another table, with nested objects and arrays represented by
linked resources rather than JSON-string fields. They identified
ontola/atomic-plugins as the owner of OpenAPI-to-Atomic generation and said
"ok go" to the upstream change and ELFA integration.

## Substantive assistant outputs and work

Investigation identified Keep View's view(root, store) module, sandboxed host
protocol, schema discovery and renders registration. Existing Braid snapshots
only described the archival wrapper, while the Atomic table adapter retained
many nested values as JSON. ELFA's separate trial branch was using those raw
snapshots. The assistant proposed a generic OpenAPI-derived linked model and
an explicit renderer compatibility contract.

The implementation adds recursiveAtomicProjector in syncables/daemon, and an
opt-in Braid atomic representation. Generated objects, arrays and indexed
array occurrences are typed resources, with explicit null/absence handling and
exact numeric tokens. The raw representation, existing PostgreSQL history and
native Atomic-peer projection are retained. The conversion profile and limits
are documented. Keep View 0.3.0 accepts the exact generated Note class and reads
the source graph directly, retaining read-only behavior and table subscriptions.

The companion ELFA change imports typed RDF in bounded native commits, then
publishes a completed content-document pointer and checkpoint. It supplies a
scoped read-only iframe Store host for the unchanged upstream module, and offers
Keep on its supported Atomic class. A browser verification against the user's
existing Keep collection rendered 111 notes and 803 checklist items, including
search, layout switching and reload persistence. Native failure/retry tests
verify that a partial content build does not replace the accepted pointer.

## Validation and redaction

Syncables' unit/PostgreSQL suite, the Keep view's typecheck/unit/DOM checks,
ELFA's unit/native-WASM tests, TypeScript checks and production build were run.
Focused tests cover recursive schema references, ordering/duplicates, nulls,
numeric precision, schema-based availability and representation version scopes.
CI also exposed a pre-existing same-millisecond collision in the mock proxy's
explicit replay-identity test. The fixture now mints an unused owner request
timestamp before sharing it across agents, preserving every replay assertion
without changing authentication behavior.
The follow-up CI lint run identified missing statement-padding blank lines in
the new Keep reader and fixture. Those formatting fixes pass the full shared
lint and format checks without changing the generated module bytes.
Specific results and any CI limitations are recorded in the PR descriptions.

Credentials, wallet material, provider connection identifiers, note contents,
private local paths and account details are omitted as [redacted]. No private
notes, screenshots or runtime state are included in the repository changes.
