# Session log — 2026-10-02: failure classes for writes

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), worker subagent of the atomic-plugins oversight session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; tests use invented data.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the oversight session):** Next slice of #260: failure
classification for writes. Today a 400/401/403/404/409/422 on a create,
update or delete retries with backoff without limit unless
`retry.maxAttempts` is set. Permanent client errors (400, 404 on
update/delete, 405, 409, 410, 413, 415, 422 and similar) should fail at once
with the status and a body excerpt in `lastError`, and stay resolvable; decide
404/410 on a delete carefully. Auth errors (401, 403) should not burn
attempts: pause the queue, expose a blocked state and an event, and resume
once the app signals renewed auth, keeping write order; decide whether a 401
pauses the origin or the route. Retryable statuses (408, 425, 429, 5xx) keep
backoff and honour `Retry-After`. Make the classification overridable, store
new state in the durable outbox (version 1 if additive), and keep the
invariant that no failed write is newer than a queued write of the same
record. Out of scope: remote deletes under a pending update, deletion
evidence, version bump and publish.

**Assistant:** Changed `src/client/client.ts` and `src/client/outbox.ts`:

- `WriteFailureClass` (`retry`, `permanent`, `auth`, `satisfied`), the
  exported `defaultWriteFailureClass` and the `classifyWriteFailure` option.
  Defaults: a delete's 404/410 settles it; 401 is `auth`; 403 is `retry` with
  rate-limit headers, `permanent` for a request sent after a renewal while no
  write has succeeded since, else `auth`; 408/425/429 retry; other 4xx are
  permanent; everything else retries. Failures without a status keep their
  earlier handling.
- `permanent` makes the write `failed` at once through the existing
  `retry.maxAttempts` path; `lastError` carries the status and up to 200
  characters of the body, and `lastStatus` the status.
- `auth` blocks the whole client (one server URL, one credential set): the
  write becomes `blocked` without counting an attempt, nothing is sent until
  `authRenewed()`, `authBlocked()` and `onAuthBlocked` expose it. A refusal
  for a request sent before the latest renewal is resent at once.
- `Retry-After` (delay-seconds or an HTTP date) replaces the backoff delay.
- The outbox stays version 1: `lastStatus`, the `blocked` state and a
  top-level `authBlock` are additive; a restored blocked client stays blocked
  until `authRenewed()`.

Tests in `__tests__/unit/client/failure-classes.test.ts` and new cases in
`durable-outbox.test.ts` (with `expectFailedOlder`). README ("Failure
classes"), CLAUDE.md and the changelog describe it. No live provider was
tested.

## Turn 2

**Human (via the oversight session, relaying a verified review of PR #313):**
Fix four findings, each with a regression test. (1) `Retry-After: 0` or a
past date causes a hot retry loop: never wait less than the backoff.
(2) `afterRenewal` is read when the response arrives instead of when the
request is sent. (3) Only a 2xx clears `afterRenewal`; any non-`auth`
response should. (4) A write can still be sent after the block began:
re-check after the in-flight store. Also: allow `resolveWrite` `discard` on
a blocked write, add an `onAuthFailure: 'block' | 'retry'` option, and add a
`retry.maxRetryAfterMs` cap (default 1 hour).

**Assistant:** Changes:

- The retry delay is now the longer of the backoff and `Retry-After`, with
  `Retry-After` capped by `retry.maxRetryAfterMs`.
- `afterRenewal` and the renewal epoch are captured after the in-flight
  store, just before sending.
- Any response at the current epoch other than an `auth` failure clears
  `afterRenewal`.
- After the in-flight store, the client checks the block again. If it is
  set, the write is not sent (outcome `held`) and no attempt is counted.
- The blocked and held paths continue the drain loop, so a renewal that
  happens during their store is not lost.
- Added `discard` for blocked writes (discarding a blocked create also drops
  the writes queued behind it), plus `onAuthFailure` and `maxRetryAfterMs`.
- Eight regression tests, each of which fails on the previous commit.
- README and CLAUDE.md updated.
