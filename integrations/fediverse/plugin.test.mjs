// Node unit tests for the Fediverse plugin's handler, against an in-memory
// host: `ctx.read`/`ctx.query` over a map of resources, a fake `ctx.keys`,
// and the route request shape of atomic-server's route_exec.rs. They check
// the plugin's decisions (what it answers, stores and queues); the host's
// own checks (signatures, write targets, quotas, delivery) are exercised by
// the real-host e2e in e2e/fediverse.spec.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  handle,
  run,
  P,
  C,
  AS,
  PUBLIC,
  PUBLIC_AGENT,
  negotiate,
  text,
  deliverable,
  remoteUrl,
  postIdentity,
} from './plugin.mjs';

const origin = 'https://alice.example';
const actor = `${origin}/ap/actor`;
const profile = 'https://alice.example/profile';
const posts = 'https://alice.example/posts';
const followersFolder = 'https://alice.example/followers';
const replies = 'https://alice.example/replies';
const publisher = 'atomic:agent:AAAAPublisherKeyForTests';
const PEM = '-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n';
const bob = 'https://remote.example/users/bob';
const bobInbox = 'https://remote.example/inbox';
const AT = 1790000000000; // 2026-09-21T14:13:20.000Z

function host(rows = {}, overrides = {}) {
  const data = {
    [profile]: { [P.name]: 'Alice', [P.description]: '<b>Hi</b>' },
    [posts]: { [P.read]: [PUBLIC_AGENT] },
    [followersFolder]: {},
    [replies]: {},
    'https://alice.example/posts/hello': {
      [P.isA]: [C.message],
      [P.parent]: posts,
      [P.description]: 'Hello <script>x</script>\nWorld',
      [P.localId]: '1789000000000-abc',
      secret: 'NO',
    },
    'https://alice.example/posts/doc': {
      [P.isA]: [C.documentV2],
      [P.parent]: posts,
      [P.name]: 'Design',
      [P.createdAt]: 1788000000000,
      'https://atomicdata.dev/properties/documentContent': 'LORO-BYTES',
    },
    'https://alice.example/posts/untimed': {
      [P.isA]: [C.message],
      [P.parent]: posts,
      [P.description]: 'no time',
    },
    ...rows,
  };
  const calls = [];
  const ctx = {
    trigger: { kind: 'http', id: 'http:01k6abcdefghjkmnpqrstvwxyz', at: AT },
    config: {
      origin,
      username: 'alice',
      profile,
      posts,
      followers: followersFolder,
      replies,
      publishers: [publisher],
      ...overrides,
    },
    read(subject) {
      calls.push(['read', subject]);
      if (!(subject in data)) throw new Error('Not found or no access');

      return data[subject];
    },
    query(property, value) {
      calls.push(['query', property, value]);

      return Object.keys(data).filter(s => data[s][property] === value);
    },
    keys: {
      publicKey(name, options) {
        calls.push(['publicKey', name, options]);

        return { publicKeyPem: PEM, keyId: options?.keyId };
      },
      sign() {
        throw new Error('the plugin never signs inline');
      },
    },
  };

  return { ctx, data, calls };
}

function request(method, path, extra = {}) {
  return { method, path, query: {}, headers: {}, ...extra };
}

function json(result, status = 200) {
  const response = result.response ?? result;
  assert.equal(response.status, status, response.body);

  return JSON.parse(response.body);
}

const followerRow = (inboxUrl = bobInbox, name = bob) => ({
  [P.isA]: [C.bookmark],
  [P.parent]: followersFolder,
  [P.name]: name,
  [P.url]: inboxUrl,
});

const signedBy = (owner, sharedInbox = bobInbox) => ({
  keyId: `${owner}#main-key`,
  owner,
  scheme: 'draft-cavage-12',
  alg: 'rsa-v1_5-sha256',
  actor: { id: owner, inbox: `${owner}/inbox`, sharedInbox },
});

function inbox(ctx, activity, caller = signedBy(activity.actor)) {
  return handle(
    ctx,
    request('POST', '/ap/inbox', { body: JSON.stringify(activity), caller }),
  );
}

