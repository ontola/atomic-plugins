import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  handle,
  run,
  manifest,
  P,
  etag,
  sha256hex,
  accessModes,
  podPath,
  parseTurtle,
  parseN3Patch,
  parseSparqlUpdate,
  applyPatch,
  parseTriples,
} from './plugin.mjs';

const BASE = 'http://pod.routes.example';
const STORAGE = 'https://atomic.example/pod';
const ALICE = 'https://id.example/alice#me';
const BOB = 'https://id.example/bob#me';
const LDP = 'http://www.w3.org/ns/ldp#';

/**
 * A host double: atoms keyed by subject, `ctx.query`/`ctx.read` as the
 * route's principal sees them, and the verdict's intents applied the way
 * the host's route writes apply them. It models the documented ctx and
 * intent shapes; it is not the host.
 */
class Host {
  constructor(
    access = { owners: [ALICE], public: ['read'] },
    publicAtoms = true,
  ) {
    this.atoms = new Map();
    this.config = { storage: STORAGE, access };
    this.publicAtoms = publicAtoms;
    this.count = 0;
    this.applied = [];
  }

  ctx(caller) {
    const visible = () => caller || this.publicAtoms;

    return {
      config: this.config,
      query: (property, value) =>
        visible()
          ? [...this.atoms]
              .filter(([, a]) => a[property] === value)
              .map(([s]) => s)
          : [],
      read: subject => {
        const atom = this.atoms.get(subject);
        if (!atom || !visible()) throw new Error('not found');

        return { ...atom };
      },
    };
  }

  apply(intents) {
    for (const intent of intents) {
      if (intent.op === 'create') {
        assert.equal(intent.parent, STORAGE);
        assert.deepEqual(intent.isA, [
          'https://atomicdata.dev/classes/PlainText',
        ]);
        this.atoms.set(`https://atomic.example/atoms/${++this.count}`, {
          ...intent.set,
          [P.parent]: intent.parent,
        });
      } else if (intent.op === 'set') {
        Object.assign(this.atoms.get(intent.subject), intent.set);
      } else if (intent.op === 'destroy') {
        assert.ok(this.atoms.delete(intent.subject));
      } else assert.fail(`unexpected intent ${intent.op}`);
    }
  }

  send(method, path, { caller = null, headers = {}, body = null } = {}) {
    const verdict = handle(this.ctx(caller), {
      method,
      path,
      base: BASE,
      url: BASE + path,
      headers,
      body,
      caller: caller && { scheme: 'dpop', webid: caller },
      receivedAt: 1_800_000_000_000 + this.count,
    });
    const response = verdict.response ?? verdict;

    if (verdict.intents) {
      assert.ok(caller, 'an anonymous request never writes');
      assert.ok(
        response.status < 300,
        `writes come with a 2xx, not ${response.status}`,
      );
      this.applied.push(...verdict.intents);
      this.apply(verdict.intents);
    }

    return response;
  }

  paths() {
    return [...this.atoms.values()].map(a => a[P.localId]).sort();
  }
}

const turtle =
  '@prefix ex: <https://example.org/> .\n<#it> ex:name "Alice"@en ; a ex:Person .';

test('manifest: an installation-origin pod whose routes need DPoP and write only into storage', () => {
  assert.equal(manifest.http.mount, 'installation-origin');
  assert.deepEqual(manifest.http.writeTargets, [
    {
      id: 'storage',
      parent: 'config:storage',
      classes: ['https://atomicdata.dev/classes/PlainText'],
    },
  ]);

  for (const route of manifest.http.routes) {
    assert.equal(route.auth, 'dpop');
    assert.equal(route.principal, 'installation');
    assert.deepEqual(route.writes, ['storage']);
    assert.equal(route.cors, 'any-origin-no-credentials');
    // Public reads and the pod's own 401 need token-less requests.
    assert.equal(route.authOptional, true);
  }

  assert.deepEqual(manifest.http.routes[0].methods, ['GET', 'HEAD', 'POST']);
});

