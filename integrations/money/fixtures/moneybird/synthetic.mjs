/**
 * SYNTHETIC Moneybird data. NOT RECORDED.
 *
 * Nobody working on this repository had a Moneybird account when this was
 * written (atomic-plugins#102), so these bodies are hand-written. Their shape
 * follows the public, read-only Moneybird OpenAPI document the proxy catalog
 * pins (localthought/openapi-directory@85a61052,
 * APIs/moneybird.com/v2-readonly/openapi.yaml: `administration_response` and
 * `contact`, including that document's own examples) and the overlays in
 * overlays/APIs/moneybird.com/v2-readonly/ (page/per_page pagination on contacts.json;
 * `include_archived` in all-records-selection.json). Every name, address,
 * e-mail address, IBAN and identifier is invented; none belongs to a real
 * administration.
 *
 * What this cannot tell you: whether real responses carry fields, nulls or
 * pagination headers this file does not. Moneybird documents a `Link`
 * header with rel="next" for paginated collections
 * (https://developer.moneybird.com/, "Pagination"); scenario.mjs sends one,
 * and the reader also stops on a short page, so both are exercised. A
 * recording against a real test administration replaces this file; see the
 * "Recording" note in scenario.mjs.
 */

export const SYNTHETIC = true;

const ADMIN_A = '100000000000000001';
const ADMIN_B = '100000000000000002';

export const administrations = [
  {
    id: ADMIN_A,
    name: 'Synthetic Studio B.V.',
    language: 'nl',
    currency: 'EUR',
    country: 'NL',
    time_zone: 'Europe/Amsterdam',
    access: 'user',
    suspended: false,
    period_locked_until: null,
    period_start_date: '2025-01-01',
  },
  {
    id: ADMIN_B,
    name: 'Synthetic Side Project',
    language: 'en',
    currency: 'EUR',
    country: 'NL',
    time_zone: 'Europe/Amsterdam',
    access: 'accountant_company',
    suspended: false,
    period_locked_until: '2025-12-31',
    period_start_date: '2024-01-01',
  },
];

/** The fields of `contact` in the pinned OpenAPI document, with synthetic values. */
function contact(administration, n, over) {
  const id = `2000000000000000${String(n).padStart(2, '0')}`;
  const stamp = `2026-0${1 + (n % 8)}-1${n % 10}T09:0${n % 10}:00.000Z`;

  return {
    id,
    administration_id: administration,
    company_name: '',
    firstname: null,
    lastname: null,
    address1: `Voorbeeldstraat ${n}`,
    address2: '',
    zipcode: `10${String(n).padStart(2, '0')} AB`,
    city: 'Amsterdam',
    country: 'NL',
    phone: '',
    delivery_method: 'Email',
    customer_id: String(n),
    tax_number: '',
    chamber_of_commerce: '',
    bank_account: '',
    is_trusted: false,
    max_transfer_amount: null,
    attention: '',
    email: `contact${n}@example.invalid`,
    email_ubl: true,
    send_invoices_to_attention: '',
    send_invoices_to_email: `contact${n}@example.invalid`,
    send_estimates_to_attention: '',
    send_estimates_to_email: `contact${n}@example.invalid`,
    direct_debit: false,
    sepa_active: false,
    sepa_iban: '',
    sepa_iban_account_name: '',
    sepa_bic: '',
    sepa_mandate_id: '',
    sepa_mandate_date: null,
    sepa_sequence_type: 'RCUR',
    credit_card_number: '',
    credit_card_reference: '',
    credit_card_type: null,
    tax_number_validated_at: null,
    tax_number_valid: null,
    invoice_workflow_id: null,
    estimate_workflow_id: null,
    si_identifier: '',
    si_identifier_type: null,
    moneybird_payments_mandate: false,
    created_at: stamp,
    updated_at: stamp,
    version: 1788950000 + n,
    sales_invoices_url: `https://moneybird.com/${administration}/sales_invoices/synthetic${n}/all`,
    notes: [],
    custom_fields: [],
    contact_people: [],
    archived: false,
    events: [],
    ...over,
  };
}

