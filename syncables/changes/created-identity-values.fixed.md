A create's identity read from its response (CRUD Causality §4.3.2) must
be a nonempty string other than `.` or `..`, or a safe integer. Before, a
`Location` of `/pets/..` (or `%2E%2E`) bound the record to `..`, whose
path normalises to another resource, and a body `id` that was an object
or a boolean bound it to `[object Object]` or `true`. Such a create is
now unbound, as one without a usable identity already was.
