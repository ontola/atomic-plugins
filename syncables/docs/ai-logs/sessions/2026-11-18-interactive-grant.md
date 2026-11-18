# Interactive sealed-grant handoff

- Tool/model: Codex, GPT-6, delegated implementation.
- Session: `codex://threads/01a1ca2a-3d99-79b1-8ccb-63e0b2173e97`.
- Scope: foreground Syncables authentication; no provider consent, deployment,
  profile migration, credentials or provider data were accessed by this work.

## Human request

> ok please migrate the remaining clients to IAP with the new auth, test them,
> and fully decommission Heroku once nothing is using LocalThought anymore.

The existing per-send Keep consent launcher was one retained client. The parent
implementation brief approved a bounded foreground grant handoff so that client
can use client-held-key authentication while preserving per-send write consent.

## Implementation and outcome

Added the explicit `--connection-grant-stdin` opt-in for interactive sync/send.
It selects one declared remote connection/platform, performs a fresh device
login, reports only public binding metadata, reuses the bounded sealed-grant
parser/importer, and uses an immutable copy-on-boundary memory store. Sync asks
for read scope; send retains fresh explicit write consent. The optional write
transport grant header does not bypass existing scopes or request guards.

Cleanup drops grant references and revokes only the new ephemeral session.
An opt-in provisional refresh-token reference allows cleanup if owner/scope
checks fail after authorization; it never exposes an unverified usable session.
Ephemeral revocation does not depend on a functioning local database lock.
Default interactive and persistent credential lifecycles remain unchanged.

Tests use invented authorization responses and grant data only. The tests cover
scope denial, exact selected bindings, expiry, input timeout, memory immutability,
no Keychain access, read/write transport handoff, database/action failure and
session revocation. Existing PostgreSQL integration tests need a disposable local
database; the parent records final validation and supplies the commit/session
trailers. No live OAuth result is claimed by these synthetic tests.

Validation completed: build/typecheck, package formatting, changelog validation
and diff checks passed. The final full suite used a separate disposable local
PostgreSQL database: 126 files passed, 2,136 tests passed and three unrelated
opt-in tests were skipped. The local run used two workers and a 30-second
command-line timeout after earlier runs hit existing Git test time limits on a
busy shared host; repository timeout defaults were not changed. Focused
interactive/CLI/edit-transport coverage also passed. No provider data or
credentials were used in those tests.
