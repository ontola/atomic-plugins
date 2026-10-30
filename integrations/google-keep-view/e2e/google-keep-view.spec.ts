// @wc-ignore-file
import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { before } from '../../../browser/e2e/tests/test-utils';
import { appVersion } from '../../tooling/apps.mjs';

const VERSION = appVersion('google-keep-view');

async function install(page: Page) {
  await page.goto(new URL('/app/integrations', page.url()).href);
  await page
    .getByRole('checkbox', { name: 'Show experimental plugins' })
    .check();
  const entry = page
    .getByRole('region', { name: 'Drive apps' })
    .locator('[data-catalog-app="google-keep-view"]');
  await expect(entry).toContainText(`Version ${VERSION}`);
  await entry.getByRole('button', { name: 'Install Google Keep View' }).click();
  const app = page.frameLocator('iframe[title="App"]');
  await expect(
    app.getByRole('heading', { name: 'Google Keep', exact: true }),
  ).toBeVisible({ timeout: 45_000 });

  return app;
}

test.describe('Keep view catalog installation', () => {
  test.beforeEach(before);
  test('installs the view and explains how to import notes', async ({
    page,
  }) => {
    const app = await install(page);
    await expect(app.getByRole('status')).toContainText(
      'Import your Keep data',
    );
    await expect(
      app.getByRole('searchbox', { name: 'Search notes' }),
    ).toBeVisible();
  });

  test('is offered on an imported checklist and edits its own Checked column', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const imported = await page.evaluate(async () => {
      const store = window.store!;
      const A = 'https://atomicdata.dev/properties/';
      const drive = store.getDrive();
      const properties: Record<string, string> = {};

      for (const [key, name, datatype] of [
        ['text', 'Array item', 'string'],
        ['checked', 'Checked', 'boolean'],
        ['position', 'Position*', 'integer'],
      ]) {
        const property = await store.newResource({
          parent: drive,
          isA: ['https://atomicdata.dev/classes/Property'],
          propVals: {
            [A + 'name']: name,
            [A + 'description']: 'Synthetic imported checklist column: ' + name,
            [A + 'shortname']: 'imported-' + key,
            [A + 'datatype']: 'https://atomicdata.dev/datatypes/' + datatype,
          },
        });
        await property.save();
        properties[key] = property.subject;
      }

      const klass = await store.newResource({
        parent: drive,
        isA: ['https://atomicdata.dev/classes/Class'],
        propVals: {
          [A + 'name']: 'Imported list item',
          [A + 'description']: 'A synthetic imported checklist item.',
          [A + 'shortname']: 'imported-list-item',
          [A + 'recommends']: [properties.text, properties.checked],
          [A + 'requires']: [properties.position],
        },
      });
      await klass.save();
      const table = await store.newResource({
        parent: drive,
        isA: ['https://atomicdata.dev/classes/Table'],
        propVals: {
          [A + 'name']: 'Invented groceries · List',
          [A + 'classtype']: klass.subject,
        },
      });
      await table.save();
      let tea = '';

      for (const [name, checked, position] of [
        ['Imaginary apples', true, 0],
        ['Fictional tea', false, 2],
        ['Pretend toast', false, 1],
      ] as const) {
        const row = await store.newResource({
          parent: table.subject,
          isA: [klass.subject],
          propVals: {
            [properties.text]: name,
            [properties.checked]: checked,
            [properties.position]: position,
          },
        });
        await row.save();
        if (name === 'Fictional tea') tea = row.subject;
      }

      return { table: table.subject, tea, checked: properties.checked };
    });
    const app = await install(page);
    await expect(
      app.getByRole('article', { name: 'Invented groceries · List' }),
    ).toBeVisible();
    await expect(
      app.getByRole('list', { name: 'Unchecked items' }).locator('li'),
    ).toHaveText(['Pretend toast', 'Fictional tea']);
    await page.goto(
      `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(imported.table)}`,
    );
    await page
      .getByRole('main')
      .getByRole('button', { name: 'Add view' })
      .click();
    await page
      .getByRole('menuitem', { name: 'Google Keep View' })
      .click({ timeout: 60_000 });
    await page
      .locator('dialog[open]')
      .getByRole('button', { name: 'Allow editing' })
      .click();
    await expect(
      app.getByRole('checkbox', { name: 'Fictional tea' }),
    ).toBeEnabled({ timeout: 30_000 });
    await app.getByRole('checkbox', { name: 'Fictional tea' }).click();
    await expect(app.getByText('2 completed items')).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate(async ({ tea, checked }) => {
            const row = await window.store!.fetchResourceFromServer(tea, {
              noWebSocket: true,
            });

            return row.get(checked);
          }, imported),
        { timeout: 15_000 },
      )
      .toBe(true);
  });
});

