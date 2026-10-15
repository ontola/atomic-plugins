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
