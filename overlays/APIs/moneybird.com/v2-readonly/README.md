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
days are in (so it names no `timeZone`). The overlay goes after the
`pagination` overlay in a catalog. No dated catalog selects it until
syncables reads `rangeWindow` schemes. Check it with
`python3 overlays/tests/test_moneybird_range_window.py --directory <openapi-directory clone>`.
