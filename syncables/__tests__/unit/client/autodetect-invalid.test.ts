// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  type OpenApiDocument,
  type PresenceChange,
  type Transport,
} from '../../../src/browser.js';

// A pagination scheme that auto-detection would apply to a list operation
// but that fails validation: before, it was dropped, the read made one
// request and took that page as the whole collection, so `absent: removed`
// removed every record on later pages. Now the read is not complete: the
// page's items are applied, nothing is removed or concluded from absence.
// Invented document and data.

type Row = Record<string, unknown>;

const rows: Row[] = [
  { id: '1', name: 'Rex' },
  { id: '2', name: 'Tom' },
  { id: '3', name: 'Kit' },
];

/** Pets listed two per page by `cursor`, next one in `next_cursor`. */
function document(scheme: Record<string, unknown>): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Pets', version: '1.0.0' },
    servers: [{ url: 'https://pets.example/api' }],
    paths: {
      '/pets': {
        get: {
          parameters: [{ name: 'cursor', in: 'query' }],
          responses: { '200': { description: 'A page of pets' } },
        },
      },
      '/pets/{petId}': {
        get: { responses: { '200': { description: 'A pet' } } },
      },
    },
    components: {
      paginationSchemes: { cursor: scheme },
      crudResources: {
        pet: {
          identity: {
            urlTemplate: '/pets/{petId}',
            bindings: { petId: { field: 'id' } },
          },
          collections: {
            pets: {
              urlTemplate: '/pets',
              envelope: { itemsField: 'data' },
              'x-completeness': { absent: 'removed' },
            },
          },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

const valid = {
  type: 'pageToken',
  request: { queryParameters: { cursor: { role: 'cursor' } } },
  response: { bodyFields: { next_cursor: { role: 'nextCursor' } } },
};
// Rule 26: an Incomplete Object needs `equals` or `in`.
const invalid = {
  ...valid,
  response: { ...valid.response, incomplete: { field: 'status' } },
};

function server(): { requests: string[]; transport: Transport } {
  const fake = {
    requests: [] as string[],
    transport: (async (request) => {
      fake.requests.push(request.url.pathname + request.url.search);
      const cursor = request.url.searchParams.get('cursor');
      const start = cursor ? Number(cursor) : 0;
      const page = rows.slice(start, start + 2);
      const more = start + 2 < rows.length;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: page,
          next_cursor: more ? String(start + 2) : null,
        }),
      };
    }) as Transport,
  };
  return fake;
}

describe('an invalid pagination scheme that auto-detection would apply', () => {
  it('makes the read not complete: nothing on later pages is removed', async () => {
    const storage = new InMemoryStorageAdapter();
    const first = createApiClient(document(valid), {
      transport: server().transport,
      storage,
    });
    await first.sync();
    expect((await first.list('pets')).map((r) => r['id'])).toEqual([
      '1',
      '2',
      '3',
    ]);
    const fake = server();
    const told: PresenceChange[] = [];
    const again = createApiClient(document(invalid), {
      transport: fake.transport,
      storage,
      onPresence: (changes) => {
        told.push(...changes);
      },
    });
    const result = await again.sync();
    // One request: the scheme is not applied.
    expect(fake.requests).toEqual(['/api/pets']);
    expect(result.incomplete).toEqual([
      {
        collection: 'pets',
        context: {},
        reason: expect.stringMatching(
          /"cursor" matches this operation by auto-detection but is invalid/,
        ),
      },
    ]);
    expect(told).toEqual([]);
    expect(again.presence()).toEqual([]);
    expect((await again.list('pets')).map((r) => r['id']).sort()).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('leaves a read complete when a valid scheme matches as well', async () => {
    const doc = document(valid);
    doc.components!.paginationSchemes!['broken'] = invalid as never;
    const fake = server();
    const c = createApiClient(doc, { transport: fake.transport });
    const result = await c.sync();
    expect(result.incomplete).toEqual([]);
    expect(fake.requests).toHaveLength(2);
  });
});
