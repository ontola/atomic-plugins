# SyncD gateway retries

- Session: codex://threads/01a1e956-99aa-7222-acc8-4a1e67f73ebc
- Assistant: OpenAI Codex (GPT-6.2).
- Maintainer authorization: finish metadata downloads through
  integrations.atomic.place, including fixing the blockers observed during
  the pilot. Retain the Heroku database.

## Human request

“ok let's fix those remaining blockers and get the 2 Dropbox and 4 Google
Drive accounts downloading metadata through integrations.atomic.place. keep
the Heroku database for now.”

## Substantive assistant work

The pilot recorded 74 successful Dropbox pages followed by an empty gateway
502 during an integrations.atomic.place production deployment. SyncD
correctly published no partial snapshot. Two Drive discovery calls also
failed during that interval and succeeded after the deployment.

Added opt-in retries to the daemon's paged read budget and its device
connection-discovery GET. The read budget retries only GETs and reader-issued
list POSTs after a 502, 503 or 504, without changing the original request. It
counts each attempt, preserves declared blocked responses, applies bounded
backoff, observes Retry-After, and keeps the existing completion requirement.
The discovery retry is bounded separately and leaves other CLI callers
unchanged. Account labels and connection identifiers are [redacted].

Added tests for retrying a cursor-bearing POST without changing its body,
archiving the failed response, preserving the published snapshot and
checkpoint when a retry exceeds the budget, and retrying discovery 502
without retrying discovery 403.
