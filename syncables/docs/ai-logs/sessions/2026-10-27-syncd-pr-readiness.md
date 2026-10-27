# SyncD PR readiness

Session URL: unavailable in this execution environment. Codex delegated task:
`/root/syncd_readiness`.
Model/tool: GPT-6 via Codex.

## Human request

“can you make sure all our open PRs are ready for trekmeester to easily merge”

The oversight session delegated review and consolidation of the SyncD stack
(#685, #692 and #693), preserving the validated candidate23 pin.

## Substantive output

Replaced the companion's hand-built genesis commit and validation flags with
`Resource::save_as_genesis` at all three resource-creation sites. The core now
owns the choice of genesis validation, signatures and resource-state adoption.

Merged current main into the top of the stack without rewriting the lower
branches. Resolved the CLI option-list conflict by retaining both Atomic peer
and Braid options. Kept the implemented Atomic projection description, corrected
its compact nested-JSON wording, and retained coexistence with Git and Braid.
The three original PR heads remain ancestors of the consolidated branch.

Documented the independent Cargo package/lockfile compatibility procedure and
the current read-only session boundary. The oversight session chose to retain
the safety adapter at the validated pin: that core does not expose a policy
combining local-only reads, collection scope and read-only reconciliation.
Removing the gate would lose those protections. A shared core API is deferred
rather than emulated by a less restrictive handler call.

Rust formatting passed. Full locked native tests, lint/types and merged
JavaScript/PostgreSQL validation were still running at the checkpoint commit.
Only invented data and local PostgreSQL are used; no provider account, owner
key, deployment, package publication or shared pin advancement is involved.
