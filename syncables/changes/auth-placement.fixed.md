`apiKeyAuth` takes `cookie` as well as `header` and `query`, the third
place an OpenAPI `apiKey` security scheme can put a key: it adds the
cookie to the request's `cookie` header, keeping the others. It and
`bearerAuth` now replace a header of the same name in any case; before,
a request with `Authorization` or `X-Api-Key` already set was sent with
both that header and the lower-case one the adapter added.
