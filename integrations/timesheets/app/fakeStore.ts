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
 * not its own (the host's "+ Add view").
 *
 * On `OTHER_TABLE` writes follow the pinned host's row grant (atomic-server
 * `app_row_grant.rs` `check_scope`, #1740 and #1849): none without a grant;
 * with one, only `time-entry-v1`'s `requires` and `recommends` plus the
 * `row-extras` the App declared when it was granted (and still declares),
 * on rows of that class; a new row has `isA` exactly [time-entry-v1]; never
 * the table itself, never `destroy`. `rowAccess()` and `requestRowAccess()`
 * answer as view-client.js does. Test-only; not bundled.
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
  /** The live row grant on `OTHER_TABLE`: the extras it covers, or none. */
  readonly grant: { extras: string[] } | undefined;
  /** Someone takes the grant back in the host's tab menu. */
  revokeGrant(): void;
  /** How many times the host asked the person ("Allow editing"). */
  readonly asked: number;
  /** What the person answers the next time the host asks. */
  answerWith(answer: 'allow' | 'deny'): void;
}

export function fakeStore({
  proxy,
  connections = [{ platform: 'clockify', connectionId: 'conn-1' }],
  withTable = true,
  resources: initial,
  idPrefix = 'new',
  view = 'own',
  grant: initialGrant = 'none',
  rowGrants = true,
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
  /**
   * The grant on `OTHER_TABLE` before the app opens: none, or "Allow
   * editing" from Add view before the app declared its row extras
   * (`columns`, covering none of them).
   */
  grant?: 'none' | 'columns';
  /** Whether the host has `rowAccess` and `requestRowAccess`. */
  rowGrants?: boolean;
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
  let grant: { extras: string[] } | undefined =
    initialGrant === 'columns' ? { extras: [] } : undefined;
  let asked = 0;
  let answer: 'allow' | 'deny' = 'allow';
  const ENTRY = classes['time-entry-v1'];

  /** The App's `row-extras` now. */
  const declared = () => {
    const value = resources.get(APP)?.[ROW_EXTRAS_PROPERTY];

    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : [];
  };

  /** Refuses a write the pinned host's row grant would refuse. */
  const checkGrant = (
    subject: string,
    parent: JSONValue,
    isA: JSONValue,
    written: string[],
    op: 'create' | 'save' | 'destroy',
  ) => {
    if (subject === OTHER_TABLE)
      throw new Error('This app may only write its own data.');
    if (parent !== OTHER_TABLE) return;
    if (!grant)
      throw new Error(
        'This app is a view of this table but may not edit its rows.',
      );
    if (op === 'destroy')
      throw new Error('Letting an app edit rows does not let it delete them');
    if (
      op === 'create'
        ? !Array.isArray(isA) || isA.length !== 1 || isA[0] !== ENTRY.subject
        : !Array.isArray(isA) || !isA.includes(ENTRY.subject)
    )
      throw new Error('This app may only edit rows of the table’s row class');
    const live = declared();
    const allowed = new Set<string>([
      ...ENTRY.requires,
      ...ENTRY.recommends,
      ...grant.extras.filter(extra => live.includes(extra)),
    ]);

    for (const property of written)
      if (!allowed.has(property))
        throw new Error(
          `This app may edit this table's columns and the row data it was allowed to keep, not ${property}`,
        );
  };

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
        const before = resources.get(subject) ?? {};
        checkGrant(
          subject,
          before[PARENT],
          before[IS_A],
          [...dirty, ...removed],
          'save',
        );
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
        const before = resources.get(subject) ?? {};
        checkGrant(subject, before[PARENT], before[IS_A], [], 'destroy');
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
      checkGrant('', parent ?? APP, isA, Object.keys(propVals), 'create');
      const subject = `did:ad:${idPrefix}-${++next}`;
      const stored = { ...propVals, [PARENT]: parent ?? APP, [IS_A]: isA };
      resources.set(subject, stored);
      writes.push({ op: 'create', subject });

      return wrap(subject, stored);
    },
    subscribe: () => () => {},
    get grant() {
      return grant;
    },
    revokeGrant: () => {
      grant = undefined;
    },
    get asked() {
      return asked;
    },
    answerWith(chosen) {
      answer = chosen;
    },
    ...(rowGrants
      ? {
          async rowAccess() {
            if (view === 'own') return { status: 'unavailable' as const };

            return grant
              ? {
                  status: 'granted' as const,
                  grantedBy: 'did:ad:agent-person',
                  grantedAt: 1,
                  via: 'request',
                  extras: [...grant.extras],
                }
              : { status: 'none' as const };
          },
          async requestRowAccess() {
            if (view === 'own')
              return {
                status: 'denied' as const,
                reason: 'This app is not shown as a table view here',
              };
            const live = declared();
            // As the host: no question when the grant covers the list.
            if (grant && live.every(extra => grant!.extras.includes(extra)))
              return { status: 'granted' as const };
            asked++;
            if (answer === 'deny')
              return { status: 'denied' as const, reason: 'You said not now' };
            // A new grant, for the list as the App declares it now.
            grant = { extras: live };

            return { status: 'granted' as const };
          },
        }
      : {}),
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
