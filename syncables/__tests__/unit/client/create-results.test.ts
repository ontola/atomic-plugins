// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  prepareDocument,
  type ApiClient,
  type OpenApiDocument,
  type StorageAdapter,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import {
  createDeclaration,
  createdIdentity,
  type CreateDeclaration,
} from '../../../src/client/created-identity.js';
import { petsDocument } from '../../fixtures/pets.js';

// CRUD Causality create results: §4.3.2 (Url Source Object, with the
// identity template read in reverse) and §4.4–4.5 (Added Field Objects,
// `generated`), with 0.5.0's rule that a create the provider accepted but
// whose identity cannot be determined is unbound and never sent again
// (`created_identity()` in the spec's validate.py, #413). Transports and
// data are invented.

/** An in-memory StorageAdapter whose state can be copied, as a crash leaves it. */
class CrashableStorage implements StorageAdapter {
  data = new Map<string, Map<string, Record<string, unknown>>>();
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
  crash(): CrashableStorage {
    const copy = new CrashableStorage();
    for (const [name, records] of this.data)
      copy.data.set(name, new Map(structuredClone([...records])));
    return copy;
  }
}

/** The pets fixture as a CRUD Causality document whose POST declares `crud` as its `x-crud`. */
function document(crud?: Record<string, unknown>): OpenApiDocument {
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
  if (crud)
    doc.paths['/pets']!.post!['x-crud'] = {
      action: 'create',
      resource: 'pet',
      ...crud,
    };
  return doc;
}

const GENERATED = {
  addedFields: {
    id: { source: 'generated' },
    createdAt: { source: 'generated' },
    status: { source: 'default' },
  },
};

type Answer = (body: Record<string, unknown>) => TransportResponse;

/** A provider whose POST answers with `answer`; records every POST body. */
function provider(answer: Answer): {
  posts: Record<string, unknown>[];
  transport: Transport;
} {
  const posts: Record<string, unknown>[] = [];
  return {
    posts,
    transport: async (r: TransportRequest): Promise<TransportResponse> => {
      if (r.method === 'GET')
        return { status: 200, headers: {}, body: '[]' };
      const body = JSON.parse(r.body ?? '{}') as Record<string, unknown>;
      posts.push(body);
      return answer(body);
    },
  };
}

const json = (
  value: unknown,
  headers: Record<string, string> = {},
  status = 201,
): TransportResponse => ({
  status,
  headers,
  body: value === undefined ? '' : JSON.stringify(value),
});

async function idle(client: ApiClient): Promise<void> {
  await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
  // The visible records are rebuilt just after the queue empties.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const settle = (ms = 30): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function created(
  crud: Record<string, unknown> | undefined,
  answer: Answer,
  options: { storage?: StorageAdapter; idempotencyKeyHeader?: string } = {},
): Promise<{
  client: ApiClient;
  posts: Record<string, unknown>[];
  local: string;
}> {
  const fake = provider(answer);
  const client = createApiClient(document(crud), {
    transport: fake.transport,
    retry: { baseDelayMs: 10 },
    ...options,
  });
  const record = await client.create('/pets', { name: 'Rex', tag: 'dog' });
  return { client, posts: fake.posts, local: String(record['id']) };
}

describe('createdIdentity (the reference created_identity)', () => {
  const declaration = (
    url?: Record<string, unknown>,
  ): CreateDeclaration =>
    createDeclaration(document(), {
      action: 'create',
      resource: 'pet',
      ...(url ? { url } : {}),
    })!;

  it('reads a Location header back through the identity template', () => {
    const header = declaration({ source: 'header', name: 'Location' });
    for (const location of [
      'https://provider.example/api/pets/42',
      '/api/pets/42',
      '/pets/42?view=full',
      '/pets/42#top',
    ])
      expect(createdIdentity(header, undefined, { location })).toEqual({
        id: '42',
      });
    expect(
      createdIdentity(header, undefined, { location: '/pets/a%20b' }),
    ).toEqual({ id: 'a b' });
    for (const location of ['/owners/42', '/pets/', '/pets/42/toys'])
      expect(createdIdentity(header, undefined, { location })).toBeUndefined();
    expect(createdIdentity(header, { id: 42 }, {})).toBeUndefined();
  });

  it('reads a body field URL, and the body for template or no source', () => {
    expect(
      createdIdentity(
        declaration({ source: 'bodyField', name: 'links.self' }),
        { links: { self: '/pets/7' } },
        {},
      ),
    ).toEqual({ id: '7' });
    expect(
      createdIdentity(
        declaration({ source: 'bodyField', name: 'links.self' }),
        { links: { self: 7 } },
        {},
      ),
    ).toBeUndefined();
    for (const url of [{ source: 'template' }, undefined]) {
      expect(createdIdentity(declaration(url), { id: 7 }, {})).toEqual({
        id: 7,
      });
      expect(
        createdIdentity(declaration(url), { id: null }, {}),
      ).toBeUndefined();
      expect(createdIdentity(declaration(url), undefined, {})).toBeUndefined();
    }
  });
});

