// @wc-ignore-file
/**
 * The Solid plugin as a pod on a real feature-enabled atomic-server, driven
 * by a published Solid client library (@inrupt/solid-client) with DPoP-bound
 * Solid-OIDC tokens from a test issuer (./issuer.ts).
 *
 *   node integrations/tooling/run-lane.mjs solid --tier e2e
 *
 * The lane runs atomic-server with `--plugin-routes read-write`, a routes
 * origin, and `ATOMIC_SOLID_OIDC_ISSUERS` naming the test issuer, which this
 * spec starts on the lane's otherwise unused mock-proxy port. The plugin
 * source is `../plugin.mjs` as-is, published and pinned like any release,
 * and installed with its route-write grant on a fresh storage folder:
 * Alice's WebID owns the pod, Bob's may read, the public may read.
 *
 * Checked: LDP containers and resources through solid-client (create,
 * read, SPARQL Update PATCH, file upload with Slug, delete), N3 Patch,
 * strong-ETag preconditions, WAC-Allow, 401/403 for anonymous and
 * unauthorized callers, tokens the host must refuse, and that what Alice
 * stored is PlainText atoms under the storage folder in the data browser.
 *
 * Not checked: a browser-based Solid app (preflights through the host's
 * CORS layer), a real identity provider's login flow, and binary files.
 *
 * Against a host without `auth: dpop` (the pinned atomic-server before
 * claude/plugin-solid-host) every route answers 501 route-auth-unavailable;
 * the test then skips with that reason instead of failing.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  Agent,
  Store,
  fetchPluginAgent,
  installRelease,
  signRequest,
  signedRequestInit,
} from '@tomic/lib';
import {
  before,
  createFromCatalog,
  getDevDriveSecret,
  SERVER_URL,
} from '../../../browser/e2e/tests/test-utils';
import { startIssuer, type TestIssuer } from './issuer';

// Playwright loads this spec as CommonJS (no package.json with "type"
// above it that it honours), so require() for the client library, which
// lives in this folder's own node_modules (package.json next to this file).
const solid = createRequire(resolve(__dirname, 'package.json'))(
  '@inrupt/solid-client',
) as typeof import('@inrupt/solid-client');

const LEVEL = process.env.PLUGIN_ROUTES_LEVEL ?? '';
const ROUTES_ORIGIN = process.env.PLUGIN_ROUTES_ORIGIN ?? '';
const ISSUER = process.env.ATOMIC_SOLID_OIDC_ISSUERS ?? '';
const SOURCE = readFileSync(resolve(__dirname, '../plugin.mjs'), 'utf8');
const FOAF = 'http://xmlns.com/foaf/0.1/';
const LDP = 'http://www.w3.org/ns/ldp#';

let issuer: TestIssuer;

test.describe('Solid pod', () => {
  test.skip(
    LEVEL !== 'read-write' || !ROUTES_ORIGIN || !ISSUER,
    'run through run-lane.mjs solid, which sets the level, routes origin and issuer',
  );
  test.beforeAll(async () => {
    issuer = await startIssuer(ISSUER);
  });
  test.afterAll(async () => {
    await issuer?.close();
  });
  test.beforeEach(before);

  test('Solid clients read and write an Atomic drive through the pod', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const { pod, storage, installation, agent } = await installPod(page);

    // On failure, the host's run log for the pod says why a route failed.
    try {
      await usePod(page, pod, storage);
    } catch (error) {
      const url = `${SERVER_URL}/plugin-route-status?installation=${encodeURIComponent(installation)}`;
      const status = await fetch(url, {
        headers: await signRequest(url, agent, {}),
      });
      await test.info().attach('route-status.json', {
        body: await status.text(),
        contentType: 'application/json',
      });
      throw error;
    }
  });
});

async function usePod(
  page: import('@playwright/test').Page,
  pod: string,
  storage: string,
) {
  {
    const alice = issuer.session('alice');
    const bob = issuer.session('bob');

    // Probe: a host without `auth: dpop` refuses every request.
    const probe = await fetch(pod);

    if (probe.status === 501) {
      const body = await probe.text();
      test.skip(
        body.includes('route-auth-unavailable'),
        `this atomic-server cannot verify DPoP yet: ${body}`,
      );
    }

    // The storage root: public read, an empty BasicContainer and pim:Storage.
    expect(probe.status, await probe.clone().text()).toBe(200);
    expect(probe.headers.get('wac-allow')).toBe('user="read",public="read"');
    expect(probe.headers.get('link')).toContain(
      '<http://www.w3.org/ns/pim/space#Storage>; rel="type"',
    );
    expect(probe.headers.get('access-control-allow-origin')).toBe('*');
    const root = await solid.getSolidDataset(pod);
    expect(solid.getContainedResourceUrlAll(root)).toEqual([]);

    // Alice creates a container and a document with solid-client.
    const notes = `${pod}notes/`;
    await solid.createContainerAt(notes, { fetch: alice });
    const hello = `${notes}hello.ttl`;
    const me = solid
      .buildThing(solid.createThing({ name: 'me' }))
      .addUrl(
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        `${FOAF}Person`,
      )
      .addStringNoLocale(`${FOAF}name`, 'Alice')
      .build();
    await solid.saveSolidDatasetAt(
      hello,
      solid.setThing(solid.createSolidDataset(), me),
      { fetch: alice },
    );

    // Anyone reads it back through the same library.
    const stored = await solid.getSolidDataset(hello);
    expect(
      solid.getStringNoLocale(
        solid.getThing(stored, `${hello}#me`)!,
        `${FOAF}name`,
      ),
    ).toBe('Alice');
    expect(
      solid.getContainedResourceUrlAll(await solid.getSolidDataset(notes)),
    ).toEqual([hello]);

    // An update is a SPARQL Update PATCH; the owner gets every WAC mode.
    const mine = await solid.getSolidDataset(hello, { fetch: alice });
    expect(solid.getEffectiveAccess(mine).user).toEqual({
      read: true,
      append: true,
      write: true,
    });
    const renamed = solid.setStringNoLocale(
      solid.getThing(mine, `${hello}#me`)!,
      `${FOAF}name`,
      'Alice A.',
    );
    await solid.saveSolidDatasetAt(hello, solid.setThing(mine, renamed), {
      fetch: alice,
    });
    expect(
      solid.getStringNoLocale(
        solid.getThing(await solid.getSolidDataset(hello), `${hello}#me`)!,
        `${FOAF}name`,
      ),
    ).toBe('Alice A.');

    // A text file with a Slug, then read as a file.
    const file = await solid.saveFileInContainer(
      notes,
      new Blob(['Plain words from Alice.'], { type: 'text/plain' }),
      { slug: 'words.txt', fetch: alice },
    );
    const fileUrl = solid.getSourceUrl(file);
    expect(fileUrl).toBe(`${notes}words.txt`);
    expect(await (await solid.getFile(fileUrl)).text()).toBe(
      'Plain words from Alice.',
    );

    // N3 Patch, as the Solid Protocol requires servers to accept it.
    const patched = await alice(hello, {
      method: 'PATCH',
      headers: { 'content-type': 'text/n3' },
      body: `@prefix solid: <http://www.w3.org/ns/solid/terms#>. @prefix foaf: <${FOAF}>.
_:p a solid:InsertDeletePatch;
  solid:where { ?me foaf:name "Alice A." };
  solid:inserts { ?me foaf:nick "al" }.`,
    });
    expect(patched.status, await patched.text()).toBe(204);
    const card = await fetch(hello, {
      headers: { accept: 'application/ld+json' },
    });
    expect(card.headers.get('content-type')).toBe('application/ld+json');
    expect(JSON.stringify(await card.json())).toContain(`"${FOAF}nick"`);

    // Strong ETags guard writes.
    const current = (await fetch(hello)).headers.get('etag')!;
    expect(current).toMatch(/^"[0-9a-f]{32}"$/);
    const stale = await alice(hello, {
      method: 'PUT',
      headers: { 'content-type': 'text/turtle', 'if-match': '"0000"' },
      body: '<#me> <http://xmlns.com/foaf/0.1/name> "Mallory" .',
    });
    expect(stale.status).toBe(412);
    expect(
      (await fetch(hello, { headers: { 'if-none-match': current } })).status,
    ).toBe(304);

    // Bob may read, not write; nobody anonymous may write.
    expect((await bob(hello)).headers.get('wac-allow')).toBe(
      'user="read",public="read"',
    );
    await expect(
      solid.overwriteFile(fileUrl, new Blob(['Bob was here']), {
        contentType: 'text/plain',
        fetch: bob,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const anonymous = await fetch(`${notes}anon.txt`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'no',
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toMatch(/^DPoP /);

    // Tokens the host must refuse before the plugin runs.
    for (const claims of [
      { aud: 'https://app.example/solid-e2e' },
      { exp: Math.floor(Date.now() / 1000) - 3600 },
      { webid: 'https://id.example/nobody#me' },
    ]) {
      const refused = await issuer.session('alice', claims)(hello);
      expect(refused.status, JSON.stringify(claims)).toBe(401);
      expect((await refused.json()).type).toBe('route-unauthorized');
    }

    const bearer = await fetch(hello, {
      headers: { authorization: 'Bearer not-a-dpop-token' },
    });
    expect(bearer.status).toBe(401);

    // What Alice stored is PlainText atoms in the drive, named by path.
    await page.goto(
      new URL(`/app/show?subject=${encodeURIComponent(storage)}`, SERVER_URL)
        .href,
    );
    await expect(
      page.getByRole('main').getByRole('link', { name: '/notes/hello.ttl' }),
    ).toBeVisible({
      timeout: 30_000,
    });

    // Deletes: the file, the document, then the empty container.
    await solid.deleteFile(fileUrl, { fetch: alice });
    await expect(
      solid.deleteContainer(notes, { fetch: alice }),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    await solid.deleteSolidDataset(hello, { fetch: alice });
    await solid.deleteContainer(notes, { fetch: alice });
    expect((await fetch(hello)).status).toBe(404);
    expect(
      solid.getContainedResourceUrlAll(await solid.getSolidDataset(pod)),
    ).toEqual([]);
    const rootTypes = solid.getUrlAll(
      solid.getThing(await solid.getSolidDataset(pod), pod)!,
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    );
    expect(rootTypes).toContain(`${LDP}BasicContainer`);
  }
}

/**
 * Publishes ../plugin.mjs, pins it, and installs it on the test's drive
 * with a fresh, publicly readable storage folder. Returns the pod's root
 * URL and the folder.
 */
