# Session log — 2026-10-08: fixed reads (CRUD Causality 0.4.0)

- **Session:** Claude Code session `34aa233c-71c8-572f-a731-1e2db1a082c2` (Remote Control on the maintainer's build VPS), the "syncables worker" subagent of the atomic-plugins coordinator session. No shareable URL is exposed to the worker.
- **Model/tool:** Claude Fable 5.1 (`claude-fable-5-1`) in Claude Code.
- **Repository touched:** `ontola/atomic-plugins`, `syncables/` only; based on `main` with the spec PR's commit (#382, `claude/crud-fixed-query`) cherry-picked underneath until it merges.
- **Redactions:** Filesystem paths and tool plumbing are omitted. No credentials or provider data; the fixture is the spec's synthetic example.

This log summarizes the substantive prompts and outputs under the scope in
[the disclosure guidance](../README.md). The committed diff contains the code.

## Turn 1

**Human (via the coordinator session):** CRUD Causality 0.4.0 fixed reads
(§4.2.1 and the §4.2 table): a Collection Object gains `listMethod` (GET or
POST), `listQuery` (string values) and `listBody` (POST only). A read sends
exactly the path parameters, `listQuery`, `listBody`, then the pagination
fields merged over them page by page; pagination owns its fields except
`pageSize`. In syncables, read the standard fields first, falling back to
`x-list-method`/`x-list-query`/`x-list-body`; when both forms are present,
the standard fields win. The reference is `read_request()` in the spec
folder's `validate.py`. Add fixture tests.

**Assistant:** `src/read/model.ts` reads each fixed value through
`listField`: the standard field when the Collection Object has it, else the
older extension, per field (so `listMethod` with an `x-list-body` keeps that
body); `listMethodOf` names the field it refused in its error. `ReadCollection`
and the README describe the standard names with the fallback. The request
itself was already assembled as the spec says (path, fixed query and body,
pagination merged per page in `walkPages`), so no change there. Tests: a new
`__tests__/fixtures/fixed-reads.ts` transcribes the spec's
`fixed-query.yaml`; `__tests__/unit/read/model.test.ts` checks the model
from the standard fields, from the older fields, and with both (per-field
precedence), string conversion of `listQuery` values, the refused method
error for each form, and, mirroring the spec's `ReadRequestTests`, the exact
requests of a two-page GET read (`/lists/L%201%2F2/tasks?showCompleted=true&showHidden=true`,
then with `pageToken`) and a two-page POST read (the fixed body exactly, the
cursor merged over it, `page_size` kept), plus a `pageSize` set by
`listQuery` staying when no caller sets one. README (collection bullet,
completeness passage, Unreleased changelog), CLAUDE.md and a `client.ts`
comment updated.
