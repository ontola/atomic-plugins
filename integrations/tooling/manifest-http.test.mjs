/**
 * manifest-http.mjs against atomic-server's shared manifest fixtures
 * (fixtures/plugin-manifest/, copied from the commit in source.json), the
 * same cases its Rust and TypeScript implementations run. The host validates
 * the whole manifest; this port only owns the `http` block, so an accepted
 * case compares the canonical `http` block, the gate and the derived
 * `requires`, and a rejected case the error.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkHostFeatures,
  checkManifest,
  derivedRequires,
  describeGating,
  hostFeatureMessage,
  httpGate,
} from './manifest-http.mjs';

const dir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/plugin-manifest',
);
const fixture = name => JSON.parse(readFileSync(resolve(dir, name), 'utf8'));

for (const entry of fixture('http-index.json'))
  test(`http-index: ${entry.name}`, () => {
    const raw = fixture(entry.file);

    if (entry.error !== undefined) {
      assert.throws(
        () => checkManifest(raw),
        error => error.message.includes(entry.error),
      );

      return;
    }

    const manifest = checkManifest(raw);
    if (entry.serialized !== undefined)
      assert.deepEqual(manifest.http, entry.serialized.http);
    assert.deepEqual(httpGate(manifest.http), entry.gate);
    assert.deepEqual(derivedRequires(manifest), entry.requires);
    // The canonical form is a fixed point.
    assert.deepEqual(checkManifest(manifest), manifest);
  });

for (const entry of fixture('http-refusals.json'))
  test(`http-refusals: ${entry.name}`, () => {
    const manifest = checkManifest(fixture(entry.file));
    const refusal = checkHostFeatures(manifest.http, entry.node);

    if (entry.refusal === null) {
      assert.equal(refusal, undefined);

      return;
    }

    assert.deepEqual(refusal, entry.refusal);
    assert.equal(hostFeatureMessage(refusal), entry.message);
  });

test('every fixture file is one source.json accounts for', () => {
  const files = readdirSync(dir).filter(f => f !== 'source.json');
  const named = new Set(
    [...fixture('http-index.json'), ...fixture('http-refusals.json')].map(
      e => e.file,
    ),
  );

  for (const file of files)
    assert.ok(
      ['http-index.json', 'http-refusals.json'].includes(file) ||
        named.has(file),
      `${file} is not used by any case; drop it or add it to the index`,
    );
  for (const file of named) assert.ok(files.includes(file), `missing ${file}`);
});

test('describeGating: gated only when a surface needs the feature', () => {
  assert.deepEqual(describeGating(fixture('v3-no-http.json')), {
    schemaVersion: 3,
    gate: { needed: 'none', listeners: [], sidecars: [], surfaces: [] },
    requires: ['wasm-sandbox'],
    gated: false,
  });
  const readOnly = describeGating(fixture('v3-read-only-route.json'));
  assert.equal(readOnly.gated, true);
  assert.equal(readOnly.gate.needed, 'read-only');
  assert.ok(readOnly.requires.includes('plugin-routes:read-only'));
  const listener = describeGating(fixture('v3-listener.json'));
  assert.equal(listener.gated, true);
  assert.ok(listener.requires.includes('operator-listener:willow-wgps'));
});

test('checkManifest refuses an unknown schemaVersion', () => {
  assert.throws(
    () => checkManifest({ schemaVersion: 4 }),
    /unsupported manifest schemaVersion/,
  );
});

// Provisional, until atomic-server candidate16's shared fixtures for the
// route field `fetches` (ctx.blobs.fetch) are copied into
// fixtures/plugin-manifest/: then these cases move there.
test('fetches: declared GET read operations, read-write, wildcard hosts allowed', () => {
  const manifest = fetches => ({
    schemaVersion: 3,
    operations: [
      { id: 'dl', method: 'GET', url: 'https://*/{*rest}', effect: 'read' },
      { id: 'post', method: 'POST', url: 'https://*/{*rest}', effect: 'write' },
    ],
    http: {
      routes: [
        {
          id: 'r',
          path: '/r',
          methods: ['POST'],
          body: 'json',
          enqueues: ['post'],
          ...(fetches ? { fetches } : {}),
        },
      ],
    },
  });
  const ok = checkManifest(manifest(['dl']));
  assert.deepEqual(ok.http.routes[0].fetches, ['dl']);
  assert.deepEqual(
    httpGate(ok.http).surfaces.map(s => [s.surface, s.needs]),
    [
      ['route `POST /r`', 'read-write'],
      ['delivery `post`', 'read-write'],
      ['fetch `dl`', 'read-write'],
    ],
  );
  assert.throws(
    () => checkManifest(manifest(['post'])),
    /fetches must name declared GET read operations/,
  );
  assert.throws(
    () => checkManifest(manifest()),
    /wildcard-host operations must be listed in a route's enqueues/,
  );
});
