// @wc-ignore-file
/**
 * 0.2.0's first open (#177 item 5): the app's own table and rows move onto
 * the shared `event-v1` class in place, an edit not sent yet survives the
 * move, the App renders `event-v1` and declares its row extras, and on a
 * table that isn't its own the app shows the rows, read only, and syncs
 * nothing.
 */
import { describe as suite, expect, it } from 'vitest';
import { PRIMARY } from '../fixtures/google-calendar/scenario.mjs';
import { adopt } from './adopt.js';
import { createController, describe, type ViewState } from './controller.js';
import {
  APP,
  APP_CLASS,
  fakeStore,
  field,
  ONTOLOGY,
  OTHER_TABLE,
  RENDERS,
  ROW_CLASS,
  ROW_EXTRAS_PROPERTY,
  TABLE,
} from './fakeStore.js';
import { EVENT, LEGACY_SHORTNAMES, SHARED, type SharedKey } from './fields.js';
import type { JSONValue } from './store.js';
import {
  CLASSTYPE,
  IS_A,
  NAME,
  PARENT,
  PROPERTIES,
  PROPERTY_CLASS,
  RECOMMENDS,
  SHORTNAME,
} from './sync.js';

type Store = ReturnType<typeof fakeStore>;

async function imported(store = fakeStore()) {
  const controller = createController(store, () => {});
  await controller.load();
  await controller.choose(PRIMARY);

  return store;
}

const rowsOf = (store: Store, table = TABLE) =>
  [...store.resources].filter(([, p]) => p[PARENT] === table);

/**
 * Puts the store back the way 0.1.4 left it: the fields as Properties of
 * the app's own ontology (shortnames `location`, `start`, `end`,
 * `atomic-calendar-*`), rows and table of the app's own class, `renders`
 * listing only that class, no `row-extras`.
 */
function asLeftBy014(store: Store): Record<SharedKey, string> {
  const ontology = store.resources.get(ONTOLOGY)!;
  const legacy = {} as Record<SharedKey, string>;

  for (const key of Object.keys(SHARED) as SharedKey[]) {
    legacy[key] = `did:ad:legacy-${key}`;
    store.resources.set(legacy[key], {
      [PARENT]: ONTOLOGY,
      [IS_A]: [PROPERTY_CLASS],
      [SHORTNAME]: LEGACY_SHORTNAMES[key],
    });
  }

  store.resources.set(ONTOLOGY, {
    ...ontology,
    [PROPERTIES]: [
      ...(ontology[PROPERTIES] as string[]),
      ...Object.values(legacy),
    ],
  });

  for (const [subject, props] of rowsOf(store)) {
    const old: Record<string, JSONValue> = { ...props, [IS_A]: [ROW_CLASS] };

    for (const key of Object.keys(SHARED) as SharedKey[])
      if (SHARED[key] in old) {
        old[legacy[key]] = old[SHARED[key]];
        delete old[SHARED[key]];
      }

    store.resources.set(subject, old);
  }

  store.resources.set(TABLE, {
    ...store.resources.get(TABLE)!,
    [CLASSTYPE]: ROW_CLASS,
  });
  const app = { ...store.resources.get(APP)!, [RENDERS]: [ROW_CLASS] };
  delete app[ROW_EXTRAS_PROPERTY];
  store.resources.set(APP, app);

  return legacy;
}

async function reopen(store: Store) {
  const states: ViewState[] = [];
  const controller = createController(store, s => states.push(s));
  const { refreshing } = await controller.load();
  await refreshing;

  return { controller, states, state: controller.state() };
}

