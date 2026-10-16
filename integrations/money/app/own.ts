// @wc-ignore-file
/**
 * What this app keeps of its own when it imports into a table of the shared
 * `bank-transaction-v1` class (ontola/atomic-plugins#177 §3.3: provider
 * bookkeeping is never part of a shared class; each sync part defines it in
 * its own ontology). All of it lives in the App's own subtree, the one place
 * the host lets an app write without a grant:
 *
 * - four Properties in the App's own ontology (`default-ontology`, as the
 *   host's `createApp` set it), on each transaction row beside the shared
 *   fields: `bank-source-id` and `bank-fingerprint` (the identity rules of
 *   `../identity.ts`, so a reimport is recognised and a changed booking is
 *   blocked), `bank-statement` and `bank-transaction-code`. The App declares
 *   them as its `row-extras` (`adopt.ts`), so an "Allow editing" grant on a
 *   table it is a view of covers them too (atomic-server#1849);
 * - a `bank-statement-record` class and an "Imported statements" table under
 *   the App, one row per imported statement with its reconciled balances,
 *   the same shape the importer's `destination.tables.statements` has
 *   (atomic-server#1768), plus `money-table`: the table the statement's
 *   transactions went to, since one App may import into several.
 *
 * Every step finds what exists by shortname (Properties and the class in the
 * ontology's own lists, the table by class among the App's children) and
 * creates only what is missing, so a second open writes nothing. A
 * same-named Property with another datatype is an error, not reused.
 */
import { STATEMENT_FIELDS } from '../schema.js';
import {
  atomic,
  datatypes,
  EXTRA_FIELDS,
  list,
  SHARED_SUBJECT,
  type ExtraField,
  type Fields,
  type StatementField,
} from './rows.js';
import type { PluginResource, PluginStore } from './store.js';

export interface Field {
  shortname: string;
  name: string;
  datatype: string;
  description: string;
}

const field = (
  shortname: string,
  name: string,
  datatype: string,
  description: string,
): Field => ({ shortname, name, datatype, description });

/** The four row extras, same meanings as `bankingSchema()` gives them. */
export const EXTRAS: Record<ExtraField, Field> = {
  'bank-source-id': field(
    'bank-source-id',
    'Source identity',
    datatypes.string,
    'Account-qualified import identity for repeat detection; written by the Money app.',
  ),
  'bank-fingerprint': field(
    'bank-fingerprint',
    'Import fingerprint',
    datatypes.string,
    'Original imported transaction content, used to detect conflicting reimports; written by the Money app.',
  ),
  'bank-statement': field(
    'bank-statement',
    'Statement',
    datatypes.string,
    'Source statement number and sequence.',
  ),
  'bank-transaction-code': field(
    'bank-transaction-code',
    'Transaction code',
    datatypes.string,
    'Original transaction type code: the MT940 :61: code, or the camt.053 bank transaction code.',
  ),
};

/** The statement rows' own fields; account and currency are the shared ones. */
export const STATEMENT_EXTRAS: Record<StatementField, Field> =
  Object.fromEntries(
    STATEMENT_FIELDS.map(([shortname, name, description]) => [
      shortname,
      field(
        shortname,
        name,
        shortname.endsWith('-start') || shortname.endsWith('-end')
          ? datatypes.date
          : datatypes.string,
        description,
      ),
    ]),
  ) as Record<StatementField, Field>;

/** Which table a statement row's transactions were imported into. */
export const TABLE_FIELD = field(
  'money-table',
  'Imported into',
  datatypes.atomicURL,
  'The table this statement’s transactions were imported into by the Money app.',
);

export const STATEMENT_CLASS = {
  shortname: 'bank-statement-record',
  name: 'Bank statement',
  description:
    'One imported MT940 or camt.053 statement: account, period and its reconciled opening and closing balances, as the Money app stored it.',
};

export const STATEMENTS_TABLE_NAME = 'Imported statements';

/** The app's own terms, once they exist. */
export interface OwnSchema {
  app: string;
  ontology: string;
  /** The four row extras, by shortname. */
  extras: Fields;
  /** Every field of a statement row (shared account and currency included). */
  statementFields: Fields;
  /** `money-table` on a statement row. */
  tableField: string;
  statementClass: string;
  statementsTable: string;
}

/** The App's own ontology, as `createApp` set it; none on an older host. */
export async function ownOntology(
  store: PluginStore,
  app: string,
): Promise<string | undefined> {
  const ontology = (await store.getResource(app)).get(atomic.defaultOntology);

  return typeof ontology === 'string' ? ontology : undefined;
}

