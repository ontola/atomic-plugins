// @wc-ignore-file
import { describe as suite, expect, it } from 'vitest';
import { PRIMARY, TEAM } from '../fixtures/google-calendar/scenario.mjs';
import { createController, describe, type ViewState } from './controller.js';
import {
  APP,
  DAY,
  fakeStore,
  field,
  RENDERS,
  ROW_CLASS,
  ROW_EXTRAS_PROPERTY,
  TABLE,
} from './fakeStore.js';
import { EVENT, SHARED } from './fields.js';
import { listCalendars } from './relay.js';
import {
  ALL_DAY,
  CLASSTYPE,
  DAY as DAY_FIELD,
  DESCRIPTION,
  END_DAY,
  IS_A,
  NAME,
  NOTES,
  PARENT,
  RECOMMENDS,
} from './sync.js';

type Store = ReturnType<typeof fakeStore>;

/** A row field's subject by shortname: shared, or the app's own extra. */
function prop(store: Store, shortname: string): string {
  return field(store, shortname);
}

/** Rows by Google event id, as plain field maps. */
function rows(store: Store) {
  const id = prop(store, 'google-event-id');
  const out = new Map<string, Record<string, unknown>>();

  for (const [subject, props] of store.resources)
    if (props[PARENT] === TABLE && typeof props[id] === 'string')
      out.set(props[id] as string, {
        subject,
        title: props[NAME],
        description: props[prop(store, NOTES)],
        location: props[prop(store, 'location')],
        start: props[prop(store, 'start')],
        end: props[prop(store, 'end')],
        allDay: props[prop(store, ALL_DAY)],
        day: props[prop(store, DAY_FIELD)],
        endDay: props[prop(store, END_DAY)],
        etag: props[prop(store, 'google-etag')],
      });

  return out;
}

/** Edits a row the way the host table would. */
function editRow(
  store: Store,
  eventId: string,
  fields: Record<string, unknown>,
) {
  const subject = rows(store).get(eventId)!.subject as string;
  store.resources.set(subject, { ...store.resources.get(subject)!, ...fields });
}

async function imported(store = fakeStore(), maxPages?: number) {
  const states: ViewState[] = [];
  const controller = createController(
    store,
    s => states.push(s),
    maxPages ? { maxPages } : {},
  );
  await controller.load();
  expect(controller.state().kind).toBe('choosing');
  await controller.choose(PRIMARY);

  return { store, controller, states };
}

const ready = (state: ViewState) => {
  if (state.kind !== 'ready') throw new Error(describe(state));

  return state;
};

