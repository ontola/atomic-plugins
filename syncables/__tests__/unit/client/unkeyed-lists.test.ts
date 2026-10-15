import { describe, expect, it } from 'vitest';
import {
  flattenList,
  mergeUnkeyedList,
  nestList,
  pairItems,
  unkeyedListsOf,
  type FlatListItem,
  type LocalListItem,
  type UnkeyedList,
} from '../../../src/client/unkeyed-lists.js';
import type { OpenApiDocument } from '../../../src/browser.js';

// CRUD Causality 0.7.0 §4.9, on a Google Keep-shaped list (the spec's
// §7.8): items are `{ text: { text }, checked }` with `childListItems`.

const spec: UnkeyedList = {
  match: ['text.text', 'checked'],
  children: 'childListItems',
};

const item = (
  text: string,
  checked = false,
  depth: 0 | 1 = 0,
): FlatListItem => ({
  value: { text: { text }, checked },
  depth,
});

const base = [item('Milk'), item('Bread'), item('Eggs'), item('Rye', false, 1)];

/** The local items as they were at the last sync. */
const synced = (): LocalListItem[] =>
  base.map((b, i) => ({
    id: `row-${i}`,
    value: structuredClone(b.value),
    position: i,
    base: i,
    ...(b.depth === 1 ? { under: 'row-2' } : {}),
  }));

const text = (value: Record<string, unknown>): string =>
  (value['text'] as { text: string }).text;

const flat = (items: FlatListItem[]): string[] =>
  items.map(
    (i) =>
      `${'  '.repeat(i.depth)}${i.value['checked'] ? '[x]' : '[ ]'} ${text(i.value)}`,
  );

const edit = (row: LocalListItem, patch: Record<string, unknown>): void => {
  row.value = { ...row.value, ...patch };
};

describe('unkeyedListsOf', () => {
  const document = (lists: unknown): OpenApiDocument =>
    ({
      openapi: '3.0.3',
      paths: {},
      components: { crudResources: { note: { unkeyedLists: lists } } },
    }) as unknown as OpenApiDocument;

  it('reads the declaration', () => {
    expect(
      unkeyedListsOf(document({ 'body.list.listItems': spec }), 'note'),
    ).toEqual({ 'body.list.listItems': spec });
    expect(unkeyedListsOf(document(undefined), 'other')).toEqual({});
  });

  it('refuses what rule 29 refuses', () => {
    for (const lists of [
      [],
      { 'a..b': { match: ['x'] } },
      { a: { match: [] } },
      { a: { match: ['x', 'x'] } },
      { a: { match: ['x'], children: 'x' } },
      { a: 'x' },
    ])
      expect(unkeyedListsOf(document(lists), 'note')).toHaveProperty('refused');
  });
});

describe('flattenList and nestList', () => {
  it('flattens children after their parent and nests them back', () => {
    const list = [
      {
        text: { text: 'Trip' },
        checked: false,
        childListItems: [{ text: { text: 'Charger' }, checked: true }],
      },
      { text: { text: 'Tickets' }, checked: false },
    ];
    const items = flattenList(list, spec);
    expect(flat(items)).toEqual(['[ ] Trip', '  [x] Charger', '[ ] Tickets']);
    expect(nestList(items, spec)).toEqual(list);
  });

  it('makes a child with no item above it a top item', () => {
    expect(nestList([item('Orphan', false, 1)], spec)).toEqual([
      { text: { text: 'Orphan' }, checked: false },
    ]);
  });
});

describe('pairItems', () => {
  it('pairs moved, ticked and edited items, and leaves additions unpaired', () => {
    expect(
      pairItems(spec, base, [
        item('Eggs', true),
        item('Milk'),
        item('Toast'),
        item('Rye', false, 1),
        item('Jam'),
      ]),
    ).toEqual([2, 0, 1, 3, undefined]);
  });

  it('pairs duplicates by nearest position', () => {
    const twice = [item('Milk'), item('Milk')];
    expect(pairItems(spec, twice, [item('Milk'), item('Milk')])).toEqual([
      0, 1,
    ]);
  });

  it('agrees with the spec example (§7.8)', () => {
    expect(
      pairItems(
        spec,
        [item('Milk'), item('Eggs', true)],
        [item('Eggs', true), item('Milk')],
      ),
    ).toEqual([1, 0]);
  });
});

