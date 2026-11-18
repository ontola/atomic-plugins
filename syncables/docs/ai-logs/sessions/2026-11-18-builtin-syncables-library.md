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

## Main-branch integration before publication

The coordinating agent delegated merging current `origin/main` into the paired
branch to resolve PR #734's conflict, with review and commit left to the
coordinator. The merge includes main through `3481ef90`. Its sole textual
conflict joined adjacent catalog tests; both GitHub catalog regressions and
main's Dropbox continuation/read-permission regression are retained. The
automatic reader merge keeps selected collection options and main's additive
pagination checkpoint/resume support. The opt-in catalog and unchanged global
default are preserved.

The npm registry and main still report version 0.27.0, so 0.28.0 remains
available. Main's two new valid daemon fragments were folded into the prepared
0.28.0 entry using the repository's `changelog.release` tool, regenerating all
five release fragments in a temporary directory. No package version was
changed again. The added release notes cover sealed device connection grants
and POST cursor continuation reads; their consumed fragments are removed.

Post-merge validation: the full library run passed 2,005 tests and skipped 82
optional cases. Three Git-backed daemon cases reached the existing five-second
timeout under concurrent compilation/check load; their three complete test
files then passed all 16 cases with one worker and unchanged timeouts. There
were no assertion failures. TypeScript, complete lint (zero errors, 21 existing
warnings), formatting and changelog checks pass. Rust formatting and all 28
non-network catalog tests pass; the new GitHub catalog, unchanged default
GitHub catalog and main's Dropbox continuation composition regressions also
pass when explicitly enabled. Python checks pass four actual catalog
composition tests, fourteen OAD-pin tests and three pinned-fetch tests.

## Preserve the deployed catalog baseline

Before publication, the coordinator found that the deployed proxy selects
`2026-11-16-storage-metadata.json`, with 17 providers and GitHub CRUD Causality
v2. The new opt-in catalog initially copied an older ten-provider profile.
Corrected only the unpublished November 18 catalog to preserve the deployed
storage baseline exactly, then append the existing GitHub discovery overlay,
the new read-model overlay and the three consumer page-size selections.
Historic catalogs, published overlays and the global default remain unchanged.

The preservation regression now removes both appended overlays and query
overrides and compares all 17 complete platform profiles with the storage
baseline. It also checks GitHub's v2 `jsonMergePatch` and generated-field
semantics survive composition. Updated the baseline notes and regenerated the
two Atomic Server test fixtures through the actual catalog composition helper,
retaining source hashes and the full provider schema. No production reader
code or server code changed in this correction.

Focused validation passes four actual catalog composition cases, eighteen
selected-collection/continuation reader cases and the proxy's actual pinned
November 18 catalog-loader regression. The server's iframe/profile tests pass
all forty cases with the regenerated v2 fixture. The coordinating agent records the
subsequent exact-head CI and publication outcomes.

## Provider App branding

The user requested a generic native SyncableCollection view and a provider App
resource with the integration icon. The unpublished GitHub read-model overlay now
sets its OpenAPI info.title and x-logo.url to a versioned public image stored in
atomic-plugins. Atomic's installer reads provider branding generically and stores
the image as an ordinary File under the App. No provider logo is bundled into
Atomic Server. The mark is attributed to Font Awesome Free 6 under CC BY 4.0.

The collection browser also derives labels from ordinary OpenAPI 3.0 schema
titles and singleton-enum oneOf branch titles. The unpublished read overlay
provides those labels for organizations and repositories; no executable view
definition or Atomic-only API response field is added. The ordinary composed
OpenAPI validator and four catalog composition checks pass with these fields.
