// @wc-ignore-file
import type { Resource, Store, Value } from './store.js';

const A = 'https://atomicdata.dev/properties/';
export const P = {
  parent: A + 'parent',
  name: A + 'name',
  description: A + 'description',
  shortname: A + 'shortname',
  isA: A + 'isA',
  classtype: A + 'classtype',
  recommends: A + 'recommends',
  requires: A + 'requires',
  classes: A + 'classes',
};
export const strings = (v: Value): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const text = (v: Value): string => (typeof v === 'string' ? v : '');
export interface Item {
  subject: string;
  text: string;
  done: boolean;
  under: string;
  position: number;
}
export interface Note {
  subject: string;
  title: string;
  body: string;
  kind: string;
  presence: string;
  hold: string;
  items: Item[];
}
export interface Source {
  table: string;
  name: string;
  rowClass: string;
}
export interface Snapshot {
  notes: Note[];
  watches: string[];
  itemTable?: string;
  doneProperty?: string;
}

/** Resolve the sync app's own terms from its class, never from another install. */
async function fields(
  store: Store,
  klass: Resource,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set([
    ...strings(klass.get(P.recommends)),
    ...strings(klass.get(P.requires)),
  ])) {
    const property = await store.getResource(id);
    out.set(text(property.get(P.shortname)), id);
  }
  return out;
}

export async function sources(store: Store): Promise<Source[]> {
  const out: Source[] = [];
  for (const klass of await store.query({
    property: P.shortname,
    value: 'google-keep-note',
  })) {
    for (const table of await store.query({
      property: P.classtype,
      value: klass,
    })) {
      const resource = await store.getResource(table);
      out.push({
        table,
        name: text(resource.get(P.name)) || 'Google Keep',
        rowClass: klass,
      });
    }
  }
  return out;
}

/** Advertise locally discovered classes so Add view offers this app on Keep tables. */
export async function register(store: Store, classes: string[]): Promise<void> {
  const app = await store.getResource(await store.getApp());
  for (const id of strings(app.get(P.isA))) {
    const terms = await fields(store, await store.getResource(id));
    const renders = terms.get('renders');
    if (!renders) continue;
    const previous = strings(app.get(renders));
    const next = [...new Set([...previous, ...classes])];
    if (next.length !== previous.length) await app.set(renders, next).save();
    return;
  }
}

async function rows(
  store: Store,
  table: string,
  rowClass: string,
): Promise<Resource[]> {
  const all = await Promise.all(
    (await store.query({ property: P.parent, value: table })).map(id =>
      store.getResource(id),
    ),
  );
  return all.filter(row => strings(row.get(P.isA)).includes(rowClass));
}

/** Stable partitions change display order only; persisted positions are never changed. */
export function partition(items: Item[]): {
  unchecked: Item[];
  checked: Item[];
} {
  const ordered = [...items].sort(
    (a, b) => a.position - b.position || a.subject.localeCompare(b.subject),
  );
  return {
    unchecked: ordered.filter(item => !item.done),
    checked: ordered.filter(item => item.done),
  };
}

export function matches(note: Note, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return (
    !needle ||
    [note.title, note.body, ...note.items.map(item => item.text)].some(value =>
      value.toLocaleLowerCase().includes(needle),
    )
  );
}

export async function read(store: Store, source: Source): Promise<Snapshot> {
  const klass = await store.getResource(source.rowClass);
  const type = text(klass.get(P.shortname));
  if (!['google-keep-note', 'google-keep-item'].includes(type))
    throw new Error('Choose a Google Keep notes or list items table.');
  const ontology = await store.getResource(text(klass.get(P.parent)));
  const classes = await Promise.all(
    strings(ontology.get(P.classes)).map(id => store.getResource(id)),
  );
  const noteClass = classes.find(
    c => c.get(P.shortname) === 'google-keep-note',
  );
  const itemClass = classes.find(
    c => c.get(P.shortname) === 'google-keep-item',
  );
  if (!noteClass || !itemClass)
    throw new Error(
      'The Google Keep note and item classes are missing. Open the Google Keep sync app first.',
    );
  const [nf, itf, table] = await Promise.all([
    fields(store, noteClass),
    fields(store, itemClass),
    store.getResource(source.table),
  ]);
  const nfValue = (row: Resource, name: string) =>
    text(row.get(nf.get('google-keep-' + name) ?? ''));
  const itemNote = itf.get('google-keep-item-note');
  const doneProperty = itf.get('google-keep-done');
  const positionProperty = itf.get('google-keep-position');
  const underProperty = itf.get('google-keep-under');
  if (!itemNote || !doneProperty || !positionProperty || !underProperty)
    throw new Error(
      'The Google Keep item columns are incomplete. Open the sync app first.',
    );
  const owner = table.get(P.parent);
  const sibling = async (rowClass: string) => {
    for (const id of await store.query({
      property: P.classtype,
      value: rowClass,
    })) {
      if ((await store.getResource(id)).get(P.parent) === owner) return id;
    }
    return undefined;
  };
  const itemTable =
    type === 'google-keep-item'
      ? source.table
      : await sibling(itemClass.subject);
  const noteTable =
    type === 'google-keep-note'
      ? source.table
      : await sibling(noteClass.subject);
  if (!noteTable) throw new Error('The Google Keep notes table is missing.');
  const [noteRows, itemRows] = await Promise.all([
    rows(store, noteTable, noteClass.subject),
    itemTable ? rows(store, itemTable, itemClass.subject) : Promise.resolve([]),
  ]);
  const notes = noteRows.map(row => ({
    subject: row.subject,
    title: text(row.get(P.name)),
    body: text(row.get(P.description)),
    kind: nfValue(row, 'kind'),
    presence: nfValue(row, 'presence'),
    hold: nfValue(row, 'hold'),
    items: itemRows
      .filter(item => item.get(itemNote) === row.subject)
      .map(item => {
        const position = item.get(positionProperty);
        return {
          subject: item.subject,
          text: text(item.get(P.name)),
          done: item.get(doneProperty) === true,
          under: text(item.get(underProperty)),
          position:
            typeof position === 'number' && Number.isFinite(position)
              ? position
              : 0,
        };
      }),
  }));
  await register(store, [noteClass.subject, itemClass.subject]);
  return {
    notes,
    itemTable,
    doneProperty,
    watches: [noteTable, ...(itemTable ? [itemTable] : [])],
  };
}

/** Recheck the host grant and row membership for every edit, including after revocation. */
export async function setDone(
  store: Store,
  snapshot: Snapshot,
  subject: string,
  done: boolean,
): Promise<void> {
  const data = await store.getData();
  if (
    !snapshot.itemTable ||
    data?.table !== snapshot.itemTable ||
    !snapshot.doneProperty ||
    (await store.rowAccess?.())?.status !== 'granted'
  ) {
    throw new Error(
      'Allow editing on the Google Keep list items table to tick items.',
    );
  }
  const row = await store.getResource(subject);
  if (row.get(P.parent) !== snapshot.itemTable)
    throw new Error('This item is no longer in this table.');
  await row.set(snapshot.doneProperty, done).save();
}
