# Native account folders and collection tables

- Session: codex://threads/01a16c93-853b-7362-94e6-c7287ee8a15e
- Tool/model: Codex, GPT-6.
- Base: the read-only Atomic peer prototype in PR #685, commit c8a1ade6.

## Human requests

The maintainer first requested a laptop test of local SyncD with local Atomic
Server, selected an existing API collection, and asked for native table columns
instead of JSON wrappers. The local experiment verified the existing wrapper
peer and created a separate table view of that snapshot.

The substantive implementation request was:

> ok can you make SyncD generate a table per API collection, grouped in folders
> per account? you don't need to expose the original JSON to atomic, it should
> be enough if you expose atomic data.
>
> so IIUC i'm now using atomic-server to view a drive that is synced from SyncD?
> i like that, but it's different from earlier experiments where we synced data
> to a folder on an existing drive. what are your thoughts on that

## Assistant output and implementation

The assistant explained that the laptop experiment used a dedicated derived
drive and a one-time native transfer through an intermediate replica, not an
installed continuous server connection. It recommended keeping the dedicated
source drive as the native-sync ownership boundary, with existing-drive import
as a separately scoped adapter requiring identity, conflict and removal rules.

The implementation adds a native graph planner over accepted PostgreSQL
revisions. It emits one folder per platform/account and one table per collection,
native row classes/properties/views, and linked resources for nested objects and
ordered arrays. OpenAPI list-response schemas seed declared columns, including
empty collections; observed fields fill incomplete schemas. Original response
and JSON-AD text remain in PostgreSQL. Unsafe numeric values use exact text.

The native companion accepts that graph as a distinct projection format. It
persists identities and property ownership, journals publication, archives
absent members without claiming provider deletion, and replays the selected
graph after interruption. The CLI selects all configured collections by default,
with singular/plural collection selectors and single-collection historical pins.
It refuses old wrapper-store bindings rather than silently migrating them.

## Validation and limits

Invented-data tests cover grouping, empty declared schemas, numbers and nested
values, owner/scope/document pins, multiple PostgreSQL collection heads,
restart/offline catch-up, native replica acceptance, stable identities,
absence/reappearance and interrupted publication. Rust formatting/Clippy and
TypeScript type/lint/build checks are run alongside the package tests.

A full local run initially passed 1,828 tests with one unrelated five-second
Git-history test timeout under concurrent load; that history suite passed when
rerun separately. A complete rerun with two workers passed all 1,829 tests.
All seven native tests, Rust Clippy and TypeScript type/lint/build checks passed.
Exact-head CI is recorded in the PR.

The local real-data layout uses the same generated graph and ordinary signed
localhost HTTP; it is separate from the invented-key native protocol tests.
No provider credentials or owner secrets are included in this log, code, graph
metadata or public test evidence. No permanent background replication service
is installed by this work. PostgreSQL retains intermediate source history;
offline native catch-up projects the current accepted heads.