test('the owner creates a resource and its containers; anyone reads it', () => {
  const host = new Host();
  const created = host.send('PUT', '/notes/2026/a.ttl', {
    caller: ALICE,
    headers: { 'content-type': 'text/turtle; charset=utf-8' },
    body: turtle,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(host.paths(), [
    'solid:/notes/',
    'solid:/notes/2026/',
    'solid:/notes/2026/a.ttl',
  ]);

  const read = host.send('GET', '/notes/2026/a.ttl', {
    headers: { accept: 'text/turtle' },
  });
  assert.equal(read.status, 200);
  assert.equal(read.body, turtle);
  assert.equal(read.headers['content-type'], 'text/turtle');
  assert.equal(read.headers['wac-allow'], 'user="read",public="read"');
  assert.ok(read.headers.link.includes(`<${LDP}RDFSource>; rel="type"`));
  assert.match(read.headers.etag, /^"[0-9a-f]{32}"$/);

  const jsonld = host.send('GET', '/notes/2026/a.ttl', {
    headers: { accept: 'application/ld+json' },
  });
  assert.deepEqual(JSON.parse(jsonld.body), [
    {
      '@id': `${BASE}/notes/2026/a.ttl#it`,
      'https://example.org/name': [{ '@value': 'Alice', '@language': 'en' }],
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type': [
        { '@id': 'https://example.org/Person' },
      ],
    },
  ]);
  assert.notEqual(jsonld.headers.etag, read.headers.etag);

  const container = host.send('GET', '/notes/', { caller: ALICE });
  assert.equal(container.status, 200);
  assert.equal(
    container.headers['wac-allow'],
    'user="read append write",public="read"',
  );
  assert.ok(
    container.headers.link.includes(`<${LDP}BasicContainer>; rel="type"`),
  );
  const graph = parseTurtle(container.body);
  assert.deepEqual(graph[0][`${LDP}contains`], [
    { '@id': `${BASE}/notes/2026/` },
  ]);

  const root = host.send('GET', '/');
  assert.ok(
    root.headers.link.includes(
      '<http://www.w3.org/ns/pim/space#Storage>; rel="type"',
    ),
  );
  assert.deepEqual(parseTurtle(root.body)[0][`${LDP}contains`], [
    { '@id': `${BASE}/notes/` },
  ]);
});

test('WAC: anonymous callers get 401, other WebIDs 403, readers read only', () => {
  const host = new Host({ owners: [ALICE], readers: [BOB] });
  host.send('PUT', '/a.txt', {
    caller: ALICE,
    headers: { 'content-type': 'text/plain' },
    body: 'hi',
  });
  const anonymous = host.send('GET', '/a.txt');
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers['www-authenticate'], /^DPoP /);
  assert.equal(anonymous.headers['wac-allow'], 'user="",public=""');
  assert.equal(
    host.send('PUT', '/b.txt', {
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    }).status,
    401,
  );

  const bob = host.send('GET', '/a.txt', { caller: BOB });
  assert.equal(bob.status, 200);
  assert.equal(bob.body, 'hi');
  assert.equal(bob.headers['wac-allow'], 'user="read",public=""');
  const denied = host.send('PUT', '/a.txt', {
    caller: BOB,
    headers: { 'content-type': 'text/plain' },
    body: 'overwritten',
  });
  assert.equal(denied.status, 403);
  assert.equal(host.send('DELETE', '/a.txt', { caller: BOB }).status, 403);
  assert.equal(
    host.send('GET', '/a.txt', { caller: 'https://id.example/eve#me' }).status,
    403,
  );
  assert.deepEqual(host.paths(), ['solid:/a.txt']);
  assert.deepEqual(
    [...accessModes({ access: { appenders: [BOB] } }, { webid: BOB }).user],
    ['append'],
  );
});