export const contacts = {
  [ADMIN_A]: [
    contact(ADMIN_A, 1, { company_name: 'Fictief Bakkerij B.V.' }),
    contact(ADMIN_A, 2, { firstname: 'Anna', lastname: 'Voorbeeld' }),
    contact(ADMIN_A, 3, {
      company_name: 'Testcafé & Co',
      city: 'Utrecht',
      sepa_iban: 'NL00TEST0000000003',
    }),
    contact(ADMIN_A, 4, {
      firstname: 'Bram',
      lastname: 'Proef',
      archived: true,
    }),
    contact(ADMIN_A, 5, {
      company_name: 'Nep Consultancy',
      country: 'BE',
      city: 'Gent',
    }),
  ],
  [ADMIN_B]: [
    contact(ADMIN_B, 11, { company_name: 'Side Project Client Ltd' }),
  ],
};

/** The civil year the dated records fall in: the one the app imports. */
export const YEAR = new Date().getUTCFullYear();
const pad = n => String(n).padStart(2, '0');

/** `YYYY-MM-DD` in YEAR. */
export const dated = (month, dayOfMonth) =>
  `${YEAR}-${pad(month)}-${pad(dayOfMonth)}`;

/** An RFC 3339 instant in YEAR, UTC. */
const at = (month, dayOfMonth, hour, minute = 0) =>
  `${dated(month, dayOfMonth)}T${pad(hour)}:${pad(minute)}:00.000Z`;

/** `user_response` (base_user_response): id, name and the two timestamps. */
const user = (n, name) => ({
  id: `3000000000000000${pad(n)}`,
  name,
  created_at: '2025-01-06T08:00:00.000Z',
  updated_at: '2025-01-06T08:00:00.000Z',
});

export const users = {
  [ADMIN_A]: [user(1, 'Anna Voorbeeld'), user(2, 'Bram Proef')],
};

/** `project_response`: id, name, state, budget. */
const project = (n, name, over) => ({
  id: `4000000000000000${pad(n)}`,
  name,
  state: 'active',
  budget: null,
  ...over,
});

export const projects = {
  [ADMIN_A]: [
    project(1, 'Website relaunch'),
    project(2, 'Bookkeeping', { state: 'archived', budget: 4000 }),
  ],
};

/** The fields of `time_entry_response`, with synthetic values. */
function timeEntry(administration, n, over) {
  const id = `6000000000000000${pad(n)}`;
  const { user: who, project: which, started_at, ended_at, ...rest } = over;

  return {
    id,
    administration_id: administration,
    contact_id: null,
    project_id: which ? which.id : null,
    sales_invoice_id: null,
    user_id: who.id,
    started_at,
    ended_at,
    description: '',
    paused_duration: 0,
    billable: true,
    created_at: ended_at ?? started_at,
    updated_at: ended_at ?? started_at,
    contact: null,
    user: who,
    project: which ?? null,
    sales_invoice: null,
    events: [],
    notes: [],
    ...rest,
  };
}

const [anna, bram] = users[ADMIN_A];
const [relaunch, bookkeeping] = projects[ADMIN_A];

/** Four entries in YEAR; one paused, one not billable, one without a project. */
export const timeEntries = {
  [ADMIN_A]: [
    timeEntry(ADMIN_A, 1, {
      user: anna,
      project: relaunch,
      started_at: at(3, 2, 9),
      ended_at: at(3, 2, 11, 30),
      description: 'Design review',
    }),
    timeEntry(ADMIN_A, 2, {
      user: anna,
      project: relaunch,
      started_at: at(3, 3, 13),
      ended_at: at(3, 3, 17),
      description: 'Build the header',
      paused_duration: 1800,
    }),
    timeEntry(ADMIN_A, 3, {
      user: bram,
      project: bookkeeping,
      started_at: at(3, 4, 8),
      ended_at: at(3, 4, 9),
      description: 'Quarterly VAT',
      billable: false,
    }),
    timeEntry(ADMIN_A, 4, {
      user: bram,
      project: null,
      started_at: at(3, 5, 10),
      ended_at: at(3, 5, 10, 45),
      description: '',
    }),
  ],
  [ADMIN_B]: [],
};

