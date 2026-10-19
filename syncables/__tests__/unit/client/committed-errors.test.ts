// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  prepareDocument,
  type StorageAdapter,
  type OpenApiDocument,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import {
  committedIdentity,
  createDeclaration,
  type CreateDeclaration,
} from '../../../src/client/created-identity.js';
import { petsDocument } from '../../fixtures/pets.js';

// CRUD Causality 0.8.0 §4.3.3, Committed Error Objects: a 5xx the provider
// documents as sent only after the create was applied, naming the new
// object's id in its error body (Notion's 503 with
// additional_data.committed_resource_id). Ports the reference
// committed_identity() and runs the client against it. Before, a 503 took
// the ordinary retry path and the create was sent again: a duplicate.
// Invented provider and data.

/** An in-memory StorageAdapter two clients can share, as a restart does. */
class MemoryStorage implements StorageAdapter {
  private data = new Map<string, Map<string, Record<string, unknown>>>();
  private ns(resource: string): Map<string, Record<string, unknown>> {
    let ns = this.data.get(resource);
    if (!ns) this.data.set(resource, (ns = new Map()));
    return ns;
  }
  async list(resource: string): Promise<Record<string, unknown>[]> {
    return [...this.ns(resource).values()].map((v) => structuredClone(v));
  }
  async get(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const value = this.ns(resource).get(id);
    return value && structuredClone(value);
  }
  async put(
    resource: string,
    id: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    this.ns(resource).set(id, structuredClone(value));
  }
  async delete(resource: string, id: string): Promise<void> {
    this.ns(resource).delete(id);
  }
}

const NOTION_LIKE = [
  {
    status: [503],
    identity: { petId: 'additional_data.committed_resource_id' },
    description: 'Invented, shaped like Notion request limits',
  },
];

function document(crud: Record<string, unknown> = {}): OpenApiDocument {
  const doc = prepareDocument({
    ...petsDocument,
    servers: [{ url: 'https://provider.example/api' }],
    components: {
      ...petsDocument.components,
      crudResources: {
        pet: {
          identity: {
            urlTemplate: '/pets/{petId}',
            bindings: { petId: { field: 'id' } },
          },
          collections: { pets: { urlTemplate: '/pets' } },
        },
      },
    },
  });
  doc.paths['/pets']!.post!['x-crud'] = {
    action: 'create',
    resource: 'pet',
    addedFields: { id: { source: 'generated' } },
    committedErrors: NOTION_LIKE,
    ...crud,
  };
  return doc;
}

const committed503 = (id: unknown): TransportResponse => ({
  status: 503,
  headers: {},
  body: JSON.stringify({
    object: 'error',
    code: 'service_unavailable',
    additional_data: {
      retry_guidance: 'read_object',
      committed_resource_id: id,
    },
  }),
});

