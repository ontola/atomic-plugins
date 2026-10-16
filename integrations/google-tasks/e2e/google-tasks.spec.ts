// @wc-ignore-file
/**
 * The Google Tasks drive app (`../app/`, a read-only import of the task lists
 * a person ticks) end to end, against the mock integration proxy serving the
 * SYNTHETIC google-tasks fixture (`../fixtures/google-tasks/`, hand-written
 * from the Tasks API v1 reference, not a recording; the live run is Decision
 * Inbox Q-098).
 *
 * The app is installed from the catalog's Drive apps section, the way the
 * Todoist spec does it; the lane's dev-server serves the committed
 * `apps/google-tasks/<version>/ui.js` in place of GitHub Pages and the entry
 * enabled although the published catalog keeps it `enabled: false`.
 *
 * Journey:
 * 1. Install, connect through the host's consent bar and the mock proxy. The
 *    first sync reads the two task lists and imports nothing: no list is
 *    ticked yet, and the card says so.
 * 2. Tick "My Tasks": its five tasks (one completed and hidden in Google, one
 *    a subtask) become rows of the shared class `issue-v1` (the app made
 *    itself a view of it: its table's class, its App's `renders`).
 * 3. Reload: the refresh finds nothing changed and writes no row (every
 *    row's properties are byte-for-byte what they were), and the list stays
 *    ticked.
 * 4. Someone completes a task in Google (the fixture's `completeTask`
 *    driver): Google still lists it, so the row becomes task/v1 done with no
 *    by-id check.
 * 5. Someone deletes a task (`deleteTask`): it leaves the list, the app looks
 *    it up by id once, and the row is `deleted`, stays open, keeps its values
 *    and says when it was last seen. Nothing is removed and nothing is sent
 *    to Google.
 *
 * At each step the shared sync-status card (`integrations/sync-status/`,
 * Q-084; `../app/status.ts`) heads the view: the last sync and its counts,
 * that the app is read-only and overwrites local edits, and the results as
 * counted groups. The visually hidden `role="status"` line keeps the summary
 * sentence this spec waits on.
 *
 * The rows use the published GitHub Pages subject of `issue-v1`, which the
 * pinned server and the browser fetch themselves, so `beforeAll` first checks
 * Pages serves it with the committed bytes (ontology-kit/served.mjs); this
 * needs network access to https://ontola.github.io.
 *
 *   node integrations/tooling/run-lane.mjs google-tasks --tier e2e
 */
