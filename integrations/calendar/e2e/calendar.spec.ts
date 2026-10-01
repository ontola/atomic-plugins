// @wc-ignore-file
/**
 * The Calendar drive app (`../app/`) end to end, in its null-origin plugin
 * frame on the pinned atomic-server: connect Google Calendar through the
 * host's consent bar and the mock integration proxy, choose one calendar,
 * import it, refresh after a Google-side edit, then preview and send a local
 * edit — including an ETag conflict and a write whose response is lost. The
 * Month hand-off opens the app's table in the host, whose own Calendar view
 * reads the rows by the host's calendar field names (`calendarFields` in
 * atomic-server `browser/lib/src/calendar-date.ts`).
 *
 * The frame calls the proxy itself (#54 phase 2): a capability from the page,
 * each request signed with the frame's own key, `If-Match` passed through.
 * The mock proxy checks every signature the way the real one does.
 *
 * The provider is the mock proxy's stateful google-calendar fixture
 * (`../fixtures/google-calendar/scenario.mjs`). Its Google-side edits are
 * made through the mock's test drivers (`POST /fixture/google-calendar/...`).
 * Nothing here talks to Google; see README.md for what is and isn't live
 * verified.
 *
 * Each test installs the app from the catalog, as the pets spec does: the
 * Integrations page's Drive apps section, with the lane's dev-server serving
 * the committed `apps/calendar/<version>/ui.js` in place of GitHub Pages and
 * the host checking it against the catalog's integrity hash.
 *
 *   node integrations/tooling/run-lane.mjs calendar --tier e2e
 */
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';
import { OPERATIONS, operationFor, type RelayRequest } from '../app/operations';

const APP_FRAME = 'iframe[title="App"]';
/** The catalog's version of this app (integrations/catalog.json). */
const VERSION = '0.1.4';
const NAME = 'https://atomicdata.dev/properties/name';
/** The host's shared calendar field names (`@tomic/lib` `calendarFields`). */
const DAY = 'atomic-calendar-day';
const ALL_DAY = 'atomic-calendar-all-day';
const END_DAY = 'atomic-calendar-end-day';
const NOTES = 'atomic-calendar-notes';

