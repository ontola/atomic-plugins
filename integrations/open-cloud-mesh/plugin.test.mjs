import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  handle,
  parseShare,
  parseNotification,
  domain,
  address,
  base64,
  describe,
  identity,
  run,
  P,
  FILE,
  KEY,
} from './plugin.mjs';

// Invented test data only.
const FOLDER = 'atomic:folder-received-shares';
const BASE = 'https://ocm-inst.routes.atomic.example';
const HOST = 'ocm-inst.routes.atomic.example';
const PEER = 'cloud.example.org';
const SECRET = 'invented-shared-secret-DO-NOT-PERSIST';
const HASH = 'a'.repeat(64);

const share = (overrides = {}) => ({
  shareWith: `bob@${HOST}`,
  name: 'spec.txt',
  providerId: 'share-123',
  owner: `alice@${PEER}`,
  sender: `alice@${PEER}`,
  senderDisplayName: 'Alice',
  shareType: 'user',
  resourceType: 'file',
  protocol: {
    name: 'multi',
    webdav: {
      uri: `https://${PEER}/remote.php/dav/ocm/share-123`,
      sharedSecret: SECRET,
      permissions: ['read'],
    },
  },
  ...overrides,
});

const caller = (overrides = {}) => ({
  keyId: `${PEER}#key1`,
  owner: `https://${PEER}`,
  domain: PEER,
  scheme: 'rfc9421',
  alg: 'ed25519',
  tag: 'ocm',
  endPoint: `https://${PEER}/ocm`,
  ...overrides,
});

/** A route context like the host's: config, reads, queries, host calls. */
function ctx({ route, config = {}, rows = {}, fetch } = {}) {
  const calls = { fetch: [] };

  return {
    calls,
    trigger: { kind: 'http', route },
    config: {
      sharesFolder: FOLDER,
      allowedPeers: { [PEER]: true },
      recipients: { bob: 'Bob' },
      ...config,
    },
    read: s => rows[s],
    query: (p, v) => Object.keys(rows).filter(s => rows[s][p] === v),
    keys: {
      publicKey: name => {
        assert.equal(name, KEY);

        return {
          name,
          alg: 'ed25519',
          publicKeyPem:
            '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n',
          jwk: {
            kty: 'OKP',
            crv: 'Ed25519',
            alg: 'Ed25519',
            use: 'sig',
            x: 'invented-x',
          },
        };
      },
    },
    blobs: {
      fetch: request => {
        calls.fetch.push(request);
        if (fetch) return fetch(request);

        return {
          status: 200,
          blob: {
            hash: HASH,
            size: 33,
            type: 'text/plain',
            subject: `atomic:blob:${HASH}`,
          },
        };
      },
    },
  };
}

const request = (method, body, extra = {}) => ({
  method,
  path: '/',
  url: `${BASE}/`,
  base: BASE,
  params: {},
  query: {},
  headers: {},
  body:
    body === undefined
      ? null
      : typeof body === 'string'
        ? body
        : JSON.stringify(body),
  caller: null,
  receivedAt: 0,
  ...extra,
});

const post = (route, body, callerOverrides, context = {}) => {
  const c = ctx({ route, ...context });
  const verdict = handle(
    c,
    request('POST', body, {
      caller: callerOverrides === null ? null : caller(callerOverrides),
    }),
  );
  const status = verdict.response ? verdict.response.status : verdict.status;
  const answer = verdict.response ? verdict.response.body : verdict.body;

  return {
    verdict,
    status,
    answer: JSON.parse(answer || 'null'),
    calls: c.calls,
  };
};

test('discovery advertises an enabled OCM 1.5 receiver with its JWK Set', () => {
  const c = ctx({ route: 'discovery' });
  const r = handle(c, request('GET', undefined, { wellKnown: 'ocm' }));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), {
    enabled: true,
    apiVersion: '1.5.0',
    endPoint: `${BASE}/ocm`,
    provider: 'Atomic Server',
    resourceTypes: [
      {
        name: 'file',
        shareTypes: ['user'],
        protocols: { 'webdav-receive': { uri: 'absolute' } },
      },
    ],
    capabilities: ['http-sig', 'notifications'],
    criteria: ['must-use-http-sig', 'allowlist'],
    jwksUri: `${BASE}/ocm/jwks`,
  });
  assert.equal(handle(c, request('HEAD')).body, '');
  assert.equal(handle(c, request('POST', {})).status, 405);
  const off = handle(
    ctx({ route: 'discovery', config: { sharesFolder: undefined } }),
    request('GET'),
  );
  assert.equal(JSON.parse(off.body).enabled, false);
});

