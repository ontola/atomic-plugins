# GitLab read-only catalog provenance

The candidate `gitlab` platform uses a small GitLab.com API v4 OAD subset. The
source is pinned to GitLab's official OpenAPI document at
[`gitlab-org/gitlab@e8b0b4728b9a69a9767a623ca6bf745998061b78`](https://gitlab.com/gitlab-org/gitlab/-/raw/e8b0b4728b9a69a9767a623ca6bf745998061b78/doc/api/openapi/openapi_v3.yaml)
(source SHA-256 `264b5a2ceeada43d2401c1dccd2a576cbb712ac5aa0254d7fec47086255ef764`).
The subset exposes only project listing, project issue listing, and their single
project/issue reads. GitLab's source declares three alternative authentication
schemes; the trusted catalog selects one OAuth profile for the four GET
operations.

The profile requests only `read_api`. GitLab describes this as read access to
the API, including groups and projects. That scope is broader than this
catalog's route coverage, so the proxy profile only permits the selected
project and issue GET operations. It exposes no writes. PKCE with S256 is
supported and recommended by GitLab but is not required by the provider; the
profile therefore advertises S256 support and marks PKCE optional. GitLab's
token endpoint accepts client credentials either in the request body or HTTP
Basic authentication. References: [GitLab OAuth 2.0 API](https://docs.gitlab.com/api/oauth2/),
[GitLab OAuth scopes](https://docs.gitlab.com/integration/oauth_provider/),
and [GitLab REST pagination](https://docs.gitlab.com/api/rest/#pagination).

The overlay adds RFC 8288 `Link` response metadata to the two list operations,
then follows only `rel="next"`; it retains the full URL so server-generated
filters and ordering stay intact. GitLab also documents page-number headers,
but some headers can be absent on GitLab.com, so the overlay does not derive
continuations from them. The projects collection's `membership=true` filter is
a catalog query override, keeping the selection outside the shared CRUD
metadata. Project issue collections inherit the project `id` from the parent
project records. The OAD corrects the issue-list response to an array based on
the documented endpoint behavior; its preserved source file records this
subset-specific correction.

No request-rate quota is declared because this review did not establish a
single reliable quota for these endpoints. No live account or OAuth connection
was tested. The synthetic Syncables fixture verifies collection discovery,
project-to-issue path binding, membership filtering, root input discovery, and
multi-page imports. The ignored integration-proxy fixture checks the composed
OAuth profile and route coverage against the proxy parser; running it downloads
the pinned OAD, so the source pin must be publicly reachable first.
