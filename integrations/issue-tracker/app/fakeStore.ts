// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, shaped after view-client.js and laid
 * out the way `createApp` lays out an app (app -> ontology -> row class, and
 * app -> table), like pets' and notion's fakes. `proxy` answers from the same
 * GitHub fixture the mock integration proxy serves
 * (`../fixtures/github-issues/scenario.mjs`), seeded repository included.
 *
 * Two host behaviours the real page has and the adapter must survive can be
 * switched on: `lagReads` (a read after an app write returns the old values
 * that many times) and `hideFromQuery` (a `query` leaves out resources the
 * app created until that many queries later). Test-only; not bundled.
 *
 * On a `table` that isn't the app's own (an `issue-v1` table the app is a
 * view of) writes follow the pinned host's row grant (atomic-server
 * `app_row_grant.rs`, #1740 and #1849): none on its rows without a grant;
 * with one, only `issue-v1`'s `requires` and `recommends` plus the
 * `row-extras` the App declared when it was granted, on rows of exactly
 * that class; never the table itself, never `destroy`. `rowAccess()` and
 * `requestRowAccess()` answer as view-client.js does.
 */
import { githubTracker } from '../fixtures/github-issues/scenario.mjs';
import type {
  ColorScheme,
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
  ISSUE_V1,
  NAME,
  PARENT,
  PROPERTIES,
  RECOMMENDS,
  SHORTNAME,
  TASK_BODY,
  TASK_STATUS,
} from './tracker.js';

export const APP = 'did:ad:app';
export const ONTOLOGY = 'did:ad:ontology';
export const ROW_CLASS = 'did:ad:class-item';
export const TABLE = 'did:ad:table-items';
/** The drive's plugin vocabulary, as `pluginSchema()` mints it per drive. */
export const APP_CLASS = 'did:ad:plugin-class-app';
export const RENDERS = 'did:ad:plugin-renders';
export const ROW_EXTRAS = 'did:ad:plugin-row-extras';

/** `issue-v1`'s `requires` and `recommends` (ontology-kit/source.json). */
const ISSUE_COLUMNS = [
  NAME,
  TASK_STATUS,
  TASK_BODY,
  'https://atomicdata.dev/task/v1/assignee',
  'https://atomicdata.dev/task/v1/due-date',
];

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save'; subject: string }[];
  readonly calls: HostProxyRequest[];
  readonly github: ReturnType<typeof githubTracker>;
  /** Makes every relayed call fail with this host error until cleared. */
  fail?: string;
  /** Limits `fail` to writes (anything but GET). */
  failWritesOnly?: boolean;
  /** With `failWritesOnly`: the lost write still reached GitHub. */
  lostWriteLands?: boolean;
  /** Answers every relayed call with this status until cleared. */
  status?: number;
  /** Answers every call with this integration-proxy refusal code. */
  refusal?: string;
  lagReads: number;
  hideFromQuery: number;
  /** Host calls counted by name (getResource, getMany, openExternal, …). */
  readonly counts: Record<string, number>;
  /** URLs passed to openExternal. */
  readonly opened: string[];
  /** Subjects passed to openResource. */
  readonly openedRows: string[];
  readonly disconnected: string[];
  /** The person switching the host between light and dark. */
  setScheme(scheme: ColorScheme): void;
  /** A person editing a row in the data-browser: no app write, no lag. */
  edit(subject: string, props: Record<string, JSONValue>): void;
  /** The live row grant on another `table`: the extras it covers, or none. */
  readonly grant: { extras: string[] } | undefined;
  /** Someone takes the grant back in the host's tab menu. */
  revokeGrant(): void;
  /** How many times the host asked the person ("Allow editing"). */
  readonly asked: number;
}

