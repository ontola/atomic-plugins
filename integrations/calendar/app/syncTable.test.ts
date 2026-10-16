// @wc-ignore-file
/**
 * "Sync this table to Google Calendar" (#177 §6.2 item 14) on an `event-v1`
 * table the app is a view of, not its own. The fake store enforces the
 * pinned host's row grant (atomic-server `app_row_grant.rs`): no row write
 * without "Allow editing", only the class's columns and the App's declared
 * `row-extras`, never the table, never a delete. The calendar choice lives
 * on a binding under the App.
 */
import { describe as suite, expect, it } from 'vitest';
import { PRIMARY } from '../fixtures/google-calendar/scenario.mjs';
import {
  createController,
  describe,
  PAUSED_NOTE,
  SYNC_NOTE,
} from './controller.js';
import { APP, fakeStore, field, OTHER_TABLE } from './fakeStore.js';
import { EVENT, SHARED } from './fields.js';
import { IS_A, NAME, PARENT } from './sync.js';

type Store = ReturnType<typeof fakeStore>;

const HAND = 'did:ad:hand-1';

/** An `event-v1` table someone made, with one row of their own. */
function teamTable(options: Parameters<typeof fakeStore>[0] = {}): Store {
  const store = fakeStore({ view: 'other', ...options });
  store.resources.set(HAND, {
    [PARENT]: OTHER_TABLE,
    [IS_A]: [EVENT],
    [NAME]: 'Planning day',
    [SHARED.day]: '2026-09-24',
  });

  return store;
}

const rowsOf = (store: Store) =>
  [...store.resources].filter(([, p]) => p[PARENT] === OTHER_TABLE);

/** Bindings under the App naming the table. */
const bindingsOf = (store: Store) =>
  [...store.resources].filter(
    ([, p]) =>
      p[PARENT] === APP && p[field(store, 'synced-table')] === OTHER_TABLE,
  );

async function synced(store = teamTable()) {
  const controller = createController(store, () => {});
  await controller.load();
  await controller.syncTable();
  await controller.choose(PRIMARY);

  return { store, controller };
}

