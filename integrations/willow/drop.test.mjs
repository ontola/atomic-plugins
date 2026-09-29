// Drop encoding, checked by an independent decoder: the willow-drop
// importer's bundle (../willow-drop/plugin.js), whose decoder was checked
// against drops willow25 0.7.9 wrote, and which verifies every Ed25519
// signature, capability and WILLIAM3 digest. Signatures here come from
// node:crypto with invented keys, never from the plugin under test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8');
const { encodeDrop, encodeEntry, willowTime, base64, william3, hex, unhex, utf8 } =
  await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
const importer = await import('../willow-drop/plugin.js');
const expected = JSON.parse(
  readFileSync(
    new URL('../willow-drop/fixtures/expected.json', import.meta.url),
    'utf8',
  ),
);

/** An invented Ed25519 key from a 32-byte seed. */
function testKey(seedByte) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, seedByte),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });

  return {
    public: new Uint8Array(spki.subarray(spki.length - 32)),
    sign: bytes => new Uint8Array(sign(null, bytes, privateKey)),
  };
}

/** A communal namespace id (last byte even) and an owned one. */
const COMMUNAL = unhex('20'.repeat(31) + '02');
const OWNED = unhex('20'.repeat(31) + '03');

function item(key, namespace, path, timestamp, text) {
  const payload = typeof text === 'string' ? utf8(text) : text;
  const entry = {
    namespace,
    subspace: key.public,
    path,
    timestamp,
    payloadLength: BigInt(payload.length),
    payloadDigest: william3(payload),
  };

  return { entry, signature: key.sign(encodeEntry(entry)), payload };
}

const properties = Object.fromEntries(
  importer.manifest.destination.schema.properties.map(p => [
    p.shortname,
    `https://example.com/${p.shortname}`,
  ]),
);

/** The willow-drop importer's proposal for `drop`, uploaded base64-encoded. */
function importRows(drop) {
  const verdict = importer.run({
    upload: { name: 'export.drop.b64', text: base64(drop) },
    config: {
      table: 'https://example.com/table',
      rowClass: 'https://example.com/willow-entry',
      properties,
    },
    query: () => [],
    read: () => ({}),
  });

  return verdict.intents.flatMap(intent =>
    intent.op === 'create' ? [intent.set] : [],
  );
}

const value = (row, name) => row[properties[name]];

test('an independent decoder accepts our drop: namespaces, subspaces, shared paths, sizes', () => {
  const alice = testKey(1),
    bob = testKey(2);
  const atomic = utf8('atomic');
  const items = [
    item(alice, COMMUNAL, [atomic, utf8('https://a.example/notes/1')], 5n, 'one'),
    // Shares two components with the previous path; another subspace.
    item(bob, COMMUNAL, [atomic, utf8('https://a.example/notes/1'), new Uint8Array([0, 255])], 300n, 'two'),
    // A three-chunk payload (WILLIAM3 chunks are 1024 bytes) and a timestamp
    // that needs all eight bytes.
    item(alice, COMMUNAL, [atomic, new Uint8Array()], 2n ** 64n - 1n, new Uint8Array(2500).fill(7)),
    // Back to a namespace and subspace used before, and an empty payload.
    item(bob, unhex('40'.repeat(32)), [], 70_000n, ''),
  ];
  const drop = encodeDrop(items);
  const rows = importRows(drop);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map(r => value(r, 'willow-timestamp')),
    ['5', '300', '18446744073709551615', '70000'],
  );
  assert.deepEqual(
    rows.map(r => value(r, 'willow-subspace')),
    [alice, bob, alice, bob].map(k => hex(k.public)),
  );
  assert.equal(value(rows[0], 'willow-path'), '/atomic/https%3a%2f%2fa.example%2fnotes%2f1');
  assert.equal(value(rows[1], 'willow-payload'), 'two');
  assert.equal(value(rows[2], 'willow-payload-length'), '2500');
});

