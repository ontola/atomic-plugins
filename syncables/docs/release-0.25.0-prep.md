# syncables 0.25.0: release prep (not yet cut)

Written 2026-10-15 against `main` at 820fb277, where `package.json` and npm
both say 0.24.0 and the changelog has no Unreleased entry: nothing under
`syncables/` changed on `main` after the 0.24.0 bump (2ae65cb0). Everything
below is in open PRs, each carrying its own `**Unreleased**` bullet. This
note lists them so the release PR can fold them into one 0.25.0 entry. It
does not bump the version. Delete it in the release PR.

The PR states below are as of 2026-10-15. Re-check with
`gh pr list --repo ontola/atomic-plugins --state open` before cutting.

## What 0.25.0 would contain

Sorted by risk, highest first. "Opt-in" means that only a document or
caller declaring something new sees the change.

| PR | Change | Kind | Breaking risk |
| --- | --- | --- | --- |
| #609 (merging) | An explicit `x-pagination` entry must be a Pagination Application Object per the spec's `schema.json`: a nonempty `scheme`, an object `overrides`, a string `description`, no other field but `x-` ones. Every entry is checked. | Behaviour change | **Yes, for documents with a malformed entry.** A read that used to apply the scheme and drop a bad field (say a typo such as `overide:`) now fails with `PaginationSchemeError`. In this repository all 1,275 `x-pagination` entries in YAML and JSON files pass. Third-party documents are not checked. |
| #533 (open) | Throttling 0.4.0-draft `blocked`: `classifyThrottling` can return `{ meaning: 'blocked' }` with no `retryAt`. A blocked write fails at once (`permanent`). A blocked read fails without sleeping. | Behaviour and API-semantic change | **Yes, for custom `classifyWriteFailure`.** A `ThrottlingVerdict` no longer always means "retry later". A classifier that answers `retry` for any `failure.throttling` now retries a blocked answer. Only documents that declare a `blocked` meaning, or an unrecognised one, produce the verdict. |
| #577 (open) | Pagination Schemes §6.3 `matchHeaders` and `matchResponseFields` are read by auto-detection. | Behaviour change | **Possible.** An operation whose description declares a matching response header or field now pages instead of taking its first response as the whole list. That gives more items, and more requests against `maxRequests` and the pacer. If the newly matched scheme is invalid, the read is now reported as not complete (the 0.23.0 rule). No operation in this repository's catalogs changes; GitLab's `Link` scheme is applied explicitly. |
| #567 (open) | Opt-in `syncables/postgres` export (archival, caching and replay of bodyless GETs), a `syncables` CLI `bin`, and `auth-test --archive`. | Additive API, but changes the package | **Install footprint, not API.** `pg` and `@bokuweb/zstd-wasm` become runtime `dependencies` for every consumer, including the browser entry's users, even though neither existing entry imports them. `engines.node` goes from `>= 22.11 < 23` to `>= 22.11`. Check `npm pack --dry-run` size and whether these belong in `optionalDependencies` or `peerDependencies` before release. |
| #613 (open) | Webhook inbox: `reconcile` may answer `'pending'`. `InboxClient` refuses a base URL whose host is a non-canonical IP literal (`127.1`, `0x7f.0.0.1`, `010.0.0.1`, any IPv6 literal) or one `URL` would rewrite. | Additive, plus a stricter check | **Low.** A caller using such a base URL gets an error at construction. |
| #600 (open) | Pagination Schemes 0.9.0 item cursor: `fromLastItem` with the `hasMore` response role, validator rules 27 to 29. A `hasMore` that is present but not a boolean (`null` included, per 0.9.1) fails the read. | Opt-in | None for documents without these fields. No overlay scheme in this repository changes verdict. |
| #606 (open, stacked on #600) | `TransportRequest.purpose` on every request syncables makes, `TransportResponse.fromCache` (a cached answer gives back its pacing count and does not count against `maxRequests`), and the `PurposedRequest` and `RequestPurpose` types. | Additive | **Low.** Both fields are optional on the types. A custom transport that forwards the whole request object somewhere strict would now see an extra `purpose` key. `fromCache` only matters when a transport sets it. |
| #603 (open, stacked on #600) | The mock server serves item-cursor schemes. Before, it read the cursor as an offset and answered an empty page. | Test tooling | None outside tests that relied on the old empty page. |
| #575 (open) | `readPlatform` reports `ReadResult.coverage` (`CollectionCoverage`), as `sync()` already did. | Additive | None. The field is optional and absent when no collection reports coverage. |
| #611 (in review) | `resolveReference` and `ResolvedReference`: a CRUD Causality §4.1.3 Reference Object resolved to the target's identity path. It refuses `.`, `..` and whitespace-padded values. | Additive | None. It is a new export, and nothing in the client calls it. |

