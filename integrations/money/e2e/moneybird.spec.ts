// @wc-ignore-file
/**
 * The Moneybird drive app (`integrations/money/moneybird/`, read-only
 * contacts, hours and financial mutations, atomic-plugins#102), end to end
 * against the mock integration proxy serving the SYNTHETIC Moneybird fixture
 * (`integrations/money/fixtures/moneybird/`, not a recording).
 *
 * The app is installed from the catalog, the way the Pets spec does it:
 * Integrations, Drive apps, Install. The lane's dev-server stands in for
 * GitHub Pages: it serves the committed `apps/moneybird/<version>/ui.js` and
 * points the entry's `app-module` there, keeping `app-module-integrity` as
 * committed, and serves the entry enabled although the published catalog
 * keeps it `enabled: false` (integrations/tooling/dev-server.mjs). The shared
 * classes (`time-entry-v1`, `work-project-v1`, `work-person-v1`,
 * `bank-transaction-v1`) are read by the server and the browser from their
 * published GitHub Pages subjects, as in production; `beforeAll` checks Pages
 * serves them with the committed bytes (ontology-kit/served.mjs).
 *
 * First journey: connect through the host's consent bar and the mock proxy,
 * choose an administration with all three collections, import, reload (the
 * fixture fails that contacts refresh on purpose: every second read of an
 * administration's contacts fails on page 2), see the contacts error next to
 * the two collections that went on and the rows still there, sync again, then
 * read the typed rows: contacts in the app's table, time entries in its
 * `time-entry-v1` table linked to project and person rows, mutations in its
 * `bank-transaction-v1` table with exact amount strings. From 0.3.0 the
 * shared sync-status card (Q-084) carries those results: each collection's
 * count, the failed one's error with its rows kept, and that the app is
 * read-only and overwrites edits in the imported columns.
 *
 * Second journey (#177 item 14): a hand-made `bank-transaction-v1` table gets
 * the app through "+ Add view", first read-only, then "Sync this table to
 * Moneybird" asks the host's "Allow editing", the app is connected and the
 * mutations land in that table; the table and the person's own row are not
 * touched otherwise.
 *
 *   node integrations/tooling/run-lane.mjs money --tier e2e
 */
