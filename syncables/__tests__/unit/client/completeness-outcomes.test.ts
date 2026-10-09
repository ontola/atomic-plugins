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
import { resourceNotFound } from '../../../src/client/client.js';
import { discoverReadModel } from '../../../src/read/model.js';
import { nestedTaskLists } from '../../fixtures/deletion-declarations.js';
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
    behave: () => (blocked ? response({ error: 'invented' }, 503) : undefined),
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
      // The report carries the last known values (the confirmed copy).
      expect(reports).toEqual([
        {
          resource: 'pets',
          id: '1',
          evidence: 'unavailable',
          source: 'read',
          status,
          record: rex,
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

  it('reads an unrecognised notFound value as unavailable, the safe direction', async () => {
    const { client, reports } = await editedThenMissing({
      doc: document({ completeness: { absent: 'removed', notFound: 'gone' } }),
      item: gone(404),
    });
    await client.sync();
    expect(reports).toMatchObject([
      { evidence: 'unavailable', source: 'read' },
    ]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'unavailable' },
    ]);
  });

  for (const [label, completeness] of [
    ['no notFound', { absent: 'removed' }],
    ['notFound: deleted', { absent: 'removed', notFound: 'deleted' }],
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
    const { client, fake, reports, unblock, relist } = await editedThenMissing({
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
    expect(reports.map((r) => r.evidence)).toEqual(['unavailable', 'filtered']);
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

  it('fails a DELETE queued behind the update of an unavailable record instead of sending it', async () => {
    const { client, fake, unblock } = await editedThenMissing({
      doc: document({ completeness: UNAVAILABLE }),
      item: gone(404),
    });
    await client.remove('/pets', '1');
    await client.sync();
    // §4.3: no write queued for the record is sent without a decision.
    expect(client.pendingWrites()).toMatchObject([
      { type: 'update', state: 'failed', missingRecord: 'unavailable' },
      {
        type: 'delete',
        state: 'failed',
        missingRecord: 'unavailable',
        lastStatus: 404,
        lastError: expect.stringMatching(/unavailable at the provider/),
      },
    ]);
    unblock();
    await settle();
    expect(fake.writes).toEqual([]);
    // The decision: drop both.
    await client.resolveWrite('/pets', '1', { action: 'discard' });
    expect(client.pendingWrites()).toEqual([]);
    await settle();
    expect(fake.writes).toEqual([]);
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
        record: tom,
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
          record: rex,
        },
      ]);
      expect(client.pendingWrites()).toMatchObject([
        { state: 'failed', missingRecord: 'unavailable', lastStatus: 404 },
      ]);
    });
  });
});

// --- §4.4, parentAbsent: the members of a nested collection whose parent
// object is concluded gone, on the spec's §6.1 task lists.

type Row = Record<string, unknown>;

/**
 * A fake task-list provider for `nestedTaskLists`: lists at
 * `/users/me/lists`, each list's tasks at `/lists/{listId}/tasks`. `hidden`
 * lists are left out of the lists read; `listRead` may answer a GET of one
 * list itself (else 200 while the list exists, 404 once removed);
 * `blocked` answers every write 503. Records every request as
 * "METHOD /path".
 */
