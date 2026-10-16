// @wc-ignore-file
/**
 * The app's own data in the user's drive, laid out like the Todoist app's
 * (`issue-tracker/todoist-app/drive.ts`) so that any view of the shared
 * class reads it:
 *
 * - Rows are of the shared class `issue-v1` (ontola/atomic-plugins#177),
 *   published on GitHub Pages. Shared fields, by subject through
 *   `ontology-kit`'s strict resolver in sync.ts: Atomic's `name` as the
 *   task's title, task/v1 `status` (the todo or done tag), `body` (the
 *   task's notes) and `due-date` (the due day).
 * - Provider extras are the app's own properties under its own ontology
 *   (the App's default ontology, as `createApp` sets it), created once and
 *   found again by shortname: the Google task id (the row's identity), the
 *   task list it is in (id and title), presence and last-seen, the parent
 *   task's id for a subtask, and the task as Google last sent it (JSON
 *   text). They are declared as the App's `row-extras` (atomic-server
 *   #1849).
 * - Three string properties on the App resource, not on rows: the time of
 *   the last complete read (`google-tasks-last-sync`, so a pass that finds
 *   nothing changed writes no row), the time of the last pass that wrote the
 *   table at all, complete or partial (`google-tasks-last-pass`, so a table
 *   holding rows never reads "Not synced yet"), and the task lists the
 *   person chose to import (`google-tasks-lists`, a JSON array of list ids).
 *
 * On first open (`provision`) the app makes itself a view of `issue-v1`: it
 * adds the class to its App's `renders`, its extras to `row-extras`, and
 * sets its own table's `classtype` to the class. Every lookup goes through a
 * resource the host reads back, so running this twice creates nothing twice.
 */
import { classes as shared } from '../../../ontology-kit/terms.mjs';
import type { JSONValue, PluginResource, PluginStore } from './store.js';

const A = 'https://atomicdata.dev';

export const PARENT = `${A}/properties/parent`;
export const IS_A = `${A}/properties/isA`;
export const NAME = `${A}/properties/name`;
export const SHORTNAME = `${A}/properties/shortname`;
export const DESCRIPTION = `${A}/properties/description`;
export const DATATYPE = `${A}/properties/datatype`;
export const RECOMMENDS = `${A}/properties/recommends`;
export const PROPERTIES = `${A}/properties/properties`;
export const CLASSTYPE = `${A}/properties/classtype`;
export const PROPERTY_CLASS = `${A}/classes/Property`;
/** The drive's default ontology on an App (`createApp` sets it). */
export const DEFAULT_ONTOLOGY = `${A}/ontology/server/property/default-ontology`;

/** The shared class this app's rows are (#177 §2.3). */
export const ISSUE_V1: string = shared['issue-v1'].subject;
const TASK = `${A}/task/v1`;

/** task/v1 terms every AtomicServer embeds; `issue-v1` recommends them. */
export const TASK_STATUS = `${TASK}/status`;
export const TASK_BODY = `${TASK}/body`;
export const TASK_DUE_DATE = `${TASK}/due-date`;
/** The two task/v1 tags a read-only import can mean: open, or checked off. */
export const TAG_TODO = `${TASK}/todo`;
export const TAG_DONE = `${TASK}/done`;

export const TABLE_NAME = 'Google Tasks';

const datatypes = {
  string: `${A}/datatypes/string`,
};

/** The app's own properties, by role. */
export type OwnProperty =
  | 'taskId'
  | 'listId'
  | 'list'
  | 'presence'
  | 'lastSeen'
  | 'parent'
  | 'source'
  | 'lastSync'
  | 'lastPass'
  | 'lists';

interface PropertySpec {
  key: OwnProperty;
  shortname: string;
  name: string;
  datatype: string;
  description: string;
}

