# OpenAPI Pagination Schemes Extension

**Spec version:** 0.4.0

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
      type: pageNumber | pageToken | nextLink | incrementalSync
      autoDetect: true | false | AutoDetectObject
      request:             # Request Pagination Fields Object (§4.3)
        queryParameters:
          <param-name>:    # Request Field Object (§4.3.1)
            role: page | pageSize | offset | pageToken | cursor | previousPageToken | syncToken
            required: false
        bodyFields: { ... }   # keys MAY use dot-notation for nested fields, e.g. metadata.continue
        headerFields: { ... }
      response:            # Response Pagination Fields Object (§4.4)
        envelope:          # Envelope Object (§4.4.2)
          itemsField: results
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
| `x-*` | any | Extension fields. |

### 4.4 Response Pagination Fields Object

Describes the fields the client reads from the server response to determine the next page.

| Field | Type | Description |
|-------|------|-------------|
| `envelope` | `EnvelopeObject` (§4.4.2) | Locates the array of items being paginated within the response body. Defaults to the response body root. |
| `bodyFields` | `Record<string, ResponseFieldObject>` | Fields in the JSON response body. Key is the field name as it appears in the response, or a dot-path (e.g. `metadata.continue`, `tokenPagination.pageToken`) to address a field nested inside an object. Each path segment is a literal property name; a segment MUST be escaped as `["a.b"]` if it contains a literal `.`. |
| `headers` | `Record<string, ResponseFieldObject>` | HTTP response headers. Key is the header name. |
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

### 4.5 Semantic Roles

#### Request Roles

| Role | Scheme type | Description |
|------|-------------|-------------|
| `page` | `pageNumber` | 1-based page number. |
| `pageSize` | all | Maximum number of items to return per page. |
| `offset` | `pageNumber` | 0-based item offset. |
| `pageToken` | `pageToken` | Opaque continuation token from the previous response. |
| `cursor` | `pageToken` | Synonym for `pageToken`. |
| `previousPageToken` | `pageToken` | Opaque token, from a `previousPageToken` response field, used to fetch the page before the current one. |
| `syncToken` | `incrementalSync` | Identifies a previous sync point. The server returns only items changed since that point. |

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

---

## 9. Validation

A conforming implementation MUST enforce:

1. `type` MUST be one of `pageNumber`, `pageToken`, `nextLink`, or `incrementalSync`.
2. At least one of `request` or `response` MUST be present.
3. `role` values in request fields MUST be from: `page`, `pageSize`, `offset`, `pageToken`, `cursor`, `previousPageToken`, `syncToken` — or an `x-` prefixed extension.
4. `role` values in response fields MUST be from: `nextPageToken`, `nextCursor`, `nextLink`, `previousPageToken`, `previousLink`, `nextSyncToken`, `totalCount`, `totalPages`, `pageSize`, `currentPage`, `offset` — or an `x-` prefixed extension.
5. The `scheme` field in a Pagination Application Object (§5) MUST reference a key that exists in `components.paginationSchemes`.
6. `itemsField` in an Envelope Object, when present, MUST resolve to a field whose value is an array.
7. A dot-path key in `bodyFields` (request or response) MUST resolve, segment by segment, to a field nested inside the (request or response) body; each segment is a literal property name unless bracket-escaped (e.g. `["a.b"]`).
8. `linkResolution` MAY appear only on a Response Field Object whose `role` is `nextLink` or `previousLink`.
9. `base` MUST be one of `request`, `server` or `declared`. `url` MUST be present when `base` is `declared`, and MUST NOT be present otherwise.
10. `url` MUST be an absolute URL with the scheme `https` or `http`, without userinfo or a fragment.
11. When a scheme with a `declared` base is applied to an operation through `x-pagination` (§5), after its overrides are merged, the origin of `url` MUST equal the origin of one of the server URLs listed for that operation. A validator that cannot know a listed server's origin statically (a relative server URL, or a variable in its scheme, host or port) skips this check for that operation. An operation that a scheme reaches only by auto-detection (§6) is not checked statically at all. In both cases the runtime rules of §4.4.4 still apply.

A consumer MUST also apply the runtime rules of §4.4.3 and §4.4.4 to every link it follows.

A validation error SHOULD identify the precise location of the violation (e.g. `paginationSchemes.myScheme.request.queryParameters.page`).

---

## Schema, validator and tests

[`schema.json`](schema.json) is a JSON Schema (draft 2020-12) for the Pagination Scheme Object and the Pagination Application Object. It covers rules 1–4 and 8–10. [`validate.py`](validate.py) checks a whole OpenAPI document (`components.paginationSchemes`, or the provisional Swagger 2.0 root `x-paginationSchemes` of §7) against that schema, and adds rules 5 and 11. It also holds `resolve_link`, a reference implementation of §4.4.3 and §4.4.4 with its own strict RFC 3986 §5.2 resolution (`rfc3986_resolve`, tested against the RFC's §5.4 examples), which the tests exercise. Loop detection (§4.4.4 rule 5) is left to the consumer. The validator does not check rules 6 and 7, which need the response schemas. From the repository root:

```sh
python3 -m venv /tmp/pagination-schemes-venv
/tmp/pagination-schemes-venv/bin/pip install -r openapi-extensions/spec/pagination-schemes/requirements.txt
cd openapi-extensions/spec/pagination-schemes
/tmp/pagination-schemes-venv/bin/python -m unittest test_validate
/tmp/pagination-schemes-venv/bin/python validate.py examples/relative-next-link.yaml examples/declared-base.yaml
```

## Changes

- **0.4.0** (2026-10-08): `nextLink` and `previousLink` values may be relative references. Adds the Link Resolution Object (`linkResolution` on a Response Field Object, §4.4.3), the link-following rules (§4.4.4: the server's origin only, no userinfo or fragment, an unfollowable link ends the read with an error, the checked URL is the one requested, and loops are detected), the refusal of values parsers disagree on (§4.4.3 rule 2), validation rules 8–11, and the schema, validator and examples. A document valid under 0.3.0 stays valid. A consumer that followed links to another origin may no longer do so.
- **0.3.0** and earlier: no change log was kept.

## Reference Implementation

[`michielbdejong/openapi-pagination-client`](https://github.com/michielbdejong/openapi-pagination-client) — a TypeScript client library that drives pagination entirely from `paginationSchemes` definitions. The `src/types.ts` file mirrors this specification's objects 1:1.

## Overlay Collection

[`pondersource/overlays`](https://github.com/pondersource/overlays) — a collection of OpenAPI Overlays that add `paginationSchemes` to existing public APIs (GitHub REST API, 200+ googleapis.com APIs, and more).
