# Draft: Cursor pagination across operations

[atomic-plugins #727](https://github.com/ontola/atomic-plugins/issues/727)

Some APIs initialize a listing with one operation and consume its cursor
with another. A page can return a usable cursor even when it is terminal
for the current read. This proposal adds an opt-in `continuation` object to
`pageToken` schemes in the [Pagination Schemes extension](README.md).

## Declaration

```yaml
components:
  paginationSchemes:
    folderListing:
      type: pageToken
      autoDetect: false
      response:
        envelope:
          itemsField: entries
        bodyFields:
          cursor:
            role: nextCursor
      continuation:
        operationId: continueListFolder
        request:
          bodyFields:
            cursor:
              role: cursor
        hasMoreField: has_more
```

Attach `folderListing` to the initial listing operation with
`x-pagination`. The continuation operation is resolved by its
`operationId` in the same OpenAPI document. It supplies the HTTP method,
path, parameters, request schema and security requirements. The scheme's
response envelope and cursor field apply to both operations.

| Field | Meaning |
| --- | --- |
| `operationId` | Required. Identifies a unique continuation operation in the same document. It may identify the initial operation. |
| `request` | Required. Locates one cursor field in a query parameter or POST JSON body. For the first version of this proposal, the cursor is the only dynamic continuation input. |
| `hasMoreField` | Required. A dot-path using the response body field syntax. Both operations must return a boolean at that location on every successful page. |

## Traversal

1. Start a fresh read with the initial operation and its configured inputs.
   When the caller supplies a saved checkpoint for the same listing scope,
   start with the continuation operation and that cursor.
2. Read the item envelope, a nonempty string cursor and the boolean
   `hasMoreField`. An empty item array is valid in either state. A
   missing or malformed required field fails the read.
3. If the flag is true, call the continuation operation with the returned
   cursor. Build the request from that operation's declaration and the
   continuation request mapping. Initial operation inputs are scoped to
   the initial request. Reject a repeated cursor that would cause another
   request in the same traversal. Apply one request and time budget across
   the full traversal.
4. If the flag is false, finish the read and return the cursor to the
   caller as the checkpoint. A terminal cursor may equal the cursor sent
   on the final request. A storage client advances its checkpoint only
   when it durably accepts the corresponding items.
5. On a malformed response, HTTP failure, or budget exhaustion, report an
   incomplete read. A storage client retains the last committed checkpoint
   and can replay from it. Provider-specific cursor reset handling and
   durable checkpoints for partial traversals are separate work.

Resolve the continuation destination from a fixed GET or POST path on the document's upstream using the
transport's normal authorization and origin checks. The cursor is an
opaque request value. It never controls the destination, method or
credential choice.

## Validation and compatibility

The standalone validator checks the continuation target and its cursor
input. Syncables checks the item envelope, cursor and flag when reading
each response. SyncD uses the terminal cursor for incremental polling
when the scheme declares `x-syncables-incremental: true`. Declare that
flag only when continuation across polls returns changes to the same
collection and its tombstones can be matched to stored item identities.

A scheme with `continuation` requires explicit opt-in and a consumer
that supports it. Publish its provider overlay separately from existing
catalog selections until compatible readers are available. Existing
schemes keep their current behavior.

## Implementation cases

- First and subsequent requests use different paths and only the second
  sends the JSON cursor.
- An empty page with `has_more: true` still advances.
- A terminal page returns a cursor and causes no further HTTP request.
- A new read passes the terminal cursor directly to the continuation operation.
- Missing or non-boolean flags, missing cursors, repeated nonterminal
  cursors, HTTP errors and exhausted budgets preserve the prior checkpoint.

Dropbox uses this pattern for folder listings and change polling. Google
Drive's ordinary file listing already uses same-operation page tokens. Its
separate change-feed bootstrap and checkpointing can be described on its own
terms.

[Dropbox change detection](https://docs.dropboxapi.com/dropbox-api/docs/detecting-changes) ·
[Google Drive change tracking](https://developers.google.com/workspace/drive/api/guides/manage-changes)
