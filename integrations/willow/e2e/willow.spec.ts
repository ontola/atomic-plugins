// @wc-ignore-file
/**
 * The Willow export route on a real atomic-server built with `--features
 * plugin-routes` and started with `--plugin-routes read-write`: the host
 * generates the installation's Ed25519 subspace key, the committed bundle
 * runs in QuickJS, `ctx.willow.authorise` has the host check and sign each
 * Entry, and `GET /_routes/<slug>/willow.drop` answers raw drop bytes
 * (`bodyBase64`). The drop is then decoded by the willow-drop importer's
 * bundle, which verifies every Ed25519 signature, capability and WILLIAM3
 * digest independently of the host.
 *
 * Needs the host pieces of atomic-server `claude/plugin-willow-host`
 * (Willow key bindings, `ctx.willow.*`, binary route bodies); a host
 * without them refuses the manifest's `willow` key field, and this spec
 * fails rather than skips. Run it the way CI does:
 *
 *   node integrations/tooling/run-lane.mjs willow --tier e2e
 *
 * With WILLOW_E2E_DROP_OUT set, the first drop is also written to that file,
 * for `integrations/willow/fixtures/verify-drop` (willow25) to check by hand.
 */
import { readFileSync, writeFileSync } from 'node:fs';
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

// Playwright loads this spec as CommonJS (no package.json above it).
const source = readFileSync(resolve(__dirname, '../plugin.js'), 'utf8');
const LEVEL = process.env.PLUGIN_ROUTES_LEVEL ?? '';
const TITLE = 'Willow export';
const NAME = 'https://atomicdata.dev/properties/name';
const CONFIG = 'https://atomicdata.dev/properties/config';
/** An invented communal namespace id (last byte even). */
const NAMESPACE = '5a'.repeat(31) + '02';
const ATOMIC = '61746f6d6963';

test.describe('willow export route', () => {
  test.skip(
    LEVEL !== 'read-write',
    'run through run-lane.mjs, which starts the server at --plugin-routes read-write',
  );
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page);
  });

  test('serves host-signed Willow entries of public resources as a drop', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const target = await createDraft(page);
    const agent = Agent.fromSecret(await getDevDriveSecret(page), 'js');
    const published = await post(agent, '/plugin-release', target);
    expect(published.status, published.text).toBe(200);
    const releaseId = (published.json as { id: string }).id;
    const pinned = await post(agent, '/plugin-release-pin', target);
    expect(pinned.status, pinned.text).toBe(200);
    expect(
      (pinned.json as { release: { manifest: { http: unknown } } }).release
        .manifest.http,
    ).toMatchObject({
      keys: [
        {
          name: 'willow',
          alg: 'ed25519',
          willow: {
            namespace: 'config:namespace',
            pathPrefix: 'config:pathPrefix',
          },
        },
      ],
    });

    const catalog = await (await fetch(`${SERVER_URL}/plugin-catalog`)).json();
    const entry = catalog.entries.find(
      (e: { releaseId?: string }) => e.releaseId === releaseId,
    );
    expect(entry.requires).toContain('plugin-routes:read-write');

    // Install through the store's review, which lists the key and its reason
    // (it does not render the Willow binding itself; the config shows it).
    const dialog = await openReview(page, releaseId);
    await expect(dialog).toContainText('Signing key: willow (ed25519)');
    await expect(dialog).toContainText('Willow subspace key');
    const reviewUrl = page.url();
    await dialog.getByRole('button', { name: 'Install', exact: true }).click();
    await leftReview(page, reviewUrl);
    const installation = subjectOf(page.url());
    const slug = routeSlug(installation);

    // Two public notes and one private one, then the config.
    const [hello, second, hidden] = await page.evaluate(
      async ({ publicAgent }) => {
        const store = window.store!;
        const drive = store.getDrive()!;

        const make = async (name: string, isPublic: boolean) => {
          const resource = await store.newResource({
            parent: drive,
            isA: 'https://atomicdata.dev/classes/Folder',
            propVals: {
              'https://atomicdata.dev/properties/name': name,
              'https://atomicdata.dev/properties/description': 'Not selected',
              ...(isPublic
                ? { 'https://atomicdata.dev/properties/read': [publicAgent] }
                : {}),
            },
          });
          await resource.save();

          return resource.subject;
        };

        return [
          await make('Hello Willow', true),
          await make('Second note', true),
          await make('Private note', false),
        ];
      },
      { publicAgent: 'https://atomicdata.dev/agents/publicAgent' },
    );
    const configure = (subjects: string[]) =>
      page.evaluate(
        async ({ subject, config, property }) => {
          const resource = await window.store!.getResource(subject);
          await resource.set(property, config);
          await resource.save();
        },
        {
          subject: installation,
          property: CONFIG,
          config: {
            subjects,
            properties: [NAME],
            namespace: NAMESPACE,
            pathPrefix: [ATOMIC],
          },
        },
      );
    await configure([hello, second]);

    const url = `${SERVER_URL}/_routes/${slug}/willow.drop`;
    const first = await fetch(url);
    const firstBytes = new Uint8Array(await first.arrayBuffer());
    expect(first.status, Buffer.from(firstBytes).toString()).toBe(200);
    expect(first.headers.get('content-type')).toBe('application/octet-stream');
    if (process.env.WILLOW_E2E_DROP_OUT)
      writeFileSync(process.env.WILLOW_E2E_DROP_OUT, firstBytes);

    const rows = importRows(firstBytes);
    expect(rows).toHaveLength(2);
    const subspace = rows[0]['willow-subspace'];
    expect(subspace).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.map(r => r['willow-namespace'])).toEqual([
      NAMESPACE,
      NAMESPACE,
    ]);
    expect(rows.map(r => r['willow-subspace'])).toEqual([subspace, subspace]);
    expect(JSON.parse(rows[0]['willow-payload'])).toEqual({
      '@id': hello,
      [NAME]: 'Hello Willow',
    });
    expect(rows[1]['willow-path']).toContain('/atomic/');
    // Within a minute of now, on the data model's reading of the commit time.
    const age =
      Date.now() - Date.parse(rows[0]['willow-time'].replace(/\d{3}Z$/, 'Z'));
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(300_000);

    // Unchanged sources: the host answers its recorded signatures, and the
    // drop is byte for byte the same.
    const again = new Uint8Array(await (await fetch(url)).arrayBuffer());
    expect(Buffer.from(again).equals(Buffer.from(firstBytes))).toBe(true);

    // An edit: a newer entry for the same path, same key.
    await page.evaluate(
      async ({ subject, property }) => {
        const resource = await window.store!.getResource(subject);
        await resource.set(property, 'Hello again');
        await resource.save();
      },
      { subject: hello, property: NAME },
    );
    const edited = await fetch(url);
    expect(edited.status, await edited.clone().text()).toBe(200);
    const editedRows = importRows(new Uint8Array(await edited.arrayBuffer()));
    expect(JSON.parse(editedRows[0]['willow-payload'])[NAME]).toBe(
      'Hello again',
    );
    expect(editedRows[0]['willow-subspace']).toBe(subspace);
    expect(BigInt(editedRows[0]['willow-timestamp'])).toBeGreaterThan(
      BigInt(rows[0]['willow-timestamp']),
    );

    // A private source: the anonymous route cannot read it, so nothing is
    // served and the reason stays out of the response.
    await configure([hello, hidden]);
    const refused = await fetch(url);
    expect(refused.status).toBe(503);
    const text = await refused.text();
    expect(text).not.toContain(hidden);
    expect(text).not.toContain('Private note');
  });
});

