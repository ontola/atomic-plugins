# OpenAPI Write Preconditions Extension

**Spec version:** 0.1.0-draft

---

## 1. Introduction

A client that keeps a local copy of a resource sends its user's edits back
later. By then the object may have changed on the provider. Sending the edit
anyway overwrites the other change without anyone seeing it. APIs offer
different ways to prevent that, or none:

* **Conditional requests.** The object carries a version (an `ETag` header, or
  a version field in the body). The client sends it back in `If-Match`, and
  the API refuses the write with `412 Precondition Failed` when the object
  changed since. Google Calendar works this way; its documentation calls the
  body field `etag`.
* **No conditional requests.** The client can only read the object just
  before writing, and check that the fields it is about to change still hold
  the values it last saw. Notion's pages work this way. The check is not
  atomic: a change made between the read and the write is overwritten.

Two more things decide what a client may do with a write, whatever the
precondition:

* some states of an object mean the client must not write it at all, even if
  nothing it is about to change differs (Notion pages in the trash);
* when a write's outcome is unknown (the connection broke, a gateway answered
  `502`), the client needs to know whether sending it again is safe.

This extension adds one field, `x-write-precondition`, to the Operation
Object of a write. It states which kind of precondition the operation
supports, how the client sends it, which states forbid the write, and whether
the request may be repeated. It does not change the operation's request or
responses, which stay ordinary OpenAPI.

## 2. Overview

```yaml
paths:
  /calendars/{calendarId}/events/{eventId}:
    patch:
      x-write-precondition:          # Write Precondition Object (§4.1)
        kind: ifMatch
        version: { in: body, name: etag }
        conflictStatus: [412]
  /pages/{page_id}:
    patch:
      x-write-precondition:
        kind: readVerify
        refuseWhen:                  # Refusal Object (§4.4)
          - { field: in_trash, values: [true] }
```

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "SHOULD NOT" and "MAY"
are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

The _object_ of a write is the object the operation changes: the one its
path identifies, or, with [CRUD Causality](../crud-causality/README.md), the
object of the resource its `x-crud` names. Its _read_ is that resource's
`read` operation, or else the `GET` of the same path.

A client's _baseline_ for a field is the value it last read from the
provider for that field. The _written fields_ of a write are the fields its
request body sets.

## 4. Object Definitions

### 4.1 Write Precondition Object

Placed under `x-write-precondition` on the Operation Object of a write: a
`PUT`, `PATCH`, `POST` or `DELETE` operation, which, when it declares
`x-crud`, has the action `update` or `delete`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `kind` | `ifMatch` \| `readVerify` \| `none` | **Yes** | How a client makes the write conditional. See §4.2. |
| `version` | Version Object (§4.3) | Conditional | Required for `ifMatch`, not allowed otherwise. Where the object's version is read. |
| `header` | string | No | `ifMatch` only. The request header that carries the version. Default: `If-Match`. |
| `conflictStatus` | array of integers | No | `ifMatch` only. The statuses that mean the precondition failed. Default: `[412]`. Each 400–499. |
| `refuseWhen` | array of Refusal Objects (§4.4) | No | States of the object in which a client MUST NOT send the write. |
| `idempotent` | boolean | No | Whether sending the same request twice leaves the object as sending it once does. Default: `true` for `PUT` and `DELETE`, `false` for `PATCH` and `POST` ([RFC 9110 §9.2.2](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2)). See §4.5. |
| `description` | string | No | Human-readable notes, such as evidence for the declaration. |
| `x-*` | any | No | Extension fields. |

### 4.2 Kinds

| `kind` | A client |
|--------|----------|
| `ifMatch` | Sends the object's version, as last read (§4.3), in `header`. A response with a status in `conflictStatus` means the object changed since that read and the write was not applied: a conflict. Declare it only when the provider documents the conditional request for this operation. |
| `readVerify` | Reads the object (§3) just before the write. When any written field's current value differs from its baseline, the write is a conflict and is not sent. Otherwise it sends the write unconditionally. A change made between that read and the write is overwritten; this kind narrows the window, it does not close it. Declare it for a provider that documents no conditional request for the operation. |
| `none` | Sends the write unconditionally. The document states that the provider offers no precondition and that a client is not expected to read first: last writer wins. |

Without `x-write-precondition`, the document says nothing about
preconditions; a client decides for itself.

Values compare as JSON values (same type and value). A client compares a
field in the form it reads it, not in the form it writes it, where the two
differ (a rich-text field read as an array of runs and written as plain text,
say); a field it cannot compare that way it does not write under
`readVerify`.

A conflict is reported to the client's user or application, with the
provider's current value. Resolving it ("keep mine", "use theirs") is a new
write with a new baseline; this extension does not describe it.

### 4.3 Version Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `in` | `header` \| `body` | **Yes** | Whether the version is a response header of the object's read (and list), or a field of the object in their bodies. |
| `name` | string | **Yes** | The header name (case-insensitive), or the dot-path of the body field. |
| `x-*` | any | No | Extension fields. |

The client sends the version exactly as it read it, quotes included. A
version read from a list response is as good as one from the read, when the
list returns the same field. A client that has no version for the object
reads it first; it does not send the write without `header`.

