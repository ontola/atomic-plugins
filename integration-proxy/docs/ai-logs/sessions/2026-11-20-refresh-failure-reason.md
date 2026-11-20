# Safe renewal failure categories

The IAP migration reproduced an immediate successful Keep read followed by
`credential_refresh_failed` after expiry. That response currently conflates
absent refresh credentials, provider refusal, and unavailable renewal. Repeated
reconnect advice is not an adequate diagnostic and forced Keep consent was
rejected by Google; the Keep-only prompt change was rolled back.

Plan: after the existing caller, connection-key and credential-opening checks,
classify a failed expired-token renewal using only a fixed enum. Preserve HTTP
401 and `credential_refresh_failed`; add an optional `reason` and a fixed,
appropriate message. Do not expose tokens, provider responses, endpoint URLs,
client configuration or arbitrary provider text. Leave unclassified retry paths
and all authentication/authorization behavior unchanged.

Verify all categories, existing wire compatibility, no reason on unrelated
errors, and the actual authorized expired-connection path. Run the proxy suite,
lint/build/package checks and independent review before rollout. Production
must preserve its catalog, settings, grant key and existing connections.

Local result: all 339 proxy tests (including the signed PostgreSQL cases) and
the doctest pass; formatting and clippy pass. Independent read-only review found
no material issues in the classification, authorization boundary or additive
response shape. Build/package/wrapper checks and CI follow before deployment.
