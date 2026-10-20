Add experimental standalone sync, foreground daemon, local browse/history
and commit/tag resource lookup commands. Archive lossless nested JSON objects
by content hash in local PostgreSQL and version the JSON-AD data copy with its
bundled schemas in private Git snapshots. Support configured GET collections,
a query-token incremental subset, durable deduplicated webhook hints, periodic
polling and macOS Keychain device credentials. See `docs/daemon.md` for setup,
limits and pending laptop validation; remote replication remains planned.
