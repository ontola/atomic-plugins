# Session log — 2026-10-12: Throttling's `blocked` meaning

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "overlays worker" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`: `syncables/` here; the spec (`openapi-extensions/spec/throttling/`) and a Notion overlay in the same branch stack.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** Take the proposed K-row: a way for
Throttling to say "don't retry". Spec first (a signal meaning such as
`blocked`, or `retry: false`, with validator, tests and an example), then,
stacked, a Notion overlay revision that declares
`rate_limit_reason: public_api_request_blocked` with it, and syncables
treating such an answer as a permanent failure (not throttled, no backoff),
with tests.

**Assistant:** Throttling 0.4.0-draft adds the signal meaning `blocked`: a
matching response is not throttling (no earliest retry time, never resent
automatically), takes no `bucket` or `minDelaySeconds`, and a meaning a
consumer does not recognise is read the same way. In syncables,
`declaredThrottling` accepts `blocked` (and reads an unknown meaning as
it; a `blocked` signal with a bucket or a delay leaves the whole `signals`
array out, as any signal that does not parse), and `classifyThrottling`
returns `{ meaning: 'blocked' }` without a retry time. The write path keeps
the verdict for the classifier but takes no retry time or bucket pause from
it; `defaultWriteFailureClass` calls it `permanent`, so the write fails at
once and is not sent again. A precondition read answered `blocked` ends the
write too. A read returns the response without sleeping, so the collection
read fails on it. Tests cover the classification, the unknown meaning, the
invalid combinations, a failed write that is not resent, another Notion
reason that is still retried, the default class and a read that does not
sleep.
