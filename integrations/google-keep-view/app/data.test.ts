// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  acceptsClass,
  matches,
  P,
  partition,
  read,
  readResource,
  register,
  setDone,
  sources,
} from './data.js';
import { fixture, folderFixture, importedFixture } from './fixture.js';

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

describe('imported checklist tables', () => {
  it('discovers a typed Text/Checked/Position table with its own class and property IDs', async () => {
    const fake = importedFixture();
    expect(await sources(fake.store)).toEqual([
      {
        table: fake.table,
        rowClass: fake.rowClass,
        name: 'Invented groceries · List',
      },
    ]);
    expect(await acceptsClass(fake.store, fake.rowClass)).toBe(true);
  });

  it('registers the imported class for Add view and renders one checklist in stored order', async () => {
    const fake = importedFixture();
    const data = await read(fake.store, {
      table: fake.table,
      rowClass: fake.rowClass,
      name: 'List',
    });
    expect(fake.resources['did:test:view-app']['did:test:renders']).toEqual([
      fake.rowClass,
    ]);
    expect(data.notes).toHaveLength(1);
    expect(data.notes[0].title).toBe('Invented groceries · List');
    const groups = partition(data.notes[0].items);
    expect(groups.unchecked.map(item => item.text)).toEqual([
      'Pretend toast',
      'Fictional tea',
    ]);
    expect(groups.checked.map(item => item.text)).toEqual(['Imaginary apples']);
    expect(data.watches).toEqual([fake.table]);
    expect(fake.writes).toEqual(['did:test:view-app']);
  });

  it('edits the actual Checked property only under the grant on this table', async () => {
    const fake = importedFixture();
    const data = await read(fake.store, {
      table: fake.table,
      rowClass: fake.rowClass,
      name: 'List',
    });
    fake.attachTable(fake.table);
    await expect(
      setDone(fake.store, data, 'did:test:import-toast', true),
    ).rejects.toThrow('Allow editing');
    fake.grant(true);
    await setDone(fake.store, data, 'did:test:import-toast', true);
    const row = fake.resources['did:test:import-toast'];
    expect(row[fake.checked]).toBe(true);
    expect(row[fake.position]).toBe(1);
    expect(row[fake.textProperty]).toBe('Pretend toast');
  });

  it('does not offer a checkbox view for a string column merely named Checked', async () => {
    const fake = importedFixture();
    fake.resources[fake.checked][P.datatype] =
      'https://atomicdata.dev/datatypes/string';
    expect(await acceptsClass(fake.store, fake.rowClass)).toBe(false);
    expect(await sources(fake.store)).toEqual([]);
  });

  it('recognizes the Array item label used by imported list tables', async () => {
    const fake = importedFixture();
    fake.resources[fake.textProperty][P.name] = 'Array item';
    fake.resources[fake.textProperty][P.shortname] = 'custom-item-content';
    const data = await read(fake.store, {
      table: fake.table,
      rowClass: fake.rowClass,
      name: 'List',
    });
    expect(data.notes[0].items[0].text).toBe('Imaginary apples');
  });

  it('skips unrelated incomplete schemas while discovering valid checklists', async () => {
    const fake = importedFixture();
    fake.resources['did:test:broken-table'] = {
      [P.isA]: ['https://atomicdata.dev/classes/Table'],
      [P.classtype]: 'did:test:missing-class',
    };
    expect(await sources(fake.store)).toHaveLength(1);
  });
});

