// @wc-ignore-file
/**
 * The app's own data in the user's drive. Since 0.2.0 its rows are of the
 * shared class `issue-v1` (ontola/atomic-plugins#177 item 6), published on
 * GitHub Pages, so any view of that class can read them and this app is
 * offered on any table of it:
 *
 * - Shared fields, by subject (`ontology-kit`, read through its strict
 *   resolver in sync.ts): Atomic's `name` as the title, and task/v1
 *   `status` (the task/v1 tags todo, doing, blocked, done) and `body`.
 * - Provider extras, the app's own properties under its own ontology,
 *   created once and found again by shortname: GitHub issue number, GitHub
 *   source (JSON) and the sync baseline (JSON, #177 decision 7: bookkeeping
 *   lives on the row). They are declared as the App's `row-extras`
 *   (atomic-server #1849), so a row grant on another table may cover them.
 * - One sync resource under the app (found by its `localId`): the bound
 *   repository and the sync state as JSON text (snapshot without the
 *   per-record baselines, write journal, view preferences).
 * - One folder under the app for the GitHub comments (Messages `about` a
 *   row), also found by `localId`.
 * - Since 0.3.0 (#177 §6.2 item 14), per table the app is a view of and
 *   was asked to sync ("Sync this table to GitHub"): a binding under the
 *   app, of the same class as the sync resource, whose `synced-table` names
 *   that table, with its own repository, sync state and comments folder.
 *   A row grant never writes the table itself, so nothing about the sync
 *   is kept there; per-row bookkeeping is on the rows, as on the app's own
 *   table.
 *
 * On first open (`provision`) the app also makes itself a view of
 * `issue-v1`: it adds the class to its App's `renders` and sets its own
 * table's `classtype` to it, through the frame store, inside its own
 * subtree (#177 spike S2). A catalog Install cannot do that yet (#177 H2).
 * A table made by 0.1.x still holds rows of the app's own class with its
 * own Status tags; `legacy` describes them for `migrateRows`.
 *
 * Every lookup goes through a resource the host reads back (`getResource`)
 * or a `localId`, which AtomicServer keeps unique per parent, so running
 * this twice does not create anything twice.
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
export const CLASSES = `${A}/properties/classes`;
export const CLASSTYPE = `${A}/properties/classtype`;
export const ALLOWS_ONLY = `${A}/properties/allowsOnly`;
export const LOCAL_ID = `${A}/properties/localId`;
export const COLOR = `${A}/properties/color`;
export const ABOUT = `${A}/properties/about`;
export const PROPERTY_CLASS = `${A}/classes/Property`;
export const SELECT_PROPERTY = `${A}/classes/SelectProperty`;
export const CLASS_CLASS = `${A}/classes/Class`;
export const TAG = `${A}/classes/Tag`;
export const FOLDER = `${A}/classes/Folder`;
export const MESSAGE = `${A}/classes/Message`;
/** The drive's default ontology on an App (`createApp` sets it). */
export const DEFAULT_ONTOLOGY = `${A}/ontology/server/property/default-ontology`;

/** The shared class this app's rows are (#177 §2.3). */
export const ISSUE_V1: string = shared['issue-v1'].subject;
const TASK = `${A}/task/v1`;

/** task/v1 terms every AtomicServer embeds; `issue-v1` recommends them. */
export const TASK_STATUS = `${TASK}/status`;
export const TASK_BODY = `${TASK}/body`;

const datatypes = {
  string: `${A}/datatypes/string`,
  integer: `${A}/datatypes/integer`,
};

export const STATUSES = ['Todo', 'Doing', 'Blocked', 'Done'] as const;
export type Status = (typeof STATUSES)[number];
/** The task/v1 tag of each status (GitHub: atomic:doing, atomic:blocked). */
export const TASK_TAGS: Record<Status, string> = {
  Todo: `${TASK}/todo`,
  Doing: `${TASK}/doing`,
  Blocked: `${TASK}/blocked`,
  Done: `${TASK}/done`,
};

export const SYNC_LOCAL_ID = 'github-issues:sync';
export const COMMENTS_LOCAL_ID = 'github-issues:comments';