async function installPod(page: import('@playwright/test').Page) {
  await createFromCatalog(page, 'Plugin');
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible({ timeout: 45_000 });
  const target = await page.evaluate(
    async ({ code }) => {
      const store = window.store!;
      const plugin = new URL(location.href).searchParams.get('subject')!;
      const resource = await store.getResource(plugin);
      const sourceProp = Object.entries(resource.getPropVals()).find(
        ([, value]) =>
          typeof value === 'string' && value.includes('export function run'),
      )?.[0];
      if (!sourceProp) throw new Error('plugin has no source property');
      await resource.set(sourceProp, code);
      await resource.set('https://atomicdata.dev/properties/name', 'Solid pod');
      await resource.save();
      const drive = store.getDrive();
      if (!drive) throw new Error('no drive');

      return { drive, plugin };
    },
    // Unique per run: a release id is a hash of its content.
    { code: `${SOURCE}\n// run ${Date.now()}\n` },
  );
  const agent = Agent.fromSecret(await getDevDriveSecret(page), 'js');
  const published = await post(agent, '/plugin-release', target);
  expect(published.status, published.text).toBe(200);
  const releaseId = (published.json as { id: string }).id;
  const pinned = await post(agent, '/plugin-release-pin', target);
  expect(pinned.status, pinned.text).toBe(200);
  const catalog = await (await fetch(`${SERVER_URL}/plugin-catalog`)).json();
  const entry = catalog.entries.find(
    (e: { releaseId?: string }) => e.releaseId === releaseId,
  );
  expect(entry, JSON.stringify(catalog.entries)).toBeTruthy();
  expect(entry.requires).toContain('plugin-routes:read-write');

  // Connected: a Store that is not connected saves offline, never to the server.
  const store = new Store({ serverUrl: SERVER_URL, agent });
  const folder = await store.newResource({
    isA: 'https://atomicdata.dev/classes/Folder',
    parent: target.drive,
    propVals: {
      'https://atomicdata.dev/properties/name': 'Solid pod storage',
      'https://atomicdata.dev/properties/displayStyle':
        'https://atomicdata.dev/display-style/list',
    },
  });
  await folder.save();
  const storage = folder.subject;
  const installation = await installRelease(store, {
    drive: target.drive,
    release: { url: entry.release, id: releaseId },
    name: 'solid',
    namespace: 'atomic-plugins',
    config: {
      storage,
      access: {
        owners: [issuer.webid('alice')],
        readers: [issuer.webid('bob')],
        public: ['read'],
      },
    },
    grants: ['storage'],
    // plugin.mjs's `http.writeTargets`, which the install review approves.
    routeWrites: [
      {
        id: 'storage',
        parent: 'config:storage',
        classes: ['https://atomicdata.dev/classes/PlainText'],
      },
    ],
  });
  // The rights, from the page's own store: the plugin's agent may write in
  // the folder (what the install review's rights commit does) and the
  // public may read it. A Node-side Store's later edits did not reach the
  // server here, so they are made where the data browser makes them.
  const pluginAgent = await fetchPluginAgent(store, installation);
  await page.evaluate(
    async ({ target: subject, writer }) => {
      const resource = await window.store!.getResource(subject);
      resource.push('https://atomicdata.dev/properties/write', [writer], true);
      await resource.set('https://atomicdata.dev/properties/read', [
        'https://atomicdata.dev/agents/publicAgent',
      ]);
      await resource.save();
    },
    { target: storage, writer: pluginAgent },
  );
  const origin = new URL(ROUTES_ORIGIN);
  const pod = `${origin.protocol}//${routeSlug(installation)}.${origin.host}/`;
  issuer.setStorage('alice', pod);
  // Activation is the server's commit hook: wait until the pod answers.
  await expect
    .poll(async () => (await fetch(pod)).status, { timeout: 60_000 })
    .not.toBe(404);

  return { pod, storage, installation, agent };
}

/** atomic-server `route_registry::slug`, as plugin-routes.spec.ts computes it. */
function routeSlug(subject: string) {
  const url = new URL(subject);
  url.search = '';
  url.hash = '';
  let pure = url.toString();
  if (pure.endsWith('/') && (pure.length > 10 || url.protocol === 'did:'))
    pure = pure.slice(0, -1);
  const fromLib = createRequire(require.resolve('@tomic/lib'));
  const { blake3 } = fromLib('@noble/hashes/blake3.js') as {
    blake3: (input: Uint8Array) => Uint8Array;
  };

  return Buffer.from(blake3(new TextEncoder().encode(pure)))
    .toString('hex')
    .slice(0, 32);
}

/**
 * A POST with a version 2 request signature over the method, the full URL
 * and the body (atomic-server#1832), as integrations/tooling/e2e/signed-post.ts
 * does; a plugin folder calls `signedRequestInit` itself.
 */
async function post(agent: Agent, path: string, body: unknown) {
  const url = `${SERVER_URL}${path}`;
  const response = await fetch(
    url,
    await signedRequestInit(url, agent, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const text = await response.text();
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  return { status: response.status, text, json };
}
