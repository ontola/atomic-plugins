# SyncD / Keep release candidate and rollout

Prepared 2026-10-29 from `c968e34417ea37d916a3954121253518e322c339`
(merged two-way implementation PR [#713](https://github.com/ontola/atomic-plugins/pull/713)).
This document is a rollout handoff, not evidence of publication, deployment or a
live Google write. Follow [Q-105 and the release recipe](../proxy-release.md):
merged, green `main` reviewed by a state of the art model; Heroku rollout through
the coordinator's worker. The preparing cloud worker had GitHub access but no
Heroku credentials.

## Review and release

Candidates: **syncables 0.26.0** and **atomic-integration-proxy 0.4.1**.
Both previous registry versions were checked as 0.25.0 and 0.4.0 respectively.
The npm release includes all changes since published commit
`5506b2ce3c1d57269ff325fe20b31edaded0efe9`, not only Keep. Review its migration
notes, especially the PostgreSQL history migration and optional inbox body.
The proxy release includes the existing unreleased key-transfer, tier-pacing
and webhook changes; check the rolling-deploy/downgrade notes in its changelog.

1. Have a state of the art model review the implementation/release diffs and
   resolve findings.
   Review the destructive replacement path, create uncertainty, durable receipt
   boundary, credential isolation, schema projection, disabled defaults and
   refresh-scope behavior. Existing green CI is test evidence, not that review.
2. Merge the release PR only after review and all exact-head checks pass.
   **Merging its package.json bump triggers npm publication automatically.**
   Verify `Syncables publish to npm` succeeds and registry metadata identifies
   version 0.26.0 and the reviewed source. Do not manually republish that version.
3. On the reviewed release merge commit, create and push
   `integration-proxy-v0.4.1` as the recipe specifies. Verify its OIDC publication
   workflow and the registry version/checksum before changing the wrapper.
4. In `localthought/integration-proxy`, update the exact dependency from
   `=0.4.0` to `=0.4.1`, then `cargo update -p atomic-integration-proxy --precise
   0.4.1`. Keep the actual registry-generated checksum and source in Cargo.lock;
   do not substitute a path/git dependency or invent an unpublished checksum.
   Run that repository's fmt/Clippy/release-build checks and open its wrapper PR.
5. The coordinator worker merges/deploys the reviewed wrapper, verifies the
   Heroku release's commit/version, `/healthz`, logs and device discovery.
   Discovery must offer `proxy:write`. Existing tokens retain their read grants;
   new write authority requires fresh owner approval. Report crate/npm/Heroku
   versions on #227. No owner/provider secret is copied to the cloud worker.

## Preserve the production catalog

The new source default has ten entries: its prior nine plus Keep. The live
service has historically used explicit catalogs containing additional platforms.
**Do not replace that selection with the ten-entry default or unset
CATALOG_PATH without comparing the current live selection.**

Before rollout, the Heroku worker records only the non-secret current catalog
URL and `/catalog`'s public platform names/profile selections, and the current
release id for rollback. It must preserve every non-Keep production entry,
including OAD pins, overlay order and selection, unchanged. If production uses
a different catalog, create a new immutable catalog derived from that actual
selection and replace/add only Keep with this reviewed entry:

- source candidate: `overlays/catalog/2026-10-29-google-keep-writes.json`;
- OAD pin: `5ccf0e09eef66d45b43e97dfc364233b2707689c`;
- auth + pagination overlays for that pin;
- CRUD overlay `crud-causality-v2-5ccf0e09eef66d45b43e97dfc364233b2707689c-overlay.yaml`;
- selection: `authenticationProfile: googleKeep`.

Require an exact comparison showing that all other production entries are
unchanged, composition/allowlist validation, merged green publication and
`Overlays published` before selecting that catalog. The new source candidate's
Pages bytes were verified after #713; that does not prove it matches the live
service's current selection. A catalog update alone does not enable writes.
Preserve the current owner hub, OAuth credentials, registered public clients
and trusted-proxy settings. Never dump Heroku configuration or credentials.

## Isolated live scratch-note trial

After deployment and package verification, the laptop worker/user runs the
trial with their existing local approval bridge and actual approved Keep
connection. Use a dedicated empty **local PostgreSQL database**, a private
configuration/data directory, and a copy of the exact composed Keep document.
The config's owner, issuer, client id and connection come from the existing
local setup, not invented credentials or values copied into a GitHub comment.
No production notes are selected for editing/deletion.

1. Set the dedicated database URL in `SYNCABLES_DATABASE_URL`; keep it out of
   logs and source. Configure one Keep collection and add
   `"writes": {"enabled": true, "allowReplacement": true}`.
   Verify `syncables edits --collection ALIAS --config FILE` is empty.
   Aliases alone do not isolate queues: scopes can be shared, hence the separate
   database. `send` drains that collection's queued edits.
2. Use `send --interactive` for each write batch and `sync --interactive` for
   each pull, approving only this connection in the owner hub. These foreground
   grants stay in memory and leave the existing shared Keychain session alone;
   each process requires its own approval. A persistent `login --write` can
   replace the stored connection selection used by other daemon processes and
   is deliberately not part of this isolated trial. The owner key remains on
   the laptop and OAuth credentials at the proxy. Approve no unrelated connection
   or administrative access.
3. Write a new JSON input file with a unique trial marker in its title and
   invented checklist items, including a parent and child. Queue `create` with
   `--edit-id UUID`; run `send --interactive`. Record the edit UUID, confirmed returned
   `created_id`, revision and status, without tokens or other notes' contents.
4. Run `sync --interactive` and retain the returned revision. Verify only the scratch note's
   content through local `browse`; the API read can archive the whole account
   even if display filtering selects its marker. Keep that archive private.
5. Change the scratch title and uncheck the child, then queue
   `edit CREATED_ID --at REVISION --input FILE --owned` with the same collection
   and config. `--owned` attests ownership of the note this trial just created.
   Send once with `--interactive`, inspect the receipt, then pull with
   `--interactive` and verify the new id/content.
   Confirm the original scratch id is absent. Never use a pre-existing note id.
6. Queue `delete NEW_SCRATCH_ID --at NEW_REVISION`, send and pull with
   `--interactive`, and verify
   the scratch note is absent. This permanently deletes only the disposable
   note created by this trial. Preserve the local receipt/history for diagnosis.
7. If create is uncertain, **stop**: do not create another note, reset the
   database or discard its receipt. Identify the created scratch note and use
   `adopt-edit` only after verification. If a partial replacement conflicts,
   retain both and resolve explicitly with `keep-both`; never delete by title.
   See [provider write recovery](../../../syncables/docs/daemon-writes.md).

Record trial evidence as operation/status/counts and redacted local result ids;
no credential values, live account dump or private note text. A successful
synthetic trial does not substitute for this Google/laptop verification.

## Rollback and completion

Disable collection writes and stop explicit sends first. Keep queued edits,
uncertain states, replacement receipts and accepted history intact. Restoring a
prior service/catalog release does not undo Google creates/deletes. A proxy
binary predating key-transfer support can re-admit retired agents; do not treat
an arbitrary old-version downgrade as a safe rollback. Use the recorded previous
reviewed release only after evaluating those changelog constraints.

Complete when registry publications, the actual Heroku release and preserved
production catalog are verified, and the isolated Google create/replace/delete
trial has recorded results. The remaining steps are review by a state of the art
model, Heroku-worker access and local owner approval/Keep connection, not another
product authorization decision.
