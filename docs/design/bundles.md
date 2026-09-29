# Bundles: organising plugins by what they do

Status: **proposal, not reviewed. Nothing here is implemented.** It builds on
the decisions recorded in
[#177](https://github.com/ontola/atomic-plugins/issues/177) (shared row
classes, "option 4") and on the placements of
[`server-plugin-routes.md`](server-plugin-routes.md) (#88). Where it changes an
earlier decision, it says so. Facts about the host were taken from #177 §1.1,
which checked them at atomic-server `2567fc30b`. They were not re-checked
against the current `.atomic-server-ref`.

Decided by Michiel (2026-09-29):

1. **The catalog lists bundles.** A bundle is the unit a person finds,
   installs and removes.
2. **A bundle holds parts of several kinds.** The kinds include reflectors
   (keeping a native table of a row class in sync with a remote dataset) and
   custom views (ways to show tables of a row class).
3. **Bundles are per domain, not per provider.** The Calendar bundle holds
   the event views and every reflector that fills an event table (Google
   Calendar now, CalDAV later). It is not a "Google" bundle.
4. **Built-in table views work the same way as plugin views.** The only
   difference is that they may run in the host page without an iframe. This
   **amends #177 decision 7 (Q3)**, which kept the built-in Calendar, Issues
   and Timer views as they were and left their evolution for later.

Everything below these four points is proposed.

Contents:

1. [Terms](#1-terms)
2. [The domain bundles](#2-the-domain-bundles)
3. [Catalog shape](#3-catalog-shape)
4. [Built-in views as a bundle](#4-built-in-views-as-a-bundle)
5. [Repository layout](#5-repository-layout)
6. [Host requirements (atomic-server)](#6-host-requirements-atomic-server)
7. [Order of work](#7-order-of-work)
8. [Open questions](#8-open-questions)

---

## 1. Terms

- **Row class.** The `classtype` of a table. A part says which row classes it
  works on by exact subject: one of the #177 shared classes
  (`event-v1`, `issue-v1`, `time-entry-v1`, `bank-transaction-v1`, …) or a
  class the bundle defines itself.
- **Bundle.** One catalog entry: a domain name, card copy, a version, and a
  list of parts. It installs and uninstalls as a whole. A part can't be
  installed without its bundle. Whether a person can switch single parts off
  is open (§8, Q3).
- **Part.** One piece of code with one kind. The kinds:

| Kind          | What it does                                                                                                                                       | Declares                                                                    | Placement (#88) | Exists today as                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------- |
| **view**      | Shows (and, with "Allow editing", edits) any table whose row class it renders, including hand-made tables and tables no reflector filled           | `renders`: row classes, exact subjects                                      | A               | Drive apps and their `renders` list; offered through "+ Add view" (`appsForClass`) |
| **reflector** | Keeps a native table of a row class in sync with a linked dataset behind a remote API, one or both ways                                            | `rowClass`, `platform`, `direction` (`read` or `two-way`), provider extras | A, later B      | The "sync part" of #177 §3                                                        |
| **importer**  | Turns a file the person hands over into rows of a row class, once per upload. Nothing is kept in sync afterwards                                   | `rowClass`, `accepts` (file types and size limits)                          | B               | Sandbox plugins with `accepts`/`destination` (`money/`, `willow-drop/`)           |
| **lens**      | Maps rows of one class onto another, both ways, so a view of the target class works on a table of the source class                                 | `from`, `to`                                                                | A (open, Q14)   | Devonian `AtomicLens`; the resolver's lens hooks in `ontology-kit/`                |

Importers are a separate kind from reflectors on purpose. A reflector
promises that the table and the remote dataset stay in step, and a person
should be able to trust that word. An importer makes no such promise.

Lenses were not in the first sketch of this idea. They are included because
#177 decision 5 makes a lens the only way a view reaches a table of another
class. A view without the lens that makes it reachable is often useless.

## 2. The domain bundles

A mapping of what exists today onto domain bundles. "Declared" means catalog
copy or code without host evidence, as in [READINESS.md](../integrations/READINESS.md).

| Bundle       | Row class(es)                      | Views                                                                 | Reflectors                                               | Importers                                | Lenses (planned)                             | Folder today                                      | Catalog entries today                    |
| ------------ | ---------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- | ------------------------------------------------- | ---------------------------------------- |
| **Calendar** | `event-v1`                         | `calendar/app/`; built-in Calendar                                    | Google Calendar (`calendar/devonian/google-calendar/`)   | –                                        | –                                            | `calendar/`                                       | `devonian-google-calendar`               |
| **Issues**   | `issue-v1`                         | `issue-tracker/app/`; built-in Issues                                 | GitHub (`issue-tracker/devonian/github-issues/`), Todoist (read) | –                                 | Issue Tracker template → `issue-v1`          | `issue-tracker/`                                  | `devonian-todoist` (GitHub has none)     |
| **Time**     | `time-entry-v1` (+ `work-project-v1`, `work-person-v1`) | `timesheets/app/`; built-in Timer                | Clockify (`timesheets/devonian/clockify/`), read          | –                                        | Time tracker template → `time-entry-v1`      | `timesheets/`                                     | `timesheets`                             |
| **Money**    | `bank-transaction-v1`              | `money/app/`                                                          | Moneybird (declared only)                                | MT940 and camt.053 (`money/plugin.ts`)   | –                                            | `money/`                                          | `money`, `moneybird`                     |
| **Tables**   | Per data source (no shared class)  | Built-in table view                                                   | Notion (`notion/app/`, `notion/plugin.ts`)               | –                                        | –                                            | `notion/`                                         | `notion`                                 |
| **Pets**     | Its own `Pet` class                | `pets/app/`                                                           | Mock `pets` platform                                     | –                                        | –                                            | `pets/`                                           | `pets`                                   |
| **Willow**   | Its own entry class                | –                                                                     | –                                                        | Willow drop (`willow-drop/`)             | –                                            | `willow-drop/`                                    | `willow-drop`                            |

Notes:

- The folders are already mostly domain-shaped. The bundle only makes that
  explicit, and adds the built-in views to each domain.
- **Notion has no domain.** A Notion data source can be anything, so its
  reflector writes a per-source class. "Tables" is a placeholder name for a
  bundle of generic reflectors whose only view is the built-in table view.
  Q2 asks whether that is the right home.
- **Pets stays a demo bundle.** It exists to exercise the drive-app path end
  to end, and its catalog card still describes the static sandbox demo
  (READINESS.md).
- **Server protocol packages are not domain bundles.** `atproto/`,
  `nextgraph/`, `open-cloud-mesh/`, `solid/` and `willow/` are protocol
  endpoints (placements C, D, E), not table sync or views. Q1 asks whether
  they get a part kind of their own (`route`) or stay outside this model.
- A bundle may list a reflector with no host entry point yet, as today's
  catalog lists `devonian-todoist`. The bundle's card must then say which
  parts work, per the "declared, not verified" rule.

## 3. Catalog shape

Proposed: `PluginCatalogEntry` is replaced by `Bundle`, whose `parts` are
nested resources. The card fields (`experimental`, `enabled`, `limitation`,
`keywords`, `capabilities`, `requires`) move to the bundle. Each part keeps
what is specific to it. Property subjects are abbreviated here.

```jsonc
{
  "@id": "https://atomicdata.dev/integrations/bundles/calendar",
  "isA": ["https://atomicdata.dev/integrations/classes/Bundle"],
  "shortname": "calendar",
  "name": "Calendar",
  "version": "0.1.0",
  "experimental": true,
  "enabled": false,            // uses the github.io ontology base (#177 decision 4)
  "limitation": ["Single, non-recurring events only."],
  "parts": [
    {
      "kind": "view",
      "shortname": "calendar-view",
      "renders": ["<base>/classes/event-v1"],
      "app-module": "https://ontola.github.io/atomic-plugins/apps/calendar/0.1.0/ui.js",
      "app-module-integrity": "sha384-…"
    },
    {
      "kind": "reflector",
      "shortname": "google-calendar",
      "rowClass": "<base>/classes/event-v1",
      "platform": "google-calendar",
      "direction": "two-way",
      "runs-in": "calendar-view"   // placement A: runs inside that view's module
    }
  ]
}
```

- **One published module per bundle version, or per part.** Today a drive
  app is one `apps/<id>/<version>/ui.js`, and the calendar app already holds
  both the view and the Google sync. Proposed: a reflector that runs in a
  view's module names it with `runs-in` and has no module of its own. A
  reflector that must also run in the background (B, once H11 exists) gets
  its own sandbox bundle. Q4 asks whether to split them further.
- **Versioning.** The bundle has one version. `apps.mjs`' rule that a
  published file on `main` is never changed stays unchanged; paths become
  `apps/<bundle>/<version>/<part>.js` for bundles with more than one module.
- **Host impact now:** none. At the pin the host reads only `shortname`,
  `enabled`, `experimental` and `requires-api-plugins` from the catalog
  (READINESS.md). The check that `version` equals the package's
  (`integrations/README.md`, "Version and catalog entry") and
  `catalog-requires.mjs` move from entries to bundles.

## 4. Built-in views as a bundle

**Proposal:** the data browser ships a bundle of its own, `builtin`, whose
views are the built-in Calendar, Issues, Timer and table views. They are
offered, listed and matched by the same code path as plugin views. The only
difference is a trust level that lets them skip the iframe.

### 4.1 Same contract

- Each built-in view declares `renders`, and "+ Add view" offers it through
  `appsForClass`, just as it offers plugin views. The generic table view
  renders every class.
- Each implements `view({ root, store })` against the same `store` API a
  drive app gets from `hostStore.ts`. The host calls it in the page instead
  of posting messages to a frame.
- Each is bound by the same grants: row edits only after "Allow editing"
  (#1788), only the class's `requires`/`recommends`, never `destroy`, never
  `parent`, `isA`, rights, the table or its views.

The benefit is that the built-in views become the reference implementation
of the plugin view API. Anything they need, plugin views can have too. It
also becomes a policy question, not a rewrite, to move a built-in view into
an iframe or to vet a plugin view into the trusted set.

### 4.2 The "inline" trust level

- A part may run without an iframe only if it is in a bundle **compiled
  into the host build**. A remote catalog entry cannot request it. A
  catalog, even this repository's, is data fetched at runtime (Settings →
  Integration can point it elsewhere), and one edit to it must never be
  able to put third-party code into the host page.
- "Inline" grants **no extra capability**. It removes the isolation, not a
  permission. Without the iframe, the grants above are kept by the view
  calling only the `store` API, which is enforced by code review, not by
  the browser. The server-side checks (the row grant in
  `app_row_grant.rs`, `refuseOutsideApp`) apply in both cases if the
  in-page `store` goes through the same path. That was not checked; see
  H-B3.

### 4.3 What changes in matching

This is the costly part. Today the built-in views recognise tables by
shortname: Calendar by the `calendarFields` shortnames, Timer by the `work-*`
terms `timeTrackingSchema` mints **per drive**, Issues by the task/v1
subjects (#177 §1.1, §2). Declaring `renders` with the shared classes means:

- **Calendar and Issues** can render `event-v1` and `issue-v1` directly.
  Those classes reuse the same shortnames and task/v1 subjects (#177 §2.2,
  §2.3).
- **Timer** can't. `time-entry-v1`'s `work-*` properties are new subjects,
  not the per-drive ones (#177 §2.4). Existing Time tracker tables need a
  lens (§3.1 of #177) or a migration, or Timer keeps its old match as a
  second path during a transition.
- **Tables made from the templates** keep their own classes until H3 (#177
  §7: templates use the shared classes). Without H3 or a lens, switching a
  built-in view to strict matching would stop offering it on tables it is
  offered on today. So the switch must wait for H3 plus lenses, or keep
  the shortname match as a fallback for the built-in bundle only. #177
  decision 5 (strict matching) is about plugin views, so a built-in
  fallback doesn't break it, but it is a difference between the two that
  this design is meant to remove. Q5.

## 5. Repository layout

Proposed: keep `integrations/<bundle>/`, one folder per domain bundle, and
rename only where the folder name is a provider or doesn't name the domain:

| Today                        | Proposed                                          |
| ---------------------------- | ------------------------------------------------- |
| `integrations/calendar/`     | unchanged                                         |
| `integrations/issue-tracker/` | `integrations/issues/`                           |
| `integrations/timesheets/`   | `integrations/time/`                              |
| `integrations/money/`        | unchanged                                         |
| `integrations/notion/`       | `integrations/tables/notion/` (Q2)                |
| `integrations/willow-drop/`  | `integrations/willow/` next to the protocol scaffold, or unchanged (Q1) |

Inside a bundle folder, parts get a subfolder per kind only when a bundle
has more than one part of that kind, for example
`issues/reflectors/github/` and `issues/reflectors/todoist/`. The existing
convention that a Devonian lens for a platform lives at
`<bundle>/devonian/<platform>/` stays. Renames are a separate PR per
bundle, after the catalog change, because `lanes.json`, CI paths and the
e2e specs name these folders.

## 6. Host requirements (atomic-server)

Nothing here is assumed to happen. H2 and H3 are #177's numbers.

1. **H-B1: install a bundle from the catalog.** `installCatalogApp` installs
   every part of a bundle, and uninstall removes them together. Supersedes
   the per-app install of [#94](https://github.com/ontola/atomic-plugins/issues/94);
   includes #177's H2 (the catalog declares `rowClass` and `renders`).
2. **H-B2: a view registry that built-in views register in.** `appsForClass`
   (or its successor) lists built-in and installed views from one registry,
   by `renders`. `TableViewTabs` renders both kinds from it.
3. **H-B3: an in-page `store`.** The `hostStore.ts` operations, callable
   directly by an inline view, going through the same grant checks as the
   frame path. Whether those checks are all in the frame message handler or
   partly shared with the server was not checked.
4. **H-B4: the inline trust level.** Honoured only for bundles compiled into
   the host build (§4.2).
5. **#177 H3: templates use the shared classes.** A prerequisite for the
   built-in views to match strictly (§4.3).

## 7. Order of work

1. Review this document and answer §8.
2. **No host change:** restructure `catalog.json` into bundles (§3), update
   `catalog-requires.mjs`, the version check and READINESS.md to read
   bundles, one PR. Host behaviour at the pin is unchanged.
3. **No host change:** folder renames (§5), one PR per bundle.
4. **No host change:** the Time tracker and Issue Tracker template lenses
   (#177 §3.1), once Q14 is decided.
5. **atomic-server:** H-B2 and H-B3 first, with the table view as the first
   built-in view on the new path, since it renders every class and so
   doesn't depend on §4.3.
6. **atomic-server:** H-B1 and H-B4, then Calendar and Issues on the new
   path, then Timer after H3 or its lens.

## 8. Open questions

1. **Server protocol packages** (`atproto`, `nextgraph`, `open-cloud-mesh`,
   `solid`, `willow`): do they become bundles with a `route` part kind, or
   stay a separate catalog class until the #88 placements C–E exist?
2. **Notion:** a "Tables" bundle of generic reflectors, a Notion bundle as
   the one provider-shaped exception, or should Notion reflect into the
   domain bundles when a data source matches a shared class (for example a
   Notion task database → `issue-v1`)?
3. **Parts on and off:** can a person switch off a single part, say the
   Todoist reflector in the Issues bundle, or only the whole bundle?
4. **Modules:** one module per bundle version, or one per part (§3)?
5. **Built-in fallback:** may built-in views keep shortname matching until
   H3 and the lenses land (§4.3), or should they switch only when strict
   matching loses no table?
6. **Third-party bundles in a domain:** if someone publishes a second
   Calendar view, is that part added to the Calendar bundle (one bundle per
   domain across publishers) or a separate bundle in the same domain?
