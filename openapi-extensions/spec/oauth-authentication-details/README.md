# OpenAPI OAuth Authentication Scheme Details Extension

**Spec version:** 0.1.0

---

## 1. Introduction

OpenAPI describes OAuth URLs and scopes, and OpenAPI 3.2 can link RFC 8414
authorization-server metadata with **oauth2MetadataUrl**. Generic tooling still
needs a standards-aligned fallback for older or incomplete descriptions, plus
server requirements that discovery describes only as capabilities. These
include token-endpoint client authentication, PKCE requirements, fixed
authorization parameters, and conditional refresh-token issuance.

This proposal adds **x-oauth-authentication-details** to an OAuth Security
Scheme Object. It reuses RFC 8414 field names and registered values for inline
capability metadata, and adds only requirement and authorization-profile
semantics that those fields do not provide. Separate Security Scheme Objects
can expose separate authorization profiles, so an operation can select or
offer them using the standard Security Requirement Object.

The extension describes authorization-server behavior. Supported
token-endpoint methods are not the method selected for a registered client.
The extension does not prescribe which profile a client selects, how a client
stores credentials or tokens, or when a client refreshes them.

## 2. Overview

~~~yaml
components:
  securitySchemes:
    serviceOnline:
      type: oauth2
      x-oauth-authentication-details:
        authorizationServerMetadata:
          token_endpoint_auth_methods_supported:
            - client_secret_basic
            - client_secret_post
          code_challenge_methods_supported: [S256]
        authorizationCode:
          pkce:
            requirement: optional
          profile:
            parameters:
              - parameter:
                  name: access_type
                  in: query
                  schema:
                    type: string
                    enum: [online, offline]
                value: online
            tokenIssuance:
              refreshToken:
                presence: never
      flows:
        authorizationCode:
          authorizationUrl: https://authorization.example/authorize
          tokenUrl: https://authorization.example/token
          scopes:
            records.read: Read records

    serviceOffline:
      type: oauth2
      x-oauth-authentication-details:
        authorizationServerMetadata:
          token_endpoint_auth_methods_supported:
            - client_secret_basic
            - client_secret_post
          code_challenge_methods_supported: [S256]
        authorizationCode:
          pkce:
            requirement: optional
          profile:
            parameters:
              - parameter:
                  name: access_type
                  in: query
                  schema:
                    type: string
                    enum: [online, offline]
                value: offline
            capabilities: [offlineAccess]
            tokenIssuance:
              refreshToken:
                presence: conditional
                conditions: [firstAuthorization]
                description: >-
                  The authorization server can omit the refresh token when it
                  has previously issued one for this authorization.
      flows:
        authorizationCode:
          authorizationUrl: https://authorization.example/authorize
          tokenUrl: https://authorization.example/token
          scopes:
            records.read: Read records
