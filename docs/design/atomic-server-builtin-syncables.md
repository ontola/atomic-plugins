# Contract with Atomic Server's built-in Syncables iframe

**Status:** GitHub implementation and selected-read contract, 2026-11-16
**Issues:** [atomic-plugins#733](https://github.com/ontola/atomic-plugins/issues/733), [atomic-server#2521](https://github.com/ontola/atomic-server/issues/2521).  
**Atomic Server design:** `planning/builtin-syncables-apps.md` and `planning/builtin-syncables-wireframes.md` on the `feat/builtin-syncables-foundation` branch.

## Responsibility boundary

The Apps catalog lists provider definitions. GitHub is the first provider that Atomic Server can install as a configured instance of its built-in Syncables UI. The UI and collector run **inside Atomic Server's existing null-origin sandboxed iframe**; their code is bundled and delivered by Atomic Server, not downloaded from the integration proxy or independently installed per platform.

This repository maintains the reusable browser-safe `syncables/browser` engine, provider OpenAPI descriptions/extensions, and integration-proxy implementation. Provider-specific code may later replace the generic built-in renderer while preserving the host's view-kind/source-binding contract.

The existing `integrations/pets/app/` and `integrations/notion/app/` code remains useful **as behavioral references**, not as the new release/distribution mechanism. The old `integrations/localthought/plugin.ts` generic sandbox mapper is a reference only (retired runtime).

## Proxy catalog contract

Existing public endpoints:
- `GET /catalog/apps` → version 1 app metadata with service IDs, display labels, descriptions and composed-document paths.
- `GET /catalog` → JSON array of platform IDs (e.g. `["github-issues", "google-calendar"]`).
- `GET /catalog/{platform}.yaml` → composed OpenAPI document.
- `GET /catalog/{platform}.selection.json` → selection metadata, where available.

Clients can fall back to the legacy catalog. The metadata contains provider
descriptions and document paths. Catalog JSON is data and cannot install or
execute a JavaScript module.

The default `catalog/2026-11-16-syncables-github.json` adds GitHub
organization discovery and declares the `state` query for stable repository-ID
Issues reads. It includes GitHub's `read:org` scope for listing memberships.
Existing pinned catalogs retain their published contents. A self-hosted
deployment with an explicit `CATALOG_PATH` must select the new catalog for
organization discovery. The host can still group accessible repository owners
when an older selected catalog has no organization endpoint.

## Syncables browser reader contract

The host should be able to supply:

```ts
type CollectionSelection = {
  proxyOrigin: string;
  platform: string;
  connectionId: string;            // reference, never credential
  documentRevision: string;        // pinned or explicitly upgradable
  collectionDefinition: string;    // from crudResources
  context: Record<string, string>; // e.g. owner/repository provider IDs
  remoteInstanceId?: string;
};

type ReadOutcome = {
  records: unknown[];
  coverage: unknown;               // complete / incomplete and reason
  errors: unknown[];
};
```

*Illustrative types, not a proposed finalized API signature.*

- `describePlatform(document)` enumerates **collection definitions** and root parameters. It does not necessarily enumerate concrete accessible collection instances.
- Provider calls to enumerate **instances** (organization, repository, calendar, database) are made through the **host's scoped proxy transport**, using OpenAPI `crudResources` parent/binding relationships.
- GitHub user login discovers accessible **organizations and personal owner namespaces**, and repos must be placed under their canonical owner. An accessible organization is not a child owned by the OAuth account.
- The browser reader must read a *selected collection instance* with explicit path bindings and without inadvertently fetching every descendant collection.
- Stable provider identities, pagination coverage and source checkpoints must survive view reload and moving/linking of destination Atomic resources.
- Failed or non-exhaustive remote reads never imply deletion of missing local rows. Preserve typed value mapping; idempotent re-run only updates changed rows.

## Security invariants

Provider tokens, OAuth secrets and refresh credentials remain sealed at the
integration proxy. For GitHub, Atomic Server's top-level host performs keyed
PKCE redemption and owner-signed provider reads. The iframe can request named
read operations over the existing bridge. The host binds each request to a
known platform, connection and, for Issues, numeric repository ID. The
browser-derived connection key, signer, and provider credentials stay outside
the iframe. The host applies typed updates to the selected Atomic table using
the signed-in user's existing permissions.

No automatic remote writes or background sync for initial implementation.

## E2E scenarios

- Pets: flat collection listing, typed records, no credentials.
- GitHub: connect account → discover organizations/personal namespace → discover repositories for one canonical owner → create/reuse Issues mirror for exactly one repository.
- Repeat setup, two account connections, duplicate discovery, reauthentication, quota/partial-read errors, pause/reload/move of mirrored table.
- Proxy catalog legacy fallback, new icon metadata and untrusted icon source handling.
- Iframe cannot access host credentials, and the host refuses writes outside declared destination.

## Decisions explicitly deferred

Folder-versus-table semantics; bidirectional sync; cross-account mirror deduplication policy; unattended sync; specific view framework/API internals. The Atomic resource hierarchy is a default navigational layout, not part of stable remote collection identity.
