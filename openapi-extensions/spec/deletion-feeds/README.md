# OpenAPI Deletion Feeds Extension

**Spec version:** 0.1.0-draft

---

## 1. Introduction

A client that keeps a local copy of a collection needs to know when an object
it had was deleted. A read of the collection's list does not tell it: an
object can be absent because it was deleted or because the list does not
return it. The [Collection Completeness extension](../collection-completeness/README.md)
covers lists that leave nothing out. Many APIs instead report deletions
directly, in one of three shapes:

* a list of changes since a cursor, in which deleted objects appear as
  tombstones (a `deleted: true` field, a `status: deleted`);
* an endpoint that lists deleted objects;
* an event log in which an event's action or type says that an object was
  deleted.

This extension adds one field, `x-deletion-feed`, on a
[CRUD Causality](../crud-causality/README.md) Collection Object (§4.2 there)
or on the Operation Object of a `list` operation. It names the operation that
returns the feed, how to recognise a tombstone and which object it is about,
and, optionally, the cursor that limits a read to changes since the previous
one.

### 1.1 Shapes in real APIs

The documents below are the OpenAPI documents that overlays in this
repository's [`overlays/APIs/`](../../../overlays/APIs/) extend, at the
`ontola/openapi-directory` commit those overlays pin. What is described here
is what those documents state; none of it has been checked against the live
APIs, and no overlay declares `x-deletion-feed`.

| API (document) | Feed | Cursor | Tombstone |
|----------------|------|--------|-----------|
| YNAB 1.0.0 (`youneedabudget.com/1.0.0`, `dec74da7`) | The list itself, e.g. `GET /budgets/{budget_id}/transactions`, with `last_knowledge_of_server` | Query `last_knowledge_of_server`; response `data.server_knowledge` | `deleted: true`; "Deleted transactions will only be included in delta requests". The document does not say what `GET /budgets/{budget_id}/transactions/{transaction_id}` answers for a deleted transaction |
| Google Calendar v3 (`googleapis.com/calendar/v3`, `32237fa5`) | The list itself, `GET /calendars/{calendarId}/events`, with `syncToken` | Query `syncToken`; response `nextSyncToken`, on the last page only; 410 when it expired | `status: cancelled` ("cancelled (deleted)"); only `id` is guaranteed. The `get` method "always returns" cancelled events, and an organizer's cancelled events "can be restored (undeleted)" |
| Asana 1.0 (`asana.com/1.0`, `bdea260b`) | `GET /events?resource=...`; `resource` is a required query parameter | Query `sync`; response `sync`; 412 with a fresh token for a missing or expired one; `has_more` | `action: deleted` (also `changed`, `added`, `removed`, `undeleted`); the object is `resource` |
| Box 2.0.0 (`box.com/2.0.0`, `dec74da7`) | `GET /events`; also `GET /folders/trash/items` | Query `stream_position`; response `next_stream_position` | `event_type: ITEM_TRASH`. A trashed file stays readable at `GET /files/{file_id}/trash`; the document does not say whether its own `GET /files/{file_id}` then answers 404 |
| Stripe 2022-11-15 (`stripe.com/2022-11-15`, `dec74da7`) | `GET /v1/events`, 30 days back | `ending_before`, an event id, newest first | `type: customer.deleted` and similar; the object is `data.object` |
| Todoist 1 (`todoist.com/1`, `ac07532b`) | none in this document | none | `is_deleted` on projects and tasks |
| Xero Accounting 2.9.4 (`xero.com/xero_accounting/2.9.4`, `c9c64afb`) | The lists, with an `If-Modified-Since` header | A time the client chooses | `Status: DELETED` on some objects |

YNAB has the shape of this version (a change list with a cursor it returns
and a tombstone marker), but its document does not say that a deleted
transaction's own read answers 404 or 410 (§4.3); that is neither documented
nor verified, as for Box below. The others do not fit (yet):

* Google Calendar's cancelled events are returned by the event's own `get`
  and can be restored, so they fail §4.3's test (the object's read answers
  404 or 410).
