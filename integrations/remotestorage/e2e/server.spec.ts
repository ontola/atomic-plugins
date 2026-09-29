// @wc-ignore-file
/**
 * The remoteStorage server end to end, on atomic-server built with the
 * `plugin-routes` feature at `--plugin-routes read-write`, with nothing
 * mocked on the server side:
 *
 * 1. The unchanged `plugin.js` is published to this node's store and
 *    installed through the store's review dialog, approving its route writes
 *    into a folder named in its config.
 * 2. An independent client, remotestorage.js (`remotestoragejs` from npm,
 *    pinned in `package.json` next to this file), runs on another origin
 *    (`http://rs-app.localhost:<port>`, a small HTTP server in the spec) and connects with the user
 *    address `me@<installation slug>.routes.localhost:<port>`: WebFinger, the
 *    OAuth implicit grant through the host's consent page (a person clicks
 *    Allow), and the token back in the redirect fragment.
 * 3. Through remotestorage.js's own API it writes, reads, lists and deletes
 *    documents, including a binary one, and a public document is read
 *    without a token.
 * 4. The documents are Atomic Files under the configured folder, read back
 *    through the data browser's store, and conditional requests and scope
 *    refusals are checked with plain `fetch` from the app's origin.
 *
 * Run it through the lane, which starts the server at the right level:
 *
 *   node integrations/tooling/run-lane.mjs remotestorage --tier e2e
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Agent, signedRequestInit } from '@tomic/lib';
import {
  before,
  createFromCatalog,
  getDevDriveSecret,
  SERVER_URL,
} from '../../../browser/e2e/tests/test-utils';
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';

// Playwright loads this spec as CommonJS, so __dirname rather than import.meta.
const bundle = readFileSync(resolve(__dirname, '../plugin.js'), 'utf8');
const rsjs = readFileSync(
  resolve(__dirname, 'node_modules/remotestoragejs/release/remotestorage.js'),
  'utf8',
);
const LEVEL = process.env.PLUGIN_ROUTES_LEVEL ?? '';
const ROUTES_ORIGIN = process.env.PLUGIN_ROUTES_ORIGIN ?? '';
const FILE = 'https://atomicdata.dev/classes/File';
const P = {
  parent: 'https://atomicdata.dev/properties/parent',
  name: 'https://atomicdata.dev/properties/name',
  isA: 'https://atomicdata.dev/properties/isA',
  blob: 'https://atomicdata.dev/properties/blob',
  mimetype: 'https://atomicdata.dev/properties/mimetype',
  filesize: 'https://atomicdata.dev/properties/filesize',
  provenance: 'https://atomicdata.dev/properties/routeProvenance',
};

/** The client app: remotestorage.js, claiming the `e2e` category read-write. */
const APP_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>remoteStorage e2e client</title>
<script src="/remotestorage.js"></script>
<script>
  const rs = new RemoteStorage({ cache: false, logging: false });
  rs.access.claim('e2e', 'rw');
  window.rs = rs;
  window.client = rs.scope('/e2e/');
  window.publicClient = rs.scope('/public/e2e/');
  window.rsErrors = [];
  rs.on('error', e => window.rsErrors.push(String((e && e.message) || e)));
  rs.on('connected', () => { window.rsConnected = true; });
