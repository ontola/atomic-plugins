# OpenAPI Runtime Schemas Extension

**Spec version:** 0.1.0-draft

---

## 1. Introduction

Some APIs let their users define the fields of their own records. A Notion
data source (the table behind a database) has columns its owner adds,
renames, retypes and removes; each page in it carries one value per column.
The OpenAPI document cannot list those columns: they differ per data source
and change over time. It can only say that a page's `properties` is an
object of some values. The API itself does describe them, at runtime: reading
the data source answers its column definitions, each with a stable id, a
name and a type.

This extension adds one field, `x-runtime-schema`, on a
[CRUD Causality](../crud-causality/README.md) Resource Object (§4.1 there).
It says which field of the resource's objects holds the user-defined values,
which other object describes them (through a CRUD Causality Reference
Object, §4.1.3 there), where in that object the definitions are, how a value
is matched to its definition, and, per definition type, where the value is
and what shape it has. A client can then derive one class per describing
object (one per Notion data source) at read time, with one property per
column, keyed by the column's stable id.

It describes reading. Whether and how a value can be written back, and how a
client converts between a provider's value and its own (Notion's formatted
text to plain text, say), are out of scope (§8).

## 2. Overview

```yaml
components:
  crudResources:
    row:
      schema: { $ref: '#/components/schemas/Row' }
      identity:
        urlTemplate: /rows/{rowId}
        bindings: { rowId: { field: id } }
      references:
        table:                       # a CRUD Causality Reference Object
          resource: table
          bindings: { tableId: { field: parent.table_id } }
      x-runtime-schema:              # Runtime Schema Object (§4.1)
        field: properties            # the user-defined values in each row
        keyedBy: name                # the values' keys are the definitions' names
        match: id                    # a value is matched to its definition by id
        memberId: id                 # where a value carries its definition's id
        describedBy:                 # Describing Object (§4.2)
          reference: table
          definitions: properties
          shape: map
        definition:                  # Definition Fields Object (§4.3)
          id: id
          name: name
          type: type
        types:                       # Type Object per definition type (§4.4)
          number:
            value: number
            schema: { type: number, nullable: true }
          select:
            value: select
            schema: { type: object, nullable: true }
            options:                 # Options Object (§4.5)
              field: select.options
              id: id
              name: name
              valueId: id
```

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "MAY" are to be
interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A _dot-path_ is a field path as CRUD Causality's Binding Object (§4.1.2
there) and Pagination Schemes' `itemsField` use it: segments separated by
`.`, each a literal property name, a segment that contains a `.` written as
`["a.b"]` and still separated by `.` (`data.["user.fields"].values`).

The _item_ is an object of the resource that carries `x-runtime-schema`. Its
_members_ are the entries of the object at `field`. The _describer_ is the
object the Reference Object named by `describedBy.reference` identifies for
that item. Its _definitions_ are the entries at `describedBy.definitions`.

## 4. Object Definitions

### 4.1 Runtime Schema Object

The value of `x-runtime-schema` on a CRUD Resource Object.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `field` | string | **Yes** | Dot-path, in an item, to the object whose members are user-defined values. |
| `keyedBy` | `"name"` \| `"id"` | **Yes** | What a member's key is: the definition's `name` (Notion) or its `id`. |
| `match` | `"id"` \| `"key"` | **Yes** | How a member is matched to its definition. `id`: the value at `memberId` in the member equals the definition's `id`, so a member still matches after its column was renamed. `key`: the member's key equals the definition's `name` or `id`, as `keyedBy` says. |
| `memberId` | string | Conditional | Dot-path, in a member, to its definition's id. REQUIRED when `match` is `id`. |
| `memberType` | string | No | Dot-path, in a member, to the definition type the member was written under. When present, a client compares it with the definition's type (§5.3). |
| `describedBy` | Describing Object (§4.2) | **Yes** | Where the definitions are. |
| `definition` | Definition Fields Object (§4.3) | **Yes** | Where a definition's id, name and type are. |
| `types` | `Record<string, TypeObject>` (§4.4) | **Yes** | The definition types this document describes, keyed by the value at `definition.type`. A type not listed here is _undescribed_ (§5.4). |
| `description` | string | No | Human-readable description. |
| `x-*` | any | No | Extension fields. |

### 4.2 Describing Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reference` | string | **Yes** | Key into the same CRUD Resource Object's `references`. The referenced resource is the describer's resource; the Reference Object's bindings, and the request context for unbound variables, identify the describer for one item exactly as CRUD Causality §4.1.3 says. The describer is read with the referenced resource's `read` operation, the `get` at its `identity.urlTemplate`. |
| `definitions` | string | **Yes** | Dot-path, in the describer, to the definitions. |
| `shape` | `"map"` \| `"array"` | **Yes** | `map`: an object whose keys are the definitions' names or ids (as `keyedBy` says) and whose values are definitions. `array`: an array of definitions. |
| `x-*` | any | No | Extension fields. |

### 4.3 Definition Fields Object

