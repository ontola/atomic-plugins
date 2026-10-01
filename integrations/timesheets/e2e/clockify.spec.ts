// @wc-ignore-file
/**
 * The Clockify timesheets drive app (`integrations/timesheets/app/`), end to
 * end in a real host: the app runs in its null-origin iframe, connects
 * Clockify through the host's consent bar and the (mock) integration proxy,
 * is set up in the frame (workspace, account, 7/30-day look-back), and
 * imports through the integration proxy into its own table, with the
 * Properties it creates under its own ontology. Then: reload (no
 * duplicates), a changed entry, a wider window, and a proxy failure that
 * leaves the rows readable and recovers.
 *
 * The app is installed from the catalog, as in the Pets spec: the
 * Integrations page's Drive apps section, with the lane's dev-server serving
 * the committed `apps/timesheets/<version>/ui.js` in place of GitHub Pages
 * and the host checking it against the catalog's integrity hash.
 *
 * Provider data changes and failures go through the mock proxy's local-only
 * fixture driver (`POST /__fixture/clockify`, see
 * `../fixtures/clockify/scenario.mjs`).
 *
 * From 0.5.0 the rows are the shared `time-entry-v1` class, linked to rows
 * of the app's Projects and People tables (`work-project-v1`,
 * `work-person-v1`; #177): the app's first open retargets its table and
 * adds the class to its `renders`. The bundle carries the published GitHub
 * Pages subjects, and the pinned server and the browser fetch those terms
 * from Pages themselves, as in production (ontology-kit/README.md, "Plugin
 * e2e tests and the published subjects"): this spec needs network access to
 * ontola.github.io, and `beforeAll` first checks Pages serves the terms
 * with the committed bytes. Run it the way CI does:
 *   node integrations/tooling/run-lane.mjs timesheets --tier e2e
 */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';
import {
  classes as sharedClasses,
  properties as sharedProperties,
} from '../../../ontology-kit/terms.mjs';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { cssRawPlugin } from '../app/build.mjs';

const APP_FRAME = 'iframe[title="App"]';
/** The catalog's version of this app (integrations/catalog.json). */
const VERSION = '0.5.0';
/** The shared classes and fields, as the bundle has them (#177). */
const TIME_ENTRY = sharedClasses['time-entry-v1'].subject;
const WORK_PROJECT = sharedClasses['work-project-v1'].subject;
const WORK_PERSON = sharedClasses['work-person-v1'].subject;
const WORK = {
  start: sharedProperties['work-start'].subject,
  end: sharedProperties['work-end'].subject,
  billable: sharedProperties['work-billable'].subject,
  project: sharedProperties['work-project'].subject,
  person: sharedProperties['work-person'].subject,
};
const NAME = 'https://atomicdata.dev/properties/name';
const IS_A = 'https://atomicdata.dev/properties/isA';
const CLASSTYPE = 'https://atomicdata.dev/properties/classtype';
/** The fixture's workspace (`../fixtures/clockify/scenario.mjs`). */
const WORKSPACE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

/** Sends a command to the mock proxy's Clockify fixture. */
async function fixture(command: Record<string, unknown>) {
  const base = process.env.INTEGRATION_PROXY_URL;
  if (!base) throw new Error('INTEGRATION_PROXY_URL is not set');
  const response = await fetch(`${base}/__fixture/clockify`, {
    method: 'POST',
    body: JSON.stringify(command),
  });
  expect(response.status).toBe(200);

  return (await response.json()) as Record<string, unknown>;
}

/** `start` of every time-entries request the mock has seen, in order. */
async function windowStarts(): Promise<string[]> {
  const { requests } = (await fixture({ action: 'requests' })) as {
    requests: string[];
  };

  return requests
    .filter(r => r.includes('/time-entries?'))
    .map(r => new URL(r.slice(r.indexOf(' ') + 1), 'http://x'))
    .map(u => u.searchParams.get('start')!);
}

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
  ]);
  if (problems.length) throw new Error(served.notServedMessage(problems));
});

