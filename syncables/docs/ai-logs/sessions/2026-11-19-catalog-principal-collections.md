# Session log — 2026-11-19: Catalog principals and collection navigation

- **Session** Continuing the coordinating [Codex chat](codex://threads/01a1e36a-4b8c-7ad0-a15e-e2b79fb4171a), local to the maintainer's app, recorded previously in [the shared-reader session](2026-11-18-builtin-syncables-library.md).
- **Model and tool** OpenAI GPT-6 in Codex.
- **Scope** Reusable browser-safe principal, collection-description, binding, navigation, authorization and projection APIs; immutable GitHub catalog metadata.
- **Delegation** The coordinating agent assigned this isolated library/catalog worktree. Atomic Server runtime, stored graph, UI and permission grants belong to separate delegated work.
- **Data** Tests use invented records and injected transports. Composition fetches immutable public OpenAPI sources and reads local overlay bytes. No credentials or private account data are recorded.

## Requests and steering

The coordinator relayed the maintainer's request to discover authenticated
identity and collection navigation from the catalog, place principal/Public
children directly under the provider App, remove hardcoded GitHub owner
grouping, and supply missing organization-to-repository relationships through
normal IAP metadata. Provider metadata parsing, discovery, individual bound
reads and pagination belong in the reusable library; Atomic owns its stored
graph, UI and scoped grants.

The coordinator accepted standard CRUD Reference Objects to a non-enumerable
transport-address resource followed by an ordinary OpenAPI Response Link,
using an actual detail response. Canonical numeric organization/repository
identities must stay independent of mutable login/owner/name route bindings.
Opening a native stored table must not fetch provider data. Public setup may
explicitly resolve a declared source entrypoint before creating its final
canonical bound table, without fabricating a principal or parent record.

Subsequent steering required preserving numeric versus string principal
subjects, client context for pairwise identities, generic presentation/input
metadata, a shared typed projection helper, and nullable/required schema
semantics compatible with Atomic's omission of scalar nulls. The package
candidate is version 0.29.0. Publication and paired PR review remain with the
coordinator; this worker was instructed not to commit, push, publish, deploy,
merge or dispatch shared CI.

Final metadata steering requested factual Organizations/Organization labels,
without the removed synthetic personal-owner grouping, and validated composed
fixtures for local Atomic Server end-to-end checks.

## Substantive output

Both library entrypoints export principal discovery/resolution, preserving
opaque string or safe-integer subjects, namespace, lifecycle guarantees,
client scope/context and optional display claims. The fixed authenticated
HTTPS GET subset is explicit. Pure validators constrain principal lookups,
selected collection/navigation requests and trusted-catalog root entrypoint
GETs; the host still supplies credentials and actual grants.

Collection descriptions include exact CRUD resource keys, resolved schemas,
path inputs, effective anonymous security, presentation labels/enum titles,
identity/reference relationships and standard Response Link entrypoints.
Bindings materialize serializable descriptors without network requests.
Direct parent identity bindings avoid enumerating sibling collections. Link
navigation resolves actual detail responses and binds one concrete child
collection through the existing pagination engine. Public owner/name setup
resolves to a canonical numeric repository context before a table is stored.
Unsupported Link expressions, external/override sources and ambiguous target
aliases are not advertised. A generic non-GitHub fixture exercises the chain.

`projectReadRecord` extracts `readPlatform`'s existing projection. Both share
scalar/schema validation, safe identities and valid date/timestamp conversion.
Missing required fields and nonnullable required nulls fail before storage.
Required nullable fields become recommended Atomic properties; a present
nullable null remains omitted so the host can clear its managed property.

The new dated catalog selects a GitHub read-navigation profile, preserving
other platforms and old published profiles. It omits the legacy mutation and
owner-path CRUD overlay from this new profile and adds one immutable overlay.
There is one canonical Issues collection and one canonical comments collection.
Organizations refer through an explicitly bound login-address resource to a
real detail response Link for organization repositories. Public repository
owner/name detail also links its actual numeric id to canonical Issues.
Documented public GETs and existing canonical aliases have anonymous security
alternatives; authenticated `/user` reads remain authenticated.

The active organization schema now uses Organizations/Organization labels and
contains no synthetic personal-owner/type field. It is a new schema selected
only in the new overlay, preserving historical published schema bytes.
Validated composed GitHub document, selection and source/output hashes were
generated outside the repository for the coordinator's server tests.

## Validation and handoff

The full library run passed 2,093 tests with 85 optional/database cases skipped.
The final focused run passed 74 cases, including the subsequently added actual
GitHub-overlay public entrypoint regression, browser bundling and request-purpose
inventory. Development TypeScript and release compilation pass. Full lint has
zero errors (existing warnings and two test return-type warnings), formatting
and changelog fragment checks pass.

Six actual catalog composition/metadata tests pass after the factual-label
correction. The published-pin check validates 562 overlays/catalog selections
against origin/main, and no old published overlay/catalog is modified.
The frozen executable v2 candidate is `/tmp/catalog-collections-v2/syncables-0.29.0.tgz`;
its SHA-1 is `82a2e53b54b7b23bff4869fa41cd89d2cbeabab8`. The label correction
changes only catalog metadata and tests, not that package candidate.

No commit, push, PR, merge, publication, deployment, shared CI dispatch or server
build was performed by this worker. The coordinating agent records subsequent
local end-to-end proof, review, PR and release outcomes separately.

## Final collection-accuracy review

The coordinator requested an explicit description of the REST Issues API's
pull-request rows because the prior Atomic adapter filtered them. The pinned
issue schema lacked that field, so the new overlay adds optional
`pull_request` object metadata and the presentation title Issues and pull
requests. Resource and collection descriptions state both kinds are included.
No provider filtering rule or runtime code is added; actual returned PR rows
remain visible to the generic reader and stored table. The current fixture
and provenance are regenerated after this metadata-only correction.

## Independent review hardening

The coordinator relayed an independent review finding that the new POST scope
validator allowed a declared empty object path to disappear, and that the
public principal resolver trusted TypeScript's string type for clientContext
at runtime. New regressions reproduced both failures before their fixes.
The validator now requires an own actual object at every declared fixed object
node, including empty nested objects and an explicitly declared empty root
body. The principal resolver rejects supplied nonstring/empty contexts before
transport. A reserved JSON-key regression also exposed the existing resolver's
legacy prototype setter; reference resolution now constructs plain own-key
objects through Object.fromEntries so declared __proto__ data survives and can
be checked. The frozen v2 package remains untouched; v3 is a separate candidate.

V3 validation passes 2,108 unit tests, with 85 optional/database cases skipped;
the three focused regression files pass 52 cases. Development and release
compilation, lint (zero errors), formatting, changelog and diff checks pass.
The v3 artifact is `/tmp/catalog-collections-v3/syncables-0.29.0.tgz`, SHA-1
`2f3d2d84447e1d06df021875c0fb613d828389f7`; earlier candidate bytes are untouched.
Current catalog fixtures/provenance retain the final organization and PR
accuracy metadata and are unchanged by these executable fixes.

Final hardened v3 checks: 2,108 passed and 85 optional/database tests skipped.
Development/release builds, lint, formatting and changelog validation pass.
The 52 focused regressions pass. Candidate SHA-1 is
`2f3d2d84447e1d06df021875c0fb613d828389f7`; v3 is stored separately from v2.
