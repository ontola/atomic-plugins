# OpenAPI Authenticated Principal Extension

**Spec version:** 0.1.0-draft

---

## 1. Introduction

An API often has an operation such as `GET /me` or `GET /userinfo` that returns
the principal represented by the caller's credentials. OpenAPI can already
describe that operation's request, response, and security requirements. It
does not state which response value is the principal's durable identifier, who
assigned it, or whether it can safely be correlated with a principal returned
by another API.

This proposal adds `x-authenticated-principal` to an Operation Object. It
describes the **current authenticated principal** returned by that operation;
it never describes an arbitrary resource owner or a user selected by a path or
query parameter. A normal OpenAPI Security Requirement Object continues to
describe the required scopes and credentials.

The extension is a capability declaration. It allows a consumer to discover a
candidate identity key and presentation claims. Trust policy, sign-in,
account-linking, and the choice to persist or use that key remain consumer
decisions outside this proposal.

## 2. Overview

```yaml
paths:
  /me:
    get:
      operationId: currentUser
      security:
        - bearerAuth: []
      x-authenticated-principal:
        kind: user
        namespace: https://identity.example.com
        subject: $response.body#/id
        identifier:
          scope: provider
          stable: true
          reassigned: false
        claims:
          name: $response.body#/displayName
          email: $response.body#/email
          picture: $response.body#/avatarUrl
          email_verified: $response.body#/emailVerified
```

The complete document is in [examples/generic.yaml](examples/generic.yaml).
The extension's JSON Schema is [schema.json](schema.json).

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", and "MAY" in this
document are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/info/bcp14)
when, and only when, they appear in all capitals.

`$response.body#...` is an OpenAPI Runtime Expression. The suffix is evaluated
as a JSON Pointer against the successful operation response. The pointer MAY
be empty when the response body itself is the principal identifier.

## 4. Object Definitions

### 4.1 Authenticated Principal Object

`x-authenticated-principal` MAY appear only on an Operation Object. It is
valid only for an operation that returns the caller's currently authenticated
principal after applying its ordinary OpenAPI security requirements.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | string | yes | `user`, `organization`, `serviceAccount`, or `bot`. |
| `namespace` | absolute HTTPS URI | yes | Identity authority that assigned `subject`. |
| `subject` | response-body Runtime Expression | yes | Identifier of the returned authenticated principal. |
| `identifier` | Identifier Object | yes | Scope and lifecycle guarantees of `subject`. |
| `claims` | Claims Object | no | Optional presentation values from the same response. |

Unknown fields are invalid in this version. An operation MUST NOT declare this
extension merely because its response contains a `user`, `owner`, `author`, or
similar object. The subject expression MUST resolve from the operation's
response body, rather than request data, a token, or an unrelated principal.

`namespace` identifies an authority, not an API hostname by convention. It
MUST be an absolute `https` URI without userinfo, query, or fragment. The
same namespace in two descriptions asserts that the authority assigns exactly
the same subject identifiers in both. An API publisher MUST use different
namespaces when that assertion is untrue, including where isolated
organizations or workspaces can issue overlapping identifiers. A consumer
MUST NOT treat equal-looking local IDs from different namespaces as equal.

The value selected by `subject` MUST be either a nonempty JSON string or a JSON
integer. A consumer MUST preserve its JSON type when using it as an identity
key: string `"7"` and integer `7` are different identifiers. Missing, null,
boolean, array, and object subjects are invalid for this version.

### 4.2 Identifier Object

| Field | Type | Required | Description |
| --- | --- | --- |
| `scope` | `provider` or `client` | yes | Whether the identifier is provider-wide or pairwise for an OAuth/OpenID client. |
| `stable` | boolean | no | Whether the authority promises that the subject remains assigned to the same principal. Omission means unknown. |
| `reassigned` | boolean | no | Whether the authority can later assign the subject to a different principal. Omission means unknown. |

`scope: provider` means the authority uses the same subject for a principal
across its clients. `scope: client` means the identifier can be pairwise: it
is scoped to the client through which the principal authenticated. A client-
scoped subject MUST NOT be correlated across clients merely because the
namespace and string match.

`stable: true` and `reassigned: false` are explicit authority guarantees.
Omission means the corresponding lifecycle property is unknown. A subject is
not automatically eligible for durable or cross-operation matching unless both
values are explicitly declared. A consumer still decides whether those
guarantees are sufficient for its use case.

### 4.3 Claims Object

Each Claims Object member is a response-body Runtime Expression. All members
are optional; omission means the operation does not declare that presentation
claim.

