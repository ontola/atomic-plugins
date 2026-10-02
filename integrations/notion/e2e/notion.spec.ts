// @wc-ignore-file
/**
 * The Notion drive plugin (`../app/`) end to end: an app in the drive runs
 * `dist/ui.js` in its null-origin frame, connects through the host's consent
 * bar and the mock integration proxy, and imports the mock proxy's notion
 * fixture through syncables/browser, cursor in the POST body included.
 *
 * The connect flow is the proxy's 0.2 one (#54 phase 2): the page redeems the
 * handoff signed with the user's key and delegates the connection to the
 * app's agent; the frame calls the proxy itself with a capability and its
 * own key (atomic-server#1697, in the pin). This spec
 * replaces the old one, which drove the `[data-integration=notion]` card that
 * atomic-server 4bab16ee6 removed (#68). Since 0.2.0 the spec covers
 * two-way edits (#8): an edit made in the host's table is found when the
 * app opens, reviewed and sent as a page PATCH, and a field changed on both
 * sides waits for "Keep mine" or "Use Notion's". Since 0.3.0 the app is a
 * sync-status view (#177 Q9): the rows are read and edited in the host's
 * table (`setRowField`, a user's commit), never through the app. Since 0.4.0
 * select, status and multi-select columns are the host's own select columns
 * (one Tag per Notion option, `app/options.ts`), so the host's table shows
 * option names, and a status edit sets the option's Tag (`setRowOption`).
 *
 * The app is installed from the catalog, as in the pets spec: the
 * Integrations page's Drive apps section, with the lane's dev-server serving
 * the committed `apps/notion/<version>/ui.js` in place of GitHub Pages and
 * the host checking it against the catalog's integrity hash.
 *
 * Run it the way CI would:
 *   node integrations/tooling/run-lane.mjs notion --tier e2e
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';

const APP_FRAME = 'iframe[title="App"]';
/** The catalog's version of this app (integrations/catalog.json). */
const VERSION = '0.4.1';

