// @wc-ignore-file
// Type-only against the lib: plugin.ts bundles this file into the sandbox
// plugin.js, so it must not pull the lib's runtime in. Datatypes are
// therefore the literal URLs of `Datatype.DATE` and `Datatype.STRING`. The
// shared ontology's subject constants (`ontology-kit/terms.mjs`, plain data)
// are bundled in.
import type { Datatype, SchemaSpec } from '../../browser/lib/src/index.js';
import { classes, properties } from '../../ontology-kit/terms.mjs';

const DATE = 'https://atomicdata.dev/datatypes/date' as Datatype;
const STRING = 'https://atomicdata.dev/datatypes/string' as Datatype;

/**
 * Written by the importer on a Bank statement row, one per parsed statement:
 * what the Money app shows in its Imports tab and as closing balances.
 */
export const STATEMENT_FIELDS = [
  [
    'bank-period-start',
    'Period start',
    'Date of the statement opening balance.',
  ],
  ['bank-period-end', 'Period end', 'Date of the statement closing balance.'],
  [
    'bank-opening-balance',
    'Opening balance',
    'Exact signed decimal string: the booked balance the statement starts from.',
  ],
  [
    'bank-closing-balance',
    'Closing balance',
    'Exact signed decimal string: the booked balance the statement ends on, reconciled with its entries.',
  ],
  [
    'bank-entry-count',
    'Entries',
    'Number of booked entries in the statement, as a decimal string.',
  ],
  ['bank-format', 'Format', 'mt940 or camt053: the export format read.'],
  [
    'bank-imported-date',
    'Imported on',
    'The date this statement was first imported.',
  ],
] as const;

/**
 * The fields of the shared class `bank-transaction-v1` (ontola/atomic-plugins
 * #177, `ontology-kit/source.json`), by the shortname this schema uses for
 * them. Set up binds these to the published subjects through
 * `PropertySpec.subject`, so the host reuses them instead of minting its own.
 */
export const SHARED_FIELDS = [
  'bank-account',
  'bank-currency',
  'bank-amount',
  'bank-value-date',
  'bank-booking-date',
  'bank-description',
  'bank-reference',
  'money-category',
  'money-note',
] as const;

export type SharedField = (typeof SHARED_FIELDS)[number];

const SHARED = new Set<string>(SHARED_FIELDS);

/**
 * The banking ontology, declared as the manifest's `destination.schema`: the
 * host binds the Bank transaction class and its fields to the shared ontology
 * (`subject`), and creates the rest in the drive when the importer is set up:
 * the import bookkeeping on each row (`bank-source-id`, `bank-fingerprint`,
 * `bank-statement`, `bank-transaction-code`) and the Bank statement class
 * with its fields. Shared terms are reused as published, never copied or
 * edited; `ensureSchema` only checks that each is a Property of the declared
 * datatype (or a Class).
 */
export function bankingSchema(): SchemaSpec {
  const fields = [
    [
      'bank-account',
      'Account',
      'Statement account identifier (MT940 field 25 or camt.053 Acct/Id); not necessarily an IBAN.',
    ],
    [
      'bank-currency',
      'Currency',
      'ISO 4217 currency code from the statement balance.',
    ],
    [
      'bank-amount',
      'Amount',
      'Exact signed decimal string in account currency. Negative is money out; positive is money in.',
    ],
    [
      'bank-value-date',
      'Value date',
      'Bank value date, without an inferred time zone.',
    ],
    [
      'bank-booking-date',
      'Booking date',
      'Booking date; value date when the statement omits it.',
    ],
    [
      'bank-description',
      'Description',
      'Original bank narrative: MT940 field 86 including its structured codes, or camt.053 counterparty and remittance information.',
    ],
    [
      'bank-reference',
      'Reference',
      'Bank reference, or customer reference if absent.',
    ],
    [
      'bank-transaction-code',
      'Transaction code',
      'Original transaction type code: the MT940 :61: code, or the camt.053 bank transaction code (domain/family/sub-family, or proprietary).',
    ],
    ['bank-statement', 'Statement', 'Source statement number and sequence.'],
    [
      'bank-source-id',
      'Source identity',
      'Account-qualified importer identity for repeat detection.',
    ],
    [
      'bank-fingerprint',
      'Import fingerprint',
      'Original imported transaction content used to detect conflicting reimports.',
    ],
  ];
  // The person's own annotations, edited in the Money app. The importer never
  // writes them, so a reimport leaves them alone.
  const notes = [
    [
      'money-category',
      'Category',
      'Your own category for this transaction, as free text. Never written by the importer.',
    ],
    [
      'money-note',
      'Note',
      'Your own note on this transaction. Never written by the importer.',
    ],
  ];

  const dated = new Set(['bank-period-start', 'bank-period-end']);

  return {
    properties: [...fields, ...notes, ...STATEMENT_FIELDS].map(
      ([shortname, name, description]) => ({
        ...(SHARED.has(shortname)
          ? { subject: properties[shortname as SharedField].subject }
          : {}),
        shortname,
        name,
        description,
        datatype:
          shortname.endsWith('-date') || dated.has(shortname) ? DATE : STRING,
      }),
    ),
    classes: [
      {
        // The shared class. Its `requires`/`recommends` here mirror the
        // published ones (without Atomic's own `name`) and are never
        // written: the host uses a shared class as it is.
        subject: classes['bank-transaction-v1'].subject,
        shortname: 'bank-transaction',
        name: 'Bank transaction',
        description:
          'A booked bank statement entry imported from an MT940 or camt.053 statement.',
        requires: [
          'bank-account',
          'bank-currency',
          'bank-amount',
          'bank-value-date',
        ],
        recommends: [
          'bank-booking-date',
          'bank-description',
          'bank-reference',
          'money-category',
          'money-note',
        ],
      },
      {
        shortname: 'bank-statement-record',
        name: 'Bank statement',
        description:
          'One imported MT940 or camt.053 statement: account, period and its reconciled opening and closing balances.',
        requires: [
          'bank-account',
          'bank-currency',
          'bank-period-start',
          'bank-period-end',
          'bank-opening-balance',
          'bank-closing-balance',
          'bank-source-id',
        ],
        recommends: [
          'bank-account',
          'bank-currency',
          'bank-statement',
          'bank-period-start',
          'bank-period-end',
          'bank-opening-balance',
          'bank-closing-balance',
          'bank-entry-count',
          'bank-format',
          'bank-imported-date',
        ],
      },
    ],
  };
}
