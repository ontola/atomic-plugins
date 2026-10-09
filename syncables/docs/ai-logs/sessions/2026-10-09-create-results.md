# Session log — 2026-10-09: declared create results (CRUD Causality §4.3.2, §4.4–4.5)

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), "syncables worker 2" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only; based on `main`.
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; fixtures are invented.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the coordinator session):** Next consumer gap: CRUD Causality
create results. Don't send `generated` `addedFields`; take the identity
from `url` (a header such as `Location`, a body field, or the template, read
in reverse) when the create response has no usable body. Fixture tests
only. Reuse the semantics of #413's `created_identity` reference (CRUD
Causality 0.5.0), so that an unresolvable identity leaves the object unbound
and the create is never resent.

**Assistant:** `src/client/created-identity.ts`: `createDeclaration` reads
the create operation's `x-crud` (`url`, `addedFields`) with the resource's
identity template and bindings; `createBody` drops `generated` fields;
`createdIdentity` mirrors `created_identity()` (URL from the named header or
body path matched against the template anywhere and up to its end, `?` or
`#`, values decoded; otherwise the body's bound fields). The client sends
the stripped body, reads the response headers (and tolerates a non-JSON 2xx
body) for declared creates, sets the identity on the record (keeping a body
value equal as text), and on an undetermined identity marks the create
`unbound`: uncertain, never resent even with an idempotency key, stored in
the outbox (added within version 1), listed in `pendingWrites()`, and
refused by `resolveWrite` `retry`; `confirm` and `discard` settle it. Tests
in `__tests__/unit/client/create-results.test.ts`: the reference function's
cases, generated fields left out (and kept without a declaration), header,
named header, non-JSON body, body-field and numeric-id cases, four unbound
cases with a key and across a restart, discard, and an undeclared create
unchanged. README, changelog and CLAUDE.md updated.

## Turn 2

**Human (via the coordinator session):** CI fails on
`unified.test.ts > uses the reader rate-limit policy and captures each
attempt` ("expected spy to be called with [2000]", received 1999), on this
PR and #419. Find the root cause rather than retrying. Also the review
follow-ups: "never sent again" holds once the outcome is stored, and the
outbox version-1 wording needs the settle-before-downgrading caveat.

**Assistant:** The read `Budget` sleeps until the throttling answer's retry
time measured from the clock at the moment it sleeps; a millisecond between
receiving the 429 and sleeping gives 1999 (reproduced deterministically
with a clock that ticks per call; not reproduced by load alone locally).
The behaviour is right (never earlier than asked), so the test now freezes
`Date.now`. README: an unbound create is never sent again once that outcome
is stored (a stop before that is handled as an in-flight create), and the
version-1 paragraph carries the caveat. Main merged in.
