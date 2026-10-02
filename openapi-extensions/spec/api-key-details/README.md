# OpenAPI API Key Details Extension

**Spec version:** 0.1.0-draft

---

## 1. Introduction

OpenAPI describes a static API key with an `apiKey` Security Scheme Object:
the parameter's `name`, whether it goes `in` a header, query parameter or
cookie, and a free-text `description`. A client that asks a person to paste
such a key still has to know two things the scheme does not say:

- where the person creates or finds the key, as a link it can show next to
  the key field; and
- how to tell, before storing the key, whether the provider accepts it.

This proposal adds `x-api-key-details` to a Security Scheme Object of
`type: apiKey`. It holds an optional help link and an optional **key check**:
one operation of the same document that a consumer calls once with the
pasted key, before it stores the key, to learn whether the provider accepts
it and, optionally, a label to show for the stored credential.

The extension describes the provider. It does not prescribe how a consumer
stores keys, how often it re-checks them, or what it shows to the person
beyond the two fields below.

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
is `apiKey`.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `helpUrl` | absolute `https` URI | no | A page where the person creates or finds this kind of key. |
| `keyCheck` | Key Check Object | no | The operation that tells whether a key is accepted. |

Unknown fields are invalid in this version.

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

### 4.3 Calling the key check

A consumer that declares support for `keyCheck` calls the operation **once,
before it stores a newly entered key**, sending that key exactly as the
security scheme says (`name` and `in`), and no other credential. It then
reads the response status:

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
URL pattern or a field name.

## 6. Examples

### 6.1 Clockify

Clockify's personal API keys are sent as `X-Api-Key`. Its `GET /v1/user`
returns the key's user, including `email`; on 2026-10-01 an invalid key got
`401` with `{"message":"Api key does not exist","code":4003}`. The overlay in
this repository is
[`overlays/APIs/clockify.me/1.0.0-readonly/auth-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml`](../../../overlays/APIs/clockify.me/1.0.0-readonly/auth-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml);
its `helpUrl` is Clockify's help article on where API keys are generated.

## 7. Validation

A conforming declaration MUST satisfy all of the following:

1. `x-api-key-details` is an object on a Security Scheme Object of
   `type: apiKey`, with no members other than `helpUrl` and `keyCheck`.
2. `helpUrl`, when present, is an absolute `https` URI without userinfo.
3. `keyCheck`, when present, is an object with a string `operationId` and
   optionally a string `label`, and no other members.
4. `operationId` resolves to exactly one operation, which satisfies the five
   rules of §4.2.
5. `label`, when present, is a Runtime Expression starting with
   `$response.body#`, followed by an empty or `/`-prefixed JSON Pointer.

## Security Considerations

The key check sends a secret to the provider before the consumer has
decided to keep it, so rule 4 of §4.2 (the document's own `https` server)
and the no-redirect rule of §4.3 keep the key from going anywhere the
provider's ordinary requests would not. A consumer that composes documents
from overlays trusts those overlays exactly as much as it already trusts
them to name the API's server.

`label` comes from the provider and may be personal data (an email address).
Consumers SHOULD store it as carefully as the key's other metadata, and show
it only to the person the credential belongs to.

`helpUrl` comes from the same document. Because consumers only render it as
a link the person chooses, a wrong URL misdirects the person but cannot
receive the key.

## Reference Implementation

`integration-proxy/` in [ontola/atomic-plugins](https://github.com/ontola/atomic-plugins)
reads both fields on its consent page (`src/providers.rs`, `src/connect.rs`):
it renders `helpUrl` as a link next to the key field, and calls `keyCheck`
before sealing a pasted key, with a 10-second timeout and redirects disabled.
It supports header- and query-located keys; a cookie-located key with a
`keyCheck` is refused as undetermined. It truncates a label to 200
characters and keeps it, encrypted, with the connection.
