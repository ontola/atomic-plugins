// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  prepareDocument,
  type ApiClient,
  type ApiClientOptions,
  type OpenApiDocument,
  type Transport,
  type TransportRequest,
} from '../../../src/browser.js';
import { petsDocument } from '../../fixtures/pets.js';

// `matchUnboundCreates`: a create the provider accepted without saying
// which record it made (CRUD Causality 0.5.0 §4.3.2: unbound) is bound
// from the next complete read only through a field the app declares
// unique, sent with the create, and only when exactly one new record of
// that read matches it and no other create. Everything else leaves it
// unbound for resolveWrite. Invented provider and data.

type Row = Record<string, unknown>;

/** The pets fixture, with a create declaring a Location it never sends. */
function document(): OpenApiDocument {
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
    url: { source: 'header', name: 'Location' },
    addedFields: { id: { source: 'generated' } },
  };
  return doc;
}

/**
 * Lists `rows` minus `hidden`. A POST answers 201 without a Location and,
 * unless `onPost` says otherwise, adds the body as a row with the next
 * server id (`s1`, `s2`, ...). A PUT replaces the row.
 */
function provider(): {
  rows: Row[];
  hidden: Set<string>;
  onPost: ((body: Row, n: number) => Row[]) | undefined;
  writes: string[];
  transport: Transport;
} {
  let n = 0;
  const fake = {
    rows: [] as Row[],
    hidden: new Set<string>(),
    onPost: undefined as ((body: Row, n: number) => Row[]) | undefined,
    writes: [] as string[],
    transport: (async (r: TransportRequest) => {
      if (r.method === 'GET')
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(
            fake.rows.filter((row) => !fake.hidden.has(String(row['id']))),
          ),
        };
      const body = JSON.parse(r.body ?? '{}') as Row;
      fake.writes.push(`${r.method} ${r.url.pathname}`);
      if (r.method === 'POST') {
        n += 1;
        fake.rows.push(
          ...(fake.onPost ? fake.onPost(body, n) : [{ ...body, id: `s${n}` }]),
        );
        return { status: 201, headers: {}, body: '' };
      }
      const id = r.url.pathname.split('/').pop();
      fake.rows = fake.rows.map((row) => (row['id'] === id ? body : row));
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    }) as Transport,
  };
  return fake;
}

const unique: ApiClientOptions = {
  matchUnboundCreates: { uniqueFields: { pets: ['ref'] } },
};

function client(
  fake: ReturnType<typeof provider>,
  options: ApiClientOptions = unique,
): ApiClient {
  return createApiClient(document(), {
    transport: fake.transport,
    retry: { baseDelayMs: 10 },
    ...options,
  });
}

/** Creates each body and waits until every create is unbound. */
async function unbound(c: ApiClient, ...bodies: Row[]): Promise<string[]> {
  const ids: string[] = [];
  for (const body of bodies)
    ids.push(String((await c.create('/pets', body))['id']));
  await vi.waitFor(() =>
    expect(c.pendingWrites()).toMatchObject(
      bodies.map(() => ({ type: 'create', state: 'uncertain', unbound: true })),
    ),
  );
  return ids;
}

const names = async (c: ApiClient): Promise<string[]> =>
  (await c.list('/pets')).map((r) => `${String(r['id'])}:${String(r['name'])}`);

const rex: Row = { name: 'Rex', tag: 'dog', ref: 'a1' };

