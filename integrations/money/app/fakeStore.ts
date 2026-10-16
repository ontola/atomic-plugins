// @wc-ignore-file
/**
 * An in-memory `PluginStore` for tests and the screenshot harness, shaped
 * after view-client.js and atomic-server's `hostStore.ts`:
 * - resources buffer `set`/`remove` until `save`; `newResource` writes at once
 *   and notifies the parent's subscribers, as the host does;
 * - `query` is a property/value match across the whole "drive";
 * - writes outside the App's subtree are refused with the host's message,
 *   unless they are rows of the table the app is a view of and the person
 *   allowed editing (`rowsWritable`, or a granted `rowAccess`).
 * It models the App as the host's `createApp` leaves it: an App of the
 * drive's App class (whose `renders` and `row-extras` Properties are found
 * by shortname), with its own ontology (`default-ontology`) holding one class
 * of its own, and `renders` listing that class. `data` picks the table the
 * app is opened on:
 * - `bank`: the importer's table (its drive-local `bank-transaction` class
 *   and, on a current host, its statements table), as on that table's app tab;
 * - `own`: the app's own table, of its own class until the app adopts the
 *   shared one, as after a catalog install;
 * - `shared`: a table someone made of `bank-transaction-v1`, not the app's;
 * - `other`: a table of some other class; `none`: no table.
 * Test-only; not bundled.
 */
import { entries } from '../identity.js';
import { parseBankStatement } from '../statement.js';
import { STATEMENT_CLASS } from './own.js';
import {
  atomic,
  BANK_FIELDS,
  BANK_TRANSACTION,
  EXTRA_FIELDS,
  NOTE_FIELDS,
  SHARED_SUBJECT,
  STATEMENT_ROW_FIELDS,
  type SharedField,
  type Shortname,
} from './rows.js';
import {
  GET_MANY_MAX,
  type ColorScheme,
  type ImporterRun,
  type JSONValue,
  type PluginResource,
  type PluginStore,
} from './store.js';

export const DRIVE = 'did:ad:drive';
export const APP = 'did:ad:money-app';
/** The App's own ontology and the class `createApp` minted in it. */
export const APP_ONTOLOGY = 'did:ad:money-app/ontology';
export const APP_CLASS_OWN = 'did:ad:money-app/ontology/class/bank-transaction';
/** The drive's App class and its `renders` and `row-extras` Properties. */
export const APP_CLASS = 'did:ad:plugin/class/app';
export const RENDERS = 'did:ad:plugin/property/renders';
export const ROW_EXTRAS = 'did:ad:plugin/property/row-extras';
export const IMPORTER = 'did:ad:importer';
/** The importer's table. */
export const TABLE = 'did:ad:importer/table';
/** The importer's second table (atomic-server#1768). */
export const STATEMENTS = 'did:ad:importer/statements';
export const STATEMENT_CLASS_SUBJECT =
  'did:ad:ontology/class/bank-statement-record';
export const ONTOLOGY = 'did:ad:ontology';
export const ROW_CLASS = 'did:ad:ontology/class/bank-transaction';
/** The app's own table (`data: 'own'`) and a hand-made one (`'shared'`). */
export const OWN_TABLE = 'did:ad:money-app/table';
export const SHARED_TABLE = 'did:ad:drive/team-table';
/** The app's own statement class, once `own.ts` made it. */
export const OWN_STATEMENT_CLASS = `${APP_ONTOLOGY}/${STATEMENT_CLASS.shortname}`;

/** The importer's drive-local Property for `shortname`. */
export const property = (shortname: string) =>
  `did:ad:ontology/property/${shortname}`;

/**
 * The Property a shared-class row carries `shortname` under: the published
 * subject for a shared field, else the app's own Property, named by its
 * shortname as this fake's `newResource` does.
 */
