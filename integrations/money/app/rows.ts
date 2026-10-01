// @wc-ignore-file
/**
 * Reading the Bank transactions table. Since 0.4.0 its rows are of the
 * shared class `bank-transaction-v1` (ontola/atomic-plugins#177), and the
 * app reads that class's fields by their published subjects only, through
 * `ontology-kit`'s strict resolver: no lookup by shortname, name or column.
 * A table of any other class is not a bank transactions table.
 *
 * The importer's own bookkeeping on each row (`bank-source-id`,
 * `bank-fingerprint`, `bank-statement`, `bank-transaction-code`) and the
 * statement rows' fields are not shared: Set up mints them in the drive's
 * ontology (`../schema.ts`). They are found through the statements table's
 * class, which lists most of them, and by shortname for the rest.
 */
import { createResolver } from '../../../ontology-kit/resolver.mjs';
import { classes, properties } from '../../../ontology-kit/terms.mjs';
import {
  GET_MANY_MAX,
  type JSONValue,
  type PluginResource,
  type PluginStore,
} from './store.js';

/** The shared class this app renders. */
export const BANK_TRANSACTION = classes['bank-transaction-v1'].subject;

/** Every class this app renders, for its App's `renders`. */
export const resolver = createResolver({
  classes: [classes['bank-transaction-v1']],
});

export const atomic = {
  parent: 'https://atomicdata.dev/properties/parent',
  isA: 'https://atomicdata.dev/properties/isA',
  shortname: 'https://atomicdata.dev/properties/shortname',
  name: 'https://atomicdata.dev/properties/name',
  requires: 'https://atomicdata.dev/properties/requires',
  recommends: 'https://atomicdata.dev/properties/recommends',
  classtype: 'https://atomicdata.dev/properties/classtype',
  propertyClass: 'https://atomicdata.dev/classes/Property',
} as const;

/** Imported by `../plugin.ts`; never written by this app. */
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

/** On a Bank statement row (the importer's `statements` table). */
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

/** One imported statement, as the importer stored it (atomic-server#1768). */
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
}

export function readStatement(
  resource: Pick<PluginResource, 'subject' | 'get'>,
  fields: Fields,
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
  };
}

const list = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

/** The shared class's fields, by the shortnames the app uses for them. */
const SHARED = [
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

const SHARED_SUBJECTS = new Map<string, Shortname>(
  SHARED.map(name => [properties[name].subject, name]),
);

/**
 * The fields of a class that is not shared (the importer's Bank statement
 * class): its `requires` and `recommends`, by shortname. A shared property is
 * recognised by its subject, without reading it.
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

  for (const subject of subjects) {
    const shared = SHARED_SUBJECTS.get(subject);
    if (shared) fields[shared] ??= subject;
  }

  const resources = await Promise.all(
    subjects
      .filter(s => !SHARED_SUBJECTS.has(s))
      .map(s => store.getResource(s).catch(() => undefined)),
  );

  for (const property of resources) {
    const shortname = property?.get(atomic.shortname);
    if (typeof shortname === 'string' && KNOWN.has(shortname))
      fields[shortname as Shortname] ??= property!.subject;
  }

  return fields;
}

/** Written by the importer on each row; not part of the shared class. */
const IMPORTER_FIELDS: BankField[] = [
  'bank-source-id',
  'bank-fingerprint',
  'bank-statement',
  'bank-transaction-code',
];

/**
 * The fields of a Bank transactions table, or `undefined` when `rowClass`
 * is not one this app renders. The shared fields are the published subjects.
 * The importer's bookkeeping comes from its statement class's fields where
 * they are listed there (`bank-source-id`, `bank-statement`), and otherwise
 * by shortname, preferring the ontology the statement class is in. On a
 * table the importer did not make, rows usually carry no bookkeeping at all.
 */
export async function resolveFields(
  store: PluginStore,
  rowClass: string,
  statement?: { rowClass: string; fields: Fields },
): Promise<Fields | undefined> {
  if (!resolver.accepts(rowClass)) return undefined;
  const fields: Fields = Object.fromEntries(
    SHARED.map(name => [name, properties[name].subject]),
  );

  for (const name of IMPORTER_FIELDS)
    if (statement?.fields[name]) fields[name] = statement.fields[name];

  const ontology = statement
    ? await store
        .getResource(statement.rowClass)
        .then(r => r.get(atomic.parent))
        .catch(() => undefined)
    : undefined;

  for (const shortname of IMPORTER_FIELDS) {
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

/** The fields without which a row is not a bank transaction at all. */
export const REQUIRED: BankField[] = [
  'bank-account',
  'bank-currency',
  'bank-amount',
  'bank-value-date',
];

export const isBankTable = (fields: Fields) =>
  REQUIRED.every(name => fields[name]);

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
