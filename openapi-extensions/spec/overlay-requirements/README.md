# OpenAPI Overlay Requirements Extension

**Spec version:** 0.1.0-draft

---

## 1. Introduction

An [OpenAPI Overlay](https://spec.openapis.org/overlay/v1.0.0.html) changes
one target document. Many overlays are written to be applied together with
others: a Collection Completeness overlay that adds `x-completeness` to a CRUD
Causality collection is only meaningful once a CRUD Causality overlay has
declared that collection, and it may be meaningful for one revision of that
overlay and wrong for another. Asana's completeness overlay in
ontola/atomic-plugins, for example, is written for the collections of its
`crud-causality-v2` revision (ontola/atomic-plugins#632); a catalog that
selected it with `crud-causality` v1 would apply its claims to collections
they were not written for.

Overlay 1.0 has no field for this. A tool that composes a platform from
several overlays (a catalog, a build script) cannot check that it applies the
overlays an overlay was written for, and none that contradict it. This
extension adds two fields to the Overlay's Info Object:

* `x-requires`: groups of overlays, each group met when any one of its
  overlays is applied to the same target document;
* `x-conflicts`: overlays that MUST NOT be applied together with this one.

It says nothing about order. Overlays whose actions only deep-merge (as
`update` actions on `$.components` do) compose in either order; one that
depends on order says so in its description.

## 2. Overview

```yaml
overlay: 1.0.0
info:
  title: Asana API task completeness
  version: 1.0.0
  x-requires:
    - anyOf: [crud-causality-v2-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml]
  x-conflicts:
    - crud-causality-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml
extends: https://raw.githubusercontent.com/ontola/openapi-directory/b58c91d9f59c6a10178916e7948793809edae46d/APIs/asana.com/1.0/openapi.yaml
actions: []
```

A composition that applies this overlay MUST also apply `crud-causality-v2-…`
to the same document, and MUST NOT apply `crud-causality-…` (v1).

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "MAY" are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

An overlay is named by a URI reference. A relative reference is resolved
against the URL the overlay itself was retrieved from ([RFC 3986
§5](https://www.rfc-editor.org/rfc/rfc3986#section-5)); a bare filename
therefore names a sibling in the same folder. Two references name the same
overlay when they resolve to the same URL, compared as strings.

A _composition_ is the set of overlays a tool applies to one target
document, identified by their resolved URLs.

## 4. Object Definitions

Both fields sit on the Overlay's [Info Object](https://spec.openapis.org/overlay/v1.0.0.html#info-object),
which allows specification extensions.

| Field | Type | Description |
|-------|------|-------------|
| `x-requires` | array of group objects | Nonempty. Each group has one `anyOf` field, a nonempty array of URI references listing alternatives: the group is met when the composition holds at least one of them. Every group MUST be met. |
| `x-conflicts` | array of URI references | Nonempty. The composition MUST NOT hold any of them. |

A reference MUST NOT name the overlay itself, and the same overlay MUST NOT
appear both in a group of `x-requires` and in `x-conflicts`. Every overlay a
reference names SHOULD extend the same target document (`extends`) as the
overlay that names it; a tool that can read the named overlay SHOULD check it.

A requirement is not transitive by itself: when A requires B and B requires
C, a composition with A and B must also meet B's own groups, because B is in
it; the tool checks every overlay of the composition.

## 5. Applying via OpenAPI Overlays

These fields describe overlays, so they are written in the overlay itself, not
applied by another one. An overlay that is already published and cannot
change can be described by the tool that composes it instead (a table of
requirements kept beside the catalog); when both exist, the overlay's own
fields win.

## 6. Examples

[`examples/requires.yaml`](examples/requires.yaml) and
[`examples/base.yaml`](examples/base.yaml) are two synthetic overlays: the
first requires the second (or a later revision named beside it) and conflicts
with an older revision.

A composition of `base.yaml` and `requires.yaml` is valid, and so is one of
`base-v3.yaml` and `requires.yaml`. `requires.yaml` alone misses the group.
`base.yaml`, `base-v1.yaml` and `requires.yaml` together hold a conflict.

## 7. Validation

A conforming document:

1. gives `x-requires`, when present, as a nonempty array of objects, each with only
   `anyOf`, a nonempty array of strings that are URI references;
2. gives `x-conflicts`, when present, as a nonempty array of such strings;
3. names no overlay twice in one group, nor twice in `x-conflicts`, nor the
   same overlay in a group and in `x-conflicts`, nor itself (when its own URL
   is known).

A conforming composer:

* MUST NOT apply an overlay whose `x-requires` has a group the composition
  does not meet, nor one whose `x-conflicts` names an overlay of the
  composition;
* MUST check every overlay of the composition, not only the one it added
  last;
* SHOULD report each unmet group and each conflict by the overlays involved.

## 8. Not covered

* Order. A composer may apply the overlays in any order its own rules allow.
* Versions as ranges. A group names concrete overlays; a later revision is
  accepted only once a group names it.
* Requirements on the target document's own revision (`extends` covers it).

## Validator and tests

[`validate.py`](validate.py) holds `validate(overlay, url=None)`, which raises
`ValueError` for a document that breaks §7's document rules, and
`check_composition(overlays)`, which takes `{resolved URL: overlay document}`
and returns the problems §7 asks a composer to report. From the repository
root:

```sh
cd openapi-extensions/spec/overlay-requirements
pip install -r requirements.txt
python3 -m unittest test_validate
python3 validate.py examples/requires.yaml examples/base.yaml
```

## Changes

- **0.1.0-draft** (2026-10-15): `x-requires` and `x-conflicts` on the
  Overlay Info Object, document and composer rules, a validator, examples
  and tests. For ontola/atomic-plugins#632, whose repository-internal
  `info.x-requires` convention for completeness overlays this generalises.

## Reference Implementation

[`validate.py`](validate.py) in this folder.
