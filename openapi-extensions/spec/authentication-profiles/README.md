# OpenAPI Authentication Profiles Extension

**Spec version:** 0.1.0-draft

---

## 1. Introduction

Many OpenAPI documents declare more than one kind of credential. Discord's,
for example, declares a bot token (`type: apiKey`) and OAuth 2.0
(`type: oauth2`); most of its operations accept only the bot token, a few
accept either, and a few accept only an OAuth user token. A consumer that
holds one credential cannot use it for the whole document, and a consumer
that guesses which credential to send for which operation may send a user's
OAuth token to an operation that does not accept it, or a bot token where a
user's consent was expected.

This proposal adds `x-authentication-profiles` to the Components Object. A
**profile** names one security scheme of the document. It authenticates
exactly the operations whose security requirements accept that scheme on its
own, and nothing else. A consumer that connects with a profile's credential
uses it for those operations only, derives OAuth scopes from those operations
only, and refuses every other operation.

The document declares which profiles make sense; it does not choose one.
Which profile a consumer uses is the consumer's own trusted configuration
(§4.3): declaring a profile enables nothing by itself.

## 2. Overview

```yaml
components:
  securitySchemes:
    botToken:
      type: apiKey
      in: header
      name: Authorization
    userOAuth:
      type: oauth2
      flows:
        authorizationCode:
          authorizationUrl: https://service.example/oauth2/authorize
          tokenUrl: https://service.example/oauth2/token
          scopes:
            identify: Read the user's profile.
  x-authentication-profiles:
    user:
      securityScheme: userOAuth
      description: Act as the person who connects, with their OAuth consent.
    bot:
      securityScheme: botToken
      description: Act as the application's bot, with a pasted bot token.
paths:
  /users/@me:
    get:
      security:
        - botToken: []
        - userOAuth: [identify]   # in both profiles
  /channels/{id}/messages:
    get:
      security:
        - botToken: []            # in the bot profile only
```

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "SHOULD NOT" and
"MAY" in this document are to be interpreted as described in
[BCP 14](https://www.rfc-editor.org/info/bcp14) when, and only when, they
appear in all capitals.

An operation's **effective security** is its own `security` field if it has
one, and otherwise the document's top-level `security` field.

## 4. Object Definitions

### 4.1 Authentication Profiles

`x-authentication-profiles` MAY appear on the Components Object. Its value is
a map from a profile name to an Authentication Profile Object. Profile names
match `^[A-Za-z0-9._-]+$`, like other component names.

### 4.2 Authentication Profile Object

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `securityScheme` | string | yes | The name of a Security Scheme Object in `components.securitySchemes`. |
| `description` | string | no | Plain text describing whose authority the profile acts with. |

Unknown fields are invalid in this version.

A profile **covers** an operation when the operation's effective security
contains a Security Requirement Object whose only member is the profile's
`securityScheme`. It covers no other operation. In particular, it does not
cover:

- an operation without any effective security;
- an operation whose only accepted requirements are empty (`{}`, anonymous
  access) or name other schemes;
- an operation that accepts the scheme only together with another scheme in
  one requirement (`{a: [], b: []}`); this version does not describe
  combined credentials.

An operation that accepts both anonymous access and the profile's scheme
(`[{}, {scheme: []}]`) is covered: a consumer with the profile's credential
sends it.

The **scopes** of a profile whose scheme is `type: oauth2` are the union of
the scope lists in the covering requirement of every covered operation. Each
of them MUST be declared in the scheme's flow.

A profile MUST cover at least one operation.

### 4.3 Selecting a profile

A consumer selects at most one profile per document, by name, from its own
trusted configuration (for example, a catalog entry its operator controls).
A request, a person using the consumer, or the document itself MUST NOT
select or change it. When a consumer has selected a profile, it:

1. uses only the selected profile's security scheme, and holds a credential
   for that scheme only;
2. asks for exactly the profile's scopes when that scheme is OAuth 2.0;
3. sends the credential only on covered operations, and refuses every other
   operation of the document instead of sending it with another credential,
   with no credential, or with this one;
4. treats a selection that does not resolve (an unknown profile name, a
   scheme that does not exist, a scheme kind it does not support, or a
   profile that covers no operation) as an error, never as a fallback to
   another profile or scheme.

A consumer that does not support this extension ignores it. A consumer that
supports it but has selected no profile behaves as if the extension were
absent; in particular, it SHOULD keep refusing documents whose security it
cannot resolve unambiguously, rather than picking a profile itself.

## 5. Applying via OpenAPI Overlays

An overlay can declare profiles for an existing document:

```yaml
overlay: 1.0.0
info:
  title: Authentication profiles for Service
  version: 1.0.0
actions:
  - target: $.components
    update:
      x-authentication-profiles:
        user:
          securityScheme: userOAuth
          description: Act as the person who connects.
```

An overlay that also changes operations' `security` (to add an
authorization-code scheme the source document lacks, say) changes which
operations a profile covers. Its author MUST check the resulting coverage
against the provider's documentation, not infer it from paths or names.

