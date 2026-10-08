// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  prepareDocument,
  type ApiClient,
  type ApiClientOptions,
  type MissingRecord,
  type OpenApiDocument,
  type StorageAdapter,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import { petsDocument } from '../../fixtures/pets.js';

// Collection Completeness 0.2.0-draft §4.3 (`notFound`): what a 404 or 410
// from reading a record a complete refresh no longer returned means. By
// default it means deleted, as before; `notFound: unavailable` means the
// caller can no longer read the record and the API does not say why. Such a
// record is never reported as deleted, its last known values are kept, and
// a queued update of it is failed (held for a decision through
// `resolveWrite`), not sent. Transports and data are invented.

const OUTBOX = 'syncables:outbox';

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

const response = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: value === undefined ? '' : JSON.stringify(value),
});

type Pet = Record<string, unknown>;

/**
 * The pets fixture as a CRUD Causality document whose `pets` collection
 * carries `completeness` (on the Collection Object, or with `onOperation` on
 * the list GET), optionally with a deletion feed at `GET /pet-deletions`
 * (every item a tombstone). `legacy` leaves `crudResources` out and puts
 * the declaration on the list GET.
 */
function document(
  options: {
    completeness?: unknown;
    onOperation?: boolean;
    legacy?: boolean;
    method?: 'put' | 'patch';
    feed?: boolean;
  } = {},
): OpenApiDocument {
  const doc = prepareDocument({
    ...petsDocument,
    servers: [{ url: 'https://provider.example/api' }],
    components: {
      ...petsDocument.components,
      ...(options.legacy
        ? {}
        : {
            crudResources: {
              pet: {
                identity: {
                  urlTemplate: '/pets/{petId}',
                  bindings: { petId: { field: 'id' } },
                },
                collections: {
                  pets: {
                    urlTemplate: '/pets',
                    ...(options.completeness && !options.onOperation
                      ? { 'x-completeness': options.completeness }
                      : {}),
                    ...(options.feed
                      ? { 'x-deletion-feed': { operationId: 'listDeletions' } }
                      : {}),
                  },
                },
              },
            },
          }),
    },
  });
  const item = doc.paths['/pets/{petId}']!;
  if (options.method === 'patch') {
    item.patch = item.put!;
    delete item.put;
  }
  if (options.completeness && (options.onOperation || options.legacy))
    doc.paths['/pets']!.get!['x-completeness'] = options.completeness;
  if (options.feed)
    doc.paths['/pet-deletions'] = {
      get: {
        operationId: 'listDeletions',
        responses: { '200': { description: 'Deleted pet ids' } },
      },
    };
  return doc;
}

/**
 * A fake provider. `listed` filters the collection list (all pets by
 * default); `item` may answer a GET of one pet itself; `deletions` is the
 * feed's body; `behave` may answer a write itself.
 */
function provider(
  initial: Pet[],
  hooks: {
    listed?: (pet: Pet) => boolean;
    item?: (id: string) => TransportResponse | undefined;
    deletions?: () => unknown[];
    behave?: (r: TransportRequest) => TransportResponse | undefined;
  } = {},
): {
  pets: Map<string, Pet>;
  writes: TransportRequest[];
  itemGets: string[];
  feedReads: number;
  transport: Transport;
} {
  const pets = new Map(initial.map((p) => [String(p['id']), p]));
  const fake = {
    pets,
    writes: [] as TransportRequest[],
    itemGets: [] as string[],
    feedReads: 0,
    transport: (async (r) => {
      const path = r.url.pathname.replace(/^\/api/, '');
      if (r.method === 'GET' && path === '/pet-deletions') {
        fake.feedReads += 1;
        return response(hooks.deletions?.() ?? []);
      }
      if (r.method === 'GET' && path === '/pets')
        return response(
          [...pets.values()].filter(hooks.listed ?? ((): boolean => true)),
        );
      const id = decodeURIComponent(path.split('/')[2] ?? '');
      if (r.method === 'GET') {
        fake.itemGets.push(id);
        const answer = hooks.item?.(id);
        if (answer) return answer;
        const pet = pets.get(id);
        return pet ? response(pet) : response({ error: 'not found' }, 404);
      }
      fake.writes.push(r);
      const behaviour = hooks.behave?.(r);
      if (behaviour) return behaviour;
      if (r.method === 'PUT' || r.method === 'PATCH') {
        const current = pets.get(id);
        if (!current) return response({ error: 'not found' }, 404);
        const pet = {
          ...(r.method === 'PATCH' ? current : {}),
          ...JSON.parse(r.body ?? '{}'),
          id,
        };
        pets.set(id, pet);
        return response(pet);
      }
      return response({}, 405);
    }) as Transport,
  };
  return fake;
}

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function idle(client: ApiClient): Promise<void> {
  await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
  await settle(5);
}

