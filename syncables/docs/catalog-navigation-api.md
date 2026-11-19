# Catalog identity and collection navigation API

Browser-safe exports from `syncables/browser` (also the Node root).

```ts
describeAuthenticatedPrincipals(document): AuthenticatedPrincipalDescription[]
resolveAuthenticatedPrincipal(document, {
  operationId?, namespace?, clientContext?, transport
}): Promise<AuthenticatedPrincipal>

describeCollections(document): CollectionDescription[]
bindCollectionNavigation(document, {
  collection: string, sourcePath: string, context?: Record<string, string>
}): CollectionNavigation
bindCollection(document, {
  collection: string, context?: Record<string, string>, selection?: QuerySelection
}): BoundCollection
relatedCollectionReads(document, {
  resource: string, record: Record<string, unknown>, context?: Record<string, string>
}): CollectionNavigation[]
resolveCollectionNavigation(document, navigation, { transport }): Promise<BoundCollection>
readBoundCollection(document, bound, options): Promise<CollectionReadResult>
validateCollectionRead(document, bound, request): boolean
validatePrincipalRead(document, request, { operationId?, namespace? }?): boolean
validateCollectionNavigationRead(document, navigation, request): boolean
validateCollectionEntryRead(document, request, {
  publicOnly?: boolean, collection?: string, sourcePath?: string
}?): boolean
projectReadRecord(document, { collection, record, context?, ontology? }): ReadRecord
```

`AuthenticatedPrincipal` returns `{namespace,subject:string|number,kind,
identifier,clientContext?,claims,record}`. Number subjects are safe integers;
string subjects retain their exact text. Only stable, non-reassigned identities
resolve. Client-scoped identities require the caller's client context. Claims
are optional presentation metadata. The transport supplies credentials and
trust; the metadata does not authenticate them.

`CollectionDescription` extends the existing read collection metadata with
`schema` (resolved), `inputs` (path parameter names, required flag, title and
schema), `allowsAnonymous` and `requiresAuthentication` (effective OpenAPI
security; absent/empty security or an anonymous alternative allows anonymous
reads), `presentation: {title, columns}` (column `field`,
normalized `property`, `label`, `datatype`, optional `format` and enum `labels`),
`entrypoints` (source `sourcePath`, `method: 'GET'`, `operationId`, `inputs`,
`allowsAnonymous`, and `link`), and `relationships`, derived only from CRUD identity/reference bindings and
standard OpenAPI Response Link Objects. Collection names must be unambiguous in these
APIs. `BoundCollection` is serializable `{collection,resource,pathParams,path,
method,query,body}`. `CollectionNavigation` is a serializable discriminated union:

```ts
{ kind: 'direct', collection, resource, parentResource, bound: BoundCollection }
{ kind: 'responseLink', collection, resource, parentResource, reference,
  source: {path, template, method: 'GET', operationId, pathParams}, link }
{ kind: 'entrypoint', collection, resource,
  source: {path, template, method: 'GET', operationId, pathParams}, link }
```

The direct form binds the child from the parent's declared identity fields
and carried path context. The response-Link form follows a declared reference
to a non-enumerable transport-address resource and its response Link.
Hosts may persist descriptors during explicit Sync and display them without
fetching provider data. `relatedCollectionReads` only evaluates declared CRUD identity bindings and
Reference Objects against stored records. `resolveCollectionNavigation` performs
the declared source GET and evaluates its successful response's Link Object;
it never treats a list element as an HTTP response.

For a canonical organization `/organizations/{organization_id}` bound to its
numeric `id`, a CRUD reference to an address resource `/orgs/{org}`, binding
`org` to `login`, expresses a mutable transport address independently of the
canonical identity. That address resource needs no collection. Its GET response
can link to `/orgs/{org}/repos` with `org: $response.body#/login`. Both steps use
existing standards: CRUD Causality §4.1.3 and OpenAPI 3.0.3 §4.7.20. The alias
resource describes an address for navigation; it is not a second stored parent.
The GitHub overlay preserves the existing numeric identities and adds only
this explicitly declared chain.

`validateCollectionRead` is an endpoint scope check, not authentication or a
proof of provider authorization. It requires the exact bound URL/method,
unchanged fixed request values, same server origin/base, and declared paging
parameters (including range-window bounds). A next-link scheme may carry
operation-declared query parameters on that same bound path; the page walker still validates next-link provenance,
origin and loops. Fixed values remain enforced. `readBoundCollection` reads
only that collection instance, without sibling discovery, through the existing
pagination engine. Atomic owns stored graph shape, UI and permission grants.

`projectReadRecord` is the existing `readPlatform` projection as a pure public
function. Pass a `ReadCollection`/`CollectionDescription`, its raw record, and
its path context. An optional prederived ontology avoids rebuilding it per
record. The result retains the existing `ReadRecord` shape (`resource` is
normalized, `namespace`, `id`, `name`, `values`); keep `collection.resource` for
the exact CRUD key. Scalar schema/datatype validation and timestamp conversion
are shared. Malformed fields or identities throw. Runtime-schema results remain
on each raw snapshot and may be attached by the host as before.

Supported Link subset: a success status explicitly declared as `2xx` digits,
a unique local `operationId` or local JSON-Pointer `operationRef`, path-only
parameters using literals, `$response.body#<pointer>` or `$request.path.<name>`.
Links with external operation references, a server override, request-body
binding or multiple target collection aliases are not advertised. Multiple
individually named direct collection aliases remain distinct; duplicate names
across resources fail binding instead of picking a global first match.

Public collection setup can choose an anonymous source entrypoint and collect
its declared path inputs (for example repository owner/name). Bind it with
`bindCollectionNavigation`, resolve its actual GET response Link, then persist
only the canonical resulting `BoundCollection`. This performs no list read
and fabricates no parent principal or record. `validateCollectionEntryRead`
lets a host authorize only these trusted-catalog source GETs, with no query
or body; `publicOnly:true` additionally requires anonymous operation security.
Saved child workers continue using the narrower exact navigation/list validators.
A native Open follows stored tables only and performs none of these requests.

Required provider properties still require presence in `projectReadRecord`.
A required property accepting null (`nullable:true` or `type:[T,'null']`)
is recommended rather than required in the derived Atomic class, since null
is omitted by projection. A present nullable null yields no projected value,
allowing the host to clear its previously managed value. Missing required
fields and nonnullable required nulls are rejected before persistence.
