# Keep does not support the forced consent test

The live OAuth acceptance test of #751 failed on Google's own page with
`400 invalid_scope` and “Some requested scopes cannot be shown” for the full
Keep scope. This also occurred for a previously working Workspace test account.
There was no IAP callback or new connection. Requesting a consent screen is not
a safe generic remedy for this Keep profile.

Do not deploy Keep's `reconnect-consent-5ccf0e09eef66d45b43e97dfc364233b2707689c-overlay.yaml`
or use `2026-11-20-google-reconnect-consent.json` as a rollout reference. Published
artifacts remain immutable for provenance; this correction publishes
`2026-11-20-calendar-reconnect-consent.json` instead. It retains Keep's admin
guidance and original offline parameters, and keeps Calendar's separate consent
parameter. It changes no scopes or API permissions.

Plan and verification: restore only Keep's prior parameter selection, verify
Calendar and all other providers are unchanged, and compare full composed
documents. The production rollback removes only the exact Keep companion URL
from the actual on-host catalog, with configuration backup, document/key
comparisons and rollback checks. It does not replace that catalog with this
reference file.

Keep connection durability remains unresolved: an initial successful read was
followed by `credential_refresh_failed` after the first access token expired.
Neither that response nor the consent-screen rejection establishes whether a
refresh token was absent. No credential contents were inspected, no shared
Google grant was revoked, and no old Heroku refresh token was reused.

Google's [Keep authorization guidance](https://developers.google.com/workspace/keep/api/guides)
describes administrator approval through an OAuth client ID as distinct from
service-account impersonation. Its [Workspace production guidance](https://developers.google.com/identity/protocols/oauth2/production-readiness/google-workspace)
describes domain-wide delegation bypassing user consent. Investigate that
supported flow and verify a post-expiry read before claiming Keep migration is
complete. Do not infer Ontola's actual settings without an administrator's review.
