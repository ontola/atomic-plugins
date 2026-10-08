# Todoist issue lens prototype

`lens/index.ts` is an **unhosted, existing-record** mapping from complete API
v1 tasks to the shared `issue-v1` class. It uses the unreleased
`devonian/lenses` source. It is not imported by the published Todoist app,
which retains its read-only operation declaration and disappearance policy.

| API field     | Atomic field            | Reverse edit                        |
| ------------- | ----------------------- | ----------------------------------- |
| `content`     | core name               | Text update                         |
| `description` | task/v1 body (Markdown) | Text update; removal clears to `''` |
| `checked`     | task/v1 Todo or Done    | Refused                             |
| `due.date`    | task/v1 due-date        | Refused                             |

The due-day display uses the first ten characters of a provider date/datetime,
validated as a real civil day. It does not convert timezones. The entire due
object, recurrence text, time and timezone remain untouched in the source.
Absent and null scheduling representations survive edits. A source with no due
date explicitly unsets a stale native due-date.

Completion requires Todoist's separate close/reopen operations and can have
recurrence/hierarchy effects. A day alone cannot express a Todoist schedule.
The lens therefore refuses edits to both fields, including clearing them.
Doing, Blocked, missing or multiple native statuses are unsupported rather than
silently treated as open. Source `is_deleted: true` requires a deletion event;
absence from an active list is not such an event. The existing app's separate
presence tracking is unchanged.

`todoistUpdatePlan(resource, previous)` returns `{ id, body }` containing only
changed `content` and `description` for `POST /api/v1/tasks/{id}`. Empty body
means no request. Provider IDs remain strings, scoped by the account connection
and entity `task`; labels, project, parent, assignee, schedule and unknown fields
are preserved. The host must fetch the current complete record and resolve
conflicts before executing a plan. The projection owns isA, name, body, status
and due-date, leaving other native fields intact. The schema helper catalogs
offline property datatypes; it does not register a class on a server.

API contract: [Todoist API v1](https://developer.todoist.com/api/v1/).

After the repo's link-atomic-server setup:

```sh
node integrations/tooling/run-lane.mjs issue-tracker --tier typecheck
node integrations/tooling/run-lane.mjs issue-tracker --tier unit
```

Tests use invented records and local AtomicStore state, with no API calls.
Text edits, preservation, civil-day rejection, explicit removal and read-only
constraints are covered. Publishing a Devonian release, adopting it in a drive
app, create/delete, live provider writes and a durable sync runtime are outside
this prototype. See [the inventory](../../../../docs/design/ontology-api-lenses.md).
