The Braid listener accepts --braid-view atomic to serve accepted source records
as linked Atomic resources with schemas derived from the pinned OpenAPI
document. Source wrappers retain source-id as a string and source-json as a
reference to a typed row. Nested objects, ordered arrays and array occurrences
are resources, preserving duplicates, empty containers, nulls and exact numeric
lexemes. The existing raw representation and PostgreSQL history are unchanged.
