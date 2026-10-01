// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  agendaDays,
  busyDays,
  latestEvent,
  nextEvent,
  packWeek,
  occupies,
  type CalEvent,
} from './events.js';
import { endDayOf } from './sync.js';
import { endClock, spoken, when } from './context.js';
import {
  isAllDayOnDate,
  nextCalendarDate,
} from '../../../browser/lib/src/calendar-date.js';
import {
  addDays,
  hhmm,
  instant,
  mondayOf,
  offsetAt,
  offsetLabel,
  parseHhmm,
  rangeTitle,
  shortDay,
  longDay,
  toDateTime,
  wall,
} from './time.js';

const AMS = 'Europe/Amsterdam';
const NY = 'America/New_York';

let n = 0;

/**
 * A row as `readEvents` reads it. Day and End day default to what the app
 * writes for Start and End (`sync.ts` `valuesOf`); a test that passes them
 * explicitly models a row whose Day or End day were set some other way.
 */
function ev(fields: Partial<CalEvent>): CalEvent {
  const base = {
    subject: `did:ad:row-${++n}`,
    id: `e${n}`,
    title: `Event ${n}`,
    description: '',
    location: '',
    start: '2026-09-24T10:00:00+02:00',
    end: '2026-09-24T11:00:00+02:00',
    allDay: false,
    pending: false,
    conflict: false,
    readOnly: false,
    calendar: { name: 'Work', color: '#039be5' },
    ...fields,
  };

  return {
    day: base.start.slice(0, 10),
    endDay: endDayOf(base),
    ...base,
  };
}

describe('time', () => {
  it('reads wall-clock time and offsets in a named zone', () => {
    const at = Date.parse('2026-09-24T09:30:00+02:00');
    expect(wall(at, AMS)).toEqual({ date: '2026-09-24', minutes: 570 });
    expect(wall(at, NY)).toEqual({ date: '2026-09-24', minutes: 210 });
    expect(offsetAt(at, AMS)).toBe(120);
    expect(offsetAt(at, NY)).toBe(-240);
    expect(offsetAt(Date.parse('2026-12-01T12:00:00Z'), AMS)).toBe(60);
    expect(offsetLabel(at, AMS)).toBe('GMT+2');
    expect(offsetLabel(at, 'UTC')).toBe('GMT');
  });

  it('attaches the viewer zone offset to an edited time, including across DST', () => {
    expect(toDateTime('2026-09-24', 600, AMS)).toBe(
      '2026-09-24T10:00:00+02:00',
    );
    // Summer time ends on 25 October 2026 in Amsterdam.
    expect(toDateTime('2026-10-26', 600, AMS)).toBe(
      '2026-10-26T10:00:00+01:00',
    );
    expect(toDateTime('2026-09-24', 600, NY)).toBe('2026-09-24T10:00:00-04:00');
    expect(instant('2026-09-24', 0, AMS)).toBe(
      Date.parse('2026-09-24T00:00:00+02:00'),
    );
  });

  it('formats dates and ranges like the mockups', () => {
    expect(shortDay('2026-09-24')).toBe('Thu 24 Sep');
    expect(longDay('2026-09-22')).toBe('Tuesday 22 September');
    expect(rangeTitle('2026-09-21', '2026-09-27')).toBe(
      '21 – 27 September 2026',
    );
    expect(rangeTitle('2026-09-28', '2026-10-04')).toBe(
      '28 September – 4 October 2026',
    );
    expect(rangeTitle('2026-12-28', '2027-01-03')).toBe(
      '28 December 2026 – 3 January 2027',
    );
    expect(mondayOf('2026-09-24')).toBe('2026-09-21');
    expect(mondayOf('2026-09-21')).toBe('2026-09-21');
    expect(mondayOf('2026-09-27')).toBe('2026-09-21');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(hhmm(570)).toBe('09:30');
    expect(parseHhmm('9:05')).toBe(545);
    expect(parseHhmm('24:00')).toBeUndefined();
    expect(parseHhmm('noon')).toBeUndefined();
  });
});

