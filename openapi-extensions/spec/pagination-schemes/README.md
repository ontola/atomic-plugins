# OpenAPI Pagination Schemes Extension

**Spec version:** 0.6.0

---

## 1. Introduction

The OpenAPI Pagination Schemes Extension defines a standard way to describe API pagination behaviour in an OpenAPI document. It enables clients, SDKs, and tooling to automatically understand and navigate paginated responses without requiring hand-written, API-specific pagination logic.

The extension adds a `paginationSchemes` map under `components`. Each entry describes one pagination strategy supported by the API — its request parameters, response fields, and auto-detection rules.

The extension can be applied to existing OpenAPI documents without modification by using an [OpenAPI Overlay](https://spec.openapis.org/overlay/v1.0.0.html).

---

## 2. Overview

```yaml
components:
  paginationSchemes:
    <scheme-name>:         # Pagination Scheme Object (§4.1)
      type: pageNumber | pageToken | nextLink | incrementalSync | rangeWindow
      autoDetect: true | false | AutoDetectObject
      window:              # Range Window Object (§4.6); rangeWindow only
        unit: day | second | integer
        format: date | basicDate | dateTime | unixSeconds | integer
        bounds: closed | halfOpen
        cap: 100
        minimumWidth: 1
        field: /date
      request:             # Request Pagination Fields Object (§4.3)
        queryParameters:
          <param-name>:    # Request Field Object (§4.3.1)
            role: page | pageSize | offset | pageToken | cursor | previousPageToken | syncToken | windowStart | windowEnd | windowRange
            template: "period:{start}..{end}"   # windowRange only
            start: 0                           # page only; default 1
            required: false
        bodyFields: { ... }   # keys MAY use dot-notation for nested fields, e.g. metadata.continue
        headerFields: { ... }
      response:            # Response Pagination Fields Object (§4.4)
        envelope:          # Envelope Object (§4.4.2)
          itemsField: results
        shortPage:         # Short Page Object (§4.4.5); pageNumber only
          size: 100 | request
          assurance: documented | observed | assumed
        bodyFields:
          <field-name>:    # Response Field Object (§4.4.1), key MAY use dot-notation
            role: nextPageToken | nextCursor | nextLink | previousPageToken | previousLink | nextSyncToken | totalCount | totalPages | pageSize | currentPage | offset
            linkResolution:   # Link Resolution Object (§4.4.3); nextLink and previousLink only
              base: request | server | declared
              url: https://api.example.com/v2/   # only with base: declared
        headers:
          <header-name>: { ... }
```

---

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "MAY" are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A _scheme_ is a named entry in `components.paginationSchemes`.

A _field_ is a named entry in a Request or Response Pagination Fields Object.

---

## 4. Pagination Scheme Object

### 4.1 Pagination Scheme Object

Describes a single pagination strategy.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `SchemeType` (§4.2) | **Yes** | The kind of pagination. |
| `description` | string | No | Human-readable description. |
| `autoDetect` | boolean \| `AutoDetectObject` (§6.3) | No | Controls auto-detection. Default: `true` (use §6.2 rules). `false` disables auto-detection for this scheme. |
| `window` | `RangeWindowObject` (§4.6) | Conditional | REQUIRED when `type` is `rangeWindow`, and MUST NOT be present otherwise. Added in 0.5.0. |
| `request` | `RequestPaginationFieldsObject` (§4.3) | Conditional* | Describes pagination request fields. |
| `response` | `ResponsePaginationFieldsObject` (§4.4) | Conditional* | Describes pagination response fields. |
| `x-*` | any | No | Extension fields. |

\* At least one of `request` or `response` MUST be present.

### 4.2 Scheme Types

| Value | Description |
|-------|-------------|
| `pageNumber` | Page-number or offset-based pagination. The client increments a page number or offset with each request. |
| `pageToken` | Opaque cursor/token-based pagination. The server returns a token in the response; the client sends it back on the next request. |
| `nextLink` | Hypermedia-style pagination. The server returns the URL of the next page, either in a response header or body field, as an absolute URL or as a relative reference resolved by §4.4.3. The client follows the resolved URL directly, under the rules of §4.4.4. |
| `rangeWindow` | Added in 0.5.0. The operation has no page parameter, and each answer holds at most a fixed number of items (the `cap`). The client reads the collection one range of an item field at a time (a date window, say), and splits a window whose answer is full until every window's answer is below the cap. See §4.6. |
| `incrementalSync` | Delta/change-feed sync. The server returns a sync token on the **last** page of a full listing (instead of, or alongside, a next-page token); the client persists it and sends it back on a future request to receive only items changed since that point. Unlike `pageToken`, the token is not intended to page through the *current* result set — it seeds the *next* sync. |

### 4.3 Request Pagination Fields Object

Describes the fields the client sends to control pagination.

| Field | Type | Description |
|-------|------|-------------|
| `queryParameters` | `Record<string, RequestFieldObject>` | Query string parameters. Key is the parameter name. |
| `bodyFields` | `Record<string, RequestFieldObject>` | Fields in the JSON request body. Key is the field name, or a dot-path (e.g. `filter.updatedSince`) to address a nested field — see §4.4.2's `itemsField` for the same convention. |
| `headerFields` | `Record<string, RequestFieldObject>` | HTTP request headers. Key is the header name. |
| `x-*` | any | Extension fields. |

#### 4.3.1 Request Field Object

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Human-readable description. |
| `schema` | OAS Schema Object | JSON Schema describing the field value. |
| `role` | `RequestRole` (§4.5) | Semantic role of this field. |
| `required` | boolean | Whether this field is required. Default: `false`. |
| `start` | integer, at least 0 | Added in 0.6.0, and allowed only when `role` is `page`. The number of the first page. Default: `1`. A client asks for the first page with `start`, and for each next page with one more. |
| `template` | string | Added in 0.5.0, and allowed only when `role` is `windowRange`, where it is REQUIRED. The whole value the client sends, with `{start}` and `{end}` standing for the window's bounds written in the window's `format` (§4.6.2). Each placeholder appears exactly once, and no other `{` or `}` appears. Everything else is sent as written, before the parameter's ordinary serialization (percent-encoding in a query string, for example). |
| `x-*` | any | Extension fields. |

### 4.4 Response Pagination Fields Object

Describes the fields the client reads from the server response to determine the next page.

| Field | Type | Description |
|-------|------|-------------|
| `envelope` | `EnvelopeObject` (§4.4.2) | Locates the array of items being paginated within the response body. Defaults to the response body root. |
| `bodyFields` | `Record<string, ResponseFieldObject>` | Fields in the JSON response body. Key is the field name as it appears in the response, or a dot-path (e.g. `metadata.continue`, `tokenPagination.pageToken`) to address a field nested inside an object. Each path segment is a literal property name; a segment MUST be escaped as `["a.b"]` if it contains a literal `.`. |
| `headers` | `Record<string, ResponseFieldObject>` | HTTP response headers. Key is the header name. |
| `shortPage` | `ShortPageObject` (§4.4.5) | Added in 0.6.0, for `pageNumber` schemes only: a page with fewer items than a full page ends the list. |
| `x-*` | any | Extension fields. |

#### 4.4.1 Response Field Object

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Human-readable description. |
| `schema` | OAS Schema Object | JSON Schema describing the field value. |
| `role` | `ResponseRole` (§4.5) | Semantic role of this field. |
| `linkResolution` | `LinkResolutionObject` (§4.4.3) | How a relative reference in this field is resolved. Allowed only when `role` is `nextLink` or `previousLink`. When absent, a relative reference is resolved against the request URL, as with `base: request`. |
| `x-*` | any | Extension fields. |

#### 4.4.2 Envelope Object

Some APIs return the paginated array as the response body itself (`[ {...}, {...} ]`); others wrap it in an envelope alongside metadata (`{ "results": [ {...} ], "nextPageToken": "..." }`). The Envelope Object says which is which, so that both this extension and the [CRUD Causality Extension](../crud-causality/README.md) can locate the item array using the same convention.

| Field | Type | Description |
|-------|------|-------------|
| `itemsField` | string | Dot-path to the field holding the array of items (e.g. `results`, `data.items`). Omit, or set to `null`, when the response body root **is** the array. |
| `x-*` | any | Extension fields. |

#### 4.4.3 Link Resolution Object

Added in 0.4.0. Some APIs return the next page as a relative reference rather than a full URL. Classic Twilio, for example, returns `"next_page_uri": "/2010-04-01/Accounts/AC.../Applications.json?PageSize=1&Page=1&PageToken=PA..."`, documented as relative to `https://api.twilio.com`. The Link Resolution Object states which absolute URL such a reference is resolved against.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `base` | `"request"` \| `"server"` \| `"declared"` | **Yes** | The base URL a relative reference is resolved against; see the table below. |
| `url` | string | Conditional | An absolute `https` or `http` URL. REQUIRED when `base` is `declared`, and MUST NOT be present otherwise. It MUST NOT contain userinfo or a fragment. Its origin MUST be the origin of one of the server URLs listed for each operation that applies the scheme (validation rule 11). At runtime, a link resolved against it is still checked against the server the request was actually sent to (§4.4.4), so with any other listed server (a sandbox, say) its relative links are refused. |
| `description` | string | No | Human-readable description. |
| `x-*` | any | No | Extension fields. |

| `base` | Base URL |
|--------|----------|
| `request` | The absolute URL of the request whose response carried the link, as addressed to the API's server. This is the default when `linkResolution` is absent, and the base [RFC 8288 §3.2](https://www.rfc-editor.org/rfc/rfc8288#section-3.2) gives a `Link` header. |
| `server` | The server URL the request was sent to (the operation's, else the path item's, else the document's `servers` entry, with its variables substituted; a relative server URL is first resolved against the URL of the OpenAPI document; in Swagger 2.0, `scheme://host` plus `basePath`), with a `/` appended when its path does not already end in `/`. A server URL is treated as a directory because OpenAPI appends operation paths to it. |
| `declared` | The `url` field, used exactly as written. Write the trailing `/` when it is meant as a directory. |

A consumer resolves the field's value as follows:

1. An absent or `null` value, or an empty string, means there is no next (or previous) page. For a `Link` header, the value is the target URI reference (between `<` and `>`) of the link whose `rel` includes `next` (for `nextLink`) or `prev` or `previous` (for `previousLink`), after parsing the header as [RFC 8288 §3](https://www.rfc-editor.org/rfc/rfc8288#section-3) defines; an `anchor` parameter does not change the base.
2. A value MUST NOT be followed when it is not a string, or when it contains whitespace, an ASCII control character, a backslash (`\`) or any character outside ASCII; or when it starts with three or more slashes (`///x`); or when it starts with a scheme (`name:`) that is not followed by `//` (`https:x`, `https:/x`); or when its `//` is followed by an empty authority (`//`, `https:///x`). URL parsers disagree on all of these. For example, against the server `https://api.example.com/v1`, `///attacker.example/x` is a same-origin path to one parser, `https://attacker.example/x` to the WHATWG parser and an empty host to strict RFC 3986, so a consumer that checks with one parser and requests with another would leave the origin.
3. Otherwise the value is a URI reference ([RFC 3986 §4.1](https://www.rfc-editor.org/rfc/rfc3986#section-4.1)). It is resolved against the base URL with the strict algorithm of [RFC 3986 §5.2](https://www.rfc-editor.org/rfc/rfc3986#section-5.2), and the result serialised as §5.3 says; for an absolute URI this only removes dot segments. Other parsers (the WHATWG URL parser, urllib's `urljoin`) differ from RFC 3986 on some inputs, so this specification does not rely on them agreeing.
4. The resolved URL is then checked under §4.4.4 before it is requested.

The bases differ only for some references. An absolute-path reference (`/2010-04-01/...`) resolves to the same URL against every base on the same origin. A relative-path or query-only reference depends on the base: against the request URL `https://api.example.com/v2/items?page=1`, `?page=2` gives `https://api.example.com/v2/items?page=2`; against `base: server` with the server `https://api.example.com/v2`, it gives `https://api.example.com/v2/?page=2`.

A consumer that reaches the API through a proxy, or another route that rewrites URLs, resolves and checks the link against the provider-side URLs (the request URL as addressed to the API's server, and the server URL from the document). It then maps the resolved URL onto its route the same way it maps any operation URL. Resolving against the proxy's own URL would drop a proxy path prefix from every absolute-path reference. A next link may also climb out of the server URL's base path while staying on its origin (`/other/x` against the server `https://api.example.com/v1`); §4.4.4 allows that, so a proxy that maps links onto its route must not assume they stay under the base path.

This version does not cover two cases: a base read from the response itself (for example a `_links.base` field), and an absolute-path reference meant to be appended to the server URL's path rather than to replace it. An API that needs either needs a later version of this object.

#### 4.4.4 Following a link

Added in 0.4.0. These rules apply to every `nextLink` and `previousLink` value a consumer follows, from a body field or a header, absolute or relative, with or without `linkResolution`:

1. The resolved URL MUST have the same origin ([RFC 6454](https://www.rfc-editor.org/rfc/rfc6454): scheme, host and port, with default ports normalised and scheme and host compared case-insensitively) as the server URL the request was sent to. An `https` server therefore never pages onto `http`. Hosts are compared as ASCII strings: an internationalised host in a different form (Unicode against punycode) does not match, and the link is refused. Within that origin, any path is allowed.
2. The resolved URL MUST NOT contain userinfo (`user:password@`) or a fragment.
3. A link that fails rule 2 of §4.4.3, or either rule above, MUST NOT be requested, and no credential for the API may be sent to its URL. The consumer MUST end the read with an error. It MUST NOT treat the page as the last one, because a read that stops there is not complete. This matters to consumers of the [Collection Completeness](../collection-completeness/README.md) extension, which may infer deletions from a complete read.
4. The URL a consumer requests MUST be exactly the serialised URL that passed rules 1 and 2. It MUST NOT hand the raw value, or the base and the value, to another URL parser or HTTP client to resolve again.
5. A consumer SHOULD detect a link that resolves to a URL it already requested in the same read, and end the read with an error rather than loop.

An API whose next links legitimately point at another origin cannot be paged under these rules; this version has no field that widens the allowed origins.

#### 4.4.5 Short pages

Added in 0.6.0. Some page-number APIs answer only the items: no next token or
link, no count, no current page. ClickUp's filtered Workspace task list
documents "Responses are limited to 100 tasks per page" and a `page` that
"starts at 0", and its response holds only `tasks`. A client can then only
ask for the next page until one comes back with fewer items than a full
page. The Short Page Object says how many items a full page holds, and how
far the document vouches for a short page being the last one.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `size` | integer, at least 1, \| `"request"` | **Yes** | How many items a full page holds: a number, or `"request"` for the value the client sends in the scheme's `pageSize` field. With `"request"`, the scheme has a `pageSize` request field and the client always sends it. |
| `assurance` | `"documented"` \| `"observed"` \| `"assumed"` | **Yes** | What the claim that a short page is the last one rests on. `documented`: the provider's documentation says so (a page with fewer than `size` items, or an empty page, is the last one). `observed`: recorded responses show every page but the last full, but the provider does not promise it. `assumed`: neither; the documentation gives only a maximum page size. |
| `description` | string | No | Human-readable description, such as the source of the claim. |
| `x-*` | any | No | Extension fields. |

`shortPage` sits on the Response Pagination Fields Object (§4.4) of a
`pageNumber` scheme. A client that reads with it:

1. starts at the page the `page` field's `start` gives (§4.3.1), and asks for
   each next page by adding 1;
2. ends the traversal at the first page that holds fewer than `size` items,
   an empty page included, or at the end any other declared response field
   shows (`totalPages`, `totalCount`), whichever comes first;
3. ends the read with an error when a page answers with more than `size`
   items, since the declared size is then wrong, or when a page holds the same
   items, by identity, as the page before it, which a server that ignores an
   out-of-range `page` answers.

A short page ends the traversal under every `assurance`. Whether the read is
also complete, in the sense of [Collection Completeness](../collection-completeness/README.md)
("follows every page"), depends on it:

- With `documented`, a traversal ended by a short page followed every page.
- With `observed` or `assumed`, it did not establish that: a server can
  answer a short page before the end (a page cut short under load, or items
  dropped after paging because the caller may not see them), and nothing the
  client sees tells that apart from the end. The read is not complete, and a
  consumer of Collection Completeness infers nothing about absent objects
  from it. The items it returned are real items.

A short-page end is a claim about full pages, so a document MUST NOT declare
`documented` when the provider documents a filter applied after paging, a
page size that varies, or a maximum below which full pages may fall. Page
numbers over a collection that changes during the read can also skip or
repeat items (an item added before the current page shifts the rest by one),
as with any `page` or `offset` traversal; that is not specific to short pages,
and a read that must not miss such an item re-reads.

### 4.5 Semantic Roles

#### Request Roles

| Role | Scheme type | Description |
|------|-------------|-------------|
| `page` | `pageNumber` | Page number: 1 for the first page, unless the field's `start` (§4.3.1) says otherwise. |
| `pageSize` | all | Maximum number of items to return per page. |
| `offset` | `pageNumber` | 0-based item offset. |
| `pageToken` | `pageToken` | Opaque continuation token from the previous response. |
| `cursor` | `pageToken` | Synonym for `pageToken`. |
| `previousPageToken` | `pageToken` | Opaque token, from a `previousPageToken` response field, used to fetch the page before the current one. |
| `syncToken` | `incrementalSync` | Identifies a previous sync point. The server returns only items changed since that point. |
| `windowStart` | `rangeWindow` | The window's lower bound, written in the window's `format`. Used together with one `windowEnd` field. |
| `windowEnd` | `rangeWindow` | The window's upper bound, written in the window's `format`; inclusive or exclusive as the window's `bounds` says. |
| `windowRange` | `rangeWindow` | One field that carries both bounds, built from its `template`. Used instead of a `windowStart` and `windowEnd` pair. |

#### Response Roles

| Role | Scheme type | Description |
|------|-------------|-------------|
| `nextPageToken` | `pageToken` | Token to send with the next request. Absent or empty when there are no more pages. |
| `nextCursor` | `pageToken` | Synonym for `nextPageToken`. |
| `nextLink` | `nextLink` | URL of the next page: absolute, or a relative reference resolved by §4.4.3. Absent, `null` or empty when there are no more pages. |
| `previousPageToken` | `pageToken` | Token to send to fetch the previous page. Absent or empty when there is no previous page. |
| `previousLink` | `nextLink` | URL of the previous page: absolute, or a relative reference resolved by §4.4.3. Absent, `null` or empty when there is no previous page. |
| `nextSyncToken` | `incrementalSync` | Returned on the last page of a full listing, in place of (or alongside) `nextPageToken`. Persist it and send it back as `syncToken` on a future request to receive an incremental delta. |
| `totalCount` | all | Total number of items across all pages. |
| `totalPages` | `pageNumber` | Total number of pages. |
| `pageSize` | all | Number of items in the current page (as confirmed by the server). |
| `currentPage` | `pageNumber` | The current page number (as confirmed by the server). |
| `offset` | `pageNumber` | The current offset into the result set (as confirmed by the server). |

### 4.6 Range windows

Added in 0.5.0. Some list operations have no page parameter and answer at most a fixed number of items, but can select items by a range of one item field. Moneybird's `GET /{administration_id}/financial_mutations.json` is one: its description says it is "Limited to 100 financial mutations", and its `filter` parameter takes a `period` such as `20130101..20130131`. A `rangeWindow` scheme describes such an operation: which request field carries the range, how a bound is written, how many items an answer holds at most, and how narrow a window can be. A client then reads a range as a set of windows, each answered below the cap.

A `rangeWindow` scheme is never matched by auto-detection (§6): its window field is often a general filter parameter that other operations share, such as Moneybird's `filter`. It applies only to an operation that names it in `x-pagination` (§5), and its `autoDetect`, when present, MUST be `false`.

#### 4.6.1 Range Window Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `unit` | `"day"` \| `"second"` \| `"integer"` | **Yes** | The unit of a window's width and of its bounds: civil days, whole seconds, or integers (a sequence number, say). |
| `format` | string | **Yes** | How one bound is written (§4.6.2). It MUST fit `unit`. |
| `bounds` | `"closed"` \| `"halfOpen"` | **Yes** | `closed`: the window `[start, end]` includes both bounds, each as a whole `unit` (§4.6.2). `halfOpen`: `[start, end)` includes `start` and excludes `end`. A document declares `closed` only when the server compares that way, and otherwise `halfOpen`. There is no default, because a wrong guess either skips or doubles every boundary. |
| `cap` | integer, at least 1 | **Yes** | The most items one answer holds. An answer with `cap` items or more is _full_ (§4.6.4). |
| `minimumWidth` | integer, at least 1 | No | The narrowest window, in `unit`s, the operation selects correctly. Default: `1`. |
| `field` | JSON Pointer string | No | The item field the range selects on, relative to one item, as in the [Filtering proposal](../filtering/README.md)'s `x-filter.field`. A client MAY use it to check that each returned item lies inside its window. When absent, the document makes no claim about which field the operation compares. |
| `timeZone` | string | No | For `unit: day` only: whose civil days the bounds are, as an IANA time zone name or `unspecified`. Default: `unspecified`. It does not affect completeness (§4.6.4), since adjacent day windows meet whatever the zone; it tells a client which days a range such as "this year" covers. |
| `description` | string | No | Human-readable description. |
| `x-*` | any | No | Extension fields. |

A `rangeWindow` scheme's `request` MUST carry the window in exactly one of two ways: one field whose `role` is `windowRange`, with a `template`; or one field whose `role` is `windowStart` and one whose `role` is `windowEnd`. These fields may sit in `queryParameters`, `bodyFields` or `headerFields`. A `rangeWindow` scheme MAY also have a `response` with an `envelope` (§4.4.2) that locates the items.

#### 4.6.2 Bound formats

| `format` | `unit` | A bound is written as | Example |
|----------|--------|-----------------------|---------|
| `date` | `day` | An RFC 3339 `full-date` | `2026-01-31` |
| `basicDate` | `day` | The same date without separators, `YYYYMMDD` | `20260131` |
| `dateTime` | `second` | An RFC 3339 `date-time` in UTC, with `Z` and without fractional seconds | `2026-01-31T23:59:59Z` |
| `unixSeconds` | `second` | Whole seconds since 1970-01-01T00:00:00Z, in decimal | `1769903999` |
| `integer` | `integer` | A decimal integer, with `-` when negative and no leading zeros | `4711` |

A bound names one whole `unit`, so it covers every value of a more precise item field within that unit. With `closed` bounds, the upper bound `e` covers `[e, e + 1 unit)`: a window `[s, e]` of `unit: second` holds an item whose field is `12:00:00.500` when `e` is `12:00:00`, and the next window starts at `12:00:01`, so no value falls between two adjacent windows. A server whose closed upper bound compares as an instant (`<= 12:00:00.000`) does not compare this way, and a document then declares that operation `halfOpen` if the server allows it, or not as a `rangeWindow` at all.

Bounds are exact strings in these forms, never floats. A provider format outside this table (a month such as `202601`, or a time zone offset other than `Z`) needs a later version; until then a document does not declare such an operation as a `rangeWindow`.

#### 4.6.3 Reading a range

The range a client reads, `[S, E]` or `[S, E)` as `bounds` says, is the client's choice: like the [Filtering proposal](../filtering/README.md), this extension does not say which items a client should import. The _width_ of a window is its number of `unit`s: `end - start + 1` when `closed`, `end - start` when `halfOpen`.

1. The client SHOULD first request the whole range as one window.
2. When the answer is not full, its items are the window's items.
3. When the answer is full and the window is at least `2 × minimumWidth` wide, the client splits it into two adjacent windows and reads each with this same procedure. By default it halves, the first window holding the first `ceil(w / 2)` units of a window of width `w`: with `closed` bounds, `[s, e]` becomes `[s, s + ceil(w/2) - 1]` and `[s + ceil(w/2), e]`; with `halfOpen` bounds, `[s, e)` becomes `[s, s + ceil(w/2))` and `[s + ceil(w/2), e)`. A client MAY split elsewhere, or into more than two windows, as long as the windows are adjacent, each is at least `minimumWidth` wide, and together they are exactly the full window.
4. When the answer is full and the window is narrower than `2 × minimumWidth`, it cannot be split, and the read ends with an error (§4.6.4).
5. Every window request sends the same values for every other request field, including the text of a `template` outside `{start}` and `{end}`. A windowed read is a set of requests over one fixed selection.

Each window is one request, so it counts against any [Throttling](../throttling/README.md) limit the operation is under. How a client paces the requests, and how many it allows one read, is its own policy. As an order of magnitude (**estimated**, not a bound): with halving, a range of `w` units holding `n` items spread evenly needs about `1 + 2 × ceil(n / cap) × ceil(log2(w))` requests; items bunched in a few narrow windows need more.

In this version a `rangeWindow` operation has no page parameter, so an operation that applies a `rangeWindow` scheme applies no other scheme (validation rule 17). An API that caps the items one filter reaches across all of its pages needs a later version.

#### 4.6.4 Completeness

1. A window's answer with fewer than `cap` items is _complete for that window_: it holds every item the operation selected for that window when it answered.
2. An answer with `cap` items or more is _full_, and may have been cut short. A client MUST NOT treat its items as all of the window's items. It MAY keep them, since they are real items, but they do not make the window complete. An answer of exactly `cap` items counts as full even when nothing was left out, because a client cannot tell the two apart.
3. A read of the range is complete when the windows whose answers were complete for them are adjacent and together cover the range exactly. Windows MAY overlap (when a client re-reads a window, say); the client then keeps one item per identity, as the [CRUD Causality](../crud-causality/README.md) identity of the operation's resource says.
4. A read that ended with an error (§4.6.3 step 4, a non-2xx answer, or a window the client did not request because of its own request budget) is not complete, and MUST NOT be treated as complete; Whether to keep the items read so far is the client's choice.
5. A complete windowed read is complete only in the sense of this section: every window was answered below the cap. It is never a complete read in the sense of [Collection Completeness](../collection-completeness/README.md), whatever its outcome, so a consumer of that extension infers nothing about an object absent from it, whether the object's field lies inside the range or outside it. Allowing such an inference for a range-selected view needs a later version of Collection Completeness.
6. A windowed read is not a snapshot. An item whose field changes during the read can appear in two windows (and is kept once, by rule 3), or in none, when it moves from a window not yet read into one already read. A client that must not miss such an item re-reads, or uses an operation that offers a snapshot or a change feed.

_Non-normative note._ The Money app's Moneybird reader (`integrations/money/moneybird/read.ts` in ontola/atomic-plugins) reads financial mutations this way today, and writes nothing when a read ends with an error. Moneybird also documents a financial mutations synchronization API (`GET /{administration_id}/financial_mutations/synchronization`, which lists every mutation's id and version) as the way to read more than 100; the read-only OpenAPI document the overlays pin does not include it, and a document that does could describe that operation instead of, or alongside, a `rangeWindow`.

---

## 5. Overrides — Pagination Application Object

An individual operation may reference a scheme from `components.paginationSchemes` and optionally override parts of it. This is done via the `pagination` field on an OAS Operation Object.

```yaml
paths:
  /items:
    get:
      x-pagination:
        - scheme: pageToken
          overrides:
            request:
              queryParameters:
                continuation:
                  role: pageToken
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `scheme` | string | **Yes** | Key into `components.paginationSchemes`. |
| `overrides` | Partial `PaginationSchemeObject` | No | Deep-merged on top of the referenced scheme for this operation. |
| `description` | string | No | Human-readable description. |
| `x-*` | any | No | Extension fields. |

---

## 6. Auto-Detection

When an operation does not explicitly reference a scheme, tooling MAY attempt to infer which schemes apply by comparing the operation's parameters and response fields against the schemes defined in `components.paginationSchemes`.

### 6.1 Disabling Auto-Detection

Set `autoDetect: false` on a scheme to prevent it from being matched automatically.

### 6.2 Default Auto-Detection Rules

When `autoDetect` is `true` (the default), a scheme matches an operation when:

1. Every `queryParameters` key in the scheme's `request` is present in the operation's query parameters, **and**
2. Every `bodyFields` key in the scheme's `request` is present in the operation's request body schema.

(`matchQueryParams: true`, `matchBodyFields: true`, `requireAll: true` — see §6.3.)

Response fields and response headers are **not** considered by default.

### 6.3 Custom Auto-Detection — Auto-Detect Object

The `autoDetect` field may be an object for fine-grained control:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `matchQueryParams` | boolean | `true` | Require all scheme `queryParameters` to be present on the operation. |
| `matchBodyFields` | boolean | `true` | Require all scheme request `bodyFields` to be present in the request body. |
| `matchResponseFields` | boolean | `false` | Require all scheme response `bodyFields` to be present in the operation's response body. |
| `matchHeaders` | boolean | `false` | Require all scheme response `headers` to be present in the operation's response. |
| `requireAll` | boolean | `true` | `true` = ALL enabled dimensions must match. `false` = ANY enabled dimension is sufficient. |
| `x-*` | any | | Extension fields. |

**Example** — detect by response header only (e.g. `Link: rel="next"`):

```yaml
paginationSchemes:
  nextLink:
    type: nextLink
    autoDetect:
      matchQueryParams: false
      matchBodyFields: false
      matchHeaders: true
      requireAll: false
    response:
      headers:
        Link:
          role: nextLink
```

---

## 7. Applying via OpenAPI Overlays

The recommended way to add `paginationSchemes` to an existing API without modifying the original document is an [OpenAPI Overlay](https://spec.openapis.org/overlay/v1.0.0.html):

```yaml
overlay: 1.0.0
info:
  title: My API Pagination Schemes
  version: 1.0.0
actions:
  - target: $.components
    update:
      paginationSchemes:
        pageToken:
          type: pageToken
          request:
            queryParameters:
              pageToken:
                role: pageToken
              pageSize:
                role: pageSize
          response:
            bodyFields:
              nextPageToken:
                role: nextPageToken
```

**Swagger 2.0 documents (provisional).** A Swagger (OpenAPI 2.0) document has no `components` object, and its `definitions` may hold only Schema Objects. An overlay for such a document places the same map on the root object as the vendor extension `x-paginationSchemes`; `scheme` references in `x-pagination` then resolve against it. This keeps the document valid Swagger 2.0 and lets the overlay compose, but tooling support for reading the root member is declared, not verified, and the `components.paginationSchemes` form above stays the normative one.

---

## 8. Examples

### 8.1 Token-based pagination (Google-style)

```yaml
paginationSchemes:
  pageToken:
    type: pageToken
    request:
      queryParameters:
        pageToken:
          role: pageToken
        pageSize:
          role: pageSize
    response:
      bodyFields:
        nextPageToken:
          role: nextPageToken
```

### 8.2 Page-number pagination

```yaml
paginationSchemes:
  pageNumber:
    type: pageNumber
    request:
      queryParameters:
        page:
          role: page
        limit:
          role: pageSize
    response:
      bodyFields:
        total:
          role: totalCount
        totalPages:
          role: totalPages
        currentPage:
          role: currentPage
```

### 8.3 Link-header pagination (GitHub-style)

```yaml
paginationSchemes:
  nextLink:
    type: nextLink
    autoDetect:
      matchQueryParams: false
      matchBodyFields: false
      matchHeaders: true
      requireAll: false
    request:
      queryParameters:
        per_page:
          role: pageSize
    response:
      headers:
        Link:
          role: nextLink
```

### 8.4 Offset-based pagination

```yaml
paginationSchemes:
  offset:
    type: pageNumber
    request:
      queryParameters:
        start:
          role: offset
        num:
          role: pageSize
```

### 8.5 Enveloped response body

```yaml
paginationSchemes:
  pageToken:
    type: pageToken
    request:
      queryParameters:
        pageToken:
          role: pageToken
    response:
      envelope:
        itemsField: results
      bodyFields:
        nextPageToken:
          role: nextPageToken
```

Matches a response body shaped like:

```json
{
  "results": [ { "id": 1 }, { "id": 2 } ],
  "nextPageToken": "abc123"
}
```

### 8.6 Incremental sync (Google Calendar-style)

```yaml
paginationSchemes:
  eventSync:
    type: incrementalSync
    request:
      queryParameters:
        pageToken:
          role: pageToken
        syncToken:
          role: syncToken
    response:
      bodyFields:
        nextPageToken:
          role: nextPageToken
        nextSyncToken:
          role: nextSyncToken
```

The client pages through with `pageToken`/`nextPageToken` as usual. The **last** page omits `nextPageToken` and includes `nextSyncToken` instead; the client persists it and sends it back as `syncToken` on a later request to receive only the changes since that sync.

### 8.7 Bidirectional pagination (YouTube-style)

```yaml
paginationSchemes:
  pageToken:
    type: pageToken
    request:
      queryParameters:
        pageToken:
          role: pageToken
    response:
      bodyFields:
        nextPageToken:
          role: nextPageToken
        prevPageToken:
          role: previousPageToken
```

Matches a response body shaped like:

```json
{
  "nextPageToken": "CAUQAA",
  "prevPageToken": "CAUQAB",
  "pageInfo": { "totalResults": 1000, "resultsPerPage": 5 }
}
```

The YouTube Data API echoes either token back through the same `pageToken` request parameter, so only the response side needs to distinguish direction. Some cursor-based APIs instead expose two distinct request parameters — one per direction — which is what the `previousPageToken` request role is for:

```yaml
paginationSchemes:
  cursor:
    type: pageToken
    request:
      queryParameters:
        after:
          role: pageToken
        before:
          role: previousPageToken
    response:
      bodyFields:
        nextCursor:
          role: nextPageToken
        previousCursor:
          role: previousPageToken
```

### 8.8 Nested response body field paths (Kubernetes/Cloud Run-style)

```yaml
paginationSchemes:
  pageToken:
    type: pageToken
    request:
      queryParameters:
        continue:
          role: pageToken
    response:
      bodyFields:
        metadata.continue:
          role: nextPageToken
```

Matches a response body shaped like:

```json
{
  "items": [ { "id": 1 } ],
  "metadata": { "continue": "abc123" }
}
```

The same convention resolves the `tokenPagination.pageToken` field used by the Android Enterprise API.

### 8.9 Offset as a confirmed response field (Giphy-style)

```yaml
paginationSchemes:
  offset:
    type: pageNumber
    request:
      queryParameters:
        offset:
          role: offset
        limit:
          role: pageSize
    response:
      bodyFields:
        pagination.offset:
          role: offset
        pagination.total_count:
          role: totalCount
```

Matches a response body shaped like:

```json
{
  "data": [ { "id": "abc" } ],
  "pagination": { "offset": 0, "total_count": 100, "count": 25 }
}
```

### 8.10 Relative next links (classic Twilio-style)

```yaml
paginationSchemes:
  linkedCollections:
    type: nextLink
    autoDetect: false
    request:
      queryParameters:
        PageSize:
          role: pageSize
    response:
      bodyFields:
        next_page_uri:
          role: nextLink
          linkResolution:
            base: server
```

Matches a response body shaped like:

```json
{
  "calls": [ { "sid": "CA00000000000000000000000000000000" } ],
  "next_page_uri": "/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls.json?PageSize=50&Page=1&PageToken=PA00000000000000000000000000000000",
  "page": 0,
  "page_size": 50
}
```

With the server `https://api.twilio.com`, the next request goes to `https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls.json?PageSize=50&Page=1&PageToken=PA00000000000000000000000000000000`. A body whose `next_page_uri` is `https://attacker.example/steal` or `//attacker.example/steal` is not followed: it resolves outside the server's origin (§4.4.4), and the read ends with an error. [`examples/relative-next-link.yaml`](examples/relative-next-link.yaml) is a complete document of this shape.

### 8.11 Declared base

```yaml
paginationSchemes:
  linkedCollections:
    type: nextLink
    response:
      headers:
        Link:
          role: nextLink
          linkResolution:
            base: declared
            url: https://api.example.com/v2/
```

A `Link: <items?cursor=abc>; rel="next"` header then resolves to `https://api.example.com/v2/items?cursor=abc`, whatever the request URL was. [`examples/declared-base.yaml`](examples/declared-base.yaml) is a complete document of this shape.

### 8.12 Range windows over one filter parameter (Moneybird-style)

```yaml
paginationSchemes:
  periodWindows:
    type: rangeWindow
    autoDetect: false
    window:
      unit: day
      format: basicDate
      bounds: closed
      cap: 100
      field: /date
    request:
      queryParameters:
        filter:
          role: windowRange
          template: "period:{start}..{end}"
```

Reading the civil year 2026 starts with `filter=period%3A20260101..20261231`. When that answer holds 100 items, the client reads `period:20260101..20260702` (183 days) and `period:20260703..20261231` (182 days), and so on, down to single days. A single day whose answer holds 100 items ends the read with an error. [`examples/range-window.yaml`](examples/range-window.yaml) is a complete document of this shape.

### 8.13 Range windows over a pair of parameters

```yaml
paginationSchemes:
  changedWindows:
    type: rangeWindow
    autoDetect: false
    window:
      unit: second
      format: dateTime
      bounds: halfOpen
      cap: 500
      field: /updatedAt
    request:
      queryParameters:
        updatedFrom:
          role: windowStart
        updatedBefore:
          role: windowEnd
```

A full answer for `updatedFrom=2026-01-01T00:00:00Z&updatedBefore=2026-01-01T00:00:10Z` (10 seconds) is read again as `[00:00:00, 00:00:05)` and `[00:00:05, 00:00:10)`. This shape is a neutral example, not a claim about a particular API.

### 8.14 Zero-based pages ended by a short page (ClickUp-style)

```yaml
paginationSchemes:
  zeroBasedPages:
    type: pageNumber
    autoDetect: false
    request:
      queryParameters:
        page:
          role: page
          start: 0
    response:
      envelope:
        itemsField: tasks
      shortPage:
        size: 100
        assurance: assumed
        description: The documentation gives only "limited to 100 tasks per page".
```

The client asks for `page=0`, `page=1`, … and stops at the first page with fewer than 100 tasks. With `assurance: assumed` it has read every task the pages returned, but the read is not complete in the Collection Completeness sense (§4.4.5). [`examples/short-page.yaml`](examples/short-page.yaml) is a complete document of this shape.

---

## 9. Validation

A conforming implementation MUST enforce:

1. `type` MUST be one of `pageNumber`, `pageToken`, `nextLink`, `incrementalSync` or `rangeWindow`.
2. At least one of `request` or `response` MUST be present.
3. `role` values in request fields MUST be from: `page`, `pageSize`, `offset`, `pageToken`, `cursor`, `previousPageToken`, `syncToken`, `windowStart`, `windowEnd`, `windowRange` — or an `x-` prefixed extension.
4. `role` values in response fields MUST be from: `nextPageToken`, `nextCursor`, `nextLink`, `previousPageToken`, `previousLink`, `nextSyncToken`, `totalCount`, `totalPages`, `pageSize`, `currentPage`, `offset` — or an `x-` prefixed extension.
5. The `scheme` field in a Pagination Application Object (§5) MUST reference a key that exists in `components.paginationSchemes`.
6. `itemsField` in an Envelope Object, when present, MUST resolve to a field whose value is an array.
7. A dot-path key in `bodyFields` (request or response) MUST resolve, segment by segment, to a field nested inside the (request or response) body; each segment is a literal property name unless bracket-escaped (e.g. `["a.b"]`).
8. `linkResolution` MAY appear only on a Response Field Object whose `role` is `nextLink` or `previousLink`.
9. `base` MUST be one of `request`, `server` or `declared`. `url` MUST be present when `base` is `declared`, and MUST NOT be present otherwise.
10. `url` MUST be an absolute URL with the scheme `https` or `http`, without userinfo or a fragment.
11. When a scheme with a `declared` base is applied to an operation through `x-pagination` (§5), after its overrides are merged, the origin of `url` MUST equal the origin of one of the server URLs listed for that operation. A validator that cannot know a listed server's origin statically (a relative server URL, or a variable in its scheme, host or port) skips this check for that operation. An operation that a scheme reaches only by auto-detection (§6) is not checked statically at all. In both cases the runtime rules of §4.4.4 still apply.
12. `window` MUST be present when `type` is `rangeWindow`, and MUST NOT be present otherwise. Its `unit`, `format`, `bounds` and `cap` are REQUIRED; `cap` and `minimumWidth` are integers of at least 1; `field`, when present, is a JSON Pointer (empty, or starting with `/`); `timeZone` appears only with `unit: day`.
13. `format` MUST fit `unit`: `date` or `basicDate` with `day`, `dateTime` or `unixSeconds` with `second`, `integer` with `integer`.
14. The roles `windowStart`, `windowEnd` and `windowRange` appear only in a `rangeWindow` scheme. A `rangeWindow` scheme's `request` has either exactly one `windowRange` field and no `windowStart` or `windowEnd`, or exactly one `windowStart` and exactly one `windowEnd` field and no `windowRange`.
15. `template` appears only on a field whose `role` is `windowRange`, and such a field MUST have one. It contains `{start}` exactly once and `{end}` exactly once, and no other `{` or `}`.
16. A `rangeWindow` scheme's `autoDetect`, when present, MUST be `false`.
17. An operation whose `x-pagination` applies a `rangeWindow` scheme, after overrides are merged, applies exactly one scheme.
18. When a `rangeWindow` scheme applied to an operation carries its window in `queryParameters` or `headerFields`, after its overrides are merged, each window field MUST name a parameter of that operation (its own or its path item's, by `name` and `in`, `$ref`s to `components.parameters` resolved).

A consumer MUST also apply the runtime rules of §4.4.3 and §4.4.4 to every link it follows, and the reading and completeness rules of §4.6.3 and §4.6.4 to every windowed read.

19. `start` MAY appear only on a Request Field Object whose `role` is `page`, and is an integer of at least 0.
20. `shortPage` MAY appear only in the `response` of a `pageNumber` scheme. Its `size` is an integer of at least 1 or `"request"`, and its `assurance` one of `documented`, `observed` or `assumed`.
21. When `size` is `"request"`, the scheme, after overrides are merged, has a request field whose `role` is `pageSize`.
22. When a scheme with `shortPage` is applied to an operation, after its overrides are merged, it has a request field whose `role` is `page`.

A validation error SHOULD identify the precise location of the violation (e.g. `paginationSchemes.myScheme.request.queryParameters.page`).

---

## Schema, validator and tests

[`schema.json`](schema.json) is a JSON Schema (draft 2020-12) for the Pagination Scheme Object and the Pagination Application Object. It covers rules 1–4, 8–10, 12–16, 19 and 20. [`validate.py`](validate.py) checks a whole OpenAPI document (`components.paginationSchemes`, or the provisional Swagger 2.0 root `x-paginationSchemes` of §7) against that schema, and adds rules 5, 11, 17, 18, 21 and 22 (for Swagger 2.0, rule 18 reads the operation's and path item's `parameters` the same way, with `$ref`s to the root `parameters`). It also holds `read_pages`, a reference implementation of the page-number traversal with `start` and §4.4.5 over a caller-supplied request function, `read_range`, a reference implementation of §4.6.3 and §4.6.4 over a caller-supplied request function, and `resolve_link`, a reference implementation of §4.4.3 and §4.4.4 with its own strict RFC 3986 §5.2 resolution (`rfc3986_resolve`, tested against the RFC's §5.4 examples), which the tests exercise. Loop detection (§4.4.4 rule 5) is left to the consumer. The validator does not check rules 6 and 7, which need the response schemas. From the repository root:

```sh
python3 -m venv /tmp/pagination-schemes-venv
/tmp/pagination-schemes-venv/bin/pip install -r openapi-extensions/spec/pagination-schemes/requirements.txt
cd openapi-extensions/spec/pagination-schemes
/tmp/pagination-schemes-venv/bin/python -m unittest test_validate
/tmp/pagination-schemes-venv/bin/python validate.py examples/relative-next-link.yaml examples/declared-base.yaml examples/range-window.yaml examples/short-page.yaml
```

## Changes

- **0.6.0** (2026-10-08): adds `start` on a `page` request field (the first page number, default 1, so zero-based pages are described), and the Short Page Object (`shortPage` on a `pageNumber` scheme's response, §4.4.5): a page with fewer than `size` items ends the list, with an `assurance` (`documented`, `observed` or `assumed`) that decides whether such a read is complete for Collection Completeness; validation rules 19–22, `read_pages` in the validator, an example and tests. For pondersource/openapi-extensions#25 and ontola/atomic-plugins#385 (ClickUp). A document valid under 0.5.0 stays valid and means the same.
- **0.5.0** (2026-10-08): adds the `rangeWindow` scheme type for operations that answer at most a fixed number of items and have no page parameter, read one range of an item field at a time (§4.6): the Range Window Object (`window`: unit, bound format, closed or half-open bounds, cap, minimum width, the selected field and the day's time zone), the request roles `windowStart`, `windowEnd` and `windowRange`, the Request Field Object's `template`, the splitting procedure (halving by default), when a windowed read is complete, validation rules 12–18, and `read_range` in the validator. For ontola/atomic-plugins pieces.md K1 (Moneybird's financial mutations). A document valid under 0.4.0 stays valid.
- **0.4.0** (2026-10-08): `nextLink` and `previousLink` values may be relative references. Adds the Link Resolution Object (`linkResolution` on a Response Field Object, §4.4.3), the link-following rules (§4.4.4: the server's origin only, no userinfo or fragment, an unfollowable link ends the read with an error, the checked URL is the one requested, and loops are detected), the refusal of values parsers disagree on (§4.4.3 rule 2), validation rules 8–11, and the schema, validator and examples. A document valid under 0.3.0 stays valid. A consumer that followed links to another origin may no longer do so.
- **0.3.0** and earlier: no change log was kept.

## Reference Implementation

[`michielbdejong/openapi-pagination-client`](https://github.com/michielbdejong/openapi-pagination-client) — a TypeScript client library that drives pagination entirely from `paginationSchemes` definitions. The `src/types.ts` file mirrors this specification's objects 1:1.

## Overlay Collection

[`pondersource/overlays`](https://github.com/pondersource/overlays) — a collection of OpenAPI Overlays that add `paginationSchemes` to existing public APIs (GitHub REST API, 200+ googleapis.com APIs, and more).