suite('Calendar drive app: supported path', () => {
  it('without the relay or a connection, fetches nothing', async () => {
    for (const [options, kind] of [
      [{ relay: false }, 'no-relay'],
      [{ connected: false }, 'disconnected'],
    ] as const) {
      const store = fakeStore(options);
      const controller = createController(store, () => {});
      await controller.load();
      expect(controller.state().kind).toBe(kind);
      expect(store.calls).toEqual([]);
    }
  });

  it('lists calendars through the relay, never naming a credential', async () => {
    const store = fakeStore();
    expect(await listCalendars(store.proxy!, 'c1')).toEqual([
      {
        id: PRIMARY,
        summary: 'Synthetic',
        primary: true,
        accessRole: 'owner',
        backgroundColor: '#9fe1e7',
      },
      {
        id: TEAM,
        summary: 'Team',
        primary: false,
        accessRole: 'reader',
        backgroundColor: '#f691b2',
      },
    ]);
    expect(store.calls).toEqual([
      {
        platform: 'google-calendar',
        connectionId: 'c1',
        path: '/calendar/v3/users/me/calendarList',
        method: 'GET',
        query: { maxResults: '250' },
      },
    ]);
  });

  it('imports all-day and timed events of the chosen calendar only, skipping recurring and cancelled', async () => {
    const { store, controller } = await imported();
    const state = ready(controller.state());
    expect(state.summary).toMatchObject({
      calendarId: PRIMARY,
      total: 3,
      added: 3,
      updated: 0,
      unchanged: 0,
      skipped: { recurring: 2, cancelled: 1, unreadable: 0 },
      conflicts: [],
      review: [],
    });
    expect(describe(state)).toContain(
      'Not imported: 2 recurring, 1 cancelled.',
    );

    const byId = rows(store);
    expect([...byId.keys()].sort()).toEqual(['all-day', 'timed', 'trip']);
    expect(byId.get('all-day')).toMatchObject({
      title: 'Calendar all-day fixture',
      description: '',
      location: '',
      start: DAY,
      end: '2026-09-25',
      allDay: true,
      day: DAY,
      // The host Calendar view's end: exclusive, as Google has it.
      endDay: '2026-09-25',
    });
    // Multi-day all-day: 10th to 12th, so the host spans 10, 11 and 12.
    expect(byId.get('trip')).toMatchObject({
      title: 'Calendar three-day fixture',
      start: '2026-09-10',
      end: '2026-09-13',
      allDay: true,
      day: '2026-09-10',
      endDay: '2026-09-13',
    });
    // Exact strings, offset kept, never re-serialised through a Date.
    expect(byId.get('timed')).toMatchObject({
      title: 'Calendar timed fixture',
      description: 'Synthetic agenda',
      location: 'Room 4',
      start: `${DAY}T09:30:00+02:00`,
      end: `${DAY}T10:30:00+02:00`,
      allDay: false,
      day: DAY,
    });
    // A timed event within one day has no End day.
    expect(byId.get('timed')!.endDay).toBeUndefined();
    // Google's description is the host's Notes, not the core description.
    expect(
      store.resources.get(byId.get('timed')!.subject as string)![DESCRIPTION],
    ).toBeUndefined();
    expect(store.resources.get(TABLE)![NAME]).toBe('Synthetic');
    expect(store.resources.get(TABLE)![prop(store, 'google-calendar-id')]).toBe(
      PRIMARY,
    );
    // #177: the table and every row are the shared event-v1; the app's own
    // class is left as it was, and its fields are the published ones.
    expect(store.resources.get(TABLE)![CLASSTYPE]).toBe(EVENT);
    for (const { subject } of byId.values())
      expect(store.resources.get(subject as string)![IS_A]).toEqual([EVENT]);
    expect(store.resources.get(ROW_CLASS)![RECOMMENDS]).toEqual([NAME]);
    for (const s of ['location', 'start', 'end', ALL_DAY, DAY_FIELD, END_DAY])
      expect(prop(store, s)).toMatch(
        /^https:\/\/ontola\.github\.io\/atomic-plugins\/ontology\/properties\/atomic-calendar-/,
      );
    // Offered on any event-v1 table, and its row extras declared (#1849).
    expect(store.resources.get(APP)![RENDERS]).toEqual([ROW_CLASS, EVENT]);
    expect(store.resources.get(APP)![ROW_EXTRAS_PROPERTY]).toEqual(
      ['google-event-id', 'google-etag', 'google-link', 'sync-baseline'].map(
        s => prop(store, s),
      ),
    );

    // Paged (2 per page), full scan with tombstones, one calendar only.
    const lists = store.calls.filter(c => c.path.endsWith('/events'));
    expect(lists.map(c => c.path)).toEqual(
      Array(3).fill(
        `/calendar/v3/calendars/${encodeURIComponent(PRIMARY)}/events`,
      ),
    );
    expect(lists.map(c => c.query?.pageToken)).toEqual([undefined, '2', '4']);
    expect(lists[0].query).toMatchObject({
      singleEvents: 'false',
      showDeleted: 'true',
      maxResults: '250',
    });
    expect(
      store.calls.every(
        c => !JSON.stringify(c).match(/secret:|authorization|bearer/i),
      ),
    ).toBe(true);
  });

  it('a refresh brings in Google edits and leaves unchanged rows alone', async () => {
    const { store, controller } = await imported();
    store.google.editRemote('timed', { location: 'Room 2' });
    const saves = store.writes.length;
    await controller.refresh();
    const state = ready(controller.state());
    expect(state.summary).toMatchObject({ added: 0, updated: 1, unchanged: 2 });
    expect(rows(store).get('timed')!.location).toBe('Room 2');
    // One save for the updated row; the unchanged row is not rewritten. The
    // table itself records when the read succeeded (`google-last-sync`).
    const after = store.writes.slice(saves);
    expect(after.filter(w => w.subject !== TABLE).map(w => w.op)).toEqual([
      'save',
    ]);
    expect(after.filter(w => w.subject === TABLE).map(w => w.op)).toEqual([
      'save',
    ]);
    await controller.refresh();
    expect(ready(controller.state()).summary).toMatchObject({
      updated: 0,
      unchanged: 3,
    });
  });

  it('keeps End day with the event: a timed event past midnight gets its end date, and loses it again', async () => {
    const { store, controller } = await imported();
    store.google.editRemote('timed', {
      start: { dateTime: `${DAY}T22:00:00+02:00` },
      end: { dateTime: '2026-09-25T01:00:00+02:00' },
    });
    await controller.refresh();
    expect(rows(store).get('timed')).toMatchObject({
      day: DAY,
      endDay: '2026-09-25',
    });
    store.google.editRemote('timed', {
      end: { dateTime: `${DAY}T23:00:00+02:00` },
    });
    await controller.refresh();
    expect(rows(store).get('timed')!.endDay).toBeUndefined();
    expect(
      Object.keys(
        store.resources.get(rows(store).get('timed')!.subject as string)!,
      ),
    ).not.toContain(prop(store, END_DAY));
  });

  it('gives an all-day event with end == start (#184) the exclusive End day of its one day', async () => {
    const { store, controller } = await imported();
    // project() reads end == start as that one day with an exclusive end, so
    // the imported one-day event (DAY to the 25th) is the same event.
    store.google.editRemote('all-day', { end: { date: DAY } });
    await controller.refresh();
    expect(ready(controller.state()).summary).toMatchObject({
      updated: 0,
      unreadable: [],
    });
    expect(rows(store).get('all-day')!.endDay).toBe('2026-09-25');

    // Moved to the 20th, end == start: the host Calendar view
    // (start <= day < End day) draws it on the 20th only.
    store.google.editRemote('all-day', {
      start: { date: '2026-09-20' },
      end: { date: '2026-09-20' },
    });
    await controller.refresh();
    expect(ready(controller.state()).summary).toMatchObject({
      updated: 1,
      unreadable: [],
    });
    expect(rows(store).get('all-day')).toMatchObject({
      start: '2026-09-20',
      end: '2026-09-21',
      allDay: true,
      day: '2026-09-20',
      endDay: '2026-09-21',
    });
  });

  it('previews a local edit as a minimal patch and sends it only on approval, with If-Match', async () => {
    const { store, controller } = await imported();
    const etag = rows(store).get('timed')!.etag;
    editRow(store, 'timed', { [NAME]: 'Renamed here' });
    await controller.refresh();
    const state = ready(controller.state());
    expect(state.summary.review).toEqual([
      expect.objectContaining({
        etag,
        title: 'Calendar timed fixture',
        fields: [
          {
            field: 'Title',
            before: 'Calendar timed fixture',
            after: 'Renamed here',
          },
        ],
      }),
    ]);
    // A preview writes nothing to Google.
    expect(store.google.writes).toEqual([]);
    expect(store.calls.some(c => c.method === 'PATCH')).toBe(false);

    await controller.send();
    const sent = ready(controller.state());
    expect(sent.outcomes).toEqual([
      { status: 'sent', title: 'Calendar timed fixture' },
    ]);
    expect(store.google.writes).toEqual([
      { id: 'timed', patch: { summary: 'Renamed here' }, ifMatch: etag },
    ]);
    const patch = store.calls.find(c => c.method === 'PATCH')!;
    expect(patch).toMatchObject({
      path: '/calendar/v3/calendars/synthetic%40example.com/events/timed',
      query: { sendUpdates: 'none' },
      ifMatch: etag,
      body: JSON.stringify({ summary: 'Renamed here' }),
    });
    expect(rows(store).get('timed')!.etag).not.toBe(etag);

    await controller.refresh();
    expect(ready(controller.state()).summary).toMatchObject({
      review: [],
      conflicts: [],
      unchanged: 3,
    });
  });

  it('an edit made in Google after the preview fails the write with 412 and is reviewed again', async () => {
    const { store, controller } = await imported();
    editRow(store, 'timed', { [NAME]: 'Renamed here' });
    await controller.refresh();
    store.google.editRemote('timed', { location: 'Room 9' });
    await controller.send();
    expect(ready(controller.state()).outcomes).toEqual([
      { status: 'stale', title: 'Calendar timed fixture' },
    ]);
    expect(store.google.writes).toEqual([]);
    expect(store.google.events.find(e => e.id === 'timed')).toMatchObject({
      summary: 'Calendar timed fixture',
      location: 'Room 9',
    });

    // Different fields: no conflict. The new preview carries the new ETag.
    await controller.refresh();
    const again = ready(controller.state());
    expect(again.summary.conflicts).toEqual([]);
    expect(rows(store).get('timed')).toMatchObject({
      title: 'Renamed here',
      location: 'Room 9',
    });
    expect(again.summary.review[0].fields.map(f => f.field)).toEqual(['Title']);
    await controller.send();
    expect(ready(controller.state()).outcomes[0].status).toBe('sent');
    expect(store.google.writes).toEqual([
      expect.objectContaining({ patch: { summary: 'Renamed here' } }),
    ]);
  });

  it('the same field changed on both sides is a conflict; neither side is overwritten', async () => {
    const { store, controller } = await imported();
    editRow(store, 'timed', { [NAME]: 'Here' });
    store.google.editRemote('timed', { summary: 'There' });
    await controller.refresh();
    const state = ready(controller.state());
    expect(state.summary.conflicts).toEqual([
      expect.objectContaining({
        id: 'timed',
        title: 'Here',
        fields: ['title'],
        kind: 'both',
        local: expect.objectContaining({ title: 'Here' }),
        remote: expect.objectContaining({ title: 'There' }),
        base: expect.objectContaining({ title: 'Calendar timed fixture' }),
        etag: expect.stringMatching(/^"v\d+"$/),
      }),
    ]);
    expect(state.summary.review).toEqual([]);
    expect(rows(store).get('timed')!.title).toBe('Here');
    expect(store.google.writes).toEqual([]);
  });

  it('a lost write response is reported as unknown, stops the batch, and the next preview shows what Google has', async () => {
    const { store, controller } = await imported();
    editRow(store, 'all-day', { [NAME]: 'All-day here' });
    editRow(store, 'timed', { [NAME]: 'Timed here' });
    await controller.refresh();
    expect(ready(controller.state()).summary.review).toHaveLength(2);
    store.loseNextWriteResponse();
    await controller.send();
    const failed = controller.state();
    if (failed.kind !== 'error') throw new Error(failed.kind);
    expect(failed.message).toMatch(/may or may not have applied/);
    expect(failed.outcomes?.map(o => o.status)).toEqual([
      'uncertain',
      'not-sent',
    ]);
    // Google did apply the first; the second was never dispatched.
    expect(store.google.writes.map(w => w.id)).toEqual(['all-day']);

    // Nothing was spent (no connection codes since #54 phase 2): the same
    // connection previews again straight away.
    await controller.refresh();
    const after = ready(controller.state());
    // Google has the first change: it now agrees, nothing to send for it.
    expect(after.summary.conflicts).toEqual([]);
    expect(after.summary.review.map(r => r.edit.id)).toEqual(['timed']);
    expect(store.calls.at(-1)!.connectionId).toBe('c1');
  });

  it('a delegation revoked at the proxy asks to connect again', async () => {
    const { store, controller } = await imported();
    store.revoke('c1');
    await controller.refresh();
    expect(controller.state()).toMatchObject({
      kind: 'error',
      reconnect: true,
    });
    store.reconnect();
    await (
      await controller.load()
    ).refreshing;
    ready(controller.state());
    expect(store.calls.at(-1)!.connectionId).toBe('c2');
  });

  it('an imported event cancelled in Google is a conflict, never a local deletion', async () => {
    const { store, controller } = await imported();
    store.google.cancel('timed');
    await controller.refresh();
    const state = ready(controller.state());
    expect(state.summary.conflicts).toEqual([
      {
        subject: rows(store).get('timed')!.subject,
        id: 'timed',
        title: 'Calendar timed fixture',
        kind: 'missing-remote',
        fields: [
          'Event cancelled, recurring or inaccessible; no deletion inferred',
        ],
      },
    ]);
    expect(state.summary.skipped.cancelled).toBe(2);
    expect(rows(store).has('timed')).toBe(true);
  });

  it('rows made here and invalid local edits are reported, not sent', async () => {
    const { store, controller } = await imported();
    // A row made in the host table gets the table's class, event-v1.
    await store.newResource({
      parent: TABLE,
      isA: [EVENT],
      propVals: { [NAME]: 'Made here', [SHARED.day]: '2026-09-24' },
    });
    editRow(store, 'timed', { [NAME]: '  ' });
    store.google.editRemote('timed', { location: 'Room 7' });
    await controller.refresh();
    const state = ready(controller.state());
    expect(state.summary.localOnly).toBe(1);
    expect(state.summary.invalid).toEqual([
      { title: '  ', reason: 'the title is empty' },
    ]);
    expect(state.summary.review).toEqual([]);
    // Held back entirely: the Google edit does not overwrite the row either.
    expect(rows(store).get('timed')!.location).toBe('Room 4');
    expect(describe(state)).toContain('creating events isn’t supported');
  });

  it('a row missing a required event-v1 field is held back whole, marked incomplete, never sent (#177)', async () => {
    const { store, controller } = await imported();
    // The host table's Day column cleared on a synced row.
    const subject = rows(store).get('timed')!.subject as string;
    const { [prop(store, DAY_FIELD)]: _day, ...rest } =
      store.resources.get(subject)!;
    store.resources.set(subject, { ...rest, [NAME]: 'Renamed here' });
    store.google.editRemote('timed', { location: 'Room 7' });
    await controller.refresh();
    const state = ready(controller.state());
    expect(state.summary.invalid).toEqual([
      { title: 'Renamed here', reason: 'Incomplete: missing Day' },
    ]);
    expect(state.summary.review).toEqual([]);
    expect(state.summary.conflicts).toEqual([]);
    // Held back entirely: neither side moves, and nothing is pending.
    expect(rows(store).get('timed')!.location).toBe('Room 4');
    expect(store.google.state().writes).toEqual([]);
    const event = controller
      .snapshot()
      .events.find(e => e.subject === subject)!;
    expect(event.incomplete).toBe('Incomplete: missing Day');
    expect(event.pending).toBe(false);
    // The other rows are unaffected.
    expect(controller.snapshot().events.length).toBe(rows(store).size);
  });

  it('the import is bounded: past the page cap it fails and writes nothing', async () => {
    const store = fakeStore();
    const controller = createController(store, () => {}, { maxPages: 1 });
    await controller.load();
    await controller.choose(PRIMARY);
    expect(controller.state()).toMatchObject({
      kind: 'error',
      message: 'Pilot supports at most 250 events per scan',
    });
    expect(
      [...store.resources.values()].filter(p => p[PARENT] === TABLE),
    ).toEqual([]);
  });

  it('a chosen calendar is remembered on the table', async () => {
    const { store } = await imported();
    const controller = createController(store, () => {});
    const { refreshing } = await controller.load();
    await refreshing;
    expect(ready(controller.state()).summary.calendarId).toBe(PRIMARY);
    expect(
      store.calls.filter(c => c.path.endsWith('/calendarList')),
    ).toHaveLength(1);
  });
});
