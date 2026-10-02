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
    key: 'syncState',
    shortname: 'github-sync-state',
    name: 'GitHub sync state',
    datatype: datatypes.string,
    description:
      'JSON text: the sync checkpoint and write journal of the GitHub issues app. Edit it and sync can no longer tell what was already sent.',
  },
];

/** The provider extras kept on rows, declared as the App's `row-extras`. */
const ROW_EXTRAS: OwnProperty[] = ['number', 'provenance', 'baseline'];

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

async function ensureProperties(
  store: PluginStore,
  ontology: PluginResource,
): Promise<Record<OwnProperty, string>> {
  const listed = asList(ontology.get(PROPERTIES));
  const byShortname = new Map<string, string>();

  for (const subject of listed) {
    const property = await store.getResource(subject);
    const shortname = property.get(SHORTNAME);
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

/** The table shown is not this app's own (it was added as a view there). */
export class OtherTable extends Error {
  constructor() {
    super(
      'This is another Issue table. Syncing a table this app did not make with GitHub is not built yet.',
    );
    this.name = 'OtherTable';
  }
}

/**
 * Makes this app a view of `issue-v1` (#177 §5, item 3): `renders` lists
 * the class, `row-extras` lists the app's row extras, and its own table's
 * `classtype` is the class. Idempotent. Throws `OtherTable` when the table
 * shown is not the app's own; `renders` and `row-extras` are set first.
 */
async function adopt(
  store: PluginStore,
  app: string,
  table: string,
  extras: string[],
): Promise<void> {
  const resource = await store.getResource(app);
  const renders = include(
    resource,
    await appProperty(store, resource, 'renders'),
    [ISSUE_V1],
  );
  const declared = include(
    resource,
    await appProperty(store, resource, 'row-extras'),
    extras,
  );
  if (renders || declared) await resource.save();
  const own = await store.getResource(table);
  if (own.get(PARENT) !== app) throw new OtherTable();
  if (own.get(CLASSTYPE) !== ISSUE_V1)
    await own.set(CLASSTYPE, ISSUE_V1).save();
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
  recommends: string[],
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
        'Where the GitHub issues app keeps its bound repository and sync state.',
      [RECOMMENDS]: recommends,
    },
  });
  await ontology.set(CLASSES, [...classes, klass.subject]).save();

  return klass.subject;
}

/** The bound repository, or undefined before one was chosen. */
export async function boundRepository(
  store: PluginStore,
): Promise<string | undefined> {
  const app = await store.getApp();
  const sync = await findByLocalId(store, app, SYNC_LOCAL_ID);
  if (!sync) return undefined;
  const data = await store.getData();
  const ontology = await appOntology(store, app, data?.rowClass).catch(
    () => undefined,
  );
  if (!ontology) return undefined;

  for (const subject of asList(ontology.get(PROPERTIES))) {
    const property = await store.getResource(subject);
    if (property.get(SHORTNAME) !== 'github-repository') continue;
    const value = sync.get(subject);

    return typeof value === 'string' && value ? value : undefined;
  }

  return undefined;
}

/**
 * Creates (or finds) everything above and binds `repository` on first use.
 * A later call with another repository throws: one app, one repository.
 */
export async function provision(
  store: PluginStore,
  repository?: string,
): Promise<{
  tracker: Tracker;
  sync: PluginResource;
  repository: string;
  legacy?: Legacy;
}> {
  const app = await store.getApp();
  const data = await store.getData();
  if (!data?.table) throw new Error('This app has no table to sync into.');
  const ontology = await appOntology(store, app, data.rowClass);
  const properties = await ensureProperties(store, ontology);
  await adopt(
    store,
    app,
    data.table,
    ROW_EXTRAS.map(key => properties[key]),
  );
  const legacy = await legacyStatus(store, ontology);

  // The same `ontology` object: a fresh read could lag the save above, and
  // the host's `save` sends every property it holds, stale ones included.
  const syncClass = await ensureClass(store, ontology, [
    NAME,
    properties.repository,
    properties.syncState,
  ]);

  let comments = await findByLocalId(store, app, COMMENTS_LOCAL_ID);
  comments ??= await store.newResource({
    parent: app,
    isA: [FOLDER],
    propVals: {
      [NAME]: 'GitHub comments',
      [LOCAL_ID]: COMMENTS_LOCAL_ID,
      [DESCRIPTION]:
        'Comments on the GitHub issues in this app’s table, as Messages about each row.',
    },
  });

  let sync = await findByLocalId(store, app, SYNC_LOCAL_ID);
  const bound = sync?.get(properties.repository);

  if (typeof bound === 'string' && bound) {
    if (repository && repository !== bound)
      throw new Error(
        `This app is bound to ${bound}. Install another app for ${repository}.`,
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
  }

  const table = await store.getResource(data.table);
  const tableName = `${repository} issues`;
  if (table.get(NAME) !== tableName) await table.set(NAME, tableName).save();

  return {
    repository,
    sync,
    ...(legacy ? { legacy } : {}),
    tracker: {
      app,
      table: data.table,
      rowClass: ISSUE_V1,
      properties: { status: TASK_STATUS, body: TASK_BODY, ...properties },
      tags: TASK_TAGS,
      commentsFolder: comments.subject,
    },
  };
}
