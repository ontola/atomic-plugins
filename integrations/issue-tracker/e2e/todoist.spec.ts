// @wc-ignore-file
/**
 * The Todoist drive app (`../todoist-app/`, read-only active tasks) end to
 * end: #99's host journey, against the mock integration proxy serving the
 * SYNTHETIC todoist fixture (`../fixtures/todoist/`, hand-written from
 * Todoist's API documentation, not a recording; #46 owns the recording).
 *
 * The app is installed from the catalog's Drive apps section, the way the
 * GitHub issues spec does it; the lane's dev-server serves the committed
 * `apps/todoist/<version>/ui.js` in place of GitHub Pages and the entry
 * enabled although the published catalog keeps it `enabled: false`.
 *
 * Journey:
 * 1. Install, connect through the host's consent bar and the mock proxy,
 *    import the five active tasks as rows of the shared class `issue-v1`
 *    (the app made itself a view of it: its table's class, its App's
 *    `renders`).
 * 2. Reload: the refresh finds nothing changed and writes no row (every
 *    row's properties are byte-for-byte what they were).
 * 3. Someone completes a task in Todoist (the fixture's `completeTask`
 *    driver): it leaves the active list, the app looks it up by id once, and
 *    the row becomes task/v1 done with presence `completed`.
 * 4. Someone else makes a task unreachable (`removeTask`, 404 by id): its
 *    row is `unavailable`, stays open, keeps its values and says when it was
 *    last seen. Nothing is removed and nothing is sent to Todoist.
 *
 * The rows use the published GitHub Pages subject of `issue-v1`, which the
 * pinned server and the browser fetch themselves, so `beforeAll` first checks
 * Pages serves it with the committed bytes (ontology-kit/served.mjs); this
 * needs network access to https://ontola.github.io.
 *
 *   node integrations/tooling/run-lane.mjs issue-tracker --tier e2e
 */
