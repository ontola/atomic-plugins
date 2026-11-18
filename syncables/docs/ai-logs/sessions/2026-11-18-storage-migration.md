# SyncD storage migration

- Session: codex://threads/01a1e956-99aa-7222-acc8-4a1e67f73ebc
- Assistant: OpenAI Codex; delegated implementation and review used GPT-6.2.
- Maintainer authorization: implement, test, publish, and verify the storage
  migration through integrations.atomic.place. Keep the Heroku database.

## Human request

“ok let's fix those remaining blockers and get the 2 Dropbox and 4 Google
Drive accounts downloading metadata through integrations.atomic.place. keep
the Heroku database for now.”

The maintainer identified the six accounts; their addresses are [redacted].

## Substantive assistant work

Preserved POST list methods, request bodies, and continuation requests in
SyncD's generic proxy read transport. Kept connection and issuer restrictions,
with the IAP checking authoritative catalog declarations before granting a
POST under a read-only device scope. Added paginated database-backed tests.

Added explicit bounded stdin import of sealed connection grants, checked
against the current owner, issuer, client, device session, and live approved
connection list. Stored grants separately in macOS Keychain, with expiry and
readback verification. The proxy never stores these client-held grants in its
database. Attached grants only to the approved proxy connection and preserved
sanitized errors. Local owner tooling reuses the existing connection-key
cryptography; it does not transfer the owner's signing secret to SyncD.

Reviewed session changes during a paged import and expired-grant reporting.
The implementation prevents mixing sessions within one published snapshot.

## Validation and limitations

Targeted TypeScript and PostgreSQL tests verify two-page read POSTs, URL and
method restrictions, grant lifetime and binding, credential refresh, and
secret-free errors. Rust tests verify device scopes and classify both the
pinned Dropbox catalog and the live composed document. Broader validation
results are recorded in the pull request.

Provider sign-in, OAuth credentials, real-account metadata downloads, and
production deployment are separate acceptance steps. This log does not claim
those completed merely because local tests passed. The Heroku database remains
retained throughout this work.
