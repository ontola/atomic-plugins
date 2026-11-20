# OAuth registration binding and safe rotation

Tool: OpenAI Codex; exact model/version is not exposed to this worker. Session:
`codex://threads/01a1ca2a-3d99-79b1-8ccb-63e0b2173e97`.
Worker: `oauth_client_binding`; parent reviews and publishes the change.

## Human prompts

The user asked to finish moving saved clients to IAP with client-held-key
authentication and test them through SyncD. Live testing found that one
provider issued short-lived access without renewal credentials. The user asked
whether its connectors should use separate OAuth client IDs, then said to keep
working and treat SyncD as a real IAP test client. Credentials remain private;
provider settings, identities and data are omitted from this source log.

## Substantive output and design

Code inspection found that encrypted OAuth credentials did not record their
issuing client ID. Renewal always loaded the deployment's current registration.
Pending authorizations also reloaded the current client at callback time. A
registration change could therefore use the wrong credentials for old tokens or
in-flight code exchanges.

The implementation adds an optional client ID to the existing encrypted
credential and sealed browser context, with backward-compatible parsing. New
authorizations use the active registration; exchanges and renewal use the bound
one. Generic private deployment configuration can retain multiple old clients
and explicitly select the fixed registration for pre-binding data. Unknown IDs
refuse before token-endpoint traffic. Successful legacy renewal pins its ID.
No SQL migration, provider-specific runtime data or branching, scope change,
connection-key storage, ownership change or credential export is introduced.

Configuration parsing rejects malformed/ambiguous registries and emits fixed
errors. Retained clients preserve their explicit supported authentication
method. Configured-provider debug output is redacted. The authorization flow
still checks its single-use state, platform and browser binding before token
exchange; request renewal still follows caller/policy/key/decryption checks.

## Validation and limits

Pure tests cover parsing, current/retained/legacy selection, malformed and
duplicate inputs, unsupported authentication, and redacted errors/debug output.
Synthetic signed PostgreSQL requests verify old/unbound/current/public renewal,
wrong caller and absent/wrong key isolation, no upstream request for an unknown
binding, preservation of tokens and encrypted bindings. A full synthetic flow
starts before rotation, completes with the retained client, redeems under an
owner's signature and checks the stored binding; new and legacy contexts,
cookie/replay/cancellation and PKCE behavior are covered too.

The worker's targeted tests, formatting, all-target compile and warning-free
Clippy pass. The parent full suite passes all 345 tests, including PostgreSQL
and network cases, plus the doctest. Independent read-only source review found
no actionable material findings; it did not independently rerun the suite or
exercise real providers. Package/wrapper validation and exact-head CI remain
publication gates. No production or real credential operations are performed
by this source change. It enables safe
registration rotation but does not claim that any provider's missing renewal
credentials have been fixed or that a new registration has been deployed.
