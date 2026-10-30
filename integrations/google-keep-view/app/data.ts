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
  datatype: A + 'datatype',
};
export const FOLDER_CLASS = 'https://atomicdata.dev/classes/Folder';
export const TABLE_CLASS = 'https://atomicdata.dev/classes/Table';
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
  /** Present for a folder or individual resource page, never a table grant. */
  resource?: string;
  title?: string;
  single?: boolean;
  container?: string;
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

interface ChecklistColumns {
  text: string;
  done: string;
  position?: string;
  under?: string;
}

/** Imported lists keep their own classes and columns. Match the declared
 * field meanings and datatypes, rather than requiring the sync app's classes.
 */
async function checklistColumns(
  store: Store,
  klass: Resource,
): Promise<ChecklistColumns | undefined> {
  const properties = await Promise.all(
    [
      ...new Set([
        ...strings(klass.get(P.recommends)),
        ...strings(klass.get(P.requires)),
      ]),
    ].map(id => store.getResource(id)),
  );
  const key = (value: Value) =>
    text(value)
      .trim()
      .replace(/\*$/, '')
      .replace(/[\s_-]+/g, '')
      .toLowerCase();

  const find = (names: string[], types: string[]) => {
    for (const name of names) {
      const property = properties.find(
        candidate =>
          types.some(
            type =>
              candidate.get(P.datatype) ===
              `https://atomicdata.dev/datatypes/${type}`,
          ) &&
          [candidate.get(P.shortname), candidate.get(P.name)].some(
            value => key(value) === name,
          ),
      );
      if (property) return property.subject;
    }

    return undefined;
  };

  const itemText = find(
    [
      'text',
      'itemtext',
      'arrayitemtext',
      'arrayitem',
      'name',
      'title',
      'item',
      'value',
    ],
    ['string', 'markdown'],
  );
  const done = find(['checked', 'done', 'completed', 'bought'], ['boolean']);
  if (!itemText || !done) return undefined;

  return {
    text: itemText,
    done,
    position: find(['position', 'index', 'order'], ['integer', 'float']),
    under: find(['under', 'parentitem', 'parentlistitem'], ['atomicURL']),
  };
}

export async function acceptsClass(
  store: Store,
  rowClass: string,
): Promise<boolean> {
  const klass = await store.getResource(rowClass);

  return (
    ['google-keep-note', 'google-keep-item'].includes(
      text(klass.get(P.shortname)),
    ) || !!(await checklistColumns(store, klass))
  );
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

  const known = new Set(out.map(source => source.table));
  const classes = new Map<string, Promise<boolean>>();
  const imported = await Promise.all(
    (await store.query({ property: P.isA, value: TABLE_CLASS })).map(
      async id => {
        if (known.has(id)) return undefined;

        try {
          const table = await store.getResource(id);
          const rowClass = text(table.get(P.classtype));
          if (!rowClass) return undefined;
          let compatible = classes.get(rowClass);

          if (!compatible) {
            compatible = store.getResource(rowClass).then(
              async klass =>
                // The sync app's items are already grouped with its notes above.
                !['google-keep-note', 'google-keep-item'].includes(
                  text(klass.get(P.shortname)),
                ) && !!(await checklistColumns(store, klass)),
            );
            classes.set(rowClass, compatible);
          }

          if (!(await compatible)) return undefined;

          return {
            table: id,
            rowClass,
            name: text(table.get(P.name)) || 'Checklist',
          };
        } catch {
          // An unreadable or incomplete unrelated schema is not a source.
          return undefined;
        }
      },
    ),
  );
  out.push(...imported.filter((source): source is Source => !!source));

  return out;
}

/** Table views and resource pages declare their capabilities separately. */
export async function register(store: Store, classes: string[]): Promise<void> {
  const app = await store.getResource(await store.getApp());

  for (const id of strings(app.get(P.isA))) {
    const terms = await fields(store, await store.getResource(id));
    const renders = terms.get('renders');
    const resourceRenders = terms.get('resource-renders');
    if (!renders && !resourceRenders) continue;
    let changed = false;

    const include = (property: string, supported: string[]) => {
      const previous = strings(app.get(property));
      const next = [...new Set([...previous, ...supported])];
      if (next.length === previous.length) return;
      app.set(property, next);
      changed = true;
    };

    if (renders) include(renders, classes);

    if (resourceRenders) {
      const notes: string[] = [];

      for (const klass of new Set(classes)) {
        if (
          (await store.getResource(klass)).get(P.shortname) ===
          'google-keep-note'
        )
          notes.push(klass);
      }

      // Item and imported-checklist row classes are table capabilities only:
      // readResource accepts a note page or an explicitly bound account folder.
      include(resourceRenders, notes);
    }

    if (changed) await app.save();

    return;
  }
}

