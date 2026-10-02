// @wc-ignore-file
/**
 * The Moneybird drive app (`integrations/money/moneybird/`, read-only
 * contacts, atomic-plugins#102), end to end against the mock integration
 * proxy serving the SYNTHETIC Moneybird fixture
 * (`integrations/money/fixtures/moneybird/`, not a recording).
 *
 * The app is installed from the catalog, the way the Pets spec does it:
 * Integrations, Drive apps, Install. The lane's dev-server stands in for
 * GitHub Pages: it serves the committed `apps/moneybird/<version>/ui.js` and
 * points the entry's `app-module` there, keeping `app-module-integrity` as
 * committed, and serves the entry enabled although the published catalog
 * keeps it `enabled: false` (integrations/tooling/dev-server.mjs).
 *
 * Journey: connect through the host's consent bar and the mock proxy, choose
 * an administration, import typed rows, reload (the fixture fails that
 * refresh on purpose: every second read of an administration fails on page
 * 2), see the error and the rows still there, then sync again.
 *
 *   node integrations/tooling/run-lane.mjs money --tier e2e
 */
import { test, expect, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';

/** The catalog's version of the Moneybird app (integrations/catalog.json). */
const VERSION = '0.1.1';

test.describe('moneybird integration', () => {
  test.beforeEach(before);

  test('Moneybird: connect, choose an administration, import contacts, survive a failed refresh', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(180_000);
    const main = page.getByRole('main');
    const app = page.frameLocator('iframe[title="App"]');

    // Discovery and installation from the catalog's Drive apps section.
    const card = await openCatalogCard(page);
    await expect(
      card.getByRole('heading', { name: 'Moneybird' }),
    ).toBeVisible();
    await expect(card).toContainText(`Version ${VERSION}`);
    await card.getByRole('button', { name: 'Install Moneybird' }).click();
    await expect(main.locator('iframe[title="App"]')).toBeVisible({
      timeout: 45_000,
    });
    await expect(app.getByRole('heading', { name: 'Moneybird' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(app.getByRole('status')).toContainText('Not connected');
    await app.getByRole('button', { name: 'Connect Moneybird' }).click();

    const consent = page.getByRole('group', { name: 'Connect an account' });
    await expect(consent).toContainText('Moneybird');
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Moneybird with this destination',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    // Administration selection.
    await expect(app.getByRole('status')).toContainText(
      'Choose the Moneybird administration',
      { timeout: 30_000 },
    );
    await app
      .getByLabel('Administration')
      .selectOption({ label: 'Synthetic Studio B.V.' });
    await app.getByRole('button', { name: 'Import contacts' }).click();
    await expect(
      app.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toContainText('5 contacts (5 added', { timeout: 30_000 });

    // Reload: the stored administration is used again, and this second read
    // fails in the synthetic fixture. The error says the rows are kept.
    await page.reload();
    await expect(app.getByRole('status')).toContainText('Refresh failed', {
      timeout: 30_000,
    });
    await expect(app.getByRole('status')).toContainText('503');
    await expect(app.getByRole('status')).toContainText('kept');

    // The next refresh succeeds and finds all five rows still there: none
    // added again, none changed.
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(
      app.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toContainText('5 contacts (0 added, 0 updated, 5 unchanged)', {
      timeout: 30_000,
    });

    // Typed rows: an ordinary table outside the app.
    const table = await tableOf(page);
    await page.goto(
      `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(table)}`,
    );
    for (const name of [
      'Fictief Bakkerij B.V.',
      'Anna Voorbeeld',
      'Bram Proef',
    ])
      await expect(main.getByText(name, { exact: true }).first()).toBeVisible();
    const datatypes = await page.evaluate(async subject => {
      const store = window.store!;
      const t = await store.getResource(subject);
      const klass = await store.getResource(
        t.get('https://atomicdata.dev/properties/classtype') as string,
      );
      const fields = klass.get(
        'https://atomicdata.dev/properties/recommends',
      ) as string[];
      const properties = await Promise.all(
        fields.map(s => store.getResource(s)),
      );

      return Object.fromEntries(
        properties.map(p => [
          p.get('https://atomicdata.dev/properties/shortname'),
          p.get('https://atomicdata.dev/properties/datatype'),
        ]),
      );
    }, table);
    expect(datatypes).toMatchObject({
      'moneybird-archived': 'https://atomicdata.dev/datatypes/boolean',
      'moneybird-version': 'https://atomicdata.dev/datatypes/integer',
      'moneybird-email': 'https://atomicdata.dev/datatypes/string',
    });
  });
});

/** The app's table: the value on the app that is a Table. */
async function tableOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const store = window.store!;
    const subject = new URL(location.href).searchParams.get('subject')!;
    const app = await store.getResource(subject);

    for (const candidate of Object.values(app.getPropVals()).filter(
      (v): v is string => typeof v === 'string' && v.includes(':'),
    )) {
      const child = await store.getResource(candidate).catch(() => undefined);
      const classes = child?.get('https://atomicdata.dev/properties/isA');
      if (
        Array.isArray(classes) &&
        classes.some(c => String(c).endsWith('/classes/Table'))
      )
        return candidate;
    }

    throw new Error('could not find the app’s table');
  });
}

/** The Integrations page's Moneybird card, with experimental plugins shown. */
async function openCatalogCard(page: Page) {
  await page.goto(new URL('/app/integrations', page.url()).href);
  const experimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await experimental.check();
  // Disabled while the setting is still saving to the private drive.
  await expect(experimental).toBeEnabled({ timeout: 30_000 });

  return page
    .getByRole('region', { name: 'Drive apps' })
    .locator('[data-catalog-app="moneybird"]');
}