export const sharedProperty = (shortname: string) =>
  shortname in SHARED_SUBJECT
    ? SHARED_SUBJECT[shortname as SharedField]
    : `${APP_ONTOLOGY}/${shortname}`;

export const REFUSED =
  'This app may only write its own data. Writing here needs rights its key does not have.';

/** One transaction as a test states it, by shortname. */
export type SeedRow = Partial<Record<Shortname, string>> & {
  'bank-account': string;
  'bank-currency': string;
  'bank-amount': string;
  'bank-value-date': string;
};

/** A synthetic row: an invented bunq-style IBAN, the amount as reference. */
export const seedRow = (
  amount: string,
  date: string,
  extra: Partial<SeedRow> = {},
): SeedRow => {
  const account = extra['bank-account'] ?? 'NL42BUNQ0123456789';
  const currency = extra['bank-currency'] ?? 'EUR';
  const reference = extra['bank-reference'] ?? `REF-${amount}-${date}`;

  return {
    'bank-account': account,
    'bank-currency': currency,
    'bank-amount': amount,
    'bank-value-date': date,
    'bank-booking-date': date,
    'bank-description': `Payment ${amount}`,
    'bank-reference': reference,
    'bank-transaction-code': 'NTRF',
    'bank-statement': '31/1',
    'bank-source-id': JSON.stringify([
      'mt940',
      account,
      currency,
      ['bank', reference],
    ]),
    ...extra,
  };
};

/** A stored statement as a test states it, by shortname. */
export type SeedStatement = Partial<Record<Shortname, string>>;

export type Data = 'bank' | 'none' | 'other' | 'own' | 'shared';

export interface FakeStore extends PluginStore {
  /** The table the app is opened on. */
  readonly table: string;
  /** The Property `shortname` lives under on this store's rows. */
  property(shortname: string): string;
  /** Adds statement rows to the statements table (the importer's, or the
   * app's own once a load made it). */
  addStatements(rows: SeedStatement[]): string[];
  /** Files handed to `importer.run`, by name. */
  readonly runs: string[];
  /** How often the app asked the person to allow editing. */
  readonly accessRequests: number;
  readonly resources: Map<string, Record<string, JSONValue>>;
  /** Saves of rows and other data, in order. */
  readonly saves: { subject: string; propVals: Record<string, JSONValue> }[];
  /** Saves of the App, its ontology and its terms (`adopt.ts`, `own.ts`). */
  readonly schemaSaves: {
    subject: string;
    propVals: Record<string, JSONValue>;
  }[];
  /** Resources made with `newResource`, in order. */
  readonly created: string[];
  /** Adds rows to the table, notifying subscribers of the table. */
  addRows(rows: SeedRow[]): string[];
  /** Fails the next `n` saves with `message`. */
  failSaves(n: number, message?: string): void;
  /** Fails the next `n` `newResource` calls with `message`. */
  failCreates(n: number, message?: string): void;
  /** Keeps every `getResource` pending until `release()` runs. */
  hold(): () => void;
  /** Subjects with a live subscription. */
  readonly subscribed: Set<string>;
  /** Calls made, by op, for asserting batching. */
  readonly calls: { get: number; getMany: number[] };
  /** Subjects the app asked the host to open. */
  readonly opened: string[];
  /** Switches the host between light and dark, as `__atomic_style` does. */
  setScheme(scheme: ColorScheme): void;
}