// -- reads ---------------------------------------------------------------------

test('the actor publishes the host-held public key, inbox, outbox and followers', () => {
  const { ctx, calls } = host();
  const doc = json(handle(ctx, request('GET', '/ap/actor')));
  assert.deepEqual(doc['@context'], [AS, 'https://w3id.org/security/v1']);
  assert.equal(doc.id, actor);
  assert.equal(doc.type, 'Service');
  assert.equal(doc.preferredUsername, 'alice');
  assert.equal(doc.name, 'Alice');
  assert.equal(doc.summary, '&lt;b&gt;Hi&lt;/b&gt;');
  assert.equal(doc.inbox, `${origin}/ap/inbox`);
  assert.equal(doc.outbox, `${origin}/ap/outbox`);
  assert.equal(doc.followers, `${origin}/ap/followers`);
  assert.equal(doc.manuallyApprovesFollowers, false);
  assert.deepEqual(doc.publicKey, {
    id: `${actor}#main-key`,
    owner: actor,
    publicKeyPem: PEM,
  });
  assert.deepEqual(
    calls.find(c => c[0] === 'publicKey'),
    ['publicKey', 'actor-key', { keyId: `${actor}#main-key` }],
  );
});

test('posts project only selected fields, escaped, newest first', () => {
  const { ctx } = host();
  const outbox = json(handle(ctx, request('GET', '/ap/outbox')));
  assert.equal(outbox.type, 'OrderedCollection');
  // The untimed Message is not a post.
  assert.equal(outbox.totalItems, 2);
  const page = json(
    handle(ctx, request('GET', '/ap/outbox', { query: { page: '1' } })),
  );
  assert.deepEqual(
    page.orderedItems.map(a => a.object.id),
    [
      `${origin}/ap/objects/1789000000000-abc`,
      `${origin}/ap/objects/${createHash('sha256').update('https://alice.example/posts/doc').digest('hex').slice(0, 32)}`,
    ],
  );
  const note = page.orderedItems[0];
  assert.equal(note.type, 'Create');
  assert.equal(note.id, `${origin}/ap/activities/1789000000000-abc`);
  assert.equal(note.published, new Date(1789000000000).toISOString());
  assert.deepEqual(note.to, [PUBLIC]);
  assert.deepEqual(note.cc, [`${origin}/ap/followers`]);
  assert.equal(
    note.object.content,
    '<p>Hello &lt;script&gt;x&lt;/script&gt;<br>World</p>',
  );
  const article = page.orderedItems[1].object;
  assert.equal(article.type, 'Article');
  assert.equal(article.published, new Date(1788000000000).toISOString());
  assert.doesNotMatch(JSON.stringify(page), /LORO-BYTES|"NO"/);

  const object = json(
    handle(ctx, request('GET', '/ap/objects/1789000000000-abc')),
  );
  assert.equal(object['@context'], AS);
  assert.equal(object.attributedTo, actor);
  const activity = json(
    handle(ctx, request('GET', '/ap/activities/1789000000000-abc')),
  );
  assert.equal(activity.object.id, object.id);
  assert.equal(handle(ctx, request('GET', '/ap/objects/missing')).status, 404);
});

test('post identity: stamped ids carry their time exactly; others need createdAt', () => {
  assert.deepEqual(postIdentity('x', { [P.localId]: '1790000000123-k9' }), {
    id: '1790000000123-k9',
    published: '2026-09-21T14:13:20.123Z',
  });
  assert.equal(postIdentity('x', { [P.localId]: 'slug' }), undefined);
  assert.equal(
    postIdentity('x', { [P.localId]: 'slug', [P.createdAt]: 1 }).id,
    'slug',
  );
});

test('the followers collection publishes a count, never who', () => {
  const { ctx } = host({ 'https://alice.example/f1': followerRow() });
  const doc = json(handle(ctx, request('GET', '/ap/followers')));
  assert.equal(doc.totalItems, 1);
  assert.doesNotMatch(JSON.stringify(doc), /remote\.example/);
});

