# SyncD PR readiness

Session URL: unavailable in this execution environment. Codex delegated task:
`/root/syncd_readiness`.
Model/tool: GPT-6 via Codex.

## Human request

“can you make sure all our open PRs are ready for trekmeester to easily merge”

The oversight session delegated review and consolidation of the SyncD stack
(#685, #692 and #693), preserving the validated candidate23 pin.

## Substantive output

Evaluated the review suggestion to use `Resource::save_as_genesis`. The existing
replication acceptance test failed its verified-creator assertion: on the
validated core pin, that method still creates a legacy commit-signature DID
without the inline creator certificate or inherited drive stamp. Retained the
core's certificate-based `Commit::create_did` path in the small adapter, named
it `create_certified_genesis`, and documented why the APIs are not equivalent.
The regression also now checks the drive's verified creator, alongside the
existing row-creator and drive-stamp assertions.

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

Native verification exposed a separate file-reopen race. The pinned core's
periodic durability thread briefly upgrades a weak store reference while
flushing, so dropping a fixture's last Peer need not release the redb lock
immediately. The file-store fixture now waits for actual availability, retrying
only the explicit database-lock error with a five-second limit. Binding and
validation errors return immediately; binding-refusal tests check the expected
reason so a lock error cannot accidentally satisfy them.

Final validation: all nine native Rust integration tests passed (five replica,
three table and one official WebSocket-client case), with no skips. Locked
production build, all-target Clippy with warnings denied, Rust formatting,
JavaScript build/type checks, ESLint and full Prettier checks passed. The
merged JavaScript suite passed 1,799 tests with 48 environment-gated cases;
the separate PostgreSQL run passed 59 cases with only the two native-binary
gates pending, and the full PostgreSQL/native run then passed all 12 cases.
Both actual PostgreSQL-to-process restart/update cases also passed against the
final production binary. CLI help exposes both Atomic peer and Braid modes.
The browser pin, native manifest revision and locked core source all match
`30994948b5adadd765ecfcdccdf0aad14ef5be1a`.

Only invented data and local PostgreSQL were used; no provider account, owner
key, deployment, package publication or shared pin advancement was involved.

## Concurrent source update

The source author advanced #693 to
`b196c5bbcc6419c1bcc6d1a6943e0688cd79c7c0` while this readiness branch was
being prepared. No source branch was overwritten. Merged that immutable head
into this consolidation, preserving the experimental Embedded Resources spec,
explicit linked-resource projection and source-bound projection-contract checks.
The only conflict was the CLI option list: retain Braid, Atomic peer and the
new `projection-contract` option together.

The combination passed all 1,920 JavaScript tests in 108 files on Node 24.19.0,
with local PostgreSQL and the actual native process enabled and no skips. This
includes linked scalar/array publication, durable restart/checkpoint recovery
and rejection of invalid contracts before native allocation. All nine native
Rust tests, locked build, all-target Clippy with warnings denied, Rust
formatting, JavaScript build/type checks, ESLint and Prettier passed again.
The ten experimental-spec validator tests and its example passed too. CLI help
retains both interface modes and the projection-contract option.

These are local results for this combination. The earlier source-head CI does
not validate this merge or an eventual wider aggregate; new current-head CI is
still required. The concurrently edited source branch remains untouched.
