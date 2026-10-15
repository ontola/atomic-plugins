// @wc-ignore-file
/**
 * The app's own data in the user's drive. There is no shared note class in
 * `ontology/` (#177 has none), so the rows are of a class of the app's own,
 * created once in the App's own ontology (the App's default ontology, as
 * `createApp` sets it), the way the Money app makes its statement class
 * (`../../money/app/own.ts`):
 *
 * - `google-keep-note`, a Class recommending Atomic's `name` (the note's
 *   title), Atomic's `description` (its body, as Markdown; see notes.ts)
 *   and the app's own properties below. It requires nothing: a Keep note
 *   may have no title, and an empty row is simply not sent.
 * - Note row properties, all strings: the note's resource name (the row's
 *   identity), its kind (text or list), its presence, why an edit here is
 *   held back (a conflict, or a note the app may not replace), Keep's
 *   `updateTime`, a short fingerprint of what both sides had at the last
 *   sync (the baseline a pass compares with; `fingerprint` in notes.ts),
 *   a list note's last-synced list (Markdown) and when a note that left the
 *   list was last seen.
 * - `google-keep-item`, the class of the App's second table, "Google Keep
 *   list items": one row per item of a list note (`lists.ts`), with its
 *   text as Name, whether it is done, its note row, the item it is under,
 *   its position and which last-synced item it is.
 * - App properties: the last complete read and the last pass (ISO 8601
 *   UTC), every note id the table has held (JSON array; a note whose row is
 *   deleted here is then not imported again), the old notes of
 *   replacements whose delete is to be retried (JSON array), the Google
 *   account the table syncs with, and the sync lease (lease.ts).
 *
 * On first open (`provision`) the app creates what is missing, adds the
 * class to its App's `renders`, and sets its table's `classtype` and name.
 * Every lookup goes through a resource the host reads back, so running it
 * twice creates nothing twice.
 */
import type { JSONValue, PluginResource, PluginStore } from './store.js';

const A = 'https://atomicdata.dev';

export const PARENT = `${A}/properties/parent`;
export const IS_A = `${A}/properties/isA`;
export const NAME = `${A}/properties/name`;
export const SHORTNAME = `${A}/properties/shortname`;
export const DESCRIPTION = `${A}/properties/description`;
export const DATATYPE = `${A}/properties/datatype`;
export const RECOMMENDS = `${A}/properties/recommends`;
export const REQUIRES = `${A}/properties/requires`;
export const PROPERTIES = `${A}/properties/properties`;
export const CLASSES = `${A}/properties/classes`;
export const CLASSTYPE = `${A}/properties/classtype`;
export const PROPERTY_CLASS = `${A}/classes/Property`;
export const TABLE_CLASS = `${A}/classes/Table`;
export const CLASS_CLASS = `${A}/classes/Class`;
export const DEFAULT_ONTOLOGY = `${A}/ontology/server/property/default-ontology`;

export const TABLE_NAME = 'Google Keep';
export const ITEMS_TABLE_NAME = 'Google Keep list items';
export const CLASS_SHORTNAME = 'google-keep-note';
export const ITEM_CLASS_SHORTNAME = 'google-keep-item';

const STRING = `${A}/datatypes/string`;
const BOOLEAN = `${A}/datatypes/boolean`;
const ATOMIC_URL = `${A}/datatypes/atomicURL`;
const FLOAT = `${A}/datatypes/float`;
const INTEGER = `${A}/datatypes/integer`;

export type OwnProperty =
  | 'noteId'
  | 'kind'
  | 'presence'
  | 'hold'
  | 'updated'
  | 'synced'
  | 'list'
  | 'done'
  | 'note'
  | 'under'
  | 'position'
  | 'base'
  | 'lastSeen'
  | 'lastSync'
  | 'lastPass'
  | 'known'
  | 'retiring'
  | 'account'
  | 'lease';

interface PropertySpec {
  key: OwnProperty;
  shortname: string;
  name: string;
  description: string;
  /** String unless given. */
  datatype?: string;
}

