/**
 * Records the moneybird mock-proxy fixture from a live Moneybird test
 * administration (atomic-plugins#102). Never hand-edit what it writes;
 * re-run it instead (PARALLEL_LANES.md §4: "realistic" is enforced by
 * recording, not asserted). Not run yet: nobody here has an account.
 *
 * Writes, next to this file, exactly what the Money app reads
 * (moneybird/read.ts), GET only, redacted per REDACTIONS below:
 *   api/GET__administrations.json
 *   api/GET__<administration>__contacts__page-<n>.json
 *                        ?per_page=<k>&page=<n>&include_archived=true
 *   api/GET__<administration>__time_entries__page-<n>.json
 *                        ?per_page=<k>&page=<n>&filter=period:this_year,state:all
 *   api/GET__<administration>__financial_accounts.json
 *   api/GET__<administration>__financial_mutations.json
 *                        ?filter=period:this_year
 *                   each { status, headers, body }; `headers.Link` keeps a
 *                   rel="next" link when Moneybird sent one, with the
 *                   administration id replaced by its fake.
 *   api/meta.json   when and how the recording was made (the civil year in
 *                   Europe/Amsterdam the dated rows fall in, the page size,
 *                   the fake administration ids) and every field the
 *                   redactor did not recognise (redacted to "redacted").
 * <administration> is the fake id (`1000…n`), never the real one.
 *
 * Command, from the repo root, in the AGENTS.md atomic-server layout (so
 * the output is formatted with oxfmt):
 *
 *   MONEYBIRD_TOKEN=<API token> \
 *     node integrations/money/fixtures/moneybird/record.mjs
 *
 * MONEYBIRD_TOKEN is a Moneybird API token for a TEST administration
 * (Moneybird's "Create API token" under the administration's settings, or a
 * sandbox administration). It is sent only to https://moneybird.com as a
 * Bearer header and is never written to disk. Only GET requests are made,
 * only on the five operations the proxy's read-only catalog exposes.
 *
 * Options (all optional):
 *   --administration <id>  record this administration (repeatable; default
 *                          every administration the token lists)
 *   --per-page <n>         page size sent as `per_page` (default 2, so a
 *                          handful of records spans pages; the app sends 100)
 *   --max-pages <n>        stop after this many pages per collection
 *                          (default 3)
 *
 * Use an administration with at least per_page+1 contacts, so the recording
 * has a second page (a Link rel="next") to exercise pagination; the script
 * warns if not. For the app's coverage, include an archived contact, a
 * company and a person, a few time entries this year (one paused, one not
 * billable, one without a project) and a few financial mutations this year,
 * two on one day. The dated rows are this year's: the app imports
 * `period:this_year` by its own clock, so a recording stops matching the
 * app's requests after New Year and must be re-recorded (meta.json's `year`
 * says which year it is; scenario.mjs's YEAR follows it).
 *
 * The fixture (scenario.mjs) is already registered in
 * integrations/localthought/fixtures/index.mjs. Until api/ exists it serves
 * the SYNTHETIC rows of synthetic.mjs; once this script has written api/, it
 * replays the recording instead. After recording, run
 * integrations/money/moneybird-fixture.test.ts (its header has the
 * command); moneybird/moneybird.test.ts and e2e/moneybird.spec.ts import
 * synthetic.mjs's names and counts directly and need their expectations
 * updated to the recorded rows.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = 'https://moneybird.com/api/v2';
const TIME_ENTRIES_FILTER = 'period:this_year,state:all';
const MUTATIONS_FILTER = 'period:this_year';

/**
 * The redaction list. Every string in a recorded body is either kept
 * verbatim because its path is in KEEP, mapped to a stable fake, or
 * replaced. Numbers, booleans and null are kept (version, budget,
 * paused_duration, the *_active and archived flags). A string field listed
 * nowhere is replaced with "redacted" and reported in api/meta.json, so an
 * API change fails closed. Nested arrays the app never reads are emptied.
 */
