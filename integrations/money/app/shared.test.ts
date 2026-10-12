// @wc-ignore-file
/**
 * The shared `bank-transaction-v1` class (ontola/atomic-plugins#177 item 8):
 * what the app does on first open (`adopt.ts`, `own.ts`), how it imports
 * into a table of that class by its own writes (`write.ts`), and how the
 * importer's table still reaches it through the lens (`rows.ts`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BASE } from '../../../ontology-kit/terms.mjs';
import { adopt, importerClasses } from './adopt.js';
import {
  createController,
  NOT_A_BANK_TABLE,
  type ChosenFile,
  type State,
} from './controller.js';
import {
  APP,
  APP_CLASS_OWN,
  APP_ONTOLOGY,
  fakeStore,
  OWN_STATEMENT_CLASS,
  OWN_TABLE,
  property,
  RENDERS,
  ROW_CLASS,
  ROW_EXTRAS,
  seedRow as row,
  SHARED_TABLE,
  sharedProperty,
  type Data,
  type SeedRow,
} from './fakeStore.js';
import { ensureOwnSchema } from './own.js';
import { totals } from './amounts.js';
import { atomic, BANK_TRANSACTION, SHARED_SUBJECT } from './rows.js';

const mt940 = readFileSync(
  new URL('../fixtures/synthetic.mt940', import.meta.url),
  'utf8',
);
const camt = readFileSync(
  new URL('../fixtures/synthetic.camt053.xml', import.meta.url),
  'utf8',
);

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
};

const file = (text: string, name = 'bunq-2026-09.sta'): ChosenFile => ({
  name,
  size: text.length,
  text: async () => text,
});

function harness(options: Parameters<typeof fakeStore>[0] = {}) {
  const store = fakeStore(options);
  const seen: State[] = [];
  const controller = createController(store, s => seen.push(s), {
    today: () => '2026-09-24',
    tick: async () => {},
  });

  return { store, controller, seen };
}

/** Rows of `table`, as stored. */
const rowsOf = (store: ReturnType<typeof fakeStore>, table: string) =>
  [...store.resources.entries()]
    .filter(([, props]) => props[atomic.parent] === table)
    .map(([subject, props]) => ({ subject, ...props }));

