# Standalone Syncables design handoff

- Session: codex://threads/01a14512-47d4-728a-9c9c-98c92f64906d
- Assistant: OpenAI Codex, GPT-6.
- Date: 2026-10-16

## Human requests and decisions

The user requested a laptop executable that stores nested API JSON objects in
a hash table, selected incremental collection fetches, a polling/webhook
daemon, a queued webhook relay, and hierarchical offline browsing with filters,
ordering, pagination, item history and revision retrieval. Atomic-server,
remoteStorage, NextGraph, Jazz and atproto destinations may follow later.

When asked about scope and object identity, the user chose architecture and
plan first and confirmed content-addressed nested objects. The user then
requested picking up the durable handoff in issue #566 and said device flow
is being tested in the existing laptop worker, API keys (local). Owner keys
must remain local. No new approval or service installation was requested here.

## Assistant output

Read #566 and its handoff, existing design PR #644, draft implementation #567,
the PostgreSQL schema/cache guide and the device contract. Corrected the earlier
SQLite recommendation to preserve the recorded laptop PostgreSQL decision.
Continued the existing design branch rather than creating another CLI or
modifying #567. Recorded pickup on #566.

Extended the design with typed/lossless nested graph encoding, owner-scoped
hashes, stable identity versus revision occurrence, raw-response retention,
compact manifests/coverage, transactional indexing/checkpoints and GC roots.
Added the proposed offline command hierarchy, incremental strategy selection,
polling/inbox scheduling, relay delivery limitations and delayed Jazz/atproto
adapters. Specified staged acceptance checks and separated draft implementation
from planned behavior and reported/live device-flow evidence.

This is documentation only. The user retains browser approval testing in the
laptop worker. No owner seed, tokens, provider records, service configuration
or runtime changes were introduced. Validation results are recorded below.

## Validation

- `git diff --check` passed.
- `node syncables/scripts/changelog.mjs --check` passed.
- Checked relative file links and balanced code fences in the changed design
  and session log. Reviewed the plan against #567's schema/cache guide and the
  current reader/inbox contracts.
- No runtime test result or live provider success is claimed by this
  documentation-only change.
