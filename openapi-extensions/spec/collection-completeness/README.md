# OpenAPI Collection Completeness Extension

**Spec version:** 0.2.0-draft

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
  member, and what an object's absence from such a read means;
* since 0.2.0, what a `404` or `410` means when a consumer reads an absent
  object by its own URL (`notFound`, §4.3), and what the members of a nested
  collection mean when the object that scopes it is itself absent
  (`parentAbsent`, §4.4).

It does not describe deletion feeds (tombstones, `deleted_since`
parameters); the [Deletion Feeds extension](../deletion-feeds/README.md)
does.

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

A nested collection whose absent objects must be read to be classified, and
whose members lose their scope when their parent goes (since 0.2.0):

```yaml
      collections:
        listTasks:
          urlTemplate: /lists/{listId}/tasks
          x-completeness:
            absent: removed
            notFound: unavailable   # §4.3
            parentAbsent: unavailable   # §4.4
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
sends, beyond the values the collection's read fixes (CRUD Causality 0.4.0
§4.2.1), no optional parameter that the API documents as narrowing the result
(a filter, a search term, a date range), and gets a successful response for
every page.

A _member_ is an object the collection's read can return under those
conditions: its `list` operation with the collection's fixed values, if any.

## 4. Object Definitions

### 4.1 Completeness Object

Placed under `x-completeness` on a CRUD Causality Collection Object, or on
the Operation Object of an operation that lists the collection. When both are
present, the Collection Object's applies.

On a Collection Object, the declaration covers reads of that collection as
the document defines it. Since CRUD Causality 0.4.0, a Collection Object can
fix a read's method, query parameters and request body (`listMethod`,
`listQuery`, `listBody`; CRUD Causality §4.2.1), and the declaration covers
reads with exactly those values. The same holds for a collection defined with
syncables' earlier extensions `x-list-method`, `x-list-query` and
`x-list-body`. On an Operation Object, the
declaration covers only a read that sends no query parameter and no request
body beyond what the operation requires (its path parameters). Several
collections can share one list URL with different fixed queries, and a
declaration on the shared operation says nothing about any of them. A read
that sends any further narrowing parameter, such as a user's filter
selection, is not a complete read (§3) under either placement.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `absent` | `deleted` \| `removed` | **Yes** | What it means when an object that was a member is absent from a complete read. See §4.2. |
| `notFound` | `deleted` \| `unavailable` | No | Since 0.2.0. What a `404` or `410` from the resource's `read` operation means for an object absent from a complete read. See §4.3. Default: `deleted`. Not allowed with `absent: deleted`. |
| `parentAbsent` | `deleted` \| `unavailable` | No | Since 0.2.0. What the members of this collection mean when the object that supplies one of its path variables is absent from a complete read of its own collection. See §4.4. Only on a Collection Object. |
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

For a resource that declares `x-read-tombstone` ([Deletion Feeds](../deletion-feeds/README.md)
0.2.0-draft, §4.4), the 404 or 410 of `deleted` includes a read tombstone: a
2xx read whose body carries the declared deletion marker.

`removed` still tells a consumer that the list does not filter by default; it
does not tell it whether the object exists. A consumer that needs to know
reads the object itself.

### 4.3 Reading an absent object

Added in 0.2.0. When a collection declares `absent: removed`, or no
Completeness Object, a consumer that wants to know what became of an absent
object reads it with the resource's `read` operation. The answer means:

| Answer | Meaning |
|--------|---------|
| 2xx, the object, without a read-tombstone marker | It exists; it left the collection (or, without a Completeness Object, the list does not return it). Its current values are the body. |
| 2xx, the object, with the resource's `x-read-tombstone` marker ([Deletion Feeds](../deletion-feeds/README.md) §4.4) | It was deleted, as that section defines, possibly restorably. |
| `404` or `410` | What `notFound` says (below). |
| Anything else, a failure, or no read made | Nothing: the object's state is unknown until a later read. |

| `notFound` | Meaning of a `404` or `410` |
|------------|-----------------------------|
| `deleted` (default) | The object was deleted. |
| `unavailable` | This caller can no longer read the object. The API does not say whether it was deleted, moved out of the caller's reach, or the caller lost access. |

For `unavailable`, a consumer MUST NOT report the object as deleted, and MUST
NOT infer any other state (completed, archived) from the answer. It keeps the
object's last known values, marked as unavailable. It MUST NOT send a write
it queued for the object without its user's or application's decision. A
later complete read that returns the object, or a later 2xx read of it,
supersedes the mark.

Declare `notFound: deleted` only when the provider documents a `404` or
`410` for its objects as their deletion, and `unavailable` when it does not
say, or documents other causes (a missing permission answered as `404`, a
deleted container). The default is `deleted` because 0.1.0 consumers read a
`404` that way; a new declaration SHOULD state `notFound` explicitly.

`notFound` is not allowed with `absent: deleted`: such a collection's absent
objects are deleted without a read, and §4.2 already says that their read
answers `404` or `410`.

How many absent objects a consumer reads in one pass is its own policy. An
object it does not read in a pass stays unknown, not deleted, until it does.

### 4.4 Nested collections

Added in 0.2.0. A collection is _nested_ when its `urlTemplate` has a path
variable that another resource's `identity.bindings` binds to one of that
resource's own fields (CRUD Causality §4.1.2): `/lists/{listId}/tasks` is
nested in task lists when the task-list resource binds `listId`. That
resource is the collection's _parent_, and the object whose field supplied
the variable for a read is the _parent object_ of that read. `parentAbsent`
requires exactly one parent: a collection with path variables bound by two
or more other resources has no single parent object, and this version does
not describe it.

`parentAbsent: deleted` also requires every Completeness Object of the
parent resource's collections to state `notFound` explicitly, so that a
`404` the parent's read answers for a missing permission cannot cascade as a
deletion of its members through the `deleted` default.

`parentAbsent` says what the members of a nested collection mean once a
consumer has concluded that their parent object is gone: it was absent from a
complete read of a parent-resource collection declared `absent: deleted`
(§4.2), or, absent from one declared `absent: removed`, its own read showed it
deleted or unavailable (§4.3). A parent object that its read shows still
exists has only left that collection; its nested collection is read as
before.

| `parentAbsent` | Meaning for each member last read in that parent object's collection |
|----------------|-----------------------------------------------------------------------|
| `deleted` | Deleted with its parent, when the parent was concluded deleted. Declare it only when the provider documents that deleting the parent deletes its members. For a parent concluded unavailable, the members are unavailable too. |
| `unavailable` | As `notFound: unavailable` (§4.3): it can no longer be read through this collection, and its fate is not known. |

A consumer applies it without reading the nested collection or its members:
that read would answer for a parent that is gone. When the parent object
returns in a later complete read, the nested collection is read again and its
members' marks are superseded by that read. Without `parentAbsent`, a
consumer draws no conclusion about the members: the nested collection can no
longer be read completely, so §3 applies.

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
collection. A collection defined with the fixed query parameter `state=all`
(CRUD Causality 0.4.0 `listQuery: {state: 'all'}`) is a different collection:
its read returns every
issue of the project, and its Collection Object can declare
`absent: removed` when issues can also be moved to another project, and
`absent: deleted` only when they cannot. The same declaration on the list
operation would not apply to that collection (§4.1).

### 6.1 Task lists and their tasks (since 0.2.0)

An API (shaped like Google Tasks) lists a user's task lists at
`/users/me/lists` and a list's tasks at `/lists/{listId}/tasks`. A task can be
moved to another list. A task read by id answers `200` with `deleted: true`
for a while after its deletion, and `404` later or when the caller cannot
reach it; the provider does not document which.

```yaml
components:
  crudResources:
    taskList:
      identity:
        urlTemplate: /users/me/lists/{listId}
        bindings:
          listId: { field: id }
      collections:
        taskLists:
          urlTemplate: /users/me/lists
          x-completeness:
            absent: removed
            notFound: unavailable
    task:
      identity:
        urlTemplate: /lists/{listId}/tasks/{taskId}
        bindings:
          taskId: { field: id }
      x-read-tombstone:          # Deletion Feeds §4.4
        field: deleted
        values: [true]
      collections:
        listTasks:
          urlTemplate: /lists/{listId}/tasks
          x-completeness:
            absent: removed
            notFound: unavailable
            parentAbsent: unavailable