describe('first open: the app adopts the shared class (adopt.ts, own.ts)', () => {
  it('mints its four extras, a statement class and a statements table in its own subtree, once', async () => {
    const store = fakeStore({ data: 'own' });
    const own = await ensureOwnSchema(store);
    expect(own.ontology).toBe(APP_ONTOLOGY);
    expect(own.extras).toEqual({
      'bank-source-id': `${APP_ONTOLOGY}/bank-source-id`,
      'bank-fingerprint': `${APP_ONTOLOGY}/bank-fingerprint`,
      'bank-statement': `${APP_ONTOLOGY}/bank-statement`,
      'bank-transaction-code': `${APP_ONTOLOGY}/bank-transaction-code`,
    });
    // Statement rows reuse the shared account and currency.
    expect(own.statementFields['bank-account']).toBe(
      SHARED_SUBJECT['bank-account'],
    );
    expect(own.statementFields['bank-closing-balance']).toBe(
      `${APP_ONTOLOGY}/bank-closing-balance`,
    );
    expect(own.statementClass).toBe(OWN_STATEMENT_CLASS);
    expect(store.resources.get(own.statementsTable)).toMatchObject({
      [atomic.parent]: APP,
      [atomic.classtype]: OWN_STATEMENT_CLASS,
    });
    const ontology = store.resources.get(APP_ONTOLOGY)!;
    expect(ontology[atomic.properties]).toHaveLength(12);
    expect(ontology[atomic.classes]).toEqual([
      APP_CLASS_OWN,
      OWN_STATEMENT_CLASS,
    ]);
    const made = store.created.length;
    const again = await ensureOwnSchema(store);
    expect(again).toEqual(own);
    expect(store.created).toHaveLength(made);
  });

  it('refuses a same-named Property with another datatype', async () => {
    const store = fakeStore({ data: 'own' });
    store.resources.set(`${APP_ONTOLOGY}/bank-statement`, {
      [atomic.parent]: APP_ONTOLOGY,
      [atomic.shortname]: 'bank-statement',
      [atomic.datatype]: 'https://atomicdata.dev/datatypes/integer',
    });
    store.resources.get(APP_ONTOLOGY)![atomic.properties] = [
      `${APP_ONTOLOGY}/bank-statement`,
    ];
    await expect(ensureOwnSchema(store)).rejects.toThrow(
      'already exists with another datatype',
    );
  });

  it('retargets its own table, lists what it renders and declares its row extras', async () => {
    const store = fakeStore({ data: 'own' });
    const data = await store.getData();
    const adopted = await adopt(store, data);
    expect(adopted.ownTable).toBe(true);
    expect(adopted.data?.rowClass).toBe(BANK_TRANSACTION);
    expect(store.resources.get(OWN_TABLE)![atomic.classtype]).toBe(
      BANK_TRANSACTION,
    );
    const app = store.resources.get(APP)!;
    // Its own class as created, the shared class, and the importer's class
    // found in this drive by shortname (so Add view offers Money there).
    expect(app[RENDERS]).toEqual([APP_CLASS_OWN, BANK_TRANSACTION, ROW_CLASS]);
    expect(app[ROW_EXTRAS]).toEqual([
      `${APP_ONTOLOGY}/bank-source-id`,
      `${APP_ONTOLOGY}/bank-fingerprint`,
      `${APP_ONTOLOGY}/bank-statement`,
      `${APP_ONTOLOGY}/bank-transaction-code`,
    ]);
    const saves = store.schemaSaves.length;
    await adopt(store, await store.getData());
    expect(store.schemaSaves).toHaveLength(saves);
  });

  it("finds the importer's class by shortname, never its own or a stranger's", async () => {
    const store = fakeStore({ data: 'own' });
    store.resources.set('did:ad:other/class/bank-transaction', {
      [atomic.parent]: 'did:ad:other',
      [atomic.isA]: [atomic.classClass],
      [atomic.shortname]: 'bank-transaction',
      [atomic.requires]: [atomic.name],
    });
    expect(await importerClasses(store, APP_ONTOLOGY)).toEqual([ROW_CLASS]);
  });

  it("leaves a table it does not own alone, and the importer's untouched", async () => {
    for (const data of ['shared', 'bank'] as Data[]) {
      const store = fakeStore({ data });
      const before = { ...store.resources.get(store.table) };
      const adopted = await adopt(store, await store.getData());
      expect(adopted.ownTable).toBe(false);
      expect(store.resources.get(store.table)).toEqual(before);
      expect(store.resources.get(APP)![RENDERS]).toContain(BANK_TRANSACTION);
    }
  });

  it('still lists the shared class on a host where the App has no ontology', async () => {
    const store = fakeStore({ data: 'bank', host: 'legacy' });
    const adopted = await adopt(store, await store.getData());
    expect(adopted.own).toBeUndefined();
    expect(store.resources.get(APP)![RENDERS]).toContain(BANK_TRANSACTION);
  });
});

