// @wc-ignore-file
/**
 * The display model of the Calendar app's views: events as the rows hold
 * them, laid out per day (Agenda) and per column (Week). Pure functions
 * only; `main.ts` and the view modules draw from these.
 *
 * Which days an event occupies is decided exactly as the host table's own
 * Calendar view decides it (atomic-server
 * `browser/data-browser/src/chunks/TablePage/Calendar/CalendarView.tsx` at
 * the pin in `.atomic-server-ref`), from the same columns, with the host's
 * own `isAllDayOnDate` (imported from its `calendar-date.ts`, not copied):
 *
 * - a row is placed by its Day (`atomic-calendar-day`): the first ten
 *   characters of the stored string. A row without one is drawn nowhere.
 * - a row whose All day is true and that has an End day is drawn on every
 *   day with Day <= day < End day (End day is exclusive). An End day on or
 *   before Day, or one that is not a date, draws it nowhere.
 * - every other row, timed ones included, is drawn on its Day only. A timed
 *   event that runs past midnight is not continued on the next day, and its
 *   End day is ignored.
 *
 * Start and End only give the clock times within that day, read in the
 * event's own stored offset (the offset its Day is the date in), so a viewer
 * in another zone sees the event on the same day as the host view does.
 */
import type { Projection } from '../adapter.js';
import {
  isAllDayOnDate,
  isCalendarDate,
} from '../../../browser/lib/src/calendar-date.js';
import { addDays, daysBetween, instant } from './time.js';

export interface CalEvent extends Projection {
  /** The row's subject. */
  subject: string;
  /** The Google event id; absent for rows made in the table. */
  id?: string;
  /** Edited here and not sent yet: the row differs from its sync baseline. */
  pending: boolean;
  /** Google Calendar's page for the event, when it gave one. */
  link?: string;
  /** What both sides last agreed on, when the row is bound. */
  baseline?: Projection;
  /** Listed as a conflict by the last preview. */
  conflict: boolean;
  /** The calendar is read-only for this person: never offer Edit. */
  readOnly: boolean;
  calendar: { name: string; color: string };
  /** The row's Day (`atomic-calendar-day`) as stored: it places the event. */
  day: unknown;
  /** The row's End day (`atomic-calendar-end-day`) as stored, if any. */
  endDay: unknown;
}

/** The host view's day key: the first ten characters of the stored Day. */
function hostKey(event: CalEvent): string | undefined {
  return typeof event.day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(event.day)
    ? event.day.slice(0, 10)
    : undefined;
}

/**
 * Whether the host table's Calendar view draws `event` on `date`: its
 * bucketing of a row, for a table whose date column is `atomic-calendar-day`.
 */
export function occupies(event: CalEvent, date: string): boolean {
  const key = hostKey(event);
  if (event.allDay && event.endDay !== undefined)
    return isAllDayOnDate(key, event.endDay, date);

  return key !== undefined && key === date;
}

/** The first day the host view draws `event` on, if it draws it at all. */
function firstDay(event: CalEvent): string | undefined {
  const key = hostKey(event);

  return key !== undefined && occupies(event, key) ? key : undefined;
}

/**
 * A timed event's clock in its own stored offset: minutes since midnight of
 * Start as written, and how long it lasts. Undefined when Start and End are
 * not a valid timed interval.
 */
function clock(
  event: Projection,
): { startMin: number; duration: number } | undefined {
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})/.exec(event.start);
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (!m || !Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return undefined;

  return {
    startMin: Number(m[1]) * 60 + Number(m[2]),
    duration: Math.round((end - start) / 60_000),
  };
}

/**
 * A row with a Day and neither Start nor End: one made in a table or in the
 * host's Calendar view (`+`), or by another app on an `event-v1` table. It
 * is drawn as an all-day event on the days the host view draws it (#177
 * §3.2: before 0.2.0 such a row was drawn as "No time set").
 */
export function dayOnly(event: Projection): boolean {
  return !event.allDay && !event.start && !event.end;
}

/** Start and end as instants, for ordering and timed layout. */
export function bounds(
  event: Projection,
  zone: string,
): { start: number; end: number } | undefined {
  if (event.allDay) {
    const s = Date.parse(`${event.start}T00:00:00Z`);
    const e = Date.parse(`${event.end}T00:00:00Z`);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return undefined;

    return {
      start: instant(event.start, 0, zone),
      end: instant(event.end, 0, zone),
    };
  }

  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return undefined;

  return { start, end };
}

