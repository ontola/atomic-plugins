// @wc-ignore-file
/**
 * The GitHub issues drive app (`../app/`) end to end, against the mock
 * integration proxy's github-issues fixture and its seeded repository
 * (`../fixtures/github-issues/scenario.mjs`, `atomic-fixture/tracker`: two
 * issues, one comment):
 *
 * 1. Install from the catalog's Drive apps section (as the pets spec does;
 *    the lane's dev-server serves the committed
 *    `apps/issue-tracker/<version>/ui.js` in place of GitHub Pages), connect
 *    through the host's consent bar, choose the repository, import.
 * 2. Reload: the app resumes from the state it saved in the drive, and an
 *    unchanged refresh writes nothing on either side.
 * 3. A reviewed update: a status change made in the table outside the app
 *    waits for review, and only "Send" closes the issue on GitHub.
 * 4. Conflict recovery: the same title edited in the table and on GitHub
 *    pauses sync; the conflict review keeps GitHub's title.
 * 5. Moving a card on the board with the keyboard, reviewed and sent.
 * 6. A comment added in the issue panel, reviewed and sent.
 * 7. Since 0.2.0 (#177 item 6): the app made itself a view of the shared
 *    class `issue-v1` (its table's class, its App's `renders`). A row added
 *    to the table outside the app stays local until "Publish to GitHub",
 *    whose create is reviewed and sent; moving it to Blocked adds the
 *    `atomic:blocked` label (#177 Q8).
 * 8. Disconnect in the app, then connect again through the host's "Use
 *    existing connection", with no reload: the app syncs again by itself
 *    (#196 user test; it used to stop at an unsynced board).
 *
 * A second test (#177 item 14, since 0.3.0): an `issue-v1` table the person
 * made by hand, "+ Add view" → GitHub issues (Read-only), "Sync this table
 * to GitHub", the host's "Allow editing" bar, connect, choose a repository
 * of its own (seeded with the fixture's `createIssue` driver), import into
 * that table, and a status edit made in the table sent after review.
 *
 * The rows are of the shared class at its published GitHub Pages subject,
 * which the pinned server and the browser fetch from Pages themselves, as
 * in production (ontology-kit/README.md, "Plugin e2e tests and the
 * published subjects"). `beforeAll` first checks Pages serves `issue-v1`
 * with the committed bytes (`ontology-kit/served.mjs`), so this needs
 * network access to https://ontola.github.io.
 *
 * GitHub-side reads and edits go through the mock's test drivers for the
 * github-issues fixture (`POST /fixture/github-issues/<driver>`), standing
 * in for someone working on GitHub. The connection itself lives at the
 * proxy (#54 phase 2): the page redeems and delegates it, and the frame
 * calls the proxy with a capability and its own key.
 *
 * Needs an atomic-server with the host relay (atomic-server#1657, in the
 * pin). Run it the way CI does:
 *   node integrations/tooling/run-lane.mjs issue-tracker --tier e2e
 */
import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';

const APP_FRAME = 'iframe[title="App"]';
/** The catalog's version of this app (integrations/catalog.json). */
const VERSION = '0.3.1';
const REPOSITORY = 'atomic-fixture/tracker';
/** Seeded by the item 14 test itself, through the fixture's createIssue driver. */
const TEAM_REPOSITORY = 'atomic-fixture/team-board';
const NAME = 'https://atomicdata.dev/properties/name';
const CLASSTYPE = 'https://atomicdata.dev/properties/classtype';
const PARENT = 'https://atomicdata.dev/properties/parent';
const IS_A = 'https://atomicdata.dev/properties/isA';
const TASK = 'https://atomicdata.dev/task/v1';