import { test, expect, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';
import {
  classes as sharedClasses,
  properties as sharedProperties,
} from '../../../ontology-kit/terms.mjs';
import { appVersion } from '../../tooling/apps.mjs';

/**
 * The catalog's version of the Moneybird app (integrations/catalog.json), read at
 * load by `appVersion`, so a version bump needs no edit here.
 */
const VERSION = appVersion('moneybird');

/** The shared classes and fields, as the bundle has them (#177). */
const TIME_ENTRY = sharedClasses['time-entry-v1'].subject;
const WORK_PROJECT = sharedClasses['work-project-v1'].subject;
const WORK_PERSON = sharedClasses['work-person-v1'].subject;
const BANK_TRANSACTION = sharedClasses['bank-transaction-v1'].subject;
const WORK_START = sharedProperties['work-start'].subject;
const WORK_END = sharedProperties['work-end'].subject;
const WORK_PROJECT_LINK = sharedProperties['work-project'].subject;
const WORK_PERSON_LINK = sharedProperties['work-person'].subject;
const BANK_AMOUNT = sharedProperties['bank-amount'].subject;
const BANK_ACCOUNT = sharedProperties['bank-account'].subject;
const BANK_CURRENCY = sharedProperties['bank-currency'].subject;
const BANK_VALUE_DATE = sharedProperties['bank-value-date'].subject;
const NAME = 'https://atomicdata.dev/properties/name';
const IS_A = 'https://atomicdata.dev/properties/isA';
const CLASSTYPE = 'https://atomicdata.dev/properties/classtype';

test.describe('moneybird integration', () => {
  test.beforeAll(async () => {
    const served = (await import(
      '../../../ontology-kit/served.mjs' as string
    )) as {
      classTermPaths(name: string): string[];
      servedProblems(paths: string[]): Promise<string[]>;
      notServedMessage(problems: string[]): string;
    };
    const problems = await served.servedProblems([
      ...served.classTermPaths('time-entry-v1'),
      ...served.classTermPaths('work-project-v1'),
      ...served.classTermPaths('work-person-v1'),
      ...served.classTermPaths('bank-transaction-v1'),
    ]);
    if (problems.length) throw new Error(served.notServedMessage(problems));
  });
  test.beforeEach(before);

  test('Moneybird: connect, choose an administration and collections, import contacts, hours and mutations, survive a failed refresh', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    const main = page.getByRole('main');
    const app = page.frameLocator('iframe[title="App"]');
    const card = app.getByRole('region', { name: 'Sync status' });

    // Discovery and installation from the catalog's Drive apps section.
    const entry = await openCatalogCard(page);
    await expect(
      entry.getByRole('heading', { name: 'Moneybird' }),
    ).toBeVisible();
    await expect(entry).toContainText(`Version ${VERSION}`);
    await entry.getByRole('button', { name: 'Install Moneybird' }).click();
    await expect(main.locator('iframe[title="App"]')).toBeVisible({
      timeout: 45_000,
    });
    await expect(app.getByRole('heading', { name: 'Moneybird' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(app.getByRole('status')).toContainText('Not connected', {
      timeout: 30_000,
    });
    // The sync-status card is there before any sync, and read-only.
    await expect(card).toContainText('Not synced yet');
    await expect(card).toContainText(
      'Read-only: edits here stay in Atomic. Nothing is sent to Moneybird, and the next sync overwrites edits made here in the columns it imports.',
    );
    await app.getByRole('button', { name: 'Connect Moneybird' }).click();
    await connectThroughMockProxy(page);

    // Administration and collection selection: all three ticked by default.
    await expect(app.getByRole('status')).toContainText(
      'Choose the Moneybird administration',
      { timeout: 30_000 },
    );
    await app
      .getByLabel('Administration')
      .selectOption({ label: 'Synthetic Studio B.V.' });
    for (const label of [
      'Contacts',
      'Hours (time entries)',
      'Financial mutations',
    ])
      await expect(app.getByRole('checkbox', { name: label })).toBeChecked();
    await app.getByRole('button', { name: 'Import', exact: true }).click();
    // The card: each collection counted, the totals, and the live region
    // (visually hidden now) still carries the same words.
    await expect(card).toContainText(
      '15 rows imported: 5 contacts, 4 time entries, 6 mutations',
      { timeout: 60_000 },
    );
    await expect(card).toContainText('Synced just now');
    await expect(card).toContainText(
      'Last sync: 15 added, 0 updated, 0 unchanged',
    );
    await expect(card).toContainText('Read-only: edits here stay in Atomic.');
    await expect(app.getByRole('status')).toContainText('5 contacts (5 added');

    // Reload: the stored settings are used again. This second contacts read
    // fails in the synthetic fixture; hours and mutations go on. The card
    // names the failure next to the two that went on, and says the contact
    // rows are kept.
    await page.reload();
    await expect(card).toContainText('Contacts: refresh failed.', {
      timeout: 60_000,
    });
    await expect(card).toContainText('503');
    await expect(card).toContainText('The contacts imported earlier are kept');
    await expect(card).toContainText(
      '10 rows imported: 4 time entries, 6 mutations',
    );
    await expect(card).toContainText(
      'Last sync: 0 added, 0 updated, 10 unchanged',
    );
    await expect(card).toContainText('Press Sync now to try again.');

    // The next refresh succeeds and finds every row still there.
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(card).toContainText(
      '15 rows imported: 5 contacts, 4 time entries, 6 mutations',
      { timeout: 60_000 },
    );
    await expect(card).toContainText(
      'Last sync: 0 added, 0 updated, 15 unchanged',
    );
    await expect(card).not.toContainText('refresh failed');

    // Typed rows: the contacts table outside the app, as before.
    const appSubject = new URL(page.url()).searchParams.get('subject')!;
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

    // The app's own shared-class tables under the App, and their rows, read
    // from the server.
    const own = await ownTables(page, appSubject);
    expect(own[TIME_ENTRY]).toBeDefined();
    expect(own[WORK_PROJECT]).toBeDefined();
    expect(own[WORK_PERSON]).toBeDefined();
    expect(own[BANK_TRANSACTION]).toBeDefined();
    const hours = await rowsOf(page, own[TIME_ENTRY]!);
    expect(hours).toHaveLength(4);

    for (const row of hours) {
      expect(row[IS_A]).toEqual([TIME_ENTRY]);
      expect(typeof row[WORK_START]).toBe('number');
      expect(typeof row[WORK_END]).toBe('number');
      expect(typeof row[WORK_PERSON_LINK]).toBe('string');
    }

    const review = hours.find(r => r[NAME] === 'Design review')!;
    expect(review[WORK_END] as number).toBe(
      (review[WORK_START] as number) + 2.5 * 3_600_000,
    );
    const projects = await rowsOf(page, own[WORK_PROJECT]!);
    expect(projects.map(r => r[NAME]).sort()).toEqual([
      'Bookkeeping',
      'Website relaunch',
    ]);
    expect(projects.map(r => r.subject)).toContain(review[WORK_PROJECT_LINK]);
    const people = await rowsOf(page, own[WORK_PERSON]!);
    expect(people.map(r => r[NAME]).sort()).toEqual([
      'Anna Voorbeeld',
      'Bram Proef',
    ]);
    const mutations = await rowsOf(page, own[BANK_TRANSACTION]!);
    expect(mutations).toHaveLength(6);
    expect(mutations.map(r => r[BANK_AMOUNT]).sort()).toEqual(
      ['1210.0', '-120.5', '-45.99', '-45.99', '2500.0', '-0.35'].sort(),
    );

    for (const row of mutations) {
      expect(row[IS_A]).toEqual([BANK_TRANSACTION]);
      expect(row[BANK_ACCOUNT]).toBe('NL00TEST0000000099');
      expect(row[BANK_CURRENCY]).toBe('EUR');
      expect(row[BANK_VALUE_DATE]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // The mutations table shows in the host as a table of bank transactions.
    await page.goto(
      `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(own[BANK_TRANSACTION]!)}`,
    );
    await expect(
      main.getByText('Nep Hosting', { exact: true }).first(),
    ).toBeVisible({
      timeout: 30_000,
    });
  });

  test('Moneybird: syncs a hand-made bank-transaction-v1 table through Add view after Allow editing (#177 item 14)', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(300_000);
    const main = page.getByRole('main');
    const app = page.frameLocator('iframe[title="App"]');
    const status = app.getByRole('status');
    const card = app.getByRole('region', { name: 'Sync status' });

    const entry = await openCatalogCard(page);
    await entry.getByRole('button', { name: 'Install Moneybird' }).click();
    await expect(main.locator('iframe[title="App"]')).toBeVisible({
      timeout: 45_000,
    });
    // The first open declares the row extras and renders the shared classes.
    await expect(status).toContainText('Not connected', { timeout: 30_000 });
    const appSubject = new URL(page.url()).searchParams.get('subject')!;
    await expect
      .poll(
        async () =>
          (await rendersOf(page, appSubject)).includes(BANK_TRANSACTION),
        {
          timeout: 30_000,
        },
      )
      .toBe(true);

    // A table the person made, of the shared class, with one row of theirs.
    const table = await page.evaluate(
      async ({ klass, name, classtype, amount, account, currency, date }) => {
        const store = window.store!;
        const made = await store.newResource({
          parent: store.getDrive(),
          isA: ['https://atomicdata.dev/classes/Table'],
          propVals: { [name]: 'Bank', [classtype]: klass },
        });
        await made.save();
        const row = await store.newResource({
          parent: made.subject,
          isA: [klass],
          propVals: {
            [name]: 'Cash from the drawer',
            [amount]: '10.00',
            [account]: 'CASH',
            [currency]: 'EUR',
            [date]: '2026-01-02',
          },
        });
        await row.save();

        return made.subject;
      },
      {
        klass: BANK_TRANSACTION,
        name: NAME,
        classtype: CLASSTYPE,
        amount: BANK_AMOUNT,
        account: BANK_ACCOUNT,
        currency: BANK_CURRENCY,
        date: BANK_VALUE_DATE,
      },
    );
    const theirs = await rowsOf(page, table);
    expect(theirs).toHaveLength(1);

    await page.goto(
      `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(table)}`,
    );
    await main.getByRole('button', { name: 'Add view' }).click();
    // Add view lists drive apps once it has read the drive's plugin schema
    // and the github.io terms (#177 S1, H1); money measured about 9 s.
    await page
      .getByRole('menuitem', { name: 'Moneybird' })
      .click({ timeout: 60_000 });
    // Read-only first: the sync asks for itself.
    await page
      .locator('dialog[open]')
      .getByRole('button', { name: 'Read-only' })
      .click();
    await expect(status).toContainText('Not synced with Moneybird', {
      timeout: 45_000,
    });
    // The card says nothing here is overwritten while the table isn't synced.
    await expect(card).toContainText('Not synced yet');
    await expect(card).toContainText(
      'this table is not synced, so nothing here is overwritten',
    );
    await expect(
      app.getByRole('button', { name: 'Connect Moneybird' }),
    ).toHaveCount(0);
    expect(await rowsOf(page, table)).toEqual(theirs);

    await app
      .getByRole('button', { name: 'Sync this table to Moneybird' })
      .click();
    // The host's own bar asks, outside the frame.
    const ask = page.getByRole('group', { name: 'Let this app edit rows' });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await ask.getByRole('button', { name: 'Allow editing' }).click();

    // No connection yet: connect as on the app's own page. Coming back from
    // the proxy reloads the page, and the app goes on with the binding.
    await expect(status).toContainText(
      'Connect Moneybird to import into “Bank”',
      {
        timeout: 45_000,
      },
    );
    await app.getByRole('button', { name: 'Connect Moneybird' }).click();
    await connectThroughMockProxy(page);
    await expect(status).toContainText('into “Bank”', { timeout: 45_000 });
    await expect(status).toContainText('Choose the Moneybird administration');
    // The collection is fixed by the table's class: no checkboxes.
    await expect(app.getByRole('checkbox')).toHaveCount(0);
    await app
      .getByLabel('Administration')
      .selectOption({ label: 'Synthetic Studio B.V.' });
    await app.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(card).toContainText('6 mutations imported', {
      timeout: 60_000,
    });
    await expect(card).toContainText(
      'Last sync: 6 added, 0 updated, 0 unchanged',
    );
    await expect(card).toContainText(
      'the next sync overwrites edits made here in the columns it imports',
    );

    // The rows landed in the person's table, next to theirs, as rows of its
    // class; the table itself and their row are as they were.
    const after = await rowsOf(page, table);
    expect(after).toHaveLength(7);
    expect(after.find(r => r[NAME] === 'Cash from the drawer')).toEqual(
      theirs[0],
    );
    const imported = after.filter(r => r[NAME] !== 'Cash from the drawer');

    for (const row of imported) {
      expect(row[IS_A]).toEqual([BANK_TRANSACTION]);
      expect(row[BANK_ACCOUNT]).toBe('NL00TEST0000000099');
    }

    expect(imported.map(r => r[BANK_AMOUNT]).sort()).toEqual(
      ['1210.0', '-120.5', '-45.99', '-45.99', '2500.0', '-0.35'].sort(),
    );
    // Nothing went to an own mutations table: syncing a bound table makes
    // none (the first run of this spec saw none), and one that exists stays
    // empty.
    const own = await ownTables(page, appSubject);
    if (own[BANK_TRANSACTION])
      expect(await rowsOf(page, own[BANK_TRANSACTION])).toHaveLength(0);
  });
});

/** The host's consent bar, then the mock proxy's connect page, then back. */
async function connectThroughMockProxy(page: Page) {
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
}

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

/** The App's child tables by their `classtype`, from the server. */
async function ownTables(
  page: Page,
  app: string,
): Promise<Record<string, string>> {
  return page.evaluate(async subject => {
    const store = window.store!;
    const children = await (
      await store.getResource(subject)
    ).getChildrenCollection(500);
    const out: Record<string, string> = {};

    for (const member of await children.getAllMembers()) {
      const child = await store.fetchResourceFromServer(member, {
        noWebSocket: true,
      });
      const classtype = child.get(
        'https://atomicdata.dev/properties/classtype',
      );
      if (typeof classtype === 'string') out[classtype] = member;
    }

    return out;
  }, app);
}

/** The rows under `table`, by property subject, from the server. */
async function rowsOf(
  page: Page,
  table: string,
): Promise<Record<string, unknown>[]> {
  return page.evaluate(async subject => {
    const store = window.store!;
    const collection = await (
      await store.getResource(subject)
    ).getChildrenCollection(500);
    const out: Record<string, unknown>[] = [];

    for (const member of await collection.getAllMembers()) {
      const row = await store.fetchResourceFromServer(member, {
        noWebSocket: true,
      });
      const classes = row.get('https://atomicdata.dev/properties/isA');
      // A table's View (Add view adds one) is a child that is not a row.
      if (
        Array.isArray(classes) &&
        classes.some(c => String(c).endsWith('/classes/View'))
      )
        continue;
      out.push({ subject: member, ...row.getPropVals() });
    }

    return out;
  }, table);
}

/** What the App's `renders` lists (its drive's App property, by shortname). */
async function rendersOf(page: Page, app: string): Promise<string[]> {
  return page.evaluate(async subject => {
    const store = window.store!;
    const resource = await store.fetchResourceFromServer(subject, {
      noWebSocket: true,
    });

    for (const [property, value] of Object.entries(resource.getPropVals())) {
      const shortname = (await store.getResource(property)).get(
        'https://atomicdata.dev/properties/shortname',
      );
      if (shortname === 'renders' && Array.isArray(value))
        return value.map(String);
    }

    return [];
  }, app);
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
