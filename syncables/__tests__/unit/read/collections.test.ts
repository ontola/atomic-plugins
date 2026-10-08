// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  readCollections,
  type OpenApiDocument,
  type Transport,
} from '../../../src/browser.js';
import { discoverReadModel } from '../../../src/read/model.js';

// #373: the collection read locates the items array through the CRUD
// Causality Collection Object's `envelope.itemsField` (the Envelope Object
// of Pagination Schemes §4.4.2), a dot-path. Without the declaration, the
// array is located as before. Documents and responses are invented.

const reply = (body: unknown, status = 200): ReturnType<Transport> =>
  Promise.resolve({ status, headers: {}, body: JSON.stringify(body) });

/** A one-collection document whose Collection Object carries `envelope`. */
function document(envelope?: unknown): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Envelopes', version: '1.0.0' },
    servers: [{ url: 'https://ledger.example/v1' }],
    paths: {
      '/books/{bookId}/entries': {
        get: { responses: { '200': { description: 'The entries' } } },
      },
      '/books/{bookId}/entries/{entryId}': {
        get: { responses: { '200': { description: 'An entry' } } },
      },
    },
    components: {
      crudResources: {
        entry: {
          identity: {
            urlTemplate: '/books/{bookId}/entries/{entryId}',
            bindings: { entryId: { field: 'id' } },
          },
          collections: {
            entries: {
              urlTemplate: '/books/{bookId}/entries',
              ...(envelope !== undefined ? { envelope } : {}),
            },
          },
        },
      },
    },
  };
}

const rows = [
  { id: 'e1', amount: '-12.50' },
  { id: 'e2', amount: '40.00' },
];

async function read(
  doc: OpenApiDocument,
  body: unknown,
): Promise<{
  complete: boolean;
  items: Record<string, unknown>[];
  error?: string;
  errors: string[];
}> {
  const transport = vi.fn<Transport>(() => reply(body));
  const result = await readCollections(doc, {
    transport,
    constants: { bookId: 'b1' },
  });
  expect(transport).toHaveBeenCalledTimes(1);
  const [snapshot] = result.collections;
  return {
    complete: snapshot!.complete,
    items: snapshot!.items,
    ...(snapshot!.error !== undefined ? { error: snapshot!.error } : {}),
    errors: result.errors,
  };
}

describe('the Collection Object envelope', () => {
  it('is read into the model as itemsField when it is a non-empty string', () => {
    const [entries] = discoverReadModel(
      document({ itemsField: 'data.entries' }),
    ).collections;
    expect(entries).toMatchObject({
      name: 'entries',
      itemsField: 'data.entries',
    });
    for (const envelope of [
      undefined,
      {},
      { itemsField: null },
      { itemsField: '' },
      { itemsField: 7 },
      'data.entries',
    ])
      expect(
        discoverReadModel(document(envelope)).collections[0],
      ).not.toHaveProperty('itemsField');
  });

  it('reads the items at a nested dot-path', async () => {
    expect(
      await read(document({ itemsField: 'response.data.entries' }), {
        response: {
          data: { entries: rows, server_knowledge: 12 },
          meta: { page: 1 },
        },
      }),
    ).toEqual({ complete: true, items: rows, errors: [] });
  });

  it('reports a missing path as an incomplete read with a clear error, not an empty collection', async () => {
    expect(
      await read(document({ itemsField: 'data.entries' }), {
        data: { items: rows },
      }),
    ).toEqual({
      complete: false,
      items: [],
      error:
        'No items array at data.entries (the declared envelope.itemsField)',
      errors: [
        'entries: No items array at data.entries (the declared envelope.itemsField)',
      ],
    });
  });

  it('reports a path that holds a non-array the same way', async () => {
    expect(
      await read(document({ itemsField: 'data' }), { data: { entries: rows } }),
    ).toMatchObject({
      complete: false,
      items: [],
      error: expect.stringMatching(/^No items array at data /),
    });
  });

  it('does not use the heuristic when an envelope is declared: a top-level array body is not the declared path', async () => {
    expect(
      await read(document({ itemsField: 'data.entries' }), rows),
    ).toMatchObject({ complete: false, items: [] });
  });

  for (const [label, envelope] of [
    ['omitted', undefined],
    ['null (the body root is the array)', { itemsField: null }],
    ['not a string (ignored)', { itemsField: 7 }],
  ] as const)
    it(`locates the array as before when the envelope is ${label}: a top-level array, or a common envelope name`, async () => {
      const doc = document(envelope);
      expect(await read(doc, rows)).toEqual({
        complete: true,
        items: rows,
        errors: [],
      });
      expect(await read(doc, { items: rows, total: 2 })).toEqual({
        complete: true,
        items: rows,
        errors: [],
      });
      expect(await read(doc, { data: { entries: rows } })).toMatchObject({
        complete: false,
        error: 'Could not locate the items array in the response',
      });
    });
});
