# Integration-proxy overlay gaps

Reviewed 2026-11-06 against this checkout. This is a source/catalog audit,
not a live-provider or deployment certification.

The source default (`integration-proxy/src/config.rs`) selects
`catalog/2026-10-29-google-keep-writes.json`: ten platforms. The repository's
AGENTS.md records 0.2.4 and localthought.io using `2026-10-02.json`; that is
historical evidence, not a check of today's running service. Later dated
catalogs are alternatives, not automatic upgrades. In particular,
`2026-10-30-production-keep-writes.json` does not become the source default
merely by existing.

## Findings in the source default

| Platform | Selected metadata gap | Next step and evidence |
| --- | --- | --- |
| GitHub Issues | CRUD v1 uses the undefined `patchFormat: merge`; completeness and throttling are unselected. | Evaluate CRUD v2 with `tests/test_github_crud_patch_format.py`, then completeness requirements and throttling. Compound-create is also available but needs separate write-consumer validation. |
| Google Calendar | Uses app CRUD v1; completeness, deletion-feed, list/read tombstones, write preconditions and throttling are unselected. | Evaluate app CRUD v2 and each synchronization declaration together; use the calendar tests. Do not infer deletion from an ordinary listing or an inaccessible item. |
| Moneybird | Uses original pagination, CRUD and throttling; newer revisions and completeness-v2 exist. | Compare pagination-v2 (documented next links) with range-window paging before selecting either. Run `test_moneybird_*` and requirement checks; these are alternative traversal contracts, not additive overlays. |
| Todoist | No completeness selection. | Evaluate completeness-v2 with `test_todoist_completeness_v2.py`; preserve its explicit visibility limits. |
| Spotify | Completeness and throttling unselected. | Use playlist completeness and throttling tests; a successful traversal alone is not proof of a complete provider snapshot. |
| Discord | Original pagination lacks the additional item-derived cursors and archive/audit-log coverage of v2–v4; throttling unselected. | Evaluate v4 using `test_discord_pagination_v4.py` and consumer tests. Item-derived cursor support requires Pagination Schemes 0.9.0; older readers can silently stop after one page. Unsupported/undocumented lists still need explicit limits. |
| Notion | Original pagination does not describe capped-result detection; completeness, throttling and write preconditions unselected. | Evaluate pagination-v3 with `test_notion_pagination_incomplete.py` and completeness together. A capped response must remain incomplete even with `has_more: false`. |
| Clockify | Original pagination selected although explicit time-entry pagination-v2 exists; throttling unselected. | Validate the current pin's v2 against the time-entry reader and write overlay. The read-only OAD does not declare projects/users collections; v2 does not add them. |
| Google Keep | Current write CRUD v2 selected; no separate completeness/throttling overlay in this pinned folder. | Keep the existing Keep composition and synthetic consumer checks. Do not manufacture a completeness or rate-quota guarantee from the absence of metadata. |
| Pets | Local demo OAD, no overlays. | Treat as a demo fixture; no external-provider coverage claim. |

Available files are evidence of authored metadata, not proof that adopting all
of them is correct. Some newer revisions already appear in alternative dated
catalogs. Check exact pins, overlay ordering, `info.x-requires` and conflicts,
authentication selections, and consumer support before migration.

## Validation gap fixed in this change

The CI step “Every catalog overlay is published from overlays/” checked only
`2026-10-02.json`. It now checks every dated catalog and reports the catalog
and platform with each error. Full composition coverage already exists in
`tests/test_identity_overlays.py`; this change strengthens the separate local
publication-source check, without making network access necessary.

## Rollout work

1. Start with GitHub's invalid patch format and Notion's incomplete-result
   handling. Prove the exact replacement compositions and actual reader
   behavior, including short/empty pages, repeated cursors and capped results.
2. Evaluate Discord/Clockify pagination and Moneybird's alternative traversal
   contracts against the versions of syncables/reflector actually shipped.
3. Add completeness, tombstones and throttling only with declared dependencies
   and consumer support. Composition alone does not implement retries,
   reconciliation or conditional writes in the runtime.
4. Publish a new immutable candidate catalog preserving unrelated entries and
   selections. Run all-catalog composition, requirements, pin validation,
   proxy catalog tests and the relevant synthetic syncables reads. Verify
   Pages, then switch the source default or deployment's explicit CATALOG_PATH
   through its normal release process. Keep the previous catalog for rollback.

No published overlay, catalog selection, source default or running deployment
was changed by this audit. Live grants, reads and provider behavior remain
unverified here.

## Implementation progress (2026-11-06)

Added `catalog/2026-11-06-overlay-fixes.json`, based on the latest
production-oriented `2026-10-30-production-keep-writes.json`, preserving every
platform, source pin and selection. It selects GitHub Issues CRUD v2 and
Notion pagination v3 plus the dependent pages completeness overlay. The
candidate has composition/extension validation and a synthetic reader
regression showing old versus new cap handling. This addresses the first
rollout priority as an opt-in candidate; it does not activate a deployment.
Remaining pagination migrations and throttling/deletion metadata adoption
remain open. GraphQL's initial operation-bundle contract is now implemented;
see the linked plan for remaining milestones.

Validation completed for this implementation: all dated-catalog compositions;
candidate composition and extension validation; completeness requirements;
GitHub patch-format and Notion pagination/completeness regressions; three
synthetic Notion reads through syncables; publication-source check and diff
whitespace check. The reader run used Node 24.19.0; CI uses Node 22. No live
provider requests were made (only pinned OpenAPI source downloads).
