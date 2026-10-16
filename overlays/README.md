# overlays
OpenAPI Overlay files that complete existing OpenAPI files with Pagination Schemes and other additions

## Where this lives and how it is published

This folder was migrated from the standalone `localthought/overlays`
repository (full history via `git subtree`, from its `main` plus its
`calendar-events-write-back-prod` branch, which the integration proxy's
production catalog pinned). Author new overlays here, not there.

GitHub Pages publishes this repository's `main` from its root (legacy
build; the root `.nojekyll` makes it serve every file byte-for-byte), so
any file `overlays/<path>` is served at:

```
https://ontola.github.io/atomic-plugins/overlays/<path>
```

Each dated catalog under `catalog/` lists each platform's overlays by those
URLs. The integration proxy's default `CATALOG_PATH` is
`https://ontola.github.io/atomic-plugins/overlays/catalog/2026-10-02-auth-profiles.json`
since #258 (unreleased); proxy 0.2.4, and localthought.io's explicit
`CATALOG_PATH`, use `catalog/2026-10-02.json`. Before this
migration every overlay URL was pinned to a `localthought/overlays` commit
on `raw.githubusercontent.com`. Pages URLs are not Git-commit URLs, but
CI preserves published dated catalogs and OAD-revision overlay files
byte-for-byte on later merges. The OAD
(`openapi`) URLs and every overlay's standard `extends` field pin the same
`ontola/openapi-directory` document at the full commit SHA that last changed
that file, rather than a later unrelated repository commit.

The unversioned `catalog.json` was removed after localthought.io switched to
this dated catalog on 2026-10-02 (Heroku release v85, wrapper commit
`1f89c7efb25f6fd0f7394997e69ed738fd1a4aad`, proxy 0.2.4). Its live Discord
document changed from two paths to 153, confirming the catalog switch.
Historical overlay revisions remain published, including Discord's two-read
subset and Clockify's older revision; existing revision URLs stay valid.