describe('reading: the shared class by subject, the importer’s class through the lens', () => {
  it('reads the shared fields by their published subjects on a bank-transaction-v1 table', async () => {
    const { store, controller } = harness({
      data: 'own',
      rows: [row('-1.50', '2026-09-02')],
    });
    await controller.load();
    const state = controller.state();
    expect(state.source).toBe('own');
    expect(state.view).toEqual({ kind: 'populated', count: 1 });
    expect(state.fields['bank-amount']).toBe(`${BASE}/properties/bank-amount`);
    expect(state.fields['bank-source-id']).toBe(
      `${APP_ONTOLOGY}/bank-source-id`,
    );
    expect(state.rows[0]).toMatchObject({ amount: '-1.50', format: 'mt940' });
    // Never read: the app knows the shared terms; it does not fetch them.
    expect(store.resources.has(`${BASE}/properties/bank-amount`)).toBe(false);
  });

  it("reads the importer's table through its class's shortnames, as before", async () => {
    const { controller } = harness({ rows: [row('-1.50', '2026-09-02')] });
    await controller.load();
    const state = controller.state();
    expect(state.source).toBe('importer');
    expect(state.fields['bank-amount']).toBe(property('bank-amount'));
    expect(state.fields['bank-fingerprint']).toBe(property('bank-fingerprint'));
    expect(state.rows[0].amount).toBe('-1.50');
  });

  it('refuses a table of another class', async () => {
    const { controller } = harness({ data: 'other' });
    await controller.load();
    expect(controller.state().view).toEqual({
      kind: 'error',
      message: NOT_A_BANK_TABLE,
    });
  });

  it('keeps a row whose amount is not one, and leaves it out of every sum', async () => {
    const { controller } = harness({
      data: 'own',
      rows: [
        row('-1.50', '2026-09-02'),
        row('twelve', '2026-09-03'),
        row('1,50', '2026-09-04'),
      ],
    });
    await controller.load();
    expect(controller.state().view).toEqual({ kind: 'populated', count: 3 });
    expect(controller.state().rows.map(r => r.amount)).toContain('twelve');
  });
});

