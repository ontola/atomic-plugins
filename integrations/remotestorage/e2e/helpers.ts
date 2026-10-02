// @wc-ignore-file
/**
 * Shared steps of the remoteStorage server e2e specs (`server.spec.ts`,
 * `api-suite.spec.ts`): publish the unchanged bundle as a release, install it
 * through the store's review dialog into a folder, and work out the
 * installation's routes origin.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

// Playwright loads the specs as CommonJS, so __dirname rather than import.meta.
const bundle = readFileSync(resolve(__dirname, '../plugin.js'), 'utf8');

export const LEVEL = process.env.PLUGIN_ROUTES_LEVEL ?? '';
export const ROUTES_ORIGIN = process.env.PLUGIN_ROUTES_ORIGIN ?? '';

/**
 * Publishes the bundle as a release and installs it into a new folder
 * (named `folderName`). Returns the folder, the Installation and its origin.
 */
export async function installServer(page: Page, folderName: string) {
  const { drive, plugin } = await createPlugin(page);
  const folder = await createFolder(page, drive, folderName);
  const agent = Agent.fromSecret(await getDevDriveSecret(page), 'js');
  const published = await post(agent, '/plugin-release', { drive, plugin });
  expect(published.status, published.text).toBe(200);
  const releaseId = (published.json as { id: string }).id;
  const installation = await install(page, releaseId, folder);
  const origin = ROUTES_ORIGIN.replace('://', `://${routeSlug(installation)}.`);

  return { folder, installation, origin };
}

/** A Plugin draft in the test's drive whose source is the unchanged bundle. */
export async function createPlugin(page: Page) {
  await openNewPluginDraft(page);

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
export async function createFolder(
  page: Page,
  drive: string,
  name = 'remoteStorage e2e',
) {
  return page.evaluate(
    async ({ parent, title }) => {
      const store = window.store!;
      const folder = await store.newResource({
        parent,
        isA: 'https://atomicdata.dev/classes/Folder',
        propVals: { 'https://atomicdata.dev/properties/name': title },
      });
      await folder.save();

      return folder.subject;
    },
    { parent: drive, title: name },
  );
}

/**
 * Installs the release through the store's review dialog: approve the
 * route writes and name the folder in the config. Returns the Installation.
 */
export async function install(page: Page, releaseId: string, folder: string) {
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
  await waitForOutboxDrained(page);

  return url.searchParams.get('subject') ?? `${url.origin}${url.pathname}`;
}

/**
 * The installation slug (atomic-server `route_registry::slug`), as in
 * integrations/tooling/e2e/plugin-routes.spec.ts.
 */
export function routeSlug(subject: string) {
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
