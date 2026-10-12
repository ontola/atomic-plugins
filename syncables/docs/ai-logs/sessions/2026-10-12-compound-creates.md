# Session log — 2026-10-12: compound creates (K8)

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** K8: syncables support for CRUD
Causality 0.5.0 compound creates (§4.7, spec #413), using the held overlay
`claude/github-compound-create-overlay` as the reference consumer document.
Plan first, checked against the Write Preconditions consumer plan.

**Assistant:** A plan (follow-ups as queued updates of the bound record,
worked out at send time) checked for overlap with the Write Preconditions
plan, then: `compound-create.ts` (parsing with fail-closed refusals, the
create body without `omit` fields, `missingValue` and `followUpRequest`
after the reference); route discovery sets `CreateDeclaration.followUps`
or `createRefused`; `drainQueue` queues the follow-ups at the head of the
record's queue when a create settles bound; `attemptWrite` sends each with
what is still missing, settles it without a request when nothing is,
fails a refusal (`refused`, the later ones `notSent`), keeps an unknown
outcome pending until a read (`awaitingRefresh`), and a `confirm`ed
uncertain create reads the object back first. `PendingWriteInfo.followUp`
reports them; the outbox stores them as type `followUp`, which an older
client keeps unrestorable. Tests on a GitHub-shaped fixture and on the
pure parts. Noted: a follow-up answered 403 blocks the client under the
default classes, as any 403 does.
