// @wc-ignore-file
/**
 * Checks the moneybird mock-proxy fixture (fixtures/moneybird/) and its
 * recorder against the app that consumes it (moneybird/). Per
 * PARALLEL_LANES.md §4 a source that drops a field the app reads must fail
 * here, not in e2e.
 *
 * The fixture serves the recorded api/ when fixtures/moneybird/record.mjs
 * has been run against a real test administration (atomic-plugins#102),
 * and the SYNTHETIC rows of synthetic.mjs until then. The recorded code
 * path is proven here against an invented api/ (nothing in it is from a
 * real account), so a recording, once made, replays without new code.
 * Run with the AGENTS.md atomic-server layout:
 *
 *   browser/node_modules/.bin/vitest run \
 *     --config integrations/money/vitest.config.ts moneybird-fixture
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fixtures } from '../localthought/fixtures/index.mjs';
import {
  civilYear as recorderYear,
  nextLink,
  redactor,
} from './fixtures/moneybird/record.mjs';
import { civilYear } from './moneybird/read';
import scenario, {
  moneybirdFixture,
  PAGE_CAP,
  recorded,
  source,
} from './fixtures/moneybird/scenario.mjs';
import { SYNTHETIC } from './fixtures/moneybird/synthetic.mjs';
import { contactName, contactValues } from './moneybird/contacts';
import { hourSourceId } from './moneybird/hours';
import { mutationSourceId } from './moneybird/mutations';

type Row = Record<string, unknown>;
type Answer = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};
const isRecorded: boolean = recorded();
const ID = /^\d{18}$/;

const api = (fixture = moneybirdFixture({ outage: false })) => {
  const get = (path: string, method = 'GET') =>
    fixture.request(
      method,
      new URL(`http://mock/proxy/moneybird/api/v2${path}`),
    ) as Answer;

  return { fixture, get };
};

/** Every row of a paged collection, following the fixture's Link headers. */
function paged(get: ReturnType<typeof api>['get'], path: string): Row[] {
  const rows: Row[] = [];
  let next: string | undefined =
    `${path}${path.includes('?') ? '&' : '?'}per_page=100`;

  while (next) {
    const res = get(next);
    expect(res.status).toBe(200);
    rows.push(...(res.body as Row[]));
    const link = nextLink(res.headers?.Link);
    next = link
      ? `${new URL(link).pathname.slice('/api/v2'.length)}${new URL(link).search}`
      : undefined;
  }

  return rows;
}

