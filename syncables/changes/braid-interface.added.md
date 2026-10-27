SyncD can serve selected PostgreSQL snapshots with the new local-only braid
command: authenticated versioned GETs, read-only Braid subscriptions, bounded
replay after reconnect and explicit full-snapshot reset. JSON-AD records and
bundled schemas travel as text to preserve numeric lexemes. The listener is
independent of provider login, Git export and the Atomic adapter; writes and
patches are not supported. See docs/braid.md for commands and limits.
