// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
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

// --- #451 review: the race with a write that settles while the app is
// told, removals after a lookup, writes still being stored, and a failing
// handler's effect on held writes.

/**
 * A provider that applies writes (PUT replaces, DELETE removes), lists
 * `pets` minus `hidden`, answers a GET of a hidden pet `itemStatus` (404
 * by default; 200 returns it), and a deletion feed of `deletions`.
 * `blocked` answers writes 503.
 */
function liveProvider(initial: Pet[]): {
  pets: Map<string, Pet>;
  hidden: Set<string>;
  itemStatus: number;
  deletions: string[];
  blocked: boolean;
  writes: string[];
  transport: Transport;
} {
  const fake = {
    pets: new Map(initial.map((p) => [String(p['id']), p])),
    hidden: new Set<string>(),
    itemStatus: 404,
    deletions: [] as string[],
    blocked: false,
    writes: [] as string[],
    transport: (async (r) => {
      const path = r.url.pathname.replace(/^\/api/, '');
      if (r.method === 'GET' && path === '/pets')
        return response(
          [...fake.pets.values()].filter(
            (p) => !fake.hidden.has(String(p['id'])),
          ),
        );
      if (r.method === 'GET' && path === '/pet-deletions')
        return response(fake.deletions.map((id) => ({ id, deleted: true })));
      const id = decodeURIComponent(path.split('/')[2] ?? '');
      if (r.method === 'GET') {
        const pet = fake.pets.get(id);
        if (!pet) return response({ error: 'gone' }, 404);
        if (fake.hidden.has(id) && fake.itemStatus !== 200)
          return response({ error: 'gone' }, fake.itemStatus);
        return response(pet);
      }
      fake.writes.push(`${r.method} ${id}`);
      if (fake.blocked) return response({ error: 'invented' }, 503);
      if (r.method === 'DELETE') {
        fake.pets.delete(id);
        return { status: 204, headers: {}, body: '' };
      }
      const pet = { ...JSON.parse(r.body ?? '{}'), id };
      fake.pets.set(id, pet);
      return response(pet);
    }) as Transport,
  };
  return fake;
}

describe('tell before prune: a write that settles while the app is told', () => {
  it('does not bring back a record whose delete settled in the handler, nor report the delete as removed later', async () => {
    const fake = liveProvider([rex, tom]);
    let deleteRex = false;
    const told: PresenceChange[][] = [];
    const client: ApiClient = createApiClient(document(), {
      transport: fake.transport,
      onPresence: async (changes) => {
        told.push(changes);
        if (!deleteRex) return;
        deleteRex = false;
        await client.remove('/pets', '1');
        await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
      },
    });
    await client.sync();
    fake.hidden.add('2');
    deleteRex = true;
    await client.sync();
    expect(await client.get('/pets', '1')).toBeUndefined();
    await client.sync();
    expect(told.flat().map((c) => [c.id, c.presence])).toEqual([
      ['2', 'removed'],
      ['2', 'removed'],
    ]);
    expect(await client.get('/pets', '1')).toBeUndefined();
  });

  it('does not revert an update that settled in the handler', async () => {
    const fake = liveProvider([rex, tom]);
    let renameRex = false;
    const client: ApiClient = createApiClient(document(), {
      transport: fake.transport,
      onPresence: async () => {
        if (!renameRex) return;
        renameRex = false;
        await client.update('/pets', '1', { name: 'Rexy' });
        await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
      },
    });
    await client.sync();
    fake.hidden.add('2');
    renameRex = true;
    await client.sync();
    expect(await client.get('/pets', '1')).toEqual({ id: '1', name: 'Rexy' });
  });
});

