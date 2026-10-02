// @wc-ignore-file
/**
 * The import pass against the in-memory store and the synthetic Todoist
 * fixture: provisioning as a view of issue-v1, the first import, a refresh
 * that writes no row, and #99's disappearance behaviour (completed, deleted,
 * unavailable, unconfirmed, partial read, reappearance) as the host runs it.
 */
import { describe, expect, it } from 'vitest';
import { createController, describeSummary } from './controller.js';
import {
  CLASSTYPE,
  ISSUE_V1,
  NAME,
  OtherTable,
  PROPERTIES,
  provision,
  SHORTNAME,
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
import { TodoistError } from './read.js';
import { relayGet, syncTasks } from './sync.js';

const T1 = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-01T11:00:00.000Z';
const T3 = '2026-03-01T12:00:00.000Z';
const T4 = '2026-03-01T13:00:00.000Z';

async function setUp() {
  const store = fakeStore();
  const drive = await provision(store);
  const get = relayGet(store.proxy!, {
    platform: 'todoist',
    connectionId: 'c1',
  });
  const sync = (now: string, read?: { maxPages?: number }) =>
    syncTasks(store, get, drive, { now: () => now, read });

  const rowOf = (taskId: string) => {
    for (const [subject, props] of store.resources)
      if (props[drive.properties.taskId] === taskId)
        return { subject, ...props };

    throw new Error(`no row for ${taskId}`);
  };

  const p = drive.properties;

  return { store, drive, sync, rowOf, p };
}

describe('provisioning', () => {
  it('makes the app a view of issue-v1 and adds its extras, once', async () => {
    const { store, drive, p } = await setUp();
    const app = store.resources.get(APP)!;
    expect(app[RENDERS]).toContain(ISSUE_V1);
    expect(app[ROW_EXTRAS]).toEqual([
      p.taskId,
      p.presence,
      p.lastSeen,
      p.priority,
      p.project,
      p.source,
    ]);
    const table = store.resources.get(TABLE)!;
    expect(table[CLASSTYPE]).toBe(ISSUE_V1);
    expect(table[NAME]).toBe(TABLE_NAME);
    expect(drive.rowClass).toBe(ISSUE_V1);
    const listed = store.resources.get(ONTOLOGY)![PROPERTIES] as string[];
    expect(listed).toHaveLength(7);
    expect(listed.map(s => store.resources.get(s)![SHORTNAME])).toContain(
      'todoist-task-id',
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

describe('import', () => {
  it('writes every active task as an issue-v1 row with shared fields and extras', async () => {
    const { store, sync, rowOf, p } = await setUp();
    const summary = await sync(T1);
    expect(summary).toMatchObject({
      total: 5,
      added: 5,
      updated: 0,
      unchanged: 0,
      checked: 0,
      complete: true,
      presence: { active: 5, completed: 0 },
    });
    expect(describeSummary(summary)).toBe(
      '5 tasks (5 added, 0 updated, 0 unchanged); 5 active.',
    );

    const plants = rowOf('synthetic-task-1');
    expect(plants).toMatchObject({
      [NAME]: 'Water the synthetic plants',
      [TASK_STATUS]: [TAG_TODO],
      [TASK_DUE_DATE]: '2026-03-02',
      [p.presence]: 'active',
      [p.priority]: 'Urgent',
      [p.project]: 'Inbox',
    });
    expect(plants).not.toHaveProperty(TASK_BODY);
    expect(plants).not.toHaveProperty(p.lastSeen);
    const source = JSON.parse(plants[p.source] as string);
    expect(source).toMatchObject({
      id: 'synthetic-task-1',
      checked: false,
      done: false,
      presence: 'active',
      'due-day': '2026-03-02',
    });
    expect(source).not.toHaveProperty('last-seen');

    const plumber = rowOf('synthetic-task-2');
    expect(plumber).toMatchObject({
      [TASK_BODY]: 'Ask about the imaginary leak under the sink.',
      // The day of due.datetime.
      [TASK_DUE_DATE]: '2026-03-03',
      [p.priority]: 'High',
    });
    expect(rowOf('synthetic-task-3')).toMatchObject({
      [p.project]: 'Synthetic house',
      [p.priority]: 'Medium',
    });
    expect(rowOf('synthetic-task-5')).not.toHaveProperty(TASK_DUE_DATE);

    // The read's time is on the App, not on the rows.
    expect(store.resources.get(APP)![p.lastSync]).toBe(T1);
  });

  it('refreshes without writing any row when nothing changed', async () => {
    const { store, sync } = await setUp();
    await sync(T1);
    const rows = new Map(
      [...store.resources].filter(([, props]) => props[TASK_STATUS]),
    );
    const before = store.writes.length;

    expect(await sync(T2)).toMatchObject({
      added: 0,
      updated: 0,
      unchanged: 5,
    });
    const since = store.writes.slice(before);
    expect(since.map(w => w.subject)).toEqual([APP]);
    for (const [subject, props] of rows)
      expect(store.resources.get(subject)).toEqual(props);
  });

  it('leaves a hand-made row alone', async () => {
    const { store, sync } = await setUp();
    const local = await store.newResource({
      parent: TABLE,
      isA: [ISSUE_V1],
      propVals: { [NAME]: 'Written in the table' },
    });
    expect(await sync(T1)).toMatchObject({ total: 5, added: 5 });
    expect(store.resources.get(local.subject)).toEqual({
      ...local.props,
    });
  });

  it('writes nothing when a page fails, and names a revoked connection', async () => {
    const { store, sync } = await setUp();
    store.todoist.failNext(1, 503, 'list');
    const before = store.writes.length;
    await expect(sync(T1)).rejects.toThrow('Todoist answered 503');
    expect(store.writes.length).toBe(before);

    store.todoist.failNext(1, 401, 'list');
    await expect(sync(T1)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof TodoistError && /reconnect Todoist/.test(e.message),
    );
  });
});

describe('a task that stops appearing (#99)', () => {
  it('is looked up by id once and closed only when Todoist says completed', async () => {
    const { store, sync, rowOf, p } = await setUp();
    await sync(T1);
    store.todoist.completeTask('synthetic-task-1');
    const calls = store.calls.length;

    const summary = await sync(T2);
    expect(summary).toMatchObject({
      updated: 1,
      unchanged: 4,
      checked: 1,
      presence: { active: 4, completed: 1 },
    });
    expect(describeSummary(summary)).toContain('4 active, 1 completed');
    expect(
      store.calls.slice(calls).filter(c => /\/tasks\/[^?]/.test(c.path)),
    ).toEqual([
      expect.objectContaining({ path: '/api/v1/tasks/synthetic-task-1' }),
    ]);
    expect(rowOf('synthetic-task-1')).toMatchObject({
      [TASK_STATUS]: [TAG_DONE],
      [p.presence]: 'completed',
      [p.lastSeen]: T2,
      // Its other columns stay as the task was last returned.
      [NAME]: 'Water the synthetic plants',
      [TASK_DUE_DATE]: '2026-03-02',
    });

    // Settled: not checked again, and unchanged on the next pass.
    const again = await sync(T3);
    expect(again).toMatchObject({ checked: 0, updated: 0, unchanged: 5 });
  });

  it('marks deleted and unavailable without closing, keeping last values and when they were seen', async () => {
    const { store, sync, rowOf, p } = await setUp();
    await sync(T1);
    store.todoist.deleteTask('synthetic-task-2');
    store.todoist.removeTask('synthetic-task-3');

    expect(await sync(T2)).toMatchObject({
      updated: 2,
      checked: 2,
      presence: { active: 3, deleted: 1, unavailable: 1 },
    });
    expect(rowOf('synthetic-task-2')).toMatchObject({
      [TASK_STATUS]: [TAG_TODO],
      [TASK_BODY]: 'Ask about the imaginary leak under the sink.',
      [p.presence]: 'deleted',
      // Last returned by the complete read at T1, not by this pass.
      [p.lastSeen]: T1,
    });
    expect(rowOf('synthetic-task-3')).toMatchObject({
      [TASK_STATUS]: [TAG_TODO],
      [p.presence]: 'unavailable',
      [p.lastSeen]: T1,
    });
    // Nothing is removed.
    expect([...store.resources.values()].filter(r => r[p.taskId]).length).toBe(
      5,
    );

    // Settled presences are not checked again.
    expect(await sync(T3)).toMatchObject({ checked: 0, updated: 0 });
  });

  it('is unconfirmed when the check fails, and checked again next time', async () => {
    const { store, sync, rowOf, p } = await setUp();
    await sync(T1);
    store.todoist.completeTask('synthetic-task-4');
    store.todoist.failNext(1, 503, 'lookup');

    expect(await sync(T2)).toMatchObject({
      checked: 1,
      presence: { active: 4, unconfirmed: 1 },
    });
    expect(rowOf('synthetic-task-4')).toMatchObject({
      [TASK_STATUS]: [TAG_TODO],
      [p.presence]: 'unconfirmed',
      [p.lastSeen]: T1,
      [TASK_DUE_DATE]: '2026-03-20',
    });

    expect(await sync(T3)).toMatchObject({
      checked: 1,
      presence: { active: 4, completed: 1 },
    });
    expect(rowOf('synthetic-task-4')).toMatchObject({
      [TASK_STATUS]: [TAG_DONE],
      [p.presence]: 'completed',
      [p.lastSeen]: T3,
    });
  });

  it('draws nothing from a partial read', async () => {
    const { store, sync, rowOf, p } = await setUp();
    await sync(T1);
    store.todoist.completeTask('synthetic-task-1');
    const calls = store.calls.length;

    // Three tasks per fixture page: one page is a partial read.
    const summary = await sync(T2, { maxPages: 1 });
    expect(summary).toMatchObject({
      complete: false,
      checked: 0,
      updated: 0,
      presence: { active: 5 },
    });
    expect(describeSummary(summary)).toContain('The read was partial');
    expect(
      store.calls.slice(calls).some(c => /\/tasks\/[^?]/.test(c.path)),
    ).toBe(false);
    expect(rowOf('synthetic-task-1')).toMatchObject({
      [TASK_STATUS]: [TAG_TODO],
      [p.presence]: 'active',
    });
    // The App's last complete read stays T1.
    expect(store.resources.get(APP)![p.lastSync]).toBe(T1);

    expect(await sync(T3)).toMatchObject({
      checked: 1,
      presence: { active: 4, completed: 1 },
    });
  });

  it('is active again when it reappears', async () => {
    const { store, sync, rowOf, p } = await setUp();
    await sync(T1);
    store.todoist.completeTask('synthetic-task-1');
    await sync(T2);
    store.todoist.reopenTask('synthetic-task-1');

    expect(await sync(T3)).toMatchObject({
      reappeared: 1,
      updated: 1,
      presence: { active: 5, completed: 0 },
    });
    const row = rowOf('synthetic-task-1');
    expect(row).toMatchObject({
      [TASK_STATUS]: [TAG_TODO],
      [p.presence]: 'active',
    });
    expect(row).not.toHaveProperty(p.lastSeen);
    expect(await sync(T4)).toMatchObject({ updated: 0, unchanged: 5 });
  });
});

describe('controller', () => {
  const states: string[] = [];
  const track = (store: ReturnType<typeof fakeStore>) =>
    createController(store, s => states.push(s.kind), { now: () => T1 });

  it('syncs on load with a connection and lists the table', async () => {
    states.length = 0;
    const store = fakeStore();
    const controller = track(store);
    const { syncing } = await controller.load();
    await syncing;
    const state = controller.state();
    expect(state.kind).toBe('synced');
    if (state.kind !== 'synced') return;
    expect(state.summary.added).toBe(5);
    expect(state.tasks.map(t => t.name)).toEqual([
      'Call the invented plumber',
      'Paint the fictional fence',
      'Return the made-up library books',
      'Sort the pretend attic',
      'Water the synthetic plants',
    ]);
    expect(state.tasks[0]).toMatchObject({
      taskId: 'synthetic-task-2',
      done: false,
      presence: 'active',
      dueDay: '2026-03-03',
      priority: 'High',
      project: 'Inbox',
    });
    expect(states).toEqual(['syncing', 'synced']);
  });

  it('lists a hand-made row, and one missing its Name as incomplete, without writing either (#177)', async () => {
    const store = fakeStore();
    const controller = track(store);
    await (
      await controller.load()
    ).syncing;
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
    // Sorted by name: the nameless row first, the hand-made one by its name.
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
    expect(state.tasks.filter(t => t.incomplete)).toHaveLength(1);
    // Neither row was written by the pass.
    expect(store.writes.slice(before).map(w => w.subject)).not.toContain(
      named.subject,
    );
    expect(store.writes.slice(before).map(w => w.subject)).not.toContain(
      nameless.subject,
    );
  });

  it('is disconnected without a connection, and syncs after an existing one is picked', async () => {
    const store = fakeStore({ connected: false, existing: true });
    const controller = track(store);
    await controller.load();
    expect(controller.state().kind).toBe('disconnected');
    await controller.connect();
    expect(controller.state().kind).toBe('synced');
  });

  it('reports another table and a host without the proxy client', async () => {
    const other = track(fakeStore({ table: OTHER_TABLE }));
    await other.load();
    expect(other.state().kind).toBe('other-table');

    const bare = track(fakeStore({ relay: false }));
    await bare.load();
    expect(bare.state().kind).toBe('no-relay');
  });

  it('keeps the imported rows when a refresh fails', async () => {
    const store = fakeStore();
    const controller = track(store);
    await (
      await controller.load()
    ).syncing;
    store.fail = 'host offline';
    await controller.sync();
    const state = controller.state();
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.message).toContain('host offline');
    expect(state.tasks).toHaveLength(5);
  });
});
