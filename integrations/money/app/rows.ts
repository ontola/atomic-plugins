// @wc-ignore-file
/**
 * Reading a Bank transactions table. Two shapes reach this app:
 *
 * - A table of the shared class `bank-transaction-v1`
 *   (ontola/atomic-plugins#177): the app's own table after a catalog install
 *   (`adopt.ts`), or any table someone made with that class. Its shared
 *   fields are read and written by their published subjects only, through
 *   `ontology-kit`'s strict resolver: no lookup by shortname, name or
 *   column. The import bookkeeping on such rows (`bank-source-id`,
 *   `bank-fingerprint`, `bank-statement`, `bank-transaction-code`) is not
 *   shared: the app mints those four Properties in its own ontology
 *   (`own.ts`) and declares them as its `row-extras`.
 * - The Bank statements importer's table, whose rows are of the drive-local
 *   `bank-transaction` class the importer's Set up minted from
 *   `bankingSchema()` (`../schema.ts`). That class reaches the same `Txn`
 *   shape through a lens: its declared properties, found by the shortnames
 *   the class lists, mapped onto the fields above. The lens is money's own
 *   (its `from` is money's own class), so it lives here, not in
 *   `ontology-kit/`. A table of any other class is not a bank transactions
 *   table.
 */
import { createResolver } from '../../../ontology-kit/resolver.mjs';
import { classes, properties } from '../../../ontology-kit/terms.mjs';
import {
  GET_MANY_MAX,
  type JSONValue,
  type PluginResource,
  type PluginStore,
} from './store.js';

/** The shared class this app renders, at its published subject. */
export const BANK_TRANSACTION = classes['bank-transaction-v1'].subject;

/** Strict: accepts exactly `bank-transaction-v1` (#177 decision 1). */
export const resolver = createResolver({
  classes: [classes['bank-transaction-v1']],
});

export const atomic = {
  parent: 'https://atomicdata.dev/properties/parent',
  isA: 'https://atomicdata.dev/properties/isA',
  shortname: 'https://atomicdata.dev/properties/shortname',
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  datatype: 'https://atomicdata.dev/properties/datatype',
  requires: 'https://atomicdata.dev/properties/requires',
  recommends: 'https://atomicdata.dev/properties/recommends',
  classtype: 'https://atomicdata.dev/properties/classtype',
  properties: 'https://atomicdata.dev/properties/properties',
  classes: 'https://atomicdata.dev/properties/classes',
  propertyClass: 'https://atomicdata.dev/classes/Property',
  classClass: 'https://atomicdata.dev/classes/Class',
  tableClass: 'https://atomicdata.dev/classes/Table',
  /** The App's own ontology, as the host's `createApp` sets it. */
  defaultOntology:
    'https://atomicdata.dev/ontology/server/property/default-ontology',
} as const;

export const datatypes = {
  string: 'https://atomicdata.dev/datatypes/string',
  date: 'https://atomicdata.dev/datatypes/date',
  atomicURL: 'https://atomicdata.dev/datatypes/atomicURL',
} as const;

/** The fields of a transaction row (`../plugin.ts` writes the same ones). */
export const BANK_FIELDS = [
  'bank-account',
  'bank-currency',
  'bank-amount',
  'bank-value-date',
  'bank-booking-date',
  'bank-description',
  'bank-reference',
  'bank-transaction-code',
  'bank-statement',
  'bank-source-id',
  'bank-fingerprint',
] as const;

/** On a Bank statement row (the importer's `statements` table, or the app's). */
export const STATEMENT_ROW_FIELDS = [
  'bank-period-start',
  'bank-period-end',
  'bank-opening-balance',
  'bank-closing-balance',
  'bank-entry-count',
  'bank-format',
  'bank-imported-date',
] as const;

/** The person's own annotations (DESIGN.md gap 5); the importer never writes them. */
export const NOTE_FIELDS = ['money-category', 'money-note'] as const;

export type BankField = (typeof BANK_FIELDS)[number];
export type NoteField = (typeof NOTE_FIELDS)[number];
export type StatementField = (typeof STATEMENT_ROW_FIELDS)[number];
export type Shortname = BankField | NoteField | StatementField;

/**
 * The shared class's fields, by the shortnames this app uses for them: the
 * published subjects (`ontology-kit/terms.mjs`).
 */
export const SHARED = [
  'bank-account',
  'bank-currency',
  'bank-amount',
  'bank-value-date',
  'bank-booking-date',
  'bank-description',
  'bank-reference',
  'money-category',
  'money-note',
] as const satisfies readonly (BankField | NoteField)[];

export type SharedField = (typeof SHARED)[number];

export const SHARED_SUBJECT: Readonly<Record<SharedField, string>> =
  Object.fromEntries(
    SHARED.map(name => [name, properties[name].subject]),
  ) as Record<SharedField, string>;

