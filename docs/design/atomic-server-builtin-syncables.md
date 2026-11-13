# Contract with Atomic Server's built-in Syncables iframe

**Status:** design agreement, 2026-11-13  
**Issues:** [atomic-plugins#733](https://github.com/ontola/atomic-plugins/issues/733), [atomic-server#2521](https://github.com/ontola/atomic-server/issues/2521).  
**Atomic Server design:** `planning/builtin-syncables-apps.md` and `planning/builtin-syncables-wireframes.md` on the `feat/builtin-syncables-foundation` branch.

## Responsibility boundary

The *consumer-facing* GitHub, Notion, Calendar, etc. entries are **configured platform instances** of Atomic Server's built-in Syncables UI. The UI and collector run **inside Atomic Server's existing null-origin sandboxed iframe**; their code is bundled and delivered by Atomic Server, not downloaded from the integration proxy or independently installed per platform.

This repository maintains the reusable browser-safe `syncables/browser` engine, provider OpenAPI descriptions/extensions, and integration-proxy implementation. Provider-specific code may later replace the generic built-in renderer while preserving the host's view-kind/source-binding contract.

The existing `integrations/pets/app/` and `integrations/notion/app/` code remains useful **as behavioral references**, not as the new release/distribution mechanism. The old `integrations/localthought/plugin.ts` generic sandbox mapper is a reference only (retired runtime).

## Proxy catalog contract

Existing public endpoints:
- `GET /catalog` → JSON array of platform IDs (e.g. `["github-issues", "google-calendar"]`).
- `GET /catalog/{platform}.yaml` → composed OpenAPI document.
- `GET /catalog/{platform}.selection.json` → selection metadata, where available.

These must remain backward-compatible. Define a separate structured, versioned service metadata endpoint with fields such as:

```json
{
  "version": 1,
  "platforms": [{
    "id": "github-issues",
    "name": "GitHub",
    "description": "Browse repositories and sync issues",
    "icon": "https://example.org/static/github.svg",
    "document": "/catalog/github-issues.yaml",
    "status": "available"
  }]
}
```

*Schema illustration only:* the endpoint path, icon provenance, safe URL policy, status semantics and possible authentication/profile variants are implementation choices, not existing features. Browser clients must accept the old `GET /catalog` array with fallback labels/icons until the new endpoint is deployed.

Icons are **untrusted data**: whitelist safe HTTPS origins (or same proxy), content types and size; avoid injecting provider-supplied SVG or HTML into the app DOM. The catalog is not an executable-code registry.

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

Provider tokens, OAuth secrets and refresh credentials remain sealed at the integration proxy. The generic iframe obtains **only scoped, short-lived proxy capabilities** via Atomic Server's host bridge. No provider URL chosen by user content may bypass the proxy's allowed operations; no unrestricted network calls from sandbox code. Host grants narrowly authorize creation/update of explicitly selected Atomic destination tables rather than all of drive root. A connection reference is not authorization by itself.

No automatic remote writes or background sync for initial implementation.

## E2E scenarios

- Pets: flat collection listing, typed records, no credentials.
- GitHub: connect account → discover organizations/personal namespace → discover repositories for one canonical owner → create/reuse Issues mirror for exactly one repository.
- Repeat setup, two account connections, duplicate discovery, reauthentication, quota/partial-read errors, pause/reload/move of mirrored table.
- Proxy catalog legacy fallback, new icon metadata and untrusted icon source handling.
- Iframe cannot access host credentials, and the host refuses writes outside declared destination.

## Decisions explicitly deferred

Folder-versus-table semantics; bidirectional sync; cross-account mirror deduplication policy; unattended sync; specific view framework/API internals. The Atomic resource hierarchy is a default navigational layout, not part of stable remote collection identity.
