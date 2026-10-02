// @wc-ignore-file
/**
 * Every open: make this app a view of the shared `bank-transaction-v1` class
 * (ontola/atomic-plugins#177 §6.2 item 3, spike S2) and of the importer's
 * table. At the pinned host a catalog Install calls `createApp` without a row
 * class, so the App renders only a class of its own and gets an empty table
 * of that class; nothing offers it on the Bank statements importer's table.
 * Through the frame store, inside its own subtree, the app fixes that
 * itself, as the calendar, timesheets and issue-tracker apps do:
 *
 * 1. Its own schema exists (`own.ts`): the four row extras, the statement
 *    class and the statements table.
 * 2. Its own table's `classtype` becomes `bank-transaction-v1`, so the rows
 *    it imports there are shared rows and the table's columns are the shared
 *    fields. The table is empty after an install; rows of the old class, if
 *    someone typed any, keep their class and are not shown.
 * 3. The App's `renders` lists `bank-transaction-v1`, so the host's
 *    "+ Add view" (`appsForClass`, exact subject) offers it on any table of
 *    that class, and every class in this drive that is the importer's
 *    `bank-transaction` (shortname, declaring the four required bank fields;
 *    minted per drive by the importer's Set up, so found at run time), so
 *    Add view offers it on the importer's table too. An importer set up
 *    after this open is picked up by the next one.
 * 4. The App's `row-extras` lists the four extras (atomic-server#1849): what
 *    an "Allow editing" grant on another table also lets it write.
 *
 * Every step is skipped when already done. `renders` and `row-extras` are
 * the drive's own App properties (minted per drive by the host's plugin
 * schema), found by shortname among the App class's `recommends`. Once the
 * host lets a catalog entry declare its row classes (#177 H2), steps 2 and
 * 3's first half go.
 */
import { ensureOwnSchema, type OwnSchema } from './own.js';
import {
  atomic,
  BANK_TRANSACTION,
  classFields,
  EXTRA_FIELDS,
  list,
  REQUIRED,
  type Fields,
} from './rows.js';
import type { DataRef, PluginResource, PluginStore } from './store.js';

export interface Adopted {
  /** The app's own terms; `undefined` on a host where it has no ontology. */
  own?: OwnSchema;
  /** The data ref, with the row class the app's own table now has. */
  data: DataRef | undefined;
  /** True when the table shown is the app's own, not one it is a view of. */
  ownTable: boolean;
  /** Whether the App's `renders` lists the shared class (now or before). */
  renders: boolean;
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every(x => b.includes(x));

/** The App properties named `shortnames`, from the App class's `recommends`. */
async function appProperties(
  store: PluginStore,
  app: PluginResource,
  shortnames: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  for (const klass of list(app.get(atomic.isA))) {
    const listed = await store
      .getResource(klass)
      .then(k => [
        ...list(k.get(atomic.recommends)),
        ...list(k.get(atomic.requires)),
      ])
      .catch(() => []);

    for (const property of listed) {
      const shortname = await store
        .getResource(property)
        .then(p => p.get(atomic.shortname))
        .catch(() => undefined);
      if (typeof shortname === 'string' && shortnames.includes(shortname))
        found.set(shortname, property);
    }
  }

  return found;
}

/**
 * The importer's row classes in this drive: shortname `bank-transaction`,
 * not in the app's own ontology, declaring the four required bank fields.
 */
export async function importerClasses(
  store: PluginStore,
  ownOntology: string | undefined,
): Promise<string[]> {
  const found: string[] = [];
  const candidates = await store
    .query({ property: atomic.shortname, value: 'bank-transaction' })
    .catch(() => [] as string[]);

  for (const subject of candidates) {
    const klass = await store.getResource(subject).catch(() => undefined);
    if (!klass || klass.get(atomic.parent) === ownOntology) continue;
    if (!list(klass.get(atomic.isA)).includes(atomic.classClass)) continue;
    const fields: Fields = await classFields(store, subject).catch(() => ({}));
    if (REQUIRED.every(name => fields[name])) found.push(subject);
  }

  return found;
}

export async function adopt(
  store: PluginStore,
  data: DataRef | undefined,
): Promise<Adopted> {
  const appSubject = await store.getApp();
  const own = await ensureOwnSchema(store).catch(() => undefined);
  let ownTable = false;

  if (data) {
    const table = await store.getResource(data.table);
    ownTable = table.get(atomic.parent) === appSubject;

    if (ownTable && data.rowClass !== BANK_TRANSACTION) {
      table.set(atomic.classtype, BANK_TRANSACTION);
      await table.save();
      data = { ...data, rowClass: BANK_TRANSACTION };
    }
  }

  const app = await store.getResource(appSubject);
  const terms = await appProperties(store, app, ['renders', 'row-extras']);
  const renders = terms.get('renders');
  const rowExtras = terms.get('row-extras');
  let dirty = false;
  let listed = false;

  if (renders) {
    const current = list(app.get(renders));
    const wanted = [
      BANK_TRANSACTION,
      ...(await importerClasses(store, own?.ontology)),
    ].filter(klass => !current.includes(klass));

    if (wanted.length) {
      app.set(renders, [...current, ...wanted]);
      dirty = true;
    }

    listed = true;
  }

  if (rowExtras && own) {
    const wanted = EXTRA_FIELDS.map(name => own.extras[name]!);

    if (!sameSet(list(app.get(rowExtras)), wanted)) {
      app.set(rowExtras, wanted);
      dirty = true;
    }
  }

  if (dirty) await app.save();

  return { own, data, ownTable, renders: listed };
}