| Field | Expected selected JSON value | Meaning |
| --- | --- | --- |
| `name` | string | Display name. |
| `email` | string | Email address. |
| `picture` | string | Profile-picture URI or provider-defined reference. |
| `email_verified` | boolean | Whether the returned email is verified. |

Claims are display or contact metadata, not identity assertions. In particular,
consumers MUST NOT use `email`, whether verified or not, as an equality key for
the principal. A claim may be absent in a particular response even when it is
declared, for example because the operation's normal scopes do not grant it.

## 5. Applying via OpenAPI Overlays

An OpenAPI Overlay can annotate an existing current-principal operation without
changing the source document. This overlay targets `GET /me`:

```yaml
overlay: 1.0.0
info:
  title: Add current-user identity metadata
  version: 1.0.0
actions:
  - target: $.paths['/me'].get
    update:
      x-authenticated-principal:
        kind: user
        namespace: https://identity.example.com
        subject: $response.body#/id
        identifier:
          scope: provider
          stable: true
          reassigned: false
```

The full overlay is in [examples/generic-overlay.yaml](examples/generic-overlay.yaml).
An overlay author MUST verify the provider's lifecycle and namespace
documentation; it MUST NOT infer those fields from an `id` field name or a
response shape.

## 6. Examples

### 6.1 Generic authenticated user

[examples/generic.yaml](examples/generic.yaml) is an authenticated fixed
`HTTPS GET /me` operation. Its bearer security scheme illustrates that this
declaration is independent of the protocol used to obtain credentials. The
reference proxy currently obtains credentials through OAuth authorization
code flows; it does not provide a standalone bearer-token login form.

### 6.2 Google OpenID Connect UserInfo

[examples/google-userinfo.yaml](examples/google-userinfo.yaml) models Google's
`GET https://openidconnect.googleapis.com/v1/userinfo`. Google's official
[OpenID Connect API reference](https://developers.google.com/identity/openid-connect/reference)
documents the `sub`, `name`, `email`, `picture`, and `email_verified` response
fields and says that `sub` is unique and never reused. The example uses the
documented Google issuer, `https://accounts.google.com`, as the namespace.

This is ordinary OpenID Connect: the security scheme uses OpenAPI's
`openIdConnect` type and its discovery URL. OIDC users should reuse issuer and
subject semantics from OpenID Connect and discovery metadata, rather than
inventing another authentication protocol or token-validation scheme through
this extension.

## 7. Validation

A conforming declaration MUST enforce all of the following:

1. `x-authenticated-principal` is on an Operation Object that returns the
   current authenticated principal.
2. `kind` is one of the four defined values.
3. `namespace` is an absolute `https` URI without userinfo, query, or fragment.
4. `subject` and each declared claim are response-body Runtime Expressions.
5. `identifier` contains `scope`, which is `provider` or `client`; when
   present, `stable` and `reassigned` are booleans.
6. `claims`, when present, contains only the four defined claim names.
7. No undeclared members appear in the Authenticated Principal, Identifier, or
   Claims Objects.

The [JSON Schema](schema.json) captures this structural subset. Run
`python3 test_schema.py` from this directory for checks of the proposal's
vocabulary and representative valid/invalid declarations. Ordinary OpenAPI and
Overlay validation remains separate.

## Security Considerations

The extension does not authenticate a caller. Consumers MUST rely on the
operation's normal security requirements and only trust a namespace when they
trust the API response and the binding of that response to the caller's token.
A reverse proxy, token exchange, or confused-deputy flow can make a response
describe a principal other than the one a consumer expects; this declaration
does not repair that binding.

An identity key is the tuple of `namespace`, JSON type of `subject`, and
`subject` value. It is automatically matchable only when `stable: true` and
`reassigned: false`, and remains subject to the Identifier Object's scope.
Consumers must retain the namespace and must not flatten
organization/workspace-local identifiers into a presumed global namespace.
For client-pairwise identifiers, the client context is also essential.

Email addresses, names, and profile images can change, be shared, or be
attacker-controlled. They are not substitutes for the subject. Consumers
should minimize storage and disclosure of these optional claims.

## Reference Implementation

The initial reference implementation supports a selected authenticated,
fixed-HTTPS `GET` operation without request parameters, using the catalog's
selected OAuth authorization-code security scheme. Its separate identity
selection is `{operationId, namespace}` and it evaluates the declared response
expressions. Direct OpenID Connect discovery, other credential acquisition
methods, and organization or service-account login are outside this initial
runtime subset; their descriptions remain valid under this extension.
It requires explicit `stable: true` and `reassigned: false`, and a nonempty
string or integer result for `subject`. It is intentionally narrower than the
extension, so providers can describe the same contract before every operation
shape is implemented.
