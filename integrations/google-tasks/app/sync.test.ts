// @wc-ignore-file
/**
 * The import pass against the in-memory store and the synthetic Google
 * Tasks fixture: provisioning as a view of issue-v1, choosing lists, the
 * first import, a refresh that writes no row, a task that stops appearing
 * (deleted, unavailable, unconfirmed, partial read, reappearance, a list no
 * longer ticked), rate limits before any write, and the controller as the
 * host runs it. The clock is pinned throughout.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createController,
  describe as describeState,
  describeSummary,
  MAX_AUTO_RETRIES,
  MAX_AUTO_RETRY_MS,
} from './controller.js';
import {
  CLASSTYPE,
  ISSUE_V1,
  NAME,
  OtherTable,
  PROPERTIES,
  provision,
  recordChosenLists,
  SHORTNAME,
  syncTime,
  TABLE_NAME,
  TAG_DONE,
  TAG_TODO,
  TASK_BODY,
  TASK_DUE_DATE,
  TASK_STATUS,
} from './drive.js';
import {
  APP,
  fakeStore,
  ONTOLOGY,
  OTHER_TABLE,
  RENDERS,
  ROW_EXTRAS,
  TABLE,
} from './fakeStore.js';
import {
  DEFAULT_RETRY_MS,
  GoogleError,
  GoogleRateLimited,
  MAX_INLINE_WAIT_MS,
} from './read.js';
import { relayGet, syncTasks } from './sync.js';
import { GROCERIES, MY_TASKS } from '../fixtures/google-tasks/synthetic.mjs';

const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-01T11:00:00.000Z';
const T3 = '2026-03-01T12:00:00.000Z';
const T4 = '2026-03-01T13:00:00.000Z';
const CONNECTION = { platform: 'google-tasks', connectionId: 'c1' };

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse(T4));
});
afterAll(() => vi.useRealTimers());

async function setUp(chosen: string[] = [MY_TASKS]) {
  const store = fakeStore();
  const drive = await provision(store);
  await recordChosenLists(store, drive, chosen);
  const get = relayGet(store.proxy!, CONNECTION);
  const waits: number[] = [];
  const sync = (
    now: string,
    options: { read?: { maxPages?: number }; maxLookups?: number } = {},
  ) =>
    syncTasks(store, get, drive, {
      now: () => now,
      ...options,
      rateLimit: {
        now: () => Date.parse(now),
        sleep: async ms => void waits.push(ms),
      },
    });

  const rowOf = (taskId: string) => {
    for (const [subject, props] of store.resources)
      if (props[drive.properties.taskId] === taskId)
        return { subject, ...props };

    throw new Error(`no row for ${taskId}`);
  };

  const p = drive.properties;

  return { store, drive, sync, rowOf, p, waits };
}

describe('provisioning', () => {
  it('makes the app a view of issue-v1 and adds its extras, once', async () => {
    const { store, drive, p } = await setUp();
    const app = store.resources.get(APP)!;
    expect(app[RENDERS]).toContain(ISSUE_V1);
    expect(app[ROW_EXTRAS]).toEqual([
      p.taskId,
      p.listId,
      p.list,
      p.presence,
      p.lastSeen,
      p.parent,
      p.source,
    ]);
    const table = store.resources.get(TABLE)!;
    expect(table[CLASSTYPE]).toBe(ISSUE_V1);
    expect(table[NAME]).toBe(TABLE_NAME);
    expect(drive.rowClass).toBe(ISSUE_V1);
    const listed = store.resources.get(ONTOLOGY)![PROPERTIES] as string[];
    expect(listed).toHaveLength(10);
    expect(listed.map(s => store.resources.get(s)![SHORTNAME])).toContain(
      'google-tasks-task-id',
    );

    const before = store.writes.length;
    const again = await provision(store);
    expect(again).toEqual(drive);
    expect(store.writes.length).toBe(before);
  });

  it('refuses another Issue table, after declaring what it renders', async () => {
    const store = fakeStore({ table: OTHER_TABLE });
    await expect(provision(store)).rejects.toBeInstanceOf(OtherTable);
    expect(store.resources.get(APP)![RENDERS]).toContain(ISSUE_V1);
    expect(store.resources.get(OTHER_TABLE)![CLASSTYPE]).not.toBe(ISSUE_V1);
  });
});

describe('the last sync time', () => {
  it('is read strictly: ISO 8601 UTC only, never a future time or junk', () => {
    const now = Date.parse(T2);
    expect(syncTime(T1, now)).toBe(T1);
    expect(syncTime('2026-03-01T10:00:00Z', now)).toBe('2026-03-01T10:00:00Z');
    for (const junk of [
      T3,
      '2026-03-01T10:00:00+02:00',
      '2026-03-01 10:00:00',
      '2026-03-01',
      'yesterday',
      '',
      42,
      null,
      undefined,
      ['2026-03-01T10:00:00.000Z'],
    ])
      expect(syncTime(junk as never, now)).toBeUndefined();
  });
});

describe('import', () => {
  it('reads the task lists and nothing else while no list is chosen', async () => {
    const { store, sync } = await setUp([]);
    const before = store.writes.length;
    const summary = await sync(T1);
    expect(summary).toMatchObject({
      total: 0,
      lists: [
        { id: MY_TASKS, title: 'My Tasks' },
        { id: GROCERIES, title: 'Synthetic groceries' },
      ],
      chosen: [],
      complete: true,
    });
    expect(describeSummary(summary)).toBe(
      'No task list chosen yet; 2 lists found. Tick the lists to import.',
    );
    expect(store.calls.map(c => c.path)).toEqual(['/tasks/v1/users/@me/lists']);
    // The one write: the App's last complete read.
    expect(store.writes.slice(before).map(w => w.subject)).toEqual([APP]);
  });

  it('writes every task of a chosen list as an issue-v1 row with shared fields and extras', async () => {
    const { store, sync, rowOf, p } = await setUp();
    const summary = await sync(T1);
    expect(summary).toMatchObject({
      total: 5,
      added: 5,
      updated: 0,
      unchanged: 0,
      checked: 0,
      complete: true,
      presence: { present: 5, deleted: 0, unavailable: 0, unconfirmed: 0 },
    });
    expect(describeSummary(summary)).toBe(
      '5 tasks (5 added, 0 updated, 0 unchanged); 5 present.',
    );
    // The fixed flags on every tasks page, and both pages of the list.
    const reads = store.calls.filter(c => c.path.endsWith('/tasks'));
    expect(reads).toHaveLength(2);
    for (const call of reads)
      expect(call.query).toMatchObject({
        showCompleted: 'true',
        showHidden: 'true',
        maxResults: '100',
      });
    expect(reads[1].query).toMatchObject({ pageToken: 'page-2' });

    const ferns = rowOf('synthetic-task-1');
    expect(ferns).toMatchObject({
      [NAME]: 'Water the imaginary ferns',
      [TASK_STATUS]: [TAG_TODO],
      [TASK_DUE_DATE]: '2026-03-02',
      [p.presence]: 'present',
      [p.listId]: MY_TASKS,
      [p.list]: 'My Tasks',
    });
    expect(ferns).not.toHaveProperty(TASK_BODY);
    expect(ferns).not.toHaveProperty(p.lastSeen);
    expect(ferns).not.toHaveProperty(p.parent);
    expect(JSON.parse(ferns[p.source] as string)).toMatchObject({
      id: 'synthetic-task-1',
      status: 'needsAction',
      due: '2026-03-02T00:00:00.000Z',
    });

    expect(rowOf('synthetic-task-2')).toMatchObject({
      [TASK_BODY]: 'Ask about the pretend filling.',
      [TASK_DUE_DATE]: '2026-03-03',
    });
    // A subtask: flat, with the parent's id as an extra.
    expect(rowOf('synthetic-task-3')).toMatchObject({
      [p.parent]: 'synthetic-task-1',
    });
    // Completed (and hidden) in Google: done here, present.
    expect(rowOf('synthetic-task-4')).toMatchObject({
      [TASK_STATUS]: [TAG_DONE],
      [p.presence]: 'present',
    });
    expect(rowOf('synthetic-task-5')).not.toHaveProperty(TASK_DUE_DATE);

    // The read's time is on the App, not on the rows.
    expect(store.resources.get(APP)![p.lastSync]).toBe(T1);
  });

  it('imports a second list when it is ticked, a task without a title as an empty Name', async () => {
    const { store, sync, rowOf, drive } = await setUp();
    await sync(T1);
    await recordChosenLists(store, drive, [MY_TASKS, GROCERIES]);
    expect(await sync(T2)).toMatchObject({ total: 7, added: 2, unchanged: 5 });
    expect(rowOf('synthetic-task-7')).toMatchObject({
      [NAME]: '',
      [TASK_BODY]: 'A task Google sent without a title.',
    });
  });

  it('refreshes without writing any row when nothing changed: the sync time is the only write', async () => {
    const { store, sync, p } = await setUp();
    await sync(T1);
    const rows = new Map(
      [...store.resources].filter(([, props]) => props[TASK_STATUS]),
    );
    const appBefore = { ...store.resources.get(APP)! };
    const before = store.writes.length;

    expect(await sync(T2)).toMatchObject({
      added: 0,
      updated: 0,
      unchanged: 5,
    });
    // The persisted sync times (one save of the App, holding the complete
    // read's time and the pass's time) are the one allowed write; any other
    // write, to a row or to another App property, fails this test.
    expect(store.writes.slice(before)).toEqual([{ op: 'save', subject: APP }]);
    const appAfter = { ...store.resources.get(APP)! };
    expect(appAfter[p.lastSync]).toBe(T2);
    expect(appAfter[p.lastPass]).toBe(T2);

    for (const key of [p.lastSync, p.lastPass]) {
      delete appBefore[key];
      delete appAfter[key];
    }

    expect(appAfter).toEqual(appBefore);
    for (const [subject, props] of rows)
      expect(store.resources.get(subject)).toEqual(props);
  });

  it('takes a change made in Google: a rename, and a completion without any lookup', async () => {
    const { store, sync, rowOf } = await setUp();
    await sync(T1);
    store.google.renameTask('synthetic-task-5', 'Sort the pretend cellar');
    store.google.completeTask('synthetic-task-1');
    const calls = store.calls.length;
    expect(await sync(T2)).toMatchObject({
      updated: 2,
      unchanged: 3,
      checked: 0,
      presence: { present: 5 },
    });
    expect(
      store.calls.slice(calls).some(c => /\/tasks\/[^/?]+$/.test(c.path)),
    ).toBe(false);
    expect(rowOf('synthetic-task-5')[NAME]).toBe('Sort the pretend cellar');
    expect(rowOf('synthetic-task-1')).toMatchObject({
      [TASK_STATUS]: [TAG_DONE],
      [NAME]: 'Water the imaginary ferns',
    });
  });

  it('leaves a hand-made row alone', async () => {
    const { store, sync } = await setUp();
    const local = await store.newResource({
      parent: TABLE,
      isA: [ISSUE_V1],
      propVals: { [NAME]: 'Written in the table' },
    });
    expect(await sync(T1)).toMatchObject({ total: 5, added: 5 });
    expect(store.resources.get(local.subject)).toEqual({ ...local.props });
  });

  it('writes nothing when a page fails, and names a revoked connection', async () => {
    const { store, sync } = await setUp();
    store.google.failNext(1, 503, 'tasks');
    const before = store.writes.length;
    await expect(sync(T1)).rejects.toThrow('Google Tasks answered 503');
    expect(store.writes.length).toBe(before);

    store.google.failNext(1, 401, 'lists');
    await expect(sync(T1)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof GoogleError && /reconnect Google Tasks/.test(e.message),
    );
  });

  it('waits out a short rate limit, and stops before any write on a long one, 429 or 403', async () => {
    const { store, sync, waits, p } = await setUp();
    store.limitNext = { count: 1, retryAfter: '2' };
    expect(await sync(T1)).toMatchObject({ added: 5 });
    expect(waits).toEqual([2000]);

    store.google.completeTask('synthetic-task-1');
    store.limitNext = { count: 1, retryAfter: '120' };
    const before = store.writes.length;
    const error = (await sync(T2).catch(
      (e: unknown) => e,
    )) as GoogleRateLimited;
    expect(error).toBeInstanceOf(GoogleRateLimited);
    expect(error.retryAt).toBe(Date.parse(T2) + 120_000);
    expect(store.writes.length).toBe(before);
    expect(waits).toEqual([2000]);

    // Google's 403 with a rate-limit reason, no Retry-After: the default wait.
    store.limitNext = { count: 1, status: 403 };
    const forbidden = (await sync(T2).catch(
      (e: unknown) => e,
    )) as GoogleRateLimited;
    expect(forbidden).toBeInstanceOf(GoogleRateLimited);
    expect(forbidden.status).toBe(403);
    expect(forbidden.retryAt).toBe(Date.parse(T2) + DEFAULT_RETRY_MS);
    expect(store.writes.length).toBe(before);

    // A rate limit on the by-id check stops the pass too: the task is not
    // marked unconfirmed, and the App's last complete read is not moved.
    store.google.deleteTask('synthetic-task-2');
    store.limitNext = { count: 1, only: 'lookup' };
    const calls = store.calls.length;
    await expect(sync(T3)).rejects.toBeInstanceOf(GoogleRateLimited);
    expect(store.calls.slice(calls).at(-1)?.path).toBe(
      `/tasks/v1/lists/${MY_TASKS}/tasks/synthetic-task-2`,
    );
    expect(store.writes.length).toBe(before);
    expect(store.resources.get(APP)![p.lastSync]).toBe(T1);
  });
});

describe('a task that stops appearing', () => {
  it('is looked up by id once and marked deleted when Google says so, not closed', async () => {
    const { store, sync, rowOf, p } = await setUp();
    await sync(T1);
    store.google.deleteTask('synthetic-task-1');
    const calls = store.calls.length;

    const summary = await sync(T2);
    expect(summary).toMatchObject({
      updated: 1,
      unchanged: 4,
      checked: 1,
      presence: { present: 4, deleted: 1 },
    });
    expect(describeSummary(summary)).toContain('4 present, 1 deleted');
    expect(
      store.calls.slice(calls).filter(c => /\/tasks\/[^/?]+$/.test(c.path)),
    ).toEqual([
      expect.objectContaining({
        path: `/tasks/v1/lists/${MY_TASKS}/tasks/synthetic-task-1`,
      }),
    ]);
    expect(rowOf('synthetic-task-1')).toMatchObject({
      [TASK_STATUS]: [TAG_TODO],
      [p.presence]: 'deleted',
      // Last returned by the complete read at T1, not by this pass.
      [p.lastSeen]: T1,
      [NAME]: 'Water the imaginary ferns',
      [TASK_DUE_DATE]: '2026-03-02',
    });

    // Settled: not checked again, and unchanged on the next pass.
    const again = await sync(T3);
    expect(again).toMatchObject({ checked: 0, updated: 0, unchanged: 5 });
  });

  it('is unavailable after a 404, keeping its values and when it was seen; nothing is removed', async () => {
    const { store, sync, rowOf, p } = await setUp();
    await sync(T1);
    store.google.removeTask('synthetic-task-3');

    expect(await sync(T2)).toMatchObject({
      updated: 1,
      checked: 1,
      presence: { present: 4, unavailable: 1 },
    });
    expect(rowOf('synthetic-task-3')).toMatchObject({
      [TASK_STATUS]: [TAG_TODO],
      [p.presence]: 'unavailable',
      [p.lastSeen]: T1,
      [p.parent]: 'synthetic-task-1',
    });
    expect([...store.resources.values()].filter(r => r[p.taskId]).length).toBe(
      5,
    );
    expect(await sync(T3)).toMatchObject({ checked: 0, updated: 0 });
  });

  it('is unconfirmed when the check fails, and checked again next time', async () => {
    const { store, sync, rowOf, p } = await setUp();
    await sync(T1);
    store.google.deleteTask('synthetic-task-4');
    store.google.failNext(1, 503, 'lookup');

    expect(await sync(T2)).toMatchObject({
      checked: 1,
      presence: { present: 4, unconfirmed: 1 },
    });
    expect(rowOf('synthetic-task-4')).toMatchObject({
      [TASK_STATUS]: [TAG_DONE],
      [p.presence]: 'unconfirmed',
      [p.lastSeen]: T1,
    });

    expect(await sync(T3)).toMatchObject({
      checked: 1,
      presence: { present: 4, deleted: 1 },
    });
    expect(rowOf('synthetic-task-4')).toMatchObject({
      [p.presence]: 'deleted',
      [p.lastSeen]: T1,
    });
  });

  it('checks at most the lookup cap per pass, the rest at a later one', async () => {
    const { store, sync, rowOf, p } = await setUp();
    await sync(T1);
    store.google.deleteTask('synthetic-task-1');
    store.google.deleteTask('synthetic-task-2');
    expect(await sync(T2, { maxLookups: 1 })).toMatchObject({
      checked: 1,
      presence: { present: 3, deleted: 1, unconfirmed: 1 },
    });
    expect(rowOf('synthetic-task-1')[p.presence]).toBe('deleted');
    expect(rowOf('synthetic-task-2')[p.presence]).toBe('unconfirmed');
    expect(await sync(T3, { maxLookups: 1 })).toMatchObject({
      checked: 1,
      presence: { present: 3, deleted: 2, unconfirmed: 0 },
    });
  });

  it('draws nothing from a partial read', async () => {
    const { store, sync, rowOf, p } = await setUp();
    await sync(T1);
    store.google.deleteTask('synthetic-task-1');
    const calls = store.calls.length;

    // Three tasks per fixture page: one page is a partial read of the list.
    const summary = await sync(T2, { read: { maxPages: 1 } });
    expect(summary).toMatchObject({
      complete: false,
      checked: 0,
      updated: 0,
      presence: { present: 5 },
    });
    expect(describeSummary(summary)).toContain('The read was partial');
    expect(
      store.calls.slice(calls).some(c => /\/tasks\/[^/?]+$/.test(c.path)),
    ).toBe(false);
    expect(rowOf('synthetic-task-1')[p.presence]).toBe('present');
    // The App's last complete read stays T1; the pass is recorded.
    expect(store.resources.get(APP)![p.lastSync]).toBe(T1);
    expect(store.resources.get(APP)![p.lastPass]).toBe(T2);

    expect(await sync(T3)).toMatchObject({
      checked: 1,
      presence: { present: 4, deleted: 1 },
    });
  });

  it('is present again when it reappears', async () => {
    const { store, sync, rowOf, p } = await setUp();
    await sync(T1);
    store.google.deleteTask('synthetic-task-1');
    await sync(T2);
    store.google.reopenTask('synthetic-task-1');

    expect(await sync(T3)).toMatchObject({
      reappeared: 1,
      updated: 1,
      presence: { present: 5, deleted: 0 },
    });
    const row = rowOf('synthetic-task-1');
    expect(row).toMatchObject({ [p.presence]: 'present' });
    expect(row).not.toHaveProperty(p.lastSeen);
    expect(await sync(T4)).toMatchObject({ updated: 0, unchanged: 5 });
  });

  it('keeps the rows of a list that is no longer ticked as they are, unchecked', async () => {
    const { store, sync, drive } = await setUp([MY_TASKS, GROCERIES]);
    await sync(T1);
    await recordChosenLists(store, drive, [GROCERIES]);
    store.google.deleteTask('synthetic-task-1');
    const before = store.writes.length;
    expect(await sync(T2)).toMatchObject({
      total: 7,
      unchanged: 7,
      checked: 0,
      presence: { present: 7 },
    });
    expect(store.writes.slice(before).map(w => w.subject)).toEqual([APP]);
  });
});

describe('controller', () => {
  const states: string[] = [];
  const track = (store: ReturnType<typeof fakeStore>) =>
    createController(store, s => states.push(s.kind), {
      now: () => T1,
      clock: () => Date.parse(T1),
    });

  it('syncs on load with a connection, lists the lists, and imports a chosen list', async () => {
    states.length = 0;
    const store = fakeStore();
    const controller = track(store);
    const { syncing } = await controller.load();
    await syncing;
    let state = controller.state();
    expect(state.kind).toBe('synced');
    if (state.kind !== 'synced') return;
    expect(state.summary.total).toBe(0);
    expect(state.lists.map(l => l.title)).toEqual([
      'My Tasks',
      'Synthetic groceries',
    ]);
    expect(state.chosen).toEqual([]);
    expect(states).toEqual(['syncing', 'synced']);

    await controller.chooseLists([MY_TASKS]);
    state = controller.state();
    expect(state.kind).toBe('synced');
    if (state.kind !== 'synced') return;
    expect(state.chosen).toEqual([MY_TASKS]);
    expect(state.summary.added).toBe(5);
    expect(state.tasks.map(t => t.name)).toEqual([
      'Buy invented fern food',
      'Call the fictional dentist',
      'Return the made-up library books',
      'Sort the pretend attic',
      'Water the imaginary ferns',
    ]);
    expect(state.tasks[0]).toMatchObject({
      taskId: 'synthetic-task-3',
      done: false,
      presence: 'present',
      list: 'My Tasks',
      listId: MY_TASKS,
      parent: 'synthetic-task-1',
    });
    expect(state.tasks[2]).toMatchObject({ done: true });
    expect(describeState(state)).toContain('5 tasks (5 added');
  });

  it('lists a hand-made row, and one missing its Name as incomplete, without writing either (#177)', async () => {
    const store = fakeStore();
    const controller = track(store);
    await (
      await controller.load()
    ).syncing;
    await controller.chooseLists([MY_TASKS]);
    const named = await store.newResource({
      parent: TABLE,
      isA: [ISSUE_V1],
      propVals: { [NAME]: 'Written in the table' },
    });
    const nameless = await store.newResource({
      parent: TABLE,
      isA: [ISSUE_V1],
      propVals: { [TASK_STATUS]: [TAG_TODO] },
    });
    const before = store.writes.length;
    await controller.sync();
    const state = controller.state();
    expect(state.kind).toBe('synced');
    if (state.kind !== 'synced') return;
    expect(state.summary).toMatchObject({ total: 5, unchanged: 5 });
    expect(state.tasks).toHaveLength(7);
    expect(state.tasks[0]).toEqual({
      subject: nameless.subject,
      name: '',
      done: false,
      presence: 'local',
      incomplete: 'Incomplete: missing Name',
    });
    expect(state.tasks.find(t => t.subject === named.subject)).toEqual({
      subject: named.subject,
      name: 'Written in the table',
      done: false,
      presence: 'local',
    });
    const written = store.writes.slice(before).map(w => w.subject);
    expect(written).not.toContain(named.subject);
    expect(written).not.toContain(nameless.subject);
  });

  it('is disconnected without a connection, and syncs after an existing one is picked', async () => {
    const store = fakeStore({ connected: false, existing: true });
    const controller = track(store);
    await controller.load();
    expect(controller.state().kind).toBe('disconnected');
    expect(describeState(controller.state())).toContain('Not connected');
    await controller.connect();
    expect(controller.state().kind).toBe('synced');
  });

  it('records a chosen list while disconnected, and syncs it once connected', async () => {
    const store = fakeStore({ connected: false, existing: true });
    const controller = track(store);
    await controller.load();
    await controller.chooseLists([GROCERIES]);
    expect(controller.state()).toMatchObject({
      kind: 'disconnected',
      chosen: [GROCERIES],
    });
    await controller.connect();
    expect(controller.state()).toMatchObject({
      kind: 'synced',
      summary: { total: 2, added: 2 },
    });
  });

  it('reports another table and a host without the proxy client', async () => {
    const other = track(fakeStore({ table: OTHER_TABLE }));
    await other.load();
    expect(other.state().kind).toBe('other-table');

    const bare = track(fakeStore({ relay: false }));
    await bare.load();
    expect(bare.state().kind).toBe('no-relay');
  });

  it('keeps the imported rows when a refresh fails, names the last good read, and says "kept" only then', async () => {
    const store = fakeStore();
    const controller = track(store);
    await (
      await controller.load()
    ).syncing;
    // Nothing imported yet: a failure does not claim anything is kept.
    store.fail = 'host offline';
    await controller.sync();
    expect(controller.state().kind).toBe('error');
    expect(describeState(controller.state())).not.toContain('kept');

    delete store.fail;
    await controller.chooseLists([MY_TASKS]);
    store.fail = 'host offline';
    await controller.sync();
    const state = controller.state();
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.message).toContain('host offline');
    expect(state.status).toBeUndefined();
    expect(state.at).toBe(Date.parse(T1));
    expect(state.lastGood).toBe(T1);
    expect(state.tasks).toHaveLength(5);
    expect(describeState(state)).toContain('Tasks imported earlier are kept.');

    delete store.fail;
    store.google.failNext(1, 503, 'lists');
    await controller.sync();
    expect(controller.state()).toMatchObject({ kind: 'error', status: 503 });

    // A later successful sync leaves no stale warning behind.
    await controller.sync();
    expect(controller.state()).toMatchObject({ kind: 'synced' });
    expect(controller.state()).not.toHaveProperty('rateLimited');
  });

  it('after a partial first read, a reload knows the pass that wrote the rows, not a complete read', async () => {
    const store = fakeStore();
    // The list is chosen before the first open, so the very first pass is
    // the partial one (three tasks per fixture page, one page read).
    await recordChosenLists(store, await provision(store), [MY_TASKS]);
    const controller = createController(store, () => undefined, {
      now: () => T1,
      clock: () => Date.parse(T1),
      read: { maxPages: 1 },
    });
    await (
      await controller.load()
    ).syncing;
    expect(controller.state()).toMatchObject({
      kind: 'synced',
      summary: { total: 3, complete: false },
      lastPass: T1,
    });
    expect(controller.state()).not.toHaveProperty('lastGood');

    // Reloaded while disconnected: the rows are there, and so is the pass.
    store.proxy!.connections = async () => [];
    const reopened = track(store);
    await reopened.load();
    expect(reopened.state()).toMatchObject({
      kind: 'disconnected',
      lastPass: T1,
    });
    expect(reopened.state()).not.toHaveProperty('lastGood');
    expect((reopened.state() as { tasks: unknown[] }).tasks).toHaveLength(3);
  });

  it('knows the last complete read before this page load syncs, and ignores a junk or future one', async () => {
    const store = fakeStore();
    const first = track(store);
    await (
      await first.load()
    ).syncing;
    await first.chooseLists([MY_TASKS]);
    const again = track(fakeStore({ connected: false }));
    await again.load();
    expect(again.state()).toMatchObject({ kind: 'disconnected' });
    expect(again.state()).not.toHaveProperty('lastGood');

    store.proxy!.connections = async () => [];
    const reopened = track(store);
    await reopened.load();
    expect(reopened.state()).toMatchObject({
      kind: 'disconnected',
      lastGood: T1,
      chosen: [MY_TASKS],
    });
    expect((reopened.state() as { tasks: unknown[] }).tasks).toHaveLength(5);

    const lastSync = (
      store.resources.get(ONTOLOGY)![PROPERTIES] as string[]
    ).find(
      s => store.resources.get(s)![SHORTNAME] === 'google-tasks-last-sync',
    )!;

    for (const junk of ['yesterday', T3, '2026-03-01T10:00:00+02:00']) {
      store.resources.set(APP, {
        ...store.resources.get(APP)!,
        [lastSync]: junk,
      });
      const c = track(store);
      await c.load();
      expect(c.state()).toMatchObject({ kind: 'disconnected' });
      expect(c.state()).not.toHaveProperty('lastGood');
    }
  });
});

describe('controller under a rate limit', () => {
  const NOW = Date.parse(T1);

  /** A controller whose clock and retry timer the test drives. */
  function limited(store: ReturnType<typeof fakeStore>) {
    const states: string[] = [];
    const timers: {
      run: () => void;
      ms: number;
      cleared: boolean;
      ran?: boolean;
    }[] = [];
    let now = NOW;
    const controller = createController(store, s => states.push(s.kind), {
      now: () => new Date(now).toISOString(),
      clock: () => now,
      rateLimit: { now: () => now, sleep: async () => undefined },
      timer: {
        set: (run, ms) => {
          const timer = { run, ms, cleared: false };
          timers.push(timer);

          return timer;
        },
        clear: handle => {
          (handle as { cleared: boolean }).cleared = true;
        },
      },
    });

    /** Lets the one waiting retry fire, as the timer would. */
    const fire = async () => {
      const pending = timers.filter(t => !t.cleared && !t.ran);
      expect(pending).toHaveLength(1);
      const [timer] = pending;
      timer.ran = true;
      now += timer.ms;
      timer.run();
      // The retry's sync runs on the next ticks.
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
    };

    return { controller, states, timers, fire };
  }

  async function connectedWith(store: ReturnType<typeof fakeStore>) {
    const drive = await provision(store);
    await recordChosenLists(store, drive, [MY_TASKS]);
  }

  it('retries by itself when the wait is soon, then syncs', async () => {
    const store = fakeStore();
    await connectedWith(store);
    const { controller, states, timers, fire } = limited(store);
    const seconds = MAX_INLINE_WAIT_MS / 1000 + 20;
    store.limitNext = { count: 1, retryAfter: String(seconds) };
    await (
      await controller.load()
    ).syncing;
    expect(controller.state()).toMatchObject({
      kind: 'error',
      status: 429,
      rateLimited: { retryAt: NOW + seconds * 1000, retrying: true },
      tasks: [],
    });
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(seconds * 1000);
    // Nothing was imported: only the provisioning wrote.
    const provisioned = store.writes.length;

    await fire();
    expect(controller.state()).toMatchObject({ kind: 'synced' });
    expect(controller.state()).not.toHaveProperty('rateLimited');
    expect(states).toEqual(['syncing', 'error', 'syncing', 'synced']);
    expect(
      store.writes.slice(provisioned).filter(w => w.op === 'create'),
    ).toHaveLength(5);
  });

  it('stops, saying when to try again, for a long wait or after too many retries', async () => {
    const store = fakeStore();
    await connectedWith(store);
    const { controller, timers, fire } = limited(store);
    const far = new Date(NOW + MAX_AUTO_RETRY_MS + 1000).toUTCString();
    store.limitNext = { count: 1, retryAfter: far };
    await (
      await controller.load()
    ).syncing;
    expect(controller.state()).toMatchObject({
      kind: 'error',
      rateLimited: { retryAt: NOW + MAX_AUTO_RETRY_MS + 1000, retrying: false },
    });
    expect(timers).toHaveLength(0);

    // A rate limit with no Retry-After: the default wait, retried, at most
    // MAX_AUTO_RETRIES times in a row.
    for (let n = 0; n < MAX_AUTO_RETRIES; n++) {
      store.limitNext = { count: 1, status: n % 2 ? 403 : 429 };
      if (n === 0) await controller.sync();
      else await fire();
      expect(controller.state()).toMatchObject({
        kind: 'error',
        rateLimited: { retrying: true },
      });
      const paused = controller.state() as {
        rateLimited: { retryAt: number };
      };
      expect(
        paused.rateLimited.retryAt - DEFAULT_RETRY_MS,
      ).toBeGreaterThanOrEqual(NOW);
    }

    store.limitNext = { count: 1 };
    await fire();
    expect(controller.state()).toMatchObject({
      kind: 'error',
      rateLimited: { retrying: false },
    });
    expect(timers.filter(t => !t.cleared)).toHaveLength(MAX_AUTO_RETRIES);

    // "Sync now" starts afresh and succeeds.
    await controller.sync();
    expect(controller.state()).toMatchObject({ kind: 'synced' });
  });

  it('cancels a waiting retry when the person syncs now, and schedules none after dispose', async () => {
    const store = fakeStore();
    await connectedWith(store);
    const { controller, timers } = limited(store);
    store.limitNext = { count: 1, retryAfter: '30' };
    await (
      await controller.load()
    ).syncing;
    expect(timers).toHaveLength(1);
    await controller.sync();
    expect(timers[0].cleared).toBe(true);
    expect(controller.state()).toMatchObject({ kind: 'synced' });

    store.limitNext = { count: 1, retryAfter: '30' };
    await controller.sync();
    expect(timers).toHaveLength(2);
    controller.dispose();
    expect(timers[1].cleared).toBe(true);
  });

  it('schedules no retry when disposed while a sync is in flight, and none while syncing', async () => {
    const store = fakeStore();
    await connectedWith(store);
    const { controller, timers } = limited(store);
    await (
      await controller.load()
    ).syncing;
    store.limitNext = { count: 1, retryAfter: '30' };
    const inFlight = controller.sync();
    // A second request while busy is a no-op, never a second timer.
    await controller.sync();
    controller.dispose();
    await inFlight;
    expect(controller.state()).toMatchObject({
      kind: 'error',
      rateLimited: { retrying: false },
    });
    expect(timers).toHaveLength(0);
  });
});

describe('controller when loading fails', () => {
  it('shows a visible error state, keeping the rows imported earlier', async () => {
    const store = fakeStore();
    const states: string[] = [];
    const first = createController(store, () => undefined, {
      now: () => T1,
      clock: () => Date.parse(T1),
    });
    await (
      await first.load()
    ).syncing;
    await first.chooseLists([MY_TASKS]);

    store.proxy!.connections = async () => {
      throw new Error('host offline');
    };

    const controller = createController(store, s => states.push(s.kind), {
      now: () => T2,
      clock: () => Date.parse(T2),
    });
    expect(await controller.load()).toEqual({});
    const state = controller.state();
    expect(state).toMatchObject({
      kind: 'error',
      message: 'Could not load: host offline',
      at: Date.parse(T2),
      lastGood: T1,
      chosen: [MY_TASKS],
    });
    expect((state as { tasks: unknown[] }).tasks).toHaveLength(5);
    expect(states).toEqual(['error']);
  });
});