export interface Segment {
  event: CalEvent;
  date: string;
  /** Drawn in the all-day area: an all-day row, or a row without clock times. */
  allDay: boolean;
  /** A row that is not all-day and has a Start or End, but no valid timed interval. */
  untimed?: boolean;
  /** Minutes since midnight, in the event's own stored offset. */
  startMin: number;
  /** Minutes since midnight, capped at 1440 when the event runs past midnight. */
  endMin: number;
  /** When a timed event runs past midnight: End's own date and clock. */
  until?: { date: string; minutes: number };
  /** 1-based day of a multi-day all-day event, and how many days it covers. */
  dayOf?: { n: number; total: number };
}

/**
 * The days of [from, from + days) the host view draws `event` on (see the
 * file comment), one segment each.
 */
export function segments(
  event: CalEvent,
  from: string,
  days: number,
): Segment[] {
  const out: Segment[] = [];
  const key = hostKey(event);
  const total =
    event.allDay && key !== undefined && isCalendarDate(event.endDay)
      ? daysBetween(key, event.endDay)
      : 1;
  const time = event.allDay ? undefined : clock(event);

  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    if (!occupies(event, date)) continue;

    if (event.allDay || !time) {
      out.push({
        event,
        date,
        allDay: true,
        ...(event.allDay || dayOnly(event) ? {} : { untimed: true }),
        startMin: 0,
        endMin: 1440,
        ...(key !== undefined && total > 1
          ? { dayOf: { n: daysBetween(key, date) + 1, total } }
          : {}),
      });
      continue;
    }

    const endAt = time.startMin + time.duration;
    const end = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(event.end);
    out.push({
      event,
      date,
      allDay: false,
      startMin: time.startMin,
      endMin: Math.min(endAt, 1440),
      ...(endAt > 1440 && end
        ? {
            until: {
              date: end[1],
              minutes: Number(end[2]) * 60 + Number(end[3]),
            },
          }
        : {}),
    });
  }

  return out;
}

const order = (a: Segment, b: Segment) =>
  Number(b.allDay) - Number(a.allDay) ||
  a.startMin - b.startMin ||
  a.endMin - b.endMin ||
  a.event.title.localeCompare(b.event.title) ||
  a.event.subject.localeCompare(b.event.subject);

export interface AgendaDay {
  date: string;
  items: Segment[];
}

/**
 * The Agenda: one entry per day from `from`, `days` long, each with its
 * events in display order (all-day first, then by start time). Days without
 * events are kept, so the view can say "No events".
 */
export function agendaDays(
  events: CalEvent[],
  from: string,
  days: number,
): AgendaDay[] {
  const byDay = new Map<string, Segment[]>();
  for (let i = 0; i < days; i++) byDay.set(addDays(from, i), []);

  for (const event of events)
    for (const segment of segments(event, from, days))
      byDay.get(segment.date)!.push(segment);

  return [...byDay].map(([date, items]) => ({
    date,
    items: items.sort(order),
  }));
}

export interface Bar {
  event: CalEvent;
  /** Column index of the first day shown, 0-based. */
  col: number;
  /** Number of columns spanned. */
  span: number;
  /** Row in the all-day area, 0-based. */
  row: number;
}

export interface Block {
  segment: Segment;
  /** Lane within its overlap cluster, 0-based, and how many lanes the cluster has. */
  lane: number;
  lanes: number;
  /** Index of its overlap cluster within the column. */
  cluster: number;
}

export interface WeekLayout {
  days: string[];
  bars: Bar[];
  /** How many all-day rows are used. */
  rows: number;
  columns: Block[][];
}

/**
 * The Week: all-day bars spanning columns (exclusive end), and per day the
 * timed blocks packed into lanes so overlapping events split the column.
 */