export const PROPERTY_SPECS: PropertySpec[] = [
  {
    key: 'noteId',
    shortname: 'google-keep-note-id',
    name: 'Keep note',
    description:
      'The resource name (notes/…) of the Google Keep note this row syncs with. The row’s identity; a row without one is a new note to create.',
  },
  {
    key: 'kind',
    shortname: 'google-keep-kind',
    name: 'Keep note kind',
    description:
      'text or list. A list note’s Description is a Markdown checklist (- [ ] and - [x], a child item indented by two spaces).',
  },
  {
    key: 'presence',
    shortname: 'google-keep-presence',
    name: 'Keep presence',
    description:
      'Where the note stands in Google Keep: present, trashed, deleted (gone, and Google answers 404) or unconfirmed (could not be checked).',
  },
  {
    key: 'hold',
    shortname: 'google-keep-hold',
    name: 'Keep sync held',
    description:
      'Why an edit here is not sent to Google Keep: a conflict (the note changed in Keep too) or a note the app may not replace. Empty when nothing is held.',
  },
  {
    key: 'updated',
    shortname: 'google-keep-updated',
    name: 'Keep updated',
    description: 'When Google Keep last changed the note, as Keep reports it.',
  },
  {
    key: 'synced',
    shortname: 'google-keep-synced',
    name: 'Keep sync fingerprint',
    description:
      'Written by the Google Keep app: a short digest of the title and text both sides had at the last sync. The next sync compares the row and Google Keep with it to tell which one changed.',
  },
  {
    key: 'list',
    shortname: 'google-keep-list',
    name: 'Keep list at last sync',
    description:
      'Written by the Google Keep app: a list note’s items as both sides had them at the last sync, as a Markdown checklist. The next sync merges each side’s changes since then, item by item.',
  },
  {
    key: 'done',
    shortname: 'google-keep-done',
    name: 'Done',
    description: 'Whether the list item is ticked.',
    datatype: BOOLEAN,
  },
  {
    key: 'note',
    shortname: 'google-keep-item-note',
    name: 'Note',
    description: 'The note this item is on: a row of the Google Keep table.',
    datatype: ATOMIC_URL,
  },
  {
    key: 'under',
    shortname: 'google-keep-under',
    name: 'Under',
    description:
      'The item this one is indented under, on the same note. Google Keep allows one level.',
    datatype: ATOMIC_URL,
  },
  {
    key: 'position',
    shortname: 'google-keep-position',
    name: 'Position',
    description: 'The item’s place in its note’s list, lowest first.',
    datatype: FLOAT,
  },
  {
    key: 'base',
    shortname: 'google-keep-base',
    name: 'Keep item at last sync',
    description:
      'Written by the Google Keep app: which item of the note’s last-synced list this one is, counting from 0. Empty for an item added here since.',
    datatype: INTEGER,
  },
  {
    key: 'lastSeen',
    shortname: 'google-keep-last-seen',
    name: 'Keep last seen',
    description:
      'When Google Keep last listed the note, as an ISO 8601 date and time. Set only on a note that is no longer listed.',
  },
  {
    key: 'lastSync',
    shortname: 'google-keep-last-sync',
    name: 'Keep last sync',
    description:
      'When the Google Keep app last read the notes completely, ISO 8601 UTC. On the App resource.',
  },
  {
    key: 'lastPass',
    shortname: 'google-keep-last-pass',
    name: 'Keep last pass',
    description:
      'When the Google Keep app last finished a pass, complete or partial, ISO 8601 UTC. On the App resource.',
  },
  {
    key: 'known',
    shortname: 'google-keep-known',
    name: 'Keep notes synced',
    description:
      'JSON array of every note id this table has held. A note whose row was deleted here is not imported again. On the App resource.',
  },
  {
    key: 'retiring',
    shortname: 'google-keep-retiring',
    name: 'Keep notes to delete',
    description:
      'JSON array of old notes a replacement still has to delete in Google Keep (the API has no update). On the App resource.',
  },
  {
    key: 'account',
    shortname: 'google-keep-account',
    name: 'Keep account',
    description:
      'The Google account this table syncs with, as the notes name it. A connection to another account does not sync here. On the App resource.',
  },
  {
    key: 'lease',
    shortname: 'google-keep-lease',
    name: 'Keep sync lease',
    description:
      'Which open browser is syncing, and until when, so two do not create the same note twice. On the App resource.',
  },
];

