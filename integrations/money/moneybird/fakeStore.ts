// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, shaped after view-client.js and laid
 * out the way `createApp` lays out an app: app -> ontology (the App's
 * `default-ontology`) -> row class, and app -> table; plus the drive's App
 * class with its `renders` and `row-extras` Properties. `proxy` answers from
 * the same synthetic Moneybird fixture the mock integration proxy serves
 * (`../fixtures/moneybird/scenario.mjs`).
 *
 * With `foreign`, `getData()` is a table the app is a view of instead
 * (`OTHER_TABLE`, under the drive, of the given class), and `rowAccess()` /
 * `requestRowAccess()` play the host's row grant: none until the person
 * allows (`ask: 'allow'`), then a grant for the `row-extras` the App declares
 * at that moment. Test-only; not bundled. Adapted from
 * `integrations/pets/app/fakeStore.ts` and timesheets' fake.
 */
import { moneybirdFixture } from '../fixtures/moneybird/scenario.mjs';
import type {
  HostProxy,
  HostProxyRequest,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';
import {
  CLASSTYPE,
  DEFAULT_ONTOLOGY,
  IS_A,
  NAME,
  PARENT,
  PROPERTIES,
  RECOMMENDS,
  SHORTNAME,
} from './sync.js';

export const DRIVE = 'did:ad:drive';
export const APP = 'did:ad:app';
export const APP_CLASS = 'did:ad:class-app';
export const RENDERS_PROPERTY = 'did:ad:property-renders';
export const ROW_EXTRAS_PROPERTY = 'did:ad:property-row-extras';
export const ONTOLOGY = 'did:ad:ontology';
export const ROW_CLASS = 'did:ad:class-item';
export const TABLE = 'did:ad:table-items';
/** A table the person made, of a shared class, which the app is a view of. */
export const OTHER_TABLE = 'did:ad:table-other';

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save' | 'destroy'; subject: string }[];
  readonly calls: HostProxyRequest[];
  readonly fixture: ReturnType<typeof moneybirdFixture>;
  /** The live grant on OTHER_TABLE: the extras it covers, or none. */
  grant(): { extras: string[] } | undefined;
}

export interface FakeOptions {
  connected?: boolean;
  relay?: boolean;
  outage?: boolean;
  mutationCap?: number;
  /** Show the app on OTHER_TABLE, a table of this class, instead of its own. */
  foreign?: { rowClass: string; name?: string };
  /** What the person answers when asked for "Allow editing". */
  ask?: 'allow' | 'deny';
  /** Whether the host has `rowAccess` and `requestRowAccess`. */
  grants?: boolean;
}

export function fakeStore({
  connected = true,
  relay = true,
  outage = true,
  mutationCap,
  foreign,
  ask = 'allow',
  grants = true,
}: FakeOptions = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>([
    [
      APP,
      {
        [NAME]: 'New app',
        [PARENT]: DRIVE,
        [IS_A]: [APP_CLASS],
        [DEFAULT_ONTOLOGY]: ONTOLOGY,
      },
    ],
    [
      APP_CLASS,
      { [RECOMMENDS]: [RENDERS_PROPERTY, ROW_EXTRAS_PROPERTY], [NAME]: 'App' },
    ],
    [RENDERS_PROPERTY, { [SHORTNAME]: 'renders' }],
    [ROW_EXTRAS_PROPERTY, { [SHORTNAME]: 'row-extras' }],
    [ONTOLOGY, { [PARENT]: APP, [PROPERTIES]: [] }],
    [ROW_CLASS, { [PARENT]: ONTOLOGY, [NAME]: 'Item', [RECOMMENDS]: [NAME] }],
    [TABLE, { [PARENT]: APP, [NAME]: 'Items', [CLASSTYPE]: ROW_CLASS }],
  ]);
  if (foreign)
    resources.set(OTHER_TABLE, {
      [PARENT]: DRIVE,
      [NAME]: foreign.name ?? 'Team table',
      [CLASSTYPE]: foreign.rowClass,
    });
  const writes: FakeStore['writes'] = [];
  const calls: HostProxyRequest[] = [];
  const fixture = moneybirdFixture({
    outage,
    ...(mutationCap === undefined ? {} : { mutationCap }),
  });
  let grant: { extras: string[] } | undefined;
  let next = 0;

  const declared = () => {
    const value = resources.get(APP)?.[ROW_EXTRAS_PROPERTY];

    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : [];
  };

  const wrap = (
    subject: string,
    stored: Record<string, JSONValue>,
  ): PluginResource => {
    const props = { ...stored };

    return {
      subject,
      get props() {
        return { ...props };
      },
      get: property => props[property],
      set(property, value) {
        props[property] = value;

        return this;
      },
      remove(property) {
        delete props[property];

        return this;
      },
      async save() {
        resources.set(subject, { ...props });
        writes.push({ op: 'save', subject });

        return this;
      },
      async destroy() {
        resources.delete(subject);
        writes.push({ op: 'destroy', subject });
      },
    };
  };

  const proxy: HostProxy = {
    async request(request) {
      calls.push(request);
      const url = new URL(
        `/proxy/${request.platform}${request.path}`,
        'https://proxy.example',
      );
      const result = fixture.request(request.method ?? 'GET', url);

      return {
        status: result.status,
        headers: Object.fromEntries(
          Object.entries(result.headers ?? {}).map(([k, v]) => [
            k.toLowerCase(),
            String(v),
          ]),
        ),
        body: result.body,
      };
    },
    async connections({ platform }) {
      return connected ? [{ connectionId: 'c1', platform }] : [];
    },
    connect: () => new Promise(() => {}),
  };

  return {
    resources,
    writes,
    calls,
    fixture,
    grant: () => grant,
    getApp: async () => APP,
    getData: async () =>
      foreign
        ? { table: OTHER_TABLE, rowClass: foreign.rowClass }
        : { table: TABLE, rowClass: ROW_CLASS },
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
      const subject = `did:ad:new-${++next}`;
      const stored = { ...propVals, [PARENT]: parent ?? APP, [IS_A]: isA };
      resources.set(subject, stored);
      writes.push({ op: 'create', subject });

      return wrap(subject, stored);
    },
    subscribe: () => () => {},
    ...(relay ? { proxy } : {}),
    ...(grants
      ? {
          async rowAccess() {
            if (!foreign) return { status: 'unavailable' as const };
            if (!grant) return { status: 'none' as const };

            return {
              status: 'granted' as const,
              grantedBy: 'did:ad:agent-person',
              grantedAt: 1,
              via: 'did:ad:view',
              // A grant covers only extras declared when it was given and
              // still declared now (atomic-server#1849).
              extras: grant.extras.filter(extra => declared().includes(extra)),
            };
          },
          async requestRowAccess() {
            if (!foreign)
              return {
                status: 'denied' as const,
                reason: 'Not shown as a table’s view',
              };
            const live = declared();
            if (grant && live.every(extra => grant!.extras.includes(extra)))
              return { status: 'granted' as const };
            if (ask === 'deny')
              return { status: 'denied' as const, reason: 'Not now' };
            grant = { extras: live };

            return { status: 'granted' as const };
          },
        }
      : {}),
  };
}