test('WebFinger answers only for this account, with rel filtering', () => {
  const { ctx } = host();
  const q = query =>
    handle(
      ctx,
      request('GET', '/.well-known/webfinger', {
        wellKnown: 'webfinger',
        query,
      }),
    );
  const found = q({ resource: 'acct:alice@alice.example' });
  assert.equal(found.headers['content-type'], 'application/jrd+json');
  assert.deepEqual(JSON.parse(found.body), {
    subject: 'acct:alice@alice.example',
    aliases: [actor],
    links: [{ rel: 'self', type: 'application/activity+json', href: actor }],
  });
  assert.equal(
    json(q({ resource: actor })).subject,
    'acct:alice@alice.example',
  );
  assert.deepEqual(
    json(q({ resource: 'acct:alice@alice.example', rel: 'other' })).links,
    [],
  );
  assert.equal(q({ resource: 'acct:bob@alice.example' }).status, 404);
  assert.equal(q({}).status, 400);
});

test('NodeInfo says activitypub and counts public posts', () => {
  const { ctx } = host();
  const links = json(
    handle(
      ctx,
      request('GET', '/.well-known/nodeinfo', { wellKnown: 'nodeinfo' }),
    ),
  );
  assert.equal(links.links[0].href, `${origin}/nodeinfo/2.1`);
  const info = json(handle(ctx, request('GET', '/nodeinfo/2.1')));
  assert.deepEqual(info.protocols, ['activitypub']);
  assert.equal(info.usage.localPosts, 2);
  assert.equal(info.openRegistrations, false);
});

test('content negotiation, HEAD and conditional requests', () => {
  const { ctx } = host();
  assert.equal(
    negotiate('application/activity+json'),
    'application/activity+json',
  );
  assert.match(negotiate('application/ld+json; profile="x"'), /ld\+json/);
  assert.equal(negotiate('text/html'), undefined);
  assert.equal(negotiate('*/*;q=0'), undefined);
  assert.equal(
    handle(
      ctx,
      request('GET', '/ap/actor', { headers: { accept: 'text/html' } }),
    ).status,
    406,
  );
  const got = handle(ctx, request('GET', '/ap/actor'));
  const head = handle(ctx, request('HEAD', '/ap/actor'));
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers.etag, got.headers.etag);
  assert.equal(
    handle(
      ctx,
      request('GET', '/ap/actor', {
        headers: { 'if-none-match': got.headers.etag },
      }),
    ).status,
    304,
  );
  assert.equal(
    handle(
      ctx,
      request('GET', '/ap/actor', { headers: { 'if-match': '"nope"' } }),
    ).status,
    412,
  );
});

test('misconfiguration and an unreadable profile fail closed', () => {
  assert.equal(
    handle(
      host({}, { origin: 'http://alice.example' }).ctx,
      request('GET', '/ap/actor'),
    ).status,
    503,
  );
  assert.equal(
    handle(
      host({}, { posts: 'not a subject' }).ctx,
      request('GET', '/ap/actor'),
    ).status,
    503,
  );
  const { ctx, data } = host();
  delete data[profile];
  assert.equal(handle(ctx, request('GET', '/ap/actor')).status, 404);
  // Development origins on localhost may be HTTP.
  assert.equal(
    handle(
      host({}, { origin: 'http://fedi.localhost:19113' }).ctx,
      request('GET', '/ap/actor'),
    ).status,
    200,
  );
});

// -- publishing -------------------------------------------------------------------------