</script>`;

test.describe('remoteStorage server', () => {
  test.skip(
    LEVEL !== 'read-write' || !ROUTES_ORIGIN,
    'run through run-lane.mjs, which starts atomic-server at --plugin-routes read-write with a routes origin',
  );
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page);
  });

  test('remotestorage.js connects, writes, reads, lists and deletes documents stored as Atomic Files', async ({
    page,
    context,
  }) => {
    test.setTimeout(300_000);
    const { drive, plugin } = await createPlugin(page);
    const folder = await createFolder(page, drive);
    const agent = Agent.fromSecret(await getDevDriveSecret(page), 'js');
    const published = await post(agent, '/plugin-release', { drive, plugin });
    expect(published.status, published.text).toBe(200);
    const releaseId = (published.json as { id: string }).id;

    const installation = await install(page, releaseId, folder);
    const origin = ROUTES_ORIGIN.replace(
      '://',
      `://${routeSlug(installation)}.`,
    );
    const host = new URL(origin).host;
    const userAddress = `me@${host}`;

    // The app is served for real on loopback: Chromium's local network
    // access checks refuse a page Playwright fulfils (no address) calling
    // the server on localhost.
    const app = createServer((req, res) => {
      const script = req.url === '/remotestorage.js';
      res.writeHead(200, {
        'content-type': script ? 'text/javascript' : 'text/html; charset=utf-8',
      });
      res.end(script ? rsjs : APP_PAGE);
    });
    await new Promise<void>(done => app.listen(0, done));
    const APP = `http://rs-app.localhost:${(app.address() as AddressInfo).port}`;

    try {
      // WebFinger, from the app's origin, as a browser client sees it.
      await page.goto(`${APP}/`);
      const jrd = await page.evaluate(
        async ({ base, address }) => {
          const response = await fetch(
            `${base}/.well-known/webfinger?resource=acct:${address}`,
          );

          return {
            status: response.status,
            type: response.headers.get('content-type'),
            body: await response.json(),
          };
        },
        { base: origin, address: userAddress },
      );
      expect(jrd.status).toBe(200);
      expect(jrd.type).toBe('application/jrd+json');
      expect(jrd.body.links[0].href).toBe(`${origin}/storage`);
      expect(
        jrd.body.links[0].properties[
          'http://tools.ietf.org/html/rfc6749#section-4.2'
        ],
      ).toBe(`${origin}/oauth`);

      // Connect: discovery, then the host's consent page on the API origin.
      await page.evaluate(address => {
        (
          window as unknown as { rs: { connect: (a: string) => void } }
        ).rs.connect(address);
      }, userAddress);
      await page.waitForURL(/\/app\/route-consent\?request=/, {
        timeout: 30_000,
      });
      await expect(page.getByText('e2e:rw')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(APP, { exact: false }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Allow', exact: true }).click();

      // Back at the app, with the token from the fragment.
      await page.waitForURL(`${APP}/**`, { timeout: 30_000 });
      await page.waitForFunction(
        () =>
          (window as unknown as { rsConnected?: boolean }).rsConnected === true,
        undefined,
        { timeout: 30_000 },
      );
      const token = await page.evaluate(
        () =>
          (window as unknown as { rs: { remote: { token: string } } }).rs.remote
            .token,
      );
      expect(token).toMatch(/^atr_/);

      // remotestorage.js's own API, straight to the server (no local cache).
      const binary = [0, 1, 2, 250, 251, 252, 253, 254, 255, 0, 10, 13];
      const results = await page.evaluate(async bytesIn => {
        type Client = {
          storeFile: (
            type: string,
            path: string,
            body: unknown,
          ) => Promise<string>;
          getFile: (
            path: string,
            maxAge: false,
          ) => Promise<{
            data: unknown;
            contentType: string;
            revision: string;
          }>;
          getListing: (
            path: string,
            maxAge: false,
          ) => Promise<Record<string, unknown>>;
          remove: (path: string) => Promise<unknown>;
        };
        const w = window as unknown as {
          client: Client;
          publicClient: Client;
          rs: { remote: { href: string; token: string } };
        };
        const text = 'Hello from remotestorage.js: Grüße 🌿\n';
        const firstRevision = await w.client.storeFile(
          'text/plain; charset=utf-8',
          'notes/hello.txt',
          text,
        );
        const read = await w.client.getFile('notes/hello.txt', false);
        const bytes = new Uint8Array(bytesIn).buffer;
        await w.client.storeFile('application/octet-stream', 'blob.bin', bytes);
        const readBinary = await w.client.getFile('blob.bin', false);
        // The bytes as the server sends them. remotestorage.js 2.0.0-beta.10
        // decides binary or text by testing its ArrayBuffer as a string, so
        // it decodes these bytes as text: a client quirk, not the server's.
        const raw = await fetch(`${w.rs.remote.href}/e2e/blob.bin`, {
          headers: { Authorization: `Bearer ${w.rs.remote.token}` },
        });
        const rawBytes = Array.from(new Uint8Array(await raw.arrayBuffer()));
        const secondRevision = await w.client.storeFile(
          'text/plain; charset=utf-8',
          'notes/hello.txt',
          text + 'again\n',
        );
        const listing = await w.client.getListing('', false);
        const notes = await w.client.getListing('notes/', false);
        await w.publicClient.storeFile(
          'text/plain',
          'shared.txt',
          'Public words',
        );
        await w.client.remove('blob.bin');
        const afterRemove = await w.client.getListing('', false);

        return {
          firstRevision,
          secondRevision,
          read: {
            data: read.data,
            contentType: read.contentType,
            revision: read.revision,
          },
          rawBytes,
          rawType: raw.headers.get('content-type'),
          binaryRead: typeof readBinary.data,
          binaryType: readBinary.contentType,
          listing,
          notes,
          afterRemove,
        };
      }, binary);
      expect(results.read.data).toBe('Hello from remotestorage.js: Grüße 🌿\n');
      expect(results.read.contentType).toBe('text/plain; charset=utf-8');
      expect(results.read.revision).toBe(results.firstRevision);
      expect(results.firstRevision).toMatch(/^[0-9a-f]{64}$/);
      expect(results.secondRevision).not.toBe(results.firstRevision);
      expect(results.rawBytes).toEqual(binary);
      expect(results.rawType).toBe('application/octet-stream');
      expect(results.binaryRead).toBe('string');
      expect(results.binaryType).toBe('application/octet-stream');
      expect(Object.keys(results.listing).sort()).toEqual([
        'blob.bin',
        'notes/',
      ]);
      expect(Object.keys(results.notes)).toEqual(['hello.txt']);
      expect(Object.keys(results.afterRemove)).toEqual(['notes/']);

      // The protocol as a plain client speaks it: public reads need no token,
      // listings and private documents do, and preconditions are enforced.
      const storage = `${origin}/storage`;
      const wire = await page.evaluate(
        async ({ root, bearer }) => {
          const auth = { Authorization: `Bearer ${bearer}` };

          const call = async (
            method: string,
            path: string,
            headers: Record<string, string> = {},
            body?: string,
          ) => {
            const response = await fetch(root + path, {
              method,
              headers,
              body,
            });

            return {
              status: response.status,
              etag: response.headers.get('etag'),
              body: method === 'HEAD' ? '' : await response.text(),
            };
          };

          const current = await call('GET', '/e2e/notes/hello.txt', auth);

          return {
            current,
            anonymousPublic: await call('GET', '/public/e2e/shared.txt'),
            anonymousPrivate: await call('GET', '/e2e/notes/hello.txt'),
            anonymousListing: await call('GET', '/public/e2e/'),
            otherCategory: await call('GET', '/contacts/', auth),
            root: await call('GET', '/', auth),
            badToken: await call('GET', '/e2e/notes/hello.txt', {
              Authorization: 'Bearer atr_not-a-token',
            }),
            notModified: await call('GET', '/e2e/notes/hello.txt', {
              ...auth,
              'If-None-Match': current.etag!,
            }),
            createOnly: await call(
              'PUT',
              '/e2e/notes/hello.txt',
              { ...auth, 'Content-Type': 'text/plain', 'If-None-Match': '*' },
              'x',
            ),
            staleWrite: await call(
              'PUT',
              '/e2e/notes/hello.txt',
              { ...auth, 'Content-Type': 'text/plain', 'If-Match': '"0000"' },
              'x',
            ),
            staleDelete: await call('DELETE', '/e2e/notes/hello.txt', {
              ...auth,
              'If-Match': '"0000"',
            }),
            folderOverDocument: await call(
              'PUT',
              '/e2e/notes/hello.txt/x',
              { ...auth, 'Content-Type': 'text/plain' },
              'x',
            ),
            head: await call('HEAD', '/e2e/notes/hello.txt', auth),
            missing: await call('GET', '/e2e/notes/nothing.txt', auth),
            unchanged: await call('GET', '/e2e/notes/hello.txt', auth),
          };
        },
        { root: storage, bearer: token },
      );
      expect(wire.current.status).toBe(200);
      expect(wire.current.etag).toBe(`"${results.secondRevision}"`);
      expect(wire.anonymousPublic).toMatchObject({
        status: 200,
        body: 'Public words',
      });
      expect(wire.anonymousPrivate.status).toBe(401);
      expect(wire.anonymousListing.status).toBe(401);
      expect(wire.otherCategory.status).toBe(403);
      expect(wire.root.status).toBe(403);
      expect(wire.badToken.status).toBe(401);
      expect(wire.notModified.status).toBe(304);
      expect(wire.createOnly.status).toBe(412);
      expect(wire.staleWrite.status).toBe(412);
      expect(wire.staleDelete.status).toBe(412);
      expect(wire.folderOverDocument.status).toBe(409);
      expect(wire.head).toMatchObject({ status: 200, etag: wire.current.etag });
      expect(wire.missing.status).toBe(404);
      // Nothing a refused request asked for was stored.
      expect(wire.unchanged).toMatchObject({
        status: 200,
        body: 'Hello from remotestorage.js: Grüße 🌿\nagain\n',
      });

      // In Atomic: Files under the configured folder, written by the
      // installation with route provenance, holding the blobs.
      const atomicPage = await context.newPage();
      await atomicPage.goto(SERVER_URL);
      const readFiles = () =>
        atomicPage.evaluate(
          async ({ server, parent, props }) => {
            const store = window.store!;
            // The server's query endpoint, as the signed-in owner: the folder's
            // children, straight from the store rather than the search index.
            const query = `${server}/query?property=${encodeURIComponent(props.parent)}&value=${encodeURIComponent(parent)}&page_size=50`;
            await store.reloadResource(query);
            const collection = await store.getResource(query);
            const children = (collection.get(
              'https://atomicdata.dev/properties/collection/members',
            ) ?? []) as string[];
            const out: Record<string, unknown>[] = [];

            for (const subject of children) {
              await store.reloadResource(subject);
              const r = await store.getResource(subject);
              out.push({
                name: r.get(props.name),
                isA: r.get(props.isA),
                blob: r.get(props.blob),
                mimetype: r.get(props.mimetype),
                filesize: r.get(props.filesize),
                provenance: r.get(props.provenance),
              });
            }

            return out;
          },
          { server: SERVER_URL, parent: folder, props: P },
        );
      let files: Record<string, unknown>[] = [];
      await expect
        .poll(
          async () => {
            files = await readFiles();

            return files.map(f => f.name).sort();
          },
          { timeout: 30_000 },
        )
        .toEqual(['hello.txt', 'shared.txt']);
      const byName = Object.fromEntries(files.map(f => [f.name, f]));
      expect(Object.keys(byName).sort()).toEqual(['hello.txt', 'shared.txt']);
      expect(byName['hello.txt']).toMatchObject({
        isA: [FILE],
        mimetype: 'text/plain; charset=utf-8',
        filesize: Buffer.byteLength(
          'Hello from remotestorage.js: Grüße 🌿\nagain\n',
        ),
      });
      expect(String(byName['hello.txt'].blob)).toContain(
        results.secondRevision,
      );
      expect(JSON.stringify(byName['hello.txt'].provenance)).toContain(
        'storage-write',
      );
    } finally {
      app.close();
    }
  });
});

