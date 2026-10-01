# OpenAPI Throttling Extension

**Version: 0.1.0-draft**

This proposal addresses [issue #13](https://github.com/pondersource/openapi-extensions/issues/13).
It describes announced API request quotas. It does not describe a client's
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
| `limits` | map of bucket identifier to Limit Object | Required, nonempty bucket definitions. |
| `applies` | array of bucket identifiers | Required default selection; entries must be unique and defined. May be empty. |

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
also do not establish units or meaning: describe whether a value is a count,
relative delay, or absolute time in its Header Object. This draft adds no
header-role mapping or competing RateLimit wire format.

A client may use these declarations to reduce the chance of throttling. Its
request history can be incomplete because other callers share the same bucket.
Scheduling, coordination between clients, safety margins, retries, and handling
changed service limits are consumer decisions. Live server responses remain
relevant regardless of locally calculated remaining capacity.

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

[validate.py](validate.py) validates these structural rules for a loaded JSON
OpenAPI document; [test_validate.py](test_validate.py) includes rejection cases.
It cannot establish whether the provider's real policy matches the declaration.
Authors must verify that against current API documentation and observations.

Future revisions can add weighted requests, richer conditional rules, other
bucket algorithms, and standard response-signal mappings as concrete cases
require them. This first version does not claim to exhaust API throttling.

## References

- [RFC 6585, 429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585#section-4)
- [RFC 9110, Retry-After](https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3)
- [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html)