const rex = { id: '1', name: 'Rex', tag: 'dog' };
const tom = { id: '2', name: 'Tom', tag: 'cat' };

const UNAVAILABLE = { absent: 'removed', notFound: 'unavailable' };

/**
 * A client that synced rex and tom, then queued `edits` updates of rex. The
 * provider answers every write 503 until `unblock()`, so the first edit is
 * between retries (unsent, not in flight) and the others wait behind it.
 * Then rex is dropped from the list (`relist()` puts it back). Returns
 * before the next sync.
 */
async function editedThenMissing(
  options: {
    doc?: OpenApiDocument;
    item?: (id: string) => TransportResponse | undefined;
    deletions?: () => unknown[];
    client?: ApiClientOptions;
    edits?: number;
  } = {},
): Promise<{
  client: ApiClient;
  storage: CrashableStorage;
  fake: ReturnType<typeof provider>;
  reports: MissingRecord[];
  unblock: () => void;
  relist: () => void;
}> {
  let listRex = true;
  let blocked = true;
  const reports: MissingRecord[] = [];
  const fake = provider([rex, tom], {
    listed: (pet) => listRex || pet['id'] !== '1',
    ...(options.item ? { item: options.item } : {}),
    ...(options.deletions ? { deletions: options.deletions } : {}),
    behave: () =>
      blocked ? response({ error: 'invented' }, 503) : undefined,
  });
  const storage = new CrashableStorage();
  const client = createApiClient(options.doc ?? document(), {
    onMissingRecord: (r) => reports.push(r),
    ...options.client,
    storage,
    transport: fake.transport,
    retry: { baseDelayMs: 60_000 },
  });
  await client.sync();
  for (let i = 0; i < (options.edits ?? 1); i++)
    await client.update('/pets', '1', { name: `Rex ${i + 2}` });
  await vi.waitFor(() => expect(client.pendingWrites()[0]?.attempts).toBe(1));
  await settle(5);
  // Only the 503s so far; tests look at the writes after this point.
  fake.writes.length = 0;
  listRex = false;
  return {
    client,
    storage,
    fake,
    reports,
    unblock: (): void => {
      blocked = false;
    },
    relist: (): void => {
      listRex = true;
    },
  };
}

const gone = (status: number) => (): TransportResponse =>
  response({ error: 'gone' }, status);

