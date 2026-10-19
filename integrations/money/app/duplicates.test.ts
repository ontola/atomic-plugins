// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { totals } from './amounts.js';
import { createController, type State } from './controller.js';
import { firstCopy, groupDuplicates, planRemoval } from './duplicates.js';
import {
  fakeStore,
  OWN_TABLE,
  seedRow,
  SHARED_TABLE,
  type SeedRow,
} from './fakeStore.js';
import { atomic, type Txn } from './rows.js';

const txn = (subject: string, extra: Partial<Txn> = {}): Txn => ({
  subject,
  account: 'NL42BUNQ0123456789',
  currency: 'EUR',
  amount: '-12.50',
  valueDate: '2026-09-02',
  bookingDate: '2026-09-02',
  description: 'Payment',
  reference: 'REF-1',
  code: 'NTRF',
  statement: '31/1',
  sourceId: '["mt940","NL42BUNQ0123456789","EUR",["bank","REF-1"]]',
  fingerprint: 'fp-1',
  category: '',
  note: '',
  ...extra,
});

describe('groupDuplicates', () => {
  it('keeps one row per source id and fingerprint, in the order given', () => {
    const rows = [
      txn('a/2'),
      txn('b/1', { sourceId: 'other', fingerprint: 'fp-2' }),
      txn('a/1'),
      txn('a/3'),
    ];
    const { rows: kept, duplicates } = groupDuplicates(rows);
    expect(kept.map(r => r.subject)).toEqual(['b/1', 'a/1']);
    expect(duplicates.map(d => [d.subject, d.duplicateOf])).toEqual([
      ['a/2', 'a/1'],
      ['a/3', 'a/1'],
    ]);
  });

  it('never groups rows without a source id, or with another fingerprint', () => {
    const rows = [
      txn('a/1', { sourceId: '' }),
      txn('a/2', { sourceId: '' }),
      txn('a/3'),
      txn('a/4', { fingerprint: 'changed' }),
    ];
    const { rows: kept, duplicates } = groupDuplicates(rows);
    expect(kept).toHaveLength(4);
    expect(duplicates).toEqual([]);
  });

  it('keeps the lowest subject', () => {
    expect(firstCopy(txn('a'), txn('b'))).toBeLessThan(0);
    expect(firstCopy(txn('b'), txn('a'))).toBeGreaterThan(0);
  });

  it('picks the same kept row whatever order the rows are read in (two tabs)', () => {
    const rows = [txn('x/9'), txn('x/3'), txn('x/1'), txn('x/4')];
    const kept = (list: Txn[]) => groupDuplicates(list).rows[0].subject;
    const orders = [
      rows,
      [...rows].reverse(),
      [rows[2], rows[0], rows[3], rows[1]],
    ];
    expect(new Set(orders.map(kept))).toEqual(new Set(['x/1']));
  });

  it('turns a former duplicate back into a row once the row it copied is gone', () => {
    const first = groupDuplicates([txn('a/1'), txn('a/2')]);
    const again = groupDuplicates(first.duplicates);
    expect(again.rows).toHaveLength(1);
    expect('duplicateOf' in again.rows[0]).toBe(false);
  });
});

describe('planRemoval', () => {
  it('moves a category or note only a copy has, and keeps a copy that differs', () => {
    const { rows, duplicates } = groupDuplicates([
      txn('a/1', { note: 'kept note' }),
      txn('a/2', { category: 'Rent' }),
      txn('a/3', { category: 'Rent', note: 'kept note' }),
      txn('a/4', { note: 'another note' }),
      txn('a/5'),
    ]);
    expect(planRemoval(rows, duplicates)).toEqual([
      {
        subject: 'a/1',
        set: { category: 'Rent' },
        remove: ['a/2', 'a/3', 'a/5'],
        keep: ['a/4'],
      },
    ]);
  });
});

/** A controller over the store, as one tab. */
const tab = (store: ReturnType<typeof fakeStore>) => {
  const seen: State[] = [];

  return createController(store, s => seen.push(s), {
    today: () => '2026-09-24',
    tick: async () => {},
  });
};

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
};

/** Two rows of one transaction (`a` kept, `b` its copy) and one other. */
function seeded(
  data: 'own' | 'shared',
  first: Partial<SeedRow> = {},
  second: Partial<SeedRow> = {},
) {
  const store = fakeStore({ data, rowsWritable: data === 'shared' });
  const one = seedRow('-12.50', '2026-09-02', { 'bank-reference': 'R1' });
  const [a, b, c] = store.addRows([
    { ...one, ...first },
    { ...one, ...second },
    seedRow('100', '2026-09-03', { 'bank-reference': 'R2' }),
  ]);
  expect(a < b).toBe(true);

  return { store, a, b, c };
}

const tableRows = (store: ReturnType<typeof fakeStore>, table: string) =>
  [...store.resources.entries()].filter(
    ([, props]) => props[atomic.parent] === table,
  );

