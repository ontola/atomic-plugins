# NextGraph RDF interchange

Status: **RDF snapshot exchange between Atomic resources and NextGraph
documents, through an operator-run NextGraph sidecar**. The plugin is a
QuickJS sandbox job. It never holds a NextGraph key and never opens a broker
connection itself. It is not a CRDT synchronizer: it moves bounded snapshots
of triples, in both directions, with a person approving every write into
NextGraph.

Two ways in:

- **Pasted** (`mode: "import"`): works on any host. A person pastes a SPARQL
  Results JSON answer from their own NextGraph client.
- **Live** (`mode: "pull"`, plus a pushed export): needs atomic-server with
  `atomic-sidecar:` operations (branch `claude/plugin-nextgraph-host`, not yet
  in the pinned `.atomic-server-ref`), built with `plugin-routes`, started at
  `--plugin-routes read-write` with `--plugin-sidecars nextgraph=http://127.0.0.1:<port>`,
  and the sidecar in [`sidecar/`](sidecar/) running on that port.

What has been **verified** and what is only **declared** is listed under
[Evidence](#evidence).

## How the pieces fit

```
Atomic drive ── /plugin-run ──► QuickJS: plugin.mjs
                                   │ ctx.http({operation:"query",
                                   │   url:"atomic-sidecar:/nextgraph/v1/query"})
                                   ▼
atomic-server host ── only declared operations, only the configured loopback URL,
                      adds x-atomic-installation / x-atomic-drive ──►
                                   ▼
ng-atomic-sidecar (operator) ── scopes.json: installation × document × read|read-write
                                   │
                      NextGraph wallet + local verifier (nextgraph-rs), saved to disk
```

Writes never happen from inside a run. `export` produces the INSERT DATA text
as an Atomic resource; `pushIntent()` turns it into the declared `update`
operation, which a person approves through atomic-server's
`/plugin-external-apply`. The host journals that request and the sidecar's
answer; a retried approval returns the journaled receipt instead of writing
again.

## Modes

| `mode` | Reads | Proposes |
| --- | --- | --- |
| `import` | `result`: pasted SPARQL Results JSON | a PlainText resource holding it |
| `pull` | the `document` NURI, through the sidecar's `query` operation | a PlainText resource holding the answer |
| `export` | `sourceSubject`: a stored snapshot, with `ctx.read` | a PlainText resource holding `INSERT DATA { … }` |

Config (declared in the manifest): `mode`, `parent`, `id`, `name` are always
required; `result` for import, `document` for pull, `sourceSubject` for
export. `pushIntent({ document, id, update })` (exported by `plugin.mjs`)
builds the external intent `{ id: "push-<id>", operation: "update", method:
"POST", url: "atomic-sidecar:/nextgraph/v1/update", body }`, whose sidecar
idempotency key is `atomic-export-<id>`.

## Snapshot format

The parser follows [SPARQL 1.1 Results JSON](https://www.w3.org/TR/sparql11-results-json/),
which the [NextGraph App Protocol](https://docs.nextgraph.org/en/specs/protocol-app/)
uses for ReadQuery SELECT answers, for a deliberately bounded triple
projection: every row binds exactly `s`, `p`, `o`; subjects are IRIs or blank
nodes, predicates IRIs; literals keep their exact lexical form, datatype IRI
and language tag. Numeric values are never converted to JavaScript numbers.
ASK, RDF-star and other projections are refused. The sidecar runs exactly
`SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 257`; 257 rows (the sentinel)
refuse the snapshot instead of truncating it.

Snapshots are stored as native `https://atomicdata.dev/classes/PlainText`
resources: the exact JSON bytes in `description`, plus `name`, `mimetype`
and `localId` (`nextgraph:<parent>:<id>`). RDF predicates are **not** mapped
onto Atomic properties, and the original subjects are not turned into Atomic
resources. Rerunning with the same id and identical content proposes nothing;
different content under the same id is refused.

## Live sidecar

[`sidecar/`](sidecar/) is `ng-atomic-sidecar`, a Rust binary linking the
NextGraph Rust SDK at nextgraph-rs commit
`d507afa3e97197b7ded5a5e241c10dd0f12dd6d4`. Build it with Docker (the bundled
RocksDB does not build with a local cargo on macOS; see the Dockerfile):

```sh
docker build -t ng-atomic-sidecar integrations/nextgraph/sidecar
mkdir -p /srv/ng-sidecar
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/data -v /srv/ng-sidecar:/data \
  ng-atomic-sidecar init --base /data --documents 1
# its last stdout line is {"documents":["did:ng:o:…"]} (NextGraph logs INFO
# lines before it); the wallet mnemonic and PIN go to
# /srv/ng-sidecar/credentials.json (mode 0600), never to stdout
docker run -d --user "$(id -u):$(id -g)" -e HOME=/data -v /srv/ng-sidecar:/data \
  -p 127.0.0.1:14480:14480 ng-atomic-sidecar serve --base /data --listen 0.0.0.0:14480
atomic-server --plugin-routes read-write --plugin-sidecars nextgraph=http://127.0.0.1:14480
```

Grants live in `/srv/ng-sidecar/scopes.json`, written by the operator and
re-read on every request (a revocation applies to the next call):

```json
{ "grants": [
  { "installation": "<Atomic installation or plugin subject>",
    "document": "did:ng:o:…", "access": "read" }
] }
```

Operations (loopback HTTP; the host is the only intended client):

- `GET /v1/health`
- `POST /v1/query` `{document}` → SPARQL Results JSON; needs `read`.
- `POST /v1/update` `{document, key, update}` → `{ack: {key, document,
  commits, appliedAt}, replayed}`; needs `read-write`. Only `INSERT DATA` into
  the document's default graph (parsed with NextGraph's own SPARQL parser),
  at most 131,072 bytes. The key is reserved on disk (fsync, rename) before
  the NextGraph write and the acknowledgement stored before it is returned.
  The same key and body replay the stored acknowledgement; the same key with
  another body is a 409; a key whose write started but was never acknowledged
  is a 409 `outcome-uncertain`, never a second write.

Nothing is granted by default. The installation comes only from the
`x-atomic-installation` header, which the host sets and a plugin cannot.

### Data exposure (E2EE)

The sidecar holds the operator's NextGraph wallet and runs the verifier on
the operator's machine. **For the documents that wallet can open, the
operator's host is an endpoint of NextGraph's end-to-end encryption**, as in
NextGraph's own headless mode: decrypted triples exist in the sidecar
process, in its on-disk verifier store under `--base`, in Atomic Server (the
snapshot resources, readable by whoever may read their parent), and in the
host's external-operation journal (the pushed update text). Brokers, if the
wallet is connected to one, still only see encrypted commits. Use a wallet
created for this purpose, and grant it only documents whose contents may be
stored in the drive.

Host-to-sidecar trust is loopback only: any local process that can reach the
sidecar port can claim an installation. There is no shared secret or request
signature between host and sidecar yet.

### Broker

`init --broker-peer <PEER_ID>` points the wallet at a local `ngd`, and
`serve --connect` connects to it. **Not verified**: no test runs `ngd`, so
sync between NextGraph peers, and registration of the wallet with a broker,
are declared only. Without a broker the documents are real NextGraph
repositories, but live in this wallet's local store alone.

## Evidence

```sh
node integrations/tooling/run-lane.mjs nextgraph --tier node   # plugin module
docker build integrations/nextgraph/sidecar                    # also runs the sidecar's cargo tests
node integrations/tooling/run-lane.mjs nextgraph --tier e2e    # real host + real sidecar
```

- Node tests (`plugin.test.mjs`): parsing, exact term serialization, reviewed
  import/pull/export, the declared operations `pull` and `pushIntent` use,
  refused and oversized sidecar answers, bounds, duplicates, a reproducible
  bundle.
- Sidecar unit tests (`sidecar/src/service.rs`, fake engine): default deny,
  read versus read-write grants, revocation on the next request, replayed
  acknowledgements, acknowledgements across a restart, uncertain outcomes not
  repeated, malformed requests refused before any write.
- Host tests (atomic-server `claude/plugin-nextgraph-host`,
  `plugins::host_core`, shared manifest fixtures in Rust and TypeScript): only
  declared `atomic-sidecar:` operations reach only the configured sidecar,
  with the host's identity headers and none of the plugin's.
- e2e (`e2e/nextgraph.spec.ts`): see the spec header for exactly what it
  checks. It is skipped, saying why, on a host without `atomic-sidecar:`
  operations, which includes the current pin.

`fixtures/select.json` is hand-authored, not a NextGraph capture. No broker,
no other NextGraph client and no NextGraph app have been used against these
documents.