async function byShortname(
  store: PluginStore,
  subjects: string[],
): Promise<Map<string, PluginResource>> {
  const found = new Map<string, PluginResource>();
  const resources = await Promise.all(
    subjects.map(s => store.getResource(s).catch(() => undefined)),
  );

  for (const resource of resources) {
    const shortname = resource?.get(atomic.shortname);
    if (typeof shortname === 'string') found.set(shortname, resource!);
  }

  return found;
}

/**
 * The app's own ontology filled in: Properties, the statement class and the
 * statements table, each made only where missing. Throws when the App has no
 * ontology of its own (a host before `createApp` set `default-ontology`).
 */
export async function ensureOwnSchema(store: PluginStore): Promise<OwnSchema> {
  const app = await store.getApp();
  const ontology = await ownOntology(store, app);
  if (!ontology)
    throw new Error('This app has no ontology of its own to add fields to.');
  const resource = await store.getResource(ontology);
  const properties = await byShortname(
    store,
    list(resource.get(atomic.properties)),
  );
  const added: string[] = [];

  const ensure = async (spec: Field): Promise<string> => {
    const existing = properties.get(spec.shortname);

    if (existing) {
      if (existing.get(atomic.datatype) !== spec.datatype)
        throw new Error(
          `The field "${spec.name}" already exists with another datatype.`,
        );

      return existing.subject;
    }

    const created = await store.newResource({
      parent: ontology,
      isA: [atomic.propertyClass],
      propVals: {
        [atomic.shortname]: spec.shortname,
        [atomic.name]: spec.name,
        [atomic.datatype]: spec.datatype,
        [atomic.description]: spec.description,
      },
    });
    added.push(created.subject);
    properties.set(spec.shortname, created);

    return created.subject;
  };

  const extras: Fields = {};
  for (const name of EXTRA_FIELDS) extras[name] = await ensure(EXTRAS[name]);
  const statementFields: Fields = {
    'bank-account': SHARED_SUBJECT['bank-account'],
    'bank-currency': SHARED_SUBJECT['bank-currency'],
    'bank-statement': extras['bank-statement'],
    'bank-source-id': extras['bank-source-id'],
  };
  for (const name of Object.keys(STATEMENT_EXTRAS) as StatementField[])
    statementFields[name] = await ensure(STATEMENT_EXTRAS[name]);
  const tableField = await ensure(TABLE_FIELD);

  if (added.length) {
    resource.set(atomic.properties, [
      ...list(resource.get(atomic.properties)),
      ...added,
    ]);
    await resource.save();
  }

  // The statement class, in the ontology's `classes`.
  const classes = await byShortname(store, list(resource.get(atomic.classes)));
  let statementClass = classes.get(STATEMENT_CLASS.shortname)?.subject;

  if (!statementClass) {
    const created = await store.newResource({
      parent: ontology,
      isA: [atomic.classClass],
      propVals: {
        [atomic.shortname]: STATEMENT_CLASS.shortname,
        [atomic.name]: STATEMENT_CLASS.name,
        [atomic.description]: STATEMENT_CLASS.description,
        [atomic.requires]: [
          statementFields['bank-account']!,
          statementFields['bank-currency']!,
          statementFields['bank-period-start']!,
          statementFields['bank-period-end']!,
          statementFields['bank-opening-balance']!,
          statementFields['bank-closing-balance']!,
          statementFields['bank-source-id']!,
        ],
        [atomic.recommends]: [
          statementFields['bank-statement']!,
          statementFields['bank-entry-count']!,
          statementFields['bank-format']!,
          statementFields['bank-imported-date']!,
          tableField,
        ],
      },
    });
    statementClass = created.subject;
    const again = await store.getResource(ontology);
    again.set(atomic.classes, [
      ...list(again.get(atomic.classes)),
      statementClass,
    ]);
    await again.save();
  }

  // The statements table: the App's child of that class.
  let statementsTable: string | undefined;

  for (const subject of await store.query({
    property: atomic.classtype,
    value: statementClass,
  })) {
    const table = await store.getResource(subject).catch(() => undefined);

    if (table?.get(atomic.parent) === app) {
      statementsTable = subject;
      break;
    }
  }

  statementsTable ??= (
    await store.newResource({
      parent: app,
      isA: [atomic.tableClass],
      propVals: {
        [atomic.name]: STATEMENTS_TABLE_NAME,
        [atomic.classtype]: statementClass,
        [atomic.description]:
          'One row per bank statement the Money app imported, with its reconciled opening and closing balance.',
      },
    })
  ).subject;

  return {
    app,
    ontology,
    extras,
    statementFields,
    tableField,
    statementClass,
    statementsTable,
  };
}
