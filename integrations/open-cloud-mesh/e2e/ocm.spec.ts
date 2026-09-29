// @wc-ignore-file
/**
 * Open Cloud Mesh, end to end on a real atomic-server built with the
 * `plugin-routes` feature at `--plugin-routes read-write`, with an invented
 * OCM 1.5 peer (./peer.mjs) serving HTTPS on loopback, which the lane's
 * debug-build seams (lanes.json `serverEnv`) let the server reach:
 *
 *   node integrations/tooling/run-lane.mjs open-cloud-mesh --tier e2e
 *
 * 1. Publish the plugin's bundle from a Plugin draft, pin it, and install it
 *    through the store's review dialog: approve its route writes, and give
 *    it a folder, the peer and one recipient in the config.
 * 2. `/.well-known/ocm` on the installation's origin answers discovery with
 *    `http-sig` and a `jwksUri`.
 * 3. The peer sends an RFC 9421 (`tag="ocm"`) signed share. The host verifies
 *    it with the key the peer's discovery names; the plugin has the host
 *    fetch the shared file with the share's secret into the blob store, and
 *    stores a File in the folder. The drive shows it; its bytes download.
 * 4. The host's delivery queue sends SHARE_ACCEPTED back, signed with the
 *    installation key; the peer verifies it against the installation's
 *    published JWK Set, independently of atomic-server's code.
 * 5. The peer's signed SHARE_UNSHARED marks the File unshared.
 * 6. An unsigned share and one for an unknown recipient are refused.
 *
 * Not covered: sending shares, WebDAV serving (PROPFIND), the token
 * exchange, a real Nextcloud or ownCloud peer.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Agent, signRequest } from '@tomic/lib';
import {
  before,
  createFromCatalog,
  getDevDriveSecret,
  SERVER_URL,
} from '../../../browser/e2e/tests/test-utils';
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';
// The peer is plain ESM node code; loaded per test (Playwright runs this
// spec as CommonJS).
type PeerModule = typeof import('./peer.mjs');
let peerModule: PeerModule;

const LEVEL = process.env.PLUGIN_ROUTES_LEVEL ?? '';
const ROUTES_ORIGIN = process.env.PLUGIN_ROUTES_ORIGIN ?? '';
const source = readFileSync(resolve(__dirname, '../plugin.js'), 'utf8');
const FOLDER = 'https://atomicdata.dev/classes/Folder';
const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';
const FILE_BODY = 'Invented shared file for the OCM e2e.\n';
const SECRET = `invented-secret-${Date.now()}`;

test.describe('Open Cloud Mesh receiver', () => {
  test.skip(
    LEVEL !== 'read-write',
    'run through run-lane.mjs, which sets PLUGIN_ROUTES_LEVEL=read-write and the loopback seams',
  );
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page);
  });

  test('receives a signed share, stores the file and acknowledges it', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    peerModule = (await import('./peer.mjs')) as PeerModule;
    const peer = await peerModule.startPeer({
      files: {
        'spec.txt': { body: FILE_BODY, type: 'text/plain', secret: SECRET },
      },
    });

    try {
      // -- 1. publish, pin and install through the review dialog ----------
      const { drive, plugin, folder } = await createPluginAndFolder(page);
      const agent = Agent.fromSecret(await getDevDriveSecret(page), 'js');
      const published = await post(agent, '/plugin-release', { drive, plugin });
      expect(published.status, published.text).toBe(200);
      const releaseId = (published.json as { id: string }).id;
      const pinned = await post(agent, '/plugin-release-pin', {
        drive,
        plugin,
      });
      expect(pinned.status, pinned.text).toBe(200);

      const dialog = await openReview(page, releaseId);
      await dialog.getByTestId('route-write-approval').click();
      await setConfig(page, dialog, {
        sharesFolder: folder,
        allowedPeers: { [peer.domain]: true },
        recipients: { bob: 'Bob Invented' },
      });
      const reviewUrl = page.url();
      await dialog
        .getByRole('button', { name: 'Install', exact: true })
        .click();
      await expect(page).not.toHaveURL(reviewUrl, { timeout: 60_000 });
      const installation = subjectOf(page.url());
      const host = `${routeSlug(installation)}.${new URL(ROUTES_ORIGIN).host}`;
      const base = `http://${host}`;

      // -- 2. discovery ----------------------------------------------------
      const discovery = await peerModule.fetchJson(`${base}/.well-known/ocm`);
      expect(discovery).toMatchObject({
        enabled: true,
        apiVersion: '1.5.0',
        endPoint: `${base}/ocm`,
        capabilities: ['http-sig', 'notifications'],
        jwksUri: `${base}/ocm/jwks`,
      });

      // -- 3. a signed share -----------------------------------------------
      const share = (providerId: string, shareWith = `bob@${host}`) => ({
        shareWith,
        name: 'spec.txt',
        providerId,
        owner: `alice@${peer.domain}`,
        sender: `alice@${peer.domain}`,
        senderDisplayName: 'Alice Invented',
        shareType: 'user',
        resourceType: 'file',
        protocol: {
          name: 'multi',
          webdav: {
            uri: `${peer.origin}/dav/spec.txt`,
            sharedSecret: SECRET,
            permissions: ['read'],
          },
        },
      });
      const received = await peer.sendShare(
        `${base}/ocm/shares`,
        share('share-e2e-1'),
      );
      expect(received.status, received.body).toBe(201);
      expect(JSON.parse(received.body)).toEqual({
        recipientDisplayName: 'Bob Invented',
      });
      const fetches = peer.received.filter(r => r.path === '/dav/spec.txt');
      expect(fetches).toHaveLength(1);
      expect(fetches[0].headers.authorization).toBe(`Bearer ${SECRET}`);

      // The drive shows the File in the folder, and its bytes download.
      const hash = blake3Hex(FILE_BODY);
      const download = await fetch(`${SERVER_URL}/download/files/${hash}`);
      expect(download.status).toBe(200);
      expect(await download.text()).toBe(FILE_BODY);
      await page.goto(
        `${SERVER_URL}/app/show?subject=${encodeURIComponent(folder)}`,
      );
      const entry = page.getByText('spec.txt').first();
      await expect(entry).toBeVisible({ timeout: 30_000 });
      await entry.click();
      await expect(page.getByText('State: accepted')).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByText('Invented shared file for the OCM e2e.'),
      ).toBeVisible({
        timeout: 30_000,
      });

      // -- 4. SHARE_ACCEPTED, verified by the peer -------------------------
      await expect
        .poll(
          () =>
            peer.received.filter(r => r.path === '/ocm/notifications').length,
          {
            timeout: 60_000,
          },
        )
        .toBeGreaterThan(0);
      const notification = peer.received.find(
        r => r.path === '/ocm/notifications',
      )!;
      expect(notification.refused).toBeUndefined();
      expect(notification.verified).toMatchObject({
        domain: host,
        keyId: `${host}#ocm-key`,
      });
      expect(JSON.parse(notification.body.toString())).toMatchObject({
        notificationType: 'SHARE_ACCEPTED',
        senderDomain: host,
        resourceType: 'file',
        notification: { file: { providerId: 'share-e2e-1' } },
      });

      // -- 5. SHARE_UNSHARED -------------------------------------------------
      const unshared = await peer.sendNotification(
        `${base}/ocm/notifications`,
        {
          notificationType: 'SHARE_UNSHARED',
          senderDomain: peer.domain,
          resourceType: 'file',
          shareType: 'user',
          notification: { file: { providerId: 'share-e2e-1' } },
        },
      );
      expect(unshared.status, unshared.body).toBe(201);
      // The File page shows the new state (its description).
      await page.reload();
      await expect(page.getByText('State: unshared')).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(SECRET)).toHaveCount(0);

      // -- 6. refusals ---------------------------------------------------------
      const unsigned = await peerModule.send(`${base}/ocm/shares`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(share('share-e2e-2')),
      });
      expect(unsigned.status).toBe(401);
      const stranger = await peer.sendShare(
        `${base}/ocm/shares`,
        share('share-e2e-3', `carol@${host}`),
      );
      expect(stranger.status, stranger.body).toBe(400);
      expect(
        peer.received.filter(r => r.path === '/dav/spec.txt'),
      ).toHaveLength(1);
    } finally {
      await peer.close();
    }
  });
});

/** A Folder for received shares, and a Plugin draft whose source is the bundle. */
async function createPluginAndFolder(page: Page) {
  await createFromCatalog(page, 'Plugin');
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible({ timeout: 45_000 });

  return page.evaluate(
    async ({ code, folderClass, nameProp, descriptionProp }) => {
      const store = window.store!;
      const plugin = new URL(location.href).searchParams.get('subject')!;
      const resource = await store.getResource(plugin);
      const sourceProp = Object.entries(resource.getPropVals()).find(
        ([, value]) =>
          typeof value === 'string' && value.includes('export function run'),
      )?.[0];
      if (!sourceProp) throw new Error('plugin has no source property');
      await resource.set(sourceProp, code);
      await resource.set(nameProp, 'Open Cloud Mesh');
      await resource.set(descriptionProp, 'OCM receiver under e2e test.');
      await resource.save();
      const drive = store.getDrive();
      if (!drive) throw new Error('no drive');
      const folder = await store.newResource({
        parent: drive,
        isA: folderClass,
        propVals: { [nameProp]: `OCM shares ${Date.now()}` },
      });
      await folder.save();

      return { drive, plugin, folder: folder.subject };
    },
    // Unique per run: a release id is a hash of its content.
    {
      code: `${source}\n// run ${Date.now()}\n`,
      folderClass: FOLDER,
      nameProp: NAME,
      descriptionProp: DESCRIPTION,
    },
  );
}

