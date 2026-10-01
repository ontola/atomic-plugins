// @wc-ignore-file
/**
 * Builds the views' `Timesheet` from a `time-entry-v1` table's rows, for a
 * table that is not the app's own (the host's "+ Add view" offers the app
 * on any table of that class, #177 §3.2): there is no observation log for
 * it, so no window, coverage or conflicts, only the rows. Fields are read
 * through `ontology-kit`'s strict resolver (`../fields.ts`), never by
 * shortname or column. A row without a start or an end (a running timer,
 * or an incomplete row) is counted as running, not listed. The project is
 * the linked project row's name; the person, the linked person row's.
 */
import { SHARED, sharedValues } from '../fields.js';
import { atomic, NAME } from '../ontology.js';
import type { PluginStore } from '../store.js';
import { weekStartOf } from './time.js';
import type { Project, Timesheet, TimeEntry } from './types.js';

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
  let running = 0;

  for (const subject of await store.query({
    property: atomic.parent,
    value: table,
  })) {
    const row = await store.getResource(subject).catch(() => undefined);
    if (!row) continue;
    const values = sharedValues(row.props);
    const start = values[SHARED.start];
    const end = values[SHARED.end];

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

  return {
    entries,
    running,
    breaks: 0,
    weekStart: weekStartOf(undefined),
    timeZone,
    unknown: [],
    conflicts: [],
  };
}