export const PROPERTY_SPECS: PropertySpec[] = [
  {
    key: 'taskId',
    shortname: 'google-tasks-task-id',
    name: 'Google task',
    datatype: datatypes.string,
    description:
      'The id of the Google task this row was imported from. The row’s identity across imports.',
  },
  {
    key: 'listId',
    shortname: 'google-tasks-list-id',
    name: 'Google task list id',
    datatype: datatypes.string,
    description: 'The id of the Google task list the task is in.',
  },
  {
    key: 'list',
    shortname: 'google-tasks-list',
    name: 'Google task list',
    datatype: datatypes.string,
    description: 'The title of the Google task list the task is in.',
  },
  {
    key: 'presence',
    shortname: 'google-tasks-presence',
    name: 'Google Tasks presence',
    datatype: datatypes.string,
    description:
      'Where the task stands in Google Tasks: present (in its list, open or completed), deleted, unavailable (gone, reason unknown) or unconfirmed (last known values; see Google Tasks last seen).',
  },
  {
    key: 'lastSeen',
    shortname: 'google-tasks-last-seen',
    name: 'Google Tasks last seen',
    datatype: datatypes.string,
    description:
      'When Google last returned this task, as an ISO 8601 date and time. Set only on a task that is no longer in its list; a present task was seen at the app’s last sync.',
  },
  {
    key: 'parent',
    shortname: 'google-tasks-parent',
    name: 'Google parent task',
    datatype: datatypes.string,
    description:
      'For a subtask: the id of the Google task it is nested under. The table is flat; this is the only trace of the nesting.',
  },
  {
    key: 'source',
    shortname: 'google-tasks-source',
    name: 'Google Tasks source',
    datatype: datatypes.string,
    description:
      'JSON text written by the Google Tasks app: the task as Google last sent it, with the app’s presence fields. Edit it and the next import can no longer tell what Google said.',
  },
  {
    key: 'lastSync',
    shortname: 'google-tasks-last-sync',
    name: 'Google Tasks last sync',
    datatype: datatypes.string,
    description:
      'When the Google Tasks app last read the chosen task lists completely, as an ISO 8601 date and time in UTC. On the App resource.',
  },
  {
    key: 'lastPass',
    shortname: 'google-tasks-last-pass',
    name: 'Google Tasks last pass',
    datatype: datatypes.string,
    description:
      'When the Google Tasks app last finished reading and wrote the table, complete or partial (the page cap), as an ISO 8601 date and time in UTC. Later than or equal to Google Tasks last sync. On the App resource.',
  },
  {
    key: 'lists',
    shortname: 'google-tasks-lists',
    name: 'Google task lists to import',
    datatype: datatypes.string,
    description:
      'The ids of the Google task lists the app imports, as a JSON array. On the App resource.',
  },
];

/** The provider extras kept on rows, declared as the App's `row-extras`. */
export const ROW_EXTRAS: OwnProperty[] = [
  'taskId',
  'listId',
  'list',
  'presence',
  'lastSeen',
  'parent',
  'source',
];

export const asList = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

async function ensureProperties(
  store: PluginStore,
  ontology: PluginResource,
): Promise<Record<OwnProperty, string>> {
  const listed = asList(ontology.get(PROPERTIES));
  const byShortname = new Map<string, string>();

  for (const subject of listed) {
    const shortname = (await store.getResource(subject)).get(SHORTNAME);
    if (typeof shortname === 'string') byShortname.set(shortname, subject);
  }

  const created: string[] = [];
  const out = {} as Record<OwnProperty, string>;

  for (const spec of PROPERTY_SPECS) {
    let subject = byShortname.get(spec.shortname);

    if (!subject) {
      const property = await store.newResource({
        parent: ontology.subject,
        isA: [PROPERTY_CLASS],
        propVals: {
          [SHORTNAME]: spec.shortname,
          [NAME]: spec.name,
          [DESCRIPTION]: spec.description,
          [DATATYPE]: spec.datatype,
        },
      });
      subject = property.subject;
      created.push(subject);
    }

    out[spec.key] = subject;
  }

  if (created.length > 0)
    await ontology.set(PROPERTIES, [...listed, ...created]).save();

  return out;
}

/** The app's own ontology: the App's default ontology, as `createApp` sets it. */
async function appOntology(
  store: PluginStore,
  app: string,
): Promise<PluginResource> {
  const own = (await store.getResource(app)).get(DEFAULT_ONTOLOGY);
  if (typeof own === 'string') return store.getResource(own);
  throw new Error('This app has no ontology of its own to add fields to.');
}

/**
 * An App property of the drive's plugin vocabulary (`renders`,
 * `row-extras`), found by shortname among what the App's class recommends;
 * their subjects are minted per drive.
 */
async function appProperty(
  store: PluginStore,
  app: PluginResource,
  shortname: string,
): Promise<string | undefined> {
  for (const klass of asList(app.get(IS_A))) {
    const resource = await store.getResource(klass).catch(() => undefined);

    for (const subject of asList(resource?.get(RECOMMENDS) ?? [])) {
      const term = await store.getResource(subject).catch(() => undefined);
      if (term?.get(SHORTNAME) === shortname) return subject;
    }
  }

  return undefined;
}

/** Adds `wanted` to the list `property` holds on `resource`; true if changed. */
function include(
  resource: PluginResource,
  property: string | undefined,
  wanted: string[],
): boolean {
  if (!property) return false;
  const list = asList(resource.get(property) ?? []);
  const missing = wanted.filter(s => !list.includes(s));
  if (!missing.length) return false;
  resource.set(property, [...list, ...missing]);

  return true;
}

