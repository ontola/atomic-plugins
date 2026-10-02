// @wc-ignore-file
/**
 * "Sync this table to Clockify" (#177 §6.2 item 14) on a `time-entry-v1`
 * table the app didn't make, through the in-memory store, which refuses
 * what the pinned host's row grant refuses (`fakeStore.ts`): no write to
 * that table or its rows without "Allow editing", only the class's fields
 * and the extras the grant covers, never the table, never `destroy`.
 */
import { describe, expect, it } from 'vitest';
import { USER, WORKSPACE } from '../fixtures/clockify/scenario.mjs';
import { ROW_EXTRAS } from './adopt.js';
import { hasRowAccess } from './binding.js';
import {
  createController,
  describe as describeState,
  type Controller,
} from './controller.js';
import {
  APP,
  fakeStore,
  IS_A,
  OTHER_TABLE,
  PARENT,
  ROW_EXTRAS_PROPERTY,
  TABLE,
  type FakeStore,
} from './fakeStore.js';
import { SHARED, TIME_ENTRY } from './fields.js';
import { fixtureProxy } from './fixtureProxy.js';
import { NAME } from './ontology.js';
import { findSchema, type CompleteSchema } from './schema.js';
import { ROW_KEPT } from './writeBack.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const HOUR = 3_600_000;
/** A row the person made in the table before syncing it. */
const MINE = 'did:ad:drive/team-hours/mine';

function setUp(options: Parameters<typeof fakeStore>[0] = {}) {
  const proxy = fixtureProxy(NOW);
  const store = fakeStore({ proxy: proxy.request, view: 'other', ...options });
  store.resources.set(MINE, {
    [PARENT]: OTHER_TABLE,
    [IS_A]: [TIME_ENTRY],
    [NAME]: 'Pairing on the parser',
    [SHARED.start]: NOW - 2 * 86_400_000,
    [SHARED.end]: NOW - 2 * 86_400_000 + HOUR,
  });
  const clock = { at: NOW };
  const controller = createController(
    store,
    () => {},
    () => clock.at,
  );

  return { proxy, store, controller, clock };
}

/** The table's rows that carry a Clockify entry id, by entry id. */
async function synced(store: FakeStore) {
  const schema = (await findSchema(store)) as CompleteSchema;
  const rows = new Map<string, Record<string, unknown>>();

  for (const [subject, props] of store.resources)
    if (props[PARENT] === OTHER_TABLE && props[schema.row.entryId])
      rows.set(String(props[schema.row.entryId]), { subject, ...props });

  return { schema, rows };
}

/** Through "Sync this table", Allow editing, the setup form and a first sync. */
async function syncedTable(options: Parameters<typeof fakeStore>[0] = {}) {
  const t = setUp(options);
  await t.controller.load();
  await t.controller.syncTable();
  await t.controller.saveSettings({
    workspaceId: WORKSPACE.id,
    lookbackDays: 7,
  });

  return t;
}

const ready = (controller: Controller) => {
  const state = controller.state();
  if (state.kind !== 'ready') throw new Error(`state is ${state.kind}`);

  return state;
};