test('the importer refuses our drop once a signature, payload or path byte changes', () => {
  const key = testKey(3);
  const drop = encodeDrop([
    item(key, COMMUNAL, [utf8('atomic'), utf8('x')], 1n, 'payload'),
  ]);
  assert.equal(importRows(drop).length, 1);

  // Header (1), namespace and subspace (64), relative path (1 + 1 + 1 + 6 +
  // 1), timestamp (1), payload length (1), digest (32), token header (1),
  // signature (64), payload (7), end (1).
  assert.equal(drop.length, 1 + 64 + 10 + 1 + 1 + 32 + 1 + 64 + 7 + 1);
  for (const [at, why] of [
    [drop.length - 2, /digest/],
    [drop.length - 9, /signature/],
    [70, /signature/],
  ]) {
    const bad = drop.slice();
    bad[at] ^= 1;
    assert.throws(() => importRows(bad), why);
  }
});

test('encodeDrop refuses owned namespaces, wrong payloads and short signatures', () => {
  const key = testKey(4);
  const good = item(key, COMMUNAL, [], 1n, 'a');
  assert.throws(() => encodeDrop([item(key, OWNED, [], 1n, 'a')]), /communal/);
  assert.throws(() => encodeDrop([{ ...good, payload: utf8('b') }]), /payload/);
  assert.throws(
    () => encodeDrop([{ ...good, signature: good.signature.slice(1) }]),
    /64 bytes/,
  );
  assert.deepEqual(encodeDrop([]), Uint8Array.of(0));
});

test('the committed exported.drop is this encoder’s output for its invented inputs', async () => {
  // fixtures/verify-drop (willow25 0.7.9's DropDecoder) accepted these exact
  // bytes; see fixtures/README.md. Ed25519 signatures are deterministic, so
  // the bytes are reproducible.
  const key = testKey(9);
  const drop = encodeDrop([
    item(key, COMMUNAL, [utf8('atomic'), utf8('https://atomic.example/notes/hello')], willowTime(1790208000000n), '{"@id":"https://atomic.example/notes/hello","https://atomicdata.dev/properties/name":"Hello"}'),
    item(key, COMMUNAL, [utf8('atomic'), utf8('https://atomic.example/notes/second')], willowTime(1790208060000n), '{"@id":"https://atomic.example/notes/second"}'),
  ]);
  const fixture = new URL('./fixtures/exported.drop', import.meta.url);
  // WILLOW_WRITE_FIXTURE=1 rewrites it; then run fixtures/verify-drop again.
  if (process.env.WILLOW_WRITE_FIXTURE) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(fixture, drop);
  }
  const committed = readFileSync(fixture);
  assert.equal(hex(drop), hex(new Uint8Array(committed)));
  assert.equal(importRows(drop).length, 2);
});

test('timestamps follow the data model, 86,432.184 s from willow25 0.7.9’s hifitime reading', () => {
  // J2000 is 2000-01-01T11:58:55.816Z.
  assert.equal(willowTime(946727935816n), 0n);
  assert.throws(() => willowTime(946727935815n), /J2000/);
  // The first entry of the willow25-written communal.drop: its timestamp is
  // 2026-09-24T00:00:00Z on the data model's reading, and willow25 reports
  // it 86,432,184 ms later.
  const [first] = expected.drops.communal;
  assert.equal(willowTime(1790208000000n), BigInt(first.timestamp));
  assert.equal(
    willowTime(BigInt(first.willow25UnixMillis)) - BigInt(first.timestamp),
    86_432_184_000n,
  );
  // A leap second: 2016-12-31T23:59:59Z to 2017-01-01T00:00:00Z is 2 s of TAI.
  assert.equal(willowTime(1483228800000n) - willowTime(1483228799000n), 2_000_000n);
});

test('base64 agrees with Node for every length remainder', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 256]) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) & 255);
    assert.equal(base64(bytes), Buffer.from(bytes).toString('base64'));
  }
});
