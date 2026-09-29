# Willow Atomic export adapter

Status: **experimental**, in QuickJS JavaScript. This package has two parts:

- a **drop route**, `GET /_routes/<installation-slug>/willow.drop`: the
  selected resources, as far as the public may read them, as one
  [Willow Drop Format](https://willowprotocol.org/specs/drop-format/) file
  whose entries the host signs with the installation's own Ed25519 subspace
  key, under a communal
  [Meadowcap](https://willowprotocol.org/specs/meadowcap/) capability. Any
  Willow'25 peer that reads drops can ingest it. It needs atomic-server with
  the `plugin-routes` feature at `--plugin-routes read-write`, and the host
  pieces on atomic-server `claude/plugin-willow-host`, which are **not in the
  pin yet** (see [Host contract](#host-contract));
- the earlier **unsigned-candidate job** (#164), unchanged: it stages exact
  `encode_entry` bytes as reviewed Atomic resources and signs nothing.

It does **not** implement WGPS, Willow Confidential Sync, a listener, owned
namespaces, capability delegations or live sync ([why](#not-done-and-why)).
The [Willow drop importer](../willow-drop/README.md) is the separate import
direction, and this package's tests use it as an independent verifier.

## Implemented protocol slice

`codec.mjs` implements canonical `encode_entry` and `encode_path`, their general
encoding-relation decoders, compact U64 integers, and relative Entry
encoding/decoding. These are the actual byte layouts defined by the
[Willow encoding specification](https://willowprotocol.org/specs/encodings/index.html),
using the [Willow’25 parameter choices](https://willowprotocol.org/specs/willow25/).
Paths retain binary components, including empty and non-UTF8 components, with
the 4096 limits. Timestamps and payload lengths stay unsigned 64-bit BigInts.
The decoder rejects truncation, trailing data, impossible paths and timestamp
overflow/underflow. Canonical decoding additionally rejects nonminimal tags.

Absolute Entry/path decoding passes all **827 upstream vectors**, including
rejected encodings, and matches upstream canonical reencodings. The provenance
and exact revision are in [fixtures/README.md](fixtures/README.md). Relative
Entry tests use a hand-calculated normative example and boundary/roundtrip
checks; no independent live peer has exercised them.

An Entry contains metadata and a payload digest; decoding it does not verify
an authorisation token or establish that the bytes represent an authorised
write. These APIs intentionally make no such claim.

## The unsigned-candidate job

`exportCandidate(ctx, config, subject)` reads the selected resource through the
host's existing scoped `ctx.read`, copies only explicitly selected property
values, and serializes a deterministic JSON-AD payload with its source `@id`.
It computes the real WILLIAM3 payload digest and canonical Willow Entry signing
bytes. The path is the configured binary prefix followed by one UTF-8 component
containing the full Atomic subject; it is never inferred from a display name.

`run(ctx)` uses that adapter and the existing `ctx.query`/`ctx.read` APIs to
return real Atomic `create`/`set` intents. After the host previews, approves and
applies those intents, ordinary resources under `outputParent` hold the unsigned
candidate in `description` and `importBaseline`, with a stable `localId`. The
baseline includes source `values` for name/description and the exact `previous`
source map required by the host import compare-and-set validator. Local edits
to either field require reconciliation; an older envelope without a baseline
map is refused. No
candidate is sent to a peer. Returning an intent is not evidence it was durably
stored.

The candidate envelope is an **application-specific JSON container**, named
`atomic-willow-signing-candidate-v1`, not a Willow interchange format. It carries:

- `entryHex`: exact canonical `encode_entry` bytes, ready for a future authorised
  signer to inspect and sign;
- `payloadHex`: the exact raw payload bytes;
- `source`, `mediaType` and an explicit `status: unsigned`.

`checkCandidate` verifies byte shape, canonical encoding, payload length and
WILLIAM3 digest. It performs no signature or Meadowcap validation. The selected
JSON-AD serialization is an application payload choice; Willow permits arbitrary
payloads. No native/Rust library, key material, network or invented host API is
used in this adapter.

The build reuses `../willow-drop/william3.ts`, without changing it or copying
its source into a second implementation. It strips TypeScript and combines the
primitive, codec and adapter into a standalone `plugin.js`. An explicitly
allowlisted CI dependency causes Willow tests to run when that one shared
primitive changes; arbitrary sibling-folder dependencies remain rejected.

### Configuring the job

Install the generated `plugin.js` as a sandbox job and supply configuration:

```json
{
  "subjects": ["https://atomic.example/notes/hello"],
  "properties": [
    "https://atomicdata.dev/properties/name",
    "https://atomicdata.dev/properties/description"
  ],
  "outputParent": "https://atomic.example/willow-candidates",
  "namespace": "934e6021339e1f013ba94900edc25d8d74c0b4e573768910ae0f507d8c817318",
  "subspace": "934e6021339e1f013ba94900edc25d8d74c0b4e573768910ae0f507d8c817318",
  "pathPrefix": ["61746f6d6963"],
  "timestamp": "1"
}
```

The namespace/subspace above are the published Willow’25 example identifiers,
not a provisioned private namespace or proof of write permission. Replace them
with the intended public identifiers. `pathPrefix` is an array of hexadecimal
binary components (`61746f6d6963` is `atomic`). `timestamp` is explicitly supplied
as a logical clock value, not a fabricated conversion from Unix milliseconds.
Increase it whenever replacing an existing candidate. Unchanged exports reuse
the stored identity; lower/equal timestamps with changed bytes are refused.
Local edits to a stored candidate also require manual reconciliation.

Run the job, review the proposed resources and apply through the host. Choose
an output parent with the intended access policy: staging copies of selected
source properties into another parent can change who can read those copies,
so the ordinary host preview/write review remains essential. The host enforces
the installing actor and installation permissions on all reads and writes.
Config does not grant permission. Unselected properties are never serialized,
and an out-of-list subject is rejected before reading it.

Limits are 32 selected resources, 32 selected properties and 64 KiB payloads.
An invalid or denied record fails the whole proposal without partial intents.
This is a bounded reviewed export, not continuous sync, a source snapshot
transaction, or an atomic batch apply. Loro editor state, blob bytes and linked
resources are not recursively exported: only the selected JSON-AD atoms are.

## The drop route

Configuration (the Installation's `config`), for the route:

```json
{
  "subjects": ["https://atomic.example/notes/hello"],
  "properties": ["https://atomicdata.dev/properties/name"],
  "namespace": "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a02",
  "pathPrefix": ["61746f6d6963"]
}
```

The namespace above is invented. It must be communal (its last byte even):
anyone may write their own subspace of a communal namespace, and the
installation writes only its own. `subspace`, `outputParent` and `timestamp`
are only read by the unsigned-candidate job.

For each subject, in order, `handle(ctx)`:

1. reads it with `ctx.read` as the route's principal, which is `anonymous`:
   only what the public may read is exported;
2. reads its `lastCommit` and that commit's `createdAt` (Unix milliseconds),
   and converts that to the data model's recommended timestamp,
   microseconds of TAI since J2000, with the leap seconds up to 2017-01-01;
3. builds the payload exactly as the job does (deterministic JSON-AD of the
   selected properties plus `@id`), its WILLIAM3 digest, and the path
   `pathPrefix ‖ UTF-8(subject)`;
4. asks `ctx.willow.authorise({ key: "willow", entry, source: { subject,
commit } })` to sign the exact `encode_entry` bytes, and checks the host
   answers for those bytes.

It answers `200`, `application/octet-stream`, the drop as raw bytes
(`bodyBase64`): each entry with its communal capability, its signature and
its whole payload. Any failure (an unreadable subject, a missing commit, a
host refusal, bad config) fails the whole request with `503` and a generic
text; the reason goes to the installation's run log only, so a private
subject's URL is not echoed to the public.

Unchanged sources give byte-identical drops: the timestamp comes from the
commit, and the host answers its recorded signature for the same Entry. An
edit gives a newer entry at the same path, which a Willow store keeps over
the older one.

### Host contract

On atomic-server `claude/plugin-willow-host` (branched from candidate14
`1432e244a`), all behind the `plugin-routes` feature:

- `http.keys[].willow = { namespace, pathPrefix }` makes an `ed25519` key a
  Willow subspace key. Each value is `config:<key>` or a literal. The install
  review lists it as "Willow signing key `willow`"; it needs `read-write`.
  Such a key never signs HTTP requests, and other keys never sign entries.
- `ctx.willow.subspace(key)` answers the key's public half (the subspace id)
  and the resolved namespace and prefix.
- `ctx.willow.authorise({ key, entry, source })` signs only a canonical
  Willow'25 Entry whose namespace is the bound communal one, whose subspace is
  the key, whose path starts with the bound prefix, whose timestamp is at most
  10 minutes ahead of the host clock (on the same data-model reading), and
  whose source the route's principal can read at exactly the named commit.
  It records the authorised entry per namespace, subspace and path, answers
  the recorded signature for the same bytes, and refuses an entry older than
  the recorded one. `ctx.willow.list(key)` lists the records (at most 256).
- Route responses may carry raw bytes as `bodyBase64`.

The host signs the payload digest the plugin states; it does not recompute
WILLIAM3 over the payload. What ties an entry to Atomic data is the source
subject and commit, checked at signing time and recorded with the signature.

### Not done, and why

- **WGPS / live sync.** WGPS needs a long-lived bidirectional stream with
  session state. QuickJS starts fresh per request, and the host's sidecar and
  stream boundaries (atomic-server #1722, #1723) are declarations and
  operator config only, with no call path. willow25 0.7.9 has no WGPS
  implementation to run as that sidecar either. So a drop over HTTP is the
  transport this package can offer now.
- **Owned namespaces and delegations.** The host issues only communal
  capabilities. An owned namespace needs a namespace key and an initial
  authorisation (`0x03 ‖ user key`), and delegations need the private-area
  encodings that willow25 was still changing in September 2026.
- **Private resources.** The route is anonymous. Exporting private resources
  would need `auth: atomic` with the `caller` principal (being added on
  another host branch) and a decision about who may fetch the drop.
- **Payload persistence and prefix pruning.** The host keeps authorised
  entries, not payloads; a newer entry at a prefix path does not remove
  records below it.

## Validation

Requires Node 22.13+ for the build-time TypeScript stripping API:

```sh
node integrations/willow/build.mjs
node integrations/tooling/run-lane.mjs willow --tier node
node integrations/tooling/run-lane.mjs willow --tier e2e   # needs claude/plugin-willow-host, see below
cargo run --release --manifest-path integrations/willow/fixtures/verify-drop/Cargo.toml -- integrations/willow/fixtures/exported.drop
```

Verified by the node tier (35 tests):

- the codec against the 827 upstream vectors, and the job as before;
- drops we encode are decoded by the willow-drop importer's committed
  bundle, which checks every Ed25519 signature (from invented node:crypto
  keys), capability and WILLIAM3 digest: namespace and subspace switches,
  shared path prefixes, binary components, a three-chunk payload, a
  full-width U64 timestamp and an empty payload; a changed signature,
  payload or path byte is refused;
- `fixtures/exported.drop` is reproduced byte for byte;
- the route against a fake host that makes the host's checks: selected
  properties only, deterministic bytes, newer entries after an edit, and
  all-or-nothing refusals without subjects in the response;
- timestamps: J2000, a leap second, and the fixed 86,432.184 s between the
  data model's reading and willow25 0.7.9's hifitime reading
  ([worm-blossom/willow_rs#62](https://codeberg.org/worm-blossom/willow_rs/issues/62)).

Verified by hand with willow25 itself: `fixtures/verify-drop` (willow25
0.7.9's `DropDecoder`, which verifies each authorisation token) accepted both
entries of `fixtures/exported.drop` on 2026-09-29, and reported the first
timestamp as Unix milliseconds 1790294432184 where the data model reads 1790208000000. CI does not run it.

Verified by the host's Rust tests on `claude/plugin-willow-host`: all
accepted `encode_entry` vectors of at most 512 bytes (74) round-trip and all
such refused ones (55) are refused; each refusal of `ctx.willow.authorise`;
`ed25519-dalek`'s `verify_strict` accepts the host's signature; records are
erased with the keys; `bodyBase64` bodies and their refusals.

E2E_EVIDENCE

Declared, not verified: interoperability with any Willow implementation
other than willow25 0.7.9 and our own importer; fuel use per signed entry;
behaviour with more than a few subjects (the limit is 32).
