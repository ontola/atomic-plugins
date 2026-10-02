# OpenAPI CRUD Causality Extension

**Spec version:** 0.3.0

---

## 1. Introduction

Most HTTP APIs are a thin veneer over Create/Read/Update/Delete operations on a set of underlying objects. An OpenAPI document describes the shape of requests and responses, but it doesn't say what actually *happens* to server-side state when an operation runs: which object is affected, where its URL comes from, which fields the server fills in, or which collections it appears in.

The OpenAPI CRUD Causality Extension fills that gap. It adds:

* a `crudResources` map under `components`, describing the objects behind the API — their schema, their canonical URL, the collections they can belong to, and the other resources their own fields identify;
* a `crud` field on individual OAS Operation Objects, stating which CRUD action the operation performs and its effect on the resource and its collections.

Together these are enough to derive the full state-transition behaviour of the API: given the spec alone, a tool can build a stateful mock server (or a client-side cache) that creates, lists, reads, updates, and deletes objects exactly the way the real API does — including navigating from a `list` response straight to the `urlTemplate` of one of its elements, via `identity.bindings` (§4.1.2) — see [Reference Implementation](#reference-implementation).

The extension can be applied to existing OpenAPI documents without modification by using an [OpenAPI Overlay](https://spec.openapis.org/overlay/v1.0.0.html).

---

## 2. Overview

```yaml
components:
  crudResources:
    <resource-name>:            # CRUD Resource Object (§4.1)
      schema: { ... }           # OAS Schema Object, or $ref
      identity:
        urlTemplate: /widgets/{widgetId}
        bindings:                # Binding Object (§4.1.2) — how to fill in / read back {widgetId}
          widgetId:
            field: id
      references:                # Reference Object (§4.1.3) — foreign keys to other resources
        <reference-name>:
          resource: <other-resource-name>
          bindings:              # fills the TARGET resource's urlTemplate from THIS object's fields
            <target-variable>:
              field: <field-on-this-object>
      collections:
        <collection-name>:      # Collection Object (§4.2)
          urlTemplate: /widgets
          envelope:              # Envelope Object — shared with the Pagination Schemes Extension, §5
            itemsField: results

paths:
  /widgets:
    post:
      x-crud:                   # Operation CRUD Object (§4.3) — create
        action: create
        resource: <resource-name>
        url:
          source: header
          name: Location
        addedFields:
          <field-name>:          # Added Field Object (§4.4)
            source: generated
        memberOf: [ <collection-name> ]
    get:
      x-crud:                   # Operation CRUD Object (§4.3) — list
        action: list
        resource: <resource-name>
        collection: <collection-name>
  /widgets/{widgetId}:
    get:
      x-crud: { action: read, resource: <resource-name> }
    put:
      x-crud: { action: update, mode: replace, resource: <resource-name> }
    patch:
      x-crud: { action: update, mode: patch, patchFormat: jsonPatch, resource: <resource-name> }
    delete:
      x-crud: { action: delete, resource: <resource-name>, removesFrom: "*" }
```

---

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "MAY" are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A _resource_ is a named entry in `components.crudResources`, representing one kind of object behind the API (e.g. "widget").

A _collection_ is a named, ordered group of objects of a given resource type (e.g. "the widgets belonging to a user"). A resource MAY have more than one collection (e.g. `widgets` and `archivedWidgets`).

An _object_ is a single instance of a resource, identified by a URL.

---

## 4. Object Definitions

### 4.1 CRUD Resource Object

Describes one kind of object behind the API.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema` | OAS Schema Object | No | The shape of the object. |
| `description` | string | No | Human-readable description. |
| `identity` | `IdentityObject` (§4.1.1) | **Yes** | How an object's canonical URL is structured. |
| `references` | `Record<string, ReferenceObject>` (§4.1.3) | No | Named references from this object's fields to objects of another resource. |
| `collections` | `Record<string, CollectionObject>` (§4.2) | No | Named collections this resource can be a member of. |
| `x-*` | any | No | Extension fields. |

#### 4.1.1 Identity Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `urlTemplate` | string | **Yes** | URL template for a single object, e.g. `/widgets/{widgetId}`. Path parameter names SHOULD match the corresponding item-GET operation's path parameters. |
| `bindings` | `Record<string, BindingObject>` (§4.1.2) | No | Maps each `{variable}` in `urlTemplate` that is derivable from the object itself to the object field it comes from. Key is the template variable name. |
| `x-*` | any | No | Extension fields. |

#### 4.1.2 Binding Object

Normally there is no need to *construct* an object's URL — an operation that returns or accepts one just uses it as-is. The one place construction is needed is going from an element of a `list` response (§4.3.1) to that element's own URL: a collection response only contains the objects' fields, not their URLs, so a client needs a way to fill in `identity.urlTemplate`'s variables from those fields — and, conversely, given a URL (e.g. a `Location` header from `create`), to read an object field back out of it.

`bindings` is that map, and it is used in both directions:

* **Object → URL** (e.g. rendering a link for a `list` element): substitute each `{variable}` in `urlTemplate` with the value at `field`'s path in the object.
* **URL → object** (e.g. after `create` returns a `Location` header per §4.3.2): match the URL against `urlTemplate`, and treat the value captured for each bound `{variable}` as the value of the corresponding object `field` — this is how a client learns a server-`generated` id (§4.5) that's only ever seen embedded in a URL, never in a response body.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `field` | string | **Yes** | Dot-path to the object field this URL template variable corresponds to. |
| `x-*` | any | No | Extension fields. |

Not every `{variable}` in `urlTemplate` needs a binding. A variable that isn't listed in `bindings` MUST instead be resolvable from the request context the object was reached through — typically because the same variable name also appears in the `urlTemplate` of a collection (§4.2) the object is a member of, in which case it takes the value that was used to request that collection. For example, given:

```yaml
identity:
  urlTemplate: /users/{userId}/widgets/{widgetId}
  bindings:
    widgetId:
      field: id
collections:
  widgets:
    urlTemplate: /users/{userId}/widgets
```

`widgetId` comes from the `id` field of each widget object; `userId` isn't a field on the widget at all — it's simply carried over unchanged from whichever `/users/{userId}/widgets` request produced the list.

#### 4.1.3 Reference Object

A _reference_ states that an object of this resource identifies an object of another resource, by carrying that object's identifying values in its own fields — a foreign key.

This is the same substitution `identity.bindings` (§4.1.2) already performs in the **Object → URL** direction, with one difference: the URL template being filled is the *target* resource's `identity.urlTemplate`, and the values filling it come from the *referring* object's fields.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `resource` | string | **Yes** | Key into `components.crudResources` — the referenced resource. |
| `bindings` | `Record<string, BindingObject>` (§4.1.2) | **Yes** | Maps each `{variable}` in the **target** resource's `identity.urlTemplate` that is derivable from the referring object to the referring object field it comes from. |
| `required` | boolean | No | Whether the reference is always populated. Default: `true`. `false` means the referring fields MAY be absent or null, in which case the reference identifies no object. |
| `description` | string | No | Human-readable description. |
| `x-*` | any | No | Extension fields. |

To resolve a reference, substitute each `{variable}` in the target resource's `identity.urlTemplate` with the value at the corresponding `field`'s path in the referring object. A `{variable}` that is not listed in `bindings` MUST be resolvable from the request context the referring object was reached through — the same rule §4.1.2 states for unbound identity variables, and for the same reason: a parent scope such as `{workspaceId}` is usually shared by both resources and carried over unchanged from the request.

A reference asserts **identity only**. It does not assert that the referenced object exists, that it is readable with the same credentials, or that the document describes an operation returning it.

A reference is also not field expansion: an API that embeds the referenced object inline (e.g. `project: { id, name }`), or that offers an `?expand=` parameter to do so, is describing something this version does not cover.

### 4.2 Collection Object

Describes one named, ordered group of objects.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `urlTemplate` | string | No | URL template for the collection itself, e.g. `/widgets`, or `/users/{userId}/widgets`. |
| `description` | string | No | Human-readable description. |
| `envelope` | `EnvelopeObject` | No | Locates the array of items within a collection response body. Identical in shape to, and interchangeable with, the Envelope Object defined by the [Pagination Schemes Extension §4.4.2](../pagination-schemes/README.md#442-envelope-object) — see §5. Defaults to the response body root. |
| `x-*` | any | No | Extension fields. |

### 4.3 Operation CRUD Object

Placed under the `crud` field of an OAS Operation Object. States the CRUD action the operation performs.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `Action` (§4.3.1) | **Yes** | Which CRUD action this operation performs. |
| `resource` | string | **Yes** | Key into `components.crudResources`. |
| `description` | string | No | Human-readable description. |
| `url` | `UrlSourceObject` (§4.3.2) | Conditional* | Where the created object's URL comes from. |
| `addedFields` | `Record<string, AddedFieldObject>` (§4.4) | No | Fields the server sets that are not present in the request body. |
| `memberOf` | array of string | No | Collection names (§4.2) the object automatically joins on creation. |
| `collection` | string | Conditional** | Collection name (§4.2) this `list` operation returns. |
| `mode` | `replace` \| `patch` | Conditional*** | For `update`: whether the request body replaces the object wholesale or partially modifies it. |
| `patchFormat` | `PatchFormat` (§4.6) | No | For `update` with `mode: patch`: the patch document format. |
| `removesFrom` | array of string \| `"*"` | No | For `delete`: collection names the object is removed from. Default: `"*"` (every collection listed in that resource's `memberOf` history). |
| `x-*` | any | No | Extension fields. |

\* Required when `action` is `create`.
\** Required when `action` is `list`.
\*** Required when `action` is `update`.

#### 4.3.1 Actions

| Value | HTTP methods (typical) | Description |
|-------|------------------------|-------------|
| `create` | `POST` | Creates a new object. |
| `list` | `GET` (collection) | Returns a collection of objects. |
| `read` | `GET` (item) | Returns a single object. |
| `update` | `PUT`, `PATCH` | Modifies a single object; see `mode`. |
| `delete` | `DELETE` | Deletes a single object. |

#### 4.3.2 Url Source Object

Describes where the newly created object's URL is found.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | `header` \| `bodyField` \| `template` | **Yes** | Where to read the new object's URL from. |
| `name` | string | Conditional | Header name (if `source: header`) or dot-path to a response body field (if `source: bodyField`). Not used for `template`. |
| `x-*` | any | No | Extension fields. |

When `source: template`, the URL is derived by substituting the created object's fields (request body plus `addedFields`) into the resource's `identity.urlTemplate` (§4.1.1), using `identity.bindings` (§4.1.2) to know which field fills which variable.

Regardless of `source`, once the object's URL is known, `identity.bindings` MAY also be read in reverse: match the URL against `identity.urlTemplate` and treat the captured value for each bound `{variable}` as authoritative for the corresponding object field, even if that field isn't otherwise listed in `addedFields`.

### 4.4 Added Field Object

Describes one field the server sets on create that the client did not supply in the request body.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema` | OAS Schema Object | No | JSON Schema describing the field value. |
| `source` | `AddedFieldSource` (§4.5) | **Yes** | How the server determines the field's value. |
| `description` | string | No | Human-readable description. |
| `x-*` | any | No | Extension fields. |

### 4.5 Added Field Sources

| Value | Description |
|-------|-------------|
| `generated` | Server generates a fresh, unique value (e.g. `id`, `createdAt`). |
| `default` | Server applies a fixed or configured default when the client omits the field. |
| `computed` | Server derives the value from other fields on the same object. |

### 4.6 Patch Formats

| Value | Description |
|-------|-------------|
| `jsonPatch` | [RFC 6902](https://www.rfc-editor.org/rfc/rfc6902) JSON Patch — request body is an array of operations. |
| `jsonMergePatch` | [RFC 7396](https://www.rfc-editor.org/rfc/rfc7396) JSON Merge Patch — request body is a partial object merged into the existing one. |
| `custom` | API-specific partial-update format; describe it in the operation's `description`. |

---

## 5. Compatibility with the Pagination Schemes Extension

A `list` operation frequently also supports pagination. The same OAS Operation Object MAY carry both an `x-crud` field (this extension) and an `x-pagination` field ([Pagination Schemes Extension](../pagination-schemes/README.md)):

```yaml
paths:
  /widgets:
    get:
      x-crud:
        action: list
        resource: widget
        collection: widgets
      x-pagination:
        - scheme: pageToken
```

The two extensions locate the array of items in the response body the same way: via an `envelope` object of shape `{ itemsField: <dot-path> | omitted }`. This extension's `Collection Object` (§4.2) and the Pagination Schemes Extension's `Response Pagination Fields Object` (§4.4.2 there) both use it, so a single envelope description is valid, and SHOULD be kept consistent, across both extensions for the same operation.

---

## 6. Applying via OpenAPI Overlays

```yaml
overlay: 1.0.0
info:
  title: My API CRUD Causality
  version: 1.0.0
actions:
  - target: $.components
    update:
      crudResources:
        widget:
          identity:
            urlTemplate: /widgets/{widgetId}
          collections:
            widgets:
              urlTemplate: /widgets
  - target: $.paths['/widgets'].post
    update:
      x-crud:
        action: create
        resource: widget
        url: { source: header, name: Location }
        addedFields:
          id: { source: generated }
          createdAt: { source: generated }
        memberOf: [ widgets ]
  - target: $.paths['/widgets'].get
    update:
      x-crud:
        action: list
        resource: widget
        collection: widgets
  - target: $.paths['/widgets/{widgetId}'].get
    update:
      x-crud: { action: read, resource: widget }
  - target: $.paths['/widgets/{widgetId}'].put
    update:
      x-crud: { action: update, mode: replace, resource: widget }
  - target: $.paths['/widgets/{widgetId}'].delete
    update:
      x-crud: { action: delete, resource: widget, removesFrom: "*" }
```

**Swagger 2.0 documents (provisional).** A Swagger (OpenAPI 2.0) document has no `components` object, and its `definitions` may hold only Schema Objects. An overlay for such a document places the same map on the root object as the vendor extension `x-crudResources`; `resource` references in `x-crud` then resolve against it. This keeps the document valid Swagger 2.0 and lets the overlay compose, but tooling support for reading the root member is declared, not verified, and the `components.crudResources` form above stays the normative one.

---

## 7. Examples

### 7.1 Full widget lifecycle

```yaml
components:
  crudResources:
    widget:
      schema:
        $ref: '#/components/schemas/Widget'
      identity:
        urlTemplate: /widgets/{widgetId}
        bindings:
          widgetId:
            field: id
      collections:
        widgets:
          urlTemplate: /widgets
          envelope:
            itemsField: results

paths:
  /widgets:
    post:
      operationId: createWidget
      x-crud:
        action: create
        resource: widget
        url:
          source: header
          name: Location
        addedFields:
          id:
            schema: { type: string, format: uuid }
            source: generated
          createdAt:
            schema: { type: string, format: date-time }
            source: generated
        memberOf: [ widgets ]
    get:
      operationId: listWidgets
      x-crud:
        action: list
        resource: widget
        collection: widgets
      x-pagination:
        - scheme: pageToken

  /widgets/{widgetId}:
    get:
      operationId: getWidget
      x-crud:
        action: read
        resource: widget
    put:
      operationId: replaceWidget
      x-crud:
        action: update
        mode: replace
        resource: widget
    patch:
      operationId: patchWidget
      x-crud:
        action: update
        mode: patch
        patchFormat: jsonMergePatch
        resource: widget
    delete:
      operationId: deleteWidget
      x-crud:
        action: delete
        resource: widget
        removesFrom: "*"
```

### 7.2 Object with a client-supplied URL

Some `create` operations echo the object's URL in the response body instead of a `Location` header:

```yaml
post:
  x-crud:
    action: create
    resource: widget
    url:
      source: bodyField
      name: self.href
```

### 7.3 Object created into more than one collection

```yaml
post:
  x-crud:
    action: create
    resource: widget
    url: { source: header, name: Location }
    memberOf: [ widgets, recentWidgets ]
```

### 7.4 Delete removing an object from a single, specific collection

```yaml
delete:
  x-crud:
    action: delete
    resource: widget
    removesFrom: [ recentWidgets ]
```

### 7.5 Navigating from a nested `list` element to its item URL

`GET /users/{userId}/widgets` returns widgets that only carry their own `id`, not a `userId` field or a full URL:

```json
{
  "results": [ { "id": "w1", "name": "Left-handed sprocket" } ]
}
```

```yaml
components:
  crudResources:
    widget:
      identity:
        urlTemplate: /users/{userId}/widgets/{widgetId}
        bindings:
          widgetId:
            field: id
      collections:
        widgets:
          urlTemplate: /users/{userId}/widgets
          envelope:
            itemsField: results

paths:
  /users/{userId}/widgets:
    get:
      x-crud: { action: list, resource: widget, collection: widgets }
  /users/{userId}/widgets/{widgetId}:
    get:
      x-crud: { action: read, resource: widget }
```

To build the item URL for `{ "id": "w1", ... }` reached via `GET /users/42/widgets`: `widgetId` is bound to the object's `id` field (`w1`); `userId` isn't bound to a field, so it's carried over unchanged from the collection request (`42`) — giving `/users/42/widgets/w1`.

### 7.6 An object field that identifies another resource

A time entry carries the bare id of the project it was booked against — not a nested project object, and not a URL:

```json
{ "id": "te-1", "description": "Spec review", "projectId": "p-9" }
```

```yaml
components:
  crudResources:
    project:
      identity:
        urlTemplate: /workspaces/{workspaceId}/projects/{projectId}
        bindings:
          projectId:
            field: id
      collections:
        projects:
          urlTemplate: /workspaces/{workspaceId}/projects

    timeEntry:
      identity:
        urlTemplate: /workspaces/{workspaceId}/time-entries/{timeEntryId}
        bindings:
          timeEntryId:
            field: id
      references:
        project:
          resource: project
          required: false
          bindings:
            projectId:
              field: projectId
      collections:
        timeEntries:
          urlTemplate: /workspaces/{workspaceId}/time-entries
```

To resolve the referenced project for the time entry above, reached via `GET /workspaces/42/time-entries`: the target template's `projectId` variable is bound to the referring object's `projectId` field (`p-9`); `workspaceId` is not bound, so it carries over unchanged from the request (`42`) — giving `/workspaces/42/projects/p-9`.

Note the two bindings for the same target variable. `project.identity.bindings.projectId` reads a project's **own** `id` field; `timeEntry.references.project.bindings.projectId` reads the **time entry's** `projectId` field. They fill the same `{projectId}` variable and differ only in which object supplies the value.

---

## 8. Validation

A conforming implementation MUST enforce:

1. `action` MUST be one of `create`, `list`, `read`, `update`, `delete`.
2. `resource` MUST reference a key that exists in `components.crudResources`.
3. When `action` is `create`, `url` MUST be present.
4. When `action` is `list`, `collection` MUST be present and MUST reference a key in the resource's `collections`.
5. When `action` is `update`, `mode` MUST be present and MUST be one of `replace`, `patch`.
6. When `mode` is `patch`, `patchFormat` SHOULD be present.
7. Every name in `memberOf` and `removesFrom` (other than `"*"`) MUST reference a key in the resource's `collections`.
8. `identity.urlTemplate` (§4.1.1) and any `collections.*.urlTemplate` (§4.2) path parameters MUST be valid OAS path template syntax.
9. Every key in `identity.bindings` MUST correspond to a `{variable}` present in `identity.urlTemplate`.
10. Every `{variable}` in `identity.urlTemplate` that is not a key in `identity.bindings` SHOULD also appear, with the same name, in the `urlTemplate` of at least one collection the resource declares under `collections`.
11. Every `references.*.resource` (§4.1.3) MUST reference a key that exists in `components.crudResources`.
12. Every key in a `references.*.bindings` map MUST correspond to a `{variable}` present in the **target** resource's `identity.urlTemplate`.
13. Every `{variable}` in the target resource's `identity.urlTemplate` that is not a key in the reference's `bindings` SHOULD also appear, with the same name, in the `urlTemplate` of at least one collection the **referring** resource declares under `collections` — i.e. it is carried from request context rather than read off the referring object.

A validation error SHOULD identify the precise location of the violation (e.g. `paths./widgets.post.x-crud.url`).

---

## Reference Implementation

None yet. The motivating use case is a stateful mock API server, such as [`localthought/syncables`](https://github.com/localthought/syncables), driven entirely by this extension: given `crudResources` and `x-crud` annotations, the server can create objects with server-minted URLs and fields, add them to the right collections, serve single objects and paginated collections, apply replace/patch semantics, and delete objects (removing them from every collection they were added to) — without any hand-written business logic.
