// The drop route, `handle(ctx)`, against a fake host whose `ctx.willow`
// makes the same checks atomic-server's `plugins/willow.rs` makes (bound
// namespace and prefix, the key's subspace, the source still at the commit
// the plugin read) and signs with an invented node:crypto key. The drop it
// answers is decoded by the willow-drop importer bundle, which verifies every
// signature and digest. Unit evidence only: the real host and QuickJS run in
// e2e/willow.spec.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8');
const { handle, manifest, P, decodeEntry, hex, unhex, utf8, willowTime } =
  await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
const importer = await import('../willow-drop/plugin.js');

const NAMESPACE = '20'.repeat(31) + '02';
const ATOMIC = '61746f6d6963';
const s1 = 'https://atomic.example/notes/hello',
  s2 = 'https://atomic.example/notes/second';
const name = 'https://atomicdata.dev/properties/name';
const secret = 'https://atomic.example/secret';

function key(seed) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.alloc(32, seed),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  });

  return {
    public: hex(new Uint8Array(spki.subarray(spki.length - 32))),
    sign: bytes => hex(new Uint8Array(sign(null, bytes, privateKey))),
  };
}

function fixture() {
  const k = key(5);
  const resources = new Map([
    [
      s1,
      {
        [name]: 'Hello',
        [secret]: 'not selected',
        [P.lastCommit]: 'https://atomic.example/commits/a',
      },
    ],
    [
      s2,
      { [name]: 'Second', [P.lastCommit]: 'https://atomic.example/commits/b' },
    ],
    ['https://atomic.example/commits/a', { [P.createdAt]: 1790208000000 }],
    ['https://atomic.example/commits/b', { [P.createdAt]: 1790208060000 }],
  ]);
  const authorised = [];
  const ctx = {
    config: {
      subjects: [s1, s2],
      properties: [name],
      namespace: NAMESPACE,
      pathPrefix: [ATOMIC],
    },
    read: id => {
      if (!resources.has(id)) throw Error('Denied');

      return resources.get(id);
    },
    willow: {
      subspace: k2 => {
        assert.equal(k2, 'willow');

        return {
          subspace: k.public,
          namespace: NAMESPACE,
          communal: true,
          pathPrefix: [ATOMIC],
        };
      },
      authorise: request => {
        const entry = decodeEntry(unhex(request.entry), { canonical: true });
        assert.equal(request.key, 'willow');
        assert.equal(hex(entry.namespace), NAMESPACE);
        assert.equal(hex(entry.subspace), k.public);
        assert.equal(hex(entry.path[0]), ATOMIC);
        if (
          resources.get(request.source.subject)?.[P.lastCommit] !==
          request.source.commit
        )
          throw Error('the source changed since it was read');
        authorised.push(request);

        return {
          entry: request.entry,
          signature: k.sign(unhex(request.entry)),
          status: 'authorised',
        };
      },
    },
  };

  return { ctx, resources, authorised, key: k };
}

const properties = Object.fromEntries(
  importer.manifest.destination.schema.properties.map(p => [
    p.shortname,
    `https://example.com/${p.shortname}`,
  ]),
);

function importRows(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/octet-stream');
  const verdict = importer.run({
    upload: { name: 'willow.drop.b64', text: response.bodyBase64 },
    config: {
      table: 'https://example.com/t',
      rowClass: 'https://example.com/c',
      properties,
    },
    query: () => [],
    read: () => ({}),
  });

  return verdict.intents.map(i => i.set);
}

const value = (row, n) => row[properties[n]];

test('the manifest asks for one anonymous GET route and one bound Willow key', () => {
  assert.equal(manifest.schemaVersion, 3);
  assert.deepEqual(manifest.http.routes, [
    {
      id: 'drop',
      path: '/willow.drop',
      methods: ['GET'],
      principal: 'anonymous',
      auth: 'none',
    },
  ]);
  assert.deepEqual(
    manifest.http.keys.map(k => [k.name, k.alg, k.willow]),
    [
      [
        'willow',
        'ed25519',
        { namespace: 'config:namespace', pathPrefix: 'config:pathPrefix' },
      ],
    ],
  );
  assert.equal(manifest.http.mount, 'drive-prefix');
  assert.deepEqual(manifest.operations, []);
  assert.deepEqual(manifest.secrets, []);
});