test('the JWK Set publishes the installation key under <host>#ocm-key', () => {
  const r = handle(ctx({ route: 'jwks' }), request('GET'));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), {
    keys: [
      {
        kty: 'OKP',
        crv: 'Ed25519',
        alg: 'Ed25519',
        use: 'sig',
        x: 'invented-x',
        kid: `${HOST}#ocm-key`,
      },
    ],
  });
});

test('a signed share from an allowed peer is fetched, stored and acknowledged', () => {
  const { verdict, status, answer, calls } = post('shares', share(), {});
  assert.equal(status, 201);
  assert.deepEqual(answer, { recipientDisplayName: 'Bob' });
  // The host fetches the file with the share's secret, never the plugin.
  assert.deepEqual(calls.fetch, [
    {
      operation: 'fetch-file',
      url: `https://${PEER}/remote.php/dav/ocm/share-123`,
      headers: { authorization: `Bearer ${SECRET}` },
    },
  ]);
  assert.equal(verdict.intents.length, 1);
  const [create] = verdict.intents;
  assert.equal(create.op, 'create');
  assert.equal(create.parent, FOLDER);
  assert.deepEqual(create.isA, [FILE]);
  assert.equal(create.set[P.name], 'spec.txt');
  assert.equal(create.set[P.blob], `atomic:blob:${HASH}`);
  assert.equal(create.set[P.filesize], 33);
  assert.equal(create.set[P.mimetype], 'text/plain');
  assert.equal(create.set[P.downloadURL], `/download/files/${HASH}`);
  assert.equal(create.set[P.localId], `ocm-share-v2 ${PEER} share-123`);
  assert.match(create.set[P.description], /^- State: accepted$/m);
  // The secret is in the fetch request only: not in intents, deliveries
  // or the answer.
  const { response, ...effects } = verdict;
  assert.ok(!JSON.stringify(effects).includes(SECRET));
  assert.ok(!JSON.stringify(response).includes(SECRET));

  assert.deepEqual(verdict.enqueue, [
    {
      operation: 'notify',
      url: `https://${PEER}/ocm/notifications`,
      headers: { 'content-type': 'application/json' },
      body: {
        notificationType: 'SHARE_ACCEPTED',
        senderDomain: HOST,
        resourceType: 'file',
        shareType: 'user',
        notification: {
          message: 'The share was accepted.',
          file: { providerId: 'share-123' },
        },
      },
      sign: {
        key: KEY,
        keyId: `${HOST}#ocm-key`,
        format: 'rfc9421',
        tag: 'ocm',
      },
      idempotencyKey: `accepted:${PEER}:share-123`,
    },
  ]);
});

test('a repeated share answers 201 without fetching or writing again', () => {
  const rows = {
    'atomic:existing': {
      [P.localId]: `ocm-share-v2 ${PEER} share-123`,
    },
  };
  const { verdict, status, calls } = post('shares', share(), {}, { rows });
  assert.equal(status, 201);
  assert.equal(calls.fetch.length, 0);
  assert.equal(verdict.intents, undefined);
  assert.equal(verdict.enqueue, undefined);
});

test('shares are refused unless signed by an allowed peer for its own accounts', () => {
  const cases = [
    [null, share(), 401],
    [{ tag: undefined }, share(), 401],
    [{ domain: 'other.example' }, share(), 403],
    [{}, share({ sender: 'mallory@other.example' }), 403],
    [{}, share({ owner: 'mallory@other.example' }), 403],
    [{}, share({ shareWith: 'carol@' + HOST }), 400],
    [{}, share({ shareWith: 'bob@elsewhere.example' }), 400],
    [{}, share({ expiration: 1 }), 400],
  ];

  for (const [who, body, expected] of cases) {
    const { verdict, status, calls } = post('shares', body, who);
    assert.equal(status, expected, JSON.stringify([who, body.shareWith]));
    assert.equal(verdict.intents, undefined);
    assert.equal(calls.fetch.length, 0);
  }

  // Allowed peers are an explicit allowlist.
  for (const allowedPeers of [
    undefined,
    {},
    { [PEER]: false },
    { 'CLOUD.example.org': 'yes' },
  ])
    assert.equal(
      post('shares', share(), {}, { config: { allowedPeers } }).status,
      403,
    );
  assert.equal(
    post(
      'shares',
      share(),
      {},
      { config: { allowedPeers: { 'Cloud.Example.Org': true } } },
    ).status,
    201,
  );
  // Not configured yet.
  assert.equal(
    post('shares', share(), {}, { config: { sharesFolder: '' } }).status,
    503,
  );
});

