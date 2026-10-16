// @wc-ignore-file
/**
 * Builds the views' `Timesheet` from a `time-entry-v1` table's rows, for a
 * table that is not the app's own (the host's "+ Add view" offers the app
 * on any table of that class, #177 §3.2): there is no observation log for
 * it, so no window, coverage or conflicts, only the rows. Fields are read
 * through `ontology-kit`'s strict resolver (`../fields.ts`), never by
 * shortname or column. A row with a start but no end (a running timer) is
 * counted as running, not listed. A row without a start lacks the class's
 * required field: it is listed as `incomplete` with its note, never
 * skipped (#177; ontology-kit's rule). The project is the linked project
 * row's name; the person, the linked person row's.
 */
import { incompleteOf, SHARED, sharedValues, TIME_ENTRY } from '../fields.js';
import { atomic, NAME } from '../ontology.js';
import type { PluginStore } from '../store.js';
import { weekStartOf } from './time.js';
import type { IncompleteRow, Project, Timesheet, TimeEntry } from './types.js';

export async function timesheetFromRows(
  store: PluginStore,
  table: string,
  timeZone: string,
): Promise<Timesheet> {
  const names = new Map<string, string | undefined>();

  const nameOf = async (subject: unknown) => {
    if (typeof subject !== 'string' || !subject) return undefined;

    if (!names.has(subject)) {
      const name = await store
        .getResource(subject)
        .then(r => r.get(NAME))
        .catch(() => undefined);
      names.set(subject, typeof name === 'string' && name ? name : undefined);
    }

    return names.get(subject);
  };

  const entries: TimeEntry[] = [];
  const incomplete: IncompleteRow[] = [];
  let running = 0;

  for (const subject of await store.query({
    property: atomic.parent,
    value: table,
  })) {
    const row = await store.getResource(subject).catch(() => undefined);
    if (!row) continue;
    // A table also holds its Views and other children; only rows of the
    // class are entries (before 0.6.2 such a child counted as running).
    const isA = row.get(atomic.isA);
    if (!Array.isArray(isA) || !isA.includes(TIME_ENTRY)) continue;
    const values = sharedValues(row.props);
    const start = values[SHARED.start];
    const end = values[SHARED.end];
    // A Start that is present but not a timestamp is as unusable as none.
    const note =
      incompleteOf(row.props) ??
      (typeof start !== 'number'
        ? 'Incomplete: Start is not a time'
        : undefined);

    if (note) {
      const name = values[NAME];
      incomplete.push({
        id: subject,
        description: typeof name === 'string' ? name : '',
        note,
      });
      continue;
    }

    if (typeof start !== 'number' || typeof end !== 'number') {
      running++;
      continue;
    }

    const projectLink = values[SHARED.project];
    const projectName = await nameOf(projectLink);
    const project: Project | undefined =
      typeof projectLink === 'string'
        ? { id: projectLink, ...(projectName ? { name: projectName } : {}) }
        : undefined;
    const member = await nameOf(values[SHARED.person]);
    const name = values[NAME];

    entries.push({
      id: subject,
      description: typeof name === 'string' ? name : '',
      start,
      end,
      billable: values[SHARED.billable] === true,
      ...(project ? { project } : {}),
      ...(member ? { member } : {}),
    });
  }

  entries.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
  incomplete.sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    entries,
    running,
    ...(incomplete.length ? { incomplete } : {}),
    breaks: 0,
    weekStart: weekStartOf(undefined),
    timeZone,
    unknown: [],
    conflicts: [],
  };
}