test('conditional writes: If-None-Match * creates only, If-Match needs the current strong ETag', () => {
  const host = new Host();
  const put = (headers, body) =>
    host.send('PUT', '/doc.ttl', {
      caller: ALICE,
      headers: { 'content-type': 'text/turtle', ...headers },
      body,
    });
  assert.equal(put({ 'if-match': '*' }, turtle).status, 412);
  assert.equal(put({ 'if-none-match': '*' }, turtle).status, 201);
  assert.equal(put({ 'if-none-match': '*' }, turtle).status, 412);
  const tag = host.send('GET', '/doc.ttl').headers.etag;
  assert.equal(tag, etag('text/turtle', turtle));
  assert.equal(put({ 'if-match': `W/${tag}` }, '<#a> <#b> <#c> .').status, 412);
  assert.equal(put({ 'if-match': '"stale"' }, '<#a> <#b> <#c> .').status, 412);
  assert.equal(put({ 'if-match': tag }, '<#a> <#b> <#c> .').status, 204);
  assert.equal(host.send('GET', '/doc.ttl').body, '<#a> <#b> <#c> .');
  assert.equal(
    host.send('GET', '/doc.ttl', { headers: { 'if-none-match': tag } }).status,
    200,
  );
  const now = host.send('GET', '/doc.ttl').headers.etag;
  assert.equal(
    host.send('GET', '/doc.ttl', { headers: { 'if-none-match': now } }).status,
    304,
  );
  assert.equal(host.send('HEAD', '/doc.ttl').body, '');
});

