# Work-account authorization help

An organization's policy can stop authorization on the provider's own site,
before the browser returns to the proxy. The proxy cannot reliably detect that
error or decide whether an administrator has approved an app.

An OAuth security scheme may declare `x-oauth-authorization-help`:

```yaml
x-oauth-authorization-help:
  summary: Work accounts may need approval from their organization.
  adminApproval:
    description: Ask your administrator to review this OAuth app and its scopes.
    documentationUrl: https://provider.example/admin/oauth
```

`summary` is required, nonempty plain text. `adminApproval` is optional; when
present, both its nonempty plain-text `description` and a credential-free
HTTPS `documentationUrl` without a fragment are required. Unknown fields and
invalid declarations are refused when resolving the selected OAuth scheme.
Author provider-specific text in an
immutable overlay, never in the proxy runtime. This is a presentation extension:
it does not grant permissions, alter scopes or make approval mandatory for every
account. It belongs on the selected OAuth scheme, including when selected by an
authentication profile.

The connect page shows the summary and a help link **before** starting OAuth.
`GET /oauth/{provider}/help` is a public, reusable page: it needs no pending
connection, cookie or query string. For configured providers with admin help it
includes a copyable request containing the public client ID, proxy origin,
exact requested scopes and their descriptions, and the declared instructions
and documentation. It never includes a client secret, account email, Atomic
identity, destination, connection key, authorization code, state or PKCE value.
It creates no connection, OAuth attempt or admin request. The person chooses
whether and where to share the text. A selectable text box remains usable when
clipboard access fails or JavaScript is unavailable.

After approval, return to the application and start a new connection. The help
page does not resume an expired attempt, assert that approval succeeded, or
automatically retry sign-in. Existing connections are unaffected. Cancelling
at the provider continues to use the existing callback cancellation flow.

## Google Keep

The Keep overlay links Google's [Keep authorization guidance](https://developers.google.com/workspace/keep/api/guides).
Google documents administrator approval through **OAuth client ID** domain-wide
delegation as the option limited to the authenticated person's Keep data. This
flow does not introduce service-account impersonation. An administrator must
review the app and requested scope; approval is not a promise of API availability.
The current profile requests the full Keep scope, including creating and
permanently deleting notes, and the request says so even if a particular test
only reads notes.