Dot-paths within one definition.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | **Yes** | The definition's stable id. It identifies the column for as long as the describer has it, through renames. A client keys what it derives from a definition (its own property, say) by this id. |
| `type` | string | **Yes** | The definition's type, a string that selects a Type Object in `types`. |
| `name` | string | No | The display name. With `shape: map` and `keyedBy: name`, the map key is the name when this is absent. |
| `description` | string | No | A human-readable description of the column. |
| `x-*` | any | No | Extension fields. |

### 4.4 Type Object

What a member of one definition type holds.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `value` | string | **Yes** | Dot-path, in the member, to the value (Notion's type-named key: `number`, `select`, `rich_text`). |
| `schema` | OAS Schema Object | **Yes** | The schema of the value at `value`. Local `$ref`s resolve against the document. |
| `options` | Options Object (§4.5) | No | Present when the value refers to options the definition lists (a select). |
| `multiple` | boolean | No | Only with `options`. `true`: the value is an array of option references; `false` (the default): one option reference, or `null`. |
| `description` | string | No | Human-readable description. |
| `x-*` | any | No | Extension fields. |

### 4.5 Options Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `field` | string | **Yes** | Dot-path, in the definition, to the array of options. |
| `id` | string | **Yes** | Dot-path, in an option, to its stable id. A client keys an option by it, so a renamed or recoloured option stays the same option. |
| `name` | string | **Yes** | Dot-path, in an option, to its display name. |
| `valueId` | string | **Yes** | Dot-path, in one option reference of a member's value, to the option's id. |
| `x-*` | any | No | Extension fields. |

## 5. Reading

### 5.1 Deriving a class

For one describer, a client derives a class (a table's columns) with one
property per definition whose type has a Type Object. The property is keyed
by the definition's `id`, named by its `name`, typed by the Type Object's
`schema`, and, with `options`, limited to the options the definition lists,
each keyed by its option id. Items that share a describer share the class.
Items with different describers (pages of two Notion data sources) get
different classes, even when their columns have the same names.

### 5.2 When to read the describer

A client reads the describer of a set of items in the same read as the items
themselves, before it interprets any of their members. Definitions read in an
earlier read MAY be reused only as a hint: they can have changed since.

When a member matches no definition, the describer may have changed after it
was read. The client SHOULD then read the describer once more within the
same read. A member that still matches no definition is _unmatched_: the
client MUST NOT assign it to a property, and SHOULD report it.

A definition that no member of an item matches means the item holds no value
for it. It does not mean the value is `null`, and a client MUST NOT write
`null` for it on the item's behalf.

### 5.3 Changes to a definition

Definitions are keyed by `id`, so:

1. A changed `name` renames the derived property; the stored values stay.
2. A definition that is gone from the describer leaves its derived property
   without new values. Whether the client removes the property or keeps it
   with the old values is its own policy; it MUST NOT read the definition's
   absence as every item's value being deleted.
3. A changed `type` for the same `id` changes the value's shape. A client
   MUST NOT interpret values stored under the old type as values of the new
   one. With `memberType`, a member whose type differs from its definition's
   is unmatched (§5.2) until the describer and the member agree.
4. An option (§4.5) that is gone from the definition can still be referenced
   by stored values; a client keeps such a reference as an unknown option
   rather than dropping it.

### 5.4 Undescribed types

A definition whose type has no Type Object is undescribed. A client MUST NOT
give it a typed property. It MAY keep the member's raw JSON. The list of
`types` is the document's claim about which value shapes it has checked, not
a list of the provider's types: a provider type left out may be one whose
values the API truncates (Notion's relations, after 25 references), or one a
document author has not yet described.

### 5.5 Throttling and access

Reading a describer is one more request per describer, counted against any
[Throttling](../throttling/README.md) limit like any other. A describer the
client cannot read (403, 404) leaves its items without a class: the client
MUST NOT derive one from the members alone, since member keys carry neither
the definitions' types nor their options.

## 6. Applying via OpenAPI Overlays

An overlay adds `x-runtime-schema` to an existing CRUD Resource Object, and
the Reference Object it names if the resource does not have one yet:

```yaml
overlay: 1.0.0
info: { title: Runtime schemas for rows, version: 1.0.0 }
actions:
  - target: $.components.crudResources.row
    update:
      references:
        table:
          resource: table
          bindings: { tableId: { field: parent.table_id } }
      x-runtime-schema:
        field: properties
        keyedBy: name
        match: id
        memberId: id
        describedBy: { reference: table, definitions: properties, shape: map }
        definition: { id: id, name: name, type: type }
        types:
          checkbox: { value: checkbox, schema: { type: boolean } }
```

## 7. Examples

### 7.1 Notion-style columns

[`examples/user-defined-columns.yaml`](examples/user-defined-columns.yaml)
is a complete synthetic document shaped like Notion's data sources and
pages. A row's `properties` is keyed by column name; each member carries the
column's `id`, its `type` and a value under a key named after the type. The
table's `properties` holds the definitions, also keyed by name, each with
`id`, `name`, `type` and, for a select, `select.options`.

A row

```json
{ "id": "r1", "parent": { "table_id": "t1" },
  "properties": {
    "Estimate": { "id": "a%3Ab", "type": "number", "number": 3 },
    "Stage": { "id": "c%3Ad", "type": "select",
               "select": { "id": "opt-1", "name": "Doing", "color": "blue" } } } }
```

and its table

```json
{ "id": "t1", "properties": {
    "Estimate": { "id": "a%3Ab", "name": "Estimate", "type": "number", "number": {} },
    "Stage": { "id": "c%3Ad", "name": "Stage", "type": "select",
               "select": { "options": [ { "id": "opt-1", "name": "Doing", "color": "blue" },
                                        { "id": "opt-2", "name": "Done", "color": "green" } ] } } } }
```

give a class with two properties, `a%3Ab` (a number named Estimate) and
`c%3Ad` (one of the options `opt-1` Doing and `opt-2` Done, named Stage), and
the row's values `3` and `opt-1`. After the table's owner renames Estimate
to Points, the next read names the property Points and keeps the values.

### 7.2 Definitions in an array, members keyed by id

```yaml
x-runtime-schema:
  field: fields
  keyedBy: id
  match: key
  describedBy: { reference: form, definitions: fields, shape: array }
  definition: { id: id, name: label, type: kind }
  types:
    text: { value: '', schema: { type: string } }
```

Here a member is the value itself (`value: ''` is the member), keyed by the
definition's id. This shape is a neutral example, not a claim about a
particular API.

## 8. Not covered by this version

- **Writes.** Which members an API accepts in a write, under which key
  (Notion accepts a name or an id), and which types are read-only (formulas,
  rollups, timestamps). The CRUD Causality write operations still apply to
  the item as a whole.
- **Conversion.** How a client maps a provider value to its own and back,
  and which mappings lose information (Notion's formatted text written back
  as plain text). That belongs to a lens or converter, not to this
  extension.
- **Truncated values.** Values the API answers only in part (Notion's
  relations after 25 references), and the operation that reads them in
  full.
- **Describers that are not CRUD Causality resources.** A definition list
  answered by an operation with no resource of its own needs a later
  version.

## 9. Validation

A conforming validator MUST check:

1. `x-runtime-schema` appears only on a CRUD Resource Object (in
   `components.crudResources`).
2. Its `field`, `keyedBy`, `match`, `describedBy` (with `reference`,
   `definitions` and `shape`), `definition` (with `id` and `type`) and
   `types` are present, and have the types §4 gives; `keyedBy`, `match` and
   `shape` have one of their listed values. No other members are present
   besides `x-` members.
3. `memberId` is present when `match` is `id`.
4. `describedBy.reference` names a Reference Object in the same resource's
   `references`, whose `resource` is a key of `components.crudResources`.
5. When the document has a `paths` entry for the referenced resource's
   `identity.urlTemplate`, it has a `get` operation; when it has none, the
   validator reports that it cannot check rule 5 rather than failing.
6. Every Type Object has `value` and `schema`; `multiple` appears only with
   `options`; an Options Object has `field`, `id`, `name` and `valueId`.
7. Every dot-path is well formed: non-empty segments, a bracketed segment
   closed. `value` alone MAY be the empty string, meaning the member itself.
8. `types` has at least one entry.

## Schema, validator and tests

[`schema.json`](schema.json) is a JSON Schema (draft 2020-12) for the
Runtime Schema Object; it covers rules 2, 3, 6, 7 and 8.
[`validate.py`](validate.py) checks a whole OpenAPI document against it and
adds rules 1, 4 and 5. It also holds `derive_class` and `read_members`, a
reference implementation of §5.1 to §5.4 over a describer and items already
read. From the repository root:

```sh
python3 -m venv /tmp/runtime-schemas-venv
/tmp/runtime-schemas-venv/bin/pip install -r openapi-extensions/spec/runtime-schemas/requirements.txt
cd openapi-extensions/spec/runtime-schemas
/tmp/runtime-schemas-venv/bin/python -m unittest test_validate
/tmp/runtime-schemas-venv/bin/python validate.py examples/user-defined-columns.yaml
```

## Changes

- **0.1.0-draft** (2026-10-08): first draft, for ontola/atomic-plugins
  pieces.md K16 (Notion's per-data-source columns).

## Sources

- Notion, [Data source properties](https://developers.notion.com/reference/data-source-properties):
  a data source's `properties` is keyed by property name; every property has
  `id`, `name`, `type` and `description`; "A property's `id` stays the same
  when its name changes"; select, multi-select and status options have a
  stable `id`, a `name` and a `color`.
- Notion, [Page properties](https://developers.notion.com/reference/page-property-values):
  a page's `properties` is keyed by property name; each value has `id`,
  `type` and a key named after the type; relations, people and mentions are
  truncated after 25.
- The Notion app's lens, `integrations/notion/devonian/notion/lens/`, which
  derives columns by stable property id today (`columns.ts`,
  `projection.ts`).