describe('mergeUnkeyedList', () => {
  it('changes nothing when neither side changed', () => {
    const merge = mergeUnkeyedList({
      spec,
      base,
      local: synced(),
      remote: base,
    });
    expect(merge.send).toBe(false);
    expect(merge.removed).toEqual([]);
    expect(merge.items.map((i) => i.id)).toEqual([
      'row-0',
      'row-1',
      'row-2',
      'row-3',
    ]);
  });

  it('moves an item moved remotely and keeps the tick made here', () => {
    const local = synced();
    edit(local[1]!, { checked: true });
    const merge = mergeUnkeyedList({
      spec,
      base,
      local,
      remote: [
        item('Bread'),
        item('Milk'),
        item('Eggs'),
        item('Rye', false, 1),
      ],
    });
    expect(flat(merge.items)).toEqual([
      '[x] Bread',
      '[ ] Milk',
      '[ ] Eggs',
      '  [ ] Rye',
    ]);
    expect(merge.items[0]!.id).toBe('row-1');
    expect(merge.send).toBe(true);
    expect(merge.conflicts).toBe(0);
  });

  it('takes a remote change alone without sending anything', () => {
    const merge = mergeUnkeyedList({
      spec,
      base,
      local: synced(),
      remote: [
        item('Milk', true),
        item('Bread'),
        item('Eggs'),
        item('Rye', false, 1),
      ],
    });
    expect(merge.send).toBe(false);
    expect(merge.items[0]).toMatchObject({
      id: 'row-0',
      value: { checked: true },
    });
  });

  it('adds items from both sides after the item they followed', () => {
    const local: LocalListItem[] = [
      ...synced(),
      { id: 'row-new', value: item('Butter').value, position: 1.5 },
    ];
    const merge = mergeUnkeyedList({
      spec,
      base,
      local,
      remote: [
        item('Milk'),
        item('Jam'),
        item('Bread'),
        item('Eggs'),
        item('Rye', false, 1),
      ],
    });
    expect(flat(merge.items)).toEqual([
      '[ ] Milk',
      '[ ] Jam',
      '[ ] Bread',
      '[ ] Butter',
      '[ ] Eggs',
      '  [ ] Rye',
    ]);
    expect(merge.items[1]!.id).toBeUndefined();
    expect(merge.items[1]!.remote).toBe(1);
    expect(merge.send).toBe(true);
  });

  it('deletes on either side, unless the other side edited the item', () => {
    const local = synced().filter((r) => r.id !== 'row-0');
    edit(local[0]!, { text: { text: 'Brown bread' } }); // was Bread
    const merge = mergeUnkeyedList({
      spec,
      base,
      local,
      remote: [item('Milk'), item('Eggs'), item('Rye', false, 1)],
    });
    expect(flat(merge.items)).toEqual([
      '[ ] Brown bread',
      '[ ] Eggs',
      '  [ ] Rye',
    ]);
    expect(merge.removed).toEqual([]);

    const gone = mergeUnkeyedList({
      spec,
      base,
      local: synced(),
      remote: [item('Milk'), item('Eggs'), item('Rye', false, 1)],
    });
    expect(gone.removed).toEqual(['row-1']);
    expect(gone.send).toBe(false);
  });

  it('keeps the local value when both sides changed one field', () => {
    const local = synced();
    edit(local[0]!, { text: { text: 'Oat milk' } });
    const merge = mergeUnkeyedList({
      spec,
      base,
      local,
      remote: [
        item('Soy milk'),
        item('Bread'),
        item('Eggs'),
        item('Rye', false, 1),
      ],
    });
    expect(text(merge.items[0]!.value)).toBe('Oat milk');
    expect(merge.items[0]!.id).toBe('row-0');
    expect(merge.conflicts).toBe(1);
    expect(merge.send).toBe(true);
  });

  it('merges different fields of one item from both sides', () => {
    const local = synced();
    edit(local[0]!, { text: { text: 'Oat milk' } });
    const merge = mergeUnkeyedList({
      spec,
      base,
      local,
      remote: [
        item('Milk', true),
        item('Bread'),
        item('Eggs'),
        item('Rye', false, 1),
      ],
    });
    expect(flat(merge.items)[0]).toBe('[x] Oat milk');
    expect(merge.conflicts).toBe(0);
  });

  it('indents and outdents from either side', () => {
    const local = synced();
    local[1]!.under = 'row-0'; // Bread under Milk, here
    const merge = mergeUnkeyedList({
      spec,
      base,
      local,
      remote: [item('Milk'), item('Bread'), item('Eggs'), item('Rye')], // Rye out, remotely
    });
    expect(flat(merge.items)).toEqual([
      '[ ] Milk',
      '  [ ] Bread',
      '[ ] Eggs',
      '[ ] Rye',
    ]);
  });

  it('keeps every item at the top without a children field', () => {
    const flatBase = base.map((b) => ({ ...b, depth: 0 as const }));
    const local: LocalListItem[] = flatBase.map((b, i) => ({
      id: `row-${i}`,
      value: b.value,
      position: i,
      base: i,
      ...(i === 1 ? { under: 'row-0' } : {}),
    }));
    const merge = mergeUnkeyedList({
      spec: { match: ['text.text'] },
      base: flatBase,
      local,
      remote: flatBase,
    });
    expect(merge.items.every((i) => i.depth === 0)).toBe(true);
  });

  it('builds a list from scratch for one never synced', () => {
    const merge = mergeUnkeyedList({ spec, base: [], local: [], remote: base });
    expect(merge.send).toBe(false);
    expect(flat(merge.items)).toEqual(flat(base));
    expect(merge.items.map((i) => i.remote)).toEqual([0, 1, 2, 3]);
  });
});