test('a publisher posts a Note: stored under posts, Create queued per shared inbox', () => {
  const { ctx } = host({
    'https://alice.example/f1': followerRow(),
    // Two followers on one server share its inbox: one delivery.
    'https://alice.example/f2': followerRow(
      bobInbox,
      'https://remote.example/users/carol',
    ),
    'https://alice.example/f3': followerRow(
      'https://other.example/inbox',
      'https://other.example/u/dan',
    ),
    // Not deliverable by the manifest's operation: skipped.
    'https://alice.example/f4': followerRow(
      'https://gts.example/users/eve/inbox',
      'https://gts.example/users/eve',
    ),
  });
  const verdict = handle(
    ctx,
    request('POST', '/ap/outbox', {
      caller: { agent: publisher },
      body: JSON.stringify({
        type: 'Create',
        object: { type: 'Note', content: 'First <post>' },
      }),
    }),
  );
  const id = `${AT}-mnpqrstvwxyz`;
  const out = json(verdict, 201);
  assert.equal(out.object, `${origin}/ap/objects/${id}`);
  assert.equal(out.queued, 2);
  assert.equal(verdict.response.headers.location, out.object);
  assert.deepEqual(verdict.intents, [
    {
      op: 'create',
      localId: 'post',
      parent: posts,
      isA: [C.message],
      set: { [P.description]: 'First <post>', [P.localId]: id },
    },
  ]);
  assert.deepEqual(
    verdict.enqueue.map(e => e.url),
    [bobInbox, 'https://other.example/inbox'],
  );
  const job = verdict.enqueue[0];
  assert.equal(job.operation, 'deliver');
  assert.deepEqual(job.sign, { key: 'actor-key', keyId: `${actor}#main-key` });
  assert.equal(job.idempotencyKey, `create:${id}:${bobInbox}`);
  assert.equal(job.body.type, 'Create');
  assert.equal(job.body.object.content, '<p>First &lt;post&gt;</p>');
  assert.equal(job.body.published, new Date(AT).toISOString());
});

test('only publishers post, only Notes, and only into a public folder', () => {
  const post = (ctx, body, caller = { agent: publisher }) =>
    handle(
      ctx,
      request('POST', '/ap/outbox', { caller, body: JSON.stringify(body) }),
    );
  const note = { type: 'Note', content: 'x' };
  assert.equal(
    post(host().ctx, note, { agent: 'atomic:agent:Someone' }).status,
    403,
  );
  assert.equal(post(host().ctx, note, null).status, 403);
  // did:ad: spellings of a publisher are the same agent.
  assert.equal(
    post(host().ctx, note, { agent: 'did:ad:agent:AAAAPublisherKeyForTests' })
      .response.status,
    201,
  );
  assert.equal(post(host().ctx, { type: 'Article', content: 'x' }).status, 400);
  assert.equal(post(host().ctx, { type: 'Note', content: '  ' }).status, 400);
  assert.equal(
    post(host().ctx, { type: 'Note', content: 'x'.repeat(8193) }).status,
    400,
  );
  const { ctx, data } = host();
  data[posts] = {};
  assert.equal(post(ctx, note).status, 409);
});

// -- inbox -----------------------------------------------------------------------------------

const follow = {
  '@context': AS,
  id: 'https://remote.example/follows/1',
  type: 'Follow',
  actor: bob,
  object: actor,
};

test('Follow is accepted automatically: follower stored, signed Accept queued', () => {
  const { ctx } = host();
  const verdict = inbox(ctx, follow);
  assert.equal(verdict.response.status, 202);
  assert.deepEqual(verdict.intents, [
    {
      op: 'create',
      localId: 'follower',
      parent: followersFolder,
      isA: [C.bookmark],
      set: { [P.name]: bob, [P.url]: bobInbox, [P.localId]: follow.id },
    },
  ]);
  assert.equal(verdict.enqueue.length, 1);
  const [job] = verdict.enqueue;
  assert.equal(job.url, bobInbox);
  assert.equal(job.idempotencyKey, `accept:${follow.id}`);
  assert.equal(job.body.type, 'Accept');
  assert.equal(job.body.actor, actor);
  assert.deepEqual(job.body.object, {
    id: follow.id,
    type: 'Follow',
    actor: bob,
    object: actor,
  });
});

test('a repeated Follow is accepted again without a second follower', () => {
  const { ctx } = host({ 'https://alice.example/f1': followerRow() });
  const verdict = inbox(ctx, {
    ...follow,
    id: 'https://remote.example/follows/2',
  });
  assert.deepEqual(verdict.intents, []);
  assert.equal(
    verdict.enqueue[0].idempotencyKey,
    'accept:https://remote.example/follows/2',
  );
});

