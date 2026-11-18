# Session log — 2026-11-18: Use the shared Syncables reader in Atomic Server

- **Session** [Codex chat](codex://threads/01a1e36a-4b8c-7ad0-a15e-e2b79fb4171a)
  (local to the maintainer's app).
- **Model and tool** OpenAI GPT-6 in Codex.
- **Scope** Shared reader reuse and ordinary GitHub catalog metadata.
- **Delegation** The maintainer requested the refactor. The coordinating agent
  delegated the provider declarations, selected-read fix, release preparation
  and regression tests.
- **Data** Transport tests use invented records. Catalog composition reads only
  immutable public OpenAPI sources, with overlay bytes from the checkout.
  No credentials or private account data are recorded.

## Human requests and steering

“Bundle the actual Syncables library into the sync app and remove the
 duplicated discovery and pagination code. Keep the Atomic-specific storage,
 UI and permission checks here.”

The maintainer subsequently asked for ordinary specification-based overlays
published through the IAP catalog, rather than a separate bundled metadata
package, and authorized merging the paired PR and bumping the npm package
version. The coordinating agent carries out publication only after the
applicable tests and required CI checks pass.

## Substantive output

The existing `syncables/browser` reader accepts an injected transport and
selected collection names. Added an ordinary GitHub OpenAPI Overlay declaring
organization, repository and stable repository-ID Issues collections with
CRUD Causality and Pagination Schemes. The new dated
`2026-11-18-syncables-apps.json` catalog selects it. Page sizes of 100 are
consumer query selections in the catalog; the Issues collection defines its
complete history read with the standard `listQuery: {state: all}`.

The canonical repository-ID listing extends the existing `issue` resource
and uses its complete provider schema. It does not create a second issue
entity or reduce that schema to an app-specific subset. A regression checks
that both raw and typed readers can select this listing using only
`repository_id`, without legacy owner/repository-name parameters.

The client reads the proxy's composed document and selection normally. The
shared reader discovers parent bindings and walks pages; Atomic Server keeps
owner grouping, typed storage mapping, account identity reads, UI and
permission checks. An initially prepared separate metadata package was removed
after the maintainer's steering. There is no separate metadata package or
runtime overlay patch in the accepted client design.

Review identified a compatibility concern with changing the global default:
existing read-all clients could begin enumerating repositories. The proxy's
previous default stays unchanged, and the new catalog is explicitly opt-in
through `CATALOG_PATH`. Historic dated catalogs and revision files are unchanged.

Fixed a selected-read ordering bug: catalog defaults are validated and applied
on the complete model before unrelated collections are removed. Prepared the
additive `syncables` 0.28.0 release with its changelog tool and version command,
including the existing valid unreleased fragments. The CI path filter also
covers the new catalog and overlay.

## Validation

The ordering regression failed before the fix and passed afterward. The full
shared library suite passes 1,993 tests; 75 optional database/environment tests
skip locally. The subsequent canonical-entity regression passes with the
focused reader tests (11 cases). Typechecking, targeted lint, formatting and changelog checks pass.
The real catalog composition tests pass four cases, including OpenAPI validation,
no new CRUD validator findings, unchanged earlier catalog entries and separation
of provider metadata from consumer page sizes. Fourteen OAD pin tests pass.
The proxy's actual checked-in catalog loader passes both the new opt-in
catalog regression and the unchanged default catalog regression.

The coordinating agent records cross-repository browser tests, required CI,
merge and npm publication outcomes in the paired PRs. This delegated subtask
has not committed, pushed, merged, published or deployed anything.
