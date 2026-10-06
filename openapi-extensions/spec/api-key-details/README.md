# OpenAPI API Key Details Extension

**Spec version:** 0.2.0-draft

---

## 1. Introduction

OpenAPI describes a static API key with an `apiKey` Security Scheme Object:
the parameter's `name`, whether it goes `in` a header, query parameter or
cookie, and a free-text `description`. A personal access token sent as
`Authorization: Bearer <token>`, or inside an `Authorization: Basic`
credential, is described instead with a Security Scheme Object of
`type: http` and `scheme: bearer` or `scheme: basic`. A client that asks a
person to paste such a key or token still has to know things the scheme does
not say:

- where the person creates or finds the key, as a link it can show next to
  the key field;
- how to tell, before storing the key, whether the provider accepts it; and
- for HTTP Basic, which half of the credential the pasted token is, and what
  the other half is. Without that, a client can only ask for a username and
  a password, which invites the person to type their account password.

This proposal adds `x-api-key-details` to a Security Scheme Object of
`type: apiKey`, or of `type: http` with `scheme: bearer` or `scheme: basic`.
It holds an optional help link, an optional **key check** (one operation of
the same document that a consumer calls once with the pasted key, before it
stores the key, to learn whether the provider accepts it and, optionally, a
label to show for the stored credential), and, for HTTP Basic only, the
**basic credentials** layout.

The extension describes the provider. It does not prescribe how a consumer
stores keys, how often it re-checks them, or what it shows to the person
beyond the fields below. "Key" below means an API key or an HTTP token
alike.

## 2. Overview

```yaml
components:
  securitySchemes:
    serviceApiKey:
      type: apiKey
      in: header
      name: X-Api-Key
      description: A personal API key, created under Settings, API keys.
      x-api-key-details:
        helpUrl: https://service.example/help/api-keys
        keyCheck:
          operationId: getCurrentUser
          label: $response.body#/email
paths:
  /user:
    get:
      operationId: getCurrentUser
      security:
        - serviceApiKey: []
      responses:
        '200':
          description: The user the key belongs to.
          content:
            application/json:
              schema:
                type: object
                properties:
                  email: {type: string}
```

The same help link for a bearer token, and a provider that takes its API
token as the Basic username with a fixed password (a `keyCheck` on either
needs an operation that requires that scheme, §4.2):

