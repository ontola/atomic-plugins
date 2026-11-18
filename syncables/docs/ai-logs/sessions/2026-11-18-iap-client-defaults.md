# IAP client defaults and legacy-client retirement

Date: 2026-11-18. Tool: OpenAI Codex, GPT-6. Session:
`codex://threads/01a1ca2a-3d99-79b1-8ccb-63e0b2173e97`.

## Substantive human request

> ok please migrate the remaining clients to IAP with the new auth, test them,
> and fully decommission Heroku once nothing is using LocalThought anymore.

The preceding request authorized a verified database backup and remaining-client
audit. Credentials must stay local. Account details and backup settings are
[redacted].

## Substantive output in this change

The audit found runnable LocalThought defaults in Syncables' device CLI and
daemon configuration, the user-test launcher, and manual issue-tracker tools.
Existing device tokens and connection identifiers are bound to their issuer;
changing their origin cannot migrate their authorization.

- Default new CLI/device and daemon configurations to
  `https://integrations.atomic.place`, preserving explicit custom origins.
- Exercise omitted/default, custom, loopback and explicit legacy issuers, and
  verify that a still-valid legacy credential is rejected before IAP network
  use.
- Document persistent device login and the existing owner-issued sealed-grant
  importer. Device approval alone cannot supply the connection key required for
  provider reads. Remove examples claiming otherwise.
- Fetch the Todoist fixture recorder's public catalog from IAP by default;
  its direct Todoist token transport remains unchanged.
- Require an explicit test receiver for the unpublished webhook inbox, whose
  historical runtime-signed protocol lacks production host key handoff. Do not
  insert connection keys into its manifest or graph configuration.
- Default the user-test launcher to IAP, preserving explicit proxy overrides.
  Refuse the known incompatible pinned host before any Docker operation. Its
  browser predates atomic-server#2490, so a compatible tested host is required
  before live deployment.

This change does not assert that a URL replacement migrates installed clients,
and does not delete the Heroku service. The live-client and retirement work is
tracked separately on the coordination board; local identities, destination
tables, journals and verified recovery archives are preserved.

## Validation

The complete Syncables unit suite ran against a disposable PostgreSQL 18
database: 125 files passed, 2,112 tests passed and three unrelated opt-in tests
were skipped. Package build and lint passed, with existing lint warnings.
Focused issue-tracker tests (35), deployment-script tests (three), credential
safety tests (seven), issue-tracker typecheck, formatting, shell syntax and diff
checks passed. No real credentials, grant envelopes, callback codes or provider
response bodies were included in test fixtures or this log.