/** The row properties, in the class's `recommends` after Name and Description. */
export const ROW_PROPERTIES: OwnProperty[] = [
  'noteId',
  'kind',
  'presence',
  'hold',
  'updated',
  'lastSeen',
  'synced',
  'list',
];

/** The item properties, in the item class's `recommends` after Name. */
export const ITEM_PROPERTIES: OwnProperty[] = [
  'done',
  'note',
  'under',
  'position',
  'base',
];

export const asList = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

async function byShortname(
  store: PluginStore,
  subjects: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  for (const subject of subjects) {
    const shortname = (
      await store.getResource(subject).catch(() => undefined)
    )?.get(SHORTNAME);
    if (typeof shortname === 'string') out.set(shortname, subject);
  }

  return out;
}

async function ensureProperties(
  store: PluginStore,
  ontology: PluginResource,
): Promise<Record<OwnProperty, string>> {
  const listed = asList(ontology.get(PROPERTIES));
  const found = await byShortname(store, listed);
  const created: string[] = [];
  const out = {} as Record<OwnProperty, string>;

  for (const spec of PROPERTY_SPECS) {
    let subject = found.get(spec.shortname);

    if (!subject) {
      subject = (
        await store.newResource({
          parent: ontology.subject,
          isA: [PROPERTY_CLASS],
          propVals: {
            [SHORTNAME]: spec.shortname,
            [NAME]: spec.name,
            [DESCRIPTION]: spec.description,
            [DATATYPE]: spec.datatype ?? STRING,
          },
        })
      ).subject;
      created.push(subject);
    }

    out[spec.key] = subject;
  }

  if (created.length)
    await ontology.set(PROPERTIES, [...listed, ...created]).save();

  return out;
}

interface ClassSpec {
  shortname: string;
  name: string;
  description: string;
  recommends: string[];
}

async function ensureClass(
  store: PluginStore,
  ontology: string,
  spec: ClassSpec,
): Promise<string> {
  const resource = await store.getResource(ontology);
  const listed = asList(resource.get(CLASSES));
  const existing = (await byShortname(store, listed)).get(spec.shortname);
  if (existing) return existing;

  const created = await store.newResource({
    parent: ontology,
    isA: [CLASS_CLASS],
    propVals: {
      [SHORTNAME]: spec.shortname,
      [NAME]: spec.name,
      [DESCRIPTION]: spec.description,
      [REQUIRES]: [],
      [RECOMMENDS]: spec.recommends,
    },
  });
  const again = await store.getResource(ontology);
  await again
    .set(CLASSES, [...asList(again.get(CLASSES)), created.subject])
    .save();

  return created.subject;
}

/** The App's own child table of class `klass`, made when missing. */
async function ensureTable(
  store: PluginStore,
  app: string,
  klass: string,
  name: string,
  description: string,
): Promise<string> {
  for (const subject of await store.query({
    property: CLASSTYPE,
    value: klass,
  })) {
    const table = await store.getResource(subject).catch(() => undefined);
    if (table?.get(PARENT) === app) return subject;
  }

  return (
    await store.newResource({
      parent: app,
      isA: [TABLE_CLASS],
      propVals: {
        [NAME]: name,
        [CLASSTYPE]: klass,
        [DESCRIPTION]: description,
      },
    })
  ).subject;
}

async function appOntology(
  store: PluginStore,
  app: string,
): Promise<PluginResource> {
  const own = (await store.getResource(app)).get(DEFAULT_ONTOLOGY);
  if (typeof own === 'string') return store.getResource(own);
  throw new Error('This app has no ontology of its own to add fields to.');
}

/** An App property of the drive's plugin vocabulary (`renders`), by shortname. */
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

/** The table shown is not this app's own (it was added as a view there). */
export class OtherTable extends Error {
  constructor() {
    super(
      'This is another table. The Google Keep app syncs only its own table.',
    );
    this.name = 'OtherTable';
  }
}

export interface Drive {
  app: string;
  table: string;
  rowClass: string;
  /** The table of list items, and its row class. */
  itemsTable: string;
  itemClass: string;
  properties: Record<OwnProperty, string>;
}

