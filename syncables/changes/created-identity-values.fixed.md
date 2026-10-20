A create's identity read from its response (CRUD Causality §4.3.2) must
be a value `resolveReference` would also accept: a nonempty string that
is not `.` or `..`, is not padded with whitespace, and holds no NUL or
lone surrogate, or a safe integer. A numeric string past 2^53 is kept,
as a string. Before, a `Location` of `/pets/..` (or `%2E%2E`) bound the
record to `..`, whose path normalises to another resource; a lone
surrogate made every later update or delete of the record throw
`URIError`; and a body `id` that was an object or a boolean bound it to
`[object Object]` or `true`. Such a create is now unbound, as one
without a usable identity already was.