test('unsupported share shapes answer 501 and fetch nothing', () => {
  const dav = share().protocol.webdav;

  for (const body of [
    share({ shareType: 'group' }),
    share({ resourceType: 'folder' }),
    share({ encryption: { resourceId: 'x', scheme: 'ocm-gpg' } }),
    share({ protocol: { name: 'multi', webapp: { uri: 'https://x/' } } }),
    share({
      protocol: { name: 'multi', webdav: { ...dav, uri: 'share-123' } },
    }),
    share({
      protocol: {
        name: 'multi',
        webdav: { ...dav, requirements: ['must-exchange-token'] },
      },
    }),
  ]) {
    const { status, calls } = post('shares', body, {});
    assert.equal(status, 501, JSON.stringify(body.protocol));
    assert.equal(calls.fetch.length, 0);
  }
});

test('plain-http WebDAV URIs are refused', () => {
  const dav = share().protocol.webdav;
  const body = share({
    protocol: {
      name: 'multi',
      webdav: { ...dav, uri: `http://${PEER}/dav/x` },
    },
  });
  const { status, calls } = post('shares', body, {});
  assert.equal(status, 400);
  assert.equal(calls.fetch.length, 0);
});

test('a failed fetch stores and sends nothing', () => {
  const refused = post(
    'shares',
    share(),
    {},
    { fetch: () => ({ status: 401 }) },
  );
  assert.equal(refused.status, 400);
  assert.match(refused.answer.message, /answered 401/);
  assert.equal(refused.verdict.intents, undefined);
  const thrown = post(
    'shares',
    share(),
    {},
    {
      fetch: () => {
        throw new Error('bytes-per-day quota');
      },
    },
  );
  assert.equal(thrown.status, 503);
  assert.ok(!JSON.stringify(thrown.answer).includes(SECRET));
  assert.equal(thrown.verdict.intents, undefined);
});

test('no endPoint in the sender discovery: stored, with a warning instead of a notification', () => {
  const { verdict, status } = post('shares', share(), { endPoint: null });
  assert.equal(status, 201);
  assert.equal(verdict.intents.length, 1);
  assert.deepEqual(verdict.enqueue, []);
  assert.match(verdict.problems[0].message, /no endPoint/);
});

const shareId = `ocm-share-v2 ${PEER} share-123`;

function received(state = 'accepted') {
  return {
    'atomic:received': {
      [P.parent]: FOLDER,
      [P.isA]: [FILE],
      [P.localId]: shareId,
      [P.description]: describe({
        ...parseShare(JSON.stringify(share())).share,
        peer: PEER,
        state,
      }),
    },
  };
}

const notification = (type = 'SHARE_UNSHARED', extra = {}) => ({
  notificationType: type,
  senderDomain: PEER,
  resourceType: 'file',
  shareType: 'user',
  notification: {
    message: 'invented',
    sharedSecret: SECRET,
    file: { providerId: 'share-123', ...extra },
  },
});

test('SHARE_UNSHARED marks the received copy unshared, once', () => {
  const { verdict, status } = post(
    'notifications',
    notification(),
    {},
    { rows: received() },
  );
  assert.equal(status, 201);
  assert.equal(verdict.intents.length, 1);
  assert.equal(verdict.intents[0].op, 'set');
  assert.equal(verdict.intents[0].subject, 'atomic:received');
  assert.match(verdict.intents[0].set[P.description], /^- State: unshared$/m);
  assert.ok(!JSON.stringify(verdict).includes(SECRET));
  const again = post(
    'notifications',
    notification(),
    {},
    { rows: received('unshared') },
  );
  assert.equal(again.status, 201);
  assert.equal(again.verdict.intents, undefined);
});

