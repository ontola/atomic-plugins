// @wc-ignore-file
/**
 * The Clockify lens's write direction (#123 M3, #177 §4): the two halves of
 * a bidirectional lens over one time entry.
 *
 * - **get** (`entryValues`): a Clockify entry → the values a table row
 *   holds (Name, Start, End, Billable, project id and name). The same
 *   mapping `clockifyProjection` makes for import, reduced to what can be
 *   written back.
 * - **put** (`putBody`): the entry as Clockify last returned it, plus the
 *   row values someone wants → the body of a full-replacement `PUT`.
 *   Clockify's `PUT` clears every field it is not sent (live check on #123),
 *   so the body starts from the full record and replaces only the fields
 *   that changed.
 *
 * `blockers` says why an entry or a wanted change cannot be written, before
 * anything is sent. Pure: no store, no network, no clock but the one passed
 * in. The three-way decision (what changed where) is not made here: that is
 * `reconcileRecord`, the sync engine's, over these values.
 */

/** A Clockify time entry as the API returns it; other fields pass through. */
export interface ClockifyTimeEntry {
  id: string;
  description?: string | null;
  billable?: boolean | null;
  projectId?: string | null;
  taskId?: string | null;
  tagIds?: string[] | null;
  type?: string | null;
  isLocked?: boolean | null;
  customFieldValues?: unknown;
  timeInterval: { start: string | null; end: string | null };
  [field: string]: unknown;
}

export interface ClockifyProject {
  id: string;
  name: string;
  archived?: boolean;
  [field: string]: unknown;
}

/**
 * What a row holds of one completed entry. Instants are epoch ms (exact:
 * Clockify keeps whole seconds). `project` is the project's name, for
 * display and for a name typed into the table; `projectId` is what is
 * written.
 */
export interface EntryValues {
  name: string;
  start: number;
  end: number;
  billable: boolean;
  projectId: string | null;
  project: string | null;
  [key: string]: string | number | boolean | null;
}

export type EntryField = 'name' | 'start' | 'end' | 'billable' | 'projectId';

/** The fields compared and written, in display order. */
export const ENTRY_FIELDS: readonly EntryField[] = [
  'name',
  'projectId',
  'billable',
  'start',
  'end',
];

/** The Name the import gives an entry without a description. */
export const NO_DESCRIPTION = 'Time entry';

const MINUTE = 60_000;

const instant = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const at = Date.parse(value);

  return Number.isFinite(at) ? at : undefined;
};

/** Clockify's form: whole seconds, `Z`. */
export const clockifyInstant = (at: number) =>
  new Date(Math.floor(at / 1000) * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

/**
 * get: the row values of a completed `REGULAR` entry, or undefined for a
 * running timer, a break (or holiday, time off) or an entry with no valid
 * interval: those have no row.
 */
export function entryValues(
  entry: ClockifyTimeEntry,
  projectName?: (id: string) => string | undefined,
): EntryValues | undefined {
  if ((entry.type ?? 'REGULAR') !== 'REGULAR') return undefined;
  const start = instant(entry.timeInterval?.start);
  const end = instant(entry.timeInterval?.end);
  if (start === undefined || end === undefined || end < start) return undefined;
  const description =
    typeof entry.description === 'string' ? entry.description.trim() : '';
  const projectId =
    typeof entry.projectId === 'string' && entry.projectId
      ? entry.projectId
      : null;

  return {
    name: description || NO_DESCRIPTION,
    start,
    end,
    billable: entry.billable === true,
    projectId,
    project: (projectId && projectName?.(projectId)) || null,
  };
}

/**
 * A row Name back to a description: `get` names an entry without one
 * `NO_DESCRIPTION`, so that Name (or an empty one) means none.
 */
export const descriptionOf = (name: string) => {
  const trimmed = name.trim();

  return trimmed === NO_DESCRIPTION ? '' : trimmed;
};

/** Fields whose values differ, in `ENTRY_FIELDS` order. */
export function changedFields(a: EntryValues, b: EntryValues): EntryField[] {
  return ENTRY_FIELDS.filter(k => a[k] !== b[k]);
}

/** Whole minutes, rounding down (#97 answer 7). */
export const snapToMinute = (at: number) => Math.floor(at / MINUTE) * MINUTE;

export interface WriteContext {
  /** Epoch ms; an entry may not be made to end after it. */
  now: number;
  /** The workspace requires a project on every entry. */
  forceProjects?: boolean;
  /** The workspace's projects as last read; unknown ids are refused. */
  projects: ClockifyProject[];
}

/**
 * Why `entry` cannot be written (and, with `desired`, why that change
 * cannot), as sentences for the view. Empty: it can be sent.
 */
export function blockers(
  entry: ClockifyTimeEntry,
  context: WriteContext,
  desired?: EntryValues,
): string[] {
  const reasons: string[] = [];
  const type = entry.type ?? 'REGULAR';

  if (!entry.timeInterval?.end)
    reasons.push('It is a running timer. Stop it in Clockify first.');
  if (type !== 'REGULAR')
    reasons.push(`It is a ${type.toLowerCase().replace('_', ' ')} entry.`);
  if (entry.isLocked === true) reasons.push('It is locked in Clockify.');
  if (Array.isArray(entry.customFieldValues) && entry.customFieldValues.length)
    reasons.push(
      'It has custom field values, which this app cannot write back yet.',
    );
  if (!desired) return reasons;

  if (!(desired.start < desired.end))
    reasons.push('Start has to be before end.');
  if (desired.end > context.now) reasons.push('End is in the future.');
  if (context.forceProjects && !desired.projectId)
    reasons.push('This workspace requires a project on every entry.');

  if (desired.projectId && desired.projectId !== (entry.projectId ?? null)) {
    const project = context.projects.find(p => p.id === desired.projectId);
    if (!project)
      reasons.push('The project is not one of this workspace’s projects.');
    else if (project.archived === true)
      reasons.push(`The project ${project.name} is archived.`);
  }

  return reasons;
}

/**
 * put: the body of a full-replacement `PUT` that gives `entry` the values
 * `desired`. Every field Clockify would otherwise clear is sent: `start`,
 * `end`, `billable`, `description`, `tagIds` and `type` always, and
 * `projectId`/`taskId` when set. A changed project drops `taskId` (tasks
 * belong to a project). Custom fields are never sent: an entry with values
 * is refused by `blockers` instead.
 */
export function putBody(
  entry: ClockifyTimeEntry,
  desired: EntryValues,
): Record<string, unknown> {
  const current = entryValues(entry);
  if (!current)
    throw new Error(`Clockify entry ${entry.id} is not a completed entry`);
  const changed = new Set(changedFields(current, desired));
  const projectId = changed.has('projectId')
    ? desired.projectId
    : current.projectId;
  const taskId =
    !changed.has('projectId') && typeof entry.taskId === 'string'
      ? entry.taskId
      : undefined;

  return {
    start: changed.has('start')
      ? clockifyInstant(desired.start)
      : entry.timeInterval.start,
    end: changed.has('end')
      ? clockifyInstant(desired.end)
      : entry.timeInterval.end,
    billable: changed.has('billable') ? desired.billable : current.billable,
    description: changed.has('name')
      ? descriptionOf(desired.name)
      : typeof entry.description === 'string'
        ? entry.description
        : '',
    ...(projectId ? { projectId } : {}),
    ...(taskId ? { taskId } : {}),
    tagIds: Array.isArray(entry.tagIds) ? [...entry.tagIds] : [],
    type: entry.type ?? 'REGULAR',
  };
}
