// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, shaped after view-client.js and
 * atomic-server's `/app-write`:
 * - resources buffer `set` and `remove` until `save`; `save` writes only
 *   the properties set or removed since the last save, as the host does,
 *   so two copies of one resource that set different properties do not
 *   undo each other;
 * - a write naming a property that is not a Property resource (or one of
 *   Atomic's own, or a published shared property, which the host fetches
 *   from GitHub Pages) fails, as `value_for` in `store_host.rs` does;
 * - `query` is a property/value match across the whole "drive";
 * - `create` defaults `parent` to the app;
 * - `getData` reads the row class off the table, as the host does.
 * It starts with what a new App has at the pin (`createApp`): the app, of
 * the drive's App class with its `renders` and `row-extras` Properties, an
 * ontology with a row class, and a table of that class. With
 * `view: 'other'` the host hands the app a `time-entry-v1` table that is
 * not its own (the host's "+ Add view"). Test-only; not bundled.
 */
import { BASE, classes } from '../../../ontology-kit/terms.mjs';
import { atomic } from './ontology.js';
import type {
  ConnectionReference,
  HostProxyRequest,
  HostProxyResponse,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';

export const PARENT = atomic.parent;
export const IS_A = atomic.isA;
export const APP = 'did:ad:app';
export const TABLE = 'did:ad:app/table';
export const ROW_CLASS = 'did:ad:app/ontology/item';
export const ONTOLOGY = 'did:ad:app/ontology';
export const APP_CLASS = 'did:ad:class-app';
export const RENDERS = 'did:ad:property-renders';
export const ROW_EXTRAS_PROPERTY = 'did:ad:property-row-extras';
/** A `time-entry-v1` table that isn't the app's own: one it is a view of. */
export const OTHER_TABLE = 'did:ad:drive/team-hours';
const CLASSTYPE = atomic.classtype;

const BUILT_IN = new Set<string>([...Object.values(atomic)]);
const shared = (property: string) => property.startsWith(`${BASE}/properties/`);

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save'; subject: string }[];
  /** Fails the next `n` saves of rows (children of the table). */
  failRowSaves(n: number): void;
}

export function fakeStore({
  proxy,
  connections = [{ platform: 'clockify', connectionId: 'conn-1' }],
  withTable = true,
  resources: initial,
  idPrefix = 'new',
  view = 'own',
}: {
  proxy?: (request: HostProxyRequest) => Promise<HostProxyResponse>;
  connections?: ConnectionReference[];
  withTable?: boolean;
  /** Start from these resources (another device's copy of the drive);
   * used as is, not copied. */
  resources?: Map<string, Record<string, JSONValue>>;
  /** New subjects are `did:ad:<idPrefix>-<n>`: distinct per device. */
  idPrefix?: string;
  /** Which table the host hands the app: its own, or another `time-entry-v1` table. */
  view?: 'own' | 'other';
} = {}): FakeStore {
  const resources =
    initial ??
    new Map<string, Record<string, JSONValue>>([
      [
        APP,
        {
          [IS_A]: [APP_CLASS],
          [atomic.defaultOntology]: ONTOLOGY,
          [RENDERS]: [ROW_CLASS],
        },
      ],
      [APP_CLASS, { [atomic.recommends]: [RENDERS, ROW_EXTRAS_PROPERTY] }],
      [
        RENDERS,
        { [atomic.shortname]: 'renders', [IS_A]: [atomic.propertyClass] },
      ],
      [
        ROW_EXTRAS_PROPERTY,
        { [atomic.shortname]: 'row-extras', [IS_A]: [atomic.propertyClass] },
      ],
    ]);

  if (withTable && !initial) {
    resources.set(ONTOLOGY, { [PARENT]: APP, [atomic.properties]: [] });
    resources.set(ROW_CLASS, { [PARENT]: ONTOLOGY, [atomic.recommends]: [] });
    resources.set(TABLE, { [PARENT]: APP, [CLASSTYPE]: ROW_CLASS });
    resources.set(OTHER_TABLE, {
      [PARENT]: 'did:ad:drive',
      [atomic.name]: 'Team hours',
      [CLASSTYPE]: classes['time-entry-v1'].subject,
    });
  }

  const writes: FakeStore['writes'] = [];
  let next = 0;
  let failing = 0;

  const check = (propVals: Record<string, JSONValue>) => {
    for (const property of Object.keys(propVals)) {
      if (BUILT_IN.has(property) || shared(property)) continue;
      const isA = resources.get(property)?.[IS_A];
      if (!Array.isArray(isA) || !isA.includes(atomic.propertyClass))
        throw new Error(`${property} is not a property`);
    }
  };

  const wrap = (
    subject: string,
    stored: Record<string, JSONValue>,
  ): PluginResource => {
    const props = { ...stored };
    const dirty = new Set<string>();
    const removed = new Set<string>();

    return {
      subject,
      get props() {
        return { ...props };
      },
      get: property => props[property],
      set(property, value) {
        props[property] = value;
        dirty.add(property);
        removed.delete(property);

        return this;
      },
      remove(property) {
        delete props[property];
        dirty.delete(property);
        removed.add(property);

        return this;
      },
      async save() {
        if (failing > 0 && resources.get(subject)?.[PARENT] === TABLE) {
          failing--;
          throw new Error('Simulated write failure');
        }

        const changed = Object.fromEntries(
          [...dirty].map(property => [property, props[property]]),
        );
        check(changed);
        const current = { ...(resources.get(subject) ?? {}), ...changed };
        for (const property of removed) delete current[property];
        resources.set(subject, current);
        Object.assign(props, current);
        dirty.clear();
        removed.clear();
        writes.push({ op: 'save', subject });

        return this;
      },
      async destroy() {
        resources.delete(subject);
      },
    };
  };

  return {
    resources,
    writes,
    failRowSaves(n) {
      failing = n;
    },
    getApp: async () => APP,
    async getData() {
      if (!withTable) return undefined;
      const table = view === 'other' ? OTHER_TABLE : TABLE;
      const rowClass = resources.get(table)?.[CLASSTYPE];

      return {
        table,
        ...(typeof rowClass === 'string' ? { rowClass } : {}),
      };
    },
    async getResource(subject) {
      const stored = resources.get(subject);
      if (!stored) throw new Error(`No resource ${subject}`);

      return wrap(subject, stored);
    },
    async query({ property, value }) {
      return [...resources.entries()]
        .filter(([, props]) => props[property] === value)
        .map(([subject]) => subject);
    },
    async newResource({ parent, isA = [], propVals = {} } = {}) {
      check(propVals);
      const subject = `did:ad:${idPrefix}-${++next}`;
      const stored = { ...propVals, [PARENT]: parent ?? APP, [IS_A]: isA };
      resources.set(subject, stored);
      writes.push({ op: 'create', subject });

      return wrap(subject, stored);
    },
    subscribe: () => () => {},
    ...(proxy
      ? {
          proxy: {
            request: proxy,
            connections: async ({ platform }) =>
              connections.filter(c => c.platform === platform),
            connect: async () => ({ status: 'cancelled' as const }),
          },
        }
      : {}),
  };
}
