# Versioned Atomic Data: local Git experiment

Michiel requested this experiment on 2026-10-20 for the standalone Syncables
daemon: store all resources and all schemas in Git, and address either at a
specific commit or tag. This document defines that local storage/resolution
contract. It is not a claim of a new published Atomic Data standard, native
Atomic synchronization, or an installed daemon.

Related work: [standalone daemon](../../syncables/docs/daemon-design.md),
[#566](https://github.com/ontola/atomic-plugins/issues/566), and the frozen-schema
questions O14/O15 in [Pieces](pieces.md). Frozen schema identity and Git history
are separate: Git commits identify a dataset snapshot, not a replacement
algorithm for Atomic's derived schema identifiers.

## Model and default

A resource keeps its stable Atomic subject IRI and JSON-AD property IRIs.
Classes, properties and datatype definitions are themselves resources. Data
and the schemas needed to interpret it belong in the same versioned repository;
there is no separate unversioned schema authority for historical reads.

The default in Syncables is **commit-pinned snapshot resolution**:

1. Choose a collection/data scope and resolve its current head once.
2. Open the resource at that full commit ID.
3. Resolve schema resources and other implicit same-snapshot references at
   that same commit, including during a paginated browse operation.
4. Return the resolved commit with the result. Continue paging or inspecting
   history against that commit even if synchronization publishes a new head.

An explicit reference can select a different snapshot. Schema evolution never
silently changes how an old data revision is interpreted. A live/latest view
is an explicit choice to resolve head again, not the meaning of a stored pin.

## Resource and schema addresses

Use a structured reference in the local resolver API/context rather than
inventing a public versioned-IRI syntax:

```json
{
  "repository": "personal-syncables",
  "scope": "<collection/definition scope>",
  "subject": "https://example.test/schema/issue",
  "at": { "commit": "<full Git commit ID>" }
}
```

`at` contains exactly one of `commit` or `tag`. The same structure addresses a
record, class, property or datatype. `repository` is a configured local store,
not a URL the daemon follows automatically. Repository selection and scope
access are checked before resolving a subject. The current storage API binds
the repository through its `GitAtomicStore` instance and accepts scope, subject
and a full commit ID or `tag:NAME`; the JSON envelope is the interchange design.

A subject without an explicit `at` inherits the surrounding resolved snapshot.
A cross-snapshot schema reference must be explicit in the referring context;
do not silently resolve it from a newer head or from the network. Return an
explicit missing-resource/schema result if that dependency is absent. Complete
schema-closure import and validation must be implemented before claiming that
an arbitrary imported graph is fully self-contained or schema-validated.

Tags are convenient names, not intrinsically immutable identities. Resolve a
tag to a commit at the beginning of an operation and return/save the commit.
The Syncables API creates tags once and refuses overwrites; an external Git
command can still move or remove one. Historical provenance therefore records
commit IDs. A tag must resolve to a commit in the selected scope's history,
not an arbitrary resource from another owner/account scope.

The experimental store uses SHA-256 Git object format. Full commit IDs are
64 hexadecimal characters. Resource/schema content hashes and raw-response
hashes have independent encodings; none is interchangeable with a Git commit.

## Repository layout and publication

Use a private, local bare Git repository owned by the daemon. Each configured
source/definition scope has an append-only branch. Resource files are named by
a hash of the subject, avoiding filesystem traversal or assumptions about URL
paths. Each file contains JSON-AD with an unchanged `@id`. A context file records
the scope, format/mapping version, schema context and source provenance.

All imported resources and their imported schemas are ordinary entries in the
same commit tree. The storage layer can retain both; it does not synthesize
missing external schemas. The initial source projection can store each raw
provider record in a JSON-typed property and bundle its own class/property
resources. Rich typed ontology/lens mappings and importing the full core
schema dependency closure remain separate from storing a snapshot.

Prepare a complete tree and commit before publishing it with compare-and-swap
on the scope branch. Concurrent or stale writers cannot replace a newer head.
Failed preparation can leave unreachable Git objects, but exposes no partial
snapshot. Repeated unchanged trees reuse the existing commit. A → B → A has
three revision occurrences even when the final resource bytes equal the first.
Deletion removes a resource from the new tree; retained commits still resolve
it. No automatic history pruning or destructive Git GC is part of this pilot.

Git commits here are local snapshot versions. They are not Atomic signed
commits, provider revisions, permissions, semantic merges or CRDT operations.
Do not enable a remote, push, run hooks or install native peer replication as
a side effect. This data repository is separate from the source-code checkout.

## Syncables persistence boundary

Keep the three roles explicit:

| Role | Durable source |
| --- | --- |
| Original API responses and nested-hash response logs | Separate laptop PostgreSQL archive; exact response text plus lossless content-addressed JSON nodes. |
| Daemon's Atomic data copy, imported schemas and their history | Local Git snapshots under this experiment. |
| Scheduling, inbox acknowledgements and outgoing intent | Laptop PostgreSQL job/inbox/outbox records; no credentials in either store. |

Raw response archival commits before applying a data observation. A successful
recorded run can then be referenced by the prepared Git snapshot. Publish the
Git head only after the required responses are durable; its context includes
any incremental checkpoint needed to resume that exact data state. A lagging
job-status update is recoverable from the published snapshot. There is no
transaction spanning PostgreSQL and Git, so retries must distinguish raw-only,
prepared-but-unpublished and published-but-not-acknowledged work.

This changes the earlier plan's placement of the projected data copy, not the
choice of PostgreSQL for response logs and durable outgoing operations. Git is
not the webhook queue and a Git commit does not acknowledge a provider write.
Owner keys and device credentials remain outside both data repositories.

## Experiment checks

- Snapshot a resource together with its schema; change both and resolve the
  original pair at their old commit.
- Resolve a tag, advance head, and keep using the originally resolved commit.
- Refuse a tag update, invalid revision, cross-scope lookup and unresolved
  schema; never silently fall back to current/live schema data.
- Preserve lossless JSON numbers and ordinary IRIs; do not turn version pins
  into altered resource identities.
- Prove A → B → A, deletion/history access, restart reconstruction and
  compare-and-swap publication under competing writers.
- Interrupt between archive commit, Git preparation/publication and job
  acknowledgement; resume without a skipped source checkpoint.
- Measure clone/storage/history cost using representative invented data before
  choosing automatic retention, repository splitting or semantic merge policy.