/** The table shown is not this app's own (it was added as a view there). */
export class OtherTable extends Error {
  constructor() {
    super(
      'This is another Issue table. The Google Tasks app imports only into its own table.',
    );
    this.name = 'OtherTable';
  }
}

/** What sync.ts writes with: the app's subjects. */
export interface Drive {
  app: string;
  table: string;
  /** Always `ISSUE_V1`. */
  rowClass: string;
  properties: Record<OwnProperty, string>;
}

/**
 * Creates (or finds) the app's properties, makes the app a view of
 * `issue-v1` (`renders`, `row-extras`, the table's `classtype`) and names
 * the table. Idempotent. Throws `OtherTable` when the table shown is not the
 * app's own; `renders` and `row-extras` are set first, so the App is a view
 * of the class either way.
 */
export async function provision(store: PluginStore): Promise<Drive> {
  const app = await store.getApp();
  const data = await store.getData();
  if (!data?.table) throw new Error('This app has no table to import into.');
  const ontology = await appOntology(store, app);
  const properties = await ensureProperties(store, ontology);

  const resource = await store.getResource(app);
  const renders = include(
    resource,
    await appProperty(store, resource, 'renders'),
    [ISSUE_V1],
  );
  const declared = include(
    resource,
    await appProperty(store, resource, 'row-extras'),
    ROW_EXTRAS.map(key => properties[key]),
  );
  if (renders || declared) await resource.save();

  const table = await store.getResource(data.table);
  if (table.get(PARENT) !== app) throw new OtherTable();
  const retype = table.get(CLASSTYPE) !== ISSUE_V1;
  const rename = table.get(NAME) !== TABLE_NAME;
  if (retype) table.set(CLASSTYPE, ISSUE_V1);
  if (rename) table.set(NAME, TABLE_NAME);
  if (retype || rename) await table.save();

  return { app, table: data.table, rowClass: ISSUE_V1, properties };
}

/** A strict ISO 8601 date and time in UTC, as `recordSync` writes it. */
const SYNC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * `value` as the last sync time, or `undefined` for anything else: junk, a
 * local-time or offset string, an unparseable date, or a time after `now`
 * (a clock that was wrong when it was written must not make the card say
 * "Synced just now" for days).
 */
export function syncTime(value: JSONValue, now: number): string | undefined {
  if (typeof value !== 'string' || !SYNC_TIME.test(value)) return undefined;
  const at = Date.parse(value);

  return Number.isFinite(at) && at <= now ? value : undefined;
}

/** The time of the last complete read, or undefined before the first. */
export async function lastSync(
  store: PluginStore,
  drive: Drive,
  now: number,
): Promise<string | undefined> {
  return syncTime(
    (await store.getResource(drive.app)).get(drive.properties.lastSync),
    now,
  );
}

/** The time of the last pass that wrote the table, complete or partial. */
export async function lastPass(
  store: PluginStore,
  drive: Drive,
  now: number,
): Promise<string | undefined> {
  return syncTime(
    (await store.getResource(drive.app)).get(drive.properties.lastPass),
    now,
  );
}

/**
 * Records a finished pass on the App in one write: `google-tasks-last-pass`
 * always, `google-tasks-last-sync` too when the read was complete. Writes
 * nothing when both already hold `at`.
 */
export async function recordPass(
  store: PluginStore,
  drive: Drive,
  at: string,
  complete: boolean,
): Promise<void> {
  const app = await store.getResource(drive.app);
  let changed = false;

  for (const key of complete
    ? (['lastPass', 'lastSync'] as const)
    : (['lastPass'] as const))
    if (app.get(drive.properties[key]) !== at) {
      app.set(drive.properties[key], at);
      changed = true;
    }

  if (changed) await app.save();
}

/** The ids of the task lists the person chose to import; none at first. */
export async function chosenLists(
  store: PluginStore,
  drive: Drive,
): Promise<string[]> {
  const value = (await store.getResource(drive.app)).get(
    drive.properties.lists,
  );
  if (typeof value !== 'string' || !value) return [];

  try {
    const parsed: unknown = JSON.parse(value);

    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && !!id)
      : [];
  } catch {
    return [];
  }
}

export async function recordChosenLists(
  store: PluginStore,
  drive: Drive,
  ids: string[],
): Promise<void> {
  const app = await store.getResource(drive.app);
  const value = JSON.stringify(ids);
  if (app.get(drive.properties.lists) === value) return;
  await app.set(drive.properties.lists, value).save();
}
