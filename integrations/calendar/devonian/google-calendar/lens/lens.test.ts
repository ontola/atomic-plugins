// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { Datatype, isAllDayOnDate } from '@tomic/lib';
import { planCalendarValues } from './edit.js';
import { calendarFields, calendarProjection } from './projection.js';
import type { FetchedPlatform, JSONValue } from './types.js';
import { applyCalendarEdit, planCalendarEdit } from '../sync.js';

// Moved from devonian/__tests__/unit/platformLenses.test.ts with the lens.
const name = 'https://atomicdata.dev/properties/name';
const baseline = {
  [name]: 'Before',
  summary: 'Before',
  description: 'Details',
};
const properties = {
  summary: 'summary',
  description: 'description',
  start: 'start',
  end: 'end',
};
const remote = {
  summary: 'Before',
  description: 'Details',
  attendees: [{ email: 'person@example.com' }],
};

describe('passive Calendar lens', () => {
  it('maps Calendar edits without replacing provider-only fields or mutating input', () => {
    const row = { ...baseline, [name]: 'After', description: '' };
    const previous = structuredClone(row);
    const edit = planCalendarValues(row, baseline, properties, remote)!;
    expect(edit.patch).toEqual({ summary: 'After', description: '' });
    expect({ ...remote, ...edit.patch }.attendees).toEqual(remote.attendees);
    expect(row).toEqual(previous);
    const acknowledged = { ...row, ...edit.acknowledged };
    expect(
      planCalendarValues(acknowledged, acknowledged, properties, {
        ...remote,
        ...edit.patch,
      }),
    ).toBeUndefined();
  });

  it('rejects competing Calendar edits and invalid intervals', () => {
    expect(() =>
      planCalendarValues(
        { ...baseline, [name]: 'Local' },
        baseline,
        properties,
        { ...remote, summary: 'Remote' },
      ),
    ).toThrow('conflict');
    expect(() =>
      planCalendarValues(
        { ...baseline, start: { date: '2026-09-12' } },
        baseline,
        properties,
        { ...remote, end: { date: '2026-09-11' } },
      ),
    ).toThrow('end must follow');
  });
});

describe('Calendar runtime after lens extraction', () => {
  const baselineKey = 'https://atomicdata.dev/properties/importBaseline';
  const config = {
    platform: 'google-calendar',
    destinations: { event: { table: 'urn:calendar', rowClass: 'urn:event' } },
    properties,
  };
  const row = {
    ...baseline,
    [name]: 'After',
    [baselineKey]: { values: baseline },
    'https://atomicdata.dev/properties/localId': JSON.stringify([
      'google-calendar',
      'event',
      'primary',
      '42',
    ]),
    'https://atomicdata.dev/properties/parent': 'urn:calendar',
    'https://atomicdata.dev/properties/isA': ['urn:event'],
  };

  it('does not checkpoint failed writes', async () => {
    const edit = planCalendarEdit('urn:event:42', row, config, {
      ...remote,
      etag: 'v1',
    })!;
    let checkpointed = false;
    await expect(
      applyCalendarEdit(
        edit,
        async () => row,
        async () => ({ status: 503, body: '' }),
        async () => {
          checkpointed = true;
        },
      ),
    ).rejects.toThrow('503');
    expect(checkpointed).toBe(false);
  });

  it('recovers a lost checkpoint without repeating the remote write', async () => {
    const edit = planCalendarEdit('urn:event:42', row, config, {
      ...remote,
      etag: 'v1',
    })!;
    const savedRemote = { ...remote, ...edit.patch, etag: 'v2' };
    await expect(
      applyCalendarEdit(
        edit,
        async () => row,
        async () => ({ status: 200, body: JSON.stringify(savedRemote) }),
        async () => {
          throw new Error('Checkpoint unavailable');
        },
      ),
    ).rejects.toThrow('Checkpoint unavailable');
    const replay = planCalendarEdit('urn:event:42', row, config, savedRemote)!;
    expect(replay.patch).toEqual({});
    let writes = 0;
    let checkpoint: unknown;
    await applyCalendarEdit(
      replay,
      async () => row,
      async () => {
        writes++;
        throw new Error('Unexpected write');
      },
      async values => {
        checkpoint = values;
      },
    );
    expect(writes).toBe(0);
    expect(checkpoint).toMatchObject({ [name]: 'After', summary: 'After' });
  });
});

describe('calendarProjection: the host Calendar view’s format', () => {
  const fetched = (start: JSONValue, end: JSONValue): FetchedPlatform => ({
    platform: 'google-calendar',
    ontology: {
      description: 'Google Calendar',
      terms: [
        {
          path: 'urn:event',
          kind: 'class',
          shortname: 'event',
          description: 'An event',
          datatype: Datatype.STRING,
          requires: [],
          recommends: [],
        },
      ],
    },
    records: [
      {
        resource: 'event',
        namespace: 'primary',
        id: 'e1',
        name: 'Invented event',
        values: { start, end },
      },
    ],
  });
  const projected = (start: JSONValue, end: JSONValue) =>
    calendarProjection(fetched(start, end)).records[0].values;

  it('keeps Google’s exclusive all-day end as End day', () => {
    expect(
      projected({ date: '2026-11-16' }, { date: '2026-11-19' }),
    ).toMatchObject({
      [calendarFields.day]: '2026-11-16',
      [calendarFields.allDay]: true,
      [calendarFields.endDay]: '2026-11-19',
    });
  });

  it('reads end.date == start.date as one day, not as an empty range (#184)', () => {
    const values = projected({ date: '2026-12-31' }, { date: '2026-12-31' });
    expect(values).toMatchObject({
      [calendarFields.day]: '2026-12-31',
      [calendarFields.endDay]: '2027-01-01',
    });
    // Google's own start/end stay as sent, for write-back.
    expect(values.end).toEqual({ date: '2026-12-31' });
    expect(
      isAllDayOnDate(
        values[calendarFields.day],
        values[calendarFields.endDay],
        '2026-12-31',
      ),
    ).toBe(true);
  });

  it('still refuses an all-day end before its start', () => {
    expect(() =>
      projected({ date: '2026-12-31' }, { date: '2026-12-30' }),
    ).toThrow('invalid all-day interval');
  });

  it('gives a timed event its Day in the supplied offset and no End day', () => {
    const values = projected(
      { dateTime: '2026-09-24T23:30:00-04:00' },
      { dateTime: '2026-09-25T00:30:00-04:00' },
    );
    expect(values[calendarFields.day]).toBe('2026-09-24');
    expect(values[calendarFields.allDay]).toBe(false);
    expect(values[calendarFields.endDay]).toBeUndefined();
  });
});
