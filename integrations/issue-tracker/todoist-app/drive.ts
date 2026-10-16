// @wc-ignore-file
/**
 * The app's own data in the user's drive, laid out like the GitHub issues
 * app's (../app/tracker.ts) so that any view of the shared class reads it:
 *
 * - Rows are of the shared class `issue-v1` (ontola/atomic-plugins#177),
 *   published on GitHub Pages. Shared fields, by subject through
 *   `ontology-kit`'s strict resolver in sync.ts: Atomic's `name` as the
 *   task text, task/v1 `status` (the todo or done tag), `body` (the task's
 *   description) and `due-date` (the due day).
 * - Provider extras are the app's own properties under its own ontology
 *   (the App's default ontology, as `createApp` sets it), created once and
 *   found again by shortname: the Todoist task id (the row's identity),
 *   presence and last-seen (#99), priority, project, and the task as
 *   Todoist last sent it (JSON text). They are declared as the App's
 *   `row-extras` (atomic-server #1849).
 * - The time of the last complete read is one string property on the App
 *   resource, not on each row, so a refresh that finds nothing changed
 *   writes no row (see sync.ts).
 *
 * On first open (`provision`) the app makes itself a view of `issue-v1`: it
 * adds the class to its App's `renders`, its extras to `row-extras`, and
 * sets its own table's `classtype` to the class (#177 spike S2; a catalog
 * Install cannot do that yet, #177 H2). Every lookup goes through a resource
 * the host reads back, so running this twice creates nothing twice.
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

export const TABLE_NAME = 'Todoist tasks';

const datatypes = {
  string: `${A}/datatypes/string`,
};

/** The app's own properties, by role. */
export type OwnProperty =
  | 'taskId'
  | 'presence'
  | 'lastSeen'
  | 'priority'
  | 'project'
  | 'source'
  | 'lastSync';

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
    shortname: 'todoist-task-id',
    name: 'Todoist task',
    datatype: datatypes.string,
    description:
      'The id of the Todoist task this row was imported from. The row’s identity across imports.',
  },
  {
    key: 'presence',
    shortname: 'todoist-presence',
    name: 'Todoist presence',
    datatype: datatypes.string,
    description:
      'Where the task stands in Todoist: active, completed, deleted, unavailable (gone, reason unknown) or unconfirmed (last known values; see Todoist last seen).',
  },
  {
    key: 'lastSeen',
    shortname: 'todoist-last-seen',
    name: 'Todoist last seen',
    datatype: datatypes.string,
    description:
      'When Todoist last returned this task, as an ISO 8601 date and time. Set only on a task that is no longer in the active list; an active task was seen at the app’s last sync.',
  },
  {
    key: 'priority',
    shortname: 'todoist-priority',
    name: 'Todoist priority',
    datatype: datatypes.string,
    description: 'Todoist priority: Normal, Medium, High or Urgent.',
  },
  {
    key: 'project',
    shortname: 'todoist-project',
    name: 'Todoist project',
    datatype: datatypes.string,
    description: 'The name of the Todoist project the task is in.',
  },
  {
    key: 'source',
    shortname: 'todoist-source',
    name: 'Todoist source',
    datatype: datatypes.string,
    description:
      'JSON text written by the Todoist app: the task as Todoist last sent it, with the app’s presence fields. Edit it and the next import can no longer tell what Todoist said.',
  },
  {
    key: 'lastSync',
    shortname: 'todoist-last-sync',
    name: 'Todoist last sync',
    datatype: datatypes.string,
    description:
      'When the Todoist app last read the complete active-task list, as an ISO 8601 date and time. On the App resource.',
  },
];

/** The provider extras kept on rows, declared as the App's `row-extras`. */
export const ROW_EXTRAS: OwnProperty[] = [
  'taskId',
  'presence',
  'lastSeen',
  'priority',
  'project',
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
      'This is another Issue table. The Todoist app imports only into its own table.',
    );
    this.name = 'OtherTable';
  }
}

/** Whether the table shown is the app's own, not one it was added to as a view. */
export async function showsOwnTable(store: PluginStore): Promise<boolean> {
  const data = await store.getData();
  if (!data?.table) return true;

  return (
    (await store.getResource(data.table)).get(PARENT) === (await store.getApp())
  );
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

/** The time of the last complete read, or undefined before the first. */
export async function lastSync(
  store: PluginStore,
  drive: Drive,
): Promise<string | undefined> {
  const value = (await store.getResource(drive.app)).get(
    drive.properties.lastSync,
  );

  return typeof value === 'string' && value ? value : undefined;
}

export async function recordSync(
  store: PluginStore,
  drive: Drive,
  at: string,
): Promise<void> {
  const app = await store.getResource(drive.app);
  if (app.get(drive.properties.lastSync) === at) return;
  await app.set(drive.properties.lastSync, at).save();
}