test.describe('GitHub issues drive app', () => {
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

  test('imports, refreshes, sends reviewed updates, moves a card, comments and recovers from a conflict', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    const writes = appWrites(page);
    await installFromCatalog(page);

    const app = page.frameLocator(APP_FRAME);
    const status = app.getByRole('status');
    await expect(
      app.getByRole('heading', { name: 'GitHub issues' }),
    ).toBeVisible();
    await expect(status).toContainText('Not connected');
    await app.getByRole('button', { name: 'Connect GitHub' }).click();

    // Drawn by the host page, outside the frame: only a click here navigates.
    const consent = page.getByRole('group', { name: 'Connect an account' });
    // The host names the platform from its id: "Github Issues".
    await expect(consent).toContainText(/github issues/i);
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync GitHub Issues with this destination',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    // 1. Choose the repository from the picker (the mock answers
    // GET /user/repos) and import.
    await expect(
      app.getByRole('heading', { name: 'Which repository?' }),
    ).toBeVisible({ timeout: 30_000 });
    await app.getByRole('radio', { name: new RegExp(REPOSITORY) }).check();
    await app.getByRole('button', { name: `Import ${REPOSITORY}` }).click();
    const bar = app.locator('.pl-conn');
    await expect(bar).toHaveAttribute(
      'title',
      /2 issues and 1 comment in sync with atomic-fixture\/tracker/,
      { timeout: 60_000 },
    );
    await expect(status).toContainText('Synced');
    // The frame's width decides board or list; this spec uses the board.
    await app.getByRole('button', { name: 'Board', exact: true }).click();
    await expect(card(app, '#1')).toContainText(
      'Keep the selected calendar after refresh',
    );
    await expect(column(app, 'Todo').locator('[data-subject]')).toHaveCount(1);
    await expect(card(app, '#2')).toContainText('Export the board as CSV');
    await expect(column(app, 'Doing').locator('[data-subject]')).toHaveCount(1);

    // 2. Reload: resumes from the saved state; an unchanged refresh writes nothing.
    await page.reload();
    await expect(bar).toHaveAttribute(
      'title',
      /0 added and 0 updated here, 0 sent to GitHub/,
      { timeout: 60_000 },
    );
    await expect(bar).toHaveAttribute('title', /2 issues and 1 comment/);
    // How long the host takes per app write (#206); for the report only.
    console.info(
      `/app-write through the import and reload: ${writes.summary()}`,
    );

    // 3. A reviewed update: close #1 from the table, outside the app.
    const first = await subjectOf(app, '#1');
    await setStatus(page, first, 'done');
    await app.getByRole('button', { name: 'Sync now' }).click();
    await app
      .getByRole('button', { name: 'Review and send' })
      .click({ timeout: 30_000 });
    const review = app.getByRole('region', {
      name: 'Changes to send to GitHub',
    });
    await expect(review).toContainText(
      'Update #1: status Todo → Done (close it)',
    );
    expect((await github('GET', '/issues/1')).state).toBe('open');
    await app.getByRole('button', { name: 'Send 1 change to GitHub' }).click();
    await expect(bar).toHaveAttribute('title', /1 sent to GitHub/, {
      timeout: 30_000,
    });
    expect((await github('GET', '/issues/1')).state).toBe('closed');
    await expect(review).toBeHidden();

    // 4. Conflict: #2's title edited on both sides since the last sync.
    const second = await subjectOf(app, '#2');
    await setName(page, second, 'Export as CSV (edited here)');
    await github('PATCH', '/issues/2', {
      title: 'Export as CSV (edited on GitHub)',
    });
    await app.getByRole('button', { name: 'Sync now' }).click();
    const banner = app.locator('.pl-banner');
    await expect(banner).toContainText(
      '#2 was changed both here and on GitHub',
      { timeout: 30_000 },
    );
    await expect(status).toContainText('Sync paused');
    await banner.getByRole('button', { name: 'Review conflict' }).click();
    const apply = app.getByRole('button', { name: 'Apply and resume sync' });
    await expect(apply).toBeDisabled();
    await app
      .getByRole('group', { name: 'Title' })
      .getByRole('radio', { name: /On GitHub/ })
      .check();
    await apply.click();
    await expect(banner).toBeHidden({ timeout: 30_000 });
    await expect(bar).toHaveAttribute('title', /0 sent to GitHub/);
    await expect(card(app, '#2')).toContainText(
      'Export as CSV (edited on GitHub)',
    );
    expect((await github('GET', '/issues/2')).title).toBe(
      'Export as CSV (edited on GitHub)',
    );

    // 5. Move a card in the app: #2 to Done with the keyboard, then send.
    await card(app, '#2').focus();
    await page.keyboard.press('4');
    await expect(column(app, 'Done')).toContainText('Export as CSV');
    await app
      .getByRole('button', { name: 'Review and send' })
      .click({ timeout: 30_000 });
    await expect(review).toContainText(
      'Update #2: status Doing → Done (close it)',
    );
    await app.getByRole('button', { name: 'Send 1 change to GitHub' }).click();
    await expect(bar).toHaveAttribute('title', /1 sent to GitHub/, {
      timeout: 30_000,
    });
    expect((await github('GET', '/issues/2')).state).toBe('closed');

    // 6. Comment on #1 from its detail panel, then send.
    await card(app, '#1').click();
    const detail = app.locator('aside.detail');
    await detail
      .getByRole('textbox', { name: 'Add a comment' })
      .fill('Fixed in the app.');
    await detail.getByRole('button', { name: 'Comment' }).click();
    await expect(detail).toContainText('Waiting to send');
    // Below 1000 px the panel is a modal drawer; close it first.
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
    await app
      .getByRole('button', { name: 'Review and send' })
      .click({ timeout: 30_000 });
    await expect(review).toContainText(
      'Add a comment on #1: “Fixed in the app.”',
    );
    await app.getByRole('button', { name: 'Send 1 change to GitHub' }).click();
    await expect(bar).toHaveAttribute('title', /1 sent to GitHub/, {
      timeout: 30_000,
    });
    const { comments } = (await fixture('snapshot', [REPOSITORY])) as {
      comments: { body: string; issue_url: string }[];
    };
    expect(
      comments.filter(c => c.issue_url.endsWith('/issues/1')).map(c => c.body),
    ).toEqual(['I can reproduce this in Firefox.', 'Fixed in the app.']);

    // 7. The shared class (#177 item 6). The app's own table is an issue-v1
    // table, and the App renders issue-v1, so Add view offers it on others.
    const issueV1 = (
      (await import('../../../ontology-kit/terms.mjs' as string)) as {
        classes: Record<string, { subject: string }>;
      }
    ).classes['issue-v1'].subject;
    const appSubject = new URL(page.url()).searchParams.get('subject')!;
    const shared = await page.evaluate(
      async args => {
        const store = window.store!;
        const row = await store.getResource(args.row);
        const table = await store.getResource(row.get(args.parent) as string);
        await store.reloadResource?.(args.app);
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
        row: first,
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

    // A row added in the table, outside the app: local only, nothing held.
    await page.evaluate(
      async args => {
        const store = window.store!;
        const row = await store.newResource({
          parent: args.table,
          isA: [args.issueV1],
          propVals: {
            [args.name]: 'Written in the table',
            [`${args.task}/status`]: [`${args.task}/todo`],
          },
        });
        await row.save();
      },
      { table: shared.table, issueV1, name: NAME, task: TASK },
    );
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(card(app, 'Local')).toContainText('Written in the table', {
      timeout: 30_000,
    });
    await expect(bar).toHaveAttribute('title', /0 sent to GitHub/);
    expect(
      (await fixture('snapshot', [REPOSITORY])) as { issues: unknown[] },
    ).toMatchObject({ issues: { length: 2 } });

    // Publish to GitHub: the create is held for review, then sent.
    await card(app, 'Local').click();
    await detail.getByRole('button', { name: 'Publish to GitHub' }).click();
    await page.keyboard.press('Escape');
    await app
      .getByRole('button', { name: 'Review and send' })
      .click({ timeout: 30_000 });
    await expect(review).toContainText(
      'Create issue “Written in the table” (Todo)',
    );
    await app.getByRole('button', { name: 'Send 1 change to GitHub' }).click();
    await expect(bar).toHaveAttribute('title', /1 sent to GitHub/, {
      timeout: 30_000,
    });
    expect((await github('GET', '/issues/3')).title).toBe(
      'Written in the table',
    );
    // The row gets its number from GitHub's answer on the next pass.
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(card(app, '#3')).toContainText('Written in the table', {
      timeout: 30_000,
    });

    // Blocked is the atomic:blocked label (#177 Q8).
    await card(app, '#3').focus();
    await page.keyboard.press('3');
    await expect(column(app, 'Blocked')).toContainText('Written in the table');
    await app
      .getByRole('button', { name: 'Review and send' })
      .click({ timeout: 30_000 });
    await expect(review).toContainText(
      'Update #3: status Todo → Blocked (add the atomic:blocked label)',
    );
    await app.getByRole('button', { name: 'Send 1 change to GitHub' }).click();
    await expect(bar).toHaveAttribute('title', /1 sent to GitHub/, {
      timeout: 30_000,
    });
    const third = (await github('GET', '/issues/3')) as {
      state: string;
      labels: (string | { name: string })[];
    };
    expect(third.state).toBe('open');
    expect(
      third.labels.map(l => (typeof l === 'string' ? l : l.name)),
    ).toContain('atomic:blocked');

    // The connection lives at the proxy, owned by the signed-in user and
    // delegated to this app; the page keeps nothing credential-like.
    // Only this test's agent's: the other test connects its own, in parallel.
    const me = await signedInAgent(page);
    const mine = async () =>
      (await proxyConnections('github-issues')).filter(c => c.owner === me);
    const connections = await mine();
    expect(connections).toHaveLength(1);
    expect(connections[0].owner).toBe(me);
    expect(connections[0].delegations).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage))).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^atomic-proxy-connect|connection-v1/),
      ]),
    );

    // 8. Disconnect this app, then connect again through the existing
    // connection. The consent bar resolves with no reload, so the app must
    // start its sync itself, as it does when the view opens.
    const appUrl = page.url();
    await app.getByRole('button', { name: 'Connection menu' }).click();
    await app.getByRole('menuitem', { name: 'Disconnect GitHub' }).click();
    await expect(status).toContainText('Not connected', { timeout: 30_000 });
    expect((await mine())[0].delegations).toEqual([]);
    await app.getByRole('button', { name: 'Connect GitHub' }).click();
    await consent
      .getByRole('button', { name: 'Use existing connection' })
      .click();
    await expect(consent).toBeHidden();
    await expect(bar).toHaveAttribute(
      'title',
      /3 issues and 2 comments in sync with atomic-fixture\/tracker/,
      { timeout: 60_000 },
    );
    // Nothing new to send. "Updated here" is left open: the comment sent
    // in step 6 changed #1's updated_at on GitHub after the last pass.
    await expect(bar).toHaveAttribute(
      'title',
      /0 added and \d+ updated here, 0 sent to GitHub/,
    );
    await expect(status).toContainText('Synced');
    expect(page.url()).toBe(appUrl);
    const again = await mine();
    expect(again).toHaveLength(1);
    expect(again[0].delegations).toHaveLength(1);
  });

  test('syncs a hand-made issue-v1 table with GitHub after Allow editing, and sends a reviewed status edit (#177 item 14)', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY ||
        !process.env.INTEGRATION_PROXY_URL,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(300_000);
    const issueV1 = (
      (await import('../../../ontology-kit/terms.mjs' as string)) as {
        classes: Record<string, { subject: string }>;
      }
    ).classes['issue-v1'].subject;
    // A repository of its own, so the other test's edits can't race this one.
    for (const title of ['Book the venue', 'Write the agenda'])
      await fixture('createIssue', [TEAM_REPOSITORY, { title, body: '' }]);

    await installFromCatalog(page);
    const app = page.frameLocator(APP_FRAME);
    await expect(app.getByRole('status')).toContainText('Not connected', {
      timeout: 45_000,
    });
    const appSubject = new URL(page.url()).searchParams.get('subject')!;
    // The first open makes the App a view of issue-v1, before connecting.
    await expect
      .poll(
        async () =>
          page.evaluate(
            async ({ subject, wanted }) => {
              const store = window.store!;
              const resource = await store.fetchResourceFromServer(subject, {
                noWebSocket: true,
              });

              return Object.values(resource.getPropVals()).some(
                v => Array.isArray(v) && v.includes(wanted),
              );
            },
            { subject: appSubject, wanted: issueV1 },
          ),
        { timeout: 30_000 },
      )
      .toBe(true);

    // A table the person made, of the shared class, with one row of theirs.
    const table = await page.evaluate(
      async ({ klass, name, classtype, task }) => {
        const store = window.store!;
        const made = await store.newResource({
          parent: store.getDrive(),
          isA: ['https://atomicdata.dev/classes/Table'],
          propVals: { [name]: 'Team issues', [classtype]: klass },
        });
        await made.save();
        const row = await store.newResource({
          parent: made.subject,
          isA: [klass],
          propVals: {
            [name]: 'Plan the offsite',
            [`${task}/status`]: [`${task}/todo`],
          },
        });
        await row.save();
        // A row missing the class's required Name (#177; ontology-kit's
        // rule: shown as incomplete, never skipped, never synced). The
        // server refuses a commit without the property (lib/src/resources.rs
        // check_required_props), so the incomplete row this host can hold
        // has an empty Name.
        const nameless = await store.newResource({
          parent: made.subject,
          isA: [klass],
          propVals: { [name]: '', [`${task}/status`]: [`${task}/doing`] },
        });
        await nameless.save();

        return made.subject;
      },
      { klass: issueV1, name: NAME, classtype: CLASSTYPE, task: TASK },
    );
    await page.goto(
      `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(table)}`,
    );
    await page
      .getByRole('main')
      .getByRole('button', { name: 'Add view' })
      .click();
    await page
      .getByRole('menuitem', { name: 'GitHub issues' })
      .click({ timeout: 60_000 });
    // Read-only first: the sync asks for itself.
    await page
      .locator('dialog[open]')
      .getByRole('button', { name: 'Read-only' })
      .click();
    await expect(
      app.getByText('Team issues isn’t synced with GitHub.'),
    ).toBeVisible({ timeout: 45_000 });
    await app
      .getByRole('button', { name: 'Sync this table to GitHub' })
      .click();
    // The host's own bar asks, outside the frame.
    const ask = page.getByRole('group', { name: 'Let this app edit rows' });
    await expect(ask).toBeVisible({ timeout: 30_000 });
    await ask.getByRole('button', { name: 'Allow editing' }).click();

    // No connection yet: connect as on the app's own page. Coming back from
    // the proxy reloads the page, and the app goes on.
    await expect(
      app.getByRole('heading', { name: 'Sync Team issues with GitHub' }),
    ).toBeVisible({ timeout: 45_000 });
    await app.getByRole('button', { name: 'Connect GitHub' }).click();
    const consent = page.getByRole('group', { name: 'Connect an account' });
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync GitHub Issues with this destination',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);
    await expect(
      app.getByRole('heading', {
        name: 'Which repository should Team issues sync with?',
      }),
    ).toBeVisible({ timeout: 45_000 });
    await app.getByRole('radio', { name: new RegExp(TEAM_REPOSITORY) }).check();
    await app
      .getByRole('button', { name: `Import ${TEAM_REPOSITORY}` })
      .click();
    const bar = app.locator('.pl-conn');
    await expect(bar).toHaveAttribute(
      'title',
      /2 issues and 0 comments in sync with atomic-fixture\/team-board/,
      { timeout: 60_000 },
    );

    // GitHub's issues are rows of that table now, with the app's extras; the
    // person's own row is as it was; the table kept its name and class.
    const issueRows = async () =>
      (await rowsUnder(page, table)).filter(r =>
        (r[IS_A] as unknown[] | undefined)?.includes(issueV1),
      );
    const rows = await issueRows();
    expect(rows).toHaveLength(4);
    expect(rows.map(r => r['github-issue-number']).sort()).toEqual([
      1,
      2,
      undefined,
      undefined,
    ]);

    for (const row of rows.filter(
      r => r['github-issue-number'] !== undefined,
    )) {
      expect(row[IS_A]).toEqual([issueV1]);
      expect(row['github-sync-baseline']).toEqual(expect.any(String));
    }

    // The incomplete row stayed as it was: not sent, and on the board as
    // "(no title)" with its tag (the board shows only once the table is
    // synced; before that the app shows the "isn't synced" offer alone).
    const nameless = rows.find(
      r => r[NAME] === '' && r['github-issue-number'] === undefined,
    )!;
    expect(nameless).not.toHaveProperty('github-sync-baseline');
    await expect(app.getByText('Incomplete: missing Name')).toBeVisible();
    await expect(app.getByText('(no title)')).toBeVisible();

    expect(rows.find(r => r[NAME] === 'Plan the offsite')).not.toHaveProperty(
      'github-issue-number',
    );
    const after = await page.evaluate(
      async ({ subject, name, classtype }) => {
        const t = await window.store!.fetchResourceFromServer(subject, {
          noWebSocket: true,
        });

        return { name: t.get(name), classtype: t.get(classtype) };
      },
      { subject: table, name: NAME, classtype: CLASSTYPE },
    );
    expect(after).toEqual({ name: 'Team issues', classtype: issueV1 });
    // The repository choice is kept under the App, naming the table.
    expect(await bindingFor(page, appSubject, table)).toBe(TEAM_REPOSITORY);

    // A status edit made in the table, as the signed-in person, is reviewed
    // and then sent.
    const first = rows.find(r => r['github-issue-number'] === 1)!
      .subject as string;
    await setStatus(page, first, 'done');
    await app.getByRole('button', { name: 'Sync now' }).click();
    await app
      .getByRole('button', { name: 'Review and send' })
      .click({ timeout: 30_000 });
    const review = app.getByRole('region', {
      name: 'Changes to send to GitHub',
    });
    await expect(review).toContainText(
      'Update #1: status Todo → Done (close it)',
    );
    expect((await teamIssue(1)).state).toBe('open');
    await app.getByRole('button', { name: 'Send 1 change to GitHub' }).click();
    await expect(bar).toHaveAttribute('title', /1 sent to GitHub/, {
      timeout: 30_000,
    });
    expect((await teamIssue(1)).state).toBe('closed');
    await expect
      .poll(async () => {
        const row = (await issueRows()).find(r => r.subject === first);

        return JSON.parse(String(row?.['github-sync-baseline'] ?? '{}')).status;
      })
      .toBe('Done');
  });
});