/** `financial_account_response`: one synthetic bank account with an invented IBAN. */
export const financialAccounts = {
  [ADMIN_A]: [
    {
      id: '500000000000000001',
      administration_id: ADMIN_A,
      type: 'bank_account',
      name: 'Zakelijke rekening',
      identifier: 'NL00TEST0000000099',
      currency: 'EUR',
      provider: null,
      moneybird_account: false,
      active: true,
      created_at: '2025-01-06T08:00:00.000Z',
      updated_at: '2025-01-06T08:00:00.000Z',
    },
  ],
  [ADMIN_B]: [],
};

/** The fields of `financial_mutation_response`, with synthetic values. */
function mutation(administration, n, over) {
  const id = `7000000000000000${pad(n)}`;
  const stamp = `${over.date}T06:00:00.000Z`;

  return {
    id,
    administration_id: administration,
    amount: '0.0',
    code: null,
    message: '',
    contra_account_name: null,
    contra_account_number: '',
    state: 'unprocessed',
    settlement_state: 'settled',
    amount_open: over.amount ?? '0.0',
    sepa_fields: null,
    batch_reference: null,
    financial_account_id: financialAccounts[ADMIN_A][0].id,
    currency: 'EUR',
    original_amount: null,
    created_at: stamp,
    updated_at: stamp,
    version: 1788960000 + n,
    financial_statement_id: `800000000000000${pad(n)}`,
    processed_at: null,
    account_servicer_transaction_id: null,
    payments: [],
    ledger_account_bookings: [],
    ...over,
  };
}

/**
 * Six mutations in YEAR: amounts are exact decimal strings as the document
 * types them (never numbers); two share one day; one is processed.
 */
export const financialMutations = {
  [ADMIN_A]: [
    mutation(ADMIN_A, 1, {
      amount: '1210.0',
      date: dated(1, 5),
      message: 'Factuur 2026-001',
      contra_account_name: 'Fictief Bakkerij B.V.',
      contra_account_number: 'NL00TEST0000000001',
      account_servicer_transaction_id: 'SYN-0001',
    }),
    mutation(ADMIN_A, 2, {
      amount: '-120.5',
      date: dated(1, 20),
      message: 'Hosting januari',
      contra_account_name: 'Nep Hosting',
      contra_account_number: 'NL00TEST0000000055',
      state: 'processed',
      processed_at: `${dated(1, 21)}T09:00:00.000Z`,
      amount_open: '0.0',
    }),
    mutation(ADMIN_A, 3, {
      amount: '-45.99',
      date: dated(2, 14),
      message: 'Kantoorartikelen',
      contra_account_name: 'Testcafé & Co',
      contra_account_number: 'NL00TEST0000000003',
    }),
    mutation(ADMIN_A, 4, {
      amount: '-45.99',
      date: dated(2, 14),
      message: 'Kantoorartikelen (dubbel)',
      contra_account_name: 'Testcafé & Co',
      contra_account_number: 'NL00TEST0000000003',
      batch_reference: 'BATCH-SYN-2',
    }),
    mutation(ADMIN_A, 5, {
      amount: '2500.0',
      date: dated(3, 1),
      message: '',
      contra_account_name: 'Side Project Client Ltd',
      contra_account_number: 'GB00TEST00000000000011',
    }),
    mutation(ADMIN_A, 6, {
      amount: '-0.35',
      date: dated(3, 9),
      message: 'Bankkosten',
      contra_account_name: null,
      contra_account_number: '',
    }),
  ],
  [ADMIN_B]: [],
};
