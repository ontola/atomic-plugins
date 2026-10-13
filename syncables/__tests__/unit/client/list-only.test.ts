// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  type OpenApiDocument,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';

// CRUD Causality 0.6.0 §4.1: a resource without `identity` (only listed) is
// read-only. The POST-on-the-collection-URL create heuristic no longer
// applies to it, and an x-crud create of it is refused (rule 25); a
// resource with an identity still creates. A create queued before is
// parked, not sent. Invented documents and data.

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

function provider(postStatus = 201): {
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
        status: r.method === 'POST' ? postStatus : 200,
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

  it('refuses a declared x-crud create of a resource without identity (rule 25), without a request', async () => {
    const fake = provider();
    const client = createApiClient(document({ xCrudCreate: true }), {
      transport: fake.transport,
    });
    await client.sync();
    await expect(client.create('rates', { v: 2 })).rejects.toThrow(
      /declares a create but no identity \(CRUD Causality 0\.6\.0 rule 25\)/,
    );
    expect(fake.log).toEqual(['GET /rates']);
  });

  it('still creates through a declared x-crud create when the resource has an identity', async () => {
    const fake = provider();
    const client = createApiClient(
      document({ identity: true, xCrudCreate: true }),
      { transport: fake.transport },
    );
    await client.sync();
    await client.create('rates', { v: 2 });
    await expect
      .poll(() => fake.log.filter((l) => l.startsWith('POST')))
      .toEqual(['POST /rates']);
  });

  it('parks a create queued before the resource became list-only, and never sends it', async () => {
    const storage = new InMemoryStorageAdapter();
    // Queued under a document that allowed the create; the POST answers 503,
    // so it stays queued between retries.
    const before = provider(503);
    const first = createApiClient(document({ identity: true }), {
      transport: before.transport,
      storage,
      retry: { baseDelayMs: 60_000 },
    });
    await first.sync();
    await first.create('rates', { id: 'r1', v: 2 });
    await expect.poll(() => first.pendingWrites()[0]?.attempts).toBe(1);
    // The document no longer declares an identity: a list-only resource.
    const after = provider();
    const second = createApiClient(document({}), {
      transport: after.transport,
      storage,
      retry: { baseDelayMs: 1 },
    });
    await second.ready();
    expect(second.pendingWrites()).toMatchObject([
      {
        id: 'r1',
        type: 'create',
        state: 'failed',
        lastError: expect.stringMatching(
          /declares no create operation; not sent: discard it/,
        ),
      },
    ]);
    await expect(
      second.resolveWrite('rates', 'r1', { action: 'retry' }),
    ).rejects.toThrow(/cannot be sent: discard it/);
    await second.sync();
    expect(after.log.filter((l) => l.startsWith('POST'))).toEqual([]);
    await second.resolveWrite('rates', 'r1', { action: 'discard' });
    expect(second.pendingWrites()).toEqual([]);
  });
});
