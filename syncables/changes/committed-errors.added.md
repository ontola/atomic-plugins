CRUD Causality 0.8.0 `committedErrors` (§4.3.3): a create answered with a
`5xx` that a Committed Error Object matches (a listed status and a usable
id at its `identity` path in the JSON error body, as Notion's `503` with
`additional_data.committed_resource_id`) is applied, bound to that id and
never sent again. Before, a `503` took the ordinary retry path, so such a
create was sent twice. A listed status whose body names no usable id is
an unknown outcome (uncertain without an idempotency key). A match that
does not name the record's id leaves the create applied but unbound,
which `matchUnboundCreates` can bind. Documents without
`committedErrors` read as before. `committedIdentity` ports the
reference `committed_identity()`, sharing the path-segment validation used
by other identity bindings, including rejection of malformed Unicode.