/** Replaces the review dialog's config JSON. */
async function setConfig(
  page: Page,
  dialog: ReturnType<Page['locator']>,
  config: object,
) {
  const editor = dialog.locator('.cm-content').first();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(JSON.stringify(config));
  await expect(dialog.getByTestId('route-write-unresolved')).toHaveCount(0);
}

async function openReview(page: Page, releaseId: string) {
  await page.goto(new URL('/app/integrations', SERVER_URL).href);
  const card = page.locator(`[data-release="${releaseId}"]`);
  await expect(card).toBeVisible({ timeout: 45_000 });
  await card.getByRole('button', { name: 'Open', exact: true }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  return dialog;
}

function subjectOf(url: string) {
  const parsed = new URL(url);

  return (
    parsed.searchParams.get('subject') ?? `${parsed.origin}${parsed.pathname}`
  );
}

const fromLib = () => createRequire(require.resolve('@tomic/lib'));

function blake3(input: Uint8Array): Uint8Array {
  const { blake3: hash } = fromLib()('@noble/hashes/blake3.js') as {
    blake3: (input: Uint8Array) => Uint8Array;
  };

  return hash(input);
}

const blake3Hex = (text: string) =>
  Buffer.from(blake3(new TextEncoder().encode(text))).toString('hex');

/** atomic-server `route_registry::slug`, as the plugin-routes spec computes it. */
function routeSlug(subject: string) {
  const url = new URL(subject);
  url.search = '';
  url.hash = '';
  let pure = url.toString();
  if (pure.endsWith('/') && (pure.length > 10 || url.protocol === 'did:'))
    pure = pure.slice(0, -1);

  return Buffer.from(blake3(new TextEncoder().encode(pure)))
    .toString('hex')
    .slice(0, 32);
}

async function post(agent: Agent, path: string, body: unknown) {
  const url = `${SERVER_URL}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...(await signRequest(url, agent, {})),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  return { status: response.status, text, json };
}