Dated catalogs and their selected revision files are immutable once on
`main`; publish a new dated catalog and update the proxy's default or its
`CATALOG_PATH` to opt in. New overlays do not change an existing catalog.
The 2026-10-02 catalog selects the full Discord OAD and its existing two-read
CRUD metadata. Proxy 0.2.4 refuses the OAD's mixed OAuth/bot-token security
schemes, so that catalog's Discord entry composes but cannot connect.
`catalog/2026-10-02-auth-profiles.json` is the same catalog except for
Discord ([#258](https://github.com/ontola/atomic-plugins/issues/258)): it
lists `APIs/discord.com/10/auth-v2-9d0d73c6b23cb07ca2d225fb8b3848fede322b21-overlay.yaml`
instead of the v1 auth overlay, and selects
`{"authenticationProfile": "discordUser"}`. The v2 overlay adds
[authentication profiles](../openapi-extensions/spec/authentication-profiles/README.md)
to v1's content: `discordUser` (the `discordOAuth` authorization-code
scheme, which covers `GET /users/@me` and `GET /users/@me/guilds` with
`identify` and `guilds`) and `discordBot` (the OAD's `BotToken`, every
operation that accepts it on its own; declared, selected by no catalog). A
proxy that supports profiles connects Discord with the user profile and
refuses every other Discord operation. Composition tests cover this; no live
Discord connection has been made with it.

Discord's guild list needs no pagination for these user tokens. Discord's
reference for `GET /users/@me/guilds`
(https://docs.discord.com/developers/resources/user, "Get Current User
Guilds", checked 2026-10-09) says it "returns 200 guilds by default, which
is the maximum number of guilds a non-bot user can join", and that
pagination is not needed to list a user's guilds; `limit` is 1–200. The
CRUD overlay's fixed `limit: 200` read of `myGuilds` therefore returns every
guild of a `discordUser` connection, and a guild missing from it is one the
user left. The comment in
`APIs/discord.com/10/pagination-9d0d73c6b23cb07ca2d225fb8b3848fede322b21-overlay.yaml`
that Syncables "cannot derive a cursor" for `before`/`after` is moot for
this read: no cursor is needed. It would matter only for a bot token (the
`discordBot` profile), which no catalog selects.

`catalog/2026-10-06-google-tasks.json` is the auth-profiles catalog plus one
platform, `google-tasks` ([#355](https://github.com/ontola/atomic-plugins/issues/355)):
the Tasks v1 OAD at `7ca47c73cf2308c9812692b482b3713b397bc88c`, its new
`auth-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml` (the
`googleOnline`/`googleOffline` schemes of Calendar's auth overlay with the one
scope `https://www.googleapis.com/auth/tasks.readonly`, every operation
narrowed to it, the writes included, because the proxy's `Provider::from_document`
needs each operation to name the selected scheme; Google's own scope check
refuses a write on such a token) and the published pagination overlay, with
`{"oauthSecurityScheme": "googleOffline"}` selected. It is for the read-only
Google Tasks drive app (`integrations/google-tasks/`). No proxy release or
deployment selects it yet; a proxy picks it up through `CATALOG_PATH`, with
`OAUTH_GOOGLE_TASKS_CLIENT_ID`/`_CLIENT_SECRET` set. Composition is checked by
`tests/test_identity_overlays.py` (every catalog) and the pin validator; no
live Google connection has been made with it.

## Asana and Airtable onboarding catalog

`catalog/2026-10-08-asana-airtable.json` retains the nine entries and pins in
the production auth-profiles catalog and adds two read-only authentication
profiles. Asana selects workspace, project, task and user GET operations with
`workspaces:read`, `projects:read`, `tasks:read` and `users:read`. Airtable selects
base/schema and record GET operations with `schema.bases:read` and
`data.records:read`, including offset paging for bases and records. The Airtable
OAD is an authored, documented subset; it does not claim full API coverage.

Both profiles use S256 PKCE. Airtable supports a confidential client using
HTTP Basic or a public client without a secret; the registered client’s choice
is configured through the proxy’s generic credential settings. Selecting this
catalog does not register applications or prove a real-account connection.
The operator must configure each application and explicitly switch
`CATALOG_PATH` after validation. Provider reads are the only operations exposed
by these two profiles. See the [source and scope evidence](tests/ASANA_AIRTABLE_READONLY_PROVENANCE.md)
and the focused composition and consumer checks under `tests/`.

Airtable OAuth integrations without a support email, privacy-policy URL and
terms-of-service URL are limited to authorization by their developer account.
Supply the operator’s actual policies before advertising general availability;
a working developer connection does not establish public distribution.

## Throttling response signals

Four standalone overlays declare [Throttling 0.2.0-draft](../openapi-extensions/spec/throttling/README.md#throttling-signals)
`headers` and `signals`; no dated catalog selects them.
`tests/test_throttling_overlays.py` composes each with its pinned OAD and
classifies synthetic responses shaped as the provider documents them. No
provider was called.

| Overlay | Declares | Evidence |
| --- | --- | --- |
| [GitHub REST 2022-11-28](APIs/github.com/api.github.com.2022-11-28/1.1.4/throttling-7782419eb8c981c9dd28379e41a43ca3186f4758-overlay.yaml) | `x-ratelimit-limit`, `-remaining`, `-used`, `-reset` (epoch seconds), `retry-after` (seconds); 403/429 with remaining `0` as `quotaExhausted`, with `retry-after` or a secondary-limit message as `throttled` (60 s minimum). | [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). The secondary-limit message text is assumed from GitHub's description: not documented as an exact string and not recorded here (the issue-tracker app also matches "abuse detection", not declared). |
| [GitHub Issues 1.1.4](APIs/github.com/github-issues/1.1.4/throttling-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml) | The same declarations as the GitHub REST 2022-11-28 row: the github-issues subset (the issue-tracker app's catalog platform) is served by the same API and limits. | As above |
| [Google Tasks v1](APIs/googleapis.com/tasks/v1/throttling-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml) | 403/429 with `rateLimitExceeded` or `userRateLimitExceeded` in `error.errors[].reason` as `throttled`. No `Retry-After`: Google does not document sending it. | Inferred from the [Calendar error guide](https://developers.google.com/workspace/calendar/api/guides/errors); the [Tasks limits page](https://developers.google.com/workspace/tasks/limits) documents no error responses. |
| [Moneybird v2-readonly v2](APIs/moneybird.com/v2-readonly/throttling-v2-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml) | v1's 150-per-300-s source-IP bucket, standard `Retry-After`, and 429 as `quotaExhausted` on that bucket. `RateLimit-*` are not declared: no documented units. | [Introduction, Throttling](https://developer.moneybird.com/introduction) |

## Pagination Schemes 0.7.0 catalog: Google Tasks empty lists and Box offsets

`catalog/2026-10-12-tasks-box-pages.json` is `catalog/2026-10-12-box-pagination-v2.json`
with two pagination overlays replaced; every other entry is unchanged.

Google Tasks:
[v2](APIs/googleapis.com/tasks/v1/pagination-v2-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml)
in place of v1. v1 declares `envelope.itemsField: items`, and a syncables
reader from 0.21.0 on fails a body without that array ("No items array at
items"). An empty task list is expected to come back without `items`: the
Protocol Buffers JSON mapping leaves an empty repeated field out, and the
google-tasks drive app reads an absent `items` as empty. The Tasks
reference does not say what an empty list returns, and no live empty list
was read. v2 declares `emptyWhenAbsent: true`, which a reader that does not
know the field ignores, failing such a read as before. No Google Calendar
overlay is changed: Calendar's reference does not say it leaves `items`
out, and the Calendar drive app (`integrations/calendar/app/relay.ts`)
requires the array.

Box:
[v3](APIs/box.com/2.0.0/pagination-v3-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml)
in place of v2: `advance: pageSize` on the offset lists' `offset` field, so
a 0.7.0 reader steps by the `limit` Box reports and ends at `total_count`,
as Box documents, instead of advancing by the entries returned (see the v2
note above for what that does). A reader without 0.7.0 ignores `advance`
and reads as with v2.

`tests/test_google_tasks_empty_lists.py` checks Tasks v2 against v1, the
composed Tasks platform with the reference validator, and the catalog
against its base; `tests/test_box_pagination_v3.py` checks Box v3 against
v2, validates it and reads a synthetic offset list with the reference
`read_offsets`. Two syncables tests read through the catalogs
(`tests/google_tasks_empty_lists_syncables.test.ts`: an empty task list
fails through 2026-10-11 and reads as empty through this catalog;
`tests/box_offsets_syncables.test.ts`: a short page is read again under v2
and stepped over under v3); run them from `syncables/` with
`npx vitest run --root .. overlays/tests/<file>` (all of them:
`overlays/tests/`), as Overlays CI's `reads` job does.

## Read and list tombstones

Google Calendar v3 declares [Deletion Feeds 0.3.0-draft](../openapi-extensions/spec/deletion-feeds/README.md#43-tombstone-object)
tombstones on its events with one reading, wherever an event is answered:

* [read tombstones, revision 2](APIs/googleapis.com/calendar/v3/read-tombstone-v2-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml):
  `x-read-tombstone: { field: status, values: [cancelled], except: [{
  field: recurringEventId, present: true }] }` on the event read
  (`GET /calendars/{calendarId}/events/{eventId}`);
* [list tombstones](APIs/googleapis.com/calendar/v3/list-tombstone-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml):
  `x-list-tombstone` with the same marker and exception on the event list
  (`GET /calendars/{calendarId}/events`).

The pinned document's `Event.status` says "cancelled" is "The event is
cancelled (deleted)", that "The get method always returns them", that the
list returns them with `showDeleted=true` or on incremental sync, and that
on the organizer's calendar cancelled events "can be restored (undeleted)";
a consumer treats every such tombstone as restorable. The document gives
"cancelled" a second meaning: "Cancelled exceptions of an uncancelled
recurring event indicate that this instance should no longer be presented
to the user. Clients should store these events for the lifetime of the
parent recurring event", and "All other cancelled events represent deleted
events". A cancelled exception carries `recurringEventId`, so the `except`
condition keeps it out of both declarations: it is not a deletion, whether a
read or a list answers it, as Deletion Feeds §4.3 requires of a marked state
the provider documents as something else. A cancelled exception of a
deleted series is kept too (the item does not say its series' state). In a
`singleEvents=false` list, as the Calendar drive app reads, the series' own
item, which has no `recurringEventId`, reports the series. With
`singleEvents=true` there is no series item: every instance carries
`recurringEventId`, so the instances of a deleted series are kept as
members and nothing in that list reports the deletion. This supersedes the reading of
the first read-tombstone revision,
[`read-tombstone-32237fa5…`](APIs/googleapis.com/calendar/v3/read-tombstone-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml)
(#489), which declared cancelled exceptions as deletions of their
occurrence; that file stays, as published revision files are immutable,
and no catalog selects it. Both declarations are on operations, so they
apply with either crud-causality overlay, and no dated catalog selects them
yet. syncables reads both. `tests/test_calendar_read_tombstone_v2.py` and
`tests/test_calendar_list_tombstone.py` compose them after the catalog's
Calendar overlays. Declared from the document; not verified against a live
calendar.

## Notion pages completeness

[`completeness-0c8e2296…-overlay.yaml`](APIs/notion.com/2026-03-11/completeness-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml)
declares [Collection Completeness 0.2.0-draft](../openapi-extensions/spec/collection-completeness/README.md)
on the Notion `pages` collection (a data source's query): `absent: removed`
and `notFound: unavailable`. Notion's
[status codes](https://developers.notion.com/reference/status-codes) say a 404
`object_not_found` "can also indicate that the resource has not been shared
with owner of the bearer token", so without this overlay a consumer would take
a page no longer shared with the connection as deleted (the `notFound`
default). The [query](https://developers.notion.com/reference/query-a-data-source)
"returns non-archived pages" by default, so absence alone settles nothing.
Inferred, not documented: that a trashed page leaves the query and that an
archived or trashed page's own read still answers 2xx; neither changes an
outcome. The query is capped at 10,000 results, so a catalog selects this
overlay only together with `pagination-v3-0c8e2296…`, which marks a capped
read incomplete; under an earlier pagination revision a query over 10,000
results looks complete (the test asserts this pairing). Not declared:
`gone` (no 410 documented), anything on `data_sources`, and so
`parentAbsent`, which needs a parent collection with a Completeness Object
(§4.4). The pinned OAD is an authored subset without descriptions, so the
evidence is Notion's reference. No dated catalog selects it yet.
`tests/test_notion_pages_completeness.py` composes it with the catalog's
auth, pagination and crud-causality overlays (and with pagination-v3), in
either order, runs both validators, and checks the outcomes `classify_read`
gives. No provider was called.

Why `data_sources` stays undeclared (checked 2026-10-15, quotes curl'd from
the raw pages): the collection is read through `POST /search`.
[Search by title](https://developers.notion.com/reference/post-search) says
"If no query param is provided, then the response contains all pages or
data_sources that have been shared with the connection.", but
[Search optimizations and limitations](https://developers.notion.com/reference/search-optimizations-and-limitations)
lists among what search is not optimized for "Exhaustively enumerating
through all the documents that a bot has access to in a workspace." and says
"Search is not guaranteed to return everything, and the index may change as
your connection iterates through pages and databases." and "Search indexing
is not immediate." A data source absent from a read can therefore be one the
index has not caught up with, so no completeness is declared on it.

## Write preconditions

Two standalone overlays declare [Write Preconditions 0.1.0-draft](../openapi-extensions/spec/write-preconditions/README.md)
`x-write-precondition`; no dated catalog selects them.
`tests/test_write_precondition_overlays.py` composes each with its pinned OAD,
and Calendar's also after each of its crud-causality overlays, and checks the
reference client logic against what the drive apps do;
`syncables/__tests__/unit/client/calendar-recurring-refuse.test.ts` runs the
Calendar overlay through the syncables client. No provider was called.

| Overlay | Declares | Evidence |
| --- | --- | --- |
| [Google Calendar v3](APIs/googleapis.com/calendar/v3/write-preconditions-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml) | Event `PATCH`, `PUT` and `DELETE`: `ifMatch` with the body field `etag`, `412` as conflict; refused for a recurring series' master event (`recurrence` present); an exception of a series (`recurringEventId` present, no `recurrence`) is written ([K18](../docs/design/pieces.md)). The calendar drive app also leaves exceptions out, which is its own scope. | [Versions of resources](https://developers.google.com/workspace/calendar/api/guides/version-resources) |
| [Notion 2026-03-11](APIs/notion.com/2026-03-11/write-preconditions-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml) | Page `PATCH`: `readVerify`, refused when `in_trash` (or its deprecated alias `archived`) is `true`. | [Page object](https://developers.notion.com/reference/page): no conditional update documented |

## GitLab issues completeness

[`completeness-f6d7940e…-overlay.yaml`](APIs/gitlab.com/v4-readonly/completeness-f6d7940e9865903b9c99c5c1fc2d57d92811eef4-overlay.yaml)
declares [Collection Completeness 0.2.0-draft](../openapi-extensions/spec/collection-completeness/README.md)
on the GitLab.com `projectIssues` collection: `absent: removed` and
`notFound: unavailable`. GitLab's
[status codes](https://docs.gitlab.com/api/rest/troubleshooting/) give one 404
for "an ID for a resource couldn't be found" and for "the user isn't
authorized to access the resource", so without this overlay a consumer would
take a confidential or no-longer-accessible issue as deleted (the `notFound`
default). The list's `state` defaults to `all` (the pinned OAD's
`default: all`) and its `scope` "Defaults to `all`" (the
[issues reference](https://docs.gitlab.com/api/issues/)), but an issue also
leaves the list when it becomes confidential to the caller or the caller loses
access, so absence alone settles nothing. Page-number paging can skip the
issue after one deleted during a read; that issue still exists, and its own
read finds it present. Not verified: which issue types (tasks, incidents)
the list returns without `issue_type`, and whether they are read as issues
are. Not
declared: `gone` (no 410 documented for issues), anything on `projects`, and
so `parentAbsent`, which needs a parent collection with a Completeness Object
(§4.4). No dated catalog selects it yet.
`tests/test_gitlab_issues_completeness.py` composes it with the catalog's
auth, pagination and crud-causality overlays of the same pin, in either order,
runs both validators, and checks the outcomes `classify_read` gives. No
provider was called.

Why `projects` stays undeclared (checked 2026-10-15, quotes curl'd from the
raw [projects reference](https://docs.gitlab.com/api/projects/)): the catalog
narrows the list with a `membership=true` selection override ("Limit by
projects that the current user is a member of."), and a consumer drops a
completeness declaration that a selection narrows. A crud-causality revision
could fix `membership=true` as a `listQuery` (as Google Tasks'
crud-causality v2 and Google Calendar's app-crud-causality v2 fix their reads,
and as
`APIs/moneybird.com/v2-readonly/all-records-selection.json` widens
Moneybird's), but the read would still narrow by default: parameters exist
that would widen it, `include_pending_delete` ("Include projects pending
deletion. (administrators only)") and `include_hidden` ("Include hidden
projects. (administrators only) Premium and Ultimate only."), and a caller
that is not an administrator cannot send them. In this repository a list
filters by default when such a parameter exists (Moneybird's
`include_archived`, GitHub's `state`), and Collection Completeness §4.2 says
`absent: removed` "still tells a consumer that the list does not filter by
default", so no completeness is declared on it.

## Todoist projects completeness

[`completeness-v2-ac07532b…`](APIs/todoist.com/1/completeness-v2-ac07532b0a0ac101cf8bae2a54177fb1d8ea3779-overlay.yaml)
keeps v1's tasks declaration (#99) and adds the `projects` collection:
`absent: removed`, `notFound: unavailable` (quotes curl'd from the raw
[API v1 reference](https://developer.todoist.com/api/v1/) on 2026-10-15). Get
Projects says "Get all active user projects, optionally filtered by folder or
workspace."; its `folder_id` and `workspace_id` only narrow it and are not
sent, and no parameter widens it to archived projects (those come from a
separate endpoint, Get Archived: "Get the user's archived projects."). As for
the tasks list ("all active tasks"), the list therefore does not filter by
default in the sense this repository applies (a parameter that would widen
it), and an archived project ("removing it from view") or a deleted one is an
absence its own read settles: §4.2's `removed` "MAY still exist, for example
archived". The reference lists a 404 among the read's responses without
saying which case gives it, so a 404 is `unavailable`. Not verified: what a
project's read answers once it is archived or deleted. It states
`info.x-requires` (the catalog's crud-causality overlay). No dated catalog
selects it. `tests/test_todoist_completeness_v2.py` checks that v2 is v1 plus
the projects declaration, composes it in either order, and checks the
outcomes `classify_read` gives. No provider was called.

## Google Calendar deletion feed

[Google Calendar v3 deletion feed](APIs/googleapis.com/calendar/v3/deletion-feed-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml)
declares [Deletion Feeds 0.3.0-draft](../openapi-extensions/spec/deletion-feeds/README.md)
`x-deletion-feed` on the `events` collection: the feed is the event list
itself (`calendar.events.list`), read with the cursor `syncToken` and its
pages only; the cursor for the next read is `nextSyncToken`, "present only
on the very last page"; a 410 ("sync tokens are invalidated") drops the
cursor; cancelled events are the tombstones, except items with
`recurringEventId` (cancelled exceptions, which clients store), the same
`except` as the read and list tombstones above. The pinned document's
`syncToken` says "All events deleted since the previous list request will
always be in the result set and it is not allowed to set showDeleted to
False", so the feed needs no `showDeleted`, and every feed read sends the
same parameters, as Google's
[sync guide](https://developers.google.com/workspace/calendar/api/guides/sync)
asks. So the first cursor comes from a feed read without a cursor, never
from the drive app's own list read (`singleEvents=false&showDeleted=true`),
whose token would then be sent without those parameters. That first read is
a full listing and counts against the consumer's record budget (syncables'
`maxRecords`, 5000 by default): a calendar with more events never completes
it and never gets a cursor. Members and tombstones are those
`singleEvents=false` (the default) returns: a series is its master event,
plus exceptions with their own ids; a deleted series has one tombstone, the
master's, and its instances get none.

It composes with `app-crud-causality-32237fa5…` (the catalogs' choice) or
`crud-causality-32237fa5…`, both tested, and is selected with
`read-tombstone-v2-32237fa5…`, not the first revision. Do not select it with
`pagination-v2-32237fa5…`, whose event-list description says "Full listing
only: omit syncToken". The first read-tombstone revision's comment "Not
declared: an `x-deletion-feed` over the event list" is stale since this
overlay; that file is published and stays as it is. Not verified and not
documented: that a feed read returns an event at most once; what it returns
for the exceptions of a deleted series; how an event moved to another
calendar (`events.move`) or an attendee's copy after the attendee is removed
appears (both may appear cancelled in the source calendar while the event
still exists elsewhere). No dated catalog selects it yet.
`tests/test_calendar_deletion_feed.py` checks the declaration against the
composed document and the pinned wording. No provider was called.

## GitHub patch formats

[GitHub Issues crud-causality v2](APIs/github.com/github-issues/1.1.4/crud-causality-v2-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml)
and [GitHub REST crud-causality v2](APIs/github.com/api.github.com/1.1.4/crud-causality-v2-920631db31e628be547e9366821d3ebc7fa0ead5-overlay.yaml)
replace v1's `patchFormat: merge`, which [CRUD Causality §4.6](../openapi-extensions/spec/crud-causality/README.md#46-patch-formats)
does not define, so a consumer did not know the body format and sent the
full record. The issue and comment PATCHes are `jsonMergePatch`: the body is
a partial object, and GitHub's
[Update an issue](https://docs.github.com/en/rest/issues/issues#update-an-issue)
reference documents merge-patch behaviour for its fields ("use null to
remove the current milestone"; labels and assignees replace the stored set,
`[]` clears it). GitHub does not name RFC 7396 and takes `application/json`.
In github-issues the two label writes keep `mode: patch` and say
`patchFormat: custom`. v1 also gives its added fields (the issue `number`,
the comment `id`) `source: server`, which §4.5 does not define; v2 says
`generated`, so a consumer leaves its own placeholder for them out of the
create body. Nothing else changes; v1 stays published. No dated
catalog selects v2 yet. `tests/test_github_crud_patch_format.py` checks
that every update of each composition names a rule-5 mode and a §4.6
format, that v2 differs from v1 only in patch formats, added-field sources
and descriptions, and that the CRUD Causality validator passes. No provider
was called.

## GitHub compound creates

[GitHub Issues compound create](APIs/github.com/github-issues/1.1.4/compound-create-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml)
declares a [CRUD Causality 0.5.0](../openapi-extensions/spec/crud-causality/README.md#47-compound-creates)
compound create for an issue with labels: the create sends `labels`
(`create: include`), and the follow-up `issues-add-labels` adds those the
created issue lacks (`itemKey: name`). GitHub's
[Create an issue](https://docs.github.com/en/rest/issues/issues#create-an-issue)
says "Only users with push access can set labels for new issues. Labels are
silently dropped otherwise", and the follow-up can be refused after the issue
exists, so the create is then partly applied. It composes after
crud-causality v2, not v1: v2's issue number is a `generated` added field,
so a create body leaves the client's placeholder out. syncables reads
`followUps` since 0.22.0. Declared, not verified against a live account. No
dated catalog selects it yet. `tests/test_github_compound_create.py` checks it with the spec's
`compound_create`. `tests/github_compound_create_syncables.test.ts` runs it
through syncables on the catalog's bytes (a dropped label added by the
follow-up; a 403 follow-up failed, the create not sent again). No CI
workflow runs the `overlays/tests/*.test.ts` files (overlays CI runs only
`test_*.py`, and syncables' vitest config covers only `syncables/__tests__`),
so run it by hand from `syncables/` after `npm ci`:
`npx vitest run --root .. overlays/tests/github_compound_create_syncables.test.ts`.

## Google Calendar throttling

[Google Calendar v3 throttling](APIs/googleapis.com/calendar/v3/throttling-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml)
declares [Throttling 0.2.0-draft](../openapi-extensions/spec/throttling/README.md)
for the Calendar document the catalogs select: the default quotas of
Google's [quota page](https://developers.google.com/workspace/calendar/api/guides/quota)
("Per minute per project": "10,000 requests", partitioned by application;
"Per minute per user per project": "600 requests", by application and user;
window kind `unspecified`, since Google lets a burst carry into "the next
window"), and one signal: a 403 or 429 whose `error.errors[].reason` is
`rateLimitExceeded` or `userRateLimitExceeded` is `throttled`, as the
[error guide](https://developers.google.com/workspace/calendar/api/guides/errors)
documents, with no bucket named. Not declared: `Retry-After` (not
documented), `quotaExceeded` (Calendar usage limits against abuse, not a
rate to wait out), the per-calendar and operational limits, which have
no numbers, and the quota page's 1,000,000 requests per day per project,
which is a billing threshold ("Usage under this threshold doesn't incur
extra charges"), not a limit at which requests are refused. A project's own quota may differ from the defaults. No dated
catalog selects it yet. `tests/test_calendar_throttling.py` composes it
alone and after the catalog's Calendar overlays, and classifies synthetic
errors in the guide's shape. No provider was called.

## Spotify playlists completeness

[`completeness-2914e6be…-overlay.yaml`](APIs/spotify.com/1.0.0-readonly/completeness-2914e6bed4db4389921b36e4ed79e645c2085668-overlay.yaml)
declares [Collection Completeness 0.2.0-draft](../openapi-extensions/spec/collection-completeness/README.md)
on the Spotify `playlists` collection (`GET /me/playlists`): `absent: removed`
and `notFound: unavailable`. Spotify's
[playlists concepts](https://developer.spotify.com/documentation/web-api/concepts/playlists)
say "the notion of deleting a playlist is not relevant": removing one from
the user's list is "simply unfollowing it", and restoring it is following it
again. So a playlist absent from the list was unfollowed, not deleted, and its
own read settles it. Spotify's
[status codes](https://developer.spotify.com/documentation/web-api/concepts/api-calls)
say a 404 "can be due to a temporary or permanent condition", so a 404 is not
a deletion either. The list is whole only with both `playlist-read-private`
and `playlist-read-collaborative`, which the catalog's auth overlay requests.
Not declared: `gone` (no 410 listed); no `parentAbsent` (the list has no path
variable). Not verified: what a playlist's read answers after its owner
unfollows it. No dated catalog selects it yet.
`tests/test_spotify_playlists_completeness.py` composes it with the catalog's
auth, pagination and crud-causality overlays, in either order, runs both
validators, checks the scopes and the outcomes `classify_read` gives. No
provider was called.

## Spotify throttling

[Spotify Web API throttling](APIs/spotify.com/1.0.0-readonly/throttling-2914e6bed4db4389921b36e4ed79e645c2085668-overlay.yaml)
declares [Throttling 0.2.0-draft](../openapi-extensions/spec/throttling/README.md)
from Spotify's [rate-limits page](https://developer.spotify.com/documentation/web-api/concepts/rate-limits):
one bucket per app (`partitionBy: [application]`) over "a rolling 30 second
window" (`kind: sliding`) with no request count, because none is published
and it differs between development and extended quota mode; `Retry-After`
in seconds, which a 429 "will normally include"; and a 429 as `throttled`.
The 429 is not declared `quotaExhausted` for the app bucket, because Spotify
also has endpoint limits that answer 429, of which it names one, "the
playlist image upload endpoint" (not in the read-only document this overlay
extends). No dated catalog selects
it yet. `tests/test_spotify_throttling.py` composes it alone and after the
catalog's Spotify overlays and classifies synthetic responses. No provider
was called.

## Airtable table records completeness

[`completeness-1f5368e0…-overlay.yaml`](APIs/airtable.com/1.0-readonly/completeness-1f5368e0251bfbaa233860dc8131507c38a4f8b3-overlay.yaml)
declares [Collection Completeness 0.2.0-draft](../openapi-extensions/spec/collection-completeness/README.md)
on the Airtable `tableRecords` collection: `absent: removed` and
`notFound: unavailable`. Airtable's
[errors page](https://airtable.com/developers/web/api/errors) says a 404 is
returned "if the resource doesn't exist (e.g. has been deleted)", but a
record read's 404 answers just as well for a deleted or renamed table
(`tableIdOrName` may be a name) or a deleted base, and the pinned OAD adds
"or is not accessible"; the answer does not say which, so a 404 is not
taken as the record's deletion. [List records](https://airtable.com/developers/web/api/list-records)
returns every record when no view or `filterByFormula` is given, in
arbitrary order; nothing is documented about records skipped during offset
paging, so absence is `removed` and settled by the record's own read. Not
declared: `gone` (no 410 documented), anything on bases or tables, and
`parentAbsent` (no resource binds `tableIdOrName`). Not verified: whether a
deleted record can be restored (the interface has a trash; the API reference
does not mention it). No dated catalog selects it yet.
`tests/test_airtable_records_completeness.py` composes it with the catalog's
auth, pagination and crud-causality overlays, in either order, runs both
validators, checks the pinned wording and the outcomes `classify_read` gives.
No provider was called.

## Airtable throttling

[Airtable Web API throttling](APIs/airtable.com/1.0-readonly/throttling-1f5368e0251bfbaa233860dc8131507c38a4f8b3-overlay.yaml)
declares [Throttling 0.2.0-draft](../openapi-extensions/spec/throttling/README.md)
from Airtable's [rate-limits page](https://airtable.com/developers/web/api/rate-limits):
"5 requests per second per base", selected by the three operations that
address a base (partitioned by a URI-named base dimension, since the
extension's vocabulary has none), and a 429 as `throttled` with
`minDelaySeconds: 30` ("will need to wait 30 seconds before subsequent
requests will succeed"). Not declared: the 50-per-second limit, which the
page states for personal access tokens and service accounts while the
catalog connects through OAuth, and `Retry-After`, which the page does not
mention. No dated catalog selects it yet. `tests/test_airtable_throttling.py`
composes it alone and after the catalog's Airtable overlays and classifies
a synthetic 429. No provider was called.

## Asana project tasks completeness

[`completeness-b58c91d9…-overlay.yaml`](APIs/asana.com/1.0/completeness-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml)
declares [Collection Completeness 0.2.0-draft](../openapi-extensions/spec/collection-completeness/README.md)
on Asana's four lists, `workspaces`, `workspaceProjects`, `users` and
`projectTasks`: `absent: removed` and `notFound: unavailable`, plus
`parentAbsent: unavailable` on projects (parent: workspace) and tasks (parent:
project). Each list sends no narrowing filter ("all workspaces visible to the
authorized user", "all projects in the workspace" without the optional
`archived` filter, "all users in all workspaces and organizations accessible
to the authenticated user", every task of the project). From the pinned OAD's
own text (the same as Asana's
[API reference](https://developers.asana.com/reference/rest-api-reference)).
Its 404 says the object "does not exist", but deleted tasks go into the
deleting user's trash and "can be recovered from the trash within a period of
30 days", and what a trashed task's read answers is not documented, so a 404
is not a final deletion. A task leaves a project's list when deleted or
removed from that project ("Tasks can exist in more than one project at a
time"), so absence leads to the task's own read. Not declared: `gone` (no 410
documented). Not verified: that the list without `completed_since`
returns completed tasks (the parameter's text implies it), and whether
subtasks not added to the project are listed. An expired offset token ("an
offset token will expire after some time") fails the read, which is then not
complete. No dated catalog selects it yet.

It composes only after
[`crud-causality-v2-b58c91d9…`](APIs/asana.com/1.0/crud-causality-v2-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml),
also new: v1 plus `listQuery: {limit: '100'}` on each of the four Asana
lists. v1's read sends no `limit`, and Asana's
[pagination guide](https://developers.asana.com/docs/pagination) says "When
making paginated requests, you are able to "page through" all objects for a
particular query up to 100 objects at a time. Alternatively, your query will
be truncated at about 1,000 objects." A large project would then read as
complete while missing tasks. With the fixed `limit` (the pagination scheme's
`pageSize` field, which CRUD Causality §4.2.1 lets a `listQuery` set) the read
pages through every task. `tests/test_asana_tasks_completeness.py` composes
the completeness overlay with the catalog's auth and pagination overlays and
crud-causality v2, in either order, runs both validators, checks that v2 is v1
plus the `limit`, the pinned wording and the outcomes `classify_read` gives.
No provider was called.

## Asana throttling

[Asana API throttling](APIs/asana.com/1.0/throttling-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml)
declares [Throttling 0.2.0-draft](../openapi-extensions/spec/throttling/README.md)
from Asana's [rate-limits page](https://developers.asana.com/docs/rate-limits):
a standard per-token bucket over minute-long windows with no request count
(150 per minute on a free domain, 1,500 on a paid one, which a document
cannot select), a search bucket of 60 per minute per token on the task
search, `Retry-After` in seconds, and a 429 as `throttled` with no bucket
named, since the standard, search, concurrency and cost-based limits all
answer 429. Not declared: the concurrency and cost-based limits, which this
version of the extension does not describe. No dated catalog selects it
yet. `tests/test_asana_throttling.py` composes it alone and after the
catalog's Asana overlays and classifies a synthetic 429. No provider was
called.

## Notion throttling

[Notion API throttling](APIs/notion.com/2026-03-11/throttling-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml)
declares [Throttling 0.2.0-draft](../openapi-extensions/spec/throttling/README.md)
from Notion's [request-limits page](https://developers.notion.com/reference/request-limits):
`Retry-After` in seconds ("an integer number of seconds") and a 429 with the
code `rate_limited` as `throttled`. Its
[v2](APIs/notion.com/2026-03-11/throttling-v2-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml)
(Throttling 0.4.0-draft) adds a first signal: a 429 whose
`additional_data.rate_limit_reason` is `public_api_request_blocked`, for which
Notion says "This connection's API access has been restricted. Retrying won't
help. Contact Notion support.", is `blocked`, so a consumer does not retry it.
Not declared: the per-connection limits (600 or 180 requests per minute,
depending on the workspace's plan, which a document cannot select), the
per-workspace limit, which has no number, and the 529 `service_overload`,
since a 5xx is not a throttling signal. No dated catalog selects either
revision yet. `tests/test_notion_throttling.py` composes v1 and v2 with
the catalog's Notion overlays in either order, and
classifies synthetic errors in Notion's format. No provider was called.

## GitLab throttling

[GitLab.com REST API v4 throttling](APIs/gitlab.com/v4-readonly/throttling-f6d7940e9865903b9c99c5c1fc2d57d92811eef4-overlay.yaml)
declares [Throttling 0.2.0-draft](../openapi-extensions/spec/throttling/README.md)
for the read-only GitLab.com document, from GitLab.com's
[rate-limits page](https://docs.gitlab.com/user/gitlab_com/rate_limits/):
"Authenticated API traffic for a user" ("2,000 requests each minute", per
user) and "All traffic from an IP address" ("2,000 requests each minute",
`sourceIp`, shared by everyone behind a proxy) on every operation; the
project list's own limit ("2,000 requests every 10 minutes") and the single
project read's ("400 requests each minute") on those two operations, with no
partition, since the rows do not say per what they count. The page's
tier-aware limits are proposed, not in effect. Also the documented
[response headers](https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/)
`RateLimit-Limit` (adjusted "to approximately the nearest 60-minute period"
for a throttle whose period is not a minute), `RateLimit-Observed`,
`RateLimit-Remaining`, `RateLimit-Reset` (Unix time) and, on a 429,
`Retry-After` (seconds), and a 429 as `throttled` with no bucket named.
"Rate limiting responses for the Projects, Groups, and Users APIs do not
include informational headers", so a 429 from the project list's or project
read's own limit has no `RateLimit-*` or `Retry-After`.
Not declared: `RateLimit-ResetTime`, `RateLimit-Name` and the
unauthenticated limit ("500 requests each minute" per IP, in effect; every
operation here sends a user's token); the page names no limit for the issue
reads. No dated catalog selects it yet. `tests/test_gitlab_throttling.py`
composes it alone and after the catalog's GitLab overlays and classifies synthetic
responses. No provider was called.

## Discord pagination v2: a cursor from the last item

[`pagination-v2-9d0d73c6…`](APIs/discord.com/10/pagination-v2-9d0d73c6b23cb07ca2d225fb8b3848fede322b21-overlay.yaml)
declares [Pagination Schemes 0.9.0](../openapi-extensions/spec/pagination-schemes/README.md)
`fromLastItem` (§4.3.3) on the two Discord operations whose order is
documented: [Get Guild Bans](https://docs.discord.com/developers/resources/guild)
("Users will always be returned in ascending order by `user.id`") and
[Get Guild Scheduled Event Users](https://docs.discord.com/developers/resources/guild-scheduled-event)
("ascending order by `user_id`"). Both take `after` as a strict bound
("consider only users after given user id"), so the next page's `after` is
the last item's `user.id`: rule (b) of §4.3.3. The first request sends no
`after`, and an empty page ends the read (Discord has no has-more field). The
pinned OAD does not require `user` on a scheduled-event user; an item without
it ends the read with an error. Not declared, because Discord does not
document their order: List Guild Members (its `after` is "the highest user id
in the previous page", but the order is not stated), Get Reactions, List
Thread Members, Get Answer Voters, List Entitlements, List SKU
Subscriptions, Get Current User Guilds, the scheduled-event exception users,
Get Channel Messages, and the audit log (whose cursor-less first page is not
ascending). It keeps v1's one action, the guild list's description, revised.
A 0.8.0 consumer would stop after one page, so it needs a 0.9.0 reader. No
dated catalog selects it; the catalogs read neither operation.
`tests/test_discord_pagination_v2.py` validates it alone and in place of v1
after the catalog's Discord overlays, and reads synthetic pages with the
reference `read_item_cursor`. No provider was called.

The overlay file's comment is published and cannot change; checked again
on 2026-10-15, it needs these corrections and additions. Get Channel
Messages does state its order, "from newest to oldest" (it takes
`before`, `after` and `around`; newest to oldest is not ascending, so its
`after` is no rule (b) bound either). Newest-first, too, are the `before`-only
lists the comment does not name: List Public Archived Threads and List
Private Archived Threads ("ordered by `archive_timestamp`, in descending
order", `before` a timestamp), List Joined Private Archived Threads
("ordered by their `id`, in descending order", `before` an id) and Get
Channel Pins (`before` a pin timestamp, order not stated). Rule (b) covers
an ascending order with a lower bound only, so none of them qualifies in
Pagination Schemes 0.9.0. Get Guild Join Requests takes `before` and
`after` but is undocumented (it is in the pinned OAD only). Checked word for word against the raw
pages with curl on 2026-10-15, every quote in the overlay matches except
one: the scheduled-event users' `after` row reads "consider only users
after given user id" (lowercase), not "Consider ...", and its `limit` row
reads "number of users to return (up to maximum 100)".

[`pagination-v3-9d0d73c6…`](APIs/discord.com/10/pagination-v3-9d0d73c6b23cb07ca2d225fb8b3848fede322b21-overlay.yaml)
(Pagination Schemes 0.10.0) keeps v2, adds `order: ascending` to its scheme
so a client checks the documented order, and pages
[List Joined Private Archived Threads](https://docs.discord.com/developers/resources/channel)
back with `before` from the last thread's `id`, `order: descending`, and
`has_more` as `hasMore`: "Threads are ordered by their id, in descending
order" and `before` "returns threads before this id" (§4.3.3 rule (b)).
[Get Channel Messages](https://docs.discord.com/developers/resources/message)
stays without a scheme: its "newest to oldest" is an order of time, not of
the id `before` bounds, and "If the current user is missing the
READ_MESSAGE_HISTORY permission in the channel, then no messages will be
returned", so an empty read cannot be told from an empty channel. The
public and private archived-thread lists are ordered by `archive_timestamp`,
which is not unique, and stay without one too. No dated catalog selects v3,
and Pagination Schemes 0.10.0 asks that no overlay declaring `order` be
published until syncables checks it. `tests/test_discord_pagination_v3.py`
composes it, runs the validators, and reads synthetic pages with
`read_item_cursor`, including out-of-order pages that fail. No provider was
called.

## Discord throttling

[Discord API v10 throttling](APIs/discord.com/10/throttling-9d0d73c6b23cb07ca2d225fb8b3848fede322b21-overlay.yaml)
declares [Throttling 0.3.0-draft](../openapi-extensions/spec/throttling/README.md)
from Discord's [rate-limits page](https://docs.discord.com/developers/topics/rate-limits)
and the pinned OAD's own headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset-After` (in seconds), `Retry-After`, the 429 body's
`retry_after`, and a 429 as `throttled` with no bucket named (Discord's
per-route buckets are named only at run time). Discord types the reset and
delay values as numbers and its example has a fraction (`retry_after:
64.57`); the extension's units are whole seconds, so a fractional value is
ignored and the consumer falls back to `Retry-After` or its own backoff.
Plainly: a consumer that follows the spec cannot use a fractional
`X-RateLimit-Reset-After` or `retry_after` at all, because the Throttling
spec allows whole seconds only.
Not declared: the global limit, which applies to bots and users ("Global
rate limits apply to the total number of requests a bot or user makes") but
has a published number only for bots ("All bots can make up to 50 requests
per second"); the per-route limits, which have no published numbers; and the invalid-request limit, which counts only 401, 403 and 429
responses. No dated catalog selects it yet.
`tests/test_discord_throttling.py` composes it alone and after the
catalog's Discord overlays and classifies synthetic responses, fractions
included. No provider was called.

## Collections with fixed reads

Two standalone overlays declare [CRUD Causality 0.4.0](../openapi-extensions/spec/crud-causality/README.md#421-reading-a-collection)
`listQuery`; no dated catalog selects them yet.
`tests/test_crud_fixed_query_overlays.py` composes each with its pinned OAD and
pagination overlay, runs the collection-read validator, and checks that each
fixed read is the request the drive app sends. No provider was called.

| Overlay | Fixed read | Evidence |
| --- | --- | --- |
| [Google Tasks v1, crud-causality v2](APIs/googleapis.com/tasks/v1/crud-causality-v2-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml) | v1 (#378) plus envelopes (with `emptyWhenAbsent`, as pagination v2's), the task-list read and descriptions; task lists and tasks, read only; the `tasks` collection fixes `showCompleted=true` and `showHidden=true`. Deleted tasks stay excluded, and so do tasks assigned to the user (`showAssigned`, default false, is not in the pinned OAD). | The pinned OAD's parameter descriptions; [tasks.list](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list) |
| [Google Calendar v3 app v2](APIs/googleapis.com/calendar/v3/app-crud-causality-v2-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml) | v1's resources and operations; the `events` collection fixes `showDeleted=true` and `singleEvents=false` (hidden invitations stay out: `showHiddenInvitations` defaults to false), and the event update declares `mode: patch` with `patchFormat: jsonMergePatch` (v1 declares no `mode`, against CRUD Causality rule 5). | The pinned OAD's parameter descriptions; [events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list); [patch semantics](https://developers.google.com/workspace/calendar/api/guides/performance) |

## Collection completeness

Four standalone overlays declare [Collection Completeness](../openapi-extensions/spec/collection-completeness/README.md)
`x-completeness`, which syncables reads (`absent`, `notFound`, `gone`,
`parentAbsent`). No dated catalog selects them yet.

| Overlay | Declares | Evidence |
| --- | --- | --- |
| [Google Tasks v1 completeness](APIs/googleapis.com/tasks/v1/completeness-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml) | Task lists and tasks `absent: removed`, `notFound: unavailable`; tasks `parentAbsent: unavailable`; the task read tombstone `deleted: true`. Needs crud-causality v2 (the fixed read that returns hidden tasks). | The pinned OAD (tasklists.list "Returns all the authenticated user's task lists"; Task.deleted "Flag indicating whether the task has been deleted"); what a 404 means is not documented |
| [GitHub Issues completeness](APIs/github.com/github-issues/1.1.4/completeness-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml) | Issues `absent: removed`, `notFound: unavailable`, no `gone`; comments the same plus `parentAbsent: unavailable`. Page-number paging can skip an issue deleted or transferred during a read; it stays unconfirmed until its GET settles it. | [Get an issue](https://docs.github.com/en/rest/issues/issues#get-an-issue): 301 when transferred, 404 when transferred or deleted out of the caller's reach, 410 when deleted where the caller can read, and 410 for every issue when issues are turned off, so neither a 404 nor a 410 is declared a deletion |
| [Google Calendar v3 events completeness](APIs/googleapis.com/calendar/v3/completeness-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml) | Events `absent: removed`, `notFound: unavailable`, no `gone`, no `parentAbsent`. Composes with app-crud-causality, its v2 and crud-causality; a deletion is the read tombstone (a 2xx `cancelled` answer), never a 404. | [Errors guide](https://developers.google.com/workspace/calendar/api/guides/errors): a 404 when the resource "has never existed" or for "a calendar that the user can not access"; the 410s are about sync tokens and repeated deletes. The pinned OAD: cancelled events, "The get method always returns them", and they "will eventually disappear". An event may also leave the list without being deleted when the user's access to the calendar changes (assumed; not documented). A move can "leave behind a cancelled event where only the id field is guaranteed to be populated": with read-tombstone-v2 or list-tombstone selected, that remnant reads as a deletion from the source calendar; under the catalogs' read without them, a deletion or a move is an absence. `removed` stays safe either way. Not verified: what a deleted event's read answers once it has disappeared |
| [Todoist v1 active-task completeness](APIs/todoist.com/1/completeness-ac07532b0a0ac101cf8bae2a54177fb1d8ea3779-overlay.yaml) (#99) | Tasks `absent: removed`, `notFound: unavailable`; no read tombstone and no `gone`. | [API v1 reference](https://developer.todoist.com/api/v1/), read raw with curl: Get Tasks "Get all active tasks for the user"; Get Task "Returns a single active (non-completed) task by ID"; Close Task "Regular tasks are marked complete and moved to history"; Delete Task "Delete a task and all of its subtasks."; pagination "When next_cursor is null, you've reached the end of the results." A task that leaves the list may be completed, deleted or out of reach, and its read cannot return it as `checked` or `is_deleted`; no read answer is taken as a deletion, and a read that stops before a null `next_cursor` is not complete |

An earlier Todoist draft was left out because the reference could not be
read; read raw, it settles the declaration above. Not verified without a
live account, so not declared: the status `GET /tasks/{task_id}` answers
for a completed, a deleted or an inaccessible task; whether `GET /tasks`
includes tasks of an archived project; and whether "Tasks Completed By
Completion Date" (up to 3 months) lists every task that left the active
list by completion, which would tell completion from deletion.
Discord gets none: its one catalog collection (`/users/@me/guilds`) has no
item read in the crud overlay, so an absent guild could never be settled.
`tests/test_completeness_overlays.py`,
`tests/test_github_issues_completeness.py`,
`tests/test_calendar_events_completeness.py` and
`tests/test_todoist_completeness.py` compose each overlay with the
overlays it needs, run the Collection Completeness and CRUD Causality
validators, and classify synthetic reads with the spec's `classify_read`.
No provider was called.

## Lists without pagination

Fourteen catalog collections have no pagination scheme, so syncables reads
each once and takes the answer as the whole list. Checked on 2026-10-14 from
the providers' documentation only, so the next person need not re-check:

| Collection | Pages? | Evidence |
| --- | --- | --- |
| Moneybird `financial_accounts`, `identities`, `ledger_accounts`, `subscriptions` (one contact's), `users`, `webhooks`, `workflows`, `custom_fields`, `document_styles`, `task_list_templates`, and the contact's and subscription's `additional_charges` | No | The pinned OAD (`85a61052`, "Generated from the official Moneybird OpenAPI v2 specification") gives none of them a `page` or `per_page` parameter; its paginated lists all have both ("The list is paginated. Use the `per_page` and `page` parameters"). `ledger_accounts`: "Pagination is not supported for this endpoint." Several say they return all: `ledger_accounts` ("a list of all the ledger accounts"), `workflows`, `document_styles`, `task_list_templates`, `webhooks`; `financial_accounts` returns "Only active financial accounts". Moneybird's server-rendered reference pages carry the same text: [`/api/ledger-accounts`](https://developer.moneybird.com/api/ledger-accounts) "Returns a list of all the ledger accounts in the administration. Pagination is not supported for this endpoint." Not verified: that a large administration's answer is never cut short (no limit is documented for these). |
| Moneybird `financial_mutations` | No, but capped | "Limited to 100 financial mutations" and no page parameter (the pinned OAD and [`/api/financial-mutations`](https://developer.moneybird.com/api/financial-mutations): "Returns a list of financial mutations in the administration. Limited to 100 financial mutations."). Read by period windows: `pagination-range-window-85a61052…` (Pagination Schemes 0.5.0 `rangeWindow`, #397, #614), on `main` and selected by no dated catalog. |
| Discord `/users/@me/guilds` | Yes (`before`, `after`, `limit` 1–200) | Discord's [Get Current User Guilds](https://docs.discord.com/developers/resources/user): "This endpoint returns 200 guilds by default, which is the maximum number of guilds a non-bot user can join. Therefore, pagination is not needed". The catalog's crud-causality overlay sends `limit=200` (`x-list-query`), and its credential is a user's OAuth token. A bot token can see more guilds; following `after` (the last guild's id) would need a last-item cursor, which `pagination-v2-9d0d73c6…` deliberately does not declare here: Discord does not document the order of the guilds it returns. |

The Moneybird drive app (`integrations/money/moneybird/read.ts`) reads with
its own client, not syncables: `financial_accounts` in one answer, financial
mutations by its own period windows, and none of the other eleven lists in
the table's first row, so it is not affected. `tests/test_unpaged_lists.py` fails if a pinned document gains
a page parameter on one of these operations, if a catalogued Moneybird
pagination overlay starts to declare one, or if the catalogs' Discord list
stops asking for 200 guilds. No provider was called.

## Throttling with plan tiers

Three overlays declare [Throttling 0.5.0-draft](../openapi-extensions/spec/throttling/README.md#plan-tiers)
`tiers`: limits whose amount (or window) depends on the account's plan. A
consumer that is not told the plan keeps within every tier at once. No
dated catalog selects them. `tests/test_plan_tier_overlays.py` composes each
with its pinned OAD, checks the documented numbers and the limits without a plan, and
checks that each revision keeps its earlier one. No provider was called.

| Overlay | Tiers | Evidence |
| --- | --- | --- |
| [Asana throttling v2](APIs/asana.com/1.0/throttling-v2-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml) | v1 with the standard per-token limit as Free 150 and Paid 1,500 per minute (without a plan: both, so 150). | [Rate limits](https://developers.asana.com/docs/rate-limits), re-read 2026-10-13 |
| [Notion throttling v3](APIs/notion.com/2026-03-11/throttling-v3-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml) | v2's header and signals (`public_api_request_blocked` as `blocked`), plus the per-connection limit, a fixed 60-second window ("a fixed budget of requests per 60-second window" that resets): Business and Enterprise 600, all other plans 180 per minute (without a plan: both, so 180). The per-workspace limit has no number. | [Request limits](https://developers.notion.com/reference/request-limits) |
| [Clockify throttling](APIs/clockify.me/1.0.0-readonly/throttling-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml) | The first for Clockify: per workspace, "Newly created workspaces on the Free plan are restricted to 30 API requests per hour" and "Workspaces on any paid plan maintain the standard limit of 50 requests per second" (without a plan: both). Older Free workspaces, trials and any per-API-key limit are not documented and not declared; no signal or header. docs.clockify.me's Rate limiting section covers only the `X-Addon-Token` limit, which the catalog does not use. | [Webhook and API limitations](https://clockify.me/help/getting-started/webhook-and-api-limitations) |

## Directory layout and OAD revisions

Provider overlays mirror `openapi-directory` including its `APIs/` prefix:

```
openapi-directory/APIs/<provider>/<service-if-any>/<version>/openapi.yaml
overlays/APIs/<provider>/<service-if-any>/<version>/<kind>-<oad-commit>-overlay.yaml
```

Use `swagger.yaml` in `extends` where that is the OAD's actual filename.
`<oad-commit>` is the full 40-character SHA of the OAD's last change.
For example, Calendar's auth and pagination overlays for one OAD are:

```
APIs/googleapis.com/calendar/v3/auth-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml
APIs/googleapis.com/calendar/v3/app-pagination-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml
```

Several overlay kinds can target one OAD revision, and several OAD revisions
can coexist in that same folder. A new OAD revision gets new filenames;
retain the files for old revisions. Published revision files are immutable;
CI compares them with `origin/main`. To revise an overlay for an unchanged
OAD, give its kind a new version, e.g. `auth-v2-<oad-commit>-overlay.yaml`.
Adding a file never changes the catalog's existing selections: publish a new dated catalog explicitly when opting a platform into a new revision. `extends` identifies the original OAD
even when the overlay depends on earlier overlays in the catalog's ordered
composition. Calendar's `app-pagination` and `app-crud-causality` variants
preserve the drive app's scope alongside the broader `pagination` and
`crud-causality` overlays for that same document.

The 390 initial current-revision pins use the directory's `main` snapshot
`b285200684e2b0460faf8464c8822b4d2516e3c7` (2026-10-02).
The old provider paths were moved, so direct consumers must use the new
URLs; this repository's catalog and file references are updated together.
The Pets demo, docs, scripts and tests are outside `APIs/`: the demo is a
complete local OAD with no overlays, and the others are authoring resources.

Validate paths, filenames and catalog selections from the repository root:

```sh
python3 overlays/scripts/validate_oad_pins.py --published origin/main
python3 overlays/tests/test_oad_pins.py
```

Validate the commits against a full-history OAD checkout as well:

```sh
git -C /path/to/openapi-directory fetch --unshallow origin main # only if shallow
python3 overlays/scripts/validate_oad_pins.py --directory /path/to/openapi-directory
```

Add `--fetch-missing` to fetch historical pins absent from current upstream
`main` (historical Discord and Clockify revisions remain published). A
blobless clone (`git clone --filter=blob:none --no-checkout`, as CI makes)
is enough: the script fetches the pinned documents' blobs in batches.

The history check accepts old revisions but rejects a pin at a commit that
did not change the OAD. For an audit requiring every overlay to target the
latest OAD at a particular ref, add `--latest-ref origin/main`. That audit
will intentionally fail once historical and current revisions coexist.
These checks establish target provenance, not live-provider compatibility.

With `--directory`, the script also reads every pinned OAD and applies each
overlay the way the proxy's loader does (its `parse_target` grammar, a deep
merge of objects, every action an `update`): an action whose target does not
exist is an error, so the mismatch of
[#264](https://github.com/ontola/atomic-plugins/issues/264) cannot come
back. Overlays a dated catalog selects are applied in that catalog's order, so
a path an earlier overlay adds counts. Overlays no catalog selects are
composed per pin with their sibling overlays in whichever order resolves,
because a historical catalog's order is not recorded here (Clockify's
`dc7b2bdb` auth and pagination overlays target paths its `crud-causality`
sibling adds). A revision that a higher `-vN-` file of the same kind and pin
supersedes is not checked on its own, since it usually exists because the
old one does not compose; a catalog that still selects it is told. The
bunq.com 1.0, codat.io accounting 2.1.0 and sendgrid.com 1.0.0 documents did
not parse with libyaml (or the proxy's serde_yaml) until
ontola/openapi-directory#179 fixed them
([#307](https://github.com/ontola/atomic-plugins/issues/307)); their overlays
now have `pagination-dc4bd462cdef2a11865274027de251b5b1f3d854-overlay.yaml`
revisions at the fixed commit, which the script checks. No catalog selects
them. The old revisions stay published; the script warns that it cannot read
their pinned documents.

Overlays are applied in the order a catalog lists them, and an action
whose target does not exist yet fails the whole catalog load. Clockify's
`crud-causality-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml` is listed first because it defines the
projects/users paths its auth and pagination overlays target, and the
two setup reads the timesheets app makes (`GET /v1/user`, `GET
/v1/workspaces`); those stay in the read overlays. Its
`time-entry-write-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml` is listed last and carries its own
`security`, so removing that one line returns Clockify to read-only; it adds
create (`POST`), full-replacement update (`PUT`) and delete on time entries
for the timesheets app's two-way sync (ontola/atomic-plugins#123). Its
request shapes follow Clockify's published reference and are not verified
against a live account.

GitHub Issues' `repositories-read-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml` comes right after its
pagination overlay, whose `nextLink` scheme it names, and carries its own
`security`: it adds `GET /user/repos`, the issue-tracker drive app's
repository picker (ontola/atomic-plugins#147), as a plain read, not a
`crudResources` collection. The same app's two label writes, adding one
label to an issue (`POST .../issues/{issue_number}/labels`) and removing one
(`DELETE .../labels/{name}`), are in `crud-causality-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml` as partial
updates of `issue`; there is no endpoint that replaces or lists an issue's
labels. All three use the `repo` scope the GitHub OAuth app already asks
for, which covers issue labels and private repositories, so the requested
scope is unchanged. Their shapes follow GitHub's REST reference and are not
verified against a live account.

The `pets` platform (ontola/atomic-plugins#174) is different: there is no
third-party API behind it. `pets-demo/1.0.0/openapi.json` is its whole
document, authored here rather than pinned from `openapi-directory`, so it
has no overlays. Its server is
`https://ontola.github.io/atomic-plugins/overlays/pets-demo/1.0.0/api`, and
the one operation it declares, `GET /pets`, is the static file
`pets-demo/1.0.0/api/pets` (five synthetic pets, one page, no `Link`
header; Pages serves it as `application/octet-stream`). It declares
top-level `security: []` and no security scheme, which
`atomic-integration-proxy` 0.2.3 and later connect without a credential;
0.2.2 and earlier list the platform but refuse to connect it. The Pets drive app
bundles the same document (`integrations/pets/app/openapi.json`). A change
to either the document or the data is a change to what live users of the
demo read, so give it a new version folder rather than editing `1.0.0` in
place.

Checks:

- `.github/workflows/overlays-ci.yml` (PRs and pushes to main): all overlay paths, revision
  filenames and `extends` commits pass the full-history check, and every
  action target exists in its pinned OAD or in the catalog composition up to
  it; every catalog overlay URL, and
  every OAD URL under the Pages base, maps to a file in this folder, and
  every `tests/test_*.py` passes, discovered rather than listed; a test whose
  source declares a `"--directory"` option gets the openapi-directory clone
  (`tests/test_identity_overlays.py` also checks the pets
  demo's document and data). It reads the
  Pages-published sources from the checkout, so it validates a change before
  Pages serves it. Its `reads` job runs every `tests/*.test.ts` (syncables
  reads through the catalogs, with vitest from `syncables/`) when an overlay
  or syncables' source changes; the composer reads each pinned OAD from the
  same openapi-directory clone (`OPENAPI_DIRECTORY_REPO`). With that
  variable set, a pinned OAD the clone cannot show is an error naming the
  pin and the path, never a silent read from raw.githubusercontent.com
  (`scripts/pinned_oad.py`, used by `tests/compose_gitlab_platform.py`,
  `tests/test_asana_airtable_readonly.py` and
  `tests/test_google_tasks_readonly.py`); without it, the default clones
  next to this repository and then the network are tried, as before.
- `integration-proxy`'s `default_catalog_*` tests (PRs touching this folder):
  compose the selected dated catalog with the proxy's runtime loader, reading
  overlays from this folder. Its
  `swagger2_overlay_revisions_compose_without_components` test composes every
  Swagger 2.0 overlay here on its own, downloading the 21 pinned documents.
- `.github/workflows/overlays-published.yml` (after each Pages build): the
  served dated catalogs, every overlay and Pages-published OAD they list, and
  the pets demo's data match the built commit.

### What a completeness overlay is declared on

A Collection Completeness overlay is a claim about a collection's read as one
crud-causality revision defines it (its fixed query, its page size) and, for
some, as one pagination revision pages it. Selected with another revision the
same declaration can be wrong: Asana's tasks completeness assumes
crud-causality v2's `limit=100`, without which Asana truncates a list at about
1,000 objects. So a new completeness overlay states what it is declared on in
its `info`, as groups of revision filenames of its own pin, each group met by
selecting any one of its files:

```yaml
info:
  title: …
  version: 1.0.0
  x-requires:
    - anyOf: [crud-causality-v2-<pin>-overlay.yaml]
```

`x-requires` is a convention of this repository, not part of an
openapi-extensions specification: it names files by this folder's revision
filenames (`<kind>[-vN]-<pin>-overlay.yaml`) and is checked against this
repository's dated catalogs, so it means nothing to a consumer that composes
documents from elsewhere; a consumer may ignore it. Published completeness
overlays cannot change, so `tests/test_completeness_requirements.py` holds the
same groups for them in a table (and for those still in review when it was written). For every dated
catalog it checks that each completeness overlay it selects has every group
met, and that no other revision of a group's kinds is selected for that
platform; it also fails on a completeness overlay that states no
requirement either way.

## Reviewed standalone pagination overlays

The [2026-10-08 handoff](HANDOFF-2026-10-08.md) records the completed
50-additional-OAD milestone, pinned inventory, publication evidence and
remaining pagination gaps.

These overlays use explicit operation selections and locate the returned
item arrays through `response.envelope.itemsField`. Replacements use new
`pagination-v2` filenames for the same pinned OADs; first overlays for a new
OAD revision use `pagination`. Old files and dated catalog selections are
unchanged. Select a v2 file instead of its v1 variant when composing that
provider's document; the new services can be composed with their pinned OAD
directly.

| Variant | Declared coverage | Sources |
| --- | --- | --- |
| [Slack v2](APIs/slack.com/1.7.0/pagination-v2-4d66b23dc5948016b50e79b944a0b084c7000da7-overlay.yaml) | Four cursor reads: conversations list/members and users conversations/list. `channels` or `members` envelopes. | [Pagination](https://docs.slack.dev/apis/web-api/pagination/), [users.conversations](https://docs.slack.dev/reference/methods/users.conversations/) |
| [DigitalOcean v2](APIs/digitalocean.com/2.0/pagination-v2-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml) | 39 collections declaring a next link and item array in the pinned OAD. Includes droplets, projects, and repository listings. | [Links and pagination](https://docs.digitalocean.com/reference/api/reference/public-apis/) |
| [Notion v2](APIs/notion.com/2026-03-11/pagination-v2-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml) | Three list operations: POST search/data-source query and GET views. `results` envelopes, with distinct body and query cursor fields. | [Pagination](https://developers.notion.com/reference/intro#pagination), [Search](https://developers.notion.com/reference/post-search) |
| [Spotify v2](APIs/spotify.com/1.0.0/pagination-v2-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml) | 19 single-collection reads, including nested albums/artists/categories/playlists and top-level items. | [API calls](https://developer.spotify.com/documentation/web-api/concepts/api-calls), [Categories](https://developer.spotify.com/documentation/web-api/reference/get-categories), [Followed artists](https://developer.spotify.com/documentation/web-api/reference/get-followed), [Recently played](https://developer.spotify.com/documentation/web-api/reference/get-recently-played) |
| [Intercom](APIs/intercom.com/2.16/pagination-4a302a4352fcb52ab0735f4781376c28913d8028-overlay.yaml) | Eight cursor operations: five GET lists and POST contacts/conversations/tickets searches. Explicit `data`, `conversations`, `events` or `tickets` envelopes. | [Pagination](https://developers.intercom.com/docs/build-an-integration/learn-more/rest-apis/pagination), [2.16 changelog](https://developers.intercom.com/docs/references/changelog) |
| [Mailchimp](APIs/mailchimp.com/3.0.91/pagination-b6b0af39fa9d35f81fbea6b7962cc6dea857e889-overlay.yaml) | 56 GET collections with declared `count`, `offset`, `total_items` and a single item array. Includes lists/members, campaigns, reports and commerce. | [Pagination and partial responses](https://mailchimp.com/developer/marketing/docs/methods-parameters/#pagination), [Lists](https://mailchimp.com/developer/marketing/api/lists/get-lists-info/) |
| [HubSpot owners](APIs/hubspot.com/crm-owners/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | One owner collection at the pinned OAD's `/crm/owners/2026-03`, using `paging.next.after` and `results`. | [Owner pagination migration](https://developers.hubspot.com/changelog/sunset-v2-owners-api), [Pinned request and response schemas](https://raw.githubusercontent.com/ontola/openapi-directory/b5dcaabe7e10736356fd0dc73d45bd6fecd26370/APIs/hubspot.com/crm-owners/2026-03/openapi.yaml) |
| [Confluence v2](APIs/atlassian.com/confluence-v2/2.0.0/pagination-5e659825c92ed8d1284b63cdc84a94a0c51d7217-overlay.yaml) | 67 GET collections with declared cursor/limit, `Link` response header and `results` array, including pages, spaces, attachments, comments and tasks. | [Pagination](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/) |
| [Figma](APIs/figma.com/0.43.0/pagination-f9b511f8ad2a8c19004af2a38815ab808dd18a98-overlay.yaml) | 13 GET collections: versions, reactions, webhooks, three team libraries, six library analytics and daily AI usage. | [Team libraries](https://developers.figma.com/docs/rest-api/component-endpoints/), [Version history](https://developers.figma.com/docs/rest-api/version-history-endpoints/), [Library analytics](https://developers.figma.com/docs/rest-api/library-analytics-endpoints/), [AI usage](https://developers.figma.com/docs/rest-api/ai-usage-endpoints/) |
| [ClickUp v3](APIs/clickup.com/v3/version/pagination-88ea4994e816563201c2069526252475d77e853f-overlay.yaml) | Nine GET collections: channels, followers, members, messages, reactions, replies, tagged users, attachments and Docs. `data` or `docs` envelopes. | [Chat messages](https://developer.clickup.com/reference/getchatmessages), [Pinned OAD](https://raw.githubusercontent.com/ontola/openapi-directory/88ea4994e816563201c2069526252475d77e853f/APIs/clickup.com/v3/version/openapi.yaml) |
| [HubSpot Files](APIs/hubspot.com/files/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Two GET searches for files and folders. `results` envelope and `paging.next.after` cursor. | [Provider documentation](https://developers.hubspot.com/docs/api-reference/latest/files/files/search-files), [Pinned OAD](https://raw.githubusercontent.com/ontola/openapi-directory/b5dcaabe7e10736356fd0dc73d45bd6fecd26370/APIs/hubspot.com/files/2026-03/openapi.yaml) |
| [HubSpot HubDB](APIs/hubspot.com/hubdb/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Four GET collections: published/draft tables and published/draft table rows. `results` envelope and `paging.next.after` cursor. | [Provider documentation](https://developers.hubspot.com/docs/api-reference/latest/cms/hubdb/guide), [Pinned OAD](https://raw.githubusercontent.com/ontola/openapi-directory/b5dcaabe7e10736356fd0dc73d45bd6fecd26370/APIs/hubspot.com/hubdb/2026-03/openapi.yaml) |
| [HubSpot blog posts](APIs/hubspot.com/posts/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Two GET collections: posts and individual post revisions. `results` envelope and `paging.next.after` cursor. | [Provider documentation](https://developers.hubspot.com/docs/api-reference/latest/cms/blogs/posts/get-posts), [Pinned OAD](https://raw.githubusercontent.com/ontola/openapi-directory/b5dcaabe7e10736356fd0dc73d45bd6fecd26370/APIs/hubspot.com/posts/2026-03/openapi.yaml) |
| [HubSpot Conversations](APIs/hubspot.com/conversations/v3/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Five GET collections: channel accounts, channels, inboxes, threads and thread messages. `results` envelope and `paging.next.after` cursor. | [Provider documentation](https://developers.hubspot.com/docs/api-reference/legacy/conversations/guide), [Pinned OAD](https://raw.githubusercontent.com/ontola/openapi-directory/b5dcaabe7e10736356fd0dc73d45bd6fecd26370/APIs/hubspot.com/conversations/v3/openapi.yaml) |
| [HubSpot Lists](APIs/hubspot.com/lists/v3/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Two GET membership collections in record and join order. `results` envelope and `paging.next.after` cursor. | [Provider documentation](https://developers.hubspot.com/docs/api-reference/legacy/crm/lists/guide), [Pinned OAD](https://raw.githubusercontent.com/ontola/openapi-directory/b5dcaabe7e10736356fd0dc73d45bd6fecd26370/APIs/hubspot.com/lists/v3/openapi.yaml) |
| [Asana](APIs/asana.com/1.0/pagination-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml) | 64 ordinary GET collections using opaque `next_page.offset` and `data`. | [Pagination documentation](https://developers.asana.com/docs/pagination) |
| [Zendesk Support](APIs/zendesk.com/support/2.0.0/pagination-bd4e4a2d9aa77933be201b08f290ccc4fbdf6bc8-overlay.yaml) | 14 GET collections in offset mode, following `next_page` URLs. | [Pagination documentation](https://developer.zendesk.com/documentation/api-basics/pagination/paginating-through-lists-using-offset-pagination/) |
| [Square v2](APIs/squareup.com/2.0/pagination-v2-e15e761285c715a9035dee558ff40c8f3bd3f796-overlay.yaml) | 69 GET/read-POST collections with query, body or integer merchant cursors. | [Pagination documentation](https://developer.squareup.com/docs/build-basics/common-api-patterns/pagination) |
| [Zoom Meetings](APIs/zoom.us/meetings/2/pagination-a0a144cfdcb49bbfdc01459d6ca012dcf01307f1-overlay.yaml) | 29 GET collections using `next_page_token` and explicit item envelopes. | [Pagination documentation](https://developers.zoom.us/docs/api/meetings/) |
| [Mastodon](APIs/mastodon.local/1.0/pagination-d8048ab7bf03d49cfc766ce25e7b955f415d5d87-overlay.yaml) | Six GET relationship/saved-status collections. Documented `Link` headers and root arrays. | [Pagination documentation](https://docs.joinmastodon.org/api/guidelines/#paginating-through-api-responses) |
| [Google Drive v3](APIs/googleapis.com/drive/v3/pagination-v2-a7dd2d8b4f5f50794e51afd84c539c2e61a182fc-overlay.yaml) | Seven ordinary file/shared-drive collections, including comments, replies, labels, permissions and revisions. | [Provider documentation](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list) |
| [Gmail v1](APIs/googleapis.com/gmail/v1/pagination-f34c235dd04bee41b091108dd52c07d1415a54b9-overlay.yaml) | Five mailbox/CSE collections with operation-specific envelopes and page-size inputs. | [Provider documentation](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) |
| [Google People v1](APIs/googleapis.com/people/v1/pagination-091431739208d017c11b0b0589ab33293f8b3690-overlay.yaml) | Five full-list contact and directory collections; sync checkpoints remain separate. | [Provider documentation](https://developers.google.com/people/api/rest/v1/people.connections/list) |
| [Google Tasks v1](APIs/googleapis.com/tasks/v1/pagination-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml) | Task lists and tasks, preserving completion, hidden/deleted and date filters. | [Provider documentation](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list) |
| [Google Tasks v1 v2](APIs/googleapis.com/tasks/v1/pagination-v2-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml) | v1 plus [Pagination Schemes 0.7.0](../openapi-extensions/spec/pagination-schemes/README.md#442-envelope-object) `emptyWhenAbsent` on both envelopes: an empty list answered without `items` is a page with no items. Declared, not verified against a live empty list. | [tasks.list](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list), [ProtoJSON format](https://protobuf.dev/programming-guides/json/) |
| [YouTube v3](APIs/googleapis.com/youtube/v3/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml) | Six playlist, subscription, comment and search collections; comment ID batches and streams excluded. | [Provider documentation](https://developers.google.com/youtube/v3/docs/playlistItems/list) |
| [Google Cloud Storage v1](APIs/googleapis.com/storage/v1/pagination-f29c692c20956b05daf223ad8f641e9a9bd6dfb4-overlay.yaml) | Four bucket, flat-object, operation and HMAC-key collections; directory prefixes excluded. | [Provider documentation](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list) |
| [Box 2.0.0 v2](APIs/box.com/2.0.0/pagination-v2-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml) | 41 GET lists, each applied explicitly: 13 offset lists (`offset`, `limit`, `total_count`; folder items, trash and users too, whose marker paging needs `usemarker=true`) and 28 marker lists (`marker`, `next_marker`), all with the `entries` envelope. Replaces v1, whose `type: offset` and roles `currentOffset` and `pageTokenMode` the spec does not define. | [Offset-based](https://developer.box.com/guides/api-calls/pagination/offset-based), [Marker-based](https://developer.box.com/guides/api-calls/pagination/marker-based) |
| [Box 2.0.0 v3](APIs/box.com/2.0.0/pagination-v3-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml) | v2 plus [Pagination Schemes 0.7.0](../openapi-extensions/spec/pagination-schemes/README.md#432-offset-advance) `advance: pageSize` on the offset lists: the next offset adds the reported `limit`, and the list ends at `total_count`. | [Offset-based](https://developer.box.com/guides/api-calls/pagination/offset-based) |
| [Box 2026.0](APIs/box.com/2026.0/pagination-84d76796923210d5e972c22c22f834a061290fbd-overlay.yaml) | GET workflows and read-POST item query, with separate query/body markers and entries envelopes. | [Provider documentation](https://developer.box.com/guides/api-calls/pagination/marker-based) |
| [GitHub REST 2022-11-28](APIs/github.com/api.github.com.2022-11-28/1.1.4/pagination-7782419eb8c981c9dd28379e41a43ca3186f4758-overlay.yaml) | Eight issue, pull-request, comment, label, milestone and repository lists, using Link headers and root arrays. | [Provider documentation](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api) |
| [Twilio Conversations](APIs/twilio.com/twilio_conversations_v1/1.55.0/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml) | 22 GET collections, including conversations, messages, participants, services and users. | [Provider documentation](https://www.twilio.com/docs/conversations-classic/api/conversation-resource) |
| [Twilio Messaging](APIs/twilio.com/twilio_messaging_v1/1.55.0/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml) | Nine GET service/sender/compliance collections with explicit envelopes. | [Provider documentation](https://www.twilio.com/docs/messaging/api/service-resource) |
| [Clockify read-only v2](APIs/clockify.me/1.0.0-readonly/pagination-v2-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml) | One user time-entry list with 1-based page numbers and a root array. | [Provider documentation](https://docs.clockify.me/) |
| [Twilio Accounts](APIs/twilio.com/twilio_accounts_v1/1.55.0/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml) | Two GET credential collections: AWS and public keys. | [Provider documentation](https://www.twilio.com/docs/iam/credentialaws-resource) |
| [Twilio API 2010-04-01 v2](APIs/twilio.com/api/1.55.0/pagination-v2-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml) | All 61 GET collections whose pinned response declares `next_page_uri`, each with its one item array (`calls`, `messages`, `usage_records`, ...). `next_page_uri` is a relative reference, declared with [Pagination Schemes 0.4.0](../openapi-extensions/spec/pagination-schemes/README.md#443-link-resolution-object) `linkResolution: {base: server}`; a consumer without 0.4.0 support that resolves it against the request URL gets the same URL. Replaces the v1 file's three auto-detected schemes. | [List example](https://www.twilio.com/docs/usage/api/applications), [Paging fields](https://www.twilio.com/docs/usage/twilios-response) |
| [Google Chat v1](APIs/googleapis.com/chat/v1/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml) | Four space, membership, message and reaction collections. | [Provider documentation](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces/list) |
| [Google Classroom v1 (pagination v2)](APIs/googleapis.com/classroom/v1/pagination-v2-780ef441b8d6134229c8b8ef75eb3ec8a0218e7f-overlay.yaml) | 12 course, coursework, roster, invitation and guardian collections with exact envelopes. | [Provider documentation](https://developers.google.com/workspace/classroom/reference/rest/v1/courses/list) |
| [Google Calendar v3 (pagination v2)](APIs/googleapis.com/calendar/v3/pagination-v2-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml) | Five full-list collections; sync checkpoints and watch registration excluded. | [Provider documentation](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) |
| [Blogger v3](APIs/googleapis.com/blogger/v3/pagination-091431739208d017c11b0b0589ab33293f8b3690-overlay.yaml) | Five post, page and comment lists. | [Provider documentation](https://developers.google.com/blogger/docs/3.0/reference/posts/list) |
| [Google Drive Activity v2](APIs/googleapis.com/driveactivity/v2/pagination-2fd9a6a4cccac6dbc988c98fc12bf8b0732015f4-overlay.yaml) | Read-POST activity query with a body token; minimum desired pageSize is unannotated. | [Provider documentation](https://developers.google.com/workspace/drive/activity/v2/reference/rest/v2/activity/query) |
| [Google Forms v1 (pagination v2)](APIs/googleapis.com/forms/v1/pagination-v2-091431739208d017c11b0b0589ab33293f8b3690-overlay.yaml) | Form responses with stable form and filter scope. | [Provider documentation](https://developers.google.com/workspace/forms/api/reference/rest/v1/forms.responses/list) |
| [Google Keep v1](APIs/googleapis.com/keep/v1/pagination-091431739208d017c11b0b0589ab33293f8b3690-overlay.yaml) | Notes with opaque tokens; ABORTED is an error, not completion. | [Provider documentation](https://developers.google.com/workspace/keep/api/reference/rest/v1/notes/list) |
| [Google Books v1 (pagination v2)](APIs/googleapis.com/books/v1/pagination-v2-7418a665c934a78c5ef05e66a35d21d6dda87c62-overlay.yaml) | Two bookshelf-volume lists using 0-based startIndex offsets. | [Provider documentation](https://developers.google.com/books/docs/v1/reference/mylibrary/bookshelves/volumes/list) |
| [HubSpot Pages](APIs/hubspot.com/pages/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Six landing/site-page, folder and revision lists. | [Provider release specification](https://api.hubspot.com/public/api/spec/v2/specs/release/75337/version/2026-03) |
| [HubSpot URL Redirects](APIs/hubspot.com/url-redirects/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | URL redirects with forward cursors and archived/date filters. | [Provider release specification](https://api.hubspot.com/public/api/spec/v2/specs/release/75326/version/2026-03) |
| [HubSpot User Provisioning](APIs/hubspot.com/user-provisioning/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Account user list. | [Provider release specification](https://api.hubspot.com/public/api/spec/v2/specs/release/75360/version/2026-03) |
| [HubSpot Event Occurrences](APIs/hubspot.com/events/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Filtered event occurrences. | [Provider release specification](https://api.hubspot.com/public/api/spec/v2/specs/release/75357/version/2026-03) |
| [HubSpot Audit Logs](APIs/hubspot.com/audit-logs/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Audit, login and security history, with distinct schemas. | [Provider release specification](https://api.hubspot.com/public/api/spec/v2/specs/release/75272/version/2026-03) |
| [HubSpot Sequences](APIs/hubspot.com/sequences/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Sequence definitions, excluding enrollments. | [Provider release specification](https://api.hubspot.com/public/api/spec/v2/specs/release/75344/version/2026-03) |
| [HubSpot Marketing Emails](APIs/hubspot.com/marketing-emails/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Email and email-revision lists, excluding unpaged histograms. | [Provider release specification](https://api.hubspot.com/public/api/spec/v2/specs/release/75322/version/2026-03) |
| [HubSpot Multicurrency](APIs/hubspot.com/multicurrency/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Configured exchange-rate list. | [Provider release specification](https://api.hubspot.com/public/api/spec/v2/specs/release/75365/version/2026-03) |
| [HubSpot Marketing Events](APIs/hubspot.com/marketing-events/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Four event and participation lists; missing-input operations excluded. | [Provider release specification](https://api.hubspot.com/public/api/spec/v2/specs/release/75335/version/2026-03) |
| [HubSpot Campaigns](APIs/hubspot.com/campaigns-public-api/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Campaigns and contact reports; string-limit assets excluded. | [Provider release specification](https://api.hubspot.com/public/api/spec/v2/specs/release/75325/version/2026-03) |
| [HubSpot Custom Objects](APIs/hubspot.com/custom-objects/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Generic CRM object list, preserving properties/history and associations; search POST excluded. | [Provider release specification](https://api.hubspot.com/public/api/spec/v2/specs/release/75278/version/2026-03) |
| [HubSpot Imports](APIs/hubspot.com/imports/2026-03/pagination-b5dcaabe7e10736356fd0dc73d45bd6fecd26370-overlay.yaml) | Import history and import errors. | [Provider release specification](https://api.hubspot.com/public/api/spec/v2/specs/release/75332/version/2026-03) |
| [Google Admin Directory](APIs/googleapis.com/admin/directory_v1/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml) | 13 directory, device, resource, role, group, user and printer lists. | [Provider documentation](https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/list) |
| [Google Admin Reports](APIs/googleapis.com/admin/reports_v1/pagination-5e5d2369ea3e91b9b09193dd9928f628612369d3-overlay.yaml) | Four audit/usage reports with warnings separate from items. | [Provider documentation](https://developers.google.com/workspace/admin/reports/reference/rest/v1/customerUsageReports/get) |
| [Google Vault](APIs/googleapis.com/vault/v1/pagination-98a453ea8cce0b5723f2f95d376720c304632d23-overlay.yaml) | Four matter, export, hold and saved-query metadata lists. | [Provider documentation](https://developers.google.com/workspace/vault/reference/rest/v1/matters/list) |
| [Google Drive Labels v2 (pagination v2)](APIs/googleapis.com/drivelabels/v2/pagination-v2-98a453ea8cce0b5723f2f95d376720c304632d23-overlay.yaml) | Labels, revision locks and permissions. | [Provider documentation](https://developers.google.com/workspace/drive/labels/reference/rest/v2/labels/list) |
| [Google Business Profile Information v1 (pagination v2)](APIs/googleapis.com/mybusinessbusinessinformation/v1/pagination-v2-a68633bd9b84af444f424d6a03f24450b84129ef-overlay.yaml) | Locations with required readMask, plus category and attribute metadata. | [Provider documentation](https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list) |

Slack's overlay declares `response_metadata.next_cursor` as the continuation
field and documents that a short page can still have another cursor. It does
not impose a shared numeric limit on all methods. The pinned `users.list`
OAD references `objs_response_metadata`, which puts its object fields under
`items`; the overlay repairs only that operation's metadata reference using a
new object schema following Slack's pagination documentation. History/replies,
classic paging and other undeclared response shapes are outside this variant.

DigitalOcean's overlay follows the complete `links.pages.next` URL, preserving
its query parameters, including repository `page_token` values. It does not
infer a next page from `page`/`per_page` alone: the pinned individual volume
action read has those parameters but no collection envelope or next link.
Garbage-collection listings likewise have no declared next link in this OAD
and remain outside this variant. The 39 selected operations have their item
arrays and continuation fields checked against the pinned response schemas.

Notion's variant locates every list under `results`. Its two POST operations
use a new optional request-body schema declaring `start_cursor` and an integer
`page_size` from 1 to 100. The existing generic JSON object is retained through
`allOf`, so filters, sorts and other body members remain permitted. GET views
keeps its existing query parameters. Page creation and individual reads are
outside the pagination selection.

Spotify's variant follows returned `next` URLs for both offset and cursor
collections. Separate schemes locate `items`, `albums.items`, `artists.items`,
`categories.items` and `playlists.items`, with matching continuation fields.
Nested schemes do not inherit nonexistent root `next` fields. The pinned
`PagedCategories` response lacks an item array; a local specialization adds
the documented `CategoryObject` array without changing the shared
`PagingObject` schema. Search is excluded because its response can contain
seven independently paged collections; recommendations have no next link.
The variant targets the pinned 2022-11-15 OAD, and current Spotify access modes
and deprecated endpoints still need separate live evidence.

Intercom separates query cursors from the search body's nested
`pagination.starting_after` and `pagination.per_page` fields. Both schemes
read `pages.next.starting_after` and stop when the next cursor is absent.
The pinned contacts GET omits pagination query parameters, so it is excluded;
company reads and activity-log searches have different request shapes.
No request/response schema repair is made in this overlay.

Mailchimp uses zero-based offsets and `total_items`, rather than a next URL.
The item envelope varies by collection. Keep that array and `total_items`
when using `fields` or `exclude_fields`; filtering these out prevents correct
traversal. Mailchimp's original OAD fails standard OpenAPI validation because
it declares a boolean default for a string field (`notify_on_subscribe`).
The regression checks the unchanged source error and preserves its entire
standard contract; the overlay adds only pagination metadata. The audience
contacts endpoint uses a cursor and is excluded; activity-feed lacks a total count, and landing pages lacks an offset. A single
abuse-report read declares count/offset but has no item array and is excluded.
HubSpot owner reads keep their email and archived filters when returning the
opaque `paging.next.after` token as `after`. The individual owner read is
outside the selection; the overlay preserves the OAD's versioned path.

Confluence v2 follows `rel="next"` in the declared `Link` response header,
with the top-level `results` envelope. Those RFC 8288 targets can be relative;
consumers must resolve them against the request URL, as syncables does. The
body's `_links.next` is also relative and is not duplicated as a second
continuation source. Individual pages with nested included collections and
ancestor reads without a declared `Link` header are excluded.

Figma uses different schemes for numeric `meta.cursor.after` tokens in team
libraries, string cursors in analytics and AI usage, and `pagination.next_page`
URLs in versions, reactions and webhooks. Numeric tokens remain opaque and
are returned through `after`; backward `before` pagination is not selected.
Analytics responses declare their cursor absent when `next_page` is false.
Their `rows` arrays can be selected by `oneOf`; the regression checks every
declared alternative. Activity logs omit a cursor request parameter in the
pinned OAD, so that endpoint remains outside the selection.

ClickUp v3 returns `next_cursor` through the `cursor` query parameter, keeping
filters and content-format settings. Docs uses `docs`; the other eight
collections use `data`. The deprecated Docs request parameter `next_cursor`
is not selected. ClickUp v2 task reads start `page` at zero and use a
`last_page` flag, while comment pagination derives two continuation values
from the last item. Neither is described by this v3 cursor overlay.

HubSpot Files, HubDB, blog posts, Conversations and Lists retain their exact
pinned paths, filters and response schemas, even where the provider's current
documentation describes a later API date. Forward traversal sends the opaque
`paging.next.after` value through `after` and uses the `results` envelope.
Only operations declaring `total` receive total-count metadata; Files and
thread/message reads do not. HubDB row reads also accept `offset`, but this
scheme uses their declared forward cursor rather than combining both modes.
The HubDB source references a missing `HubDbTableRowV3Wrapper` item schema
in two collection schemas. The regression checks that exact source validation
failure before and after composition; this overlay preserves the contract
and adds no substitute item schema.
Thread cursors apply to default ID ordering or `sort=id`; timestamp ordering
requires `latestMessageTimestampAfter` and is outside this scheme. Provider
documentation also limits thread filtering to one inbox ID; the overlay
preserves the original OAD's parameter schemas.

List search is a POST with `hasMore` and a returned integer offset, rather
than the membership cursor scheme. Six blog author/post/tag cursor endpoints
have empty response-property maps in the pinned OAD and remain unselected.
The blog post collections declare their JSON-shaped response under `*/*`;
tests read that original media key without replacing it or modifying schemas.
Individual reads, batch reads and writes stay outside these selections.

Asana requires `limit` to enable ordinary pagination; its `offset` is an
opaque token, not an item count. The overlay marks that pagination request
field required without changing the OAD's parameter contract. It preserves
filters and `opt_fields`, and stops on null `next_page`. Audit logs are
excluded: that stream can keep returning a token even with no matching data.

Zendesk selects offset-mode reads with declared `page` or `per_page` fields
and a next-page URL. It follows that URL instead of calculating a page number.
Activities uses `activities`, not the sideloaded `actors` or `users` arrays.
Cursor-mode routes, incremental exports and batch show-many routes are outside
this variant. The provider limits offset traversal to the first 10,000 records;
larger collections need a separately reviewed cursor/export variant.

Square separates query cursors on GET from body cursors on read/search POST,
preserving all search filters. Page size is added only where the pinned request
declares `limit`. Merchant cursors are integers in both directions and remain
opaque; the overlay never increments them. Catalog searches page `objects` or
`items` rather than related objects or variation IDs; event searches page
`events` rather than associated metadata. Order search is excluded because
`return_entries` chooses between `orders` and `order_entries`. Errors are never
the paged item array. Square documents a five-minute cursor lifetime.
The pinned source omits `AppFeeAllocation` and `CurrencyExchange` payment
schemas, leaving five dangling references. Tests assert their exact locations
and the unchanged source validation failure. This pagination overlay adds no
substitute payment schema.

Zoom Meetings uses opaque tokens with operation-specific envelopes. It does
not select deprecated `page_number` pagination, individual archive files, or
writes. Tokens expire after 15 minutes; filters and date ranges must remain
fixed. The archive-files API can normalize a future `to` to the current time,
and callers must reuse that returned effective date. This extension has no
role for copying a non-pagination response filter into the next request, so
the overlay records that caller requirement explicitly.

Mastodon's selected response bodies remain root arrays. Its pinned OAD omits
response headers, so the overlay adds only the documented string `Link` header
to followers, following, blocks, mutes, bookmarks and favourites. Follow the
RFC 8288 next relation; private relationship IDs can differ from visible
account or status IDs. Unpaged batch reads, directory offsets and instance
peer reads are excluded. Server selection and dynamic OAuth registration
remain separate from this pagination metadata.

The six Google variants use opaque `nextPageToken` values as `pageToken`,
with `pageSize` or `maxResults` only as declared on that operation. A short
or empty page is not terminal while a token remains. Keep filters, masks,
ordering, resource selection and page size fixed. When using `fields`, include
both the continuation and the selected item envelope. No estimated count is
used as a pagination total or terminal condition.

Drive v3 selects files, shared drives, comments, replies, labels, permissions
and revisions; its deprecated Team Drives, change feed and watch registration
are excluded. Comments and replies require a `fields` query. For example,
`fields=nextPageToken,comments(id,content)` preserves pagination metadata.
`incompleteSearch` means the corpus search was incomplete; finishing its pages
must not be presented as a complete corpus listing. The old Drive variant
stays published; select this `pagination-v2` file explicitly.

Gmail selects drafts, messages, threads and client-side-encryption identity/key
pair lists. Their page-size names and item envelopes differ. Mailbox listings
contain identifiers rather than complete message bodies, and
`resultSizeEstimate` remains an estimate. History and watch are outside this
ordinary collection variant.

People selects full contact-group, other-contact, directory-list,
directory-search and connection listings. Omit `syncToken` for these
applications and retain `readMask`/`personFields` and source choices across
pages. `nextSyncToken` belongs to a later incremental sync; it is never used
as a page continuation. Tasks keeps each caller's existing completion,
hidden/deleted and date filters; paging does not make a filtered list complete
for all tasks.

YouTube selects playlists, playlist items, subscriptions, comment threads,
comment replies and search. Comment replies require `parentId`, and comment
threads require `videoId` or `allThreadsRelatedToChannelId`: the provider
rejects pagination with their `id` batch mode. Live-chat/member-update streams
and other list modes remain excluded. Follow the forward token only; search's
`pageInfo.totalResults` is approximate and does not control traversal.

Cloud Storage selects buckets, objects, long-running operations and HMAC-key
lists. The object application requires flat mode: omit `delimiter` and
`includeFoldersAsPrefixes`; `prefixes` is a separate directory-mode collection.
Folder and managed-folder methods remain unselected because their current
[folder](https://docs.cloud.google.com/storage/docs/json_api/v1/folders/list)
and [managed-folder](https://docs.cloud.google.com/storage/docs/json_api/v1/managedFolder/list)
docs name `maxResults`, while the pinned OAD declares `pageSize`.
[Cache-list docs](https://docs.cloud.google.com/storage/docs/json_api/v1/AnywhereCaches/list)
omit the pagination inputs present in the pin, so that method also needs a
separate review. Tokens preserve an ordering position, not a snapshot of
concurrent changes.

Box 2026.0 selects the beta Automate workflow list and the read-only item-query
POST. Query markers and page sizes belong in the JSON body for `/query` and
in query parameters for `/automate_workflows`; both page `entries` using the
opaque `next_marker`. Preserve the required `box-version` header and every
query predicate, parameter, sort key and requested field. The workflow list
is unavailable on free developer accounts. Workflow starts, note conversion
and aggregated insights are excluded. Endpoint contracts were checked against
[Box's exact vendor specification](https://raw.githubusercontent.com/box/box-openapi/5b055e333a802b10b8ca90fcc513643836dd92b4/openapi/openapi-v2026.0.json)
as well as its marker-pagination guide; the public endpoint-reference pages
were unavailable during review.

GitHub's eight selected collections retain their declared `Link` response
headers and root arrays. Follow only the next relation with unchanged filters,
ordering and page size; keep `X-GitHub-Api-Version: 2022-11-28` for this pinned
version. Issues can include pull requests; pagination does not filter them out.
Search has a different envelope and remains unselected, along with single
reads and writes.

The three Twilio service OADs select GET collections only. Conversations,
Messaging and Accounts follow the full URL in `meta.next_page_url`.
Each operation declares its own item envelope. Preserve the returned page link
and filters rather than constructing `PageToken` or incrementing `Page`.
A null/empty/absent next link ends traversal; `meta.url`, first-page and
previous-page links do not advance it. Page size is the declared `PageSize`,
not an SDK's client-side `limit`. Individual reads, resource creation and
updates stay outside the variants. The classic API's relative `next_page_uri`
is excluded from this reviewed batch: the extension requires a full URL for
`nextLink`.

Clockify's new revision selects only the user time-entry list in its read-only
OAD. It retains the declared page/page-size defaults (1 and 50), root array,
workspace/user scope and start/end filters. Its older overlay also targets
projects and users, which this OAD does not declare; that published file remains
immutable. Select the new `pagination-v2` explicitly. The new variant adds no
response envelope, totals, completion header or authentication scheme. Empty
pages end traversal; concurrent edits can shift page contents.

Google Chat, Classroom, Blogger, Forms and Keep copy opaque `nextPageToken`
values into `pageToken`, preserving resource scope, filters and ordering. Keep
requires either consistent results through concurrent changes or an `ABORTED`
error; an error must not count as a completed traversal. Forms preserves the
same form and filter across pages. Classroom's `courseWorkMaterial` and `topic`
arrays retain their singular field names. Partial or empty pages with a token
still have a continuation.

Calendar's new revision selects five full listings, with `syncToken` omitted.
It pages `items`, leaving ancillary `defaultReminders` and `nextSyncToken`
checkpoints outside traversal. Event filters, recurrence expansion and deleted
selection stay caller-controlled; watch POSTs are unselected. Drive Activity's
read-POST keeps its token in the JSON body and preserves filter and consolidation
settings. Its `pageSize` requests a minimum desired activity count, so the
maximum-size role does not apply to that field.

Books selects the two bookshelf-volume lists, using `startIndex` from zero and
a positive `maxResults`. It leaves volume search and less documented annotation,
onboarding and upload lists unselected; `totalItems` is not a traversal bound.
Its ordinary offset traversal does not guarantee a snapshot through concurrent
changes. Existing Calendar, Classroom, Forms and Books revisions remain
published; select the new `pagination-v2` files explicitly.

The twelve additional HubSpot 2026-03 service OADs copy `paging.next.after`
into the query's `after`, page `results`, and preserve `limit` and all other
filters. They cover content/revisions, redirects, user provisioning, event
occurrences, audit/login/security history, sequence definitions, marketing
email/event/campaign lists, configured exchange rates, CRM objects and imports.
They do not use backward `before` cursors or derive tokens from `paging.next.link`.
The exact release specifications from HubSpot's public API catalog were checked
alongside the pinned OADs. Object search POST, unpaged email histograms,
marketing-event association/identifier operations without paging inputs and the
campaign-assets endpoint's string-valued limit remain unselected.

Google Directory preserves customer/domain, masks, sorting, deleted selection
and derived membership scope. Its users application omits subscription `event`
and documents that tokens expire after three days. Reports pages `usageReports`
for usage operations and `items` for activity, keeping `warnings` outside the
item envelope; callers must still inspect warnings. The customer usage request
has no page-size field, so the overlay adds none. Vault selects only four
resource-metadata lists, leaving operation polling and export downloads outside
the scope. Drive Labels preserves language, revision, published/draft and access
selection. Business Profile's location application retains required `readMask`;
category and attribute metadata use separate envelopes. Existing Drive Labels
and Business Profile revisions remain published.

These are documentation and composition checks as of 2026-10-02 (Slack,
DigitalOcean, Notion and Spotify), 2026-10-05 (Intercom, Mailchimp and HubSpot),
and 2026-10-06 (Confluence, Figma, ClickUp, the five additional HubSpot OADs,
Asana, Zendesk, Square, Zoom, Mastodon and the six Google OADs), and 2026-10-08
(Box, GitHub, three Twilio OADs, Clockify, eight additional Google OADs, twelve
additional HubSpot OADs and five Google administration/business OADs),
not live provider certification.
The metadata follows the
[pagination extension](../openapi-extensions/spec/pagination-schemes/README.md).
Run the schema and scope regressions without provider credentials:

```sh
python3 overlays/tests/test_pagination_collection.py --directory /path/to/openapi-directory
```

Omit `--directory` to download the 57 pinned OADs. CI uses the same full-history
checkout as the pin validator. Every declared query or body field must exist, every
continuation field must be declared, and each envelope must locate an array;
the tests also preserve unrelated request parameters, operations and security.
Nested request body fields are checked segment by segment. Use the pinned
`requirements-identity-tests.txt` dependencies: openapi-spec-validator 0.7.2
fixes the older validator's rejection of required properties defined inside
`oneOf`, as used by Intercom's data-attribute schema.
Notion body-schema cases check optional first-page requests, preserved extra
fields, page-size bounds, and opaque cursor types.

## Stripe pagination v2: a cursor from the last item

[`pagination-v2-dec74da7…`](APIs/stripe.com/2022-11-15/pagination-v2-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml)
declares [Pagination Schemes 0.9.0](../openapi-extensions/spec/pagination-schemes/README.md)
`fromLastItem` under rule (a) of §4.3.3: Stripe's
[pagination reference](https://docs.stripe.com/api/pagination), read on
2026-10-14, says every v1
list method takes `starting_after`, "an object ID that defines your place in
the list" (receive objects "ending with `obj_foo`" and send
`starting_after=obj_foo`), and that `has_more` false means "this set
comprises the end of the list". That live page documents a newer Stripe API
version than the pinned 2022-11-15 document, so it is evidence only where the
pinned document agrees: its own `starting_after` descriptions carry the same
"defines your place in the list" text, and its list responses have `data`
and `has_more`. Objects come newest first; rule (a) needs no ascending
order. v1 declared the `cursor` scheme but applied it to no
operation and had no way to find the next cursor; v2 redefines it
(`starting_after` from the last item's `id`, items in `data`, `has_more` as
`hasMore`) and applies it to all 99 list operations of the pinned document
that take `starting_after`. 97 of them describe it in the words above;
exchange rates say "the currency that defines your place in the list" (an
exchange rate's id is its currency code); treasury financial accounts say
only "An object ID cursor for use in pagination", covered by the reference
page's statement about all list methods. Not declared: `ending_before` (it
pages backwards) and the `/v2` APIs. It needs a 0.9.0 reader. Of the
catalog and overlay platforms, Stripe is the only one whose docs describe a
rule (a) cursor; Discord's two lists use rule (b) (#590). No dated catalog
selects it. `tests/test_stripe_pagination_v2.py` validates it, checks the
operation set and the pinned wording, and reads synthetic pages with the
reference `read_item_cursor`. No provider was called.

## Swagger 2.0 documents

The 2026-10-02 collection audit behind
[#264](https://github.com/ontola/atomic-plugins/issues/264) found 21
overlays, for 18 providers, pinned to a `swagger.yaml` whose first action
targets `$.components`. A Swagger 2.0 document has `definitions`,
`parameters`, `responses` and `securityDefinitions` but no `components`, so
the proxy's strict `merge_at_target` refused the whole composition
(`overlay target "$.components" does not exist`). `openapi-directory`'s
`main` holds only `swagger.yaml` in those 18 folders, so there is no
OpenAPI 3 document to re-pin to. Each of the 21 has a new
`<kind>-v2-<oad-commit>-overlay.yaml` revision for the same pin that targets
`$` and adds the map as a root vendor extension instead: `x-paginationSchemes`
for the 18 pagination overlays, `x-crudResources` for the adafruit.com,
cenit.io and getsandbox.com CRUD overlays. Swagger 2.0 allows `x-` members on
its root object, while `definitions` may hold only Schema Objects, so neither
map can go there. The operation-level actions (`x-pagination` and `x-crud`
on `$.paths[...]`) are unchanged, and their paths exist in the pinned
documents. The old files stay published and unchanged, and nothing selects
them: a `-v2-` revision supersedes its `-v1` for the validator above.

The same check found four overlays pinned to OpenAPI 3 documents that have
no `components` member at all (bikewise.org v2, braze.com 1.0.0,
hetzner.cloud 1.0.0 and notion.com 1.0.0, the latter a historical pin).
Their `-v2-` revisions target `$` and add `components.paginationSchemes`
from the root, which is ordinary OpenAPI 3.

What this establishes: the 25 revisions compose with the proxy's loader,
checked against the pinned documents by the validator and, for the 21
Swagger 2.0 ones, by integration-proxy's
`swagger2_overlay_revisions_compose_without_components` test. What it does
not: no dated catalog selects any of these 22 providers, so no catalog
changed, and no runtime here reads a Swagger 2.0 document yet. The proxy
resolves requests through `servers`, which Swagger 2.0 lacks (`host`,
`basePath`, `schemes`), and syncables and reflector read
`components.paginationSchemes` and `components.crudResources`, not the root
vendor extensions. Selecting one of these providers needs that support
first; the placement is a documented convention (noted in
`openapi-extensions/spec/pagination-schemes/` and `crud-causality/`), not a
verified capability.

## Authenticated principal overlays

The Google Calendar and GitHub Issues identity overlays add a current-principal
operation without making it a collection or assigning CRUD metadata. The
catalog is the trusted identity selection and associates it with its ordinary
OAuth scheme. Google uses either `googleOnline` or `googleOffline`; GitHub
uses `githubOAuth`. Before rollout, an operator upgrading an existing
Google-login deployment explicitly sets
`APP_AUTH_IDENTITY_NAMESPACE=https://accounts.google.com` to retain the prior
tenant mapping. This is operator-only configuration; there is no default and
callers cannot choose an identity namespace.

For example, the Google Calendar catalog entry selects:

```json
{
  "oauthSecurityScheme": "googleOffline",
  "tenantIdentity": {
    "operationId": "getGoogleAuthenticatedPrincipal",
    "namespace": "https://accounts.google.com"
  }
}
```

GitHub uses `githubOAuth`, `getGitHubAuthenticatedPrincipal`, and
`https://github.com`. Merely adding the extension to an OpenAPI document does
not enable tenant login; the trusted catalog must select the operation.

Google's overlay is applied after its auth overlay because it adds `openid`,
`email`, and `profile` to both `googleOnline` and `googleOffline`. GitHub's
overlay is also applied after `auth-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml`, which declares `githubOAuth`.
The overlays only describe the provider endpoints and response metadata; the
runtime supplies its normal User-Agent header and bearer token.

The Google declaration follows its [OpenID Connect discovery and UserInfo
reference](https://developers.google.com/identity/openid-connect/reference).
The GitHub declaration follows the [authenticated-user endpoint](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)
and GitHub's [durable numeric-ID guidance](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app).

Validate the full catalog compositions, from this folder, with
`python tests/test_identity_overlays.py` after installing
`requirements-identity-tests.txt`. Generate proxy regression fixtures with
`python tests/generate_identity_catalog_fixtures.py --output <fixture-directory>`;
the generated `sources.json` records the source URLs and content hashes.
Both read overlays under the Pages URL from this checkout and download only
the pinned OADs.

## GitLab read-only candidate

The 2026-10-08 GitLab candidate uses a read-only OAD subset pinned to the
official GitLab OpenAPI source. It exposes four GET operations: project list
and item reads, project issue list and issue item reads. Its authentication
overlay defines a `gitlabReadOnly` OAuth profile with the `read_api` scope;
the selected catalog profile limits proxy access to those operations. The
pagination overlay follows GitLab's RFC 8288 `Link rel=next` URL and adds the
response header schema omitted by the source OAD. CRUD metadata maps project
IDs into nested issue collections. `membership=true` lives in the catalog's
query override, not the shared CRUD description. No rate quota is declared.
The composition and runtime checks are documented in
[GitLab read-only provenance](tests/GITLAB_READONLY_PROVENANCE.md) and
[RUNTIME_VALIDATION.md](tests/RUNTIME_VALIDATION.md). The candidate dated
catalog selects these overlays; no existing published catalog changes.

## GitLab and Google Tasks onboarding candidates

`catalog/2026-10-08-gitlab.json` preserves the eleven production entries from
the Asana/Airtable catalog and adds the four-GET GitLab v4 subset.
`catalog/2026-10-08-gitlab-tasks.json` additionally selects Google Tasks'
`googleTasksReadOnly` authentication profile. Unlike the earlier Tasks
catalog, this profile permits only task-list listing, task listing and a
single-task read; it refuses writes at the proxy as well as requesting
`https://www.googleapis.com/auth/tasks.readonly` from Google. Its new CRUD
metadata lets the generic importer walk task lists into their task collections.

These catalogs are prepared deployment choices. Publishing them does not
register OAuth clients or activate them on localthought.io. Register the
corresponding clients and exact callbacks, configure their provider-specific
Heroku credentials, then explicitly select the appropriate dated catalog.
Google Cloud consent audience, testing and verification remain registration
requirements; this metadata makes no public-distribution claim.

Validation includes all-catalog composition, immutable revision/target checks,
actual two-page Syncables imports for each new platform and both profiles in
the proxy parser. The Google Tasks importer fixture is
`tests/google_tasks_syncables.test.ts`; its composition checks are
`tests/test_google_tasks_readonly.py`. Real-account sync is not certified.

## Google Tasks deployment without GitLab

`catalog/2026-10-08-google-tasks.json` preserves all eleven production entries
and selects the same read-only Google Tasks entry as the combined GitLab/Tasks
catalog. This twelve-entry option allows Tasks deployment independently when
its OAuth client is ready and GitLab registration is still pending. It changes
no existing pins or API metadata and does not activate itself.

## Box onboarding catalogs

`catalog/2026-10-11-box.json` preserves all twelve entries from the Google Tasks
deployment catalog and adds Box 2.0.0 with its existing revision-pinned
pagination overlay and `OAuth2Security` scheme. The combined
`catalog/2026-10-11-gitlab-box.json` additionally preserves the GitLab entry
from its published onboarding catalog. These options let either registration
finish first without dropping an existing platform or changing its pins.

Box's selected document describes the full API, including write operations;
it is not a read-only authentication profile. Its OAuth scope list is empty.
Box's [authorization reference](https://developer.box.com/reference/get-authorize)
documents that an omitted scope parameter defaults to the permissions
configured on the application. The current proxy sends an empty `scope`
parameter for this document; verify that behavior against the registered
client before activation. Configure the Local Thought application for
the minimum useful read permissions and register the exact callback
`https://localthought.io/oauth/box/callback`. Provider permissions must enforce
that limit; this catalog does not restrict the proxy to GET requests.

Publishing these catalogs does not create a Box account or OAuth client,
configure `OAUTH_BOX_CLIENT_ID` / `OAUTH_BOX_CLIENT_SECRET`, or switch
localthought.io. Client authentication and the document's default PKCE
behavior still require registration and live verification before activation.
Catalog composition and credential-scheme resolution do not certify a
real-account OAuth grant, API read, or complete import.

`catalog/2026-10-12-box-pagination-v2.json` is `catalog/2026-10-11-gitlab-box.json`
with Box's v1 pagination overlay replaced by
[v2](APIs/box.com/2.0.0/pagination-v2-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml);
every other entry is unchanged. The v1 composition fails the Pagination
Schemes validator (`type: offset`, roles `currentOffset` and
`pageTokenMode`). v1 applies its schemes by auto-detection only, and
syncables leaves an invalid scheme out of auto-detection, so a syncables
reader reads each Box list as one page and takes it as the whole list; v2
applies its schemes explicitly and uses `pageNumber` with the `offset` role and
`pageToken` with `cursor`/`nextCursor`. Box documents a maximum `offset` of
9999, so an offset list longer than 10,000 entries ends with an error
rather than early. Box also documents the next offset as
`previous_offset + previous_limit`, "and not by the size of the entries in
the response array, as this may be less than the limit", while syncables
(0.21.0 and 0.22.0) advances by the entries returned and stops at the
first empty page. So with syncables, an offset list whose page holds fewer
entries than the limit before its end is read again from inside that page
(the repeated entries fail the read: a collection read, and from syncables 0.22.0 any offset read), and an empty page before
`total_count` ends the read as if complete, missing the entries after it
without an error. Whether Box answers such pages is not verified. The
marker lists do not have this risk. `GET /files/{file_id}/collaborations`
is read by marker, as Box's reference says, although the pinned response
schema shows offset fields; if Box answered it with offset fields and no
`next_marker`, the read would end after one page and look complete. `tests/test_box_pagination_v2.py` checks the catalog
against its base, and validates v2 and the Box platform composed from the
catalog. Declared from Box's documentation and the pinned OAD; no Box
request was made.

A standalone [throttling overlay](APIs/box.com/2.0.0/throttling-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml)
declares Box's documented [rate limits](https://developer.box.com/guides/api-calls/permissions-and-errors/rate-limits)
(Throttling 0.2.0-draft or later, `limits` and `headers`): 1000 requests per
minute per user on every operation, plus 240 per minute per user on the two
direct uploads, 6 per second and 60 per minute per user and 12 per second per
enterprise on search, and Box Sign's 100 (create, resend) and 1000 (get, and
also the list) per minute per user; and the `retry-after` header in seconds.
Box does not say whether upload, search and Sign requests also count against
the general 1000 per minute; keeping that bucket on them is the conservative
choice, not a documented one, and makes the Sign read bucket duplicate it.
No dated catalog selects the overlay. `tests/test_box_throttling.py` composes
it with its pinned OAD, in either order with each Box pagination overlay a
dated catalog selects (v3 in the newest, `catalog/2026-10-12-tasks-box-pages.json`;
v2 and v1 in older ones), checks the buckets and their operations, and classifies
a synthetic `429`. No provider was called.
