# OpenAPI Produced Classes Extension

**Spec version:** 0.1.0-draft

---

## 1. Introduction

A sync client that copies an API's objects into a local table needs to know
which kind of row each object becomes. Today that knowledge is code: each
integration knows that a Clockify time entry becomes a "time entry" row, that
a GitHub issue becomes an "issue" row. The [CRUD Causality
extension](../crud-causality/README.md) already names the kinds of objects
behind an API (`components.crudResources`), but only by an API-local name
such as `timeEntry`, which says nothing about a shared vocabulary.

This extension adds one statement to a CRUD Resource Object:

* an `x-produces` field, listing the shared classes (by their subject URIs,
  for example classes of an RDF or Atomic Data ontology) that an object of
  this resource can be represented as, each optionally with a lens: a
  separately published mapping document from the resource's objects to that
  class.

A consumer can then offer the resource wherever a table of that class is
wanted (a "Connect" offer), and look up how to map it, without
per-provider code. The extension does not define a mapping format, does not
say how a class is dereferenced or what its properties are, and does not
make the document depend on any particular data platform: a consumer that
does not know a class ignores the declaration.

It was written for ontola/atomic-plugins `docs/design/pieces.md` D4 and I1:
a catalog entry or overlay may declare the shared ontology class an
integration produces, and the integration proxy carries that declaration as
metadata without understanding it.

## 2. Overview

```yaml
components:
  crudResources:
    timeEntry:                   # CRUD Resource Object (CRUD Causality §4.1)
      identity: { urlTemplate: /time-entries/{id} }
      collections:
        entries: { urlTemplate: /time-entries }
      x-produces:                # Produced Class Object list (§4.1)
        - class: https://ontology.example/classes/time-entry-v1
          lens: https://ontology.example/lenses/example-time-entry-v1
```

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "MAY" are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A _class_ is a type of record in some shared vocabulary, named by an
absolute URI (its _subject_). A _lens_ is a document, also named by an
absolute URI, that maps an object of a resource to an instance of a class
and, where it can, back. Neither is defined here.