describe('agendaDays', () => {
  it('uses the exclusive all-day end: a 3-day event covers exactly 3 days', () => {
    const offsite = ev({
      title: 'Team offsite',
      allDay: true,
      start: '2026-09-23',
      end: '2026-09-26',
    });
    const days = agendaDays([offsite], '2026-09-22', 6);
    expect(days.map(d => d.items.length)).toEqual([0, 1, 1, 1, 0, 0]);
    expect(days[2].items[0]).toMatchObject({
      allDay: true,
      dayOf: { n: 2, total: 3 },
    });
  });

  it('a one-day all-day event has no "Day n of m"', () => {
    const one = ev({ allDay: true, start: '2026-09-24', end: '2026-09-25' });
    const [day] = agendaDays([one], '2026-09-24', 1);
    expect(day.items[0].dayOf).toBeUndefined();
  });

  it('shows a timed event that crosses midnight on its Day only, as the host does', () => {
    const late = ev({
      start: '2026-09-24T22:00:00+02:00',
      end: '2026-09-25T01:30:00+02:00',
    });
    // The app writes End day for it; the host view ignores End day unless
    // All day is true, and so do the views.
    expect(late.endDay).toBe('2026-09-25');
    const days = agendaDays([late], '2026-09-24', 2);
    expect(days.map(d => d.items.length)).toEqual([1, 0]);
    expect(days[0].items[0]).toMatchObject({
      startMin: 1320,
      endMin: 1440,
      allDay: false,
      until: { date: '2026-09-25', minutes: 90 },
    });
    expect(days[0].items[0].dayOf).toBeUndefined();
  });

  it('an event ending exactly at midnight stays on its own day', () => {
    const evening = ev({
      start: '2026-09-24T20:00:00+02:00',
      end: '2026-09-25T00:00:00+02:00',
    });
    const days = agendaDays([evening], '2026-09-24', 2);
    expect(days.map(d => d.items.length)).toEqual([1, 0]);
    expect(days[0].items[0]).toMatchObject({ startMin: 1200, endMin: 1440 });
    expect(days[0].items[0].until).toBeUndefined();
  });

  it('places a timed event on its Day, in its own offset, whatever the viewer zone', () => {
    // 23:30 in New York is 05:30 the next day in Amsterdam. The host view
    // reads Day, the date in the stored offset, and so does the app.
    const call = ev({
      start: '2026-09-24T23:30:00-04:00',
      end: '2026-09-25T00:30:00-04:00',
    });
    const days = agendaDays([call], '2026-09-24', 2);
    expect(days[1].items).toEqual([]);
    expect(days[0].items[0]).toMatchObject({
      startMin: 1410,
      endMin: 1440,
      until: { date: '2026-09-25', minutes: 30 },
    });
  });

  it('draws a timed event spanning several days on its Day only', () => {
    const conference = ev({
      start: '2026-09-22T09:00:00+02:00',
      end: '2026-09-24T17:00:00+02:00',
    });
    const days = agendaDays([conference], '2026-09-21', 5);
    expect(days.map(d => d.items.length)).toEqual([0, 1, 0, 0, 0]);
    expect(days[1].items[0]).toMatchObject({ allDay: false, startMin: 540 });
  });

  it('orders all-day first, then by start time', () => {
    const a = ev({
      title: 'B',
      start: '2026-09-24T14:00:00+02:00',
      end: '2026-09-24T15:00:00+02:00',
    });
    const b = ev({
      title: 'A',
      start: '2026-09-24T10:00:00+02:00',
      end: '2026-09-24T11:00:00+02:00',
    });
    const c = ev({
      title: 'Z',
      allDay: true,
      start: '2026-09-24',
      end: '2026-09-25',
    });
    const [day] = agendaDays([a, b, c], '2026-09-24', 1);
    expect(day.items.map(i => i.event.title)).toEqual(['Z', 'A', 'B']);
  });

  it('skips events with an interval it cannot place', () => {
    const bad = ev({ start: 'garbage', end: 'garbage' });
    expect(agendaDays([bad], '2026-09-24', 1)[0].items).toEqual([]);
  });
});

