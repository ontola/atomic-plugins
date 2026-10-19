# Moneybird readable-record metadata

These overlays accompany the generated read-only Moneybird OpenAPI document at
commit `85a6105220036a98ef0d7cd6f228d4aae0036508` in the OpenAPI directory.

`crud-causality-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml` describes record identity, collections, object
reads, and response Links. The contact-to-subscriptions relation uses standard
Link request context plus the proposed `x-for-each` item binding; publication
of that dependency waits for the filtering/Link proposal review.

`all-records-selection.json` is deliberately separate from the overlays. Its
generic `query_overrides` request archived, inactive, billed, and unbilled
records for an “all records” import. The catalog passes this object to the
client as explicit consumer configuration; it is never composed into the
OpenAPI document and makes no claim about Moneybird's default API behavior.

Regenerate from a full-history checkout containing the generated OpenAPI
document. The generator derives its revision filename and `extends` from
that file's last-change commit. The validator selects the revision in the
platform catalog:

```sh
ruby scripts/generate_moneybird_metadata.rb /path/to/APIs/moneybird.com/v2-readonly
ruby scripts/validate_moneybird_metadata.rb /path/to/APIs/moneybird.com/v2-readonly
```

## A bounded read-only import: what the overlays declare (#102)

Checked on 2026-10-15 from documentation only, with no account and no token:
the pinned OAD and Moneybird's
[introduction](https://developer.moneybird.com/introduction.md) (static
Markdown, listed in `/llms.txt`; the HTML site renders client-side).

| Concern | Overlay | Declares | Status |
| --- | --- | --- | --- |
| Paging | `pagination-v2-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml` (new) | The 19 lists v1 pages follow the `Link` header's `rel="next"`; no `rel="next"` is the last page. No `per_page` is sent (default 50). | This PR; no catalog selects it |
| Paging | `pagination-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml` (v1) | `page`/`per_page` on the same lists, with no response field: a reader cannot tell the last page. | On `main`, in the catalogs |
| Unpaged lists | none needed | Twelve lists have no page parameter: one answer is the list. | Evidence in #578 |
| Financial mutations | `pagination-range-window-85a61052…` | "Limited to 100", no page parameter: read by period windows. | #614 |
| Completeness | `completeness-85a61052…` | `absent: removed`, `notFound: unavailable` on 20 collections. | #585 |
| Rate limits | `throttling-85a61052…` (v1) | 150 requests per 300 s per source IP. | On `main` |
| Rate limits | `throttling-v2-85a61052…` | v1 plus `Retry-After` and a 429 as `quotaExhausted`. | #615 |

Why the paging revision sends no `per_page`: the introduction gives
`per_page` "default: 50, maximum: 100" and says "Each paginated response
contains a `Link` header with information about the previous and next page",
but its example link carries only `page=3`. Whether a next link keeps a
`per_page` the client sent is not documented; a link that dropped it would
make the second page overlap the first. With the default the pages stay
consistent, at about twice the requests of 100 per page: 1,000 contacts take
20 requests, against the 150 per 5 minutes per IP. (The Money drive app,
`integrations/money/moneybird/read.ts`, sends `per_page=100` and follows the
links; it is verified against its synthetic fixture only.)

Stays unverified until a live run against a real administration:

- that every paginated answer carries a `Link` header (the pinned OAD
  attaches one to `downloads.json` only), that the last page's has no
  `rel="next"`, and that its links stay on `https://moneybird.com/api/v2` and
  the same list (the documented example link,
  `https://moneybird.com/api/v2/contacts.json?page=3`, has no administration
  id segment; taken literally it leaves the list's path, which §4.4.4's
  same-origin rule would still follow);
- whether a next link keeps `per_page`;
- the caching Moneybird warns of: "our API requests are cached for
  performance optimization. As a result, we strongly advise against using
  GET methods for verification purposes as this may result in an incomplete
  result". A list or an item read right after a change can be stale, so a
  record that #585's `removed` settles by its own read can read as present
  for a while;
- what a 404 means beyond "Entity not found", and what any read answers for
  a deleted record;
- the units of `RateLimit-Remaining`, `RateLimit-Limit` and `RateLimit-Reset`
  (the introduction calls `RateLimit-Remaining` "the time remaining"), and
  whether the window is fixed or sliding; a 403 means "IP is blacklisted for
  API usage";
- `X-Total-Count`, documented in the pinned OAD for `downloads.json` only,
  so not declared;