/** A card (board) or row (list) by its "#n" reference. */
function card(app: FrameLocator, ref: string) {
  return app.locator('[data-issue]').filter({
    has: app.locator('.ref', { hasText: new RegExp(`^${ref}$`) }),
  });
}

function column(app: FrameLocator, status: string) {
  return app.locator(`section[data-status="${status}"]`);
}

async function subjectOf(app: FrameLocator, ref: string): Promise<string> {
  const subject = await card(app, ref).getAttribute('data-issue');
  if (!subject) throw new Error(`No card for ${ref}`);

  return subject;
}

/** A person renaming a row in the table: the host page's own store. */
async function setName(page: Page, subject: string, name: string) {
  await page.evaluate(
    async ({ row: target, title, property }) => {
      const row = await window.store!.getResource(target);
      await row.set(property, title);
      await row.save();
    },
    { row: subject, title: name, property: NAME },
  );
}

/** A person changing a row's task/v1 Status to the tag with this shortname. */
async function setStatus(page: Page, subject: string, shortname: string) {
  await page.evaluate(
    async ({ target, wanted, task }) => {
      const row = await window.store!.getResource(target);
      await row.set(`${task}/status`, [`${task}/${wanted}`]);
      await row.save();
    },
    { target: subject, wanted: shortname, task: TASK },
  );
}