/**
 * Written on each transaction row beside the shared fields; not part of the
 * shared class. On the app's own rows these are its `row-extras` (`own.ts`);
 * on the importer's rows, Properties of the drive ontology.
 */
export const EXTRA_FIELDS = [
  'bank-source-id',
  'bank-fingerprint',
  'bank-statement',
  'bank-transaction-code',
] as const satisfies readonly BankField[];

export type ExtraField = (typeof EXTRA_FIELDS)[number];

/** Property subject by shortname, for the ones the row class declares. */
export type Fields = Partial<Record<Shortname, string>>;

export type StatementFormat = 'mt940' | 'camt053';

export interface Txn {
  subject: string;
  account: string;
  currency: string;
  /** Exact signed decimal string. */
  amount: string;
  valueDate: string;
  /** Booking date; the value date when the row has none. */
  bookingDate: string;
  description: string;
  reference: string;
  code: string;
  statement: string;
  sourceId: string;
  fingerprint: string;
  /** From the importer's source identity; `undefined` when it is not one. */
  format?: StatementFormat;
  category: string;
  note: string;
}

const KNOWN = new Set<string>([
  ...BANK_FIELDS,
  ...NOTE_FIELDS,
  ...STATEMENT_ROW_FIELDS,
]);

/** One imported statement, as the importer or this app stored it. */
export interface StoredStatement {
  subject: string;
  account: string;
  currency: string;
  number: string;
  start: string;
  end: string;
  /** Exact decimal strings. */
  opening: string;
  closing: string;
  entries: string;
  format?: StatementFormat;
  imported: string;
  /** The importer's identity for the statement; `''` on an older row. */
  sourceId: string;
  /** The table the transactions went to (`money-table`), when stored. */
  table?: string;
}

export function readStatement(
  resource: Pick<PluginResource, 'subject' | 'get'>,
  fields: Fields,
  tableField?: string,
): StoredStatement | undefined {
  const text = (name: Shortname) => {
    const property = fields[name];
    const value = property ? resource.get(property) : undefined;

    return typeof value === 'string' ? value : '';
  };

  const account = text('bank-account');
  const currency = text('bank-currency');
  const end = text('bank-period-end');
  const closing = text('bank-closing-balance');
  if (!account || !currency || !end || !closing) return undefined;
  const format = text('bank-format');
  const table = tableField ? resource.get(tableField) : undefined;

  return {
    subject: resource.subject,
    account,
    currency,
    number: text('bank-statement'),
    start: text('bank-period-start'),
    end,
    opening: text('bank-opening-balance'),
    closing,
    entries: text('bank-entry-count'),
    format: format === 'mt940' || format === 'camt053' ? format : undefined,
    imported: text('bank-imported-date'),
    sourceId: text('bank-source-id'),
    ...(typeof table === 'string' ? { table } : {}),
  };
}

export const list = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/**
 * The fields a class declares, by the shortnames this app knows: its
 * `requires` and `recommends`, each Property read for its shortname. A shared
 * property is recognised by its subject without reading it.
 */
export async function classFields(
  store: PluginStore,
  rowClass: string,
): Promise<Fields> {
  const klass = await store.getResource(rowClass);
  const subjects = [
    ...new Set([
      ...list(klass.get(atomic.requires)),
      ...list(klass.get(atomic.recommends)),
    ]),
  ];
  const fields: Fields = {};
  const shared = new Map<string, Shortname>(
    SHARED.map(name => [SHARED_SUBJECT[name], name]),
  );
  const unknown: string[] = [];

  for (const subject of subjects) {
    const name = shared.get(subject);
    if (name) fields[name] ??= subject;
    else unknown.push(subject);
  }

  const resources = await Promise.all(
    unknown.map(s => store.getResource(s).catch(() => undefined)),
  );

  for (const property of resources) {
    const shortname = property?.get(atomic.shortname);
    if (typeof shortname === 'string' && KNOWN.has(shortname))
      fields[shortname as Shortname] ??= property!.subject;
  }

  return fields;
}

/**
 * The lens from the importer's drive-local `bank-transaction` class onto
 * this app's fields: the class's declared properties by shortname, plus the
 * bookkeeping `bankingSchema()` leaves off the class (the importer writes
 * the fingerprint; nobody fills it in by hand), found by shortname and
 * preferably in the class's own ontology. `undefined` when the class does
 * not declare the four fields without which a row is not a bank
 * transaction: then it is not the importer's class, and not a bank table.
 */
export async function importerLens(
  store: PluginStore,
  rowClass: string,
): Promise<Fields | undefined> {
  const klass = await store.getResource(rowClass);
  const fields = await classFields(store, rowClass);
  if (!REQUIRED.every(name => fields[name])) return undefined;
  const ontology = klass.get(atomic.parent);

  for (const shortname of EXTRA_FIELDS) {
    if (fields[shortname]) continue;
    const found = await store
      .query({ property: atomic.shortname, value: shortname })
      .catch(() => [] as string[]);
    if (!found.length) continue;
    const resources = await Promise.all(
      found.map(s => store.getResource(s).catch(() => undefined)),
    );
    const property =
      resources.find(r => r && r.get(atomic.parent) === ontology) ??
      resources.find(Boolean);
    if (property) fields[shortname] = property.subject;
  }

  return fields;
}