export function fakeStore({
  rows = [],
  notes = true,
  rowsWritable = false,
  data = 'bank',
  host = 'current',
  scheme = 'light',
  statements = [],
  access = 'none',
  answer = 'grant',
  importRun,
}: {
  statements?: SeedStatement[];
  /** `rowAccess()` at the start (a current host). */
  access?: 'granted' | 'none' | 'unavailable';
  /** What the person says to `requestRowAccess()`. */
  answer?: 'grant' | 'deny';
  /** Overrides `importer.run`; by default it imports like the importer. */
  importRun?: (file?: { name: string; text: string }) => Promise<ImporterRun>;
  /** `legacy`: a host before 007869464, without getMany, theme, openResource,
   * row access, importer.run, or an App ontology of its own. */
  host?: 'current' | 'legacy';
  scheme?: ColorScheme;
  rows?: SeedRow[];
  /** Whether the importer's class declares money-category and money-note (M-5). */
  notes?: boolean;
  rowsWritable?: boolean;
  data?: Data;
} = {}): FakeStore {
  const resources = new Map<string, Record<string, JSONValue>>();
  const shortnames: string[] = [...BANK_FIELDS, ...(notes ? NOTE_FIELDS : [])];
  const modern = host === 'current';
  const sharedRows = data === 'own' || data === 'shared';
  const table =
    data === 'own' ? OWN_TABLE : data === 'shared' ? SHARED_TABLE : TABLE;
  const rowProperty = sharedRows ? sharedProperty : property;
  let writable = rowsWritable || (modern && access === 'granted');
  let accessStatus: 'granted' | 'none' | 'unavailable' = access;
  const runs: string[] = [];
  let accessRequests = 0;

  // The drive's App class, and the App as createApp left it.
  resources.set(DRIVE, {});
  resources.set(RENDERS, {
    [atomic.shortname]: 'renders',
    [atomic.isA]: [atomic.propertyClass],
  });
  resources.set(ROW_EXTRAS, {
    [atomic.shortname]: 'row-extras',
    [atomic.isA]: [atomic.propertyClass],
  });
  resources.set(APP_CLASS, {
    [atomic.shortname]: 'app',
    [atomic.isA]: [atomic.classClass],
    [atomic.recommends]: [RENDERS, ROW_EXTRAS],
  });
  resources.set(APP, {
    [atomic.parent]: DRIVE,
    [atomic.isA]: [APP_CLASS],
    [atomic.name]: 'Bank statements',
    [RENDERS]: [APP_CLASS_OWN],
    ...(modern ? { [atomic.defaultOntology]: APP_ONTOLOGY } : {}),
  });
  resources.set(APP_ONTOLOGY, {
    [atomic.parent]: APP,
    [atomic.properties]: [],
    [atomic.classes]: [APP_CLASS_OWN],
  });
  resources.set(APP_CLASS_OWN, {
    [atomic.parent]: APP_ONTOLOGY,
    [atomic.isA]: [atomic.classClass],
    [atomic.shortname]: 'bank-transaction',
    [atomic.recommends]: [atomic.name],
  });
  if (data === 'own')
    resources.set(OWN_TABLE, {
      [atomic.parent]: APP,
      [atomic.isA]: [atomic.tableClass],
      [atomic.classtype]: APP_CLASS_OWN,
    });
  if (data === 'shared')
    resources.set(SHARED_TABLE, {
      [atomic.parent]: DRIVE,
      [atomic.isA]: [atomic.tableClass],
      [atomic.classtype]: BANK_TRANSACTION,
    });

  // The importer, its ontology and tables, as its Set up left them.
  resources.set(IMPORTER, { [atomic.parent]: DRIVE });
  resources.set(ONTOLOGY, { [atomic.parent]: IMPORTER });

  for (const shortname of shortnames)
    resources.set(property(shortname), {
      [atomic.parent]: ONTOLOGY,
      [atomic.isA]: [atomic.propertyClass],
      [atomic.shortname]: shortname,
    });

  resources.set(ROW_CLASS, {
    [atomic.parent]: ONTOLOGY,
    [atomic.isA]: [atomic.classClass],
    [atomic.shortname]: 'bank-transaction',
    [atomic.requires]: [
      'bank-account',
      'bank-currency',
      'bank-amount',
      'bank-value-date',
      'bank-source-id',
    ].map(property),
    [atomic.recommends]: shortnames
      .filter(s => !['bank-source-id', 'bank-fingerprint'].includes(s))
      .map(property),
  });
  if (data === 'bank' || data === 'other')
    resources.set(TABLE, {
      [atomic.parent]: IMPORTER,
      [atomic.classtype]:
        data === 'other' ? 'did:ad:ontology/class/pet' : ROW_CLASS,
    });
  if (data === 'other')
    resources.set('did:ad:ontology/class/pet', { [atomic.parent]: ONTOLOGY });

  if (modern) {
    for (const shortname of STATEMENT_ROW_FIELDS)
      resources.set(property(shortname), {
        [atomic.parent]: ONTOLOGY,
        [atomic.isA]: [atomic.propertyClass],
        [atomic.shortname]: shortname,
      });
    resources.set(STATEMENT_CLASS_SUBJECT, {
      [atomic.parent]: ONTOLOGY,
      [atomic.shortname]: 'bank-statement-record',
      [atomic.requires]: [
        'bank-account',
        'bank-currency',
        'bank-period-start',
        'bank-period-end',
        'bank-opening-balance',
        'bank-closing-balance',
        'bank-source-id',
      ].map(property),
      [atomic.recommends]: ['bank-statement', ...STATEMENT_ROW_FIELDS].map(
        property,
      ),
    });
    resources.set(STATEMENTS, {
      [atomic.parent]: IMPORTER,
      [atomic.classtype]: STATEMENT_CLASS_SUBJECT,
    });
  }

  const saves: FakeStore['saves'] = [];
  const schemaSaves: FakeStore['saves'] = [];
  const created: string[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const subscribed = new Set<string>();
  let failing = 0;
  let failure = REFUSED;
  let failingCreates = 0;
  let createFailure = REFUSED;
  let held: Promise<void> | undefined;
  let next = 0;

  const notify = (subject: string) => {
    for (const handler of listeners.get(subject) ?? []) handler();
  };

  const within = (subject: string): boolean => {
    let current: string | undefined = subject;

    for (let depth = 0; current && depth < 12; depth++) {
      if (current === APP) return true;
      const parent: JSONValue = resources.get(current)?.[atomic.parent];
      current = typeof parent === 'string' ? parent : undefined;
    }

    return false;
  };

  const isRow = (subject: string) =>
    resources.get(subject)?.[atomic.parent] === table;

  /** The App, its tables, its ontology and that ontology's terms (`adopt.ts`). */
  const isSchema = (subject: string) =>
    subject === APP ||
    subject === APP_ONTOLOGY ||
    subject === OWN_TABLE ||
    resources.get(subject)?.[atomic.parent] === APP_ONTOLOGY;

  const wrap = (
    subject: string,
    stored: Record<string, JSONValue>,
  ): PluginResource => {
    const props = { ...stored };
    const changed = new Set<string>();
    const removed = new Set<string>();

    return {
      subject,
      get props() {
        return { ...props };
      },
      get: p => props[p],
      set(p, value) {
        props[p] = value;
        changed.add(p);
        removed.delete(p);

        return this;
      },
      remove(p) {
        delete props[p];
        changed.delete(p);
        removed.add(p);

        return this;
      },
      async save() {
        await Promise.resolve();

        if (failing > 0) {
          failing--;
          throw new Error(failure);
        }

        if (!within(subject) && !(writable && isRow(subject)))
          throw new Error(REFUSED);
        const propVals = Object.fromEntries(
          [...changed].map(p => [p, props[p]]),
        );
        const current = { ...(resources.get(subject) ?? {}), ...propVals };
        for (const p of removed) delete current[p];
        resources.set(subject, current);
        (isSchema(subject) ? schemaSaves : saves).push({ subject, propVals });
        changed.clear();
        removed.clear();
        notify(subject);

        return this;
      },
      async destroy() {
        resources.delete(subject);
      },
    };
  };

  const calls = { get: 0, getMany: [] as number[] };
  const opened: string[] = [];
  const themeListeners = new Set<(t: { colorScheme: ColorScheme }) => void>();
  let colorScheme = scheme;

  const addUnder = (
    parent: string,
    klass: string,
    prefix: string,
    seed: Partial<Record<string, string>>[],
    name: (shortname: string) => string,
  ) => {
    const subjects = seed.map(row => {
      const subject = `${parent}/${prefix}-${++next}`;
      resources.set(subject, {
        [atomic.parent]: parent,
        [atomic.isA]: [klass],
        ...Object.fromEntries(
          Object.entries(row).map(([k, v]) => [name(k), v]),
        ),
      });

      return subject;
    });
    notify(parent);

    return subjects;
  };

  /** The app's own statements table, once `own.ts` made it. */
  const ownStatements = () =>
    [...resources.entries()].find(
      ([, props]) =>
        props[atomic.parent] === APP &&
        props[atomic.classtype] === OWN_STATEMENT_CLASS,
    )?.[0];

  const store: FakeStore = {
    table,
    property: rowProperty,
    resources,
    runs,
    created,
    get accessRequests() {
      return accessRequests;
    },
    addStatements: seed => {
      if (!sharedRows)
        return addUnder(
          STATEMENTS,
          STATEMENT_CLASS_SUBJECT,
          'statement',
          seed,
          property,
        );
      const parent = ownStatements();
      if (!parent)
        throw new Error('load the app first: it makes its statements table');

      return addUnder(parent, OWN_STATEMENT_CLASS, 'statement', seed, s =>
        s === 'money-table' ? `${APP_ONTOLOGY}/money-table` : sharedProperty(s),
      );
    },
    saves,
    schemaSaves,
    subscribed,
    calls,
    opened,
    setScheme(to) {
      if (to === colorScheme) return;
      colorScheme = to;
      for (const listener of themeListeners) listener({ colorScheme });
    },
    addRows(seed) {
      return addUnder(
        table,
        sharedRows ? BANK_TRANSACTION : ROW_CLASS,
        'row',
        seed,
        rowProperty,
      );
    },
    failSaves(n, message = 'Simulated write failure') {
      failing = n;
      failure = message;
    },
    failCreates(n, message = 'Simulated write failure') {
      failingCreates = n;
      createFailure = message;
    },
    hold() {
      let release!: () => void;
      held = new Promise(resolve => (release = resolve));

      return () => {
        held = undefined;
        release();
      };
    },
    getApp: async () => APP,
    getData: async () =>
      data === 'none'
        ? undefined
        : {
            table,
            rowClass: resources.get(table)?.[atomic.classtype] as string,
            ...(modern && data === 'bank'
              ? {
                  tables: {
                    statements: {
                      table: STATEMENTS,
                      rowClass: STATEMENT_CLASS_SUBJECT,
                    },
                  },
                }
              : {}),
          },
    async getResource(subject) {
      calls.get++;
      if (held) await held;
      const stored = resources.get(subject);
      if (!stored) throw new Error(`No resource ${subject}`);

      return wrap(subject, stored);
    },
    async query({ property: p, value }) {
      return [...resources.entries()]
        .filter(([, props]) => props[p] === value)
        .map(([subject]) => subject);
    },
    async newResource({ parent = APP, isA = [], propVals = {} } = {}) {
      await Promise.resolve();

      if (failingCreates > 0) {
        failingCreates--;
        throw new Error(createFailure);
      }

      if (!within(parent) && !(writable && parent === table))
        throw new Error(REFUSED);
      // A Property or class is named by its shortname, so tests can predict
      // the app's own subjects; anything else by a counter.
      const shortname = propVals[atomic.shortname];
      const subject =
        typeof shortname === 'string'
          ? `${parent}/${shortname}`
          : `${parent}/new-${++next}`;
      const stored = {
        ...propVals,
        [atomic.parent]: parent,
        [atomic.isA]: isA,
      };
      resources.set(subject, stored);
      created.push(subject);
      notify(parent);

      return wrap(subject, stored);
    },
    subscribe(subject, handler) {
      const set = listeners.get(subject) ?? new Set();
      set.add(handler);
      listeners.set(subject, set);
      subscribed.add(subject);

      return () => {
        set.delete(handler);
        if (!set.size) subscribed.delete(subject);
      };
    },
  };

  if (host === 'current') {
    store.getMany = async subjects => {
      if (subjects.length > GET_MANY_MAX)
        throw new Error(
          `getMany reads at most ${GET_MANY_MAX} subjects at a time; ask in batches`,
        );
      calls.getMany.push(subjects.length);
      if (held) await held;

      return subjects.map(subject => {
        const stored = resources.get(subject);

        return stored
          ? wrap(subject, stored)
          : { subject, error: `No resource ${subject}` };
      });
    };

    store.getTheme = () => ({ colorScheme });

    store.onThemeChange = handler => {
      themeListeners.add(handler);

      return () => themeListeners.delete(handler);
    };

    store.openResource = async subject => {
      if (!resources.has(subject)) throw new Error(`No resource ${subject}`);
      opened.push(subject);

      return { status: 'opened' as const, subject };
    };
  }

  if (modern) {
    store.rowAccess = async () => ({
      status: data === 'own' ? 'unavailable' : accessStatus,
    });

    store.requestRowAccess = async () => {
      accessRequests++;

      if (answer === 'grant') {
        accessStatus = 'granted';
        writable = true;

        return { status: 'granted' as const };
      }

      return { status: 'denied' as const, reason: 'Not now' };
    };
  }

  // Only the importer's table has an importer behind it.
  if (modern && data === 'bank')
    store.importer = {
      async run(args) {
        runs.push(args?.file?.name ?? '(picker)');
        if (importRun) return importRun(args?.file);
        if (!args?.file) return { status: 'cancelled' };

        // Like the importer: new transactions by identity, one statement
        // row per statement, append-only.
        const { format, statements: parsed } = parseBankStatement(
          args.file.text,
        );
        const known = new Set(
          [...resources.values()].map(
            r => r[property('bank-source-id')] as string,
          ),
        );
        const fresh = entries(format, parsed).filter(
          e => !known.has(e.identity),
        );
        store.addRows(
          fresh.map(e => ({
            'bank-account': e.statement.account,
            'bank-currency': e.statement.currency,
            'bank-amount': e.row.amount,
            'bank-value-date': e.row.date,
            'bank-booking-date': e.row.bookingDate,
            'bank-description': e.row.description,
            'bank-reference': e.row.bankReference || e.row.reference,
            'bank-transaction-code': e.row.code,
            'bank-statement': e.statement.number,
            'bank-source-id': e.identity,
            'bank-fingerprint': e.fingerprint,
          })),
        );
        store.addStatements(
          parsed.map(st => ({
            'bank-account': st.account,
            'bank-currency': st.currency,
            'bank-statement': st.number,
            'bank-period-start': st.start,
            'bank-period-end': st.end,
            'bank-opening-balance': st.opening,
            'bank-closing-balance': st.closing,
            'bank-entry-count': String(st.transactions.length),
            'bank-format': format,
            'bank-imported-date': '2026-09-24',
          })),
        );

        return fresh.length
          ? {
              status: 'applied',
              created: fresh.length + parsed.length,
              updated: 0,
              destroyed: 0,
              failed: 0,
            }
          : { status: 'nothing' };
      },
    };

  if (rows.length) store.addRows(rows);
  if (statements.length) store.addStatements(statements);

  return store;
}

/** The four extras as the app's own Properties, by shortname. */
export const ownExtras = () =>
  Object.fromEntries(EXTRA_FIELDS.map(name => [name, sharedProperty(name)]));