describe('committedIdentity (the reference committed_identity)', () => {
  const declared = (crud: Record<string, unknown> = {}): CreateDeclaration =>
    createDeclaration(document(crud), {
      action: 'create',
      resource: 'pet',
      committedErrors: NOTION_LIKE,
      ...crud,
    })!;

  it('reads the identity from a listed status', () => {
    expect(
      committedIdentity(declared(), 503, committed503('p-9').body),
    ).toEqual({ id: 'p-9' });
    expect(committedIdentity(declared(), 503, committed503(42).body)).toEqual({
      id: '42',
    });
  });

  it.each([
    ['another status', 500, committed503('p-9').body],
    ['a body that is not JSON', 503, 'Service Unavailable'],
    [
      'only retry guidance',
      503,
      JSON.stringify({ additional_data: { retry_guidance: 'retry' } }),
    ],
    ['an empty id', 503, committed503('').body],
    ['a padded id', 503, committed503(' p-9').body],
    ['a dot segment', 503, committed503('..').body],
    ['a slash', 503, committed503('a/b').body],
    ['a query mark', 503, committed503('a?b').body],
    ['a control character', 503, committed503('a\u0007b').body],
    ['a negative number', 503, committed503(-1).body],
    ['a fraction', 503, committed503(1.5).body],
    ['an object', 503, committed503({ id: 'p-9' }).body],
  ] as const)('matches nothing for %s', (_label, status, body) => {
    expect(committedIdentity(declared(), status, body)).toBeUndefined();
  });

  it('gives only the fields the named variables bind', () => {
    // A template with a second variable the error does not name: its value
    // comes from the request, so only the named one is returned.
    const doc = document();
    (
      doc.components!['crudResources'] as Record<
        string,
        Record<string, unknown>
      >
    )['pet']!['identity'] = {
      urlTemplate: '/shops/{shopId}/pets/{petId}',
      bindings: { shopId: { field: 'shop' }, petId: { field: 'id' } },
    };
    const declaration = createDeclaration(doc, {
      action: 'create',
      resource: 'pet',
      committedErrors: [
        {
          status: [503],
          identity: { shopId: 'additional_data.committed_resource_id' },
        },
      ],
    })!;
    expect(
      committedIdentity(declaration, 503, committed503('s-1').body),
    ).toEqual({ shop: 's-1' });
  });

  it('does not step into an array, as the reference get_path does', () => {
    const declaration = declared({
      committedErrors: [
        { status: [503], identity: { petId: 'errors.length' } },
      ],
    });
    expect(
      committedIdentity(
        declaration,
        503,
        JSON.stringify({ errors: ['a', 'b'] }),
      ),
    ).toBeUndefined();
    const indexed = declared({
      committedErrors: [{ status: [503], identity: { petId: 'ids.0' } }],
    });
    expect(
      committedIdentity(indexed, 503, JSON.stringify({ ids: ['p-9'] })),
    ).toBeUndefined();
  });

  it('reads a JSON 5.0 as the integer 5 (JSON.parse cannot tell them apart)', () => {
    expect(
      committedIdentity(
        declared(),
        503,
        '{"additional_data":{"committed_resource_id":5.0}}',
      ),
    ).toEqual({ id: '5' });
  });

  it('takes the first entry that matches', () => {
    const declaration = declared({
      committedErrors: [
        { status: [503], identity: { petId: 'missing.path' } },
        ...NOTION_LIKE,
      ],
    });
    expect(
      committedIdentity(declaration, 503, committed503('p-9').body),
    ).toEqual({ id: 'p-9' });
  });

  it('ignores entries the rules refuse, and committedErrors beside followUps', () => {
    for (const committedErrors of [
      [{ status: [404], identity: { petId: 'a' } }],
      [{ status: [], identity: { petId: 'a' } }],
      [{ status: [503], identity: { notAVariable: 'a' } }],
      [{ status: [503], identity: {} }],
      'not an array',
    ])
      expect(
        createDeclaration(document(), {
          action: 'create',
          resource: 'pet',
          committedErrors,
        })?.committedErrors,
      ).toBeUndefined();
    expect(
      createDeclaration(document(), {
        action: 'create',
        resource: 'pet',
        committedErrors: NOTION_LIKE,
        followUps: [],
      })?.committedErrors,
    ).toBeUndefined();
  });
});

/** POSTs answer `answer`; GETs an empty list. */
function provider(answer: () => TransportResponse): {
  posts: TransportRequest[];
  transport: Transport;
} {
  const fake = {
    posts: [] as TransportRequest[],
    transport: (async (request) => {
      if (request.method === 'GET')
        return { status: 200, headers: {}, body: '[]' };
      fake.posts.push(request);
      return answer();
    }) as Transport,
  };
  return fake;
}