* Asana's `GET /events` needs the required query parameter `resource`; fixed
  query parameters of a feed are not covered (§8), so a consumer that sends
  only the cursor gets an error.
* Box's `ITEM_TRASH` has the shape, but whether a trashed item's own read
  answers 404 or 410 (§4.3) is not documented; unverified.
* Stripe's cursor is the id of the newest event and its events come newest
  first, Xero's is a client-chosen time in a header, and Todoist's document
  has no feed.

§8 lists these cases as not covered.

## 2. Overview

```yaml
components:
  crudResources:
    transaction:
      identity:
        urlTemplate: /budgets/{budgetId}/transactions/{transactionId}
        bindings:
          transactionId: { field: id }
      collections:
        transactions:
          urlTemplate: /budgets/{budgetId}/transactions
          x-deletion-feed:            # Deletion Feed Object (§4.1)
            operationId: listTransactions
            envelope:
              itemsField: data.transactions
            cursor:                   # Cursor Object (§4.2)
              parameter: last_knowledge_of_server
              responseField: data.server_knowledge
            tombstone:                # Tombstone Object (§4.3)
              field: deleted
              values: [true]
```

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "MAY" are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

A _feed read_ is a read of the feed operation that binds its path parameters,
sends the cursor parameter when the consumer has a cursor, follows every page
(per the [Pagination Schemes Extension](../pagination-schemes/README.md),
where the operation is paginated), and gets a successful response for every
page.

An _item_ is an element of the array a feed read returns. A _tombstone_ is an
item that §4.3 recognises as reporting a deletion.

A _member_ is an object of the collection, as in Collection Completeness §3.

## 4. Object Definitions

### 4.1 Deletion Feed Object

Placed under `x-deletion-feed` on a CRUD Causality Collection Object, or on
the Operation Object of an operation that lists the collection. When both are
present, the Collection Object's applies. Unlike a Completeness Object, the
declaration is about objects, not about what a read of the list returns, so
it applies to the collection however the consumer narrows its own list reads.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `operationId` | string | **Yes** | The `operationId` of a `GET` operation that returns the feed. It MAY be the collection's own `list` operation. Its path parameters are bound by name from the values used to read the collection (the collection's `urlTemplate` variables). |
| `envelope` | Envelope Object | No | Locates the array of items in each response body, as in CRUD Causality §4.2: `{ itemsField: <dot-path> }`. Default: the response body itself, which is then an array. |
| `cursor` | Cursor Object (§4.2) | No | How a read is limited to the changes since an earlier one. Without it, every read returns the whole feed (a deleted-items endpoint without a cursor, say). |
| `tombstone` | Tombstone Object (§4.3) | No | Which items are tombstones. Without it, every item is one (a deleted-items endpoint). |
| `idField` | string | No | Dot-path, in an item, to the identity value of the object the item is about. Default: the field the resource's `identity.bindings` binds to the variable of its `urlTemplate` that the collection's `urlTemplate` does not have. |
| `description` | string | No | Human-readable description. |
| `x-*` | any | No | Extension fields. |

By declaring a Deletion Feed Object, the document states:

* a tombstone reports that the object it is about was deleted (§4.3);
* the items of one feed read that are about the same object are in the order
  of the changes they report, oldest first, so the last one is the newest;
* with a `cursor`: a feed read from a cursor returns at least one item for
  every member deleted after the server issued that cursor, for as long as
  the operation accepts the cursor, and the last item about such an
  object is a tombstone unless a later change (a restore) followed the
  deletion. A feed read without a cursor MAY leave out deletions.

### 4.2 Cursor Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `parameter` | string | **Yes** | Name of the query parameter that carries the cursor. |
| `responseField` | string | **Yes** | Dot-path to the cursor for the next read, in the body of the last page of a feed read. Its value is a string or a number; the consumer sends it back unchanged (a number in its decimal form). |
| `expiredStatuses` | array of integer | No | Statuses with which the operation refuses a cursor it no longer accepts (410, 412). |
| `x-*` | any | No | Extension fields. |