export function fakeStore({
  connected = true,
  existing = false,
  relay = true,
  hostApis = true,
  table = TABLE,
  grant: initialGrant = 'none',
  answer: answerWith = 'allow',
}: {
  /** The table the app is shown on; another one is a view on someone's table. */
  table?: string;
  connected?: boolean;
  /**
   * The person has a GitHub connection this app is not delegated yet:
   * `proxy.connect` resolves `connected` (the host's "Use existing
   * connection", no reload) instead of never settling.
   */
  existing?: boolean;
  relay?: boolean;
  /** The host calls of atomic-server pin 007869464 (getMany, openExternal, …). */
  hostApis?: boolean;
  /**
   * The grant on another `table` before the app opens: none, or "Allow
   * editing" from Add view before the app declared its row extras
   * (`columns`, covering none of them).
   */
  grant?: 'none' | 'columns';
  /** What the person answers when the app asks with `requestRowAccess()`. */
  answer?: 'allow' | 'deny';
} = {}): FakeStore {
  // As `createApp` lays it out at the pin.
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
  ]);
  /** What a lagging read still returns, and for how many more reads. */
  const stale = new Map<
    string,
    { props: Record<string, JSONValue>; reads: number }
  >();
  /** Created subjects a query still leaves out, and for how many queries. */
  const hidden = new Map<string, number>();
  const writes: FakeStore['writes'] = [];
  const calls: HostProxyRequest[] = [];
  const github = githubTracker();
  let next = 0;
  let grant: { extras: string[] } | undefined =
    initialGrant === 'columns' ? { extras: [] } : undefined;
  let asked = 0;
  const foreign = table !== TABLE;

  /** The App's `row-extras` now. */
  const declared = () => {
    const value = resources.get(APP)![ROW_EXTRAS];

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
    if (!foreign) return;
    if (subject === table)
      throw new Error('This app may only write its own data.');
    if (parent !== table) return;
    if (!grant)
      throw new Error(
        'This app is a view of this table but may not edit its rows.',
      );
    if (op === 'destroy')
      throw new Error('Letting an app edit rows does not let it delete them');
    if (!Array.isArray(isA) || isA.length !== 1 || isA[0] !== ISSUE_V1)
      throw new Error('This app may only edit rows of the table’s row class');
    const live = declared();
    const allowed = new Set([
      ...ISSUE_COLUMNS,
      ...grant.extras.filter(extra => live.includes(extra)),
    ]);

    for (const property of written)
      if (!allowed.has(property))
        throw new Error(
          `This app may edit this table's columns and the row data it was allowed to keep, not ${property}`,
        );
  };

  const wrap = (
    subject: string,
    stored: Record<string, JSONValue>,
  ): PluginResource => {
    const props = structuredClone(stored);
    /** Removed since the last save; `save` sends them, as view-client.js does. */
    const removed = new Set<string>();
    /** Set since the last save: what view-client.js sends. */
    const changed = new Set<string>();

    return {
      subject,
      get props() {
        return { ...props };
      },
      get: property => props[property],
      set(property, value) {
        props[property] = value;
        removed.delete(property);
        changed.add(property);

        return this;
      },
      remove(property) {
        delete props[property];
        removed.add(property);
        changed.delete(property);

        return this;
      },
      async save() {
        const before = resources.get(subject) ?? {};
        checkGrant(
          subject,
          before[PARENT],
          before[IS_A],
          [...changed, ...removed],
          'save',
        );
        changed.clear();
        if (fake.lagReads)
          stale.set(subject, {
            props: structuredClone(before),
            reads: fake.lagReads,
          });
        // /app-write `save` sets every property sent and removes only the
        // ones `remove` named since the last save.
        const saved = { ...before, ...structuredClone(props) };
        for (const property of removed) delete saved[property];
        removed.clear();
        resources.set(subject, saved);
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

  const proxy: HostProxy = {
    async request(request) {
      calls.push(request);
      const write = (request.method ?? 'GET') !== 'GET';

      if (fake.fail && (write || !fake.failWritesOnly)) {
        // A lost response: the host sent it, then heard nothing back.
        if (write && fake.lostWriteLands)
          github.request(
            request.method!,
            new URL(
              `/proxy/github-issues${request.path}`,
              'https://proxy.example',
            ),
            request.body ? JSON.parse(request.body) : {},
          );
        throw new Error(fake.fail);
      }

      if (fake.refusal)
        return {
          status: fake.refusal === 'unknown_connection' ? 404 : 403,
          headers: {},
          body: { error: fake.refusal, message: 'refused by the proxy' },
        };

      if (fake.status)
        return {
          status: fake.status,
          headers: {},
          body: { message: 'Bad credentials' },
        };
      const url = new URL(
        `/proxy/github-issues${request.path}`,
        'https://proxy.example',
      );
      for (const [k, v] of Object.entries(request.query ?? {}))
        url.searchParams.set(k, v);
      const result = github.request(
        request.method ?? 'GET',
        url,
        request.body ? JSON.parse(request.body) : {},
      );

      // Relayed headers arrive lower-cased, as view-client.js passes them.
      const headers = Object.fromEntries(
        Object.entries(
          (result as { headers?: Record<string, string> }).headers ?? {},
        ).map(([k, v]) => [k.toLowerCase(), v]),
      );

      return { status: result.status, headers, body: result.body };
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
    ...(hostApis
      ? {
          async disconnect({ platform }: { platform: string }) {
            const had = connected;
            connected = false;
            fake.disconnected.push(platform);

            return {
              status: 'disconnected' as const,
              platform,
              connectionIds: had ? ['c1'] : [],
            };
          },
        }
      : {}),
  };
  let scheme: ColorScheme = 'light';
  const themeListeners = new Set<(t: { colorScheme: ColorScheme }) => void>();

  const counts: Record<string, number> = {};
  const count = (name: string) => (counts[name] = (counts[name] ?? 0) + 1);
  const opened: string[] = [];
  const openedRows: string[] = [];

  const fake: FakeStore = {
    resources,
    writes,
    calls,
    github,
    lagReads: 0,
    hideFromQuery: 0,
    edit(subject, props) {
      resources.set(subject, { ...resources.get(subject), ...props });
      // The page's own edit: its cache has the new values.
      const lag = stale.get(subject);
      if (lag) lag.props = { ...lag.props, ...structuredClone(props) };
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
      count('getResource');
      const lag = stale.get(subject);

      if (lag && lag.reads > 0) {
        lag.reads--;

        return wrap(subject, lag.props);
      }

      const stored = resources.get(subject);
      if (!stored) throw new Error(`No resource ${subject}`);

      return wrap(subject, stored);
    },
    async query({ property, value }) {
      const out: string[] = [];

      for (const [subject, props] of resources) {
        const left = hidden.get(subject);

        if (left) {
          hidden.set(subject, left - 1);
          continue;
        }

        if (props[property] === value) out.push(subject);
      }

      return out;
    },
    async newResource({ parent, isA = [], propVals = {} } = {}) {
      checkGrant('', parent ?? APP, isA, Object.keys(propVals), 'create');
      const subject = `did:ad:new-${++next}`;
      const stored = {
        ...structuredClone(propVals),
        [PARENT]: parent ?? APP,
        [IS_A]: isA,
      };
      resources.set(subject, stored);
      if (fake.hideFromQuery) hidden.set(subject, fake.hideFromQuery);
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
    async rowAccess() {
      if (!foreign) return { status: 'unavailable' as const };

      return grant
        ? {
            status: 'granted' as const,
            grantedBy: 'did:ad:agent-person',
            grantedAt: 1,
            via: 'request',
            extras: grant.extras,
          }
        : { status: 'none' as const };
    },
    async requestRowAccess() {
      if (!foreign)
        return {
          status: 'denied' as const,
          reason: 'This app is not shown as a table view here',
        };
      const live = declared();
      // As the host's rowAccessQuestion: no question when the grant covers the list.
      if (grant && live.every(extra => grant!.extras.includes(extra)))
        return { status: 'granted' as const };
      asked++;
      if (answerWith === 'deny')
        return { status: 'denied' as const, reason: 'The person said no' };
      // A new grant, for the list as the App declares it now.
      grant = { extras: live };

      return { status: 'granted' as const };
    },
    counts,
    opened,
    openedRows,
    disconnected: [],
    setScheme(value) {
      scheme = value;
      for (const listener of themeListeners) listener({ colorScheme: value });
    },
    ...(hostApis
      ? {
          async getMany(subjects: string[]) {
            count('getMany');
            if (subjects.length > 100) throw new Error('getMany: at most 100');
            const out = [];

            for (const subject of subjects) {
              const stored = resources.get(subject);
              out.push(
                stored
                  ? wrap(subject, stale.get(subject)?.props ?? stored)
                  : { subject, error: `No resource ${subject}` },
              );
            }

            return out;
          },
          async openExternal(url: string) {
            count('openExternal');
            opened.push(url);

            return { status: 'opened' as const };
          },
          async openResource(subject: string) {
            count('openResource');
            openedRows.push(subject);

            return { status: 'opened' as const, subject };
          },
          getTheme: () => ({ colorScheme: scheme }),
          onThemeChange(handler: (t: { colorScheme: ColorScheme }) => void) {
            themeListeners.add(handler);

            return () => themeListeners.delete(handler);
          },
        }
      : {}),
    ...(relay ? { proxy } : {}),
  };

  return fake;
}