### 4.4 Refusal Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `field` | string | **Yes** | Dot-path to a field of the object. |
| `values` | array of string, number, boolean or `null` | **Yes** | The write is refused when the field's current value equals one of these (same JSON type and value). |
| `description` | string | No | Human-readable notes. |

A client checks every Refusal Object against the object as it last read it,
and, for `readVerify`, against the read made just before the write. When one
matches, it MUST NOT send the write and reports why. Declare a state here
when the provider documents it as the object having been taken out of use by
its owner (trashed, archived, cancelled), so that a background write would
silently change something its owner put away. A state the provider refuses
writes in anyway needs no Refusal Object, but MAY have one, to save the
request.

The same shape is the Tombstone Object of [Deletion Feeds](../deletion-feeds/README.md)
§4.3 without its meaning: a refused state is not a deletion.

### 4.5 Unknown outcomes and repeating a write

A write's outcome is _unknown_ when the client cannot tell whether the
provider applied it: no response arrived, or a gateway answered `502`, `503`
or `504`, or the provider answered another `5xx` that it does not document as
"not applied".

* When `idempotent` is `true`, a client MAY send the same request again, with
  the same version for `ifMatch`.
* When it is `false`, a client MUST NOT send the request again before it has
  read the object. If every written field holds the value the write set, the
  write was applied. If every written field holds its baseline, it was not,
  and the client MAY send it again. Otherwise the outcome is a conflict.
* Under `ifMatch`, a repeated write that answers a `conflictStatus` may be the
  first write's own effect, which changed the version. The client resolves it
  by the same read and comparison.

An idempotency key that the operation declares as a header parameter (such as
`Idempotency-Key`) makes a `POST` safe to repeat; that is ordinary OpenAPI and
not part of this extension.

## 5. Applying via OpenAPI Overlays

```yaml
overlay: 1.0.0
info:
  title: Calendar event write preconditions
  version: 1.0.0
actions:
  - target: $.paths['/calendars/{calendarId}/events/{eventId}'].patch
    update:
      x-write-precondition:
        kind: ifMatch
        version: { in: body, name: etag }
```

An overlay author SHOULD cite the provider documentation for `ifMatch`,
`refuseWhen` and a non-default `idempotent` in the `description`.

## 6. Examples

[`examples/conditional-writes.yaml`](examples/conditional-writes.yaml) is a
synthetic document with all three kinds. Two providers, as their
documentation describes them:

* **Google Calendar** events: "Every resource has a version field that changes
  every time the resource changes — the `etag` field"; with `If-Match` and a
  changed resource, "you will get a 412 (Precondition failed) response code"
  ([Calendar API, versions of resources](https://developers.google.com/workspace/calendar/api/guides/version-resources)).
  `kind: ifMatch`, `version: {in: body, name: etag}`.
* **Notion** pages: the page reference documents no ETag or conditional
  update; `in_trash` is "Whether the page has been trashed", and `archived` is
  a deprecated alias of it ([Page object](https://developers.notion.com/reference/page)).
  `kind: readVerify`, `refuseWhen` on `in_trash` (and `archived`, for
  documents that still list it).

## 7. Validation

A conforming document:

* places `x-write-precondition` only on a `PUT`, `PATCH`, `POST` or `DELETE`
  operation, and, when the operation declares `x-crud`, one whose action is
  `update` or `delete`;
* gives `kind` one of the values of §4.2;
* gives `version` exactly when `kind` is `ifMatch`, with `in` one of `header`
  and `body` and a nonempty `name`;
* gives `header` and `conflictStatus` only with `ifMatch`; `header` a
  nonempty string, `conflictStatus` a nonempty array of unique integers
  400–499;
* gives each Refusal Object a nonempty `field` and a nonempty `values` array
  of JSON scalars;
* gives `idempotent`, when present, a boolean.

A conforming client:

* under `ifMatch`, sends the version in `header` and treats a
  `conflictStatus` as a conflict, never as an error to retry;
* under `readVerify`, reads the object and compares every written field with
  its baseline before sending, and sends nothing on a difference;
* never sends a write while a Refusal Object matches;
* follows §4.5 for an unknown outcome.

## 8. Not covered

* Preconditions on creates (`If-None-Match: *`) and on whole collections.
* Version fields with too coarse a precision to compare (a modification time
  in minutes). Compare written fields instead.
* Merging a conflict, or which side wins.
* Partly applied compound writes (a create followed by a second request); see
  pieces.md K8.

## Validator and tests

[`validate.py`](validate.py) checks the document rules of §7.
`may_send(...)` and `resolve_unknown(...)` are reference implementations of
§4.2–§4.5 for clients. From the repository root:

```sh
cd openapi-extensions/spec/write-preconditions
pip install -r requirements.txt
python3 -m unittest test_validate
python3 validate.py examples/conditional-writes.yaml
```

## Changes

- **0.1.0-draft** (2026-10-08): first version, for ontola/atomic-plugins
  pieces.md K14, K15 and K17.

## Reference Implementation

None yet. The Google Calendar drive app (`integrations/calendar/app/`)
implements `ifMatch` by hand, and the Notion drive app
(`integrations/notion/app/send.ts`) `readVerify` with a trash refusal; neither
reads this extension.
