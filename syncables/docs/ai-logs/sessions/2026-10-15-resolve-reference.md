# Session log — 2026-10-15: resolving CRUD Causality references

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker 1" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Opus 5.5 (`claude-opus-5-5`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`: `syncables/` only.
- **Redactions:** Filesystem paths and tool plumbing are omitted.

## Turn 1

**Human (via the coordinator session):** pick the next syncables gap,
away from #577, #600, #603 and #606.

**Assistant:** CRUD Causality §4.1.3 Reference Objects were read only for
Runtime Schemas describers; nothing resolved a reference in general.
`resolveReference(document, resource, reference, object, context)` in
`read/references.ts` fills the target's `identity.urlTemplate` from the
object's bound fields and from the request context for unbound
variables, as the spec's §7.6 example describes; `required: false` with
an absent or null field gives undefined; anything unfillable throws.
Exported from both entries. Tests on the §7.6 example in
`unit/read/references.test.ts`. README (table row, section, changelog),
CLAUDE.md.

## Turn 2

**Human (via the coordinator session):** make sure `resolveReference`
refuses `.` and `..` values, since `/pages/..` normalises to `/`, and
values with leading or trailing whitespace, with tests.

**Assistant:** It did not: `encodeURIComponent` leaves `.` alone.
`segmentProblem` now refuses `.`, `..` and a value whose `trim()`
differs, for bound fields and context values alike, with a message
naming the field or variable. `...` and inner spaces or dots still pass.
Eleven new tests, all failing on the code before. README section and
changelog, CLAUDE.md.

## Turn 3

**Human (via the coordinator session):** the #611 review. Blockers:
use `Number.isSafeInteger` (`1e21` bound as `1e%2B21`,
`9007199254740993` became `...992`); and an optional reference's outcome
depended on template order (a null `projectId` with no `workspaceId` in
the context threw instead of giving undefined). Nits: refuse a template
that is not a path, decide on `''`, wrap a lone surrogate's `URIError`,
refuse NUL, and add tests for `%2e%2e`, `/`, `?` and `#`.

**Assistant:** Bound fields are now read in a first pass, so an
optional reference with an absent or null field gives undefined before
any context variable is looked up. A number must be a safe integer.
A template must start with exactly one `/`. `''` stays a value, not an
absence: it throws as "empty", required or not, because the spec names
only absent and `null`. `segmentProblem` also refuses NUL, and a lone
surrogate gets a message naming the field or variable. 14 new tests,
13 of them failing on the code before. README, CLAUDE.md, changelog.

## Turn 4

**Human (via the coordinator session):** a follow-up from #611's
re-review: a bigint field value makes the error message's
`JSON.stringify` throw a `TypeError`; and a template starting `/\` passes
the one-slash check, while the WHATWG URL parser resolves
`/\evil.example/` to that host.

**Assistant:** Error messages format values with `show`, which writes a
bigint as `10n` and falls back to the value's type when `JSON.stringify`
throws or gives nothing. A template with any backslash is refused. Six
new tests, five failing on the code before (the sixth pins the URL
parser's reading of `/\host`). README, changelog, CLAUDE.md.
