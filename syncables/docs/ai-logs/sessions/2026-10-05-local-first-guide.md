# Syncables local-first guide — 2026-10-05

- **Session:** [Codex conversation](codex://threads/01a0fb75-f5eb-7293-9664-36d7bb89c7a2)
- **Tool/model:** OpenAI Codex, GPT-6-based coding agent; the exact deployed
  model version is not exposed in this session.
- **Scope:** Syncables documentation in `ontola/atomic-plugins`. This continues
  the [unified-client session](2026-10-02-unified-client.md); the newer outbox,
  pending-write and failure-class implementations were authored in other
  sessions and are documented here as existing behavior.
- **Review/merge:** The maintainer requested these docs and previously said
  “i trust you, merge your pr when you see fit”. The assistant reviewed the
  text and examples under that standing delegation. This does not claim human
  line-by-line review of the draft.
- **Redaction:** No credentials or personal API data were used. The demo's
  Notes API, records and provider responses are invented. Personal filesystem
  paths and tool-call plumbing are omitted.

## Human request

“can you write docs that present Syncables as a useful tool, depending on
openapi-directory, openapi-extensions, and overlays, and explain how it can be
used to local-firstify any API”

## Assistant work

Read the current source and documentation after updating from `main`, including
the newer durable outbox, failure classes, uncertain-create and conflict
behavior. Checked OpenAPI Directory's primary documentation and the repository's
extensions/overlay publication model.

- Reframed the README around the useful outcome: an existing API's collections
  become a local working copy with local reads and background write delivery.
- Explained the roles of OpenAPI Directory, openapi-extensions and overlays,
  with a composition diagram and a link to a practical guide. Distinguished
  metadata sources from mandatory installed npm dependencies.
- Added `docs/local-first.md`: a complete runnable Notes example, followed by
  the workflow for choosing a description, adding metadata, composing overlays,
  configuring direct/proxy transports, using local reads/writes and polling,
  persisting records/outboxes, optionally archiving raw responses, and showing
  delivery states in an app.
- Described requirements for general API support, including stable identities,
  supported JSON mutation shapes, reference bundling, Overlay selector limits,
  provider CORS and deletion evidence. Did not claim every API or every
  extension feature is already supported.
- Distinguished current unreleased source from the published `0.18.0` API,
  and supplied build commands for running the guide against the current source.
- Preserved the existing detailed API/recovery reference and AI/funding
  disclosure in the README.

## Validation and limits

Release compilation passed with Node 22. The exact complete code block was
extracted from the guide and run against the built package: it asserted two
pages, three local records, an offline edit visible locally before the provider
changed, a retry attempt, and eventual delivery after returning online.
Relative documentation links and heading anchors resolved, and the diff passed
whitespace checks. CI results and the resulting PR are recorded in the PR body.

This is a documentation change. No live provider was contacted by the demo;
it does not establish production compatibility, browser behavior, persistence
durability or provider-specific authentication. No runtime or package version
changes, and no npm publish, are part of this work.