describe('moneybird fixture: always-on checks', () => {
  it('is registered with the mock proxy', () => {
    expect(fixtures.moneybird).toBe(scenario);
  });

  it('redacts every string it does not know to be safe, keeping references, amounts and dates', () => {
    const redact = redactor();
    const administration: Row = redact.row('administration', {
      id: '777000111',
      name: 'Bakkerij Jansen B.V.',
      language: 'nl',
      currency: 'EUR',
      country: 'NL',
      time_zone: 'Europe/Amsterdam',
      access: 'user',
      suspended: false,
      period_locked_until: null,
      period_start_date: '2025-01-01',
    });
    const contact: Row = redact.row('contact', {
      id: 888000222,
      administration_id: '777000111',
      company_name: 'Bakkerij Jansen B.V.',
      firstname: 'Piet',
      lastname: 'Jansen',
      address1: 'Dorpsstraat 1',
      address2: '',
      zipcode: '1234 AB',
      city: 'Ons Dorp',
      country: 'NL',
      phone: '0612345678',
      email: 'piet@jansen.example',
      send_invoices_to_email: 'piet@jansen.example',
      customer_id: '42',
      tax_number: 'NL001234567B01',
      sepa_iban: 'NL91ABNA0417164300',
      sepa_iban_account_name: 'P. Jansen',
      sepa_sequence_type: 'RCUR',
      sales_invoices_url:
        'https://moneybird.com/777000111/sales_invoices/abc/all',
      created_at: '2026-02-01T09:00:00.000Z',
      updated_at: '2026-02-02T09:00:00.000Z',
      version: 1788950001,
      archived: true,
      notes: [{ note: 'secret' }],
      contact_people: [{ firstname: 'Kees' }],
      custom_fields: [],
      events: [{ action: 'created' }],
      favourite_colour: 'leak',
    });
    const user = { id: '999000333', name: 'Piet Jansen' };
    const project = {
      id: '999000444',
      name: 'Website',
      state: 'active',
      budget: 4000,
    };
    const entry: Row = redact.row('time_entry', {
      id: '999000555',
      administration_id: '777000111',
      contact_id: 888000222,
      project_id: '999000444',
      user_id: '999000333',
      started_at: '2026-03-02T09:00:00.000Z',
      ended_at: '2026-03-02T11:30:00.000Z',
      description: 'Call with Piet about the leak',
      paused_duration: 1800,
      billable: true,
      user,
      project,
      contact: { id: 888000222, company_name: 'Bakkerij Jansen B.V.' },
      events: [],
      notes: [],
    });
    const account: Row = redact.row('financial_account', {
      id: '999000666',
      administration_id: '777000111',
      type: 'bank_account',
      name: 'Zakelijk NL91',
      identifier: 'NL91ABNA0417164300',
      currency: 'EUR',
      active: true,
    });
    const mutation: Row = redact.row('financial_mutation', {
      id: '999000777',
      administration_id: '777000111',
      amount: '-120.5',
      code: 'TRF',
      message: 'Factuur 2026-001 Jansen',
      contra_account_name: 'Bakkerij Jansen B.V.',
      contra_account_number: 'NL91ABNA0417164300',
      state: 'unprocessed',
      settlement_state: 'settled',
      amount_open: '-120.5',
      batch_reference: 'B-77',
      financial_account_id: '999000666',
      currency: 'EUR',
      date: '2026-01-20',
      version: 1788960002,
      financial_statement_id: '999000888',
      account_servicer_transaction_id: 'ABN-123',
      payments: [{ amount: '1' }],
      ledger_account_bookings: [{ ledger_account_id: '1' }],
    });
    const text = JSON.stringify([
      administration,
      contact,
      entry,
      account,
      mutation,
    ]);

    for (const secret of [
      '777000111',
      '888000222',
      '999000',
      'Jansen',
      'Piet',
      'Kees',
      'Dorpsstraat',
      '1234 AB',
      'Ons Dorp',
      '0612345678',
      'jansen.example',
      'NL001234567B01',
      'ABNA0417164300',
      'Website',
      'leak',
      'secret',
      'TRF',
      'B-77',
      'ABN-123',
      '/abc/',
    ])
      expect(text, secret).not.toContain(secret);

    // Ids: 18 digits, by kind, stable, and references intact.
    for (const id of [
      administration.id,
      contact.id,
      (entry.user as Row).id,
      entry.id,
      account.id,
      mutation.id,
    ])
      expect(String(id)).toMatch(ID);
    expect(administration.id).toBe(redact.administration('777000111'));
    expect(contact.administration_id).toBe(administration.id);
    expect(entry.administration_id).toBe(administration.id);
    expect(entry.user_id).toBe((entry.user as Row).id);
    expect(entry.project_id).toBe((entry.project as Row).id);
    expect(entry.contact_id).toBe(contact.id);
    expect((entry.contact as Row).id).toBe(contact.id);
    expect(mutation.financial_account_id).toBe(account.id);
    expect(String(contact.id)).toMatch(/^2000/);
    expect(String((entry.user as Row).id)).toMatch(/^3000/);
    expect(String(account.id)).toMatch(/^5000/);
    expect(String(mutation.id)).toMatch(/^7000/);
    // The same IBAN in two places stays the same fake.
    expect(contact.sepa_iban).toBe(account.identifier);
    expect(mutation.contra_account_number).toBe(account.identifier);
    expect(account.identifier).toMatch(/^NL00TEST\d{10}$/);

    // Kept: amounts, dates, timestamps, enum-like values, numbers, booleans.
    expect(mutation).toMatchObject({
      amount: '-120.5',
      amount_open: '-120.5',
      currency: 'EUR',
      date: '2026-01-20',
      state: 'unprocessed',
      settlement_state: 'settled',
      version: 1788960002,
      payments: [],
      ledger_account_bookings: [],
    });
    expect(entry).toMatchObject({
      started_at: '2026-03-02T09:00:00.000Z',
      ended_at: '2026-03-02T11:30:00.000Z',
      paused_duration: 1800,
      billable: true,
      project: { state: 'active', budget: 4000 },
    });
    expect(contact).toMatchObject({
      country: 'NL',
      address2: '',
      phone: '',
      sepa_sequence_type: 'RCUR',
      archived: true,
      version: 1788950001,
      notes: [],
      contact_people: [],
      events: [],
      favourite_colour: 'redacted',
    });
    expect(administration.name).toMatch(/^Redacted administration \d+$/);
    expect(contact.city).toMatch(/^Redacted city \d+$/);
    expect(contact.email).toMatch(/^contact\d+@example\.invalid$/);
    expect(contact.send_invoices_to_email).toBe(contact.email);
    expect(contact.sales_invoices_url).toBe(
      `https://moneybird.com/${administration.id}/sales_invoices/redacted/all`,
    );
    expect(redact.unknown()).toEqual(['contact.favourite_colour']);

    // What the app makes of the redacted rows still has a name and an identity.
    expect(contactName(contact as never)).toMatch(/^Redacted company \d+$/);
    expect(contactValues(contact as never)['moneybird-city']).toBe(
      contact.city,
    );
    expect(hourSourceId(String(administration.id), String(entry.id))).toContain(
      String(entry.id),
    );
    expect(
      mutationSourceId(String(administration.id), String(mutation.id)),
    ).toContain(String(mutation.id));
  });

  it('reads a rel="next" Link header', () => {
    expect(
      nextLink(
        '<https://moneybird.com/api/v2/1/contacts.json?page=2>; rel="next", <https://moneybird.com/api/v2/1/contacts.json?page=9>; rel="last"',
      ),
    ).toBe('https://moneybird.com/api/v2/1/contacts.json?page=2');
    expect(nextLink('<https://x/a?page=1>; rel="first"')).toBeUndefined();
    expect(nextLink(null)).toBeUndefined();
  });

  it('gives a project, user or contact one fake wherever it appears', () => {
    const redact = redactor();
    const user = { id: '999000333', name: 'Piet Jansen' };
    const project = { id: '999000444', name: 'Website', state: 'active' };
    const rawContact = {
      id: '888000222',
      administration_id: '777000111',
      company_name: 'Bakkerij Jansen B.V.',
      firstname: 'Piet',
      lastname: 'Jansen',
      city: 'Ons Dorp',
    };
    const entry = (id: string, description: string): Row =>
      redact.row('time_entry', {
        id,
        administration_id: '777000111',
        contact_id: rawContact.id,
        project_id: project.id,
        user_id: user.id,
        description,
        user,
        project,
        contact: rawContact,
      });
    const [one, two] = [entry('999000551', 'Call'), entry('999000552', 'Call')];
    const contact: Row = redact.row('contact', rawContact);

    // Two entries, one project and one user: the same fake ids and names.
    expect((one.project as Row).id).toBe((two.project as Row).id);
    expect((one.project as Row).name).toBe((two.project as Row).name);
    expect((one.user as Row).id).toBe((two.user as Row).id);
    expect((one.user as Row).name).toBe((two.user as Row).name);
    expect(one.project_id).toBe((one.project as Row).id);
    expect(one.user_id).toBe((one.user as Row).id);
    expect((one.project as Row).name).toMatch(/^Redacted project 1$/);
    expect((one.user as Row).name).toMatch(/^Redacted user 1$/);
    // The same description twice is the same fake; a different one is not.
    expect(one.description).toBe(two.description);
    expect(entry('999000553', 'Lunch').description).not.toBe(one.description);
    // A contact nested in an entry and read top-level is the same row.
    expect(one.contact).toEqual(contact);
    expect(one.contact_id).toBe(contact.id);
    expect(contact).toMatchObject({
      company_name: 'Redacted company 1',
      firstname: 'Firstname 1',
      lastname: 'Lastname 1',
      city: 'Redacted city 1',
    });
    // Distinct real values get distinct fakes.
    expect(
      redact.row('contact', { ...rawContact, id: '888000223', city: 'Elders' })
        .city,
    ).toBe('Redacted city 2');
  });

  it('keeps only allow-listed numbers; other numbers are redacted and reported', () => {
    const redact = redactor();
    const contact: Row = redact.row('contact', {
      id: 888000222,
      chamber_of_commerce: 12345678,
      tax_number: 123456789,
      customer_id: 42,
      version: 1788950001,
      max_transfer_amount: 500,
    });
    const mutation: Row = redact.row('financial_mutation', {
      id: '999000777',
      contra_account_number: 417164300,
      account_servicer_transaction_id: 987654,
      version: 7,
    });
    const entry: Row = redact.row('time_entry', {
      id: '999000555',
      paused_duration: 1800,
      project: { id: '999000444', name: 'Website', budget: 4000 },
    });
    const text = JSON.stringify([contact, mutation, entry]);
    for (const secret of ['12345678', '123456789', '417164300', '987654'])
      expect(text, secret).not.toContain(secret);
    expect(contact).toMatchObject({
      chamber_of_commerce: 'redacted',
      tax_number: 'redacted',
      customer_id: '1',
      version: 1788950001,
      max_transfer_amount: 500,
    });
    expect(mutation).toMatchObject({
      contra_account_number: 'redacted',
      account_servicer_transaction_id: 'TX-1',
      version: 7,
    });
    expect(entry).toMatchObject({
      paused_duration: 1800,
      project: { budget: 4000 },
    });
    expect(redact.unknown()).toEqual([
      'contact.chamber_of_commerce',
      'contact.tax_number',
      'financial_mutation.contra_account_number',
    ]);
  });

  it('counts the civil year the way the app does', () => {
    expect(recorderYear()).toBe(civilYear());
  });
});

