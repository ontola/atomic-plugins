// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  prepareDocument,
  type ApiClient,
  type ApiClientOptions,
  type OpenApiDocument,
  type PresenceChange,
  type Transport,
  type TransportResponse,
} from '../../../src/browser.js';
import { nestedTaskLists } from '../../fixtures/deletion-declarations.js';
import { petsDocument } from '../../fixtures/pets.js';

// K4/K5 presence marks (coordinator decisions 1–4): a record a complete read
// lacks is kept, marked `unconfirmed`, under `absent: removed` (or wherever
// a check will be made) until a check settles it; checks of records without
// writes are capped per sync (50 by default); `retainDeleted` keeps deleted
// records marked; `SyncResult.presence` lists the changes, `presence()` the
// full set. Shaped like Google Tasks (`absent: removed`, `notFound:
// unavailable`, a `deleted: true` read tombstone). Data is invented.

type Pet = Record<string, unknown>;

const response = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: JSON.stringify(value),
});

function document(
  completeness: Record<string, unknown> | null = {
    absent: 'removed',
    notFound: 'unavailable',
  },
): OpenApiDocument {
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
          'x-read-tombstone': { field: 'deleted', values: [true] },
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

/**
 * Lists `pets` minus `hidden`; a GET of a pet answers `item(id)` when it
 * returns something, else the pet (404 when unknown or hidden). Counts
 * item GETs.
 */
function provider(pets: Pet[]): {
  pets: Map<string, Pet>;
  hidden: Set<string>;
  item: (id: string) => TransportResponse | undefined;
  gets: string[];
  transport: Transport;
} {
  const fake = {
    pets: new Map(pets.map((p) => [String(p['id']), p])),
    hidden: new Set<string>(),
    item: ((): TransportResponse | undefined => undefined) as (
      id: string,
    ) => TransportResponse | undefined,
    gets: [] as string[],
    transport: (async (r) => {
      const path = r.url.pathname.replace(/^\/api/, '');
      if (path === '/pets')
        return response(
          [...fake.pets.values()].filter(
            (p) => !fake.hidden.has(String(p['id'])),
          ),
        );
      const id = decodeURIComponent(path.split('/')[2] ?? '');
      fake.gets.push(id);
      const answer = fake.item(id);
      if (answer) return answer;
      const pet = fake.pets.get(id);
      return pet && !fake.hidden.has(id)
        ? response(pet)
        : response({ error: 'gone' }, 404);
    }) as Transport,
  };
  return fake;
}

const rex = { id: '1', name: 'Rex' };
const tom = { id: '2', name: 'Tom' };

async function setup(
  doc = document(),
  options: Partial<ApiClientOptions> = {},
  pets: Pet[] = [rex, tom],
): Promise<{
  client: ApiClient;
  fake: ReturnType<typeof provider>;
  told: PresenceChange[][];
  storage: InMemoryStorageAdapter;
}> {
  const fake = provider(pets);
  const told: PresenceChange[][] = [];
  const storage = new InMemoryStorageAdapter();
  const client = createApiClient(doc, {
    storage,
    transport: fake.transport,
    onPresence: (changes) => {
      told.push(changes);
    },
    ...options,
  });
  await client.sync();
  fake.gets.length = 0;
  return { client, fake, told, storage };
}

const change = (
  presence: PresenceChange['presence'],
  source: PresenceChange['source'],
  record: Pet | undefined,
  pruned: boolean,
  id = '2',
): PresenceChange => ({
  collection: 'pets',
  id,
  presence,
  source,
  ...(record ? { record } : {}),
  pruned,
});

describe('presence marks under absent: removed (the Google Tasks table)', () => {
  it('404: unavailable, kept with its values, told once', async () => {
    const { client, fake, told } = await setup();
    fake.hidden.add('2');
    const result = await client.sync();
    expect(fake.gets).toEqual(['2']);
    // Kept before the check, so never removed and brought back.
    expect(told).toEqual([[change('unavailable', 'read', tom, false)]]);
    expect(result.presence).toEqual(told[0]);
    expect(await client.get('/pets', '2')).toEqual(tom);
    expect(client.presence()).toEqual([
      {
        collection: 'pets',
        id: '2',
        presence: 'unavailable',
        source: 'read',
        detail: expect.stringContaining('404'),
        record: tom,
        lastSeen: expect.any(String),
      },
    ]);
  });

  it('a deleted: true read tombstone: deleted, told, then removed', async () => {
    const { client, fake, told } = await setup();
    fake.hidden.add('2');
    fake.item = (id): TransportResponse | undefined =>
      id === '2' ? response({ ...tom, deleted: true }) : undefined;
    await client.sync();
    expect(told).toEqual([[change('deleted', 'read', tom, true)]]);
    expect(await client.get('/pets', '2')).toBeUndefined();
    expect(client.presence()).toEqual([]);
  });

  it('a deleted record is kept, marked deleted, under retainDeleted', async () => {
    const { client, fake, told } = await setup(document(), {
      retainDeleted: true,
    });
    fake.hidden.add('2');
    fake.item = (id): TransportResponse | undefined =>
      id === '2' ? response({ ...tom, deleted: true }) : undefined;
    await client.sync();
    expect(told).toEqual([[change('deleted', 'read', tom, false)]]);
    expect(await client.get('/pets', '2')).toEqual(tom);
    expect(client.presence()).toMatchObject([{ id: '2', presence: 'deleted' }]);
  });

  it('the record itself (2xx, not in the list): removed from this collection, told first', async () => {
    const { client, fake, told } = await setup();
    fake.hidden.add('2');
    fake.item = (id): TransportResponse | undefined => (id === '2' ? response(tom) : undefined);
    await client.sync();
    // The GET answers the pet (it exists, but left the list).
    expect(fake.gets).toEqual(['2']);
    expect(told.flat()).toEqual([change('removed', 'read', tom, true)]);
    expect(await client.get('/pets', '2')).toBeUndefined();
  });

  it('a 500: unconfirmed, kept, and checked again by the next sync even when the list is unchanged', async () => {
    const { client, fake, told } = await setup();
    fake.hidden.add('2');
    fake.item = (id): TransportResponse | undefined =>
      id === '2' ? response({ error: 'invented' }, 500) : undefined;
    await client.sync();
    expect(told).toEqual([[change('unconfirmed', 'read', tom, false)]]);
    expect(await client.get('/pets', '2')).toEqual(tom);
    fake.gets.length = 0;
    told.length = 0;
    // The same list again: still checked; still unknown, so no change.
    const result = await client.sync();
    expect(fake.gets).toEqual(['2']);
    expect(told).toEqual([]);
    expect(result).not.toHaveProperty('presence');
    // Now a 404: unavailable.
    fake.item = (): undefined => undefined;
    await client.sync();
    expect(told).toEqual([[change('unavailable', 'read', tom, false)]]);
  });

  it('a read that returns a marked record again: present, mark dropped', async () => {
    const { client, fake, told } = await setup();
    fake.hidden.add('2');
    await client.sync();
    fake.hidden.delete('2');
    told.length = 0;
    const result = await client.sync();
    expect(told).toEqual([[change('present', 'read', tom, false)]]);
    expect(result.presence).toEqual(told[0]);
    expect(client.presence()).toEqual([]);
  });

  it('keeps a record that cannot be checked (missingRecordChecks none) unconfirmed, without a GET', async () => {
    const { client, fake, told } = await setup(document(), {
      missingRecordChecks: 'none',
    });
    fake.hidden.add('2');
    await client.sync();
    expect(fake.gets).toEqual([]);
    expect(told).toEqual([[change('unconfirmed', 'read', tom, false)]]);
    expect(await client.get('/pets', '2')).toEqual(tom);
  });
});

describe('presence marks: the per-sync check limit', () => {
  it('checks at most 50 records without writes per sync; the rest stay unconfirmed and go first next time', async () => {
    const pets = Array.from({ length: 121 }, (_, i) => ({
      id: String(i + 1),
      name: `Pet ${i + 1}`,
    }));
    const { client, fake } = await setup(document(), {}, pets);
    for (let i = 2; i <= 121; i++) fake.hidden.add(String(i));
    await client.sync();
    expect(fake.gets).toHaveLength(50);
    const marks = client.presence();
    expect(marks.filter((m) => m.presence === 'unavailable')).toHaveLength(50);
    const waiting = marks
      .filter((m) => m.presence === 'unconfirmed')
      .map((m) => m.id);
    expect(waiting).toHaveLength(70);
    expect(marks[0]?.detail ?? '').toBeTruthy();
    fake.gets.length = 0;
    await client.sync();
    // The unconfirmed ones first: 50 of the 70.
    expect(fake.gets).toHaveLength(50);
    expect(fake.gets.every((id) => waiting.includes(id))).toBe(true);
    fake.gets.length = 0;
    await client.sync();
    expect(fake.gets).toHaveLength(20);
    expect(client.presence().every((m) => m.presence === 'unavailable')).toBe(
      true,
    );
  });

  it('takes maxMissingRecordChecks', async () => {
    const { client, fake } = await setup(document(), {
      maxMissingRecordChecks: 1,
    }, [rex, tom, { id: '3', name: 'Jo' }]);
    fake.hidden.add('2');
    fake.hidden.add('3');
    await client.sync();
    expect(fake.gets).toHaveLength(1);
  });
});

describe('presence marks under other declarations', () => {
  it('absent: deleted: told deleted and removed, or kept marked under retainDeleted', async () => {
    for (const retainDeleted of [false, true]) {
      const { client, fake, told } = await setup(
        document({ absent: 'deleted' }),
        { retainDeleted },
      );
      fake.hidden.add('2');
      await client.sync();
      expect(fake.gets).toEqual([]);
      expect(told).toEqual([
        [change('deleted', 'declaration', tom, !retainDeleted)],
      ]);
      expect(await client.get('/pets', '2')).toEqual(
        retainDeleted ? tom : undefined,
      );
    }
  });

  it("an undeclared collection under 'all': kept before the check, told once as settled", async () => {
    const { client, fake, told } = await setup(document(null), {
      missingRecordChecks: 'all',
    });
    fake.hidden.add('2');
    fake.item = (id): TransportResponse | undefined => (id === '2' ? response({ error: 'x' }, 404) : undefined);
    await client.sync();
    // The default notFound: deleted; told once, then removed.
    expect(told).toEqual([[change('deleted', 'read', tom, true)]]);
    expect(await client.get('/pets', '2')).toBeUndefined();
  });

  it('an undeclared collection under the default checks: removed, told first, no GET', async () => {
    const { client, fake, told } = await setup(document(null));
    fake.hidden.add('2');
    await client.sync();
    expect(fake.gets).toEqual([]);
    expect(told).toEqual([[change('removed', 'read', tom, true)]]);
  });
});

describe('presence marks across a restart', () => {
  it('keeps the marks and checks unconfirmed records first', async () => {
    const { client, fake, storage } = await setup();
    fake.hidden.add('2');
    fake.item = (id): TransportResponse | undefined =>
      id === '2' ? response({ error: 'invented' }, 500) : undefined;
    await client.sync();
    const again = createApiClient(document(), {
      storage,
      transport: fake.transport,
    });
    await again.ready();
    expect(again.presence()).toMatchObject([
      { id: '2', presence: 'unconfirmed', record: tom },
    ]);
    fake.item = (): undefined => undefined;
    fake.gets.length = 0;
    await again.sync();
    expect(fake.gets).toEqual(['2']);
    expect(again.presence()).toMatchObject([
      { id: '2', presence: 'unavailable' },
    ]);
  });
});

describe('presence marks: writes queued while the app is told, and parents', () => {
  it('does not remove, nor report as pruned, a record the app updated inside the handler', async () => {
    const fake = provider([rex, tom]);
    let edit = false;
    const writes: string[] = [];
    const transport: Transport = async (r) => {
      if (r.method !== 'GET') {
        writes.push(r.method);
        return response({ error: 'invented' }, 503);
      }
      return fake.transport(r);
    };
    const client: ApiClient = createApiClient(document(null), {
      transport,
      retry: { baseDelayMs: 60_000 },
      onPresence: async () => {
        if (!edit) return;
        edit = false;
        await client.update('/pets', '2', { name: 'Tommy' });
      },
    });
    await client.sync();
    fake.hidden.add('2');
    edit = true;
    const result = await client.sync();
    expect(result.presence).toEqual([change('removed', 'read', tom, false)]);
    expect(await client.get('/pets', '2')).toEqual({ id: '2', name: 'Tommy' });
    expect(client.pendingWrites()).toMatchObject([{ id: '2', type: 'update' }]);
  });

  it('tells the members of a gone parent as unavailable, source parent, kept', async () => {
    const lists = new Map<string, Pet>([
      ['L1', { id: 'L1', title: 'Home' }],
      ['L2', { id: 'L2', title: 'Work' }],
    ]);
    const tasks: Record<string, Pet[]> = {
      L1: [{ id: 't1', title: 'Water plants' }],
      L2: [{ id: 't2', title: 'Write report' }],
    };
    const transport: Transport = async (r) => {
      const path = r.url.pathname;
      if (path === '/users/me/lists') return response([...lists.values()]);
      const list = /^\/users\/me\/lists\/(.+)$/.exec(path);
      if (list)
        return lists.has(list[1]!)
          ? response(lists.get(list[1]!))
          : response({ error: 'gone' }, 404);
      const listTasks = /^\/lists\/([^/]+)\/tasks$/.exec(path);
      if (listTasks) return response(tasks[listTasks[1]!] ?? []);
      return response({ error: 'gone' }, 404);
    };
    const told: PresenceChange[][] = [];
    const client = createApiClient(prepareDocument(structuredClone(nestedTaskLists)), {
      transport,
      onPresence: (changes) => {
        told.push(changes);
      },
    });
    await client.sync();
    lists.delete('L2');
    await client.sync();
    expect(told.flat()).toEqual([
      {
        collection: 'taskLists',
        id: 'L2',
        presence: 'unavailable',
        source: 'read',
        record: { id: 'L2', title: 'Work' },
        pruned: false,
      },
      {
        collection: 'listTasks',
        context: { listId: 'L2' },
        id: 't2',
        presence: 'unavailable',
        source: 'parent',
        record: { id: 't2', title: 'Write report' },
        pruned: false,
      },
    ]);
    expect(
      await client.get('listTasks', 't2', { listId: 'L2' }),
    ).toEqual({ id: 't2', title: 'Write report' });
  });
});

describe('presence marks: lastSeen', () => {
  it('is the start of the last sync whose read returned the record, kept across a restart', async () => {
    const before = Date.now();
    const { client, fake, storage } = await setup();
    const after = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.hidden.add('2');
    await client.sync();
    const [mark] = client.presence();
    expect(mark?.presence).toBe('unavailable');
    const seen = Date.parse(mark?.lastSeen ?? '');
    expect(seen).toBeGreaterThanOrEqual(before);
    expect(seen).toBeLessThanOrEqual(after);
    // Unchanged by later syncs that do not return it.
    await client.sync();
    expect(client.presence()[0]?.lastSeen).toBe(mark?.lastSeen);
    const again = createApiClient(document(), {
      storage,
      transport: fake.transport,
    });
    await again.ready();
    expect(again.presence()[0]?.lastSeen).toBe(mark?.lastSeen);
  });

  it('is absent for a record no read of this client returned (storage from before a restart)', async () => {
    const { fake, storage } = await setup();
    fake.hidden.add('2');
    const again = createApiClient(document(), {
      storage,
      transport: fake.transport,
    });
    await again.sync();
    expect(again.presence()).toMatchObject([
      { id: '2', presence: 'unavailable' },
    ]);
    expect(again.presence()[0]).not.toHaveProperty('lastSeen');
  });
});
