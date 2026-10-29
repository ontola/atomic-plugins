// @wc-ignore-file
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { before } from '../../../browser/e2e/tests/test-utils';
import { appVersion } from '../../tooling/apps.mjs';

const VERSION = appVersion('google-keep-view');

test.describe('Keep view catalog installation', () => {
  test.beforeEach(before);
  test('installs the view and explains how to import notes', async ({
    page,
  }) => {
    await page.goto(new URL('/app/integrations', page.url()).href);
    await page
      .getByRole('checkbox', { name: 'Show experimental plugins' })
      .check();
    const entry = page
      .getByRole('region', { name: 'Drive apps' })
      .locator('[data-catalog-app="google-keep-view"]');
    await expect(entry).toContainText(`Version ${VERSION}`);
    await entry
      .getByRole('button', { name: 'Install Google Keep View' })
      .click();
    const app = page.frameLocator('iframe[title="App"]');
    await expect(
      app.getByRole('heading', { name: 'Google Keep', exact: true }),
    ).toBeVisible({
      timeout: 45_000,
    });
    await expect(app.getByRole('status')).toContainText(
      'Open the Google Keep sync app',
    );
    await expect(
      app.getByRole('searchbox', { name: 'Search notes' }),
    ).toBeVisible();
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
