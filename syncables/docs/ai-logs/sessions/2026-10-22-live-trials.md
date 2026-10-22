# Standalone Syncables live-trial setup

- Session: codex://threads/01a14512-47d4-728a-9c9c-98c92f64906d
- Assistant: OpenAI Codex, GPT-6.
- Date: 2026-10-22

## Human requests

Michiel reported that the local trial worked and authorized merging PR #675.
He then asked to test a real repository and Google Keep. While following the
guide, he asked whether to copy `examples/daemon/config.demo.json` and whether
`./data` in the repository root was an appropriate destination. After copying
the files he asked which config fields to change and whether the GitHub
OpenAPI file needed editing.

## Work

Verified all checks on PR #675's exact tested head, recorded the user-reported
trial and merged it as 14819ce5. This report does not establish additional live
provider or Keychain coverage. No deployment or package publication occurred.

Clarified the exact config/document filenames, relative paths, private external
directory recommendation, optional ignored repository-root directory, connection
discovery and real GitHub config fields. Kept the GitHub profile unchanged.
Provided a complete example config with placeholders for owner/connection IDs;
credentials remain at the proxy/Keychain and owner signing stays local. Updated
source instructions to use main after the merge.

Added a minimal GET-only Google Keep note profile using the pinned API v1 list
contract, stable resource names and declared pagination. The copy commands and
shell helper remain explicit; the guide covers a second collection entry,
provider setup prerequisites, one-page access probe, manual full fetch, local
title filtering, slash-containing IDs, revision history and later polling.
The daemon reads all pages of the approved default note collection; the title
filter does not restrict fetching/archival. No live notes, access tokens,
provider credentials or owner keys were accessed, exported or committed.

Validated the profile with invented notes through real PostgreSQL and Git:
continuation after a short/empty page, stable note IDs, empty-account removal
with retained history, archived nested responses, failed-page preservation and
malformed-array rejection. Cloud tests cannot establish deployed Google Keep
OAuth readiness or laptop approval success. Validation results follow on the
PR. All 1,802 tests in 100 files passed against PostgreSQL 17 and Git; type
checking, lint, formatting, changelog validation and the release build passed.
