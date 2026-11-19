Typed record projection now rejects values that contradict declared scalar
types, unsafe integer identities and invalid calendar dates or timestamps.
This also applies to `readPlatform`, which uses the same pure projection as
`projectReadRecord`. Providers returning malformed fields leave the collection
incomplete instead of passing values with the wrong type to downstream stores.
Required provider fields must be present, and nonnullable required nulls fail
projection. Required nullable properties are recommended rather than required
in derived Atomic classes; nullable null remains omitted for managed-value
clearing.
