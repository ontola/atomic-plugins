// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests, shaped after view-client.js and laid
 * out the way `createApp` lays out an app: app -> ontology -> row class, and
 * app -> table. `proxy` answers from the same stateful Google Calendar
 * fixture the mock integration proxy serves
 * (`../fixtures/google-calendar/scenario.mjs`), the way the host's frame
 * client and the integration proxy answer (ontola/atomic-plugins#54):
 * `ifMatch` becomes an `If-Match` header; a connection the page no longer
 * lists throws the page's "Connect again" refusal; a revoked one gets the
 * proxy's `403 not_delegated`. A lost response spends nothing: the same
 * connection works on the next call. Test-only; not bundled.
 *
 * On `OTHER_TABLE` (an `event-v1` table the app is a view of) writes follow
 * the pinned host's row grant (atomic-server `app_row_grant.rs`, #1740 and
 * #1849): none without a grant; with one, only the class's `requires` and
 * `recommends` plus the `row-extras` the App declared when it was granted,
 * on rows of that class; never the table itself, never `destroy`.
 * `rowAccess()` and `requestRowAccess()` answer as view-client.js does.
 */
import { calendarFixture } from '../fixtures/google-calendar/scenario.mjs';
import type {
  ColorScheme,
  HostProxy,
  HostProxyRequest,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';
import { classes, properties } from '../../../ontology-kit/terms.mjs';
import { EVENT, LEGACY_SHORTNAMES, SHARED, type SharedKey } from './fields.js';
import {
  CLASSTYPE,
  DEFAULT_ONTOLOGY,
  IS_A,
  NAME,
  PARENT,
  PROPERTIES,
  RECOMMENDS,
  REQUIRES,
  SHORTNAME,
} from './sync.js';

export const APP = 'did:ad:app';
export const APP_CLASS = 'did:ad:class-app';
export const RENDERS = 'did:ad:property-renders';
export const ROW_EXTRAS_PROPERTY = 'did:ad:property-row-extras';
export const ONTOLOGY = 'did:ad:ontology';
export const ROW_CLASS = 'did:ad:class-item';
export const TABLE = 'did:ad:table-items';
/** An `event-v1` table that isn't the app's own: one it is a view of. */
export const OTHER_TABLE = 'did:ad:table-team-events';
export const DAY = '2026-09-24';

/** The `event-v1` properties' names (ontology-kit/source.json). */
const PUBLISHED_NAMES = {
  'atomic-calendar-day': 'Day',
  'atomic-calendar-end-day': 'End day',
  'atomic-calendar-all-day': 'All day',
  'atomic-calendar-start': 'Start',
  'atomic-calendar-end': 'End',
  'atomic-calendar-location': 'Location',
  'atomic-calendar-notes': 'Notes',
  'atomic-calendar-recurrence': 'Recurrence',
} as const;

/**
 * A row field's subject by the shortname tests use: the shared `event-v1`
 * property for the mapped fields (by their 0.1.x or shared shortname), else
 * the app's own Property of that shortname (its provider extras).
 */
export function field(
  store: { resources: Map<string, Record<string, JSONValue>> },
  shortname: string,
): string {
  const key = (Object.keys(LEGACY_SHORTNAMES) as SharedKey[]).find(
    k =>
      LEGACY_SHORTNAMES[k] === shortname || SHARED[k].endsWith(`/${shortname}`),
  );
  if (key) return SHARED[key];
  const listed = store.resources.get(ONTOLOGY)![PROPERTIES] as string[];
  const subject = listed.find(
    s => store.resources.get(s)![SHORTNAME] === shortname,
  );
  if (!subject) throw new Error(`no ${shortname} property`);

  return subject;
}

type Fixture = ReturnType<typeof calendarFixture>;

export interface FakeStore extends PluginStore {
  readonly resources: Map<string, Record<string, JSONValue>>;
  readonly writes: { op: 'create' | 'save'; subject: string }[];
  readonly calls: HostProxyRequest[];
  readonly google: Fixture;
  /** The next PATCH reaches Google, then the relay throws (a lost response). */
  loseNextWriteResponse(): void;
  /** What the proxy would hold after the person connected again. */
  reconnect(): void;
  /** The delegation of `connectionId` revoked at the proxy, elsewhere. */
  revoke(connectionId: string): void;
  /** The next relay call answers with this status instead of reaching the fixture. */
  answerNext(status: number, headers?: Record<string, string>): void;
  /** The next relay call throws, as a failed fetch in the page would. */
  throwNext(message: string): void;
  /** What the app asked the host to open (`openExternal`, `openResource`). */
  readonly opened: { external: string[]; resources: string[] };
  /** The person switches the host between light and dark. */
  setTheme(scheme: ColorScheme): void;
  /** The live row grant on `OTHER_TABLE`: the extras it covers, or none. */
  readonly grant: { extras: string[] } | undefined;
  /** Someone takes the grant back in the host's tab menu. */
  revokeGrant(): void;
  /** How many times the host asked the person ("Allow editing"). */
  readonly asked: number;
}

export function fakeStore({
  connected = true,
  relay = true,
  hostOps = true,
  view = 'own',
  grant: initialGrant = 'none',
  answer: answerWith = 'allow',
}: {
  connected?: boolean;
  relay?: boolean;
  /** The operations of pin 007869464: open links and resources, theme, disconnect. */
  hostOps?: boolean;
  /** Which table the host hands the app: its own, or another `event-v1` table. */
  view?: 'own' | 'other';
  /**
   * The grant on `OTHER_TABLE` before the app opens: none, or "Allow
   * editing" from Add view before the app declared its row extras
   * (`columns`, covering none of them).
   */
  grant?: 'none' | 'columns';
  /** What the person answers when the app asks with `requestRowAccess()`. */
  answer?: 'allow' | 'deny';
} = {}): FakeStore {
  const opened: FakeStore['opened'] = { external: [], resources: [] };
  let scheme: ColorScheme = 'light';
  const themeListeners = new Set<(t: { colorScheme: ColorScheme }) => void>();
  const event = classes['event-v1'];
  const resources = new Map<string, Record<string, JSONValue>>([
    // As `createApp` lays an app out at the pin, with the drive's App class
    // and its `renders` and `row-extras` Properties.
    [
      APP,
      {
        [NAME]: 'New app',
        [IS_A]: [APP_CLASS],
        [DEFAULT_ONTOLOGY]: ONTOLOGY,
        [RENDERS]: [ROW_CLASS],
      },
    ],
    [APP_CLASS, { [RECOMMENDS]: [RENDERS, ROW_EXTRAS_PROPERTY] }],
    [RENDERS, { [SHORTNAME]: 'renders' }],
    [ROW_EXTRAS_PROPERTY, { [SHORTNAME]: 'row-extras' }],
    [ONTOLOGY, { [PARENT]: APP, [PROPERTIES]: [] }],
    [ROW_CLASS, { [PARENT]: ONTOLOGY, [NAME]: 'Item', [RECOMMENDS]: [NAME] }],
    [TABLE, { [PARENT]: APP, [NAME]: 'Items', [CLASSTYPE]: ROW_CLASS }],
    [
      OTHER_TABLE,
      { [PARENT]: 'did:ad:drive', [NAME]: 'Team events', [CLASSTYPE]: EVENT },
    ],
    // The published class and its properties, as the host reads them from
    // GitHub Pages.
    [
      EVENT,
      {
        [REQUIRES]: [...event.requires],
        [RECOMMENDS]: [...event.recommends],
      },
    ],
    ...Object.entries(PUBLISHED_NAMES).map(
      ([shortname, name]): [string, Record<string, JSONValue>] => [
        properties[shortname as keyof typeof PUBLISHED_NAMES].subject,
        { [SHORTNAME]: shortname, [NAME]: name },
      ],
    ),
  ]);
  const writes: FakeStore['writes'] = [];
  const calls: HostProxyRequest[] = [];
  const google = calendarFixture(DAY);
  let next = 0;
  let loseResponse = false;
  let canned:
    | { status: number; headers: Record<string, string> }
    | { throws: string }
    | undefined;
  const connections = connected ? ['c1'] : [];
  const revoked = new Set<string>();
  let grant: { extras: string[] } | undefined =
    initialGrant === 'columns' ? { extras: [] } : undefined;
  let asked = 0;

  /** The App's `row-extras` now. */
  const declared = () => {
    const value = resources.get(APP)![ROW_EXTRAS_PROPERTY];

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
      throw new Error('Letting an app edit rows does not let it delete them.');
    if (!Array.isArray(isA) || isA.length !== 1 || isA[0] !== EVENT)
      throw new Error('This app may only edit rows of the table’s row class');
    const live = declared();
    const allowed = new Set([
      ...event.requires,
      ...event.recommends,
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
    const props = { ...stored };
    const removed = new Set<string>();
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
        const merged = { ...before, ...props };
        for (const property of removed) delete merged[property];
        removed.clear();
        resources.set(subject, merged);
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
      if (!connections.includes(request.connectionId))
        throw new Error(
          `No google-calendar connection ${request.connectionId} is delegated to this app. Connect again.`,
        );
      if (revoked.has(request.connectionId))
        return {
          status: 403,
          headers: {},
          body: {
            error: 'not_delegated',
            message: 'the signing agent has no delegation for this connection',
          },
        };

      if (canned) {
        const answer = canned;
        canned = undefined;
        if ('throws' in answer) throw new Error(answer.throws);

        return {
          status: answer.status,
          headers: answer.headers,
          body: { error: { code: answer.status, message: 'Canned' } },
        };
      }

      const url = new URL(
        `/proxy/${request.platform}${request.path}`,
        'http://mock-proxy.test',
      );
      for (const [k, v] of Object.entries(request.query ?? {}))
        url.searchParams.set(k, v);
      const result = google.request(
        request.method ?? 'GET',
        url,
        request.body === undefined ? {} : JSON.parse(request.body),
        request.ifMatch ? { 'if-match': request.ifMatch } : {},
      ) as {
        status: number;
        body: unknown;
        headers?: Record<string, string>;
      };

      if (request.method === 'PATCH' && loseResponse) {
        loseResponse = false;
        throw new Error('Failed to fetch');
      }

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
      return connections.map(connectionId => ({ connectionId, platform }));
    },
    connect: () => new Promise(() => {}),
    ...(hostOps
      ? {
          async disconnect({ platform }: { platform: string }) {
            const connectionIds = connections.splice(0);

            return { status: 'disconnected' as const, platform, connectionIds };
          },
        }
      : {}),
  };

  return {
    resources,
    writes,
    calls,
    google,
    loseNextWriteResponse: () => {
      loseResponse = true;
    },
    reconnect: () => {
      connections.push(`c${connections.length + 1}`);
    },
    revoke: connectionId => {
      revoked.add(connectionId);
    },
    answerNext: (status, headers = {}) => {
      canned = { status, headers };
    },
    throwNext: message => {
      canned = { throws: message };
    },
    getApp: async () => APP,
    async getData() {
      const table = view === 'own' ? TABLE : OTHER_TABLE;

      return {
        table,
        rowClass: resources.get(table)![CLASSTYPE] as string,
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
      checkGrant('', parent ?? APP, isA, Object.keys(propVals), 'create');
      const subject = `did:ad:new-${++next}`;
      const stored = { ...propVals, [PARENT]: parent ?? APP, [IS_A]: isA };
      resources.set(subject, stored);
      writes.push({ op: 'create', subject });

      return wrap(subject, stored);
    },
    subscribe: () => () => {},
    ...(relay ? { proxy } : {}),
    opened,
    setTheme: chosen => {
      scheme = chosen;
      for (const listener of themeListeners) listener({ colorScheme: chosen });
    },
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
      if (view === 'own') return { status: 'unavailable' as const };

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
      if (view === 'own')
        return {
          status: 'denied' as const,
          reason: 'This app is not shown as a table view here',
        };
      const live = declared();
      // As rowAccessQuestion: no question when the grant covers the list.
      if (grant && live.every(extra => grant!.extras.includes(extra)))
        return { status: 'granted' as const };
      asked++;
      if (answerWith === 'deny')
        return { status: 'denied' as const, reason: 'The person said no' };
      // A new grant, for the list as the App declares it now.
      grant = { extras: live };

      return { status: 'granted' as const };
    },
    ...(hostOps
      ? {
          async openExternal(url: string) {
            opened.external.push(url);

            return { status: 'opened' as const };
          },
          async openResource(subject: string) {
            opened.resources.push(subject);

            return { status: 'opened' as const, subject };
          },
          getTheme: () => ({ colorScheme: scheme }),
          onThemeChange(handler: (t: { colorScheme: ColorScheme }) => void) {
            themeListeners.add(handler);

            return () => themeListeners.delete(handler);
          },
        }
      : {}),
  };
}