test('POST names new resources from Slug, and makes containers on request', () => {
  const host = new Host();
  const made = host.send('POST', '/', {
    caller: ALICE,
    headers: { 'content-type': 'text/plain', slug: 'hello world.txt' },
    body: 'hello',
  });
  assert.equal(made.status, 201);
  assert.equal(made.headers.location, `${BASE}/hello-world.txt`);
  const again = host.send('POST', '/', {
    caller: ALICE,
    headers: { 'content-type': 'text/plain', slug: 'hello world.txt' },
    body: 'second',
  });
  assert.notEqual(again.headers.location, made.headers.location);
  const container = host.send('POST', '/', {
    caller: ALICE,
    headers: {
      slug: 'photos',
      link: '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
  });
  assert.equal(container.headers.location, `${BASE}/photos/`);
  assert.equal(host.send('GET', '/photos/').status, 200);
  assert.equal(
    host.send('POST', '/missing/', {
      caller: ALICE,
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    }).status,
    404,
  );
  assert.equal(
    host.send('POST', '/', { caller: ALICE, body: 'x' }).status,
    415,
  );
  assert.equal(
    host.send('POST', '/', {
      caller: ALICE,
      headers: { 'content-type': 'text/turtle' },
      body: '<a> <b> ',
    }).status,
    400,
  );
});

test('N3 Patch inserts, deletes and binds solid:where exactly once', () => {
  const host = new Host();
  host.send('PUT', '/card.ttl', {
    caller: ALICE,
    headers: { 'content-type': 'text/turtle' },
    body: '@prefix ex: <https://example.org/>.\n<#me> ex:givenName "Claudia"; ex:familyName "Garcia".',
  });
  const patch = body =>
    host.send('PATCH', '/card.ttl', {
      caller: ALICE,
      headers: { 'content-type': 'text/n3' },
      body,
    });
  const rename = `@prefix solid: <http://www.w3.org/ns/solid/terms#>. @prefix ex: <https://example.org/>.
_:rename a solid:InsertDeletePatch;
  solid:where   { ?person ex:familyName "Garcia". };
  solid:inserts { ?person ex:givenName "Alex". };
  solid:deletes { ?person ex:givenName "Claudia". }.`;
  assert.equal(patch(rename).status, 204);
  const graph = parseTurtle(host.send('GET', '/card.ttl').body);
  assert.deepEqual(graph[0]['https://example.org/givenName'], [
    { '@value': 'Alex' },
  ]);
  // The delete is no longer there: 409, nothing changes.
  const before = host.send('GET', '/card.ttl').body;
  assert.equal(patch(rename).status, 409);
  assert.equal(host.send('GET', '/card.ttl').body, before);
  assert.equal(patch('not n3 {').status, 422);
  assert.equal(
    patch(`@prefix solid: <http://www.w3.org/ns/solid/terms#>.
_:p a solid:InsertDeletePatch; solid:inserts { ?x <urn:p> "o" }.`).status,
    422,
  );
  // PATCH may create an RDF resource.
  const created = host.send('PATCH', '/new.ttl', {
    caller: ALICE,
    headers: { 'content-type': 'text/n3' },
    body: `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
_:p a solid:InsertDeletePatch; solid:inserts { <#a> <urn:p> "o", [ <urn:q> 1 ] }.`,
  });
  assert.equal(created.status, 201);
  assert.equal(parseTriples(host.send('GET', '/new.ttl').body).length, 3);
  // Plain text is not RDF.
  host.send('PUT', '/t.txt', {
    caller: ALICE,
    headers: { 'content-type': 'text/plain' },
    body: 'x',
  });
  assert.equal(
    host.send('PATCH', '/t.txt', {
      caller: ALICE,
      headers: { 'content-type': 'text/n3' },
      body: `@prefix solid: <http://www.w3.org/ns/solid/terms#>. _:p a solid:InsertDeletePatch; solid:inserts { <#a> <urn:p> "o" }.`,
    }).status,
    415,
  );
});

test('SPARQL Update INSERT DATA / DELETE DATA, as solid-client sends them', () => {
  const host = new Host();
  host.send('PUT', '/list.ttl', {
    caller: ALICE,
    headers: { 'content-type': 'text/turtle' },
    body: '<https://example.org/s> <https://example.org/p> "old" .',
  });
  const result = host.send('PATCH', '/list.ttl', {
    caller: ALICE,
    headers: { 'content-type': 'application/sparql-update' },
    body: 'DELETE DATA {<https://example.org/s> <https://example.org/p> "old".};\nINSERT DATA {<https://example.org/s> <https://example.org/p> "new"@en.};',
  });
  assert.equal(result.status, 204);
  assert.deepEqual(parseTurtle(host.send('GET', '/list.ttl').body), [
    {
      '@id': 'https://example.org/s',
      'https://example.org/p': [{ '@value': 'new', '@language': 'en' }],
    },
  ]);
  assert.throws(
    () => parseSparqlUpdate('DELETE WHERE { ?s ?p ?o }', BASE),
    /INSERT DATA/,
  );
  assert.throws(
    () => parseSparqlUpdate('DELETE DATA { _:b <urn:p> "o" }', BASE),
    /blank/,
  );
  // A reader cannot patch; an appender may insert but not delete.
  const appender = new Host({ owners: [ALICE], appenders: [BOB] });
  appender.send('PUT', '/l.ttl', {
    caller: ALICE,
    headers: { 'content-type': 'text/turtle' },
    body: '<urn:s> <urn:p> "o" .',
  });
  const insert = 'INSERT DATA { <urn:s> <urn:p> "x" . }';
  assert.equal(
    appender.send('PATCH', '/l.ttl', {
      caller: BOB,
      headers: { 'content-type': 'application/sparql-update' },
      body: insert,
    }).status,
    204,
  );
  assert.equal(
    appender.send('PATCH', '/l.ttl', {
      caller: BOB,
      headers: { 'content-type': 'application/sparql-update' },
      body: 'DELETE DATA { <urn:s> <urn:p> "x" . }',
    }).status,
    403,
  );
});

test('DELETE removes resources and only empty containers; the root stays', () => {
  const host = new Host();
  host.send('PUT', '/box/a.txt', {
    caller: ALICE,
    headers: { 'content-type': 'text/plain' },
    body: 'a',
  });
  assert.equal(host.send('DELETE', '/box/', { caller: ALICE }).status, 409);
  assert.equal(
    host.send('DELETE', '/box/a.txt', { caller: ALICE }).status,
    204,
  );
  assert.equal(host.send('GET', '/box/a.txt').status, 404);
  assert.equal(host.send('DELETE', '/box/', { caller: ALICE }).status, 204);
  assert.equal(host.send('DELETE', '/', { caller: ALICE }).status, 405);
  assert.deepEqual(host.paths(), []);
  // A document and a container cannot share a name.
  host.send('PUT', '/x', {
    caller: ALICE,
    headers: { 'content-type': 'text/plain' },
    body: 'x',
  });
  assert.equal(
    host.send('PUT', '/x/y', {
      caller: ALICE,
      headers: { 'content-type': 'text/plain' },
      body: 'y',
    }).status,
    409,
  );
  assert.equal(host.send('PUT', '/x/', { caller: ALICE }).status, 409);
});

test('paths are validated before anything is looked up', () => {
  for (const bad of [
    '/a//b',
    '/a/../b',
    '/a/%2e%2e/b',
    '/a b',
    '/%zz',
    `/${'a/'.repeat(17)}`,
  ])
    assert.throws(() => podPath(bad), bad);
  assert.equal(podPath('/a/b/'), '/a/b/');
  assert.equal(new Host().send('GET', '/a//b').status, 400);
});

test('an unconfigured pod refuses instead of guessing a folder', () => {
  const host = new Host();
  host.config = { access: { public: ['read'] } };
  assert.equal(host.send('GET', '/').status, 503);
});

test('a private pod hides its atoms from anonymous reads even when public read is configured', () => {
  const host = new Host({ owners: [ALICE], public: ['read'] }, false);
  host.send('PUT', '/a.txt', {
    caller: ALICE,
    headers: { 'content-type': 'text/plain' },
    body: 'hi',
  });
  // The host's public principal cannot read the atom: the plugin sees nothing.
  assert.equal(host.send('GET', '/a.txt').status, 404);
  assert.equal(host.send('GET', '/a.txt', { caller: ALICE }).status, 200);
});

test('patch application is exact: blank nodes are renamed, deletes must match', () => {
  const base = parseTriples('<urn:s> <urn:p> "o" .');
  const [op] = parseN3Patch(
    '@prefix solid: <http://www.w3.org/ns/solid/terms#>. _:p a solid:InsertDeletePatch; solid:inserts { <urn:s> <urn:q> [ <urn:r> "x" ] }.',
    BASE,
  );
  const out = applyPatch(base, [op], 't');
  assert.equal(out.length, 3);
  assert.ok(out.some(t => t.s.t === 'bnode' && t.s.v.startsWith('_:t')));
});

test('SHA-256 matches FIPS 180-4 vectors (strong ETags)', () => {
  assert.equal(
    sha256hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    sha256hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
  for (const text of ['', 'é', '😀 over the 64-byte block boundary '.repeat(9)])
    assert.equal(
      sha256hex(text),
      createHash('sha256').update(text).digest('hex'),
    );
});

test('reviewed import emits a create intent that the pod then serves', () => {
  const host = new Host();
  host.config = {
    ...host.config,
    parent: STORAGE,
    document: {
      id: 'hello',
      name: 'Hello',
      mediaType: 'text/plain',
      body: 'Hello from Solid',
    },
  };
  const verdict = run(host.ctx(null));
  assert.equal(verdict.intents[0].set[P.localId], 'solid:/hello');
  host.apply(verdict.intents);
  assert.equal(host.send('GET', '/hello').body, 'Hello from Solid');
  assert.throws(() => run(host.ctx(ALICE)), /already imported/);
});