describe('packWeek', () => {
  it('spans multi-day all-day bars across columns and stacks overlapping bars', () => {
    const offsite = ev({
      allDay: true,
      start: '2026-09-23',
      end: '2026-09-26',
    });
    const deadline = ev({
      allDay: true,
      start: '2026-09-21',
      end: '2026-09-22',
    });
    const holiday = ev({
      allDay: true,
      start: '2026-09-24',
      end: '2026-09-25',
    });
    const week = packWeek([offsite, deadline, holiday], '2026-09-21', 7);
    const bar = (e: CalEvent) => week.bars.find(b => b.event === e)!;
    expect(bar(offsite)).toMatchObject({ col: 2, span: 3, row: 0 });
    expect(bar(deadline)).toMatchObject({ col: 0, span: 1, row: 0 });
    expect(bar(holiday)).toMatchObject({ col: 3, span: 1, row: 1 });
    expect(week.rows).toBe(2);
  });

  it('clips bars to the visible days', () => {
    const long = ev({ allDay: true, start: '2026-09-19', end: '2026-09-23' });
    const week = packWeek([long], '2026-09-21', 3);
    expect(week.bars[0]).toMatchObject({ col: 0, span: 2 });
  });

  it('packs overlapping timed events into lanes of one cluster', () => {
    const t = (s: string, e: string, title: string) =>
      ev({
        title,
        start: `2026-09-22T${s}:00+02:00`,
        end: `2026-09-22T${e}:00+02:00`,
      });
    const oneOnOne = t('11:00', '12:00', '1:1');
    const dentist = t('11:30', '12:30', 'Dentist');
    const later = t('12:15', '13:00', 'Later');
    const alone = t('16:00', '17:00', 'Sync');
    const week = packWeek([alone, later, dentist, oneOnOne], '2026-09-21', 7);
    const col = week.columns[1];
    const of = (e: CalEvent) => col.find(b => b.segment.event === e)!;
    expect(of(oneOnOne)).toMatchObject({ lane: 0, lanes: 2 });
    expect(of(dentist)).toMatchObject({ lane: 1, lanes: 2 });
    // Reuses lane 0 once 1:1 has ended, still in the same cluster.
    expect(of(later)).toMatchObject({ lane: 0, lanes: 2 });
    expect(of(alone)).toMatchObject({ lane: 0, lanes: 1 });
    expect(week.columns[0]).toEqual([]);
  });

  it('draws a timed event covering whole days in its Day column only', () => {
    const trip = ev({
      start: '2026-09-21T18:00:00+02:00',
      end: '2026-09-23T09:00:00+02:00',
    });
    const week = packWeek([trip], '2026-09-21', 7);
    expect(week.bars).toEqual([]);
    expect(week.columns[0][0].segment).toMatchObject({
      startMin: 1080,
      endMin: 1440,
      until: { date: '2026-09-23', minutes: 540 },
    });
    expect(week.columns.slice(1).flat()).toEqual([]);
  });
});

/**
 * The host table's Calendar view, case by case (atomic-server
 * CalendarView.tsx at the pin): the app's views must draw exactly the days
 * it draws. `host()` restates the host's bucketing of one row, with the
 * host's own `isAllDayOnDate`, so each case is checked against it as well
 * as against the expected days.
 */