The cursor is opaque to the consumer, even when it is a timestamp. A consumer
SHOULD keep it across restarts. The operation SHOULD accept a cursor more than
once, so that a consumer that stops before it stores a new cursor can read
again from the old one.

A response with one of the `expiredStatuses` is not a feed read. If its body
is JSON with a value at `responseField`, that value is the consumer's new
cursor; otherwise the consumer discards its cursor and the next read has none.

### 4.3 Tombstone Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `field` | string | **Yes** | Dot-path to a field of the item. |
| `values` | array of string, number or boolean | **Yes** | The item is a tombstone when the value at `field` equals one of these (same JSON type and value). |
| `x-*` | any | No | Extension fields. |

A tombstone has the meaning `absent: deleted` has in Collection Completeness
§4.2: the object no longer exists, and the resource's `read` operation, if it
has one, answers 404 or 410 for it. A state that keeps the object readable
through its own URL (archived, in a trash it can be restored from) is not a
deletion, and its marker MUST NOT be declared as a tombstone value.

## 5. Relation to CRUD Causality and Collection Completeness

The object an item is about is identified as for any member of the
collection: `idField` gives the value CRUD Causality's `identity.bindings`
puts into the object's `urlTemplate`, and the collection's context supplies
the rest (CRUD Causality §4.1.2).

A consumer that needs to know whether a member it no longer finds in a
complete read of the collection was deleted SHOULD use:

1. `x-completeness: { absent: deleted }` on the collection (Collection
   Completeness): the object was deleted. No request is needed.
2. The last item about the object in a feed read: a tombstone means the
   object was deleted when the read was made. This holds whatever the
   collection's `x-completeness` says, and without one.
3. The object's own `read` operation.

A tombstone says nothing about what happened after its feed read: the
object can be restored, or recreated with the same identity. A consumer
MAY read the object first and use a feed read made after that only for
objects whose read did not decide (no answer, or one other than 404, 410 or
a 2xx with the object). A consumer MAY keep a tombstone from an earlier feed
read and use it in place of reading the object, but only until any of these
supersedes it:

* a later feed read has a later item about the object that is not a
  tombstone;
* a later read of the object answers 2xx with the object, or a later
  complete read of the collection returns it;
* the API accepts a later write to the object with a 2xx.

A consumer SHOULD read the feed again before it relies on a kept tombstone,
to rule out the first case. When that read fails, it MAY still rely on the
kept tombstone; an object restored in the meantime is then treated as
deleted, although it exists, until a later read supersedes the tombstone.

A feed read in which the object has no tombstone (no item, or a last item
that is not one) does not show that the object exists. A deletion that
happened after the object was last seen but before the feed read that
returned the cursor is in an earlier read, not this one. Only when the
consumer received the cursor before it sent the read in which it last saw
the object, and sent the feed read after the read that lacked it, does a
feed read without a tombstone for the object show that it was not deleted in
between; the consumer MAY then treat it as `absent: removed` (Collection
Completeness §4.2). Otherwise it uses step 3.

## 6. Applying via OpenAPI Overlays

```yaml
overlay: 1.0.0
info:
  title: Declare the deletion feed of the transactions collection
  version: 1.0.0
actions:
  - target: $.components.crudResources.transaction.collections.transactions
    update:
      x-deletion-feed:
        operationId: listTransactions
        envelope: { itemsField: data.transactions }
        cursor:
          parameter: last_knowledge_of_server
          responseField: data.server_knowledge
        tombstone: { field: deleted, values: [true] }
```

An overlay author SHOULD have evidence for the declaration (provider
documentation, or observed behaviour) and SHOULD cite it in the overlay's
`description`. A wrong tombstone value makes a consumer treat existing
objects as deleted.

## 7. Examples

### 7.1 A change list with a status marker

