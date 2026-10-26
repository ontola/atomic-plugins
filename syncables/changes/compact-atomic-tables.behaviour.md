The experimental Atomic table projection uses one resource per API record,
with nested objects, arrays and comments kept as inline native JSON. Use a new
projection directory when upgrading from the recursive-resource format. API
identity columns have distinct labels, imported permissions remain source
metadata, and declared compound-field schemas stay on their Properties. The
Keep daemon example now retains the complete pinned upstream OAD instead of a
minimal GET-only profile; the daemon still selects read-only GET collections.