/**
 * Someone working on GitHub directly: the github-issues fixture's test
 * drivers on the mock proxy (`snapshot`, `updateIssue`), not the app's
 * connection.
 */
async function github(
  method: 'GET' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const number = Number(/^\/issues\/(\d+)$/.exec(path)?.[1]);
  if (!number) throw new Error(`Unsupported GitHub path ${path}`);

  if (method === 'PATCH')
    return (await fixture('updateIssue', [
      REPOSITORY,
      number,
      body ?? {},
    ])) as Record<string, unknown>;
  const { issues } = (await fixture('snapshot', [REPOSITORY])) as {
    issues: { number: number }[];
  };
  const issue = issues.find(i => i.number === number);
  if (!issue) throw new Error(`No issue #${number}`);

  return issue;
}

/** An issue of `TEAM_REPOSITORY`, as the mock's github-issues fixture has it. */
async function teamIssue(number: number): Promise<Record<string, unknown>> {
  const { issues } = (await fixture('snapshot', [TEAM_REPOSITORY])) as {
    issues: { number: number }[];
  };
  const issue = issues.find(i => i.number === number);
  if (!issue) throw new Error(`No issue #${number}`);

  return issue;
}

/**
 * The resources under `table`, read from the server, with `subject`. The
 * app's own properties are keyed by shortname; atomicdata.dev terms keep
 * their URL.
 */