describe('a table with a duplicated row (#587)', () => {
  it('counts the transaction once and lists the copy, in every tab alike', async () => {
    const { store, a, b } = seeded('own');
    const one = tab(store);
    const two = tab(store);
    await one.load();
    await two.load();

    for (const controller of [one, two]) {
      const state = controller.state();
      expect(state.rows.map(r => r.subject)).toContain(a);
      expect(state.rows.map(r => r.subject)).not.toContain(b);
      expect(state.duplicates.map(d => [d.subject, d.duplicateOf])).toEqual([
        [b, a],
      ]);
      expect(state.view).toEqual({ kind: 'populated', count: 2 });
      expect(totals(state.rows)).toEqual([
        expect.objectContaining({
          in: '100',
          out: '-12.5',
          net: '87.5',
          count: 2,
        }),
      ]);
    }

    // Nothing is removed by reading.
    expect(tableRows(store, OWN_TABLE)).toHaveLength(3);
    expect(store.destroyed).toEqual([]);
  });

  it('a copy that arrives later is grouped as it arrives', async () => {
    const store = fakeStore({ data: 'own' });
    const one = seedRow('-12.50', '2026-09-02', { 'bank-reference': 'R1' });
    const [a] = store.addRows([one]);
    const controller = tab(store);
    await controller.load();
    const [b] = store.addRows([one]);
    await settle();
    expect(controller.state().duplicates.map(d => d.subject)).toEqual([b]);
    expect(controller.state().rows.map(r => r.subject)).toEqual([a]);
  });

  it('on press, moves the copy’s category onto the kept row, then destroys the copy', async () => {
    const { store, a, b } = seeded('own', {}, { 'money-category': 'Rent' });
    const controller = tab(store);
    await controller.load();
    await controller.removeDuplicates();
    await settle();
    expect(store.destroyed).toEqual([b]);
    const state = controller.state();
    expect(state.duplicates).toEqual([]);
    expect(state.rows.find(r => r.subject === a)?.category).toBe('Rent');
    expect(state.dedupe).toEqual({
      status: 'done',
      removed: 1,
      kept: 0,
      failed: 0,
      details: undefined,
    });
    expect(tableRows(store, OWN_TABLE)).toHaveLength(2);
  });

  it('on press, leaves a copy whose note differs from the kept row', async () => {
    const { store, b } = seeded(
      'own',
      { 'money-note': 'mine' },
      { 'money-note': 'theirs' },
    );
    const controller = tab(store);
    await controller.load();
    await controller.removeDuplicates();
    await settle();
    expect(store.destroyed).toEqual([]);
    const state = controller.state();
    expect(state.duplicates.map(d => d.subject)).toEqual([b]);
    expect(state.dedupe).toMatchObject({ status: 'done', removed: 0, kept: 1 });
  });

  it('a copy already gone when the button is pressed counts as removed', async () => {
    const { store, b } = seeded('own');
    const controller = tab(store);
    await controller.load();
    // Another tab removed it first, unseen by this one.
    store.resources.delete(b);
    await controller.removeDuplicates();
    expect(controller.state().dedupe).toMatchObject({
      status: 'done',
      removed: 1,
      failed: 0,
    });
    expect(controller.state().duplicates).toEqual([]);
  });

  it('a destroy that fails while the copy is still listed counts as failed', async () => {
    const { store, b } = seeded('own');
    const controller = tab(store);
    await controller.load();
    const getResource = store.getResource.bind(store);

    store.getResource = async subject => {
      const resource = await getResource(subject);

      return subject === b
        ? {
            ...resource,
            get: resource.get,
            set: resource.set,
            remove: resource.remove,
            save: resource.save,
            destroy: async () => {
              throw new Error('Host did not answer in time');
            },
          }
        : resource;
    };

    await controller.removeDuplicates();
    expect(controller.state().dedupe).toMatchObject({
      status: 'done',
      removed: 0,
      failed: 1,
      details: 'Host did not answer in time',
    });
    expect(controller.state().duplicates.map(d => d.subject)).toEqual([b]);
  });

  it('in a table that is not the app’s own, asks to edit first, and removes nothing when refused', async () => {
    const store = fakeStore({ data: 'shared', answer: 'deny' });
    const one = seedRow('-12.50', '2026-09-02', { 'bank-reference': 'R1' });
    store.addRows([one, one]);
    const controller = tab(store);
    await controller.load();
    expect(controller.state().duplicates).toHaveLength(1);
    await controller.removeDuplicates();
    expect(store.accessRequests).toBe(1);
    expect(controller.state().dedupe).toMatchObject({ status: 'refused' });
    expect(store.destroyed).toEqual([]);
    expect(tableRows(store, SHARED_TABLE)).toHaveLength(2);
  });
});