describe('notFound: unavailable (Collection Completeness 0.2.0 §4.3)', () => {
  for (const [method, status] of [
    ['put', 404],
    ['patch', 404],
    ['put', 410],
  ] as const)
    it(`fails a ${method.toUpperCase()} update as unavailable, not deleted, when the GET answers ${status}`, async () => {
      const { client, fake, reports } = await editedThenMissing({
        doc: document({ completeness: UNAVAILABLE, method }),
        item: gone(status),
        edits: 2,
      });
      await client.sync();
      expect(fake.itemGets).toEqual(['1']);
      expect(reports).toEqual([
        {
          resource: 'pets',
          id: '1',
          evidence: 'unavailable',
          source: 'read',
          status,
        },
      ]);
      // §4.3: never reported as deleted; the queued write is held for a
      // decision (failed: resolveWrite retries or discards it), not sent.
      expect(client.pendingWrites()).toMatchObject([
        {
          state: 'failed',
          missingRecord: 'unavailable',
          lastStatus: status,
          lastError: expect.stringMatching(
            new RegExp(
              `^Record 1 is unavailable at the provider \\(GET /api/pets/1 answered ${status}, which the API document declares means the record is unavailable to this caller`,
            ),
          ),
        },
        { state: 'failed', missingRecord: 'unavailable' },
      ]);
      expect(client.pendingWrites().map((w) => w.missingRecord)).toEqual([
        'unavailable',
        'unavailable',
      ]);
      await settle();
      expect(fake.writes).toEqual([]);
      // The last known values are kept, with the edits on top.
      expect(await client.get('/pets', '1')).toEqual({
        id: '1',
        name: 'Rex 3',
        tag: 'dog',
      });
    });

  for (const [label, completeness] of [
    ['no notFound', { absent: 'removed' }],
    ['notFound: deleted', { absent: 'removed', notFound: 'deleted' }],
    ['an unrecognised notFound value', { absent: 'removed', notFound: 'gone' }],
  ] as const)
    it(`keeps the default, deleted, with ${label}`, async () => {
      const { client, reports } = await editedThenMissing({
        doc: document({ completeness }),
        item: gone(404),
      });
      await client.sync();
      expect(reports).toMatchObject([{ evidence: 'deleted', source: 'read' }]);
      expect(client.pendingWrites()).toMatchObject([
        { state: 'failed', missingRecord: 'deleted' },
      ]);
    });

  it('keeps the default, deleted, without a declaration', async () => {
    const { client, reports } = await editedThenMissing({ item: gone(404) });
    await client.sync();
    expect(reports).toMatchObject([{ evidence: 'deleted', source: 'read' }]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted' },
    ]);
  });

  for (const [label, doc] of [
    [
      'the list operation of a CRUD Causality document',
      document({ completeness: UNAVAILABLE, onOperation: true }),
    ],
    [
      'the list operation of a document without crudResources',
      document({ completeness: UNAVAILABLE, legacy: true }),
    ],
  ] as const)
    it(`reads notFound from ${label}`, async () => {
      const { client, reports } = await editedThenMissing({
        doc,
        item: gone(404),
      });
      await client.sync();
      expect(reports).toMatchObject([
        { evidence: 'unavailable', source: 'read', status: 404 },
      ]);
      expect(client.pendingWrites()).toMatchObject([
        { state: 'failed', missingRecord: 'unavailable' },
      ]);
    });

  it('reads nothing with absent: deleted (where notFound is not allowed)', async () => {
    const { client, fake, reports } = await editedThenMissing({
      doc: document({
        completeness: { absent: 'deleted', notFound: 'unavailable' },
      }),
    });
    await client.sync();
    expect(fake.itemGets).toEqual([]);
    expect(reports).toMatchObject([
      { evidence: 'deleted', source: 'declaration' },
    ]);
  });

  it('lets a later complete read that returns the record supersede the mark: a new update is sent at once', async () => {
    const { client, fake, reports, unblock, relist } =
      await editedThenMissing({
        doc: document({ completeness: UNAVAILABLE }),
        item: gone(404),
      });
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'unavailable' },
    ]);
    // The record is back in the list (the caller regained access, say).
    relist();
    fake.pets.set('1', { ...rex, tag: 'hound' });
    unblock();
    await client.sync();
    expect(reports).toHaveLength(1);
    // The failed edit waits for a decision; a new edit of another field is
    // not held (one of the same field would settle it away, as always).
    await client.update('/pets', '1', { tag: 'husky' });
    await vi.waitFor(() =>
      expect(fake.writes.map((w) => w.method)).toEqual(['PUT']),
    );
    expect(JSON.parse(fake.writes[0]?.body ?? '{}')).toEqual({
      id: '1',
      name: 'Rex',
      tag: 'husky',
    });
    await settle();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'unavailable' },
    ]);
    // The decision: resend the failed edit, which no longer carries the mark.
    await client.resolveWrite('/pets', '1', { action: 'retry' });
    await idle(client);
    expect(fake.writes.map((w) => w.method)).toEqual(['PUT', 'PUT']);
    expect(JSON.parse(fake.writes[1]?.body ?? '{}')).toEqual({
      id: '1',
      name: 'Rex 2',
      tag: 'husky',
    });
  });

  it('lets a later 2xx read of the record supersede the mark: a new update is checked and sent on the returned record', async () => {
    let gone404 = true;
    const { client, fake, reports, unblock } = await editedThenMissing({
      doc: document({ completeness: UNAVAILABLE }),
      item: (id) => (gone404 && id === '1' ? gone(404)() : undefined),
    });
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'unavailable' },
    ]);
    // Still off the list: a new edit is held and checked by the next sync.
    unblock();
    await client.update('/pets', '1', { tag: 'hound' });
    await settle();
    expect(fake.writes).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'unavailable' },
      { state: 'pending', awaitingRefresh: true },
    ]);
    // Now readable again: filtered, so the new edit goes out on that copy.
    gone404 = false;
    fake.pets.set('1', { ...rex, name: 'Rexy' });
    await client.sync();
    expect(reports.map((r) => r.evidence)).toEqual([
      'unavailable',
      'filtered',
    ]);
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    expect(JSON.parse(fake.writes[0]?.body ?? '{}')).toEqual({
      id: '1',
      name: 'Rexy',
      tag: 'hound',
    });
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'unavailable' },
    ]);
  });

  it('stores and restores missingRecord: unavailable on a failed update', async () => {
    const { client, storage } = await editedThenMissing({
      doc: document({ completeness: UNAVAILABLE }),
      item: gone(404),
    });
    await client.sync();
    const stored = storage.data.get(OUTBOX)?.get('outbox') as {
      records: { failed: { missingRecord?: string }[] }[];
    };
    expect(stored.records[0]?.failed[0]?.missingRecord).toBe('unavailable');
    const again = createApiClient(document({ completeness: UNAVAILABLE }), {
      storage: storage.crash(),
      transport: provider([tom]).transport,
    });
    await again.ready();
    expect(again.pendingWrites()).toMatchObject([
      { id: '1', state: 'failed', missingRecord: 'unavailable' },
    ]);
  });

  it("reports a vanished record's 404 as unavailable with missingRecordChecks 'all'", async () => {
    let listTom = true;
    const reports: MissingRecord[] = [];
    const fake = provider([rex, tom], {
      listed: (pet) => listTom || pet['id'] !== '2',
      item: (id) => (id === '2' ? gone(404)() : undefined),
    });
    const client = createApiClient(document({ completeness: UNAVAILABLE }), {
      transport: fake.transport,
      missingRecordChecks: 'all',
      onMissingRecord: (r) => reports.push(r),
    });
    await client.sync();
    listTom = false;
    await client.sync();
    expect(reports).toEqual([
      {
        resource: 'pets',
        id: '2',
        evidence: 'unavailable',
        source: 'read',
        status: 404,
      },
    ]);
    // As for every record without writes, the complete read pruned the
    // visible copy; keeping the last known values is the app's call here.
    expect(await client.get('/pets', '2')).toBeUndefined();
  });

  describe('with a deletion feed', () => {
    it('lets a tombstone in the feed stand over the unavailable answer', async () => {
      const { client, fake, reports } = await editedThenMissing({
        doc: document({ completeness: UNAVAILABLE, feed: true }),
        item: gone(404),
        deletions: () => [{ id: '1' }],
      });
      // The feed is read once per sync, at its end, after the GET.
      const feedReads = fake.feedReads;
      await client.sync();
      expect(fake.itemGets).toEqual(['1']);
      expect(fake.feedReads).toBe(feedReads + 1);
      expect(reports).toEqual([
        { resource: 'pets', id: '1', evidence: 'deleted', source: 'feed' },
      ]);
      expect(client.pendingWrites()).toMatchObject([
        { state: 'failed', missingRecord: 'deleted' },
      ]);
    });

    it('keeps the unavailable answer when the feed has no tombstone for the record', async () => {
      const { client, fake, reports } = await editedThenMissing({
        doc: document({ completeness: UNAVAILABLE, feed: true }),
        item: gone(404),
        deletions: () => [{ id: '2' }],
      });
      const feedReads = fake.feedReads;
      await client.sync();
      expect(fake.feedReads).toBe(feedReads + 1);
      expect(reports).toEqual([
        {
          resource: 'pets',
          id: '1',
          evidence: 'unavailable',
          source: 'read',
          status: 404,
        },
      ]);
      expect(client.pendingWrites()).toMatchObject([
        { state: 'failed', missingRecord: 'unavailable', lastStatus: 404 },
      ]);
    });
  });
});
