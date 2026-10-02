# Open Cloud Mesh

Status: **experimental receiver**. Receiving a file share from a real
Nextcloud 35.0.1 is verified by an opt-in e2e, but only on an atomic-server
with two host fixes that no pin has yet (see "Against a real Nextcloud"); at
the pin (`a12b74a`) Nextcloud's shares are refused. Not tried against
ownCloud, OCIS or other Nextcloud versions. `manifest.json` and `plugin.js`
are the host release inputs; edit `plugin.mjs` and run `build.mjs`.

An Open Cloud Mesh (OCM) server can share a file with a person on this
drive: the plugin answers OCM discovery, accepts RFC 9421 signed Share
Creation Notifications from servers the installer allows, has the host
fetch the shared file into the blob store, stores it as a File in a folder
the installer picks, and sends `SHARE_ACCEPTED` back. The received copy
opens in the data browser like any uploaded File (including its "convert to
document" action).

Reference: [OCM 1.5.0](https://github.com/cs3org/OCM-API/tree/v1.5.0)
(`IETF-OCM.md`, `spec.yaml`), the latest release on 2026-09-29.

## What it implements

| OCM 1.5 part                                     | Here                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Discovery                                        | `GET /.well-known/ocm` (exclusive claim) and the removed-in-1.4 `/ocm-provider`, both on the installation's origin: `apiVersion` `1.5.0`, `endPoint` `<base>/ocm`, `resourceTypes: [{ name: "file", shareTypes: ["user"], protocols: { "webdav-receive": { uri: "absolute" } } }]`, `capabilities: ["http-sig", "notifications"]`, `criteria: ["must-use-http-sig", "allowlist"]`, `jwksUri` `<base>/ocm/jwks`. `enabled` is `false` until `sharesFolder` is configured. |
| HTTP Message Signatures                          | Inbound: verified by the host before this code runs (see "Host contracts"). Outbound: the host's delivery queue signs with the installation's Ed25519 key `ocm-key`, `tag="ocm"`, covering `@method`, `@target-uri`, `content-digest` and `content-length`; the key is published as `<host>#ocm-key` at `/ocm/jwks`.                                                                                                                                                     |
| Share Creation Notification (`POST /ocm/shares`) | `shareType: user`, `resourceType: file`, WebDAV (`multi` or legacy `webdav`) with an **absolute** `uri` and a `sharedSecret`; or Nextcloud's legacy form, `{ name: "webdav", options: { sharedSecret, permissions: "<WebDAV property name>" } }` with no `uri` (see "Against a real Nextcloud"). `shareWith` may carry the receiver's URL (`bob@https://host`), as Nextcloud sends it. `201 { recipientDisplayName }` on success.                                        |
| Resource access                                  | Shared-secret access only, done by the host (`ctx.blobs.fetch`): `GET <uri>` with `Authorization: Bearer <sharedSecret>`; for Nextcloud's legacy form, `GET <signer origin>/public.php/webdav/` with `Authorization: Basic base64(<sharedSecret>:)`. No `PROPFIND`, no token exchange.                                                                                                                                                                                   |
| Notifications (`POST /ocm/notifications`)        | Receives `SHARE_UNSHARED` and `SHARE_CHANGE_PERMISSION` (provider ID from `notification.file.providerId`, or the deprecated top-level `providerId`; `senderDomain`, if present, must be the signer). Sends `SHARE_ACCEPTED` once per share.                                                                                                                                                                                                                              |

Refused, with the status OCM names: unsigned or non-`tag="ocm"` requests
(`401`, from the host or the plugin); a signing server that is not in
`allowedPeers`, or a `sender`/`owner` that is not an account of the signing
server (`403`); an unknown recipient, an expired share, an `http:` WebDAV URI,
a file the sender refuses
to serve (`400`); groups, folders, encryption, relative WebDAV URIs,
`webapp`/`ssh`, and any `requirements` such as `must-exchange-token` or
`must-use-mfa` (`501`). Nothing is stored and nothing is sent for a refused
share.

### What is stored

Each accepted share is one `File` under `sharesFolder`, created by the
installation's agent through the host's route-write grant: name, `blob`
(the fetched bytes, `atomic:blob:<blake3>`), size, media type,
`downloadURL` `/download/files/<blake3>`, and a Markdown description
listing the state, sender, owner, sending server, provider ID, recipient,
permissions and expiration. `localId` holds the identity
`ocm-share-v2 <sending server> <providerId>` (each part URI-encoded; plain
text, because the host's planner reads JSON-looking strings as JSON); a repeated notification
with the same identity answers `201` and changes nothing.

**The shared secret is never stored**: not in the File, the answer, a
delivery or a log line of this plugin. It is used once, for the fetch. So
the copy is a snapshot taken when the share arrived: later changes at the
sender are not fetched, and `SHARE_UNSHARED` marks the copy `unshared`
without deleting it (OCM lets a receiver clean up; this one leaves that to
the person).

Limits: request bodies up to 65,536 bytes; the fetched file up to the
operator's `--plugin-route-max-blob-bytes` (16 MiB by default), counted
toward the installation's bytes-per-day quota; the whole request within the
host's route deadline (3 s without the `extended-fuel` grant, which the
fetch must fit in).

## Configuration

Set in the install review, next to approving the route writes:

```json
{
  "sharesFolder": "<subject of a Folder on this drive>",
  "allowedPeers": { "cloud.example.org": true },
  "recipients": { "bob": "Bob" },
  "providerName": "Atomic Server"
}
```

`allowedPeers` keys are server domains as OCM addresses spell them
(`host` or `host:port`, lowercased). `recipients` keys are the user part of
the OCM addresses on this installation's host: with the above, the address
is `bob@<installation host>`. Everything else answers `403` or `400`.

The installation needs `--plugin-routes read-write`, a routes origin
(`--routes-origin`; the manifest uses the `installation-origin` mount,
since `drive-prefix` routes cannot use the `installation` principal), and
the install review's route-write approval for `sharesFolder`.

## Host contracts it depends on

All from atomic-server's plugin-routes work (ontola/atomic-plugins#167),
plus the pieces added on atomic-server branch `claude/plugin-ocm-host`
(on top of `claude/plugin-fediverse-host`), as folded into pin candidate16
with the route field `fetches` below. The current pin, candidate19
(`a12b74a`), contains them (`ocm.spec.ts` passes there, see
[Against a real Nextcloud](#against-a-real-nextcloud)); a pin before
candidate16 does not. `ES256` keys, which Nextcloud sends, are the exception
and are not in the pin. The pieces:

- **OCM key discovery for `auth: http-signature`** (new). A request whose
  RFC 9421 signature carries `tag="ocm"` is verified the OCM way: exactly
  one such signature, covering `@method`, `@target-uri` and, with a body,
  `content-digest` and `content-length`; the signer's domain is the JSON
  body's `senderDomain` or the domain of its `sender`; the key is the JWK
  with that `kid` at the `jwksUri` of `https://<domain>/.well-known/ocm`,
  and its `alg` decides the algorithm (Ed25519, RS256 or PS512).
  `request.caller` is `{ keyId, owner, domain, scheme, alg, tag, endPoint }`.
- **Tagged outbound signatures** (new): `sign.tag` on deliveries and
  `ctx.keys.sign`, and `ctx.keys.publicKey(...).jwk`.
- **`ctx.blobs.fetch`** (new): a `GET` whose answer goes straight into the
  blob store, through the egress guard, for an operation listed in the
  route's own `fetches` field (a declared `GET` read operation; wildcard
  host and trailing `{*rest}` path allowed). It needs `read-write` (gate
  surface ``fetch `<id>` ``), and the install review says "May download
  files from <hosts> into your drive": for this plugin's wildcard host,
  "May download files from any server into your drive". The plugin only
  gets `{ status, blob }`.
- The Fediverse worker's debug-build test seams
  (`ATOMIC_PLUGIN_E2E_LOOPBACK_PEERS`, `ATOMIC_PLUGIN_E2E_PEER_CA`): key and
  discovery fetches, deliveries and (here) `blobs.fetch` may reach loopback,
  trusting only the peer's test CA there. Release builds ignore them. Only
  the e2e lane sets them (lanes.json `serverEnv`).
- Existing: route writes into `writeTargets` under the route grant, the
  durable delivery queue, host-held installation keys, the `ocm`
  well-known claim.

The operations are `fetch-file` (`GET https://*/{*rest}`, `effect: read`,
in the shares route's `fetches`) and `notify` (`POST https://*/{*rest}`,
`effect: write`, in its `enqueues`). The first version borrowed an
`enqueues` write operation for the download; candidate16's host has the
dedicated `fetches` field instead, and `integrations/tooling/manifest-http.mjs`
mirrors it, checked against the host's shared manifest fixtures copied from
candidate16 (`integrations/tooling/fixtures/plugin-manifest/v3-fetches*.json`).

## Not implemented

- Sending shares, and serving shared resources over WebDAV (`PROPFIND`,
  ranges): needs host method and response-header support (#167 section 4).
- The code flow (`exchange-token`, `tokenEndPoint`), `must-use-mfa`,
  invites (`/invite-accepted`, WAYF), `REQUEST_SHARE`, `REQUEST_RESHARE`,
  groups, folders, encryption, the `webapp` and `ssh` protocols.
- Relative WebDAV URIs (would need an inline read of the sender's
  discovery, which the host only allows for fixed endpoints), and a
  `PROPFIND` before the `GET`.
- Discovery over plain `http` (OCM's testing-setup fallback): the host
  fetches `https://<domain>/.well-known/ocm` only.
- Draft-cavage signatures and the pre-1.4 `publicKey` discovery field that
  Nextcloud uses towards a receiver without the `http-sig` capability (and,
  presumably, older Nextcloud releases always; which ones was not checked).
  The host still verifies cavage signatures against a fetched `keyId`
  document, but this plugin only accepts `tag="ocm"` callers.
- `SHARE_ACCEPTED` that Nextcloud accepts: Nextcloud 35.0.1 answers `400`,
  because it wants the share's `sharedSecret` (and the deprecated top-level
  `providerId`) in the notification, and this plugin never stores or sends
  the secret. The received copy is unaffected; Nextcloud just does not mark
  the share accepted.
- Replay protection beyond the ±300 s `created` window, and atomic
  uniqueness for concurrent identical shares (two concurrent deliveries of
  the same share could both create a File; the host has no in-commit
  uniqueness check yet, #167 section 1).
- Re-fetching after the sender changes the file, and revocation of the local
  copy on `SHARE_UNSHARED`.

## Against a real Nextcloud

Checked on 2026-10-01 with the official Docker image `nextcloud:35.0.1-apache`
(`status.php` versionstring `35.0.1`, OCM `apiVersion` `1.0-proposal1`,
`version` `1.1.2`), first against a recording stub and then by
`e2e/nextcloud.spec.ts`. What Nextcloud sends to a receiver whose discovery
advertises `http-sig` and a `jwksUri` (like this one):

- **Discovery**: `GET https://<host>/.well-known/ocm`, then
  `/ocm-provider`, then the same over `http://` (Nextcloud tries `https`
  first unless the address names a scheme). User agent
  `Nextcloud-Server-Crawler/35.0.1`. A loopback receiver also needs
  Nextcloud's `allow_local_remote_servers`.
- **Signature**: RFC 9421 with `tag="ocm"`, label `ocm`, covering
  `"@method" "@target-uri" "content-digest" "content-length"`, with
  `created` and `keyid`, no `alg`. The key is ECDSA P-256: `keyid`
  `https://<host>/ocm#ecdsa-p256-sha256-1`, published as an `EC`/`P-256`
  JWK with `alg` `ES256` at its `jwksUri`
  (`/apps/cloud_federation_api/api/v1/jwks`). It also sends an uncovered
  `Date`. Its discovery still has the pre-1.4 `publicKey` (RSA, keyId
  `https://<host>/ocm#signature`) for draft-cavage receivers.
- **Share**: `shareWith` `bob@http://<receiver host>` (the receiver's URL,
  with `https://` when the address has no scheme), `owner`/`sender`
  `alice@<host>`, `senderDomain` absent, and the legacy protocol
  `{ "name": "webdav", "options": { "sharedSecret": "…", "permissions":
"{http://open-cloud-mesh.org/ns}share-permissions" } }`, with no `uri`.
  Nextcloud only sends a `webdav.uri` (`https://<host>/public.php/webdav/`)
  and the token exchange to receivers that advertise `exchange-token`.
  The file is then at `GET https://<host>/public.php/webdav/` with
  `Authorization: Basic base64(<sharedSecret>:)`; `Bearer` is refused there
  (`401`). A shared **folder** is sent the same way, as `resourceType:
file`, and that URL then answers `200` with an HTML page.
- **Unshare**: `SHARE_UNSHARED` with the top-level `providerId`,
  `notification.sharedSecret`, and no `senderDomain` (which OCM 1.5
  requires).

What it took:

| Gap                                                                  | Where                    | Fix                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EC`/`ES256` JWKs refused, so every Nextcloud request was a `401`    | host (`http_signatures`) | atomic-server branch `claude/plugin-ocm-es256` (`4dd4f39be`, on the pin `a12b74a`): ECDSA P-256 verification, from a JWK only.                                                                                                                                 |
| `SHARE_UNSHARED` names no sender, so the host could not find the key | host (`route_auth`)      | Same branch: with neither `senderDomain` nor `sender` in the body, the signer domain is the `keyid`'s; the key must still be in that domain's own JWK Set.                                                                                                     |
| Legacy `options` protocol without `uri`; `shareWith` with a scheme   | plugin                   | `parseShare`/`address`. The file is read from `<signer origin>/public.php/webdav/` with Basic auth, through its own fixed-path operation `fetch-legacy-webdav` (`fetch-file`'s `{*rest}` does not match a trailing `/`), only on the origin the host verified. |
| No `senderDomain` in notifications                                   | plugin                   | `senderDomain` optional; when present it must still be the signer.                                                                                                                                                                                             |
| Folders arrive as `resourceType: file`                               | plugin                   | An HTML answer for a legacy share whose name is not `.html`/`.htm`/`.xhtml` is refused (`501`); Nextcloud then reports the share as failed. The fetched page stays in the blob store, unreferenced.                                                            |

Results of `OCM_NEXTCLOUD_E2E=1 node integrations/tooling/run-lane.mjs
open-cloud-mesh --tier e2e` (both specs):

- **atomic-server `a12b74a` (the pin)**, binary from
  `ghcr.io/ontola/atomic-server-e2e:a12b74a…-plugin-routes`: `ocm.spec.ts`
  passes; `nextcloud.spec.ts` fails at step 1, Nextcloud reporting the
  receiver's `401` ("the OCM signing key could not be used": the `ES256`
  JWK).
- **atomic-server `claude/plugin-ocm-es256` (`4dd4f39be`)**, built with
  `--features wasm-plugins,plugin-routes`: both pass. Nextcloud reports the
  share created, the host fetches the file into the blob store, the File
  shows "State: accepted", unsharing in Nextcloud marks it unshared, and a
  folder share is refused. The `SHARE_ACCEPTED` delivery fails for good
  with Nextcloud's `400` (see "Not implemented").

## Build and tests

```sh
node integrations/open-cloud-mesh/build.mjs
node integrations/tooling/run-lane.mjs open-cloud-mesh --tier node
node integrations/tooling/run-lane.mjs open-cloud-mesh --tier e2e
```

The node tier runs `plugin.test.mjs` (every route with a fake host:
discovery, JWK Set, accepted/refused/repeated shares, notifications,
secret handling, the bundle) and `peer.test.mjs` (the e2e peer's own RFC
9421 code).

`e2e/nextcloud.spec.ts` is opt-in (skipped unless `OCM_NEXTCLOUD_E2E=1`;
needs Docker, pulls `nextcloud:35.0.1-apache` or `OCM_NEXTCLOUD_IMAGE`, and
uses `127.0.0.1:18443` or `OCM_NEXTCLOUD_PORT`). `e2e/nextcloud.mjs` runs
the container on the host network with Apache bound to `127.0.0.1` only,
HTTPS from the same throwaway test CA as the peer, SQLite and invented
users, and removes it afterwards. The two specs share that CA through the
OS temporary directory (`peer.mjs` `shareCa`), because the server trusts
exactly one and Playwright runs them in parallel.

The e2e tier runs `e2e/ocm.spec.ts` on atomic-server built with the
`plugin-routes` feature at `--plugin-routes read-write`, with the invented
OCM peer in `e2e/peer.mjs`, serving HTTPS on loopback with a throwaway
test CA (made with `openssl`), which the lane's `serverEnv` seams let the
server reach. It installs the plugin through the store's
review dialog, checks discovery, sends a signed share, sees the File (and
its text preview) in the drive, has the peer verify the `SHARE_ACCEPTED`
notification against the installation's JWK Set, sends `SHARE_UNSHARED`,
and checks two refusals. The peer is written from the specification, not
from atomic-server's code, but it is still ours: it is not interoperability
evidence with any deployed OCM server.

**Verified on candidate16** (2026-09-29): with the `fetches` manifest, the
e2e passed against pin candidate16 (`38306758`) built with the
`plugin-routes` feature, including the install review's "May download files
from any server into your drive". It had earlier passed against
`claude/plugin-ocm-host` d18d2f6a2 with the `enqueues` manifest. At a pin
without OCM key discovery the signed share is refused and the e2e fails.