import { test, expect, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';

const APP_FRAME = 'iframe[title="App"]';
/** The catalog's version of this app (integrations/catalog.json). */
const VERSION = '0.1.1';
const CLASSTYPE = 'https://atomicdata.dev/properties/classtype';
const NAME = 'https://atomicdata.dev/properties/name';
const PARENT = 'https://atomicdata.dev/properties/parent';
const IS_A = 'https://atomicdata.dev/properties/isA';
const TASK = 'https://atomicdata.dev/task/v1';

test.describe('Todoist drive app', () => {
  test.beforeAll(async () => {
    const served = (await import(
      '../../../ontology-kit/served.mjs' as string
    )) as {
      classTermPaths(name: string): string[];
      servedProblems(paths: string[]): Promise<string[]>;
      notServedMessage(problems: string[]): string;
    };
    const problems = await served.servedProblems(
      served.classTermPaths('issue-v1'),
    );
    if (problems.length) throw new Error(served.notServedMessage(problems));
  });
  test.beforeEach(before);

  test('connects, imports active tasks as issue-v1, refreshes without writing, and settles tasks that disappear', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(180_000);
    const main = page.getByRole('main');
    const app = page.frameLocator(APP_FRAME);
    const status = app.getByRole('status');
    const synced = status.filter({ hasText: 'Last synced' });
    const rows = app.locator('tr[data-task]');

    // 1. Install from the catalog and connect.
    await installFromCatalog(page);
    await expect(app.getByRole('heading', { name: 'Todoist' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(status).toContainText('Not connected');
    await app.getByRole('button', { name: 'Connect Todoist' }).click();

    const consent = page.getByRole('group', { name: 'Connect an account' });
    await expect(consent).toContainText('Todoist');
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Todoist with this destination',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    await expect(synced).toContainText(
      '5 tasks (5 added, 0 updated, 0 unchanged); 5 active.',
      { timeout: 60_000 },
    );
    await expect(rows).toHaveCount(5);
    const plants = rows.filter({ hasText: 'Water the synthetic plants' });
    await expect(plants).toHaveAttribute('data-task', 'synthetic-task-1');
    await expect(plants).toContainText('Todo');
    await expect(plants).toContainText('active');
    await expect(plants).toContainText('2026-03-02');
    await expect(plants).toContainText('Urgent');
    await expect(plants).toContainText('Inbox');

    // The shared class (#177): the rows, the table and the App.
    const subjects = await rows.evaluateAll(trs =>
      trs.map(tr => (tr as HTMLElement).dataset.subject!),
    );
    expect(subjects).toHaveLength(5);
    const issueV1 = (
      (await import('../../../ontology-kit/terms.mjs' as string)) as {
        classes: Record<string, { subject: string }>;
      }
    ).classes['issue-v1'].subject;
    const appSubject = new URL(page.url()).searchParams.get('subject')!;
    const shared = await page.evaluate(
      async args => {
        const store = window.store!;
        await store.reloadResource(args.row);
        const row = await store.getResource(args.row);
        const table = await store.getResource(row.get(args.parent) as string);
        await store.reloadResource(args.app);
        const appResource = await store.getResource(args.app);

        return {
          rowIsA: row.get(args.isA),
          classtype: table.get(args.classtype),
          table: table.subject,
          renders: Object.values(appResource.getPropVals()).some(
            v => Array.isArray(v) && v.includes(args.issueV1),
          ),
        };
      },
      {
        row: subjects[0],
        app: appSubject,
        parent: PARENT,
        isA: IS_A,
        classtype: CLASSTYPE,
        issueV1,
      },
    );
    expect(shared).toMatchObject({
      rowIsA: [issueV1],
      classtype: issueV1,
      renders: true,
    });
    const first = await propsOf(page, subjects);
    for (const props of Object.values(first))
      expect(props[`${TASK}/status`]).toEqual([`${TASK}/todo`]);

    // 2. Reload: nothing changed in Todoist, so no row is written.
    await page.reload();
    await expect(synced).toContainText(
      '5 tasks (0 added, 0 updated, 5 unchanged); 5 active.',
      { timeout: 60_000 },
    );
    expect(await propsOf(page, subjects)).toEqual(first);

    // 3. A task completed in Todoist: gone from the active list, confirmed
    // by id, closed here.
    await fixture('completeTask', ['synthetic-task-1']);
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(synced).toContainText(
      '5 tasks (0 added, 1 updated, 4 unchanged); 4 active, 1 completed.',
      { timeout: 60_000 },
    );
    await expect(rows).toHaveCount(5);
    await expect(plants).toHaveAttribute('data-presence', 'completed');
    await expect(plants).toContainText('Done');
    const plantsSubject = (await plants.getAttribute('data-subject'))!;
    const after = await propsOf(page, [plantsSubject]);
    expect(after[plantsSubject][`${TASK}/status`]).toEqual([`${TASK}/done`]);
    expect(Object.values(after[plantsSubject])).toContain('completed');

    // 4. A task that can no longer be reached: unavailable, not closed,
    // last values kept, with when it was last seen.
    await fixture('removeTask', ['synthetic-task-3']);
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(synced).toContainText(
      '3 active, 1 completed, 1 unavailable.',
      { timeout: 60_000 },
    );
    const fence = rows.filter({ hasText: 'Paint the fictional fence' });
    await expect(fence).toHaveAttribute('data-presence', 'unavailable');
    await expect(fence).toContainText('Todo');
    await expect(fence).toContainText('Synthetic house');
    // Last seen: an ISO date and time, from the last complete read.
    await expect(fence.locator('td').last()).toHaveText(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    );
    const fenceSubject = (await fence.getAttribute('data-subject'))!;
    const gone = await propsOf(page, [fenceSubject]);
    expect(gone[fenceSubject][`${TASK}/status`]).toEqual([`${TASK}/todo`]);
    expect(Object.values(gone[fenceSubject])).toContain('unavailable');
    await expect(rows).toHaveCount(5);

    // Nothing reached Todoist: the fixture's tasks changed only through its
    // own drivers (checked and unreachable are what the drivers set).
    const snapshot = (await fixture('snapshot', [])) as {
      tasks: { id: string; checked: boolean }[];
      unreachable: string[];
    };
    expect(snapshot.tasks.filter(t => t.checked).map(t => t.id)).toEqual([
      'synthetic-task-1',
    ]);
    expect(snapshot.unreachable).toEqual(['synthetic-task-3']);

    // 5. A row made in the table with an empty Name, the class's required
    // field (#177; ontology-kit's rule; the server refuses a commit without
    // the property, lib/src/resources.rs check_required_props): listed as
    // incomplete, with a way to the row, never written by a pass; the task
    // rows are unaffected.
    const nameless = await page.evaluate(
      async ({ table, klass, task, name }) => {
        const store = window.store!;
        const row = await store.newResource({
          parent: table,
          isA: [klass],
          propVals: { [name]: '', [`${task}/status`]: [`${task}/todo`] },
        });
        await row.save();

        return row.subject;
      },
      { table: shared.table, klass: issueV1, task: TASK, name: NAME },
    );
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(synced).toContainText('5 tasks (0 added, 0 updated', {
      timeout: 60_000,
    });
    const local = app.locator('tr[data-local]');
    await expect(local).toHaveCount(1);
    await expect(local).toHaveAttribute('data-subject', nameless);
    await expect(local).toHaveAttribute('data-presence', 'local');
    await expect(local).toContainText('Incomplete: missing Name');
    await expect(
      local.getByRole('button', { name: 'Open row (no name)' }),
    ).toBeVisible();
    await expect(rows).toHaveCount(5);
    expect((await propsOf(page, [nameless]))[nameless][NAME]).toBe('');

    // The typed table outside the app shows the tasks.
    await page.goto(
      `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(shared.table)}`,
    );
    for (const name of [
      'Water the synthetic plants',
      'Call the invented plumber',
      'Return the made-up library books',
    ])
      await expect(main.getByText(name, { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
  });
});

/** Every property of each row, read fresh from the server. */
async function propsOf(
  page: Page,
  subjects: string[],
): Promise<Record<string, Record<string, unknown>>> {
  return page.evaluate(async list => {
    const store = window.store!;
    const out: Record<string, Record<string, unknown>> = {};

    for (const subject of list) {
      await store.reloadResource(subject);
      const resource = await store.getResource(subject);
      out[subject] = { ...resource.getPropVals() };
    }

    return out;
  }, subjects);
}

/** One todoist fixture driver on the mock proxy: someone working in Todoist. */
async function fixture(name: string, args: unknown[]): Promise<unknown> {
  const response = await fetch(
    `${process.env.INTEGRATION_PROXY_URL}/fixture/todoist/${name}`,
    { method: 'POST', body: JSON.stringify(args) },
  );
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);

  return response.json();
}

/**
 * Installs the app the way a user does: Integrations page, experimental
 * plugins shown, Drive apps, Install. The host downloads the catalog's
 * `app-module` and refuses it unless its bytes match
 * `app-module-integrity`, then opens the new app.
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
    .locator('[data-catalog-app="todoist"]');
  await expect(entry).toContainText(`Version ${VERSION}`);
  await entry.getByRole('button', { name: 'Install Todoist' }).click();
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });
}
