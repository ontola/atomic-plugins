// @wc-ignore-file
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMockServer,
  type MockServer,
} from '../../../src/mock-server/server.js';
import { loadOpenApiDocument } from '../../../src/openapi/load.js';
import type { OpenApiDocument } from '../../../src/openapi/types.js';

// The mock server checks a paginated list's parameters as a provider
// does: a page size, offset, page number or (its own, numeric) page token
// that is not a whole number in range gets a 400. Before, `limit=0`
// answered `hasMore` with the same next offset forever, and `limit=abc`
// an empty page that ends a read as if complete. Invented document.

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function document(
  request: Record<string, unknown>,
  response: Record<string, unknown>,
  type: string,
): OpenApiDocument {
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
          request: { queryParameters: request },
          response: { bodyFields: response },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

const schemes = {
  offset: document(
    { offset: { role: 'offset' }, limit: { role: 'pageSize' } },
    { total: { role: 'totalCount' } },
    'pageNumber',
  ),
  page: document(
    { page: { role: 'page' }, limit: { role: 'pageSize' } },
    { pages: { role: 'totalPages' } },
    'pageNumber',
  ),
  token: document(
    { cursor: { role: 'pageToken' }, limit: { role: 'pageSize' } },
    { next: { role: 'nextPageToken' } },
    'pageToken',
  ),
};

async function get(
  doc: OpenApiDocument,
  query: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  server = createMockServer(await loadOpenApiDocument(doc));
  const { url } = await server.listen();
  const response = await fetch(`${url}/items${query}`);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('the mock server refuses a pagination parameter out of range', () => {
  it.each([
    ['offset', '?limit=0'],
    ['offset', '?limit=abc'],
    ['offset', '?limit=-2'],
    ['offset', '?limit=2.5'],
    ['offset', '?offset=-1'],
    ['offset', '?offset=x'],
    ['page', '?page=0'],
    ['page', '?page=two'],
    ['token', '?cursor=abc'],
    ['token', '?cursor=-3'],
  ] as const)('%s scheme, %s', async (scheme, query) => {
    const { status, body } = await get(schemes[scheme], query);
    expect(status).toBe(400);
    expect(String(body['error'])).toMatch(/must be a whole number/);
  });

  it.each([
    ['offset', '?offset=3&limit=2', 2],
    ['page', '?page=2&limit=3', 3],
    ['token', '?cursor=6&limit=3', 1],
    ['token', '?cursor=', 3],
  ] as const)('still answers %s scheme, %s', async (scheme, query, length) => {
    const { status, body } = await get(schemes[scheme], query);
    expect(status).toBe(200);
    expect(body['items']).toHaveLength(length);
  });
});
