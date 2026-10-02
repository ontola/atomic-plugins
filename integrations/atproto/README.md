# AT Protocol handle and did:web document

Status: **handle responder and did:web document implemented and exercised on
a real feature-enabled host; resolved by Bluesky's reference identity code
and accepted by the reference PDS on the loopback (2026-10-02, see
[Interoperability evidence](#interoperability-evidence)); no live Bluesky
network evidence**.
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
and reconfigures to `did:plc` to check `did.json` disappears. Along the way
it resolves the same identity with Bluesky's reference code over TLS
(below). It uses invented names only and makes no network calls outside the
machine.

## Interoperability evidence

The e2e checks the plugin's answers with Bluesky's own code as well as its
own assertions. Results on 2026-10-02, atomic-server pin `a12b74a` with
`plugin-routes` (which reports `requestHost`), Node 22.23.3:

| Package (pinned in `e2e/package.json`) | Version | Used for                                                                                         |
| -------------------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `@atproto/identity`                    | 0.5.15  | `HandleResolver` (HTTPS method), `DidResolver` (did:web), `ensureAtpDocument`, `verifySignature` |
| `@atproto/did`                         | 0.5.6   | the strict `didDocumentValidator`, `extractAtprotoData`, `isAtprotoDidWeb`                       |
| `@atproto/crypto`                      | 0.5.6   | fresh secp256k1 and P-256 key pairs, `parseDidKey`                                               |
| `@atproto/syntax`                      | 0.7.6   | `ensureValidHandle`, `ensureValidDid`                                                            |
| `@atproto-labs/fetch-node`             | 0.4.0   | `safeFetchWrap`, the resolvers' default fetch                                                    |
| `undici`                               | 7.30.0  | the loopback connector                                                                           |
| `ghcr.io/bluesky-social/pds` (opt-in)  | 0.5.36  | `@atproto/pds`, image digest `sha256:95d6179b…` (`e2e/pds.ts`)                                   |

**Reference resolver (every e2e run).** `e2e/reference.ts` builds the
resolvers' fetch the way `@atproto/identity`'s `createDefaultFetch` does
(`safeFetchWrap`: no IP hosts, no custom ports, no plain http, explicit
redirect mode, the forbidden-domain list, 512 kB and 10 s limits), with
private addresses allowed, because the host is 127.0.0.1. Its connector
sends each `https://<name>:443` connection to a TLS terminator on an
ephemeral loopback port, with the original name as SNI, and the terminator
forwards to atomic-server with that name in `Host`. The certificate is a
`*.e2e.atomicdata.dev` wildcard from a throwaway `openssl` CA that only
this client trusts. What passed, for a secp256k1 key and, after a key
rotation, a P-256 key:

- handle to DID through `/.well-known/atproto-did`;
- did:web to document through `/.well-known/did.json`: the package's own
  schema and `id` check, then `@atproto/did`'s stricter validator;
- `ensureAtpDocument`: the handle, the `#atproto_pds` endpoint, and the
  `#atproto` Multikey as the same `did:key` the key pair reports
  (`ES256K`, `ES256`);
- bidirectional: the handle in `alsoKnownAs` resolves back to the same DID;
- `verifySignature` with the resolved key accepts a signature by the
  private key, and after rotation rejects one by the old key;
- the second host name never verifies: on this host it resolves to nothing
  and `did:web:<other>` is not found. On a host without `requestHost` the
  spec expects it to resolve to the handle's DID, whose document names the
  handle and not it, and `did:web:<other>` to fail the `id` check (not run
  at this pin);
- after reconfiguring to `did:plc`, the handle resolves to the PLC DID and
  `did:web:<handle>` is not found.

**Reference PDS (opt-in, needs Docker).**
`ATPROTO_PDS_E2E=1 node integrations/tooling/run-lane.mjs atproto --tier e2e`
also starts `ghcr.io/bluesky-social/pds` (`e2e/pds.ts`) with its XRPC port
on 127.0.0.1 only, the test names mapped to 127.0.0.1 inside its container,
no working DNS resolver, and a TLS terminator in its network namespace that
reaches atomic-server through a bind-mounted Unix socket. Its one
relaxation is `PDS_DISABLE_SSRF_PROTECTION=true`, without which it refuses
to fetch from a loopback address. It then goes through an account
migration onto the plugin's identity, and every step passed:
`com.atproto.identity.resolveHandle` returns the did:web (and refuses the
second host name); `com.atproto.server.createAccount` with that DID and a
service-auth token signed by its `#atproto` key succeeds, so the PDS
resolved the document, verified the token against the published key and
checked the handle resolves back to the DID; `checkAccountStatus` reports
`validDid: false` until the drive owner publishes
`getRecommendedDidCredentials`' endpoint and `did:key` through the plugin
exactly as "Configure and deploy" says, then `validDid: true`; and
`activateAccount` succeeds. The PDS fetched only the handle's
`/.well-known/atproto-did` and `/.well-known/did.json` (plus the second
name's `atproto-did`).

**DID ports.** AT Protocol allows a `%3A`-encoded port in did:web for
`localhost` only. `@atproto/syntax` accepts `did:web:<host>%3A8443`, but
`@atproto/did` rejects it outside localhost and the resolvers' default
fetch refuses it before connecting ("Custom https: ports not allowed"), as
it refuses `did:web:localhost%3A<port>`, which resolves over plain http.
The plugin accepts no port in a did:web or handle, so it agrees with the
reference code here.

**Not covered by the reference checks:**

- DNS TXT (`_atproto.<handle>`): the plugin does not publish TXT records,
  and on the invented names the method would query public DNS. The spec's
  resolver has that method turned off, and the PDS container has no working
  resolver;
- port 443 on a real host and a publicly trusted certificate (see
  "Public HTTPS" below);
- the redirect-hop checks of `safeFetchWrap` (the spec's connector replaces
  its dispatcher; the plugin never redirects) and the private-address check
  (the host is the loopback);
- a relay crawling the PDS, the Bluesky AppView showing the handle, and the
  `did:plc` reverse direction.

**Reference behaviour the plugin does not enforce:** the resolvers' default
fetch refuses `example.com`, `example.org`, `example.net` and
`googleusercontent.com` and their subdomains, so a handle or did:web there
never resolves. The plugin accepts them (the examples above use
`example.com`); nobody can deploy on those names anyway. The fetch also
refuses custom ports, which matters for clients that fetch the PDS through
it: the plugin accepts a `pds` with a port, but a production PDS is on 443.

### Public HTTPS

Resolvers fetch only `https://<handle>/...` on port 443 with a publicly
trusted certificate. At pin `a12b74a`, atomic-server's ACME support
(`server/src/https.rs`) requests a certificate for its own `--domain` (and
its wildcard, with DNS-01), not for host names bound with `/bind-drive`.
So a handle that is not under the server's domain needs a TLS-terminating
proxy in front of atomic-server with a certificate for that name (read from
the source, not tried on a public host).

Not yet verified: TLS on port 443 of a real host, a relay or the Bluesky
AppView, and a live handle. Record the resolver version, test hostname, DID
and bidirectional result before claiming live verification.

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
