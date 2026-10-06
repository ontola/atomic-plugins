// @wc-ignore-file
/**
 * Shared steps of the Open Cloud Mesh e2e specs (`ocm.spec.ts` with the
 * invented peer, `nextcloud.spec.ts` with a real Nextcloud): publish the
 * bundle, install it through the store's review dialog, and the subject and
 * hash helpers both need.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { Agent, signedRequestInit } from '@tomic/lib';
import {
  getDevDriveSecret,
  SERVER_URL,
} from '../../../browser/e2e/tests/test-utils';
import {
  openNewPluginDraft,
  waitForOutboxDrained,
} from '../../tooling/e2e/route-install';

export const LEVEL = process.env.PLUGIN_ROUTES_LEVEL ?? '';
export const ROUTES_ORIGIN = process.env.PLUGIN_ROUTES_ORIGIN ?? '';
const source = readFileSync(resolve(__dirname, '../plugin.js'), 'utf8');
const FOLDER = 'https://atomicdata.dev/classes/Folder';
const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';

/**
 * Publishes and pins the bundle, installs it through the review dialog with
 * `config(folder)`, and waits until its discovery answers `enabled`.
 * Returns the installation's routes host (`<slug>.routes.localhost:<port>`),
 * its base URL, the folder and its discovery document.
 */
export async function installReceiver(
  page: Page,
  config: (folder: string) => Record<string, unknown>,
  fetchJson: (url: string) => Promise<Record<string, unknown>>,
) {
  const { drive, plugin, folder } = await createPluginAndFolder(page);
  const agent = Agent.fromSecret(await getDevDriveSecret(page), 'js');
  const published = await post(agent, '/plugin-release', { drive, plugin });
  expect(published.status, published.text).toBe(200);
  const releaseId = (published.json as { id: string }).id;
  const pinned = await post(agent, '/plugin-release-pin', { drive, plugin });
  expect(pinned.status, pinned.text).toBe(200);

  const dialog = await openReview(page, releaseId);
  // The route's `fetches` (wildcard host) in the review, as candidate16
  // words it.
  await expect(
    dialog.getByText('May download files from any server into your drive'),
  ).toBeVisible();
  await dialog.getByLabel('Config').fill(JSON.stringify(config(folder)));
  await dialog.getByTestId('route-write-approval').check();
  await expect(dialog.getByTestId('route-write-unresolved')).toHaveCount(0);
  const reviewUrl = page.url();
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page).not.toHaveURL(reviewUrl, { timeout: 60_000 });
  await waitForOutboxDrained(page);
  const installation = subjectOf(page.url());
  const host = `${routeSlug(installation)}.${new URL(ROUTES_ORIGIN).host}`;
  const base = `http://${host}`;

  // The route registry picks the installation up after the commit.
  let discovery: Record<string, unknown> | undefined;
  await expect
    .poll(
      async () => {
        discovery = await fetchJson(`${base}/.well-known/ocm`).catch(
          () => undefined,
        );

        return discovery?.enabled;
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  return { host, base, folder, discovery: discovery! };
}

/** A Folder for received shares, and a Plugin draft whose source is the bundle. */
export async function createPluginAndFolder(page: Page) {
  await openNewPluginDraft(page);

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

export async function openReview(page: Page, releaseId: string) {
  await page.goto(new URL('/app/integrations', SERVER_URL).href);
  const card = page.locator(`[data-release="${releaseId}"]`);
  await expect(card).toBeVisible({ timeout: 45_000 });
  await card.getByRole('button', { name: 'Open', exact: true }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  return dialog;
}

/** Opens the folder and waits until its listing shows `name`. */
export async function openReceived(page: Page, folder: string, name: string) {
  await page.goto(
    `${SERVER_URL}/app/show?subject=${encodeURIComponent(folder)}`,
  );
  // The folder's listing follows the sync; reload until it has the File.
  const entry = page.getByRole('main').getByRole('link', { name });
  await expect(async () => {
    await page.reload();
    await expect(entry).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 90_000 });
  await entry.click();
}

export function subjectOf(url: string) {
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

export const blake3Hex = (text: string) =>
  Buffer.from(blake3(new TextEncoder().encode(text))).toString('hex');

/** atomic-server `route_registry::slug`, as the plugin-routes spec computes it. */
export function routeSlug(subject: string) {
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

/**
 * A POST that needs a version 2 request signature (`/plugin-release`,
 * `/plugin-release-pin`), signed anew over method, URL and body.
 */
export async function post(agent: Agent, path: string, body: unknown) {
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
