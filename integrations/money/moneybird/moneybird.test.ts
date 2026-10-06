// @wc-ignore-file
/**
 * Moneybird read-only contacts, hours and financial mutations
 * (atomic-plugins#102) against the SYNTHETIC fixture in ../fixtures/moneybird/
 * (not a recording; see synthetic.mjs).
 *
 *   browser/node_modules/.bin/vitest run --config integrations/money/vitest.config.ts
 */
import { describe, expect, it } from 'vitest';
import {
  contacts,
  financialMutations,
  timeEntries,
  YEAR,
} from '../fixtures/moneybird/synthetic.mjs';
import { PAGE_CAP } from '../fixtures/moneybird/scenario.mjs';
import { collectionOf } from './binding.js';
import { CONTACT_FIELDS, contactName, contactValues } from './contacts.js';
import { createController, describe as say } from './controller.js';
import {
  APP,
  fakeStore,
  OTHER_TABLE,
  OWN_SHARED_TABLE,
  RENDERS_PROPERTY,
  ROW_EXTRAS_PROPERTY,
  TABLE,
} from './fakeStore.js';
import {
  hourOf,
  TIME_ENTRY,
  WORK,
  WORK_PERSON,
  WORK_PROJECT,
} from './hours.js';
import {
  BANK,
  BANK_TRANSACTION,
  mutationLabel,
  mutationOf,
  mutationSkipReason,
} from './mutations.js';
import { adopt, ensureTables, TABLE_NAMES } from './own.js';
import {
  civilYear,
  halves,
  nextLink,
  readAdministrations,
  readContacts,
  readFinancialAccounts,
  readFinancialMutations,
  readTimeEntries,
  type MoneybirdGet,
} from './read.js';
import {
  CLASSTYPE,
  IS_A,
  NAME,
  PARENT,
  PROPERTIES,
  relayGet,
  syncContacts,
  syncHours,
  syncMutations,
} from './sync.js';
import type { PluginStore } from './store.js';

const A = '100000000000000001';
const B = '100000000000000002';
const connection = { platform: 'moneybird', connectionId: 'c1' };
const get = (store: PluginStore): MoneybirdGet =>
  relayGet(store.proxy!, connection);

type Store = ReturnType<typeof fakeStore>;

const rows = (store: Store, table = TABLE) =>
  [...store.resources.entries()].filter(([, p]) => p[PARENT] === table);

const shortnameOf = (store: Store) => {
  const ontology = store.resources.get('did:ad:ontology')!;
  const byShortname = new Map<string, string>();

  for (const subject of ontology[PROPERTIES] as string[])
    byShortname.set(
      store.resources.get(subject)![
        'https://atomicdata.dev/properties/shortname'
      ] as string,
      subject,
    );

  return byShortname;
};

/** The app's own table of `klass`, if `ensureTables` made one. */
const tableOf = (store: Store, klass: string): string | undefined =>
  [...store.resources.entries()].find(
    ([, p]) => p[PARENT] === APP && p[CLASSTYPE] === klass,
  )?.[0];

const none = { added: 0, updated: 0, unchanged: 0, skipped: 0 };

