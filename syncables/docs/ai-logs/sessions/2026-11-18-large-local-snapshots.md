# Large saved SyncD snapshots

- Session: codex://threads/01a1e956-99aa-7222-acc8-4a1e67f73ebc
- Assistant: OpenAI Codex (GPT-6.2), with delegated implementation/review.
- Maintainer authorization: finish metadata downloads through
  integrations.atomic.place and fix blockers observed during the pilot.
  Keep the Heroku database.

## Human request

“ok let's fix those remaining blockers and get the 2 Dropbox and 4 Google
Drive accounts downloading metadata through integrations.atomic.place. keep
the Heroku database for now.” Account details are [redacted].

## Substantive assistant work

A complete Dropbox metadata snapshot contained 459,799 provider records.
Publication succeeded, but materializing its working folder reconstructed
one graph at a time and the local browser refused it above 50,000 resources.

Changed PostgreSQL checkout to traverse membership in bounded batches,
reconstruct their shared JSON graphs in batches, and stream exact resource
bytes through the existing staging-folder materializer. Local-edit, symlink,
lock and atomic-publication protections remain in that materializer.

Added a lazy owner/revision-scoped PostgreSQL browser index. It stores
lowercase search text locally and persists the existing JavaScript locale
ordering, including its stable tie order. Preparation commits atomically;
advisory locking prevents competing processes from building the same index.
HTTP requests receive a preparation response immediately and the UI polls
the pinned revision. Pages reconstruct at most 25 resources, preserving
source number lexemes and immutable revision navigation.

Tests cover exact checkout bytes, more than one membership batch, paginated
first/last results, literal percent/underscore search, concurrent viewers,
and continued access to an old revision after the head advances. Existing
working-folder protection and browser access-control cases were retained.

## Validation

Focused browser and PostgreSQL history tests passed against the dedicated
test database. TypeScript staged release build, ESLint (no errors) and
Prettier checks passed. A live saved-snapshot checkout and local browser index were started without
repeating provider downloads. The initial HTTP preparation response returned
in 279 ms. Broader local daemon runs encountered wall-clock timeout failures
during heavy host I/O/suspension; those results are not recorded as passes. Private
local access links and account identifiers are [redacted].
