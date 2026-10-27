# Owned list components

`projectOwnedList` is a consumer-side, one-way projection of one accepted native
record. It materializes an owned component graph without changing the source
OpenAPI description or declaring the components to be API-addressable entities.

The resulting graph has:

- A typed **Note**, retaining the original record's other fields and provenance.
  Its new `body` Property links to a **List**. **Original body** contains the exact
  original JSON value with its source schema metadata.
- A typed **List**, whose parent is the Note. Its ordered `items` references are
  the top-level list entries. The List is also a standard Atomic Table, so the
  data browser can display its item resources in columns.
- A typed **ListItem** per entry, including duplicate and blank entries. All
  items have the List as their Atomic parent. A nested item has a **Parent item** link
  to its logical parent item; ordered `child-items` links retain nested order.
  `position` is the zero-based preorder index for browsing all items together.

A separate profile supplies the source paths, scalar fields and class labels.
The example `examples/daemon/google-keep-owned-list.json` maps Keep's list and
item structures. These provider paths are data in the profile; the projector
contains no provider-specific parsing or browser code. Field absence is kept
separate from `false`, and unknown source body fields remain in Original body.
Malformed profiles or values fail before publication.

## Prepare a graph

Build Syncables, then provide a native projection and a selection file containing
`{ "rowKey": "…", "bodyPropertyKey": "…" }`. Both keys must identify the selected
record and its JSON-valued body Property in that projection.

```sh
npx tsc -p tsconfig.release.json
node examples/daemon/project-owned-list.mjs \
  /absolute/private/path/accepted-plan.json \
  /absolute/private/path/selection.json \
  examples/daemon/google-keep-owned-list.json \
  /absolute/private/path/owned-list-plan.json
```

The command makes no provider requests and never overwrites the output file.
The generated plan contains only the selected Note, its components and required
schema definitions. It uses the existing `atomic-tables-v2` wire representation;
`local: "drive"` is the destination-drive binding. Source snapshot revisions and
OpenAPI hashes remain intact, with separate consumer-profile and body hashes.
A signed publisher must bind the graph to the intended existing drive and
verify the fresh stored resources before recording completion.

## Identity and updates

Exact replay of the same accepted snapshot and profile has deterministic graph
keys. Note and List keys are stable for the profile ID, source owner and source
record key. Item keys additionally contain the original body hash and exact
source path. This preserves duplicates and prevents an array index from being
misrepresented as a permanent provider item ID.

This is a snapshot projection, not an installed continuous synchronizer or a
provider write-back implementation. A publisher must retain its allocation
checkpoint, reuse allocated Atomic identities after interruptions, and refuse a
divergent existing import instead of overwriting user edits. Applying a changed
body requires an explicit update policy. Pairing unkeyed items across changed
snapshots remains the baseline-based reconciliation problem documented in
[the Keep list design](../../docs/design/google-keep-lists.md).
