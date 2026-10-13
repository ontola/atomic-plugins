// @wc-ignore-file
/**
 * A Clockify entry's name, start, end and billable flag, both ways, through
 * the shared lens catalog's `clockify-time-entry-v2`
 * (ontology-kit/LENSES.md) instead of mapping code of this app's own. The
 * lens and its interpreter are bundled at build time, like terms.mjs.
 *
 * - `entryValues` reads an entry with the lens's `get`. Its guards refuse a
 *   running timer and a non-REGULAR entry (`out-of-domain`): no row, as
 *   before.
 * - `putBody` writes the fields that changed with the lens's forward `put`
 *   onto the fresh full record, so unchanged values (start and end strings,
 *   the description) keep their exact form, then builds Clockify's
 *   full-replacement `PUT` body from the result.
 *
 * The name is the description exactly: not trimmed, and an empty one is an
 * empty name. "Time entry" or "(no description)" are display only (the
 * views), never data, so a row nobody edited never sends a description
 * (decision D-1 on the plan for this adoption).
 *
 * Still code here, until the catalog can express them (LENSES.md, "What the
 * format cannot express yet"): an entry that ends before it starts has no
 * row (gap 1, a relation between two places); the project id and name are
 * read from the entry (gap 3, a link to another row); and a changed
 * project drops the entry's task (gap 4, coupled writes).
 */
import { LensError, lensGet, lensPut } from '../../../ontology-kit/lens.mjs';
import { clockifyTimeEntryV2 } from '../../../ontology-kit/lenses.mjs';
import { properties } from '../../../ontology-kit/terms.mjs';
import {
  changedFields,
  type ClockifyTimeEntry,
  type EntryValues,
} from '../devonian/clockify/lens/index.js';

export const CLOCKIFY_LENS = clockifyTimeEntryV2;

const NAME = 'https://atomicdata.dev/properties/name';
const START = properties['work-start'].subject;
const END = properties['work-end'].subject;
const BILLABLE = properties['work-billable'].subject;

if (
  CLOCKIFY_LENS.mapping.fields.some(
    f => ![NAME, START, END, BILLABLE].includes(f.target),
  )
)
  throw new Error(
    `${CLOCKIFY_LENS['@id']} writes fields this app does not expect`,
  );

/** The lens's view of an entry, or undefined when it refuses it. */
function view(entry: ClockifyTimeEntry): Record<string, unknown> | undefined {
  try {
    return lensGet(CLOCKIFY_LENS.mapping, entry);
  } catch (error) {
    if (error instanceof LensError) return undefined;
    throw error;
  }
}

/**
 * get: the row values of a completed `REGULAR` entry, or undefined for a
 * running timer, a break (or holiday, time off), an entry with no valid
 * interval or one that ends before it starts: those have no row.
 */
export function entryValues(
  entry: ClockifyTimeEntry,
  projectName?: (id: string) => string | undefined,
): EntryValues | undefined {
  const values = view(entry);
  if (!values) return undefined;
  const start = values[START];
  const end = values[END];
  if (typeof start !== 'number' || typeof end !== 'number' || end < start)
    return undefined;
  const name = values[NAME];
  const projectId =
    typeof entry.projectId === 'string' && entry.projectId
      ? entry.projectId
      : null;

  return {
    name: typeof name === 'string' ? name : '',
    start,
    end,
    billable: values[BILLABLE] === true,
    projectId,
    project: (projectId && projectName?.(projectId)) || null,
  };
}

/**
 * put: the entry as Clockify last returned it, plus the row values someone
 * wants, as the body of a full-replacement `PUT` (Clockify clears every
 * field it is not sent). Only changed fields go through the lens; the rest
 * keep the fresh record's representation.
 */
export function putBody(
  entry: ClockifyTimeEntry,
  desired: EntryValues,
): Record<string, unknown> {
  const current = entryValues(entry);
  if (!current)
    throw new Error(`Clockify entry ${entry.id} is not a completed entry`);
  const changed = new Set(changedFields(current, desired));
  const wanted: Record<string, unknown> = {};
  if (changed.has('name')) wanted[NAME] = desired.name;
  if (changed.has('start')) wanted[START] = desired.start;
  if (changed.has('end')) wanted[END] = desired.end;
  if (changed.has('billable')) wanted[BILLABLE] = desired.billable;
  const next = lensPut(CLOCKIFY_LENS.mapping, wanted, entry) as Partial<
    ClockifyTimeEntry & { timeInterval: { start: string; end: string } }
  >;

  const projectId = changed.has('projectId')
    ? desired.projectId
    : current.projectId;
  // Gap 4: a changed project drops the entry's task.
  const taskId =
    !changed.has('projectId') && typeof entry.taskId === 'string'
      ? entry.taskId
      : undefined;

  return {
    start: next.timeInterval?.start,
    end: next.timeInterval?.end,
    billable: typeof next.billable === 'boolean' ? next.billable : false,
    description: typeof next.description === 'string' ? next.description : '',
    ...(projectId ? { projectId } : {}),
    ...(taskId ? { taskId } : {}),
    tagIds: Array.isArray(entry.tagIds) ? [...entry.tagIds] : [],
    type: entry.type ?? 'REGULAR',
  };
}