test('SHARE_CHANGE_PERMISSION updates the permissions line', () => {
  const { verdict } = post(
    'notifications',
    notification('SHARE_CHANGE_PERMISSION', { permissions: ['write', 'read'] }),
    {},
    { rows: received() },
  );
  assert.match(
    verdict.intents[0].set[P.description],
    /^- Permissions: read, write$/m,
  );
  assert.equal(
    post(
      'notifications',
      notification('SHARE_CHANGE_PERMISSION'),
      {},
      { rows: received() },
    ).status,
    400,
  );
});

test('notifications are refused for other senders, unknown shares and unsupported types', () => {
  assert.equal(
    post('notifications', notification(), null, { rows: received() }).status,
    401,
  );
  assert.equal(
    post(
      'notifications',
      { ...notification(), senderDomain: 'other.example' },
      {},
      { rows: received() },
    ).status,
    403,
  );
  assert.equal(
    post('notifications', notification(), {}, { rows: {} }).status,
    404,
  );
  assert.equal(
    post(
      'notifications',
      notification('SHARE_ACCEPTED'),
      {},
      { rows: received() },
    ).status,
    501,
  );
  assert.equal(
    post(
      'notifications',
      notification('REQUEST_RESHARE'),
      {},
      { rows: received() },
    ).status,
    501,
  );
  const moved = received();
  moved['atomic:received'][P.parent] = 'atomic:elsewhere';
  assert.equal(
    post('notifications', notification(), {}, { rows: moved }).status,
    409,
  );
  const edited = received();
  edited['atomic:received'][P.description] = 'edited by hand';
  assert.equal(
    post('notifications', notification(), {}, { rows: edited }).status,
    409,
  );
  // The deprecated top-level providerId still works.
  const legacy = { ...notification(), providerId: 'share-123' };
  delete legacy.notification;
  assert.equal(
    post('notifications', legacy, {}, { rows: received() }).status,
    201,
  );
});

test('parsers bound their input and keep secrets out of metadata', () => {
  const { share: meta, access } = parseShare(JSON.stringify(share()));
  assert.equal(access.secret, SECRET);
  assert.ok(!JSON.stringify(meta).includes(SECRET));
  assert.deepEqual(meta.permissions, ['read']);
  assert.throws(() => parseShare('x'.repeat(70000)), /at most/);
  assert.throws(() => parseShare('[]'), /Invalid share/);
  assert.throws(
    () => parseShare(JSON.stringify(share({ name: '../x' }))),
    /Invalid name/,
  );
  assert.throws(
    () => parseShare(JSON.stringify(share({ name: 'a\nb' }))),
    /Invalid name/,
  );
  const n = parseNotification(JSON.stringify(notification()));
  assert.deepEqual(n, {
    notificationType: 'SHARE_UNSHARED',
    senderDomain: PEER,
    providerId: 'share-123',
  });
});

test('domains are canonical host[:port] only', () => {
  assert.equal(domain('Cloud.Example.Org'), 'cloud.example.org');
  assert.equal(domain('127.0.0.1:19143'), '127.0.0.1:19143');
  for (const bad of [
    'https://cloud.example.org',
    'cloud.example.org/path',
    'user@cloud.example.org',
    'cloud.example.org:0',
    'cloud.example.org:65536',
    '-bad.example',
    '[::1]:80',
    'cloud.example.org\n',
  ])
    assert.throws(() => domain(bad), undefined, bad);
});

test('unknown routes and failures never echo request data', () => {
  assert.equal(handle(ctx({ route: 'nope' }), request('GET')).status, 404);
  const c = ctx({ route: 'shares' });

  c.query = () => {
    throw new Error(SECRET);
  };

  const r = handle(c, request('POST', share(), { caller: caller() }));
  assert.equal(r.status, 500);
  assert.ok(!r.body.includes(SECRET));
  assert.equal(run().intents.length, 0);
});

