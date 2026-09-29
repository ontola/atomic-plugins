import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  P,
  FILE,
  run,
  handle,
  sha256,
  manifest,
  documentKey,
  parseScopes,
  originOf,
  storagePath,
  SPEC_VERSION,
} from './plugin.mjs';
import { validateHttp, httpGate } from '../tooling/manifest-http.mjs';

// Invented data only: example.test hosts, made-up tokens and hashes.
const table = 'https://atomic.example/documents';
const BASE = 'http://abc.routes.example.test';
const hashOf = text => createHash('sha256').update(text).digest('hex');
const document = (path = '/public/notes/a.txt', text = 'hello') => ({
  path,
  text,
  contentType: 'text/plain; charset=utf-8',
});

/**
 * An in-memory stand-in for the host: `query`/`read` over a map of
 * resources, route intents and import intents applied to it. Unit evidence
 * only; the e2e tier runs the same bundle against the real host.
 */
function fixture(documents = []) {
  const resources = new Map();
  let next = 0;
  const consents = [];
  const issued = [];
  const revoked = [];
  const ctx = {
    config: { table },
    trigger: { route: 'storage-read' },
    query: (property, value) =>
      [...resources].filter(([, r]) => r[property] === value).map(([s]) => s),
    read: subject => {
      if (!resources.has(subject)) throw Error('Denied or absent');

      return resources.get(subject);
    },
    tokens: {
      requestConsent: request => {
        consents.push(request);

        return { url: 'http://api.example.test/app/route-consent?request=r1' };
      },
      issue: ({ code }) => {
        if (code !== 'good-code') throw Error('this code is unknown');
        const token = {
          id: 'tok_1',
          token: 'atr_invented+token/=',
          client: 'https://app.example.test',
          scopes: ['notes:rw'],
        };
        issued.push(token);

        return token;
      },
      revoke: id => revoked.push(id),
    },
  };
  const proposal = docs =>
    run({ ...ctx, upload: { text: JSON.stringify({ documents: docs }) } });

  // Fixture application is deliberately not evidence of real Atomic host persistence.
  function apply(verdict) {
    assert.deepEqual(verdict.problems ?? [], []);

    for (const intent of verdict.intents ?? []) {
      if (intent.op === 'create')
        resources.set(table + '/' + ++next, {
          [P.parent]: intent.parent,
          ...intent.set,
        });
      else if (intent.op === 'destroy') resources.delete(intent.subject);
      else Object.assign(resources.get(intent.subject), intent.set);
    }
  }

  apply(proposal(documents));

  const call = (route, request) =>
    handle(
      { ...ctx, trigger: { route } },
      { base: BASE, headers: {}, ...request },
    );
  const scopes = s => ({ token: { id: 'tok_x', scopes: s } });
  /** A request to the storage, as the host hands it to the handler. */
  const storage = (method, path, { caller = null, headers = {}, blob } = {}) =>
    call(['GET', 'HEAD'].includes(method) ? 'storage-read' : 'storage-write', {
      method,
      path,
      caller,
      headers,
      blob,
    });

  /** PUT, then apply its intents like the host would after the precondition check. */
  const put = (path, text, type = 'text/plain', caller = scopes(['*:rw'])) => {
    const hash = hashOf(text);
    const verdict = storage('PUT', '/storage' + encodeURI(path), {
      caller,
      blob: {
        hash,
        size: Buffer.byteLength(text),
        type,
        subject: 'atomic:blob:' + hash,
      },
    });
    apply(verdict);

    return { verdict, hash };
  };

  return {
    ctx,
    resources,
    proposal,
    apply,
    call,
    storage,
    put,
    scopes,
    consents,
    issued,
    revoked,
  };
}

const status = verdict => verdict.response?.status ?? verdict.status;

test('SHA-256 matches independent standard implementation for Unicode and multiple blocks', () => {
  for (const text of [
    '',
    'abc',
    'a'.repeat(55),
    'a'.repeat(56),
    'x'.repeat(1000),
    'é 🌍\r\n',
  ])
    assert.equal(sha256(text), hashOf(text));
});

