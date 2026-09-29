import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  handle,
  run,
  manifest,
  normalizeHandle,
  base58Decode,
  configuration,
  didDocument,
  validatePds,
  validateSigningKey,
  validateDid,
} from './plugin.mjs';
const did = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
const context = () => ({
  trigger: { route: 'atproto-did' },
  config: { handle: 'user.example.com', did },
  read: () => assert.fail('No store reads'),
  query: () => assert.fail('No queries'),
  http: () => assert.fail('No network'),
});
const request = (method = 'GET') => ({
  method,
  path: '/.well-known/atproto-did',
  wellKnown: 'atproto-did',
  headers: {},
  query: {},
});
test('host v3 drive-host exclusive claims connect to declared anonymous routes', () => {
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.http.mount, 'drive-host');
  assert.deepEqual(manifest.http.wellKnown, [
    { name: 'atproto-did', kind: 'exclusive', route: 'atproto-did' },
    { name: 'did.json', kind: 'exclusive', route: 'did-json' },
  ]);
  assert.deepEqual(
    manifest.http.routes.map(r => [r.id, r.path]),
    [
      ['atproto-did', '/atproto-did'],
      ['did-json', '/did.json'],
    ],
  );

  for (const route of manifest.http.routes) {
    assert.deepEqual(route.methods, ['GET', 'HEAD']);
    assert.equal(route.principal, 'anonymous');
    assert.equal(route.auth, 'none');
  }
});
test('HTTPS well-known method returns DID bytes without decoration', () => {
  const result = handle(context(), request());
  assert.equal(result.status, 200);
  assert.equal(result.body, did);
  assert.equal(result.headers['content-type'], 'text/plain');
  assert.equal(result.headers['cache-control'], 'no-store');
});
test('HEAD and direct declared route work with host request shape', () => {
  const get = handle(context(), request());
  const head = handle(context(), request('HEAD'));
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.deepEqual(head.headers, get.headers);
  assert.equal(
    handle(context(), { method: 'GET', path: '/atproto-did', wellKnown: null })
      .body,
    did,
  );
});
test('dispatch mismatch and arbitrary paths do not reveal DID', () => {
  for (const patch of [
    { path: '/other' },
    { wellKnown: 'webfinger' },
    { wellKnown: null },
    { path: '/atproto-did' },
  ]) {
    assert.equal(handle(context(), { ...request(), ...patch }).status, 404);
  }

  assert.equal(
    handle({ ...context(), trigger: { route: 'other' } }, request()).status,
    404,
  );
});
test('all unsupported methods refuse without effects', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'get'])
    assert.equal(handle(context(), request(method)).status, 405);
});
test('invalid/missing configuration returns generic unavailable and empty HEAD', () => {
  for (const config of [
    undefined,
    {},
    { handle: 'user.example.com', did: 'private\r\nsecret' },
    { handle: 'bad handle', did },
  ]) {
    const c = { ...context(), config };
    assert.equal(handle(c, request()).status, 503);
    assert.equal(handle(c, request('HEAD')).body, '');
    assert.throws(() => run(c));
  }
});
test('header and query values cannot select or replace identity', () => {
  const req = {
    ...request(),
    headers: {
      host: 'evil.com',
      origin: 'https://evil.com',
      'x-forwarded-host': 'evil.com',
    },
    query: { handle: 'evil.com', did: 'did:web:evil.com' },
  };
  // Without request.host (hosts before claude/plugin-atproto-host), the
  // registry alone binds the installation to its drive's hostnames.
  assert.equal(handle(context(), req).body, did);
  // With it, a forwarded or Host header naming the handle changes nothing:
  // only the dispatched host counts.
  assert.equal(
    handle(context(), {
      ...req,
      host: 'other.example.com',
      headers: { ...req.headers, 'x-forwarded-host': 'user.example.com' },
    }).status,
    404,
  );
});
test('with the dispatched host, only the handle hostname answers', () => {
  assert.equal(
    handle(context(), { ...request(), host: 'user.example.com' }).body,
    did,
  );

  for (const host of [
    'other.example.com',
    'USER.example.com',
    'user.example.com.evil.com',
    '',
  ]) {
    const result = handle(context(), { ...request(), host });
    assert.equal(result.status, 404, host);
    assert.equal(result.body, '', host);
  }
});
test('production handles accept case folding and published syntax examples', () => {
  for (const value of [
    'jay.bsky.social',
    '8.cn',
    'XX.LCS.MIT.EDU',
    'a.co',
    'xn--notarealidn.com',
  ])
    assert.equal(normalizeHandle(value), value.toLowerCase());
});
test('reject whitespace, injection, invalid DNS and reserved production suffixes', () => {
  for (const value of [
    'user.example.com\n',
    'a.com\r\nX: y',
    '💩.com',
    'a..com',
    '-a.com',
    'a-.com',
    'a.8',
    'org',
    'a.com.',
    'a.onion',
    'a.local',
    'a.test',
    'a.example',
    'a.invalid',
    'a'.repeat(64) + '.com',
    'a.'.repeat(126) + 'co',
  ])
    assert.throws(() => normalizeHandle(value), value);
});
test('DID allows PLC and hostname-only web, rejects URI and header injection', () => {
  assert.equal(validateDid(did), did);
  assert.equal(
    validateDid('did:web:user.example.com'),
    'did:web:user.example.com',
  );
  for (const value of [
    'did:key:abc',
    did + '\n',
    did + '#key',
    did + '?x',
    'did:plc:abc',
    'did:plc:' + '0'.repeat(24),
    'did:web:example.com:path',
    'did:web:example.com%3A443',
    'did:web:EXAMPLE.com',
    'did:web:a.local',
  ])
    assert.throws(() => validateDid(value), value);
});
test('non-HTTP job validates configuration without producing mutations', () => {
  assert.deepEqual(run(context()), { intents: [], problems: [] });
});
test('build is reproducible, executable ESM and contains the exported manifest', async () => {
  const build = new URL('./build.mjs', import.meta.url);
  execFileSync(process.execPath, [build.pathname]);
  const first = await readFile(
    new URL('./dist/plugin.js', import.meta.url),
    'utf8',
  );
  const metadata = await readFile(
    new URL('./dist/manifest.json', import.meta.url),
    'utf8',
  );
  execFileSync(process.execPath, [build.pathname]);
  assert.equal(
    await readFile(new URL('./dist/plugin.js', import.meta.url), 'utf8'),
    first,
  );
  assert.equal(
    await readFile(new URL('./dist/manifest.json', import.meta.url), 'utf8'),
    metadata,
  );
  assert.deepEqual(JSON.parse(metadata), manifest);
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(first).toString('base64')
  );
  assert.equal(module.handle(context(), request()).body, did);
});