describe('a create answered by a committed error', () => {
  it('is applied, bound to the named id, and not sent again', async () => {
    const fake = provider(() => committed503('p-9'));
    const client = createApiClient(document(), {
      transport: fake.transport,
      retry: { baseDelayMs: 1 },
    });
    const local = await client.create('/pets', { name: 'Rex' });
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.posts).toHaveLength(1);
    expect(await client.get('/pets', 'p-9')).toEqual({
      name: 'Rex',
      id: 'p-9',
    });
    expect(await client.get('/pets', String(local['id']))).toBeUndefined();
  });

  it('without a declaration, a 503 is still retried, as before', async () => {
    let n = 0;
    const fake = provider(() =>
      ++n === 1
        ? committed503('p-9')
        : {
            status: 201,
            headers: {},
            body: JSON.stringify({ id: 'p-10', name: 'Rex' }),
          },
    );
    const client = createApiClient(document({ committedErrors: undefined }), {
      transport: fake.transport,
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Rex' });
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    expect(fake.posts).toHaveLength(2);
  });

  it('a listed status naming no usable id is an unknown outcome: uncertain without a key', async () => {
    const fake = provider(() => committed503(''));
    const client = createApiClient(document(), {
      transport: fake.transport,
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Rex' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()).toMatchObject([
        { type: 'create', state: 'uncertain', lastStatus: 503 },
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The provider said this status can follow an applied create: not
    // resent without a key, though a 503 otherwise means not processed.
    expect(fake.posts).toHaveLength(1);
  });

  it('a listed status naming no usable id is resent under an idempotency key', async () => {
    let n = 0;
    const fake = provider(() =>
      ++n === 1
        ? committed503('')
        : {
            status: 201,
            headers: {},
            body: JSON.stringify({ id: 'p-10', name: 'Rex' }),
          },
    );
    const client = createApiClient(document(), {
      transport: fake.transport,
      idempotencyKeyHeader: 'Idempotency-Key',
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Rex' });
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    expect(fake.posts).toHaveLength(2);
    expect(fake.posts[1]!.headers['Idempotency-Key']).toBe(
      fake.posts[0]!.headers['Idempotency-Key'],
    );
  });

  it('does not apply to an update with a matching body', async () => {
    const doc = document();
    let puts = 0;
    const transport: Transport = async (request) => {
      if (request.method === 'GET')
        return {
          status: 200,
          headers: {},
          body: JSON.stringify([{ id: 'p-1', name: 'Rex' }]),
        };
      puts += 1;
      return puts === 1
        ? committed503('p-1')
        : { status: 200, headers: {}, body: request.body ?? '{}' };
    };
    const client = createApiClient(doc, {
      transport,
      retry: { baseDelayMs: 1 },
    });
    await client.sync();
    await client.update('/pets', 'p-1', { id: 'p-1', name: 'Rex II' });
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    // A 503 to an update: the ordinary path, sent again.
    expect(puts).toBe(2);
  });

  it('wins over an x-throttling signal for the same 503', async () => {
    const doc = document();
    (doc as unknown as Record<string, unknown>)['x-throttling'] = {
      headers: { 'Retry-After': { role: 'retryAfter', unit: 'deltaSeconds' } },
      signals: [{ status: [503], meaning: 'throttled' }],
    };
    const fake = provider(() => ({
      ...committed503('p-9'),
      headers: { 'retry-after': '600' },
    }));
    const client = createApiClient(doc, {
      transport: fake.transport,
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Rex' });
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    expect(fake.posts).toHaveLength(1);
    // Not held for ten minutes: the create is settled.
    await vi.waitFor(async () =>
      expect(await client.get('/pets', 'p-9')).toMatchObject({ name: 'Rex' }),
    );
  });

  it('stays applied after a restart: nothing is sent again', async () => {
    const storage = new MemoryStorage();
    const fake = provider(() => committed503('p-9'));
    const first = createApiClient(document(), {
      transport: fake.transport,
      storage,
      retry: { baseDelayMs: 1 },
    });
    await first.create('/pets', { name: 'Rex' });
    await vi.waitFor(() => expect(first.pendingWrites()).toEqual([]));
    const again = createApiClient(document(), {
      transport: fake.transport,
      storage,
      retry: { baseDelayMs: 1 },
    });
    await again.ready();
    expect(again.pendingWrites()).toEqual([]);
    expect(await again.get('/pets', 'p-9')).toMatchObject({ name: 'Rex' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.posts).toHaveLength(1);
  });
});

describe('a create applied but unbound by a committed error', () => {
  /** A template with a second variable the error does not name. */
  function twoVariables(): OpenApiDocument {
    const doc = document({
      committedErrors: [
        {
          status: [503],
          identity: { kind: 'additional_data.committed_resource_id' },
        },
      ],
    });
    (
      doc.components!['crudResources'] as Record<
        string,
        Record<string, unknown>
      >
    )['pet']!['identity'] = {
      urlTemplate: '/pets/{kind}/{petId}',
      bindings: { kind: { field: 'kind' }, petId: { field: 'id' } },
    };
    return doc;
  }

  it('keeps the named field, is not sent again, and a later read binds it', async () => {
    let rows: Record<string, unknown>[] = [];
    const posts: TransportRequest[] = [];
    const transport: Transport = async (request) => {
      if (request.method === 'GET')
        return { status: 200, headers: {}, body: JSON.stringify(rows) };
      posts.push(request);
      // Applied: the row exists; the answer names only its kind.
      rows = [
        ...rows,
        {
          ...(JSON.parse(request.body ?? '{}') as object),
          id: 's1',
          kind: 'cat',
        },
      ];
      return committed503('cat');
    };
    const client = createApiClient(twoVariables(), {
      transport,
      retry: { baseDelayMs: 1 },
      matchUnboundCreates: { uniqueFields: { pets: ['ref'] } },
    });
    await client.sync();
    const local = String(
      (await client.create('/pets', { name: 'Rex', ref: 'a1' }))['id'],
    );
    await vi.waitFor(() =>
      expect(client.pendingWrites()).toMatchObject([
        { type: 'create', state: 'uncertain', unbound: true, lastStatus: 503 },
      ]),
    );
    expect(await client.get('/pets', local)).toMatchObject({ kind: 'cat' });
    const result = await client.sync();
    expect(result.matched).toEqual([
      { collection: 'pets', localId: local, id: 's1' },
    ]);
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    expect(posts).toHaveLength(1);
  });
});
