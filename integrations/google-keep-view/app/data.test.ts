// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { matches, P, partition, read, setDone, sources } from './data.js';
import { fixture } from './fixture.js';

const source = {
  table: 'did:test:notes',
  rowClass: 'did:test:note-class',
  name: 'Invented notes',
};
describe('Keep table view', () => {
  it('reads note bodies and groups items by their actual note row', async () => {
    const { store, writes } = fixture();
    const data = await read(store, source);
    expect(data.notes).toHaveLength(2);
    expect(data.notes[0].items).toHaveLength(4);
    expect(data.notes[1].body).toContain('\nBring a notebook.');
    expect(data.notes[1].items).toEqual([]);
    expect(data.watches).toEqual(['did:test:notes', 'did:test:items']);
    expect(writes).toEqual(['did:test:view-app']);
    await read(store, source);
    expect(writes).toEqual(['did:test:view-app']);
  });
  it('puts unchecked items first without changing stored positions or nesting', async () => {
    const fake = fixture();
    const data = await read(fake.store, source);
    const original = data.notes[0].items.map(item => item.subject);
    const { unchecked, checked } = partition(data.notes[0].items);
    expect(unchecked.map(item => item.text)).toEqual([
      'Fictional bread',
      'Pretend jam',
    ]);
    expect(checked.map(item => item.text)).toEqual([
      'Imaginary apples',
      'Made-up tea',
    ]);
    expect(unchecked[1].under).toBe('did:test:item-1');
    expect(data.notes[0].items.map(item => item.subject)).toEqual(original);
    expect(fake.writes).not.toContain('did:test:item-0');
  });
  it('searches titles, text bodies and checked items case insensitively', async () => {
    const { store } = fixture();
    const data = await read(store, source);
    expect(matches(data.notes[0], '  APPLES  ')).toBe(true);
    expect(matches(data.notes[1], 'scenic')).toBe(true);
    expect(matches(data.notes[1], 'thought')).toBe(true);
    expect(matches(data.notes[0], 'scenic')).toBe(false);
  });
  it('discovers source tables and can read from an items table', async () => {
    const { store } = fixture();
    expect(await sources(store)).toEqual([source]);
    const data = await read(store, {
      ...source,
      table: 'did:test:items',
      rowClass: 'did:test:item-class',
    });
    expect(data.notes[0].items).toHaveLength(4);
  });
  it('does not mix tables owned by another Keep installation', async () => {
    const { store, resources } = fixture();
    resources['did:test:other-items'] = {
      [P.parent]: 'did:test:other-app',
      [P.classtype]: 'did:test:item-class',
    };
    resources['did:test:other-item'] = {
      ...resources['did:test:item-0'],
      [P.parent]: 'did:test:other-items',
    };
    expect((await read(store, source)).notes[0].items).toHaveLength(4);
  });
  it('refuses to tick from the notes table or without a live editing grant', async () => {
    const fake = fixture();
    const data = await read(fake.store, source);
    fake.attach('notes');
    fake.grant(true);
    await expect(
      setDone(fake.store, data, 'did:test:item-1', true),
    ).rejects.toThrow('Allow editing');
    fake.attach('items');
    fake.grant(false);
    await expect(
      setDone(fake.store, data, 'did:test:item-1', true),
    ).rejects.toThrow('Allow editing');
    expect(fake.resources['did:test:item-1'][fake.done]).toBe(false);
  });
  it('ticks one item, then refuses further edits when the grant is revoked', async () => {
    const fake = fixture();
    fake.attach('items');
    fake.grant(true);
    const data = await read(fake.store, source);
    await setDone(fake.store, data, 'did:test:item-1', true);
    expect(fake.resources['did:test:item-1'][fake.done]).toBe(true);
    fake.grant(false);
    await expect(
      setDone(fake.store, data, 'did:test:item-1', false),
    ).rejects.toThrow('Allow editing');
    expect(fake.writes.filter(id => id.includes('item-'))).toEqual([
      'did:test:item-1',
    ]);
  });
  it('refuses to edit an item moved out of the table', async () => {
    const fake = fixture();
    fake.attach('items');
    fake.grant(true);
    const data = await read(fake.store, source);
    fake.resources['did:test:item-1'][P.parent] = 'did:test:elsewhere';
    await expect(
      setDone(fake.store, data, 'did:test:item-1', true),
    ).rejects.toThrow('no longer');
  });
});
