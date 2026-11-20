# OpenAPI Embedded Resources Extension

**Spec version:** 0.2.0-draft

**Status:** Experimental. The spelling and contract may change before adoption.
This draft is not a certification claim or a stable compatibility guarantee.

---

## 1. Introduction

An API response may carry an object of another resource inside a field, or
an array of such objects. A JSON Schema `$ref` describes that field's shape;
it does not say which API resource the object represents. This extension
adds `x-embeddedResources` to a CRUD Resource Object to make that relationship
explicit. The same map can identify a scalar foreign-key field using an
existing CRUD Reference Object, without claiming that it supplies target data.

This is API embedding semantics, not import or presentation policy. It names
the resource represented by supplied objects or identity-only references. It
specifies neither an Atomic class, a table, a display-name field, nor a rule
for merging or persisting
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
| `representation` | `object` or `identity` | No | Defaults to `object` for compatibility with 0.1.0-draft. |
| `cardinality` | `one` or `many` | Yes | `many` is supported only for `object`. |
| `resource` | string | Conditional | Fixed target `crudResources` key for `object`; mutually exclusive with `discriminator`. |
| `discriminator` | Discriminator Object | Conditional | Chooses the target of each supplied `object`; mutually exclusive with `resource`. |
| `reference` | string | Conditional | Required for `identity`: the name of an existing `references` entry on the source CRUD resource. |
| `x-*` | any | No | Extension fields; no semantics are defined here. |

Other fields are invalid. An `object` entry MUST declare exactly one of
`resource` or `discriminator` and MUST NOT declare `reference`. An `identity`
entry MUST declare `reference` and `cardinality: one`, and MUST NOT declare
`resource` or `discriminator`. Identity arrays are not supported in this
draft. There are no presentation hints, fetching options, or inferred targets.

Every selected target MUST explicitly declare an object `schema` and an
`identity`. The schema MAY use ordinary local Schema Object references.
Resolving those references establishes shape only. If the target's object
shape cannot be resolved, the declaration is invalid.

#### 4.2.1 Discriminator Object

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `field` | string | Yes | Dot-path relative to each embedded object. |
| `mapping` | map of string to string | Yes | Nonempty map from exact, nonempty string discriminator values to declared target resource keys. |
| `x-*` | any | No | Extension fields; no semantics are defined here. |

Other fields are invalid. The discriminator reads own properties of each
embedded object, without coercion or normalization. A missing, null,
non-string, or unmapped value makes the whole source field unresolved.
There is no fallback resource, including for an otherwise well-formed `id`.
All mapped resources MUST meet the target schema and identity requirements.
For `many`, each array member selects its own target independently; one
unresolved member makes the whole field unresolved.

```yaml
owner:
  representation: object
  cardinality: one
  discriminator:
    field: type
    mapping:
      Person: person
      Team: team
```

### 4.3 Identity and request context

For each supplied `object`, select its declared fixed or discriminated target,
then fill the **target's** `identity.urlTemplate` with
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
contain a lone surrogate. A carried context value MUST be a string or safe
integer meeting the same rules. Identity values retain their original types: numeric `7`
and string `"7"` are distinct identities, even though both substitute as `7`
in an HTTP path. A consumer MUST NOT use the substituted URL alone as a
canonical identity or coerce a numeric identity to a string. Canonical
identity includes the target resource, its namespace and all typed template
variable values, including inherited context. Values are percent-encoded individually when substituted;
an already encoded value is encoded again. A missing or unsafe value
makes the field unresolved under §4.4.

### 4.4 Supplied values and unresolved fields

For an `object` with `one`, an absent or null field supplies no object and
no link. An object must resolve its target and identity; a string, number,
boolean, or array is unresolved. For an `object` with `many`, an actual empty
array supplies an empty list. Every nonempty array member must be an object
with a selected target and resolvable identity. A non-array field (including
null or absence), a string member, a null member, or any member whose target
or identity cannot be resolved makes the **whole field** unresolved.