/** A Plugin draft in the test's drive whose source is the unchanged bundle. */
async function createPlugin(page: Page) {
  await createFromCatalog(page, 'Plugin');
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible({ timeout: 45_000 });

  return page.evaluate(
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
      await resource.set(
        'https://atomicdata.dev/properties/name',
        'remoteStorage',
      );
      await resource.save();
      const drive = store.getDrive();
      if (!drive) throw new Error('no drive');

      return { drive, plugin };
    },
    // Unique per run: a release id is a hash of its content (see plugin-routes.spec.ts).
    { code: `${bundle}\n// run ${Date.now()}\n` },
  );
}

/** The folder the documents go to. */
async function createFolder(page: Page, drive: string) {
  return page.evaluate(async parent => {
    const store = window.store!;
    const folder = await store.newResource({
      parent,
      isA: 'https://atomicdata.dev/classes/Folder',
      propVals: {
        'https://atomicdata.dev/properties/name': 'remoteStorage e2e',
      },
    });
    await folder.save();

    return folder.subject;
  }, drive);
}

/**
 * Installs the release through the store's review dialog: approve the
 * route writes and name the folder in the config. Returns the Installation.
 */
async function install(page: Page, releaseId: string, folder: string) {
  await page.goto(new URL('/app/integrations', SERVER_URL).href);
  const card = page.locator(`[data-release="${releaseId}"]`);
  await expect(card).toBeVisible({ timeout: 45_000 });
  const dialog = page.locator('dialog[open]');
  // The store re-renders its cards while its listing settles.
  await expect(async () => {
    await card
      .getByRole('button', { name: 'Open', exact: true })
      .click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await dialog.getByTestId('route-write-approval').check();
  const editor = dialog.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(JSON.stringify({ table: folder }));
  await expect(dialog.getByTestId('route-write-unresolved')).toBeHidden();
  const reviewUrl = page.url();
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page).not.toHaveURL(reviewUrl, { timeout: 60_000 });
  const url = new URL(page.url());

  return url.searchParams.get('subject') ?? `${url.origin}${url.pathname}`;
}

/**
 * The installation slug (atomic-server `route_registry::slug`), as in
 * integrations/tooling/e2e/plugin-routes.spec.ts.
 */
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
 * A POST signed as the test's agent, with a version 2 signature over the
 * method, URL and body: state-changing endpoints require it (#1700).
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