test.describe('calendar drive app', () => {
  test.beforeEach(before);

  test('imports one Google calendar and sends reviewed edits with If-Match', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY ||
        !process.env.INTEGRATION_PROXY_URL,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    await installFromCatalog(page);

    const app = page.frameLocator(APP_FRAME);
    // The #89 design: the status pill carries the sync state in words, the
    // header's primary action is "Sync now" or "Review N changes", and the
    // review happens in a sheet (a dialog).
    const pill = app.locator('.pill');
    const syncNow = () =>
      app.getByRole('button', { name: 'Sync now', exact: true }).first();
    const sheet = app.getByRole('dialog');
    await expect(
      app.getByRole('heading', { name: 'Bring your calendar into Atomic' }),
    ).toBeVisible();
    await expect(
      app.getByRole('button', { name: 'Connect Google Calendar' }),
    ).toBeVisible();
    await connectThroughHost(page, app);

    // Calendar selection: both calendars listed, the primary preselected.
    const choose = app.getByRole('form', { name: 'Choose a calendar' });
    await expect(choose.getByRole('radio', { name: /Synthetic/ })).toBeChecked({
      timeout: 30_000,
    });
    const team = choose.getByRole('radio', { name: /Team/ });
    await expect(team).not.toBeChecked();
    await expect(
      choose.locator('li').filter({ hasText: 'Team' }).getByText('Read-only'),
    ).toBeVisible();
    await choose.getByRole('button', { name: 'Import this calendar' }).click();

    // Bounded, paged import: the two all-day events and the timed one; the
    // weekly series (master and instance) and the cancelled event are not
    // imported.
    await expect(pill).toContainText('Synced', { timeout: 30_000 });
    await app.getByRole('button', { name: 'Agenda', exact: true }).click();
    await expect(app.locator('.agenda')).toContainText(
      '2 recurring events and 1 cancelled event aren’t imported yet.',
    );
    await expect(
      app.getByRole('button', { name: /^Calendar timed fixture, .*Room 4/ }),
    ).toBeVisible();
    const imported = await rowsOf(page);
    expect(imported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Calendar all-day fixture',
          [ALL_DAY]: true,
        }),
        expect.objectContaining({
          name: 'Calendar timed fixture',
          location: 'Room 4',
          [NOTES]: 'Synthetic agenda',
          [ALL_DAY]: false,
        }),
        expect.objectContaining({
          name: 'Calendar three-day fixture',
          [ALL_DAY]: true,
        }),
      ]),
    );
    expect(imported).toHaveLength(3);
    const timed = imported.find(r => r.name === 'Calendar timed fixture')!;
    expect(timed.start).toMatch(/^\d{4}-\d{2}-\d{2}T09:30:00\+02:00$/);
    expect(timed[DAY]).toBe((timed.start as string).slice(0, 10));
    // Within one day: no End day.
    expect(timed).not.toHaveProperty(END_DAY);
    const allDay = imported.find(r => r.name === 'Calendar all-day fixture')!;
    expect(allDay.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(allDay[DAY]).toBe(allDay.start);
    // The host reads End day as exclusive, as Google's all-day end is.
    expect(allDay[END_DAY]).toBe(allDay.end);
    const trip = imported.find(r => r.name === 'Calendar three-day fixture')!;
    expect(trip[DAY]).toMatch(/^\d{4}-\d{2}-10$/);
    expect(trip[END_DAY]).toMatch(/^\d{4}-\d{2}-13$/);

    // Sync after an edit made in Google.
    await driver('editRemote', ['timed', { location: 'Room 2' }]);
    await syncNow().click();
    await expect(
      app.getByRole('button', { name: /^Calendar timed fixture, .*Room 2/ }),
    ).toBeVisible();
    // The app writes as the app agent; the page's store sees it once the
    // commit comes back, so poll.
    await expect
      .poll(async () => (await rowsOf(page)).map(r => r.location).sort())
      .toEqual(['', '', 'Room 2']);

    // A local edit is previewed, not sent, until approved.
    await setRowTitle(page, 'Calendar timed fixture', 'Renamed here');
    await syncNow().click();
    await app.getByRole('button', { name: 'Review 1 change' }).click();
    await expect(sheet).toContainText('Send 1 change to Google Calendar');
    await expect(sheet).toContainText(
      /Title\s*Calendar timed fixture\s*→\s*becomes\s*Renamed here/,
    );
    expect((await driver('state', [])).writes).toEqual([]);
    const sendOne = sheet.getByRole('button', {
      name: 'Send 1 change to Google',
    });
    await sendOne.click();
    await expect(sheet).toContainText('1 of 1 change sent');
    await expect(sheet).toContainText('Calendar timed fixture: Sent');
    const afterSend = await driver('state', []);
    expect(afterSend.writes).toEqual([
      expect.objectContaining({
        id: 'timed',
        patch: { summary: 'Renamed here' },
        ifMatch: expect.stringMatching(/^"v\d+"$/),
      }),
    ]);
    await sheet.getByRole('button', { name: 'Done' }).click();

    // ETag conflict: Google changes the event between preview and send.
    await setRowTitle(page, 'Renamed here', 'Renamed twice');
    await syncNow().click();
    await app.getByRole('button', { name: 'Review 1 change' }).click();
    await expect(sheet).toContainText(
      /Renamed here\s*→\s*becomes\s*Renamed twice/,
    );
    await driver('editRemote', ['timed', { location: 'Room 9' }]);
    await sendOne.click();
    await expect(sheet).toContainText('0 of 1 change sent');
    await expect(sheet).toContainText('Changed in Google since this preview');
    expect((await driver('state', [])).writes).toHaveLength(1);

    // A lost response: the PATCH reaches the proxy, its answer never
    // reaches the frame. The app says it can't know.
    await sheet.getByRole('button', { name: 'Review again' }).click();
    await expect(sheet).toContainText(
      /Renamed here\s*→\s*becomes\s*Renamed twice/,
    );
    await page.route('**/proxy/*/google-calendar/**', async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fetch();
      await route.abort('connectionreset');
    });
    await sendOne.click();
    await expect(sheet).toContainText('Unknown whether Google applied it');
    await page.unroute('**/proxy/*/google-calendar/**');
    expect((await driver('state', [])).writes).toHaveLength(2);
    await sheet.getByRole('button', { name: 'Done' }).click();
    const banner = app.locator('.banner');
    await expect(banner).toContainText('may or may not have applied');

    // Nothing was spent (there are no connection codes any more): the same
    // connection syncs straight away. Google has the change, so the new
    // preview agrees: nothing to review, no conflict.
    await banner.getByRole('button', { name: 'Sync now' }).click();
    await expect(pill).toContainText('Synced', { timeout: 30_000 });
    await expect(banner).toHaveCount(0);
    await expect(app.getByRole('button', { name: /^Review \d/ })).toHaveCount(
      0,
    );
    expect((await driver('state', [])).writes).toHaveLength(2);

    // Compare on open (#192): an edit made in the host's table, in the
    // host's format (End day, exclusive), found when the app opens again and
    // sent, after review, as Google's end date.
    const oneDay = (await rowsOf(page)).find(
      r => r.name === 'Calendar all-day fixture',
    )!;
    const later = new Date(Date.parse(`${oneDay[END_DAY]}T00:00:00Z`) + 864e5)
      .toISOString()
      .slice(0, 10);
    await setRowField(page, 'Calendar all-day fixture', END_DAY, later);
    await page.reload();
    // No Sync now: opening the app compares the rows with their baselines.
    const review = app.getByRole('button', { name: 'Review 1 change' });
    await expect(review).toBeVisible({ timeout: 30_000 });
    await review.click();
    // The sheet shows the last day (End day minus one), not the raw date.
    await expect(sheet).toContainText('Calendar all-day fixture');
    await expect(sheet).toContainText(/End[^→]*→\s*becomes/);
    expect((await driver('state', [])).writes).toHaveLength(2);
    await sendOne.click();
    await expect(sheet).toContainText('1 of 1 change sent');
    expect((await driver('state', [])).writes.at(-1)).toEqual(
      expect.objectContaining({
        id: 'all-day',
        patch: { end: { date: later } },
        ifMatch: expect.stringMatching(/^"v\d+"$/),
      }),
    );
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect
      .poll(
        async () =>
          (await rowsOf(page)).find(r => r.name === 'Calendar all-day fixture')
            ?.end,
      )
      .toBe(later);

    // The connection lives at the proxy, owned by the signed-in user and
    // delegated to this app; the page keeps nothing credential-like.
    const connections = await proxyConnections('google-calendar');
    expect(connections).toHaveLength(1);
    expect(connections[0].owner).toBe(await signedInAgent(page));
    expect(connections[0].delegations).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage))).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^atomic-proxy-connect|connection-v1/),
      ]),
    );

    // The declared scope (app/operations.ts) is what the frame sent: every
    // request the mock proxy received is one of the three declared
    // operations, with their query parameters and If-Match (`operationFor`
    // throws, naming the request, for anything else), and all three were
    // used. Nothing else reached the proxy, so nothing else reached Google.
    const sent = (await driver('received', [])) as RelayRequest[];
    expect(sent.length).toBeGreaterThan(5);
    const used = new Set(sent.map(request => operationFor(request).id));
    expect([...used].sort()).toEqual(OPERATIONS.map(o => o.id).sort());
    expect(sent.filter(r => r.method === 'PATCH').map(r => r.ifMatch)).toEqual(
      sent
        .filter(r => r.method === 'PATCH')
        .map(() => expect.stringMatching(/^"v\d+"$/)),
    );
  });
});

