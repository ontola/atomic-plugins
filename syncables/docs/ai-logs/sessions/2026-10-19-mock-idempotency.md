# Session log — 2026-10-19: idempotent creates against the mock server

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`: `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** pick a README "not verified"
item that a mock-server test can close without a live provider.

**Assistant:** The Idempotency-Key retry ("whether the provider actually
deduplicates on that key ... is not verified here"). The mock server now
keeps, per collection, the body and record of each key a declared
`Idempotency-Key` create was sent with, answers a repeat with that
record and the same key with another body with `422`. The test runs the
client against it through a transport that loses the first POST's
response: the retry carries the same key and the server ends with one
record; without a declaration the create stays `uncertain` and is not
resent. The document gives the server the id (`addedFields` `source:
generated`), because with the pets fixture the client sends its own id
and the mock's id upsert hid the duplicate; three of the five tests
fail on the server before. A real provider's deduplication stays its
contract, as the README now says.