- which administration fields and record fields a real administration
  returns (the drive app's fixture is synthetic).

`../../../tests/test_moneybird_pagination_v2.py` validates the paging
revision alone and in the catalog's composition, checks it covers exactly
v1's lists, and follows links of the documented shape with the reference
`resolve_link` (another origin is refused). No provider was called.

`throttling-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml` describes the API's announced 150-request, 300-second
source-IP quota using [`openapi-extensions/spec/throttling`](../../../../openapi-extensions/spec/throttling/README.md). The
window algorithm is explicitly unspecified; pacing/retries remain consumer
choices. The catalog excludes report endpoints, whose stricter quota is not
modeled by this overlay. Source: https://developer.moneybird.com/#throttling

`completeness-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml` declares
[Collection Completeness 0.2.0-draft](../../../../openapi-extensions/spec/collection-completeness/README.md)
`absent: removed` and `notFound: unavailable` on the five lists whose read
sends no filter and leaves nothing out by default: identities,
ledger_accounts, task_list_templates, task_lists and workflows. §4.2 says
`removed` "still tells a consumer that the list does not filter by default",
which holds for these; an absent record may still exist and is settled by its
own read. The evidence is the pinned document and developer.moneybird.com's
server-rendered `/api/<resource>` pages, which embed the same OpenAPI and are
readable with curl: `/api/ledger-accounts` lists "Returns 404 when requesting
unexisting ledger account" with the ledger account read, and `/api/identities`
"Returns 404 when identity does not exist" with the identity read. Neither
says what a deleted record's read answers, nor tells a deleted record from
one that never existed or that the caller cannot read, so a 404 is
`unavailable` rather than the default `deleted`.

Not declared:

- Lists whose documented default leaves out records that still exist: the
  documents, estimates, external and sales invoices and time entries
  (`filter` default `period:this_year`), purchase transactions
  (`unbatched:true`) and recurring sales invoices (`state:active`). With
  `removed`, every record outside the default would go unconfirmed and need
  its own read; on 1 January that is every prior-year record, against a
  check budget of 50 per sync and 150 requests per 300 s.
- Assets, products, projects and contacts (`active` default true,
  `state:active`, archived contacts only with `include_archived`). A
  crud-causality revision that fixes the widening query as a `listQuery`, as
  `all-records-selection.json` does, could declare them on that read later.
- `financial_mutations` (capped at 100 with no page parameter, read by period
  windows below), `subscriptions` (listed per contact through a `contact_id`
  query the collection does not model), the resources without an item read,
  `gone` (no 410 documented) and `parentAbsent` (no administration resource).

Not verified: what any read answers for a deleted record. No dated catalog
selects it yet. `../../../tests/test_moneybird_completeness.py` composes it
with the catalog's Moneybird overlays in either order, runs both validators,
checks that exactly the five unfiltered lists are declared and that every
narrowing list stays undeclared, and checks the outcomes `classify_read`
gives. No provider was called.

`all-records-selection.json` sends `active: false` on assets. The parameter
reads "Whether to include only active assets", and the pinned document's
example for `false` is named `ReturnsAListOfAllAssets` ("Returns a list of all
assets", as `/api/assets` shows it), so `false` lists all assets, active and
inactive.

`crud-causality-v2-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml` is v1
plus a fixed read ([CRUD Causality 0.4.0](../../../../openapi-extensions/spec/crud-causality/README.md)
`listQuery`, §4.2.1) on the four lists that narrow by default, with exactly
the values `all-records-selection.json` passes as consumer configuration:
assets and products `active=false`, contacts `include_archived=true`,
projects `filter=state:all`. From the server-rendered pages: `/api/assets`
"Whether to include only active assets" (default true; the example for
`false` is named "Returns a list of all assets"), `/api/products` "When true,
only active products are returned. Set to false to include deactivated
products.", `/api/projects` "Any filter you pass replaces the defaults below
entirely, so include every key you need." with `state` taking "all, active or
archived.". `/api/contacts` gives `include_archived` no description: that
`true` lists archived contacts as well as the others is inferred from its
name, not documented. `completeness-v2-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml`
keeps v1's five declarations and adds the same `absent: removed` and
`notFound: unavailable` on those four, composed after crud-causality v2 (not
v1, whose reads of them narrow). Neither is selected by a dated catalog.
`../../../tests/test_moneybird_widened_reads.py` checks that v2 is v1 plus
those list queries, that each names a parameter the list declares, that
completeness v2 is v1 plus the four, that every declared list reads without
a narrowing default, and both validators. No provider was called.

`pagination-range-window-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml`
declares `GET /{administration_id}/financial_mutations.json` as a
[Pagination Schemes 0.5.0](../../../../openapi-extensions/spec/pagination-schemes/README.md#46-range-windows)
`rangeWindow`: the list has no page parameter and its description says it is
"Limited to 100 financial mutations" (the pinned document, and
https://developer.moneybird.com/api/financial_mutations/), so a client reads
a range of days as `filter=period:YYYYMMDD..YYYYMMDD` windows and halves a
window whose answer holds 100 mutations, down to single days. A single day
with 100 mutations ends the read with an error. The Money app's
`integrations/money/moneybird/read.ts` splits windows the same way in code
today, but asks its first window as the named `period:this_year`. Moneybird's
financial mutations synchronization API, which the pinned read-only document
does not include, is the documented alternative for reading more than 100. Declared, not
verified against a live administration: that the period bounds are
inclusive (inferred from the documented example `20130101..20130131`), that
a one-day period is accepted, which mutation field the period compares
(`date` is likely, so the overlay names no `field`), and whose time zone the
days are in (so it names no `timeZone`), and that a `period:` filter
alone still selects every state and mutation type (Moneybird says a passed
filter "replaces the defaults below entirely", and those defaults are
`state:all` and `mutation_type:all`). The overlay goes after the
`pagination` overlay in a catalog. syncables reads `rangeWindow` schemes,
and its `sync()` applies a windowed read from 0.22.0; no dated catalog
selects it yet. Check it with
`python3 overlays/tests/test_moneybird_range_window.py --directory <openapi-directory clone>`.

`throttling-v2-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml` (#615) keeps
v1's limits exactly and adds what the introduction's Throttling section
documents for a 429: `Retry-After` ("the time after which a new request can
be made") and a 429 as `quotaExhausted` on the `apiRequests` bucket.
`RateLimit-Remaining`, `RateLimit-Limit` and `RateLimit-Reset` are not
declared: the introduction gives them no units. No dated catalog selects it
yet. `../../../tests/test_throttling_overlays.py` checks it.