describe('Keep resource pages', () => {
  it('reads a migrated account folder without moving or copying any note', async () => {
    const fake = folderFixture();
    const before = Object.keys(fake.resources);
    const snapshot = await readResource(fake.store, 'did:test:notes');
    expect(snapshot.title).toBe('Google Keep fictional@example.test');
    expect(snapshot.single).toBe(false);
    expect(snapshot.notes.map(note => note.subject)).toEqual([
      'did:test:groceries',
      'did:test:thought',
    ]);
    expect(snapshot.notes[0].items).toHaveLength(4);
    expect(Object.keys(fake.resources)).toEqual(before);
    expect(fake.writes).toEqual(['did:test:view-app']);
    expect(fake.resources['did:test:groceries'][P.parent]).toBe(
      'did:test:notes',
    );
    expect(
      (
        await read(fake.store, {
          table: 'did:test:items',
          rowClass: 'did:test:item-class',
          name: 'Items',
        })
      ).notes,
    ).toHaveLength(2);
  });

  it('opens only the requested note and keeps its nested and empty items', async () => {
    const fake = folderFixture();
    fake.resources['did:test:item-2'][P.name] = '';
    const snapshot = await readResource(fake.store, 'did:test:groceries');
    expect(snapshot.single).toBe(true);
    expect(snapshot.container).toBe('did:test:notes');
    expect(snapshot.notes).toHaveLength(1);
    expect(snapshot.notes[0].subject).toBe('did:test:groceries');
    expect(snapshot.notes[0].items[2]).toMatchObject({
      text: '',
      under: 'did:test:item-1',
    });
    const text = await readResource(fake.store, 'did:test:thought');
    expect(text.notes).toHaveLength(1);
    expect(text.notes[0].body).toContain('Take the scenic route.');
  });

  it('reads a single note without enumerating sibling notes or the account items table', async () => {
    const fake = folderFixture();
    fake.resources['did:test:foreign-item'] = {
      ...fake.resources['did:test:item-0'],
      [P.parent]: 'did:test:other-items',
    };
    fake.resources['did:test:wrong-class'] = {
      ...fake.resources['did:test:item-0'],
      [P.isA]: ['did:test:note-class'],
    };
    fake.resources['did:test:sibling-item'] = {
      ...fake.resources['did:test:item-0'],
      ['did:test:google-keep-item-note']: 'did:test:thought',
    };
    const queries: { property: string; value: string }[] = [];
    const reads: string[] = [];
    const query = fake.store.query;
    const getResource = fake.store.getResource;

    fake.store.query = async args => {
      queries.push(args);

      return query(args);
    };

    fake.store.getResource = async subject => {
      reads.push(subject);

      return getResource(subject);
    };

    const snapshot = await readResource(fake.store, 'did:test:groceries');
    expect(snapshot.notes).toHaveLength(1);
    expect(snapshot.notes[0].items).toHaveLength(4);
    expect(snapshot.notes[0].items.map(item => item.subject)).not.toContain(
      'did:test:foreign-item',
    );
    expect(snapshot.notes[0].items.map(item => item.subject)).not.toContain(
      'did:test:wrong-class',
    );
    expect(queries).toContainEqual({
      property: 'did:test:google-keep-item-note',
      value: 'did:test:groceries',
    });
    expect(queries).not.toContainEqual({
      property: P.parent,
      value: 'did:test:notes',
    });
    expect(queries).not.toContainEqual({
      property: P.parent,
      value: 'did:test:items',
    });
    expect(reads).not.toContain('did:test:thought');
    expect(reads).not.toContain('did:test:sibling-item');
  });

  it('rejects an unrelated resource instead of falling back to another account', async () => {
    const fake = folderFixture();
    await expect(readResource(fake.store, 'did:test:sync-app')).rejects.toThrow(
      'not a Google Keep note or account folder',
    );
    fake.resources['did:test:groceries'][P.parent] = 'did:test:items';
    await expect(
      readResource(fake.store, 'did:test:groceries'),
    ).rejects.toThrow('not a Google Keep note or account folder');
  });

  it('does not turn a resource target into a row editing grant', async () => {
    const fake = folderFixture();
    const snapshot = await readResource(fake.store, 'did:test:groceries');
    fake.grant(true);
    fake.store.getData = async () => ({
      resource: 'did:test:groceries',
      table: 'did:test:items',
    });
    await expect(
      setDone(fake.store, snapshot, 'did:test:item-1', true),
    ).rejects.toThrow('Allow editing');
    expect(fake.resources['did:test:item-1'][fake.done]).toBe(false);
  });
});

it('advertises only note classes for resource pages and keeps table capabilities separate', async () => {
  const fake = fixture();
  await register(fake.store, ['did:test:note-class', 'did:test:item-class']);
  expect(fake.resources['did:test:view-app']['did:test:renders']).toEqual([
    'did:test:note-class',
    'did:test:item-class',
  ]);
  expect(
    fake.resources['did:test:view-app']['did:test:resource-renders'],
  ).toEqual(['did:test:note-class']);
  await register(fake.store, ['did:test:note-class', 'did:test:item-class']);
  expect(fake.writes).toEqual(['did:test:view-app']);
  const imported = importedFixture();
  await register(imported.store, [imported.rowClass]);
  expect(imported.resources['did:test:view-app']['did:test:renders']).toEqual([
    imported.rowClass,
  ]);
  expect(
    imported.resources['did:test:view-app']['did:test:resource-renders'],
  ).toBeUndefined();
});
