Interactive `sync` and `send` can opt into `--connection-grant-stdin` for
an owner-issued sealed IAP grant bound to one selected remote connection
and a fresh device session. The bounded handoff stays in process memory,
never touches Keychain, and revokes the ephemeral session on completion or
failure. Send still requires fresh write consent; sync remains read-only.