```

After a complete read of `taskLists` and of each list's tasks:

* a task absent from its list's read is read by id: `200` with the task means
  it moved or left the list, `200` with `deleted: true` means deleted, `404`
  means unavailable;
* a list absent from the lists read is read by id; if it answers `404`, it is
  unavailable, and so is every task last read in it, without reading them.

## 7. Validation

A conforming document:

* MUST give `absent` one of the values in §4.2;
* MUST NOT declare `absent: deleted` for a collection whose objects can leave
  it without being deleted;
* SHOULD NOT declare a Completeness Object for a collection whose pages can
  skip members when the collection changes during the read (offset paging
  over a list from which objects are removed, typically), unless consumers
  can tell such a read apart; otherwise an object skipped by the paging looks
  absent;
* since 0.2.0: MUST give `notFound` and `parentAbsent`, when present, one of
  the values in §4.3 and §4.4; MUST NOT declare `notFound` together with
  `absent: deleted`; MUST declare `parentAbsent` only on a Collection Object
  of a nested collection (§4.4) with exactly one parent resource, which has
  at least one collection with a Completeness Object; MUST declare
  `parentAbsent: deleted` only when every Completeness Object of the parent
  resource's collections states `notFound` explicitly; MUST NOT declare
  `notFound: deleted` or `parentAbsent: deleted` without provider
  documentation for it.

A conforming consumer:

* MUST NOT draw a conclusion from an object's absence from a read that is not
  complete (§3): a page failed, a budget stopped it, or it sent a narrowing
  parameter;
* MAY treat an object absent from a complete read of a collection declared
  `absent: deleted` as deleted without reading it;
* SHOULD read the object itself (its `read` operation) before treating it as
  deleted when the collection declares no Completeness Object, or declares
  `absent: removed`;
* since 0.2.0: MUST classify that read's answer as §4.3 says, and MUST NOT
  report an `unavailable` object as deleted or infer another state from it;
* since 0.2.0: MUST NOT send a write it queued for an `unavailable` object
  without its user's or application's decision;
* since 0.2.0: MUST NOT apply `parentAbsent` before it has concluded, by §4.2
  or §4.3, that the parent object is deleted or unavailable.

## 8. Not covered

* Deletion feeds: a tombstone list or a `deleted_since` parameter that
  reports deletions directly. The [Deletion Feeds extension](../deletion-feeds/README.md)
  names such an operation for a collection (`x-deletion-feed`).
* Partial completeness (complete within a time window, or for the
  authenticated principal's own objects only). Describe those with the
  [Filtering proposal](../filtering/README.md) and leave this field out.
* States other than deletion that a read reports through a field (Todoist's
  `checked: true` for a completed task). They are values of the object, for a
  field map or a lens, not an outcome of its absence.
* How many absent objects a consumer reads per pass (§4.3): consumer policy.

## Validator and tests

[`validate.py`](validate.py) checks the document rules of §7 that a document
alone can show: the values of `absent`, `notFound` and `parentAbsent`,
`notFound` with `absent: deleted`, and that `parentAbsent` sits on a nested
collection whose parent has a Completeness Object. It cannot check the
evidence rules. It also holds `classify_read(...)` and `members_of_gone_parent(...)`,
reference implementations of §4.3 and §4.4. From the repository root:

```sh
cd openapi-extensions/spec/collection-completeness
pip install -r requirements.txt
python3 -m unittest test_validate
python3 validate.py examples/nested-tasks.yaml
```

## Changes

- **0.2.0-draft** (2026-10-08): adds `notFound` (§4.3: what a `404` or `410`
  from reading an absent object means, `deleted` by default or
  `unavailable`) and `parentAbsent` (§4.4: what the members of a nested
  collection mean once their parent object is gone), with document and
  consumer rules, an example, a validator and tests. A 0.1.0 document stays
  valid and means the same.
- 0.1.0-draft, 2026-10-08, wording only, no version change: §3 and §4.1
  refer to the fixed reads of CRUD Causality 0.4.0 (`listMethod`,
  `listQuery`, `listBody`); a complete read may send those values.
- **0.1.0-draft**: `absent: deleted | removed`.

## Reference Implementation

[`syncables`](../../../syncables/README.md#records-a-refresh-no-longer-returns)
reads `absent: deleted` (on the Collection Object, or on the list operation
of a collection without a fixed `x-list-query` or `x-list-body`) to treat a
record missing from a complete refresh as deleted without reading it. A
selection that adds or changes a query parameter of the collection, `removed`,
or no declaration makes it read the record first. Not verified against a real
provider. It does not yet read the 0.2.0 fields: it classifies every `404` or
`410` of that read as deleted (the `notFound` default), and has no
`unavailable` outcome or `parentAbsent` handling.
