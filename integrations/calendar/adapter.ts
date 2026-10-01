// @wc-ignore-file
/** Google Calendar-specific mapping; the host owns credentials, effects and persistence. */
import {
  reconcileRecord,
  type SyncRecord,
} from '../../browser/lib/src/plugin-reconcile.js';
import type {
  ConnectionState,
  ExternalIntent,
  ExternalReceipt,
} from '../../browser/lib/src/plugin-connection.js';

export interface EventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}
export interface Event {
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  start: EventTime;
  end: EventTime;
  recurrence?: string[];
  recurringEventId?: string;
  etag: string;
  /** Google Calendar's web page for the event. */
  htmlLink?: string;
}
export type Projection = {
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
};
export interface Card {
  subject: string;
  id?: string;
  value: Projection;
}
export interface Host {
  read(intent: ExternalIntent): Promise<ExternalReceipt>;
  cards(): Promise<Card[]>;
  state(): Promise<ConnectionState>;
}

export interface Change {
  subject?: string;
  id?: string;
  local?: Projection;
  remote?: Projection;
  desired: Projection;
  /** The event's ETag as read in this preview; an edit sent later is conditioned on it. */
  etag?: string;
  /** Google's `htmlLink` for the event (display only, never written back). */
  link?: string;
}
export interface Preview {
  calendarId: string;
  revision: number;
  changes: Change[];
  conflicts: Array<{
    subject?: string;
    id?: string;
    fields: string[];
    /** Both-changed conflicts only: the three sides, and the ETag read, so a
     * person can choose per field (the choice is sent later, reviewed). */
    local?: Projection;
    remote?: Projection;
    base?: Projection;
    etag?: string;
  }>;
  /** Events read but not imported, by reason. A cancelled instance of a
   * series counts as recurring. */
  skipped: { recurring: number; cancelled: number; unreadable: number };
  /** The events counted in `skipped.unreadable`: Google returned them with a
   * start/end this app cannot map. Listed with the raw values so a person (or
   * a log) can see what Google sent. Their rows, if any, are left as is. */
  unreadable: Array<{ id: string; title: string; reason: string }>;
}

/** An event whose start/end cannot be mapped. The preview skips and lists it
 * instead of failing the whole scan over one event. */
export class UnreadableEventError extends Error {}

/** Google answered a conditional write with 412: the event changed after the
 * preview that the edit was planned from. Nothing was written. */
export class StaleEventError extends Error {
  constructor(readonly id: string) {
    super('Google event changed after preview; preview again');
  }
}

/** 250 events per page; the default cap of 100 pages is 25,000 events. */
export const PAGE_SIZE = 250;
export const MAX_PAGES = 100;

/** The app never names a credential: the host's relay owns the connection
 * (app/relay.ts). `If-Match` is the only header that reaches the proxy. */
const headers = { 'Content-Type': 'application/json' };

function civilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);

  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

/** Google's own writes give an all-day event an exclusive end, the day after
 * its last day. Events with end == start exist too (seen in user testing,
 * 2026-09-28: all-day events written with an inclusive end), and Google
 * Calendar shows them as one day, so they are read as that one day. Any
 * write-back then sends the exclusive end. */
function allDayEnd(start: string, end: string): string {
  if (end !== start) return end;
  const next = new Date(Date.parse(`${start}T00:00:00Z`) + 86_400_000);

  return next.toISOString().slice(0, 10);
}

