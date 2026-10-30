// @wc-ignore-file
/**
 * An in-memory host `store` for the learning app's tests: resources with
 * properties, `query` by equality or list membership, `getMany`, and the row
 * grant ("Allow editing") the host asks the person for on a table the app did
 * not make. It enforces nothing else.
 */
import { properties } from '../../../ontology-kit/terms-v2.mjs';
import type { JSONValue, PluginResource, PluginStore } from './store.js';

const A = 'https://atomicdata.dev/properties/';

export const APP = 'fake:app';
export const APP_CLASS = 'fake:app-class';
export const RENDERS = 'fake:renders';
export const OWN_TABLE = 'fake:app-table';
export const OWN_ROW_CLASS = 'fake:app-row-class';

export interface FakeStore extends PluginStore {
  resources: Map<string, Record<string, JSONValue>>;
  /** Subjects created through `newResource`, in order. */
  created: string[];
  grant: { asked: number; answer: 'granted' | 'denied'; held: boolean };
  /** Rows of a class in a table, as props. */
  rowsOf(table: string, klass?: string): Record<string, JSONValue>[];
}

export function fakeStore(
  options: { data?: { table: string; rowClass?: string } | null } = {},
): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>();
  const created: string[] = [];
  const grant: FakeStore['grant'] = {
    asked: 0,
    answer: 'granted',
    held: false,
  };
  let counter = 0;

  resources.set(APP_CLASS, { [A + 'recommends']: [RENDERS] });
  resources.set(RENDERS, { [A + 'shortname']: 'renders' });
  resources.set(APP, { [A + 'isA']: [APP_CLASS] });
  resources.set(OWN_TABLE, {
    [A + 'parent']: APP,
    [A + 'classtype']: OWN_ROW_CLASS,
  });

  const wrap = (subject: string): PluginResource => {
    const props = resources.get(subject);
    if (!props) throw new Error(`not found: ${subject}`);
    const staged: Record<string, JSONValue> = {};

    const resource: PluginResource = {
      subject,
      get props() {
        return { ...props, ...staged };
      },
      get: property =>
        property in staged ? staged[property] : props[property],
      set: (property, value) => {
        staged[property] = value;

        return resource;
      },
      remove: property => {
        staged[property] = undefined;

        return resource;
      },
      save: async () => {
        Object.assign(props, staged);
        for (const key of Object.keys(staged)) delete staged[key];

        return resource;
      },
      destroy: async () => void resources.delete(subject),
    };

    return resource;
  };

  const store: FakeStore = {
    resources,
    created,
    grant,
    getApp: async () => APP,
    getData: async () =>
      options.data === null
        ? undefined
        : (options.data ?? { table: OWN_TABLE, rowClass: OWN_ROW_CLASS }),
    getResource: async subject => wrap(subject),
    query: async ({ property, value }) =>
      [...resources]
        .filter(
          ([, p]) =>
            p[property] === value ||
            (Array.isArray(p[property]) &&
              (p[property] as JSONValue[]).includes(value)),
        )
        .map(([s]) => s),
    newResource: async ({ parent, isA, propVals } = {}) => {
      // The host's rule: a new row of a table the app did not make needs the grant.
      const outside =
        parent &&
        parent !== APP &&
        resources.get(parent)?.[A + 'parent'] !== APP;
      if (outside && !grant.held)
        throw new Error('This app may only write its own data.');
      const subject = `fake:r${(counter += 1)}`;
      resources.set(subject, {
        ...propVals,
        [A + 'parent']: parent,
        [A + 'isA']: isA,
      });
      created.push(subject);

      return wrap(subject);
    },
    subscribe: () => () => undefined,
    getMany: async subjects =>
      subjects.map(s =>
        resources.has(s) ? wrap(s) : { subject: s, error: 'not found' },
      ),
    rowAccess: async () => ({ status: grant.held ? 'granted' : 'none' }),
    requestRowAccess: async () => {
      grant.asked += 1;
      grant.held = grant.answer === 'granted';

      return { status: grant.answer };
    },
    rowsOf: (table, klass) =>
      [...resources.values()].filter(
        p =>
          p[A + 'parent'] === table &&
          (!klass || (p[A + 'isA'] as string[] | undefined)?.includes(klass)),
      ),
  };

  return store;
}

/** A hand-made table of `klass` outside the app, as someone else's tree. */
export function foreignTable(
  store: FakeStore,
  klass: string,
  subject = 'fake:foreign-table',
): string {
  store.resources.set(subject, {
    [A + 'parent']: 'fake:drive',
    [A + 'classtype']: klass,
  });

  return subject;
}

export const term = (name: keyof typeof properties) => properties[name].subject;
