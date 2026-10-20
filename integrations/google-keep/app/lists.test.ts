// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  type FlatItem,
  type ItemRow,
  listText,
  matchKeep,
  mergeList,
} from './lists.js';

const item = (text: string, done = false, depth: 0 | 1 = 0): FlatItem => ({
  text,
  done,
  depth,
});

const base = [item('Milk'), item('Bread'), item('Eggs'), item('Rye', false, 1)];

/** The drive's rows as they were at the last sync. */
const synced = (): ItemRow[] =>
  base.map((b, i) => ({
    subject: `row-${i}`,
    text: b.text,
    done: b.done,
    position: i,
    base: i,
    ...(b.depth === 1 ? { under: 'row-2' } : {}),
  }));

const flat = (items: FlatItem[]) =>
  items.map(i => `${'  '.repeat(i.depth)}${i.done ? '[x]' : '[ ]'} ${i.text}`);

describe('matchKeep', () => {
  it('pairs moved, ticked and edited items, and leaves additions unpaired', () => {
    expect(
      matchKeep(base, [
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
    expect(matchKeep(twice, [item('Milk'), item('Milk')])).toEqual([0, 1]);
  });
});

describe('mergeList', () => {
  it('changes nothing when neither side changed', () => {
    const merge = mergeList({ base, rows: synced(), keep: base });
    expect(merge.send).toBe(false);
    expect(merge.removed).toEqual([]);
    expect(merge.items.map(i => i.subject)).toEqual([
      'row-0',
      'row-1',
      'row-2',
      'row-3',
    ]);
  });

  it('moves an item moved in Keep and keeps the tick made here', () => {
    const rows = synced();
    rows[1].done = true;
    const merge = mergeList({
      base,
      rows,
      keep: [item('Bread'), item('Milk'), item('Eggs'), item('Rye', false, 1)],
    });
    expect(flat(merge.items)).toEqual([
      '[x] Bread',
      '[ ] Milk',
      '[ ] Eggs',
      '  [ ] Rye',
    ]);
    expect(merge.items[0].subject).toBe('row-1');
    expect(merge.send).toBe(true);
    expect(merge.conflicts).toBe(0);
  });

  it('takes Keep’s change alone without sending anything', () => {
    const merge = mergeList({
      base,
      rows: synced(),
      keep: [
        item('Milk', true),
        item('Bread'),
        item('Eggs'),
        item('Rye', false, 1),
      ],
    });
    expect(merge.send).toBe(false);
    expect(merge.items[0]).toMatchObject({ subject: 'row-0', done: true });
  });

  it('adds items from both sides after the item they followed', () => {
    const rows: ItemRow[] = [
      ...synced(),
      { subject: 'row-new', text: 'Butter', done: false, position: 1.5 },
    ];
    const merge = mergeList({
      base,
      rows,
      keep: [
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
    expect(merge.items[1].subject).toBeUndefined();
    expect(merge.send).toBe(true);
  });

  it('deletes on either side, unless the other side edited the item', () => {
    const rows = synced().filter(r => r.subject !== 'row-0');
    rows[0].text = 'Brown bread'; // was Bread
    const merge = mergeList({
      base,
      rows,
      keep: [item('Milk'), item('Eggs'), item('Rye', false, 1)],
    });
    expect(flat(merge.items)).toEqual([
      '[ ] Brown bread',
      '[ ] Eggs',
      '  [ ] Rye',
    ]);
    expect(merge.removed).toEqual([]);

    const gone = mergeList({
      base,
      rows: synced(),
      keep: [item('Milk'), item('Eggs'), item('Rye', false, 1)],
    });
    expect(gone.removed).toEqual(['row-1']);
    expect(gone.send).toBe(false);
  });

  it('keeps the drive’s value when both sides changed one field', () => {
    const rows = synced();
    rows[0].text = 'Oat milk';
    const merge = mergeList({
      base,
      rows,
      keep: [
        item('Soy milk'),
        item('Bread'),
        item('Eggs'),
        item('Rye', false, 1),
      ],
    });
    expect(merge.items[0]).toMatchObject({
      text: 'Oat milk',
      subject: 'row-0',
    });
    expect(merge.conflicts).toBe(1);
    expect(merge.send).toBe(true);
  });

  it('indents and outdents from either side', () => {
    const rows = synced();
    rows[1].under = 'row-0'; // Bread under Milk, here
    const merge = mergeList({
      base,
      rows,
      keep: [item('Milk'), item('Bread'), item('Eggs'), item('Rye')], // Rye out, in Keep
    });
    expect(flat(merge.items)).toEqual([
      '[ ] Milk',
      '  [ ] Bread',
      '[ ] Eggs',
      '[ ] Rye',
    ]);
  });

  it('builds a list from scratch for a note that was never a list here', () => {
    const merge = mergeList({ base: [], rows: [], keep: base });
    expect(merge.send).toBe(false);
    expect(listText(merge.items)).toBe(listText(base));
    expect(merge.items.map(i => i.keep)).toEqual([0, 1, 2, 3]);
  });
});