/**
 * An invented api/ in the recording's layout: one administration, three
 * contacts over two pages (one archived), two time entries, one account,
 * two mutations in YEAR. Nothing in it is from a real account.
 */
const invented: string[] = [];
afterAll(() => {
  for (const dir of invented) rmSync(dir, { recursive: true, force: true });
});

function inventedRecording(year: number): URL {
  const dir = mkdtempSync(join(tmpdir(), 'moneybird-fixture-'));
  invented.push(dir);
  const admin = '100000000000000001';
  const answer = (body: unknown, headers: Record<string, string> = {}) => ({
    status: 200,
    headers,
    body,
  });
  const contact = (n: number, over: Row = {}): Row => ({
    id: `2000000000000000${String(n).padStart(2, '0')}`,
    administration_id: admin,
    company_name: `Redacted company ${n}`,
    firstname: '',
    lastname: '',
    city: `Redacted city ${n}`,
    country: 'NL',
    email: `contact${n}@example.invalid`,
    customer_id: String(n),
    archived: false,
    version: 1788950000 + n,
    updated_at: `${year}-02-0${n}T09:00:00.000Z`,
    ...over,
  });
  const user = { id: '300000000000000001', name: 'Redacted user 1' };
  const project = {
    id: '400000000000000001',
    name: 'Redacted project 1',
    state: 'active',
    budget: null,
  };
  const entry = (n: number): Row => ({
    id: `6000000000000000${String(n).padStart(2, '0')}`,
    administration_id: admin,
    project_id: project.id,
    user_id: user.id,
    started_at: `${year}-03-0${n}T09:00:00.000Z`,
    ended_at: `${year}-03-0${n}T10:00:00.000Z`,
    description: `Redacted description ${n}`,
    paused_duration: 0,
    billable: true,
    updated_at: `${year}-03-0${n}T10:00:00.000Z`,
    user,
    project,
    contact: null,
  });
  const account = {
    id: '500000000000000001',
    administration_id: admin,
    type: 'bank_account',
    name: 'Redacted account 1',
    identifier: 'NL00TEST0000000001',
    currency: 'EUR',
    active: true,
  };
  const mutation = (n: number, date: string, amount: string): Row => ({
    id: `7000000000000000${String(n).padStart(2, '0')}`,
    administration_id: admin,
    amount,
    message: `Redacted message ${n}`,
    state: 'unprocessed',
    financial_account_id: account.id,
    currency: 'EUR',
    date,
    version: 1788960000 + n,
    updated_at: `${date}T06:00:00.000Z`,
  });
  const files: Record<string, unknown> = {
    'meta.json': { recorded_at: `${year}-10-08`, year, per_page: 2 },
    'GET__administrations.json': answer([
      { id: admin, name: 'Redacted administration 1', currency: 'EUR' },
    ]),
    [`GET__${admin}__contacts__page-1.json`]: answer(
      [contact(1), contact(2, { archived: true })],
      {
        Link: `<https://moneybird.com/api/v2/${admin}/contacts.json?per_page=2&include_archived=true&page=2>; rel="next"`,
      },
    ),
    [`GET__${admin}__contacts__page-2.json`]: answer([contact(3)]),
    [`GET__${admin}__time_entries__page-1.json`]: answer([entry(1), entry(2)]),
    [`GET__${admin}__financial_accounts.json`]: answer([account]),
    [`GET__${admin}__financial_mutations.json`]: answer([
      mutation(1, `${year}-01-05`, '1210.0'),
      mutation(2, `${year}-03-09`, '-0.35'),
    ]),
  };
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dir, name), JSON.stringify(content));

  return pathToFileURL(`${dir}/`);
}

