// @wc-ignore-file
/**
 * The Calendar app's table: one row per imported Google event, under the
 * app's own table, which is all a view may write.
 *
 * `adapter.ts` owns the Google side (paging, skip rules, three-way
 * reconciliation, minimal ETag-conditioned patches). This file only maps its
 * `Card`/`ConnectionState` onto rows:
 *
 * - The mapped fields are the shared `event-v1` class's (#177, `fields.ts`):
 *   Name (title), Location, Start, End, All day, Notes (Google's
 *   description), Day and End day, by their published subjects. They are
 *   read through `ontology-kit`'s strict resolver only. Start and End are
 *   the exact strings Google sent (`YYYY-MM-DD`, or a date-time with its UTC
 *   offset), never parsed into numbers or `Date`s for storage.
 * - All day, Day and End day have the host's shared calendar field
 *   shortnames (`calendarFields` in atomic-server
 *   `browser/lib/src/calendar-date.ts`: `atomic-calendar-all-day`, `-day`,
 *   `-end-day`), so the host table's own Calendar view (the app's Month)
 *   places the row, and spans an all-day range over its days. Day is the
 *   civil date of Start. End day
 *   follows the host's reading of it (`isAllDayOnDate`: start <= day < end):
 *   for an all-day event it is Google's exclusive end date, the day after the
 *   last day; for a timed event that ends on a later date it is that date,
 *   and a timed event within one day has none. Day and End day are derived
 *   on import and on local edits. Edited in the host (its table or its
 *   Calendar view), they are translated back into Start and End for review
 *   (`hostValue`); they are never sent as such. The app's own views place
 *   rows by them, as the host view does (`events.ts`).
 * - The binding lives on the row, not in a separate store: the Google event
 *   id, the ETag last read, and the baseline — the projection both sides
 *   last agreed on, as JSON text. These provider extras are Properties in
 *   the app's own ontology, declared on the App as `row-extras`
 *   (`adopt.ts`). The baseline is what lets a refresh tell a
 *   local edit from a Google edit, and report both-changed as a conflict
 *   instead of overwriting either (adapter.ts, `reconcileRecord`).
 *
 * Nothing is sent to Google here except from `send()`, and only edits a
 * preview planned, each conditioned on the ETag that preview read.
 */