```yaml
components:
  securitySchemes:
    personalToken:
      type: http
      scheme: bearer
      x-api-key-details:
        helpUrl: https://service.example/help/tokens
    tokenAsBasicUser:
      type: http
      scheme: basic
      x-api-key-details:
        basicCredentials:
          token: username
          password: api_token
```

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "SHOULD NOT" and
"MAY" in this document are to be interpreted as described in
[BCP 14](https://www.rfc-editor.org/info/bcp14) when, and only when, they
appear in all capitals.

`$response.body#...` is an OpenAPI Runtime Expression. The suffix is a JSON
Pointer evaluated against the key check's successful response body.

## 4. Object Definitions

### 4.1 API Key Details Object

`x-api-key-details` MAY appear only on a Security Scheme Object whose `type`
is `apiKey`, or whose `type` is `http` and whose `scheme` is `bearer` or
`basic` (compared case-insensitively, as HTTP authentication scheme names
are).

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `helpUrl` | absolute `https` URI | no | A page where the person creates or finds this kind of key. |
| `keyCheck` | Key Check Object | no | The operation that tells whether a key is accepted. |
| `basicCredentials` | Basic Credentials Object | see below | Only on an `http` `basic` scheme: where the pasted token goes in the Basic credential. |

Unknown fields are invalid in this version, and `basicCredentials` is
invalid on any scheme other than `http` `basic`. A consumer SHOULD NOT ask a
person for a credential of an `http` `basic` scheme that has no
`basicCredentials`, since nothing then says that the password is not the
person's account password (Security Considerations).

`helpUrl` MUST be an absolute `https` URI without userinfo. A consumer that
shows it MUST present it as a link the person chooses to follow (for an
HTML page: a plain `<a>` that opens in a new browsing context with
`rel="noopener noreferrer"`), and MUST NOT navigate to it, fetch it, or
redirect to it on the person's behalf. The link carries no key, state or
return address. The scheme's `description` remains the place for how-to
text; `helpUrl` adds a destination, not instructions.

### 4.2 Key Check Object

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `operationId` | string | yes | The `operationId` of the operation to call. |
| `label` | response-body Runtime Expression | no | A display label for the accepted key, from the check's response. |

Unknown fields are invalid in this version.

The referenced operation MUST:

1. be an Operation Object of this document, found by its `operationId`;
2. use the `GET` method;
3. have a path without template expressions, and declare no parameters
   (neither on the operation nor on its Path Item) and no request body;
4. be served by the document's first Server Object, whose URL MUST be an
   absolute `https` URL without variables;
5. require this security scheme: its effective Security Requirement (its own
   `security`, or else the document's top-level `security`) MUST contain a
   requirement whose only member is this scheme.

The operation SHOULD be free of side effects and cheap: a "current user",
"current account" or "token info" operation fits. It need not return
anything the consumer otherwise uses.

`label`, when present, selects a JSON string. A consumer MAY show it to the
person as a description of the stored credential ("connected as …"). It is
display metadata only: consumers MUST NOT use it as an identity key or to
decide which account a credential belongs to (the
[Authenticated Principal](../authenticated-principal/README.md) extension
describes identity). An absent, non-string or empty value means no label; the
key is still accepted.

### 4.3 Basic Credentials Object

An HTTP Basic credential is a username and a password (RFC 7617). This
object says which of the two the pasted **token** is, and what the other is.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `token` | `"username"` or `"password"` | yes | Which half the pasted token fills. |
| `password` | string | when `token` is `username` | The fixed password sent with the token; MAY be empty. |
| `username` | string | see below | When `token` is `password`: the fixed username. |
| `usernameLabel` | string | see below | When `token` is `password`: the label of a field in which the person types the username (an email address, an account name). |

Unknown fields are invalid in this version. Exactly these combinations are
valid:

1. `token: username` with `password`, and neither `username` nor
   `usernameLabel`;
2. `token: password` with `username`, and neither `password` nor
   `usernameLabel`;
3. `token: password` with `usernameLabel`, and neither `password` nor
   `username`.

A fixed `username` MUST be non-empty and MUST NOT contain `:`. A
`usernameLabel` MUST be non-empty after trimming and at most 100 characters.
No value may contain control characters. There is deliberately no
combination in which the person types a password: the only secret the person
enters is the token.

A consumer builds the credential from these declarations and what the person
entered, and sends `Authorization: Basic` with the base64 of
`username:password`. A token used as the username MUST NOT contain `:`, and
neither may a typed username; a consumer refuses such input rather than
send an ambiguous credential.

### 4.4 Calling the key check

A consumer that declares support for `keyCheck` calls the operation **once,
before it stores a newly entered key**, sending that key exactly as the
security scheme says, and no other credential: for an `apiKey` scheme as its
`name` and `in` say; for `http` `bearer` as `Authorization: Bearer <token>`;
for `http` `basic` as the `Authorization: Basic` credential §4.3 describes.
It then reads the response status:

| Status | Meaning | Consumer action |
| --- | --- | --- |
| 2xx | The provider accepts the key. | Store the key; evaluate `label`. |
| 401 or 403 | The provider rejects the key. | Store nothing; ask for the key again. |
| anything else, or no response | Undetermined. | Store nothing; report an error. |

A consumer MUST NOT follow redirects from the check, MUST bound it with a
short timeout, and MUST NOT include the key in logs, error messages, or
anything shown to the person. A 3xx response is "undetermined".

A consumer that does not support `keyCheck` ignores it and stores the key
as it would without this extension.

## 5. Applying via OpenAPI Overlays

An overlay can add the extension to a provider's existing scheme, and add the
check operation if the source document lacks one:

```yaml
overlay: 1.0.0
info:
  title: API key details for Service
  version: 1.0.0
actions:
  - target: $.components.securitySchemes.serviceApiKey
    update:
      x-api-key-details:
        helpUrl: https://service.example/help/api-keys
        keyCheck:
          operationId: getCurrentUser
          label: $response.body#/email
  - target: $.paths['/user'].get
    update:
      security:
        - serviceApiKey: []
```

An overlay author MUST check `helpUrl` against the provider's current
documentation or UI, and the check operation's status codes and label field
against the provider's API documentation; neither may be inferred from a
URL pattern or a field name. The same holds for `basicCredentials`: which
half the token is, and the fixed other half, come from the provider's
documentation of its API tokens, never from a client library or another
provider.

## 6. Examples

### 6.1 Clockify

Clockify's personal API keys are sent as `X-Api-Key`. Its `GET /v1/user`
returns the key's user, including `email`; on 2026-10-01 an invalid key got
`401` with `{"message":"Api key does not exist","code":4003}`. The overlay in
this repository is
[`overlays/APIs/clockify.me/1.0.0-readonly/auth-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml`](../../../overlays/APIs/clockify.me/1.0.0-readonly/auth-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml);
its `helpUrl` is Clockify's help article on where API keys are generated.

### 6.2 HTTP tokens

No overlay in this repository declares `x-api-key-details` on an `http`
scheme yet. Before writing one, an overlay author MUST check the provider's
current documentation for which layout it uses (§5), rather than infer it
from a client library or from another provider.

## 7. Validation

A conforming declaration MUST satisfy all of the following:

1. `x-api-key-details` is an object on a Security Scheme Object of
   `type: apiKey`, or of `type: http` with `scheme` `bearer` or `basic`
   (case-insensitive), with no members other than `helpUrl`, `keyCheck` and,
   on a `basic` scheme only, `basicCredentials`.
2. `helpUrl`, when present, is an absolute `https` URI without userinfo.
3. `keyCheck`, when present, is an object with a string `operationId` and
   optionally a string `label`, and no other members.
4. `operationId` resolves to exactly one operation, which satisfies the five
   rules of §4.2.
5. `label`, when present, is a Runtime Expression starting with
   `$response.body#`, followed by an empty or `/`-prefixed JSON Pointer.
6. `basicCredentials`, when present, is one of the three combinations of
   §4.3, with string values that satisfy its constraints.

## Security Considerations

The key check sends a secret to the provider before the consumer has
decided to keep it, so rule 4 of §4.2 (the document's own `https` server)
and the no-redirect rule of §4.4 keep the key from going anywhere the
provider's ordinary requests would not. A consumer that composes documents
from overlays trusts those overlays exactly as much as it already trusts
them to name the API's server.

`label` comes from the provider and may be personal data (an email address).
Consumers SHOULD store it as carefully as the key's other metadata, and show
it only to the person the credential belongs to.

`helpUrl` comes from the same document. Because consumers only render it as
a link the person chooses, a wrong URL misdirects the person but cannot
receive the key.

HTTP Basic is also how many providers accept a person's account password. A
stored account password can usually do more than any API token (sign in,
change the password, get past a second factor), and it is sent on every
request. `basicCredentials` exists so that a consumer never has to ask for
one: in every valid combination the pasted token is the only secret the
person enters. It is a declaration by the document's author, which a
consumer cannot verify; an author who declared an account password as
`token` would make a consumer ask for it under the name of a token. Authors
SHOULD prefer a `bearer` scheme where the provider offers one.

Personal access tokens are often account-wide: unlike OAuth scopes, nothing
in the document limits what a token can do. A consumer SHOULD send a token
only to the operations it needs, and SHOULD NOT present a token as narrower
than the provider documents it to be.

## Reference Implementation

`integration-proxy/` in [ontola/atomic-plugins](https://github.com/ontola/atomic-plugins)
reads these fields on its consent page (`src/providers.rs`, `src/connect.rs`):
it renders `helpUrl` as a link next to the key field, and calls `keyCheck`
before sealing a pasted key, with a 10-second timeout and redirects disabled.
It supports header- and query-located API keys; a cookie-located key with a
`keyCheck` is refused as undetermined. It truncates a label to 200
characters and keeps it, encrypted, with the connection. Its unreleased
version also supports `http` `bearer` and `basic` schemes (0.2.0-draft), and
does not offer a `basic` scheme without `basicCredentials`.

## Changes

- 0.2.0-draft: `x-api-key-details` may appear on `http` `bearer` and
  `basic` schemes; new `basicCredentials` (§4.3); the key check of an `http`
  scheme is sent the scheme's `Authorization` header (§4.4).
- 0.1.0-draft: help link and key check for `apiKey` schemes.