suite('Sync this table to Google Calendar (#177 §6.2 item 14)', () => {
  it('offers it on a table that isn’t synced, and writes nothing before it is pressed', async () => {
    const store = teamTable();
    const controller = createController(store, () => {});
    await controller.load();
    const state = controller.state();
    expect(state).toEqual({ kind: 'local', canSync: true });
    expect(describe(state)).toContain(SYNC_NOTE);
    expect(store.asked).toBe(0);
    expect(store.calls).toEqual([]);
    expect(
      store.writes.filter(w => w.subject === OTHER_TABLE || w.subject === HAND),
    ).toEqual([]);
  });

  it('is not offered on a host without the row grant or the proxy relay', async () => {
    for (const store of [
      Object.assign(teamTable(), { requestRowAccess: undefined }),
      teamTable({ relay: false }),
    ]) {
      const controller = createController(store, () => {});
      await controller.load();
      expect(controller.state()).toEqual({ kind: 'local', canSync: false });
      await controller.syncTable();
      expect(controller.state().kind).toBe('local');
      expect(bindingsOf(store)).toEqual([]);
    }
  });

  it('asks for Allow editing with the row extras, binds the table under the App, and imports into it', async () => {
    const { store, controller } = await synced();
    expect(store.asked).toBe(1);
    // The grant covers the four extras the App declares.
    expect([...store.grant!.extras].sort()).toEqual(
      ['google-event-id', 'google-etag', 'google-link', 'sync-baseline']
        .map(s => field(store, s))
        .sort(),
    );
    // One binding, under the App, with the calendar; the table is untouched.
    const bindings = bindingsOf(store);
    expect(bindings).toHaveLength(1);
    expect(bindings[0][1][field(store, 'google-calendar-id')]).toBe(PRIMARY);
    expect(store.resources.get(OTHER_TABLE)![NAME]).toBe('Team events');
    expect(store.writes.filter(w => w.subject === OTHER_TABLE)).toEqual([]);
    expect(controller.state().kind).toBe('ready');
    // Google's three single events became rows of the table, with extras.
    const imported = rowsOf(store).filter(([s]) => s !== HAND);
    expect(imported).toHaveLength(3);

    for (const [, row] of imported) {
      expect(row[IS_A]).toEqual([EVENT]);
      expect(row[field(store, 'google-event-id')]).toEqual(expect.any(String));
      expect(row[field(store, 'sync-baseline')]).toEqual(expect.any(String));
    }

    // The row that was already there stays local only, untouched.
    expect(store.resources.get(HAND)).toEqual({
      [PARENT]: OTHER_TABLE,
      [IS_A]: [EVENT],
      [NAME]: 'Planning day',
      [SHARED.day]: '2026-09-24',
    });
    const snap = controller.snapshot();
    expect(snap.summary?.localOnly).toBe(1);
    expect(snap.own).toBe(false);
    expect(snap.events.find(e => e.subject === HAND)?.readOnly).toBe(true);
  });

  it('asks again when Add view’s grant came before the App declared its extras', async () => {
    const { store } = await synced(teamTable({ grant: 'columns' }));
    expect(store.asked).toBe(1);
    expect(store.grant!.extras).toHaveLength(4);
  });

  it('stays not synced, with the reason, when the person says Not now to the host', async () => {
    const store = teamTable({ answer: 'deny' });
    const controller = createController(store, () => {});
    await controller.load();
    await controller.syncTable();
    expect(controller.state()).toEqual({
      kind: 'local',
      canSync: true,
      reason: 'Not synced: The person said no.',
    });
    expect(bindingsOf(store)).toEqual([]);
    expect(store.calls).toEqual([]);
  });

  it('sends an edit made in the table after review, with If-Match, and moves the row’s baseline', async () => {
    const { store, controller } = await synced();
    const [subject, row] = rowsOf(store).find(
      ([, p]) => p[NAME] === 'Calendar timed fixture',
    )!;
    // The person edits the row in the host's table: their own commit.
    store.resources.set(subject, { ...row, [NAME]: 'Renamed in the table' });
    await controller.refresh();
    const review = controller.snapshot().summary!.review;
    expect(review.map(r => r.fields)).toEqual([
      [
        {
          field: 'Title',
          before: 'Calendar timed fixture',
          after: 'Renamed in the table',
        },
      ],
    ]);
    expect(store.google.writes).toEqual([]);
    await controller.send();
    expect(store.google.writes).toEqual([
      expect.objectContaining({
        id: 'timed',
        patch: { summary: 'Renamed in the table' },
      }),
    ]);
    expect(store.calls.find(c => c.method === 'PATCH')?.ifMatch).toMatch(
      /^"v\d+"$/,
    );
    const baseline = JSON.parse(
      store.resources.get(subject)![field(store, 'sync-baseline')] as string,
    );
    expect(baseline.title).toBe('Renamed in the table');
  });

  it('opens straight into the sync next time, without asking again', async () => {
    const { store } = await synced();
    const again = createController(store, () => {});
    const { refreshing } = await again.load();
    await refreshing;
    expect(again.state().kind).toBe('ready');
    expect(again.snapshot().meta?.summary).toBe('Synthetic');
    expect(store.asked).toBe(1);
  });

  it('pauses, without a request to Google, once the grant is taken back', async () => {
    const { store, controller } = await synced();
    store.revokeGrant();
    const calls = store.calls.length;
    await controller.refresh();
    expect(controller.state()).toEqual({
      kind: 'local',
      canSync: true,
      reason: PAUSED_NOTE,
    });
    const reopened = createController(store, () => {});
    await reopened.load();
    expect(reopened.state()).toMatchObject({
      kind: 'local',
      reason: PAUSED_NOTE,
    });
    expect(store.calls.length).toBe(calls);
    // Allowing editing again goes on with the same calendar.
    await reopened.syncTable();
    expect(store.asked).toBe(2);
    expect(bindingsOf(store)).toHaveLength(1);
    expect(reopened.snapshot().meta?.summary).toBe('Synthetic');
  });

  it('Not now before a calendar is chosen goes back to not synced', async () => {
    const store = teamTable();
    const controller = createController(store, () => {});
    await controller.load();
    await controller.syncTable();
    expect(controller.state().kind).toBe('choosing');
    expect(bindingsOf(store)).toHaveLength(1);
    await controller.notNow();
    expect(controller.state()).toEqual({ kind: 'local', canSync: true });
    expect(bindingsOf(store)).toEqual([]);
  });

  it('never deletes a row of the table: Remove local copy does nothing there', async () => {
    const { store, controller } = await synced();
    store.google.cancel('timed');
    await controller.refresh();
    const conflict = controller
      .snapshot()
      .summary!.conflicts.find(c => c.kind === 'missing-remote')!;
    expect(conflict).toBeDefined();
    await controller.removeLocal(conflict);
    expect(store.resources.has(conflict.subject!)).toBe(true);
    // Keep as local event only takes the extras off the row: allowed.
    await controller.keepAsLocal(conflict);
    expect(
      store.resources.get(conflict.subject!)![field(store, 'google-event-id')],
    ).toBeUndefined();
  });
});
