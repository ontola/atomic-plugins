# OpenAPI Webhook Deliveries Extension

**Spec version:** 0.1.0-draft

---

## 1. Introduction

A receiver that accepts a provider's webhook deliveries on behalf of many
users has to answer, for every request it receives, before it trusts a single
byte of the payload:

- how to check that the provider sent it (the signature algorithm, which bytes
  are signed, which header carries the signature, where the secret comes from,
  and whether a timestamp limits replay);
- which delivery this is, so that a redelivery is recognised;
- which source (a repository, a project, an installation) it concerns, and
  therefore which subscriptions may see it;
- whether the receiver created the provider's hook, and may delete it, or the
  hook belongs to an application that serves many installations;
- which of the API's resources and collections it says may have changed, so
  that a consumer reads exactly those.

OpenAPI 3.1's `webhooks` field describes payloads and operations a provider
initiates. It does not answer these questions. This extension adds one root
field, `x-webhook-deliveries`, that does, so that a receiver can stay
generic: every provider-specific choice is a declaration in a document or an
[OpenAPI Overlay](https://spec.openapis.org/overlay/v1.0.0.html), not a
branch in the receiver's code.

It is the provider-side half of the contracts in
[`docs/design/proxy-webhooks-and-two-way-sync.md`](../../../docs/design/proxy-webhooks-and-two-way-sync.md)
(ontola/atomic-plugins#369). The receiver-to-consumer half (subscriptions,
leases, cursors, generations, gaps and the pilot limits) is the
[Webhook Subscriptions extension](../webhook-subscriptions/README.md).

Status: a draft. No receiver implements it yet, no published overlay declares
it, and none of the GitHub facts in §6.2 has been checked against live
deliveries; they follow GitHub's documentation as cited there.

## 2. Overview

```yaml
x-webhook-deliveries:
  verificationProfiles:
    appHook:
      algorithm: hmac-sha256
      signedContent: rawBody
      signature: { in: header, name: Example-Signature, encoding: hex }
      secret: { source: operatorConfigured }
  delivery:
    id: { in: header, name: Example-Delivery }
    redelivery: sameId
    eventType: { in: header, name: Example-Event }
  sources:
    project:
      key: $request.body#/project/id
      access:
        operation: { method: get, path: '/projects/{projectId}' }
        key: $response.body#/id
  hooks:
    sharedApplication: { verificationProfile: appHook }
  events:
    task:
      source: project
      resources:
        - resource: task
          bindings:
            projectId: $request.body#/project/id
            taskId: $request.body#/task/id
```

A receiver that understands the field:

1. reads the raw request body, within its own size cap;
2. verifies the signature over those exact bytes with the profile of the
   endpoint the request arrived at (§4.2);
3. only then parses the body and reads the delivery id, event type and
   source key from it (§4.3, §4.4);
4. routes the delivery only to subscriptions whose source binding was
   established by an access check with the subscriber's own connection
   (§4.4.1), and never because two owners use the same application;
5. hands consumers the event type and the resources and collections it
   names (§4.6), which they read through the API as usual.

## 3. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "SHOULD NOT", "MAY"
are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

- A _receiver_ is the service that accepts deliveries (the integration proxy,
  in the plan above). A _consumer_ is a client of the receiver that reads
  what it retained (the Atomic sync daemon).
- An _endpoint_ is one URL at the receiver to which a provider sends
  deliveries. Each endpoint is tied to one document, one hook (§4.5) and one
  verification profile (§4.2). An endpoint id in that URL is a routing
  identifier, not a credential: knowing it grants nothing.
- A _source_ is the provider-side scope a delivery concerns (a repository, a
  project); a _source kind_ is a name declared in `sources` (§4.4).
- A _body expression_ is an OpenAPI runtime expression of the form
  `$request.body#<JSON Pointer>` evaluated against the parsed delivery body,
  or `$response.body#<JSON Pointer>` against the parsed response of an API
  operation. JSON Pointers follow [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901).
  Only where a field says so (§4.4.2, §4.5.2), one pointer segment may be the
  single character `*`, which selects each element of an array; a literal
  `*` member name cannot be addressed there.
- A _key_ is the value a body expression selects, when it is a string or an
  integer. It is compared as text: an integer is written in decimal without
  sign or leading zeros (negative integers are not keys), and a string is
  used as is. The integer `42` and the string `"42"` are therefore the same
  key. Any other JSON type (a float, a boolean, null, an object, an array)
  or a missing value is _no key_.
- An _operation reference_ is `{ method, path }`: an HTTP method in lower
  case and a path template exactly as it appears under the document's
  `paths`.

## 4. Object Definitions

### 4.1 Webhook Deliveries Object

Placed under `x-webhook-deliveries` at the root of an OpenAPI document. Every
field listed as required MUST be present.

| Field                  | Type                                              | Required | Description                                                   |
| ---------------------- | ------------------------------------------------- | -------- | ------------------------------------------------------------- |
| `verificationProfiles` | map of name to Verification Profile Object (§4.2) | **Yes**  | Non-empty.                                                    |
| `delivery`             | Delivery Object (§4.3)                            | **Yes**  | Delivery id, redelivery behaviour, event type.                |
| `sources`              | map of source kind to Source Object (§4.4)        | **Yes**  | Non-empty.                                                    |
| `hooks`                | Hooks Object (§4.5)                               | **Yes**  | At least one of its two models.                               |
| `events`               | map of event type to Event Object (§4.6)          | **Yes**  | Non-empty. Keys are the event type values the provider sends. |
| `revocations`          | array of Revocation Object (§4.4.2)               | No       | Deliveries that narrow access.                                |
| `description`          | string                                            | No       | Evidence and remaining unknowns.                              |

Unknown fields are invalid in this version, except `x-*` extension fields on
any object.

### 4.2 Verification Profile Object

How a receiver checks that a delivery came from the provider. A profile
never contains a secret; it says where the receiver gets one.

| Field           | Type                               | Required                        | Description                                                                                                                                                                                   |
| --------------- | ---------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `algorithm`     | `hmac-sha256`                      | **Yes**                         | HMAC ([RFC 2104](https://www.rfc-editor.org/rfc/rfc2104)) with SHA-256. The only algorithm of this version.                                                                                   |
| `signedContent` | `rawBody` \| `timestampDotRawBody` | **Yes**                         | `rawBody`: the request body bytes exactly as received. `timestampDotRawBody`: the timestamp header's value as received (ASCII), the byte `.` (0x2E), then the body bytes exactly as received. |
| `signature`     | Signature Location Object          | **Yes**                         | Where the signature is and how it is written.                                                                                                                                                 |
| `timestamp`     | Timestamp Object                   | Only with `timestampDotRawBody` | A signed timestamp that bounds replay.                                                                                                                                                        |
| `secret`        | Secret Source Object               | **Yes**                         | Where the receiver gets the HMAC key.                                                                                                                                                         |
| `description`   | string                             | No                              |                                                                                                                                                                                               |

Signature Location Object:

| Field      | Type              | Required | Description                                                                                                                          |
| ---------- | ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `in`       | `header`          | **Yes**  | The only location of this version.                                                                                                   |
| `name`     | string            | **Yes**  | Header name; matched case-insensitively.                                                                                             |
| `prefix`   | string            | No       | A literal the header value starts with (`sha256=`), removed before decoding. A value that does not start with it fails verification. |
| `encoding` | `hex` \| `base64` | **Yes**  | How the 32-byte MAC is written after the prefix. `hex` accepts upper and lower case; `base64` is RFC 4648 §4 with padding.           |

Timestamp Object:

| Field              | Type           | Required | Description                                                                                                              |
| ------------------ | -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `in`               | `header`       | **Yes**  |                                                                                                                          |
| `name`             | string         | **Yes**  | Header name; matched case-insensitively.                                                                                 |
| `format`           | `unixSeconds`  | **Yes**  | Decimal seconds since 1970-01-01T00:00:00Z, digits only.                                                                 |
| `toleranceSeconds` | integer, 1–900 | **Yes**  | A delivery whose timestamp differs from the receiver's clock by more than this, in either direction, fails verification. |

A timestamp is only declared when it is signed (`timestampDotRawBody`): an
unsigned timestamp can be replaced by anyone who replays the request, so it
bounds nothing. Without a timestamp, replay of a captured delivery is bounded
only by delivery-id deduplication (§4.3) for as long as the receiver keeps
the receipt; a receiver MUST NOT treat a profile without a timestamp as
replay-proof.

Secret Source Object:

| Field      | Type                                        | Required | Description                                                                      |
| ---------- | ------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `source`   | `receiverGenerated` \| `operatorConfigured` | **Yes**  | See below.                                                                       |
| `minBytes` | integer, 32–1024                            | No       | The least secret length the receiver accepts or generates, in bytes. Default 32. |

- `receiverGenerated`: the receiver creates the secret (at least `minBytes`
  bytes from a cryptographically secure generator) when it registers a
  dedicated hook (§4.5.2), sends it to the provider in that registration,
  and stores it encrypted, bound to the hook. It is never shown to a
  consumer.
- `operatorConfigured`: the secret belongs to an application hook the
  operator set up at the provider (§4.5.1). The receiver reads it from its
  deployment configuration, never from a document, a catalog, a consumer or
  a delivery. A receiver with no secret configured for such an endpoint MUST
  refuse every delivery to it.

#### 4.2.1 Verification procedure

A receiver MUST, in this order, for a delivery to an endpoint:

1. refuse a body longer than its own cap, before reading past the cap;
2. look up the endpoint's profile and secret; refuse an unknown endpoint;
3. read the signature header; refuse a missing header, a header given more
   than once, a value without the declared prefix, or a value that does not
   decode to exactly 32 bytes;
4. for `timestampDotRawBody`, read the timestamp header with the same rules,
   refuse a value that is not digits only or is outside `toleranceSeconds`;
5. compute HMAC-SHA256 with the secret over the signed content (§4.2) and
   compare it with the decoded signature in **constant time** (a comparison
   whose duration does not depend on where the two values first differ). A
   receiver MUST NOT compare the encoded strings, and MUST NOT use an
   early-exit comparison;
6. only after the comparison succeeds, parse the body.

A receiver MUST NOT parse the body, look up a delivery id or a source, or
write any state that depends on the request's content before step 5
succeeds. A refused delivery writes nothing except bounded counters with
labels that do not include request content.

The body's media type in this version is `application/json` (UTF-8,
[RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)); the receiver parses
it with a nesting depth limit of its own choosing. A body that verifies but
does not parse, or exceeds the depth limit, is a verified but uncapturable
delivery (Webhook Subscriptions §5.3).

### 4.3 Delivery Object

| Field                     | Type                                          | Required | Description                                                                                           |
| ------------------------- | --------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `id`                      | Header Location Object (`in: header`, `name`) | **Yes**  | The header carrying the delivery id.                                                                  |
| `redelivery`              | `sameId` \| `newId` \| `unspecified`          | **Yes**  | Whether the provider's redelivery of a delivery carries the same id.                                  |
| `eventType`               | Header Location Object, or a body expression  | **Yes**  | Where the event type is. Its value is looked up in `events`.                                          |
| `action`                  | body expression                               | No       | A sub-type within an event type (`opened`, `edited`), when the provider has one.                      |
| `responseDeadlineSeconds` | positive integer                              | No       | How soon the provider expects a response before it treats the delivery as failed.                     |
| `maxPayloadBytes`         | positive integer                              | No       | The largest body the provider documents that it sends. Informational: the receiver's own cap applies. |

A delivery id is 1–255 printable ASCII characters (0x21–0x7E); a receiver
refuses a verified delivery whose id header is missing, repeated or outside
that range, and MAY record a gap for it where its source can be identified
(Webhook Subscriptions §5.3).

Deduplication: the receiver keys a receipt on the endpoint and the delivery
id, never on the delivery id alone, so that two hooks (or two providers)
cannot collide or suppress each other's deliveries. A second delivery with a
key that has an unexpired receipt is acknowledged to the provider and not
retained again. Receipts expire (Webhook Subscriptions §6); after that the
same id is seen as new, so consumers MUST be idempotent per delivery id
anyway. With `redelivery: newId` or `unspecified`, deduplication does not
catch provider redeliveries, and consumers' idempotency is the only
protection.

### 4.4 Source Object

How a verified delivery maps to a source, and how a subscriber shows it may
see that source.

| Field         | Type                           | Required | Description                                                                                                                                                        |
| ------------- | ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `key`         | body expression                | **Yes**  | Selects the source's key in a delivery of an event of this source kind. It SHOULD select an identifier that never changes and is never reused (an id, not a name). |
| `access`      | Access Check Object            | **Yes**  | How the receiver establishes that a connection may subscribe to a source of this kind.                                                                             |
| `context`     | map of name to body expression | No       | Further keys recorded from verified deliveries of this source, used only by revocations (§4.4.2).                                                                  |
| `description` | string                         | No       |                                                                                                                                                                    |

Access Check Object:

| Field       | Type                         | Required | Description                                                                            |
| ----------- | ---------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `operation` | operation reference          | **Yes**  | A `get` operation of the document. Its path parameters are supplied by the subscriber. |
| `key`       | `$response.body#` expression | **Yes**  | Selects the source key in the operation's response.                                    |

#### 4.4.1 Source authorization

Signature verification establishes that the provider sent a delivery. It does
not establish that any subscriber may read it. A receiver therefore routes a
delivery only to subscriptions that hold a _source binding_: a source kind
and key, established like this:

1. A subscriber asks to subscribe one of its connections to a source kind,
   with values for the access operation's path parameters.
2. The receiver calls the access operation through that connection, with
   the connection's own credential, exactly as an ordinary proxied read would
   be sent (same allowlist, same credential handling).
3. Only a 2xx response whose `key` expression selects a key binds the
   subscription to that kind and key. The key comes from the provider's
   response, never from the subscriber or from a delivery.

The receiver MUST repeat that check when a subscription's lease is renewed
(Webhook Subscriptions §4.3). A check that fails (a 401, 403 or 404, or a
different key) closes the subscription at once (Webhook Subscriptions §4.1).
A check that cannot complete (a 5xx, a timeout) leaves the binding as it was
but does not renew the lease. Two owners who authorized the
same application, or connections to the same provider account, never share a
binding: each subscription is checked with its own connection.

A delivery is routed to every subscription with a binding of the event's
source kind and the delivery's key, that is active (Webhook Subscriptions
§4.1), that subscribed to the delivery's event type, and whose endpoint is
the one the delivery arrived at. A delivery with no key, an event type that
`events` does not declare, or no such subscription is acknowledged to the
provider and discarded, without creating state for its source.

#### 4.4.2 Revocation Object

A delivery that tells the receiver access has narrowed (a repository removed
from an installation, an installation deleted). A revocation can only ever
suspend routing until the next access check; it never grants or restores
access. A wrong or missing declaration therefore leaves access to the
periodic checks of §4.4.1, never wider than they allow.

| Field     | Type                         | Required | Description                                                                                                             |
| --------- | ---------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `event`   | string                       | **Yes**  | An event type. It need not be declared in `events`.                                                                     |
| `actions` | array of string              | No       | Only deliveries with one of these `action` values. Omitted: every action.                                               |
| `source`  | source kind                  | **Yes**  | The kind of the bindings it affects.                                                                                    |
| `context` | name                         | No       | A `context` name of that source kind. Present: it matches bindings by that recorded context key; absent: by source key. |
| `keys`    | body expression; may use `*` | **Yes**  | Selects the affected keys.                                                                                              |

For a verified delivery that matches a revocation, the receiver MUST, in the
same transaction that records the delivery's receipt, suspend every binding
of that source kind whose key (or recorded context key) is among the selected
keys, and schedule an access check for each. Deliveries are not routed to a
suspended binding. A check that fails closes the subscription; one that
passes resumes routing and records an `access-suspended` gap (Webhook
Subscriptions §5.1) if anything was not routed meanwhile. A receiver records a context key
from the first verified delivery routed to a binding and replaces it when a
later verified delivery carries another value.

### 4.5 Hooks Object

| Field               | Type                           | Required | Description                                                       |
| ------------------- | ------------------------------ | -------- | ----------------------------------------------------------------- |
| `sharedApplication` | Shared Application Hook Object | No       | An application-wide hook the operator configures at the provider. |
| `dedicated`         | Dedicated Hook Object          | No       | A hook the receiver creates for one source.                       |

At least one is REQUIRED.

#### 4.5.1 Shared application hooks

| Field                 | Type         | Required | Description                                            |
| --------------------- | ------------ | -------- | ------------------------------------------------------ |
| `verificationProfile` | profile name | **Yes**  | A profile whose secret source is `operatorConfigured`. |
| `description`         | string       | No       | How an operator sets it up.                            |

One endpoint receives the deliveries of every installation of the
application. The receiver never creates, changes, disables or deletes the
provider-side hook: the operator does. When a subscription expires or closes,
the receiver stops routing to it and nothing else; the hook stays, and so do
other subscriptions on it. Deliveries for sources nobody subscribed to are
verified, acknowledged and discarded (§4.4.1). Sharing a hook does not share
payload visibility: routing is per subscription binding.

#### 4.5.2 Dedicated hooks

| Field                 | Type                         | Required | Description                                                                           |
| --------------------- | ---------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `verificationProfile` | profile name                 | **Yes**  | A profile whose secret source is `receiverGenerated`.                                 |
| `source`              | source kind                  | **Yes**  | The kind of source one hook covers.                                                   |
| `create`              | Hook Operation Object        | **Yes**  | Registers a hook. Its `body` MUST contain `$receiver.url` and `$receiver.secret`.     |
| `hookId`              | `$response.body#` expression | **Yes**  | Selects the provider's id of the hook in `create`'s response.                         |
| `delete`              | Hook Operation Object        | **Yes**  | Deletes a hook; its path has a `{hookId}`-style parameter named by `hookIdParameter`. |
| `hookIdParameter`     | string                       | **Yes**  | The path parameter of `delete` that takes the hook id.                                |
| `list`                | Hook List Object             | No       | Lists the source's hooks, to find one whose creation response was lost.               |
| `description`         | string                       | No       | Including the provider permission that hook management needs.                         |

Hook Operation Object: an operation reference plus an optional `body`. The
body is a JSON value in which a string equal to one of these tokens is
replaced, and no other string starts with `$`:

| Token              | Replaced by                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$receiver.url`    | The endpoint URL the receiver allocated for this hook.                                                                                                                            |
| `$receiver.secret` | The secret generated for this hook: at least `minBytes` random bytes, written as base64url without padding. The HMAC key is that text's ASCII bytes, as the provider will use it. |
| `$events`          | An array of the event types (keys of `events`) of the source kind.                                                                                                                |

Hook List Object: an operation reference plus `url` and `hookId`, both
`$response.body#` expressions that use `*` once to select, element by
element, each listed hook's URL and id.

The path parameters of `create`, `list` and `delete` (other than
`hookIdParameter`) MUST be path parameters of the source's access operation;
the receiver fills them with the values the access check was made with.

A dedicated hook:

- is created by the receiver with the credential of a connection whose
  access check passed for its source; creating one may need a provider
  permission that reading does not (`description` should say which);
- is reused by any later subscription of the same endpoint document, source
  kind and key, so one source has at most one dedicated hook per receiver;
- is deleted (or, where the provider has no delete, disabled) by the receiver
  only when no active or needs-reconciliation subscription uses it, and only
  when the receiver created it (it stored its `hookId` from `create`);
- has its creation reconciled after a crash: a receiver that does not know
  whether `create` succeeded calls `list` (when declared) and adopts a hook
  whose URL is the endpoint URL it allocated, before creating another;
  without `list` it MUST NOT retry `create` for that endpoint and instead
  records the provisioning as failed.

Deletion runs as a bounded cleanup job (Webhook Subscriptions §6): retries
with backoff, a deadline, and a visible failure when the credential needed
for it was revoked. A verified delivery that arrives for a hook after its
last subscription closed is acknowledged and discarded.

### 4.6 Event Object

| Field         | Type                            | Required | Description                                                                                                             |
| ------------- | ------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `source`      | source kind                     | **Yes**  | The source kind whose `key` applies to deliveries of this event.                                                        |
| `actions`     | array of string                 | No       | The `action` values the provider documents; informational. Deliveries with other actions are still events of this type. |
| `resources`   | array of Resource Read Object   | No       | Objects whose authoritative read a consumer MAY make.                                                                   |
| `collections` | array of Collection Read Object | No       | Collections a consumer MAY re-read.                                                                                     |
| `payload`     | Reference Object                | No       | A `$ref` to the payload's schema (under `webhooks` or `components`).                                                    |
| `description` | string                          | No       |                                                                                                                         |

Resource Read Object: `resource` (a [CRUD Causality](../crud-causality/README.md)
resource name in `components.crudResources`) and `bindings`, a map from every
variable of that resource's `identity.urlTemplate` to a body expression.
Collection Read Object: `resource`, `collection` (a collection of that
resource) and `bindings` for every variable of the collection's
`urlTemplate`. When the document has no `crudResources` the names cannot be
checked, and a validator reports that.

A delivery is a hint that these objects may have changed, not their state.
A consumer that acts on it reads them through the API (with its own
connection), and treats an older delivery arriving after a newer read as
nothing more than another hint. Deliveries can be duplicated, arrive out of
order or be missing; this extension does not make them a change log.

## 5. Applying via OpenAPI Overlays

The field sits at the root, so one overlay action adds it:

```yaml
overlay: 1.0.0
info: { title: Example Tracker webhook deliveries, version: 1.0.0 }
actions:
  - target: $
    update:
      x-webhook-deliveries: { ... }
```

[examples/tracker-overlay.yaml](examples/tracker-overlay.yaml) is a complete
one for the neutral example. An overlay for a published provider document
follows the immutability and pinning rules of
[`overlays/README.md`](../../../overlays/README.md) and needs a new dated
catalog to take effect; none exists yet.

## 6. Examples

### 6.1 A neutral provider

[examples/tracker.yaml](examples/tracker.yaml) is a made-up "Example
Tracker" with both hook models: a shared application hook signed over the
raw body, and dedicated per-project hooks signed over a timestamp and the
body, with a five-minute tolerance. Its fixtures under
[examples/tracker-deliveries/](examples/tracker-deliveries/) are signed with
the invented secrets in [test_validate.py](test_validate.py).

### 6.2 GitHub, as synthetic fixtures

[examples/github-fixture.yaml](examples/github-fixture.yaml) is a synthetic,
trimmed document that declares GitHub's webhook behaviour through this
extension, next to the `issue` resource and `issues` collection names of the
published `github-issues` CRUD Causality overlay. It is not a published
overlay: its paths are trimmed to what it references, and nothing in it is
verified against live deliveries. What it declares, with the documentation it
follows:

- `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 over the raw body, with
  no timestamp
  ([validating deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries));
- `X-GitHub-Delivery`, kept on redelivery, and a ten-second response
  expectation
  ([best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks));
  `X-GitHub-Event` as the event type and `action` in the body;
- the shared GitHub App webhook (operator-configured secret) preferred for the
  pilot, with the installation id recorded as context
  ([GitHub App webhooks](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps));
- repository sources keyed by the numeric repository id, checked with
  `GET /repos/{owner}/{repo}` through the connection;
- dedicated repository hooks
  ([repository webhooks API](https://docs.github.com/en/rest/repos/webhooks)),
  declared but not used by the pilot, since managing them needs the Webhooks
  write permission the pilot's grant does not have;
- `installation_repositories` (`removed`) and `installation`
  (`deleted`, `suspend`) as revocations.

The deliveries under [examples/github-deliveries/](examples/github-deliveries/)
are invented: fake ids, a fake owner and repository, and a signature made
with a fake secret that appears only in [test_validate.py](test_validate.py).

## 7. Validation

[validate.py](validate.py) checks a document's `x-webhook-deliveries`
against [schema.json](schema.json) and then the rules a schema cannot
express:

- every profile, source kind, context name, resource and collection a field
  names is declared;
- a `timestamp` is present exactly when `signedContent` is
  `timestampDotRawBody`;
- a shared hook uses an `operatorConfigured` profile and a dedicated hook a
  `receiverGenerated` one;
- a dedicated hook's `create` body contains `$receiver.url` and
  `$receiver.secret`, and no other `$`-string;
- every operation reference exists under `paths` with that method; the
  access operation is a `get`; hook operation path parameters are the access
  operation's (plus `hookIdParameter` on `delete`);
- event bindings cover exactly the variables of the named URL template;
- `*` appears only where §4.4.2 and §4.5.2 allow it, and at most once.

It also has two reference functions used by the tests:
`verify_delivery(profile, headers, body, secret, now)` follows §4.2.1 with
`hmac.compare_digest`, and `route_delivery(document, headers, body)` returns
the delivery id, event type, action, source kind and key, context keys,
revoked keys and the resource and collection reads. They are a check on the
text, not a receiver.

```sh
cd openapi-extensions/spec/webhook-deliveries
python3 -m unittest test_validate -v
python3 validate.py examples/tracker.yaml examples/github-fixture.yaml
```

A validator cannot check that a declaration matches the provider. Authors
cite the provider's documentation in `description` and confirm with
recorded deliveries before a declaration is called verified.

## 8. Open points

- **Handshakes.** Some providers confirm an endpoint with a challenge
  request before sending deliveries (a token to echo, a verification
  delivery). The plan allows "bounded handshake mechanisms"; this version
  defines none, so such providers are not covered yet.
- **Secret rotation.** Accepting two secrets for one endpoint during a
  rotation, or several signatures in one header, is not covered.
- **Other algorithms and signed content.** Asymmetric signatures (Ed25519,
  RSA) and signed content that includes the URL or other headers are not
  covered.
- **Installation-scope subscriptions.** A source whose access check is
  membership in a paginated list (GitHub's installations for a user) cannot
  be expressed: §4.4's `key` reads one response. The GitHub fixture
  therefore subscribes per repository only.
- **Non-JSON bodies.** Form-encoded payloads (an option for GitHub
  repository hooks) are not covered; the fixture's `create` body asks for
  JSON.
- **Revocation by context.** Recording context keys from deliveries (§4.4.2)
  means a binding has no context until its first delivery; a revocation
  before then is caught only by the next access check. Whether to read the
  context during the access check instead is open.
- **Periodic revalidation interval.** §4.4.1 requires a check at each
  renewal (every 12 hours with the pilot defaults). Whether a separate,
  shorter interval is needed is open.
- **Deletion as an event.** Whether a delivery's action should be declared
  as a deletion hint (like Deletion Feeds' tombstones) is open; this version
  always asks the consumer to read.

## Reference Implementation

None yet. The integration proxy is planned to implement it in
ontola/atomic-plugins#369, steps 2 and 3, behind a configuration switch that
is off by default.
