SyncD adds explicit, opt-in provider creates, replacements and deletes through
an independently approved device write grant. Local edits and receipts persist
in PostgreSQL; interrupted creates remain uncertain without automatic reposting,
and replacement identities are committed before originals are retired. Google
Keep uses a revised composed profile with resource-name path bindings. See
Provider writes and recovery for configuration, conflict handling, metadata
loss, ownership attestation and the remaining non-atomic deletion race.