describe('the host Calendar view’s days', () => {
  const WEEK = '2026-09-21';
  const dates = Array.from({ length: 7 }, (_, i) => addDays(WEEK, i));
  const host = (e: CalEvent) =>
    dates.filter(d =>
      e.allDay && e.endDay !== undefined
        ? isAllDayOnDate(
            typeof e.day === 'string' ? e.day.slice(0, 10) : undefined,
            e.endDay,
            d,
          )
        : typeof e.day === 'string' && e.day.slice(0, 10) === d,
    );

  const drawn = (e: CalEvent) => {
    const week = packWeek([e], WEEK, 7);

    return {
      agenda: agendaDays([e], WEEK, 7)
        .filter(d => d.items.length)
        .map(d => d.date),
      week: week.days.filter(
        (_, i) =>
          week.columns[i].length ||
          week.bars.some(b => i >= b.col && i < b.col + b.span),
      ),
      busy: [...busyDays([e], WEEK, 7)],
    };
  };

  const cases: Array<[string, Partial<CalEvent>, string[]]> = [
    [
      'all-day, one day',
      { allDay: true, start: '2026-09-22', end: '2026-09-23' },
      ['2026-09-22'],
    ],
    [
      'all-day, three days, End day exclusive',
      { allDay: true, start: '2026-09-22', end: '2026-09-25' },
      ['2026-09-22', '2026-09-23', '2026-09-24'],
    ],
    [
      'all-day, End day == Day (#184 shape, as stored): nowhere',
      {
        allDay: true,
        start: '2026-09-22',
        end: '2026-09-23',
        endDay: '2026-09-22',
      },
      [],
    ],
    [
      'all-day, End day before Day: nowhere',
      {
        allDay: true,
        start: '2026-09-22',
        end: '2026-09-23',
        endDay: '2026-09-20',
      },
      [],
    ],
    [
      'all-day, End day not a date: nowhere',
      { allDay: true, start: '2026-09-22', end: '2026-09-23', endDay: 'soon' },
      [],
    ],
    [
      'all-day, no End day: its Day only',
      {
        allDay: true,
        start: '2026-09-22',
        end: '2026-09-25',
        endDay: undefined,
      },
      ['2026-09-22'],
    ],
    [
      'row added in the host view: Day and End day, no Start or End',
      {
        allDay: true,
        start: '',
        end: '',
        id: undefined,
        day: '2026-09-23',
        endDay: nextCalendarDate('2026-09-23'),
      },
      ['2026-09-23'],
    ],
    [
      'Day and End day edited in the host table: they win over Start and End',
      {
        allDay: true,
        start: '2026-09-22',
        end: '2026-09-23',
        day: '2026-09-25',
        endDay: '2026-09-27',
      },
      ['2026-09-25', '2026-09-26'],
    ],
    [
      'no Day: nowhere',
      { allDay: true, start: '2026-09-22', end: '2026-09-23', day: undefined },
      [],
    ],
    [
      'Day with a time part: its first ten characters',
      { day: '2026-09-24T10:00:00+02:00' },
      ['2026-09-24'],
    ],
    ['timed, within one day', {}, ['2026-09-24']],
    [
      'timed, crossing midnight: Day only',
      { start: '2026-09-24T22:00:00+02:00', end: '2026-09-25T01:30:00+02:00' },
      ['2026-09-24'],
    ],
    [
      'timed, three days: Day only, End day ignored',
      { start: '2026-09-22T09:00:00+02:00', end: '2026-09-24T17:00:00+02:00' },
      ['2026-09-22'],
    ],
    [
      'timed, stored in another offset: the stored date',
      { start: '2026-09-24T23:30:00-04:00', end: '2026-09-25T00:30:00-04:00' },
      ['2026-09-24'],
    ],
    [
      'Day only, no Start or End: its Day (drawn all-day)',
      { start: '', end: '', day: '2026-09-23' },
      ['2026-09-23'],
    ],
  ];

  for (const [name, fields, expected] of cases)
    it(name, () => {
      const e = ev(fields);
      expect(host(e)).toEqual(expected);
      expect(dates.filter(d => occupies(e, d))).toEqual(expected);
      expect(drawn(e)).toEqual({
        agenda: expected,
        week: expected,
        busy: expected,
      });
    });

  it('draws a row with a Day and no Start or End as an all-day event (#177)', () => {
    const e = ev({ start: '', end: '', day: '2026-09-23' });
    const [segment] = agendaDays([e], '2026-09-23', 1)[0].items;
    expect(segment).toMatchObject({ allDay: true });
    expect(segment.untimed).toBeUndefined();
    expect(spoken(segment)).toBe('All day');
    expect(packWeek([e], WEEK, 7).bars).toEqual([
      expect.objectContaining({ col: 2, span: 1 }),
    ]);
  });

  it('draws a row whose Start and End are not a valid interval in the all-day area, saying so', () => {
    const e = ev({ start: 'tomorrow', end: '', day: '2026-09-23' });
    const [segment] = agendaDays([e], '2026-09-23', 1)[0].items;
    expect(segment).toMatchObject({ allDay: true, untimed: true });
    expect(spoken(segment)).toBe('No time set');
  });

  it('numbers the days of a multi-day all-day event from Day to End day', () => {
    const e = ev({
      allDay: true,
      start: '2026-09-22',
      end: '2026-09-23',
      day: '2026-09-22',
      endDay: '2026-09-24',
    });
    expect(
      agendaDays([e], WEEK, 7)
        .flatMap(d => d.items)
        .map(s => s.dayOf),
    ).toEqual([
      { n: 1, total: 2 },
      { n: 2, total: 2 },
    ]);
  });
});

