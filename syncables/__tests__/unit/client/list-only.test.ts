// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  type OpenApiDocument,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';

// CRUD Causality 0.6.0 §4.1: a resource without `identity` (only listed) is
// read-only. The POST-on-the-collection-URL create heuristic no longer
// applies to it; a resource with an identity, or an x-crud create, still
// creates. Invented documents and data.

const ok = { '200': { description: 'ok' } };

function document(options: {
  identity?: boolean;
  xCrudCreate?: boolean;
}): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Rates', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/rates': {
        get: { responses: ok },
        post: {
          requestBody: { content: { 'application/json': { schema: {} } } },
          responses: { '201': { description: 'Created' } },
          ...(options.xCrudCreate
            ? {
                'x-crud': {
                  action: 'create',
                  resource: 'rate',
                  url: { source: 'bodyField', name: 'id' },
                },
              }
            : {}),
        },
      },
      '/rates/{rateId}': { get: { responses: ok } },
    },
    components: {
      crudResources: {
        rate: {
          ...(options.identity
            ? {
                identity: {
                  urlTemplate: '/rates/{rateId}',
                  bindings: { rateId: { field: 'id' } },
                },
              }
            : {}),
          collections: { rates: { urlTemplate: '/rates' } },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

function provider(): {
  log: string[];
  transport: (r: TransportRequest) => Promise<TransportResponse>;
} {
  const log: string[] = [];
  return {
    log,
    transport: async (r): Promise<TransportResponse> => {
      log.push(`${r.method} ${r.url.pathname}`);
      const body =
        r.method === 'POST' ? { id: 'new', v: 1 } : [{ id: 'a', v: 1 }];
      return {
        status: r.method === 'POST' ? 201 : 200,
        headers: {},
        body: JSON.stringify(body),
      };
    },
  };
}

describe('a list-only resource (no identity) is read-only', () => {
  it('reads its collection, and create() throws without a request', async () => {
    const fake = provider();
    const client = createApiClient(document({}), {
      transport: fake.transport,
    });
    await client.sync();
    expect(await client.list('rates')).toEqual([{ id: 'a', v: 1 }]);
    await expect(client.create('rates', { v: 2 })).rejects.toThrow(
      /declares no create operation/,
    );
    expect(client.pendingWrites()).toEqual([]);
    expect(fake.log).toEqual(['GET /rates']);
  });

  it('still creates through the collection POST when the resource has an identity', async () => {
    const fake = provider();
    const client = createApiClient(document({ identity: true }), {
      transport: fake.transport,
    });
    await client.sync();
    await client.create('rates', { v: 2 });
    await expect
      .poll(() => fake.log.filter((l) => l.startsWith('POST')))
      .toEqual(['POST /rates']);
  });

  it('still creates through a declared x-crud create', async () => {
    const fake = provider();
    const client = createApiClient(document({ xCrudCreate: true }), {
      transport: fake.transport,
    });
    await client.sync();
    await client.create('rates', { v: 2 });
    await expect
      .poll(() => fake.log.filter((l) => l.startsWith('POST')))
      .toEqual(['POST /rates']);
  });
});
