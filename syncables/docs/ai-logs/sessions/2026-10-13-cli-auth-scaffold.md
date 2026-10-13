# CLI authentication and replication configuration scaffold

- Tool/model: Codex (OpenAI).
- Session: codex://threads/01a13516-270d-7604-a37e-cc81237fe040
- Scope: first testable stage of atomic-plugins#566; device-server dependency #565.

## Substantive user requests

- Create separate tickets for Local Thought device authentication and the CLI.
  The CLI must live inside syncables and its existing npm package, preserving
  present library usage.
- Build scaffolding first to test device flow and API access. The user will
  test that before functionality is built out step by step.
- Assess whether the daemon can speak Atomic and NextGraph synchronization.
- Add remoteStorage as a third replication backend, with CLI options to set
  up and list replication connections.

## Substantive assistant output and changes

- Created #565 and #566 and linked them. Explained that Atomic/NextGraph
  native replication needs SDK protocol state, whereas remoteStorage uses
  discovery, authorization and document/ETag synchronization.
- Added an isolated npm executable with an auth-test command. It performs
  device discovery/polling, lists connections and optionally probes a GET
  through Local Thought. Tokens remain in memory for this initial stage.
- Added a local mock server for independent manual testing before the server
  device-flow contract is deployed. Mock approval is not production identity.
- Added private, non-secret setup/list configuration for the three replication
  backends, reporting explicitly that runtime replication is not implemented.
- Kept PostgreSQL caching, durable mutation storage, Keychain persistence and
  launchd installation for later stages after user testing.

No private repository data, authentication secrets or real provider records
are included. Test data and identifiers are invented.

## Validation

On Node 22: 1,307 unit tests passed; lint, formatting and TypeScript compilation
passed. A packed npm install preserved both library imports and exposed the
CLI executable. A local mock device approval followed by connection discovery
and a GET API probe passed. Live device-flow/GitHub evidence depends on #565;
macOS runtime replication and launchd installation are not part of this stage.

## Follow-up during terminal testing

The user reported using Node 26 and asked why the package was restricted to
Node 22, then reported a missing cli:mock script. The restriction was inherited
from the existing package/tooling baseline. Node 26.11.1 passed all 1,307 unit
tests, compilation, lint and CLI help. Removed the upper limit while keeping
the minimum at 22.11, added a Node 22/24/26 CI matrix, and clarified that the
mock script requires this source branch and its syncables package directory.

## Local PostgreSQL stage

The user confirmed the mock flow worked in their terminal and authorized
continuing. Added the next stage: separate local PostgreSQL request attempts,
compressed immutable payloads, cache heads, expiring refresh leases and ordered
recorded-run replay. Tokens stay command-local; the live device-flow ticket
still has no implementation contract. The CLI can record/repeat a read and
replay it offline; no proxy-side archive was added.

Added real PostgreSQL tests for deduplication/compression, owner/connection/grant
isolation, parallel refresh coalescing, expired-lease fencing, atomic rollback,
unfinished runs, HTTP 304 body references and paginated Syncables reconstruction.
Collection range metadata, outgoing outbox persistence, native replication,
Keychain and launchd remain subsequent stages. Test records are invented.

The full Node 26 suite passed with PostgreSQL configured (1,320 tests), along
with lint, formatting and TypeScript checks. A Node 22 compiled CLI test
recorded an upstream read and cache hit,
stopped the mock, restarted PostgreSQL, and replayed offline successfully.
Its invented 4,360-byte body occupied one 100-byte compressed payload; that
counts payload bytes only, not database metadata or indexes. Packed root and
browser imports remained usable without opening a database; the installed
PostgreSQL subpath successfully decoded its archived Zstandard/WASM payload.

The user will wait for the localthought.io deployment before the live CLI test
and requested instructions. Clarified source update/build, using the deployed
public client/read-scope values, selecting an approved GitHub connection,
the private repository installation requirement and expected HTTP 200 output.
The live test does not require PostgreSQL or print provider bodies/tokens.