suite('0.2.0 first open: onto event-v1 (#177)', () => {
  it('moves a 0.1.4 table and its rows in place, keeping an edit not sent yet', async () => {
    const store = await imported();
    const legacy = asLeftBy014(store);
    // Edited before the update, in 0.1.4's Location column; not sent.
    const timed = rowsOf(store).find(
      ([, p]) => p[field(store, 'google-event-id')] === 'timed',
    )![0];
    store.resources.set(timed, {
      ...store.resources.get(timed)!,
      [legacy.location]: 'Room 7',
    });

    const { state } = await reopen(store);

    expect(store.resources.get(TABLE)![CLASSTYPE]).toBe(EVENT);

    for (const [, props] of rowsOf(store)) {
      expect(props[IS_A]).toEqual([EVENT]);
      for (const old of Object.values(legacy))
        expect(props).not.toHaveProperty(old);
      expect(props[SHARED.day]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    expect(store.resources.get(timed)![SHARED.location]).toBe('Room 7');
    // The baseline is unchanged, so the edit is still a change to send.
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.summary.review).toEqual([
      expect.objectContaining({
        fields: [{ field: 'Location', before: 'Room 4', after: 'Room 7' }],
      }),
    ]);
    expect(store.google.writes).toEqual([]);
    // The old Properties and class stay in the app's ontology, unused.
    for (const old of Object.values(legacy))
      expect(store.resources.has(old)).toBe(true);
    expect(store.resources.get(ROW_CLASS)![RECOMMENDS]).toEqual([NAME]);
    expect(store.resources.get(APP)![RENDERS]).toEqual([ROW_CLASS, EVENT]);
  });

  it('does nothing more once done: no row is written on the next open', async () => {
    const store = await imported();
    const rows = new Set(rowsOf(store).map(([subject]) => subject));
    const before = store.writes.length;
    expect(await adopt(store)).toEqual({ own: true, migrated: 0 });
    expect(store.writes.slice(before).filter(w => rows.has(w.subject))).toEqual(
      [],
    );
    expect(store.writes.slice(before)).toEqual([]);
  });

  it('declares the row extras on the App, and skips that on a host without row-extras', async () => {
    const store = fakeStore();
    store.resources.set(APP_CLASS, { [RECOMMENDS]: [RENDERS] });
    expect(await adopt(store)).toEqual({ own: true, migrated: 0 });
    expect(store.resources.get(APP)![RENDERS]).toEqual([ROW_CLASS, EVENT]);
    expect(store.resources.get(APP)).not.toHaveProperty(ROW_EXTRAS_PROPERTY);
    expect(store.resources.get(TABLE)![CLASSTYPE]).toBe(EVENT);
  });
});

suite('on an event-v1 table that isn’t its own', () => {
  function withRows() {
    const store = fakeStore({ view: 'other' });
    store.resources.set('did:ad:hand-1', {
      [PARENT]: OTHER_TABLE,
      [IS_A]: [EVENT],
      [NAME]: 'Planning day',
      [SHARED.day]: '2026-09-24',
    });
    store.resources.set('did:ad:hand-2', {
      [PARENT]: OTHER_TABLE,
      [IS_A]: [EVENT],
      [NAME]: 'Stand-up',
      [SHARED.day]: '2026-09-24',
      [SHARED.start]: '2026-09-24T09:00:00+02:00',
      [SHARED.end]: '2026-09-24T09:15:00+02:00',
      [SHARED.location]: 'Room 1',
    });

    return store;
  }

  it('shows the rows from their shared fields, read only, and syncs nothing', async () => {
    const store = withRows();
    const controller = createController(store, () => {});
    await controller.load();
    const snap = controller.snapshot();
    expect(snap.state.kind).toBe('local');
    expect(describe(snap.state)).toContain('isn’t synced with Google Calendar');
    expect(snap.meta?.summary).toBe('Team events');
    expect(
      snap.events.map(e => ({
        title: e.title,
        start: e.start,
        location: e.location,
        day: e.day,
        readOnly: e.readOnly,
        pending: e.pending,
      })),
    ).toEqual([
      {
        title: 'Planning day',
        start: '',
        location: '',
        day: '2026-09-24',
        readOnly: true,
        pending: false,
      },
      {
        title: 'Stand-up',
        start: '2026-09-24T09:00:00+02:00',
        location: 'Room 1',
        day: '2026-09-24',
        readOnly: true,
        pending: false,
      },
    ]);
    await controller.refresh();
    expect(controller.state().kind).toBe('local');
    expect(store.calls).toEqual([]);
    // Neither the table nor its rows were written.
    expect(
      store.writes.filter(
        w => w.subject === OTHER_TABLE || w.subject.startsWith('did:ad:hand-'),
      ),
    ).toEqual([]);
  });
});
