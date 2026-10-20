// @wc-ignore-file
/**
 * README screenshots (#49), one per drive app, at 1280×800 in the light
 * theme on the pinned atomic-server. Not a test: no lane lists this file, and
 * every case skips unless SCREENSHOTS_DIR is set. Run it through the driver,
 * which starts the servers and passes the environment:
 *
 *   node integrations/tooling/screenshots.mjs [pets calendar issue-tracker money notion timesheets]
 *
 * Invented data only:
 * - Pets: the catalog install of `pets` (the lane dev-server's catalog,
 *   serving the committed `apps/pets/<version>/ui.js`), connected through the
 *   host's consent bar to the mock proxy's static `pets` fixture.
 * - Google Calendar, GitHub issues, Clockify timesheets and Notion: the "(sample data)" entries of the
 *   user-testing catalog (`usertest/catalog.mjs`, `usertest/sample-data/`),
 *   which run the app built from this checkout on an invented Acme Studio
 *   account in the frame. Their yellow "Sample data" line stays in the shot.
 * - Money: the catalog install of `money` (the lane dev-server's catalog,
 *   serving the committed `apps/money/<version>/ui.js`), then the invented
 *   `integrations/money/fixtures/usertest/` August statement imported through
 *   the app's own "Import statement" into its own table.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';

const OUT = process.env.SCREENSHOTS_DIR;
const SAMPLE_CATALOG_URL = process.env.SAMPLE_CATALOG_URL;
const APP_FRAME = 'iframe[title="App"]';
const repo = resolve(__dirname, '../../..');

test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });

test.describe('README screenshots', () => {
  test.skip(
    !OUT,
    'Set SCREENSHOTS_DIR (run integrations/tooling/screenshots.mjs)',
  );
  test.beforeEach(before);
  // What the page complains about is the first clue when a shot times out.
  test.beforeEach(({ page }) => {
    page.on('console', m => {
      if (m.type() === 'error') console.log(`[page] ${m.text()}`);
    });
    page.on('pageerror', e => console.log(`[page] ${e.message}`));
  });

  test('pets', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(new URL('/app/integrations', page.url()).href);
    const experimental = page.getByRole('checkbox', {
      name: 'Show experimental plugins',
    });
    await experimental.check();
    await expect(experimental).toBeEnabled({ timeout: 30_000 });
    await page
      .getByRole('region', { name: 'Drive apps' })
      .locator('[data-catalog-app="pets"]')
      .getByRole('button', { name: 'Install Pets' })
      .click();
    const app = await appFrame(page);
    await app.getByRole('button', { name: 'Connect Pets' }).click();
    const consent = page.getByRole('group', { name: 'Connect an account' });
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Pets with this destination',
        exact: true,
      })
      .click();
    const app2 = page.frameLocator(APP_FRAME);
    await expect(
      app2.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toContainText('5 pets', { timeout: 30_000 });

    // The app's own view is one status line; the rows are in its table.
    await page
      .getByRole('navigation')
      .last()
      .getByRole('button', { name: 'Pets', exact: true })
      .nth(1)
      .click();
    await expect(
      page.getByRole('main').getByText('Whiskers', { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await shoot(page, 'pets');
  });

  test('calendar', async ({ page }) => {
    test.setTimeout(240_000);
    const app = await installSample(
      page,
      'calendar',
      'Google Calendar (sample data)',
    );
    const choose = app.getByRole('form', { name: 'Choose a calendar' });
    await choose
      .getByRole('radio', { name: /Acme Studio/ })
      .check({ timeout: 30_000 });
    await choose.getByRole('button', { name: 'Import this calendar' }).click();
    await expect(app.locator('.pill')).toContainText('Synced', {
      timeout: 30_000,
    });
    await expect(
      app.getByText(/Design review: Bakkerij Zonnig packaging/).first(),
    ).toBeVisible({ timeout: 15_000 });
    // The week grid scrolls to the current time, which on a late evening
    // run leaves the working day out of view: show 08:00 onwards.
    await app
      .getByText('08:00', { exact: true })
      .first()
      .evaluate(el => {
        el.scrollIntoView({ block: 'start' });
        // Only the grid should scroll, not the app's header above it.
        window.scrollTo(0, 0);
      });
    await shoot(page, 'calendar');
  });

  test('issue-tracker', async ({ page }) => {
    test.setTimeout(240_000);
    const app = await installSample(
      page,
      'issue-tracker',
      'GitHub issues (sample data)',
    );
    await app
      .getByRole('radio', { name: /acme-studio\/website/ })
      .check({ timeout: 30_000 });
    await app
      .getByRole('button', { name: 'Import acme-studio/website' })
      .click();
    await expect(
      app.getByText('Contact form accepts an empty email address').first(),
    ).toBeVisible({ timeout: 30_000 });
    await app.getByRole('button', { name: 'Board', exact: true }).click();
    // The first import pages in; wait until it is done.
    await expect(app.getByText(/^Importing…/)).toHaveCount(0, {
      timeout: 60_000,
    });
    await expect(app.getByText('Syncing…')).toHaveCount(0, {
      timeout: 60_000,
    });
    await shoot(page, 'issue-tracker');
  });

  test('timesheets', async ({ page }) => {
    test.setTimeout(240_000);
    const app = await installSample(
      page,
      'timesheets',
      'Clockify timesheets (sample data)',
    );
    await app
      .getByText('Connected as Alex Sample')
      .waitFor({ timeout: 30_000 });
    await app.getByRole('button', { name: 'Import entries' }).click();
    await expect(app.getByText('Webshop phase 2').first()).toBeVisible({
      timeout: 30_000,
    });
    await shoot(page, 'timesheets');
  });

  test('notion', async ({ page }) => {
    test.setTimeout(240_000);
    const app = await installSample(page, 'notion', 'Notion (sample data)');
    await waitForNotionSync(app);
    await shoot(page, 'notion');
  });

  // Optional: not in the driver's default set (see SHOTS there).
  test('notion-table', async ({ page }) => {
    test.setTimeout(240_000);
    const app = await installSample(page, 'notion', 'Notion (sample data)');
    await waitForNotionSync(app);
    await app.getByRole('button', { name: 'Open table' }).click();
    const main = page.getByRole('main');
    await expect(main.getByText('Launch plan').first()).toBeVisible({
      timeout: 30_000,
    });
    // The lens also leaves its raw Page fields as columns, auto-named and
    // empty, between the readable ones; scroll past them to the options.
    // The lens also leaves its raw Page fields as columns, auto-named and
    // empty, and the host's columns are 300 px wide: hide all but the
    // readable name and the option columns.
    const menu = page
      .getByRole('menu')
      .filter({ hasText: 'Toggle properties' });
    const keep = ['Name', 'Status', 'Tags', 'Format'];
    for (let round = 0; round < 40; round++) {
      const headers = (await main.getByRole('columnheader').allInnerTexts())
        .map(h => h.trim())
        .filter(h => h !== '#');
      // The first "Status" is Roadmap's; the second is the Reading list's.
      const extra = headers.findIndex(
        (h, i) => !keep.includes(h) || headers.indexOf(h) !== i,
      );
      if (extra < 0) break;
      const name = headers[extra]!;
      if (!(await menu.isVisible()))
        await main.getByTitle('Toggle properties').click();
      await expect(menu).toBeVisible();
      await menu
        .getByRole('menuitem', { name, exact: true })
        .nth(headers.indexOf(name) === extra ? 0 : 1)
        .click();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
    }
    // Close the sidebar, so the fourth column fits, and drop the focus ring.
    await page
      .getByRole('button', { name: /sidebar|menu/i })
      .first()
      .click();
    await page.getByRole('heading', { name: 'Pages' }).click();
    await shoot(page, 'notion-table');
  });

  test('money', async ({ page }) => {
    test.setTimeout(300_000);
    // Installed from Drive apps, as a person does. The app makes its own
    // Bank transactions table (shared `bank-transaction-v1` class) on first
    // open and writes the imported rows into it itself: no importer.
    await page.goto(new URL('/app/integrations', page.url()).href);
    const experimental = page.getByRole('checkbox', {
      name: 'Show experimental plugins',
    });
    await experimental.check();
    await expect(experimental).toBeEnabled({ timeout: 30_000 });
    await page
      .getByRole('region', { name: 'Drive apps' })
      .locator('[data-catalog-app="money"]')
      .getByRole('button', { name: 'Install Bank statements' })
      .click();
    const app = await appFrame(page);
    await expect(
      app.getByRole('heading', { name: 'Bring in your bank transactions' }),
    ).toBeVisible({ timeout: 60_000 });

    const name = 'acme-studio-2026-08.mt940';
    await app.locator('input[type="file"]').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: readFileSync(
        resolve(repo, 'integrations/money/fixtures/usertest', name),
      ),
    });
    const sheet = app.getByRole('dialog', { name: 'Import statement' });
    await sheet
      .getByRole('button', { name: /^Import \d+ transactions?$/ })
      .click({ timeout: 30_000 });
    await expect(sheet).toBeHidden({ timeout: 60_000 });
    await expect(app.getByRole('status').first()).toContainText('Imported', {
      timeout: 60_000,
    });
    await expect(app.getByRole('group', { name: /^Accounts/ })).toContainText(
      /on /,
      { timeout: 30_000 },
    );
    await shoot(page, 'money');
  });
});

/** Waits until the Notion status view has finished its first import. */
async function waitForNotionSync(app: FrameLocator) {
  await expect(app.getByText('Importing your first rows')).toHaveCount(0, {
    timeout: 90_000,
  });
  await expect(app.getByText('Roadmap').first()).toBeVisible({
    timeout: 30_000,
  });
}