import { test, expect, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';
import { appVersion } from '../../tooling/apps.mjs';

const APP_FRAME = 'iframe[title="App"]';
/**
 * The catalog's version of this app (integrations/catalog.json), read at
 * load by `appVersion`, so a version bump needs no edit here.
 */
const VERSION = appVersion('google-tasks');
const CLASSTYPE = 'https://atomicdata.dev/properties/classtype';
const NAME = 'https://atomicdata.dev/properties/name';
const PARENT = 'https://atomicdata.dev/properties/parent';
const IS_A = 'https://atomicdata.dev/properties/isA';
const TASK = 'https://atomicdata.dev/task/v1';

test.describe('Google Tasks drive app', () => {
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

  test('connects, ticks a list, imports its tasks as issue-v1, refreshes without writing, and settles tasks that change or disappear', async ({
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
    const card = app.getByRole('region', { name: 'Sync status' });
    const rows = app.locator('tr[data-task]');
    const lists = app.getByRole('group', { name: 'Task lists to import' });
    // The mock proxy outlives an attempt: a retry finds the tasks an earlier
    // attempt completed and deleted, so bring both back first.
    for (const id of ['synthetic-task-1', 'synthetic-task-2'])
      await fixture('reopenTask', [id]);

    // 1. Install from the catalog and connect.
    await installFromCatalog(page);
    await expect(
      app.getByRole('heading', { name: 'Google Tasks' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(status).toContainText('Not connected');
    // The card, before anything was read: read-only all the same.
    await expect(card).toContainText('Not synced yet');
    await expect(card).toContainText('Not connected.');
    await expect(card).toContainText('Read-only: edits here stay in Atomic.');
    await expect(lists).toBeHidden();
    await app.getByRole('button', { name: 'Connect Google Tasks' }).click();

    const consent = page.getByRole('group', { name: 'Connect an account' });
    await expect(consent).toContainText('Google Tasks');
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Google Tasks with this destination',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    // The first sync reads the task lists only.
    await expect(synced).toContainText(
      'No task list chosen yet; 2 lists found. Tick the lists to import.',
      { timeout: 60_000 },
    );
    await expect(card).toContainText('No task list chosen.');
    await expect(card).toContainText('Last sync: nothing to read');
    await expect(rows).toHaveCount(0);
    const myTasks = lists.getByRole('checkbox', { name: 'My Tasks' });
    await expect(myTasks).toBeVisible();
    await expect(
      lists.getByRole('checkbox', { name: 'Synthetic groceries' }),
    ).not.toBeChecked();

    // 2. Tick a list: its tasks are imported.
    await myTasks.check();
    await expect(synced).toContainText(
      '5 tasks (5 added, 0 updated, 0 unchanged); 5 present.',
      { timeout: 60_000 },
    );
    await expect(rows).toHaveCount(5);
    // The card after the first import (Q-084): the sync, its counts, the
    // task count, and the exact write-back words.
    await expect(card).toContainText('Synced just now');
    await expect(card).toContainText(
      'Last sync: 5 added, 0 updated, 0 unchanged',
    );
    await expect(card).toContainText('5 tasks from Google Tasks');
    await expect(card).toContainText(
      'Read-only: edits here stay in Atomic. Nothing is sent to Google Tasks. An edit here to an imported column (Name, Status, Description, Due date) is overwritten at the next sync; a row added here is kept.',
    );
    await expect(card).not.toContainText('No task list chosen');
    await expect(card).not.toContainText('deleted in Google Tasks');
    const ferns = rows.filter({ hasText: 'Water the imaginary ferns' });
    await expect(ferns).toHaveAttribute('data-task', 'synthetic-task-1');
    await expect(ferns).toContainText('Todo');
    await expect(ferns).toContainText('present');
    await expect(ferns).toContainText('2026-03-02');
    await expect(ferns).toContainText('My Tasks');
    // Completed (and hidden) in Google before the import: done here.
    const books = rows.filter({ hasText: 'Return the made-up library books' });
    await expect(books).toContainText('Done');
    // A subtask, flat, with its parent's id.
    const food = rows.filter({ hasText: 'Buy invented fern food' });
    await expect(food.locator('td').nth(5)).toHaveText('synthetic-task-1');

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
    const fernsSubject = (await ferns.getAttribute('data-subject'))!;
    expect(first[fernsSubject][`${TASK}/status`]).toEqual([`${TASK}/todo`]);
    expect(first[fernsSubject][`${TASK}/due-date`]).toBe('2026-03-02');

    // 3. Reload: nothing changed in Google, so no row is written.
    await page.reload();
    await expect(synced).toContainText(
      '5 tasks (0 added, 0 updated, 5 unchanged); 5 present.',
      { timeout: 60_000 },
    );
    expect(await propsOf(page, subjects)).toEqual(first);
    await expect(myTasks).toBeChecked();

    // 4. A task completed in Google: still listed, so done here with no
    // by-id check.
    await fixture('completeTask', ['synthetic-task-1']);
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(synced).toContainText(
      '5 tasks (0 added, 1 updated, 4 unchanged); 5 present.',
      { timeout: 60_000 },
    );
    await expect(ferns).toContainText('Done');
    await expect(ferns).toHaveAttribute('data-presence', 'present');
    await expect(card).toContainText(
      'Last sync: 0 added, 1 updated, 4 unchanged',
    );
    const done = await propsOf(page, [fernsSubject]);
    expect(done[fernsSubject][`${TASK}/status`]).toEqual([`${TASK}/done`]);

    // 5. A task deleted in Google: gone from the list, confirmed by id,
    // marked deleted here, not closed, last values kept, with when it was
    // last seen.
    await fixture('deleteTask', ['synthetic-task-2']);
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(synced).toContainText('4 present, 1 deleted.', {
      timeout: 60_000,
    });
    const dentist = rows.filter({ hasText: 'Call the fictional dentist' });
    await expect(dentist).toHaveAttribute('data-presence', 'deleted');
    await expect(dentist).toContainText('Todo');
    await expect(dentist).toContainText('2026-03-03');
    // Last seen (the seventh column; the eighth is Open row): an ISO date
    // and time, from the last complete read.
    await expect(dentist.locator('td').nth(6)).toHaveText(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
    );
    await expect(card).toContainText(
      '1 task was deleted in Google Tasks: kept here as last read; not closed.',
    );
    await card.getByText('Which').first().click();
    await expect(card).toContainText('Call the fictional dentist');
    const dentistSubject = (await dentist.getAttribute('data-subject'))!;
    const gone = await propsOf(page, [dentistSubject]);
    expect(gone[dentistSubject][`${TASK}/status`]).toEqual([`${TASK}/todo`]);
    expect(Object.values(gone[dentistSubject])).toContain('deleted');
    await expect(rows).toHaveCount(5);

    // Nothing reached Google: the fixture's tasks changed only through its
    // own drivers (completed and deleted are what the drivers set).
    const snapshot = (await fixture('snapshot', [])) as {
      tasks: { id: string; status: string; deleted?: boolean }[];
      unreachable: string[];
    };
    expect(
      snapshot.tasks.filter(t => t.status === 'completed').map(t => t.id),
    ).toEqual(['synthetic-task-1', 'synthetic-task-4']);
    expect(snapshot.tasks.filter(t => t.deleted).map(t => t.id)).toEqual([
      'synthetic-task-2',
    ]);
    expect(snapshot.unreachable).toEqual([]);

    // 6. A row made in the table with an empty Name, the class's required
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
    await expect(card).toContainText(
      '1 task is incomplete (missing Name): listed, not counted above.',
    );
    await expect(card).toContainText('5 tasks from Google Tasks');
    await expect(card.getByRole('button', { name: 'Open row' })).toBeVisible();
    await expect(rows).toHaveCount(5);
    expect((await propsOf(page, [nameless]))[nameless][NAME]).toBe('');

    // The typed table outside the app shows the tasks.
    await page.goto(
      `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(shared.table)}`,
    );
    for (const title of [
      'Water the imaginary ferns',
      'Call the fictional dentist',
      'Sort the pretend attic',
    ])
      await expect(main.getByText(title, { exact: true }).first()).toBeVisible({
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

/** One google-tasks fixture driver on the mock proxy: someone working in Google Tasks. */
async function fixture(name: string, args: unknown[]): Promise<unknown> {
  const response = await fetch(
    `${process.env.INTEGRATION_PROXY_URL}/fixture/google-tasks/${name}`,
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
    .locator('[data-catalog-app="google-tasks"]');
  await expect(entry).toContainText(`Version ${VERSION}`);
  await entry.getByRole('button', { name: 'Install Google Tasks' }).click();
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });
}