An _absolute URI_ is a URI with a scheme, per
[RFC 3986 §4.3](https://www.rfc-editor.org/rfc/rfc3986#section-4.3): no
relative references, no whitespace. `https` subjects are RECOMMENDED.

## 4. Object Definitions

### 4.1 `x-produces`

`x-produces` is a field of a CRUD Resource Object
([CRUD Causality §4.1](../crud-causality/README.md#41-crud-resource-object)),
whether that object sits in `components.crudResources` or, in a Swagger 2.0
document, in the root `x-crudResources` (CRUD Causality §6). Its value is a
nonempty array of Produced Class Objects (§4.2).

It states that every object of this resource, as read from any of its
collections or its item URL, can be represented as an instance of each
listed class. It does not state that the representation is lossless, that
every field of the object has a place in the class, or that the class
requires nothing the object lacks; a lens, where given, says that.

The declaration is per resource, not per collection or operation: all
collections of a resource hold objects of the same kind. A field of this
name anywhere else in the document has no meaning under this version.

### 4.2 Produced Class Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `class` | string (absolute URI) | **Yes** | The class subject. |
| `lens` | string (absolute URI) | No | A mapping document from this resource's objects to `class`. |
| `description` | string | No | Human-readable notes, such as which objects map poorly. |
| `x-*` | any | No | Extension fields. |

Within one `x-produces` array, each `class` appears at most once.

A consumer MUST NOT assume a field mapping from `class` alone: without a
`lens` the declaration only says which tables the resource is meant for. A
consumer that cannot fetch or does not understand a `lens` treats the entry
as if it had none. This extension requires no fetch of a `class` or `lens`
URI; whether and from where a consumer fetches them is its own policy.

### 4.3 What a passing intermediary does

A proxy or catalog service that composes and serves an OpenAPI document
(such as `/catalog/<name>.yaml` of ontola/atomic-plugins'
`integration-proxy`) SHOULD pass `x-produces` through unchanged. It needs no
knowledge of the classes or lenses and MUST NOT change its own behaviour
because of them.

## 5. Applying via OpenAPI Overlays

The declaration is added to an existing document with an
[OpenAPI Overlay](https://spec.openapis.org/overlay/v1.0.0.html) action whose
target is the CRUD Resource Object:

```yaml
overlay: 1.0.0
info: { title: Produced classes for Example Timesheets, version: 1.0.0 }
actions:
  - target: $.components.crudResources.timeEntry
    update:
      x-produces:
        - class: https://ontology.example/classes/time-entry-v1
```

That overlay is applied after the overlay that adds `crudResources`.

**Catalog fallback (not part of this extension).** Where the CRUD Resource
Objects are not available to annotate, a dated catalog in
ontola/atomic-plugins (`overlays/catalog/`) MAY carry the same declaration in
a platform entry's `selection`, as `x-produces`: an object whose keys are
CRUD resource names and whose values are Produced Class Object arrays. The
integration proxy serves it unchanged at `/catalog/<name>.selection.json`. A
declaration in the document takes precedence over one in the selection for
the same resource. This is a convention of that catalog format, recorded
here so that the two placements cannot drift apart; [`validate.py`](validate.py)
checks it with `validate_selection`.

## 6. Examples

### 6.1 One class, with a lens

```yaml
components:
  crudResources:
    timeEntry:
      identity:
        urlTemplate: /workspaces/{workspaceId}/time-entries/{id}
        bindings: { id: { field: id } }
      collections:
        entries: { urlTemplate: /workspaces/{workspaceId}/time-entries }
      x-produces:
        - class: https://ontola.github.io/atomic-plugins/ontology/classes/time-entry-v1
          lens: https://ontola.github.io/atomic-plugins/ontology/lenses/clockify-time-entry-v1
```

### 6.2 One resource, two classes

A task API whose tasks fit both an issue table and a to-do table:

```yaml
x-produces:
  - class: https://ontology.example/classes/issue-v1
    description: Labels map to issue labels; subtasks are not represented.
  - class: https://ontology.example/classes/todo-v1
```

[`examples/time-entries.yaml`](examples/time-entries.yaml) is a complete
synthetic document.

## 7. Validation

1. `x-produces` MUST appear only on a CRUD Resource Object: directly under
   a key of `components.crudResources`, or of the root `x-crudResources`.
2. Its value MUST be a nonempty array.
3. Each element MUST be an object with a `class`, and MAY have `lens`,
   `description` and `x-*` fields; no other fields.
4. `class` and `lens` MUST be absolute URIs (§3).
5. A `class` MUST NOT appear twice in one array.
6. `description` MUST be a string.

For the catalog fallback (§5), a selection's `x-produces` MUST be an object
whose keys are names of CRUD resources in the composed document and whose
values obey rules 2–6.

A validation error SHOULD identify the precise location of the violation
(e.g. `components.crudResources.timeEntry.x-produces[0].class`).

## Validator and tests

[`validate.py`](validate.py) checks rules 1–6 for a loaded OpenAPI document
(`validate`) and the catalog fallback (`validate_selection`).
[`test_validate.py`](test_validate.py) covers each rule. It does not fetch or
check any class or lens URI. From the repository root:

```sh
cd openapi-extensions/spec/produced-classes
pip install -r requirements.txt
python3 -m unittest test_validate
python3 validate.py examples/time-entries.yaml
```

## Changes

- **0.1.0-draft** (2026-10-08): first draft, for ontola/atomic-plugins
  `docs/design/pieces.md` D4 and I1.

## Open points

- Per collection or per operation (pieces.md O8): this draft declares per
  resource, on the reasoning in §4.1. A collection-level override would be
  an addition, not a change.
- The field mapping (O8) is left to a lens; this extension does not define
  one. ontola/atomic-plugins' lens documents (`ontology/lenses/`) are one
  such format.
- Class subjects on a provisional base (github.io in ontola/atomic-plugins,
  O11): whether a declaration using one inherits that repository's
  `enabled: false` gate is not settled here.

## Reference Implementation

ontola/atomic-plugins' `integration-proxy` passes the declaration through
unchanged (§4.3), in `/catalog/<name>.yaml` and `/catalog/<name>.selection.json`,
and tests that it does. No consumer reads it yet.