test.describe('calendar drive app: responsive and theme (#89 C13)', () => {
  // Wide enough that a 1200px frame is not clipped by the host page.
  test.use({ viewport: { width: 1680, height: 900 } });
  test.beforeEach(before);

  test('fits 360, 720 and 1200px frames in light and dark without horizontal scroll', async ({
    page,
  }, testInfo) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY ||
        !process.env.INTEGRATION_PROXY_URL,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    await page.emulateMedia({ colorScheme: 'light' });
    await installFromCatalog(page);
    const app = page.frameLocator(APP_FRAME);
    await connectThroughHost(page, app);
    await importPrimary(app);

    // The host re-sends its theme into the frame; the view follows it
    // without a reload (DESIGN.md §3).
    const root = app.locator('.pl-app');
    await root.evaluate(el => el.setAttribute('data-e2e-mark', 'kept'));
    const html = app.locator('html');
    await expect(html).toHaveAttribute('data-pl-theme', 'light');

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(html).toHaveAttribute('data-pl-theme', scheme);
      await expect(root).toHaveAttribute('data-e2e-mark', 'kept');

      for (const width of [360, 720, 1200]) {
        await page.locator(APP_FRAME).evaluate((el, w) => {
          (el as HTMLElement).style.width = `${w}px`;
          (el as HTMLElement).style.maxWidth = 'none';
        }, width);
        await expect
          .poll(() =>
            root.evaluate(el => el.ownerDocument.documentElement.clientWidth),
          )
          .toBe(width);
        const overflow = await root.evaluate(el => {
          const doc = el.ownerDocument.documentElement;

          return doc.scrollWidth - doc.clientWidth;
        });
        expect(overflow, `${scheme} ${width}px scrolls sideways`).toBe(0);
        // Week below 720px only when chosen; Agenda is the default there.
        await expect(
          width < 720
            ? app.locator('.agenda, .wk')
            : app.locator('.wk, .agenda'),
        ).toBeVisible();
        const axe = await new AxeBuilder({ page }).include(APP_FRAME).analyze();
        expect(
          axe.violations.map(v => `${v.id}: ${v.nodes.length}`),
          `${scheme} ${width}px`,
        ).toEqual([]);
        await testInfo.attach(`calendar-${width}-${scheme}.png`, {
          body: await page.locator(APP_FRAME).screenshot(),
          contentType: 'image/png',
        });
      }
    }
  });

  test('hands links, Month and Disconnect to the host (pin 007869464)', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY ||
        !process.env.INTEGRATION_PROXY_URL,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    await installFromCatalog(page);
    const app = page.frameLocator(APP_FRAME);
    await connectThroughHost(page, app);
    await importPrimary(app);

    // C8: the host asks before opening Google's page for the event.
    await app.getByRole('button', { name: 'Agenda', exact: true }).click();
    // The mock's fixture is shared by the lane's tests, so the timed event
    // may carry an earlier test's title; it is the one with a room.
    await app
      .getByRole('button', { name: /, Room \d+, Synthetic calendar/ })
      .click();
    await app
      .getByRole('dialog')
      .getByRole('button', { name: 'Open in Google Calendar ↗' })
      .click();
    const ask = page.getByRole('group', { name: 'Open a link' });
    await expect(ask).toContainText(
      'https://www.google.com/calendar/event?eid=dGltZWQgc3ludGhldGlj',
    );
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toHaveCount(0);
    await app
      .getByRole('dialog')
      .getByRole('button', { name: 'Close' })
      .click();

    // Disconnect: only this app's delegation goes; the connection and the
    // rows stay.
    await app.getByRole('button', { name: 'Connection menu' }).click();
    await app.getByRole('menuitem', { name: /^Disconnect/ }).click();
    await expect(
      app.getByRole('button', { name: 'Connect Google Calendar' }),
    ).toBeVisible();
    const owner = await signedInAgent(page);
    await expect
      .poll(async () =>
        (await proxyConnections('google-calendar'))
          .filter(c => c.owner === owner)
          .map(c => c.delegations.length),
      )
      .toEqual([0]);
    expect(await rowsOf(page)).toHaveLength(3);
  });

  test('Month opens the app’s table in the host, whose Calendar view spans all-day ranges (#172)', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY ||
        !process.env.INTEGRATION_PROXY_URL,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    await installFromCatalog(page);
    const app = page.frameLocator(APP_FRAME);
    await connectThroughHost(page, app);
    await importPrimary(app);
    const table = await tableOf(page);
    // The mock's fixture is shared by the lane's tests, so the timed event
    // may carry an earlier test's title; it is the one with a room.
    const rows = await rowsOf(page);
    const timed = rows.find(r => /^Room \d+$/.test(String(r.location)))!;
    const trip = rows.find(r => r.name === 'Calendar three-day fixture')!;
    const allDay = rows.find(r => r.name === 'Calendar all-day fixture')!;
    await app.getByRole('button', { name: 'Month ↗' }).click();
    await expect.poll(() => decodeURIComponent(page.url())).toContain(table);

    // The host table's own Calendar view (atomic-server CalendarView.tsx):
    // it places rows by the first date column, `atomic-calendar-day`, and
    // only then spans an all-day row from Day up to End day, exclusive.
    await page.getByRole('button', { name: 'Add view' }).click();
    await page.getByTestId('menu-item-calendar').click();
    await expect(page.getByTestId('calendar-view')).toBeVisible({
      timeout: 30_000,
    });
    const cell = (date: unknown) =>
      page.locator(`[data-testid="calendar-day"][data-date="${date}"]`);
    const chip = (date: unknown, name: unknown) =>
      cell(date)
        .getByTestId('calendar-event')
        .filter({ hasText: String(name) });
    // The fixture puts the three-day event in the fixture day's month, which
    // is the month the view opens on (both are today, give or take the
    // browser's zone at midnight).
    const month = String(trip[DAY]).slice(0, 8);
    await expect(cell(`${month}10`)).toBeVisible();

    for (const day of ['10', '11', '12'])
      await expect(
        chip(`${month}${day}`, trip.name),
        `three-day event on the ${day}th`,
      ).toBeVisible({ timeout: 15_000 });
    // Exclusive end: not on the 13th, and not the day before.
    await expect(chip(`${month}13`, trip.name)).toHaveCount(0);
    await expect(chip(`${month}09`, trip.name)).toHaveCount(0);
    // The other all-day event is not drawn on its End day. (The fixture is
    // shared: after the first test's End day edit it is two days long.)
    await expect(chip(allDay[DAY], allDay.name)).toBeVisible();
    await expect(chip(allDay[END_DAY], allDay.name)).toHaveCount(0);
    // A timed event shows on its day.
    await expect(chip(timed[DAY], timed.name)).toBeVisible();
  });
});