describe('reading', () => {
  it('lists administrations with string identifiers', async () => {
    const store = fakeStore();
    expect(await readAdministrations(get(store))).toEqual([
      { id: A, name: 'Synthetic Studio B.V.', currency: 'EUR' },
      { id: B, name: 'Synthetic Side Project', currency: 'EUR' },
    ]);
  });

  it('follows Link rel="next" across pages, archived contacts included', async () => {
    const store = fakeStore();
    const read = await readContacts(get(store), A);
    expect(read.map(c => c.id)).toEqual(contacts[A].map(c => c.id));
    const paths = store.calls.map(c => c.path);
    expect(paths).toHaveLength(Math.ceil(contacts[A].length / PAGE_CAP));
    expect(paths[0]).toBe(
      `/api/v2/${A}/contacts.json?per_page=100&include_archived=true`,
    );
    expect(paths[1]).toContain('page=2');
  });

  it('reads this year’s time entries, every state, across pages', async () => {
    const store = fakeStore();
    const read = await readTimeEntries(get(store), A);
    expect(read.map(e => e.id)).toEqual(timeEntries[A].map(e => e.id));
    const paths = store.calls.map(c => c.path);
    expect(paths).toHaveLength(Math.ceil(timeEntries[A].length / PAGE_CAP));
    expect(paths[0]).toBe(
      `/api/v2/${A}/time_entries.json?per_page=100&filter=${encodeURIComponent('period:this_year,state:all')}`,
    );
    expect(await readTimeEntries(get(store), B)).toEqual([]);
  });

  it('reads the financial accounts by id, with their IBAN', async () => {
    const store = fakeStore();
    const accounts = await readFinancialAccounts(get(store), A);
    expect([...accounts.values()]).toEqual([
      {
        id: '500000000000000001',
        identifier: 'NL00TEST0000000099',
        name: 'Zakelijke rekening',
        currency: 'EUR',
      },
    ]);
  });

  it('reads a year of financial mutations in one window when under the limit', async () => {
    const store = fakeStore();
    const read = await readFinancialMutations(get(store), A, { year: YEAR });
    expect(read.map(m => m.id).sort()).toEqual(
      financialMutations[A].map(m => m.id).sort(),
    );
    // Moneybird's own period first, the same the hours read uses.
    expect(store.fixture.mutationFilters).toEqual(['period:this_year']);
    expect(store.calls[0].path).toBe(
      `/api/v2/${A}/financial_mutations.json?filter=${encodeURIComponent('period:this_year')}`,
    );
  });

  it('takes the civil year from a time zone, Europe/Amsterdam by default', () => {
    // 2026-12-31T23:30Z is already 2027 in Amsterdam, still 2026 in UTC.
    const newYear = new Date('2026-12-31T23:30:00Z');
    expect(civilYear('Europe/Amsterdam', newYear)).toBe(2027);
    expect(civilYear('UTC', newYear)).toBe(2026);
    expect(civilYear(undefined, newYear)).toBe(2027);
    expect(civilYear()).toBe(YEAR);
  });

  it('halves a window that comes back at the limit, down to single days', async () => {
    // The fixture answers at most 3 of its 6 mutations per window.
    const store = fakeStore({ mutationCap: 3 });
    const read = await readFinancialMutations(get(store), A, {
      year: YEAR,
      cap: 3,
    });
    expect(read.map(m => m.id).sort()).toEqual(
      financialMutations[A].map(m => m.id).sort(),
    );
    const filters = store.fixture.mutationFilters;
    expect(filters[0]).toBe('period:this_year');
    expect(filters[1]).toBe(`period:${YEAR}0101..${YEAR}0702`);
    expect(filters.length).toBeGreaterThan(3);
    expect(filters.length).toBeLessThan(40);
    // Every later window is within the year, and no day is asked twice.
    for (const filter of filters.slice(1))
      expect(filter).toMatch(
        new RegExp(`^period:${YEAR}\\d{4}\\.\\.${YEAR}\\d{4}$`),
      );
    expect(new Set(filters).size).toBe(filters.length);
  });

  it('refuses a single day at the limit rather than import an incomplete ledger', async () => {
    // Two mutations share one day; at a limit of 1 that day cannot be read whole.
    const store = fakeStore({ mutationCap: 1 });
    await expect(
      readFinancialMutations(get(store), A, { year: YEAR, cap: 1 }),
    ).rejects.toThrow(/limit for one answer.*Nothing was written/);
  });

  it('stops after too many mutation requests', async () => {
    const store = fakeStore({ mutationCap: 3 });
    await expect(
      readFinancialMutations(get(store), A, {
        year: YEAR,
        cap: 3,
        maxRequests: 2,
      }),
    ).rejects.toThrow(/Stopped after 2 requests/);
  });

  it('splits day ranges in halves', () => {
    expect(halves({ from: '20260101', to: '20260101' })).toBeUndefined();
    expect(halves({ from: '20260101', to: '20260102' })).toEqual([
      { from: '20260101', to: '20260101' },
      { from: '20260102', to: '20260102' },
    ]);
    expect(halves({ from: '20260101', to: '20261231' })).toEqual([
      { from: '20260101', to: '20260702' },
      { from: '20260703', to: '20261231' },
    ]);
  });

  it('relays every path with the server URL base path, as the proxy requires', async () => {
    const store = fakeStore();
    await readAdministrations(get(store));
    await readContacts(get(store), A);
    await readTimeEntries(get(store), A);
    await readFinancialAccounts(get(store), A);
    await readFinancialMutations(get(store), A, { year: YEAR });
    expect(store.calls.length).toBeGreaterThan(4);

    for (const call of store.calls) {
      expect(call.path).toMatch(/^\/api\/v2\//);
      expect(call.method).toBe('GET');
    }
  });

  it('refuses a next link outside the collection', async () => {
    const hostile: MoneybirdGet = async () => ({
      status: 200,
      headers: { link: '<https://evil.example/steal>; rel="next"' },
      body: [],
    });
    await expect(readContacts(hostile, A)).rejects.toThrow(/Refusing/);
    const sideways: MoneybirdGet = async () => ({
      status: 200,
      headers: {
        link: `<https://moneybird.com/api/v2/${B}/contacts.json?page=2>; rel="next"`,
      },
      body: [],
    });
    await expect(readContacts(sideways, A)).rejects.toThrow(/Refusing/);
    await expect(readTimeEntries(hostile, A)).rejects.toThrow(/Refusing/);
  });

  it('stops a provider that never stops paging', async () => {
    const loop: MoneybirdGet = async path => ({
      status: 200,
      headers: {
        link: `<https://moneybird.com/api/v2${path.split('?')[0]}?page=9>; rel="next"`,
      },
      body: [],
    });
    await expect(readContacts(loop, A, { maxPages: 3 })).rejects.toThrow(
      /Stopped after 3 pages/,
    );
  });

  it('parses Link headers with several relations', () => {
    expect(
      nextLink(
        '<https://x/a?page=1>; rel="prev", <https://x/a?page=3>; rel="next"',
      ),
    ).toBe('https://x/a?page=3');
    expect(nextLink('<https://x/a?page=1>; rel="prev"')).toBeUndefined();
    expect(nextLink(undefined)).toBeUndefined();
  });
});

describe('mapping', () => {
  it('maps only the declared contact fields, typed, and never writes null', () => {
    const [bakery, anna, , archived] = contacts[A];
    expect(contactName(bakery)).toBe('Fictief Bakkerij B.V.');
    expect(contactName(anna)).toBe('Anna Voorbeeld');
    const values = contactValues(archived);
    expect(values['moneybird-archived']).toBe(true);
    expect(values['moneybird-version']).toBe(archived.version);
    expect(values['moneybird-administration-id']).toBe(A);
    expect(values).not.toHaveProperty('moneybird-company-name', null);
    expect(
      Object.keys(values).every(k =>
        CONTACT_FIELDS.some(f => f.shortname === k),
      ),
    ).toBe(true);
  });

  it('maps a time entry onto time-entry-v1: epoch-millisecond start and end, links, billable, paused', () => {
    const [review, paused, vat, loose] = timeEntries[A];
    const row = hourOf(review, A)!;
    expect(row).toEqual({
      identity: `moneybird:${A}:time_entry:${review.id}`,
      name: 'Design review',
      start: Date.parse(review.started_at),
      end: Date.parse(review.ended_at!),
      billable: true,
      project: { id: review.project!.id, name: 'Website relaunch' },
      person: { id: review.user.id, name: 'Anna Voorbeeld' },
      updatedAt: review.updated_at,
    });
    expect(Number.isSafeInteger(row.start)).toBe(true);
    expect(row.end! - row.start).toBe(2.5 * 3_600_000);
    expect(hourOf(paused, A)!.paused).toBe(1800);
    expect(hourOf(vat, A)!.billable).toBe(false);
    const bare = hourOf(loose, A)!;
    expect(bare.name).toBe(`Time entry ${loose.id}`);
    expect(bare.project).toBeUndefined();
    expect(bare.person?.name).toBe('Bram Proef');
    // No readable start: not a row (the class requires one).
    expect(hourOf({ ...review, started_at: null }, A)).toBeUndefined();
    expect(hourOf({ ...review, started_at: 'yesterday' }, A)).toBeUndefined();
    // A running timer keeps its start and has no end.
    expect(hourOf({ ...review, ended_at: null }, A)!.end).toBeUndefined();
  });

  it('maps a financial mutation onto bank-transaction-v1 with the exact amount string and the account IBAN', async () => {
    const store = fakeStore();
    const accounts = await readFinancialAccounts(get(store), A);
    const [invoice, hosting, , duplicate, , fee] = financialMutations[A];
    expect(mutationOf(invoice, A, accounts)).toEqual({
      identity: `moneybird:${A}:financial_mutation:${invoice.id}`,
      name: 'Fictief Bakkerij B.V.',
      account: 'NL00TEST0000000099',
      currency: 'EUR',
      amount: '1210.0',
      valueDate: invoice.date,
      description: 'Factuur 2026-001',
      reference: 'SYN-0001',
      state: 'unprocessed',
      contraAccount: 'NL00TEST0000000001',
      version: invoice.version,
      updatedAt: invoice.updated_at,
    });
    expect(mutationOf(hosting, A, accounts)).toMatchObject({
      amount: '-120.5',
      state: 'processed',
    });
    expect(mutationOf(duplicate, A, accounts)!.reference).toBe('BATCH-SYN-2');
    // No contra account name and no message: named by id; an unknown
    // account falls back to its id.
    const bare = mutationOf(
      { ...fee, message: '', financial_account_id: '999' },
      A,
      accounts,
    )!;
    expect(bare.name).toBe(`Mutation ${fee.id}`);
    // Prefixed: a Moneybird id is not a bank's account id.
    expect(bare.account).toBe('moneybird:999');
    expect(bare.description).toBeUndefined();
    // Not exact: skipped, never approximated.
    expect(mutationOf({ ...fee, amount: -0.35 }, A, accounts)).toBeUndefined();
    expect(mutationOf({ ...fee, amount: '1e3' }, A, accounts)).toBeUndefined();
    expect(
      mutationOf({ ...fee, amount: '0.123456' }, A, accounts),
    ).toBeUndefined();
    expect(
      mutationOf({ ...fee, date: '09-03-2026' }, A, accounts),
    ).toBeUndefined();
    // The reason the card gives: the first failing requirement.
    expect(mutationSkipReason({ ...fee, amount: -0.35 })).toMatch(
      /not send as a decimal string: not imported, never approximated/,
    );
    expect(mutationSkipReason({ ...fee, date: '09-03-2026' })).toMatch(
      /not YYYY-MM-DD/,
    );
    expect(mutationSkipReason({ ...fee, currency: '' })).toMatch(
      /without a currency/,
    );
    expect(mutationSkipReason({ ...fee, financial_account_id: null })).toMatch(
      /without a financial account/,
    );
    expect(mutationSkipReason(fee)).toBeUndefined();
    expect(mutationLabel({ ...fee, message: '' })).toBe(`Mutation ${fee.id}`);
  });

  it('knows which shared class holds which collection', () => {
    expect(collectionOf(TIME_ENTRY)).toBe('hours');
    expect(collectionOf(BANK_TRANSACTION)).toBe('mutations');
    expect(collectionOf('did:ad:class-item')).toBeUndefined();
  });
});

describe('importing', () => {
  it('creates typed contact rows once, and a repeat import writes nothing', async () => {
    const store = fakeStore({ outage: false });
    const first = await syncContacts(store, get(store), A);
    expect(first).toEqual({ ...none, total: 5, added: 5 });
    expect(rows(store)).toHaveLength(5);
    expect(
      rows(store)
        .map(([, p]) => p[NAME])
        .sort(),
    ).toContain('Testcafé & Co');
    const properties = shortnameOf(store);
    const datatype = (s: string) =>
      store.resources.get(properties.get(s)!)![
        'https://atomicdata.dev/properties/datatype'
      ];
    expect(datatype('moneybird-archived')).toBe(
      'https://atomicdata.dev/datatypes/boolean',
    );
    expect(datatype('moneybird-version')).toBe(
      'https://atomicdata.dev/datatypes/integer',
    );

    const writes = store.writes.length;
    const again = await syncContacts(store, get(store), A);
    expect(again).toEqual({ ...none, total: 5, unchanged: 5 });
    expect(store.writes.length).toBe(writes);
    expect(rows(store)).toHaveLength(5);
  });

  it('identifies rows by administration and id, so two administrations do not collide', async () => {
    const store = fakeStore({ outage: false });
    await syncContacts(store, get(store), A);
    await syncContacts(store, get(store), B);
    expect(rows(store)).toHaveLength(6);
  });

  it('updates a contact that changed on Moneybird in place', async () => {
    const store = fakeStore({ outage: false });
    await syncContacts(store, get(store), A);
    const original = contacts[A][1];
    const changed = {
      ...original,
      city: 'Haarlem',
      version: original.version + 1,
    };
    const read = async () =>
      contacts[A].map(c => (c.id === original.id ? changed : c));
    expect(await syncContacts(store, get(store), A, read)).toEqual({
      ...none,
      total: 5,
      updated: 1,
      unchanged: 4,
    });
    expect(rows(store)).toHaveLength(5);
  });

  it('writes nothing when a refresh fails part-way', async () => {
    const store = fakeStore();
    await syncContacts(store, get(store), A);
    const before = structuredClone([...store.resources]);
    const writes = store.writes.length;
    // The fixture's second read fails on page 2 (synthetic outage).
    await expect(syncContacts(store, get(store), A)).rejects.toThrow(/503/);
    expect(store.writes.length).toBe(writes);
    expect([...store.resources]).toEqual(before);
  });

  it('imports hours as time-entry-v1 rows linked to project and person rows of the shared classes', async () => {
    const store = fakeStore();
    const tables = await ensureTables(store, APP);
    expect(store.resources.get(tables.hours)).toMatchObject({
      [PARENT]: APP,
      [CLASSTYPE]: TIME_ENTRY,
      [NAME]: TABLE_NAMES.hours,
    });
    const summary = await syncHours(store, get(store), A, tables);
    expect(summary).toEqual({ ...none, total: 4, added: 4 });
    const hours = rows(store, tables.hours);
    expect(hours).toHaveLength(4);

    for (const [, row] of hours) {
      expect(row[IS_A]).toEqual([TIME_ENTRY]);
      expect(typeof row[WORK.start]).toBe('number');
      expect(typeof row[WORK.end]).toBe('number');
    }

    const projects = rows(store, tables.projects);
    const people = rows(store, tables.people);
    expect(projects.map(([, p]) => p[NAME]).sort()).toEqual([
      'Bookkeeping',
      'Website relaunch',
    ]);
    expect(people.map(([, p]) => p[NAME]).sort()).toEqual([
      'Anna Voorbeeld',
      'Bram Proef',
    ]);
    for (const [, p] of projects) expect(p[IS_A]).toEqual([WORK_PROJECT]);
    for (const [, p] of people) expect(p[IS_A]).toEqual([WORK_PERSON]);
    const review = hours.find(([, p]) => p[NAME] === 'Design review')![1];
    const relaunch = projects.find(([, p]) => p[NAME] === 'Website relaunch')!;
    const anna = people.find(([, p]) => p[NAME] === 'Anna Voorbeeld')!;
    expect(review[WORK.project]).toBe(relaunch[0]);
    expect(review[WORK.person]).toBe(anna[0]);
    expect(review[WORK.billable]).toBe(true);
    const properties = shortnameOf(store);
    const paused = hours.find(([, p]) => p[NAME] === 'Build the header')![1];
    expect(paused[properties.get('moneybird-paused-duration')!]).toBe(1800);
    const loose = hours.find(([, p]) => p[WORK.project] === undefined)![1];
    expect(loose[NAME]).toMatch(/^Time entry 6/);

    // Again: nothing written. A project renamed in Moneybird is renamed here.
    const writes = store.writes.length;
    expect(await syncHours(store, get(store), A, tables)).toEqual({
      ...none,
      total: 4,
      unchanged: 4,
    });
    expect(store.writes.length).toBe(writes);
    const renamed = async () =>
      timeEntries[A].map(e =>
        e.project?.id === relaunch[1]['moneybird-source-id' as never]
          ? e
          : e.project
            ? { ...e, project: { ...e.project, name: `${e.project.name} 2` } }
            : e,
      );
    await syncHours(store, get(store), A, tables, renamed);
    expect(rows(store, tables.projects).map(([, p]) => p[NAME])).toContain(
      'Website relaunch 2',
    );
    expect(rows(store, tables.projects)).toHaveLength(2);
  });

  it('counts a time entry without a start as skipped and imports the rest', async () => {
    const store = fakeStore();
    const tables = await ensureTables(store, APP);
    const read = async () => [
      { ...timeEntries[A][0], started_at: null },
      ...timeEntries[A].slice(1),
    ];
    expect(await syncHours(store, get(store), A, tables, read)).toEqual({
      ...none,
      total: 4,
      added: 3,
      skipped: 1,
      // Named with its reason, for the sync-status card's ignored list.
      skippedRows: [
        {
          name: 'Design review',
          reason:
            'without a readable start (started_at) in Moneybird: not imported.',
        },
      ],
    });
    expect(rows(store, tables.hours)).toHaveLength(3);
  });

  it('imports financial mutations as bank-transaction-v1 rows with exact amounts', async () => {
    const store = fakeStore();
    const tables = await ensureTables(store, APP);
    const summary = await syncMutations(
      store,
      get(store),
      A,
      tables.mutations,
      {
        year: YEAR,
      },
    );
    expect(summary).toEqual({ ...none, total: 6, added: 6 });
    const mutations = rows(store, tables.mutations);
    expect(mutations).toHaveLength(6);
    const amounts = mutations.map(([, p]) => p[BANK.amount]).sort();
    expect(amounts).toEqual(
      ['1210.0', '-120.5', '-45.99', '-45.99', '2500.0', '-0.35'].sort(),
    );

    for (const [, row] of mutations) {
      expect(row[IS_A]).toEqual([BANK_TRANSACTION]);
      expect(row[BANK.account]).toBe('NL00TEST0000000099');
      expect(row[BANK.currency]).toBe('EUR');
      expect(row[BANK.valueDate]).toMatch(
        new RegExp(`^${YEAR}-\\d{2}-\\d{2}$`),
      );
      expect(typeof row[BANK.amount]).toBe('string');
    }

    const properties = shortnameOf(store);
    const hosting = mutations.find(([, p]) => p[NAME] === 'Nep Hosting')![1];
    expect(hosting[properties.get('moneybird-state')!]).toBe('processed');
    expect(hosting[properties.get('moneybird-version')!]).toBe(1788960002);

    const writes = store.writes.length;
    expect(
      await syncMutations(store, get(store), A, tables.mutations, {
        year: YEAR,
      }),
    ).toEqual({ ...none, total: 6, unchanged: 6 });
    expect(store.writes.length).toBe(writes);
  });

  it('removes a column Moneybird no longer sends, and leaves other rows of the table alone', async () => {
    const store = fakeStore();
    const tables = await ensureTables(store, APP);
    // A row of the person's own in the same table.
    await store.newResource({
      parent: tables.mutations,
      isA: [BANK_TRANSACTION],
      propVals: { [NAME]: 'Cash from the drawer', [BANK.amount]: '10.00' },
    });
    await syncMutations(store, get(store), A, tables.mutations, { year: YEAR });
    expect(rows(store, tables.mutations)).toHaveLength(7);
    const read = async () =>
      financialMutations[A].map(m => ({
        ...m,
        account_servicer_transaction_id: null,
        batch_reference: null,
      }));
    expect(
      await syncMutations(
        store,
        get(store),
        A,
        tables.mutations,
        { year: YEAR },
        read,
      ),
    ).toEqual({ ...none, total: 6, updated: 2, unchanged: 4 });
    for (const [, row] of rows(store, tables.mutations))
      expect(row[BANK.reference]).toBeUndefined();
    expect(
      rows(store, tables.mutations).find(
        ([, p]) => p[NAME] === 'Cash from the drawer',
      ),
    ).toBeDefined();
  });

  it('writes nothing when the mutations read fails', async () => {
    const store = fakeStore({ mutationCap: 1 });
    const tables = await ensureTables(store, APP);
    const writes = store.writes.length;
    await expect(
      syncMutations(store, get(store), A, tables.mutations, {
        year: YEAR,
        cap: 1,
      }),
    ).rejects.toThrow(/limit for one answer/);
    expect(rows(store, tables.mutations)).toHaveLength(0);
    expect(store.writes.length).toBe(writes);
  });
});

describe('adopting', () => {
  it('declares the shared classes it renders and its row extras, once', async () => {
    const store = fakeStore();
    const adopted = await adopt(store);
    const app = store.resources.get(APP)!;
    expect(app[RENDERS_PROPERTY]).toEqual([TIME_ENTRY, BANK_TRANSACTION]);
    expect(app[ROW_EXTRAS_PROPERTY]).toEqual(adopted.extras);
    expect(adopted.extras).toHaveLength(6);
    const shortnames = shortnameOf(store);
    expect(shortnames.get('moneybird-source-id')).toBe(adopted.extras[0]);
    expect(shortnames.has('moneybird-synced-table')).toBe(true);
    const writes = store.writes.length;
    await adopt(store);
    expect(store.writes.length).toBe(writes);
  });
});

describe('controller on the app’s own table', () => {
  it('connects, asks for an administration and collections, imports all three, and keeps going when one refresh fails', async () => {
    const store = fakeStore();
    const states: string[] = [];
    const controller = createController(store, s => states.push(s.kind));
    await controller.load();
    const choosing = controller.state();
    expect(choosing.kind).toBe('choosing');
    expect(say(choosing)).toMatch(/Choose the Moneybird administration/);
    if (choosing.kind !== 'choosing') throw new Error('unreachable');
    expect(choosing.selectable).toBe(true);
    expect(choosing.collections).toEqual(['contacts', 'hours', 'mutations']);

    await controller.select(A, ['contacts', 'hours', 'mutations']);
    const synced = controller.state();
    expect(synced.kind).toBe('synced');
    if (synced.kind !== 'synced') throw new Error('unreachable');
    expect(synced.results.contacts).toEqual({ ...none, total: 5, added: 5 });
    expect(synced.results.hours).toEqual({ ...none, total: 4, added: 4 });
    expect(synced.results.mutations).toEqual({ ...none, total: 6, added: 6 });
    expect(say(synced)).toMatch(
      /5 contacts \(5 added.*4 time entries \(4 added.*6 mutations \(6 added/,
    );
    expect(rows(store)).toHaveLength(5);
    expect(rows(store, tableOf(store, TIME_ENTRY))).toHaveLength(4);
    expect(rows(store, tableOf(store, BANK_TRANSACTION))).toHaveLength(6);
    const app = store.resources.get(APP)!;
    expect(Object.values(app)).toContain(A);
    expect(Object.values(app)).toContain('contacts,hours,mutations');

    // A new view (reload) finds the stored settings and syncs; the fixture's
    // second contacts read fails, the other two collections go on, and the
    // rows stay.
    const reloaded = createController(store, () => {});
    await (
      await reloaded.load()
    ).syncing;
    const after = reloaded.state();
    expect(after.kind).toBe('synced');
    if (after.kind !== 'synced') throw new Error('unreachable');
    expect(after.results.contacts).toEqual({
      error: 'Moneybird answered 503 for contacts page 2.',
    });
    expect(after.results.hours).toEqual({ ...none, total: 4, unchanged: 4 });
    expect(say(after)).toMatch(/contacts: refresh failed: .*503.*kept/);
    expect(rows(store)).toHaveLength(5);

    await reloaded.sync();
    const again = reloaded.state();
    if (again.kind !== 'synced') throw new Error(again.kind);
    expect(again.results.contacts).toEqual({ ...none, total: 5, unchanged: 5 });
    expect(rows(store)).toHaveLength(5);
  });

  it('imports only the chosen collections, and an administration chosen by 0.1.x means contacts', async () => {
    const store = fakeStore({ outage: false });
    const controller = createController(store, () => {});
    await controller.load();
    await controller.select(A, ['mutations']);
    const synced = controller.state();
    if (synced.kind !== 'synced') throw new Error(synced.kind);
    expect(Object.keys(synced.results)).toEqual(['mutations']);
    expect(rows(store)).toHaveLength(0);

    // Settings as 0.1.1 stored them: an administration, no collections.
    const legacy = fakeStore({ outage: false });
    const first = createController(legacy, () => {});
    await first.load();
    await first.select(A, ['hours']);
    const shortnames = shortnameOf(legacy);
    delete legacy.resources.get(APP)![shortnames.get('moneybird-collections')!];
    const second = createController(legacy, () => {});
    await (
      await second.load()
    ).syncing;
    const state = second.state();
    if (state.kind !== 'synced') throw new Error(state.kind);
    expect(Object.keys(state.results)).toEqual(['contacts']);
  });

  it('refuses an import with nothing chosen', async () => {
    const store = fakeStore();
    const controller = createController(store, () => {});
    await controller.load();
    await controller.select(A, []);
    expect(controller.state().kind).toBe('error');
    expect(say(controller.state())).toMatch(/at least one collection/);
  });

  it('says so when the host has no relay or no connection', async () => {
    const noRelay = createController(fakeStore({ relay: false }), () => {});
    await noRelay.load();
    expect(noRelay.state().kind).toBe('no-relay');
    const offline = createController(fakeStore({ connected: false }), () => {});
    await offline.load();
    expect(offline.state().kind).toBe('disconnected');
  });
});

describe('controller on a table the app is a view of (#177 item 14)', () => {
  it('offers to sync a bank-transaction-v1 table, asks for the grant, binds it under the App and imports into it', async () => {
    const store = fakeStore({
      outage: false,
      foreign: { rowClass: BANK_TRANSACTION, name: 'Bank' },
    });
    const controller = createController(store, () => {});
    await controller.load();
    expect(controller.state()).toEqual({
      kind: 'unsynced',
      table: 'Bank',
      collection: 'mutations',
    });
    expect(say(controller.state())).toMatch(/Not synced with Moneybird/);
    expect(store.grant()).toBeUndefined();
    const before = structuredClone(store.resources.get(OTHER_TABLE));

    await controller.syncTable();
    expect(store.grant()?.extras).toHaveLength(6);
    const choosing = controller.state();
    if (choosing.kind !== 'choosing') throw new Error(choosing.kind);
    expect(choosing.selectable).toBe(false);
    expect(choosing.collections).toEqual(['mutations']);
    expect(say(choosing)).toMatch(/into “Bank”/);
    // The binding: a child of the App naming the table.
    const shortnames = shortnameOf(store);
    const binding = [...store.resources.entries()].find(
      ([, p]) =>
        p[PARENT] === APP &&
        p[shortnames.get('moneybird-synced-table')!] === OTHER_TABLE,
    );
    expect(binding).toBeDefined();

    await controller.select(A);
    const synced = controller.state();
    if (synced.kind !== 'synced') throw new Error(synced.kind);
    expect(synced.results).toEqual({
      mutations: { ...none, total: 6, added: 6 },
    });
    const imported = rows(store, OTHER_TABLE);
    expect(imported).toHaveLength(6);
    for (const [, row] of imported)
      expect(row[IS_A]).toEqual([BANK_TRANSACTION]);
    // The administration went on the binding, not the App; the table itself
    // was not written.
    expect(
      store.resources.get(binding![0])![
        shortnames.get('moneybird-administration')!
      ],
    ).toBe(A);
    expect(
      store.resources.get(APP)![shortnames.get('moneybird-administration')!],
    ).toBeUndefined();
    expect(store.resources.get(OTHER_TABLE)).toEqual(before);
    expect(rows(store)).toHaveLength(0);

    // A reload finds the binding and syncs again without asking.
    const reloaded = createController(store, () => {});
    await (
      await reloaded.load()
    ).syncing;
    const again = reloaded.state();
    if (again.kind !== 'synced') throw new Error(again.kind);
    expect(again.results.mutations).toEqual({
      ...none,
      total: 6,
      unchanged: 6,
    });
  });

  it('syncs hours into a time-entry-v1 table, with project and person rows in the app’s own tables', async () => {
    const store = fakeStore({
      outage: false,
      foreign: { rowClass: TIME_ENTRY, name: 'Team hours' },
    });
    const controller = createController(store, () => {});
    await controller.load();
    await controller.syncTable();
    await controller.select(A);
    const synced = controller.state();
    if (synced.kind !== 'synced') throw new Error(synced.kind);
    expect(synced.results).toEqual({ hours: { ...none, total: 4, added: 4 } });
    expect(rows(store, OTHER_TABLE)).toHaveLength(4);
    expect(rows(store, tableOf(store, WORK_PROJECT))).toHaveLength(2);
    expect(rows(store, tableOf(store, WORK_PERSON))).toHaveLength(2);
    // Only the link tables were made: no own hours or mutations table.
    expect(tableOf(store, TIME_ENTRY)).toBeUndefined();
    expect(tableOf(store, BANK_TRANSACTION)).toBeUndefined();
  });

  it('makes no own table at all for a bank-transaction-v1 table it is a view of', async () => {
    const store = fakeStore({
      outage: false,
      foreign: { rowClass: BANK_TRANSACTION, name: 'Bank' },
    });
    const controller = createController(store, () => {});
    await controller.load();
    await controller.syncTable();
    await controller.select(A);
    expect(controller.state().kind).toBe('synced');
    expect(rows(store, OTHER_TABLE)).toHaveLength(6);
    for (const klass of [
      TIME_ENTRY,
      WORK_PROJECT,
      WORK_PERSON,
      BANK_TRANSACTION,
    ])
      expect(tableOf(store, klass)).toBeUndefined();
  });

  it('leaves the table unsynced on "Not now", and pauses when the grant lapses', async () => {
    const denied = fakeStore({
      foreign: { rowClass: BANK_TRANSACTION, name: 'Bank' },
      ask: 'deny',
    });
    const controller = createController(denied, () => {});
    await controller.load();
    await controller.syncTable();
    expect(controller.state()).toMatchObject({
      kind: 'unsynced',
      message: 'Not now',
    });
    const shortnames = shortnameOf(denied);
    expect(
      [...denied.resources.values()].some(
        p => p[shortnames.get('moneybird-synced-table')!] === OTHER_TABLE,
      ),
    ).toBe(false);

    const store = fakeStore({
      outage: false,
      foreign: { rowClass: BANK_TRANSACTION, name: 'Bank' },
    });
    const bound = createController(store, () => {});
    await bound.load();
    await bound.syncTable();
    await bound.select(A);
    expect(bound.state().kind).toBe('synced');
    // The person took the grant back in the tab menu.
    const extras = store.resources.get(APP)![ROW_EXTRAS_PROPERTY];
    store.resources.get(APP)![ROW_EXTRAS_PROPERTY] = [];
    await bound.sync();
    expect(bound.state()).toEqual({
      kind: 'paused',
      table: 'Bank',
      collection: 'mutations',
    });
    expect(say(bound.state())).toMatch(/paused/);
    store.resources.get(APP)![ROW_EXTRAS_PROPERTY] = extras;
  });

  it('says a table of another class is not one it can sync', async () => {
    const store = fakeStore({ foreign: { rowClass: 'did:ad:class-notes' } });
    const controller = createController(store, () => {});
    await controller.load();
    expect(controller.state().kind).toBe('unsupported');
    expect(say(controller.state())).toMatch(/not a table this app can sync/);
  });

  it('cannot sync another table on a host without row grants', async () => {
    const store = fakeStore({
      foreign: { rowClass: BANK_TRANSACTION },
      grants: false,
    });
    const controller = createController(store, () => {});
    await controller.load();
    await controller.syncTable();
    expect(controller.state()).toMatchObject({
      kind: 'unsynced',
      message: expect.stringMatching(/host can’t/),
    });
  });
});

describe('controller on the app’s own shared-class tables', () => {
  it('opened on its own hours table, syncs only hours into it and never treats it as the contacts table', async () => {
    const store = fakeStore({
      outage: false,
      ownShared: { rowClass: TIME_ENTRY, name: 'Moneybird hours' },
    });
    // The published class is not a resource the fake knows; a contacts sync
    // would try to write RECOMMENDS and "Contact" onto it and rename the
    // table, which this placement must never do.
    const controller = createController(store, () => {});
    await controller.load();
    const choosing = controller.state();
    if (choosing.kind !== 'choosing') throw new Error(choosing.kind);
    expect(choosing.selectable).toBe(false);
    expect(choosing.collections).toEqual(['hours']);
    expect(choosing.table).toBe('Moneybird hours');

    await controller.select(A, ['contacts', 'hours', 'mutations']);
    const synced = controller.state();
    if (synced.kind !== 'synced') throw new Error(synced.kind);
    expect(Object.keys(synced.results)).toEqual(['hours']);
    expect(synced.results.hours).toEqual({ ...none, total: 4, added: 4 });
    expect(rows(store, OWN_SHARED_TABLE)).toHaveLength(4);
    for (const [, row] of rows(store, OWN_SHARED_TABLE))
      expect(row[IS_A]).toEqual([TIME_ENTRY]);
    expect(store.resources.get(OWN_SHARED_TABLE)![NAME]).toBe(
      'Moneybird hours',
    );
    expect(store.resources.has(TIME_ENTRY)).toBe(false);
    expect(rows(store)).toHaveLength(0);
    // The link tables were made, no second hours table and no mutations table.
    expect(rows(store, tableOf(store, WORK_PROJECT))).toHaveLength(2);
    expect(rows(store, tableOf(store, WORK_PERSON))).toHaveLength(2);
    expect(tableOf(store, BANK_TRANSACTION)).toBeUndefined();
    // The administration went on the App (its own table needs no binding).
    const shortnames = shortnameOf(store);
    expect(
      store.resources.get(APP)![shortnames.get('moneybird-administration')!],
    ).toBe(A);
    expect(
      [...store.resources.values()].some(
        p => p[shortnames.get('moneybird-synced-table')!] === OWN_SHARED_TABLE,
      ),
    ).toBe(false);
  });

  it('opened on its own mutations table, syncs only mutations into it', async () => {
    const store = fakeStore({
      outage: false,
      ownShared: { rowClass: BANK_TRANSACTION, name: 'Moneybird mutations' },
    });
    const controller = createController(store, () => {});
    await controller.load();
    await controller.select(A);
    const synced = controller.state();
    if (synced.kind !== 'synced') throw new Error(synced.kind);
    expect(Object.keys(synced.results)).toEqual(['mutations']);
    expect(rows(store, OWN_SHARED_TABLE)).toHaveLength(6);
    expect(store.resources.get(OWN_SHARED_TABLE)![NAME]).toBe(
      'Moneybird mutations',
    );
    expect(rows(store)).toHaveLength(0);
    for (const klass of [TIME_ENTRY, WORK_PROJECT, WORK_PERSON])
      expect(tableOf(store, klass)).toBeUndefined();
  });

  it('refuses its own projects and people tables with a note', async () => {
    for (const [rowClass, word] of [
      [WORK_PROJECT, 'projects'],
      [WORK_PERSON, 'people'],
    ] as const) {
      const store = fakeStore({
        ownShared: { rowClass, name: `Moneybird ${word}` },
      });
      const controller = createController(store, () => {});
      await controller.load();
      expect(controller.state().kind).toBe('unsupported');
      expect(say(controller.state())).toMatch(
        new RegExp(`own ${word} table.*hours table`),
      );
    }
  });

  it('on the contacts table, makes only the own tables the chosen collections write', async () => {
    const store = fakeStore({ outage: false });
    const controller = createController(store, () => {});
    await controller.load();
    await controller.select(A, ['mutations']);
    expect(controller.state().kind).toBe('synced');
    expect(rows(store, tableOf(store, BANK_TRANSACTION))).toHaveLength(6);
    for (const klass of [TIME_ENTRY, WORK_PROJECT, WORK_PERSON])
      expect(tableOf(store, klass)).toBeUndefined();

    const hoursOnly = fakeStore({ outage: false });
    const second = createController(hoursOnly, () => {});
    await second.load();
    await second.select(A, ['hours']);
    expect(second.state().kind).toBe('synced');
    expect(rows(hoursOnly, tableOf(hoursOnly, TIME_ENTRY))).toHaveLength(4);
    expect(tableOf(hoursOnly, WORK_PROJECT)).toBeDefined();
    expect(tableOf(hoursOnly, WORK_PERSON)).toBeDefined();
    expect(tableOf(hoursOnly, BANK_TRANSACTION)).toBeUndefined();
  });
});
