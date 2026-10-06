// @wc-ignore-file
/**
 * Where this app writes, and "Sync this table to Moneybird"
 * (ontola/atomic-plugins#177 §6.2 item 14; integrations/README.md, "Syncing a
 * table the app didn't make") on a `time-entry-v1` or `bank-transaction-v1`
 * table the app didn't make, which it reaches through the host's "+ Add
 * view".
 *
 * - On its **own** table (the install's), settings live on the App: the
 *   administration and the chosen collections. Contacts go to that table;
 *   hours and mutations to the app's own tables under the App (`own.ts`).
 * - On a table it is a **view of**, the one collection that table's class
 *   can hold is synced into it, after the person asked for it and gave the
 *   host's "Allow editing" grant that covers the app's `row-extras`. The
 *   table's **binding** is a resource under the App (always writable) whose
 *   `moneybird-synced-table` names the table and which holds the
 *   administration. Rows are created with `isA` [the table's class], the
 *   shared fields and the extras the grant covers; the table itself is never
 *   written, and a row is never deleted. Hours synced into such a table
 *   still link to the app's own Projects and People tables.
 */
import { TIME_ENTRY } from './hours.js';
import { BANK_TRANSACTION } from './mutations.js';
import { SYNCED_TABLE, type Adopted } from './own.js';
import { ADMINISTRATION, NAME, PARENT } from './sync.js';
import type { JSONValue, PluginStore, RowAccessAnswer } from './store.js';

export type Collection = 'contacts' | 'hours' | 'mutations';
export const COLLECTIONS: readonly Collection[] = [
  'contacts',
  'hours',
  'mutations',
];

export const COLLECTION_LABELS: Record<Collection, string> = {
  contacts: 'Contacts',
  hours: 'Hours (time entries)',
  mutations: 'Financial mutations',
};

/** The collection a table of `rowClass` can hold, if this app can sync one into it. */
export function collectionOf(rowClass: string): Collection | undefined {
  if (rowClass === TIME_ENTRY) return 'hours';
  if (rowClass === BANK_TRANSACTION) return 'mutations';

  return undefined;
}

/** The collections in `value` ("contacts,hours"), in canonical order. */
export function parseCollections(value: JSONValue): Collection[] {
  const names =
    typeof value === 'string' ? value.split(',').map(s => s.trim()) : [];

  return COLLECTIONS.filter(c => names.includes(c));
}

export const formatCollections = (collections: readonly Collection[]) =>
  COLLECTIONS.filter(c => collections.includes(c)).join(',');

export interface Layout {
  app: string;
  table: string;
  rowClass: string;
  /** The table is the app's own (the install's), not one it is a view of. */
  own: boolean;
  /** The table's name, for messages. */
  name: string;
}

export async function layout(store: PluginStore): Promise<Layout> {
  const data = await store.getData();
  if (!data?.table || !data.rowClass)
    throw new Error('This app has no table with a row class to import into.');
  const app = await store.getApp();
  const table = await store.getResource(data.table);
  const name = table.get(NAME);

  return {
    app,
    table: data.table,
    rowClass: data.rowClass,
    own: table.get(PARENT) === app,
    name: typeof name === 'string' && name ? name : 'this table',
  };
}

/**
 * The binding for the table the app is a view of: a child of the App whose
 * `moneybird-synced-table` is that table. On the app's own table, the App
 * itself (settings live there).
 */
export async function findHome(
  store: PluginStore,
  where: Layout,
  adopted: Adopted,
): Promise<string | undefined> {
  if (where.own) return where.app;
  const property = adopted.properties.get(SYNCED_TABLE.shortname)!;

  for (const subject of await store.query({ property, value: where.table })) {
    const candidate = await store.getResource(subject).catch(() => undefined);
    if (candidate?.get(PARENT) === where.app) return subject;
  }

  return undefined;
}

/** The binding for the table the app is a view of, made when missing. */
export async function bindTable(
  store: PluginStore,
  where: Layout,
  adopted: Adopted,
): Promise<string> {
  const found = await findHome(store, where, adopted);
  if (found) return found;
  const binding = await store.newResource({
    parent: where.app,
    propVals: {
      [NAME]: `Moneybird sync of ${where.name}`,
      [adopted.properties.get(SYNCED_TABLE.shortname)!]: where.table,
    },
  });

  return binding.subject;
}

/**
 * "Not now" before an administration was chosen: the table goes back to not
 * synced. A binding with an administration is kept ("Stop syncing" is not
 * built). True when it removed one.
 */
export async function unbindTable(
  store: PluginStore,
  where: Layout,
  adopted: Adopted,
): Promise<boolean> {
  if (where.own) return false;
  const home = await findHome(store, where, adopted);
  if (!home) return false;
  const binding = await store.getResource(home);
  if (binding.get(adopted.properties.get(ADMINISTRATION.shortname)!))
    return false;
  await binding.destroy();

  return true;
}

/**
 * Whether the person's grant on the table the app is a view of covers its
 * columns and every row extra. Always true on the app's own table. Read
 * fresh each time: the grant lapses when the view is removed, the person who
 * gave it loses write access, the app's key changes or someone takes it back
 * in the tab menu.
 */
export async function hasRowAccess(
  store: PluginStore,
  where: Layout,
  adopted: Adopted,
): Promise<boolean> {
  if (where.own) return true;
  if (typeof store.rowAccess !== 'function') return false;
  const access = await store.rowAccess();
  if (access.status !== 'granted') return false;

  return adopted.extras.every(extra => access.extras.includes(extra));
}

/** Whether this host can ask for, and report, "Allow editing". */
export const canAskRowAccess = (store: PluginStore) =>
  typeof store.rowAccess === 'function' &&
  typeof store.requestRowAccess === 'function';

/**
 * Asks for "Allow editing" when the grant is missing or doesn't cover the
 * row extras: the host's own bar asks the person and records a grant for
 * the extras the App declares now, superseding an older one. Never writes
 * the table.
 */
export async function ensureRowAccess(
  store: PluginStore,
  where: Layout,
  adopted: Adopted,
): Promise<RowAccessAnswer> {
  if (await hasRowAccess(store, where, adopted)) return { status: 'granted' };
  if (!canAskRowAccess(store))
    return {
      status: 'denied',
      reason: 'This host can’t let an app edit another table’s rows.',
    };
  const answer = await store.requestRowAccess!();
  if (answer.status !== 'granted') return answer;
  if (await hasRowAccess(store, where, adopted)) return answer;

  return {
    status: 'denied',
    reason:
      'The grant doesn’t cover the Moneybird identities the app keeps on rows.',
  };
}
