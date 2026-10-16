// @wc-ignore-file
/**
 * "Sync this table to GitHub" (#177 §6.2 item 14) on an `issue-v1` table the
 * app is a view of, not its own. The fake store enforces the pinned host's
 * row grant (atomic-server `app_row_grant.rs`): no row write without "Allow
 * editing", only `issue-v1`'s columns and the App's declared `row-extras`,
 * never the table, never a delete. The repository, sync state and comments
 * live on a binding under the App.
 */
import { describe as group, expect, it } from 'vitest';
import { SEEDED_REPOSITORY } from '../fixtures/github-issues/scenario.mjs';
import {
  createController,
  describe,
  describeHeld,
  PAUSED_NOTE,
  SYNC_NOTE,
  type ViewState,
} from './controller.js';
import { bannerFor } from './model.js';
import {
  APP,
  fakeStore,
  RENDERS,
  ROW_EXTRAS,
  type FakeStore,
} from './fakeStore.js';
import {
  CLASSTYPE,
  IS_A,
  ISSUE_V1,
  LOCAL_ID,
  NAME,
  PARENT,
  SHORTNAME,
  TASK_STATUS,
  TASK_TAGS,
} from './tracker.js';

const TEAM = 'did:ad:team-table';
const HAND = 'did:ad:hand-1';

type Ready = Extract<ViewState, { kind: 'ready' }>;

const ready = (state: ViewState): Ready => {
  if (state.kind !== 'ready')
    throw new Error(`Expected ready, got ${JSON.stringify(state)}`);

  return state;
};

const property = (store: FakeStore, shortname: string) =>
  [...store.resources.entries()].find(
    ([, props]) => props[SHORTNAME] === shortname,
  )![0];

/** An `issue-v1` table someone made, with one row of their own. */
function teamTable(options: Parameters<typeof fakeStore>[0] = {}): FakeStore {
  const store = fakeStore({ table: TEAM, ...options });
  store.resources.set(TEAM, {
    [PARENT]: 'did:ad:drive',
    [NAME]: 'Team issues',
    [CLASSTYPE]: ISSUE_V1,
  });
  store.resources.set(HAND, {
    [PARENT]: TEAM,
    [IS_A]: [ISSUE_V1],
    [NAME]: 'Plan the offsite',
    [TASK_STATUS]: [TASK_TAGS.Todo],
  });

  return store;
}

const rowsOf = (store: FakeStore) =>
  [...store.resources].filter(([, p]) => p[PARENT] === TEAM);

/** Bindings under the App naming the table. */
const bindingsOf = (store: FakeStore) =>
  [...store.resources].filter(
    ([, p]) => p[PARENT] === APP && p[property(store, 'synced-table')] === TEAM,
  );

const tableWrites = (store: FakeStore) =>
  store.writes.filter(
    w =>
      w.subject === TEAM || store.resources.get(w.subject)?.[PARENT] === TEAM,
  );

const githubWrites = (store: FakeStore) =>
  store.calls.filter(c => (c.method ?? 'GET') !== 'GET');

async function synced(store = teamTable()) {
  const controller = createController(store);
  await controller.start();
  const chosen = await controller.syncTable();
  expect(chosen.kind).toBe('choose-repository');
  const state = ready(await controller.choose(SEEDED_REPOSITORY));
  if (state.problem) throw new Error(state.problem.message);

  return { store, controller, state };
}

