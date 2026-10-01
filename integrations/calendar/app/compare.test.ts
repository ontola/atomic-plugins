// @wc-ignore-file
/**
 * Compare on open (#192, #177 Q4–Q7): edits made to synced rows outside the
 * app (the host's table, its built-in Calendar view, another device) are
 * found when the app opens, by comparing each row with the baseline stored
 * on it, and become the app's reviewed "Changes to send". The rows keep the
 * host's format (Day, exclusive End day), so an edit to Day, End day or All
 * day is translated back into Google's start and end (`hostValue`).
 */
import { describe as suite, expect, it } from 'vitest';
import { properties } from '../../../ontology-kit/terms.mjs';
import { PRIMARY } from '../fixtures/google-calendar/scenario.mjs';
import { EVENT } from './fields.js';
import { createController, describe, type ViewState } from './controller.js';
import { DAY, fakeStore, field, TABLE } from './fakeStore.js';
import {
  ALL_DAY,
  DAY as DAY_FIELD,
  DESCRIPTION,
  END_DAY,
  hostValue,
  NAME,
  NOTES,
  PARENT,
  readEvents,
} from './sync.js';

type Store = ReturnType<typeof fakeStore>;

function prop(store: Store, shortname: string): string {
  return field(store, shortname);
}

function row(store: Store, eventId: string) {
  const id = prop(store, 'google-event-id');

  for (const [subject, props] of store.resources)
    if (props[PARENT] === TABLE && props[id] === eventId)
      return {
        subject,
        title: props[NAME],
        start: props[prop(store, 'start')],
        end: props[prop(store, 'end')],
        allDay: props[prop(store, ALL_DAY)],
        day: props[prop(store, DAY_FIELD)],
        endDay: props[prop(store, END_DAY)],
      };

  return undefined;
}

/** A commit made in the host's table: the named columns, by shortname. */
function hostEdit(
  store: Store,
  eventId: string,
  fields: Record<string, unknown>,
) {
  const subject = row(store, eventId)!.subject;
  const stored = { ...store.resources.get(subject)! };

  for (const [shortname, value] of Object.entries(fields)) {
    const property = shortname === 'name' ? NAME : prop(store, shortname);
    if (value === undefined) delete stored[property];
    else stored[property] = value as never;
  }

  store.resources.set(subject, stored);
}

async function imported() {
  const store = fakeStore();
  const controller = createController(store, () => {});
  await controller.load();
  await controller.choose(PRIMARY);

  return store;
}

/** Opens the app again on the same rows: `load()` compares on open. */
async function reopen(store: Store) {
  const controller = createController(store, () => {});
  await (
    await controller.load()
  ).refreshing;

  return { controller, state: ready(controller.state()) };
}

const ready = (state: ViewState) => {
  if (state.kind !== 'ready') throw new Error(describe(state));

  return state;
};

const fields = (state: ReturnType<typeof ready>, id: string) =>
  state.summary.review.find(r => r.edit.id === id)?.fields;

