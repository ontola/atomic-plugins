// @wc-ignore-file
/**
 * Importing Moneybird collections into tables: the common reconcile, and one
 * sync per collection (contacts, hours, financial mutations). Every sync
 * reads everything it needs before writing anything, so a refresh that fails
 * part-way leaves its table exactly as it was. Rows are matched by
 * `moneybird-source-id`; a repeated import with no change on Moneybird
 * writes nothing. Moneybird owns the imported columns: a changed record
 * overwrites them, and a column it no longer sends is removed (local-edit
 * preservation is atomic-plugins#97's policy question). Records that
 * disappear from Moneybird are kept, not deleted: a grant on another table
 * never deletes a row anyway.
 */
import {
  CONTACT_FIELDS,
  contactName,
  contactValues,
  sourceId,
  UPDATED_AT,
  VERSION,
  type ContactField,
} from './contacts.js';
import {
  hourOf,
  PAUSED_DURATION,
  personSourceId,
  projectSourceId,
  TIME_ENTRY,
  WORK,
  WORK_PERSON,
  WORK_PROJECT,
  type HourRow,
} from './hours.js';
import {
  BANK,
  BANK_TRANSACTION,
  CONTRA_ACCOUNT,
  mutationOf,
  STATE,
} from './mutations.js';
import {
  readContacts,
  readFinancialAccounts,
  readFinancialMutations,
  readTimeEntries,
  UPSTREAM,
  type MoneybirdGet,
  type MoneybirdResponse,
  type MutationOptions,
} from './read.js';
import type {
  ConnectionReference,
  HostProxy,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';

export const PLATFORM = 'moneybird';

const A = 'https://atomicdata.dev';

export const PARENT = `${A}/properties/parent`;
export const IS_A = `${A}/properties/isA`;
export const NAME = `${A}/properties/name`;
export const SHORTNAME = `${A}/properties/shortname`;
export const DESCRIPTION = `${A}/properties/description`;
export const DATATYPE = `${A}/properties/datatype`;
export const RECOMMENDS = `${A}/properties/recommends`;
export const REQUIRES = `${A}/properties/requires`;
export const PROPERTIES = `${A}/properties/properties`;
export const CLASSTYPE = `${A}/properties/classtype`;
export const PROPERTY_CLASS = `${A}/classes/Property`;
export const TABLE_CLASS = `${A}/classes/Table`;
/** The App's own ontology, as the host's `createApp` sets it. */
export const DEFAULT_ONTOLOGY = `${A}/ontology/server/property/default-ontology`;

/** Row identity; see `sourceId`, `hourSourceId`, `mutationSourceId`. */
export const SOURCE_ID: ContactField = {
  key: 'id',
  shortname: 'moneybird-source-id',
  name: 'Moneybird source',
  description:
    'Import identity: moneybird:<administration>:<collection>:<id>. Stable across reads.',
  datatype: `${A}/datatypes/string`,
};
/** The chosen administration, stored on the App resource (or a table's binding). */
export const ADMINISTRATION: ContactField = {
  key: 'administration',
  shortname: 'moneybird-administration',
  name: 'Moneybird administration',
  description: 'The Moneybird administration this app imports from.',
  datatype: `${A}/datatypes/string`,
};

/** The extras this app may keep on a row of a shared class (its `row-extras`). */
export const ROW_EXTRAS: ContactField[] = [
  SOURCE_ID,
  UPDATED_AT,
  VERSION,
  PAUSED_DURATION,
  STATE,
  CONTRA_ACCOUNT,
];

export interface SyncSummary {
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  /** Records the mapping could not make a complete row of (hours.ts, mutations.ts). */
  skipped: number;
}

/** The base path of UPSTREAM: what a relayed path starts with. */
const BASE_PATH = new URL(UPSTREAM).pathname.replace(/\/+$/, '');

/**
 * A `MoneybirdGet` over the host's proxy relay. The frame never holds a
 * credential or calls the network itself; the host's page makes the call.
 */
export function relayGet(
  proxy: HostProxy,
  connection: ConnectionReference,
): MoneybirdGet {
  return async path => {
    if (!path.startsWith('/'))
      throw new Error(`Refusing a Moneybird path: ${path}`);
    // The proxy resolves a relayed path against the composed document's
    // `servers[0].url`, base path included: `/api/v2/administrations.json`,
    // not `/administrations.json` (integration-proxy catalog.rs `allows`).
    const response = await proxy.request({
      platform: connection.platform,
      connectionId: connection.connectionId,
      path: `${BASE_PATH}${path}`,
      method: 'GET',
    });

    return {
      status: response.status,
      headers: response.headers ?? {},
      body: response.body,
    } satisfies MoneybirdResponse;
  };
}

export { UPSTREAM };

export const asList = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/**
 * The ontology the app's own Properties go in: the App's `default-ontology`
 * (the host's `createApp` sets it), else the own table's row class's parent
 * on an older host.
 */
export async function ownOntology(store: PluginStore): Promise<string> {
  const app = await store.getResource(await store.getApp());
  const own = app.get(DEFAULT_ONTOLOGY);
  if (typeof own === 'string' && own) return own;
  const data = await store.getData();
  if (!data?.rowClass)
    throw new Error('This app has no table with a row class to import into.');
  const parent = (await store.getResource(data.rowClass)).get(PARENT);
  if (typeof parent !== 'string')
    throw new Error('This app has no ontology of its own to add fields to.');

  return parent;
}

/** Shortname -> Property subject, creating the missing ones in the app's own ontology. */
export async function ensureProperties(
  store: PluginStore,
  terms: Pick<
    ContactField,
    'shortname' | 'name' | 'description' | 'datatype'
  >[],
): Promise<Map<string, string>> {
  const ontologySubject = await ownOntology(store);
  const ontology = await store.getResource(ontologySubject);
  const listed = asList(ontology.get(PROPERTIES));
  const byShortname = new Map<string, string>();

  for (const subject of listed) {
    const shortname = await store
      .getResource(subject)
      .then(p => p.get(SHORTNAME))
      .catch(() => undefined);
    if (typeof shortname === 'string') byShortname.set(shortname, subject);
  }

  const created: string[] = [];
  const out = new Map<string, string>();

  for (const term of terms) {
    let subject = byShortname.get(term.shortname);

    if (!subject) {
      subject = (
        await store.newResource({
          parent: ontologySubject,
          isA: [PROPERTY_CLASS],
          propVals: {
            [SHORTNAME]: term.shortname,
            [NAME]: term.name,
            [DESCRIPTION]: term.description,
            [DATATYPE]: term.datatype,
          },
        })
      ).subject;
      created.push(subject);
      byShortname.set(term.shortname, subject);
    }

    out.set(term.shortname, subject);
  }

  if (created.length > 0)
    await ontology.set(PROPERTIES, [...listed, ...created]).save();

  return out;
}

/** One row to write: its identity and every property value it should have. */
export interface Incoming {
  identity: string;
  propVals: Record<string, JSONValue>;
}

/**
 * Makes `table`'s rows match `incoming`: by `sourceProperty`, a row per
 * identity, created with `isA` [`rowClass`] under the table, its `owned`
 * properties set to the incoming values and removed when no longer sent.
 * Rows with another or no identity are left alone. Pure writes: everything
 * was read before this is called.
 */
export async function reconcile(
  store: PluginStore,
  {
    table,
    rowClass,
    sourceProperty,
    owned,
    incoming,
  }: {
    table: string;
    rowClass: string;
    sourceProperty: string;
    /** Every property an import may set on a row (the source property included). */
    owned: string[];
    incoming: Incoming[];
  },
): Promise<Map<string, string> & { summary: SyncSummary }> {
  const existing = new Map<string, PluginResource>();

  for (const subject of await store.query({
    property: PARENT,
    value: table,
  })) {
    const row = await store.getResource(subject).catch(() => undefined);
    const id = row?.get(sourceProperty);
    if (row && typeof id === 'string') existing.set(id, row);
  }

  const summary: SyncSummary = {
    total: incoming.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
  };
  const subjects = new Map<string, string>() as Map<string, string> & {
    summary: SyncSummary;
  };

  for (const { identity, propVals } of incoming) {
    const values = { ...propVals, [sourceProperty]: identity };
    const row = existing.get(identity);

    if (!row) {
      const made = await store.newResource({
        parent: table,
        isA: [rowClass],
        propVals: values,
      });
      subjects.set(identity, made.subject);
      summary.added++;
      continue;
    }

    subjects.set(identity, row.subject);
    let changed = false;

    for (const [property, value] of Object.entries(values))
      if (row.get(property) !== value) {
        row.set(property, value);
        changed = true;
      }

    for (const property of owned)
      if (!(property in values) && row.get(property) !== undefined) {
        row.remove(property);
        changed = true;
      }

    if (!changed) {
      summary.unchanged++;
      continue;
    }

    await row.save();
    summary.updated++;
  }

  subjects.summary = summary;

  return subjects;
}

/**
 * Reads every contact of `administrationId`, then reconciles the app's own
 * table (the one its install made), naming it and its row class.
 */
export async function syncContacts(
  store: PluginStore,
  get: MoneybirdGet,
  administrationId: string,
  read: typeof readContacts = readContacts,
): Promise<SyncSummary> {
  const data = await store.getData();
  if (!data?.rowClass)
    throw new Error('This app has no table with a row class to import into.');
  const contacts = await read(get, administrationId);

  const properties = await ensureProperties(store, [
    SOURCE_ID,
    ...CONTACT_FIELDS,
  ]);
  const klass = await store.getResource(data.rowClass);
  const recommends = asList(klass.get(RECOMMENDS));
  const wanted = [NAME, ...properties.values()];
  const merged = [
    ...recommends,
    ...wanted.filter(s => !recommends.includes(s)),
  ];
  if (merged.length !== recommends.length || klass.get(NAME) !== 'Contact')
    await klass.set(RECOMMENDS, merged).set(NAME, 'Contact').save();
  const table = await store.getResource(data.table);
  if (table.get(NAME) !== 'Moneybird contacts')
    await table.set(NAME, 'Moneybird contacts').save();

  const incoming: Incoming[] = contacts.map(contact => {
    const propVals: Record<string, JSONValue> = {
      [NAME]: contactName(contact),
    };

    for (const [shortname, value] of Object.entries(contactValues(contact)))
      propVals[properties.get(shortname)!] = value;

    return { identity: sourceId(contact, administrationId), propVals };
  });

  return (
    await reconcile(store, {
      table: data.table,
      rowClass: data.rowClass,
      sourceProperty: properties.get(SOURCE_ID.shortname)!,
      owned: [NAME, ...properties.values()],
      incoming,
    })
  ).summary;
}

/** Where the hours import writes: the time entries table and the two link tables. */
export interface HourTables {
  hours: string;
  projects: string;
  people: string;
}

/**
 * Reads this year's time entries of `administrationId`, then reconciles the
 * Projects and People tables (one row per project or user the entries
 * embed, named as Moneybird names them) and the hours table, whose rows
 * link to those.
 */
export async function syncHours(
  store: PluginStore,
  get: MoneybirdGet,
  administrationId: string,
  tables: HourTables,
  read: typeof readTimeEntries = readTimeEntries,
): Promise<SyncSummary> {
  const entries = await read(get, administrationId);
  const properties = await ensureProperties(store, [
    SOURCE_ID,
    UPDATED_AT,
    PAUSED_DURATION,
  ]);
  const source = properties.get(SOURCE_ID.shortname)!;
  const rows: HourRow[] = [];
  let skipped = 0;

  for (const entry of entries) {
    const row = hourOf(entry, administrationId);
    if (row) rows.push(row);
    else skipped++;
  }

  const links = async (
    kind: 'project' | 'person',
    table: string,
    rowClass: string,
  ) => {
    const seen = new Map<string, Incoming>();

    for (const row of rows) {
      const target = row[kind];
      if (!target) continue;
      const identity =
        kind === 'project'
          ? projectSourceId(administrationId, target.id)
          : personSourceId(administrationId, target.id);
      seen.set(identity, { identity, propVals: { [NAME]: target.name } });
    }

    return reconcile(store, {
      table,
      rowClass,
      sourceProperty: source,
      owned: [NAME, source],
      incoming: [...seen.values()],
    });
  };

  const projects = await links('project', tables.projects, WORK_PROJECT);
  const people = await links('person', tables.people, WORK_PERSON);

  const incoming: Incoming[] = rows.map(row => {
    const propVals: Record<string, JSONValue> = {
      [NAME]: row.name,
      [WORK.start]: row.start,
    };
    if (row.end !== undefined) propVals[WORK.end] = row.end;
    if (row.billable !== undefined) propVals[WORK.billable] = row.billable;
    if (row.project)
      propVals[WORK.project] = projects.get(
        projectSourceId(administrationId, row.project.id),
      )!;
    if (row.person)
      propVals[WORK.person] = people.get(
        personSourceId(administrationId, row.person.id),
      )!;
    if (row.paused !== undefined)
      propVals[properties.get(PAUSED_DURATION.shortname)!] = row.paused;
    if (row.updatedAt)
      propVals[properties.get(UPDATED_AT.shortname)!] = row.updatedAt;

    return { identity: row.identity, propVals };
  });

  const summary = (
    await reconcile(store, {
      table: tables.hours,
      rowClass: TIME_ENTRY,
      sourceProperty: source,
      owned: [NAME, ...Object.values(WORK), ...properties.values()],
      incoming,
    })
  ).summary;
  summary.total += skipped;
  summary.skipped = skipped;

  return summary;
}

/**
 * Reads the financial accounts and this year's financial mutations of
 * `administrationId`, then reconciles `table` (a `bank-transaction-v1`
 * table).
 */
export async function syncMutations(
  store: PluginStore,
  get: MoneybirdGet,
  administrationId: string,
  table: string,
  options: MutationOptions = {},
  read: typeof readFinancialMutations = readFinancialMutations,
): Promise<SyncSummary> {
  const accounts = await readFinancialAccounts(get, administrationId);
  const mutations = await read(get, administrationId, options);
  const properties = await ensureProperties(store, [
    SOURCE_ID,
    UPDATED_AT,
    VERSION,
    STATE,
    CONTRA_ACCOUNT,
  ]);
  const p = (field: ContactField) => properties.get(field.shortname)!;
  const incoming: Incoming[] = [];
  let skipped = 0;

  for (const mutation of mutations) {
    const row = mutationOf(mutation, administrationId, accounts);

    if (!row) {
      skipped++;
      continue;
    }

    const propVals: Record<string, JSONValue> = {
      [NAME]: row.name,
      [BANK.account]: row.account,
      [BANK.currency]: row.currency,
      [BANK.amount]: row.amount,
      [BANK.valueDate]: row.valueDate,
    };
    if (row.description) propVals[BANK.description] = row.description;
    if (row.reference) propVals[BANK.reference] = row.reference;
    if (row.state) propVals[p(STATE)] = row.state;
    if (row.contraAccount) propVals[p(CONTRA_ACCOUNT)] = row.contraAccount;
    if (row.version !== undefined) propVals[p(VERSION)] = row.version;
    if (row.updatedAt) propVals[p(UPDATED_AT)] = row.updatedAt;
    incoming.push({ identity: row.identity, propVals });
  }

  const summary = (
    await reconcile(store, {
      table,
      rowClass: BANK_TRANSACTION,
      sourceProperty: p(SOURCE_ID),
      owned: [NAME, ...Object.values(BANK), ...properties.values()],
      incoming,
    })
  ).summary;
  summary.total += skipped;
  summary.skipped = skipped;

  return summary;
}
