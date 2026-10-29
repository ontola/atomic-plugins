// @wc-ignore-file
/** Invented host resources for unit and browser tests. Never bundled. */
import { P } from './data.js';
import type { Store, Value } from './store.js';

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
  resources['did:test:app-class'] = { [P.recommends]: [renders] };
  resources['did:test:view-app'] = { [P.isA]: ['did:test:app-class'] };
  resources['did:test:ontology'] = {
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

  let data: { table: string; rowClass?: string } | undefined;
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
      Object.keys(resources).filter(id => resources[id][property] === value),
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
    grant: (value: boolean) => {
      granted = value;
    },
  };
}