/** A Plugin draft whose source is the bundle, as plugin-routes.spec.ts makes one. */
async function createDraft(page: Page) {
  await createFromCatalog(page, 'Plugin');
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible({ timeout: 45_000 });

  return page.evaluate(
    async ({ code, title }) => {
      const store = window.store!;
      const plugin = new URL(location.href).searchParams.get('subject')!;
      const resource = await store.getResource(plugin);
      const sourceProp = Object.entries(resource.getPropVals()).find(
        ([, value]) =>
          typeof value === 'string' && value.includes('export function run'),
      )?.[0];
      if (!sourceProp) throw new Error('plugin has no source property');
      await resource.set(sourceProp, code);
      await resource.set('https://atomicdata.dev/properties/name', title);
      await resource.set(
        'https://atomicdata.dev/properties/description',
        'Willow export route, e2e.',
      );
      await resource.save();
      const drive = store.getDrive();
      if (!drive) throw new Error('no drive');

      return { drive, plugin };
    },
    // Unique per run: a release id is a hash of its content.
    { code: `${source}\n// run ${Date.now()}\n`, title: TITLE },
  );
}

/** The willow-drop importer's rows for `bytes`, as the shortname → value. */
function importRows(bytes: Uint8Array): Record<string, string>[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const importer = require('../../willow-drop/plugin.js');
  const properties = Object.fromEntries(
    importer.manifest.destination.schema.properties.map(
      (p: { shortname: string }) => [
        p.shortname,
        `https://example.com/${p.shortname}`,
      ],
    ),
  );
  const verdict = importer.run({
    upload: {
      name: 'willow.drop.b64',
      text: Buffer.from(bytes).toString('base64'),
    },
    config: {
      table: 'https://example.com/t',
      rowClass: 'https://example.com/c',
      properties,
    },
    query: () => [],
    read: () => ({}),
  });

  return verdict.intents.map((intent: { set: Record<string, string> }) =>
    Object.fromEntries(
      Object.entries(properties).map(([shortname, url]) => [
        shortname,
        intent.set[url as string],
      ]),
    ),
  );
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

/**
 * Waits for Install to open the new Installation. On #118 (run 36834223383)
 * the page stayed on /app/integrations for 60 s in 3 of 4 attempts, with no
 * server log after the click; it did not reproduce in 9 local runs or in the
 * 18 CI runs before it. The store keeps the user there in three ways: an
 * inline refusal in the dialog, a toast.error, or a dialog closed without
 * navigating. The failure names which one, so the next occurrence doesn't
 * need the trace.
 */
async function leftReview(page: Page, reviewUrl: string) {
  try {
    await expect(page).not.toHaveURL(reviewUrl, { timeout: 60_000 });
  } catch (err) {
    const dialog = await page.locator('dialog[open]').allInnerTexts();
    const toasts = await page.locator('[role="status"]').allInnerTexts();
    throw new Error(
      `Install did not leave the review.\n` +
        `Open dialog: ${dialog.length ? dialog.join('\n---\n') : '(none)'}\n` +
        `Toasts: ${toasts.length ? toasts.join(' | ') : '(none)'}\n` +
        String(err),
    );
  }
}

function subjectOf(url: string) {
  const parsed = new URL(url);

  return (
    parsed.searchParams.get('subject') ?? `${parsed.origin}${parsed.pathname}`
  );
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

/** A POST with a fresh version 2 request signature (atomic-server#1832). */
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
