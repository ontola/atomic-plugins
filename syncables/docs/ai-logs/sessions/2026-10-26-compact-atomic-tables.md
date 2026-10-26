# Compact Atomic tables and complete Keep OpenAPI contract

Session: codex://threads/01a16c93-853b-7362-94e6-c7287ee8a15e
Model/tool: GPT-6 via Codex; Astra reviewed the separate browser transport design.

## Human prompts

- Use Atomic as SyncD's sync engine and show API collection tables grouped by account.
- Benchmark one resource per issue/note, keeping comments inside each issue.
- The note table loads slowly, body displays JSON, two Name columns are confusing, and explain permissions.
- “why is there a minimal local OAD? we should be using the real one”

Private resource identifiers, account details, note contents and credentials are [redacted].

## Substantive outputs

Changed the experimental projector from recursive resources to inline native JSON per row, preserving ordered arrays, nested nulls, comments and exact unsafe numeric text. Versioned the projection binding, retained native Classes/Properties and default views, and documented fresh-directory upgrades. Distinguished API identifiers from Atomic display names and explicitly described source permissions as metadata, without granting Atomic access. Retained declared compound-field JSON schemas on Properties.

Replaced the stripped Keep example with the complete pinned upstream document (all paths and response schemas), adding only collection/pagination annotations and provenance. Replaced the GitHub profile with a small annotation file and a reproducible preparation script that verifies the pinned full upstream contract; generated large contracts stay outside Git. Both live local configurations were switched to the full contracts. Read-only operation selection remains enforced by SyncD. Switching the local configuration required a new immutable source-document scope; refreshing private data remained blocked on device login renewal. No old snapshot provenance was rewritten.

TypeScript type checks and six targeted table tests passed. Three native table tests passed, including inline JSON persistence and publication recovery; Rust formatting passed. PostgreSQL/peer integration and full CI remained pending at commit time. Browser transport work is in a separate atomic-server worktree and PR.
