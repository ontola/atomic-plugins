// @wc-ignore-file
import { SHARED, TIME_ENTRY, WORK_PERSON, WORK_PROJECT } from './fields.js';
import { Links } from './links.js';
import {
  atomic,
  LINK_FIELDS,
  LOG_FIELDS,
  ROW_FIELDS,
  SETTING_FIELDS,
  SYNC_FIELDS,
  type Field,
  type LinkKey,
  type LogKey,
  type RowKey,
  type SettingKey,
  type SyncKey,
} from './ontology.js';
import type { JSONValue, PluginResource, PluginStore } from './store.js';

/**
 * A row's fields: the shared `time-entry-v1` ones (fixed subjects, `fields.ts`)
 * and the app's own `entryId` extra (a Property of its ontology, once made).
 */
export type RowFields = typeof SHARED & Partial<Record<RowKey, string>>;

/** The app's table, its row class, and the Property subject of every field. */
export interface Schema {
  app: string;
  table: string;
  rowClass: string;
  /** The app's own ontology, where its own Properties are. */
  ontology: string;
  /** Whether the table is the app's own (under the App), not one it is a
   * view of through the host's "+ Add view". */
  own: boolean;
  /**
   * Where the settings and the observation log's pointer are kept: the App
   * for its own table; for a table it is a view of, that table's sync
   * binding under the App (`binding.ts`, #177 item 14), undefined until
   * "Sync this table to Clockify" made one.
   */
  home?: string;
  row: RowFields;
  /** Extras on the Projects and People tables' rows. */
  link: Partial<Record<LinkKey, string>>;
  settings: Partial<Record<SettingKey, string>>;
  log: Partial<Record<LogKey, string>>;
  /** Per-row sync bookkeeping (#123 M3): not table columns. */
  sync: Partial<Record<SyncKey, string>>;
  /** The app's own Projects and People tables, once made. */
  tables: { projects?: string; people?: string };
}

export type CompleteSchema = Schema & {
  home: string;
  row: typeof SHARED & Record<RowKey, string>;
  link: Record<LinkKey, string>;
  settings: Record<SettingKey, string>;
  log: Record<LogKey, string>;
  sync: Record<SyncKey, string>;
  tables: { projects: string; people: string };
  /** Reads and makes the project and person rows entries link to. */
  links: Links;
};

const list = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/** The table names the app gives its Projects and People tables. */
export const TABLE_NAMES = { projects: 'Projects', people: 'People' } as const;

export interface Layout {
  app: string;
  table: string;
  rowClass: string;
  ontology: string;
  own: boolean;
}

/**
 * Where the app's data is: the table the host hands it, and the app's own
 * ontology (the App's `default-ontology`, as `createApp` sets it; failing
 * that, the parent of a row class of the app's own, which is the same
 * ontology for an install `createApp` made).
 */
export async function layout(store: PluginStore): Promise<Layout> {
  const data = await store.getData();
  if (!data?.table || !data.rowClass)
    throw new Error('This app has no table with a row class to import into.');
  const app = await store.getApp();
  let ontology = (await store.getResource(app)).get(atomic.defaultOntology);

  if (typeof ontology !== 'string' && data.rowClass !== TIME_ENTRY)
    ontology = (await store.getResource(data.rowClass)).get(atomic.parent);
  if (typeof ontology !== 'string')
    throw new Error('This app has no ontology of its own to add fields to.');
  const table = await store.getResource(data.table);

  return {
    app,
    table: data.table,
    rowClass: data.rowClass,
    ontology,
    own: table.get(atomic.parent) === app,
  };
}

/** The app's Properties, by shortname. */
async function byShortname(
  store: PluginStore,
  ontology: string,
): Promise<Map<string, PluginResource>> {
  const resource = await store.getResource(ontology);
  const found = new Map<string, PluginResource>();

  for (const subject of list(resource.get(atomic.properties))) {
    const property = await store.getResource(subject);
    const shortname = property.get(atomic.shortname);
    if (typeof shortname === 'string') found.set(shortname, property);
  }

  return found;
}

function bind<K extends string>(
  fields: Record<K, Field>,
  found: Map<string, PluginResource>,
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};

  for (const key of Object.keys(fields) as K[]) {
    const property = found.get(fields[key].shortname);
    if (property && property.get(atomic.datatype) === fields[key].datatype)
      out[key] = property.subject;
  }

  return out;
}

/** The app's own table of `klass` (a child of the App), if there is one. */
async function ownTable(
  store: PluginStore,
  app: string,
  klass: string,
): Promise<string | undefined> {
  for (const subject of await store.query({
    property: atomic.classtype,
    value: klass,
  })) {
    const table = await store.getResource(subject).catch(() => undefined);
    if (table?.get(atomic.parent) === app) return subject;
  }

  return undefined;
}

/**
 * The sync binding for a table the app is a view of (#177 item 14): a child
 * of the App whose `clockify-synced-table` names the table. Only the App's
 * own children count, since anyone can make a resource that names a table.
 * The App itself for its own table.
 */
