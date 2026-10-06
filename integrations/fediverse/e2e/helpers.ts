// @wc-ignore-file
/**
 * What the Fediverse e2e specs share: the drive folders, the host binding,
 * publishing and installing the bundle through the store's review dialog,
 * and requests signed with a version 2 Atomic request signature.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { Agent, signRequest } from '@tomic/lib';
import { SERVER_URL } from '../../../browser/e2e/tests/test-utils';
import {
  openNewPluginDraft,
  waitForOutboxDrained,
} from '../../tooling/e2e/route-install';
import { atomicRequest } from './peer';

// Playwright loads the specs as CommonJS, so __dirname, not import.meta.
const source = readFileSync(resolve(__dirname, '../plugin.js'), 'utf8');

/** atomic-server's port: drive hosts are `<name>.localhost` on it. */
export const PORT = new URL(SERVER_URL).port;
export const AS = 'https://www.w3.org/ns/activitystreams';
export const P = {
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  read: 'https://atomicdata.dev/properties/read',
  replyTo: 'https://atomicdata.dev/properties/replyTo',
  url: 'https://atomicdata.dev/property/url',
};
const FOLDER = 'https://atomicdata.dev/classes/Folder';
const PLAIN_TEXT = 'https://atomicdata.dev/classes/PlainText';
const PUBLIC_AGENT = 'https://atomicdata.dev/agents/publicAgent';

/** The profile and the three folders, under the test's drive. */
export async function createFolders(page: Page) {
  return page.evaluate(
    async ({ p, folderClass, plainTextClass, publicAgent }) => {
      const store = window.store!;
      const drive = store.getDrive();
      if (!drive) throw new Error('no drive');

      const make = async (
        isA: string,
        propVals: Record<string, unknown>,
      ): Promise<string> => {
        const resource = await store.newResource({
          isA,
          parent: drive,
          propVals: propVals as never,
        });
        await resource.save();

        return resource.subject;
      };

      return {
        drive,
        profile: await make(plainTextClass, {
          [p.name]: 'Atomic news',
          [p.description]: 'Posts from an Atomic drive',
          [p.read]: [publicAgent],
        }),
        posts: await make(folderClass, {
          [p.name]: 'Fediverse posts',
          [p.read]: [publicAgent],
        }),
        followers: await make(folderClass, { [p.name]: 'Fediverse followers' }),
        replies: await make(folderClass, { [p.name]: 'Fediverse replies' }),
      };
    },
    {
      p: P,
      folderClass: FOLDER,
      plainTextClass: PLAIN_TEXT,
      publicAgent: PUBLIC_AGENT,
    },
  );
}

/**
 * Maps the host of `origin` to the drive (`/bind-drive`), as its owner. The
 * host is bound by name: every port on it reaches the same drive.
 */
export async function bindHost(agent: Agent, origin: string, drive: string) {
  const bound = await signedPost(agent, `${origin}/bind-drive`, {
    'https://atomicdata.dev/properties/initialDrive': drive,
  });
  expect(bound.status, bound.body).toBe(200);
}

/** A Plugin draft whose source is the bundle, as plugin-routes.spec.ts makes one. */
export async function createPluginDraft(page: Page) {
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
      await resource.set('https://atomicdata.dev/properties/name', 'Fediverse');
      await resource.set(
        'https://atomicdata.dev/properties/description',
        'One ActivityPub actor for this drive.',
      );
      await resource.save();
      const drive = store.getDrive();
      if (!drive) throw new Error('no drive');

      return { drive, plugin };
    },
    // Unique per run: a release id is a hash of its content.
    { code: `${source}\n// run ${Date.now()}\n` },
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

/**
 * A JSON POST with a version 2 Atomic request signature over the method,
 * the full URL and the body; unsigned without an agent. Drive-host URLs go
 * through {@link atomicRequest}.
 */
export async function signedPost(
  agent: Agent | undefined,
  url: string,
  value: unknown,
) {
  const body = JSON.stringify(value);
  const headers = {
    'content-type': 'application/json',
    ...(agent
      ? await signRequest(url, agent, {}, { method: 'POST', body })
      : {}),
  } as Record<string, string>;

  return atomicRequest(url, { method: 'POST', headers, body });
}

/** A child of `parent` whose description contains `text`, as its propvals. */
export async function childNamed(page: Page, parent: string, text: string) {
  const found = await page.evaluate(
    async ({ under, needle }) => {
      const store = window.store!;

      for (const hit of await store.search(needle, { parents: under })) {
        const row = await store.fetchResourceFromServer(hit);
        const values = row.getPropVals() as Record<string, unknown>;
        const description =
          values['https://atomicdata.dev/properties/description'];
        if (String(description ?? '').includes(needle))
          return JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
      }

      return undefined;
    },
    { under: parent, needle: text },
  );

  return (found ?? undefined) as Record<string, unknown> | undefined;
}

/**
 * Publishes, pins and installs the bundle through the store's review
 * dialog, with `config` and the route-write approval.
 */
export async function installPlugin(
  page: Page,
  agent: Agent,
  config: Record<string, unknown>,
) {
  const draft = await createPluginDraft(page);
  const published = await signedPost(
    agent,
    `${SERVER_URL}/plugin-release`,
    draft,
  );
  expect(published.status, published.body).toBe(200);
  const releaseId = JSON.parse(published.body).id as string;
  const pinned = await signedPost(
    agent,
    `${SERVER_URL}/plugin-release-pin`,
    draft,
  );
  expect(pinned.status, pinned.body).toBe(200);

  const dialog = await openReview(page, releaseId);
  await dialog.getByLabel('Config').fill(JSON.stringify(config));
  await dialog.getByTestId('route-write-approval').check();
  const reviewUrl = page.url();
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page).not.toHaveURL(reviewUrl, { timeout: 60_000 });
  await waitForOutboxDrained(page);
}
