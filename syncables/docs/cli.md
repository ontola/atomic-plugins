# CLI device authentication and local data

This CLI implements the first stages of [#566](https://github.com/ontola/atomic-plugins/issues/566)
adds a CLI to the existing `syncables` npm package. Library imports and the
`syncables/browser` entry remain unchanged. Importing either entry does not
run the CLI or read CLI configuration.

The CLI tests device authorization, connection discovery and a GET through
Local Thought, and saves replication definitions. The [standalone daemon
guide](daemon.md) covers configured syncing, foreground polling/webhooks,
macOS Keychain sessions and commit-pinned Git data browsing. Remote replication
and outgoing writes remain planned. The [cache guide](postgres-cache.md)
covers optional PostgreSQL archival and recorded-run replay.

## Build the source

Use Node 22.11 or newer, including Node 26. CI covers Node 22, 24 and 26.
The source implementation is on `main`; it is not in the currently published
npm release.
For a fresh checkout from any directory:

```sh
git clone --branch main \
  https://github.com/ontola/atomic-plugins.git atomic-plugins-cli-test
cd atomic-plugins-cli-test/syncables
npm ci
npm run build:release
node build/src/cli/main.js --help
```

If using an existing checkout, update `main` and run commands
from its `syncables/` directory. `npm pkg get name scripts.cli:mock` should
report package `syncables` and `node examples/cli-device-server.mjs`.
A missing `cli:mock` script means the current package/checkout does not contain
the implementation; the clone above gives an independent test checkout.

The package has a `bin` named `syncables` pointing to `build/src/cli/main.js`.
The commands below use the source build; the CLI is not claimed to be in the
currently published npm release. No service is installed by npm installation.

## Try the mock device flow

In one terminal:

```sh
npm run cli:mock
```

In another terminal:

```sh
node build/src/cli/main.js auth-test \
  --issuer http://127.0.0.1:11872 \
  --client-id syncables-cli-demo \
  --path '/repos/example/tasks/issues?per_page=1'
```

Open the printed URL, enter the displayed code and approve the invented
connection. The CLI lists the owner and accessible provider connections, then
reports `apiAccess: verified`, HTTP status, content type and response byte count.
This proves the scaffold works against the mock; it is not evidence of real
GitHub access. The mock's approval page uses no real login and is not a
production authorization server.

The default mock port avoids the previous pilot's 11870/11871 ports. Override
it with `SYNCABLES_MOCK_PORT` if needed and use that origin in the CLI command.

## Test the real Local Thought deployment

The device-flow contract is implemented in integration-proxy 0.4.0; its
[device-auth guide](../../integration-proxy/DEVICE_AUTH.md) publishes client ID
`syncables-cli` and scopes `connections:read proxy:read`. The operator must
register that client and configure a working owner approval page at the deployed
issuer. The mock's `syncables-cli-demo` client ID is local-only. Update and
rebuild the checkout before testing:

```sh
git pull --ff-only
npm ci
npm run build:release
```

This first live test does not require PostgreSQL. Request only read access,
approve the existing GitHub connection in the browser, and test one issue:

```sh
node build/src/cli/main.js auth-test \
  --issuer https://localthought.io \
  --client-id syncables-cli \
  --scope 'connections:read proxy:read' \
  --path '/repos/ontola/usertest-findings/issues?state=all&per_page=1'
```

If more than one connection is returned, add
`--connection '<approved-github-connection-id>'`. These are Local Thought
provider connection IDs, distinct from the named replication destinations.
Omit
`--path` to test login and list connections without making a provider request.
The command sends GET only; success logging does not imply write access.

Success means the command prints the authenticated owner and accessible
connections, then `apiAccess: verified`, `status: 200`, JSON content type and
the response byte count. That is evidence of an actual GitHub API read through
the selected connection. The private repository also requires the GitHub App
installation to include `ontola/usertest-findings`; device login alone does not
grant that upstream access.

If it fails, share the terminal error/status only. The CLI does not print tokens
or the provider response body. A discovery 404 means the contract is not yet
available at this issuer. A 404 with `device_auth_disabled` means the operator
must enable the client and configure `DEVICE_APPROVAL_URL`. The `/device` page
only links to that approval page; it does not authenticate an Atomic owner.
A proxy 401/403 or provider 404 needs connection/scope/repository-access
verification.

Discovery uses `/.well-known/oauth-authorization-server` and requires matching
issuer, `device_authorization_endpoint` and `token_endpoint`. If #565 publishes
endpoints before discovery, supply both `--device-endpoint` and
`--token-endpoint`. This scaffold permits HTTPS or loopback HTTP, requires the
device/token endpoints on the issuer origin, and refuses redirects. The
implemented resource contract is bearer-authenticated `/connections` and
`/proxy/{connection_id}/{platform}/{path}`. The contract-fixture test checks
the CLI against the proxy's checked-in contract; only a successful provider
read establishes live compatibility.

Polling obeys the interval, pending/slow-down responses, denial and expiry,
with a 15-minute command cap and 10-second request timeouts. Tokens stay in
memory, are not printed/saved, and are discarded when the command exits.
The `auth-test` command does not persist or refresh sessions; daemon commands
use the separate credential lifecycle described in the daemon guide.
No provider credential is requested by or returned to the CLI.

## Configure replication destinations

Local Thought provider connections and replication destinations are separate.
Each replication definition names its backend, destination and explicit local
collection scope. These examples use invented identifiers; substitute real
values when a backend is implemented:

```sh
node build/src/cli/main.js replication add \
  --name ontola --backend atomic --collections issues,comments \
  --url http://localhost:11870 --drive atomic:example

node build/src/cli/main.js replication add \
  --name nextgraph --backend nextgraph --collections issues \
  --graph did:ng:o:example

node build/src/cli/main.js replication add \
  --name personal --backend remotestorage --collections issues \
  --address user@example.com --module syncables

node build/src/cli/main.js replication list
```

Definitions are private JSON files beneath
`~/Library/Application Support/Syncables/replication` on macOS, or
`~/.config/syncables/replication` elsewhere. `--config-dir` chooses a separate
directory for tests. Adds publish a complete file without overwriting an
existing name, including concurrent adds. No keys or tokens belong in these
definitions. Output says `status: configured` and `replicationImplemented:
false`; no remote access or background job is started.

Atomic and NextGraph native replication require their SDKs, identities,
permissions, commit history and durable protocol state. remoteStorage requires
WebFinger discovery, scoped authorization and ETag-aware document sync.
Configuring an endpoint is not proof that any of those steps has happened.