export async function homeOf(
  store: PluginStore,
  where: Pick<Layout, 'app' | 'table' | 'own'>,
  syncedTable: string | undefined,
): Promise<string | undefined> {
  if (where.own) return where.app;
  if (!syncedTable) return undefined;

  for (const subject of await store.query({
    property: syncedTable,
    value: where.table,
  })) {
    const binding = await store.getResource(subject).catch(() => undefined);
    if (binding?.get(atomic.parent) === where.app) return subject;
  }

  return undefined;
}

/** Read-only: what exists already. A field with another datatype is not bound. */
export async function findSchema(store: PluginStore): Promise<Schema> {
  const where = await layout(store);
  const found = await byShortname(store, where.ontology);
  const projects = await ownTable(store, where.app, WORK_PROJECT);
  const people = await ownTable(store, where.app, WORK_PERSON);
  const settings = bind(SETTING_FIELDS, found);
  const home = await homeOf(store, where, settings.syncedTable);

  return {
    ...where,
    ...(home ? { home } : {}),
    row: { ...SHARED, ...bind(ROW_FIELDS, found) },
    link: bind(LINK_FIELDS, found),
    settings,
    log: bind(LOG_FIELDS, found),
    sync: bind(SYNC_FIELDS, found),
    tables: {
      ...(projects ? { projects } : {}),
      ...(people ? { people } : {}),
    },
  };
}

/**
 * Finds or creates one Property per own field under the app's ontology (the
 * app's own subtree, where the host lets an app write) and lists new ones in
 * the ontology's `properties`. Idempotent: a second run writes nothing. A
 * same-named property with another datatype is an error rather than
 * silently reused or duplicated. The row fields themselves are the shared
 * `time-entry-v1` ones: nothing is added to any class.
 */
export async function ensureProperties(
  store: PluginStore,
  where: Pick<Layout, 'ontology'>,
): Promise<
  Pick<CompleteSchema, 'settings' | 'log' | 'sync' | 'link'> & {
    row: Record<RowKey, string>;
  }
> {
  const ontology = await store.getResource(where.ontology);
  const found = await byShortname(store, where.ontology);
  const added: string[] = [];

  const ensure = async (field: Field): Promise<string> => {
    const existing = found.get(field.shortname);

    if (existing) {
      if (existing.get(atomic.datatype) !== field.datatype)
        throw new Error(
          `The field "${field.name}" already exists with another datatype.`,
        );

      return existing.subject;
    }

    const created = await store.newResource({
      parent: ontology.subject,
      isA: [atomic.propertyClass],
      propVals: {
        [atomic.shortname]: field.shortname,
        [atomic.name]: field.name,
        [atomic.datatype]: field.datatype,
        [atomic.description]: field.description,
      },
    });
    added.push(created.subject);
    found.set(field.shortname, created);

    return created.subject;
  };

  const all = async <K extends string>(fields: Record<K, Field>) => {
    const out = {} as Record<K, string>;
    for (const key of Object.keys(fields) as K[])
      out[key] = await ensure(fields[key]);

    return out;
  };

  const row = await all(ROW_FIELDS);
  const link = await all(LINK_FIELDS);
  const settings = await all(SETTING_FIELDS);
  const log = await all(LOG_FIELDS);
  const sync = await all(SYNC_FIELDS);

  if (added.length) {
    ontology.set(atomic.properties, [
      ...list(ontology.get(atomic.properties)),
      ...added,
    ]);
    await ontology.save();
  }

  return { row, link, settings, log, sync };
}

/**
 * The app's Projects and People tables (#177 Q11: entries link to
 * `work-project-v1` and `work-person-v1` rows): two tables under the App,
 * made on first use, found again by class among the App's children.
 */
export async function ensureTables(
  store: PluginStore,
  app: string,
): Promise<{ projects: string; people: string }> {
  const ensure = async (klass: string, name: string) =>
    (await ownTable(store, app, klass)) ??
    (
      await store.newResource({
        parent: app,
        isA: [atomic.tableClass],
        propVals: {
          [atomic.name]: name,
          [atomic.classtype]: klass,
          [atomic.description]: `Filled by the Clockify timesheets app from what it last read in Clockify; time entries link to these rows. Names follow Clockify: a name changed here is set back on the next sync.`,
        },
      })
    ).subject;

  return {
    projects: await ensure(WORK_PROJECT, TABLE_NAMES.projects),
    people: await ensure(WORK_PERSON, TABLE_NAMES.people),
  };
}

/**
 * Everything a sync or a send needs: the app's own Properties and its
 * Projects and People tables, made where missing (in the app's own
 * subtree). On a table the app is a view of, only once "Sync this table to
 * Clockify" made its binding; before that the app syncs nothing there.
 */
export async function ensureSchema(
  store: PluginStore,
): Promise<CompleteSchema> {
  const where = await layout(store);
  const properties = await ensureProperties(store, where);
  const home = await homeOf(store, where, properties.settings.syncedTable);
  if (!home)
    throw new Error(
      'This table isn’t synced with Clockify. Use “Sync this table to Clockify” first.',
    );
  const tables = await ensureTables(store, where.app);

  return {
    ...where,
    home,
    ...properties,
    row: { ...SHARED, ...properties.row },
    tables,
    links: new Links(store, tables, properties.link),
  };
}