describe('an unbound create with a declared unique value', () => {
  it('is bound to the one new record of the next read that matches it', async () => {
    const fake = provider();
    const c = client(fake);
    await c.sync();
    const [local] = await unbound(c, rex);
    // An edit made while the create is unbound waits behind it.
    await c.update('/pets', local!, { ...rex, tag: 'puppy' });
    const result = await c.sync();
    expect(result.matched).toEqual([
      { collection: 'pets', localId: local, id: 's1' },
    ]);
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
    // The edit went to the server's id, and the copy holds the record once.
    expect(fake.writes).toEqual(['POST /api/pets', 'PUT /api/pets/s1']);
    await c.sync();
    expect(await c.list('/pets')).toEqual([{ ...rex, tag: 'puppy', id: 's1' }]);
  });

  it('is not bound when one new record matches two identical creates', async () => {
    const fake = provider();
    // Only the first POST makes a visible record.
    fake.onPost = (body, n): Row[] => (n === 1 ? [{ ...body, id: 's1' }] : []);
    const c = client(fake);
    await c.sync();
    await unbound(c, rex, rex);
    const result = await c.sync();
    expect(result.matched).toBeUndefined();
    expect(c.pendingWrites()).toMatchObject([
      { state: 'uncertain', unbound: true },
      { state: 'uncertain', unbound: true },
    ]);
  });

  it('is not bound when two new records match two identical creates', async () => {
    const fake = provider();
    const c = client(fake);
    await c.sync();
    await unbound(c, rex, rex);
    const result = await c.sync();
    expect(result.matched).toBeUndefined();
    expect(c.pendingWrites()).toHaveLength(2);
    expect(c.pendingWrites().every((w) => w.unbound)).toBe(true);
  });

  it('is not bound to a record someone else made when its own is filtered out', async () => {
    const fake = provider();
    // Ours is not listed; someone else's, with the same values but another
    // unique value, is.
    fake.onPost = (body): Row[] => [
      { ...body, id: 's1' },
      { ...body, ref: 'b2', id: 's2' },
    ];
    fake.hidden.add('s1');
    const c = client(fake);
    await c.sync();
    const [local] = await unbound(c, rex);
    const result = await c.sync();
    expect(result.matched).toBeUndefined();
    expect(c.pendingWrites()).toMatchObject([{ id: local, unbound: true }]);
    expect((await names(c)).sort()).toEqual([`${local}:Rex`, 's2:Rex']);
  });

  it('is not bound without a declared unique value, even to the only match', async () => {
    const fake = provider();
    fake.onPost = (body): Row[] => [{ ...body, id: 's1' }];
    for (const [options, body] of [
      // The unique field is declared, but this create does not send it.
      [unique, { name: 'Rex', tag: 'dog' }],
      [unique, { name: 'Rex', tag: 'dog', ref: '' }],
      // Another collection's field is no declaration for this one.
      [{}, rex],
    ] as const) {
      fake.rows = [];
      const c = client(fake, options);
      await c.sync();
      await unbound(c, body);
      expect((await c.sync()).matched).toBeUndefined();
      expect(c.pendingWrites()).toMatchObject([{ unbound: true }]);
    }
  });

  it('is not bound to a record that already existed', async () => {
    const fake = provider();
    // The provider makes nothing new: the matching record was there before.
    fake.onPost = (): Row[] => [];
    fake.rows = [{ ...rex, id: 's0' }];
    const c = client(fake);
    await c.sync();
    await unbound(c, rex);
    expect((await c.sync()).matched).toBeUndefined();
  });

  it('gets one chance: the first complete read after the answer', async () => {
    const fake = provider();
    const c = client(fake);
    await c.sync();
    fake.hidden.add('s1');
    await unbound(c, rex);
    // The provider lists it late.
    expect((await c.sync()).matched).toBeUndefined();
    fake.hidden.clear();
    expect((await c.sync()).matched).toBeUndefined();
    expect(c.pendingWrites()).toMatchObject([{ unbound: true }]);
  });

  it('is not bound after a read that was not applied (the presence handler threw)', async () => {
    const fake = provider();
    // The provider makes nothing new: the matching record exists already.
    fake.onPost = (): Row[] => [];
    fake.rows = [{ ...rex, id: 's0' }];
    // A record a reused storage holds, which the first read lacks: telling
    // its removal throws, so that read is not applied.
    const storage = new InMemoryStorageAdapter();
    await storage.put('pets', 'old', { id: 'old', name: 'Old', ref: 'z9' });
    let fail = true;
    const c = client(fake, {
      ...unique,
      storage,
      onPresence: () => {
        if (fail) throw new Error('not now');
      },
    });
    await expect(c.sync()).rejects.toThrow('not now');
    await unbound(c, rex);
    fail = false;
    // s0 was in that read but never confirmed: it is not new since the
    // create, so it must not be bound.
    expect((await c.sync()).matched).toBeUndefined();
    expect(c.pendingWrites()).toMatchObject([{ unbound: true }]);
  });

  it('is not bound without a complete read of the collection before it', async () => {
    const fake = provider();
    const c = client(fake);
    await unbound(c, rex);
    expect((await c.sync()).matched).toBeUndefined();
    expect(c.pendingWrites()).toMatchObject([{ unbound: true }]);
  });

  it('is not bound after a restart', async () => {
    const fake = provider();
    const storage = new InMemoryStorageAdapter();
    const first = client(fake, { ...unique, storage });
    await first.sync();
    const [local] = await unbound(first, rex);
    const again = client(fake, { ...unique, storage });
    await again.ready();
    await again.sync();
    expect((await again.sync()).matched).toBeUndefined();
    expect(again.pendingWrites()).toMatchObject([
      { id: local, state: 'uncertain', unbound: true },
    ]);
  });

  it('refuses an unknown collection in uniqueFields', () => {
    expect(() =>
      client(provider(), {
        matchUnboundCreates: { uniqueFields: { owners: ['ref'] } },
      }),
    ).toThrow(/Unknown resource "owners"/);
  });
});
