// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  prepareDocument,
  type ApiClient,
  type OpenApiDocument,
  type PresenceChange,
  type Transport,
  type TransportResponse,
} from '../../../src/browser.js';
import { petsDocument } from '../../fixtures/pets.js';

// Tell before prune (K4/K5 decision 1): a record the client removes from
// its local copy because a complete read no longer returns it is told to
// the app first (`onPresence`, awaited; `SyncResult.presence`). Transports
// and data are invented.

type Pet = Record<string, unknown>;

const response = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: JSON.stringify(value),
});

/** The pets fixture as a CRUD Causality document, with an optional Completeness Object. */
function document(completeness?: Record<string, unknown>): OpenApiDocument {
  return prepareDocument({
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
          collections: {
            pets: {
              urlTemplate: '/pets',
              ...(completeness ? { 'x-completeness': completeness } : {}),
            },
          },
        },
      },
    },
  });
}

const rex = { id: '1', name: 'Rex' };
const tom = { id: '2', name: 'Tom' };

/** A provider listing `pets`; writes answer 503. */
function provider(pets: Pet[]): { pets: Pet[]; transport: Transport } {
  const fake = {
    pets,
    transport: (async (r) =>
      r.method === 'GET' && r.url.pathname === '/api/pets'
        ? response(fake.pets)
        : response({ error: 'invented' }, 503)) as Transport,
  };
  return fake;
}

/** A client synced with rex and tom; then tom leaves the list. */
async function syncedThenTomGone(
  doc: OpenApiDocument,
  onPresence?: (changes: PresenceChange[], client: ApiClient) => unknown,
  storage = new InMemoryStorageAdapter(),
): Promise<{
  client: ApiClient;
  fake: ReturnType<typeof provider>;
  told: PresenceChange[][];
}> {
  const fake = provider([rex, tom]);
  const told: PresenceChange[][] = [];
  const client: ApiClient = createApiClient(doc, {
    storage,
    transport: fake.transport,
    retry: { baseDelayMs: 60_000 },
    onPresence: async (changes) => {
      told.push(changes);
      await onPresence?.(changes, client);
    },
  });
  await client.sync();
  fake.pets = [rex];
  return { client, fake, told };
}

describe('tell before prune', () => {
  for (const [label, doc, presence, source] of [
    ['an undeclared collection', document(), 'removed', 'read'],
    [
      'absent: removed',
      document({ absent: 'removed' }),
      'removed',
      'read',
    ],
    [
      'absent: deleted',
      document({ absent: 'deleted' }),
      'deleted',
      'declaration',
    ],
  ] as const)
    it(`tells a record a complete read no longer returns before removing it (${label})`, async () => {
      const seen: unknown[] = [];
      const { client, told } = await syncedThenTomGone(
        doc,
        async (_, c) => {
          // Still in the local copy while the app is told.
          seen.push(await c.get('/pets', '2'));
        },
      );
      const result = await client.sync();
      const change = {
        collection: 'pets',
        id: '2',
        presence,
        source,
        record: tom,
        pruned: true,
      };
      expect(told).toEqual([[change]]);
      expect(seen).toEqual([tom]);
      expect(result.presence).toEqual([change]);
      expect(await client.get('/pets', '2')).toBeUndefined();
      expect(await client.list('/pets')).toEqual([rex]);
    });

  it('waits for an asynchronous handler before removing', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client } = await syncedThenTomGone(document(), () => gate);
    const syncing = client.sync();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await client.get('/pets', '2')).toEqual(tom);
    release();
    await syncing;
    expect(await client.get('/pets', '2')).toBeUndefined();
  });

  it('applies nothing of that read when the handler fails, and tells again next sync', async () => {
    let fail = true;
    const { client, told } = await syncedThenTomGone(document(), () => {
      if (fail) throw new Error('app could not record it');
    });
    await expect(client.sync()).rejects.toThrow('app could not record it');
    expect(await client.get('/pets', '2')).toEqual(tom);
    fail = false;
    const result = await client.sync();
    expect(told).toHaveLength(2);
    expect(result.presence?.map((c) => c.id)).toEqual(['2']);
    expect(await client.get('/pets', '2')).toBeUndefined();
  });

  it('tells nothing, and has no presence field, when nothing is removed', async () => {
    const { client, fake, told } = await syncedThenTomGone(document());
    fake.pets = [rex, tom];
    const result = await client.sync();
    expect(told).toEqual([]);
    expect(result).not.toHaveProperty('presence');
  });

  it('does not tell a record with a queued write, which is not removed', async () => {
    const { client, told } = await syncedThenTomGone(document());
    await client.update('/pets', '2', { name: 'Tommy' });
    await client.sync();
    expect(told).toEqual([]);
    expect(await client.get('/pets', '2')).toEqual({ id: '2', name: 'Tommy' });
  });

  it('tells a record a reused storage held from an earlier client', async () => {
    const storage = new InMemoryStorageAdapter();
    const first = createApiClient(document(), {
      storage,
      transport: provider([rex, tom]).transport,
    });
    await first.sync();
    const told: PresenceChange[][] = [];
    const second = createApiClient(document(), {
      storage,
      transport: provider([rex]).transport,
      onPresence: (changes) => {
        told.push(changes);
      },
    });
    await second.sync();
    expect(told).toEqual([
      [
        {
          collection: 'pets',
          id: '2',
          presence: 'removed',
          source: 'read',
          record: tom,
          pruned: true,
        },
      ],
    ]);
    expect(await second.get('/pets', '2')).toBeUndefined();
  });
});