export const REDACTIONS = [
  {
    field: 'id, *_id (any string or number)',
    replace:
      'an 18-digit fake, stable per real value and kind: 1000…n ' +
      'administration, 2000…n contact, 3000…n user, 4000…n project, 5000…n ' +
      'financial account, 6000…n time entry, 7000…n mutation, 8000…n ' +
      'financial statement, 9000…n sales invoice, 1100…n anything else',
    reason:
      'Account-identifying. Mapped consistently across all files, so ' +
      'time_entry.user_id still points at the recorded user and ' +
      'financial_mutation.financial_account_id at the recorded account. ' +
      'Numeric, because the fixture routes on \\d+ administration ids and ' +
      'read.ts accepts identifiers of digits only.',
  },
  {
    field: 'any other number (a numeric tax number, account number, reference)',
    replace:
      '"redacted" (reported in api/meta.json); only version, budget, ' +
      'paused_duration, max_transfer_amount and child_order are kept',
    reason: 'Fail closed on numbers as on strings: a number can identify too.',
  },
  {
    field: 'administration.name',
    replace: 'Redacted administration <n>',
    reason:
      'Names the business. Every name-like fake below is stable per real ' +
      'value, so a project or user nested in several time entries keeps one ' +
      'name and a contact reads the same nested and top-level.',
  },
  {
    field: 'contact.company_name, firstname, lastname',
    replace:
      '"" when empty, else Redacted company <n> / Firstname <n> / Lastname <n>',
    reason:
      'Personal data. Kept empty when empty: contactName() falls back on it.',
  },
  {
    field: 'contact.email, send_invoices_to_email, send_estimates_to_email',
    replace: '"" when empty, else contact<n>@example.invalid',
    reason: 'Personal data.',
  },
  {
    field:
      'contact.address1, address2, zipcode, city, phone, attention, send_*_to_attention',
    replace:
      '"" when empty, else Redacted street / "" / 1000 AA / Redacted city <n> / "" / ""',
    reason:
      'Personal data. city is a column the app imports, so it keeps a value.',
  },
  {
    field: 'contact.customer_id',
    replace: '<n> (a stable fake per value)',
    reason: 'Shown in Moneybird; a column the app imports.',
  },
  {
    field:
      'IBAN-like and account strings: contact.sepa_iban, bank_account, ' +
      'financial_account.identifier, financial_mutation.contra_account_number',
    replace: '"" when empty, else NL00TEST + 10 digits, stable per value',
    reason:
      'Bank account numbers. The app writes identifier as the bank-account id ' +
      'of bank-transaction-v1 rows, so it keeps an IBAN shape.',
  },
  {
    field:
      'contact.tax_number, chamber_of_commerce, sepa_iban_account_name, sepa_bic, ' +
      'sepa_mandate_id, credit_card_number, credit_card_reference, si_identifier, ' +
      'sales_invoices_url',
    replace:
      '"" when empty, else "redacted" (sales_invoices_url: a URL with the fake ids)',
    reason: 'Identifying; the app reads none of them.',
  },
  {
    field: 'user.name, project.name, financial_account.name',
    replace: 'Redacted user <n> / Redacted project <n> / Redacted account <n>',
    reason: 'Personal and business names; the app names its rows by them.',
  },
  {
    field:
      'time_entry.description, financial_mutation.message, contra_account_name',
    replace:
      '"" or null when so, else Redacted description <n> / Redacted message <n> / Redacted counterparty <n>',
    reason:
      'User-written text. Kept non-empty when non-empty: the app names rows by it.',
  },
  {
    field:
      'financial_mutation.code, batch_reference, account_servicer_transaction_id',
    replace: 'null or "" when so, else "redacted" / BATCH-<n> / TX-<n>',
    reason: 'Bank references.',
  },
  {
    field:
      'notes[], custom_fields[], contact_people[], events[], payments[], ' +
      'ledger_account_bookings[]',
    replace: '[]',
    reason:
      'User-written content and bookings the app never reads; their shape ' +
      'is not recorded.',
  },
  {
    field: 'next-page Link header',
    replace: 'the same URL with the administration id replaced by its fake',
    reason:
      'Embeds the real administration id; the app follows it, so it stays a URL.',
  },
  {
    field: 'any other string field',
    replace: 'redacted (reported in api/meta.json)',
    reason: 'Fail closed on fields this list does not know about.',
  },
];

