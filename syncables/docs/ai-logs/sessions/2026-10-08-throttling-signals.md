# Session log — 2026-10-08: throttling signals (Throttling 0.2.0-draft)

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Fable 5.1 (`claude-fable-5-1`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only; based on `main` after Throttling 0.2.0-draft (#377) merged.
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; the fixtures are the spec's synthetic example and its reading of three providers' public documentation.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the coordinator session):** Piece 1 of the batch, unblocked by
Throttling 0.2.0-draft (#377), which defines header roles and throttling
signals: read `x-throttling.headers` and `signals`; replace the hard-coded
403 rule in `defaultWriteFailureClass` with declaration-driven
classification (with signals declared, only a matching signal or a 429
counts as throttling; without signals, keep today's behaviour); compute the
earliest retry time exactly as the spec says (the later of the two clocks,
then `minDelaySeconds`, then `window.seconds`, then backoff) and never retry
earlier; add fixture tests mirroring the spec's tests and the three
providers' example responses. The reference is `classify()` in the spec
folder's `validate.py`.

**Assistant:** Added `src/throttling/throttling.ts` (browser-safe):
`declaredThrottling` parses the root object (bucket windows, `applies`,
header roles by lower-cased name, the signals; a header entry that does not
parse is left out, and the signals array is dropped as a whole when one
object does not parse, since they are ordered), `classifyThrottling`
follows the spec's `classify()` (first matching signal; else a 429 is
`throttled`; `retryAt` as the later of `retryAfter` and, for
`quotaExhausted` or `remaining: 0`, `reset`, each absolute time measured
against the consumer's clock and the `Date` header; else `minDelaySeconds`;
else the bucket window; else none), with `headerTime` for the four units
(the obsolete asctime form read as GMT) and `operationBuckets` for an
operation's selection. When no `retryAfter` role is declared, the standard
`Retry-After` is read as RFC 9110 defines it, so a plain 429 behaves as
before. In the client, the verdict is computed once per failed response and
handed to the classifier as `WriteFailure.throttling`, with
`signalsDeclared`; `defaultWriteFailureClass` returns `retry` for a verdict
and keeps the 403 header heuristic only without signals. The retry delay is
never below the earliest retry time (nor below the backoff); a time further
away than `retry.maxRetryAfterMs` makes the write fail with an explanatory
`lastError` instead of retrying early, as the spec allows. A
`quotaExhausted` answer pauses every write whose operation counts against
the bucket (or all writes when unnamed) until the time; a create answered by
a declared signal is a refusal, not `uncertain`. The read `Budget` classifies
every response the same way and waits the earliest retry time for a
declared signal, not only a 429. Tests: `unit/throttling/throttling.test.ts`
mirrors the spec's `ClassifyTests` on the synthetic example plus parsing and
`headerTime` cases; `unit/client/throttling.test.ts` runs the GitHub, Google
and Moneybird snippets through writes (reset wait, minimum delay, a
non-matching 403 blocks, Retry-After honoured, giving up past the cap, a
signalled 500 create not uncertain, bucket pause and resume) and reads
(waiting through the injected sleep, past the deadline, non-matching 403
returned, the spec example through `sync()`), and checks the heuristic
without signals. Not implemented: pacing against the announced `limits`,
and the bucket pause for reads. README (Failure classes, a Throttling
subsection, an Unreleased changelog entry) and CLAUDE.md updated.

## Turn 2

**Human (via the coordinator session):** Review of PR #391. Blocking: a
create answered by a 5xx that a declared signal matches was treated as not
applied and resent; the spec says such a response is not a throttling
signal, since it may follow partial processing, and "not applied" is only an
inference, so `mayHaveApplied` must ignore the verdict. Should-fix: the
"never sent before the earliest retry time" claim did not hold across a
restart or a `resolveWrite` retry; reads ignored a `quotaExhausted` pause
and a read's `quotaExhausted` did not pause writes; the bucket pause ran
before the `maxRetryAfterMs` cap, so other writes could wait days with no
`lastError`; a `quotaExhausted` with no time paused nothing; a custom
classifier's `auth` after a renewal resent with no delay.

**Assistant:** `mayHaveApplied` is as before (a 5xx other than 503 is
uncertain for a create, verdict or not) and the test turned around. Each
throttled write stores `notBefore` (the later of the answer's time and its
backoff) with the queued write in the outbox, and the exhausted buckets are
stored at the outbox's top level (`throttlingPauses`, within version 1), so
both survive a restart and a `resolveWrite` retry. The drain waits out the
later of the bucket pause and `notBefore`; a hold longer than
`retry.maxRetryAfterMs` fails the write with "Held until … not sent". A
`quotaExhausted` with no time and no window pauses the bucket until the
write's own backoff. The post-renewal resend waits the answer's time. The
client's read transport waits out a paused bucket for the request's
operation (through `sleep`, within `limits.timeoutMs`, else stops the read
with an error) and pauses the bucket on a read's `quotaExhausted` answer.
Tests for each; README, CLAUDE.md and the changelog reworded. Not done
(nits): integers above 2^53 and `Date.parse`'s leniency.

## Turn 3

**Human (via the coordinator session):** Second review of #391, treated as
blocking for write safety: an answer that sets `retryAt` but ends on the
uncertain, blocked or auth path returns before `write.notBefore` is set (a
create answered 500 with `retry-after: 60` under a `throttled` signal, then
`resolveWrite({action:'retry'})` re-POSTs at once). Also: document the
downgrade (an older syncables drops `notBefore` and `throttlingPauses`),
keep `OUTBOX_VERSION` at 1; nits: compare the read pause with what is left
of the budget's deadline and re-check after the sleep; a read's
`quotaExhausted` with no time should pause too; fix the read transport's
GET-only operation lookup for POST list reads.

**Assistant:** `write.notBefore` is set from the verdict's `retryAt` right
after the verdict is computed, before any classification path, so an
uncertain create, a blocked write and a permanently failed write all keep
it: a `resolveWrite` retry or `authRenewed()` re-queues them and the drain
waits it out (tests for each path). The README's outbox paragraph documents
the downgrade. The read transport looks the operation up by the request's
method, compares a pause with the running sync's remaining budget time
(`Budget.remainingMs()`, tracked as `activeBudget`), re-checks after each
sleep, and pauses the bucket on a read's `quotaExhausted` without a time
until the client's base backoff.

## Turn 4

**Human (via the coordinator session, to a worker taking over after the
previous one stopped on a usage limit):** Finish the second review of #391:
merge `origin/main` (which brings `listMethod: POST` from #392) with a merge
commit, then fix the read transport's operation lookup for a POST list
read; document the downgrade in the changelog.

**Assistant:** Merge commit resolving `conditionalTransport` (this branch's
method-aware lookup with main's `paginated()` check). A test on the fixed-read
example's POST search with a bucket of its own: the search's 429 pauses
`search`, and the next search waits on it (here: stops, past its 1 s
budget), where a GET-only lookup would have counted it against the default
bucket and sent it at once (checked by reverting the lookup). The
Unreleased changelog bullet names the POST-read buckets and the downgrade
(outbox version 1; an older client drops `notBefore` and
`throttlingPauses`, so it may send a held write early, never twice).
