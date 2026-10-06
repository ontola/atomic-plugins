// @wc-ignore-file
/**
 * Moneybird financial mutations (the transactions on its financial accounts)
 * as rows of the shared `bank-transaction-v1` class
 * (ontola/atomic-plugins#177; ontology-kit/source.json), so the Money app's
 * ledger, or any other view of that class, shows them.
 *
 * Shared fields, by their published subjects: `bank-account` (the financial
 * account's `identifier`, an IBAN when the bank gives one; when Moneybird
 * lists no such account, `moneybird:<financial_account_id>`, prefixed so a
 * Moneybird id is never mistaken for a bank's account id, which the class
 * asks for), `bank-currency`, `bank-amount` (Moneybird's `amount`, the exact
 * signed decimal string it sent, never parsed to a float), `bank-value-date`
 * (Moneybird's `date`), `bank-description` (`message`, verbatim),
 * `bank-reference` (`account_servicer_transaction_id`, else
 * `batch_reference`) and `name` (the contra account's name, else the
 * message, else the id). Moneybird gives one date, so `bank-booking-date` is
 * not written; `money-category` and `money-note` are the person's and never
 * written. The app's own extras: `moneybird-source-id`,
 * `moneybird-version`, `moneybird-updated-at`, `moneybird-state`
 * (unprocessed or processed in Moneybird) and `moneybird-contra-account`.
 *
 * Not imported: payments, ledger account bookings, SEPA fields,
 * `amount_open`, `original_amount` and `settlement_state`.
 */
import { classes, properties } from '../../../ontology-kit/terms.mjs';
import type { ContactField } from './contacts.js';
import {
  identifier,
  type FinancialAccount,
  type FinancialMutation,
} from './read.js';

export const BANK_TRANSACTION = classes['bank-transaction-v1'].subject;

/** The shared fields this import writes, by their published subjects. */
export const BANK = {
  account: properties['bank-account'].subject,
  currency: properties['bank-currency'].subject,
  amount: properties['bank-amount'].subject,
  valueDate: properties['bank-value-date'].subject,
  description: properties['bank-description'].subject,
  reference: properties['bank-reference'].subject,
} as const;

const string = (
  key: string,
  shortname: string,
  name: string,
  description: string,
): ContactField => ({
  key,
  shortname,
  name,
  description,
  datatype: 'https://atomicdata.dev/datatypes/string',
});

export const STATE = string(
  'state',
  'moneybird-state',
  'Moneybird state',
  'Whether the mutation is unprocessed or processed (booked) in Moneybird.',
);
export const CONTRA_ACCOUNT = string(
  'contra_account_number',
  'moneybird-contra-account',
  'Contra account',
  'The other party’s account number, as Moneybird sent it.',
);

/** An exact signed decimal with at most 5 fraction digits (`bank-amount`'s rule). */
export const AMOUNT = /^-?\d+(\.\d{1,5})?$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface MutationRow {
  /** `moneybird:<administration>:financial_mutation:<id>` */
  identity: string;
  name: string;
  account: string;
  currency: string;
  /** Exact signed decimal string, as sent. */
  amount: string;
  /** YYYY-MM-DD */
  valueDate: string;
  description?: string;
  reference?: string;
  state?: string;
  contraAccount?: string;
  version?: number;
  updatedAt?: string;
}

export const mutationSourceId = (administrationId: string, id: string) =>
  `moneybird:${administrationId}:financial_mutation:${id}`;

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The mutation as the person knows it: the contra account's name, else the message, else "Mutation <id>". */
export function mutationLabel(mutation: FinancialMutation): string {
  const message = typeof mutation.message === 'string' ? mutation.message : '';

  return (
    text(mutation.contra_account_name) ??
    (message.trim() || `Mutation ${mutation.id}`)
  );
}

/**
 * Why `mutationOf` leaves a mutation out, completing "<n> mutations …" on
 * the sync-status card; `undefined` for one it imports. The first failing
 * requirement, in the order `mutationOf` checks them.
 */
export function mutationSkipReason(
  mutation: FinancialMutation,
): string | undefined {
  const amount = typeof mutation.amount === 'string' ? mutation.amount : '';
  if (!AMOUNT.test(amount))
    return 'with an amount Moneybird did not send as a decimal string: not imported, never approximated.';
  const date = typeof mutation.date === 'string' ? mutation.date : '';
  if (!DATE.test(date))
    return 'with a date that is not YYYY-MM-DD: not imported.';
  if (!text(mutation.currency)) return 'without a currency: not imported.';
  if (!identifier(mutation.financial_account_id))
    return 'without a financial account: not imported.';

  return undefined;
}

/**
 * The row for one financial mutation, or `undefined` when a required shared
 * field cannot be filled exactly (`mutationSkipReason`): an `amount` that is
 * not a decimal string (a JSON number would already have been parsed to a
 * float), a `date` that is not `YYYY-MM-DD`, no currency, or no financial
 * account. Such a mutation is counted as skipped, never approximated.
 */
export function mutationOf(
  mutation: FinancialMutation,
  administrationId: string,
  accounts: ReadonlyMap<string, FinancialAccount>,
): MutationRow | undefined {
  if (mutationSkipReason(mutation) !== undefined) return undefined;
  const amount = mutation.amount as string;
  const date = mutation.date as string;
  const currency = text(mutation.currency)!;
  const accountId = identifier(mutation.financial_account_id)!;
  const message = typeof mutation.message === 'string' ? mutation.message : '';
  const row: MutationRow = {
    identity: mutationSourceId(administrationId, mutation.id),
    name: mutationLabel(mutation),
    account: accounts.get(accountId)?.identifier ?? `moneybird:${accountId}`,
    currency,
    amount,
    valueDate: date,
  };
  if (message) row.description = message;
  const reference =
    text(mutation.account_servicer_transaction_id) ??
    text(mutation.batch_reference);
  if (reference) row.reference = reference;
  const state = text(mutation.state);
  if (state) row.state = state;
  const contra = text(mutation.contra_account_number);
  if (contra) row.contraAccount = contra;
  if (
    typeof mutation.version === 'number' &&
    Number.isSafeInteger(mutation.version)
  )
    row.version = mutation.version;
  if (typeof mutation.updated_at === 'string' && mutation.updated_at)
    row.updatedAt = mutation.updated_at;

  return row;
}