test('the bundle rebuilds reproducibly and matches the manifest', async () => {
  const before = await readFile(
    new URL('./plugin.js', import.meta.url),
    'utf8',
  );
  execFileSync(process.execPath, [
    new URL('./build.mjs', import.meta.url).pathname,
  ]);
  assert.equal(
    await readFile(new URL('./plugin.js', import.meta.url), 'utf8'),
    before,
  );
  const built = await import(
    'data:text/javascript;base64,' + Buffer.from(before).toString('base64')
  );
  const manifest = JSON.parse(
    await readFile(new URL('./manifest.json', import.meta.url)),
  );
  assert.deepEqual(built.manifest, manifest);
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.http.mount, 'installation-origin');
  const routes = Object.fromEntries(manifest.http.routes.map(r => [r.id, r]));

  // Writes, deliveries and downloads only on signature-verified routes.
  for (const route of Object.values(routes))
    if (route.writes || route.enqueues || route.fetches) {
      assert.equal(route.auth, 'http-signature', route.id);
      assert.equal(route.principal, 'installation', route.id);
    }

  // The download is a `fetches` read operation, never borrowed from
  // `enqueues` (atomic-server candidate16).
  assert.deepEqual(routes.shares.fetches, [
    'fetch-file',
    'fetch-legacy-webdav',
  ]);
  assert.deepEqual(routes.shares.enqueues, ['notify']);
  const operations = Object.fromEntries(
    manifest.operations.map(o => [o.id, o]),
  );
  assert.deepEqual(operations['fetch-file'], {
    id: 'fetch-file',
    method: 'GET',
    url: 'https://*/{*rest}',
    effect: 'read',
  });
  assert.deepEqual(operations['fetch-legacy-webdav'], {
    id: 'fetch-legacy-webdav',
    method: 'GET',
    url: 'https://*/public.php/webdav/',
    effect: 'read',
  });
  assert.equal(operations.notify.effect, 'write');
  const blobFetches = [];
  post('shares', share(), {}).calls.fetch.forEach(c => blobFetches.push(c));
  post('shares', nextcloudShare(), {}).calls.fetch.forEach(c =>
    blobFetches.push(c),
  );
  assert.equal(blobFetches.length, 2);
  for (const c of blobFetches)
    assert.ok(routes.shares.fetches.includes(c.operation));

  assert.deepEqual(manifest.http.wellKnown, [
    { name: 'ocm', kind: 'exclusive', route: 'discovery' },
  ]);

  // Every route a manifest declares has a handler here.
  for (const id of Object.keys(routes)) {
    const r = built.handle(ctx({ route: id }), request('GET'));
    assert.notEqual(r.status ?? r.response?.status, 404, id);
  }
});

/**
 * The body Nextcloud 35.0.1 sent in the 2026-10-01 spike (see README,
 * "Against a real Nextcloud"), with an invented secret and our test hosts:
 * the legacy `webdav` protocol with `options` and no `uri`, `shareWith`
 * carrying the receiver's URL, no `senderDomain`.
 */
const nextcloudShare = (overrides = {}) => ({
  shareWith: `bob@https://${HOST}`,
  shareType: 'user',
  name: 'spec.txt',
  resourceType: 'file',
  description: '',
  providerId: '1',
  owner: `alice@${PEER}`,
  ownerDisplayName: 'alice',
  sharedBy: `alice@${PEER}`,
  sharedByDisplayName: 'alice',
  sender: `alice@${PEER}`,
  senderDisplayName: 'alice',
  protocol: {
    name: 'webdav',
    options: {
      sharedSecret: SECRET,
      permissions: '{http://open-cloud-mesh.org/ns}share-permissions',
    },
  },
  ...overrides,
});

test("a Nextcloud legacy share is read from the signer's public WebDAV root with Basic auth", () => {
  const { verdict, status, answer, calls } = post(
    'shares',
    nextcloudShare(),
    {},
  );
  assert.equal(status, 201, JSON.stringify(answer));
  assert.deepEqual(calls.fetch, [
    {
      operation: 'fetch-legacy-webdav',
      url: `https://${PEER}/public.php/webdav/`,
      headers: {
        authorization: `Basic ${Buffer.from(`${SECRET}:`).toString('base64')}`,
      },
    },
  ]);
  const [create] = verdict.intents;
  assert.equal(create.set[P.localId], `ocm-share-v2 ${PEER} 1`);
  assert.match(create.set[P.description], /^- Permissions: read$/m);
  assert.match(
    create.set[P.description],
    new RegExp(`^- Recipient: bob@https://`, 'm'),
  );
  const { response, ...effects } = verdict;
  assert.ok(!JSON.stringify(effects).includes(SECRET));
  assert.ok(!JSON.stringify(response).includes(SECRET));
  // Plain-http receiver address, as Nextcloud spells it for one.
  assert.equal(
    post('shares', nextcloudShare({ shareWith: `bob@http://${HOST}/` }), {})
      .status,
    201,
  );
});

