// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, shaped after view-client.js and laid
 * out the way `createApp` lays out an app (app -> ontology -> row class, and
 * app -> table), like ../app/fakeStore.ts. `proxy` answers from the same
 * Todoist fixture the mock integration proxy serves
 * (`../fixtures/todoist/scenario.mjs`), whose drivers a test calls directly
 * on `todoist`. Test-only; not bundled.
 */
import { todoistFixture } from '../fixtures/todoist/scenario.mjs';
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
/** The drive's plugin vocabulary, as `pluginSchema()` mints it per drive. */
export const APP_CLASS = 'did:ad:plugin-class-app';
export const RENDERS = 'did:ad:plugin-renders';
export const ROW_EXTRAS = 'did:ad:plugin-row-extras';
/** Someone else's issue-v1 table the app can be added to as a view. */
export const OTHER_TABLE = 'did:ad:table-theirs';

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save'; subject: string }[];
  readonly calls: HostProxyRequest[];
  readonly todoist: ReturnType<typeof todoistFixture>;
  /** Makes every relayed call throw with this host error until cleared. */
  fail?: string;
  /**
   * Answers the next `count` relayed calls with 429 and this `retry-after`
   * header (seconds or an HTTP date; none when undefined), as Todoist would
   * through the proxy. `only` limits it to list pages or by-id lookups.
   * Cleared once spent.
   */
  limitNext?: { count: number; retryAfter?: string; only?: 'list' | 'lookup' };
  /** Subjects passed to `openResource`. */
  readonly openedRows: string[];
}

export function fakeStore({
  connected = true,
  existing = false,
  relay = true,
  table = TABLE,
}: {
  /** The table the app is shown on; OTHER_TABLE is a view on someone's table. */
  table?: string;
  connected?: boolean;
  /** `proxy.connect` resolves `connected` (the host's "Use existing connection"). */
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
    [APP_CLASS, { [SHORTNAME]: 'app', [RECOMMENDS]: [RENDERS, ROW_EXTRAS] }],
    [RENDERS, { [SHORTNAME]: 'renders' }],
    [ROW_EXTRAS, { [SHORTNAME]: 'row-extras' }],
    [ONTOLOGY, { [PARENT]: APP, [PROPERTIES]: [] }],
    [ROW_CLASS, { [PARENT]: ONTOLOGY, [NAME]: 'Item', [RECOMMENDS]: [NAME] }],
    [TABLE, { [PARENT]: APP, [NAME]: 'Items', [CLASSTYPE]: ROW_CLASS }],
    [
      OTHER_TABLE,
      {
        [PARENT]: 'did:ad:someone',
        [NAME]: 'Their issues',
        [CLASSTYPE]: ROW_CLASS,
      },
    ],
  ]);
  const writes: FakeStore['writes'] = [];
  const calls: HostProxyRequest[] = [];
  const todoist = todoistFixture();
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

      const kind = /\/tasks\/[^?]/.test(request.path) ? 'lookup' : 'list';

      if (
        fake.limitNext &&
        fake.limitNext.count > 0 &&
        (fake.limitNext.only ?? kind) === kind
      ) {
        const { retryAfter } = fake.limitNext;
        if (--fake.limitNext.count <= 0) delete fake.limitNext;

        return {
          status: 429,
          headers:
            retryAfter === undefined ? {} : { 'retry-after': retryAfter },
          body: { error: 'Synthetic rate limit (429)' },
        };
      }

      const result = todoist.request(
        request.method ?? 'GET',
        new URL(`/proxy/todoist${request.path}`, 'https://proxy.example'),
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

  const openedRows: string[] = [];

  const fake: FakeStore = {
    resources,
    writes,
    calls,
    todoist,
    openedRows,
    async openResource(subject) {
      openedRows.push(subject);

      return { status: 'opened' as const, subject };
    },
    getApp: async () => APP,
    getData: async () => {
      const classtype = resources.get(table)?.[CLASSTYPE];

      return {
        table,
        ...(typeof classtype === 'string' ? { rowClass: classtype } : {}),
      };
    },
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