test('the manifest is a valid v3 http block that needs read-write, on its own origin', () => {
  validateHttp(manifest.http, { operations: manifest.operations });
  assert.equal(httpGate(manifest.http).needed, 'read-write');
  assert.equal(manifest.http.mount, 'installation-origin');
  const routes = Object.fromEntries(manifest.http.routes.map(r => [r.id, r]));
  assert.deepEqual(routes['storage-read'].methods, ['GET', 'HEAD']);
  assert.equal(routes['storage-read'].auth, 'bearer');
  assert.equal(routes['storage-read'].authOptional, true);
  assert.equal(routes['storage-read'].principal, 'installation');
  assert.deepEqual(routes['storage-write'].methods, ['PUT', 'DELETE']);
  assert.equal(routes['storage-write'].body, 'blob');
  assert.deepEqual(routes['storage-write'].writes, ['documents']);
  for (const id of ['storage-read', 'storage-write', 'webfinger'])
    assert.equal(routes[id].cors, 'any-origin-no-credentials', id);
  assert.deepEqual(manifest.http.writeTargets, [
    { id: 'documents', parent: 'config:table', classes: [FILE] },
  ]);
  assert.deepEqual(manifest.http.wellKnown[0].match, {
    resourcePrefix: 'acct:',
  });
});

// -- WebFinger ------------------------------------------------------------------

