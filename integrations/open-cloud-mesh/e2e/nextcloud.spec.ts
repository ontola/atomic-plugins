// @wc-ignore-file
/**
 * Opt-in: a share from a real Nextcloud server to this plugin, on
 * atomic-server built with the `plugin-routes` feature at
 * `--plugin-routes read-write`.
 *
 * It starts the official `nextcloud` image in Docker (./nextcloud.mjs: host
 * network, Apache on 127.0.0.1 only, HTTPS with the lane's throwaway test
 * CA, SQLite, removed afterwards), installs the plugin with that Nextcloud
 * as its only allowed peer, and has an invented Nextcloud user share a file
 * with `bob@http://<installation host>` through Nextcloud's own OCS Share
 * API, so Nextcloud does its own discovery, signing and sending:
 *
 * 1. Nextcloud reports the federated share as created (it only does when
 *    the receiver answered `201`).
 * 2. The File is in the folder, with the bytes the host fetched from
 *    Nextcloud's public WebDAV with the share's secret.
 * 3. Unsharing in Nextcloud sends SHARE_UNSHARED, which marks the File
 *    unshared.
 * 4. A shared folder (which Nextcloud also sends as `resourceType: file`) is
 *    refused, so Nextcloud reports the share as failed.
 *
 * Skipped unless OCM_NEXTCLOUD_E2E=1. Needs Docker; pulls
 * `nextcloud:35.0.1-apache` (OCM_NEXTCLOUD_IMAGE to try another) and uses
 * port 18443 on 127.0.0.1 (OCM_NEXTCLOUD_PORT):
 *
 *   OCM_NEXTCLOUD_E2E=1 node integrations/tooling/run-lane.mjs open-cloud-mesh --tier e2e
 *
 * What passes at which atomic-server is in the README ("Against a real
 * Nextcloud").
 */
import { test, expect } from '@playwright/test';
import { before, SERVER_URL } from '../../../browser/e2e/tests/test-utils';
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';
import { blake3Hex, installReceiver, LEVEL, openReceived } from './helpers';

type PeerModule = typeof import('./peer.mjs');
type NextcloudModule = typeof import('./nextcloud.mjs');

const ENABLED = process.env.OCM_NEXTCLOUD_E2E === '1';
const PORT = Number(process.env.OCM_NEXTCLOUD_PORT || 18443);
const FILE_BODY = 'Invented file shared from Nextcloud for the OCM e2e.\n';

test.describe('Open Cloud Mesh receiver with a real Nextcloud', () => {
  test.skip(
    LEVEL !== 'read-write',
    'run through run-lane.mjs, which sets PLUGIN_ROUTES_LEVEL=read-write and the loopback seams',
  );
  test.skip(!ENABLED, 'opt-in: set OCM_NEXTCLOUD_E2E=1 (needs Docker)');
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page);
  });

  test('a federated share from Nextcloud arrives as a File', async ({
    page,
  }, testInfo) => {
    test.setTimeout(900_000);
    const peerModule = (await import('./peer.mjs')) as PeerModule;
    const { startNextcloud, request } =
      (await import('./nextcloud.mjs')) as NextcloudModule;
    const nc = await startNextcloud({ port: PORT });

    try {
      testInfo.annotations.push({
        type: 'nextcloud',
        description: `${nc.image} (status.php versionstring ${nc.version})`,
      });
      const { base, folder } = await installReceiver(
        page,
        sharesFolder => ({
          sharesFolder,
          allowedPeers: { [nc.domain]: true },
          recipients: { bob: 'Bob Invented' },
        }),
        peerModule.fetchJson,
      );

      // -- 1. Nextcloud shares a file with bob ---------------------------
      const password = nc.addUser('alice', 'Alice Invented');
      const uploaded = await nc.upload(
        'alice',
        password,
        'nextcloud-spec.txt',
        FILE_BODY,
      );
      expect(uploaded.status).toBe(201);
      // Nextcloud spells a plain-http server's address with its scheme
      // (the lanes' routes origin is http://*.routes.localhost).
      const created = await nc.ocs(
        'alice',
        password,
        'POST',
        '/apps/files_sharing/api/v1/shares',
        {
          path: '/nextcloud-spec.txt',
          shareType: '6',
          shareWith: `bob@${base}`,
        },
      );
      expect(created.status, `${created.body}\n${nc.log()}`).toBe(200);
      const shareId = JSON.parse(created.body).ocs.data.id as string;

      // -- 2. the File, with the fetched bytes --------------------------
      const download = await fetch(
        `${SERVER_URL}/download/files/${blake3Hex(FILE_BODY)}`,
      );
      expect(download.status).toBe(200);
      expect(await download.text()).toBe(FILE_BODY);
      await openReceived(page, folder, 'nextcloud-spec.txt');
      await expect(page.getByText('State: accepted')).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByText(`Sending server: ${nc.domain}`),
      ).toBeVisible();
      await expect(
        page.getByText('Invented file shared from Nextcloud for the OCM e2e.'),
      ).toBeVisible({ timeout: 30_000 });

      // -- 3. unsharing in Nextcloud ------------------------------------
      const removed = await nc.ocs(
        'alice',
        password,
        'DELETE',
        `/apps/files_sharing/api/v1/shares/${shareId}`,
      );
      expect(removed.status, removed.body).toBe(200);
      await expect(async () => {
        await page.reload();
        await expect(page.getByText('State: unshared')).toBeVisible({
          timeout: 5_000,
        });
      }).toPass({ timeout: 60_000 });

      // -- 4. a folder is refused ---------------------------------------
      const folderPath = `/remote.php/dav/files/alice/invented-folder`;
      const made = await request(nc.ca, `${nc.origin}${folderPath}`, {
        method: 'MKCOL',
        headers: {
          authorization: `Basic ${Buffer.from(`alice:${password}`).toString('base64')}`,
        },
      });
      expect(made.status).toBe(201);
      const folderShare = await nc.ocs(
        'alice',
        password,
        'POST',
        '/apps/files_sharing/api/v1/shares',
        {
          path: '/invented-folder',
          shareType: '6',
          shareWith: `bob@${base}`,
        },
      );
      expect(folderShare.status, folderShare.body).toBe(403);
      expect(nc.log()).toContain('served a folder');
    } finally {
      nc.stop();
    }
  });
});