describe('tell before prune: removals after a check', () => {
  const unavailableDoc = (feed: boolean): OpenApiDocument => {
    const doc = document({ absent: 'removed', notFound: 'unavailable' });
    if (feed) {
      const resources = doc.components!['crudResources'] as Record<
        string,
        { collections: Record<string, Record<string, unknown>> }
      >;
      resources['pet']!.collections['pets']!['x-deletion-feed'] = {
        operationId: 'listDeletions',
      };
      doc.paths['/pet-deletions'] = {
        get: {
          operationId: 'listDeletions',
          responses: { '200': { description: 'Deleted pet ids' } },
        },
      };
    }
    return doc;
  };

  for (const [label, feed, presence, source] of [
    ['a later filtered GET', false, 'removed', 'read'],
    ['a later feed tombstone', true, 'deleted', 'feed'],
  ] as const)
    it(`tells a kept unavailable record before ${label} removes it`, async () => {
      const fake = liveProvider([rex, tom]);
      const told: PresenceChange[][] = [];
      const client = createApiClient(unavailableDoc(feed), {
        transport: fake.transport,
        missingRecordChecks: 'all',
        retry: { baseDelayMs: 60_000 },
        onPresence: (changes) => {
          told.push(changes);
        },
      });
      await client.sync();
      fake.hidden.add('2');
      await client.sync();
      // Kept before the lookup, which found it unavailable: told once.
      expect(told.flat().map((c) => [c.id, c.presence, c.pruned])).toEqual([
        ['2', 'unavailable', false],
      ]);
      expect(await client.get('/pets', '2')).toEqual(tom);
      told.length = 0;
      // A held update seeds the confirmed copy; discarding it leaves the
      // record kept and confirmed, without writes.
      fake.blocked = true;
      await client.update('/pets', '2', { name: 'Tommy' });
      await client.sync();
      await client.resolveWrite('/pets', '2', { action: 'discard' });
      fake.blocked = false;
      expect(await client.get('/pets', '2')).toEqual(tom);
      // The next check concludes otherwise; a changed list makes the read
      // compared again.
      if (presence === 'removed') fake.itemStatus = 200;
      else fake.deletions = ['2'];
      fake.pets.set('3', { id: '3', name: 'Jo' });
      const result = await client.sync();
      expect(told.flat()).toEqual([
        {
          collection: 'pets',
          id: '2',
          presence,
          source,
          record: tom,
          pruned: true,
        },
      ]);
      expect(result.presence).toEqual(told.flat());
      expect(await client.get('/pets', '2')).toBeUndefined();
    });
});

describe('tell before prune: writes still being stored, and a failing handler', () => {
  it('neither tells nor removes a record whose only write is still being stored', async () => {
    let gate: (() => void) | undefined;
    let armed = false;
    class SlowOutbox extends InMemoryStorageAdapter {
      override async put(
        resource: string,
        id: string,
        value: Record<string, unknown>,
      ): Promise<void> {
        if (resource === 'syncables:outbox' && armed && gate === undefined)
          await new Promise<void>((resolve) => (gate = resolve));
        await super.put(resource, id, value);
      }
    }
    const fake = liveProvider([rex, tom]);
    const told: PresenceChange[][] = [];
    const storage = new SlowOutbox();
    const client = createApiClient(document(), {
      storage,
      transport: fake.transport,
      onPresence: (changes) => {
        told.push(changes);
      },
    });
    await client.sync();
    fake.hidden.add('2');
    armed = true;
    // The update's outbox store waits at the gate: not durable yet.
    const updating = client.update('/pets', '2', { name: 'Tommy' });
    await vi.waitFor(() => expect(gate).toBeDefined());
    // The sync's own outbox store waits behind it, after its rebuild.
    const syncing = client.sync();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(told).toEqual([]);
    expect(await storage.get('pets', '2')).toEqual(tom);
    gate!();
    await updating;
    await syncing;
    expect(await client.get('/pets', '2')).toEqual({ id: '2', name: 'Tommy' });
  });

  it('does not count refresh misses for a collection whose handler threw', async () => {
    const storage = new InMemoryStorageAdapter();
    const fake = liveProvider([rex, tom]);
    const first = createApiClient(document(), {
      storage,
      transport: fake.transport,
      retry: { baseDelayMs: 60_000 },
    });
    await first.sync();
    fake.blocked = true;
    await first.update('/pets', '1', { name: 'Rexy' });
    await vi.waitFor(() =>
      expect(first.pendingWrites()[0]?.attempts).toBe(1),
    );
    // A restarted client holds the update until a complete read.
    fake.hidden.add('2');
    const again = createApiClient(document(), {
      storage,
      transport: fake.transport,
      retry: { baseDelayMs: 60_000 },
      onPresence: () => {
        throw new Error('app could not record it');
      },
    });
    await again.ready();
    for (let i = 0; i < 4; i++)
      await expect(again.sync()).rejects.toThrow('app could not record it');
    expect(again.pendingWrites()).toMatchObject([
      { id: '1', state: 'pending', awaitingRefresh: true },
    ]);
  });
});