test.describe('notion drive plugin', () => {
  test.beforeEach(before);
  // No integration-discovery settings: a drive app needs none, and that
  // helper's signature differs between the pinned and newer atomic-server.

  test('imports every shared Notion page through the integration proxy', async ({
    page,
  }, testInfo) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(300_000);
    // The mock proxy outlives an attempt: a retry starts from the seeded
    // pages, options and scenario again, not from what the first one did
    // (Points 9, the renamed option).
    await driver('reset', []);
    await installFromCatalog(page);

    const app = page.frameLocator(APP_FRAME);
    await app.getByRole('button', { name: 'Connect Notion' }).click();
    // The consent bar is drawn by the host, outside the frame, so the frame
    // cannot click it for the user.
    const consent = page.getByRole('group', { name: 'Connect an account' });
    await expect(consent).toContainText('Notion');
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Notion with this destination',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    // Back on the app, which finds its connection and imports on open. The
    // app is a sync-status view (#177 Q9): it names the databases and counts
    // the rows; the rows themselves are in the host's table, below.
    await expect(app.getByRole('status')).toContainText('Synced', {
      timeout: 60_000,
    });
    const appUrl = page.url();
    const card = app.getByRole('region', { name: 'Sync status' });
    await expect(card.getByRole('list', { name: 'Databases' })).toContainText(
      'Roadmap',
    );
    await expect(card).toContainText('3 rows in this table');
    await expect(app.getByRole('table')).toHaveCount(0);
    await app.getByRole('button', { name: 'Sync details' }).click();
    await expect(
      app.getByRole('dialog', { name: 'Sync details' }),
    ).toContainText('1 page has formatting in Notes');
    await page.keyboard.press('Escape');

    // The rows are ordinary rows of the app's table, named by the catalog
    // entry's `app-row-name-plural` ("Pages"). After the connect round trip
    // the app's folder is usually still expanded in the sidebar; expand it
    // only when it is not.
    const sidebar = page.getByRole('navigation').last();
    const items = sidebar.getByRole('button', { name: 'Pages', exact: true });

    if (!(await items.isVisible()))
      await sidebar
        .locator('[data-sidebar-id]')
        .filter({
          has: page.getByRole('button', { name: 'Notion', exact: true }),
        })
        .getByRole('button', { name: 'Expand folder' })
        .click();
    await items.click();
    const main = page.getByRole('main');

    for (const title of ['Launch plan', 'Write changelog', 'Retrospective'])
      await expect(
        main.getByText(title, { exact: true }).first(),
      ).toBeVisible();

    // Status and Tags cells show the option names (the Tags' chips), not
    // Notion's option ids (0.4.0, app/options.ts).
    for (const option of ['In progress', 'Not started', 'release', 'docs'])
      await expect(
        main.getByText(option, { exact: true }).first(),
      ).toBeVisible();
    await expect(main.getByText(DONE_OPTION)).toHaveCount(0);

    // Columns are named after the Notion properties and keep the lens's
    // datatypes rather than becoming JSON; the option columns are the host's
    // select columns (`resourceArray` of Tags, `allowsOnly` = the options).
    const datatypes = await page.evaluate(async () => {
      const store = window.store!;
      const table = await store.getResource(
        new URL(location.href).searchParams.get('subject')!,
      );
      const klass = await store.getResource(
        table.get('https://atomicdata.dev/properties/classtype') as string,
      );
      // Without the host's own `name`, which `createApp` recommends on every
      // row class and which the app never touches.
      const fields = (
        klass.get('https://atomicdata.dev/properties/recommends') as string[]
      ).filter(s => s !== 'https://atomicdata.dev/properties/name');
      const properties = await Promise.all(
        fields.map((s: string) => store.getResource(s)),
      );

      return Object.fromEntries(
        properties.map(p => [
          p.get('https://atomicdata.dev/properties/name'),
          {
            datatype: p.get('https://atomicdata.dev/properties/datatype'),
            isA: p.getClasses(),
            allowsOnly: (
              (p.get('https://atomicdata.dev/properties/allowsOnly') as
                | string[]
                | undefined) ?? []
            ).length,
          },
        ]),
      );
    });
    const RESOURCE_ARRAY = 'https://atomicdata.dev/datatypes/resourceArray';
    const SELECT = 'https://atomicdata.dev/classes/SelectProperty';
    expect(datatypes).toMatchObject({
      Done: { datatype: 'https://atomicdata.dev/datatypes/boolean' },
      Points: { datatype: 'https://atomicdata.dev/datatypes/float' },
      Status: {
        datatype: RESOURCE_ARRAY,
        isA: expect.arrayContaining([SELECT]),
        allowsOnly: 3,
      },
      Tags: { datatype: RESOURCE_ARRAY, allowsOnly: 2 },
      'Last edited in Notion': {
        datatype: 'https://atomicdata.dev/datatypes/timestamp',
      },
    });
    // No column of the platform's own Page fields (`object`, `id`, `url`, …,
    // which 0.4.0 added, named by their raw term path; #303): exactly the
    // fixed columns and one per Notion property.
    expect(Object.keys(datatypes).sort()).toEqual(
      [
        'Notion page id',
        'Data source',
        'Notion URL',
        'Last edited in Notion',
        'Name',
        'Status',
        'Done',
        'Points',
        'Tags',
        'Notes',
      ].sort(),
    );
    for (const name of Object.keys(datatypes))
      expect(name).not.toMatch(/\/property\//);

    // Back to the app for each of its states, against the fixture's
    // scenarios. One connection serves them all.
    await page.goto(appUrl);
    await statesTour(page, testInfo);
  });
});

