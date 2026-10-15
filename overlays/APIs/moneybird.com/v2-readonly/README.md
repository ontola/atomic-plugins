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