test("a Nextcloud folder share (its WebDAV root's HTML page) is refused, an HTML file is not", () => {
  const html = name =>
    post(
      'shares',
      nextcloudShare({ name }),
      {},
      {
        fetch: () => ({
          status: 200,
          blob: {
            hash: HASH,
            size: 112,
            type: 'text/html; charset=UTF-8',
            subject: `atomic:blob:${HASH}`,
          },
        }),
      },
    );
  const folder = html('folder');
  assert.equal(folder.status, 501);
  assert.match(folder.answer.message, /served a folder/);
  assert.equal(folder.verdict.intents, undefined);
  assert.equal(folder.verdict.enqueue, undefined);
  assert.equal(html('page.html').status, 201);
});

test('a legacy share is only fetched from the https origin that signed it', () => {
  for (const owner of [
    undefined,
    `https://other.example`,
    `http://${PEER}`,
    `https://${PEER}.evil.example`,
  ]) {
    const { status, calls, verdict } = post('shares', nextcloudShare(), {
      owner,
    });
    assert.ok([400, 501].includes(status), `${owner}: ${status}`);
    assert.equal(calls.fetch.length, 0);
    assert.equal(verdict.intents, undefined);
  }

  // A `uri` next to `options`, or a new-style `webdav` block without one,
  // is not the legacy shape.
  const withUri = nextcloudShare();
  withUri.protocol.options.uri = 'share-1';
  assert.equal(post('shares', withUri, {}).status, 501);
  assert.equal(
    post(
      'shares',
      nextcloudShare({
        protocol: { name: 'webdav', webdav: { sharedSecret: SECRET } },
      }),
      {},
    ).status,
    400,
  );
  assert.equal(
    post(
      'shares',
      nextcloudShare({
        protocol: { name: 'multi', options: { sharedSecret: SECRET } },
      }),
      {},
    ).status,
    400,
  );
});

test('a Nextcloud SHARE_UNSHARED without senderDomain is matched to the signer', () => {
  // The notification Nextcloud 35.0.1 sent: top-level providerId, the
  // secret inside `notification`, no senderDomain.
  const body = {
    notificationType: 'SHARE_UNSHARED',
    resourceType: 'file',
    providerId: 'share-123',
    notification: {
      sharedSecret: SECRET,
      message: 'file is no longer shared with you',
    },
  };
  const { verdict, status } = post(
    'notifications',
    body,
    {},
    {
      rows: received(),
    },
  );
  assert.equal(status, 201);
  assert.match(verdict.intents[0].set[P.description], /^- State: unshared$/m);
  assert.ok(!JSON.stringify(verdict).includes(SECRET));
  // From another signer it names no share of that signer.
  assert.equal(
    post(
      'notifications',
      body,
      { domain: 'other.example' },
      {
        rows: received(),
        config: { allowedPeers: { 'other.example': true } },
      },
    ).status,
    404,
  );
});

test('addresses may carry the server URL, domains may not', () => {
  assert.deepEqual(address('bob@https://Host.Example:8443/', 'x'), {
    user: 'bob',
    domain: 'host.example:8443',
  });
  assert.deepEqual(address('a@b@http://host.example', 'x'), {
    user: 'a@b',
    domain: 'host.example',
  });
  for (const bad of [
    'bob@https://host.example/path',
    'bob@ftp://host.example',
    'bob@https://',
  ])
    assert.throws(() => address(bad, 'x'), undefined, bad);
});

test('base64 matches Buffer for ASCII and UTF-8', () => {
  for (const value of ['', 'a', 'ab', 'abc', 'invented-secret:', 'é€😀:'])
    assert.equal(base64(value), Buffer.from(value).toString('base64'), value);
});

test('share identities are plain text the host planner keeps as is', () => {
  const id = identity('localhost:8443', 'share 1/[x]');
  assert.equal(id, 'ocm-share-v2 localhost%3A8443 share%201%2F%5Bx%5D');
  assert.throws(() => JSON.parse(id));
});
