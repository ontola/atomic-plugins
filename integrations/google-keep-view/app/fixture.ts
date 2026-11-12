// @wc-ignore-file
/** Invented host resources for unit and browser tests. Never bundled. */
import { P, TABLE_CLASS } from './data.js';
import type { DataRef, Store, Value } from './store.js';

export function fixture() {
  const resources: Record<string, Record<string, Value>> = {};

  const prop = (shortname: string) => {
    const subject = 'did:test:' + shortname;
    resources[subject] = { [P.shortname]: shortname };

    return subject;
  };

  const kind = prop('google-keep-kind');
  const presence = prop('google-keep-presence');
  const hold = prop('google-keep-hold');
  const note = prop('google-keep-item-note');
  const done = prop('google-keep-done');
  const under = prop('google-keep-under');
  const position = prop('google-keep-position');
  const renders = prop('renders');
  const resourceRenders = prop('resource-renders');
  resources['did:test:app-class'] = {
    [P.recommends]: [renders, resourceRenders],
  };
  resources['did:test:view-app'] = { [P.isA]: ['did:test:app-class'] };
  resources['did:test:ontology'] = {
    [P.parent]: 'did:test:sync-app',
    [P.classes]: ['did:test:note-class', 'did:test:item-class'],
  };
  resources['did:test:note-class'] = {
    [P.parent]: 'did:test:ontology',
    [P.shortname]: 'google-keep-note',
    [P.recommends]: [kind, presence, hold],
  };
  resources['did:test:item-class'] = {
    [P.parent]: 'did:test:ontology',
    [P.shortname]: 'google-keep-item',
    [P.recommends]: [note, done, under, position],
  };
  resources['did:test:notes'] = {
    [P.parent]: 'did:test:sync-app',
    [P.classtype]: 'did:test:note-class',
    [P.name]: 'Invented notes',
  };
  resources['did:test:items'] = {
    [P.parent]: 'did:test:sync-app',
    [P.classtype]: 'did:test:item-class',
  };
  resources['did:test:groceries'] = {
    [P.parent]: 'did:test:notes',
    [P.isA]: ['did:test:note-class'],
    [P.name]: 'Imaginary groceries',
    [kind]: 'list',
    [presence]: 'present',
  };
  resources['did:test:thought'] = {
    [P.parent]: 'did:test:notes',
    [P.isA]: ['did:test:note-class'],
    [P.name]: 'A little thought',
    [P.description]: 'Take the scenic route.\nBring a notebook.',
    [kind]: 'text',
  };

  for (const [index, text, checked, parent] of [
    [0, 'Imaginary apples', true, ''],
    [1, 'Fictional bread', false, ''],
    [2, 'Pretend jam', false, 'did:test:item-1'],
    [3, 'Made-up tea', true, ''],
  ] as const) {
    resources['did:test:item-' + index] = {
      [P.parent]: 'did:test:items',
      [P.isA]: ['did:test:item-class'],
      [P.name]: text,
      [note]: 'did:test:groceries',
      [done]: checked,
      [under]: parent,
      [position]: index,
    };
  }

  let data: DataRef | undefined;
  let granted = false;
  const writes: string[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const store: Store = {
    getApp: async () => 'did:test:view-app',
    getData: async () => data,
    getResource: async subject => {
      if (!resources[subject])
        throw new Error('Missing test resource: ' + subject);
      const values = { ...resources[subject] };
      const row = {
        subject,
        get: (property: string) => values[property],
        set: (property: string, value: Value) => {
          values[property] = value;

          return row;
        },
        save: async () => {
          resources[subject] = { ...values };
          writes.push(subject);
          for (const listener of listeners.get(subject) ?? []) listener();
          for (const listener of listeners.get(String(values[P.parent])) ?? [])
            listener();

          return row;
        },
      };

      return row;
    },
    query: async ({ property, value }) =>
      Object.keys(resources).filter(id => {
        const actual = resources[id][property];

        return (
          actual === value || (Array.isArray(actual) && actual.includes(value))
        );
      }),
    subscribe: (subject, handler) => {
      const set = listeners.get(subject) ?? new Set<() => void>();
      listeners.set(subject, set);
      set.add(handler);

      return () => {
        set.delete(handler);
      };
    },
    rowAccess: async () => ({ status: granted ? 'granted' : 'none' }),
    requestRowAccess: async () => {
      granted = true;

      return { status: 'granted' };
    },
    getTheme: () => ({ colorScheme: 'light' }),
  };

  return {
    store,
    resources,
    writes,
    done,
    listeners,
    attach: (table: 'notes' | 'items') => {
      data = { table: 'did:test:' + table };
    },
    attachTable: (table: string) => {
      data = { table };
    },
    attachResource: (resource: string) => {
      data = { resource };
    },
    grant: (value: boolean) => {
      granted = value;
    },
  };
}

/** An imported checklist with its own class, unrelated to the sync app. */
export function importedFixture() {
  const fake = fixture();
  const { resources } = fake;

  for (const id of [
    'notes',
    'items',
    'groceries',
    'thought',
    'item-0',
    'item-1',
    'item-2',
    'item-3',
  ]) {
    delete resources['did:test:' + id];
  }

  const textProperty = 'did:test:import-text';
  const checked = 'did:test:import-checked';
  const position = 'did:test:import-position';
  const rowClass = 'did:test:import-class';
  const table = 'did:test:import-table';
  resources[P.name] = {
    [P.shortname]: 'name',
    [P.datatype]: 'https://atomicdata.dev/datatypes/string',
  };

  for (const [id, name, datatype] of [
    [textProperty, 'Text', 'string'],
    [checked, 'Checked', 'boolean'],
    [position, 'Position*', 'integer'],
  ]) {
    resources[id] = {
      [P.shortname]: 'custom-' + name.toLowerCase(),
      [P.name]: name,
      [P.datatype]: 'https://atomicdata.dev/datatypes/' + datatype,
    };
  }

  resources[rowClass] = {
    [P.shortname]: 'imported-list-items',
    [P.name]: 'List item',
    [P.recommends]: [P.name, textProperty, checked],
    [P.requires]: [position],
  };
  resources[table] = {
    [P.isA]: [TABLE_CLASS],
    [P.name]: 'Invented groceries · List',
    [P.parent]: 'did:test:imports-folder',
    [P.classtype]: rowClass,
  };

  for (const [id, name, done, order] of [
    ['apples', 'Imaginary apples', true, 0],
    ['tea', 'Fictional tea', false, 2],
    ['toast', 'Pretend toast', false, 1],
  ] as const) {
    resources['did:test:import-' + id] = {
      [P.parent]: table,
      [P.isA]: [rowClass],
      [P.name]: 'Imported row ' + id,
      [textProperty]: name,
      [checked]: done,
      [position]: order,
    };
  }

  return { ...fake, table, rowClass, checked, textProperty, position };
}

/** The host migrates the original notes container in place into an account folder. */
export function folderFixture() {
  const fake = fixture();
  fake.resources['did:test:notes'][P.parent] = 'did:test:drive';
  fake.resources['did:test:notes'][P.isA] = [
    'https://atomicdata.dev/classes/Folder',
  ];
  fake.resources['did:test:notes'][P.name] =
    'Google Keep fictional@example.test';
  fake.resources['did:test:app-data'] = { [P.shortname]: 'app-data' };
  fake.resources['did:test:app-class'][P.recommends] = [
    'did:test:renders',
    'did:test:resource-renders',
    'did:test:app-data',
  ];
  fake.resources['did:test:sync-app'] = {
    [P.isA]: ['did:test:app-class'],
    ['did:test:app-data']: 'did:test:notes',
  };

  return fake;
}