test('the activity must be from the signer, and its inbox must be deliverable', () => {
  const { ctx } = host();
  assert.equal(
    inbox(ctx, follow, signedBy('https://evil.example/users/mallory')).status,
    401,
  );
  assert.equal(inbox(ctx, follow, null).status, 401);
  // No verified actor document: no inbox to answer.
  assert.equal(
    inbox(ctx, follow, { ...signedBy(bob), actor: undefined }).status,
    422,
  );
  // The host verified another actor's document than the sender's.
  assert.equal(
    inbox(ctx, follow, {
      ...signedBy(bob),
      actor: { id: 'https://x.example/a', inbox: bobInbox },
    }).status,
    422,
  );
  assert.equal(
    inbox(ctx, follow, signedBy(bob, 'https://remote.example/users/bob/inbox'))
      .status,
    422,
  );
  assert.equal(
    inbox(ctx, { ...follow, object: 'https://else.example/actor' }).response
      ?.status ?? 202,
    202,
  );
  assert.equal(
    handle(
      ctx,
      request('POST', '/ap/inbox', { body: '{', caller: signedBy(bob) }),
    ).status,
    400,
  );
  assert.equal(inbox(ctx, { type: 'Follow', actor: bob }).status, 400);
});

test('Undo(Follow) and Delete of the actor remove the follower', () => {
  const rows = { 'https://alice.example/f1': followerRow() };
  const undo = inbox(host(rows).ctx, {
    id: 'https://remote.example/undo/1',
    type: 'Undo',
    actor: bob,
    object: follow,
  });
  assert.deepEqual(undo.intents, [
    { op: 'destroy', subject: 'https://alice.example/f1' },
  ]);
  const gone = inbox(host(rows).ctx, {
    id: 'https://remote.example/delete/1',
    type: 'Delete',
    actor: bob,
    object: bob,
  });
  assert.deepEqual(gone.intents, [
    { op: 'destroy', subject: 'https://alice.example/f1' },
  ]);
  // Another actor cannot undo bob's follow: their Undo removes nothing of bob's.
  const carol = 'https://remote.example/users/carol';
  const other = inbox(host(rows).ctx, {
    id: 'https://remote.example/undo/2',
    type: 'Undo',
    actor: carol,
    object: { ...follow, actor: carol },
  });
  assert.deepEqual(other.intents, []);
});

const replyTo = (target, extra = {}) => ({
  id: 'https://remote.example/activities/9',
  type: 'Create',
  actor: bob,
  object: {
    id: 'https://remote.example/notes/9',
    type: 'Note',
    attributedTo: bob,
    inReplyTo: target,
    content: '<p>Nice &amp; <b>true</b></p><p>second</p>',
    ...extra,
  },
});

test('a reply to one of our posts is stored as a Message, as text', () => {
  const { ctx } = host();
  const verdict = inbox(ctx, replyTo(`${origin}/ap/objects/1789000000000-abc`));
  assert.equal(verdict.response.status, 202);
  assert.deepEqual(verdict.intents, [
    {
      op: 'create',
      localId: 'reply',
      parent: replies,
      isA: [C.message],
      set: {
        [P.description]: 'Nice & true\nsecond',
        [P.name]: bob,
        [P.url]: 'https://remote.example/notes/9',
        [P.replyTo]: 'https://alice.example/posts/hello',
      },
    },
  ]);
  assert.equal(verdict.enqueue, undefined);
});