describe('incomplete rows (#177; ontology-kit’s rule: shown as incomplete, never skipped)', () => {
  /** A row the person left unfinished: the fixture row with `patch` applied. */
  const unfinished = (patch: Partial<SeedRow>): SeedRow => ({
    ...row('-9', '2026-09-03'),
    ...patch,
  });

  it('lists a row missing a required field apart from the ledger, with its note; a View of the table is not a row', async () => {
    const { store, controller } = harness({
      data: 'shared',
      rows: [
        row('-5', '2026-09-01'),
        unfinished({ 'bank-amount': '' }),
        unfinished({ 'bank-account': '', 'bank-currency': '' }),
      ],
    });
    // A row with no value date at all (another writer; the server refuses
    // such a commit at the pin, a lens or an older row may still hold one).
    store.resources.set(`${SHARED_TABLE}/row-no-date`, {
      [atomic.parent]: SHARED_TABLE,
      [atomic.isA]: [BANK_TRANSACTION],
      [SHARED_SUBJECT['bank-account']]: 'NL42BUNQ0123456789',
      [SHARED_SUBJECT['bank-currency']]: 'EUR',
      [SHARED_SUBJECT['bank-amount']]: '12',
    });
    // A child of the table that is not of its class: a View. Without the
    // isA check it would be listed as missing all four fields.
    store.resources.set(`${SHARED_TABLE}/view-1`, {
      [atomic.parent]: SHARED_TABLE,
      [atomic.isA]: ['https://atomicdata.dev/classes/View'],
    });
    await controller.load();
    const state = controller.state();
    expect(state.view).toEqual({ kind: 'populated', count: 1 });
    expect(state.rows.map(r => r.amount)).toEqual(['-5']);
    expect(state.incomplete.map(r => r.incomplete)).toEqual([
      'Incomplete: missing Amount',
      'Incomplete: missing Account and Currency',
      'Incomplete: missing Value date',
    ]);
    // What it does have is kept, for the listing.
    expect(state.incomplete[0]).toMatchObject({
      amount: '',
      account: 'NL42BUNQ0123456789',
      valueDate: '2026-09-03',
      description: 'Payment -9',
    });
    // Never in a balance or total: the ledger sums `rows` only.
    expect(totals(state.rows)).toEqual([
      expect.objectContaining({ net: '-5', count: 1 }),
    ]);
    expect(state.canOpenRows).toBe(true);
  });

  it('never counts an incomplete row as already imported, nor as a changed booking', async () => {
    // Same identity as the fixture's TEST-1 (seedRow derives the source id
    // from account, currency and reference), but no amount.
    const stub = row('-9', '2026-09-02', {
      'bank-amount': '',
      'bank-account': 'NL00BUNQ0000000000',
      'bank-reference': 'TEST-1',
    });
    const incomplete = harness({ data: 'shared', rows: [stub] });
    await incomplete.controller.load();
    await incomplete.controller.importFile(file(mt940));
    const sheet = incomplete.controller.state().importing;
    expect(sheet?.step).toBe('preview');
    if (sheet?.step !== 'preview') return;
    expect(sheet.preview.fresh).toHaveLength(2);
    expect(sheet.preview.already).toEqual([]);

    // The same row complete: the file's TEST-1 is then already imported.
    const complete = harness({
      data: 'shared',
      rows: [{ ...stub, 'bank-amount': '-12.34' }],
    });
    await complete.controller.load();
    await complete.controller.importFile(file(mt940));
    const again = complete.controller.state().importing;
    expect(again?.step === 'preview' && again.preview.already).toHaveLength(1);
  });

  it('moves a row into the ledger once it is completed in the host, without a reload', async () => {
    const { store, controller } = harness({
      data: 'shared',
      rows: [row('-5', '2026-09-01'), unfinished({ 'bank-amount': '' })],
    });
    await controller.load();
    const [stub] = controller.state().incomplete;
    store.resources.get(stub.subject)![SHARED_SUBJECT['bank-amount']] = '-9';
    // The table's change notification, as the host sends on any row commit.
    store.addRows([]);
    await settle();
    const state = controller.state();
    expect(state.incomplete).toEqual([]);
    expect(state.rows.map(r => r.amount).sort()).toEqual(['-5', '-9']);
    expect(state.view).toEqual({ kind: 'populated', count: 2 });
    // Completing a row is not an import.
    expect(state.arrived).toBeUndefined();
  });

  it('is populated with only incomplete rows, and opens one in the host', async () => {
    const { store, controller } = harness({
      data: 'shared',
      rows: [unfinished({ 'bank-value-date': '' })],
    });
    await controller.load();
    expect(controller.state().view).toEqual({ kind: 'populated', count: 0 });
    const [stub] = controller.state().incomplete;
    expect(stub.incomplete).toBe('Incomplete: missing Value date');
    await controller.openRow(stub.subject);
    expect(store.opened).toEqual([stub.subject]);
  });

  it('cannot offer Open row on a host without openResource', async () => {
    const { controller } = harness({
      data: 'shared',
      host: 'legacy',
      rows: [unfinished({ 'bank-amount': '' })],
    });
    await controller.load();
    expect(controller.state().canOpenRows).toBe(false);
    expect(controller.state().incomplete).toHaveLength(1);
  });
});

