// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  paginate,
  readCollections,
  type OpenApiDocument,
  type Transport,
} from '../../../src/browser.js';
import { discoverReadModel } from '../../../src/read/model.js';

// #384 items 6, 7, 9 and 10a: envelopes in the collection read and in
// paginate. Invented documents and responses.

const reply = (body: unknown): ReturnType<Transport> =>
  Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(body) });

/** One collection, its Collection Object carrying `envelope` (unless undefined). */
function document(envelope?: unknown): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Envelopes', version: '1.0.0' },
    servers: [{ url: 'https://ledger.example/v1' }],
    paths: {
      '/entries': { get: { responses: { '200': { description: 'Entries' } } } },
      '/entries/{entryId}': {
        get: { responses: { '200': { description: 'An entry' } } },
      },
    },
    components: {
      crudResources: {
        entry: {
          identity: {
            urlTemplate: '/entries/{entryId}',
            bindings: { entryId: { field: 'id' } },
          },
          collections: {
            entries: {
              urlTemplate: '/entries',
              ...(envelope !== undefined ? { envelope } : {}),
            },
          },
        },
      },
    },
  };
}

async function read(
  doc: OpenApiDocument,
  body: unknown,
): Promise<{ complete: boolean; items: unknown[]; error?: string }> {
  const result = await readCollections(doc, {
    transport: vi.fn<Transport>(() => reply(body)),
  });
  const [snapshot] = result.collections;
  return {
    complete: snapshot!.complete,
    items: snapshot!.items,
    ...(snapshot!.error !== undefined ? { error: snapshot!.error } : {}),
  };
}

const rows = [{ id: 'e1' }, { id: 'e2' }];

describe('a declared items array with a non-object item (item 6)', () => {
  it('fails the read with a clear error instead of reading the array as empty', async () => {
    expect(
      await read(document({ itemsField: 'data' }), { data: ['a', 'b'] }),
    ).toEqual({
      complete: false,
      items: [],
      error:
        'Item 0 at data (the declared envelope.itemsField) is not an object',
    });
    expect(
      await read(document({ itemsField: 'data' }), { data: [{ id: 'e1' }, 7] }),
    ).toMatchObject({
      complete: false,
      error: expect.stringMatching(/^Item 1 /),
    });
  });
});

describe('null and "" mean the body root (item 7)', () => {
  it('reads itemsField null or "" as the root array, strictly', async () => {
    for (const envelope of [{ itemsField: null }, { itemsField: '' }, {}]) {
      const doc = document(envelope);
      expect(discoverReadModel(doc).collections[0]).toMatchObject(
        'itemsField' in envelope ? { itemsField: '' } : {},
      );
    }
    expect(await read(document({ itemsField: null }), rows)).toEqual({
      complete: true,
      items: rows,
    });
    // Declared root: an enveloped body is not located by the heuristic.
    expect(
      await read(document({ itemsField: null }), { items: rows }),
    ).toMatchObject({
      complete: false,
      error: 'No items array at the body root',
    });
    // Omitted: the heuristic as before.
    expect(await read(document(), { items: rows })).toMatchObject({
      complete: true,
      items: rows,
    });
  });

  it('names only the body root for a path of "" (item 9)', async () => {
    expect(
      await read(document({ itemsField: '' }), { items: rows }),
    ).toMatchObject({
      error: 'No items array at the body root',
    });
  });
});

describe("the pagination scheme's own envelope (item 10a)", () => {
  const scheme = (envelope: unknown): OpenApiDocument => ({
    openapi: '3.1.0',
    info: { title: 'Scheme envelope', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com' }],
    components: {
      paginationSchemes: {
        token: {
          type: 'pageToken',
          request: { queryParameters: { cursor: { role: 'pageToken' } } },
          response: {
            ...(envelope === undefined ? {} : { envelope: envelope as never }),
            bodyFields: { next: { role: 'nextPageToken' } },
          },
        },
      },
    },
    paths: {
      '/things': {
        get: {
          'x-pagination': [{ scheme: 'token' }],
          responses: { '200': { description: 'Things' } },
        },
      },
    },
  });

  it('locates the items at the declared dot-path, and fails when nothing is there', async () => {
    const transport = vi.fn<Transport>(async ({ url }) =>
      url.searchParams.get('cursor') === 'c2'
        ? reply({ payload: { things: [{ id: 't3' }] } })
        : reply({
            payload: { things: [{ id: 't1' }, { id: 't2' }] },
            next: 'c2',
          }),
    );
    expect(
      await paginate(scheme({ itemsField: 'payload.things' }), {
        transport,
        path: '/things',
      }),
    ).toHaveLength(3);
    await expect(
      paginate(scheme({ itemsField: 'payload.other' }), {
        transport,
        path: '/things',
      }),
    ).rejects.toThrow(
      'No items array at payload.other (the declared envelope.itemsField)',
    );
    // null: the body root, strictly.
    await expect(
      paginate(scheme({ itemsField: null }), { transport, path: '/things' }),
    ).rejects.toThrow('No items array at the body root');
  });

  it("is overridden by a Collection Object's envelope passed by the caller", async () => {
    const transport = vi.fn<Transport>(async () =>
      reply({ payload: { things: [{ id: 't1' }] }, elsewhere: [{ id: 'x' }] }),
    );
    expect(
      await paginate(scheme({ itemsField: 'payload.things' }), {
        transport,
        path: '/things',
        itemsField: 'elsewhere',
      }),
    ).toEqual([{ id: 'x' }]);
  });
});