function offsetDateTime(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Series and instances are out of scope for this pilot; the host skips them
 * rather than mapping a partial view of a recurring event. Cancelled events
 * are skipped the same way, never treated as evidence of a completed sync. */
export function project(event: Event): Projection | undefined {
  if (event.recurrence?.length || event.recurringEventId) return undefined;
  if (event.status === 'cancelled') return undefined;
  if (typeof event.id !== 'string' || !event.id)
    throw new Error('Google returned an invalid event');
  const allDay = typeof event.start?.date === 'string';
  const raw = (time: EventTime | undefined) =>
    JSON.stringify(time?.date ?? time?.dateTime ?? null);
  const interval = () => `start ${raw(event.start)}, end ${raw(event.end)}`;

  if (!event.start || !event.end)
    throw new UnreadableEventError(
      `Calendar event ${event.id} has no start or end`,
    );

  if (allDay) {
    if (
      event.start.dateTime !== undefined ||
      event.end.dateTime !== undefined ||
      !event.start.date ||
      !civilDate(event.start.date) ||
      !event.end.date ||
      !civilDate(event.end.date) ||
      event.end.date < event.start.date
    )
      throw new UnreadableEventError(
        `Calendar event ${event.id} has an invalid all-day interval (${interval()})`,
      );
  } else {
    if (
      event.start.date !== undefined ||
      event.end.date !== undefined ||
      typeof event.start.dateTime !== 'string' ||
      !offsetDateTime(event.start.dateTime) ||
      typeof event.end.dateTime !== 'string' ||
      !offsetDateTime(event.end.dateTime) ||
      Date.parse(event.end.dateTime) <= Date.parse(event.start.dateTime)
    )
      throw new UnreadableEventError(
        `Calendar event ${event.id} has an invalid timed interval (${interval()})`,
      );
  }

  return {
    title: event.summary ?? '',
    description: event.description ?? '',
    location: event.location ?? '',
    start: allDay ? event.start.date! : event.start.dateTime!,
    end: allDay
      ? allDayEnd(event.start.date!, event.end.date!)
      : event.end.dateTime!,
    allDay,
  };
}

function validate(value: Projection) {
  if (typeof value.title !== 'string' || !value.title.trim())
    throw new Error('Events require a non-empty title');
  if (
    typeof value.description !== 'string' ||
    typeof value.location !== 'string'
  )
    throw new Error('Description and location must be text');
  if (typeof value.allDay !== 'boolean')
    throw new Error('allDay must be a boolean');
  const valid = value.allDay ? civilDate : offsetDateTime;
  if (!valid(value.start) || !valid(value.end))
    throw new Error(
      value.allDay
        ? 'All-day events need plain YYYY-MM-DD dates'
        : 'Timed events need an explicit UTC offset',
    );
  const parseDate = (d: string) =>
    value.allDay ? Date.parse(`${d}T00:00:00Z`) : Date.parse(d);
  if (parseDate(value.end) <= parseDate(value.start))
    throw new Error('Event end must follow its start');
}

export function endpoint(calendarId: string): string {
  if (
    !calendarId ||
    /[/?#]/.test(calendarId) ||
    ['.', '..'].includes(calendarId)
  )
    throw new Error('Calendar id must not contain path separators');

  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

function parse<T>(response: ExternalReceipt): T {
  if (response.status < 200 || response.status >= 300)
    throw new Error(
      `Google Calendar returned ${response.status}; no checkpoint was advanced. Resolve access/reconnect before retrying.`,
    );

  return JSON.parse(response.body) as T;
}

export function request(
  operation: string,
  method: string,
  url: string,
  id: string,
  body?: unknown,
  ifMatch?: string,
): ExternalIntent {
  return {
    operation,
    method,
    url,
    id,
    headers: ifMatch ? { ...headers, 'If-Match': ifMatch } : headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}
/** Full scans avoid interpreting a partial page as deletion. A pilot cap fails loudly. */
export async function preview(
  host: Host,
  calendarId: string,
  { maxPages = MAX_PAGES }: { maxPages?: number } = {},
): Promise<Preview> {
  const root = endpoint(calendarId);
  const state = await host.state();
  if (state.cursor)
    throw new Error(
      'A saved sync is pending; resume it before previewing another run',
    );
  const events = new Map<string, Projection>();
  const etags = new Map<string, string>();
  const links = new Map<string, string>();
  const skipped = { recurring: 0, cancelled: 0, unreadable: 0 };
  const unreadable: Preview['unreadable'] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    if (++pages > maxPages)
      throw new Error(
        `Pilot supports at most ${String(maxPages * PAGE_SIZE).replace(/\B(?=(\d{3})+$)/g, ',')} events per scan`,
      );
    const url = `${root}?singleEvents=false&showDeleted=true&maxResults=${PAGE_SIZE}${
      pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    }`;
    const page = parse<{ items: Event[]; nextPageToken?: string }>(
      await host.read(request('list', 'GET', url, `page-${pages}`)),
    );
    if (!Array.isArray(page.items))
      throw new Error('Google Calendar event page must include an items array');

    for (const event of page.items) {
      let projection: Projection | undefined;

      try {
        projection = project(event);
      } catch (error) {
        if (!(error instanceof UnreadableEventError)) throw error;
        // Not added to `events`, so a row bound to it becomes a "no deletion
        // inferred" conflict below, never a deletion.
        skipped.unreadable++;
        unreadable.push({
          id: event.id,
          title: event.summary ?? '',
          reason: error.message,
        });
        continue;
      }

      if (projection) {
        events.set(event.id, projection);
        if (typeof event.etag === 'string') etags.set(event.id, event.etag);
        if (
          typeof event.htmlLink === 'string' &&
          /^https:\/\//.test(event.htmlLink)
        )
          links.set(event.id, event.htmlLink);
      } else if (event.recurrence?.length || event.recurringEventId)
        skipped.recurring++;
      else skipped.cancelled++;
    }

    pageToken = page.nextPageToken;
  } while (pageToken);

  const cards = await host.cards();
  const byId = new Map<string, Card>();

  for (const card of cards) {
    validate(card.value);

    if (card.id !== undefined) {
      if (byId.has(card.id))
        throw new Error(`Duplicate cards for event ${card.id}`);
      byId.set(card.id, card);
    }
  }

  const result: Preview = {
    calendarId,
    revision: state.revision,
    changes: [],
    conflicts: [],
    skipped,
    unreadable,
  };

  for (const [id, remote] of events) {
    const binding = state.records[id];
    const card = byId.get(id);

    if (binding && (!card || binding.local !== card.subject)) {
      result.conflicts.push({
        ...(binding.local ? { subject: binding.local } : {}),
        id,
        fields: ['Missing or rebound local card'],
      });
      continue;
    }

    const decision = reconcileRecord(
      binding?.baseline as SyncRecord,
      card?.value,
      remote,
    );

    if (decision.conflicts.length) {
      result.conflicts.push({
        subject: card?.subject,
        id,
        fields: decision.conflicts.map(c => c.property),
        ...(card ? { local: card.value } : {}),
        remote,
        ...(binding?.baseline
          ? { base: binding.baseline as unknown as Projection }
          : {}),
        ...(etags.has(id) ? { etag: etags.get(id) } : {}),
      });
      continue;
    }

    const desired = { ...remote, ...decision.remote } as Projection;
    validate(desired);
    // Include unchanged records so their identity/baseline is established on first import.
    result.changes.push({
      subject: card?.subject,
      id,
      local: card?.value,
      remote,
      desired,
      etag: etags.get(id),
      ...(links.has(id) ? { link: links.get(id) } : {}),
    });
  }

  for (const card of cards) {
    if (card.id === undefined)
      result.changes.push({
        subject: card.subject,
        local: card.value,
        desired: card.value,
      });
    else if (!events.has(card.id))
      result.conflicts.push({
        subject: card.subject,
        id: card.id,
        fields: [
          'Event cancelled, recurring or inaccessible; no deletion inferred',
        ],
      });
  }

  return result;
}

export interface Edit {
  id: string;
  subject?: string;
  patch: Partial<{
    summary: string;
    description: string;
    location: string;
    start: EventTime;
    end: EventTime;
  }>;
}

function eventTime(value: string, allDay: boolean): EventTime {
  return allDay ? { date: value } : { dateTime: value };
}

/** Only the fields a title/description/location/start/end edit actually
 * touches; never a full event replacement. */
export function planEdit(
  id: string,
  desired: Projection,
  remote: Projection,
  subject?: string,
): Edit | undefined {
  const patch: Edit['patch'] = {};
  if (desired.title !== remote.title) patch.summary = desired.title;
  if (desired.description !== remote.description)
    patch.description = desired.description;
  if (desired.location !== remote.location) patch.location = desired.location;
  if (desired.start !== remote.start || desired.allDay !== remote.allDay)
    patch.start = eventTime(desired.start, desired.allDay);
  if (desired.end !== remote.end || desired.allDay !== remote.allDay)
    patch.end = eventTime(desired.end, desired.allDay);
  if (!Object.keys(patch).length) return undefined;

  return { id, subject, patch };
}
/** Conditions the write on the ETag captured at preview time so a change to
 * the event in Google since then fails loudly instead of being overwritten. */
export async function applyEdit(
  host: Host,
  root: string,
  edit: Edit,
  etag: string,
): Promise<Event> {
  const response = await host.read(
    request(
      'update',
      'PATCH',
      `${root}/${encodeURIComponent(edit.id)}?sendUpdates=none`,
      'write',
      edit.patch,
      etag,
    ),
  );
  if (response.status === 412) throw new StaleEventError(edit.id);

  return parse<Event>(response);
}