/** String fields kept verbatim: timestamps, dates, amounts, enum-like values. */
const KEEP = new Set([
  'created_at',
  'updated_at',
  'started_at',
  'ended_at',
  'processed_at',
  'date',
  'sepa_mandate_date',
  'tax_number_validated_at',
  'period_locked_until',
  'period_start_date',
  'amount',
  'amount_open',
  'original_amount',
  'language',
  'currency',
  'country',
  'time_zone',
  'access',
  'state',
  'settlement_state',
  'delivery_method',
  'sepa_sequence_type',
  'type',
  'provider',
  'si_identifier_type',
  'credit_card_type',
]);

/**
 * Numbers kept verbatim: record versions and quantities the app reads. Any
 * other number (a numeric tax number, account number or reference) is
 * redacted and reported like an unknown string.
 */
const KEEP_NUMBERS = new Set([
  'version',
  'budget',
  'paused_duration',
  'max_transfer_amount',
  'child_order',
]);

/** Arrays replaced with [] (user-written content the app never reads). */
const EMPTIED = new Set([
  'notes',
  'custom_fields',
  'contact_people',
  'events',
  'payments',
  'ledger_account_bookings',
]);

const IBAN_LIKE = new Set([
  'sepa_iban',
  'bank_account',
  'identifier',
  'contra_account_number',
]);
const IDENTIFYING = new Set([
  'tax_number',
  'chamber_of_commerce',
  'sepa_iban_account_name',
  'sepa_bic',
  'sepa_mandate_id',
  'credit_card_number',
  'credit_card_reference',
  'si_identifier',
  'code',
]);
const ID_PREFIX = {
  administration: '1000',
  contact: '2000',
  user: '3000',
  project: '4000',
  financial_account: '5000',
  time_entry: '6000',
  financial_mutation: '7000',
  financial_statement: '8000',
  sales_invoice: '9000',
  other: '1100',
};
const ID_FIELD_KIND = {
  administration_id: 'administration',
  contact_id: 'contact',
  user_id: 'user',
  project_id: 'project',
  financial_account_id: 'financial_account',
  financial_statement_id: 'financial_statement',
  sales_invoice_id: 'sales_invoice',
};
/** The resource a nested object is, by the field it sits under. */
const NESTED = { user: 'user', project: 'project', contact: 'contact' };

