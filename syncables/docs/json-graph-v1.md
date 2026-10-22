# Archived JSON graph encoding, version 1

This is the persisted response-index format, separate from Git's object format
and from raw response hashes. Original response text remains the replay source.
The executable indexes each object and array, including nested containers, as
one node. Scalar roots have a scalar wrapper. Parents inline scalar values and
refer to nested containers by their node hashes.

Canonical node bytes are UTF-8 of compact ECMAScript `JSON.stringify` output:

```text
["syncables-json-node",1,"object",[[key,value],...]]
["syncables-json-node",1,"array",[value,...]]
["syncables-json-node",1,"scalar",value]
```

A value is exactly one of `["null"]`, `["boolean",true|false]`,
`["string",text]`, `["number",originalJSONNumberToken]` or `["ref",hash]`.
A hash is SHA-256 of the canonical node bytes, represented as 64 lowercase hex
characters without a prefix. The domain/version tuple is part of those bytes.
Object entries sort by decoded UTF-16 key order; array order/length is retained.
Strings use ECMAScript escaping, including escaping lone surrogates, without
Unicode normalization. Number tokens are never converted through JS Number;
`1`, `1.0` and `1e0` deliberately produce different node hashes. Provider fields
named `$ref` or `__proto__` remain ordinary keys.

The immutable [test vectors](../__tests__/fixtures/json-graph-v1.json) contain
inputs, complete canonical nodes and expected hashes. They were computed with
an independent SHA-256 implementation and are checked directly by the tests.
Examples:

Input: `{}`

```json
["syncables-json-node",1,"object",[]]
```

SHA-256: `498d308ed3f13b1f6a8bb65a4f78d1c227873b8df7e9cf196e96bde25770f549`.

Input: `[]`

```json
["syncables-json-node",1,"array",[]]
```

SHA-256: `6d026c27630ed6eff3a69162ec64ae0526d1aa61913eda750a58773ad3c8d903`.

Input: `9007199254740993`

```json
["syncables-json-node",1,"scalar",["number","9007199254740993"]]
```

SHA-256: `d7086203835a90996c9bcef7ac00d6a7304da863aa267c0431efac52bb48a5cb`.

The vectors also freeze lexical numbers, UTF-16 ordering across BMP and
supplementary characters, and nested object sharing.

PostgreSQL keys nodes by owner and hash; the hash already includes the format
version. Response roots additionally declare `encoding_version=1`. Nodes can
share across one owner's connections but never authorize cross-owner access.
Compression uses its own codec version and verifies decompressed bytes/hash.

Malformed JSON, duplicate decoded keys and input beyond graph limits retain
raw text with an explicit indexing error; they never acquire a guessed graph.
Defaults are 8 MiB input/expanded output, depth 128 and 100,000 value visits.
Loading checks hashes, encoding version and expansion bounds. No graph GC or
backfill of older unindexed responses runs automatically. An incompatible
encoding needs a new version/domain and explicit reader/migration support.
