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
`absent: removed` and `notFound: unavailable` on the 20 collections whose
resource has an item read documented with a 404. The evidence is the pinned
document alone; developer.moneybird.com renders client-side and could not be
read. Absence is `removed` because the lists' own documented defaults leave
out records that still exist (`filter` defaults `period:this_year`,
`state:active` and `unbatched:true`; `active` default true for assets and
products; archived contacts only with `include_archived`), so a record
absent from a read is settled by its own read. The reads document their 404
only as "Not found", which does not tell a deleted record from one the
caller cannot read, so a 404 is `unavailable` rather than the default
`deleted`. Not declared: `financial_mutations` (capped at 100 with no page
parameter, so a read is complete only through the range-window overlay, not
yet on `main`), `subscriptions` (listed per contact through a `contact_id`
query the collection does not model), the resources without an item read
(absence could never be settled), `gone` (no 410 documented) and
`parentAbsent` (no administration resource). Not verified: what any read
answers for a deleted record. No dated catalog selects it yet.
`../../../tests/test_moneybird_completeness.py` composes it with the
catalog's Moneybird overlays in either order, runs both validators, and
checks which collections are declared, the documented defaults and the
outcomes `classify_read` gives. No provider was called.

Not checked here, and worth checking: `all-records-selection.json` sends
`active: false` on assets, whose parameter reads "Whether to include only
active assets". For products the document says false includes deactivated
ones; for assets it does not say whether false means all assets or only
inactive ones.