export function redactor() {
  const ids = new Map();
  const counters = {};
  const unknown = new Set();
  const next = kind => (counters[kind] = (counters[kind] ?? 0) + 1);

  /** The same fake for the same real value and kind, every time. */
  const stable = (kind, raw, make) => {
    const key = `${kind}:${raw}`;
    if (!ids.has(key)) ids.set(key, make(next(`id:${kind}`)));

    return ids.get(key);
  };

  const fakeId = (kind, raw) =>
    stable(
      kind,
      raw,
      n =>
        `${ID_PREFIX[kind] ?? ID_PREFIX.other}${String(n).padStart(14, '0')}`,
    );
  const fakeIban = raw =>
    stable('iban', raw, n => `NL00TEST${String(n).padStart(10, '0')}`);

  const idKind = (field, resource) => {
    if (field === 'id') return resource;
    if (ID_FIELD_KIND[field]) return ID_FIELD_KIND[field];

    return 'other';
  };

  /**
   * A name-like fake, the same for the same real value every time, so a
   * project or user nested in several time entries keeps one name (hours.ts
   * links rows by it) and a contact reads the same nested and top-level.
   */
  const fakeName = (kind, raw, label) =>
    stable(`name:${kind}`, raw, n => `${label} ${n}`);
  const isId = field => field === 'id' || field.endsWith('_id');

  const value = (v, field, resource, row) => {
    if (v === null || typeof v === 'boolean') return v;
    if (Array.isArray(v))
      return EMPTIED.has(field)
        ? []
        : v.map(item => value(item, field, resource, row));
    if (typeof v === 'object') return redactRow(NESTED[field] ?? resource, v);

    // Fields that look like ids but are not Moneybird record ids, before the
    // `*_id` rule: the customer number (a column the app imports) and the
    // bank's transaction reference.
    if (field === 'customer_id')
      return v === '' ? '' : stable('customer_id', v, n => String(n));
    if (field === 'account_servicer_transaction_id')
      return v === '' ? '' : stable('transaction', v, n => `TX-${n}`);
    if (isId(field)) return fakeId(idKind(field, resource), v);

    if (typeof v === 'number') {
      // Numbers fail closed too: only counters and quantities the app reads
      // are kept; a numeric account number or tax number is not a number.
      if (KEEP_NUMBERS.has(field)) return v;
      unknown.add(`${resource}.${field}`);

      return 'redacted';
    }

    if (KEEP.has(field)) return v;

    if (field === 'name') {
      if (resource === 'administration')
        return fakeName(resource, v, 'Redacted administration');
      if (resource === 'user') return fakeName(resource, v, 'Redacted user');
      if (resource === 'project')
        return fakeName(resource, v, 'Redacted project');
      if (resource === 'financial_account')
        return fakeName(resource, v, 'Redacted account');
    }

    if (v === '') return '';
    if (field === 'company_name') return fakeName(field, v, 'Redacted company');
    if (field === 'firstname') return fakeName(field, v, 'Firstname');
    if (field === 'lastname') return fakeName(field, v, 'Lastname');
    if (field === 'email' || field.endsWith('_to_email'))
      return stable('email', v, n => `contact${n}@example.invalid`);
    if (field === 'address1') return 'Redacted street';
    if (field === 'zipcode') return '1000 AA';
    if (field === 'city') return fakeName(field, v, 'Redacted city');
    if (
      field === 'address2' ||
      field === 'phone' ||
      field === 'attention' ||
      field.endsWith('_to_attention')
    )
      return '';
    if (IBAN_LIKE.has(field)) return fakeIban(v);
    if (field === 'sales_invoices_url')
      return `https://moneybird.com/${fakeId('administration', row.administration_id)}/sales_invoices/redacted/all`;
    if (IDENTIFYING.has(field)) return 'redacted';
    if (field === 'description')
      return fakeName(field, v, 'Redacted description');
    if (field === 'message') return fakeName(field, v, 'Redacted message');
    if (field === 'contra_account_name')
      return fakeName(field, v, 'Redacted counterparty');
    if (field === 'batch_reference')
      return stable('batch_reference', v, n => `BATCH-${n}`);
    unknown.add(`${resource}.${field}`);

    return 'redacted';
  };

  const redactRow = (resource, row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, value(v, k, resource, row)]),
    );

  return {
    row: redactRow,
    /** The fake for a real administration id (file names, Link headers). */
    administration: raw => fakeId('administration', raw),
    unknown: () => [...unknown].sort(),
  };
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);

  return i === -1 ? fallback : process.argv[i + 1];
};

/** Every value of a repeatable `--<name> <value>` option, in order. */
const args = name =>
  process.argv.flatMap((a, i) =>
    a === `--${name}` && process.argv[i + 1] !== undefined
      ? [process.argv[i + 1]]
      : [],
  );

/** The `rel="next"` target of a Link header, if any. */
export function nextLink(link) {
  if (typeof link !== 'string') return undefined;

  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }

  return undefined;
}