/** Connect, consent in the host's bar, then the mock proxy's page. */
async function connectThroughHost(page: Page, app: FrameLocator) {
  await app.getByRole('button', { name: 'Connect Google Calendar' }).click();
  // Drawn by the host page, outside the frame: only a click here navigates.
  const consent = page.getByRole('group', { name: 'Connect an account' });
  await expect(consent).toContainText('Google Calendar');
  await consent.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Mock integration proxy' }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: 'Use LocalThought to sync Google Calendar with this destination',
      exact: true,
    })
    .click();
  await expect(page).not.toHaveURL(/connection_code=|integration_state=/);
}

/**
 * Imports the preselected (primary) calendar once the picker has listed it.
 * Coming back from the proxy reloads the page, and the frame then lists the
 * calendars; on a loaded host that can take longer than a click's own 10 s,
 * so wait for the preselection first, as the first test does.
 */
async function importPrimary(app: FrameLocator) {
  const choose = app.getByRole('form', { name: 'Choose a calendar' });
  await expect(choose.getByRole('radio', { name: /Synthetic/ })).toBeChecked({
    timeout: 30_000,
  });
  await choose.getByRole('button', { name: 'Import this calendar' }).click();
  await expect(app.locator('.pill')).toContainText('Synced', {
    timeout: 30_000,
  });
}