group('Sync this table to GitHub (#177 §6.2 item 14)', () => {
  it('offers it on a table that isn’t synced, and writes nothing before it is pressed', async () => {
    const store = teamTable();
    const controller = createController(store);
    const state = await controller.start();
    expect(state).toEqual({ kind: 'other-table', canSync: true });
    expect(describe(state)).toContain(SYNC_NOTE);
    expect(controller.foreign()).toBe('Team issues');
    expect(store.asked).toBe(0);
    expect(store.calls).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  it('is not offered on a host without the row grant or the proxy relay', async () => {
    for (const store of [
      Object.assign(teamTable(), { requestRowAccess: undefined }),
      teamTable({ relay: false }),
    ]) {
      const controller = createController(store);
      expect(await controller.start()).toEqual({
        kind: 'other-table',
        canSync: false,
      });
      expect((await controller.syncTable()).kind).toBe('other-table');
      expect(store.writes).toEqual([]);
    }
  });

  it('asks for Allow editing with the row extras, binds the table under the App, and imports into it', async () => {
    const { store, state } = await synced();
    expect(store.asked).toBe(1);
    // The grant covers what the App declares: three GitHub extras and localId.
    expect([...store.grant!.extras].sort()).toEqual(
      [
        property(store, 'github-issue-number'),
        property(store, 'github-source'),
        property(store, 'github-sync-baseline'),
        LOCAL_ID,
      ].sort(),
    );
    // One binding, under the App, with the repository; the table is untouched.
    const bindings = bindingsOf(store);
    expect(bindings).toHaveLength(1);
    expect(bindings[0][1][property(store, 'github-repository')]).toBe(
      SEEDED_REPOSITORY,
    );
    expect(store.resources.get(TEAM)).toEqual({
      [PARENT]: 'did:ad:drive',
      [NAME]: 'Team issues',
      [CLASSTYPE]: ISSUE_V1,
    });
    expect(store.writes.filter(w => w.subject === TEAM)).toEqual([]);
    // GitHub's two issues became rows of the table, with the extras.
    const imported = rowsOf(store).filter(([s]) => s !== HAND);
    expect(imported).toHaveLength(2);

    for (const [, row] of imported) {
      expect(row[IS_A]).toEqual([ISSUE_V1]);
      expect(row[property(store, 'github-issue-number')]).toEqual(
        expect.any(Number),
      );
      expect(row[property(store, 'github-sync-baseline')]).toEqual(
        expect.any(String),
      );
    }

    // #1's comment is a Message in a folder under the binding.
    const comment = state.last!.result.rows.find(r => r.number === 1)!
      .comments[0].subject;
    const parentOf = (s: string) => store.resources.get(s)?.[PARENT];
    expect(parentOf(parentOf(comment) as string)).toBe(bindings[0][0]);
    // The row that was already there stays local only, untouched.
    expect(store.resources.get(HAND)).toEqual({
      [PARENT]: TEAM,
      [IS_A]: [ISSUE_V1],
      [NAME]: 'Plan the offsite',
      [TASK_STATUS]: [TASK_TAGS.Todo],
    });
    expect(state.last!.result.rows.find(r => r.subject === HAND)).toMatchObject(
      { localOnly: true },
    );
    expect(githubWrites(store)).toEqual([]);
  });

  it('asks again when Add view’s grant came before the App declared its extras', async () => {
    const { store } = await synced(teamTable({ grant: 'columns' }));
    expect(store.asked).toBe(1);
    expect(store.grant!.extras).toHaveLength(4);
  });

  it('stays not synced, with the reason, when the person says Not now to the host', async () => {
    const store = teamTable({ answer: 'deny' });
    const controller = createController(store);
    await controller.start();
    expect(await controller.syncTable()).toEqual({
      kind: 'other-table',
      canSync: true,
      reason: 'Not synced: The person said no.',
    });
    expect(bindingsOf(store)).toEqual([]);
    expect(store.calls).toEqual([]);
    expect(tableWrites(store)).toEqual([]);
  });

  it('sends a status edit made in the table after review, and moves the row’s baseline', async () => {
    const { store, controller, state } = await synced();
    const first = state.last!.result.rows.find(r => r.number === 1)!.subject;
    // The person closes #1 in the host's table: their own commit.
    store.edit(first, { [TASK_STATUS]: [TASK_TAGS.Done] });
    const held = ready(await controller.sync());
    expect(held.last!.result.held.map(describeHeld)).toEqual([
      'Update #1: status Todo → Done (close it)',
    ]);
    expect(githubWrites(store)).toEqual([]);
    const sent = ready(await controller.send());
    expect(sent.problem).toBeUndefined();
    expect(sent.last!.result.sentToGitHub).toBe(1);
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'closed',
    );
    const baseline = JSON.parse(
      store.resources.get(first)![
        property(store, 'github-sync-baseline')
      ] as string,
    );
    expect(baseline.status).toBe('Done');
  });

  it('publishes a row that was already there only when asked, after review', async () => {
    const { store, controller } = await synced();
    expect(ready(await controller.sync()).last!.result.held).toEqual([]);
    await controller.publish(HAND);
    const held = ready(controller.state());
    expect(held.last!.result.held.map(describeHeld)).toEqual([
      'Create issue “Plan the offsite” (Todo)',
    ]);
    ready(await controller.send());
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[2].title).toBe(
      'Plan the offsite',
    );
    // The next pass writes the issue number onto the row (a row extra).
    await controller.sync();
    expect(
      store.resources.get(HAND)![property(store, 'github-issue-number')],
    ).toBe(3);
  });

  it('opens straight into the sync next time, without asking again', async () => {
    const { store } = await synced();
    const again = createController(store);
    const state = ready(await again.start());
    expect(state.repository).toBe(SEEDED_REPOSITORY);
    expect(state.problem).toBeUndefined();
    expect(state.last!.result.addedHere).toBe(0);
    expect(store.asked).toBe(1);
  });

  it('pauses, without a request to GitHub, once the grant is taken back', async () => {
    const { store, controller } = await synced();
    store.revokeGrant();
    const calls = store.calls.length;
    expect(await controller.sync()).toEqual({
      kind: 'other-table',
      canSync: true,
      reason: PAUSED_NOTE,
    });
    const reopened = createController(store);
    expect(await reopened.start()).toMatchObject({
      kind: 'other-table',
      reason: PAUSED_NOTE,
    });
    expect(store.calls.length).toBe(calls);
    // Allowing editing again goes on with the same repository and binding.
    const resumed = ready(await reopened.syncTable());
    expect(store.asked).toBe(2);
    expect(resumed.repository).toBe(SEEDED_REPOSITORY);
    expect(resumed.problem).toBeUndefined();
    expect(bindingsOf(store)).toHaveLength(1);
  });

  it('Not now before a repository is chosen goes back to not synced', async () => {
    const store = teamTable();
    const controller = createController(store);
    await controller.start();
    expect((await controller.syncTable()).kind).toBe('choose-repository');
    expect(bindingsOf(store)).toHaveLength(1);
    expect(await controller.notNow()).toEqual({
      kind: 'other-table',
      canSync: true,
    });
    expect(bindingsOf(store)).toEqual([]);
  });

  it('never deletes a row of the table: Remove from board is not offered or done there', async () => {
    const { store, controller, state } = await synced();
    const row = state.last!.result.rows.find(r => r.number === 1)!.subject;
    // GitHub stops returning #1 (deleted or transferred).
    const request = store.proxy!.request.bind(store.proxy);

    store.proxy!.request = async r => {
      if (/\/issues\/1(\/|$)/.test(r.path))
        return { status: 404, headers: {}, body: {} };
      const response = await request(r);
      if (/\/issues$/.test(r.path) && Array.isArray(response.body))
        return {
          ...response,
          body: (response.body as { number: number }[]).filter(
            i => i.number !== 1,
          ),
        };

      return response;
    };

    const paused = ready(await controller.sync());
    expect(paused.problem).toMatchObject({ kind: 'paused', reason: 'missing' });
    const banner = bannerFor(paused, false, false)!;
    expect(banner.actions.map(a => a.label)).toEqual(['Keep here only']);
    expect(banner.text).toContain('delete its row in the table');
    await controller.removeFromBoard();
    expect(store.resources.has(row)).toBe(true);
    // Keep here only just takes the issue number off the row: allowed.
    expect(ready(await controller.keepHereOnly()).problem).toBeUndefined();
    expect(
      store.resources.get(row)![property(store, 'github-issue-number')],
    ).toBeUndefined();
  });

  it('renders issue-v1 and declares its row extras from the first open, before connecting', async () => {
    const store = fakeStore({ connected: false });
    expect((await createController(store).start()).kind).toBe('not-connected');
    const app = store.resources.get(APP)!;
    expect(app[RENDERS]).toContain(ISSUE_V1);
    expect(app[ROW_EXTRAS]).toContain(LOCAL_ID);
  });

  it('leaves the app’s own table as it was: no binding, no grant asked', async () => {
    const store = fakeStore();
    const controller = createController(store);
    expect((await controller.start()).kind).toBe('choose-repository');
    expect(controller.foreign()).toBeUndefined();
    expect(await controller.syncTable()).toMatchObject({
      kind: 'choose-repository',
    });
    expect(store.asked).toBe(0);
  });
});