/**
 * The fields of the table's rows, or `undefined` when `rowClass` is neither
 * `bank-transaction-v1` nor the importer's class. For the shared class the
 * shared fields are the published subjects and the bookkeeping is the app's
 * own `extras` (`own.ts`), when it has them.
 */
export async function resolveFields(
  store: PluginStore,
  rowClass: string,
  extras: Fields = {},
): Promise<Fields | undefined> {
  if (resolver.accepts(rowClass)) {
    const fields: Fields = { ...SHARED_SUBJECT };
    for (const name of EXTRA_FIELDS)
      if (extras[name]) fields[name] = extras[name];

    return fields;
  }

  return importerLens(store, rowClass);
}

/** The fields without which a row is not a bank transaction at all. */
export const REQUIRED: BankField[] = [
  'bank-account',
  'bank-currency',
  'bank-amount',
  'bank-value-date',
];

export const canAnnotate = (fields: Fields) =>
  Boolean(fields['money-category'] && fields['money-note']);

export function formatOf(sourceId: string): StatementFormat | undefined {
  try {
    const parsed: unknown = JSON.parse(sourceId);
    const first = Array.isArray(parsed) ? parsed[0] : undefined;

    return first === 'mt940' || first === 'camt053' ? first : undefined;
  } catch {
    return undefined;
  }
}

export function readRow(
  resource: Pick<PluginResource, 'subject' | 'get'>,
  fields: Fields,
): Txn | undefined {
  const text = (name: Shortname) => {
    const property = fields[name];
    const value = property ? resource.get(property) : undefined;

    return typeof value === 'string' ? value : '';
  };

  const amount = text('bank-amount');
  const account = text('bank-account');
  const currency = text('bank-currency');
  const valueDate = text('bank-value-date');
  if (!amount || !account || !currency || !valueDate) return undefined;
  const sourceId = text('bank-source-id');

  return {
    subject: resource.subject,
    account,
    currency,
    amount,
    valueDate,
    bookingDate: text('bank-booking-date') || valueDate,
    description: text('bank-description'),
    reference: text('bank-reference'),
    code: text('bank-transaction-code'),
    statement: text('bank-statement'),
    sourceId,
    fingerprint: text('bank-fingerprint'),
    format: formatOf(sourceId),
    category: text('money-category'),
    note: text('money-note'),
  };
}

/**
 * Reads `subjects`, reporting progress. With the host's `getMany`, in
 * batches of `GET_MANY_MAX`, a few in flight; otherwise one `getResource`
 * each, `concurrency` in flight. Unreadable rows are skipped, not fatal: one
 * broken resource should not hide a ledger.
 */
export async function readRows(
  store: PluginStore,
  subjects: string[],
  fields: Fields,
  onProgress?: (loaded: number) => void,
  concurrency = 16,
): Promise<Txn[]> {
  return readMany(
    store,
    subjects,
    r => readRow(r, fields),
    onProgress,
    concurrency,
  );
}

/** Reads `subjects` into `T`s (see `readRows`); unreadable ones are skipped. */
export async function readMany<T>(
  store: PluginStore,
  subjects: string[],
  read: (resource: PluginResource) => T | undefined,
  onProgress?: (loaded: number) => void,
  concurrency = 16,
): Promise<T[]> {
  const out: (T | undefined)[] = new Array(subjects.length);
  let loaded = 0;
  const getMany = store.getMany?.bind(store);

  if (getMany) {
    const batches: number[] = [];
    for (let at = 0; at < subjects.length; at += GET_MANY_MAX) batches.push(at);
    let next = 0;

    const worker = async () => {
      while (next < batches.length) {
        const at = batches[next++];
        const entries = await getMany(
          subjects.slice(at, at + GET_MANY_MAX),
        ).catch(() => []);
        entries.forEach((entry, i) => {
          out[at + i] =
            'error' in entry && entry.error !== undefined
              ? undefined
              : read(entry as PluginResource);
        });
        loaded += Math.min(GET_MANY_MAX, subjects.length - at);
        onProgress?.(loaded);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(4, batches.length) }, worker),
    );
  } else {
    let next = 0;

    const worker = async () => {
      while (next < subjects.length) {
        const index = next++;
        const resource = await store
          .getResource(subjects[index])
          .catch(() => undefined);
        out[index] = resource ? read(resource) : undefined;
        onProgress?.(++loaded);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, subjects.length) }, worker),
    );
  }

  return out.filter((row): row is T => row !== undefined);
}