interface MockConnection {
  connection_id: string;
  platform: string;
  owner: string;
  delegations: { agent: string; label: string | null }[];
}

/** The mock proxy's connections for `platform` (test-side introspection). */
async function proxyConnections(platform: string): Promise<MockConnection[]> {
  const response = await fetch(
    `${process.env.INTEGRATION_PROXY_URL}/__mock/connections`,
  );
  const { connections } = (await response.json()) as {
    connections: MockConnection[];
  };

  return connections.filter(c => c.platform === platform);
}

/** The signed-in agent as the proxy names it: `atomic:agent:<base64url>`. */
async function signedInAgent(page: Page): Promise<string> {
  const key = await page.evaluate(() =>
    window.store!.getAgent()!.getPublicKey(),
  );

  return `atomic:agent:${Buffer.from(key, 'base64').toString('base64url')}`;
}

/** Calls a mock-proxy test driver of the google-calendar fixture. */
async function driver(name: string, args: unknown[]) {
  const response = await fetch(
    `${process.env.INTEGRATION_PROXY_URL}/fixture/google-calendar/${name}`,
    { method: 'POST', body: JSON.stringify(args) },
  );
  if (!response.ok) throw new Error(`driver ${name}: HTTP ${response.status}`);

  return response.json();
}

/** The app's table rows, keyed by property shortname, via window.store. */
async function rowsOf(page: Page): Promise<Record<string, unknown>[]> {
  const table = await tableOf(page);

  return page.evaluate(async (subject: string) => {
    const store = window.store!;
    const collection = await (
      await store.getResource(subject)
    ).getChildrenCollection(500);
    const out: Record<string, unknown>[] = [];

    for (const member of await collection.getAllMembers()) {
      // From the server, not the page's cache: what was actually committed.
      const row = await store.fetchResourceFromServer(member, {
        noWebSocket: true,
      });
      const named: Record<string, unknown> = {};

      for (const [property, value] of Object.entries(row.getPropVals())) {
        const shortname = (await store.getResource(property)).get(
          'https://atomicdata.dev/properties/shortname',
        );
        named[typeof shortname === 'string' ? shortname : property] = value;
      }

      out.push(named);
    }

    return out;
  }, table);
}

