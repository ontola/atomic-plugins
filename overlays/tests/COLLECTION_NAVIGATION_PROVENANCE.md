# GitHub collection navigation evidence

Checked 2026-11-19 against official references. These are declared request,
response and binding shapes; no live authenticated provider verification.

- [List organizations for the authenticated user](https://docs.github.com/en/rest/orgs/orgs#list-organizations-for-the-authenticated-user): `GET /user/orgs`, response items include numeric `id` and string `login`; OAuth classic requires `user` or `read:org`. The existing discovery overlay already requests `read:org`. Fine-grained tokens may return an empty list; this overlay makes no completeness claim beyond the selected credentials.
- [Get an organization](https://docs.github.com/en/rest/orgs/orgs#get-an-organization): `GET /orgs/{org}`, where `org` is the organization name; response includes `id` and `login`. The new transport-address resource uses that documented route; it does not invent a numeric-ID detail endpoint.
- [List organization repositories](https://docs.github.com/en/rest/repos/repos#list-organization-repositories): `GET /orgs/{org}/repos`; `org` is the organization name, `type` defaults to `all`, page size is 1–100 and `page` defaults to 1. Responses carry repository numeric `id`. Public-only access is available without credentials, and the overlay explicitly declares an anonymous security alternative alongside the existing OAuth scheme with `repo`. An anonymous request returns public repositories; an authenticated request is scoped to repositories those credentials can see. This does not assert membership in the organization from a repository owner field.
- [OpenAPI 3.0.3 Link Object](https://spec.openapis.org/oas/v3.0.3.html#link-object): a response may identify a target operation by unique `operationId` and bind its parameter using `$response.body#/login`. A Link does not guarantee authorization to invoke the target.
- [CRUD Causality Reference Object](../../openapi-extensions/spec/crud-causality/README.md#413-references): a referring record binds named fields into a target resource's identity template. A non-enumerable transport-address resource makes the canonical numeric parent identity independent from the mutable `login` used in the detail request.

Published dated catalogs and revision overlays remain unchanged. The new
catalog replaces the GitHub legacy mutation/owner-path CRUD profile with its
read-navigation profile, adds the new overlay, and selects `per_page:100`
for `/orgs/{org}/repos`; every other platform and selection is unchanged.
The numeric canonical identity templates come from the existing builtin-read
model overlay and remain byte-for-byte unchanged in the composed resources.
The library never needs to call numeric organization or repository detail
routes; canonical identity and transport traversal serve different purposes.

The profile has one numeric canonical Issues collection and one numeric
canonical issue-comments collection. It deliberately omits the old mutation
CRUD overlay from the new composition, rather than trying unsupported Overlay
`remove` actions or publishing duplicate owner/name list aliases. Old dated
catalogs still select their original CRUD metadata unchanged. Anonymous
alternatives apply only to GET reads, including documented owner/name routes
and the already-published canonical numeric aliases. Canonical alias public
behavior follows the existing alias mapping; the official GitHub descriptions
below document owner/name routes, not those numeric aliases.

- [Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository): the documented owner/name detail GET supplies numeric `id`, permitting an actual-response Link to the canonical Issues collection.
- [List repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues): public resources are readable without authentication; `state:all` includes closed issues. The list also includes pull requests, as GitHub documents; no issue-only completeness is asserted.
- [Get an issue](https://docs.github.com/en/rest/issues/issues#get-an-issue), [List issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments), and [Get an issue comment](https://docs.github.com/en/rest/issues/comments#get-an-issue-comment): public reads accept anonymous callers. Writes retain their authenticated security declarations.

The active organization schema in the new overlay uses the factual titles
Organizations/Organization and the documented `id`, `login`, `avatar_url` and
`description` fields. It does not carry the prior synthetic User/Personal owner
type branch. A newly named schema is selected by the new profile's resource and
organization response metadata; merge-only overlay application leaves old
published schema definitions untouched and inactive for these reads.

The new profile explicitly titles the repository Issues API schema **Issues
and pull requests** and declares its optional `pull_request` object (with
URL fields). GitHub documents that presence as the discriminator. The generic
reader keeps both row kinds; the prior adapter's PR filtering is deliberately
not reproduced by an extension, catalog filter or runtime provider rule.
