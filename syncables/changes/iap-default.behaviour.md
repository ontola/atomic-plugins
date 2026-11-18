The CLI and daemon now use `https://integrations.atomic.place` when no
issuer is configured. Explicit issuers, including loopback test servers,
are preserved. Existing LocalThought sessions and connection IDs are not
migrated: connect providers at IAP, update the configured issuer and
connection IDs, complete a fresh device login, and import an owner-issued
sealed connection grant before provider reads. Keychain issuer/session
binding prevents legacy credentials or grants from being reused at the
new origin.