async function rowsUnder(
  page: Page,
  table: string,
): Promise<Record<string, unknown>[]> {
  return page.evaluate(async (subject: string) => {
    const store = window.store!;
    const collection = await (
      await store.getResource(subject)
    ).getChildrenCollection(500);
    const out: Record<string, unknown>[] = [];

    for (const member of await collection.getAllMembers()) {
      const row = await store.fetchResourceFromServer(member, {
        noWebSocket: true,
      });
      const named: Record<string, unknown> = { subject: member };

      for (const [property, value] of Object.entries(row.getPropVals())) {
        const shortname = property.startsWith('https://atomicdata.dev/')
          ? undefined
          : (await store.getResource(property)).get(
              'https://atomicdata.dev/properties/shortname',
            );
        named[typeof shortname === 'string' ? shortname : property] = value;
      }

      out.push(named);
    }

    return out;
  }, table);
}

/**
 * The repository on the App's binding for `table`: a child of the App whose
 * `synced-table` names it.
 */
async function bindingFor(
  page: Page,
  app: string,
  table: string,
): Promise<unknown> {
  return page.evaluate(
    async ({ appSubject, tableSubject }) => {
      const store = window.store!;
      const children = await (
        await store.getResource(appSubject)
      ).getChildrenCollection(500);

      for (const member of await children.getAllMembers()) {
        const child = await store.fetchResourceFromServer(member, {
          noWebSocket: true,
        });
        const named: Record<string, unknown> = {};

        for (const [property, value] of Object.entries(child.getPropVals())) {
          const shortname = (await store.getResource(property)).get(
            'https://atomicdata.dev/properties/shortname',
          );
          named[String(shortname)] = value;
        }

        if (named['synced-table'] === tableSubject)
          return named['github-repository'];
      }

      return undefined;
    },
    { appSubject: app, tableSubject: table },
  );
}