~~~

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", and "MAY" are to be
interpreted as described in
[BCP 14](https://www.rfc-editor.org/info/bcp14) when, and only when, they appear
in all capitals.

This extension uses the OAuth terminology defined by
[RFC 6749](https://www.rfc-editor.org/rfc/rfc6749), and the OpenAPI Object and
Reference Object rules from the
[OpenAPI Specification](https://spec.openapis.org/oas/latest.html).

## 4. Object Definitions

### 4.1 OAuth Authentication Details Object

**x-oauth-authentication-details** MAY appear on a Security Scheme Object whose
**type** is **oauth2**.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| **authorizationServerMetadata** | Authorization Server Metadata Object | no | Inline fallback for selected RFC 8414 metadata fields. |
| **tokenEndpointOperation** | URI reference | no | Reference to an OpenAPI Operation Object that describes authorization-code token requests. |
| **refreshEndpointOperation** | URI reference | no | Reference to an OpenAPI Operation Object that describes refresh-token requests when they use a distinct operation. |
| **authorizationCode** | Authorization Code Details Object | no | Requirements and profile semantics for the authorization-code flow. |

At least one field MUST be present.

Endpoint-operation references use the same URI-reference and resolution rules
as an OpenAPI Link Object's **operationRef**. The referenced operations can use
ordinary request-body schemas and Security Requirement Objects to describe
their complete wire format. If a flow has **refreshUrl** and refresh requests
use different client authentication behavior, **refreshEndpointOperation**
SHOULD identify that operation instead of overloading token-endpoint metadata.

### 4.2 Authorization Server Metadata Object

This object is a deliberately small inline fallback using the exact field names
and values registered by RFC 8414 and RFC 7636:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| **token_endpoint_auth_methods_supported** | [string] | no | Client authentication methods accepted by the token endpoint, such as **client_secret_basic**, **client_secret_post**, or **none**. |
| **code_challenge_methods_supported** | [string] | no | PKCE code challenge methods accepted by the authorization endpoint, such as **S256**. |

These arrays describe server support. They MUST NOT be interpreted as the
method assigned to or selected for a registered client. Registered values keep
their definitions from the relevant IANA registries.

When **oauth2MetadataUrl** is present, tooling SHOULD retrieve that metadata.
Inline values fill fields that are absent from retrieved metadata. If an inline
field conflicts with a retrieved field, the description is inconsistent;
tooling MUST report the conflict and MUST NOT silently combine values or
downgrade security behavior.

If neither retrieved nor inline metadata supplies a field, its value is
unknown. When a retrieved RFC 8414 metadata document omits a field for which
RFC 8414 defines a default, that RFC default still applies before comparison
with inline metadata. For example, omitted
**token_endpoint_auth_methods_supported** means **client_secret_basic**; an
inline list containing only **client_secret_post** conflicts with it.

### 4.3 Authorization Code Details Object

This object is valid only when the Security Scheme contains an
**authorizationCode** flow.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| **pkce** | PKCE Requirements Object | no | Server acceptance and rejection rules for PKCE. |
| **profile** | OAuth Authorization Profile Object | no | Fixed authorization parameters, capabilities, and token issuance. |

At least one field MUST be present.

### 4.4 PKCE Requirements Object

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| **requirement** | string | yes | One of **required**, **optional**, **conditional**, or **unsupported**. |
| **requiredFor** | [string] | conditionally | Server-side conditions that require PKCE. REQUIRED for **conditional**. |
| **description** | string | conditionally | Human-readable server rule. REQUIRED for **conditional**. |

**required** means authorization requests without a valid PKCE challenge are
rejected. **optional** means both PKCE and non-PKCE requests can be accepted.
**conditional** means the server requires PKCE when a listed condition holds.
**unsupported** means the server does not implement or validate PKCE. It does
not assert that the server rejects otherwise unknown authorization parameters;
OAuth authorization endpoints can ignore unrecognized parameters.

This specification defines **publicClients** as a **requiredFor** value: PKCE is
required when the authorization server classifies the registered client as a
public client. Other condition values MUST be absolute URIs. This is a server
acceptance rule; it does not classify a client or choose policy for one.

PKCE **required**, **optional**, or **conditional** MUST be accompanied by a
non-empty **code_challenge_methods_supported** metadata value. A conforming
description MUST include **S256** unless the authorization server truly cannot
accept it. Absence of **pkce** means unknown behavior, not unsupported behavior.

### 4.5 OAuth Authorization Profile Object

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| **parameters** | [Authorization Parameter Value Object] | no | Fixed parameters that the client adds to the authorization request. |
| **capabilities** | [string] | no | Authorization capabilities requested by this profile. Values defined here are listed below. Other values MUST be absolute URIs. |
| **tokenIssuance** | Token Issuance Object | no | Token-response issuance semantics associated with this profile. |

At least one field MUST be present. Array entries MUST be unique by parameter
name or capability value, as applicable.

The following capability is defined by this specification:

| Value | Meaning |
| --- | --- |
| **offlineAccess** | The profile requests authorization that can be used while the resource owner is absent by means of a refresh token. |

The capability describes what the authorization request asks the authorization
server to grant. It does not state that the request will be approved.

### 4.6 Authorization Parameter Value Object

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| **parameter** | Parameter Object or Reference Object | yes | The authorization endpoint query parameter. |
| **value** | any | yes | The fixed value for this profile. |
| **description** | string | no | Additional profile-specific semantics of this value. |

**parameter** MUST be, or resolve to, an OpenAPI Parameter Object with
**in: query**. If the authorization endpoint is described by an OpenAPI
operation, this field SHOULD reference the same Parameter Object.

The value MUST conform to the parameter schema and MUST be serialized according
to the Parameter Object. A parameter name MUST NOT be **client_id**,
**client_secret**, **redirect_uri**, **response_type**, **scope**, **state**,
**code**, **code_challenge**, **code_challenge_method**, or **code_verifier**.
Those parameters have protocol-defined construction rules, carry credentials
or grants, or are generated per authorization attempt; they are not fixed
profile metadata.

### 4.7 Token Issuance Object

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| **refreshToken** | Refresh Token Issuance Object | no | Whether a successful authorization-code exchange includes a refresh token. |

### 4.8 Refresh Token Issuance Object

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| **presence** | string | yes | One of **always**, **conditional**, or **never**. |
| **conditions** | [string] | conditionally | Conditions under which the token is issued. REQUIRED when **presence** is **conditional**. Values defined here are listed below; other values MUST be absolute URIs. |
| **description** | string | conditionally | Human-readable issuance conditions. REQUIRED when **presence** is **conditional**. |

**always** means every successful token response for this profile contains a
refresh token. **conditional** means a successful response can omit it; clients
MUST tolerate its absence. **never** means a successful response does not
contain one.

These values describe issuance, not the outcome of authorization. In
particular, **conditional** MUST be used when prior consent, a previously issued
token, server policy, or another condition can cause omission. A profile MUST
NOT use **always** merely because it requests **offlineAccess**.

The following condition is defined by this specification:

| Value | Meaning |
| --- | --- |
| **firstAuthorization** | The authorization server issues the token only when it recognizes the exchange as the first authorization for the client and resource owner. |

Conditions explain when issuance occurs; they do not turn **conditional** into
a guarantee because authorization-server state and policy determine whether a
condition holds.

## 5. Applying via OpenAPI Overlays

An Overlay can add details without changing the source description. This
example supplies metadata and requires PKCE for public clients:

~~~yaml
overlay: 1.0.0
info:
  title: Online authorization profile
  version: 1.0.0
actions:
  - target: >-
      $.components.securitySchemes.serviceOnline
    update:
      x-oauth-authentication-details:
        authorizationServerMetadata:
          token_endpoint_auth_methods_supported:
            - client_secret_basic
            - client_secret_post
            - none
          code_challenge_methods_supported: [S256]
        authorizationCode:
          pkce:
            requirement: conditional
            requiredFor: [publicClients]
            description: Public clients must use PKCE.
~~~

## 6. Example: Google Online and Offline Access

The two schemes below let an API operation offer online and offline
authorization independently. Google's **access_type=offline** requests offline
access, but a refresh token is generally returned only on the first
authorization. The offline profile therefore declares conditional issuance.

~~~yaml
components:
  parameters:
    googleAccessType:
      name: access_type
      in: query
      required: false
      schema:
        type: string
        enum: [online, offline]

  securitySchemes:
    googleOnline:
      type: oauth2
      x-oauth-authentication-details:
        authorizationCode:
          profile:
            parameters:
              - parameter:
                  $ref: '#/components/parameters/googleAccessType'
                value: online
            tokenIssuance:
              refreshToken:
                presence: never
      flows:
        authorizationCode:
          authorizationUrl: https://accounts.google.com/o/oauth2/v2/auth
          tokenUrl: https://oauth2.googleapis.com/token
          scopes:
            https://www.googleapis.com/auth/drive.metadata.readonly: >-
              View metadata for files in Google Drive

    googleOffline:
      type: oauth2
      x-oauth-authentication-details:
        authorizationCode:
          profile:
            parameters:
              - parameter:
                  $ref: '#/components/parameters/googleAccessType'
                value: offline
            capabilities: [offlineAccess]
            tokenIssuance:
              refreshToken:
                presence: conditional
                conditions: [firstAuthorization]
                description: >-
                  Google returns a refresh token on the first authorization;
                  later authorization-code exchanges can omit it.
      flows:
        authorizationCode:
          authorizationUrl: https://accounts.google.com/o/oauth2/v2/auth
          tokenUrl: https://oauth2.googleapis.com/token
          scopes:
            https://www.googleapis.com/auth/drive.metadata.readonly: >-
              View metadata for files in Google Drive

paths:
  /drive-files:
    get:
      security:
        - googleOnline:
            - https://www.googleapis.com/auth/drive.metadata.readonly
        - googleOffline:
            - https://www.googleapis.com/auth/drive.metadata.readonly
      responses:
        '200':
          description: File metadata
~~~

The Security Requirement Object above makes the profiles alternatives. A
client chooses between them based on its own requirements; that choice is
outside this extension.

## 7. Example: Token Authentication and PKCE

This scheme describes a server that accepts HTTP Basic and form-body client
secrets, plus public clients using **none**. It requires S256 PKCE for public
clients. The supported-method array does not select a method for any particular
registration.

~~~yaml
components:
  securitySchemes:
    exampleOAuth:
      type: oauth2
      oauth2MetadataUrl: https://authorization.example/.well-known/oauth-authorization-server
      x-oauth-authentication-details:
        authorizationServerMetadata:
          token_endpoint_auth_methods_supported:
            - client_secret_basic
            - client_secret_post
            - none
          code_challenge_methods_supported: [S256]
        authorizationCode:
          pkce:
            requirement: conditional
            requiredFor: [publicClients]
            description: Public clients must use S256 PKCE.
      flows:
        authorizationCode:
          authorizationUrl: https://authorization.example/authorize
          tokenUrl: https://authorization.example/token
          scopes:
            records.read: Read records
~~~

Spotify's documented Authorization Code with PKCE flow requires **S256** and
exchanges the code without a client secret. A description of that public-client
server profile can use **none** without implying that PKCE itself determines
the token-endpoint authentication method:

~~~yaml
components:
  securitySchemes:
    spotifyPublicClient:
      type: oauth2
      x-oauth-authentication-details:
        authorizationServerMetadata:
          token_endpoint_auth_methods_supported: [none]
          code_challenge_methods_supported: [S256]
        authorizationCode:
          pkce:
            requirement: required
      flows:
        authorizationCode:
          authorizationUrl: https://accounts.spotify.com/authorize
          tokenUrl: https://accounts.spotify.com/api/token
          scopes:
            user-read-private: Read subscription details
~~~

## 8. Validation

A conforming validator MUST enforce these rules:

1. The extension appears only on an OAuth Security Scheme Object.
2. **authorizationCode** details appear only when the scheme defines that flow.
3. Endpoint-operation references resolve to Operation Objects. Their effective
   request URLs agree with the flow's **tokenUrl** or **refreshUrl**, as
   applicable.
4. Inline metadata arrays are non-empty, contain unique registered values, and
   agree with metadata retrieved through **oauth2MetadataUrl** when both supply
   the same field. RFC 8414 defaults are applied to omitted retrieved fields
   before this comparison.
5. PKCE **requirement** is **required**, **optional**, **conditional**, or
   **unsupported**. Conditional requirements have non-empty **requiredFor** and
   **description** values. Other requirement values omit **requiredFor**.
6. Required-condition values are unique. Unknown values are absolute URIs.
7. A supported PKCE requirement has non-empty challenge methods;
   **unsupported** omits **code_challenge_methods_supported**. Supported methods include **S256** whenever the
   server accepts it; tooling MUST NOT infer **plain** from an absent value.
8. Every authorization-profile parameter is an inline Parameter Object or a Reference Object that
   resolves to one, and its **in** value is **query**.
9. Parameter names are unique within a profile and do not use the reserved
   OAuth names listed in section 4.6.
10. Each fixed value validates against its parameter schema.
11. Capability values are unique and non-empty. An unrecognized capability is
   an absolute URI, preventing collisions with future values defined here.
12. Refresh-token **presence** is **always**, **conditional**, or **never**.
   **conditions** is non-empty and **description** is present and non-empty for
   conditional issuance. Conditions are unique; an unrecognized condition is
   an absolute URI.
13. A profile containing **offlineAccess** declares refresh-token issuance as
   **always** or **conditional**.
14. If the token endpoint response is described in the same OpenAPI document,
   its schema does not contradict the declared presence: **always** requires
   the refresh-token property, **conditional** permits it but does not require
   it, and **never** does not require it.

A validator SHOULD warn when two Security Scheme Objects differ only in name
but resolve to indistinguishable authorization profiles.

## 9. Security Considerations

This extension contributes fixed values only to the authorization request. It
MUST NOT be used to carry client credentials, access tokens, refresh tokens, or
arbitrary token-endpoint URLs. Tooling MUST apply the normal OAuth protections
for redirect URI validation, state correlation, PKCE, and authorization-server
metadata.

Descriptions are explanatory and MUST NOT override the normative fields. A
client MUST treat **conditional** refresh-token issuance as absence-tolerant
even when a description lists common conditions.

## References

- [OAuth 2.0, RFC 6749](https://www.rfc-editor.org/rfc/rfc6749)
- [Proof Key for Code Exchange, RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)
- [OAuth 2.0 Authorization Server Metadata, RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)
- [OpenAPI Specification](https://spec.openapis.org/oas/latest.html)
- [OpenAPI Overlay Specification](https://spec.openapis.org/overlay/v1.0.0.html)
- [Google OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
- [Spotify Authorization Code with PKCE Flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow)