/** Waits for the app frame and its first paint, then returns it. */
async function appFrame(page: Page): Promise<FrameLocator> {
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });

  return page.frameLocator(APP_FRAME);
}

/** Installs `<id>-sample` from the user-testing catalog. */
async function installSample(
  page: Page,
  id: string,
  title: string,
): Promise<FrameLocator> {
  expect(SAMPLE_CATALOG_URL, 'SAMPLE_CATALOG_URL').toBeTruthy();
  await page.evaluate(
    url => localStorage.setItem('plugin-catalog-url', url),
    SAMPLE_CATALOG_URL!,
  );
  await page.goto(new URL('/app/integrations', page.url()).href);
  const entry = page
    .getByRole('region', { name: 'Drive apps' })
    .locator(`[data-catalog-app="${id}-sample"]`);
  await entry
    .getByRole('button', { name: `Install ${title}` })
    .click({ timeout: 30_000 });
  const app = await appFrame(page);
  await expect(
    app.getByRole('note').filter({ hasText: 'Sample data' }),
  ).toBeVisible({ timeout: 30_000 });

  return app;
}

/**
 * Clears the host's toasts, lets fonts and transitions settle, then writes
 * `<OUT>/<name>.png`.
 */
async function shoot(page: Page, name: string) {
  for (const clear of await page.getByTitle('Clear', { exact: true }).all())
    await clear.click().catch(() => undefined);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: resolve(OUT!, `${name}.png`) });
}
