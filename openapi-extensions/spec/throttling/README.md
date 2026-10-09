# OpenAPI Throttling Extension

**Spec version:** 0.3.0-draft

This proposal addresses [issue #13](https://github.com/pondersource/openapi-extensions/issues/13).
It describes announced API request quotas, the response headers that report
them (`headers`, since 0.2.0), and the responses that mean a request was
throttled (`signals`, since 0.2.0). It does not describe a client's
scheduler, retry count, import budget, or chosen delay between requests.

An API can also throttle because of load, abuse detection, or unpublished rules.
Remaining below an announced quota never guarantees acceptance. Ordinary OpenAPI
Response and Header Objects already describe `429`, other error statuses, and
`Retry-After`; this extension does not replace them.

## Declaration and operation selection

A root `x-throttling` object defines named quota buckets and the buckets that
apply by default. An operation's `x-throttling` array, when present, replaces
the default list **in full**. Include a default bucket explicitly to retain it.
Every selected bucket applies simultaneously; the list is not a choice between
alternatives. `[]` means no announced bucket is selected, not unlimited service.

```yaml
x-throttling:
  limits:
    source:
      requests: 120
      window: { seconds: 60, kind: fixed }
      partitionBy: [sourceIp]
    signedInUser:
      requests: 1000
      window: { seconds: 3600, kind: sliding }
      partitionBy: [user]
    expensiveReads:
      requests: 10
      window: { seconds: 60, kind: sliding }
      partitionBy: [user]
  applies: [source, signedInUser]
paths:
  /records:
    get: {} # inherits source and signedInUser
  /exports:
    get:
      x-throttling: [source, signedInUser, expensiveReads]
```

These are illustrative numbers, not claims about a real provider. The complete
example in [examples/windowed.yaml](examples/windowed.yaml) also demonstrates
an operation replacing a default user bucket with a session bucket.

Buckets are shared by all operations selecting the same bucket identifier,
within each partition. A different identifier declares a distinct counter even
when its numeric limit is identical. Identifiers are local to the OpenAPI
document; matching names in two documents do not establish shared counters.
Unlisted rules may still exist, including rules shared with other APIs.

## Objects

The capitalized requirements below are normative in the sense of
[BCP 14](https://www.rfc-editor.org/info/bcp14).

| Root field | Type | Meaning |
| --- | --- | --- |
| `limits` | map of bucket identifier to Limit Object | Nonempty bucket definitions. Required with `applies`. |
| `applies` | array of bucket identifiers | Default selection; entries must be unique and defined. May be empty. Required with `limits`. |
| `headers` | map of response header name to Header Role Object | Since 0.2.0. What each rate-limit response header reports, and its unit. See [Response headers](#response-headers). |
| `bodyFields` | map of JSON body dot-path to Header Role Object | Since 0.3.0. The same roles read from the JSON response body instead of a header. See [Response body fields](#response-body-fields). |
| `signals` | array of Signal Objects | Since 0.2.0. The responses that mean the request was throttled. See [Throttling signals](#throttling-signals). |

The root object holds at least one of `limits`, `headers`, `bodyFields` and
`signals`;
`limits` and `applies` appear together or not at all. A document can therefore
describe its rate-limit headers and throttling responses without announcing a
numeric quota.

A Limit Object contains:

| Field | Type | Meaning |
| --- | --- | --- |
| `requests` | positive integer, optional | Announced maximum number of counted requests in the window. Omission means the amount is unknown or not published. |
| `window` | Window Object, required | Duration and known window semantics. |
| `partitionBy` | array of dimension names, optional | Dimensions forming one joint bucket key. Omission means partitioning is unknown; `[]` explicitly means one counter shared by all callers. |
| `description` | string, optional | API-specific identity meanings, qualifications, or remaining unknowns. |

Each request counts as one unit against each applicable bucket. Weighted costs,
concurrency limits, token/leaky buckets, burst allowances, and conditional
account-tier formulas are outside this first version. Do not approximate those
rules as exact request-count windows. Omit an unknown numeric limit instead of
inventing one or using zero/infinity. A documented minimum service allowance
(such as “20 or more per minute”) is not a maximum quota.

### Windows

| Field | Type | Meaning |
| --- | --- | --- |
| `seconds` | positive integer, required | Window duration in seconds. |
| `kind` | `fixed`, `sliding`, or `unspecified`, required | Known counting semantics; no default is inferred. |
| `anchor` | RFC 3339 timestamp, optional | A known boundary for a fixed window. Only valid with `kind: fixed`; this version uses seconds 00–59. |

`fixed` means counts belong to successive non-overlapping windows of the stated
duration and reset at their boundaries. If `anchor` is known, boundaries are
`anchor + n * seconds`, for integer n. Without an anchor, the phase is unknown;
it may differ between partitions. Do not assume UTC minute boundaries or a
first-request anchor.

`sliding` means the count concerns the preceding interval of the stated
duration as the evaluation time advances. It does not imply periodic full
resets. Providers with approximate/segmented algorithms should use
`unspecified` unless their documented externally visible semantics match this
model. `unspecified` records the announced duration without asserting the
algorithm. A reset header alone does not establish either algorithm.

The description does not specify which failed/rejected requests count unless
the API documentation does. Such details remain prose in this version; clients
must not infer that failures are free.

### Partitions

The initial dimension vocabulary is:

| Dimension | API-side identity counted |
| --- | --- |
| `sourceIp` | Source IP as observed by the API, including a shared proxy/NAT address. |
| `user` | Authenticated resource-owner identity recognized by the API. |
| `session` | Session identity recognized by the API. |
| `application` | Registered application/client identity recognized by the API. |
| `credential` | Individual credential identity, only when documented as the partition. |
| `account` | API account, tenant, or workspace; qualify its meaning in `description`. |
| `operation` | The OpenAPI operation, shared across concrete path-parameter values unless otherwise documented. |

Unknown dimension names MUST be absolute URIs, allowing future vocabulary
without collisions. These names do not instruct a client to extract or expose
credentials, infer user identity from a JWT claim, or equate an API user with a
proxy's login identity.

`partitionBy: [sourceIp, user]` means one counter **per pair**. Independent IP
and user limits require two bucket definitions, one partitioned by IP and one
by user, with both selected. A quota shared across several credentials belonging
to the same user must use `user`, not `credential`.

If different authentication profiles have different limits, this version can
describe a document narrowed to one profile, or leave the amount unknown and
explain the alternatives. It does not define a conditional policy language.

## Responses remain standard OpenAPI

```yaml
responses:
  '429':
    description: Request throttled; other limits may also apply.
    headers:
      Retry-After:
        description: >-
          Delay-seconds or an HTTP-date as defined by RFC 9110 section 10.2.3.
        schema: { type: string }
```

A response can signal throttling even when no announced bucket is exhausted.
Do not classify every `403` as throttling; an API's response description must
distinguish quota exhaustion from authorization failures. Header names alone
also do not establish units or meaning. Since 0.2.0, `headers` states what a
rate-limit header reports and in which unit, and `signals` states which
responses are throttling; both are described below. This draft still defines
no wire format of its own: it describes the headers and bodies an API already
sends.

A client may use these declarations to reduce the chance of throttling. Its
request history can be incomplete because other callers share the same bucket.
Scheduling, coordination between clients, safety margins, retries, and handling
changed service limits are consumer decisions. Live server responses remain
relevant regardless of locally calculated remaining capacity.

## Response headers

Added in 0.2.0. `headers` maps a response header name to a Header Role Object.
Header names are case-insensitive (RFC 9110 §5.1); two keys that differ only in
case are invalid. The map applies to every response of every operation in the
document.

| Field | Type | Meaning |
| --- | --- | --- |
| `role` | `limit`, `remaining`, `used`, `reset` or `retryAfter`, required | What the header reports; see below. Each role appears at most once in the map. |
| `unit` | Time Unit, required for `reset` and `retryAfter`, not allowed otherwise | How the header's value encodes a time. |
| `description` | string, optional | API-specific meaning, for example which bucket the header reports when several apply. |

| Role | Value |
| --- | --- |
| `limit` | The number of requests allowed in the current window of the bucket the response counted against. A non-negative decimal integer. |
| `remaining` | The number of requests left in that window. A non-negative decimal integer. `0` means the bucket is exhausted until `reset`. |
| `used` | The number of requests made in that window. A non-negative decimal integer. |
| `reset` | When that window resets, in the declared `unit`. |
| `retryAfter` | The earliest time to send another request, in the declared `unit`. The standard `Retry-After` header is declared with `unit: deltaSecondsOrHttpDate`. |

| Time Unit | Encoding |
| --- | --- |
| `epochSeconds` | A non-negative decimal integer: seconds since 1970-01-01T00:00:00Z. |
| `deltaSeconds` | A non-negative decimal integer: seconds after the response was received. |
| `httpDate` | An HTTP-date (RFC 9110 §5.6.7). |
| `deltaSecondsOrHttpDate` | Either of the two above, as RFC 9110 §10.2.3 defines `Retry-After`. |

Declare a header only when the API's documentation establishes its role and
unit. A header whose unit is not documented stays out of the map, even when its
name suggests one; the Moneybird example below shows such a case. A consumer
ignores a declared header whose value does not parse in its declared encoding;
it does not guess another unit. How an absolute time is measured against the
consumer's clock and the response's `Date` header is defined under "Earliest
retry time" below. An HTTP-date in an obsolete format without a zone is read
as GMT (RFC 9110 §5.6.7).

The headers of the IETF `RateLimit` and `RateLimit-Policy` structured fields
(draft-ietf-httpapi-ratelimit-headers) carry several values in one header. A
Header Role Object cannot describe them; this version does not cover them.

## Response body fields

Added in 0.3.0. Some APIs report rate-limit values in the JSON error body
rather than, or as well as, in headers. Todoist's API v1 documents an
`error_extra.retry_after` field ("Seconds to wait before retrying. May be
returned on rate-limited requests and other API errors, not just 429
responses"; [Todoist API v1](https://developer.todoist.com/api/v1/), Errors).
`bodyFields` maps a dot-path into the parsed JSON response body to a Header
Role Object (above): the same `role`, `unit` and `description`, the same
roles at most once in the map, and the same rule that a value which does not
parse in its declared encoding is ignored. A field value is used as text: a
JSON number is its decimal representation, so `3` reads as `deltaSeconds`
`3`; any other non-string value does not parse.

A role read from both a header and a body field counts once: for `reset` and
`retryAfter`, the later of the two times; for `limit`, `remaining` and
`used`, the header's value when it parses, else the body field's. A body
field is read only from a response that is JSON and is classified as
throttling (below); a role on another response says nothing.

## Throttling signals

Added in 0.2.0. `signals` is a nonempty array of Signal Objects. A response
matches a Signal Object when its status is listed and every predicate the
object holds matches. A consumer tests the objects in order, and the first one
that matches determines the response's meaning.

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | array of integer HTTP status codes, required | Nonempty, unique, each 100–599. |
| `header` | Header Predicate, optional | A condition on one response header. |
| `body` | Body Predicate, optional | A condition on the JSON response body. |
| `meaning` | `throttled` or `quotaExhausted`, required | What a matching response means; see below. |
| `bucket` | bucket identifier, optional | The `limits` bucket the response reports exhausted, when the API's documentation establishes it. Requires `limits`. |
| `minDelaySeconds` | positive integer, optional | A delay the API's documentation asks for when the response carries no `retryAfter` or `reset` time. |
| `description` | string, optional | API-specific notes. |

A **Header Predicate** has a `name` (case-insensitive) and exactly one of:
`equals` (a string; the header value must equal it exactly), `in` (a nonempty
array of strings; the value must equal one of them) or `present: true` (the
header is present, with any value).

A **Body Predicate** has a `pointer`, a JSON Pointer (RFC 6901) into the
parsed JSON body, and exactly one of:

- `equals`: a string, number, boolean or `null`; the value at `pointer` must
  equal it (JSON equality, so `"0"` does not equal `0`);
- `in`: a nonempty array of such values; the value must equal one of them;
- `contains`: a string; the value at `pointer` must be a string that contains
  it, compared ASCII case-insensitively (for human-readable messages);
- `present: true`: `pointer` resolves to any value;
- `item`: a Body Predicate; the value at `pointer` must be an array, and at
  least one element must match `item`, whose `pointer` is evaluated against
  that element. This is how a reason inside an error array, such as Google's
  `error.errors[].reason`, is matched.

A body that is not JSON, or a `pointer` that does not resolve, does not match.

| Meaning | A consumer |
| --- | --- |
| `throttled` | Treats the request as refused because of rate limiting. It retries no earlier than the earliest retry time below. |
| `quotaExhausted` | Treats the request as refused and the bucket as exhausted until it resets: every request counted against the same bucket will be refused until then, so it pauses them all, not only this one. When `bucket` is given, those are the requests to operations that select it. |

A signal declares a response the API documents as a rate-limit refusal. That
the refused request was not applied is an inference, as for any refusal before
processing; none of the APIs in the examples below documents it explicitly. A
response that may follow partial processing (a timeout, a `5xx` in general) is
not a throttling signal. A consumer that resends a write after a matching
response, or after a `429` classified by the default below, relies on that
inference. Before resending a create that is not idempotent, it SHOULD send an
idempotency key, or read the collection to check whether the record already
exists, where the API offers either.

Use `equals`, `in` and `contains` only on headers and body fields the API
writes itself, never on a field that may echo the request (a submitted title, a
query string): a caller's own data could otherwise make an ordinary error look
like throttling, or the reverse.

A header field that appears more than once in a response has no single value:
a role ignores it, and `equals` and `in` do not match it (`present` does).
Header values are compared after removing leading and trailing whitespace.

**Earliest retry time.** For a matching response, a consumer computes:

1. T1, from the `retryAfter` header or body field, when it is declared,
   present and parses (the later of the two when both do);
2. T2, from the `reset` header or body field, when it is declared, present and
   parses, and the meaning is `quotaExhausted` or the `remaining` value is `0`;
3. the later of T1 and T2. When neither exists: the response time plus
   `minDelaySeconds` when the signal gives it; else, for `quotaExhausted` with
   a `bucket` whose window is known, the response time plus that window's
   `seconds`; otherwise the consumer's own backoff.

An absolute time (`epochSeconds`, `httpDate`) is measured twice: against the
consumer's own clock, and, when the response has a `Date` header, as the same
offset from `Date` applied to the time the response was received. The later of
the two counts, so neither a wrong local clock nor a wrong `Date` header can
make the time earlier. A delay (`deltaSeconds`) counts from the time the
response was received. A decimal integer too large to parse does not parse.

A consumer MUST NOT send the request again, or another request counted against
an exhausted bucket, before this time. It MAY wait longer, cap how long it is
willing to wait and give up instead, and back off further after repeated
signals; those are consumer decisions.

**Classification.** A response with status `429` (RFC 6585) is throttling,
with the meaning `throttled`, unless a Signal Object matches it first; this
holds whether or not `signals` is present. When `signals` is present, a
consumer classifies any other response as throttling only when it matches a
Signal Object; in particular, a `403` that matches no signal is not
throttling. When `signals` is absent, this extension says nothing about
responses other than `429`.

`headers` and `signals` are root-level only in this version: an operation's
`x-throttling` array still selects buckets and nothing else. An API whose
throttling responses differ per operation is described by the union of its
signals, or by a document narrowed to the operations that share them.

## Examples observed in APIs

- **Moneybird:** the guide announces 150 requests per five minutes per source IP,
  and a stricter report limit. It does not establish the window algorithm. For
  the non-report read API, a truthful declaration is `requests: 150`,
  `window: {seconds: 300, kind: unspecified}`, and `partitionBy: [sourceIp]`.
  Report grouping and overlap should be described only to the extent verified;
  this example is not a complete model of report traffic.
  [Moneybird developer guide](https://developer.moneybird.com/).
- **Spotify:** the API describes an application-wide rolling 30-second window,
  with limits affected by quota mode. Use `window: {seconds: 30, kind: sliding}`
  and `partitionBy: [application]`; omit `requests` when the numeric amount is
  not provided. Separate endpoint limits need separate buckets when documented.
  [Spotify rate limits](https://developer.spotify.com/documentation/web-api/concepts/rate-limits).
- **GitHub:** unauthenticated public requests have an IP quota, while personal
  authenticated traffic can share a user quota across tokens and apps. Model
  those as different partitions, not one counter per token. The full conditional
  plan/app formulas and secondary limits are deliberately not approximated here.
  [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
- **Slack:** Web API quotas can be per operation, application, and workspace.
  `[operation, application, account]` describes that joint partition. Tier
  descriptions and unpublished burst allowances must not be mistaken for an
  exact maximum. [Slack rate limits](https://api.slack.com/docs/rate-limits).

### Response headers and signals in three APIs

**GitHub** documents `x-ratelimit-limit`, `-remaining`, `-used` and `-reset`
("in UTC epoch seconds"). The primary limit answers `403` or `429` with
`x-ratelimit-remaining: 0`; a secondary limit answers `403` or `429` with "an
error message that indicates that you exceeded a secondary rate limit", with
or without `retry-after`. Without either header, GitHub asks clients to "wait
for at least one minute before retrying"
([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
The documentation quotes no exact message, so the `contains` text below is an
observation, not a documented string.

```yaml
x-throttling:
  headers:
    x-ratelimit-limit: { role: limit }
    x-ratelimit-remaining: { role: remaining }
    x-ratelimit-used: { role: used }
    x-ratelimit-reset: { role: reset, unit: epochSeconds }
    retry-after: { role: retryAfter, unit: deltaSeconds }
  signals:
    - status: [403, 429]
      header: { name: x-ratelimit-remaining, equals: '0' }
      meaning: quotaExhausted
    - status: [403, 429]
      header: { name: retry-after, present: true }
      meaning: throttled
    - status: [403, 429]
      body: { pointer: /message, contains: secondary rate limit }
      meaning: throttled
      minDelaySeconds: 60
```

A `403` for a missing permission usually carries a nonzero
`x-ratelimit-remaining`, no `retry-after` and another message, so it matches
none of these and is not throttling. When the hourly quota happens to be used
up at the same time, it carries `x-ratelimit-remaining: 0` and matches the
first signal; the only cost is a wait until the reset before the request fails
again as a permission error.

**Google.** The Calendar API's error guide documents a rate-limit overrun as
`403` or `429` with the reason `rateLimitExceeded` in `error.errors[].reason`,
and `userRateLimitExceeded` with `403` only; it recommends exponential backoff
([Calendar API errors](https://developers.google.com/workspace/calendar/api/guides/errors)).
The snippet below generalises that guide to other Google Workspace APIs, which
is an inference: the Google Tasks API, which K6 targets, documents only a
courtesy limit of 50,000 queries per day and no error responses
([Tasks usage limits](https://developers.google.com/workspace/tasks/limits)).
`quotaExceeded`, which the Calendar guide uses for Calendar's own usage limits
rather than API quota, is left out, as is any daily-limit reason.

```yaml
x-throttling:
  signals:
    - status: [403, 429]
      body:
        pointer: /error/errors
        item: { pointer: /reason, in: [rateLimitExceeded, userRateLimitExceeded] }
      meaning: throttled
```

**Moneybird** answers `429` and sends `Retry-After`, `RateLimit-Remaining`,
`RateLimit-Limit` and `RateLimit-Reset`, described only as "the time after
which a new request can be made", "the time remaining before a new request can
be made" and "the total limit", without units
([introduction](https://developer.moneybird.com/introduction)). Only
`Retry-After`, whose encoding RFC 9110 defines, can be declared; the
`RateLimit-*` headers stay out of the map until their units are documented.

```yaml
x-throttling:
  limits:
    apiRequests:
      requests: 150
      window: { seconds: 300, kind: unspecified }
      partitionBy: [sourceIp]
  applies: [apiRequests]
  headers:
    Retry-After: { role: retryAfter, unit: deltaSecondsOrHttpDate }
  signals:
    - status: [429]
      meaning: quotaExhausted
      bucket: apiRequests
```

The `bucket` holds only for a document without the `/reports/` endpoints,
which have their own limit of 50 requests per five minutes; for a document
that includes them, a `429` does not say which bucket is exhausted, and the
signal should leave `bucket` out.

[examples/response-signals.yaml](examples/response-signals.yaml) is a
complete synthetic document with headers and signals.

## Overlay publication and validation

An overlay can add the root object and replace operation selections at ordinary
OpenAPI targets. The extension does not require new Overlay operations. A
consumer that does not understand it still sees normal operations, responses,
and security requirements.

Validators MUST check object shapes, positive integer amounts/durations, known
window kinds, anchor format and placement, unique partition dimensions, and
unique/defined bucket references at the root and every operation. An operation
selection without root definitions is invalid. Unknown numeric capacity and
unknown partitioning are valid and must remain distinguishable from zero and
global scope respectively.

Since 0.2.0 they MUST also check: the root holds at least one of `limits`,
`headers` and `signals`, and `limits` with `applies` or neither; header names
unique case-insensitively; known roles, each at most once; `unit` present
exactly for `reset` and `retryAfter`, with a known Time Unit; for each Signal
Object, a nonempty array of unique integer statuses within 100–599, a known
`meaning`, a positive integer `minDelaySeconds`, a `bucket` defined in
`limits`; for each predicate, exactly one operator, a nonempty `in`, a string
`equals` and a nonempty `name` in a Header Predicate, a valid RFC 6901
`pointer` (empty, or `/`-separated with only `~0` and `~1` escapes), JSON
scalar operands in a Body Predicate, and a nested `item` checked by the same
rules.

[validate.py](validate.py) validates these structural rules for a loaded
OpenAPI document. It also holds `classify(document, status, headers, body,
received_at)`, a reference implementation of signal matching, the earliest
retry time and the classification rule, which the tests exercise.
[test_validate.py](test_validate.py) includes rejection cases. It cannot
establish whether the provider's real policy matches the declaration. Authors
must verify that against current API documentation and observations. From the
repository root:

```sh
cd openapi-extensions/spec/throttling
pip install -r requirements.txt
python3 -m unittest test_validate
python3 validate.py examples/windowed.yaml examples/response-signals.yaml
```

The tests need PyYAML ([requirements.txt](requirements.txt)); they also check
that every `x-throttling` snippet in this README validates on its own.
`validate.py` itself reads JSON, and YAML when PyYAML is installed.

Future revisions can add weighted requests, richer conditional rules, other
bucket algorithms, per-operation signals and the IETF `RateLimit` structured
fields as concrete cases require them. This draft does not claim to exhaust
API throttling.

## Changes

- **0.3.0-draft** (2026-10-09): adds `bodyFields`, the Header Role Object's
  roles read from a JSON body field (Todoist's `error_extra.retry_after`). A
  0.2.0 document stays valid and means the same.
- **0.2.0-draft** (2026-10-08): adds `headers` (Header Role Objects: `limit`,
  `remaining`, `used`, `reset`, `retryAfter`, with Time Units) and `signals`
  (Signal Objects with status, header and body predicates, `throttled` or
  `quotaExhausted`, an optional `bucket` and `minDelaySeconds`), the earliest
  retry time (absolute times measured against both clocks, the bucket window
  as a floor for `quotaExhausted`), the classification rule (`429` throttled
  with or without signals), and the resend basis (an inference, with an
  idempotency key or a read before resending a create). `limits` and
  `applies` become optional together. A 0.1.0 document stays valid.
- **0.1.0-draft**: announced request-count windows and partitions.

## References

- [RFC 6585, 429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585#section-4)
- [RFC 9110, Retry-After](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)
- [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)