describe('Sync this table to Clockify (#177 item 14)', () => {
  it('offers it on a table that is not synced, and writes nothing before it is pressed', async () => {
    const { proxy, store, controller } = setUp();
    const table = structuredClone(store.resources.get(OTHER_TABLE));

    await controller.load();

    expect(controller.state()).toEqual({
      kind: 'local',
      tableName: 'Team hours',
      canSync: true,
    });
    expect(describeState(controller.state())).toMatch(
      /Sync it to keep it and one Clockify workspace in step/,
    );
    // The first open declared the row extras, in the app's own subtree.
    const schema = (await findSchema(store)) as CompleteSchema;
    expect(store.resources.get(APP)![ROW_EXTRAS_PROPERTY]).toEqual(
      ROW_EXTRAS.map(key =>
        key === 'entryId' ? schema.row.entryId : schema.sync[key],
      ),
    );
    expect(store.resources.get(OTHER_TABLE)).toEqual(table);
    expect(store.asked).toBe(0);
    expect(proxy.seen).toEqual([]);
    expect(controller.syncedTable()).toBeUndefined();
  });

  it('is not offered when the host cannot ask for Allow editing', async () => {
    const { controller } = setUp({ rowGrants: false });

    await controller.load();

    expect(controller.state()).toMatchObject({ kind: 'local', canSync: false });
  });

  it('stays not synced when the person answers Not now in the host bar', async () => {
    const { store, controller } = setUp();
    await controller.load();
    store.answerWith('deny');

    await controller.syncTable();

    expect(store.asked).toBe(1);
    expect(controller.state()).toEqual({
      kind: 'local',
      tableName: 'Team hours',
      canSync: true,
      reason: 'Not synced: You said not now.',
    });
    expect((await findSchema(store)).home).toBeUndefined();
  });

  it('asks again when a grant from Add view does not cover the row extras, binds under the App, then syncs rows into that table', async () => {
    const t = setUp({ grant: 'columns' });
    const table = structuredClone(t.store.resources.get(OTHER_TABLE));
    const mine = structuredClone(t.store.resources.get(MINE));
    await t.controller.load();
    expect(await hasRowAccess(t.store)).toBe(false);

    await t.controller.syncTable();

    // The host's bar asked; the new grant covers what the App declares.
    expect(t.store.asked).toBe(1);
    expect(await hasRowAccess(t.store)).toBe(true);
    const schema = (await findSchema(t.store)) as CompleteSchema;
    const binding = t.store.resources.get(schema.home)!;
    expect(binding[PARENT]).toBe(APP);
    expect(binding[schema.settings.syncedTable]).toBe(OTHER_TABLE);
    expect(binding[NAME]).toBe('Clockify sync of Team hours');
    expect(t.controller.state().kind).toBe('setup');
    expect(t.controller.syncedTable()).toEqual({
      name: 'Team hours',
      canUndo: true,
    });

    const done = await t.controller.saveSettings({
      workspaceId: WORKSPACE.id,
      lookbackDays: 7,
    });

    expect(describeState(done)).toMatch(/2 created, 0 updated, 0 unchanged/);
    // The settings and the log are the binding's; the App's are untouched.
    const after = t.store.resources.get(schema.home)!;
    expect(after[schema.settings.workspaceId]).toBe(WORKSPACE.id);
    expect(after[schema.settings.userId]).toBe(USER.id);
    expect(after[schema.settings.lookbackDays]).toBe(7);
    const head = after[schema.log.log] as string;
    expect(t.store.resources.get(head)![PARENT]).toBe(schema.home);
    const app = t.store.resources.get(APP)!;
    expect(app[schema.settings.workspaceId]).toBeUndefined();
    expect(app[schema.log.log]).toBeUndefined();

    // Clockify's entries are rows of that table, of exactly its class,
    // with the app's extras; the person's row and the table are as they were.
    const { rows } = await synced(t.store);
    expect([...rows.keys()].sort()).toEqual(['entry-1', 'entry-2']);

    for (const row of rows.values()) {
      expect(row[IS_A]).toEqual([TIME_ENTRY]);
      expect(row[schema.sync.baseline]).toEqual(expect.any(String));
    }

    expect(t.store.resources.get(MINE)).toEqual(mine);
    expect(t.store.resources.get(OTHER_TABLE)).toEqual(table);
    // Nothing went to the app's own table.
    expect(
      [...t.store.resources.values()].filter(r => r[PARENT] === TABLE),
    ).toEqual([]);
    // The timesheet comes from that table's log now.
    expect(
      t.controller
        .sheet()!
        .entries.map(e => e.id)
        .sort(),
    ).toContain('entry-1');
    expect(t.controller.syncedTable()).toEqual({
      name: 'Team hours',
      canUndo: false,
    });
  });

  it('finds the binding again on the next open and syncs without asking', async () => {
    const t = await syncedTable();
    const again = createController(
      t.store,
      () => {},
      () => NOW,
    );

    const { syncing } = await again.load();
    await syncing;

    expect(t.store.asked).toBe(1);
    expect(describeState(again.state())).toMatch(
      /0 created, 0 updated, 2 unchanged/,
    );
  });

  it('lists an edit made in the table and sends it only from the review', async () => {
    const t = await syncedTable();
    const { rows } = await synced(t.store);
    const row = rows.get('entry-2')!;
    // The person renames the entry in the table, as a plain table edit.
    t.store.resources.set(String(row.subject), {
      ...t.store.resources.get(String(row.subject))!,
      [NAME]: 'Weekly sync (team hours)',
    });

    await t.controller.sync();

    expect(t.controller.changes().review).toMatchObject([
      { entryId: 'entry-2', fields: ['name'], blockers: [] },
    ]);
    expect(t.proxy.fixture.state.writes).toEqual([]);

    await t.controller.send();

    expect(t.controller.changes().outcomes?.results).toMatchObject([
      { entryId: 'entry-2', status: 'sent' },
    ]);
    expect(t.proxy.fixture.state.writes).toMatchObject([
      {
        method: 'PUT',
        body: expect.objectContaining({
          description: 'Weekly sync (team hours)',
        }),
      },
    ]);
  });

  it('keeps a row whose entry Clockify deleted, without the app’s extras, and says to delete it there', async () => {
    const t = await syncedTable();
    const { schema, rows } = await synced(t.store);
    const subject = String(rows.get('entry-1')!.subject);
    t.proxy.fixture.control({ action: 'delete', id: 'entry-1' });

    // The first pass sees it missing; the next confirms the deletion.
    t.clock.at += 60_000;
    await t.controller.sync();
    t.clock.at += 60_000;
    await t.controller.sync();

    const state = ready(t.controller);
    expect(state.last).toMatchObject({ ok: true, result: { kept: 1 } });
    expect(describeState(state)).toMatch(
      /1 deleted in Clockify: kept in this table as rows of their own.*Delete them there\./,
    );
    const row = t.store.resources.get(subject)!;
    expect(row[NAME]).toBe('Fix plugin source loading');
    for (const extra of [schema.row.entryId, ...Object.values(schema.sync)])
      expect(row).not.toHaveProperty(extra);
    expect((await synced(t.store)).rows.has('entry-1')).toBe(false);
  });

  it('sends a delete asked for here, and keeps the row as the person’s', async () => {
    const t = await syncedTable();
    const { rows } = await synced(t.store);
    const subject = String(rows.get('entry-2')!.subject);

    await t.controller.deleteEntry('entry-2');
    await t.controller.send();

    expect(t.controller.changes().outcomes?.results).toMatchObject([
      { entryId: 'entry-2', status: 'sent', message: ROW_KEPT },
    ]);
    expect(t.proxy.fixture.state.writes).toMatchObject([{ method: 'DELETE' }]);
    expect(t.store.resources.has(subject)).toBe(true);
    expect(t.controller.changes().review).toEqual([]);
  });

  it('stages a range edit’s new entry as a row of that table, and Discard leaves it as the person’s', async () => {
    const t = await syncedTable();
    const from = NOW - 3 * 86_400_000;

    expect(
      await t.controller.editRange({
        from,
        to: from + HOUR,
        target: { kind: 'worked', projectId: null },
      }),
    ).toBe(true);

    const [change] = t.controller.changes().review;
    expect(change).toMatchObject({ kind: 'create' });
    const row = t.store.resources.get(change!.subject)!;
    expect(row[PARENT]).toBe(OTHER_TABLE);
    expect(row[IS_A]).toEqual([TIME_ENTRY]);

    await t.controller.discard(change!.entryId);

    expect(t.controller.changes()).toMatchObject({
      review: [],
      error: `Not sent. ${ROW_KEPT}`,
    });
    const kept = t.store.resources.get(change!.subject)!;
    expect(kept[SHARED.start]).toBe(from);
    const schema = (await findSchema(t.store)) as CompleteSchema;
    expect(kept).not.toHaveProperty(schema.sync.create);
    expect(t.proxy.fixture.state.writes).toEqual([]);
  });

  it('pauses when the grant is taken back, and goes on once editing is allowed again', async () => {
    const t = await syncedTable();
    t.store.revokeGrant();
    const before = t.proxy.seen.length;

    await t.controller.sync();

    expect(t.controller.state()).toMatchObject({ kind: 'local', paused: true });
    expect(describeState(t.controller.state())).toMatch(/paused/);
    expect(t.proxy.seen.length).toBe(before);

    // A reload is paused too, until the person allows editing again.
    const again = createController(
      t.store,
      () => {},
      () => NOW,
    );
    await again.load();
    expect(again.state()).toMatchObject({ kind: 'local', paused: true });

    await again.syncTable();

    expect(t.store.asked).toBe(2);
    expect(['ready', 'syncing']).toContain(again.state().kind);
  });

  it('Not now before a workspace is chosen drops the empty binding', async () => {
    const t = setUp();
    await t.controller.load();
    await t.controller.syncTable();
    expect(t.controller.state().kind).toBe('setup');

    await t.controller.notNow();

    expect((await findSchema(t.store)).home).toBeUndefined();
    expect(t.controller.state()).toMatchObject({
      kind: 'local',
      canSync: true,
    });
    // The grant stays; the host's tab menu takes it back.
    expect(t.store.grant).toBeDefined();
  });

  it('on the app’s own table nothing changes: no binding, no grant asked', async () => {
    const proxy = fixtureProxy(NOW);
    const store = fakeStore({ proxy: proxy.request });
    const controller = createController(
      store,
      () => {},
      () => NOW,
    );

    await controller.load();

    expect(controller.state().kind).toBe('setup');
    expect(controller.syncedTable()).toBeUndefined();
    expect((await findSchema(store)).home).toBe(APP);
    expect(store.asked).toBe(0);
  });
});