test('the route answers a drop of host-authorised entries of the selected properties', () => {
  const f = fixture();
  const { response, problems } = handle(f.ctx);
  assert.deepEqual(problems, []);
  const rows = importRows(response);
  assert.equal(rows.length, 2);
  assert.equal(value(rows[0], 'willow-subspace'), f.key.public);
  assert.equal(value(rows[0], 'willow-namespace'), NAMESPACE);
  assert.deepEqual(JSON.parse(value(rows[0], 'willow-payload')), {
    '@id': s1,
    [name]: 'Hello',
  });
  assert.doesNotMatch(value(rows[0], 'willow-payload'), /not selected/);
  // The commit time, read as the data model recommends.
  assert.equal(
    value(rows[0], 'willow-timestamp'),
    willowTime(1790208000000n).toString(),
  );
  assert.equal(value(rows[0], 'willow-time'), '2026-09-24T00:00:00.000000Z');
  assert.deepEqual(
    f.authorised.map(a => a.source),
    [
      { subject: s1, commit: 'https://atomic.example/commits/a' },
      { subject: s2, commit: 'https://atomic.example/commits/b' },
    ],
  );
});

test('unchanged sources give the same bytes; an edit gives a newer entry', () => {
  const f = fixture();
  const first = handle(f.ctx).response.bodyBase64;
  assert.equal(handle(f.ctx).response.bodyBase64, first);
  f.resources.get(s1)[name] = 'Edited';
  f.resources.get(s1)[P.lastCommit] = 'https://atomic.example/commits/c';
  f.resources.set('https://atomic.example/commits/c', {
    [P.createdAt]: 1790208120000,
  });
  const rows = importRows(handle(f.ctx).response);
  assert.equal(
    value(rows[0], 'willow-timestamp'),
    willowTime(1790208120000n).toString(),
  );
  assert.match(value(rows[0], 'willow-payload'), /Edited/);
});

test('an unreadable, uncommitted or host-refused source fails the whole drop with a logged problem', () => {
  for (const [breakIt, why] of [
    [f => f.resources.delete(s2), /Denied/],
    [f => delete f.resources.get(s2)[P.lastCommit], /no last commit/],
    [f => f.resources.delete('https://atomic.example/commits/b'), /Denied/],
    [
      f => {
        const authorise = f.ctx.willow.authorise;

        f.ctx.willow.authorise = r => {
          f.resources.get(s1)[P.lastCommit] =
            'https://atomic.example/commits/moved';

          return authorise(r);
        };
      },
      /source changed/,
    ],
    [f => (f.ctx.config.namespace = 'nope'), /64 hex/],
    [f => (f.ctx.config.subjects = []), /subjects/],
  ]) {
    const f = fixture();
    breakIt(f);
    const { response, problems } = handle(f.ctx);
    assert.equal(response.status, 503);
    assert.equal(response.bodyBase64, undefined);
    assert.doesNotMatch(response.body, /atomic\.example/);
    assert.match(problems[0].message, why);
  }
});

test('the host signing other bytes than asked is caught', () => {
  const f = fixture();
  const authorise = f.ctx.willow.authorise;
  f.ctx.willow.authorise = r => ({
    ...authorise(r),
    entry: r.entry.slice(0, -2) + '00',
  });
  assert.match(handle(f.ctx).problems[0].message, /other bytes/);
});

test('the path is the configured prefix and the full subject, byte for byte', () => {
  const f = fixture();
  const rows = importRows(handle(f.ctx).response);
  assert.equal(
    value(rows[1], 'willow-path'),
    '/atomic/https%3a%2f%2fatomic.example%2fnotes%2fsecond',
  );
  assert.equal(
    value(rows[1], 'willow-payload-length'),
    String(utf8(JSON.stringify({ '@id': s2, [name]: 'Second' })).length),
  );
});
