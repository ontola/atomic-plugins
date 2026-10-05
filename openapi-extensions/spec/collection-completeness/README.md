# OpenAPI Collection Completeness Extension

**Spec version:** 0.1.0-draft

---

## 1. Introduction

A client that keeps a local copy of a collection reads it again from time to
time. When a record it had is no longer in the read, the client cannot tell
from the read alone why: the record may have been deleted, or the list may
just not return it (a default filter such as "open issues only", an
authentication-dependent view, a page size limit the client did not walk
past). The two cases need different handling. A pending local edit of a
deleted record must not be sent as if the record still existed (a `PUT` can
recreate it on some providers), while an edit of a record that a list merely
filters out is still valid.

The [Filtering proposal](../filtering/README.md) describes which members a
filter selects, and says explicitly that a missing annotation means "not
described", not "does not filter". Nothing in the existing extensions says
that a list is complete. This extension adds that one statement:

* an `x-completeness` field on a [CRUD Causality](../crud-causality/README.md)
  Collection Object (§4.2 there), or on the Operation Object of a `list`
  operation, stating that a complete read of the collection returns every
  member, and what an object's absence from such a read means.

It does not describe deletion feeds (tombstones, `deleted_since`
parameters); see §8.

## 2. Overview

```yaml
components:
  crudResources:
    pet:
      identity:
        urlTemplate: /pets/{petId}
        bindings:
          petId: { field: id }
      collections:
        pets:
          urlTemplate: /pets
          x-completeness:        # Completeness Object (§4.1)
            absent: deleted
```

Or, for a document without `crudResources`, on the list operation itself:

```yaml
paths:
  /pets:
    get:
      x-completeness:
        absent: deleted
```

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "MAY" are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A _complete read_ of a collection is a read of its `list` operation that
follows every page (per the [Pagination Schemes Extension](../pagination-schemes/README.md),
where the operation is paginated), binds the collection's path parameters,
sends no optional parameter that the API documents as narrowing the result
(a filter, a search term, a date range), and gets a successful response for
every page.

A _member_ is an object the collection's `list` operation can return under
those conditions.

## 4. Object Definitions

### 4.1 Completeness Object

Placed under `x-completeness` on a CRUD Causality Collection Object, or on
the Operation Object of an operation that lists the collection. When both are
present, the Collection Object's applies.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `absent` | `deleted` \| `removed` | **Yes** | What it means when an object that was a member is absent from a complete read. See §4.2. |
| `description` | string | No | Human-readable description. |
| `x-*` | any | No | Extension fields. |

By declaring a Completeness Object, the document states that a complete read
returns every object that is a member both when the read starts and when it
ends. An object that becomes a member, or stops being one, during the read
MAY be present or absent.

### 4.2 Absence values

| Value | Meaning of an absent object |
|-------|-----------------------------|
| `deleted` | It no longer exists: the resource's `read` operation, if it has one, answers 404 or 410 for it. Objects are members of this collection for as long as they exist (no archiving, no moving to another collection). |
| `removed` | It is no longer a member of this collection. It MAY still exist, for example archived or moved to another collection, and remain readable and writable through its own URL. |

`removed` still tells a consumer that the list does not filter by default; it
does not tell it whether the object exists. A consumer that needs to know
reads the object itself.

## 5. Applying via OpenAPI Overlays

```yaml
overlay: 1.0.0
info:
  title: Declare the pets collection complete
  version: 1.0.0
actions:
  - target: $.components.crudResources.pet.collections.pets
    update:
      x-completeness:
        absent: deleted
```

An overlay author SHOULD have evidence for the declaration (provider
documentation, or observed behaviour) and SHOULD cite it in the overlay's
`description`. A wrong `deleted` declaration makes a consumer treat filtered
objects as deleted.

## 6. Examples

A to-do API whose `GET /projects/{projectId}/tasks` returns every task of a
project, open and done, and where a task only leaves the list by being
deleted:

```yaml
components:
  crudResources:
    task:
      identity:
        urlTemplate: /tasks/{taskId}
        bindings:
          taskId: { field: id }
      collections:
        projectTasks:
          urlTemplate: /projects/{projectId}/tasks
          x-completeness:
            absent: deleted
```

An (invented) issue tracker whose `GET /projects/{projectId}/issues` returns
open issues only by default declares no Completeness Object for that
collection. If a fixed query parameter such as `state=all` makes the read
return every issue of the project, a collection defined with that parameter
can declare `absent: removed` when issues can also be moved to another
project, and `absent: deleted` only when they cannot.

## 7. Validation

A conforming document:

* MUST give `absent` one of the values in §4.2;
* MUST NOT declare `absent: deleted` for a collection whose objects can leave
  it without being deleted;
* SHOULD NOT declare a Completeness Object for a collection whose pages can
  skip members when the collection changes during the read (offset paging
  over a list from which objects are removed, typically), unless consumers
  can tell such a read apart; otherwise an object skipped by the paging looks
  absent.

A conforming consumer:

* MUST NOT draw a conclusion from an object's absence from a read that is not
  complete (§3): a page failed, a budget stopped it, or it sent a narrowing
  parameter;
* MAY treat an object absent from a complete read of a collection declared
  `absent: deleted` as deleted without reading it;
* SHOULD read the object itself (its `read` operation) before treating it as
  deleted when the collection declares no Completeness Object, or declares
  `absent: removed`.

## 8. Not covered

* Deletion feeds: a tombstone list or a `deleted_since` parameter that
  reports deletions directly. A later version may add a way to name such an
  operation for a collection.
* Partial completeness (complete within a time window, or for the
  authenticated principal's own objects only). Describe those with the
  [Filtering proposal](../filtering/README.md) and leave this field out.

## Reference Implementation

[`syncables`](../../../syncables/README.md#records-a-refresh-no-longer-returns)
reads `absent: deleted` (on the Collection Object, or on the list operation)
to treat a record missing from a complete refresh as deleted without reading
it; `removed`, or no declaration, makes it read the record first. Not
verified against a real provider.
