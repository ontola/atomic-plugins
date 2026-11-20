# Google reconnect consent

During the authorized IAP migration, an older unhosted Keep connection and
Calendar connection returned `credential_refresh_failed`, while a new Keep
connection still read successfully. The failure code does not prove that
refresh tokens were absent. Source inspection does establish that the proxy
stores an absent refresh token when Google omits one and cannot later refresh
that connection. It cannot reuse a token from a different sealed connection or
the retired issuer.

Plan: add immutable companion overlays to the selected Keep and Calendar
offline profiles, requesting `prompt=consent` alongside `access_type=offline`.
The generic runtime already supports fixed authorization query parameters.
Keep issuance conditional, not guaranteed. Preserve scopes, operations, online
alternatives, PKCE, token endpoints, help metadata and all stored connections.

Google documents first-authorization issuance and reconsent in its
[web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server#offline).
This does not resolve a Workspace organization's `invalid_scope` restriction.
Do not revoke shared grants, copy old refresh tokens, or enable incremental
scopes as a workaround.

Composition tests compare full documents after removing only the new prompt
entry, and compare catalogs after removing the two appended overlay URLs.
Production must append these overlays to its actual catalog rather than replace
custom provider selections with this reference catalog.

Live acceptance still requires explicit fresh consent for each provider and a
successful read after the original access token expires. An immediate read
alone is not a durability pass. No token values should be inspected or logged.
