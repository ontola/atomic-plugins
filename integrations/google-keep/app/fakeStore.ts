// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, laid out the way `createApp` lays
 * out an app (app -> ontology -> row class, and app -> table), like the
 * Google Tasks app's. `proxy` answers from the same Google Keep fixture the
 * mock integration proxy serves (`../fixtures/google-keep/scenario.mjs`),
 * whose drivers a test calls directly on `google`. Test-only; not bundled.
 */
import { googleKeepFixture } from '../fixtures/google-keep/scenario.mjs';
import {
  CLASSTYPE,
  DEFAULT_ONTOLOGY,
  IS_A,
  NAME,
  PARENT,
  PROPERTIES,
  RECOMMENDS,
  SHORTNAME,
} from './drive.js';
import type {
  HostProxy,
  HostProxyRequest,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';

export const APP = 'did:ad:app';
export const ONTOLOGY = 'did:ad:ontology';
export const ROW_CLASS = 'did:ad:class-item';
export const TABLE = 'did:ad:table-items';
export const APP_CLASS = 'did:ad:plugin-class-app';
export const RENDERS = 'did:ad:plugin-renders';
export const OTHER_TABLE = 'did:ad:table-theirs';

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save'; subject: string }[];
  readonly calls: HostProxyRequest[];
  readonly google: ReturnType<typeof googleKeepFixture>;
  fail?: string;
}

export function fakeStore({
  connected = true,
  existing = false,
  relay = true,
  table = TABLE,
}: {
  table?: string;
  connected?: boolean;
  existing?: boolean;
  relay?: boolean;
} = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>([
    [
      APP,
      {
        [NAME]: 'New app',
        [IS_A]: [APP_CLASS],
        [DEFAULT_ONTOLOGY]: ONTOLOGY,
        [RENDERS]: [ROW_CLASS],
      },
    ],
    [APP_CLASS, { [SHORTNAME]: 'app', [RECOMMENDS]: [RENDERS] }],
    [RENDERS, { [SHORTNAME]: 'renders' }],
    [ONTOLOGY, { [PARENT]: APP, [PROPERTIES]: [] }],
    [ROW_CLASS, { [PARENT]: ONTOLOGY, [NAME]: 'Item', [RECOMMENDS]: [NAME] }],
    [TABLE, { [PARENT]: APP, [NAME]: 'Items', [CLASSTYPE]: ROW_CLASS }],
    [
      OTHER_TABLE,
      { [PARENT]: 'did:ad:someone', [NAME]: 'Theirs', [CLASSTYPE]: ROW_CLASS },
    ],
  ]);
  const writes: FakeStore['writes'] = [];
  const calls: HostProxyRequest[] = [];
  const google = googleKeepFixture();
  let next = 0;

  const wrap = (
    subject: string,
    stored: Record<string, JSONValue>,
  ): PluginResource => {
    const props = structuredClone(stored);
    const removed = new Set<string>();

    return {
      subject,
      get props() {
        return { ...props };
      },
      get: property => props[property],
      set(property, value) {
        props[property] = value;
        removed.delete(property);

        return this;
      },
      remove(property) {
        delete props[property];
        removed.add(property);

        return this;
      },
      async save() {
        const saved = { ...resources.get(subject), ...structuredClone(props) };
        for (const property of removed) delete saved[property];
        removed.clear();
        resources.set(subject, saved);
        writes.push({ op: 'save', subject });

        return this;
      },
      async destroy() {
        resources.delete(subject);
      },
    };
  };

  const proxy: HostProxy = {
    async request(request) {
      calls.push(request);
      if (fake.fail) throw new Error(fake.fail);
      const url = new URL(
        `/proxy/google-keep${request.path}`,
        'https://proxy.example',
      );
      for (const [name, value] of Object.entries(request.query ?? {}))
        url.searchParams.set(name, value);
      const result = google.request(
        request.method ?? 'GET',
        url,
        request.body ? JSON.parse(request.body) : {},
      );

      return { status: result.status, headers: {}, body: result.body };
    },
    async connections({ platform }) {
      return connected ? [{ connectionId: 'c1', platform }] : [];
    },
    connect: ({ platform }) => {
      if (!existing) return new Promise(() => {});
      connected = true;

      return Promise.resolve({
        status: 'connected' as const,
        connectionId: 'c1',
        platform,
      });
    },
  };

  const fake: FakeStore = {
    resources,
    writes,
    calls,
    google,
    getApp: async () => APP,
    getData: async () => ({ table }),
    async getResource(subject) {
      const stored = resources.get(subject);
      if (!stored) throw new Error(`No resource ${subject}`);

      return wrap(subject, stored);
    },
    async query({ property, value }) {
      const out: string[] = [];
      for (const [subject, props] of resources)
        if (props[property] === value) out.push(subject);

      return out;
    },
    async newResource({ parent, isA = [], propVals = {} } = {}) {
      const subject = `did:ad:new-${++next}`;
      const stored = {
        ...structuredClone(propVals),
        [PARENT]: parent ?? APP,
        [IS_A]: isA,
      };
      resources.set(subject, stored);
      writes.push({ op: 'create', subject });

      return wrap(subject, stored);
    },
    subscribe: () => () => {},
    ...(relay ? { proxy } : {}),
  };

  return fake;
}
