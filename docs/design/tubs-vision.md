# TUBS vision and the atomic-plugins stack

Status: vision and design discussion, 12 October 2026. This is not an approved
implementation PRD. The vision and requirements below come from Michiel de
Jong's Resource View discussion; candidate contracts and unresolved semantics
are explicitly marked. This document changes no runtime behavior.

## Vision and confirmed direction

TUBS means **The Ultimate Bookkeeping System**. Each database is a **tub**.
Continuous two-way sync connections connect tubs through a network of
transformations. Data is multi-homed, represented in multiple formats, and
edited over time by multiple authors.

The model must represent both **statements made by authors** and the **single
fixed reality those statements concern**, so that representations can be
de-duplicated and contradictions flagged. Statements may be factual, abstract,
argumentative or fictional. Reality need not be physical: people can disagree
about an abstract concept or a uniquely identified thing in a fantasy world.
Shared reference makes disagreement expressible; shared reference does not
require agreement.

“Fixed reality” is the common referent against which claims are compared,
not a requirement that things never change over time. Evolution of reality and
evolution of recorded data are distinct. Nor does a common referent give the
software an oracle that automatically determines which author is correct.

Semantic merging informed by Michiel's research on **intent trees** is a
confirmed requirement. The representation of those trees, merge algorithm,
and user review interaction remain design work. No particular tree structure
or conflict-resolution algorithm is established by this document.

The atomic-plugins stack was designed with this TUBS vision in mind. Its API
descriptions, transport, sync mechanics, lenses, integration plugins and view
plugins provide different parts of that architecture. They do not yet
establish the complete statement model or intent-tree semantic merge.