test('manifest declares each consumed installation config field with host-supported types', () => {
  assert.deepEqual(Object.keys(manifest.config.properties), [
    'handle',
    'did',
    'pds',
    'signingKey',
  ]);
  assert.deepEqual(manifest.config.required, ['handle', 'did']);

  for (const field of Object.values(manifest.config.properties)) {
    assert.ok(['string', 'object'].includes(field.type));
    assert.equal(typeof field.description, 'string');
    assert.ok(field.description.length > 0);
  }
});

// did:web: the AT Protocol cryptography spec's published example keys, and
// keys generated here, so the Multikey check is exercised both ways.
const P256_EXAMPLE = 'zDnaembgSGUhZULN2Caob4HLJPaxBh92N7rtH21TErzqf8HQo';
const K256_EXAMPLE = 'zQ3shqwJEJyMBsBXCWyCBpUBMqxcon9oHB7mCvx4sSpMdLJwc';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';

  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }

  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }

  return out;
}

const multikey = (prefix, point) => 'z' + base58Encode([...prefix, ...point]);
const webDid = 'did:web:user.example.com';
const webConfig = {
  handle: 'user.example.com',
  did: webDid,
  pds: 'https://pds.example.com',
  signingKey: K256_EXAMPLE,
};
const webContext = (route = 'did-json', config = webConfig) => ({
  ...context(),
  trigger: { route },
  config,
});
const didJson = (method = 'GET', extra = {}) => ({
  method,
  path: '/.well-known/did.json',
  wellKnown: 'did.json',
  headers: {},
  query: {},
  ...extra,
});