/** One github-issues fixture driver on the mock proxy. */
async function fixture(name: string, args: unknown[]): Promise<unknown> {
  const response = await fetch(
    `${process.env.INTEGRATION_PROXY_URL}/fixture/github-issues/${name}`,
    { method: 'POST', body: JSON.stringify(args) },
  );
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);

  return response.json();
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

/**
 * Installs the app the way a user does: Integrations page, experimental
 * plugins shown, Drive apps, Install. The host downloads the catalog's
 * `app-module` (the lane's dev-server serves the committed
 * `apps/issue-tracker/<version>/ui.js` in place of GitHub Pages) and refuses it
 * unless its bytes match `app-module-integrity`, then opens the new app.
 * Returns the card, for its "Installed <version>" line.
 */
/**
 * The page's `/app-write` POSTs (every write the app makes), with their
 * request size and time to a response, as Playwright reports them.
 */
function appWrites(page: Page) {
  const seen: { bytes: number; ms: number }[] = [];

  page.on('requestfinished', request => {
    if (request.method() !== 'POST' || !request.url().endsWith('/app-write'))
      return;
    const timing = request.timing();
    seen.push({
      bytes: request.postDataBuffer()?.length ?? 0,
      ms: Math.round(timing.responseEnd - timing.requestStart),
    });
  });

  return {
    summary() {
      const ms = seen.map(w => w.ms).sort((a, b) => a - b);
      const at = (q: number) =>
        ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];

      return `${seen.length} writes, ${seen.reduce((n, w) => n + w.bytes, 0)} bytes, largest ${Math.max(0, ...seen.map(w => w.bytes))} bytes; median ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${ms.at(-1)} ms; ${JSON.stringify(seen)}`;
    },
  };
}

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
    .locator('[data-catalog-app="issue-tracker"]');
  await expect(entry).toContainText(`Version ${VERSION}`);
  await entry.getByRole('button', { name: 'Install GitHub issues' }).click();
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });

  return entry;
}
