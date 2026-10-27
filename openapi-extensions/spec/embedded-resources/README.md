# OpenAPI Embedded Resources Extension

**Spec version:** 0.1.0-draft

**Status:** Experimental. The spelling and contract may change before adoption.
This draft is not published provider metadata or a certification claim.

---

## 1. Introduction

An API response may carry an object of another resource inside a field, or
an array of such objects. A JSON Schema `$ref` describes that field's shape;
it does not say which API resource the object represents. This extension
adds `x-embeddedResources` to a CRUD Resource Object to make that relationship
explicit.

This is API embedding semantics, not import or presentation policy. It names
the resource represented by supplied objects. It specifies neither an Atomic
class, a table, a display-name field, nor a rule for merging or persisting
the objects. Consumers MUST NOT infer an embedding from a schema name,
`$ref`, field name, object contents, URL-looking value, or provider identity.

## 2. Overview

```yaml
components:
  crudResources:
    issue:
      x-embeddedResources:
        user:
          resource: person
          cardinality: one
        labels:
          resource: label
          cardinality: many
    person:
      schema:
        type: object
        properties:
          id: { type: integer }
          name: { type: string }
      identity:
        urlTemplate: /people/{personId}
        bindings:
          personId: { field: id }
    label:
      schema:
        type: object
        properties:
          id: { type: integer }
          name: { type: string }
      identity:
        urlTemplate: /repos/{owner}/{repo}/labels/{labelId}
        bindings:
          labelId: { field: id }
```

For an issue reached through request context `{owner: sample, repo: paper}`,
`labels: [{id: 9, name: Urgent}]` supplies a label object whose identity path
is `/repos/sample/paper/labels/9`. Its name is an ordinary supplied field;
this extension assigns it no display role. The example is invented.

## 3. Conventions

The key words MUST, MUST NOT, REQUIRED, SHOULD, and MAY are interpreted as
described in RFC 2119.

This draft uses the CRUD Resource, Identity, and Binding Objects from
[CRUD Causality](../crud-causality/README.md), §§4.1–4.1.2. The document and
resource maps are ordinary OpenAPI 3.x `components.crudResources` metadata.

A **dot-path** consists of nonempty property names separated by `.`.
Whitespace, `[` and `]`, and ASCII control characters (including DEL) are
not allowed in these names. Traversal reads own object properties only;
it never traverses an array or a prototype. This draft has no escaping for
a property name containing a literal dot.

## 4. Object Definitions

### 4.1 Embedded Resources Map

`x-embeddedResources` is an object on a CRUD Resource Object. Each key is a
dot-path in an object of that source resource. Each value is an Embedded
Resource Object. Source paths MUST NOT overlap: declaring both `user` and
`user.profile`, for example, is invalid. An empty map declares no embeddings.

### 4.2 Embedded Resource Object

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `resource` | string | Yes | An explicitly declared target `crudResources` key. |
| `cardinality` | `one` or `many` | Yes | One embedded object, or an array of embedded objects. |
| `x-*` | any | No | Extension fields; no semantics are defined here. |

Other fields are invalid. In particular, this draft has no `nameField`,
presentation hints, field mapping, reference bindings, or fetching options.

The target MUST explicitly declare an object `schema` and an `identity`.
The schema MAY use ordinary local Schema Object references. Resolving those
references establishes shape only; the `resource` declaration alone selects
the target. If the target's object shape cannot be resolved by a consumer,
that is an invalid declaration, not permission to infer a target.

### 4.3 Identity and request context

For each supplied object, fill the **target's** `identity.urlTemplate` with
the **target's** `identity.bindings`, reading fields from that embedded
object. Unbound variables come unchanged from the original source request's
path-variable context. Neither source-record fields nor a child object
replace that request context. An explicitly bound field takes precedence
over a request-context variable of the same name; a missing bound value
does not fall back to context.

An identity template MUST be a path starting with exactly one `/`, and
MUST NOT contain a backslash, ASCII control character, space, or DEL.
Variables use `[A-Za-z_][A-Za-z0-9_]*`; `__proto__`, `constructor`, and
`prototype` are reserved. Braces MUST delimit complete variables. Every
binding names one of those variables and has a nonempty `field` dot-path.