describe('importing into the app’s own table by its own writes (write.ts)', () => {
  it('writes shared rows and a statement row, then shows them with the closing balance', async () => {
    const { store, controller, seen } = harness({ data: 'own' });
    await controller.load();
    expect(controller.state().canApply).toBe(true);
    expect(controller.state().rowAccess).toBe('granted');
    expect(controller.state().importer).toBeUndefined();
    await controller.importFile(file(mt940));
    expect(controller.state().importing?.step).toBe('preview');
    await controller.applyImport();
    expect(controller.state().importing).toBeUndefined();
    const rows = rowsOf(store, OWN_TABLE);
    expect(rows).toHaveLength(2);
    expect(rows[0][atomic.isA]).toEqual([BANK_TRANSACTION]);
    expect(rows.map(r => r[SHARED_SUBJECT['bank-amount']]).sort()).toEqual([
      '-12.34',
      '20',
    ]);
    const lunch = rows.find(
      r => r[SHARED_SUBJECT['bank-description']] === 'Fixture lunch',
    )!;
    expect(lunch).toMatchObject({
      [atomic.name]: 'Fixture lunch',
      [SHARED_SUBJECT['bank-account']]: 'NL00BUNQ0000000000',
      [SHARED_SUBJECT['bank-currency']]: 'EUR',
      [SHARED_SUBJECT['bank-value-date']]: '2026-09-02',
      [SHARED_SUBJECT['bank-booking-date']]: '2026-09-02',
      [SHARED_SUBJECT['bank-reference']]: 'TEST-1',
      [sharedProperty('bank-transaction-code')]: 'NTRF',
      [sharedProperty('bank-statement')]: '1/1',
    });
    expect(lunch[sharedProperty('bank-source-id')]).toBe(
      JSON.stringify([
        'mt940',
        'NL00BUNQ0000000000',
        'EUR',
        ['bank', 'TEST-1'],
      ]),
    );
    expect(String(lunch[sharedProperty('bank-fingerprint')])).toMatch(
      /^mt940-content:/,
    );
    // Progress, in steps, up to rows plus statements.
    const progress = seen
      .map(s => s.importing)
      .filter(s => s?.step === 'preview' && s.progress)
      .map(s => (s?.step === 'preview' ? s.progress!.done : 0));
    expect([...new Set(progress)]).toEqual([1, 2, 3]);
    await settle();
    const state = controller.state();
    expect(state.rows).toHaveLength(2);
    expect(state.arrived).toMatchObject({ count: 2 });
    expect(state.statements).toEqual([
      expect.objectContaining({
        account: 'NL00BUNQ0000000000',
        currency: 'EUR',
        number: '1/1',
        opening: '100',
        closing: '107.66',
        entries: '2',
        format: 'mt940',
        imported: '2026-09-24',
        table: OWN_TABLE,
      }),
    ]);
  });

  it('recognises a reimport, adds camt.053 of the same period, and blocks a changed booking', async () => {
    const { store, controller } = harness({ data: 'own' });
    await controller.load();
    await controller.importFile(file(mt940));
    await controller.applyImport();
    await settle();
    const written = store.created.length;

    await controller.importFile(file(mt940));
    const again = controller.state().importing;
    expect(again?.step === 'preview' && again.tab).toBe('already');
    await controller.applyImport();
    expect(store.created).toHaveLength(written);
    expect(controller.state().importing).toBeUndefined();

    await controller.importFile(file(camt, 'bunq.xml'));
    await controller.applyImport();
    await settle();
    expect(rowsOf(store, OWN_TABLE)).toHaveLength(4);
    expect(controller.state().statements).toHaveLength(2);

    await controller.importFile(
      file(mt940.replace('Fixture lunch', 'Fixture dinner'), 'changed.sta'),
    );
    expect(controller.state().importing).toMatchObject({
      step: 'blocked',
      problem: { code: 'CHANGED_TRANSACTION' },
    });
    expect(rowsOf(store, OWN_TABLE)).toHaveLength(4);
  });

  it('keeps what was written when a row write fails, and the retry writes only the rest', async () => {
    const { store, controller } = harness({ data: 'own' });
    await controller.load();
    await controller.importFile(file(mt940));
    // The first row goes through, the second is refused.
    const original = store.newResource.bind(store);
    let calls = 0;

    store.newResource = async args => {
      if (++calls === 2) throw new Error('Simulated write failure');

      return original(args);
    };

    await controller.applyImport();
    expect(controller.state().importing).toMatchObject({
      step: 'preview',
      applying: false,
      failure: 'Simulated write failure',
    });
    store.newResource = original;
    expect(rowsOf(store, OWN_TABLE)).toHaveLength(1);
    await settle();
    controller.closeImport();
    await controller.importFile(file(mt940));
    const preview = controller.state().importing;
    expect(preview?.step === 'preview' && preview.preview.fresh).toHaveLength(
      1,
    );
    await controller.applyImport();
    await settle();
    expect(rowsOf(store, OWN_TABLE)).toHaveLength(2);
    expect(controller.state().statements).toHaveLength(1);
  });

  it('saves a category on its own rows without asking for a grant', async () => {
    const { store, controller } = harness({
      data: 'own',
      rows: [row('-23.47', '2026-09-22')],
    });
    await controller.load();
    controller.select(controller.state().rows[0].subject);
    await controller.saveNote('category', 'Groceries');
    expect(store.accessRequests).toBe(0);
    expect(store.saves).toEqual([
      {
        subject: controller.state().rows[0].subject,
        propVals: { [SHARED_SUBJECT['money-category']]: 'Groceries' },
      },
    ]);
    expect(controller.state().edits.category?.status).toBe('saved');
  });

  it('cannot import on a host where the App has no ontology, and says so', async () => {
    const { controller } = harness({ data: 'own', host: 'legacy' });
    await controller.load();
    expect(controller.state().source).toBe('own');
    expect(controller.state().canApply).toBe(false);
    await controller.importFile(file(mt940));
    expect(controller.state().importing?.step).toBe('preview');
  });
});

