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

CI found that the installed-daemon smoke test still read the removed GitHub
profile. Moved that explicitly invented API into a test fixture and ran the
installed npm tarball against a new disposable local PostgreSQL database;
sync, webhook/daemon, browse/history, schema tags, export and cleanup passed.

## Candidate23 alignment (2026-10-27)

Human request: “ok maybe we want to create candidate23 with our additions in it and use that everywhere?”

Prepared an Atomic Server candidate based directly on candidate22 with batching, bounded browser read recovery, nested-JSON null preservation, and readable schema-backed table previews. Aligned the SyncD native companion dependency and documented the supported full-sync capabilities. Adapted unavailable newer APIs to the candidate equivalents without importing develop. Added explicit recovery refusal and replicated nested-null regression checks. Local production data and credential details remain [redacted]. Exact-head CI and final pin publication are tracked separately from local tests.

Human follow-up: the schema should depend on the OAD and its path/operation, not the configured collection. Changed schema import keys and labels accordingly, keeping account tables and row identities separate. Added failing-first regressions for cross-account schema reuse and declared Class independence from current records, plus OAD-revision isolation. Undeclared source fields remain visible in table projections without changing the declared Class. The local preview now uses single lines, ellipses and bounded tooltips to preserve fixed row height.

Final local validation for candidate 30994948: 42 core Loro tests, 9 native Rust tests, locked native build and Clippy passed. The final mixed PostgreSQL/Vitest run passed 12 cases with no skips: 2 actual PostgreSQL-to-native-process restart/update cases, 1 PostgreSQL-only case and 9 unit cases. The browser helper has 13 passing unit cases and the matching native Playwright test passes without retries, including desktop/mobile geometry and full JSON editing. Operation-based schema publication reused every existing resource identity; a fresh signed readback verified 194 resources, 2,491 fields and all 132 rows with no mismatches. The host/browser pin proposal is PR #695; exact-head CI remains pending at this commit.
