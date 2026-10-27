Syncs now maintain a normal Git working folder per collection under `data`
beside the private Git archive (configurable with `checkoutDirectory`). Local
edits block automatic updates instead of being overwritten. Existing snapshots
can be exposed offline with `syncables checkout`; it adds API-specific classes
and schemas in a new commit while preserving original history and payloads.