test.describe('timesheets drive app', () => {
  test.beforeEach(before);

  test('connects, sets up and imports Clockify entries through the host relay', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    await fixture({ action: 'reset' });
    await installFromCatalog(page);
    const appUrl = page.url();

    const app = page.frameLocator(APP_FRAME);
    const status = app.getByRole('status');
    await expect(
      app.getByRole('heading', { name: 'Clockify timesheets' }),
    ).toBeVisible();
    await expect(status).toContainText('Not connected');
    await app.getByRole('button', { name: 'Connect Clockify' }).click();

    // Drawn by the host page, outside the frame: only a click here navigates.
    const consent = page.getByRole('group', { name: 'Connect an account' });
    await expect(consent).toContainText('Clockify');
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    // An API-key platform: the key is pasted on the proxy's own page and
    // stays there, sealed in the connection; the drive never sees it.
    await page.getByLabel('API key').fill('synthetic-clockify-key');
    await page
      .getByRole('button', { name: 'Connect Clockify', exact: true })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    // Setup, in the frame: the account and its workspaces come through the proxy.
    await expect(status).toContainText('Choose the workspace', {
      timeout: 30_000,
    });
    // #89 frame G2: a radio per workspace (the key sees two), the window.
    await expect(app.getByText('Test Person', { exact: true })).toBeVisible();
    await app.getByRole('radio', { name: 'Test workspace' }).check();
    await app.getByRole('button', { name: 'Last 7 days' }).click();
    await app.getByRole('button', { name: 'Import entries' }).click();

    // Two completed entries; the running timer and the break are not rows.
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '2 created, 0 updated, 0 unchanged, last 7 days.',
      {
        timeout: 60_000,
      },
    );

    // #89 views, read from the observation log's mirror (not the rows).
    await expect(
      app.getByRole('table', { name: /^Hours per project/ }),
    ).toBeVisible();
    await expect(app.getByText('Clockify · Test workspace')).toBeVisible();
    await app.getByRole('tab', { name: 'Projects' }).click();
    await expect(
      app.getByRole('list', { name: 'Time per project' }),
    ).toContainText('Atomic plugins');
    // Both entries were yesterday: on a week's first day, that is last week.
    await app.getByRole('tab', { name: 'Entries' }).click();
    const weekly = app.getByRole('button', { name: /Weekly sync/ });
    if (!(await weekly.count()))
      await app.getByRole('button', { name: 'Previous week' }).click();
    await weekly.click();
    const detail = app.getByRole('dialog', { name: 'Weekly sync' });
    await expect(detail).toContainText('Atomic plugins');
    await expect(detail).toContainText('Test client');
    // "Open Clockify" asks the host (the frame cannot open a tab itself):
    // the host names the destination; cancelling opens nothing.
    await detail.getByRole('button', { name: 'Open Clockify' }).click();
    const openLink = page.getByRole('group', { name: 'Open a link' });
    await expect(openLink).toContainText('app.clockify.me');
    await openLink.getByRole('button', { name: 'Cancel' }).click();
    await expect(openLink).toHaveCount(0);
    // Keyboard focus is back in the host page after its prompt: return to
    // the drawer before Esc.
    await detail.getByRole('heading', { name: 'Weekly sync' }).click();
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await expect(weekly).toBeFocused();
    await app.getByRole('tab', { name: 'Week' }).click();

    const table = await tableOf(page);

    // "Open row in Atomic" shows the entry's table row in the host.
    await app.getByRole('tab', { name: 'Entries' }).click();
    if (!(await weekly.count()))
      await app.getByRole('button', { name: 'Previous week' }).click();
    await weekly.click();
    await detail.getByRole('button', { name: 'Open row in Atomic' }).click();
    await expect(page).not.toHaveURL(appUrl);
    await expect(
      page.getByRole('main').getByText('Weekly sync', { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toBeVisible({
      timeout: 60_000,
    });

    // The drive holds settings, never the connection or the key.
    // The connection lives at the proxy, owned by the signed-in user and
    // delegated to this app; the page keeps nothing credential-like.
    const connections = await proxyConnections('clockify');
    expect(connections).toHaveLength(1);
    expect(connections[0].owner).toBe(await signedInAgent(page));
    expect(connections[0].delegations).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage))).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^atomic-proxy-connect|connection-v1/),
      ]),
    );
    const appValues = await page.evaluate(async () => {
      const store = window.store!;
      const subject = new URL(location.href).searchParams.get('subject')!;

      return JSON.stringify((await store.getResource(subject)).getPropVals());
    });
    expect(appValues).toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(appValues).not.toMatch(
      /connection[-_]?code|bearer|capabilit|synthetic-clockify-key/i,
    );

    // The table is the shared time-entry-v1 class (#177): its columns are
    // the published properties, and project and person are links.
    expect(await columnDatatypes(page, table)).toMatchObject({
      Start: 'https://atomicdata.dev/datatypes/timestamp',
      End: 'https://atomicdata.dev/datatypes/timestamp',
      Billable: 'https://atomicdata.dev/datatypes/boolean',
      Project: 'https://atomicdata.dev/datatypes/atomicURL',
      Person: 'https://atomicdata.dev/datatypes/atomicURL',
    });
    const shared = await sharedOf(page, table);
    expect(shared.table).toBe(TIME_ENTRY);
    expect(shared.renders).toBe(true);
    expect(shared.rows).toHaveLength(2);
    const weeklyRow = shared.rows.find(r => r.name === 'Weekly sync')!;
    expect(weeklyRow).toMatchObject({
      isA: [TIME_ENTRY],
      billable: false,
      project: { isA: [WORK_PROJECT], name: 'Atomic plugins' },
      person: { isA: [WORK_PERSON], name: 'Test Person' },
    });
    expect(typeof weeklyRow.start).toBe('number');
    expect(typeof weeklyRow.end).toBe('number');

    // Reload: the app finds its connection and settings and syncs on open,
    // without creating duplicates.
    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 created, 0 updated, 2 unchanged',
      { timeout: 60_000 },
    );

    // A changed entry in Clockify updates its row in place.
    await fixture({
      action: 'update',
      id: 'entry-1',
      patch: { description: 'Fix plugin source loading (renamed)' },
    });
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 created, 1 updated, 1 unchanged',
      { timeout: 60_000 },
    );

    // The window is recomputed on every run, so it moves with the clock.
    const starts = await windowStarts();
    expect(starts.length).toBeGreaterThanOrEqual(3);
    expect(Date.parse(starts.at(-1)!)).toBeGreaterThan(Date.parse(starts[0]));

    // Widening to 30 days brings in the older entry, and only that one.
    // #89 frame M: the settings sheet over the views.
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = app.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByLabel('Workspace')).toHaveValue(WORKSPACE_ID);
    await settings.getByRole('button', { name: 'Last 30 days' }).click();
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '1 created, 0 updated, 2 unchanged, last 30 days.',
      {
        timeout: 60_000,
      },
    );

    // A proxy failure: the error is shown and nothing is written.
    await fixture({ action: 'fail', status: 503, count: 1 });
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(status).toContainText('Import failed: Clockify request', {
      timeout: 60_000,
    });
    await expect(status).toContainText('failed with 503');
    await expect(status).toContainText('Rows already in the table are kept.');
    // #89 frame J: a banner over the data already on screen.
    await expect(app.getByRole('alert')).toContainText('The last sync failed.');
    await expect(
      app.getByRole('table', { name: /^Hours per project/ }),
    ).toBeVisible();

    // The rows stay an ordinary, readable table outside the app: each entry
    // once, no running timer, no break.
    await expectRows(page, table);

    // Reopening the app recovers: it syncs on open, without duplicates.
    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 created, 0 updated, 3 unchanged',
      { timeout: 60_000 },
    );
    await expectRows(page, table);

    // #123 M2: a conflict and unknown time, as the #89 views show them
    // through `ui/coverage.ts`.
    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toBeVisible({
      timeout: 60_000,
    });
    // An entry without a project inside the running timer's span (project
    // "Atomic plugins"): unclear which project.
    const minute = 60_000;
    await fixture({
      action: 'add',
      entry: {
        id: 'entry-9',
        description: 'No project here',
        userId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        billable: false,
        projectId: null,
        isLocked: false,
        type: 'REGULAR',
        timeInterval: {
          start: clockifyInstant(Date.now() - 40 * minute),
          end: clockifyInstant(Date.now() - 20 * minute),
        },
      },
    });
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '1 created,',
      { timeout: 60_000 },
    );
    await expect(
      app.getByRole('region', { name: 'Conflicts in Clockify' }),
    ).toContainText('Unclear which project: Atomic plugins · No project');

    // The running timer disappears from Clockify's list: a candidate, not
    // yet a deletion, so its span is not loaded (and no longer a conflict).
    await fixture({ action: 'delete', id: 'entry-4' });
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      "1 missing from Clockify's list",
      { timeout: 60_000 },
    );
    await expect(
      app.getByRole('note', { name: 'Not loaded' }).first(),
    ).toContainText('Not loaded: ');
    await expect(
      app.getByRole('region', { name: 'Conflicts in Clockify' }),
    ).toHaveCount(0);

    // #89 frame M: Disconnect, confirmed inline, removes this app's
    // delegation (store.proxy.disconnect); the imported rows stay.
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    const sheet = app.getByRole('dialog', { name: 'Settings' });
    await sheet.getByRole('button', { name: 'Disconnect…' }).click();
    await expect(sheet).toContainText('already imported stay in this drive');
    await sheet
      .getByRole('button', { name: 'Disconnect', exact: true })
      .click();
    await expect(status).toContainText('Not connected', { timeout: 30_000 });
    expect((await proxyConnections('clockify'))[0].delegations).toHaveLength(0);
    await expectRows(page, table);
  });

  test('#123 M3: an edit in the app reaches Clockify only after review, through the proxy', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    await fixture({ action: 'reset' });
    await installFromCatalog(page);
    const appUrl = page.url();
    const app = page.frameLocator(APP_FRAME);
    const status = app.getByRole('status');
    await expect(status).toContainText('Not connected');
    await app.getByRole('button', { name: 'Connect Clockify' }).click();
    const consent = page.getByRole('group', { name: 'Connect an account' });
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByLabel('API key').fill('synthetic-clockify-key');
    await page
      .getByRole('button', { name: 'Connect Clockify', exact: true })
      .click();
    await expect(status).toContainText('Choose the workspace', {
      timeout: 30_000,
    });
    await app.getByRole('radio', { name: 'Test workspace' }).check();
    await app.getByRole('button', { name: 'Last 7 days' }).click();
    await app.getByRole('button', { name: 'Import entries' }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '2 created,',
      { timeout: 60_000 },
    );

    // Edit in the drawer: saved to the row, listed, nothing sent.
    await app.getByRole('tab', { name: 'Entries' }).click();
    const weekly = app.getByRole('button', { name: /Weekly sync/ });
    if (!(await weekly.count()))
      await app.getByRole('button', { name: 'Previous week' }).click();
    await weekly.click();
    const detail = app.getByRole('dialog', { name: 'Weekly sync' });
    await detail.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = app.getByRole('form', { name: 'Edit entry' });
    await form.getByLabel('Description').fill('Weekly sync (notes)');
    await form.getByLabel('Project').selectOption({ label: 'Research' });
    await app.getByRole('button', { name: 'Save', exact: true }).click();
    const changes = app.getByRole('region', { name: 'Changes to send' });
    await expect(changes).toContainText('1 change to send', {
      timeout: 30_000,
    });
    await expect(changes).toContainText('Project: Atomic plugins → Research');
    let log = (await fixture({ action: 'requests' })) as {
      writes: unknown[];
    };
    expect(log.writes).toEqual([]);

    // Compare on open: the edit survives a reload and a sync.
    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(changes).toContainText(
      'Description: Weekly sync → Weekly sync (notes)',
    );

    // Send: one full-replacement PUT through the host's frame client and
    // the proxy's catalog (write overlay), then the row agrees with Clockify.
    await changes.getByRole('button', { name: 'Send 1 to Clockify' }).click();
    await expect(changes).toContainText('“Weekly sync”: Sent', {
      timeout: 60_000,
    });
    log = (await fixture({ action: 'requests' })) as { writes: unknown[] };
    expect(log.writes).toEqual([
      expect.objectContaining({
        method: 'PUT',
        path: expect.stringContaining(
          `/workspaces/${WORKSPACE_ID}/time-entries/entry-2`,
        ),
        body: expect.objectContaining({
          description: 'Weekly sync (notes)',
          projectId: 'eeeeeeeeeeeeeeeeeeeeeeee',
          billable: false,
          tagIds: [],
        }),
      }),
    ]);
    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 created, 0 updated, 2 unchanged',
      { timeout: 60_000 },
    );
    await expect(changes).toHaveCount(0);

    // A proxy without the write overlay refuses the write; the app says so.
    await fixture({ action: 'catalog', readOnly: true });
    await app.getByRole('tab', { name: 'Entries' }).click();
    if (!(await weekly.count()))
      await app.getByRole('button', { name: 'Previous week' }).click();
    await app.getByRole('button', { name: /Weekly sync \(notes\)/ }).click();
    await app.getByRole('button', { name: 'Edit', exact: true }).click();
    await app
      .getByRole('form', { name: 'Edit entry' })
      .getByLabel('Billable')
      .check();
    await app.getByRole('button', { name: 'Save', exact: true }).click();
    await changes.getByRole('button', { name: 'Send 1 to Clockify' }).click();
    await expect(changes).toContainText('does not allow writing to Clockify', {
      timeout: 60_000,
    });
    await fixture({ action: 'catalog', readOnly: false });
  });

  test('#123 M4: a range edit and a conflict resolution reach Clockify after review', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    await fixture({ action: 'reset' });
    // Inside "Fix plugin source loading" (Atomic plugins, 28–26 h ago): an
    // invented Research entry, so the timeline shows "unclear which project".
    const now = Date.now();
    await fixture({
      action: 'add',
      entry: {
        id: 'entry-q',
        description: 'Overlapping research',
        userId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        workspaceId: WORKSPACE_ID,
        billable: false,
        projectId: 'eeeeeeeeeeeeeeeeeeeeeeee',
        taskId: null,
        tagIds: null,
        isLocked: false,
        type: 'REGULAR',
        timeInterval: {
          start: clockifyInstant(now - 27 * 3_600_000),
          end: clockifyInstant(now - 26.5 * 3_600_000),
          duration: 'PT30M',
        },
      },
    });
    await installFromCatalog(page);
    const appUrl = page.url();
    const app = page.frameLocator(APP_FRAME);
    const status = app.getByRole('status');
    await app.getByRole('button', { name: 'Connect Clockify' }).click();
    const consent = page.getByRole('group', { name: 'Connect an account' });
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByLabel('API key').fill('synthetic-clockify-key');
    await page
      .getByRole('button', { name: 'Connect Clockify', exact: true })
      .click();
    await expect(status).toContainText('Choose the workspace', {
      timeout: 30_000,
    });
    await app.getByRole('radio', { name: 'Test workspace' }).check();
    await app.getByRole('button', { name: 'Last 7 days' }).click();
    await app.getByRole('button', { name: 'Import entries' }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '3 created,',
      { timeout: 60_000 },
    );

    // Resolve: keep Atomic plugins over the overlap. Staged, not sent.
    const conflicts = app.getByRole('region', {
      name: 'Conflicts in Clockify',
    });
    await expect(conflicts).toContainText(
      'Unclear which project: Atomic plugins · Research',
    );
    await conflicts
      .getByRole('button', { name: 'Keep Atomic plugins' })
      .click();
    const changes = app.getByRole('region', { name: 'Changes to send' });
    await expect(changes).toContainText('Delete this entry in Clockify', {
      timeout: 30_000,
    });

    // S10: "worked on Research" over a free hour (6–5 h ago, profile zone).
    const hour = Math.floor(now / 3_600_000) * 3_600_000;
    await app.getByRole('button', { name: 'Edit a time range…' }).click();
    const form = app.getByRole('form', { name: 'Edit a time range' });
    await form.getByLabel(/^From/).fill(amsterdamInput(hour - 6 * 3_600_000));
    await form.getByLabel(/^To/).fill(amsterdamInput(hour - 5 * 3_600_000));
    await form
      .getByLabel('What happened')
      .selectOption({ label: 'Worked on Research' });
    await app.getByRole('button', { name: 'Plan changes' }).click();
    await expect(changes).toContainText('2 changes to send', {
      timeout: 30_000,
    });
    await expect(changes).toContainText('Create a new entry');
    let log = (await fixture({ action: 'requests' })) as {
      writes: Array<{ method: string; path: string; body: unknown }>;
    };
    expect(log.writes).toEqual([]);

    // Both survive a reload (bookkeeping on the rows), then go out: the
    // deletion before the create.
    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(changes).toContainText('2 changes to send');
    await changes.getByRole('button', { name: 'Send 2 to Clockify' }).click();
    await expect(changes).toContainText('“Overlapping research”: Sent', {
      timeout: 60_000,
    });
    log = (await fixture({ action: 'requests' })) as typeof log;
    expect(log.writes).toEqual([
      expect.objectContaining({
        method: 'DELETE',
        path: expect.stringContaining('/time-entries/entry-q'),
      }),
      expect.objectContaining({
        method: 'POST',
        path: expect.stringMatching(
          new RegExp(`/workspaces/${WORKSPACE_ID}/time-entries$`),
        ),
        body: expect.objectContaining({
          start: clockifyInstant(hour - 6 * 3_600_000),
          end: clockifyInstant(hour - 5 * 3_600_000),
          projectId: 'eeeeeeeeeeeeeeeeeeeeeeee',
        }),
      }),
    ]);
    await expect(conflicts).toHaveCount(0);

    // Reopen: the new entry has exactly one row, nothing is left to send.
    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 created, 0 updated, 3 unchanged',
      { timeout: 60_000 },
    );
    await expect(changes).toHaveCount(0);
  });
});

