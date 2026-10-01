# OpenAPI Filtering Extension — proposal

**Spec version:** 0.1.0-draft

This proposal addresses [issue #17](https://github.com/pondersource/openapi-extensions/issues/17) and its review comments. It describes the API's selection semantics. It does not specify which filters a synchronizer should choose, how many requests it should make, or how it should organize imported tables.

## 1. One collection, multiple views

A filter changes which members an operation returns; it does not create a new resource type or a separately identified collection for every parameter value. Active and archived objects remain members of one collection. Their identity is independent of the filter through which they were discovered.

A collection need not have an endpoint that enumerates all its members without a filter. Required parameters remain standard OpenAPI Parameter Objects. Conditional requirements such as “provide either an incoming or outgoing direction” are deferred; this proposal does not add a parameter dependency language.

## 2. What standard OpenAPI already describes

Keep parameter names, locations, types, enumerations, defaults, requiredness and serialization in ordinary Parameter and Schema Objects. Use Link Objects to describe navigation from one response to another operation. Links already support operation IDs/references and bindings from request parameters, response headers and response body JSON Pointers.

For a single contact response, this is ordinary OpenAPI, with no extension:

```yaml
links:
  subscriptions:
    operationId: listSubscriptions
    parameters:
      path.administration_id: $request.path.administration_id
      query.contact_id: $response.body#/id
```

Names are location-qualified where needed to avoid two target parameters with the same name. Linked values remain typed values until the target operation applies its own parameter serialization. Do not percent-encode them as path fragments before placing them in a query string.

Links describe a possible operation relationship. Their existence does not order a client to follow them.

## 3. Proposed parameter annotation: `x-filter`

An optional `x-filter` on a Parameter Object relates its value to a field in each returned collection item:

| Field | Type | Meaning |
| --- | --- | --- |
| `field` | JSON Pointer string | Field relative to one logical collection item, not the whole response envelope. |
| `operator` | string | Initially `eq`, `gte`, `gt`, `lte`, or `lt`. |
| `description` | string | Qualifications not expressible by the simple predicate. |

Example, simplified from Moneybird's subscriptions API:

```yaml
parameters:
  - name: contact_id
    in: query
    required: true
    schema: { type: string }
    x-filter:
      field: /contact_id
      operator: eq
```

A response item belongs to the selected view when its logical `contact_id` equals the parameter value. This also permits a path parameter to describe a parent selector, without implying that the parent is part of the item's globally unique identity.

No annotation means “not described”, not “does not filter”. An absent optional parameter follows the API's documented default; this extension does not invent an unfiltered default. Composite search languages, overlap predicates, substring matching, disjunction and value-to-predicate maps are deferred rather than approximated by equality.

For example, a calendar's `timeMin` can involve an event's end time rather than its start time. An overlay must describe the documented predicate, not infer it from the parameter's name. The simple operators above must not be used when the API's actual comparison semantics differ.

### Logical fields omitted from the payload

A selector can imply a logical property such as archived state even if the response omits it. That implication does not assert that the wire response contains the property. The initial machine-readable annotation requires a field in the resource model; describing a logical field absent from the payload needs an explicit model/projection declaration. Until such a declaration exists, use prose rather than inserting a fabricated response field or creating another collection.

## 4. Authentication-dependent views

An endpoint described as “my issues” is not necessarily filtered by author: it may mean assignee, creator, participant or accessible-to-me. Its semantics must be taken from its API documentation.

Proposed operation annotation, separate from optional request filters:

```yaml
x-collection-scope:
  description: Issues created by the authenticated API user.
  constraints:
    - field: /user/id
      operator: eq
      authenticatedPrincipal: user
```

`authenticatedPrincipal: user` refers to the API's user identity. It does **not** mean an OAuth client ID, token string, arbitrary JWT `sub`, or the proxy's own logged-in user. If an API has a current-user operation, an ordinary Link to that operation can document how to obtain the corresponding user resource. No universal mapping between an OAuth subject and an API user ID is assumed.

The first draft models only a fixed implicit constraint. If a request parameter changes the role (e.g. creator versus assignee), describe the alternatives in prose until conditional predicates are specified. Readability/authorization restrictions are not asserted to be equality filters unless the API guarantees that relationship.

## 5. Remaining Link gap: each item in a response

Standard Links work for a single object or a fixed array index. JSON Pointer has no wildcard or “for each item” evaluation. `$response.body#/0/id` binds only the first object. It must not be presented as a complete traversal of a collection.

A narrowly scoped proposal is an optional `x-for-each` on a Link Object:

```yaml
links:
  subscriptions:
    operationId: listSubscriptions
    parameters:
      path.administration_id: $request.path.administration_id
    x-for-each:
      items: ''
      parameters:
        query.contact_id: /id
```

| Field | Type | Meaning |
| --- | --- | --- |
| `items` | JSON Pointer string | Array in the response body. Empty string selects a top-level array; `/items` selects an envelope array. |
| `parameters` | map of target parameter name to JSON Pointer | Values selected relative to the same array item. |

This extends Link evaluation rather than inventing another operation reference or URL-template syntax. Ordinary Link parameters retain standard runtime expressions and request/response context. Item parameter values use plain JSON Pointers, not new runtime-expression tokens. Extension-aware consumers derive one possible Link binding per array item. Clients that do not support the extension must not assume that the incomplete ordinary parameter map enumerates the collection.

All bindings for one invocation come from the **same** source request and the **same** source item. They are not independent value sets to combine. A missing item field leaves that Link unresolved; it must not reuse a previous item's value. A parameter cannot be supplied by both ordinary `parameters` and `x-for-each.parameters`.

This is separate from filtering: the Link explains where a valid parameter value comes from; `x-filter` explains what that value means to the target API's result set. Either can be useful independently.

### Concrete parent-context example

Suppose administration A returns contact `{id: 7}`, and administration B also returns contact `{id: 7}`. Following a subscriptions Link from A must retain `administration_id=A`; following B must retain B. Flattening all administration IDs and contact IDs into two global lists would also request invalid A/B combinations and could associate results with the wrong source context.

Likewise, a contact and a product can both contain an `id` field. A Link to a contact-filtered endpoint must bind the ID from the contact response, not any object whose property happens to be named `id`. The explicit source Link and per-item binding remove this ambiguity. This is the context/Cartesian-product concern raised in the issue; it is not a proposal to create a separate collection for every parent.

## 6. CRUD Causality simplification

The current CRUD spec duplicates navigation information with collection and identity URL templates. Several parts could reuse standard Links:

| Current purpose | Standard OAS reuse | Remaining CRUD semantics |
| --- | --- | --- |
| Navigate from create result to read operation | Response Link using `$response.header.Location` or a returned ID | Whether creation occurred, which fields the server added. |
| Navigate from an item to update/delete | Link referencing the target operation | Update/replace/delete effects and conflict semantics. |
| Navigate from list elements to item reads | Standard Link for a fixed object; proposed `x-for-each` for all items | Stable logical identity when no item-read endpoint exists. |
| Identify list operation | `operationId` / `operationRef` and response schema | Which logical collection is listed and how mutations affect membership. |

Do not remove canonical identity or CRUD effects merely because a navigation Link exists: a Link is not a guarantee of identity, mutation effect, inverse mapping, or complete enumeration. A follow-up version could make duplicate URL templates optional when a linked item operation and its parameter bindings fully determine the same identity. This draft does not silently change existing CRUD consumers.

The CRUD definition of collection should be clarified so caller-selected filters do not require separately named collections. Multiple collections remain useful only for distinct API-defined relationships, not every archived/active selector value.

## 7. Overlays and validation

An overlay can update a parameter with `x-filter`, an operation with `x-collection-scope`, or a response Link with `x-for-each`. Existing target existence and ordinary OpenAPI validation remain required.

Validators should check JSON Pointer syntax, target parameter existence and location, unique operation references, non-overlapping parameter bindings, item array shape where statically knowable, and equality/range operator compatibility with declared parameter and field types. Pagination does not change the Link context: each page binds its own response items while preserving the originating request parameters.

These extensions do not authorize HTTP requests or loosen origin/security checks. They do not set retry counts, import budgets, concurrency, or a requirement to enumerate every filter value.

## 8. Investigated examples and references

- [Moneybird subscriptions](https://developer.moneybird.com/api/subscriptions/): `contact_id` is a required query parameter, and subscription responses contain `contact_id`. This is a concrete equality selector and contact-to-subscriptions Link use case. It also shows why “one collection” does not imply an unfiltered list endpoint exists.
- [GitHub issue lists](https://docs.github.com/en/rest/issues/issues#list-issues-assigned-to-the-authenticated-user): the default authenticated-user view concerns assignments, and the `filter` parameter can select other relationships. Calling it “author equals me” without qualification would be wrong.
- [OpenAPI Link Objects and runtime expressions](https://spec.openapis.org/oas/v3.1.1.html#link-object): reuse these for operation navigation and scalar bindings; they do not define array iteration.
- [CRUD Causality](../crud-causality/README.md): identity and mutation effects still provide information beyond navigation.

## Reference implementation

Not yet published. The earlier local `listQueryBindings` experiment is not this specification and should not be treated as standardized API metadata.