suite('compare on open: edits made in the host table', () => {
  it('title, notes and location become one reviewed PATCH of those fields', async () => {
    const store = await imported();
    hostEdit(store, 'timed', {
      name: 'Retitled in the table',
      [NOTES]: 'New agenda',
      location: 'Room 12',
    });
    const { controller, state } = await reopen(store);
    expect(fields(state, 'timed')).toEqual([
      {
        field: 'Title',
        before: 'Calendar timed fixture',
        after: 'Retitled in the table',
      },
      { field: 'Description', before: 'Synthetic agenda', after: 'New agenda' },
      { field: 'Location', before: 'Room 4', after: 'Room 12' },
    ]);
    // Opening sends nothing.
    expect(store.google.writes).toEqual([]);
    await controller.send();
    expect(store.google.writes).toEqual([
      {
        id: 'timed',
        patch: {
          summary: 'Retitled in the table',
          description: 'New agenda',
          location: 'Room 12',
        },
        ifMatch: expect.stringMatching(/^"v\d+"$/),
      },
    ]);
    expect((await reopen(store)).state.summary.review).toEqual([]);
  });

  it('Start and End edited in the table are sent; the stale Day is derived again', async () => {
    const store = await imported();
    hostEdit(store, 'timed', {
      start: '2026-09-26T11:00:00+02:00',
      end: '2026-09-26T12:00:00+02:00',
    });
    const { controller, state } = await reopen(store);
    expect(fields(state, 'timed')?.map(f => f.field)).toEqual(['Start', 'End']);
    // Day followed Start when the preview wrote the row.
    expect(row(store, 'timed')!.day).toBe('2026-09-26');
    await controller.send();
    expect(store.google.writes[0].patch).toEqual({
      start: { dateTime: '2026-09-26T11:00:00+02:00' },
      end: { dateTime: '2026-09-26T12:00:00+02:00' },
    });
  });

  it('Day and End day moved on an all-day event: Google gets the days the host view shows', async () => {
    const store = await imported();
    // The host view draws Day up to, not including, End day: 26 and 27.
    hostEdit(store, 'all-day', {
      [DAY_FIELD]: '2026-09-26',
      [END_DAY]: '2026-09-28',
    });
    // The app's views mark it before any preview.
    const events = await readEvents(store, {
      summary: 'Synthetic',
      color: '#9fe1e7',
      accessRole: 'owner',
    });
    expect(events.find(e => e.id === 'all-day')).toMatchObject({
      pending: true,
      start: '2026-09-26',
      end: '2026-09-28',
    });
    const { controller, state } = await reopen(store);
    expect(fields(state, 'all-day')).toEqual([
      { field: 'Start', before: DAY, after: '2026-09-26' },
      { field: 'End', before: '2026-09-25', after: '2026-09-28' },
    ]);
    await controller.send();
    expect(store.google.writes[0].patch).toEqual({
      start: { date: '2026-09-26' },
      end: { date: '2026-09-28' },
    });
    // Sent: the row's Start and End now say what Day and End day said.
    expect(row(store, 'all-day')).toMatchObject({
      start: '2026-09-26',
      end: '2026-09-28',
      day: '2026-09-26',
      endDay: '2026-09-28',
    });
    const again = (await reopen(store)).state.summary;
    expect(again).toMatchObject({ review: [], conflicts: [], invalid: [] });
  });

  it('only Day moved: End day stays, so the range the host shows changes with it', async () => {
    const store = await imported();
    hostEdit(store, 'trip', { [DAY_FIELD]: '2026-09-11' });
    const { state } = await reopen(store);
    expect(fields(state, 'trip')).toEqual([
      { field: 'Start', before: '2026-09-10', after: '2026-09-11' },
    ]);
  });

  it('only End day moved on the three-day event: the end moves', async () => {
    const store = await imported();
    hostEdit(store, 'trip', { [END_DAY]: '2026-09-15' });
    const { state } = await reopen(store);
    expect(fields(state, 'trip')).toEqual([
      { field: 'End', before: '2026-09-13', after: '2026-09-15' },
    ]);
  });

  it('End day cleared on an all-day event: the host shows Day only, so one day', async () => {
    const store = await imported();
    hostEdit(store, 'trip', { [END_DAY]: undefined });
    const { state } = await reopen(store);
    expect(fields(state, 'trip')).toEqual([
      { field: 'End', before: '2026-09-13', after: '2026-09-11' },
    ]);
  });

  it('End day not after Day on an all-day event is held back, not rewritten or sent', async () => {
    const store = await imported();
    hostEdit(store, 'trip', { [END_DAY]: '2026-09-10' });
    const { state } = await reopen(store);
    expect(state.summary.invalid).toEqual([
      {
        title: 'Calendar three-day fixture',
        reason:
          'End day must be after Day: for an all-day event it is the day after the last day',
      },
    ]);
    expect(state.summary.review).toEqual([]);
    // The person's value stays as they typed it.
    expect(row(store, 'trip')!.endDay).toBe('2026-09-10');
    expect(store.google.writes).toEqual([]);
  });

  it('Day moved on a timed event: same clock time and offset, end moves with it', async () => {
    const store = await imported();
    hostEdit(store, 'timed', { [DAY_FIELD]: '2026-09-27' });
    const { controller, state } = await reopen(store);
    expect(fields(state, 'timed')?.map(f => [f.field, f.after])).toEqual([
      ['Start', '2026-09-27T09:30:00+02:00'],
      ['End', '2026-09-27T10:30:00+02:00'],
    ]);
    await controller.send();
    expect(store.google.writes[0].patch).toEqual({
      start: { dateTime: '2026-09-27T09:30:00+02:00' },
      end: { dateTime: '2026-09-27T10:30:00+02:00' },
    });
  });

  it('End day set on a timed event: it ends on that date, at its own time', async () => {
    const store = await imported();
    hostEdit(store, 'timed', { [END_DAY]: '2026-09-25' });
    const { state } = await reopen(store);
    expect(fields(state, 'timed')).toEqual([
      {
        field: 'End',
        before: `${DAY}T10:30:00+02:00`,
        after: '2026-09-25T10:30:00+02:00',
      },
    ]);
  });

  it('All day turned on for a timed event: an all-day event on its Day', async () => {
    const store = await imported();
    hostEdit(store, 'timed', { [ALL_DAY]: true });
    const { controller, state } = await reopen(store);
    expect(fields(state, 'timed')?.map(f => [f.field, f.after])).toEqual([
      ['Start', DAY],
      ['End', '2026-09-25'],
      ['All day', 'true'],
    ]);
    await controller.send();
    expect(store.google.writes[0].patch).toEqual({
      start: { date: DAY },
      end: { date: '2026-09-25' },
    });
  });

  it('All day turned off with no times to send is held back with the reason', async () => {
    const store = await imported();
    hostEdit(store, 'all-day', { [ALL_DAY]: false });
    const { state } = await reopen(store);
    expect(state.summary.invalid).toEqual([
      {
        title: 'Calendar all-day fixture',
        reason:
          'All day was turned off in the table, with no times to send; set the times with Edit in the app',
      },
    ]);
    expect(state.summary.review).toEqual([]);
    expect(describe(state)).toContain('1 row can’t be sent as edited.');
  });

  it('Start and Day both edited, disagreeing, is held back', async () => {
    const store = await imported();
    hostEdit(store, 'trip', {
      start: '2026-09-09',
      [DAY_FIELD]: '2026-09-11',
    });
    const { state } = await reopen(store);
    expect(state.summary.invalid.map(i => i.title)).toEqual([
      'Calendar three-day fixture',
    ]);
    expect(state.summary.review).toEqual([]);
  });

  it('Day edited here and the start changed in Google: a conflict, neither side overwritten', async () => {
    const store = await imported();
    hostEdit(store, 'trip', { [DAY_FIELD]: '2026-09-09' });
    store.google.editRemote('trip', { start: { date: '2026-09-11' } });
    const { state } = await reopen(store);
    expect(state.summary.conflicts).toEqual([
      expect.objectContaining({
        id: 'trip',
        kind: 'both',
        fields: ['start'],
        local: expect.objectContaining({ start: '2026-09-09' }),
        remote: expect.objectContaining({ start: '2026-09-11' }),
      }),
    ]);
    expect(state.summary.review).toEqual([]);
    expect(row(store, 'trip')!.day).toBe('2026-09-09');
    expect(store.google.writes).toEqual([]);
  });

  it('Day edited here and another field changed in Google: Google’s lands, the Day edit is reviewed', async () => {
    const store = await imported();
    hostEdit(store, 'trip', { [DAY_FIELD]: '2026-09-09' });
    store.google.editRemote('trip', { location: 'Hut' });
    const { state } = await reopen(store);
    expect(state.summary.conflicts).toEqual([]);
    expect(fields(state, 'trip')?.map(f => f.field)).toEqual(['Start']);
    expect(row(store, 'trip')).toMatchObject({
      start: '2026-09-09',
      day: '2026-09-09',
    });
    expect(
      store.resources.get(row(store, 'trip')!.subject)![
        prop(store, 'location')
      ],
    ).toBe('Hut');
  });

  it('a synced row deleted here is not noticed: it is imported again, and Google keeps the event', async () => {
    const store = await imported();
    store.resources.delete(row(store, 'timed')!.subject);
    const { state } = await reopen(store);
    // Declared limitation (#177 §4.1, H6): with no change list with
    // tombstones, a deleted row leaves nothing to compare.
    expect(state.summary).toMatchObject({ added: 1, review: [] });
    expect(row(store, 'timed')).toBeDefined();
    expect(store.google.writes).toEqual([]);
  });

  it('a row added by hand (the host view’s "+") stays local: shown, never uploaded', async () => {
    const store = await imported();
    await store.newResource({
      parent: TABLE,
      isA: [EVENT],
      propVals: {
        [NAME]: 'Added in the host',
        [prop(store, DAY_FIELD)]: '2026-09-20',
        [prop(store, ALL_DAY)]: true,
        [prop(store, END_DAY)]: '2026-09-21',
      },
    });
    const { state } = await reopen(store);
    expect(state.summary).toMatchObject({ localOnly: 1, review: [] });
    expect(describe(state)).toContain('creating events isn’t supported');
    const events = await readEvents(store, {
      summary: 'Synthetic',
      color: '#9fe1e7',
      accessRole: 'owner',
    });
    expect(events.find(e => e.title === 'Added in the host')).toMatchObject({
      readOnly: true,
      pending: false,
      day: '2026-09-20',
    });
    expect(store.google.writes).toEqual([]);
  });

  it('a column the app doesn’t map is listed as kept here, never silently dropped', async () => {
    const store = await imported();
    // event-v1 recommends Recurrence, which the app doesn't import or send.
    const recurrence = properties['atomic-calendar-recurrence'].subject;
    const subject = row(store, 'timed')!.subject;
    store.resources.set(subject, {
      ...store.resources.get(subject)!,
      [recurrence]: '{"freq":"weekly"}',
      // The core Description is not Notes: not sent either.
      [DESCRIPTION]: 'Typed in the wrong column',
    });
    hostEdit(store, 'timed', { location: 'Room 5' });
    const { controller, state } = await reopen(store);
    expect(state.summary.unmapped).toEqual([{ column: 'Recurrence', rows: 1 }]);
    expect(describe(state)).toContain(
      '1 column the app doesn’t send (Recurrence) is kept here only.',
    );
    await controller.send();
    expect(store.google.writes[0].patch).toEqual({ location: 'Room 5' });
    expect(store.resources.get(subject)![recurrence]).toBe('{"freq":"weekly"}');
  });
});