/** Creates (or finds) the app's properties and class, and types its table. Idempotent. */
export async function provision(store: PluginStore): Promise<Drive> {
  const app = await store.getApp();
  const data = await store.getData();
  if (!data?.table) throw new Error('This app has no table to sync into.');
  const ontology = await appOntology(store, app);
  const properties = await ensureProperties(store, ontology);
  const rowClass = await ensureClass(store, ontology.subject, {
    shortname: CLASS_SHORTNAME,
    name: 'Google Keep note',
    description:
      'A note synced with Google Keep by the Google Keep app: its title as Name, a text note’s text as Description. A list note’s items are rows of the Google Keep list items table.',
    recommends: [
      NAME,
      DESCRIPTION,
      ...ROW_PROPERTIES.map(key => properties[key]),
    ],
  });
  const itemClass = await ensureClass(store, ontology.subject, {
    shortname: ITEM_CLASS_SHORTNAME,
    name: 'Google Keep list item',
    description:
      'An item of a Google Keep list note, synced by the Google Keep app: its text as Name.',
    recommends: [NAME, ...ITEM_PROPERTIES.map(key => properties[key])],
  });

  const resource = await store.getResource(app);
  const renders = await appProperty(store, resource, 'renders');

  if (renders) {
    const list = asList(resource.get(renders) ?? []);
    if (!list.includes(rowClass))
      await resource.set(renders, [...list, rowClass]).save();
  }

  const table = await store.getResource(data.table);
  if (table.get(PARENT) !== app) throw new OtherTable();
  const retype = table.get(CLASSTYPE) !== rowClass;
  const rename = table.get(NAME) !== TABLE_NAME;
  if (retype) table.set(CLASSTYPE, rowClass);
  if (rename) table.set(NAME, TABLE_NAME);
  if (retype || rename) await table.save();
  const itemsTable = await ensureTable(
    store,
    app,
    itemClass,
    ITEMS_TABLE_NAME,
    'The items of the Google Keep list notes, one row per item, synced item by item by the Google Keep app.',
  );

  return {
    app,
    table: data.table,
    rowClass,
    itemsTable,
    itemClass,
    properties,
  };
}

const SYNC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** `value` as a recorded time, or undefined for junk or a time after `now`. */
export function syncTime(value: JSONValue, now: number): string | undefined {
  if (typeof value !== 'string' || !SYNC_TIME.test(value)) return undefined;
  const at = Date.parse(value);

  return Number.isFinite(at) && at <= now ? value : undefined;
}

export async function appValue(
  store: PluginStore,
  drive: Drive,
  key: OwnProperty,
): Promise<JSONValue> {
  return (await store.getResource(drive.app)).get(drive.properties[key]);
}

export async function lastSync(store: PluginStore, drive: Drive, now: number) {
  return syncTime(await appValue(store, drive, 'lastSync'), now);
}

export async function lastPass(store: PluginStore, drive: Drive, now: number) {
  return syncTime(await appValue(store, drive, 'lastPass'), now);
}

/** A JSON array of strings kept as text on the App; `[]` for anything else. */
export function idList(value: JSONValue): string[] {
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

/**
 * Writes the App's bookkeeping in one save, only what changed: the pass
 * time (always), the complete-read time (after a complete read), the note
 * ids, the notes still to delete, and the account.
 */
export async function recordPass(
  store: PluginStore,
  drive: Drive,
  values: {
    at: string;
    complete: boolean;
    known: string[];
    retiring: string[];
    account?: string;
  },
): Promise<void> {
  const app = await store.getResource(drive.app);
  const p = drive.properties;
  const wanted: [string, string | undefined][] = [
    [p.lastPass, values.at],
    [p.lastSync, values.complete ? values.at : undefined],
    [p.known, JSON.stringify([...new Set(values.known)].sort())],
    [p.retiring, JSON.stringify([...new Set(values.retiring)].sort())],
    [p.account, values.account],
  ];
  let changed = false;

  for (const [property, value] of wanted)
    if (value !== undefined && app.get(property) !== value) {
      app.set(property, value);
      changed = true;
    }

  if (changed) await app.save();
}
