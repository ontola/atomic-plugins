# The shared lens catalog

Status: **declared, not verified.** The format, its builder and checker, and
release 1 with four lenses exist in this repository. No host loads the
catalog yet: ontola/atomic-server#2069's `loadLensCatalog()` still returns
`[]` (checked at `bab52555`). Nothing here has run against a live drive or
provider.

This closes gap L1 of [`docs/design/pieces.md`](../docs/design/pieces.md)
(open point O2), and feeds L2, L4 and L5. The decisions it follows are
Q-089 (a shared catalog next to the ontology, plus drive-local lenses that
need review), Q-091 (chains of at most 2 lenses, two-way only), Q-106
(published under `ontology/lenses/`, provider-record-to-class lenses
allowed) and Q-107 (the host's templates make shared-class rows, below).

## Where it lives

| What                | Path                                                      | Served at (Pages)                |
| ------------------- | --------------------------------------------------------- | -------------------------------- |
| Source              | `ontology-kit/lenses.json`                                | not a subject                    |
| Interpreter         | `ontology-kit/lens.mjs`, `lens.d.mts`                     | not a subject; plugins bundle it |
| Builder and checker | `ontology-kit/lens-catalog.mjs`, called by `ontology.mjs` | –                                |
| A catalog release   | `ontology/lenses/v<N>`                                    | `<base>/lenses/v<N>`             |
| One lens            | `ontology/lenses/<name>-v<N>`                             | `<base>/lenses/<name>-v<N>`      |

`<base>` is `ontology-kit/base.json`'s, now
`https://ontola.github.io/atomic-plugins/ontology`. Each published file's
`@id` is the URL it is served at, like a term file's.

**Rule change.** AGENTS.md said `ontology/` holds only the generated term
files. This puts the generated lens files there too, under `lenses/`, and
amends that sentence. Why there, and not in a new top-level folder:

- one base, so a domain move stays one edit to `base.json` plus a rebuild,
  and the existing base-move exception covers the lens files;
- `ontology.mjs check --published origin/main`, which CI already runs, makes
  every file under `ontology/` immutable, so the lens files are covered with
  no change to `.github/workflows/` (which agent sessions cannot push);
- `ontology-published.yml` already checks that Pages serves every file under
  `ontology/` with its committed bytes, so lens files get that check too.

The alternative, a top-level `lenses/` folder with its own base, needs a
second immutability check and a workflow change.

**Decided (Decision Inbox Q-106, `ontology-lenses`, Michiel, 2026-10-08):**
lens files are published under `ontology/lenses/`, and the catalog may hold
provider-record-to-class lenses (record and rdf endpoints) as well as
class-to-class ones. AGENTS.md's two rules are amended accordingly: what
`ontology/` holds, and that shared code may hold such declarative lenses
while provider-specific code, code lenses included, stays in plugin
folders.

## Versioning: published lens files are immutable

As for terms and app bundles:

- A file under `ontology/lenses/` that is on `main` is never changed or
  deleted. `check --published <ref>` reports a changed or deleted one; the
  only allowed change is a base move.
- A lens is named `<slug>-v<N>`. Any change to a published lens (mapping,
  endpoints, limits, examples, even its description) is a new lens
  `<slug>-v<N+1>`.
- A release `lenses/v<N>` lists **every** lens a host gets when it pins that
  release, not only the new ones (unlike an ontology release, which lists the
  terms it adds). A new or changed lens goes in a new release `v<N+1>`. A lens
  found wrong is withdrawn by leaving it out of the next release; its file
  stays served.
- A lens records the first release that listed it in `release`.
- One release offers at most one lens per pair of endpoints, so a chain
  search over it never has to break a tie between two lenses for the same
  pair (#2069 breaks ties by list order, which would then depend on the
  release's order).
- **A host pins a release URL** (`<base>/lenses/v1`), fetches it, then each
  lens it lists. A newer release reaches a host only when its pin moves. How
  the host's pin is set is part of the batch 2 issue draft below.

## File formats

`lensFormat: 1` marks both files; a host refuses a format it does not know.

A release, `ontology/lenses/v<N>`:

```json
{
  "@id": "<base>/lenses/v1",
  "lensFormat": 1,
  "name": "Shared lens catalog, release 1",
  "description": "…",
  "lenses": ["<base>/lenses/clockify-time-entry-v1", "…"]
}
```

A lens, `ontology/lenses/<name>-v<N>`:

| Key              | Value                                                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@id`            | Its own URL                                                                                                                                                                                                             |
| `lensFormat`     | `1`                                                                                                                                                                                                                     |
| `release`        | The first release that listed it                                                                                                                                                                                        |
| `name`           | What a menu shows, `Source ↔ Target`                                                                                                                                                                                    |
| `description`    | One or two sentences                                                                                                                                                                                                    |
| `source`         | An endpoint (below)                                                                                                                                                                                                     |
| `target`         | An endpoint                                                                                                                                                                                                             |
| `mapping`        | A `LensMapping`, version 2 or 3 (below)                                                                                                                                                                                 |
| `limits`         | Optional: what the mapping does not do that a reader could expect, one sentence each                                                                                                                                    |
| `implementation` | Optional: the repository path of the code lens it was derived from when published; informative, never executed. `check` requires the file only while the lens is unpublished, so moving the code later does not fail CI |
| `examples`       | At least one `{ source, target, edits? }`; `check` runs every one (below)                                                                                                                                               |

In `lenses.json`, a class endpoint may name a shared class by its name
(`"time-entry-v1"`), and a reference on a class endpoint, or a key of an
example row on one, may be a shared property's shortname (`"work-start"`).
`build` writes them as subjects, so `lenses.json` never contains the base.

### Endpoints

Exactly one of:

- `{ "class": "<subject>" }`: an Atomic class. Rows are keyed by property
  subjects, so mapping references on this side are absolute URLs.
- `{ "record": { "provider", "resource", "openapi"? } }`: a provider record
  as syncables reads it, keyed by the provider's JSON field names, so
  references on this side are JSON Pointers. `provider` is the
  openapi-directory provider key (`todoist.com`); `resource` the
  `components.crudResources` name. `openapi`, when present, is the folder
  under `overlays/` (`APIs/todoist.com/1`), and `check` requires a
  `crud-causality-*-overlay.yaml` there that declares that resource.
  Without it the lens names a shape no catalog integration produces yet.
- `{ "rdf": "<RDF class IRI>" }`: a node of that RDF class in expanded
  JSON-LD (a Solid Pod document). References are JSON Pointers.

A host's chain search needs one string per endpoint (#2069's `source` and
`target`). `endpointKey()` gives a class's subject, and for the other two a
**provisional** key (`record:APIs/todoist.com/1#task`, `rdf:<IRI>`). That key
must agree with whatever the produced-class declaration (pieces.md I1, O8)
gives a derived class, which is not specified yet. A record endpoint is the
"catalog lens from the derived class" option of O8; the format does not
decide O8.

### Mappings: `LensMapping` version 2

```json
{ "version": 2, "fields": [{ "source", "target", "convert"?, "args"?, "readOnly"? }] }
```

- `source`, `target`: an absolute URL is a top-level key; a string starting
  with `/` is a JSON Pointer (RFC 6901, `~1` for `/`, `~0` for `~`) into
  nested values, such as `/timeInterval/start` or
  `/http:~1~1purl.org~1dc~1terms~1title/0/@value`.
- `convert`: one of the converters below, `identity` when absent. `args`
  only where the converter takes them.
- `readOnly: true`: the lens never writes this field's source. A forward
  `put` with a changed value throws `read-only`; an unchanged value is
  ignored. Reading, and writing the table from the provider side, are
  unaffected.

| Converter           | Source → target                                                                                   | Inverse                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `identity`          | The value, copied                                                                                 | The same                                                     |
| `ms-to-iso`         | Epoch ms → ISO 8601 (`toISOString`), from #2069                                                   | Refuses sub-millisecond digits                               |
| `iso-to-ms`         | ISO 8601 instant (Z or offset) → epoch ms                                                         | `toISOString`, with milliseconds                             |
| `iso-seconds-to-ms` | The same, for a side that keeps whole seconds                                                     | Refuses milliseconds (`precision`); writes `…:SSZ`           |
| `map`               | `args.pairs: [[source, target], …]`, one-to-one                                                   | The same table backwards; an unlisted value `unmapped-value` |
| `day-of`            | `YYYY-MM-DD`, or a date-time with no time zone, → `YYYY-MM-DD`; `Z` or an offset is a `bad-value` | None: one-way, only on a `readOnly` field                    |

Every converter refuses values outside its domain (`bad-value`) instead of
coercing them, and none loses precision silently. Instants must be valid
times of day (no `T24:00`, no leap second) in the years 0000-9999 UTC, so
that every value round-trips through `toISOString`. `day-of` refuses an
instant (`Z` or an offset) because its civil day depends on the time zone it
is read in, which a mapping cannot know.

Values must be JSON-like (plain objects, arrays, strings, finite numbers,
booleans, null) and nest at most 64 levels; anything else is a `bad-value`.
The path tokens `__proto__`, `constructor` and `prototype` are refused, and
only own properties are read or written.

**Semantics.** `get` reads each source reference and writes the converted
value at the target reference; an absent source leaves the target absent,
and unmapped places are dropped. `put(view, previous)` writes only the fields
whose view value differs from what `get(previous)` reads, so an unchanged
value keeps its exact representation (Devonian's unchanged-value rule); a
field absent from the view is left alone; everything the mapping does not
reference keeps its value, including siblings along a pointer's path (an RDF
literal's `@language`). Two fields may not read or write the same place, or
one place inside another (`/a` and `/a/b`). The backward direction swaps
roles and skips one-way fields.

**Laws**, checked on every catalog example: GetPut
(`put(get(s), s) = s`) forward on the example source and backward on the
example target; and for each edit, in the edit's direction, PutGet
(`get(put(v, s)) = v` on the fields the view holds, and, under `absent:
"unset"`, a field the view leaves out reads back absent) and stable put
(putting the same view twice changes nothing more). They hold on the
examples, which is evidence, not a proof over all values. The backward
limits are listed under "Mapping version 3".

### Mapping version 3 (pieces.md L2)

Version 3 is version 2 plus three additions. A version 2 mapping keeps its
exact meaning, and published version 2 files are unchanged.

```json
{
  "version": 3,
  "fields": [{ "source", "target", "convert"?, "args"?, "readOnly"?, "absent"?, "default"? }],
  "guards"?: [{ "at", "is" | "in" | "notIn", "orAbsent"? }]
}
```

- **Guards** say which source records the lens is for. Each guard tests the
  place `at` (a reference on the source side) and has exactly one test:
  - `is: "present"` or `is: "absent"`, where present means neither
    undefined nor null;
  - `in: [values]`, where the value must be present and equal one of them
    (`orAbsent: true` also lets it be absent);
  - `notIn: [values]`, where the value is absent or equals none of them.

  Guards apply wherever a provider record is the input or the output:
  - a forward `get` refuses a record outside them with `out-of-domain`;
  - a forward `put` refuses one too, both for the previous record and for
    the record it would write;
  - a backward `put` refuses a view outside them: its view is the provider
    record, so a deleted Todoist task is refused whichever way it would be
    written, as the code lens does;
  - a backward `get` reads a target-shaped row, so guards don't apply to it.

  Release 2 uses them for a running Clockify timer (`/timeInterval/end` must
  be present), a non-REGULAR entry, a deleted Todoist task, a task without
  content and a Raindrop record without an `_id`.

- **`absent`** says what a `put` does when the view lacks a field that the
  previous row had:
  - `keep`, the default and version 2's only behaviour, leaves it;
  - `unset` removes it;
  - `default` writes the field's `default` value, a source value, into the
    source in a forward put, and removes the target in a backward one.

  A read-only field is never written forward, so there its `absent` only
  matters backward. Only an object member can be removed: `parseMapping`
  refuses `unset` or `default` on a field whose source or target ends in an
  array index, which would shift every later index. An object that a
  removal leaves empty is removed too (`/due/date` leaves no `due: {}`),
  but never the row itself or an array item. A `default` must be a source
  value the field's converter accepts, checked when the mapping is parsed.
  With `unset` or `default`, `put` reads the view as the whole row, as
  Devonian's `recordLens` does; a host that has only a patch merges it onto
  the previous view first.

- **A one-way field is written backward.** A backward `put` (writing the
  table from a provider-shaped view) computes a one-way field's target from
  the view, and removes it under `unset` or `default` when the view lacks
  it. Version 2 skips such fields. Todoist's due day is the case: a task
  without a due date now removes a stale `due-date`, as the code lens does.

Backward limits, stated plainly:

- **One-way fields break backward GetPut under `unset` or `default`.** A
  target-shaped row cannot be turned into a source view that holds a
  one-way field, since it has no inverse, so `put_b(get_b(row), row)`
  removes that field's target (Todoist's `due-date`). The law check leaves
  one-way fields' target places out of the comparison; for them backward
  GetPut is not claimed.
- **A backward view built from a row can fall outside the guards**, because
  it lacks provider places no field maps (Raindrop's `_id`). `put` refuses
  such a view, and the law check gives no GetPut verdict for it.

### Examples

Each example has a `source` row and either the `target` row `get` must give,
or an `error` code that `get` must refuse with (`out-of-domain`). Optional
`edits` hold:

- a changed `target` with the `source` that `put` must give, or with an
  `error` code (`read-only`, `precision`, …) that `put` must throw;
- with `direction: "backward"`, a provider-shaped `source` view and either
  the `target` row that a backward `put` onto the example's target must
  give, or the `error` code it must refuse with (`out-of-domain` for a
  view outside the guards).

They are the lens's conformance fixtures: a host's interpreter can run them
too.

### Compatibility with #2069's `LensMapping` v1

`lens.mjs` reads `{ version: 1, fields: [{ source, target, convert? }] }`
unchanged, with every reference a top-level key taken verbatim and only the
converters `identity` and `ms-to-iso`; #2069's own test cases pass against it
(`lens.test.mjs`). Version 2 adds JSON Pointers, the four converters after
`ms-to-iso`, `args` and `readOnly`.

Migration for #2069 (batch 2): parse version 2 as well (or use `lens.mjs`),
and pass `mappingVersion` through, so a host that only runs v1 skips a v2
lens instead of failing its offers. Drive-local lenses stored as v1 keep
working, except where they relied on what `lens.mjs` refuses. Every
difference from #2069's `lens.ts` at `bab52555`:

- **Put:** v1's `lensPut` rewrote every mapped field, v2 writes only changed
  ones. The results are the same except where a converter re-encodes an
  unchanged value (an ISO string without milliseconds, read and written back
  through `ms-to-iso`).
- **Strict converters:** #2069's `ms-to-iso` passes a non-number (get) or
  non-string (put) through unchanged and lets `Date.parse` return `NaN`;
  `lens.mjs` refuses a non-integer, out-of-range or non-ISO value, an ISO
  string without a time zone, `T24:00` and sub-millisecond digits.
- **Values:** #2069 passes values by reference and accepts anything;
  `lens.mjs` copies them and refuses non-JSON-like or too deeply nested ones.
- **Unknown keys** in a mapping or a field are refused; #2069 ignores them.
- **Path tokens** `__proto__`, `constructor` and `prototype` are refused,
  and only own properties are read (#2069 reads `row[from]`, inherited
  ones included).
- **Exports:** the parser is `parseMapping` (#2069: `parseLensMapping`) and
  returns a frozen mapping with parsed paths; `storedMapping` gives the plain
  form. `lensGet`, `lensPut`, `getAlongPath` and `CONVERTERS` keep #2069's
  names.
- **Errors** are `LensError`s with a stable `code`. Messages are lowercase
  and worded differently ("unknown converter", where #2069's test matches
  `/Unknown converter/`); match on `code`, not on the message.

`catalogLensInfo(file)` returns #2069's `CatalogLens` shape (`subject`,
`name`, `source`, `target`, `mapping`) plus `mappingVersion`. All four
release 1 lenses are version 2 (they need pointers), so a v1-only host
would skip all of them. Release 2's Clockify, Todoist and Raindrop lenses are version 3: a host that runs only version 2 would skip them, so it stays pinned to `lenses/v1` until it runs version 3.

## Bundling a catalog lens

A plugin can run a published lens without any host support: `build` also
writes `ontology-kit/lenses.mjs` (with `lenses.d.mts`), one export per
published lens (`todoistTaskIssueV2` for `todoist-task-issue-v2`) holding
what a plugin runs: `@id`, `release`, `name`, `source`, `target` and
`mapping`. Examples and limits stay in the published files. A plugin
imports the one it uses, with `lens.mjs` to run it, by relative path, as it
does `terms.mjs`:

```ts
import { lensPut } from '../../../ontology-kit/lens.mjs';
import { todoistTaskIssueV2 } from '../../../ontology-kit/lenses.mjs';
```

- Each export is `/* @__PURE__ */ JSON.parse('…')`, so esbuild leaves out
  the lenses a plugin does not import; `lenses`, all of them by name,
  bundles every one.
- The data is exactly the published file's, checked by `check` (freshness)
  and by `lens-catalog.test.mjs`. A lens version is immutable, so a bundle
  never runs a different mapping than the file at its `@id`; a new lens
  version reaches a plugin only through a rebuild and a new app version.
- The github.io gate still applies: the bundle carries the base, so the
  plugin's catalog entry stays `enabled: false` (`ontology-kit/README.md`,
  "Gate").
- First use: the Todoist drive app, 0.3.0 (`integrations/issue-tracker/
todoist-app/lens.ts`), writes its `issue-v1` rows through
  `todoist-task-issue-v2`'s backward put.

## Trust and review (Q-089)

- **Catalog lenses are reviewed by being in a release.** A host trusts the
  lenses of the release it pins, on every drive, as #2069 does.
- **Drive-local lenses** keep #2069's resource (`lens-source`, `lens-target`,
  `lens-mapping`, `lens-review`) and use the same mapping format; until
  approved they offer nothing. At #2069's head nothing resets `lens-review`
  when the mapping changes (checked, a search of its diff at `bab52555`), so
  an approved lens stays approved after any edit. "Approvals bound to a
  mapping digest" below proposes a fix.
- A drive-local lens and a catalog lens between the same endpoints: while
  the drive-local one is unreviewed only the catalog one is trusted. When
  both are trusted, #2069's search takes the lens listed first, and its
  `loadPieces` lists catalog lenses first (checked, at `bab52555`). Whether a
  reviewed drive-local lens should override a catalog lens is not decided.

### Approvals bound to a mapping digest (proposal, L3/O3)

**A proposal, not implemented and not decided.** It changes #2069's
drive-local `lens` resource, so under the freeze it goes to Joep as part of
the host-loading issue, and what the review screen shows stays open (O3).

1. **Digest.** The approval covers the lens's _effective_ content:
   `source`, `target` and the mapping. Its canonical form is the JSON text
   of an object with three keys, `mapping` (`storedMapping(mapping)`),
   `source` (the `lens-source` subject) and `target` (the `lens-target`
   subject), with object keys sorted at every level, no whitespace, and
   array order kept (array order is meaningful in a mapping). The digest is
   `sha256:` plus the lowercase hex SHA-256 of its UTF-8 bytes; a browser
   computes it with `crypto.subtle.digest`.
2. **Approving** writes `lens-review: "approved"` and a new property
   `lens-review-digest` holding the digest of the content just reviewed, in
   one commit. The review screen shows the content it digests, so what was
   reviewed is what is bound.
3. **Trust.** A drive-local lens is trusted only when `lens-review` is
   `"approved"` **and** `lens-review-digest` equals the digest of its current
   content. Any edit to the mapping, source or target makes it unreviewed
   again without anyone resetting a flag, and the offer shows it as
   "waiting for review", as #2069 does today for an unapproved lens.
4. **Migration.** An approved lens with no `lens-review-digest` (every lens
   approved under #2069 today) counts as unreviewed once the rule ships, and
   needs one more approval.
5. **Catalog lenses** need no digest: a published lens file never changes,
   and the host trusts it by its subject in the pinned release.

What it does not do: it does not record who approved (the commit's signer
already does), nor stop a person with write access from approving their own
edit. Whether approval needs a second person is part of O3.

## Chains (Q-091)

The catalog does not chain anything; the host does, with
`MAX_LENS_HOPS = 2` (#2069). Every catalog lens has a `put`, so every lens is
two-way and can be walked both ways.

**Decided (L-B, by the coordinator, citing Q-091, 2026-10-08):** a lens whose
put refuses edits to some read-only fields counts as two-way. Q-091 excluded
one-way lenses that make a whole piece read-only, not refusals of single
fields.

## The host's templates (Q-107)

**Decided (Decision Inbox Q-107, `shared-classes`, Michiel, 2026-10-08):**
the host's Time tracker and Issue Tracker templates create `time-entry-v1`
and `issue-v1` rows directly, instead of minting a class per table (the
pinned host mints one per table, and the Time tracker's `work-*`
properties per drive). A table made from either template then matches
views and integrations of the shared class exactly, so the catalog needs no
lens for it, and none is planned: per-drive template classes cannot be
named in a published catalog anyway. The host change is an atomic-server
issue, under the freeze a draft for Joep. Tables made from the old
templates keep their per-table classes until migrated.

## Release 1

All four come from merged prototypes and keep their code lens as the
reference; the catalog entry is the part a host can run with no provider
code (D5). Each entry's `limits` lists what the code lens does and the entry
does not. Next to each code lens, `catalog.test.ts` checks that the code lens
gives the same rows as the published entry on every catalog example, and
refuses the same edits; it runs in that plugin's lane unit tier
(`node integrations/tooling/run-lane.mjs <lane> --tier unit` for `bookmarks`,
`solid`, `issue-tracker` and `timesheets`), which reruns when
`ontology/lenses/` changes.

| Lens                     | Source → target                                | Writable                                  | Read-only                       | Left to code (see `limits`)                                                                   |
| ------------------------ | ---------------------------------------------- | ----------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `clockify-time-entry-v1` | Clockify `timeEntry` record → `time-entry-v1`  | name, work-start, work-end, work-billable | –                               | domain guard (running, locked, non-REGULAR), "Time entry" naming, project link, task coupling |
| `todoist-task-issue-v1`  | Todoist `task` record → `issue-v1`             | name, body                                | status (map), due-date (day-of) | domain guard (deleted, empty content), removing a stale due-date                              |
| `raindrop-bookmark-v1`   | Raindrop `raindrop` record → host `Bookmark`   | name, url, description                    | –                               | domain guard (id, lengths, URL), clearing an excerpt; no overlay declares the resource yet    |
| `solid-bookmark-v1`      | RDF `bookmark#Bookmark` node → host `Bookmark` | name, url                                 | –                               | alias predicates and types, literal-encoded links, the Pod write (ETag, CRDT)                 |

## Release 2

`lenses/v2` moves Clockify, Todoist and Raindrop to mapping version 3. It
lists `clockify-time-entry-v2`, `todoist-task-issue-v2`,
`raindrop-bookmark-v2` and the unchanged `solid-bookmark-v1`. Release 1 and
its files stay published as they were; a host pinned to `lenses/v1` keeps
getting them.

| Lens                     | What version 3 adds                                                                                                                  | Still left to code (see `limits`)                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `clockify-time-entry-v2` | Guards: `type` REGULAR or absent, start and end present (no running timers)                                                          | end after start, write restrictions (locked, custom fields, project rules), naming, project link, task |
| `todoist-task-issue-v2`  | Guards: not deleted, content present; a backward put writes the due day from the task and removes a stale one (`absent: "unset"`)    | an empty content, Doing and Blocked, a time-zoned due date, unmapped fields                            |
| `raindrop-bookmark-v2`   | Guard: `_id` present; a removed description writes an empty excerpt, a missing excerpt removes the description (`absent: "default"`) | id range, lengths, URL checks; no overlay declares the resource yet                                    |

The conformance tests next to each code lens run every example of both
versions; a refusal code (`out-of-domain`, `read-only`, `precision`) must
match the code lens's own message, listed in each test's `refusals` table.

### What it takes over from #271 and #365, and what it supersedes

Both PRs were merged with no review threads (checked, GitHub API, 2026-10-08);
their open ends are in their bodies, #259's comments and the #367 handover.

- **Taken over:** "a lens catalog next to the ontology" (#2069's stub comment,
  Q-089), and a declarative, published form of the four prototypes. Their
  passive tests stay where they are.
- **Not superseded:** the code lenses themselves. They still do what v2
  cannot (domain guards, coupled writes, identity links, removal) and remain
  the reference for each entry's examples. The npm release of
  `devonian/lenses` and app adoption stay open on #259; this catalog does not
  need either, since `lens.mjs` has no dependencies.
- **Superseded, as a proposal:** #2069's v1-only `lens.ts` interpreter, by
  `lens.mjs` (v1 and v2), for the "one interpreter" of L4; and the resolver's
  hand-written lens hooks for class-to-class lenses, by `resolverLens()`.
- **Not taken over:** the GitHub issues lens (#271), which needs workflow
  labels as a coupled field, and the Notion and Google Calendar lenses, which
  need runtime schemas and recurrence. They are L2 material, below.

## What the format cannot express yet (input for L2)

Found by fitting the four prototypes. Items 1 and 2 are built in mapping
version 3; the rest are candidate features:

1. **Domain guards** (version 3, `guards`): refuse a record outside the
   lens's domain (a running Clockify timer, a deleted Todoist task). Guards
   test single places; a relation between two places (an end after a start)
   is still not expressible.
2. **Removal** (version 3, `absent`): a field absent from the view clears
   the source (Raindrop's excerpt, Todoist's stale due-date).
3. **Identity links**: a provider id to a link to another row (Clockify
   `projectId` → `work-project`) needs an identity map, not a converter.
4. **Coupled writes**: one view field owning several source fields (Clockify's
   project and task; GitHub's state and workflow labels).
5. **Alternatives**: one view field read from whichever of several
   predicates is present (Solid's title aliases).
6. **Normalising converters**: trim, an empty value shown as a placeholder.

## Checks

```sh
node ontology-kit/ontology.mjs build                           # after editing lenses.json
node ontology-kit/ontology.mjs check --published origin/main   # what CI runs
node --test ontology-kit/                                      # all ontology-kit tests
```

`check` fails, besides the ontology's own problems, on: a lens or release
name; an endpoint that is not exactly one of the three; an unknown shared
class or property; a reference of the wrong kind for its endpoint; a mapping
`parseMapping` refuses; a target (or source) field that is not a field of the
shared class it names, or a required field of that class left unmapped; a
missing example or one whose `get`, `put`, laws or expected refusal fail
(including an example `get` must refuse, and a backward edit); a guard whose
`at` is of the wrong kind for the source endpoint; an
example row on a class endpoint whose value for one of `source.json`'s
properties does not fit that property's datatype (a string on a boolean, a
non-integer timestamp); a lens whose source and target are the same; an
`openapi` folder without an overlay declaring the resource; a missing
`implementation` file, for a lens not yet published at `--published`; a
release listing an undefined lens, a lens in no release, two lenses for one
pair in a release (a record counts as its provider and resource, with or
without `openapi`); a stale or stray file under
`ontology/lenses/`; and, with `--published`, a changed or deleted published
lens file.

CI's shared-checks job lists its test files by name, so `lens.test.mjs` and
`lens-catalog.test.mjs` run by being imported from `ontology.test.mjs`. Adding
them to the list in `.github/workflows/ci.yml` needs a push with the
`workflow` scope; the import can then go.

## Not verified

- Any host loading the catalog; Pages serving `ontology/lenses/` (it will
  be checked by `ontology-published.yml` after the first merge).
- A lane reading the catalog from the dev-server: `ontologyFile` in
  `integrations/tooling/dev-server.mjs` serves `ontology/lenses/` with its
  subjects moved to the dev-server's origin (unit-tested), but no lane e2e
  fetches it yet.
- That syncables' records for Clockify and Todoist have exactly the field
  names the examples use: the examples follow the code lenses' fixtures,
  not a recorded syncables read.
- The provisional endpoint keys against an I1 declaration, which does not
  exist yet.

## Open points

| #   | Open point                                                                                                                                         | Recommendation                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| L-C | The github.io gate (pieces.md O11): lens files carry the temporary base, as terms do                                                               | No host loads the catalog outside #2069's flag until the stable domain is in `base.json`; the release URL then moves with the base |
| L-D | Endpoint keys for record and rdf endpoints vs. the I1 declaration (O8)                                                                             | Settle with the I1 spec; until then the keys are provisional and no host should persist them                                       |
| L-E | Whether lens files should also be Atomic resources (JSON-AD with a shared `lens` class), so a drive can copy a catalog lens into a drive-local one | Later, with the host loader; plain JSON is enough to fetch and run                                                                 |
