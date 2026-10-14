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
 * - Row properties, all strings: the note's resource name (the row's
 *   identity), its kind (text or list), its presence, why an edit here is
 *   held back (a conflict, or a note the app may not replace), Keep's
 *   `updateTime`, a short fingerprint of what both sides had at the last
 *   sync (the baseline a pass compares with; `fingerprint` in notes.ts) and
 *   when a note that left the list was last seen.
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
export const CLASS_CLASS = `${A}/classes/Class`;
export const DEFAULT_ONTOLOGY = `${A}/ontology/server/property/default-ontology`;

export const TABLE_NAME = 'Google Keep';
export const CLASS_SHORTNAME = 'google-keep-note';

const STRING = `${A}/datatypes/string`;

export type OwnProperty =
  | 'noteId'
  | 'kind'
  | 'presence'
  | 'hold'
  | 'updated'
  | 'synced'
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
            [DATATYPE]: STRING,
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

async function ensureClass(
  store: PluginStore,
  ontology: string,
  properties: Record<OwnProperty, string>,
): Promise<string> {
  const resource = await store.getResource(ontology);
  const listed = asList(resource.get(CLASSES));
  const existing = (await byShortname(store, listed)).get(CLASS_SHORTNAME);
  if (existing) return existing;

  const created = await store.newResource({
    parent: ontology,
    isA: [CLASS_CLASS],
    propVals: {
      [SHORTNAME]: CLASS_SHORTNAME,
      [NAME]: 'Google Keep note',
      [DESCRIPTION]:
        'A note synced with Google Keep by the Google Keep app: its title as Name, its text or checklist as Description.',
      [REQUIRES]: [],
      [RECOMMENDS]: [
        NAME,
        DESCRIPTION,
        ...ROW_PROPERTIES.map(key => properties[key]),
      ],
    },
  });
  const again = await store.getResource(ontology);
  await again
    .set(CLASSES, [...asList(again.get(CLASSES)), created.subject])
    .save();

  return created.subject;
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
  properties: Record<OwnProperty, string>;
}

/** Creates (or finds) the app's properties and class, and types its table. Idempotent. */
export async function provision(store: PluginStore): Promise<Drive> {
  const app = await store.getApp();
  const data = await store.getData();
  if (!data?.table) throw new Error('This app has no table to sync into.');
  const ontology = await appOntology(store, app);
  const properties = await ensureProperties(store, ontology);
  const rowClass = await ensureClass(store, ontology.subject, properties);

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

  return { app, table: data.table, rowClass, properties };
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
