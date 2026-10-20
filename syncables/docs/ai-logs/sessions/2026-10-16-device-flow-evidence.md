# Device-flow verification handoff

- Session: codex://threads/01a14512-47d4-728a-9c9c-98c92f64906d
- Assistant: OpenAI Codex, GPT-6.
- Date: 2026-10-16

## Human request

Michiel requested incorporating the handoff from API keys (local), chat
`01a11a49-4322-7813-aa0d-2f70ada2be33`, into the standalone plan. The handoff
reports completed browser approval, bearer discovery of the selected existing
GitHub connection, a proxied GitHub GET returning 200, session revocation and
a subsequent bearer refusal returning 401. Refresh was not exercised.

The local bridge adaptation uses the existing atomic-drive agent with an
internal macOS Keychain bootstrap instead of exporting an owner seed. It
retains Atomic v2 signing and loopback Host/Origin/CSRF restrictions. The
source adaptation and evidence remain local; absolute personal filesystem
paths and process identifiers are omitted here. No credentials or provider
body were supplied. The request authorizes documentation, not another grant,
runtime implementation, service installation or broader provider access.

## Assistant output and validation

Updated the existing design on current main after #645 merged. Replaced
pending-test wording with attributed results and stable source references.
Recorded the reusable integration-proxy components, local signer boundary,
service brand versus issuer, evidence filenames and remaining production
owner-hub/lifecycle/refresh work. Distinguished example-client protocol
verification from an unreported test of a particular packed #567 executable.

Documentation-only validation: changelog fragments, relative file-link targets,
balanced code fences and diff whitespace. No live test was rerun here and no
runtime source, local owner material or deployed configuration was changed.