test('synthetic Keep view: checklist edits, search, completed section, narrow layout and dark theme', async ({
  page,
}) => {
  const require = createRequire(
    new URL('../../../browser/package.json', import.meta.url),
  );
  const esbuild = require('esbuild');
  const { cssRawPlugin } = (await import(
    '../../sync-status/build.mjs' as string
  )) as { cssRawPlugin(esbuild: unknown): unknown };
  const bundle = await esbuild.build({
    stdin: {
      contents: `import { view } from './main.ts'; import { fixture } from './fixture.ts';
        export async function mount() { const fake = fixture(); fake.attach('items');
          await view({ root: document.getElementById('root'), store: fake.store }); return fake; }`,
      resolveDir: new URL('../app/', import.meta.url).pathname,
    },
    bundle: true,
    format: 'iife',
    globalName: 'keepTest',
    write: false,
    plugins: [cssRawPlugin(esbuild)],
  });
  await page.setContent(
    '<!doctype html><html><head><style>body{margin:0}</style></head><body><div id="root"></div></body></html>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(async () => {
    const { keepTest } = globalThis as typeof globalThis & {
      keepTest: { mount(): Promise<unknown> };
    };

    await keepTest.mount();
  });
  const grocery = page.getByRole('article', { name: 'Imaginary groceries' });
  await expect(grocery.locator('li')).toHaveText([
    'Fictional bread',
    'Pretend jam',
    'Imaginary apples',
    'Made-up tea',
  ]);
  await expect(
    grocery.getByRole('checkbox', { name: 'Fictional bread' }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Allow editing', exact: true })
    .click();
  await grocery.getByRole('checkbox', { name: 'Fictional bread' }).click();
  await expect(grocery.getByText('3 completed items')).toBeVisible();
  await grocery.getByText('3 completed items').click();
  await expect(
    grocery.getByRole('checkbox', { name: 'Fictional bread' }),
  ).toBeChecked();
  await page.getByRole('searchbox').fill('scenic');
  await expect(page.getByRole('article')).toHaveCount(1);
  await page.getByRole('searchbox').fill('');
  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.locator('.keep-grid')).toHaveClass(/keep-list/);
  await page.getByRole('button', { name: 'Grid view' }).click();
  await page.screenshot({
    path: test.info().outputPath('keep-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('.keep-grid')).toHaveCSS('column-count', '1');
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('keep-mobile.png'),
    fullPage: true,
  });
  await page.locator('#root').evaluate(node => {
    node.style.colorScheme = 'dark';
  });
  await expect(page.locator('#root')).toHaveCSS(
    'background-color',
    'rgb(32, 33, 36)',
  );
  await page.screenshot({
    path: test.info().outputPath('keep-dark.png'),
    fullPage: true,
  });
});

test('synthetic Keep view: account folder cards and a single checklist with 485 completed items', async ({
  page,
}) => {
  const require = createRequire(
    new URL('../../../browser/package.json', import.meta.url),
  );
  const esbuild = require('esbuild');
  const { cssRawPlugin } = (await import(
    '../../sync-status/build.mjs' as string
  )) as { cssRawPlugin(esbuild: unknown): unknown };
  const bundle = await esbuild.build({
    stdin: {
      contents: `import { view } from './main.ts'; import { folderFixture } from './fixture.ts';
        export async function mount() {
          const fake = folderFixture();
          for (const id of ['item-0','item-1','item-2','item-3']) delete fake.resources['did:test:'+id];
          for (let i = 0; i < 490; i++) fake.resources['did:test:large-item-'+i] = {
            ['https://atomicdata.dev/properties/parent']: 'did:test:items',
            ['https://atomicdata.dev/properties/isA']: ['did:test:item-class'],
            ['https://atomicdata.dev/properties/name']: i < 485 ? 'Imaginary completed item '+i : i < 488 ? 'Fictional active item '+i : '',
            ['did:test:google-keep-item-note']: 'did:test:groceries',
            ['did:test:google-keep-done']: i < 485,
            ['did:test:google-keep-position']: i,
            ['did:test:google-keep-under']: i === 487 ? 'did:test:large-item-486' : ''
          };
          const show = async (subject) => {
            dispatchEvent(new Event('pagehide'));
            fake.attachResource(subject);
            await view({ root: document.getElementById('root'), store: fake.store });
          };
          fake.store.openResource = show;
          await show('did:test:notes');
        }`,
      resolveDir: new URL('../app/', import.meta.url).pathname,
    },
    bundle: true,
    format: 'iife',
    globalName: 'keepTest',
    write: false,
    plugins: [cssRawPlugin(esbuild)],
  });
  await page.setContent(
    '<!doctype html><html><head><style>body{margin:0}</style></head><body><div id="root"></div></body></html>',
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(async () => {
    const { keepTest } = globalThis as typeof globalThis & {
      keepTest: { mount(): Promise<void> };
    };
    await keepTest.mount();
  });
  await expect(
    page.getByRole('heading', {
      name: 'Google Keep fictional@example.test',
    }),
  ).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.locator('.keep-grid')).not.toHaveClass(
    /keep-single|keep-list/,
  );
  await page.screenshot({
    path: test.info().outputPath('keep-account-folder-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('heading', { name: 'Imaginary groceries' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.locator('.keep-grid')).toHaveClass(/keep-single/);
  await expect(
    page.getByRole('heading', { name: 'Imaginary groceries' }),
  ).toBeVisible();
  await expect(page.getByText('485 completed items')).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Completed items' }),
  ).not.toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Unchecked items' }).locator('li'),
  ).toHaveCount(5);
  await expect(
    page.getByRole('checkbox', { name: 'Fictional active item 485' }),
  ).toBeDisabled();
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('keep-note-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('keep-note-mobile.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Back to notes' }).click();
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(page.locator('.keep-grid')).toHaveCSS('column-count', '1');
  await page.screenshot({
    path: test.info().outputPath('keep-account-folder-mobile.png'),
    fullPage: true,
  });
});
