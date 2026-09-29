# AT Protocol handle and did:web document

Status: **handle responder and did:web document implemented and exercised on
a real feature-enabled host; no live Bluesky interoperability evidence**.
This dependency-free QuickJS module lets a drive's hostname be an
[AT Protocol handle](https://atproto.com/specs/handle), for a `did:plc`
identity or for a `did:web` identity rooted in that same hostname. It is not
a Personal Data Server (PDS), OAuth service, repository or firehose: the
account, its repository and its signing key stay on an existing PDS.

`plugin.mjs` exports a schema-version-3 manifest and `handle(ctx, request)`.
The manifest uses `drive-host` and declares two anonymous GET/HEAD routes,
each with an exclusive well-known claim the host dispatches to it:

| Claim                      | Route          | Answers                                                                                   |
| -------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `/.well-known/atproto-did` | `/atproto-did` | `200`, `text/plain`, the DID bytes only                                                   |
| `/.well-known/did.json`    | `/did.json`    | `200`, `application/json`, the DID document, only for `did:web:<handle>`; `404` otherwise |

HEAD has identical metadata and an empty body. All responses are `no-store`
and `Access-Control-Allow-Origin: *` without credentials. Requests perform no
Atomic reads/writes or outbound calls.

## Configure and deploy

For a `did:plc` identity (an account on any PDS, such as bsky.social, whose
handle you change to your drive's hostname):

```json
{
  "handle": "user.example.com",
  "did": "did:plc:ewvi7nxzyoun6zhxrhs64oiz"
}
```

For a `did:web` identity whose document this drive publishes:

```json
{
  "handle": "user.example.com",
  "did": "did:web:user.example.com",
  "pds": "https://pds.example.com",
  "signingKey": "zQ3shqwJEJyMBsBXCWyCBpUBMqxcon9oHB7mCvx4sSpMdLJwc"
}
```

Use your actual identity and hostname; the values above are examples (the key
is the AT Protocol cryptography spec's example). `pds` and `signingKey` are
what the PDS hosting the account publishes for it: the reference PDS returns
them from `com.atproto.identity.getRecommendedDidCredentials`
(`services.atproto_pds.endpoint`, and `verificationMethods.atproto`, a
`did:key:z…` value; the plugin accepts it with or without the `did:key:`
prefix and publishes the bare Multikey). The document the plugin serves is:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1",
    "https://w3id.org/security/suites/secp256k1-2019/v1"
  ],
  "id": "did:web:user.example.com",
  "alsoKnownAs": ["at://user.example.com"],
  "verificationMethod": [
    {
      "id": "did:web:user.example.com#atproto",
      "type": "Multikey",
      "controller": "did:web:user.example.com",
      "publicKeyMultibase": "zQ3sh…"
    }
  ],
  "service": [
    {
      "id": "#atproto_pds",
      "type": "AtprotoPersonalDataServer",
      "serviceEndpoint": "https://pds.example.com"
    }
  ]
}
```

A `did:web` on a _different_ host (`did:web:id.example.org` with handle
`user.example.com`) is accepted: this drive then answers the handle only,
and `did.json` is `404`, because that DID's document belongs to its own host.
`pds` and `signingKey` are ignored except for `did:web:<handle>`.

Validation:

- Handles are normalized to lowercase and validated as production DNS names,
  bounded to 253 characters. Reserved suffixes (`.test`, `.localhost`,
  `.example`, …), whitespace, IP addresses and invalid labels are rejected.
- DIDs: 24-character lowercase base32 `did:plc`, and hostname-only `did:web`.
  Other methods, paths, ports, query/fragment suffixes and injection strings
  are rejected. See the [AT Protocol DID rules](https://atproto.com/specs/did).
- `pds`: an `https://` origin on a production hostname, optional port, no
  path, query or userinfo.
- `signingKey`: a base58btc Multikey (`z…`) of a 33-byte compressed
  secp256k1 (multicodec `0xe7`) or P-256 (`0x1200`) public key, the two
  curves AT Protocol accepts for `#atproto`.

This checks syntax, not DID existence, key ownership or that the PDS hosts
the account.

Deploy on a drive whose hostname is `config.handle`, with public HTTPS on
port 443. The host requires the `plugin-routes` build feature, the
operator's `--plugin-routes read-only` switch, installation consent, and the
drive owner's approval of both exclusive claims (another installation holding
`atproto-did` or `did.json` on that drive's hosts refuses the install). The
plugin claims `did.json` even for a `did:plc` identity; it then answers
`404` there, but no other plugin can serve `did.json` on that drive.

### Hostname matching

atomic-server branch `claude/plugin-atproto-host` (on candidate14,
`1432e244a`) gives handlers `request.host`: the host name the registry
dispatched on, lowercase without port, taken from the same `Host` value it
looked the drive up by and never from `Forwarded`/`X-Forwarded-Host`. It
reports this as `hostFeatures.pluginRoutes.requestHost: true` in
`/plugin-catalog`. On such a host only `config.handle` answers; every other
hostname bound to the same drive gets `404`, whatever forwarding headers a
client adds. Pin candidate16 (`38306758`, the `.atomic-server-ref` this
plugin landed with) includes that branch; the e2e passed there on
2026-09-29.

**Older hosts** (pins before candidate16, candidate14 itself included) pass
path/wellKnown/method and a `url`/`base` whose authority Actix takes from
forwarding headers, but no trusted host name. There the plugin cannot tell
hostnames apart: every approved hostname of the drive answers with the same
DID. Do not install on a multi-host drive on those hosts. The plugin never
treats `url`, `Origin`, forwarded headers or query parameters as host
identity.

### Both directions

A client trusts a handle only when the DID's document names it back
(`alsoKnownAs: ["at://<handle>"]`). For `did:web:<handle>` the plugin
generates both directions from one config, so they cannot disagree. For
`did:plc`, the reverse direction lives in the PLC directory and is set at
the PDS (by changing the account's handle); the plugin does not check it,
because that needs outbound calls this plugin does not declare.

## Failures and limits

Missing or invalid config returns a generic `503` without reflecting config
data. Other routes/paths/well-known names, `did.json` without a
`did:web:<handle>` identity, and (where `request.host` exists) other host
names return `404`. Unsupported methods return `405` (defense in depth: the
host manifest restricts methods before execution). No redirects or dynamic
headers contain configuration values. `run(ctx)` validates config and
returns no intents.

## Build and CI

```sh
node integrations/atproto/build.mjs
node integrations/tooling/run-lane.mjs atproto --tier node
node integrations/tooling/run-lane.mjs atproto --tier e2e
```

The build produces `integrations/atproto/dist/plugin.js` and `manifest.json`.
It copies the self-contained module verbatim; no Node dependency reaches the
QuickJS payload. Nineteen Node tests exercise the manifest/request shape,
GET/HEAD on both routes, exact DID bytes and the DID document, dispatch
mismatch, `request.host` matching, invalid configuration, method refusal,
hostile headers, production handle/DID/PDS syntax, Multikey decoding
against the spec's example keys and freshly generated secp256k1/P-256 keys,
and reproducible builds.

The e2e tier (`e2e/atproto.spec.ts`, lane `atproto`, `pluginRoutes:
read-only`) runs on atomic-server built with the `plugin-routes` feature:
it publishes `plugin.mjs`, binds two invented host names to the test drive,
commits an active Installation with a `did:web` config, resolves
`/.well-known/atproto-did` and `/.well-known/did.json` on the handle host
over HTTP with a `Host` header, checks `alsoKnownAs` names the handle,
checks the other host name (strictly `404` where `requestHost` is reported),
and reconfigures to `did:plc` to check `did.json` disappears. It uses
invented names only and makes no network calls outside the machine.

Not yet verified: TLS on port 443, an independent resolver (for example
`@atproto/identity`), a real PDS accepting the `did:web` identity, and the
Bluesky AppView showing the handle. Record the resolver version, test
hostname, DID and bidirectional result before claiming live verification.

## Beyond the handle: what a PDS would take

A drive serving its own AT repository (rather than pointing at an existing
PDS) needs, per ontola/atomic-plugins#167 section 7 and
`docs/design/server-plugin-routes.md` (placement E):

- a repository signing key on secp256k1 or P-256, held by the host. Host
  installation keys today are RSA-2048 and Ed25519 only, so a QuickJS
  plugin cannot sign repository commits;
- DAG-CBOR encoding, a Merkle Search Tree, CIDs and CAR export, with
  durable per-commit state and revisions (possible in QuickJS, but the
  commit must be atomic with the Atomic resources it mirrors: #167 section
  1);
- XRPC `com.atproto.sync.*` and `repo.*` reads, blob serving, and the
  `com.atproto.sync.subscribeRepos` WebSocket firehose that relays crawl.
  Without the firehose, the Bluesky network does not index the repository;
  host WebSockets (atomic-server#1722) are design-only;
- accounts, sessions and atproto OAuth (PAR + DPoP) for writing clients,
  and `did:plc` operations or `did:web` document updates on key rotation.

That is a sidecar (the reference PDS) behind an operator-approved
declaration (atomic-server#1723), with a plugin bridging Atomic resources
to it as a client; it is not in scope here.