Public vision: [tubsproject.org](https://tubsproject.org/).

## Unhosted and local-first foundations

Confirmed direction, added 12 October 2026: atomic-plugins should apply the
ideas of [unhosted.org](https://unhosted.org/) and
[local-first software](https://www.inkandswitch.com/essay/local-first/).
Unhosted separates the source of an application's code from the user's choice
of data storage. Local-first emphasizes locally usable data, offline work,
collaboration and continuing user control. These principles complement the
TUBS network of independently operated tubs.

**Proposed product implications:** a view plugin should work on available local
data without requiring its publisher's server; supported edits should be
durably accepted locally and synchronized independently of rendering; the UI
should distinguish local persistence, pending sync, provider acknowledgement
and failed writes. Initial authorization, fetching data not yet present, and
provider-only operations can still require a network connection. Local-first
does not promise that a disconnected device contains an entire huge collection.

The integration proxy remains an optional transport/credential service where
needed, not the owner of the user's dataset or the compulsory persistence path
for every plugin. Deployment and adapter choices must make that independence
real. Supporting two hosts alone does not prove offline operation or user
control; those outcomes need their own acceptance evidence.

Native replication or a CRDT can help preserve and combine changes, but does
not by itself implement the authored-statement model or semantic merging with
intent trees. Retained disagreement, incompatible intentions and domain
invariants remain meaningful after replicas converge.

## Portability across Atomic Server and ELFA

Confirmed requirement: plugins must work using **Atomic Server's view host**
and also **ELFA's db-app-runner**, in
[ELFA/database-apps](https://git.elfaconsortium.eu/ELFA/database-apps).
This is a target requirement, not a claim of current plugin compatibility.
Portable view and domain behavior must not depend on an Atomic Server being
the database backend. Transport/integration components still need an appropriate
runtime; this does not mean every server component executes inside a view host.

The ELFA integration must follow these explicit user requirements:

- Use the NextGraph ORM SDK.
- Store schemas using `useDiscrete`.
- Store data using `useShape`.
- Avoid RDF lists.

The prior drafting session reported that the first and third requirements
were consistent with the runner documentation it inspected on 12 October 2026.
This publication session could not independently recheck the ELFA source
because outbound access to its Git host was denied. The `useDiscrete` schema requirement and
RDF-list prohibition are recorded from Michiel's instruction; they were not
independently located in the runner documents inspected. The precise schema
encoding, discrete document type, SDK API/version and migration rules remain to
be specified. No schema storage implementation is introduced by this document.

**Proposed architecture:** keep domain logic, transformations and reusable view
behavior separate from host-specific mounting, storage, navigation and
authorization. Provide an Atomic host adapter and an ELFA/NextGraph host
adapter. Their supported capabilities should be explicit rather than inferred
from one host's API.

| Concern | Atomic host | ELFA/NextGraph target |
| --- | --- | --- |
| View mounting and host interactions | Atomic Server view host | db-app-runner; mounting contract still to be assessed |
| Data subscription and mutation | Atomic storage interface appropriate to the host | NextGraph ORM SDK with `useShape` |
| Schema persistence | Atomic schema resources where applicable | `useDiscrete`; schema mapping/versioning remains design work |
| Session and authorization | Host-provided Atomic capabilities | Native NextGraph session and permissions |
| Relationships | Preserve declared ResourceArray semantics | Avoid RDF lists; unordered relationships can use RDF sets |
| History and attribution | Expose available evidence | Expose native evidence without inventing Atomic commits or signatures |

Avoiding RDF lists does not imply that all ordered data should become unordered.
If order matters, define an explicit supported representation and mapping;
do not silently drop order when translating an Atomic ResourceArray into a set.
Schema documents, relationship membership and presentation order are distinct
concerns.

The prior session reported that the runner's existing Atomic editor uses real `@tomic/lib` resources through a
limited NextGraph `useShape` storage adapter. Its
[mapping document](https://git.elfaconsortium.eu/ELFA/database-apps/src/branch/main/docs/atomic-data-mapping.md)
describes retained graph/subject identities, reactive updates and supported
edits, but excludes Atomic collection/search/permission APIs and does not
fabricate Atomic commit history. This is useful architectural evidence, not a
complete portable-plugin host contract.

The prior session also reported that the runner's
[RDF conflict assessment](https://git.elfaconsortium.eu/ELFA/database-apps/src/branch/main/docs/rdf-crdt-behaviour.md)
also warns that concurrent values can violate a single-valued shape and remove
an object from the ORM projection while its triples remain. A future adapter
must distinguish projection absence from deletion and preserve a route to
inspect conflicts. That document describes an implementation inference, not a
completed native conflict experiment.

**Proposed acceptance work:** exercise the same view/domain behavior in both
hosts; verify local persistence and restart recovery, external subscription
updates, schema round trips, relationship identity, offline edits and subsequent
sync, and truthful write/conflict/history status. These are proposed checks for
a future implementation, not tests performed during this documentation task.

## Subjects, statements and representations

Keep three identities conceptually distinct:

- A thing being discussed: a transaction, person, abstract concept, argument,
  fictional character or event.
- A statement by an author about that thing, including its context.
- A representation stored in a particular tub or exposed through a view.

This separation is a proposed modeling approach to the confirmed requirement,
not a finalized schema. A provider record ID alone does not establish global
identity: account, tenant and collection scope may be necessary, and explicit
identity correspondences may be required between providers.

De-duplicating two representations of the same transaction must not erase
their provenance. De-duplicating equivalent claim content must not erase the
fact that two authors made it. Two incompatible claims about the same subject
must remain distinguishable. A disagreement is not automatically a concurrent
editing conflict.

Contradiction detection needs compatible meanings and contexts. Different
times, units, perspectives or fictional worlds can explain superficially
different values. Unique identification is necessary for shared reference;
it does not by itself establish logical contradiction.

Illustrative cases, not implementation fixtures:

| Case | Desired distinction |
| --- | --- |
| A bank feed and a ledger identify the same payment | Two representations of one event; preserve source evidence. |
| Two authors assign different categories to that payment | Retain attribution; decide whether categories are exclusive before flagging contradiction. |
| Authors disagree about a property of an abstract concept | Compare claims about the same identified concept without requiring a physical object. |
| Authors disagree about a character's birthplace in one fantasy world | Preserve the world/context and character identity; expose incompatible claims where the model warrants it. |
| A later edition changes that character's story | A contextual or temporal difference may explain the values; do not assume one author overwrote the other's claim. |

The exact vocabulary for worlds, editions, modality, arguments, evidence and
validity is open. These examples do not mandate a universal ontology.

## How the stack contributes

The role column explains the architecture in the TUBS vision. The limits column
separates that role from documented implementation. Source assessment:
atomic-plugins main at `7bb26c7e8e803121bad98f85a8d40c0c94fb7f40`.
Source documentation is not evidence that every deployed version supports it.

| Component | Role in TUBS | Documented boundary |
| --- | --- | --- |
| [integration-proxy](../../integration-proxy/README.md) | Authorized access to remote tubs without putting provider credentials in view plugins. | Stores provider grants and forwards catalog-allowlisted requests using agent ownership/delegation. Transport authorization does not establish the truth or authorship of provider content. |
| [OpenAPI Directory](https://github.com/APIs-guru/openapi-directory) | Describes existing APIs so tubs can participate without adopting a single storage format. | External description source, not a folder in this repo. Catalogs pin exact document revisions; an API description does not supply semantic equivalence between domains. |
| [openapi-extensions](../../openapi-extensions/README.md) | Vocabulary for behaviors needed to traverse and modify API collections reliably. | Specifications cover pagination, CRUD causality and other concerns; consumers support particular subsets. A specification's existence does not imply runtime support. |
| [overlays](../../overlays/README.md) | Add missing provider behavior to API descriptions separately from the provider's document. | Dated catalogs select immutable overlay revisions and pinned OpenAPI documents. Metadata needs provider-specific evidence; it does not invent a provider capability. |
| [Syncables](../../syncables/README.md) | Local-first API copies, collection reads and queued writes beneath the transformations. | Supports declared read/write mechanics, pending writes and conflict reporting. Some source changes are unreleased; this is not general distributed semantic convergence. |
| [Devonian](../../devonian/docs/value-lenses.md) | Transform source representations into views and put supported edits back while preserving unrepresented data. | Value lenses use get and put with previous source and declared ownership. Example law tests do not prove distributed convergence or intent-tree merging. |
| [Integration plugins](../../integrations/README.md) | Bind provider scopes, mappings and supported mutations to actual domains. | Plugins are experimental and vary in readiness. Drive apps, sandbox plugins and libraries have different runtime boundaries; not all are currently installable or writable. |
| View plugins | Present the same data through tables, calendars or custom interactions, with supported edits flowing back through transformations. | Current drive apps combine some integration and presentation behavior. Full separation and reusable view discovery remain architectural work; do not infer a completed general registry. |
| [Reflector](../../reflector/README.md) | Sync-engine/plugin-runtime orchestration above Syncables. | An additional layer in this repository; reuse and runtime placement must be assessed for a particular integration. It is not evidence that every pair of tubs continuously syncs today. |

The layers form a network, not a requirement to pass every operation through
one canonical database. Shared models can be useful intermediate views without
becoming the only allowed representation.

## Transformations and derived collections

Confirmed direction: filtering a collection and following a relationship can
resolve to the same derived collection in the transformation network. Applying
`category=Food` to Expenses and following Food's Expenses link should reach
that same derived resource. Naming or saving the definition need not copy rows.

Lens evaluation and writeback belong underneath the Resource View. A filter
does not automatically provide an unrestricted whole-collection put operation.
The current value-lens API does not establish a general paged filtered-collection
writeback contract.

**Proposed adapter contract:** expose base and derived resources through a
consistent inspection, editing and history interface, with stable identities,
provenance, bounded paging and explicit write capabilities. Decide independently
whether an operation creates an entity, updates it, deletes it, or changes a
relationship. Preserve rows and fields the view does not represent.

Unresolved: creation through a filter; editing a row so it leaves the result;
entity deletion versus unlinking; hidden fields and rows; and historical
versions of transformation definitions.

## Semantic merging and intent trees

The requirement is to support semantic merging using the intent-tree research.
A candidate approach is to carry change intentions alongside state and
provenance through transformations, then judge whether intentions can coexist
before materializing a merged view. This is a proposal, not a specification of
the research.

The design must distinguish:

1. Copies or transformations representing the same underlying statement.
2. Compatible intentions that can both be applied.
3. Competing edits whose intended outcomes cannot both be applied.
4. Legitimate disagreement between authors, which may remain as multiple claims.
5. Violations of declared domain invariants that need review.

Neither last-write-wins nor a successful transport retry answers those semantic
questions. Lens laws help establish representation behavior; they do not choose
whose claim is true. Authorization to write does not confer authority to decide
a disputed claim.

Open design questions include how intentions survive lossy transformations,
which changes can be merged automatically, what evidence supports a decision,
who may resolve an editing conflict, and how a resolution is attributed and
recorded. Intent-tree details must be grounded in the actual research before
selecting an algorithm.

## Resource View product boundary

Resource View is the intended coherent standalone and embedded viewer/editor
experience for Atomic Server's Data Browser. Claiming ownership of that
experience is an intended direction, not an organizational agreement.

Confirmed scope includes typed collections, cell/row/column editing,
follow-your-nose linked navigation, filtering/sorting and bounded work for huge
collections; pluggable storage such as Atomic lib, Nextgraph useShape and
remoteStorage; installing custom views; and viewer, editor and historical
inspection. Historical states are inspection-only; restoration is not requested.

The mode/presentation split (read-only/editable/historical versus
record/table/calendar/custom) is a proposal. History must account for authors,
replicas, Syncables and lenses; local session undo is not this history.

Sharing, general browsing, and integration/sync setup UI are outside this
Resource View scope. Storage can sync elsewhere; the viewer/editor is agnostic
to transport configuration. Backend integration work happens “under water.”
A future merge-review interaction is a design question, not an approved
additional UI.

## Remaining design decisions

Before turning this vision into an implementation PRD, settle:

- Stable identity and correspondence across tubs, formats and contexts.
- Statement attribution, argumentative relationships and retained disagreement.
- Real-world valid time versus recording/history time; contextual scope.
- Intent-tree representation, merge rules, review and resolution provenance.
- Schema evolution, migration, missing/null/optional values and exact values.
- Global filters as convenience versus enforced scope.
- External changes while editing, failed writes and incomplete reads.
- Historical availability, retention, cross-resource consistency and lens versions.
- Custom-view capabilities/installation and measurable large-collection behavior.
- The dual-host mounting/capability contract and packaging strategy.
- NextGraph discrete schema encoding, versioning and migrations; ordered data
  representations that avoid RDF lists.
- Local persistence guarantees and offline/sync acceptance criteria per adapter.

## Related design and evidence

- [Ontology targets and API lenses](ontology-api-lenses.md).
- [Proxy webhooks and two-way sync](proxy-webhooks-and-two-way-sync.md):
  proposed orchestration/recovery work, not proof of universal continuous sync.
- [Plugin readiness](../../integrations/READINESS.md): consult per-plugin evidence.
- [Experimental AtomicServer PR #2069](https://github.com/ontola/atomic-server/pull/2069):
  architecture input for views, integrations and lenses; this document does not
  assert it is merged.
- [Atomic table model](https://github.com/atomicdata-dev/atomic-data-docs/issues/37):
  separates schema, collection membership and view configuration.

Authorship: AI-assisted drafting by Codex from Michiel's explicit discussion
and publication request. Repository documentation was read; no runtime or
live-provider acceptance test was performed. Proposals remain proposals.