async function rows(
  store: Store,
  table: string,
  rowClass: string,
  where: { property: string; value: string } = {
    property: P.parent,
    value: table,
  },
): Promise<Resource[]> {
  const all = await Promise.all(
    (await store.query(where)).map(id => store.getResource(id)),
  );

  return all.filter(
    row =>
      row.get(P.parent) === table && strings(row.get(P.isA)).includes(rowClass),
  );
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

export async function read(
  store: Store,
  source: Source,
  onlyNote?: string,
): Promise<Snapshot> {
  const klass = await store.getResource(source.rowClass);
  const type = text(klass.get(P.shortname));

  if (!['google-keep-note', 'google-keep-item'].includes(type)) {
    const columns = await checklistColumns(store, klass);
    if (!columns)
      throw new Error(
        'Choose a Keep notes table or a checklist with text and a boolean Checked or Done column.',
      );
    const [table, items] = await Promise.all([
      store.getResource(source.table),
      rows(store, source.table, source.rowClass),
    ]);
    await register(store, [source.rowClass]);

    return {
      notes: [
        {
          subject: source.table,
          title: text(table.get(P.name)) || source.name,
          kind: 'list',
          body: '',
          presence: '',
          hold: '',
          items: items.map((item, index) => {
            const position = columns.position
              ? item.get(columns.position)
              : undefined;

            return {
              subject: item.subject,
              text: text(item.get(columns.text)),
              done: item.get(columns.done) === true,
              under: columns.under ? text(item.get(columns.under)) : '',
              position:
                typeof position === 'number' && Number.isFinite(position)
                  ? position
                  : index,
            };
          }),
        },
      ],
      itemTable: source.table,
      doneProperty: columns.done,
      watches: [source.table],
    };
  }

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
  // The notes container may be a root-level account folder. Its schema stays
  // under the sync app, alongside the hidden list-items table.
  const owner = text(ontology.get(P.parent)) || table.get(P.parent);

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

  const ownNotes = async () => {
    const app = await store.getResource(String(owner)).catch(() => undefined);

    for (const id of strings(app?.get(P.isA))) {
      const terms = await fields(store, await store.getResource(id));
      const property = terms.get('app-data');
      const target = property ? text(app?.get(property)) : '';
      if (!target) continue;
      const container = await store.getResource(target);
      if (container.get(P.classtype) === noteClass.subject) return target;
    }

    return sibling(noteClass.subject);
  };

  const noteTable =
    type === 'google-keep-note' ? source.table : await ownNotes();
  if (!noteTable) throw new Error('The Google Keep notes table is missing.');
  const [noteRows, itemRows] = await Promise.all([
    onlyNote
      ? store
          .getResource(onlyNote)
          .then(row =>
            row.get(P.parent) === noteTable &&
            strings(row.get(P.isA)).includes(noteClass.subject)
              ? [row]
              : [],
          )
      : rows(store, noteTable, noteClass.subject),
    itemTable
      ? rows(
          store,
          itemTable,
          itemClass.subject,
          onlyNote ? { property: itemNote, value: onlyNote } : undefined,
        )
      : Promise.resolve([]),
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

/** Read precisely the folder or note the host opened, never another account. */
export async function readResource(
  store: Store,
  subject: string,
): Promise<Snapshot> {
  const target = await store.getResource(subject);
  const rowClass = text(target.get(P.classtype));

  if (strings(target.get(P.isA)).includes(FOLDER_CLASS) && rowClass) {
    const klass = await store.getResource(rowClass);
    if (klass.get(P.shortname) !== 'google-keep-note')
      throw new Error('This folder does not contain Google Keep notes.');
    const snapshot = await read(store, {
      table: subject,
      rowClass,
      name: text(target.get(P.name)),
    });

    return {
      ...snapshot,
      resource: subject,
      title: text(target.get(P.name)) || 'Google Keep',
      single: false,
    };
  }

  for (const id of strings(target.get(P.isA))) {
    const klass = await store.getResource(id);
    if (klass.get(P.shortname) !== 'google-keep-note') continue;
    const parent = text(target.get(P.parent));
    if (!parent) break;
    const container = await store.getResource(parent);
    if (container.get(P.classtype) !== id) break;
    const snapshot = await read(
      store,
      {
        table: parent,
        rowClass: id,
        name: text(container.get(P.name)),
      },
      subject,
    );
    const note = snapshot.notes.find(
      candidate => candidate.subject === subject,
    );
    if (!note) break;

    return {
      ...snapshot,
      notes: [note],
      resource: subject,
      title: note.title || 'Untitled note',
      single: true,
      container: parent,
      watches: [...snapshot.watches, subject],
    };
  }

  throw new Error('This resource is not a Google Keep note or account folder.');
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
    !!data?.resource ||
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
