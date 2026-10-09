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
`x-crud`, has the action `update` or `delete`. On a `create`, there is no
object yet to condition the write on: a create MAY carry a Write Precondition
Object only with `kind: none` and Refusal Objects that all have a `source`
(§4.4.1), such as a workspace setting that refuses entries without a project.

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
| `readVerify` | Reads the object (§3) just before the write. When any written field's current value differs from its baseline, the write is a conflict and is not sent. A delete writes no field: for a delete, every field the client holds a baseline for is compared. Otherwise it sends the write unconditionally. A change made between that read and the write is overwritten; this kind narrows the window, it does not close it. Declare it for a provider that documents no conditional request for the operation. |
| `none` | Sends the write unconditionally. The document states that the provider offers no precondition and that a client is not expected to read first: last writer wins. |

Without `x-write-precondition`, the document says nothing about
preconditions; a client decides for itself.

Values compare as JSON values (same type and value), with an absent field
equal to `null` (§4.5). A client compares a
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

`If-Match` uses the strong comparison of [RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110#section-13.1.1):
a weak entity tag (`W/"…"`) never matches. A provider whose versions are weak
entity tags cannot be declared `ifMatch` with `If-Match`; declare
`readVerify` instead.

### 4.4 Refusal Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `field` | string | **Yes** | Dot-path to a field of the object, or of the source object when `source` is given. |
| `values` | array of string, number, boolean or `null` | Conditional | The write is refused when the field's current value equals one of these (same JSON type and value; an absent field is `null`). |
| `present` | `true` | Conditional | The write is refused when the field is present with a value other than `null`, whatever the value (Google Calendar's `recurrence` on a recurring series). |
| `source` | Source Object (§4.4.1) | No | Read `field` from another object, such as a settings resource, instead of the write's own object. |
| `when` | Body Condition (§4.4.1) | No | Refuse only a write whose request body also matches this condition. |
| `description` | string | No | Human-readable notes. |

Exactly one of `values` and `present` is given.

#### 4.4.1 Source Object and Body Condition

Some providers refuse a write because of a setting held elsewhere: a Clockify
workspace with `settings.forceProjects` set refuses a time entry without a
project. A Refusal Object with `source` reads `field` from that other object,
and `when` limits it to the writes the setting concerns.

| Source Object field | Type | Required | Description |
|---------------------|------|----------|-------------|
| `resource` | string | **Yes** | A key of [CRUD Causality](../crud-causality/README.md) `crudResources`. |
| `description` | string | No | Human-readable notes. |

The _source object_ is the object of that resource whose identity variables
(`identity.urlTemplate`, CRUD Causality §4.1.1) take the values of the
write's path parameters of the same names; every variable MUST be one of
them. A client reads it with the resource's `read` operation, or, when the
resource has none, from a complete read of one of its collections, taking the
item whose identity binding holds the value. It SHOULD read the source object
at least once per sync pass; a value older than that may be stale.

| Body Condition field | Type | Required | Description |
|----------------------|------|----------|-------------|
| `field` | string | **Yes** | Dot-path to a field of the write's request body. |
| `values` \| `present` | as above | Conditional | Exactly one; matched against the body's value, an absent field being `null`. |

A Refusal Object with `when` refuses a write only when both its own
condition (on the object or the source object) and `when` (on the request
body) match. A write whose body does not match `when` is not affected by the
Refusal Object at all.

**Failing closed.** When the source object cannot be read (a failed request,
a `403` or `404`, no item with that identity in a complete read), the client
MUST NOT send a write that the Refusal Object could refuse: one whose body
matches `when`, or any write when there is no `when`. It reports why. Other
writes are unaffected.

A client checks every Refusal Object against the object as it last read it,
and, for `readVerify`, against the read made just before the write. When one
matches, it MUST NOT send the write and reports why. A client that has not
read the object (a write it composes without a read, under `ifMatch` or
`none`) MUST read it first when the operation declares a Refusal Object
without a `source` (a Refusal Object with a `source` needs the source object,
not the write's own object, §4.4.1); a state
reached after its last read is otherwise missed, and the declaration only
protects writes whose read is recent. Declare a state here
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

**Which writes this section covers.** Only a write known to be an update or
a delete: by its operation's `x-crud` action (`update` or `delete`), or, without
`x-crud`, by its method (`PUT` or `PATCH` an update, `DELETE` a delete). Any
other write (a `POST` without `x-crud`, which may be a create, or an `x-crud`
`create`) is outside this section: its unknown outcome stays unknown, and the
client never resends it on this section's rules, since a resent create may
duplicate the object.

**Whether to read first.**

* Under `readVerify`, a client MUST read the object and resolve the outcome
  as below before sending anything again, whatever `idempotent` says: a
  resend skips the pre-write comparison, and would overwrite a change made in
  the meantime.
* Under `ifMatch` or `none`, when `idempotent` is `true`, a client MAY send
  the same request again (under `ifMatch` with the same version) without
  reading; that resend is a new send, to which §4.2 and §4.4 apply again. When
  it is `false`, it MUST read the object first.

**Resolving by a read.** The client reads the object (§3) and compares:

Which rule applies follows the write's action, as above.

_Deletion confirmed_ means the document says that a missing object of this
resource was deleted, for this object: a [Deletion Feeds](../deletion-feeds/README.md)
tombstone for this object; a collection of the resource that declares
`notFound: deleted` explicitly; or a collection declared `absent: deleted` that
the object was a member of when the client last read it, which rests on
[Collection Completeness](../collection-completeness/README.md) §4.2's rule
that objects do not leave the caller's reach while they exist. An
`absent: deleted` collection the object was not read in says nothing about
it, and a deletion feed alone, without a tombstone for this object, is not
confirmation.

The client checks the read in this order, and the first rule that applies
decides:

1. `404` or `410`: the object is gone. For a delete, the write counts as
   applied when deletion is confirmed, and is otherwise _gone, not
   confirmed_. For an update, the outcome is _gone_. Either way the client
   stops resending: a resent `PUT` could recreate the object. It reports a
   deletion only when it is confirmed.
2. A 2xx whose body is a read tombstone of the resource (Deletion Feeds
   §4.4): for a delete, applied (a soft delete); for an update, _gone_ as in
   rule 1, with the deletion confirmed.
3. For an update, every written field holds the value the write set: applied.
4. A Refusal Object (§4.4) matches the object's own state: _refused_, and
   nothing is sent again. Refusal Objects with a `source` are not re-checked
   here.
5. Under `ifMatch`, the version equals the one sent: not applied, and the
   client MAY send the write again. A different version is a conflict for an
   update (another writer changed the object, and a resend with the old
   version would only answer a `conflictStatus`), and for a delete.
6. Otherwise, compare with the baseline: when every written field (for a
   delete, every field the client holds a baseline for) still holds its
   baseline, the write was not applied and the client MAY send it again;
   anything else is a conflict. A compared field without a baseline leaves
   the outcome unknown.
7. Any other answer leaves the outcome unknown.

The baseline of a delete is the object as the client last read it before
sending: under `ifMatch` its version, otherwise every field the client holds.

A resend after rule 5 or 6 is a new send: §4.2 and §4.4 apply to it again,
including Refusal Objects with a `source`.

_Gone, not confirmed_ ends the write without reporting a deletion: the client
keeps the record with its last known values and marks it unavailable (as
[Collection Completeness](../collection-completeness/README.md)
`notFound: unavailable` does), and a later read that returns the object
supersedes the mark.

Creates are not covered by this section: a create has no object to read
before it, and its unknown outcome is CRUD Causality's (an idempotency key,
or its compound creates, ontola/atomic-plugins pieces.md K8). The validator
rejects `idempotent` on a create.

**The write's own answer.** The same rules 1 and 2 classify the answer to the
write itself, on the first send and on any resend: a `404` or `410` to a
delete counts as applied only when deletion is confirmed, and is otherwise
gone, not confirmed; a `404` or `410` to an update means gone. A client never
reports a deletion it has not confirmed.


"Applied" means that the object now holds what the write set. A read cannot
tell this write from another writer that set the same values in the
meantime; for a sync either way ends in the same state.

A field the write removes (a JSON Merge Patch `null`) and a field the object
lacks compare equal: absent and `null` are the same value in every comparison
of this extension.

Under `ifMatch`, a repeated write that answers a `conflictStatus` may be the
first write's own effect, which changed the version. The client resolves it by
the same read.

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
  `update` or `delete`, or `create` with `kind: none` and only Refusal
  Objects that have a `source`;
* gives `kind` one of the values of §4.2;
* gives `version` exactly when `kind` is `ifMatch`, with `in` one of `header`
  and `body` and a nonempty `name`;
* gives `header` and `conflictStatus` only with `ifMatch`; `header` a
  nonempty string, `conflictStatus` a nonempty array of unique integers
  400–499;
* gives each Refusal Object a nonempty `field` and exactly one of a nonempty
  `values` array of JSON scalars and `present: true`; a `source`, when given, with a `resource` that is a `crudResources` key whose identity variables are all path parameters of the operation; a `when`, when given, with a nonempty `field` and exactly one of `values` and `present`;
* gives `idempotent`, when present, a boolean.

A conforming client:

* under `ifMatch`, sends the version in `header` and treats a
  `conflictStatus` as a conflict, never as an error to retry;
* under `readVerify`, reads the object and compares every written field with
  its baseline before sending, and sends nothing on a difference;
* never sends a write while a Refusal Object matches, and, when a Refusal Object's source object cannot be read, never sends a write that Refusal Object could refuse (§4.4.1);
* follows §4.5 for an unknown outcome.

## 8. Not covered

* Conditional creates (`If-None-Match: *`), the unknown outcome of a create
  (§4.5), and preconditions on whole collections. A create may carry only
  Refusal Objects with a `source` (§4.1).
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
  pieces.md K14, K15 and K17; the Refusal Object's `present: true` covers
  the read-only-by-predicate half of K18, and `source` with `when` the write half of K12.

## Reference Implementation

None yet. The Google Calendar drive app (`integrations/calendar/app/`)
implements `ifMatch` by hand, and the Notion drive app
(`integrations/notion/app/send.ts`) `readVerify` with a trash refusal; neither
reads this extension.