describe('a hand-made bank-transaction-v1 table the app is a view of', () => {
  it('reads it, and imports after the person allows editing', async () => {
    const { store, controller } = harness({
      data: 'shared',
      rows: [row('-5', '2026-09-01')],
    });
    await controller.load();
    const state = controller.state();
    expect(state.source).toBe('shared');
    expect(state.rowAccess).toBe('none');
    expect(state.canApply).toBe(true);
    await controller.importFile(file(mt940));
    await controller.applyImport();
    expect(store.accessRequests).toBe(1);
    expect(controller.state().rowAccess).toBe('granted');
    expect(controller.state().importing).toBeUndefined();
    const rows = rowsOf(store, SHARED_TABLE);
    expect(rows).toHaveLength(3);
    // The statement row goes under the App, naming the table it was for.
    await settle();
    expect(controller.state().statements).toEqual([
      expect.objectContaining({ closing: '107.66', table: SHARED_TABLE }),
    ]);
    // A second import asks no one again.
    await controller.importFile(file(camt, 'bunq.xml'));
    await controller.applyImport();
    expect(store.accessRequests).toBe(1);
    expect(rowsOf(store, SHARED_TABLE)).toHaveLength(5);
  });

  it('writes nothing when the person says no, and says why', async () => {
    const { store, controller } = harness({ data: 'shared', answer: 'deny' });
    await controller.load();
    await controller.importFile(file(mt940));
    await controller.applyImport();
    expect(store.created.filter(s => s.startsWith(SHARED_TABLE))).toEqual([]);
    expect(controller.state().importing).toMatchObject({
      step: 'preview',
      failure: expect.stringContaining("didn't allow Money to edit this table"),
    });
    expect(controller.state().rowAccess).toBe('denied');
  });

  it('cannot import where the host has no row access API', async () => {
    const { controller } = harness({ data: 'shared', host: 'legacy' });
    await controller.load();
    expect(controller.state().source).toBe('shared');
    expect(controller.state().canApply).toBe(false);
  });

  it("shows only the statements imported into this table, not another's", async () => {
    const { store, controller } = harness({ data: 'shared' });
    await controller.load();
    store.addStatements([
      {
        'bank-account': 'NL18RABO0301224456',
        'bank-currency': 'EUR',
        'bank-period-end': '2026-09-16',
        'bank-closing-balance': '19738',
        'money-table': OWN_TABLE,
      } as never,
      {
        'bank-account': 'NL18RABO0301224456',
        'bank-currency': 'EUR',
        'bank-period-end': '2026-09-17',
        'bank-closing-balance': '19739',
        'money-table': SHARED_TABLE,
      } as never,
    ]);
    await settle();
    expect(controller.state().statements?.map(s => s.closing)).toEqual([
      '19739',
    ]);
  });
});
