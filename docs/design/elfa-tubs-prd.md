# Atomic plugins product requirements for ELFA and TUBS

Draft for product review — 12 October 2026. This PRD owns portable view plugins, provider integrations, transformations and sync. The companion [database apps PRD](https://git.elfaconsortium.eu/ELFA/database-apps/src/branch/docs/elfa-tubs-prd/docs/PRD.md) owns Resource View, editable schemas and forms. Links target review branches until both documents merge.

## TUBS vision and confirmed direction

TUBS is The Ultimate Bookkeeping System. Each database is a tub, connected through continuous two-way sync and transformations. Data is multi-homed in multiple formats and edited over time by multiple authors. Model authored statements separately from the single reality their uniquely identified subjects concern. De-duplicate representations and flag contradictions while preserving authorship and legitimate disagreement. Subjects can be physical, abstract, argumentative or fictional; identity does not supply an oracle for truth. Distinguish evolution of reality from evolution of recorded statements.

Support semantic merging informed by intent-tree research. Exact representation, merge algorithm and review interaction remain open. Lens law tests and ordinary CRDT behavior do not establish semantic merging or distributed convergence.

Apply [unhosted](https://unhosted.org/) separation of application delivery from data storage and [local-first](https://www.inkandswitch.com/essay/local-first/) principles. Plugins must work using both Atomic Server's view host and ELFA's db-app-runner. For ELFA: use the NextGraph ORM SDK, schemas through useDiscrete, records through useShape, and avoid RDF lists. Host adapters, capability contracts, packaging, schema encoding/versioning and order representation remain design proposals.

## Stack responsibilities

| Component | Intended role |
| --- | --- |
| integration-proxy | Mediate provider access and credentials. |
| openapi-directory | Supply upstream API descriptions. |
| openapi-extensions | Specify API contracts needed for sync. |
| overlays | Add provider declarations and pin API descriptions. |
| Syncables | API-driven reads and sync operations under declared capabilities. |
| Reflector | Sync orchestration above the API engine. |
| Devonian | Transformations and declared get/put behavior, preserving unrepresented data. |
| Integration plugins | Connect external tubs through mappings and supported operations. |
| View plugins | Present/edit compatible collections in either host. |

Continuous two-way sync is the product direction, not a claim that every integration supports it today. Keep each provider's actual scope and evidence in [READINESS](../../integrations/READINESS.md). The [NextGraph snapshot sidecar](../../integrations/nextgraph/README.md) is distinct from direct NextGraph-backed database editors.

## Portable Resource View requirements

View plugins participate in a coherent standalone and embedded Resource View. Support typed collections, cell/row/column editing, linked follow-your-nose navigation, filtering/sorting, bounded work on huge collections, pluggable storage, installed custom views and viewer/editor/history access. Historical states are inspection-only; restoration is not requested.

Updates can arrive from UI edits, store sync, provider integrations or lenses within one store. Views remain agnostic to transport and sync configuration. Sharing, general browsing and integration/sync setup UI are outside Resource View; host/backend configuration remains separate.

Filtering Expenses by category=Food and following Food's Expenses link must identify the same derived collection. Naming/saving the definition need not copy records. Evaluation and writeback happen below the UI. Do not assume a filtered collection permits unrestricted whole-collection writes.

## Requirements and acceptance

| ID | Requirement | Acceptance |
| --- | --- | --- |
| AP-1 | Run views in both hosts | Exercise the same plugin against Atomic Server and db-app-runner with equivalent typed records; disclose unsupported capabilities explicitly. |
| AP-2 | Handle runtime schema edits | Continue on compatible edits, require mapping updates or pause with an explanation; never silently drop fields or records. Coordinate the supported schema profile with database-apps. |
| AP-3 | Declare sync scope | Document read/write fields, completeness, conflict behavior and deletion/absence semantics per provider. Read-only imports explain when local edits are overwritten. |
| AP-4 | Review external writes | Show destination, record and changed values before sending supported two-way edits; do not expand provider permissions on schema changes. |
| AP-5 | Recover reliably | Preserve pending work through rate limits, reconnects and rejected writes; distinguish confirmed, rejected and uncertain outcomes and avoid blind replay. |
| AP-6 | Preserve data through lenses | Demonstrate owned-field writes and preservation of hidden/unrepresented data. Unsupported inverse operations are read-only. |
| AP-7 | Preserve provenance | Represent authors, source/replica, recording time and relevant lens/schema versions; preserve legitimate disagreement and surface unavailable history. |
| AP-8 | Operate locally | Test disconnected local edits and reconnection in the actual host; app delivery and provider availability do not determine ownership of stored data. |
| AP-9 | Gate release claims on evidence | Verify each enabled operation against the actual host and provider/peer. Fixtures support tests and UX review, not live interoperability certification. |

Credentials stay within the existing proxy/host architecture; a view never acquires provider credentials. Do not change existing authorization, release or catalog gates through this PRD.

## Joint boundary and open semantics

Database apps own Resource View interaction, schema authoring/persistence, selected-document data access, navigation and history presentation. Atomic plugins own provider contracts, mappings, transformations and sync orchestration. Hosts own integration setup and permissions. This split is a product responsibility boundary; no new ownership agreement is implied.

Settle cross-format identity, authored disagreement versus editing conflicts, valid time versus recording time, history retention and cross-resource consistency. For derived collections settle insertion, edits that leave a filter, entity deletion versus unlinking, preservation of hidden data and historical lens definitions. Intent-tree mechanics must come from the research rather than invented assumptions.

Devonian value lenses and existing [ontology/API lens design](ontology-api-lenses.md) are architecture inputs; neither establishes general paged filtered-collection writeback or distributed convergence. The [webhook/two-way-sync plan](proxy-webhooks-and-two-way-sync.md) remains governed by its own implementation status and recovery limits.

## Proposed delivery

1. Agree the shared Atomic schema profile and minimal host capabilities with database-apps.
2. Validate one compatible shared-class view in both hosts, including reload and runtime schema edits.
3. Validate one provider's continuous two-way workflow: review, disconnected edits, reconnect, conflict and uncertain-outcome recovery.
4. Add derived-resource identity and explicit inverse capabilities; bound collection work and preserve hidden data.
5. Define provenance/history semantics and intent-tree merge interactions before claiming the full TUBS vision.

Current plugin capabilities remain experimental and scoped by the [README](../../README.md) and readiness matrix. Provider-specific operations and live evidence must be rechecked per release.

## Research and product review

The forms research informs the companion PRD's registration/feedback workflows; it does not expand provider writes or Resource View scope. Use [LiberaForms, CryptPad and Airtable comparison requirements](https://team.elfaconsortium.eu/doc/survey-and-roadmap-af8SuJxk02) to evaluate portable records, export and deployment boundaries alongside UX.

Open decisions: first provider/shared class; host-adapter API and packaging; history/provenance encoding; schema version contract; ordering without RDF lists; permissions for derived writes; semantic merging; owners, dates and budget. Confirmed TUBS requirements originate in the product discussion of 11–12 October 2026; acceptance details and sequencing remain draft proposals.
