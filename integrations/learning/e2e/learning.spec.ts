// @wc-ignore-file
/**
 * The Leerboom drive app (`integrations/learning/app/`), end to end in a real
 * host: installed from the catalog's Drive apps section (the lane's
 * dev-server serving the committed `apps/learning/<version>/ui.js` in place
 * of GitHub Pages), it runs in its null-origin iframe, turns its own table
 * into a `skill-v1` table, loads the starter tree, and writes a `mastery-v1`
 * row that survives a reload.
 *
 * The rows use the published GitHub Pages subjects of skill-v1, lesson-v1 and
 * mastery-v1, which the server and browser fetch themselves, so this spec
 * needs network access to ontola.github.io and first checks Pages serves the
 * terms with the committed bytes. Run it the way CI does:
 *   node integrations/tooling/run-lane.mjs learning --tier e2e
 */
import { test, expect, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';
import { appVersion } from '../../tooling/apps.mjs';

const APP_FRAME = 'iframe[title="App"]';
const VERSION = appVersion('learning');

test.beforeAll(async () => {
  const served = (await import(
    '../../../ontology-kit/served.mjs' as string
  )) as {
    classTermPaths(name: string): string[];
    servedProblems(paths: string[]): Promise<string[]>;
    notServedMessage(problems: string[]): string;
  };
  const problems = await served.servedProblems([
    ...served.classTermPaths('skill-v1'),
    ...served.classTermPaths('lesson-v1'),
    ...served.classTermPaths('mastery-v1'),
  ]);

  if (problems.length) throw new Error(served.notServedMessage(problems));
});

async function installFromCatalog(page: Page) {
  await page.goto(
    new URL('/app/integrations?preview=plugins', page.url()).href,
  );
  const experimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await experimental.check();
  await expect(experimental).toBeEnabled({ timeout: 30_000 });
  const entry = page
    .getByRole('region', { name: 'Drive apps' })
    .locator('[data-catalog-app="learning"]');
  await expect(entry).toContainText(`Version ${VERSION}`);
  await entry.getByRole('button', { name: 'Install Leerboom' }).click();
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });
}

test.describe('learning drive app', () => {
  test.beforeEach(before);

  test('loads the starter tree into its own table and keeps a mastery row across a reload', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await installFromCatalog(page);
    const app = page.frameLocator(APP_FRAME);
    const node = (name: string) =>
      app.locator('.lb-node', { hasText: name }).first();

    await expect(
      app.getByRole('heading', { name: 'Learning tree' }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(app.locator('.lb-node')).toHaveCount(0);
    await app.getByRole('button', { name: 'Load starter tree' }).click();
    await expect(app.locator('.lb-node')).toHaveCount(30, { timeout: 90_000 });

    // Advice only: a locked skill is dimmed and can still be opened.
    await expect(node('Breuken')).toHaveClass(/is-locked/);
    await node('Breuken').click();
    await expect(app.locator('.lb-detail h2')).toHaveText('Breuken');
    await expect(app.locator('.lb-detail')).toContainText('This is advice');
    await expect(app.locator('.lb-lessons li')).toHaveCount(2);

    await node('Rekenen met getallen').click();
    await app.getByRole('button', { name: 'I master this' }).click();
    await expect(node('Rekenen met getallen')).toHaveClass(/is-mastered/);
    await expect(node('Breuken')).toHaveClass(/is-available/);

    await page.reload();
    await expect(node('Rekenen met getallen')).toHaveClass(/is-mastered/, {
      timeout: 45_000,
    });
    await expect(node('Breuken')).toHaveClass(/is-available/);
  });
});