/** What `AtomicPort` consumes, plus the app's own subjects. */
export interface Tracker {
  app: string;
  table: string;
  /** Always `ISSUE_V1`. */
  rowClass: string;
  properties: {
    status: string;
    body: string;
    number: string;
    provenance: string;
    baseline: string;
    repository: string;
    syncState: string;
    /** On a binding: the table, not the app's own, it syncs. */
    syncedTable: string;
    /** When the last pass completed (ISO 8601), so a reload still names it. */
    lastSync: string;
  };
  tags: Record<Status, string>;
  commentsFolder: string;
}

/** A 0.1.x table's own Status column and its tags, by tag shortname. */
export interface Legacy {
  status: string;
  tags: Record<string, string>;
}

type OwnProperty = Exclude<keyof Tracker['properties'], 'status' | 'body'>;

interface PropertySpec {
  key: OwnProperty;
  shortname: string;
  name: string;
  datatype: string;
  description: string;
}

const PROPERTY_SPECS: PropertySpec[] = [
  {
    key: 'number',
    shortname: 'github-issue-number',
    name: 'GitHub issue number',
    datatype: datatypes.integer,
    description: 'The issue number in the bound GitHub repository.',
  },
  {
    key: 'provenance',
    shortname: 'github-source',
    name: 'GitHub source',
    datatype: datatypes.string,
    description:
      'JSON text written by the GitHub issues app: the GitHub author, URL and timestamps. Not an Atomic authorship claim.',
  },
  {
    key: 'baseline',
    shortname: 'github-sync-baseline',
    name: 'GitHub sync baseline',
    datatype: datatypes.string,
    description:
      'JSON text written by the GitHub issues app: the title, description and status (or comment text) it last agreed with GitHub. Edit it and sync can no longer tell which side changed.',
  },
  {
    key: 'repository',
    shortname: 'github-repository',
    name: 'GitHub repository',
    datatype: datatypes.string,
    description: 'The owner/name of the repository this app syncs with.',
  },
  {
    key: 'syncedTable',
    shortname: 'synced-table',
    name: 'Synced table',
    datatype: `${A}/datatypes/atomicURL`,
    description:
      'The table, not the app’s own, that this sync binding keeps in step with one GitHub repository (on a binding under the app).',
  },
  {
    key: 'syncState',
    shortname: 'github-sync-state',
    name: 'GitHub sync state',
    datatype: datatypes.string,
    description:
      'JSON text: the sync checkpoint and write journal of the GitHub issues app. Edit it and sync can no longer tell what was already sent.',
  },
  {
    key: 'lastSync',
    shortname: 'github-last-sync',
    name: 'GitHub last sync',
    datatype: datatypes.string,
    description:
      'When the GitHub issues app last completed a sync pass for this table (ISO 8601), written by the app; the sync-status card names it after a reload or a failed sync.',
  },
];

/** The provider extras kept on rows, declared as the App's `row-extras`. */
const ROW_EXTRAS: OwnProperty[] = ['number', 'provenance', 'baseline'];

/**
 * Everything the app writes on rows beyond `issue-v1`'s own columns, as the
 * App declares it in `row-extras`: the provider extras, and Atomic's
 * `localId`, which the Bridge sets on each row it imports so a create a
 * reload interrupted is found again instead of made twice. A row grant on
 * another table covers only what is listed here (atomic-server#1849).
 */
export const rowExtras = (
  properties: Record<OwnProperty, string>,
): string[] => [...ROW_EXTRAS.map(key => properties[key]), LOCAL_ID];

const asList = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/** The one resource under `parent` with this `localId`, if any. */
export async function findByLocalId(
  store: PluginStore,
  parent: string,
  localId: string,
): Promise<PluginResource | undefined> {
  for (const subject of await store.query({
    property: LOCAL_ID,
    value: localId,
  })) {
    const resource = await store.getResource(subject);
    if (resource.get(PARENT) === parent) return resource;
  }

  return undefined;
}

/** The app's own properties its ontology already lists, by shortname. */
async function listedProperties(
  store: PluginStore,
  ontology: PluginResource,
): Promise<Map<string, string>> {
  const byShortname = new Map<string, string>();

  for (const subject of asList(ontology.get(PROPERTIES))) {
    const property = await store.getResource(subject);
    const shortname = property.get(SHORTNAME);
    if (typeof shortname === 'string') byShortname.set(shortname, subject);
  }

  return byShortname;
}