An identity value MUST be a nonempty string or a safe integer, expressed in
decimal. A string MUST NOT be `.`, `..`, whitespace-padded, contain NUL, or
contain a lone surrogate. A carried context value MUST be a string meeting
the same rules. Values are percent-encoded individually when substituted;
an already encoded value is encoded again. A missing or unsafe value
makes the field unresolved under §4.4.

### 4.4 Supplied values and unresolved fields

For `one`, an absent or null field supplies no object and no link. An object
must resolve its identity; a string, number, boolean, or array is unresolved.
For `many`, an actual empty array supplies an empty list. Every nonempty
array member must be an object with a resolvable identity. A non-array field
(including null or absence), a string member, a null member, or any member
whose identity cannot be resolved makes the **whole field** unresolved.

A consumer MUST preserve the complete original field on an unresolved
result and report diagnostics; it MUST NOT produce a partial link list or
drop unresolved members. Diagnostics SHOULD identify array member indices.
Order and repeated members are retained by resolution. How a consumer
represents an unresolved field is its policy; the experimental Syncables
projection retains it as JSON.

Supplied objects may be partial representations. Their presence does not
assert a complete target record or target collection membership. This
extension grants no write authority and specifies no creation, deletion,
conflict resolution, persistence, deduplication, or merge precedence policy.

### 4.5 Distinction from identity references

CRUD Causality §4.1.3 `references` remains unchanged: bindings read
identifying values from the referring source object and assert identity
only. An embedding instead supplies target object data and uses the
target object's own identity bindings. Declaring one MUST NOT implicitly
declare or change the other. Both may coexist on a source resource.

### 4.6 No expansion or network effects

Resolution MUST NOT fetch a target, expand nested embeddings recursively,
infer undeclared relationships, or follow a supplied object's URL field.
A consumer may separately choose to read or persist a target; that action
is outside this extension and requires its own authorization and policy.

## 5. Applying via OpenAPI Overlays

The declaration may be contributed by an explicit overlay:

```yaml
overlay: 1.0.0
info: { title: Experimental supplied objects, version: 0.1.0 }
actions:
  - target: $.components.crudResources.issue
    update:
      x-embeddedResources:
        user: { resource: person, cardinality: one }
        labels: { resource: label, cardinality: many }
```

The composed document must also explicitly declare `person` and `label`
with their schemas and identities. This example is not a provider overlay
or permission to change an existing immutable catalog revision.

## 6. Examples

[`examples/work-records.json`](examples/work-records.json) is a standalone
invented document with scalar and repository-scoped array embeddings. Its
Schema Object references are deliberately named differently from its CRUD
resource keys to demonstrate that shape and identity metadata are separate.

## 7. Validation

A consumer MUST reject invalid metadata before projecting any source
records. The reference validator checks:

1. `x-embeddedResources` appears only on a declared CRUD Resource Object.
2. Its value is a map of valid, non-overlapping source dot-paths.
3. Every entry contains exactly the required `resource` and `cardinality`,
   apart from `x-*` extension fields, with a supported cardinality.
4. Each target resource explicitly exists and supplies a resolvable object
   schema and an identity URL template.
5. Identity templates and declared bindings meet §4.3's metadata rules.

At runtime, consumers MUST enforce §4.3's value safety and §4.4's
whole-field fallback. Ordinary OpenAPI/JSON Schema validation remains
separate. An input record with an invalid embedding does not invalidate
the declaration or justify losing that record's source data.

## Reference Implementation

`validate.py` checks declaration metadata, resolving local schema references
for shape without making requests. Run its invented example and tests with:

```sh
python3 validate.py examples/work-records.json
python3 -m unittest discover -p 'test_*.py'
```

The experimental Syncables implementation is
[`embedded-resources.ts`](../../../syncables/src/read/embedded-resources.ts):
`embeddedResourcesOf` validates a prepared document, and
`resolveEmbeddedResource` returns original objects, bound paths and identity
values, or the original complete field with diagnostics. Path binding is
shared with its existing identity-reference resolver. This is experimental
source support, not a stable public package API.
