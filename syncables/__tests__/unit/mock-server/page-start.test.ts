// @wc-ignore-file
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMockServer,
  type MockServer,
} from '../../../src/mock-server/server.js';
import { loadOpenApiDocument } from '../../../src/openapi/load.js';
import type { OpenApiDocument } from '../../../src/openapi/types.js';
import { paginate } from '../../../src/read/read.js';
import { fetchTransport } from '../../../src/read/transport.js';
import type { WalkOutcome } from '../../../src/read/pages.js';

// A page-number scheme's first page is its `start` (Pagination Schemes
// §4.3.1, default 1). The mock server's next link and `currentPage` used
// `+ 1` whatever the start: with `start: 0` the link skipped a page, with
// `start: 2` it pointed back at the first. Through the mock and the
// client's walker, for start 0, 1 and 2, with 7 items in pages of 3.

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function document(
  type: 'nextLink' | 'pageNumber',
  start: number,
): OpenApiDocument {
  const response =
    type === 'nextLink'
      ? { next: { role: 'nextLink' }, page: { role: 'currentPage' } }
      : { page: { role: 'currentPage' }, pages: { role: 'totalPages' } };
  return {
    openapi: '3.0.3',
    info: { title: 'Items', version: '1' },
    paths: {
      '/items': {
        get: {
          'x-pagination': [{ scheme: 'paging' }],
          responses: {
            '200': {
              description: 'Items',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      items: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: { id: { type: 'string' } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: {
      paginationSchemes: {
        paging: {
          type,
          autoDetect: false,
          request: {
            queryParameters: {
              page: { role: 'page', start },
              limit: { role: 'pageSize' },
            },
          },
          response: { envelope: { itemsField: 'items' }, bodyFields: response },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

async function serve(doc: OpenApiDocument): Promise<string> {
  server = createMockServer(await loadOpenApiDocument(doc));
  return (await server.listen()).url;
}

describe.each([0, 1, 2])('a page-number scheme with start %i', (start) => {
  it('links to the next page and numbers the current one from start', async () => {
    const url = await serve(document('nextLink', start));
    const first = (await (
      await fetch(`${url}/items?page=${start}&limit=3`)
    ).json()) as Record<string, unknown>;
    expect(first['page']).toBe(start);
    const next = new URL(String(first['next']));
    expect(next.searchParams.get('page')).toBe(String(start + 1));
    const second = (await (await fetch(next)).json()) as Record<
      string,
      unknown
    >;
    expect(second['page']).toBe(start + 1);
    const ids = (body: Record<string, unknown>): unknown[] =>
      (body['items'] as { id: string }[]).map((item) => item.id);
    // The second page continues the first: no gap, no repeat.
    expect(ids(second)).not.toEqual(ids(first));
  });

  it.each(['nextLink', 'pageNumber'] as const)(
    'is read whole by the client through %s',
    async (type) => {
      const url = await serve(document(type, start));
      const outcome: WalkOutcome = { complete: true };
      const items = await paginate(
        { ...document(type, start), servers: [{ url }] },
        {
          transport: fetchTransport(fetch),
          path: '/items',
          pageSize: 3,
          outcome,
        },
      );
      expect(items).toHaveLength(7);
      expect(new Set(items.map((item) => item['id'])).size).toBe(7);
      expect(outcome.complete).toBe(true);
    },
  );
});
