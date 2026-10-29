# Explicit provider writes in SyncD

SyncD can queue local creates, edits and deletes and send them through an
owner-approved integration-proxy device session. The current delivery protocol
supports declared JSON creates and deletes, and resources with a CRUD Causality
`replace` declaration. It refuses operations requiring unimplemented write
preconditions, compound creates or non-generated added-field derivation. Google Keep is the first composed example. Polling,
webhooks, working folders and Braid remain readers of accepted provider snapshots;
changing or deleting a checkout file never sends a provider write.

This source implementation is experimental and unreleased. Tests use invented
providers. Live Google writes, proxy deployment and package publication have not
been verified by these tests.

## Enable a collection and approve a write session

Use the composed `examples/daemon/google-keep.json` document. Add this to the
collection in your configuration:

```json
"writes": { "enabled": true, "allowReplacement": true }
```

Without `writes.enabled`, sending and queuing fail. `allowReplacement` explicitly
accepts creation of a new resource followed by permanent deletion of the old
one. Removing either permission stops the corresponding sends, including
retirement of a partially applied replacement.

Run `syncables login --write --config FILE` and approve changes for the selected
connection in the owner hub. The default login still requests only
`connections:read proxy:read`; a write login additionally requests `proxy:write`.
Old sessions stay read-only. Credentials remain in macOS Keychain. On other
systems, `send --interactive` or `adopt-edit --interactive` performs a foreground
write login and keeps the token in memory. The deployed proxy must support the
new grant; the command cannot add privileges to an old session.

## Queue and inspect local intent

First run `sync` and obtain a revision from `browse` or `history`. Input files
contain the complete desired writable object, excluding generated/output-only
fields. Declared schema defaults are normalized when building the request and
comparing receipts; for Keep, an omitted checkbox means unchecked and an omitted
child list means empty. No defaults are guessed from field names. For a text note:

```json
{"title":"Packing","body":{"text":{"text":"Remember the charger"}}}
```

For a checklist use `body.list.listItems`, for example:

```json
{"title":"Packing","body":{"list":{"listItems":[{"text":{"text":"Charger"},"checked":true}]}}}
```

```sh
syncables create --collection google-keep/work/notes --input note.json --config FILE
syncables edit notes/ID --collection google-keep/work/notes --at REVISION --input note.json --owned --config FILE
syncables delete notes/ID --collection google-keep/work/notes --at REVISION --config FILE
syncables edits --collection google-keep/work/notes --config FILE
syncables send --collection google-keep/work/notes --config FILE
```

Queuing is local and durable before the command returns; only `send` contacts
the provider. Supply `--edit-id UUID` to make repeating a queue command with the
same intent idempotent. Preserve that UUID if the queue command loses its output.
The queue is scoped to owner, connection, collection, bindings, query and exact
OpenAPI document hash. Inspect/drain pending edits before changing the document
or configuration that defines that scope. Configuration aliases sharing a scope
also share its edits and lock.

`--owned` is your explicit attestation that you own the original note. The Keep
API has no current-user ownership lookup in this profile; SyncD cannot infer
ownership from a permission list containing an owner. Google ultimately enforces
delete authorization. Replacement is blocked for attachments or live
collaborators. It also loses Keep colour, labels, pins, reminders and ordering,
which the API cannot copy. Use the Keep application for notes needing those
features.

## Outcomes and recovery

Accepted provider snapshots stay separate from pending edits. `edits` shows the
baseline, desired object, request body, created identity, state and receipt.
After sending, run `sync` to observe the provider's new state and update folders.
The new note has a new provider identity; completed receipts preserve the
old-to-new association and prevent editing an already retired ID. No stable
identity across replacements is promised by this version.

Before replacement, a fresh GET merges disjoint object changes with the local
edit. Competing changes to a scalar or list pause as `conflict`; checklist
changes on both sides are held for review. A no-op edit is cancelled without
creation. Before deletion, fresh GETs verify that the original is unchanged and
the durably identified replacement still exists with the sent content. Keep
has no conditional DELETE: another writer can still change the original between
the final GET and DELETE. This process cannot provide an atomic replacement or
eliminate that last race.

A create is durably marked before dispatch. A crash, missing identity, HTTP 408,
5xx or lost response becomes `uncertain` and is never automatically posted
again. Inspect Keep and identify the exact created note, then use:

```sh
syncables adopt-edit EDIT_UUID --created-id notes/NEW_ID --collection google-keep/work/notes --config FILE
syncables send --collection google-keep/work/notes --config FILE
```

Adoption freshly verifies the named note's writable content against the stored
request. It records identity only; the next explicit `send` performs retirement.
This is a user assertion of identity, not a uniqueness inference from matching
titles. If no note was created, the uncertain edit remains held for manual
investigation; this version deliberately offers no automatic uncertain-POST
retry or discard.

A confirmed create identity is committed before deleting the original. Interrupted
retirements remain `retiring`; another `send` only checks and deletes that same
original. It never creates another replacement. If the original changed after
creation, both are retained as `conflict`. To keep both and settle the queue:

```sh
syncables keep-both EDIT_UUID --collection google-keep/work/notes --config FILE
```

Use `cancel-edit EDIT_UUID` for a queued, failed or conflicted edit that has no
created receipt, then pull and queue a revised intent. A definite create refusal
stays `failed` and never deletes the original. Retrying a retirement always
requires unchanged content and the stored receipt; missing originals (404/410)
are already retired. No credentials or authorization headers enter the edit table.

Reads and writes share the existing PostgreSQL collection advisory lock. Losing
that database connection aborts HTTP and prevents subsequent calls. The write
transport performs one attempt, rejects redirects and connection escapes, limits
input to 1 MiB and responses to 8 MiB, and never uses the read replay cache.
