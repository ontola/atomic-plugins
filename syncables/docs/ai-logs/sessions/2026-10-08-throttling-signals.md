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