/** The app's own properties, without creating any; undefined when one is missing. */
async function existingProperties(
  store: PluginStore,
  ontology: PluginResource,
): Promise<Record<OwnProperty, string> | undefined> {
  const byShortname = await listedProperties(store, ontology);
  const out = {} as Record<OwnProperty, string>;

  for (const spec of PROPERTY_SPECS) {
    const subject = byShortname.get(spec.shortname);
    if (!subject) return undefined;
    out[spec.key] = subject;
  }

  return out;
}

async function ensureProperties(
  store: PluginStore,
  ontology: PluginResource,
): Promise<Record<OwnProperty, string>> {
  const listed = asList(ontology.get(PROPERTIES));
  const byShortname = await listedProperties(store, ontology);

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

/** The 0.1.x Status column and its tags, when this app's ontology has it. */
async function legacyStatus(
  store: PluginStore,
  ontology: PluginResource,
): Promise<Legacy | undefined> {
  for (const subject of asList(ontology.get(PROPERTIES))) {
    const property = await store.getResource(subject);
    if (property.get(SHORTNAME) !== 'issue-status') continue;
    const tags: Record<string, string> = {};

    for (const tag of asList(property.get(ALLOWS_ONLY))) {
      const shortname = (await store.getResource(tag)).get(SHORTNAME);
      if (typeof shortname === 'string') tags[shortname] = tag;
    }

    return { status: subject, tags };
  }

  return undefined;
}

/**
 * The app's own ontology: the App's default ontology, as `createApp` sets
 * it. A 0.1.x app found it as its row class's parent, which is no longer
 * the app's once the table is `issue-v1`.
 */
async function appOntology(
  store: PluginStore,
  app: string,
  rowClass: string | undefined,
): Promise<PluginResource> {
  const own = (await store.getResource(app)).get(DEFAULT_ONTOLOGY);
  if (typeof own === 'string') return store.getResource(own);

  if (rowClass && rowClass !== ISSUE_V1) {
    const parent = (await store.getResource(rowClass)).get(PARENT);
    if (typeof parent === 'string') return store.getResource(parent);
  }

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

/** The table shown, and whether it is the app's own or one it is a view of. */
export interface Where {
  app: string;
  table: string;
  own: boolean;
  rowClass?: string;
}

export async function where(store: PluginStore): Promise<Where> {
  const app = await store.getApp();
  const data = await store.getData();
  if (!data?.table) throw new Error('This app has no table to sync into.');
  const own = (await store.getResource(data.table)).get(PARENT) === app;

  return {
    app,
    table: data.table,
    own,
    ...(data.rowClass ? { rowClass: data.rowClass } : {}),
  };
}

/**
 * Makes this app a view of `issue-v1` (#177 §5, item 3): its own properties
 * exist, `renders` lists the class and `row-extras` lists what it keeps on
 * rows (`rowExtras`). Only the app's own subtree is written, so this runs
 * on any table, and must run before the app asks for a row grant there: a
 * grant covers the extras declared when it was given. Idempotent.
 */
interface Declared {
  ontology: PluginResource;
  properties: Record<OwnProperty, string>;
}

/**
 * One `declare` per view (per host `store`). The host's reads can lag the
 * app's own saves (frameStore.ts), so a second run could read the ontology
 * without the properties the first one made and make them again; the same
 * `ontology` object is reused instead, as `provision` always did.
 */
const declaredBy = new WeakMap<PluginStore, Promise<Declared>>();

function declare(store: PluginStore, at: Where): Promise<Declared> {
  let pending = declaredBy.get(store);

  if (!pending) {
    pending = declareNow(store, at);
    declaredBy.set(store, pending);
    pending.catch(() => declaredBy.delete(store));
  }

  return pending;
}

async function declareNow(store: PluginStore, at: Where): Promise<Declared> {
  const ontology = await appOntology(store, at.app, at.rowClass);
  const properties = await ensureProperties(store, ontology);
  const resource = await store.getResource(at.app);
  const renders = include(
    resource,
    await appProperty(store, resource, 'renders'),
    [ISSUE_V1],
  );
  const declared = include(
    resource,
    await appProperty(store, resource, 'row-extras'),
    rowExtras(properties),
  );
  if (renders || declared) await resource.save();

  return { ontology, properties };
}

/**
 * `declare`, then, on the app's own table, sets its `classtype` to
 * `issue-v1`. A table the app is a view of is never written.
 */
async function adopt(
  store: PluginStore,
  at: Where,
): ReturnType<typeof declare> {
  const declared = await declare(store, at);

  if (at.own) {
    const own = await store.getResource(at.table);
    if (own.get(CLASSTYPE) !== ISSUE_V1)
      await own.set(CLASSTYPE, ISSUE_V1).save();
  }

  return declared;
}

/**
 * On every open of the app's own table, before a repository is chosen too:
 * `adopt`, so the App renders `issue-v1` and declares its row extras from
 * the start and the host's "+ Add view" offers it on other Issue tables
 * (#177 item 14). Writes nothing on a table the app is a view of.
 */
export async function adoptOwnTable(store: PluginStore): Promise<void> {
  const data = await store.getData();
  if (!data?.table) return;
  const at = await where(store);
  if (at.own) await adopt(store, at);
}

/**
 * What the app keeps on rows (`rowExtras`), declared on the App first when
 * missing. For checking a row grant's `extras` before asking for one.
 */
export async function declareRowExtras(store: PluginStore): Promise<string[]> {
  return rowExtras((await declare(store, await where(store))).properties);
}

/**
 * What the app keeps on rows, as far as its ontology has the properties;
 * undefined when one is missing (then no grant can cover them yet). Writes
 * nothing.
 */
export async function rowExtrasNow(
  store: PluginStore,
): Promise<string[] | undefined> {
  const at = await where(store);
  const ontology = await appOntology(store, at.app, at.rowClass).catch(
    () => undefined,
  );
  const properties = ontology
    ? await existingProperties(store, ontology)
    : undefined;

  return properties ? rowExtras(properties) : undefined;
}

/**
 * The binding of the table shown, when it is one the app is a view of: a
 * resource under the App whose `synced-table` names that table. `hint` is
 * a subject the caller already knows (the host's `query` can miss a
 * resource the page has not synced yet). Only one under the App counts:
 * anyone can make a resource that names the table.
 */
async function findBinding(
  store: PluginStore,
  at: Where,
  syncedTable: string,
  hint?: string,
): Promise<PluginResource | undefined> {
  const ours = (r: PluginResource | undefined) =>
    r?.get(PARENT) === at.app && r.get(syncedTable) === at.table;

  if (hint) {
    const known = await store.getResource(hint).catch(() => undefined);
    if (known && ours(known)) return known;
  }

  for (const subject of await store.query({
    property: syncedTable,
    value: at.table,
  })) {
    const found = await store.getResource(subject).catch(() => undefined);
    if (found && ours(found)) return found;
  }

  return undefined;
}

/** What `binding` reports about the sync of the table shown. */
export interface Binding {
  /** The sync resource (own table) or binding (another table). */
  subject: string;
  repository?: string;
}

/**
 * The sync resource of the app's own table, or the binding of a table it is
 * a view of; undefined when there is none yet, which on another table means
 * "not synced". Writes nothing.
 */
export async function binding(
  store: PluginStore,
  hint?: string,
): Promise<Binding | undefined> {
  const data = await store.getData();
  if (!data?.table) return undefined;
  const at = await where(store);
  const ontology = await appOntology(store, at.app, at.rowClass).catch(
    () => undefined,
  );
  if (!ontology) return undefined;
  const byShortname = await listedProperties(store, ontology);
  let sync: PluginResource | undefined;

  if (at.own) sync = await findByLocalId(store, at.app, SYNC_LOCAL_ID);
  else {
    const syncedTable = byShortname.get('synced-table');
    if (!syncedTable) return undefined;
    sync = await findBinding(store, at, syncedTable, hint);
  }

  if (!sync) return undefined;
  const property = byShortname.get('github-repository');
  const value = property ? sync.get(property) : undefined;

  return {
    subject: sync.subject,
    ...(typeof value === 'string' && value ? { repository: value } : {}),
  };
}

/**
 * "Sync this table to GitHub" on a table the app is a view of: makes its
 * binding under the App when missing, with no repository yet (`provision`
 * adds it). Writes only the app's own subtree. Returns its subject.
 */
export async function bindTable(
  store: PluginStore,
  hint?: string,
): Promise<string> {
  const at = await where(store);
  if (at.own) throw new Error('The app’s own table needs no binding.');
  const { ontology, properties } = await declare(store, at);
  const found = await findBinding(store, at, properties.syncedTable, hint);
  if (found) return found.subject;
  const syncClass = await ensureClass(store, ontology, properties);
  const name = (await store.getResource(at.table)).get(NAME);
  const made = await store.newResource({
    parent: at.app,
    isA: [syncClass],
    propVals: {
      [NAME]: `GitHub sync of ${typeof name === 'string' && name ? name : 'a table'}`,
      // AtomicServer keeps a localId unique per parent: one binding per table.
      [LOCAL_ID]: `${SYNC_LOCAL_ID} ${at.table}`,
      [properties.syncedTable]: at.table,
    },
  });

  return made.subject;
}

/**
 * "Not now" before a repository was chosen: the table goes back to not
 * synced. A binding that already names a repository is kept.
 */
export async function unbindTable(
  store: PluginStore,
  hint?: string,
): Promise<void> {
  const at = await where(store);
  if (at.own) return;
  const ontology = await appOntology(store, at.app, at.rowClass);
  const properties = await existingProperties(store, ontology);
  if (!properties) return;
  const found = await findBinding(store, at, properties.syncedTable, hint);
  if (!found) return;
  const repository = found.get(properties.repository);
  if (typeof repository === 'string' && repository) return;
  // Its comments folder, if any, goes first.
  const comments = await findByLocalId(store, found.subject, COMMENTS_LOCAL_ID);
  await comments?.destroy();
  await found.destroy();
}

/** Whether the table shown is the app's own, not one it was added to as a view. */
export async function showsOwnTable(store: PluginStore): Promise<boolean> {
  const data = await store.getData();
  if (!data?.table) return true;

  return (
    (await store.getResource(data.table)).get(PARENT) === (await store.getApp())
  );
}

/**
 * Rewrites a 0.1.x table's rows in place as `issue-v1` rows (#177 §5): the
 * app's own Status tag becomes the task/v1 tag with the same shortname,
 * Atomic's `description` becomes task/v1 `body`, and `isA` becomes
 * `issue-v1`. Everything else on the row (title, number, GitHub source)
 * stays, and so does the sync state, so edits not yet sent are still found
 * by the next pass. Rows already `issue-v1` are left alone. Returns how
 * many rows it rewrote.
 */
/** A row as `migrateRows` reads and writes it (the frame store's resources). */
export interface MigratedRow {
  get(property: string): JSONValue;
  set(property: string, value: JSONValue): unknown;
  remove(property: string): unknown;
  save(): Promise<unknown>;
}

export async function migrateRows(
  rows: {
    list(): Promise<string[]>;
    get(subject: string): Promise<MigratedRow>;
  },
  table: string,
  legacy: Legacy,
): Promise<number> {
  const byTag = new Map(
    Object.entries(legacy.tags).map(([shortname, tag]) => [tag, shortname]),
  );
  let rewritten = 0;

  for (const subject of await rows.list()) {
    const row = await rows.get(subject);
    if (row.get(PARENT) !== table || asList(row.get(IS_A)).includes(ISSUE_V1))
      continue;
    const status = asList(row.get(legacy.status) ?? []).map(tag => {
      const shortname = byTag.get(tag);
      const known = STATUSES.find(s => s.toLowerCase() === shortname);

      return known ? TASK_TAGS[known] : tag;
    });
    const body = row.get(DESCRIPTION);
    row.set(IS_A, [ISSUE_V1]);
    if (status.length) row.set(TASK_STATUS, status);
    if (typeof body === 'string') row.set(TASK_BODY, body);
    row.remove(legacy.status);
    row.remove(DESCRIPTION);
    await row.save();
    rewritten++;
  }

  return rewritten;
}

async function ensureClass(
  store: PluginStore,
  ontology: PluginResource,
  properties: Record<OwnProperty, string>,
): Promise<string> {
  const classes = asList(ontology.get(CLASSES));

  for (const subject of classes) {
    const klass = await store.getResource(subject);
    if (klass.get(SHORTNAME) === 'github-issue-tracker-sync') return subject;
  }

  const klass = await store.newResource({
    parent: ontology.subject,
    isA: [CLASS_CLASS],
    propVals: {
      [SHORTNAME]: 'github-issue-tracker-sync',
      [NAME]: 'GitHub issue tracker sync',
      [DESCRIPTION]:
        'Where the GitHub issues app keeps a table’s bound repository and sync state: its own table’s, or, with the synced table named, another table’s.',
      [RECOMMENDS]: [
        NAME,
        properties.repository,
        properties.syncState,
        properties.syncedTable,
      ],
    },
  });
  await ontology.set(CLASSES, [...classes, klass.subject]).save();

  return klass.subject;
}

/** The bound repository, or undefined before one was chosen. */
export async function boundRepository(
  store: PluginStore,
  hint?: string,
): Promise<string | undefined> {
  return (await binding(store, hint))?.repository;
}

/**
 * Creates (or finds) everything above and binds `repository` on first use.
 * A later call with another repository throws: one table, one repository.
 * On a table the app is a view of, the binding must exist (`bindTable`;
 * `hint` is its subject when known): the repository, sync state and
 * comments folder are kept there, and the table is never written.
 */
export async function provision(
  store: PluginStore,
  repository?: string,
  hint?: string,
): Promise<{
  tracker: Tracker;
  sync: PluginResource;
  repository: string;
  legacy?: Legacy;
}> {
  const at = await where(store);
  const { app } = at;
  const { ontology, properties } = await adopt(store, at);
  const legacy = at.own ? await legacyStatus(store, ontology) : undefined;

  // The same `ontology` object: a fresh read could lag the save above, and
  // the host's `save` sends every property it holds, stale ones included.
  const syncClass = await ensureClass(store, ontology, properties);

  let sync = at.own
    ? await findByLocalId(store, app, SYNC_LOCAL_ID)
    : await findBinding(store, at, properties.syncedTable, hint);
  if (!at.own && !sync)
    throw new Error('Choose “Sync this table to GitHub” first.');
  // Another table's comments go in a folder under its binding, so the two
  // syncs never list each other's.
  const commentsParent = at.own ? app : sync!.subject;
  let comments = await findByLocalId(store, commentsParent, COMMENTS_LOCAL_ID);
  comments ??= await store.newResource({
    parent: commentsParent,
    isA: [FOLDER],
    propVals: {
      [NAME]: 'GitHub comments',
      [LOCAL_ID]: COMMENTS_LOCAL_ID,
      [DESCRIPTION]: at.own
        ? 'Comments on the GitHub issues in this app’s table, as Messages about each row.'
        : 'Comments on the GitHub issues in the synced table, as Messages about each row.',
    },
  });

  const bound = sync?.get(properties.repository);

  if (typeof bound === 'string' && bound) {
    if (repository && repository !== bound)
      throw new Error(
        at.own
          ? `This app is bound to ${bound}. Install another app for ${repository}.`
          : `This table syncs with ${bound}. It can’t switch to ${repository}.`,
      );
    repository = bound;
  }

  if (!repository) throw new Error('Choose a GitHub repository first.');

  if (!sync) {
    sync = await store.newResource({
      parent: app,
      isA: [syncClass],
      propVals: {
        [NAME]: `GitHub sync: ${repository}`,
        [LOCAL_ID]: SYNC_LOCAL_ID,
        [properties.repository]: repository,
      },
    });
  } else if (bound !== repository) {
    await sync.set(properties.repository, repository).save();
  }

  // The app's own table is named after its repository; a table it is a
  // view of keeps the name the person gave it (a grant never writes it).
  if (at.own) {
    const table = await store.getResource(at.table);
    const tableName = `${repository} issues`;
    if (table.get(NAME) !== tableName) await table.set(NAME, tableName).save();
  }

  return {
    repository,
    sync,
    ...(legacy ? { legacy } : {}),
    tracker: {
      app,
      table: at.table,
      rowClass: ISSUE_V1,
      properties: { status: TASK_STATUS, body: TASK_BODY, ...properties },
      tags: TASK_TAGS,
      commentsFolder: comments.subject,
    },
  };
}