/** Edits a row's Name the way a table edit would: a commit by the user. */
async function setRowTitle(page: Page, from: string, to: string) {
  const table = await tableOf(page);
  await page.evaluate(
    async ([subject, oldTitle, newTitle, name]) => {
      const store = window.store!;
      const collection = await (
        await store.getResource(subject)
      ).getChildrenCollection(500);

      for (const member of await collection.getAllMembers()) {
        const row = await store.getResource(member);
        if (row.get(name) !== oldTitle) continue;
        await row.set(name, newTitle);
        await row.save();

        return;
      }

      throw new Error(`no row named ${oldTitle}`);
    },
    [table, from, to, NAME] as const,
  );
}

/** Sets one column (by shortname) of the row named `title`: a user's commit, as a table edit is. */
async function setRowField(
  page: Page,
  title: string,
  shortname: string,
  value: string,
) {
  const table = await tableOf(page);
  await page.evaluate(
    async ([subject, rowTitle, short, newValue, name]) => {
      const store = window.store!;
      const collection = await (
        await store.getResource(subject)
      ).getChildrenCollection(500);

      for (const member of await collection.getAllMembers()) {
        const row = await store.getResource(member);
        if (row.get(name) !== rowTitle) continue;

        for (const property of Object.keys(row.getPropVals())) {
          const found = (await store.getResource(property)).get(
            'https://atomicdata.dev/properties/shortname',
          );
          if (found !== short) continue;
          await row.set(property, newValue);
          await row.save();

          return;
        }

        throw new Error(`row ${rowTitle} has no ${short}`);
      }

      throw new Error(`no row named ${rowTitle}`);
    },
    [table, title, shortname, value, NAME] as const,
  );
}

/** The app's table: the value on the app that is a Table (`app-data`). */
async function tableOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const store = window.store!;
    const subject = new URL(location.href).searchParams.get('subject')!;
    const app = await store.getResource(subject);
    const candidates = Object.values(app.getPropVals()).filter(
      (v): v is string => typeof v === 'string' && v.includes(':'),
    );

    for (const candidate of candidates) {
      const child = await store.getResource(candidate).catch(() => undefined);
      if (!child) continue;
      const classes = child.get('https://atomicdata.dev/properties/isA');

      if (
        Array.isArray(classes) &&
        classes.some(c => String(c).endsWith('/classes/Table'))
      )
        return candidate;
    }

    throw new Error('could not find the app’s table');
  });
}

/**
 * Installs the app the way a user does: Integrations page, experimental
 * plugins shown, Drive apps, Install. The host downloads the catalog's
 * `app-module` (the lane's dev-server serves the committed
 * `apps/calendar/<version>/ui.js` in place of GitHub Pages) and refuses it
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
    .locator('[data-catalog-app="calendar"]');
  await expect(entry).toContainText(`Version ${VERSION}`);
  await entry.getByRole('button', { name: 'Install Google Calendar' }).click();
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });

  return entry;
}