async function get(token, path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) throw new Error(`GET ${path} returned ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`GET ${path}: not an array`);

  return { body, link: res.headers.get('link') };
}

function write(dir, file, record) {
  writeFileSync(
    new URL(`api/${file}`, dir),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/** A page's Link header with the real administration id replaced. */
function redactLink(link, real, fake) {
  const next = nextLink(link);
  if (!next) return {};

  return { Link: `<${next.split(real).join(fake)}>; rel="next"` };
}

async function recordPaged({
  dir,
  token,
  redact,
  real,
  fake,
  resource,
  collection,
  query,
  perPage,
  maxPages,
}) {
  let path = `/${real}/${collection}.json?per_page=${perPage}${query}`;
  let page = 1;

  for (; path && page <= maxPages; page++) {
    const { body, link } = await get(token, path);
    const next = nextLink(link);
    write(dir, `GET__${fake}__${collection}__page-${page}.json`, {
      status: 200,
      headers: page < maxPages ? redactLink(link, real, fake) : {},
      body: body.map(row => redact.row(resource, row)),
    });
    path = next
      ? new URL(next).pathname.slice('/api/v2'.length) + new URL(next).search
      : undefined;
  }

  if (page === 2)
    console.warn(
      `record: ${fake}/${collection} fit on one page at per_page=${perPage}; its Link paging is not exercised.`,
    );

  return page - 1;
}

/**
 * Formats what was written with the repo's oxfmt, so CI's `oxfmt --check
 * integrations` passes. Only whitespace changes.
 */
function format(dir) {
  const root = new URL('../../../../', dir);
  const bin = new URL('browser/node_modules/.bin/oxfmt', root);

  if (!existsSync(bin)) {
    console.warn(
      'record: browser/node_modules/.bin/oxfmt not found (see AGENTS.md for the atomic-server layout); format before committing.',
    );

    return;
  }

  const result = spawnSync(
    fileURLToPath(bin),
    [
      '-c',
      fileURLToPath(new URL('browser/.oxfmtrc.json', root)),
      fileURLToPath(dir),
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('oxfmt failed');
}

/** The civil year in Europe/Amsterdam now (what `period:this_year` means). */
export const civilYear = () =>
  Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Amsterdam',
      year: 'numeric',
    }).format(new Date()),
  );

async function main() {
  const dir = new URL('./', import.meta.url);
  const token = process.env.MONEYBIRD_TOKEN;
  if (!token) throw new Error('MONEYBIRD_TOKEN must be set');
  const perPage = Number(arg('per-page', '2'));
  const maxPages = Number(arg('max-pages', '3'));
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100)
    throw new Error('--per-page must be an integer from 1 to 100');
  if (!Number.isInteger(maxPages) || maxPages < 1)
    throw new Error('--max-pages must be an integer of at least 1');
  const api = new URL('api/', dir);
  rmSync(api, { recursive: true, force: true });
  mkdirSync(api);
  const redact = redactor();

  const { body: administrations } = await get(token, '/administrations.json');
  const wanted = args('administration');
  const chosen = administrations.filter(
    a => wanted.length === 0 || wanted.includes(String(a.id)),
  );
  if (chosen.length === 0)
    throw new Error('record: no administration matched --administration');
  write(dir, 'GET__administrations.json', {
    status: 200,
    headers: {},
    body: chosen.map(row => redact.row('administration', row)),
  });

  const pages = {};

  for (const administration of chosen) {
    const real = String(administration.id);
    const fake = redact.administration(administration.id);
    const common = { dir, token, redact, real, fake, perPage, maxPages };
    pages[fake] = {
      contacts: await recordPaged({
        ...common,
        resource: 'contact',
        collection: 'contacts',
        query: '&include_archived=true',
      }),
      time_entries: await recordPaged({
        ...common,
        resource: 'time_entry',
        collection: 'time_entries',
        query: `&filter=${encodeURIComponent(TIME_ENTRIES_FILTER)}`,
      }),
    };
    const accounts = await get(token, `/${real}/financial_accounts.json`);
    write(dir, `GET__${fake}__financial_accounts.json`, {
      status: 200,
      headers: {},
      body: accounts.body.map(row => redact.row('financial_account', row)),
    });
    const mutations = await get(
      token,
      `/${real}/financial_mutations.json?filter=${encodeURIComponent(MUTATIONS_FILTER)}`,
    );
    write(dir, `GET__${fake}__financial_mutations.json`, {
      status: 200,
      headers: {},
      body: mutations.body.map(row => redact.row('financial_mutation', row)),
    });
    if (mutations.body.length >= 100)
      console.warn(
        `record: ${fake}/financial_mutations answered ${mutations.body.length} records; the document's limit is 100, so the year may be truncated.`,
      );
  }

  writeFileSync(
    new URL('meta.json', api),
    `${JSON.stringify(
      {
        recorded_at: new Date().toISOString().slice(0, 10),
        source: API,
        year: civilYear(),
        per_page: perPage,
        administrations: Object.keys(pages),
        pages,
        unrecognised_fields_redacted: redact.unknown(),
      },
      null,
      2,
    )}\n`,
  );
  const unknown = redact.unknown();
  if (unknown.length)
    console.warn(
      `record: redacted unrecognised fields ${unknown.join(', ')}; review, and add safe ones to KEEP.`,
    );
  console.info(`record: wrote ${readdirSync(api).length} files to api/`);
  format(dir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => {
    console.error(`record: ${error.message}`);
    process.exit(1);
  });