For `identity`, an absent or null declared source field supplies no link.
Otherwise that field MUST be a string or safe integer; arrays and objects
are unresolved. Resolve the named source CRUD reference against the complete
source record, using its reference bindings and inherited request context
(§4.5). There is no embedded target data in a successful identity result.

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
only. An `identity` field explicitly selects one such reference for that
source field. It MUST use the reference's bindings, not the target object's
own identity bindings. A reference MUST explicitly declare a `bindings`
object; `{}` is valid when all variables come from request context. Unbound
target variables come only from the original
source request context. All composite identity variables are retained;
there is no rule that a single scalar is the complete identity.

An `object` entry instead supplies target object data and uses that object's
own identity bindings. Neither form implicitly declares or changes a CRUD
reference. Ordinary references used as mutable navigation addresses do not
become imported record relationships merely by existing in `references`.
Only an explicit `x-embeddedResources` entry selects a field for this contract.

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
It also exercises the unchanged 0.1.0-draft object syntax.

[`examples/reference-links.json`](examples/reference-links.json) adds scalar
and composite identity references and explicit polymorphic object targets.
For its example source record reached with context `{workspaceId: "w-1"}`:

| Source field | Result |
| --- | --- |
| `assignee_id: 7` | `person` identity `/people/7`, typed `personId: 7`; no target object data. |
| `milestone_id: 12`, `project_code: "p-9"` | `milestone` identity `/workspaces/w-1/projects/p-9/milestones/12`; all three typed identity variables retained. |
| `owner: {type: "Team", id: 5, name: "Build"}` | `team` identity `/teams/5`, supplied partial object retained. |
| `labels: [{id: 9, name: "Urgent"}]` | One supplied `label` object in original array order. |

Replacing `owner.type` with `"Robot"` leaves the complete `owner` object
unresolved and reports its unknown discriminator; it never falls back to
`person`. Replacing the labels with `[{id: 9}, {name: "missing id"}]` leaves
the complete array unresolved, with a diagnostic identifying `labels[1]`;
it does not emit the first link alone. Passing `[7, 8]` for `assignee_id`
is unresolved; declaring an identity entry with `cardinality: many` is an
invalid document. A missing `project_code` cannot be supplied by a similarly
named context variable because it has an explicit reference binding.

Consumers supporting only 0.1.0-draft MUST reject new declaration fields
rather than treating polymorphic or identity entries as legacy fixed object
embeddings. Producers must select compatible consumers before publishing a
catalog that uses these forms.

## 7. Validation

A consumer MUST reject invalid metadata before projecting any source
records. The reference validator checks:

1. `x-embeddedResources` appears only on a declared CRUD Resource Object.
2. Its value is a map of valid, non-overlapping source dot-paths.
3. Every entry has a supported representation, cardinality and exclusive
   target declaration under §4.2, apart from `x-*` extension fields.
4. An identity entry selects an existing source reference with valid bindings;
   a discriminator has a valid field and a nonempty explicit target mapping.
5. Each target resource explicitly exists and supplies a resolvable object
   schema and an identity URL template.
6. Identity templates and declared bindings meet §4.3's metadata rules.

At runtime, consumers MUST enforce §4.3's value safety and §4.4's
whole-field fallback. Ordinary OpenAPI/JSON Schema validation remains
separate. An input record with an invalid embedding does not invalidate
the declaration or justify losing that record's source data.

## Reference Implementation

`validate.py` checks declaration metadata, resolving local schema references
for shape without making requests. Run its invented example and tests with:

```sh
python3 validate.py examples/*.json
python3 -m unittest discover -p 'test_*.py'
```

The experimental Syncables implementation is
[`embedded-resources.ts`](../../../syncables/src/read/embedded-resources.ts):
`embeddedResourcesOf` and `resolveEmbeddedResource` retain their legacy fixed
object contract. The browser entry point additionally exposes
`describeResourceFields` and `resolveResourceField` for typed fixed-object,
discriminated-object and identity-only results. Descriptors identify the
existing ontology property key, not a second property naming scheme. A
resolved target includes its typed canonical entity identity; an unresolved
result retains the complete original field with diagnostics. Resolution
reuses existing identity/reference binding rules and performs no requests.