## 6. Examples

### 6.1 Discord

The pinned full Discord OAD
(`APIs/discord.com/10/openapi.yaml` at `ontola/openapi-directory`
`9d0d73c6b23cb07ca2d225fb8b3848fede322b21`) declares `BotToken` (`apiKey`
in the `Authorization` header) and `OAuth2` (an implicit flow only). This
repository's auth overlay adds `discordOAuth`, an authorization-code scheme,
to `GET /users/@me` and `GET /users/@me/guilds`. Its v2 revision,
[`overlays/APIs/discord.com/10/auth-v2-9d0d73c6b23cb07ca2d225fb8b3848fede322b21-overlay.yaml`](../../../overlays/APIs/discord.com/10/auth-v2-9d0d73c6b23cb07ca2d225fb8b3848fede322b21-overlay.yaml),
declares two profiles:

- `discordUser` (`discordOAuth`): covers those two reads, with scopes
  `identify` and `guilds`;
- `discordBot` (`BotToken`): covers every operation that accepts the bot
  token on its own.

These are declarations, checked by composition tests only; neither profile
has been verified against a live Discord account or bot.

## 7. Validation

A conforming declaration MUST satisfy all of the following:

1. `x-authentication-profiles` is an object on the Components Object, and
   each of its keys is a profile name matching `^[A-Za-z0-9._-]+$`.
2. Each value is an object with a string `securityScheme`, optionally a
   string `description`, and no other members.
3. `securityScheme` names a Security Scheme Object in the same document's
   `components.securitySchemes`.
4. Each profile covers at least one operation (§4.2).
5. For an `oauth2` scheme, every scope in a covering requirement is declared
   in the scheme's flow.

## Security Considerations

The point of a profile is that a credential goes only where the document
says it is accepted. Rule 3 of §4.3 is what keeps a person's OAuth token
away from bot-only operations, and a bot token away from operations that
expect a person's consent. A consumer MUST apply it per request, not only
when it builds its request list.

A profile changes nothing about trust in the document: a consumer that
composes documents from overlays trusts them to describe the API's security
exactly as much as it already trusts them to name its servers and
operations. The selection is separate (§4.3) so that adding a profile to a
document cannot by itself widen what an existing consumer sends.

If a consumer's selection changes while it holds credentials obtained under
an earlier selection, it SHOULD stop using a credential whose kind no longer
matches the selected profile's scheme, and ask for a new one.

## Reference Implementation

`integration-proxy/` in [ontola/atomic-plugins](https://github.com/ontola/atomic-plugins)
reads the extension when its catalog entry's `selection` names a profile
(`authenticationProfile`; `src/providers.rs`, `src/catalog.rs`). It supports
profiles whose scheme is `oauth2` with an authorization-code flow, or
`apiKey`, and (unreleased) `http` with `scheme: bearer` or `scheme: basic`.
Without a selection it keeps refusing documents that declare both `oauth2`
and `apiKey`, and uses an `http` scheme only in a document that declares
neither. `Catalog::allows` refuses an operation the selected profile does not
cover, and the proxy sends an OAuth token only while the platform still
resolves to an OAuth profile, and a bearer or basic token only while it
resolves to an `http` scheme of the same kind.
