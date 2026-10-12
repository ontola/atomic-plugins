// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  paginate,
  PaginationSchemeError,
  readCollections,
  resolveEffectiveScheme,
  validatePaginationScheme,
  type OpenApiDocument,
  type PaginationSchemeObject,
  type Transport,
} from '../../../src/browser.js';

// Pagination Schemes 0.7.0 §4.3.2: an offset field's `advance`. Shaped like
// Box's offset lists: `entries`, the `limit` applied, and a `total_count`
// that can exceed the entries left; the next offset is the previous offset
// plus the previous limit. Invented folders and items.

const scheme = (
  advance?: 'itemCount' | 'pageSize',
  reportsLimit = true,
): PaginationSchemeObject => ({
  type: 'pageNumber',
  autoDetect: false,
  request: {
    queryParameters: {
      offset: { role: 'offset', ...(advance ? { advance } : {}) },
      limit: { role: 'pageSize' },
    },
  },
  response: {
    envelope: { itemsField: 'entries' },
    bodyFields: {
      total_count: { role: 'totalCount' },
      ...(reportsLimit ? { limit: { role: 'pageSize' } } : {}),
    },
  },
});

function document(s: PaginationSchemeObject): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Offsets', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com/2.0' }],
    paths: {
      '/folders/{folder_id}/items': {
        get: {
          parameters: [
            { name: 'folder_id', in: 'path', required: true },
            { name: 'offset', in: 'query' },
            { name: 'limit', in: 'query' },
          ],
          'x-pagination': [{ scheme: 'limitPages' }],
          responses: { '200': { description: 'Items' } },
        },
      },
      '/items/{id}': {
        get: { responses: { '200': { description: 'One item' } } },
      },
    },
    components: {
      paginationSchemes: { limitPages: s },
      crudResources: {
        item: {
          identity: {
            urlTemplate: '/items/{id}',
            bindings: { id: { field: 'id' } },
          },
          collections: { items: { urlTemplate: '/folders/{folder_id}/items' } },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

/** `entries` items at offsets 0..entries-1, minus `holes`; pages of `limit`. */
function provider(
  entries: number,
  limit: number,
  options: { total?: number; holes?: number[]; reportLimit?: boolean } = {},
): { transport: Transport; offsets: number[] } {
  const offsets: number[] = [];
  const transport: Transport = (request) => {
    const offset = Number(request.url.searchParams.get('offset') ?? '0');
    const sent = Number(request.url.searchParams.get('limit') ?? limit);
    offsets.push(offset);
    const page: { id: string }[] = [];
    for (let i = offset; i < Math.min(entries, offset + sent); i += 1)
      if (!options.holes?.includes(i)) page.push({ id: `i${i}` });
    return Promise.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({
        entries: page,
        offset,
        ...(options.reportLimit === false ? {} : { limit: sent }),
        total_count: options.total ?? entries,
      }),
    });
  };
  return { transport, offsets };
}

const read = (
  s: PaginationSchemeObject,
  transport: Transport,
  pageSize = 4,
): Promise<unknown[]> =>
  paginate(document(s), {
    transport,
    path: '/folders/{folder_id}/items',
    pathParams: { folder_id: '0' },
    pageSize,
  });

describe('advance: pageSize', () => {
  it('steps by the reported limit over a short and an empty page', async () => {
    const { transport, offsets } = provider(10, 4, {
      holes: [2, 3, 4, 5, 6, 7],
    });
    const items = await read(scheme('pageSize'), transport);
    expect(offsets).toEqual([0, 4, 8]);
    expect(items).toEqual([
      { id: 'i0' },
      { id: 'i1' },
      { id: 'i8' },
      { id: 'i9' },
    ]);
  });

  it('runs to a total_count above the entries', async () => {
    const { transport, offsets } = provider(5, 2, { total: 8 });
    const items = await read(scheme('pageSize'), transport, 2);
    expect(offsets).toEqual([0, 2, 4, 6]);
    expect(items).toHaveLength(5);
  });

  it('steps by the page size sent when the response reports none', async () => {
    const { transport, offsets } = provider(6, 3, { reportLimit: false });
    await read(scheme('pageSize', false), transport, 3);
    expect(offsets).toEqual([0, 3]);
  });

  it('reads a whole collection with a short page inside it', async () => {
    const { transport } = provider(10, 4, { holes: [2] });
    const result = await readCollections(document(scheme('pageSize')), {
      transport,
      constants: { folder_id: '0' },
    });
    expect(result.errors).toEqual([]);
    expect(result.collections[0]!.complete).toBe(true);
    expect(result.collections[0]!.items).toHaveLength(9);
  });

  it('ends with an error when no page size is known', async () => {
    const { transport } = provider(6, 3, { reportLimit: false });
    await expect(
      paginate(document(scheme('pageSize', false)), {
        transport,
        path: '/folders/{folder_id}/items',
        pathParams: { folder_id: '0' },
      }),
    ).rejects.toThrow(/no page size to advance by/);
  });
});

describe('advance: itemCount (the default)', () => {
  it('reads a short page again from inside it, and the collection read fails', async () => {
    const { transport, offsets } = provider(10, 4, { holes: [2, 3] });
    const result = await readCollections(document(scheme()), {
      transport,
      constants: { folder_id: '0' },
    });
    expect(offsets.slice(0, 2)).toEqual([0, 2]);
    expect(result.errors.join()).toMatch(
      /holds an item an earlier page returned/,
    );
  });

  it('stops at an empty page before total_count, as before', async () => {
    const { transport } = provider(10, 4, { holes: [4, 5, 6, 7] });
    expect(await read(scheme(), transport)).toHaveLength(4);
  });
});

describe('a server that ignores the offset (review of #484)', () => {
  for (const advance of ['pageSize', 'itemCount'] as const)
    it(`ends paginate after the repeated page under ${advance}`, async () => {
      // The server answers the same two entries whatever the offset.
      let requests = 0;
      const transport: Transport = () => {
        requests += 1;
        return Promise.resolve({
          status: 200,
          headers: {},
          body: JSON.stringify({
            entries: [{ id: 'a' }, { id: 'b' }],
            limit: 2,
            total_count: 100,
          }),
        });
      };
      const s = scheme(advance);
      // Without a totalCount an itemCount read has no next page at all.
      if (advance === 'pageSize') delete s.response!.bodyFields!['total_count'];
      await expect(read(s, transport, 2)).rejects.toThrow(
        /holds an item an earlier page returned/,
      );
      expect(requests).toBe(2);
    });

  it('ends paginate on a repeated page without ids, by its fingerprint', async () => {
    let requests = 0;
    const transport: Transport = () => {
      requests += 1;
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ entries: [{ name: 'x' }], limit: 1 }),
      });
    };
    const s = scheme('pageSize');
    delete s.response!.bodyFields!['total_count'];
    await expect(read(s, transport, 1)).rejects.toThrow(
      /repeats the page before it/,
    );
    expect(requests).toBe(2);
  });
});

