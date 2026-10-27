# CLI complete approval link

- Session: codex://threads/01a14512-47d4-728a-9c9c-98c92f64906d
- Assistant: OpenAI Codex, GPT-6.
- Date: 2026-10-22

## Human requests and observed blocker

While testing the real daemon setup, Michiel reported being unable to paste
the user code on `localthought.io/device`. His screenshot showed the bare
instruction page without a code-entry box. After following its owner-approval
link he reported that the Mac's loopback bridge at port 11873 was unreachable.
He asked the existing authenticated local worker to restart it, then asked to
continue live testing there and requested a handoff. No live code or token is
retained in this log.

## Work

Explained the public-page/local-approval separation and the local bridge restart
requirement. The cloud executor cannot start a process on the Mac or access its
Keychain. Kept the existing owner identity/signing adapter as the bridge setup;
did not request owner key export or another identity.

Found that the CLI discarded `verification_uri_complete` and printed only
`verification_uri`. Changed it to print the complete URL when supplied, matching
its origin/path and single user_code to the verification endpoint and displayed
code before reporting or polling. Older servers retain manual entry. Added
explicit instructions for prefilled codes and continuing to owner approval,
updated the mock to supply/prefill the complete link, and clarified both guides.
This does not start the bridge or approve a grant.

Added tests for prefilled links and mismatched origin/path/code, duplicate codes
and missing codes, including rejection before polling. Existing manual-entry
and token/device-code redaction tests remain. Live browser approval and provider
tests move to the local worker; no cloud approval or live credential access.

Validation: all 1,808 tests in 100 files passed with PostgreSQL 17 and Git.
Type checking, lint, formatting, changelog validation, release build and the
installed-tarball device/sync/daemon/offline-history smoke passed. The new mock
complete-link response is exercised by the installed executable. CI runs on
the fix PR; it does not establish live Mac bridge readiness.