Semver: syncables is 0.x, and earlier minors (0.23.0, 0.24.0) carried
behaviour changes. A 0.25.0 that contains #609, #533 or #577 follows that
pattern, but its entry should lead with those three, as 0.23.0 led with
its behaviour changes.

## Found while collecting: #600's stack truncates the 0.24.0 entry

`claude/syncables-item-cursor` (#600) deletes 12 lines of the published
0.24.0 changelog entry. They are the body of the "Also:
`validatePaginationScheme` follows the spec's `schema.json` ..." paragraph,
from "`schema.json`: a field the spec does not define" to "an operation no
longer makes the read of that collection fail." The entry is left ending
mid-sentence. #603 and #606 inherit the cut from #600. This most likely
came from a changelog conflict resolution during a rebase. Fix it on #600
before merging, by restoring those lines from `main`. Check with:

```sh
git diff "$(git merge-base origin/main origin/claude/syncables-item-cursor)" \
  origin/claude/syncables-item-cursor -- syncables/README.md \
  | sed -n '/^ ## Changelog/,$p' | grep -c '^-'   # 0 once fixed
```

No other open syncables PR deletes changelog lines (the same check gives 0
for #533, #567, #575, #577, #609, #611 and #613).

## Merge order and conflicts

`git merge-tree` on pairs of these branches shows conflicts only in
`syncables/README.md`, where every PR adds its Unreleased bullet at the
same spot above 0.24.0. Each later merge resolves by keeping both bullets.
The source files overlap without textual conflict:

- `pagination/autodetect.ts`: #609 and #577;
- `read/pages.ts` and `client/client.ts`: #533 and the #600 stack;
- `index.ts` and `browser.ts`: #611 and #606.

These pairs were checked: #609 + #577, #611 + #606, #533 + #606, #609 + #606,
#575 + #606, #577 + #606 and #611 + #609. #606 and #603 merge after #600, or
retarget to `main` once #600 is in (see the stacked-PR rule in
`docs/agents/ci-and-merging.md`).

## Release PR checklist

1. Wait for the PRs meant for 0.25.0 to merge. Leaving #567 out is the
   simplest way to avoid the dependency question above.
2. Fold every `**Unreleased**` bullet into one `**0.25.0**` entry. Lead
   with the behaviour changes (#609, #533, #577), then additive APIs, then
   test tooling. Keep each bullet's "Additive" or "Behaviour change"
   wording.
3. Update the README's spec table rows that the merged PRs touch
   (Pagination Schemes 0.9.x for #600, Throttling `blocked` for #533, CRUD
   Causality §4.1.3 for #611).
4. Bump `package.json` and `package-lock.json` to 0.25.0.
5. Run the checks from the syncables folder: `npm run prettier:check`,
   `npm run lint`, `npx tsc --noEmit -p .`, `npm test`,
   `npm run build:release` and `npm pack --dry-run`. `npm test` scopes
   vitest to `unit`; a bare `npx vitest run` after a build also picks up
   `build/__tests__` and fails on fixture paths.
6. Delete this note.