function taskProvider(
  lists: Row[],
  tasks: Record<string, Row[]>,
): {
  lists: Map<string, Row>;
  tasks: Map<string, Map<string, Row>>;
  hidden: Set<string>;
  blocked: boolean;
  listRead: ((id: string) => TransportResponse | undefined) | undefined;
  requests: string[];
  writes: TransportRequest[];
  transport: Transport;
} {
  const fake = {
    lists: new Map(lists.map((l) => [String(l['id']), l])),
    tasks: new Map(
      Object.entries(tasks).map(([listId, rows]) => [
        listId,
        new Map(rows.map((t) => [String(t['id']), t])),
      ]),
    ),
    hidden: new Set<string>(),
    blocked: false,
    listRead: undefined as
      | ((id: string) => TransportResponse | undefined)
      | undefined,
    requests: [] as string[],
    writes: [] as TransportRequest[],
    transport: (async (r) => {
      const path = r.url.pathname;
      fake.requests.push(`${r.method} ${path}`);
      const parts = path.split('/').map(decodeURIComponent);
      if (r.method === 'GET' && path === '/users/me/lists')
        return response(
          [...fake.lists.values()].filter(
            (l) => !fake.hidden.has(String(l['id'])),
          ),
        );
      if (r.method === 'GET' && path === '/users/me/starred')
        return response([]);
      if (r.method === 'GET' && parts[1] === 'users' && parts[4]) {
        const list = fake.listRead?.(parts[4]) ?? undefined;
        if (list) return list;
        const found = fake.lists.get(parts[4]);
        return found ? response(found) : response({ error: 'gone' }, 404);
      }
      const listTasks = fake.tasks.get(parts[2] ?? '');
      if (r.method === 'GET' && parts[1] === 'lists' && !parts[4])
        return listTasks
          ? response([...listTasks.values()])
          : response({ error: 'gone' }, 404);
      const task = listTasks?.get(parts[4] ?? '');
      if (r.method === 'GET')
        return task ? response(task) : response({ error: 'gone' }, 404);
      fake.writes.push(r);
      if (fake.blocked) return response({ error: 'invented' }, 503);
      if (r.method === 'POST' && listTasks) {
        const created = {
          ...JSON.parse(r.body ?? '{}'),
          id: `n${fake.writes.length}`,
        };
        listTasks.set(String(created['id']), created);
        return response(created, 201);
      }
      if (r.method === 'PUT' && listTasks) {
        const updated = { ...JSON.parse(r.body ?? '{}'), id: parts[4] };
        listTasks.set(parts[4] ?? '', updated);
        return response(updated);
      }
      return response({ error: 'gone' }, 404);
    }) as Transport,
  };
  return fake;
}

const L1 = { id: 'L1', title: 'Home' };
const L2 = { id: 'L2', title: 'Work' };
const t1 = { id: 't1', title: 'Water plants' };
const t2 = { id: 't2', title: 'Write report' };
const t3 = { id: 't3', title: 'Book room' };

function nestedDocument(
  edit: (
    resources: Record<string, Row>,
    paths: Record<string, Row>,
  ) => void = (): void => undefined,
): OpenApiDocument {
  const doc = structuredClone(nestedTaskLists);
  edit(
    doc.components!['crudResources'] as Record<string, Row>,
    doc.paths as unknown as Record<string, Row>,
  );
  return prepareDocument(doc);
}

const completenessOf = (
  resources: Record<string, Row>,
  resource: string,
  collection: string,
): Row =>
  (resources[resource]!['collections'] as Record<string, Row>)[collection]![
    'x-completeness'
  ] as Row;

/**
 * A client that synced two lists and their tasks (`t1` in L1, `t2` and
 * `t3` in L2), optionally queued an update of `t2` that is between retries
 * (every write 503), then lost L2 from the lists read. Returns before the
 * next sync; `fake.requests` and `reports` hold only what follows.
 */
async function listsThenGone(
  options: {
    doc?: OpenApiDocument;
    edit?: boolean;
    client?: ApiClientOptions;
  } = {},
): Promise<{
  client: ApiClient;
  fake: ReturnType<typeof taskProvider>;
  reports: MissingRecord[];
}> {
  const fake = taskProvider([L1, L2], { L1: [t1], L2: [t2, t3] });
  const reports: MissingRecord[] = [];
  const client = createApiClient(options.doc ?? nestedDocument(), {
    onMissingRecord: (r) => reports.push(r),
    ...options.client,
    transport: fake.transport,
    retry: { baseDelayMs: 60_000 },
  });
  await client.sync();
  if (options.edit) {
    fake.blocked = true;
    await client.update(
      'listTasks',
      't2',
      { title: 'Write the report' },
      { listId: 'L2' },
    );
    await vi.waitFor(() => expect(client.pendingWrites()[0]?.attempts).toBe(1));
    await settle(5);
  }
  fake.hidden.add('L2');
  fake.lists.delete('L2');
  fake.requests.length = 0;
  fake.writes.length = 0;
  return { client, fake, reports };
}