describe('nextEvent and busyDays', () => {
  it('finds the first event on or after a date', () => {
    const early = ev({
      title: 'Early',
      start: '2026-09-01T10:00:00+02:00',
      end: '2026-09-01T11:00:00+02:00',
    });
    const next = ev({
      title: 'Next',
      start: '2026-10-13T10:00:00+02:00',
      end: '2026-10-13T11:00:00+02:00',
    });
    const later = ev({
      title: 'Later',
      allDay: true,
      start: '2026-10-20',
      end: '2026-10-21',
    });
    expect(nextEvent([later, early, next], '2026-10-05')).toMatchObject({
      event: next,
      date: '2026-10-13',
    });
    expect(nextEvent([early], '2026-10-05')).toBeUndefined();
  });

  it('finds the last event before a date, for a calendar of past events', () => {
    const april = ev({
      title: 'testing',
      allDay: true,
      start: '2026-04-02',
      end: '2026-04-03',
    });
    const may = ev({
      title: 'May',
      start: '2026-05-12T10:00:00+02:00',
      end: '2026-05-12T11:00:00+02:00',
    });
    const next = ev({
      title: 'Next',
      start: '2026-10-13T10:00:00+02:00',
      end: '2026-10-13T11:00:00+02:00',
    });
    expect(latestEvent([april, next, may], '2026-09-28')).toMatchObject({
      event: may,
      date: '2026-05-12',
    });
    expect(latestEvent([next], '2026-09-28')).toBeUndefined();
  });

  it('marks the days with events', () => {
    const e = ev({ allDay: true, start: '2026-09-23', end: '2026-09-25' });
    expect([...busyDays([e], '2026-09-21', 7)]).toEqual([
      '2026-09-23',
      '2026-09-24',
    ]);
  });
});

describe('labels for host-placed segments', () => {
  it('names the real end of an event that runs past midnight', () => {
    const late = ev({
      title: 'Night shift',
      start: '2026-09-24T22:00:00+02:00',
      end: '2026-09-25T01:30:00+02:00',
    });
    const [segment] = agendaDays([late], '2026-09-24', 1)[0].items;
    expect(spoken(segment)).toBe('22:00 to 01:30 on Friday 25 September');
    expect(endClock(segment, true)).toBe('01:30 Fri 25 Sep');
  });

  it('describes a row with a Day but no Start or End without throwing', () => {
    expect(
      when(ev({ allDay: true, start: '', end: '', day: '2026-09-23' }), AMS),
    ).toEqual({ day: 'Wednesday 23 September', time: 'All day' });
    // A Day and nothing else: an all-day event on that day (#177).
    expect(when(ev({ start: '', end: '', day: '2026-09-23' }), AMS)).toEqual({
      day: 'Wednesday 23 September',
      time: 'All day',
    });
    expect(
      when(
        ev({ start: '2026-09-23T10:00:00+02:00', end: '', day: '2026-09-23' }),
        AMS,
      ),
    ).toEqual({ day: 'Wednesday 23 September', time: 'No time set' });
  });
});
