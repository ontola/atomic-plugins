// @wc-ignore-file
/**
 * Importing a checked statement file into a table of the shared
 * `bank-transaction-v1` class, by this app's own writes (the Bank statements
 * importer's table has its own path: `store.importer.run`). The same rows
 * the sandbox importer writes (`../plugin.ts`), with the same identities and
 * fingerprints (`../identity.ts`): the shared fields at their published
 * subjects, the four extras at the app's own Properties (`own.ts`), and the
 * row's name from its description or reference. One `newResource` per row,
 * a few in flight, progress reported; then one statement row per statement
 * the app has not stored yet, under the App's statements table.
 *
 * What the preview said is new is what gets written: `compare()` already
 * compared the file with every row of the table by identity and fingerprint,
 * so a reimport writes nothing and a changed booking never reaches here. Not
 * covered: two copies of the app importing the same file at the same moment
 * can both write a row (the importer's server-side `localId` uniqueness has
 * no equivalent for app writes). Amounts, balances and dates stay the exact
 * strings the readers produced.
 */
import type { Entry } from '../identity.js';
import type { Statement } from '../parser.js';
import type { Preview } from './check.js';
import { localToday } from './format.js';
import type { OwnSchema } from './own.js';
import { atomic, BANK_TRANSACTION, type Fields } from './rows.js';
import type { ImporterRun, JSONValue, PluginStore } from './store.js';

export interface WriteTarget {
  table: string;
  /** The row fields: shared subjects plus the app's extras. */
  fields: Fields;
  own: OwnSchema;
  /** The `bank-source-id` of every statement row stored for this table. */
  stored: ReadonlySet<string>;
}

export interface WriteProgress {
  done: number;
  total: number;
}

/** The identity the importer gives a statement row (`../plugin.ts`). */
export const statementIdentity = (format: string, statement: Statement) =>
  `statement:${JSON.stringify([
    format,
    statement.account,
    statement.currency,
    statement.number,
    statement.start,
    statement.end,
  ])}`;

/** The row values for one entry, as the importer would write them. */
export function rowValues(
  entry: Entry,
  fields: Fields,
): Record<string, JSONValue> {
  const { statement, row, identity, fingerprint } = entry;
  const values: Record<string, JSONValue> = {
    [atomic.name]: row.description || row.reference,
  };

  const set = (name: keyof Fields, value: string) => {
    const property = fields[name];
    if (property && value) values[property] = value;
  };

  set('bank-account', statement.account);
  set('bank-currency', statement.currency);
  set('bank-amount', row.amount);
  set('bank-value-date', row.date);
  set('bank-booking-date', row.bookingDate);
  set('bank-description', row.description);
  set('bank-reference', row.bankReference || row.reference);
  set('bank-transaction-code', row.code);
  set('bank-statement', statement.number);
  set('bank-source-id', identity);
  set('bank-fingerprint', fingerprint);

  return values;
}

/**
 * Writes the preview's new transactions into `target.table` as shared rows,
 * then the statements the app has not stored yet. Resolves like
 * `store.importer.run` does, so the controller treats both paths alike. A
 * failing row write stops the import; rows written before it stay (the
 * identities make a retry skip them), and the error is the outcome.
 */
export async function writeImport(
  store: PluginStore,
  target: WriteTarget,
  preview: Preview,
  onProgress?: (progress: WriteProgress) => void,
  { concurrency = 4, today = localToday } = {},
): Promise<ImporterRun> {
  const { entries, statements, format } = preview;
  const fresh = statements.filter(
    s => !target.stored.has(statementIdentity(format, s)),
  );
  const total = entries.length + fresh.length;
  if (!total) return { status: 'nothing' };
  let done = 0;
  let next = 0;
  let failed: unknown;

  const worker = async () => {
    while (next < entries.length && failed === undefined) {
      const entry = entries[next++];

      try {
        await store.newResource({
          parent: target.table,
          isA: [BANK_TRANSACTION],
          propVals: rowValues(entry, target.fields),
        });
      } catch (error) {
        failed ??= error;

        return;
      }

      onProgress?.({ done: ++done, total });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, entries.length) }, worker),
  );
  if (failed !== undefined) throw failed;

  const f = target.own.statementFields;
  const date = today();

  for (const statement of fresh) {
    const identity = statementIdentity(format, statement);
    const values: Record<string, JSONValue> = {
      [atomic.name]: `${statement.account} ${statement.currency} ${statement.number}`,
      [target.own.tableField]: target.table,
    };

    const set = (name: keyof Fields, value: string) => {
      const property = f[name];
      if (property && value) values[property] = value;
    };

    set('bank-account', statement.account);
    set('bank-currency', statement.currency);
    set('bank-statement', statement.number);
    set('bank-period-start', statement.start);
    set('bank-period-end', statement.end);
    set('bank-opening-balance', statement.opening);
    set('bank-closing-balance', statement.closing);
    set('bank-entry-count', String(statement.transactions.length));
    set('bank-format', format);
    set('bank-imported-date', date);
    set('bank-source-id', identity);
    await store.newResource({
      parent: target.own.statementsTable,
      isA: [target.own.statementClass],
      propVals: values,
    });
    onProgress?.({ done: ++done, total });
  }

  return {
    status: 'applied',
    created: total,
    updated: 0,
    destroyed: 0,
    failed: 0,
  };
}