suite('hostValue, the lens read backwards', () => {
  const base = {
    title: 'x',
    description: '',
    location: '',
    start: '2026-09-10',
    end: '2026-09-13',
    allDay: true,
  };

  it('rows the app wrote (Day and End day agree with Start and End) read as Start and End', () => {
    expect(
      hostValue(
        {
          start: '2026-09-11',
          end: '2026-09-12',
          allDay: true,
          day: '2026-09-11',
          endDay: '2026-09-12',
        },
        base,
      ),
    ).toEqual({ start: '2026-09-11', end: '2026-09-12', allDay: true });
  });

  it('without a baseline, Start and End', () => {
    expect(
      hostValue(
        {
          start: '2026-09-10',
          end: '2026-09-13',
          allDay: true,
          day: '2026-09-01',
          endDay: undefined,
        },
        null,
      ),
    ).toEqual({ start: '2026-09-10', end: '2026-09-13', allDay: true });
  });

  it('a Day that isn’t a date is a reason, not a guess', () => {
    expect(
      hostValue(
        {
          start: '2026-09-10',
          end: '2026-09-13',
          allDay: true,
          day: '10 September',
          endDay: '2026-09-13',
        },
        base,
      ),
    ).toEqual({ reason: 'Day must be a date (YYYY-MM-DD)' });
  });

  it('a row with no Day (an older version’s) reads as Start and End', () => {
    expect(
      hostValue(
        {
          start: '2026-09-10',
          end: '2026-09-13',
          allDay: true,
          day: undefined,
          endDay: undefined,
        },
        base,
      ),
    ).toEqual({ start: '2026-09-10', end: '2026-09-13', allDay: true });
  });
});
