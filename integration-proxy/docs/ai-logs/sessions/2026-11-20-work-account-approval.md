# Work-account approval flow

User request: improve the flow when a work account needs its domain
administrator's review before connecting. A live Keep attempt stopped on
Google with `invalid_scope`, before the callback; the user has no domain admin
access. That observation alone does not confirm the organization's settings.

Plan:

1. Keep provider policy in an immutable overlay; validate optional plain-text
   authorization help on the selected scheme generically.
2. Explain prerequisites before OAuth and offer a reusable, state-free help
   page with a copyable request containing only public client/scopes details.
3. Tell the user to start a fresh connection from their app after approval;
   never keep or resume an expiring attempt, or claim approval succeeded.
4. Test selection, unchanged scopes, unavailable help, escaping and security
   headers; compose the Keep overlay and prove every other API byte is
   unchanged. Verify clipboard success/fallback and narrow-screen rendering.

Boundaries: no admin settings changes, no outbound admin message, no service
accounts, no changes to atomic-server #2522, existing connections or provider
permissions. Existing source-default dated catalog remains unchanged; production
must explicitly select the new catalog when deploying the matching build.

Read-only design review delegated to the existing client-auth-design agent.
Google's Keep documentation calls OAuth-client-ID approval domain-wide
delegation too; explain its authenticated-user-only behavior and distinguish
it from impersonation. Keep `invalid_scope` guidance conditional.

Validation and publication results will be recorded after the checks finish.