describe('generated addedFields are not sent', () => {
  it('leaves generated fields, the client-made id included, out of the create body', async () => {
    const { client, posts, local } = await created(GENERATED, (body) =>
      json({ ...body, id: '42', createdAt: '2026-10-09T10:00:00Z' }),
    );
    await idle(client);
    expect(posts).toEqual([{ name: 'Rex', tag: 'dog' }]);
    expect(await client.get('/pets', local)).toBeUndefined();
    expect(await client.get('/pets', '42')).toEqual({
      id: '42',
      name: 'Rex',
      tag: 'dog',
      createdAt: '2026-10-09T10:00:00Z',
    });
  });

  it('still sends a default or computed field, and the id without a declaration', async () => {
    const fake = provider((body) => json({ ...body, id: '42' }));
    const client = createApiClient(document(GENERATED), {
      transport: fake.transport,
    });
    await client.create('/pets', { name: 'Rex', status: 'available' });
    await idle(client);
    expect(fake.posts).toEqual([{ name: 'Rex', status: 'available' }]);
    const plain = await created(undefined, (body) => json({ ...body }));
    await idle(plain.client);
    expect(plain.posts).toEqual([{ name: 'Rex', tag: 'dog', id: plain.local }]);
  });
});

describe('the identity from the declared url source', () => {
  it('binds a create answered with an empty body and a Location header', async () => {
    const { client, posts, local } = await created(
      { ...GENERATED, url: { source: 'header', name: 'Location' } },
      () => json(undefined, { Location: 'https://provider.example/api/pets/42' }),
    );
    await idle(client);
    expect(posts).toHaveLength(1);
    expect(await client.get('/pets', local)).toBeUndefined();
    expect(await client.get('/pets', '42')).toEqual({
      id: '42',
      name: 'Rex',
      tag: 'dog',
    });
  });

  it('reads a named header, and a 2xx body that is not JSON', async () => {
    const { client } = await created(
      { url: { source: 'header', name: 'Content-Location' } },
      () => ({
        status: 201,
        headers: { 'content-location': '/api/pets/42' },
        body: 'Created',
      }),
    );
    await idle(client);
    expect(await client.get('/pets', '42')).toMatchObject({ name: 'Rex' });
  });

  it('takes the URL identity over the body’s, keeping a body value equal as text', async () => {
    const numeric = await created(
      { url: { source: 'header', name: 'Location' } },
      (body) => json({ ...body, id: 42 }, { location: '/api/pets/42' }),
    );
    await idle(numeric.client);
    expect(await numeric.client.get('/pets', '42')).toMatchObject({ id: 42 });
    const other = await created(
      { url: { source: 'bodyField', name: 'self' } },
      (body) => json({ ...body, id: 'tmp', self: '/api/pets/7' }),
    );
    await idle(other.client);
    expect(await other.client.get('/pets', '7')).toMatchObject({
      id: '7',
      self: '/api/pets/7',
    });
  });
});

describe('an unbound create is never sent again', () => {
  for (const [label, crud, answer] of [
    [
      'no Location header',
      { url: { source: 'header', name: 'Location' } },
      (): TransportResponse => json(undefined),
    ],
    [
      'a Location outside the identity template',
      { url: { source: 'header', name: 'Location' } },
      (): TransportResponse => json(undefined, { location: '/owners/1' }),
    ],
    [
      'an empty body where the template needs the id',
      { url: { source: 'template' } },
      (): TransportResponse => json(undefined),
    ],
    [
      'a body field without a URL',
      { url: { source: 'bodyField', name: 'self' } },
      (body: Record<string, unknown>): TransportResponse =>
        json({ ...body, id: '9' }),
    ],
  ] as const)
    it(`with ${label}, even with an idempotency key`, async () => {
      const storage = new CrashableStorage();
      const { client, posts, local } = await created(crud, answer, {
        storage,
        idempotencyKeyHeader: 'Idempotency-Key',
      });
      await vi.waitFor(() =>
        expect(client.pendingWrites()).toMatchObject([
          { type: 'create', state: 'uncertain', unbound: true },
        ]),
      );
      await settle();
      expect(posts).toHaveLength(1);
      // Still visible under the local id.
      expect(await client.get('/pets', local)).toMatchObject({ name: 'Rex' });
      await expect(
        client.resolveWrite('/pets', local, { action: 'retry' }),
      ).rejects.toThrow(/unbound/);
      // A restart keeps it unbound and unsent.
      const again = createApiClient(document(crud), {
        storage: storage.crash(),
        transport: provider(answer).transport,
        retry: { baseDelayMs: 10 },
      });
      await again.ready();
      expect(again.pendingWrites()).toMatchObject([
        { type: 'create', state: 'uncertain', unbound: true },
      ]);
      await expect(
        again.resolveWrite('/pets', local, { action: 'retry' }),
      ).rejects.toThrow(/unbound/);
      // Confirmed with the server's id, it settles without a request.
      await client.resolveWrite('/pets', local, {
        action: 'confirm',
        id: '42',
      });
      // The rebuild under the new id follows the settle.
      await vi.waitFor(async () =>
        expect(await client.get('/pets', '42')).toMatchObject({ name: 'Rex' }),
      );
      expect(client.pendingWrites()).toEqual([]);
      expect(posts).toHaveLength(1);
    });

  it('can be discarded', async () => {
    const { client, local } = await created(
      { url: { source: 'header', name: 'Location' } },
      () => json(undefined),
    );
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('uncertain'),
    );
    await client.resolveWrite('/pets', local, { action: 'discard' });
    expect(client.pendingWrites()).toEqual([]);
    expect(await client.get('/pets', local)).toBeUndefined();
  });

  it('leaves an undeclared create as before: uncertain, not unbound, and retry resends it', async () => {
    const { client, posts, local } = await created(undefined, () =>
      json(undefined),
    );
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('uncertain'),
    );
    expect(client.pendingWrites()[0]).not.toHaveProperty('unbound');
    await client.resolveWrite('/pets', local, { action: 'retry' });
    await vi.waitFor(() => expect(posts).toHaveLength(2));
  });
});