/** `datetime-local` text for `at` in the fixture's profile zone. */
const amsterdamInput = (at: number) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(at)
    .replace(' ', 'T');

/** Clockify's instant form: whole seconds, `Z`. */
const clockifyInstant = (at: number) =>
  new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function expectRows(page: Page, table: string) {
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(table)}`,
  );
  const main = page.getByRole('main');

  for (const name of [
    'Fix plugin source loading (renamed)',
    'Weekly sync',
    'Plugin catalog evidence',
  ])
    await expect(main.getByText(name, { exact: true })).toHaveCount(1, {
      timeout: 30_000,
    });

  for (const skipped of ['Still running', 'Lunch'])
    await expect(main.getByText(skipped, { exact: true })).toHaveCount(0);
}

async function columnDatatypes(
  page: Page,
  table: string,
): Promise<Record<string, string>> {
  return page.evaluate(async (subject: string) => {
    const store = window.store!;
    const tableResource = await store.getResource(subject);
    const klass = await store.getResource(
      tableResource.get(
        'https://atomicdata.dev/properties/classtype',
      ) as string,
    );
    const fields = [
      ...((klass.get('https://atomicdata.dev/properties/requires') ??
        []) as string[]),
      ...((klass.get('https://atomicdata.dev/properties/recommends') ??
        []) as string[]),
    ];
    const properties = await Promise.all(fields.map(s => store.getResource(s)));

    return Object.fromEntries(
      properties.map(p => [
        p.get('https://atomicdata.dev/properties/name'),
        p.get('https://atomicdata.dev/properties/datatype'),
      ]),
    );
  }, table);
}

interface SharedRow {
  name: unknown;
  isA: unknown;
  start: unknown;
  end: unknown;
  billable: unknown;
  project?: { isA: unknown; name: unknown };
  person?: { isA: unknown; name: unknown };
}

/**
 * The app's table's class, whether the App renders `time-entry-v1`, and the
 * rows' shared fields with their linked project and person, as committed
 * on the server.
 */
async function sharedOf(
  page: Page,
  table: string,
): Promise<{ table: unknown; renders: boolean; rows: SharedRow[] }> {
  return page.evaluate(
    async ({ subject, entry, work, name, isA, classtype }) => {
      const store = window.store!;
      const app = new URL(location.href).searchParams.get('subject')!;
      await store.reloadResource(app);
      const renders = Object.values(
        (await store.getResource(app)).getPropVals(),
      ).some(v => Array.isArray(v) && v.includes(entry));

      const fresh = (s: string) =>
        store.fetchResourceFromServer(s, { noWebSocket: true });

      const linked = async (s: unknown) => {
        if (typeof s !== 'string') return undefined;

        const r = await fresh(s);

        return { isA: r.get(isA), name: r.get(name) };
      };

      const t = await fresh(subject);
      const collection = await (
        await store.getResource(subject)
      ).getChildrenCollection(500);
      const rows = [];

      for (const member of await collection.getAllMembers()) {
        const row = await fresh(member);
        rows.push({
          name: row.get(name),
          isA: row.get(isA),
          start: row.get(work.start),
          end: row.get(work.end),
          billable: row.get(work.billable),
          project: await linked(row.get(work.project)),
          person: await linked(row.get(work.person)),
        });
      }

      return { table: t.get(classtype), renders, rows };
    },
    {
      subject: table,
      entry: TIME_ENTRY,
      work: WORK,
      name: NAME,
      isA: IS_A,
      classtype: CLASSTYPE,
    },
  );
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
 * The #89 views frame by frame (`app/ui/preview.ts`: the real views, the
 * mockup's sample data, a stub controller), at the mockups' widths, checked
 * with axe (WCAG 2.1 A/AA rules) and attached as screenshots. No server is
 * needed; it runs in this lane because the lane is where Playwright is.
 */
test.describe('timesheets drive app: any time-entry-v1 table (#177)', () => {
  test.beforeEach(before);

  test('is offered under Add view on a hand-made time-entry-v1 table, and shows its rows without syncing', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await installFromCatalog(page);
    const app = page.frameLocator(APP_FRAME);
    await expect(
      app.getByRole('button', { name: 'Connect Clockify' }),
    ).toBeVisible({ timeout: 45_000 });
    // The first open added time-entry-v1 to what the App renders.
    const own = await tableOf(page);
    await expect
      .poll(async () => (await sharedOf(page, own)).renders, {
        timeout: 30_000,
      })
      .toBe(true);

    // A table the person made, of the shared class, with one entry that
    // links to a project row of their own.
    const table = await page.evaluate(
      async ({ entry, project, work, name, classtype }) => {
        const store = window.store!;
        const today = new Date();
        today.setHours(9, 0, 0, 0);
        const made = await store.newResource({
          parent: store.getDrive(),
          isA: ['https://atomicdata.dev/classes/Table'],
          propVals: { [name]: 'Team hours', [classtype]: entry },
        });
        await made.save();
        const projects = await store.newResource({
          parent: store.getDrive(),
          isA: ['https://atomicdata.dev/classes/Table'],
          propVals: { [name]: 'Team projects', [classtype]: project },
        });
        await projects.save();
        const compiler = await store.newResource({
          parent: projects.subject,
          isA: [project],
          propVals: { [name]: 'Compiler' },
        });
        await compiler.save();
        const row = await store.newResource({
          parent: made.subject,
          isA: [entry],
          propVals: {
            [name]: 'Pairing on the parser',
            [work.start]: today.getTime(),
            [work.end]: today.getTime() + 3_600_000,
            [work.billable]: true,
            [work.project]: compiler.subject,
          },
        });
        await row.save();

        return made.subject;
      },
      {
        entry: TIME_ENTRY,
        project: WORK_PROJECT,
        work: WORK,
        name: NAME,
        classtype: CLASSTYPE,
      },
    );
    const untouched = await sharedOf(page, table);

    await page.goto(
      `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(table)}`,
    );
    await page
      .getByRole('main')
      .getByRole('button', { name: 'Add view' })
      .click();
    // Add view lists drive apps once it has read the drive's plugin schema
    // and the github.io terms (#177 S1, H1); money measured about 9 s.
    await page
      .getByRole('menuitem', { name: 'Clockify' })
      .click({ timeout: 60_000 });
    await page
      .locator('dialog[open]')
      .getByRole('button', { name: 'Read-only' })
      .click();
    await expect(app.getByText('Not synced with Clockify.')).toBeVisible({
      timeout: 45_000,
    });
    await expect(
      app.getByRole('button', { name: 'Connect Clockify' }),
    ).toHaveCount(0);
    await expect(app.getByRole('button', { name: 'Sync now' })).toHaveCount(0);
    await app.getByRole('tab', { name: 'Entries' }).click();
    await app.getByRole('button', { name: /Pairing on the parser/ }).click();
    const detail = app.getByRole('dialog', { name: 'Pairing on the parser' });
    await expect(detail).toContainText('Compiler');
    await expect(detail.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    // Nothing was written to the table or its row.
    expect(await sharedOf(page, table)).toEqual(untouched);
  });
});

test.describe('timesheets views, frame by frame', () => {
  test('every design frame renders without axe violations', async ({
    browser,
  }, testInfo) => {
    const script = await previewScript();
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    // Reduced motion: the drawer does not slide in, so axe measures its
    // final colours (and the reduced-motion styles get exercised).
    const context = await browser.newContext({
      timezoneId: 'Europe/Amsterdam',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.setContent(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Timesheets frames</title></head><body></body></html>',
    );
    await page.addScriptTag({ content: script });
    const frames = await page.evaluate(() =>
      Object.entries(
        (window as unknown as { FRAMES: Record<string, { width: number }> })
          .FRAMES,
      ).map(([id, f]) => [id, f.width] as const),
    );
    expect(frames.length).toBeGreaterThanOrEqual(20);

    for (const [id, width] of frames) {
      await page.setViewportSize({ width, height: 720 });
      await page.evaluate(frame => {
        document.body.replaceChildren();
        const root = document.createElement('div');
        document.body.append(root);
        (
          window as unknown as {
            renderFrame: (root: HTMLElement, id: string) => void;
          }
        ).renderFrame(root, frame);
      }, id);
      await testInfo.attach(`frame-${id}.png`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
      // Frame O uses the host's default dark values (preview.ts), so its
      // contrast is checked too.
      const axe = new AxeBuilder({ page }).withTags([
        'wcag2a',
        'wcag2aa',
        'wcag21a',
        'wcag21aa',
      ]);
      const { violations } = await axe.analyze();
      expect(violations.map(v => `${id}: ${v.id} (${v.nodes.length})`)).toEqual(
        [],
      );
    }

    await context.close();
  });
});

/** `app/ui/preview.ts` bundled for the page, with esbuild from `browser/`. */
async function previewScript(): Promise<string> {
  const require = createRequire(
    new URL('../../../browser/package.json', import.meta.url),
  );
  // esbuild's types are not resolvable from here; only `build` is used.
  const esbuild = require('esbuild') as {
    build(options: object): Promise<{ outputFiles: { text: string }[] }>;
  };
  const preview = fileURLToPath(
    new URL('../app/ui/preview.ts', import.meta.url),
  );
  const result = await esbuild.build({
    stdin: {
      contents: `import { renderFrame, FRAMES } from ${JSON.stringify(preview)};\nObject.assign(window, { renderFrame, FRAMES });`,
      resolveDir: dirname(preview),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    alias: {
      '@tomic/lib': fileURLToPath(
        new URL('../app/tomic-lib-shim.ts', import.meta.url),
      ),
    },
    plugins: [cssRawPlugin(esbuild)],
    logLevel: 'silent',
  });

  return result.outputFiles[0].text;
}

/**
 * Installs the app the way a user does: Integrations page, experimental
 * plugins shown, Drive apps, Install. The host downloads the catalog's
 * `app-module` (the lane's dev-server serves the committed
 * `apps/timesheets/<version>/ui.js` in place of GitHub Pages) and refuses it
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
    .locator('[data-catalog-app="timesheets"]');
  await expect(entry).toContainText(`Version ${VERSION}`);
  await entry.getByRole('button', { name: 'Install Clockify' }).click();
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });

  return entry;
}