describe('moneybird fixture: replaying a recording (#102)', () => {
  const year = 2031;
  const apiDir = inventedRecording(year);
  const admin = '100000000000000001';

  it('takes its rows and year from api/ once meta.json exists', () => {
    expect(recorded(apiDir)).toBe(true);
    const rows = source({ apiDir });
    expect(rows.synthetic).toBe(false);
    expect(rows.year).toBe(year);
    expect(rows.administrations.map((a: Row) => a.id)).toEqual([admin]);
    expect(rows.contacts[admin].map((c: Row) => c.id)).toEqual([
      '200000000000000001',
      '200000000000000002',
      '200000000000000003',
    ]);
    expect(rows.timeEntries[admin]).toHaveLength(2);
    expect(rows.financialAccounts[admin]).toHaveLength(1);
    expect(rows.financialMutations[admin]).toHaveLength(2);
  });

  it('serves them as the real proxy would: pages, archived, the year, read-only', () => {
    const { fixture, get } = api(moneybirdFixture({ outage: false, apiDir }));
    expect(fixture.synthetic).toBe(false);
    expect(fixture.year).toBe(year);
    expect(get('/administrations.json').body).toMatchObject([{ id: admin }]);

    const active = paged(get, `/${admin}/contacts.json`);
    expect(active.map(c => c.id)).toEqual([
      '200000000000000001',
      '200000000000000003',
    ]);
    const all = paged(get, `/${admin}/contacts.json?include_archived=true`);
    expect(all).toHaveLength(3);
    // PAGE_CAP rows per page whatever per_page asks.
    const first = get(
      `/${admin}/contacts.json?per_page=100&include_archived=true`,
    );
    expect(first.body as Row[]).toHaveLength(PAGE_CAP);
    expect(first.headers?.Link).toMatch(/rel="next"/);

    expect(
      paged(
        get,
        `/${admin}/time_entries.json?filter=period%3Athis_year%2Cstate%3Aall`,
      ),
    ).toHaveLength(2);
    expect(get(`/${admin}/financial_accounts.json`).body).toMatchObject([
      { identifier: 'NL00TEST0000000001' },
    ]);
    // `this_year` is the recording's year, and a period within it filters.
    expect(
      (
        get(`/${admin}/financial_mutations.json?filter=period%3Athis_year`)
          .body as Row[]
      ).map(m => m.amount),
    ).toEqual(['1210.0', '-0.35']);
    expect(
      get(
        `/${admin}/financial_mutations.json?filter=period%3A${year}0301..${year}0331`,
      ).body as Row[],
    ).toHaveLength(1);
    expect(
      get(
        `/${admin}/financial_mutations.json?filter=period%3A${year - 1}0101..${year - 1}1231`,
      ).body,
    ).toEqual([]);

    expect(get(`/${admin}/contacts.json`, 'POST').status).toBe(403);
    expect(get('/999/contacts.json').status).toBe(404);
  });
});

