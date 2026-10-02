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
 * - Money: the Bank statements importer published to the server and set up,
 *   then the published `apps/money/<version>/ui.js` added test-side as a view
 *   of its Bank transactions table (as `integrations/money/e2e/money.spec.ts`
 *   does; a catalog install does not give a working Money app at this pin),
 *   and the invented `integrations/money/fixtures/usertest/` August statement
 *   imported from inside the app through the host's review.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import {
  before,
  createFromCatalog,
} from '../../../browser/e2e/tests/test-utils';

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

  test('money', async ({ page }) => {
    test.setTimeout(300_000);
    const main = page.getByRole('main');
    const release = await publishImporter(page);
    await page.goto(new URL('/app/integrations', page.url()).href);
    await page
      .getByRole('checkbox', { name: 'Show experimental plugins' })
      .check();
    await page
      .locator(`[data-release="${release}"]`)
      .first()
      .getByRole('button', { name: 'Open', exact: true })
      .click();
    await page
      .locator('dialog[open]')
      .getByRole('button', { name: 'Create draft', exact: true })
      .click();
    await expect(
      main.getByRole('heading', { name: 'Bank statements', level: 1 }),
    ).toBeVisible({ timeout: 45_000 });
    await main.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(main.getByLabel('File to import')).toBeVisible({
      timeout: 120_000,
    });
    const sidebar = page.getByRole('navigation').last();
    await sidebar
      .getByRole('button', { name: 'Expand folder' })
      .first()
      .click();
    await sidebar
      .getByRole('button', { name: 'Bank transactions', exact: true })
      .click();
    await expect(
      main.getByRole('heading', { name: 'Bank transactions' }),
    ).toBeVisible({ timeout: 30_000 });
    const table = new URL(page.url()).searchParams.get('subject')!;
    const rowClass = await page.evaluate(
      async subject =>
        (await window.store!.getResource(subject)).get(
          'https://atomicdata.dev/properties/classtype',
        ) as string,
      table,
    );

    // The published module, as a new App that renders bank transactions.
    await createFromCatalog(page, 'App');
    await expect(main.locator(APP_FRAME)).toBeVisible({ timeout: 45_000 });
    const version = catalogVersion('money');
    await loadApp(
      page,
      readFileSync(resolve(repo, `apps/money/${version}/ui.js`), 'utf8'),
      rowClass,
      'Money',
    );
    await page.goto(
      `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(table)}`,
    );
    await main.getByRole('button', { name: 'Add view' }).click();
    await page
      .getByRole('menuitem', { name: 'Money' })
      .click({ timeout: 30_000 });
    await page
      .locator('dialog[open]')
      .getByRole('button', { name: 'Read-only' })
      .click();
    const app = page.frameLocator(APP_FRAME);
    await expect(
      app.getByRole('heading', { name: 'Bring in your bank transactions' }),
    ).toBeVisible({ timeout: 45_000 });

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
    const ask = page.getByRole('group', { name: 'Import with this app' });
    await ask.getByRole('button', { name: 'Preview import' }).click();
    const review = page.locator('dialog[open]');
    await review
      .getByRole('button', { name: /^Apply \d+ changes$/ })
      .click({ timeout: 120_000 });
    await expect(review).toBeHidden({ timeout: 60_000 });
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

function catalogVersion(shortname: string): string {
  const catalog = JSON.parse(
    readFileSync(resolve(repo, 'integrations/catalog.json'), 'utf8'),
  ) as Record<string, unknown>[];
  const entry = catalog.find(
    e => e['https://atomicdata.dev/properties/shortname'] === shortname,
  );

  return entry![
    'https://atomicdata.dev/integrations/properties/version'
  ] as string;
}

/** Publishes the committed Bank statements bundle; returns the release id. */
async function publishImporter(page: Page): Promise<string> {
  await createFromCatalog(page, 'Plugin');
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible({ timeout: 45_000 });
  await page.evaluate(
    async source => {
      const store = window.store!;
      const subject = new URL(location.href).searchParams.get('subject')!;
      const plugin = await store.getResource(subject);
      const sourceProp = Object.entries(plugin.getPropVals()).find(
        ([, value]) =>
          typeof value === 'string' && value.includes('export function run'),
      )?.[0];
      if (!sourceProp) throw new Error('plugin has no source property');
      await plugin.set(sourceProp, source);
      await plugin.set(
        'https://atomicdata.dev/properties/name',
        'Bank statements',
      );
      await plugin.set(
        'https://atomicdata.dev/properties/description',
        'Import bank transactions from MT940 and camt.053 statement exports.',
      );
      await plugin.save();
    },
    readFileSync(resolve(repo, 'integrations/money/plugin.js'), 'utf8'),
  );
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  const publication = page.waitForResponse(
    response =>
      response.url().endsWith('/plugin-release') &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Publish to integration store' })
    .click();
  const published = await publication;
  expect(published.ok(), await published.text()).toBe(true);

  return ((await published.json()) as { id: string }).id;
}

/**
 * Loads `source` into the App on screen, names it, and lets it render
 * `rowClass`. The entry point and `renders` are found by value: their
 * property subjects are minted per drive.
 */
async function loadApp(
  page: Page,
  source: string,
  rowClass: string,
  name: string,
) {
  await page.evaluate(
    async args => {
      const store = window.store!;
      const subject = new URL(location.href).searchParams.get('subject')!;
      const app = await store.getResource(subject);
      let loaded = false;

      // `renders`: the drive-local property, named so by its shortname, that
      // the App's own class lists. A fresh App may not hold it yet.
      let renders: string | undefined;

      for (const klass of (app.get('https://atomicdata.dev/properties/isA') ??
        []) as string[]) {
        const schema = await store.getResource(klass);

        for (const key of ['recommends', 'requires']) {
          for (const property of (schema.get(
            `https://atomicdata.dev/properties/${key}`,
          ) ?? []) as string[]) {
            const p = await store.getResource(property);
            if (
              p.get('https://atomicdata.dev/properties/shortname') === 'renders'
            )
              renders = property;
          }
        }
      }

      if (!renders)
        throw new Error('could not find the app’s renders property');
      const current = (app.get(renders) ?? []) as string[];
      await app.set(renders, [...current, args.rowClass]);

      for (const [, value] of Object.entries(app.getPropVals())) {
        if (typeof value !== 'string' || !value.includes(':')) continue;
        const child = await store.getResource(value).catch(() => undefined);
        const sourceProp =
          child &&
          Object.entries(child.getPropVals()).find(
            ([, v]) =>
              typeof v === 'string' && v.includes('export async function view'),
          )?.[0];
        if (!child || !sourceProp) continue;
        await child.set(sourceProp, args.source);
        await child.save();
        loaded = true;
      }

      await app.set('https://atomicdata.dev/properties/name', args.name);
      await app.save();
      if (!loaded) throw new Error('could not find the app’s entry point');
    },
    { source, rowClass, name },
  );
}