/** Calls a mock-proxy test driver of the notion fixture. */
async function driver(name: string, args: unknown[]) {
  const base = process.env.INTEGRATION_PROXY_URL;
  if (!base) return null;
  const response = await fetch(`${base}/fixture/notion/${name}`, {
    method: 'POST',
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`driver ${name}: HTTP ${response.status}`);

  return response.json();
}

const DONE_OPTION = 'b1f5a3c2-0001-4000-8000-000000000003';
const LAUNCH_PAGE = '1a2b3c4d-0000-4000-8000-000000000001';
/** The column of the fixture's "Points" (property id `n%3D1`, hex-encoded). */
const POINTS = 'notion-6e25334431';
/** The column of the fixture's "Status" (property id `%3AUPp`, hex-encoded). */
const STATUS = 'notion-253341555070';

/**
 * Sets one column (by shortname) of the row named `title` from the host
 * page: a commit by the user, as an edit in the host's table is. This is
 * how rows are edited since 0.3.0; the app has no cells of its own. With
 * `option` set, `value` is a Notion option id and the cell gets that
 * option's Tag, as picking it in the host's select cell would (0.4.0).
 */
async function setRowField(
  page: Page,
  title: string,
  shortname: string,
  value: string | number | boolean,
  option = false,
) {
  await page.evaluate(
    async ([rowTitle, short, newValue, asOption]) => {
      const store = window.store!;
      const NAME = 'https://atomicdata.dev/properties/name';
      const SHORTNAME = 'https://atomicdata.dev/properties/shortname';
      const ALLOWS_ONLY = 'https://atomicdata.dev/properties/allowsOnly';
      const app = await store.getResource(
        new URL(location.href).searchParams.get('subject')!,
      );

      /** The Tag of a Notion option among a select column's `allowsOnly`. */
      const tagOf = async (column: string, optionId: string) => {
        const property = await store.getResource(column);
        const allowed = (property.get(ALLOWS_ONLY) as string[]) ?? [];

        for (const subject of allowed) {
          const tag = await store.getResource(subject);

          for (const [key, held] of Object.entries(tag.getPropVals())) {
            if (held !== optionId) continue;
            const found = (await store.getResource(key)).get(SHORTNAME);
            if (found === 'notion-option-id') return subject;
          }
        }

        throw new Error(`no tag for option ${optionId} in ${column}`);
      };

      for (const candidate of Object.values(app.getPropVals())) {
        if (typeof candidate !== 'string' || !candidate.includes(':')) continue;
        const table = await store.getResource(candidate).catch(() => undefined);
        if (!table?.get('https://atomicdata.dev/properties/classtype'))
          continue;
        const members = await (
          await table.getChildrenCollection(500)
        ).getAllMembers();

        for (const member of members) {
          const row = await store.getResource(member);
          if (row.get(NAME) !== rowTitle) continue;

          for (const property of Object.keys(row.getPropVals())) {
            const found = (await store.getResource(property)).get(SHORTNAME);
            if (found !== short) continue;
            await row.set(
              property,
              asOption ? [await tagOf(property, String(newValue))] : newValue,
            );
            await row.save();

            return;
          }

          throw new Error(`row ${rowTitle} has no ${short}`);
        }
      }

      throw new Error(`no row named ${rowTitle}`);
    },
    [title, shortname, value, option] as const,
  );
}

/**
 * The app's states in the real frame: text and roles, not pixels.
 * Screenshots go to the test's output folder as artefacts.
 */
async function statesTour(page: Page, testInfo: TestInfo) {
  const app = page.frameLocator(APP_FRAME);
  const status = app.getByRole('status');
  const banner = app.locator('.pl-banner');
  const card = app.getByRole('region', { name: 'Sync status' });
  const databases = card.getByRole('list', { name: 'Databases' });
  const strip = app.locator('.nt-changes');
  const review = app.getByRole('region', {
    name: 'Changes to send to Notion',
  });
  const shot = (name: string) =>
    page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

  /** Presses "Sync now" and waits for the sync to end, in whatever state. */
  const syncNow = async () => {
    await expect(app.getByRole('button', { name: 'Sync now' })).toBeEnabled({
      timeout: 60_000,
    });
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(status).not.toContainText('Syncing', { timeout: 60_000 });
  };

  try {
    // S6, N6: a second database, whose "Status" has another property id,
    // shows on the card after a sync, with its own row count.
    await driver('setScenario', ['two-sources']);
    await expect(status).toContainText('Synced', { timeout: 60_000 });
    await syncNow();
    await expect(
      databases.getByRole('listitem').filter({ hasText: 'Reading list' }),
    ).toContainText('2 rows', { timeout: 60_000 });
    await expect(
      databases.getByRole('listitem').filter({ hasText: 'Roadmap' }),
    ).toContainText('3 rows');
    await expect(card).toContainText('5 rows in this table');
    await expect(app.locator('.pl-connbar')).toContainText('2 databases');
    await shot('s6-status');

    // S10: sync details list what was not copied, per database.
    await app.getByRole('button', { name: 'Sync details' }).click();
    const details = app.getByRole('dialog', { name: 'Sync details' });
    await expect(details).toContainText('Reading list');
    await expect(details).toContainText('Recommended by people');
    await shot('s10-details');
    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();

    // N7: a rename in Notion shows after one sync, rows untouched: the
    // option's Tag is renamed, so the host's table shows "Shipped" where it
    // showed "Done" (0.4.0). Then set the row's Status to that option in
    // the host's table and read it back in the review: before → after by
    // name. Then discard, which puts Notion's value back.
    await driver('renameOption', [DONE_OPTION, 'Shipped']);
    await syncNow();
    const statusAppUrl = page.url();
    await card.getByRole('button', { name: 'Open table' }).click();
    const shipped = page
      .getByRole('main')
      .getByText('Shipped', { exact: true })
      .first();
    await expect(shipped).toBeVisible({ timeout: 30_000 });
    // The chip is in a column to the right of the first screen.
    await shipped.scrollIntoViewIfNeeded();
    await shot('n7-table-renamed');
    await page.goto(statusAppUrl);
    await setRowField(page, 'Launch plan', STATUS, DONE_OPTION, true);
    await page.reload();
    await expect(strip).toContainText('1 change in 1 row not sent to Notion', {
      timeout: 60_000,
    });
    await strip.getByRole('button', { name: 'Review changes' }).click();
    await expect(review).toContainText('Status');
    await expect(review.locator('.nt-r-before')).toHaveText('In progress');
    await expect(review.locator('.nt-r-after')).toHaveText('Shipped');
    await shot('n7-renamed-option');
    await review.getByRole('button', { name: 'Discard' }).click();
    await expect(review).toContainText('Nothing left to send', {
      timeout: 30_000,
    });
    await review.getByRole('button', { name: 'Close' }).click();
    await expect(strip).toHaveCount(0);
    await expect(card).toBeVisible();

    // S15 (#8): compare on open. An edit made in the host's table (a user's
    // commit, as a table edit is) is found when the app opens again, with no
    // request to Notion, and sent only after review.
    await setRowField(page, 'Launch plan', POINTS, 5);
    await page.reload();
    await expect(strip).toContainText('1 change in 1 row not sent to Notion', {
      timeout: 60_000,
    });
    await shot('s15-pending');
    await strip.getByRole('button', { name: 'Review changes' }).click();
    await expect(review).toContainText('Launch plan');
    await expect(review.locator('.nt-r-before')).toHaveText('3');
    await expect(review.locator('.nt-r-after')).toHaveText('5');
    expect(
      (await driver('getPage', [LAUNCH_PAGE])).properties.Points.number,
    ).toBe(3);
    await shot('s15-review');
    await review.getByRole('button', { name: 'Send 1 change' }).click();
    await expect(review.locator('[data-outcome="sent"]')).toHaveText(
      'Sent to Notion',
      { timeout: 60_000 },
    );
    expect(
      (await driver('getPage', [LAUNCH_PAGE])).properties.Points.number,
    ).toBe(5);
    await review.getByRole('button', { name: 'Close' }).click();

    // S16: the same field changed here and in Notion is a conflict; neither
    // side is overwritten until the person picks one.
    await setRowField(page, 'Launch plan', POINTS, 6);
    await driver('editPage', [LAUNCH_PAGE, { Points: { number: 9 } }]);
    await syncNow();
    await expect(strip).toContainText('1 row also changed in Notion', {
      timeout: 60_000,
    });
    await strip.getByRole('button', { name: 'Review changes' }).click();
    await expect(review).toContainText('Also changed in Notion, to 9');
    await expect(review.getByRole('button', { name: /^Send/ })).toBeDisabled();
    await shot('s16-conflict');
    await review.getByRole('button', { name: 'Use Notion’s' }).click();
    await expect(review).toContainText('Nothing left to send', {
      timeout: 30_000,
    });
    expect(
      (await driver('getPage', [LAUNCH_PAGE])).properties.Points.number,
    ).toBe(9);
    await review.getByRole('button', { name: 'Close' }).click();
    await expect(strip).toHaveCount(0);

    // S12: rate limited, with the retry time.
    await driver('setScenario', ['rate-limited']);
    await syncNow();
    await expect(banner).toContainText('Notion asked Atomic to slow down', {
      timeout: 60_000,
    });
    await expect(status).toContainText('Paused until');
    await shot('s12-rate-limited');

    // S13: any other failure, with technical details.
    await driver('setScenario', ['bad-gateway']);
    await banner.getByRole('button', { name: 'Try now' }).click();
    await expect(banner).toContainText('Notion didn’t answer properly', {
      timeout: 60_000,
    });
    await expect(banner.getByText('Technical details')).toBeVisible();
    await expect(status).toHaveText('Sync failed');
    await shot('s13-failed');

    // S5 over kept rows: nothing shared any more; the card still counts them.
    await driver('setScenario', ['empty']);
    await banner.getByRole('button', { name: 'Try again' }).click();
    await expect(banner).toContainText('no longer shares any databases', {
      timeout: 60_000,
    });
    await expect(card).toContainText('5 rows in this table');

    // S11: Notion revoked access; rows are kept.
    await driver('setScenario', ['unauthorized']);
    await syncNow();
    await expect(banner).toContainText('Notion no longer gives Atomic access', {
      timeout: 60_000,
    });
    await expect(
      banner.getByRole('button', { name: 'Reconnect Notion' }),
    ).toBeVisible();
    await shot('s11-reauth');

    // "Open table" (store.openResource) shows the table in the host, where
    // the rows are browsed and edited.
    await driver('setScenario', ['default']);
    const appUrl = page.url();
    await card.getByRole('button', { name: 'Open table' }).click();
    await expect(page).not.toHaveURL(appUrl);
    await expect(
      page.getByRole('main').getByText('Launch plan', { exact: true }).first(),
    ).toBeVisible();
    await page.goto(appUrl);

    // "Disconnect Notion…" (store.proxy.disconnect), after a confirmation:
    // the rows stay, and the app offers to connect again. (The last saved
    // record is the "nothing shared" one, so the pill says so.)
    await expect(status).toHaveText('No databases shared', { timeout: 60_000 });
    await app.getByRole('button', { name: 'More' }).click();
    await app.getByRole('menuitem', { name: 'Disconnect Notion…' }).click();
    await expect(banner).toContainText('Disconnect Notion from this app?');
    await banner
      .getByRole('button', { name: 'Disconnect', exact: true })
      .click();
    await expect(banner).toContainText('Notion is not connected to this app', {
      timeout: 30_000,
    });
    await expect(status).toHaveText('Not connected');
    await expect(card).toContainText('5 rows in this table');
    await shot('disconnected');
  } finally {
    // Leaves the fixture as it found it for any later test; a retry resets
    // it first as well, so this is not what the retry relies on.
    await driver('reset', []);
  }
}

/**
 * Installs the app the way a user does: Integrations page, experimental
 * plugins shown, Drive apps, Install. The host downloads the catalog's
 * `app-module` (the lane's dev-server serves the committed
 * `apps/notion/<version>/ui.js` in place of GitHub Pages) and refuses it
 * unless its bytes match `app-module-integrity`, then opens the new app.
 * Returns the card, for its "Installed <version>" line.
 */
async function installFromCatalog(page: Page) {
  await page.goto(new URL('/app/integrations', page.url()).href);
  const experimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await experimental.check();
  // Disabled while the setting is still saving to the private drive.
  await expect(experimental).toBeEnabled({ timeout: 30_000 });
  const entry = page
    .getByRole('region', { name: 'Drive apps' })
    .locator('[data-catalog-app="notion"]');
  await expect(entry).toContainText(`Version ${VERSION}`);
  await entry.getByRole('button', { name: 'Install Notion' }).click();
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });

  return entry;
}