test('WebFinger answers the storage root and the OAuth endpoint for this host', () => {
  const f = fixture();
  const url =
    BASE + '/.well-known/webfinger?resource=acct:me@abc.routes.example.test';
  const answer = f.call('webfinger', {
    method: 'GET',
    url,
    query: { resource: 'acct:me@abc.routes.example.test' },
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['content-type'], 'application/jrd+json');
  const jrd = JSON.parse(answer.body);
  assert.equal(jrd.subject, 'acct:me@abc.routes.example.test');
  const [link] = jrd.links;
  assert.equal(link.rel, 'http://tools.ietf.org/id/draft-dejong-remotestorage');
  assert.equal(link.href, BASE + '/storage');
  assert.equal(
    link.properties['http://remotestorage.io/spec/version'],
    SPEC_VERSION,
  );
  assert.equal(
    link.properties['http://tools.ietf.org/html/rfc6749#section-4.2'],
    BASE + '/oauth',
  );
  assert.equal(link.properties['http://tools.ietf.org/html/rfc7233'], null);

  for (const resource of [
    'acct:me@other.example.test',
    'mailto:me@abc.routes.example.test',
    undefined,
  ])
    assert.equal(
      f.call('webfinger', { method: 'GET', url, query: { resource } }).status,
      404,
      String(resource),
    );
  // A configured user name is the only one answered.
  f.ctx.config.user = 'alice';
  assert.equal(
    f.call('webfinger', {
      method: 'GET',
      url,
      query: { resource: 'acct:me@abc.routes.example.test' },
    }).status,
    404,
  );
  assert.equal(
    f.call('webfinger', {
      method: 'GET',
      url,
      query: { resource: 'acct:alice@abc.routes.example.test' },
    }).status,
    200,
  );
});

// -- OAuth ------------------------------------------------------------------------

test('the OAuth endpoint asks the host for consent with the app origin and exact scopes', () => {
  const f = fixture();
  const answer = f.call('oauth', {
    method: 'GET',
    query: {
      redirect_uri: 'https://App.Example.test:443/cb?x=1#frag',
      client_id: 'https://app.example.test',
      scope: 'notes:rw contacts:r',
      response_type: 'token',
      state: 'abc',
    },
  });
  assert.equal(answer.status, 302);
  assert.equal(
    answer.headers.location,
    'http://api.example.test/app/route-consent?request=r1',
  );
  assert.deepEqual(f.consents, [
    {
      name: 'storage',
      scopes: ['notes:rw', 'contacts:r'],
      client: 'https://app.example.test',
      redirect: '/oauth/callback',
      state: JSON.stringify({
        r: 'https://App.Example.test:443/cb?x=1',
        s: 'abc',
      }),
    },
  ]);
});

test('bad OAuth requests are refused before any consent is asked', () => {
  const f = fixture();
  const good = { redirect_uri: 'https://app.example.test/', scope: 'notes:rw' };
  for (const query of [
    { ...good, redirect_uri: 'javascript:alert(1)' },
    { ...good, redirect_uri: '//app.example.test/' },
    { ...good, redirect_uri: 'https://app.example.test/' + 'x'.repeat(500) },
    { ...good, scope: 'notes' },
    { ...good, scope: 'notes:w' },
    { ...good, scope: '' },
    { ...good, scope: '../x:rw' },
    { ...good, response_type: 'code' },
  ])
    assert.equal(
      f.call('oauth', { method: 'GET', query }).status,
      400,
      JSON.stringify(query),
    );
  assert.deepEqual(f.consents, []);
  assert.deepEqual(parseScopes('*:rw'), ['*:rw']);
  assert.deepEqual(parseScopes('a:r,a:r b:rw'), ['a:r', 'b:rw']);
  assert.equal(originOf('http://localhost:80/x'), 'http://localhost');
  assert.equal(originOf('HTTP://Host.test:8080'), 'http://host.test:8080');
  assert.equal(originOf('ftp://x'), null);
});

test('the callback hands the token back to the approved app in the fragment', () => {
  const f = fixture();
  const state = JSON.stringify({ r: 'https://app.example.test/cb', s: 'a b' });
  const answer = f.call('oauth-callback', {
    method: 'GET',
    query: { code: 'good-code', state },
  });
  assert.equal(answer.status, 302);
  assert.equal(
    answer.headers.location,
    'https://app.example.test/cb#access_token=atr_invented%2Btoken%2F%3D&token_type=bearer&state=a%20b',
  );
  assert.deepEqual(f.revoked, []);

  // A state that names another app: the token is revoked, not handed over.
  const other = JSON.stringify({ r: 'https://evil.example.test/cb', s: '' });
  const refused = f.call('oauth-callback', {
    method: 'GET',
    query: { code: 'good-code', state: other },
  });
  assert.equal(refused.status, 400);
  assert.deepEqual(f.revoked, ['tok_1']);
  assert.equal(refused.headers.location, undefined);

  // Denied, unknown codes and forged states.
  assert.equal(
    f.call('oauth-callback', {
      method: 'GET',
      query: { error: 'access_denied', state },
    }).status,
    403,
  );
  assert.equal(
    f.call('oauth-callback', { method: 'GET', query: { code: 'bad', state } })
      .status,
    400,
  );
  assert.equal(
    f.call('oauth-callback', {
      method: 'GET',
      query: { code: 'good-code', state: '{' },
    }).status,
    400,
  );
});

// -- storage: access -------------------------------------------------------------

test('without a token only public documents are readable, never a listing', () => {
  const f = fixture();
  f.put('/public/notes/a.txt', 'public');
  f.put('/notes/private.txt', 'private');
  const anon = f.storage('GET', '/storage/public/notes/a.txt');
  assert.equal(anon.response.blob, hashOf('public'));
  assert.equal(anon.response.headers['content-type'], 'text/plain');
  for (const path of [
    '/storage/notes/private.txt',
    '/storage/public/notes/',
    '/storage/notes/',
    '/storage/',
  ])
    assert.equal(status(f.storage('GET', path)), 401, path);
  assert.equal(status(f.storage('PUT', '/storage/public/notes/b.txt')), 401);
  assert.equal(status(f.storage('DELETE', '/storage/public/notes/a.txt')), 401);
  assert.match(
    f.storage('GET', '/storage/notes/').headers['www-authenticate'],
    /^Bearer/,
  );
});

test('scopes are per category, r or rw, and * covers the root', () => {
  const f = fixture();
  f.put('/notes/a.txt', 'a');
  f.put('/contacts/b.txt', 'b');
  const notesR = f.scopes(['notes:r']);
  assert.equal(
    f.storage('GET', '/storage/notes/a.txt', { caller: notesR }).response.blob,
    hashOf('a'),
  );
  assert.equal(
    status(f.storage('GET', '/storage/notes/', { caller: notesR })),
    200,
  );
  assert.equal(
    status(f.storage('GET', '/storage/contacts/b.txt', { caller: notesR })),
    403,
  );
  assert.equal(status(f.storage('GET', '/storage/', { caller: notesR })), 403);
  assert.equal(
    status(f.storage('GET', '/storage/public/notes/', { caller: notesR })),
    200,
  );
  assert.equal(
    status(f.storage('GET', '/storage/public/', { caller: notesR })),
    403,
  );
  assert.equal(
    status(f.put('/notes/c.txt', 'c', 'text/plain', notesR).verdict),
    403,
  );
  assert.equal(
    status(
      f.put('/public/notes/c.txt', 'c', 'text/plain', f.scopes(['notes:rw']))
        .verdict,
    ),
    201,
  );
  assert.equal(
    status(f.storage('GET', '/storage/', { caller: f.scopes(['*:r']) })),
    200,
  );
  // Public documents are readable with any token, or none.
  assert.equal(
    f.storage('GET', '/storage/public/notes/c.txt', {
      caller: f.scopes(['contacts:r']),
    }).response.blob,
    hashOf('c'),
  );
});

// -- storage: documents ------------------------------------------------------------

test('PUT creates a File with the blob, then updates it; the host gets the prior blob', () => {
  const f = fixture();
  const first = f.put('/notes/a b.txt', 'one', 'text/plain; charset=utf-8');
  assert.equal(first.verdict.response.status, 201);
  assert.equal(first.verdict.response.current, null);
  const [create] = first.verdict.intents;
  assert.equal(create.op, 'create');
  assert.equal(create.parent, table);
  assert.deepEqual(create.isA, [FILE]);
  assert.deepEqual(create.set, {
    [P.name]: 'a b.txt',
    [P.filename]: 'a b.txt',
    [P.localId]: documentKey('/notes/a b.txt'),
    [P.blob]: 'atomic:blob:' + hashOf('one'),
    [P.filesize]: 3,
    [P.mimetype]: 'text/plain; charset=utf-8',
    [P.downloadURL]: BASE + '/storage/notes/a%20b.txt',
  });

  const second = f.put('/notes/a b.txt', 'two');
  assert.equal(second.verdict.response.status, 200);
  assert.equal(second.verdict.response.current, hashOf('one'));
  assert.equal(second.verdict.intents[0].op, 'set');
  assert.equal(f.resources.size, 1);
  const read = f.storage('GET', '/storage/notes/a%20b.txt', {
    caller: f.scopes(['notes:r']),
  });
  assert.equal(read.response.blob, hashOf('two'));
  assert.equal(read.response.headers['cache-control'], 'no-cache');
  assert.match(read.response.headers['access-control-expose-headers'], /ETag/);
});

test('DELETE destroys the File and tells the host which blob it held', () => {
  const f = fixture();
  f.put('/notes/a.txt', 'a');
  const rw = f.scopes(['notes:rw']);
  const missing = f.storage('DELETE', '/storage/notes/nope.txt', {
    caller: rw,
  });
  assert.equal(missing.response.status, 404);
  assert.equal(missing.response.current, null);
  const gone = f.storage('DELETE', '/storage/notes/a.txt', { caller: rw });
  assert.equal(gone.response.status, 200);
  assert.equal(gone.response.current, hashOf('a'));
  assert.deepEqual(gone.intents, [
    { op: 'destroy', subject: [...f.resources.keys()][0] },
  ]);
  f.apply(gone);
  assert.equal(
    status(f.storage('GET', '/storage/notes/a.txt', { caller: rw })),
    404,
  );
  assert.equal(
    status(
      f.storage('GET', '/storage/notes/a.txt', {
        caller: rw,
        headers: { 'if-match': '"x"' },
      }),
    ),
    412,
  );
});

test('a document and a folder cannot share a path, and folders are not written', () => {
  const f = fixture();
  f.put('/notes/a', 'a');
  assert.equal(status(f.put('/notes/a/b', 'b').verdict), 409);
  f.put('/notes/c/d', 'd');
  assert.equal(status(f.put('/notes/c', 'c').verdict), 409);
  assert.equal(
    status(f.storage('PUT', '/storage/notes/', { caller: f.scopes(['*:rw']) })),
    400,
  );
  assert.equal(
    status(
      f.storage('DELETE', '/storage/notes/', { caller: f.scopes(['*:rw']) }),
    ),
    400,
  );
});

test('folder listings show immediate children with ETags that change with any descendant', () => {
  const f = fixture();
  f.put('/notes/a.txt', 'é', 'text/plain; charset=utf-8');
  f.put('/notes/sub/b.txt', 'b');
  const caller = f.scopes(['notes:r']);
  const listing = f.storage('GET', '/storage/notes/', { caller });
  assert.equal(listing.headers['content-type'], 'application/ld+json');
  const json = JSON.parse(listing.body);
  assert.equal(
    json['@context'],
    'http://remotestorage.io/spec/folder-description',
  );
  assert.deepEqual(Object.keys(json.items), ['a.txt', 'sub/']);
  assert.deepEqual(json.items['a.txt'], {
    ETag: hashOf('é'),
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': 2,
  });
  const sub = f.storage('GET', '/storage/notes/sub/', { caller });
  assert.equal(json.items['sub/'].ETag, sub.headers.etag.slice(1, -1));

  f.put('/notes/sub/b.txt', 'changed');
  const changed = f.storage('GET', '/storage/notes/', { caller });
  assert.notEqual(changed.headers.etag, listing.headers.etag);
  // Conditional folder reads, and an empty folder.
  assert.equal(
    status(
      f.storage('GET', '/storage/notes/', {
        caller,
        headers: { 'if-none-match': changed.headers.etag },
      }),
    ),
    304,
  );
  assert.equal(
    status(
      f.storage('GET', '/storage/notes/', {
        caller,
        headers: { 'if-match': '"old"' },
      }),
    ),
    412,
  );
  assert.deepEqual(
    JSON.parse(f.storage('GET', '/storage/notes/none/', { caller }).body).items,
    {},
  );
  assert.equal(f.storage('HEAD', '/storage/notes/', { caller }).body, '');
  // The root listing shows categories as folders.
  assert.deepEqual(
    Object.keys(
      JSON.parse(
        f.storage('GET', '/storage/', { caller: f.scopes(['*:r']) }).body,
      ).items,
    ),
    ['notes/'],
  );
});

test('imported text documents are served and listed, but not overwritten over remoteStorage', () => {
  const f = fixture([document('/notes/imported.txt', 'é\r\n🌍')]);
  const caller = f.scopes(['notes:rw']);
  const read = f.storage('GET', '/storage/notes/imported.txt', { caller });
  assert.equal(read.status, 200);
  assert.equal(read.body, 'é\r\n🌍');
  assert.match(read.headers.etag, /^"[a-f0-9]{64}"$/);
  assert.equal(
    status(
      f.storage('GET', '/storage/notes/imported.txt', {
        caller,
        headers: { 'If-None-Match': read.headers.etag },
      }),
    ),
    304,
  );
  assert.equal(
    JSON.parse(f.storage('GET', '/storage/notes/', { caller }).body).items[
      'imported.txt'
    ].ETag,
    read.headers.etag.slice(1, -1),
  );
  assert.equal(
    status(f.put('/notes/imported.txt', 'x', 'text/plain', caller).verdict),
    409,
  );
  assert.equal(
    status(f.storage('DELETE', '/storage/notes/imported.txt', { caller })),
    409,
  );
  // A local edit in Atomic: 503 rather than an outdated text, and left out of listings.
  [...f.resources.values()][0][P.content] = 'local edit';
  assert.equal(
    status(f.storage('GET', '/storage/notes/imported.txt', { caller })),
    503,
  );
  assert.deepEqual(
    JSON.parse(f.storage('GET', '/storage/notes/', { caller }).body).items,
    {},
  );
});

test('imports never replace a document an app stored', () => {
  const f = fixture();
  f.put('/notes/a.txt', 'from an app');
  const result = f.proposal([document('/notes/a.txt', 'imported')]);
  assert.deepEqual(result.intents, []);
  assert.match(result.problems[0].message, /stored by a remoteStorage app/);
});

test('host failures are a 503 that says nothing about the data', () => {
  const f = fixture();
  f.put('/notes/a.txt', 'a');
  const failing = {
    ...f.ctx,
    trigger: { route: 'storage-read' },
    read: () => {
      throw Error('private key in error');
    },
  };
  const answer = handle(failing, {
    method: 'GET',
    path: '/storage/notes/',
    caller: f.scopes(['notes:r']),
    headers: {},
    base: BASE,
  });
  assert.equal(answer.status, 503);
  assert.doesNotMatch(answer.body, /private key/);
});

test('records outside the folder, or whose URL and identity disagree, are not documents', () => {
  const f = fixture();
  f.put('/notes/a.txt', 'a');
  const [subject, resource] = [...f.resources][0];
  f.resources.set(subject, {
    ...resource,
    [P.parent]: 'https://elsewhere.example.test/x',
  });
  const caller = f.scopes(['notes:r']);
  assert.equal(
    status(f.storage('GET', '/storage/notes/a.txt', { caller })),
    404,
  );
  f.resources.set(subject, {
    ...resource,
    [P.downloadURL]: BASE + '/storage/notes/b.txt',
  });
  assert.deepEqual(
    JSON.parse(f.storage('GET', '/storage/notes/', { caller }).body).items,
    {},
  );
  // A document whose own path has a `storage` segment.
  f.put('/notes/storage/c.txt', 'c');
  assert.deepEqual(
    Object.keys(
      JSON.parse(f.storage('GET', '/storage/notes/storage/', { caller }).body)
        .items,
    ),
    ['c.txt'],
  );
});

test('path validation refuses traversal and encoded separators but supports Unicode URL encoding', () => {
  const f = fixture();
  f.put('/public/notes/é.txt', 'x');
  assert.equal(
    f.storage('GET', '/storage/public/notes/%C3%A9.txt').response.blob,
    hashOf('x'),
  );
  for (const suffix of [
    '../secret',
    '%2e%2e/secret',
    'a%2Fb',
    'a%5Cb',
    '%252e%252e/secret',
    'a//b',
    'bad%GG',
  ])
    assert.equal(
      status(f.storage('GET', '/storage/public/notes/' + suffix)),
      400,
      suffix,
    );
  assert.deepEqual(storagePath('/storage/'), {
    path: '/',
    pieces: [],
    folder: true,
  });
  assert.equal(storagePath('/storage/a/b/').path, '/a/b/');
});

test('unsafe JSON object member names survive folder serialization as ordinary keys', () => {
  const f = fixture();
  f.put('/notes/__proto__', 'x');
  const items = JSON.parse(
    f.storage('GET', '/storage/notes/', { caller: f.scopes(['notes:r']) }).body,
  ).items;
  assert.equal(Object.hasOwn(items, '__proto__'), true);
});

test('malformed conditions are a 400', () => {
  const f = fixture();
  f.put('/notes/a.txt', 'a');
  assert.equal(
    status(
      f.storage('GET', '/storage/notes/', {
        caller: f.scopes(['notes:r']),
        headers: { 'if-none-match': 'garbage' },
      }),
    ),
    400,
  );
});

// -- the importer (reviewed jobs, unchanged contract) ----------------------------

test('import uses actual create intent shape and exact UTF-8 source in editable description atoms', () => {
  const f = fixture(),
    doc = document('/notes/a.txt', 'é\r\n🌍');
  const verdict = f.proposal([doc]),
    [intent] = verdict.intents;
  assert.deepEqual(verdict.problems, []);
  assert.equal(intent.op, 'create');
  assert.equal(intent.parent, table);
  assert.deepEqual(intent.isA, []);
  assert.equal(intent.set[P.localId], documentKey('/notes/a.txt'));
  assert.equal(intent.set[P.baseline].text, doc.text);
  assert.equal(intent.set[P.content], doc.text);
});

test('idempotent import and source update target persistent Atomic identity', () => {
  const f = fixture([document()]);
  assert.deepEqual(f.proposal([document()]).intents, []);
  const update = f.proposal([document(undefined, 'changed')]);
  assert.equal(update.intents[0].op, 'set');
  assert.equal(update.intents[0].subject, [...f.resources.keys()][0]);
  f.apply(update);
  assert.equal(f.storage('GET', '/storage/public/notes/a.txt').body, 'changed');
});

test('local text atom edits block overwrite', () => {
  const f = fixture([document()]);
  [...f.resources.values()][0][P.content] = 'local edit';
  const result = f.proposal([document(undefined, 'remote edit')]);
  assert.deepEqual(result.intents, []);
  assert.match(result.problems[0].message, /Local document edits/);
});

test('an error in a batch yields no partial import intents', () => {
  const f = fixture();

  for (const bad of [
    document('/notes/../a'),
    document('/notes/a%2fb'),
    { ...document('/notes/blob'), contentType: 'image/png' },
    { ...document('/notes/html'), contentType: 'text/html' },
    { ...document('/notes/a'), text: '\ud800' },
  ]) {
    const result = f.proposal([document(), bad]);
    assert.deepEqual(result.intents, []);
    assert.equal(result.problems[0].severity, 'error');
  }

  assert.equal(f.proposal([document(), document()]).problems.length, 1);
});

test('persistent file-folder collisions and duplicate identities fail closed', () => {
  const f = fixture([document('/public/notes/a')]);
  assert.equal(f.proposal([document('/public/notes/a/b')]).problems.length, 1);
  f.resources.set(table + '/dup', { ...[...f.resources.values()][0] });
  assert.equal(f.proposal([document('/public/notes/a')]).problems.length, 1);
});

test('canonical Atomic parents and resource IDs support imports, updates and reads', () => {
  const parent = 'atomic:' + Buffer.alloc(64, 1).toString('base64');
  const subject = 'atomic:' + Buffer.alloc(64, 2).toString('base64');
  const f = fixture();
  f.ctx.config = { table: parent };
  const created = f.proposal([document()]);
  assert.deepEqual(created.problems, []);
  assert.equal(created.intents[0].parent, parent);
  f.resources.set(subject, { [P.parent]: parent, ...created.intents[0].set });
  assert.equal(f.storage('GET', '/storage/public/notes/a.txt').body, 'hello');
  assert.deepEqual(f.proposal([document()]).intents, []);
  assert.equal(
    f.proposal([document(undefined, 'changed')]).intents[0].subject,
    subject,
  );
});

test('empty, legacy-link and control-containing parent subjects are refused', () => {
  for (const parent of [
    'atomic:',
    'atomic:?drive=x',
    'atomic://host/path',
    'atomic:bad\nvalue',
    'did:ad:',
    'https://',
  ]) {
    const f = fixture();
    f.ctx.config = { table: parent };
    assert.match(
      f.proposal([document()]).problems[0].message,
      /parent subject/,
    );
    assert.equal(status(f.storage('GET', '/storage/public/notes/a.txt')), 503);
  }
});

test('import baselines carry source values and the observed previous values for host commit checks', () => {
  const f = fixture();
  const first = f.proposal([document()]);
  const source = { [P.name]: 'a.txt', [P.content]: 'hello' };
  assert.deepEqual(first.intents[0].set[P.baseline].values, source);
  assert.deepEqual(first.intents[0].set[P.baseline].previous, {});
  f.apply(first);
  const update = f.proposal([document(undefined, 'second')]);
  assert.deepEqual(update.intents[0].set[P.baseline].previous, source);
  assert.deepEqual(update.intents[0].set[P.baseline].values, {
    ...source,
    [P.content]: 'second',
  });
  f.apply(update);
  assert.deepEqual(f.proposal([document(undefined, 'second')]).intents, []);
  const third = f.proposal([document(undefined, 'third')]);
  assert.deepEqual(
    third.intents[0].set[P.baseline].previous,
    update.intents[0].set[P.baseline].values,
  );
  // A held preview keeps the original source snapshot so the host can reject
  // it if another import updates the baseline before Apply.
  assert.deepEqual(update.intents[0].set[P.baseline].previous, source);
});

test('local name edits and malformed legacy source baselines require review', () => {
  for (const mutate of [
    row => {
      row[P.name] = 'local title';
    },
    row => {
      delete row[P.baseline].values;
    },
    row => {
      row[P.baseline].values[P.content] = 'tampered';
    },
  ]) {
    const f = fixture([document()]);
    mutate([...f.resources.values()][0]);
    const result = f.proposal([document(undefined, 'remote update')]);
    assert.deepEqual(result.intents, []);
    assert.match(result.problems[0].message, /review/);
  }
});

test('bundle is deterministic, self-contained and executable without Node host APIs', async () => {
  execFileSync(process.execPath, [
    new URL('./build.mjs', import.meta.url).pathname,
    '--check',
  ]);
  const source = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(
    source,
    /\b(?:require\(|Buffer\.|fetch\(|process\.|crypto\.|new URL\()/,
  );
  const bundle = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  assert.equal(bundle.sha256('abc'), sha256('abc'));
  const f = fixture();
  f.put('/public/notes/a.txt', 'a');
  assert.equal(
    bundle.handle(
      { ...f.ctx, trigger: { route: 'storage-read' } },
      {
        method: 'GET',
        path: '/storage/public/notes/a.txt',
        headers: {},
        caller: null,
      },
    ).response.blob,
    hashOf('a'),
  );
});
