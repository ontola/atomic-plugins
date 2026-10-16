// @wc-ignore-file
/**
 * Moneybird time entries as rows of the shared `time-entry-v1` class
 * (ontola/atomic-plugins#177; ontology-kit/source.json), so the Clockify
 * timesheets app's week grid, or any other view of that class, shows them.
 *
 * Shared fields, by their published subjects: `name` (the description),
 * `work-start` and `work-end` (Moneybird's `started_at`/`ended_at`, as
 * milliseconds since the epoch, the class's `timestamp` datatype),
 * `work-billable`, and `work-project`/`work-person` as links to rows of the
 * app's own Projects and People tables (classes `work-project-v1` and
 * `work-person-v1`), made from the `project` and `user` objects each entry
 * embeds, so no extra read is needed. The app's own extras on a row:
 * `moneybird-source-id` (identity), `moneybird-updated-at`, and
 * `moneybird-paused-duration` (Moneybird's `paused_duration`, seconds): the
 * Start–End span includes paused time; the class has no field for it.
 *
 * Not imported: the entry's contact, sales invoice, notes and events.
 */
import { classes, properties } from '../../../ontology-kit/terms.mjs';
import type { ContactField } from './contacts.js';
import { identifier, type TimeEntry } from './read.js';

export const TIME_ENTRY = classes['time-entry-v1'].subject;
export const WORK_PROJECT = classes['work-project-v1'].subject;
export const WORK_PERSON = classes['work-person-v1'].subject;

/** The shared fields this import writes, by their published subjects. */
export const WORK = {
  start: properties['work-start'].subject,
  end: properties['work-end'].subject,
  project: properties['work-project'].subject,
  person: properties['work-person'].subject,
  billable: properties['work-billable'].subject,
} as const;

export const PAUSED_DURATION: ContactField = {
  key: 'paused_duration',
  shortname: 'moneybird-paused-duration',
  name: 'Paused (seconds)',
  description:
    'Seconds the Moneybird timer was paused within this entry; the Start–End span includes them.',
  datatype: 'https://atomicdata.dev/datatypes/integer',
};

export interface HourRow {
  /** `moneybird:<administration>:time_entry:<id>` */
  identity: string;
  name: string;
  /** Milliseconds since the epoch. */
  start: number;
  end?: number;
  billable?: boolean;
  project?: { id: string; name: string };
  person?: { id: string; name: string };
  paused?: number;
  updatedAt?: string;
}

export const hourSourceId = (administrationId: string, id: string) =>
  `moneybird:${administrationId}:time_entry:${id}`;
export const projectSourceId = (administrationId: string, id: string) =>
  `moneybird:${administrationId}:project:${id}`;
export const personSourceId = (administrationId: string, id: string) =>
  `moneybird:${administrationId}:user:${id}`;

/** An RFC 3339 instant as epoch milliseconds, or undefined when it isn't one. */
export function instant(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);

  return Number.isFinite(ms) ? ms : undefined;
}

/** `{ id, name }` of an embedded project or user object, when it has an id. */
function linked(
  value: unknown,
  fallback: string,
): { id: string; name: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const id = identifier(record.id);
  if (!id) return undefined;
  const name =
    typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : `${fallback} ${id}`;

  return { id, name };
}

/** The entry as the person knows it: its description, else "Time entry <id>". */
export function hourLabel(entry: TimeEntry): string {
  const description =
    typeof entry.description === 'string' ? entry.description.trim() : '';

  return description || `Time entry ${entry.id}`;
}

/**
 * Why `hourOf` leaves an entry out, completing "<n> time entries …" on the
 * sync-status card; `undefined` for one it imports.
 */
export function hourSkipReason(entry: TimeEntry): string | undefined {
  return instant(entry.started_at) === undefined
    ? 'without a readable start (started_at) in Moneybird: not imported.'
    : undefined;
}

/**
 * The row for one time entry, or `undefined` for one without a readable
 * `started_at` (`hourSkipReason`): the class requires a start, and the host
 * refuses a row without one, so such an entry is counted as skipped, not
 * written.
 */
export function hourOf(
  entry: TimeEntry,
  administrationId: string,
): HourRow | undefined {
  const start = instant(entry.started_at);
  if (start === undefined) return undefined;
  const end = instant(entry.ended_at);
  const row: HourRow = {
    identity: hourSourceId(administrationId, entry.id),
    name: hourLabel(entry),
    start,
  };
  if (end !== undefined) row.end = end;
  if (typeof entry.billable === 'boolean') row.billable = entry.billable;
  const project = linked(entry.project, 'Moneybird project');
  if (project) row.project = project;
  const person = linked(entry.user, 'Moneybird user');
  if (person) row.person = person;
  if (
    typeof entry.paused_duration === 'number' &&
    Number.isSafeInteger(entry.paused_duration) &&
    entry.paused_duration > 0
  )
    row.paused = entry.paused_duration;
  if (typeof entry.updated_at === 'string' && entry.updated_at)
    row.updatedAt = entry.updated_at;

  return row;
}