describe('values that are not integers (review of #484)', () => {
  for (const reported of [2.5, '2', 0, -2])
    it(`steps by the size sent when the response reports ${JSON.stringify(reported)}`, async () => {
      const offsets: number[] = [];
      const transport: Transport = (request) => {
        const offset = Number(request.url.searchParams.get('offset') ?? '0');
        offsets.push(offset);
        const entries: { id: string }[] = [];
        for (let i = offset; i < Math.min(6, offset + 3); i += 1)
          entries.push({ id: `i${i}` });
        return Promise.resolve({
          status: 200,
          headers: {},
          body: JSON.stringify({ entries, limit: reported, total_count: 6 }),
        });
      };
      await read(scheme('pageSize'), transport, 3);
      expect(offsets).toEqual([0, 3]);
    });

  it('does not take a total_count that is a string', async () => {
    const offsets: number[] = [];
    const transport: Transport = (request) => {
      const offset = Number(request.url.searchParams.get('offset') ?? '0');
      offsets.push(offset);
      const entries: { id: string }[] = [];
      for (let i = offset; i < Math.min(4, offset + 2); i += 1)
        entries.push({ id: `i${i}` });
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ entries, limit: 2, total_count: '4' }),
      });
    };
    await read(scheme('pageSize'), transport, 2);
    // Without a carried totalCount the read ends at the first empty page.
    expect(offsets).toEqual([0, 2, 4]);
  });
});

describe('validation', () => {
  it('allows advance only on an offset field, with two values (rule 24)', () => {
    expect(validatePaginationScheme('s', scheme('pageSize'))).toEqual([]);
    const onLimit = scheme();
    onLimit.request!.queryParameters!['limit']!.advance = 'pageSize';
    expect(validatePaginationScheme('s', onLimit)).toEqual([
      expect.stringMatching(/advance is allowed only on an offset field/),
    ]);
    const odd = scheme();
    (odd.request!.queryParameters!['offset'] as { advance?: unknown }).advance =
      'limit';
    expect(validatePaginationScheme('s', odd)).toEqual([
      expect.stringMatching(/advance must be itemCount or pageSize/),
    ]);
  });

  it('needs a pageSize field where pageSize advance is applied (rule 25)', () => {
    const bare = scheme('pageSize', false);
    delete bare.request!.queryParameters!['limit'];
    const doc = document(bare);
    expect(() =>
      resolveEffectiveScheme(
        doc,
        doc.paths['/folders/{folder_id}/items']!.get!,
      ),
    ).toThrow(PaginationSchemeError);
  });
});