test('replies: unrelated, duplicate, forged and deleted', () => {
  const stored = {
    'https://alice.example/r1': {
      [P.isA]: [C.message],
      [P.parent]: replies,
      [P.name]: bob,
      [P.url]: 'https://remote.example/notes/9',
    },
  };
  assert.equal(
    inbox(host().ctx, replyTo('https://elsewhere.example/n/1')).intents,
    undefined,
  );
  assert.equal(
    inbox(host().ctx, replyTo(`${origin}/ap/objects/unknown`)).intents,
    undefined,
  );
  assert.equal(
    inbox(host(stored).ctx, replyTo(`${origin}/ap/objects/1789000000000-abc`))
      .intents,
    undefined,
  );
  assert.equal(
    inbox(
      host().ctx,
      replyTo(`${origin}/ap/objects/1789000000000-abc`, {
        attributedTo: 'https://remote.example/users/eve',
      }),
    ).status,
    400,
  );
  assert.equal(
    inbox(
      host().ctx,
      replyTo(`${origin}/ap/objects/1789000000000-abc`, {
        id: 'https://elsewhere.example/n/9',
      }),
    ).status,
    400,
  );
  const deleted = inbox(host(stored).ctx, {
    id: 'https://remote.example/delete/9',
    type: 'Delete',
    actor: bob,
    object: { id: 'https://remote.example/notes/9', type: 'Tombstone' },
  });
  assert.deepEqual(deleted.intents, [
    { op: 'destroy', subject: 'https://alice.example/r1' },
  ]);
  const notTheirs = inbox(
    host(stored).ctx,
    {
      id: 'https://remote.example/delete/10',
      type: 'Delete',
      actor: 'https://remote.example/users/eve',
      object: 'https://remote.example/notes/9',
    },
    signedBy('https://remote.example/users/eve'),
  );
  assert.deepEqual(notTheirs.intents, []);
});

test('other activity types are accepted and ignored', () => {
  const r = inbox(host().ctx, {
    id: 'https://remote.example/l/1',
    type: 'Like',
    actor: bob,
    object: actor,
  });
  assert.equal(r.status, 202);
  assert.equal(r.intents, undefined);
});

// -- helpers ------------------------------------------------------------------------------------

test('HTML to text drops markup and decodes entities', () => {
  assert.equal(
    text('<p>a<br/>b</p><p>&lt;c&gt; &#65;&#x42; &#0;</p>'),
    'a\nb\n<c> AB ',
  );
});

test('deliverable inboxes: HTTPS /inbox only', () => {
  assert.ok(deliverable('https://m.example/inbox'));
  assert.ok(!deliverable('http://m.example/inbox'));
  assert.ok(!deliverable('https://m.example/users/a/inbox'));
  assert.ok(!deliverable('https://m.example/inbox?x'));
  assert.ok(!deliverable('https://user:pw@m.example/inbox'));
  assert.equal(remoteUrl('http://peer.example/x'), undefined);
  assert.equal(remoteUrl('http://localhost:1234/x').host, 'localhost');
});

test('non-route triggers do nothing', () => {
  assert.deepEqual(run(), { intents: [], problems: [] });
});

// -- bundle ------------------------------------------------------------------------------------------

test('plugin.js is the reproducible build of plugin.mjs and manifest.json', async () => {
  const before = await readFile(
    new URL('./plugin.js', import.meta.url),
    'utf8',
  );
  execFileSync(process.execPath, [
    new URL('./build.mjs', import.meta.url).pathname,
  ]);
  const after = await readFile(new URL('./plugin.js', import.meta.url), 'utf8');
  assert.equal(
    after,
    before,
    'run node integrations/fediverse/build.mjs and commit plugin.js',
  );
  const manifest = JSON.parse(
    await readFile(new URL('./manifest.json', import.meta.url), 'utf8'),
  );
  const routes = Object.fromEntries(manifest.http.routes.map(r => [r.id, r]));
  // Everything that writes or queues is authenticated by the host.
  for (const route of Object.values(routes))
    if (route.writes || route.enqueues)
      assert.notEqual(route.auth, 'none', route.id);
  assert.equal(routes.inbox.auth, 'http-signature');
  assert.equal(routes.publish.auth, 'atomic');
  assert.deepEqual(
    manifest.operations.map(o => o.url),
    ['https://*/inbox'],
  );
  const mod = await import(
    new URL('./plugin.js', import.meta.url).href + '?bundle'
  );
  assert.deepEqual(mod.manifest, manifest);
  assert.equal(typeof mod.handle, 'function');
});
