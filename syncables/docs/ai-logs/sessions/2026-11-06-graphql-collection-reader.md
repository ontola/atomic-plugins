# Session log — 2026-11-06: GraphQL collection reader

- **Session:** [Codex chat](codex://threads/01a1b031-fe1e-756f-ae2e-7179197f6070).
  This link is local to the maintainer's Codex app.
- **Model/tool:** OpenAI GPT-6 in Codex.
- **Scope:** overlay audit and GraphQL plan; this log records the syncables
  reader work and the contract it consumes.
- **Review/delegation:** the maintainer requested implementation and authorized
  pushing and merging. Required repository checks still apply.
- **Redactions:** no credentials, provider-account data or personal information
  are included. Internal tool plumbing is omitted.

## Human requests

“work on overlays. any gaps in ones that are already used by
integration-proxy? please also write a plan for how we'll do overlays or
something similar for GraphQL APIs”

“ok, add the plans to the repo and work on it”

“ok push and merge. then work on the execution of the plan”

## Substantive assistant outputs and implementation

Audited the proxy's source-default catalog and proposed immutable catalog
updates. Added a GraphQL implementation plan separating pinned schemas,
named operations, variable policy, proxy authorization and collection reads.
The initial contract/catalog change was pushed and merged as atomic-plugins
PR #721 after its required CI, overlay, spec and proxy checks passed.

The follow-up implements GraphQL Integration 0.2 collection metadata,
result-path/argument binding validation, pinned introspection snapshots,
and a Python execution/reader reference. Synthetic schemas and tests cover
query execution, partial errors, continuation and variable policies.

The `syncables/graphql` subpath adds the browser-safe TypeScript reader over
an injected operation-ID executor, with explicit cursor and empty-page offset
termination, per-read limits, identity checks and generic executor failures.
The reader imports the contract's synthetic fixtures in its tests and bundles
without Node built-ins or a GraphQL parser. Traversal completion is separate
from deletion evidence; `absenceEvidence` is always false. No REST replica
pruning, credentials, endpoint choice or GraphQL proxy route is implemented.
The callback's connection authorization and pinned-query validation remain
the responsibility of a future trusted executor.

## Validation

The 26 Python contract/reference tests and four example manifests pass.
The 18 TypeScript reader tests pass, including browser bundling and bounded
failure behavior. Full syncables build/lint and unit-suite results are
recorded in the completion update below. Fixtures use invented data only;
no provider calls or real grants are used.

Completion validation: `npm run build` (including lint),
`npm run prettier:check` and changelog validation pass. The full unit suite
passes with loopback sockets enabled: 107 files / 1,955 tests passed;
6 files / 67 tests skipped (optional external-service/native prerequisites).
The initial sandboxed run failed on loopback `listen EPERM`; it was stopped
and rerun with the required socket access. The built `syncables/graphql`
subpath imports successfully. No production provider calls were performed.