An invented calendar API (not Google Calendar, whose cancelled events stay
readable, §1.1) whose `GET /calendars/{calendarId}/events` takes a
`syncToken`, returns `nextSyncToken` on its last page, answers 410 for an
expired token, and lists deleted events with `status: cancelled` (their own
`GET` answers 404):

```yaml
x-deletion-feed:
  operationId: listEvents
  envelope: { itemsField: items }
  cursor:
    parameter: syncToken
    responseField: nextSyncToken
    expiredStatuses: [410]
  tombstone: { field: status, values: [cancelled] }
```

### 7.2 An event log

An invented project tool whose `GET /projects/{projectId}/events` takes a
`sync` token and returns `{ data: [{ action, resource: { gid } }], sync }`,
answering 412 with a fresh `sync` for a missing or expired token. (Asana's
own `GET /events` takes the resource as a required query parameter instead,
which this version does not cover; §1.1.)

```yaml
x-deletion-feed:
  operationId: getProjectEvents
  envelope: { itemsField: data }
  idField: resource.gid
  cursor:
    parameter: sync
    responseField: sync
    expiredStatuses: [412]
  tombstone: { field: action, values: [deleted] }
```

An `undeleted` event after a `deleted` one for the same object makes the last
item about it not a tombstone.

### 7.3 A deleted-items endpoint

An (invented) to-do API whose `GET /deleted-tasks?since=<token>` returns
`{ items: [{ id }], next: <token> }`, every item a deleted task:

```yaml
x-deletion-feed:
  operationId: listDeletedTasks
  envelope: { itemsField: items }
  cursor: { parameter: since, responseField: next }
```

## 8. Not covered

* Cursors the API does not return: a time the consumer chooses itself
  (`updated_since=<time of the previous read>`, an `If-Modified-Since`
  header), with its clock and precision questions, or the id of the newest
  item (Stripe's `ending_before`).
* Feeds whose items come newest first.
* Cursors in a header or a request body, and fixed query parameters that the
  feed needs (Asana's required `resource`, Google Calendar's `showDeleted`).
* Tombstones for objects that stay readable through their own `read`
  operation (Google Calendar returns a cancelled event from its `get`, and
  it can be restored): §4.3 does not count them as deletions, so Google
  Calendar's event list does not fit this version.
* Restores: an item after a tombstone that is not one is only "not a
  tombstone"; this version does not say the object exists again.

## 9. Validation

A conforming document:

* MUST name, in `operationId`, a `GET` operation of the document;
* MUST give `tombstone.values` at least one value;
* MUST NOT declare a tombstone value for a state in which the object remains
  readable through its own URL (§4.3);
* MUST NOT declare a feed whose items about one object are not oldest first
  (§4.1).

A conforming consumer:

* MUST NOT use items of a read that is not a feed read (§3): a page failed,
  a budget stopped it, or a body did not have the declared shape;
* MUST NOT store a cursor from a read that is not a feed read, apart from
  the case in §4.2;
* MAY treat an object as deleted when the last item about it in a feed read
  is a tombstone;
* MUST NOT treat an object as existing because a feed read has no tombstone
  for it, other than as §5 allows.

## Reference Implementation

[`syncables`](../../../syncables/README.md#deletion-feeds) reads
`x-deletion-feed` (on the Collection Object, else on the list operation),
unless `x-completeness: { absent: deleted }` applies or its missing-record
checks are off. It reads the feed once per sync, per bound context, at the
end of the sync after the reads of missing records, from a cursor kept in its
durable outbox when it has storage. For a record the collection read lacked,
it uses a tombstone kept from an earlier feed read in place of the record's
read, deciding at the end of the sync, after that sync's feed read: a later
item about the record that is not a tombstone in a complete read supersedes
it, and a failed or incomplete read leaves it standing (§5). Otherwise it
reads the record, and when that read did not decide, uses the tombstone of
this sync's feed read. It keeps tombstones only for records with unsettled
writes, and drops one when a read returns the record or a write to it is
answered with a 2xx. It does not use the "not deleted" case of §5. Cursors in a
header or body, and the other cases in §8, are not implemented. Not verified
against a real provider.