describe('parentAbsent (Collection Completeness 0.2.0 §4.4)', () => {
  it('§6.1: a list that answers 404 is unavailable, and so is every task last read in it, without reading them', async () => {
    const { client, fake, reports } = await listsThenGone({
      client: { missingRecordChecks: 'all' },
    });
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /users/me/lists',
      'GET /lists/L1/tasks',
      'GET /users/me/lists/L2',
    ]);
    expect(reports).toEqual([
      {
        resource: 'taskLists',
        id: 'L2',
        evidence: 'unavailable',
        source: 'read',
        status: 404,
        record: L2,
      },
      {
        resource: 'listTasks',
        id: 't2',
        context: { listId: 'L2' },
        evidence: 'unavailable',
        source: 'parent',
        record: t2,
      },
      {
        resource: 'listTasks',
        id: 't3',
        context: { listId: 'L2' },
        evidence: 'unavailable',
        source: 'parent',
        record: t3,
      },
    ]);
    // Nothing is pruned: the tasks keep their last known values.
    expect(await client.get('listTasks', 't2', { listId: 'L2' })).toEqual(t2);
    expect(await client.get('listTasks', 't3', { listId: 'L2' })).toEqual(t3);
    expect(await client.get('listTasks', 't1', { listId: 'L1' })).toEqual(t1);
  });

  it('checks a vanished list without writes when a task under it has a queued update, and fails that update as unavailable', async () => {
    const { client, fake, reports } = await listsThenGone({ edit: true });
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /users/me/lists',
      'GET /lists/L1/tasks',
      'GET /users/me/lists/L2',
    ]);
    expect(reports.map((r) => [r.id, r.evidence, r.source])).toEqual([
      ['L2', 'unavailable', 'read'],
      ['t2', 'unavailable', 'parent'],
      ['t3', 'unavailable', 'parent'],
    ]);
    expect(client.pendingWrites()).toMatchObject([
      {
        id: 't2',
        context: { listId: 'L2' },
        state: 'failed',
        missingRecord: 'unavailable',
        lastError: expect.stringMatching(
          /^Record t2 is unavailable at the provider \(its parent taskList L2 of taskLists was concluded unavailable: GET \/users\/me\/lists\/L2 answered 404/,
        ),
      },
    ]);
    expect(client.pendingWrites()[0]).not.toHaveProperty('lastStatus');
    fake.blocked = false;
    await settle();
    expect(fake.writes).toEqual([]);
    expect(await client.get('listTasks', 't2', { listId: 'L2' })).toEqual({
      ...t2,
      title: 'Write the report',
    });
    // The list returns: its tasks are read again, and new edits go out.
    fake.hidden.delete('L2');
    fake.lists.set('L2', L2);
    fake.requests.length = 0;
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /users/me/lists',
      'GET /lists/L1/tasks',
      'GET /lists/L2/tasks',
    ]);
    await client.update('listTasks', 't2', { due: 'Friday' }, { listId: 'L2' });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    expect(JSON.parse(fake.writes[0]?.body ?? '{}')).toEqual({
      ...t2,
      due: 'Friday',
    });
    // Settled; the failed edit still waits for the decision.
    await vi.waitFor(() =>
      expect(client.pendingWrites()).toMatchObject([
        { state: 'failed', missingRecord: 'unavailable' },
      ]),
    );
  });

  it('does not read a vanished list that has no writes under it by default', async () => {
    const { client, fake, reports } = await listsThenGone();
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /users/me/lists',
      'GET /lists/L1/tasks',
    ]);
    expect(reports).toEqual([]);
  });

  it('makes the tasks unavailable, never deleted, under a parent collection declared absent: deleted, without any GET', async () => {
    // §4.4 (0.2.0 round 6): no deleted cascade; deleting a member needs
    // evidence about the member itself.
    const doc = nestedDocument((resources) => {
      resources['taskList']!['collections'] = {
        taskLists: {
          urlTemplate: '/users/me/lists',
          'x-completeness': { absent: 'deleted' },
        },
      };
    });
    const { client, fake, reports } = await listsThenGone({ doc, edit: true });
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /users/me/lists',
      'GET /lists/L1/tasks',
    ]);
    expect(reports.map((r) => [r.id, r.evidence, r.source])).toEqual([
      ['L2', 'deleted', 'declaration'],
      ['t2', 'unavailable', 'parent'],
      ['t3', 'unavailable', 'parent'],
    ]);
    expect(client.pendingWrites()).toMatchObject([
      {
        id: 't2',
        state: 'failed',
        missingRecord: 'unavailable',
        lastError: expect.stringMatching(
          /its parent taskList L2 of taskLists was concluded deleted: the API document declares/,
        ),
      },
    ]);
    // Nothing is pruned.
    expect(await client.get('listTasks', 't3', { listId: 'L2' })).toEqual(t3);
  });

  for (const value of ['unavailable', 'deleted', 'gone'])
    for (const [label, parent, conclusion] of [
      [
        'a 404 under a stated notFound: deleted',
        { absent: 'removed', notFound: 'deleted' },
        ['L2', 'deleted', 'read'],
      ],
      [
        'a 404 under the notFound default',
        { absent: 'removed' },
        ['L2', 'deleted', 'read'],
      ],
      [
        'a 404 under notFound: unavailable',
        { absent: 'removed', notFound: 'unavailable' },
        ['L2', 'unavailable', 'read'],
      ],
    ] as const)
      it(`reads parentAbsent: ${value} as unavailable under a parent concluded by ${label}`, async () => {
        const doc = nestedDocument((resources) => {
          resources['taskList']!['collections'] = {
            taskLists: {
              urlTemplate: '/users/me/lists',
              'x-completeness': parent,
            },
          };
          completenessOf(resources, 'task', 'listTasks')['parentAbsent'] =
            value;
        });
        const { client, reports } = await listsThenGone({ doc, edit: true });
        await client.sync();
        expect(reports.map((r) => [r.id, r.evidence, r.source])).toEqual([
          conclusion,
          ['t2', 'unavailable', 'parent'],
          ['t3', 'unavailable', 'parent'],
        ]);
        expect(client.pendingWrites()).toMatchObject([
          { id: 't2', state: 'failed', missingRecord: 'unavailable' },
        ]);
      });

  it('does not mark a member that this sync read under another parent (it moved)', async () => {
    const { client, fake, reports } = await listsThenGone({
      client: { missingRecordChecks: 'all' },
    });
    fake.tasks.get('L1')!.set('t2', t2);
    await client.sync();
    expect(reports.map((r) => [r.id, r.evidence, r.source])).toEqual([
      ['L2', 'unavailable', 'read'],
      ['t3', 'unavailable', 'parent'],
    ]);
  });

  it('ignores parentAbsent on a collection with two parent resources', async () => {
    // §4.4: a collection whose path variables two other resources bind has
    // no single parent object, and this version does not describe it.
    const doc = nestedDocument((resources, paths) => {
      resources['owner'] = {
        identity: {
          urlTemplate: '/owners/{ownerId}',
          bindings: { ownerId: { field: 'id' } },
        },
        collections: { owners: { urlTemplate: '/owners' } },
      };
      paths['/owners'] = {
        get: { responses: { '200': { description: 'Owners' } } },
      };
      paths['/owners/{ownerId}'] = {
        get: {
          parameters: [
            {
              name: 'ownerId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'An owner' } },
        },
      };
      const tasks = (resources['task']!['collections'] as Record<string, Row>)[
        'listTasks'
      ]!;
      tasks['urlTemplate'] = '/owners/{ownerId}/lists/{listId}/tasks';
      paths['/owners/{ownerId}/lists/{listId}/tasks'] =
        paths['/lists/{listId}/tasks']!;
      delete paths['/lists/{listId}/tasks'];
    });
    const fake = taskProvider([L1, L2], { L1: [t1], L2: [t2, t3] });
    const inner = fake.transport;
    const reports: MissingRecord[] = [];
    // The owners read and the re-shaped task lists, over the same fake.
    const transport: Transport = async (r) => {
      if (r.url.pathname === '/owners') return response([{ id: 'o1' }]);
      const url = new URL(r.url);
      url.pathname = url.pathname.replace(/^\/owners\/o1/, '');
      return inner({ ...r, url });
    };
    const client = createApiClient(doc, {
      transport,
      missingRecordChecks: 'all',
      onMissingRecord: (r) => reports.push(r),
    });
    await client.sync();
    expect(
      await client.get('listTasks', 't2', { ownerId: 'o1', listId: 'L2' }),
    ).toEqual(t2);
    fake.hidden.add('L2');
    fake.lists.delete('L2');
    await client.sync();
    expect(reports).toMatchObject([{ id: 'L2', evidence: 'unavailable' }]);
  });

  // §4.3 (0.2.0 round 6): notFound is resource-wide. The lists read that
  // supplies listId, taskLists, is set up per case; the 404 of L2's own
  // read follows what the taskList resource states through any collection.
  for (const [label, collections, operation, evidence] of [
    [
      'another collection that states notFound: unavailable',
      {
        taskLists: { urlTemplate: '/users/me/lists' },
        starredLists: {
          urlTemplate: '/users/me/starred',
          'x-completeness': { absent: 'removed', notFound: 'unavailable' },
        },
      },
      undefined,
      'unavailable',
    ],
    [
      'its own absent: removed without notFound, beside one stating unavailable',
      {
        taskLists: {
          urlTemplate: '/users/me/lists',
          'x-completeness': { absent: 'removed' },
        },
        starredLists: {
          urlTemplate: '/users/me/starred',
          'x-completeness': { absent: 'removed', notFound: 'unavailable' },
        },
      },
      undefined,
      'unavailable',
    ],
    [
      'collections that state different values (the safe direction)',
      {
        taskLists: {
          urlTemplate: '/users/me/lists',
          'x-completeness': { absent: 'removed', notFound: 'deleted' },
        },
        starredLists: {
          urlTemplate: '/users/me/starred',
          'x-completeness': { absent: 'removed', notFound: 'unavailable' },
        },
      },
      undefined,
      'unavailable',
    ],
    [
      'a notFound stated beside an absent this client does not recognise',
      {
        taskLists: { urlTemplate: '/users/me/lists' },
        starredLists: {
          urlTemplate: '/users/me/starred',
          'x-completeness': { absent: 'archived', notFound: 'unavailable' },
        },
      },
      undefined,
      'unavailable',
    ],
    [
      'the x-crud list operation of another collection',
      {
        taskLists: { urlTemplate: '/users/me/lists' },
        starredLists: { urlTemplate: '/users/me/starred' },
      },
      {
        'x-crud': {
          action: 'list',
          resource: 'taskList',
          collection: 'starredLists',
        },
        'x-completeness': { absent: 'removed', notFound: 'unavailable' },
        responses: { '200': { description: 'Starred lists, v2' } },
      },
      'unavailable',
    ],
    [
      'no collection that states it (the default)',
      {
        taskLists: { urlTemplate: '/users/me/lists' },
        starredLists: {
          urlTemplate: '/users/me/starred',
          'x-completeness': { absent: 'removed' },
        },
      },
      undefined,
      'deleted',
    ],
  ] as const)
    it(`classifies a 404 through an undeclared collection by ${label}`, async () => {
      const doc = nestedDocument((resources, paths) => {
        resources['taskList']!['collections'] = structuredClone(collections);
        paths['/users/me/starred'] = {
          get: { responses: { '200': { description: 'Starred lists' } } },
        };
        if (operation) paths['/v2/starred'] = { get: structuredClone(operation) };
      });
      const { client, fake, reports } = await listsThenGone({
        doc,
        edit: true,
      });
      await client.sync();
      expect(fake.requests).toContain('GET /users/me/lists/L2');
      expect(reports.map((r) => [r.id, r.evidence, r.source])).toEqual([
        ['L2', evidence, 'read'],
        ['t2', 'unavailable', 'parent'],
        ['t3', 'unavailable', 'parent'],
      ]);
    });

  it('draws no parent marks from a collection whose absent is not recognised', async () => {
    const doc = nestedDocument((resources) => {
      completenessOf(resources, 'task', 'listTasks')['absent'] = 'archived';
    });
    const { client, reports } = await listsThenGone({
      doc,
      client: { missingRecordChecks: 'all' },
    });
    await client.sync();
    expect(reports).toMatchObject([{ id: 'L2', evidence: 'unavailable' }]);
  });

  it('parks a create into the nested scope of an unavailable parent instead of sending it', async () => {
    const doc = nestedDocument((_, paths) => {
      (paths['/lists/{listId}/tasks'] as Record<string, Row>)['post'] = {
        requestBody: { content: { 'application/json': { schema: {} } } },
        responses: { '201': { description: 'Created' } },
      };
    });
    const { client, fake } = await listsThenGone({
      doc,
      client: { missingRecordChecks: 'all' },
    });
    await client.sync();
    const created = await client.create(
      'listTasks',
      { title: 'New' },
      { listId: 'L2' },
    );
    await settle();
    expect(fake.writes).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      {
        type: 'create',
        id: created['id'],
        state: 'failed',
        missingRecord: 'unavailable',
        lastError: expect.stringMatching(
          /unavailable at the provider \(its parent taskList L2 of taskLists/,
        ),
      },
    ]);
    // Visible meanwhile, as a parked create is.
    expect(
      await client.get('listTasks', String(created['id']), { listId: 'L2' }),
    ).toMatchObject({ title: 'New' });
    // A create into a list that is still there goes out.
    await client.create('listTasks', { title: 'Other' }, { listId: 'L1' });
    await vi.waitFor(() =>
      expect(fake.writes.map((w) => `${w.method} ${w.url.pathname}`)).toEqual([
        'POST /lists/L1/tasks',
      ]),
    );
  });

  it('concludes a new edit of a member under an unavailable parent at once, and sends edits again once the list is back', async () => {
    const { client, fake } = await listsThenGone({
      client: { missingRecordChecks: 'all' },
    });
    await client.sync();
    // Nothing was pruned, so the record is still confirmed locally; the
    // edit is still not sent as a PUT on a record the caller cannot read.
    await client.update(
      'listTasks',
      't3',
      { title: 'Book a bigger room' },
      { listId: 'L2' },
    );
    await settle();
    expect(fake.writes).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      {
        id: 't3',
        state: 'failed',
        missingRecord: 'unavailable',
        lastError: expect.stringMatching(
          /its parent taskList L2 of taskLists was concluded unavailable/,
        ),
      },
    ]);
    expect(await client.get('listTasks', 't3', { listId: 'L2' })).toEqual({
      ...t3,
      title: 'Book a bigger room',
    });
    // The list returns: the read of its tasks lifts the mark.
    fake.hidden.delete('L2');
    fake.lists.set('L2', L2);
    await client.sync();
    await client.update('listTasks', 't3', { due: 'Monday' }, { listId: 'L2' });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    expect(JSON.parse(fake.writes[0]?.body ?? '{}')).toEqual({
      ...t3,
      due: 'Monday',
    });
  });

  it('draws no conclusion about the tasks when the list still exists (its read answers 200)', async () => {
    const { client, fake, reports } = await listsThenGone({
      client: { missingRecordChecks: 'all' },
    });
    fake.listRead = (id): TransportResponse | undefined =>
      id === 'L2' ? response({ ...L2, archived: true }) : undefined;
    await client.sync();
    expect(reports).toMatchObject([
      { id: 'L2', evidence: 'filtered', source: 'read' },
    ]);
    expect(fake.requests).not.toContain('GET /lists/L2/tasks');
  });

  for (const [label, doc] of [
    [
      'without parentAbsent',
      nestedDocument((resources) => {
        delete completenessOf(resources, 'task', 'listTasks')['parentAbsent'];
      }),
    ],
    [
      'with parentAbsent on the list operation instead of the Collection Object',
      nestedDocument((resources, paths) => {
        const completeness = completenessOf(resources, 'task', 'listTasks');
        delete (resources['task']!['collections'] as Record<string, Row>)[
          'listTasks'
        ]!['x-completeness'];
        (paths['/lists/{listId}/tasks']!['get'] as Row)['x-completeness'] =
          completeness;
      }),
    ],
  ] as const)
    it(`draws no conclusion about the tasks ${label}`, async () => {
      const { client, reports } = await listsThenGone({
        doc,
        client: { missingRecordChecks: 'all' },
      });
      await client.sync();
      expect(reports).toMatchObject([{ id: 'L2', evidence: 'unavailable' }]);
    });
});