test('Multikey check accepts secp256k1 and P-256 compressed keys only', async () => {
  const { createECDH } = await import('node:crypto');
  assert.equal(validateSigningKey(K256_EXAMPLE), 'secp256k1');
  assert.equal(validateSigningKey(P256_EXAMPLE), 'p256');

  for (const [curve, name, prefix] of [
    ['secp256k1', 'secp256k1', [0xe7, 0x01]],
    ['prime256v1', 'p256', [0x80, 0x24]],
  ]) {
    const point = createECDH(curve).generateKeys(null, 'compressed');
    const key = multikey(prefix, point);
    assert.equal(validateSigningKey(key), name);
    assert.deepEqual(base58Decode(key.slice(1)), [...prefix, ...point]);
    // An uncompressed point is refused.
    const long = createECDH(curve).generateKeys(null, 'uncompressed');
    assert.throws(() => validateSigningKey(multikey(prefix, long)));
  }

  const ed25519 = multikey([0xed, 0x01], new Uint8Array(32).fill(7));
  for (const value of [
    ed25519,
    `did:key:${K256_EXAMPLE}`,
    K256_EXAMPLE.slice(1),
    K256_EXAMPLE + '0',
    K256_EXAMPLE.slice(0, -1),
    'z' + '1'.repeat(40),
    undefined,
    42,
  ])
    assert.throws(() => validateSigningKey(value), String(value));
});
test('PDS endpoint is a bare https origin on a production hostname', () => {
  assert.equal(
    validatePds('https://pds.example.com'),
    'https://pds.example.com',
  );
  assert.equal(
    validatePds('https://PDS.example.com/'),
    'https://pds.example.com',
  );
  assert.equal(
    validatePds('https://pds.example.com:8443'),
    'https://pds.example.com:8443',
  );
  for (const value of [
    'http://pds.example.com',
    'https://pds.example.com/xrpc',
    'https://pds.example.com?x=1',
    'https://user@pds.example.com',
    'https://127.0.0.1',
    'https://pds.localhost',
    'https://pds.example.com:99999',
    'https://pds.example.com:0',
    'https://pds.example.com\n',
    undefined,
  ])
    assert.throws(() => validatePds(value), String(value));
});
test('did:web configuration needs the handle host, a PDS and a key', () => {
  assert.equal(configuration(webConfig).curve, 'secp256k1');
  // The did:key form getRecommendedDidCredentials returns is accepted and
  // published as its Multikey.
  assert.equal(
    configuration({ ...webConfig, signingKey: `did:key:${P256_EXAMPLE}` })
      .signingKey,
    P256_EXAMPLE,
  );
  for (const patch of [
    { pds: undefined },
    { signingKey: undefined },
    { signingKey: 'zBAD' },
  ])
    assert.throws(() => configuration({ ...webConfig, ...patch }));
  // A did:web on another host: this host answers the handle only; the
  // document is that host's to publish.
  const elsewhere = { handle: 'user.example.com', did: 'did:web:id.example.org' };
  assert.deepEqual(configuration(elsewhere), elsewhere);
  assert.equal(
    handle(webContext('atproto-did', elsewhere), request()).body,
    'did:web:id.example.org',
  );
  assert.equal(handle(webContext('did-json', elsewhere), didJson()).status, 404);
  // did:plc ignores the did:web-only fields.
  assert.deepEqual(
    configuration({ handle: 'user.example.com', did, pds: 1 }),
    { handle: 'user.example.com', did },
  );
});
test('did.json serves the AT Protocol DID document for did:web', () => {
  const result = handle(webContext(), didJson());
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'application/json');
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(result.body), {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
      'https://w3id.org/security/suites/secp256k1-2019/v1',
    ],
    id: webDid,
    alsoKnownAs: ['at://user.example.com'],
    verificationMethod: [
      {
        id: `${webDid}#atproto`,
        type: 'Multikey',
        controller: webDid,
        publicKeyMultibase: K256_EXAMPLE,
      },
    ],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://pds.example.com',
      },
    ],
  });
  assert.equal(
    didDocument(configuration({ ...webConfig, signingKey: P256_EXAMPLE }))[
      '@context'
    ][2],
    'https://w3id.org/security/suites/ecdsa-2019/v1',
  );
  // The handle direction agrees with the document.
  assert.equal(handle(webContext('atproto-did'), request()).body, webDid);
  const head = handle(webContext(), didJson('HEAD'));
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.deepEqual(head.headers, result.headers);
  assert.equal(
    handle(webContext(), { ...didJson(), path: '/did.json', wellKnown: null })
      .status,
    200,
  );
});
test('did.json refuses did:plc, other hosts, dispatch mismatches and bad config', () => {
  assert.equal(
    handle(webContext('did-json', context().config), didJson()).status,
    404,
  );
  assert.equal(
    handle(webContext(), didJson('GET', { host: 'other.example.com' })).status,
    404,
  );
  assert.equal(
    handle(webContext(), didJson('GET', { host: 'user.example.com' })).status,
    200,
  );
  for (const patch of [
    { path: '/.well-known/atproto-did' },
    { wellKnown: 'atproto-did' },
    { wellKnown: null },
  ])
    assert.equal(handle(webContext(), didJson('GET', patch)).status, 404);
  // Neither route answers on the other's claim.
  assert.equal(handle(webContext('atproto-did'), didJson()).status, 404);
  assert.equal(handle(webContext(), request()).status, 404);
  const broken = handle(
    webContext('did-json', { ...webConfig, pds: 'http://pds.example.com' }),
    didJson(),
  );
  assert.equal(broken.status, 503);
  assert.ok(!broken.body.includes('pds.example.com'));
  assert.equal(handle(webContext(), didJson('POST')).status, 405);
});
