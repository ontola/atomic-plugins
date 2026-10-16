# Atomic ontology targets, API lenses and Solid app portability

Source assessment on 2026-10-08. Atomic defaults were inspected at this repo's
pinned host `a12b74a6783b6158119e26a7d36aecadbedda0bf`. Provider and Solid
capabilities below are mapping candidates unless an existing implementation is
identified. No live provider or Pod account was used for this assessment.

## What is already defined

AtomicServer seeds five core class declarations in `lib/src/populate.rs`, plus
50 class declarations across eleven embedded `lib/defaults/*.json` files.
Commit occurs in both places: **54 distinct class subjects**, not 54 domain
ontologies. The list is bounded by that commit and excludes additional resources
created by users. Defaults are add-only on existing stores; an existing edited
schema may differ from a fresh seed. Sources: [population code](https://github.com/ontola/atomic-server/blob/a12b74a6783b6158119e26a7d36aecadbedda0bf/lib/src/populate.rs)
and [embedded declarations](https://github.com/ontola/atomic-server/tree/a12b74a6783b6158119e26a7d36aecadbedda0bf/lib/defaults).

| Seed group            | Classes / declarations | Scope                                                                                                                                                                                 |
| --------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core Rust models      | 5                      | Property, Class, Datatype, Agent, Commit                                                                                                                                              |
| default_store.json    | 20                     | Article, Bookmark, File, PlainText, Folder, Drive, Document/DocumentV2, Collection, Commit, Atom, Peer, Server, Endpoint, Importer, Invite, Redirect, Canvas, Paragraph, DisplayStyle |
| chatroom.json         | 3                      | ChatRoom, Message, FollowEvent                                                                                                                                                        |
| meeting.json          | 1                      | Meeting                                                                                                                                                                               |
| table.json            | 10                     | Table, View, Tag and seven property/format models                                                                                                                                     |
| dashboard.json        | 2                      | Dashboard, Block                                                                                                                                                                      |
| ontologies.json       | 1                      | Ontology grouping                                                                                                                                                                     |
| ai.json               | 7                      | AI chat/message and message-part types                                                                                                                                                |
| plugins.json          | 5                      | Plugin, Release, Installation, InstallationRuntime, Listing                                                                                                                           |
| forks.json            | 1                      | Fork                                                                                                                                                                                  |
| tasks.json, i18n.json | 0                      | Property vocabularies; task status values are Tag instances                                                                                                                           |

`task/v1` supplies status, body, assignee and due-date properties, with Todo,
Doing, Blocked and Done tags. It does not define a Task class. The repo's
[`issue-v1`](../../ontology/classes/issue-v1) fills that gap.

Separately, [`ontology-kit/source.json`](../../ontology-kit/source.json) defines
six published classes: event-v1, issue-v1, time-entry-v1, work-project-v1,
work-person-v1 and bank-transaction-v1. Their source is outside the server.
They remain on GitHub Pages; catalog entries using them stay disabled under the
current publication rules. Drive-local schemas are additional user-created resources; they are not a universal
public ontology.

## Where APIs fit

| Target                             | Existing repo mapping paths                                | Further candidates and limits                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bookmark                           | New passive Solid and Raindrop lenses below                | Destination URL is a string, not the bookmark's identity. Topics/tag resources require another mapping.                                                                          |
| issue-v1 / task-v1                 | GitHub, Todoist and Google Tasks apps                      | Solid task formats; other task APIs need explicit workflow/status rules. Priority and assignment are not all interchangeable.                                                    |
| event-v1                           | Google Calendar app/lens                                   | Outlook Calendar, CalDAV: retain all-day/civil-time boundaries, exact offsets and recurrence rules.                                                                              |
| time-entry-v1, project, person     | Clockify, Moneybird app read paths                         | Time tracking APIs with explicit running-entry and precision contracts. Work-person is a name/reference, not a full contact card or agent.                                       |
| bank-transaction-v1                | Money bank-statement import, Moneybird financial mutations | Banking/accounting transaction feeds with scoped account IDs, currency and exact signed decimals (v1 allows at most five fractional digits). Invoices are not bank transactions. |
| ChatRoom / Message                 | Native chat; fediverse reply projection                    | Solid chat is promising. Slack/Matrix/Discord need room/thread mapping, attachment handling, author provenance and permission translation.                                       |
| File                               | Native files; protocol bridges                             | Drive/Dropbox/OneDrive/S3 metadata. A temporary authenticated download URL does not implement blob storage or access control.                                                    |
| Article / PlainText                | Native content types                                       | Text exports, feeds and notes. Article's published-at is a **date** in the pinned defaults despite its DateTime description. Preserve source timestamps separately.              |
| DocumentV2                         | Native rich document editor                                | Notion/Google Docs require conversion to the editor's collaborative document model. A JSON object or Markdown string is not a DocumentV2 body.                                   |
| No seeded full contact/movie model | None                                                       | Define a contact domain for vCard, and Movie/WatchAction domains for Media Kraken. Avoid squeezing them into work-person or Bookmark.                                            |

The first four further-API columns are schema/architecture candidates, not new
provider certifications. The strongest already-inspected new provider contract is
[Raindrop's bookmark API](https://developer.raindrop.io/v1/raindrops).

## Solid storage and Solid Data Modules

Solid applications choose their own RDF vocabularies and document layouts.
Pods store RDF documents (often Turtle) and non-RDF files; discovery can use a
WebID profile and public/private type indexes. A resource IRI such as
`https://pod.example/movies/film#it` names an RDF subject; it is different from
its document URL and from a linked external movie or bookmark destination.
Source: [Solid's data model](https://solidproject.org/faq).

Inspection of [Solid Data Modules](https://github.com/solid-contrib/data-modules/tree/4602b8aee3737f06248ef08d45d771525cbba0a3)
found actual implementations beyond the README's older summary:

| Module / apps                                                    | RDF/storage conventions                                                                                          | Atomic bridge assessment                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Bookmarks (Poddit, Solid Bookmarks, Booklice and Soukai formats) | bookmark#Bookmark with recalls; title/label variants; some ActivityStreams Notes; literal or linked destinations | Direct name/destination projection into Bookmark. Keep subjects, term encodings and topics/provenance in the complement. |
| Contacts / SolidOS address book                                  | vCard contacts, groups and address-book documents, with linked email/phone/address nodes                         | New Atomic contact/address schemas needed; work-person alone loses the address-book model.                               |
| Chat / SolidOS                                                   | Solid Chat convention, RDF messages across channel/day documents                                                 | Map into ChatRoom/Message, retaining message identities, external author provenance and document placement.              |
| Tasks / SolidOS Issue Pane and Solid Hello World                 | Tracker index/state documents versus one schema:Action document per task                                         | issue-v1 is a useful target, but each convention needs its own status and comment mapping.                               |
| Movies / Media Kraken                                            | schema:Movie and schema:WatchAction in expanded JSON-LD                                                          | New Atomic movie/watch-action schemas; retain full node identities and graph for reverse writes.                         |

Primary conventions: [bookmarks](https://pdsinterop.org/conventions/bookmark/),
[contacts](https://github.com/solid/contacts), [chat](https://solid.github.io/chat/),
[tasks module](https://github.com/solid-contrib/data-modules/tree/4602b8aee3737f06248ef08d45d771525cbba0a3/tasks/vanilla).

A practical bridge has three layers: the data module discovers/reads a Pod;
a provider-local Devonian lens maps its data into Atomic;
a host executes approved writes using the module or a dataset-aware RDF client.
A normalized module DTO alone may lose unmapped triples, datatype/language tags
and original identities. Retain the source graph and current ETag, or retrieve
them before an edit. Full RDF datasets, blank nodes and lists require explicit
adapters. WebID/WAC/ACP rights are not Atomic agent/grant rights.

The repo already has a [Solid protocol plugin](../../integrations/solid/README.md)
that stores Pod document bytes in PlainText atoms. That supplies a protocol
placement, not typed Movie/Bookmark projections or a verified Media Kraken
backend. Keeping Solid document bytes available and exposing typed Atomic views
could coexist; they must have one coordinated write path.

## A close Media Kraken port

Inspected [Media Kraken c7e78d6d](https://github.com/NoelDeMartin/media-kraken/tree/c7e78d6d503c219680dcdd1b7946ffd830a14624).
The app uses Vue services, Soukai models, browser caching and Solid/browser user
backends. It discovers a Movie container via the private type index, falling
back to `/movies`. Each movie and its watch actions share a document. Search
uses TMDB separately from the Pod. Sources:
[storage/architecture](https://github.com/NoelDeMartin/media-kraken/blob/c7e78d6d503c219680dcdd1b7946ffd830a14624/docs/README.md),
[Movie](https://github.com/NoelDeMartin/media-kraken/blob/c7e78d6d503c219680dcdd1b7946ffd830a14624/src/models/soukai/Movie.ts),
[WatchAction](https://github.com/NoelDeMartin/media-kraken/blob/c7e78d6d503c219680dcdd1b7946ffd830a14624/src/models/soukai/WatchAction.ts).

| RDF model                         | Suggested Atomic representation                                                          | Preservation requirement                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| schema:Movie                      | New Movie class, name and description; explicit release-date/image/external-links fields | Original movie subject; release date's lexical value/type; external URLs remain metadata, not the sync identity |
| schema:WatchAction                | New WatchAction class, linked native movie resource, start/end strings                   | Each original action subject; all rewatch events; original precision and timezone                               |
| schema:object                     | AtomicURL pointing at the imported movie                                                 | Resolve through the same Pod/account-scoped identity map, never by title/slug                                   |
| dcterms created/modified          | Separate imported timestamps                                                             | Do not forge Atomic server-managed createdAt/createdBy values                                                   |
| Movie and actions in one document | Separate typed Atomic resources plus document placement in the complement                | Reverse changes must edit the original complete RDF dataset atomically                                          |

The watched flag is derived from action history, not the movie's identity or a
replacement for that history. The UI can stay close: film cards, search,
watch/unwatch, dates and local cache. Replace the authentication/storage service
boundary with an Atomic backend and new typed models. Rich portability requires
import/export of the original graph, not merely a UI rewrite.

The [movies module source](https://github.com/solid-contrib/data-modules/blob/4602b8aee3737f06248ef08d45d771525cbba0a3/movies/vanilla/src/movies.ts)
is a useful read prototype. It accepts both linked and string-valued URLs,
but its Listing output omits the Movie `@id`; watch output also omits the action
`@id` and uses `listingId` where its declared type says `listingUr`. Dates become
JavaScript Dates, losing lexical timezone/precision, and sparse required-looking
fields are not comprehensively validated. Before bidirectional use, add original
IDs/document URLs and retain raw typed terms; test sparse records and multiple
watch events. These are concrete module improvements rather than reasons to
invent a generic RDF-to-Atomic cast.

A staged port would first publish Movie/WatchAction schemas, then import movie
and action graphs with stable identities, add the Atomic storage backend, and
verify UI parity and bidirectional edits in a disposable Pod/drive. No new movie
vocabulary, UI port or live synchronization is implemented by this assessment.

## First implemented lenses

- [Solid RDF Bookmark](../../integrations/solid/devonian/bookmarks/lens/index.ts):
  bounded expanded JSON-LD; name/URL edits preserve predicates, language and
  literal-versus-link encoding. Semantic triple plans only.
- [Raindrop Bookmark](../../integrations/bookmarks/devonian/raindrop/lens/index.ts):
  title/link/excerpt, scoped numeric ID; minimal update bodies and explicit clears.
- [Todoist issue-v1](../../integrations/issue-tracker/devonian/todoist/lens/index.ts):
  task text edits, scoped string ID; completion and scheduling remain read-only.

These are unhosted prototypes using unreleased `devonian/lenses` source.
Projection patches preserve unmanaged native properties; putting into the
previous source preserves provider-only fields. They do not supply transport,
create/delete, conflict policy or durable recovery. An empty reverse plan means
no write. Hosts must use a current source snapshot and respect their write
review/authorization flow. None changes a published app bundle or catalog.
The per-provider READMEs give contracts, exact commands and evidence limits.