// --- wp-consumer R2: the resource's stated notFound, as the Write
// Preconditions consumer's deletionConfirmed reads it (route.notFound).

describe('resourceNotFound (route.notFound, resource-wide)', () => {
  const collections = (
    doc: OpenApiDocument,
  ): ReturnType<typeof discoverReadModel>['collections'] =>
    discoverReadModel(doc).collections;
  const lists = (declared: Record<string, Row>): OpenApiDocument =>
    nestedDocument((resources, paths) => {
      resources['taskList']!['collections'] = declared;
      paths['/users/me/starred'] = {
        get: { responses: { '200': { description: 'Starred lists' } } },
      };
    });

  it('is undefined when no collection of the resource states it: the default is no confirmation', () => {
    const doc = lists({
      taskLists: {
        urlTemplate: '/users/me/lists',
        'x-completeness': { absent: 'removed' },
      },
    });
    expect(resourceNotFound(doc, collections(doc), 'taskList')).toBeUndefined();
  });

  it('is deleted only when stated so, and applies to an undeclared collection of the resource', () => {
    const doc = lists({
      taskLists: { urlTemplate: '/users/me/lists' },
      starredLists: {
        urlTemplate: '/users/me/starred',
        'x-completeness': { absent: 'removed', notFound: 'deleted' },
      },
    });
    expect(resourceNotFound(doc, collections(doc), 'taskList')).toBe(
      'deleted',
    );
  });

  it('is unavailable for different or unrecognised stated values', () => {
    for (const [first, second] of [
      ['deleted', 'unavailable'],
      ['deleted', 'gone'],
    ]) {
      const doc = lists({
        taskLists: {
          urlTemplate: '/users/me/lists',
          'x-completeness': { absent: 'removed', notFound: first },
        },
        starredLists: {
          urlTemplate: '/users/me/starred',
          'x-completeness': { absent: 'removed', notFound: second },
        },
      });
      expect(resourceNotFound(doc, collections(doc), 'taskList')).toBe(
        'unavailable',
      );
    }
  });
});
