# Session log — 2026-11-18: Bundle the Syncables reader in Atomic Server

- **Session** [Codex chat](codex://threads/01a1e36a-4b8c-7ad0-a15e-e2b79fb4171a)
  (local to the maintainer's app).
- **Model and tool** OpenAI GPT-6 in Codex.
- **Scope** Shared reader reuse for the built-in Atomic GitHub Sync app.
- **Delegation** The maintainer requested the refactor. The coordinating agent
  delegated the metadata package, selected-read fix and regression tests.
- **Data** Validation uses invented records and transport fixtures. No
  credentials or private account data are recorded.

## Human request

“Bundle the actual Syncables library into the sync app and remove the
 duplicated discovery and pagination code. Keep the Atomic-specific storage,
 UI and permission checks here.”

## Substantive output

The existing `syncables/browser` reader already accepts an injected transport
and selected collection names. The GitHub catalog currently declares Issues
and comments as CRUD collections, while repository and organization picker
operations are plain reads. The chosen design bundles a trusted, opt-in JSON
Overlay from the existing overlays project alongside the actual reader. Its
collection declarations let the shared library discover parent bindings and
walk pagination. The overlay does not replace or mutate the configured proxy
catalog, and the host's existing endpoint and permission checks still decide
which requests can be sent. Atomic owner grouping, typed storage mapping,
account identity reads, UI and permission checks remain in Atomic Server.

Added a metadata-only `@ontola/openapi-overlays` package and the GitHub read
model. Fixed a selected-read ordering bug exposed by reusing catalog defaults:
selection is validated on the complete model before unrelated collections are
removed. The shared CI path filter also includes the metadata package and read model,
so future metadata-only changes run the reader and browser checks. The tests
demonstrate scoped reads, stable repository-ID binding,
fixed query values, cursor pagination, partial row retention and refusal of a
cross-origin continuation through the actual shared browser reader.

## Validation

The ordering regression failed before the fix. The two focused suites pass
10 tests after the fix. The broader reader and browser-bundle suites pass
521 tests across 24 files. The full shared library suite passes 1,993 tests;
75 optional database/environment tests skip locally. Typechecking, targeted
lint, formatting, metadata package dry-run and changelog validation pass. The coordinating agent records final cross-repository browser
and CI outcomes in the paired pull requests. No npm package is published and
no proxy is redeployed by this change.