import {
  applyEdit,
  endpoint,
  planEdit,
  preview,
  project,
  StaleEventError,
  type Card,
  type Edit,
  type Host,
  type Preview,
  type Projection,
} from '../adapter.js';
import {
  isCalendarDate,
  nextCalendarDate,
} from '../../../browser/lib/src/calendar-date.js';
import type { CalEvent } from './events.js';
import { EVENT, fields, SHARED, sharedValues } from './fields.js';
import { addDays, daysBetween } from './time.js';
import { relay, UncertainWriteError, type Relayed } from './relay.js';
import type {
  HostProxy,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';

const A = 'https://atomicdata.dev';

export const PARENT = `${A}/properties/parent`;
export const IS_A = `${A}/properties/isA`;
export const NAME = `${A}/properties/name`;
export const SHORTNAME = `${A}/properties/shortname`;
export const DESCRIPTION = `${A}/properties/description`;
export const DATATYPE = `${A}/properties/datatype`;
export const RECOMMENDS = `${A}/properties/recommends`;
export const REQUIRES = `${A}/properties/requires`;
export const PROPERTIES = `${A}/properties/properties`;
export const PROPERTY_CLASS = `${A}/classes/Property`;
export const CLASSTYPE = `${A}/properties/classtype`;
export const DEFAULT_ONTOLOGY = `${A}/ontology/server/property/default-ontology`;
const DT = `${A}/datatypes`;

interface Spec {
  name: string;
  datatype: string;
  description: string;
}

/**
 * The host's shared calendar field shortnames (`@tomic/lib`
 * `calendarFields`), which the `event-v1` properties carry. Its Calendar
 * view matches them by shortname, so only these names get all-day and
 * multi-day handling there.
 */
export const DAY = 'atomic-calendar-day';
export const ALL_DAY = 'atomic-calendar-all-day';
export const END_DAY = 'atomic-calendar-end-day';
export const NOTES = 'atomic-calendar-notes';

/**
 * The app's own Properties, by shortname: its provider extras. Created under
 * the app's ontology on first use. The first four are kept on each row, and
 * declared on the App as `row-extras` (`ROW_EXTRAS`); the last two on the
 * app's own table.
 */
export const SPECS: Record<string, Spec> = {
  'google-event-id': {
    name: 'Google event id',
    datatype: `${DT}/string`,
    description: 'The Google Calendar event this row is bound to.',
  },
  'google-etag': {
    name: 'Google ETag',
    datatype: `${DT}/string`,
    description: 'The event version last read from Google Calendar.',
  },
  'google-link': {
    name: 'Google Calendar link',
    datatype: `${DT}/string`,
    description:
      'The event’s page in Google Calendar (its htmlLink), as last read. Display only.',
  },
  'sync-baseline': {
    name: 'Sync baseline',
    datatype: `${DT}/string`,
    description:
      'JSON of the fields as both sides last agreed; tells local edits from Google edits.',
  },
  'google-calendar-id': {
    name: 'Google calendar id',
    datatype: `${DT}/string`,
    description: 'The one Google calendar this table imports (on the table).',
  },
  'google-calendar-meta': {
    name: 'Google calendar details',
    datatype: `${DT}/string`,
    description:
      'JSON of the imported calendar’s name, colour, access role and account, as Google listed them (on the table; display only).',
  },
};

/** What the app shows about the imported calendar; kept on the table. */
export interface CalendarMeta {
  summary: string;
  /** Google's `backgroundColor`, e.g. `#9fe1e7`. */
  color: string;
  accessRole: string;
  /** The account's e-mail address: the primary calendar's id. */
  account?: string;
}

/** The extras kept on rows: declared on the App as its `row-extras`. */
export const ROW_EXTRAS = [
  'google-event-id',
  'google-etag',
  'google-link',
  'sync-baseline',
] as const;

export const DEFAULT_COLOR = '#4986e7';

export const isReadOnly = (accessRole: string) =>
  accessRole === 'reader' || accessRole === 'freeBusyReader';

export type Props = Record<keyof typeof SPECS, string>;

export interface Layout {
  app: string;
  table: string;
  /** The table's row class: `event-v1` once the app adopted it (`adopt.ts`). */
  rowClass: string;
  /** The app's own ontology, where its provider extras are. */
  ontology: string;
  /** Whether the table is the app's own (under the App), not one it is a view of. */
  own: boolean;
}

const asList = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/**
 * Where the app's data is: the table the host hands it, and the app's own
 * ontology (the App's `default-ontology`, as `createApp` sets it; failing
 * that, the parent of a row class of the app's own, which is the same
 * ontology for an install `createApp` made).
 */
export async function layout(store: PluginStore): Promise<Layout> {
  const data = await store.getData();
  if (!data?.rowClass)
    throw new Error('This app has no table with a row class to sync into.');
  const app = await store.getApp();
  let ontology = (await store.getResource(app)).get(DEFAULT_ONTOLOGY);

  if (typeof ontology !== 'string' && data.rowClass !== EVENT)
    ontology = (await store.getResource(data.rowClass)).get(PARENT);
  if (typeof ontology !== 'string')
    throw new Error('This app has no ontology of its own to add fields to.');
  const table = await store.getResource(data.table);

  return {
    app,
    table: data.table,
    rowClass: data.rowClass,
    ontology,
    own: table.get(PARENT) === app,
  };
}

/** The existing Properties, by shortname; `create` adds the missing ones. */
export async function properties(
  store: PluginStore,
  where: Pick<Layout, 'ontology'>,
  create: boolean,
): Promise<Props | undefined> {
  const found = await existing(store, where);
  const missing = Object.keys(SPECS).filter(s => !found.has(s));
  if (missing.length && !create) return undefined;
  const created: string[] = [];

  for (const shortname of missing) {
    const spec = SPECS[shortname];
    const property = await store.newResource({
      parent: where.ontology,
      isA: [PROPERTY_CLASS],
      propVals: {
        [SHORTNAME]: shortname,
        [NAME]: spec.name,
        [DESCRIPTION]: spec.description,
        [DATATYPE]: spec.datatype,
      },
    });
    found.set(shortname, property.subject);
    created.push(property.subject);
  }

  if (created.length) {
    const ontology = await store.getResource(where.ontology);
    await ontology
      .set(PROPERTIES, [...asList(ontology.get(PROPERTIES)), ...created])
      .save();
  }

  return Object.fromEntries(
    Object.keys(SPECS).map(s => [s, found.get(s)!]),
  ) as Props;
}

/** Existing Properties by shortname, without creating any. */
export async function existing(
  store: PluginStore,
  where: Pick<Layout, 'ontology'>,
): Promise<Map<string, string>> {
  const ontology = await store.getResource(where.ontology);
  const found = new Map<string, string>();

  for (const subject of asList(ontology.get(PROPERTIES))) {
    const shortname = (await store.getResource(subject)).get(SHORTNAME);
    if (typeof shortname === 'string') found.set(shortname, subject);
  }

  return found;
}

function parseMeta(raw: JSONValue): CalendarMeta | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;

  try {
    const meta = JSON.parse(raw) as Partial<CalendarMeta>;
    if (typeof meta.summary !== 'string') return undefined;

    return {
      summary: meta.summary,
      color: typeof meta.color === 'string' ? meta.color : DEFAULT_COLOR,
      accessRole:
        typeof meta.accessRole === 'string' ? meta.accessRole : 'reader',
      ...(typeof meta.account === 'string' ? { account: meta.account } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The calendar this table imports, once chosen, and what was kept about it. */
export async function chosenCalendar(
  store: PluginStore,
): Promise<{ id: string; meta?: CalendarMeta } | undefined> {
  const where = await layout(store);
  const found = await existing(store, where);
  const idProp = found.get('google-calendar-id');
  if (!idProp) return undefined;
  const table = await store.getResource(where.table);
  const id = table.get(idProp);
  if (typeof id !== 'string' || !id) return undefined;
  const metaProp = found.get('google-calendar-meta');
  const meta = metaProp ? parseMeta(table.get(metaProp)) : undefined;

  return { id, ...(meta ? { meta } : {}) };
}

/** Binds the table to one calendar. A table never switches calendars. */
export async function chooseCalendar(
  store: PluginStore,
  calendar: {
    id: string;
    summary: string;
    backgroundColor?: string;
    accessRole?: string;
  },
  account?: string,
): Promise<CalendarMeta> {
  const where = await layout(store);
  const props = (await properties(store, where, true))!;
  const table = await store.getResource(where.table);
  const current = table.get(props['google-calendar-id']);
  if (typeof current === 'string' && current && current !== calendar.id)
    throw new Error(
      'This table already imports another calendar. Use a new Calendar app for a second one.',
    );
  const meta: CalendarMeta = {
    summary: calendar.summary,
    color: calendar.backgroundColor ?? DEFAULT_COLOR,
    accessRole: calendar.accessRole ?? 'reader',
    ...(account ? { account } : {}),
  };
  await table
    .set(props['google-calendar-id'], calendar.id)
    .set(props['google-calendar-meta'], JSON.stringify(meta))
    .set(NAME, calendar.summary)
    .save();

  return meta;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/**
 * The row as the adapter's projection, from its shared `event-v1` fields
 * (read through the resolver, `fields.ts`) and the app's own extras. For a
 * synced row, Start, End and All day come through `hostValue`, so an edit to
 * Day or End day made in the host is read, not overwritten. `reason` says
 * why the row's columns can't be turned into something Google can take; the
 * value is then the row's own Start and End.
 */
function cardOf(row: PluginResource, props: Props): Card & { reason?: string } {
  const id = row.get(props['google-event-id']);
  const bound = typeof id === 'string' && !!id;
  const shared = sharedValues(row.props);
  const own = {
    start: text(shared[SHARED.start]),
    end: text(shared[SHARED.end]),
    allDay: shared[SHARED.allDay] === true,
  };
  const when = bound
    ? hostValue(
        {
          ...own,
          day: shared[SHARED.day] as JSONValue,
          endDay: shared[SHARED.endDay] as JSONValue,
        },
        baselineOf(row, props),
      )
    : own;

  return {
    subject: row.subject,
    ...(bound ? { id } : {}),
    value: {
      title: text(shared[NAME]),
      description: text(shared[SHARED.notes]),
      location: text(shared[SHARED.location]),
      ...('reason' in when ? own : when),
    },
    ...('reason' in when ? { reason: when.reason } : {}),
  };
}

type When = Pick<Projection, 'start' | 'end' | 'allDay'>;

/**
 * The lens read backwards: what a synced row's Start, End, All day, Day and
 * End day columns ask Google for. The rows keep the host's format (Day, and
 * an exclusive End day for all-day events; `endDayOf`), and the host table
 * and its built-in Calendar view edit Day, End day and All day without
 * touching Start and End.
 *
 * - Day and End day agree with Start and End (as the app writes them): Start
 *   and End.
 * - Only Day, End day or All day differ from the baseline: Start and End
 *   are made from them, so Google shows the days the host view shows. All
 *   day: Day to End day (exclusive), or Day alone when End day is unset.
 *   Timed: Day with Start's clock time and offset; End moves by the same
 *   number of days, or to End day (Day when cleared) if End day was edited.
 * - Only Start or End differ from the baseline (Day and End day are then
 *   stale): Start and End, and the next write re-derives Day and End day.
 * - Both differ and disagree, or the host format has no Google equivalent
 *   (End day not after Day on an all-day row, All day turned off with no
 *   times to send): a reason, and the row is held back, not rewritten.
 *
 * Without a baseline, Start and End.
 */
export function hostValue(
  row: When & { day: JSONValue; endDay: JSONValue },
  baseline: Projection | null,
): When | { reason: string } {
  const own: When = { start: row.start, end: row.end, allDay: row.allDay };
  if (!baseline) return own;
  const day = typeof row.day === 'string' ? row.day : undefined;
  const endDay = typeof row.endDay === 'string' ? row.endDay : undefined;
  const startEdited = row.start !== baseline.start || row.end !== baseline.end;
  const allDayEdited = row.allDay !== baseline.allDay;
  const agrees = day === row.start.slice(0, 10) && endDay === endDayOf(own);
  if (agrees && (startEdited || !allDayEdited)) return own;
  // No Day (cleared, or a row an older version wrote without one): nothing
  // for Google in it; the next write of the row derives it again.
  if (day === undefined && !allDayEdited) return own;
  const baseEndDay = endDayOf(baseline);
  const dayEdited =
    day !== baseline.start.slice(0, 10) || endDay !== baseEndDay;

  if (startEdited)
    return dayEdited
      ? {
          reason:
            'Start or End and Day or End day were edited in the table and disagree; change the event with Edit in the app',
        }
      : own;

  if (!isCalendarDate(day))
    return { reason: 'Day must be a date (YYYY-MM-DD)' };
  if (endDay !== undefined && !isCalendarDate(endDay))
    return { reason: 'End day must be a date (YYYY-MM-DD)' };

  if (row.allDay) {
    if (endDay === undefined)
      return { start: day, end: nextCalendarDate(day), allDay: true };
    if (endDay <= day)
      return {
        reason:
          'End day must be after Day: for an all-day event it is the day after the last day',
      };

    return { start: day, end: endDay, allDay: true };
  }

  if (baseline.allDay)
    return {
      reason:
        'All day was turned off in the table, with no times to send; set the times with Edit in the app',
    };
  const startDate = row.start.slice(0, 10);
  const endDate =
    endDay !== baseEndDay
      ? (endDay ?? day)
      : addDays(row.end.slice(0, 10), daysBetween(startDate, day));

  return {
    start: `${day}${row.start.slice(10)}`,
    end: `${endDate}${row.end.slice(10)}`,
    allDay: false,
  };
}

function baselineOf(row: PluginResource, props: Props): Projection | null {
  const raw = row.get(props['sync-baseline']);
  if (typeof raw !== 'string' || !raw) return null;

  try {
    return JSON.parse(raw) as Projection;
  } catch {
    return null;
  }
}

/** Mirrors adapter.ts `validate()`, returning the reason instead of throwing. */
export function invalid(value: Projection): string | undefined {
  if (!value.title.trim()) return 'the title is empty';
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const dateTime = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/;
  const ok = (v: string) =>
    value.allDay
      ? date.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`))
      : dateTime.test(v) && Number.isFinite(Date.parse(v));
  if (!ok(value.start) || !ok(value.end))
    return value.allDay
      ? 'all-day Start and End must be YYYY-MM-DD'
      : 'Start and End need a date-time with a UTC offset';
  const at = (v: string) =>
    value.allDay ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v);
  if (at(value.end) <= at(value.start)) return 'End must be after Start';

  return undefined;
}

export interface Rows {
  props: Props;
  bound: Map<string, PluginResource>;
  /** Rows with no Google event id: made in the table, never sent. */
  localOnly: number;
  /** Bound rows whose local value can't be sent, with the reason. */
  invalid: Map<string, { title: string; reason: string }>;
  /** Columns the app doesn't map, with how many bound rows fill them. */
  unmapped: Array<{ column: string; rows: number }>;
}

const filled = (value: JSONValue) =>
  value !== undefined &&
  value !== null &&
  value !== '' &&
  !(Array.isArray(value) && !value.length);

/**
 * The table's columns (the row class's `requires` and `recommends`) that
 * the app neither writes nor sends: on `event-v1`, its Recurrence. Their
 * values stay on the rows; this only finds them, so the app can say they
 * aren't sent.
 */
async function otherColumns(
  store: PluginStore,
  where: Layout,
  props: Props,
): Promise<string[]> {
  const klass = await store.getResource(where.rowClass);
  const own = new Set<string>([
    NAME,
    ...Object.values(SHARED),
    ...Object.values(props as Record<string, string>),
  ]);

  return [
    ...new Set([
      ...asList(klass.get(REQUIRES)),
      ...asList(klass.get(RECOMMENDS)),
    ]),
  ].filter(subject => !own.has(subject));
}

async function readRows(
  store: PluginStore,
  where: Layout,
  props: Props,
): Promise<Rows> {
  const out: Rows = {
    props,
    bound: new Map(),
    localOnly: 0,
    invalid: new Map(),
    unmapped: [],
  };
  const others = await otherColumns(store, where, props);
  const counts = new Map(others.map(p => [p, 0]));

  for (const subject of await store.query({
    property: PARENT,
    value: where.table,
  })) {
    const row = await store.getResource(subject);
    const card = cardOf(row, props);

    if (!card.id) {
      out.localOnly++;
      continue;
    }

    out.bound.set(subject, row);
    for (const p of others)
      if (filled(row.get(p))) counts.set(p, counts.get(p)! + 1);
  }

  for (const [subject, rows] of counts) {
    if (!rows) continue;
    const column = await store.getResource(subject);
    const name = column.get(NAME) ?? column.get(SHORTNAME);
    out.unmapped.push({
      column: typeof name === 'string' && name ? name : subject,
      rows,
    });
  }

  return out;
}

/** The adapter's `Host` over the app's rows and the host's proxy calls. */
function host(
  proxy: HostProxy,
  connectionId: string,
  rows: Rows,
): Host & { rows: Rows; relayed: Relayed } {
  const relayed = relay(proxy, connectionId);
  const { props } = rows;

  return {
    rows,
    relayed,
    read: intent => relayed.read(intent),
    async cards() {
      const cards: Card[] = [];

      for (const row of rows.bound.values()) {
        const { reason: hostReason, ...card } = cardOf(row, props);
        const reason = hostReason ?? invalid(card.value);

        if (reason) {
          // Held back, not dropped: the baseline stands in for it, so the
          // row keeps its binding and nothing on either side changes.
          rows.invalid.set(row.subject, { title: card.value.title, reason });
          const baseline = baselineOf(row, props);
          if (baseline) cards.push({ ...card, value: baseline });
          continue;
        }

        cards.push(card);
      }

      return cards;
    },
    async state() {
      const records: Record<
        string,
        { local: string; baseline: Record<string, unknown> | null }
      > = {};

      for (const row of rows.bound.values()) {
        const id = row.get(props['google-event-id']) as string;
        records[id] = { local: row.subject, baseline: baselineOf(row, props) };
      }

      return { revision: 0, records, cursor: null };
    },
  };
}

export interface PendingEdit {
  edit: Edit;
  /** The ETag the preview read; the write is conditioned on it. */
  etag: string;
  title: string;
  /** Per changed field: what Google has now, and what would be sent. */
  fields: Array<{ field: string; before: string; after: string }>;
  /** What Google has now (Discard puts this back into the row). */
  remote: Projection;
  /** What would be sent. */
  desired: Projection;
}

/** Why an event is listed as a conflict, from `preview().conflicts`. */
export type ConflictKind =
  /** The same field changed here and in Google. */
  | 'both'
  /** Imported, then cancelled, made recurring or made inaccessible in Google. */
  | 'missing-remote'
  /** Bound to a row that is gone or bound to another row. */
  | 'missing-local';

export interface Conflict {
  subject?: string;
  id?: string;
  title: string;
  /** Field keys (`title`, `start`, …) for `both`; the adapter's reason otherwise. */
  fields: string[];
  kind: ConflictKind;
  local?: Projection;
  remote?: Projection;
  base?: Projection;
  etag?: string;
}

export interface ImportSummary {
  calendarId: string;
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  skipped: Preview['skipped'];
  /** Events Google returned that the app cannot map; see `Preview`. */
  unreadable: Preview['unreadable'];
  conflicts: Conflict[];
  localOnly: number;
  invalid: Array<{ title: string; reason: string }>;
  /** Columns a person added that the app doesn't send, with how many synced rows fill them. */
  unmapped: Array<{ column: string; rows: number }>;
  review: PendingEdit[];
}

export const LABELS: Record<keyof Projection, string> = {
  title: 'Title',
  description: 'Description',
  location: 'Location',
  start: 'Start',
  end: 'End',
  allDay: 'All day',
};

function fieldsOf(before: Projection, after: Projection) {
  return (Object.keys(LABELS) as Array<keyof Projection>)
    .filter(k => before[k] !== after[k])
    .map(k => ({
      field: LABELS[k],
      before: String(before[k]),
      after: String(after[k]),
    }));
}

/**
 * The host Calendar view's End day for `value` (see the file comment), or
 * undefined when it has none. Exact strings: the date part of what Google
 * sent, never re-derived through a `Date`.
 */
export function endDayOf(value: When): string | undefined {
  const day = value.start.slice(0, 10);
  const end = value.end.slice(0, 10);
  if (value.allDay) return end;

  return end > day ? end : undefined;
}

/**
 * Row values for `value`, as shared `event-v1` fields (the resolver refuses
 * anything else); `undefined` means the property is removed.
 */
function valuesOf(value: Projection): Record<string, JSONValue> {
  return fields.write(
    {
      [NAME]: value.title,
      [SHARED.notes]: value.description,
      [SHARED.location]: value.location,
      [SHARED.start]: value.start,
      [SHARED.end]: value.end,
      [SHARED.allDay]: value.allDay,
      [SHARED.day]: value.start.slice(0, 10),
      [SHARED.endDay]: endDayOf(value),
    },
    EVENT,
  ) as Record<string, JSONValue>;
}

/** `valuesOf` without the removed properties, for a new row. */
function defined(values: Record<string, JSONValue>): Record<string, JSONValue> {
  return Object.fromEntries(
    Object.entries(values).filter(([, v]) => v !== undefined),
  );
}

function writeRow(
  row: PluginResource,
  props: Props,
  value: Projection,
): boolean {
  let changed = false;

  for (const [property, v] of Object.entries(valuesOf(value)))
    if (row.get(property) !== v) {
      if (v === undefined) row.remove(property);
      else row.set(property, v);
      changed = true;
    }

  return changed;
}

/**
 * Reads the whole calendar, reconciles it with the rows and applies the
 * inbound half: new events become rows, Google-side edits update rows that
 * were not edited here. Local edits are not sent; they come back as
 * `review`, to be approved and sent with `send()`. Conflicts leave both
 * sides as they are.
 */
export async function refresh(
  store: PluginStore,
  proxy: HostProxy,
  connectionId: string,
  options: {
    maxPages?: number;
    /** Called after each page of events is read, with the page count. */
    onPage?: (pages: number) => void;
  } = {},
): Promise<ImportSummary> {
  const where = await layout(store);
  const props = await properties(store, where, true);
  const table = await store.getResource(where.table);
  const calendarId = table.get(props!['google-calendar-id']);
  if (typeof calendarId !== 'string' || !calendarId)
    throw new Error('Choose a calendar first.');
  const rows = await readRows(store, where, props!);
  const h = host(proxy, connectionId, rows);
  let pages = 0;
  const read = h.read;

  h.read = async intent => {
    const receipt = await read(intent);
    if (intent.operation === 'list') options.onPage?.(++pages);

    return receipt;
  };

  const result = await withStatus(h.relayed, () =>
    preview(h, calendarId, { maxPages: options.maxPages }),
  );
  const titles = new Map(
    [...rows.bound.values()].map(r => [r.subject, text(r.get(NAME))]),
  );
  const summary: ImportSummary = {
    calendarId,
    total: result.changes.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    skipped: result.skipped,
    unreadable: result.unreadable,
    conflicts: result.conflicts.map(c => {
      const kind: ConflictKind = c.remote
        ? 'both'
        : /no deletion inferred/.test(c.fields[0] ?? '')
          ? 'missing-remote'
          : 'missing-local';

      return {
        ...(c.subject ? { subject: c.subject } : {}),
        ...(c.id ? { id: c.id } : {}),
        title:
          (c.subject && titles.get(c.subject)) ||
          c.remote?.title ||
          c.id ||
          '(untitled)',
        fields: c.fields,
        kind,
        ...(c.local ? { local: c.local } : {}),
        ...(c.remote ? { remote: c.remote } : {}),
        ...(c.base ? { base: c.base } : {}),
        ...(c.etag ? { etag: c.etag } : {}),
      };
    }),
    localOnly: rows.localOnly,
    invalid: [...rows.invalid.values()],
    unmapped: rows.unmapped,
    review: [],
  };

  for (const change of result.changes) {
    if (!change.id || !change.remote) continue;
    if (change.subject && rows.invalid.has(change.subject)) continue;
    const baseline = JSON.stringify(change.remote);

    if (!change.subject) {
      await store.newResource({
        parent: where.table,
        isA: [EVENT],
        propVals: {
          ...defined(valuesOf(change.desired)),
          [props!['google-event-id']]: change.id,
          [props!['google-etag']]: change.etag ?? '',
          [props!['sync-baseline']]: baseline,
          ...(change.link ? { [props!['google-link']]: change.link } : {}),
        },
      });
      summary.added++;
      continue;
    }

    const row = rows.bound.get(change.subject)!;
    const updated = writeRow(row, props!, change.desired);
    const link = change.link ?? '';
    const bookkeeping =
      row.get(props!['google-etag']) !== (change.etag ?? '') ||
      row.get(props!['sync-baseline']) !== baseline ||
      (row.get(props!['google-link']) ?? '') !== link;
    if (bookkeeping)
      row
        .set(props!['google-etag'], change.etag ?? '')
        .set(props!['sync-baseline'], baseline)
        .set(props!['google-link'], link);
    if (updated || bookkeeping) await row.save();
    if (updated) summary.updated++;
    else summary.unchanged++;

    const edit = planEdit(
      change.id,
      change.desired,
      change.remote,
      change.subject,
    );
    if (edit && change.etag)
      summary.review.push({
        edit,
        etag: change.etag,
        title: change.remote.title,
        fields: fieldsOf(change.remote, change.desired),
        remote: change.remote,
        desired: change.desired,
      });
  }

  return summary;
}

export type Outcome =
  | { status: 'sent'; title: string }
  /** Google answered 412: the event changed after the preview. */
  | { status: 'stale'; title: string }
  /** The call threw: Google may or may not have the change. */
  | { status: 'uncertain'; title: string; message: string }
  | { status: 'failed'; title: string; message: string }
  /** Not attempted, because an earlier write's outcome was unknown. */
  | { status: 'not-sent'; title: string };

/**
 * Sends reviewed edits one by one, each a PATCH of only the changed fields,
 * with `If-Match` set to the ETag its preview read. A 412 or a refusal
 * affects only that event. An uncertain outcome (the call threw, so it may
 * have reached Google) stops the batch; the next preview reads what Google
 * has. The baseline advances only for events Google confirmed.
 */
export async function send(
  store: PluginStore,
  proxy: HostProxy,
  connectionId: string,
  calendarId: string,
  review: PendingEdit[],
  progress?: (index: number, outcome?: Outcome) => void,
): Promise<Outcome[]> {
  const where = await layout(store);
  const props = (await properties(store, where, false))!;
  const h = relay(proxy, connectionId);
  const root = endpoint(calendarId);
  const outcomes: Outcome[] = [];
  let stop = false;

  for (const pending of review) {
    const { title } = pending;

    if (stop) {
      outcomes.push({ status: 'not-sent', title });
      progress?.(outcomes.length - 1, outcomes.at(-1));
      continue;
    }

    progress?.(outcomes.length);

    try {
      const event = await applyEdit(
        { read: h.read, cards: async () => [], state: async () => never() },
        root,
        pending.edit,
        pending.etag,
      );
      const projection = project(event);

      if (pending.edit.subject && projection) {
        const row = await store.getResource(pending.edit.subject);
        // An edit made in the host's format (Day, End day, All day) was
        // sent as Start and End: write those back, so the row agrees with
        // its new baseline. Unless the row changed again since the review;
        // then the next preview lists that change.
        const now = cardOf(row, props);
        if (
          !now.reason &&
          (Object.keys(LABELS) as Array<keyof Projection>).every(
            k => now.value[k] === pending.desired[k],
          )
        )
          writeRow(row, props, projection);
        await row
          .set(props['google-etag'], event.etag)
          .set(props['sync-baseline'], JSON.stringify(projection))
          .save();
      }

      outcomes.push({ status: 'sent', title });
    } catch (error) {
      if (error instanceof StaleEventError)
        outcomes.push({ status: 'stale', title });
      else if (error instanceof UncertainWriteError) {
        outcomes.push({ status: 'uncertain', title, message: error.message });
        stop = true;
      } else
        outcomes.push({
          status: 'failed',
          title,
          message: error instanceof Error ? error.message : String(error),
        });
    }

    progress?.(outcomes.length - 1, outcomes.at(-1));
  }

  return outcomes;
}

/**
 * Runs a read and, when it fails on a provider status, attaches that status
 * and the `retry-after` header to the error, so the view can say what went
 * wrong (401 reconnect, 429 wait) without parsing the adapter's message.
 */
async function withStatus<T>(
  relayed: Relayed,
  op: () => Promise<T>,
): Promise<T> {
  try {
    return await op();
  } catch (error) {
    const last = relayed.last;
    // Only Google's own answers (the adapter's "returned NNN"); a refusal
    // from the relay or the proxy keeps its own meaning, e.g. "Connect again".
    if (
      error instanceof Error &&
      /Google Calendar returned \d{3}\b/.test(error.message) &&
      last &&
      last.status >= 400
    )
      Object.assign(error, {
        status: last.status,
        ...(last.headers?.['retry-after']
          ? { retryAfter: last.headers['retry-after'] }
          : {}),
        ...(typeof last.body === 'object' && last.body
          ? { detail: JSON.stringify(last.body) }
          : typeof last.body === 'string' && last.body
            ? { detail: last.body }
            : {}),
      });
    throw error;
  }
}

/** The rows as the views draw them. */
export async function readEvents(
  store: PluginStore,
  meta: CalendarMeta,
  conflicts: Conflict[] = [],
): Promise<CalEvent[]> {
  const where = await layout(store);
  // Creates a Property an older install lacks (as a refresh would).
  const props = (await properties(store, where, true))!;
  const inConflict = new Set(conflicts.map(c => c.subject));
  const out: CalEvent[] = [];
  const readOnly = isReadOnly(meta.accessRole);

  for (const subject of await store.query({
    property: PARENT,
    value: where.table,
  })) {
    const row = await store.getResource(subject);
    const card = cardOf(row, props);
    const shared = sharedValues(row.props);
    const baseline = baselineOf(row, props);
    const link = row.get(props['google-link']);

    out.push({
      ...card.value,
      subject,
      ...(card.id ? { id: card.id } : {}),
      ...(baseline ? { baseline } : {}),
      ...(typeof link === 'string' && /^https:\/\//.test(link) ? { link } : {}),
      pending:
        !!card.id &&
        !!baseline &&
        (!!card.reason ||
          (Object.keys(LABELS) as Array<keyof Projection>).some(
            k => baseline[k] !== card.value[k],
          )),
      conflict: inConflict.has(subject),
      readOnly: readOnly || !card.id,
      calendar: { name: meta.summary, color: meta.color },
      // What the host's Calendar view places the row by; the views do too.
      day: shared[SHARED.day],
      endDay: shared[SHARED.endDay],
    });
  }

  return out;
}

/** Stores what the calendar list says about the imported calendar. */
export async function saveMeta(
  store: PluginStore,
  meta: CalendarMeta,
): Promise<void> {
  const where = await layout(store);
  const props = (await properties(store, where, true))!;
  await (
    await store.getResource(where.table)
  )
    .set(props['google-calendar-meta'], JSON.stringify(meta))
    .save();
}

/**
 * A local edit from the event drawer: the six mapped fields (and Day and
 * End day),
 * stored as exact strings. Nothing is sent; the next preview lists it for
 * review because the row now differs from its baseline.
 */
export async function saveLocal(
  store: PluginStore,
  subject: string,
  value: Projection,
): Promise<void> {
  const where = await layout(store);
  const props = (await properties(store, where, true))!;
  const row = await store.getResource(subject);
  if (writeRow(row, props, value)) await row.save();
}

/** Discard in the review sheet: the row takes Google's current value again. */
export async function discard(
  store: PluginStore,
  pending: PendingEdit,
): Promise<void> {
  if (!pending.edit.subject) return;
  const where = await layout(store);
  const props = (await properties(store, where, true))!;
  const row = await store.getResource(pending.edit.subject);
  writeRow(row, props, pending.remote);
  await row
    .set(props['google-etag'], pending.etag)
    .set(props['sync-baseline'], JSON.stringify(pending.remote))
    .save();
}

export type Choice = 'mine' | 'google';

/**
 * Resolves a both-changed conflict field by field. "Use Google's" takes
 * Google's value; "Keep mine" keeps the row's. The baseline becomes what
 * Google has now, so a kept field is a local edit the next preview lists for
 * review: nothing is sent from here.
 */
export async function resolveConflict(
  store: PluginStore,
  conflict: Conflict,
  choices: Partial<Record<keyof Projection, Choice>>,
): Promise<void> {
  const { subject, local, remote, base } = conflict;
  if (conflict.kind !== 'both' || !subject || !local || !remote)
    throw new Error('Only a both-changed conflict can be resolved per field.');
  const keys = Object.keys(LABELS) as Array<keyof Projection>;

  for (const field of conflict.fields)
    if (!choices[field as keyof Projection])
      throw new Error(`Choose a value for ${field}.`);

  const merged = Object.fromEntries(
    keys.map(k => {
      const choice = choices[k];
      if (choice) return [k, choice === 'mine' ? local[k] : remote[k]];
      // Not in conflict: keep a local-only edit, otherwise take Google's.
      const editedHere = base ? base[k] !== local[k] : false;

      return [k, editedHere ? local[k] : remote[k]];
    }),
  ) as Projection;
  // Start and end move together with all-day; a mixed pick is invalid.
  const reason = invalid(merged);
  if (reason) throw new Error(`That combination can’t be saved: ${reason}.`);
  const where = await layout(store);
  const props = (await properties(store, where, true))!;
  const row = await store.getResource(subject);
  writeRow(row, props, merged);
  row
    .set(props['sync-baseline'], JSON.stringify(remote))
    .set(props['google-etag'], conflict.etag ?? '');
  await row.save();
}

/**
 * "Keep as local event": the row stops being bound to the Google event that
 * is gone, and is counted as made here from now on. Nothing is deleted.
 */
export async function keepAsLocal(
  store: PluginStore,
  subject: string,
): Promise<void> {
  const where = await layout(store);
  const props = (await properties(store, where, true))!;
  await (
    await store.getResource(subject)
  )
    .remove(props['google-event-id'])
    .remove(props['google-etag'])
    .remove(props['sync-baseline'])
    .save();
}

/** The table's name, as the host shows it. */
export async function tableName(store: PluginStore): Promise<string> {
  const name = (await store.getResource((await layout(store)).table)).get(NAME);

  return typeof name === 'string' && name ? name : 'Events';
}

/** The app's table, for handing off to the host's own views. */
export async function tableOf(store: PluginStore): Promise<string> {
  return (await layout(store)).table;
}

/** "Remove local copy": the only delete path, and it is local. */
export async function removeLocal(
  store: PluginStore,
  subject: string,
): Promise<void> {
  await (await store.getResource(subject)).destroy();
}

function never(): never {
  throw new Error('applyEdit does not read connection state');
}