describe.skipIf(isRecorded)('moneybird fixture: synthetic only', () => {
  it('says it is synthetic, dated this civil year', () => {
    expect(SYNTHETIC).toBe(true);
    const rows = source();
    expect(rows.synthetic).toBe(true);
    expect(rows.year).toBe(civilYear());
    expect(moneybirdFixture().synthetic).toBe(true);
  });
});

describe.skipIf(!isRecorded)('moneybird fixture: recorded only', () => {
  it('keeps ids redacted and holds what the app reads', () => {
    const rows = source();
    for (const a of rows.administrations as Row[])
      expect(String(a.id)).toMatch(/^1000\d{14}$/);

    for (const list of Object.values(rows.contacts) as Row[][])
      for (const c of list) {
        expect(String(c.id)).toMatch(/^2000\d{14}$/);
        expect(typeof c.archived).toBe('boolean');
        expect(typeof c.updated_at).toBe('string');
      }

    for (const list of Object.values(rows.financialMutations) as Row[][])
      for (const m of list) {
        expect(typeof m.amount).toBe('string');
        expect(m.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(String(m.financial_account_id)).toMatch(/^5000\d{14}$/);
      }
  });

  it('was recorded this civil year, or its dated rows no longer match the app', () => {
    expect(source().year).toBe(civilYear());
  });
});
