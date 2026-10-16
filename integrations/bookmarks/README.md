# Bookmark lenses

This folder contains an **unhosted library**, with no drive app, catalog entry,
connection, polling or provider transport. Its Raindrop prototype uses the
unreleased `devonian/lenses` source and `devonian/atomic`; npm Devonian 0.8.0
does not provide the former. Tests alias both package imports to this repo.

[`devonian/raindrop/lens/index.ts`](devonian/raindrop/lens/index.ts) maps a
complete existing Raindrop record into Atomic's built-in
[`Bookmark`](https://atomicdata.dev/class/Bookmark): `title` → name,
`link` → URL, `excerpt` → description. The URL property is the singular
`https://atomicdata.dev/property/url`, whose datatype is **string**.
Description carries the same characters into Atomic's Markdown property;
Markdown punctuation may affect its rendering.

The value lens preserves `_id`, collection, tags, provider notes, timestamps,
media and unknown fields. An unchanged empty description preserves an absent
excerpt. In the Atomic projection, an absent excerpt explicitly unsets a stale
description. Removing a native description when the previous excerpt is
nonempty plans `excerpt: ''`. All other native properties remain outside the
projection. `isA`, name, URL and description are the managed properties.

`raindropUpdatePlan(resource, previous)` returns `{ id, body }` with only
changed `title`, `link` and `excerpt` fields for
[`PUT /rest/v1/raindrop/{id}`](https://developer.raindrop.io/v1/raindrops/single).
An empty body is a no-op: the host should send no request. The previous record
must be current and complete; conflict checks and authorization belong to the
host. Numeric IDs must be positive safe integers. Text limits are conservative
UTF-16 code-unit limits of 1000 for title and 10000 for excerpt; only absolute
HTTP(S) destination URLs are supported. Source contract:
[Raindrop fields](https://developer.raindrop.io/v1/raindrops).

Bind `_id` as a **number**, scoped by the account connection and entity
`raindrop`, using `AtomicIdentityMap`. Two bookmarks with the same destination
URL can be separate records. Never use the title, URL or content as identity.
The schema helper is an offline property catalog, not a class validator or a
published ontology registration.

## Checks

From the repo root, after `node integrations/tooling/link-atomic-server.mjs`:

```sh
node integrations/tooling/run-lane.mjs bookmarks --tier typecheck
node integrations/tooling/run-lane.mjs bookmarks --tier unit
```

The tests use invented records and local `AtomicStore` state. They check laws
on supported views, field preservation, explicit clears, minimal update plans,
invalid values and identity snapshots. No Raindrop request, real AtomicServer
write, create/delete behavior, browser host installation or live round trip
has been verified.

See [the ontology/API and Solid overview](../../docs/design/ontology-api-lenses.md)
for other targets and the separate Solid RDF bookmark lens.
