// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  invalidAutoDetected,
  paginate,
  validatePaginationScheme,
  type WalkOutcome,
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

/** Also answers an `ETag`, and notes each `If-None-Match` sent. */
function server(): {
  requests: string[];
  conditional: (string | undefined)[];
  transport: Transport;
} {
  const fake = {
    requests: [] as string[],
    conditional: [] as (string | undefined)[],
    transport: (async (request) => {
      fake.requests.push(request.url.pathname + request.url.search);
      fake.conditional.push(request.headers['if-none-match']);
      const cursor = request.url.searchParams.get('cursor');
      const start = cursor ? Number(cursor) : 0;
      const page = rows.slice(start, start + 2);
      const more = start + 2 < rows.length;
      return {
        status: 200,
        headers: { etag: `"v${start}"` },
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

  it('leaves a read complete when an explicit x-pagination applies a valid scheme', async () => {
    const doc = document(invalid);
    doc.components!.paginationSchemes!['good'] = {
      ...valid,
      autoDetect: false,
    } as never;
    (doc.paths['/pets']!.get as Record<string, unknown>)['x-pagination'] = [
      { scheme: 'good' },
    ];
    const fake = server();
    const result = await createApiClient(doc, {
      transport: fake.transport,
    }).sync();
    expect(result.incomplete).toEqual([]);
    expect(fake.requests).toHaveLength(2);
  });

  it('is not opted out of by an empty x-pagination', async () => {
    const doc = document(invalid);
    (doc.paths['/pets']!.get as Record<string, unknown>)['x-pagination'] = [];
    expect(invalidAutoDetected(doc, doc.paths['/pets']!.get!)).toMatchObject({
      schemeName: 'cursor',
    });
    const result = await createApiClient(doc, {
      transport: server().transport,
    }).sync();
    expect(result.incomplete).toHaveLength(1);
  });

  it('fills paginate’s outcome as not complete', async () => {
    const outcome: WalkOutcome = { complete: true };
    const items = await paginate(document(invalid), {
      transport: server().transport,
      path: '/pets',
      method: 'GET',
      outcome,
    });
    expect(items.map((r) => r['id'])).toEqual(['1', '2']);
    expect(outcome.complete).toBe(false);
    expect(outcome.reason).toMatch(
      /"cursor" matches this operation by auto-detection but is invalid/,
    );
  });

  it('ignores a scheme too broken to compare (autoDetect: null), without throwing', async () => {
    const broken = { ...valid, autoDetect: null };
    // Invalid (the spec's schema: a boolean or an object); before, the
    // validator let it through and every read of the document threw.
    expect(validatePaginationScheme('cursor', broken as never)).toContainEqual(
      expect.stringMatching(/autoDetect must be a boolean/),
    );
    const doc = document(broken);
    expect(invalidAutoDetected(doc, doc.paths['/pets']!.get!)).toBeUndefined();
    const fake = server();
    const result = await createApiClient(doc, {
      transport: fake.transport,
    }).sync();
    // Read as unpaginated, as before: one request, complete.
    expect(fake.requests).toEqual(['/api/pets']);
    expect(result.incomplete).toEqual([]);
  });

  it('is not served from the conditional cache, unlike an unpaginated operation', async () => {
    // Unpaginated (the only scheme is valid but not auto-detected): the
    // second read is conditional.
    const plain = server();
    const unpaged = createApiClient(document({ ...valid, autoDetect: false }), {
      transport: plain.transport,
    });
    await unpaged.sync();
    await unpaged.sync();
    expect(plain.conditional).toEqual([undefined, '"v0"']);
    // An invalid scheme auto-detection would apply: never conditional.
    const fake = server();
    const c = createApiClient(document(invalid), {
      transport: fake.transport,
    });
    await c.sync();
    await c.sync();
    expect(fake.conditional).toEqual([undefined, undefined]);
  });
});
