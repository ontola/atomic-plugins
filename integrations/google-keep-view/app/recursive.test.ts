// @wc-ignore-file
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { recursiveAtomicProjector } from '../../../syncables/src/daemon/recursive-atomic.js';
import { nodeHash } from '../../../syncables/src/postgres/json-graph.js';
import { JSDOM } from '../../../browser/data-browser/node_modules/jsdom/lib/api.js';
import { acceptsClass, sources, read, P } from './data.js';
import { view } from './main.js';
import type { Resource, Store, Value } from './store.js';

function fixture() {
  const raw = readFileSync(
    new URL(
      '../../../syncables/examples/daemon/google-keep.json',
      import.meta.url,
    ),
    'utf8',
  );
  const projection = recursiveAtomicProjector({
    document: JSON.parse(raw),
    documentHash: nodeHash(raw),
    resource: 'note',
    namespace: 'invented/keep/view',
  }).project({
    'urn:test:note': JSON.stringify({
      '@id': 'urn:test:note',
      'urn:syncables:property:source-id': 'notes/invented',
      'urn:syncables:property:source-json': {
        title: 'Invented groceries',
        body: {
          list: {
            listItems: [
              { text: { text: 'Already bought' }, checked: true },
              {
                text: { text: 'Still needed' },
                checked: false,
                childListItems: [
                  { text: { text: 'A nested item' }, checked: false },
                ],
              },
              { text: { text: 'Still needed' }, checked: false },
            ],
          },
        },
      },
    }),
  });
  const rows: Record<string, Record<string, Value>> = Object.fromEntries(
    Object.entries(projection.resources).map(([id, value]) => [
      id,
      JSON.parse(value),
    ]),
  );
  rows['urn:test:view'] = { [P.isA]: ['urn:test:view-class'] };
  rows['urn:test:view-class'] = { [P.recommends]: ['urn:test:renders'] };
  rows['urn:test:renders'] = { [P.shortname]: 'renders' };
  const get = (id: string): Resource => {
    const values = rows[id];
    if (!values) throw Error('Missing fixture resource');
    return {
      subject: id,
      get: p => values[p],
      set(p, v) {
        values[p] = v;
        return this;
      },
      async save() {
        return this;
      },
    };
  };
  const store: Store = {
    getApp: async () => 'urn:test:view',
    getData: async () => undefined,
    getResource: async id => get(id),
    query: async ({ property, value }) =>
      Object.entries(rows)
        .filter(
          ([, row]) =>
            row[property] === value ||
            (Array.isArray(row[property]) &&
              (row[property] as Value[]).includes(value)),
        )
        .map(([id]) => id),
    subscribe: () => () => {},
    rowAccess: async () => ({ status: 'none' }),
  };
  return { rows, store };
}

describe('OpenAPI-derived Google Keep resources', () => {
  it('discovers the exact supported Note class and traverses typed nested resources', async () => {
    const { store, rows } = fixture();
    const found = await sources(store);
    expect(found).toHaveLength(1);
    expect(await acceptsClass(store, found[0].rowClass)).toBe(true);
    const snapshot = await read(store, found[0]);
    expect(snapshot.notes).toHaveLength(1);
    expect(
      snapshot.notes[0].items.map(i => [i.text, i.done, i.position]),
    ).toEqual([
      ['Already bought', true, 0],
      ['Still needed', false, 1],
      ['A nested item', false, 2],
      ['Still needed', false, 3],
    ]);
    expect(snapshot.notes[0].items[2].under).toBe(
      snapshot.notes[0].items[1].subject,
    );
    expect(new Set(snapshot.notes[0].items.map(i => i.subject)).size).toBe(4);
    expect(snapshot.readOnlyReason).toBeDefined();
    expect(snapshot.itemTable).toBeUndefined();
    expect(snapshot.watches.length).toBeGreaterThan(3);
    expect(rows['urn:test:view']['urn:test:renders']).toEqual([
      found[0].rowClass,
    ]);
  });
  it('renders the unchanged source model as cards with disabled checkboxes', async () => {
    const { store } = fixture();
    const dom = new JSDOM('<main id="root"></main>');
    const root = dom.window.document.getElementById('root')!;
    await view({ root, store });
    expect(root.querySelector('h2')?.textContent).toBe('Invented groceries');
    expect(root.querySelector('[role=status]')?.textContent).toBe('1 note');
    expect(
      [
        ...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]'),
      ].every(input => input.disabled),
    ).toBe(true);
    expect(root.querySelector('.keep-indented')?.textContent).toBe(
      'A nested item',
    );
    dom.window.close();
  });
  it('does not offer the view on a different document with identical labels', async () => {
    const { store, rows } = fixture();
    const found = await sources(store);
    rows[found[0].rowClass]['urn:syncables:atomic:v1:document-hash'] =
      '0'.repeat(64);
    expect(await acceptsClass(store, found[0].rowClass)).toBe(false);
    expect(await sources(store)).toEqual([]);
  });
});
