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
import { test, expect } from '@playwright/test';
import { before, SERVER_URL } from '../../../browser/e2e/tests/test-utils';
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';
import { blake3Hex, installReceiver, LEVEL, openReceived } from './helpers';
// The peer is plain ESM node code; loaded per test (Playwright runs this
// spec as CommonJS).
type PeerModule = typeof import('./peer.mjs');
let peerModule: PeerModule;

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
      // -- 2. discovery ----------------------------------------------------
      const { host, base, folder, discovery } = await installReceiver(
        page,
        sharesFolder => ({
          sharesFolder,
          allowedPeers: { [peer.domain]: true },
          recipients: { bob: 'Bob Invented' },
        }),
        peerModule.fetchJson,
      );
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
      await openReceived(page, folder, 'spec.txt');
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
