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
old one does not compose; a catalog that still selects it is told. Three
pinned OADs do not parse with libyaml ([#307](https://github.com/ontola/atomic-plugins/issues/307)):
bunq.com 1.0 at `dec74da7` has two U+2028 (line separator) characters inside
a block scalar on line 1141, which libyaml
treats as YAML 1.1 line breaks, so the text after them is dedented out of the scalar
("did not find expected key", libyaml line 1143); codat.io accounting 2.1.0
at `41b90944` has a line holding only a tab inside two `|-` block scalars
(lines 43982 and 44484); sendgrid.com 1.0.0 at `bdea260b` has raw C1
control characters (U+0090, U+0091, U+009C, U+009F) in three example `city`
strings (lines 13002, 13169 and 27059). The proxy's serde_yaml 0.9.34
(unsafe-libyaml) refuses all three with the same errors, so the proxy cannot
load them either. No later revision parses: each pin is the last upstream
change to its file (checked against `ontola/openapi-directory` `main` at
`845f81fffbea9a2c4b49fb7364cce967eea3203a`), so these overlays cannot be
re-pinned until the documents are fixed upstream. The script warns and
cannot check their overlays.

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

- `.github/workflows/overlays-ci.yml` (PRs): all overlay paths, revision
  filenames and `extends` commits pass the full-history check, and every
  action target exists in its pinned OAD or in the catalog composition up to
  it; every catalog overlay URL, and
  every OAD URL under the Pages base, maps to a file in this folder, and the
  tests below pass (`tests/test_identity_overlays.py` also checks the pets
  demo's document and data). It reads the
  Pages-published sources from the checkout, so it validates a change before
  Pages serves it.
- `integration-proxy`'s `default_catalog_*` tests (PRs touching this folder):
  compose the selected dated catalog with the proxy's runtime loader, reading
  overlays from this folder. Its
  `swagger2_overlay_revisions_compose_without_components` test composes every
  Swagger 2.0 overlay here on its own, downloading the 21 pinned documents.
- `.github/workflows/overlays-published.yml` (after each Pages build): the
  served dated catalogs, every overlay and Pages-published OAD they list, and
  the pets demo's data match the built commit.

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
| [YouTube v3](APIs/googleapis.com/youtube/v3/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml) | Six playlist, subscription, comment and search collections; comment ID batches and streams excluded. | [Provider documentation](https://developers.google.com/youtube/v3/docs/playlistItems/list) |
| [Google Cloud Storage v1](APIs/googleapis.com/storage/v1/pagination-f29c692c20956b05daf223ad8f641e9a9bd6dfb4-overlay.yaml) | Four bucket, flat-object, operation and HMAC-key collections; directory prefixes excluded. | [Provider documentation](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list) |
| [Box 2026.0](APIs/box.com/2026.0/pagination-84d76796923210d5e972c22c22f834a061290fbd-overlay.yaml) | GET workflows and read-POST item query, with separate query/body markers and entries envelopes. | [Provider documentation](https://developer.box.com/guides/api-calls/pagination/marker-based) |
| [GitHub REST 2022-11-28](APIs/github.com/api.github.com.2022-11-28/1.1.4/pagination-7782419eb8c981c9dd28379e41a43ca3186f4758-overlay.yaml) | Eight issue, pull-request, comment, label, milestone and repository lists, using Link headers and root arrays. | [Provider documentation](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api) |
| [Twilio Conversations](APIs/twilio.com/twilio_conversations_v1/1.55.0/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml) | 22 GET collections, including conversations, messages, participants, services and users. | [Provider documentation](https://www.twilio.com/docs/conversations-classic/api/conversation-resource) |
| [Twilio Messaging](APIs/twilio.com/twilio_messaging_v1/1.55.0/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml) | Nine GET service/sender/compliance collections with explicit envelopes. | [Provider documentation](https://www.twilio.com/docs/messaging/api/service-resource) |
| [Clockify read-only v2](APIs/clockify.me/1.0.0-readonly/pagination-v2-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml) | One user time-entry list with 1-based page numbers and a root array. | [Provider documentation](https://docs.clockify.me/) |
| [Twilio Accounts](APIs/twilio.com/twilio_accounts_v1/1.55.0/pagination-fdc294bd8f2520f4cef3491726d86b603b5cf946-overlay.yaml) | Two GET credential collections: AWS and public keys. | [Provider documentation](https://www.twilio.com/docs/iam/credentialaws-resource) |
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