export function packWeek(
  events: CalEvent[],
  from: string,
  count: number,
): WeekLayout {
  const days = Array.from({ length: count }, (_, i) => addDays(from, i));
  const barSegs = new Map<string, Segment[]>();
  const perDay: Segment[][] = days.map(() => []);

  for (const event of events)
    for (const segment of segments(event, from, count)) {
      if (segment.allDay) {
        const list = barSegs.get(event.subject) ?? [];
        list.push(segment);
        barSegs.set(event.subject, list);
      } else perDay[days.indexOf(segment.date)].push(segment);
    }

  // Consecutive all-day days of one event become one bar.
  const pending: Array<Omit<Bar, 'row'>> = [];

  for (const list of barSegs.values()) {
    let current: Omit<Bar, 'row'> | undefined;

    for (const segment of list) {
      const col = days.indexOf(segment.date);

      if (current && current.col + current.span === col) current.span++;
      else {
        current = { event: segment.event, col, span: 1 };
        pending.push(current);
      }
    }
  }

  pending.sort(
    (a, b) =>
      a.col - b.col ||
      b.span - a.span ||
      a.event.title.localeCompare(b.event.title),
  );
  const occupied: boolean[][] = [];
  const bars: Bar[] = pending.map(bar => {
    let row = 0;

    for (; ; row++) {
      occupied[row] ??= [];
      const cells = occupied[row];
      let free = true;
      for (let c = bar.col; c < bar.col + bar.span; c++)
        if (cells[c]) free = false;
      if (!free) continue;
      for (let c = bar.col; c < bar.col + bar.span; c++) cells[c] = true;
      break;
    }

    return { ...bar, row };
  });

  const columns = perDay.map(list => packColumn(list.sort(order)));

  return { days, bars, rows: occupied.length, columns };
}

/** Greedy lane packing within clusters of transitively overlapping blocks. */
function packColumn(sorted: Segment[]): Block[] {
  const out: Block[] = [];
  let cluster: Block[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  let clusters = 0;

  const close = () => {
    for (const block of cluster) block.lanes = laneEnds.length;
    out.push(...cluster);
    clusters++;
    cluster = [];
    laneEnds = [];
  };

  for (const segment of sorted) {
    if (cluster.length && segment.startMin >= clusterEnd) {
      close();
      clusterEnd = -1;
    }

    let lane = laneEnds.findIndex(end => end <= segment.startMin);
    if (lane < 0) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = segment.endMin;
    cluster.push({ segment, lane, lanes: 0, cluster: clusters });
    clusterEnd = Math.max(clusterEnd, segment.endMin);
  }

  if (cluster.length) close();

  return out;
}

/**
 * Where `event` starts as the views draw it: its first day in the host view
 * and, for a timed event, the clock time on it. Undefined when the host view
 * draws it nowhere.
 */
function placed(event: CalEvent): { date: string; at: number } | undefined {
  const date = firstDay(event);
  if (date === undefined) return undefined;
  const time = event.allDay ? undefined : clock(event);

  return {
    date,
    at: Date.parse(`${date}T00:00:00Z`) + (time?.startMin ?? 0) * 60_000,
  };
}

/** The first event starting on or after `date`, for "Jump to next event". */
export function nextEvent(
  events: CalEvent[],
  after: string,
): { event: CalEvent; date: string } | undefined {
  let best: { event: CalEvent; date: string; at: number } | undefined;

  for (const event of events) {
    const p = placed(event);
    if (!p || p.date < after) continue;
    if (!best || p.at < best.at) best = { event, ...p };
  }

  return best && { event: best.event, date: best.date };
}

/** The last event starting before `date`, for "Jump to latest event" when
 * nothing comes later (user testing, 2026-09-28: every imported event was in
 * the past, and the week showed "No events this week" with nowhere to go). */
export function latestEvent(
  events: CalEvent[],
  before: string,
): { event: CalEvent; date: string } | undefined {
  let best: { event: CalEvent; date: string; at: number } | undefined;

  for (const event of events) {
    const p = placed(event);
    if (!p || p.date >= before) continue;
    if (!best || p.at > best.at) best = { event, ...p };
  }

  return best && { event: best.event, date: best.date };
}

/** Days in [from, from + days) that have at least one event, for the day strip's dots. */
export function busyDays(
  events: CalEvent[],
  from: string,
  days: number,
): Set<string> {
  const out = new Set<string>();
  for (const event of events)
    for (const s of segments(event, from, days)) out.add(s.date);

  return out;
}
