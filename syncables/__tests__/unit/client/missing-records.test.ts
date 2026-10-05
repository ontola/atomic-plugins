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

// #260, Q-071 and Q-072: an unsent update whose record a complete refresh no
// longer returns is not sent on the last known copy. The client checks the
// record (the document's x-completeness declaration, else a GET) and fails
// the update (deleted, unknown) or keeps it on the returned copy (filtered).
// Transports and data are invented.

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

/**
 * The ordering invariant, as stored: per record, every failed write is older
 * (queued earlier) than every queued one.
 */
function expectFailedOlder(storage: CrashableStorage): void {
  const outbox = storage.data.get(OUTBOX)?.get('outbox') as
    | {
        records: {
          id: string;
          failed: { seq?: number }[];
          queue: { seq?: number }[];
        }[];
      }
    | undefined;
  for (const record of outbox?.records ?? []) {
    const failed = record.failed.map((w) => w.seq ?? -1);
    const queued = record.queue.map((w) => w.seq ?? Infinity);
    if (failed.length && queued.length)
      expect(Math.max(...failed), `record ${record.id}`).toBeLessThan(
        Math.min(...queued),
      );
  }
}

const response = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: value === undefined ? '' : JSON.stringify(value),
});

type Pet = Record<string, unknown>;

/** The pets fixture as a CRUD Causality document, optionally declared complete. */
function crudDocument(
  options: {
    completeness?: unknown;
    onOperation?: boolean;
    method?: 'put' | 'patch';
    itemGet?: boolean;
    /** The collection's fixed `x-list-query`. */
    listQuery?: Record<string, string>;
  } = {},
): OpenApiDocument {
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
          collections: {
            pets: {
              urlTemplate: '/pets',
              ...(options.listQuery
                ? { 'x-list-query': options.listQuery }
                : {}),
              ...(options.completeness && !options.onOperation
                ? { 'x-completeness': options.completeness }
                : {}),
            },
          },
        },
      },
    },
  });
  const item = doc.paths['/pets/{petId}']!;
  if (options.method === 'patch') {
    item.patch = item.put!;
    delete item.put;
  }
  if (options.itemGet === false) delete item.get;
  // A declared query parameter, so a selection may narrow the list by it.
  doc.paths['/pets']!.get!.parameters = [
    { name: 'tag', in: 'query', schema: { type: 'string' } },
  ];
  if (options.completeness && options.onOperation)
    doc.paths['/pets']!.get!['x-completeness'] = options.completeness;
  return doc;
}

/**
 * A fake provider. `listed` filters the collection list (all pets by
 * default); `item` may answer a GET of one pet itself; `behave` may answer
 * a write itself ('hang' never answers).
 */
function provider(
  initial: Pet[],
  hooks: {
    listed?: (pet: Pet) => boolean;
    item?: (id: string) => TransportResponse | undefined;
    behave?: (r: TransportRequest) => TransportResponse | 'hang' | undefined;
  } = {},
): {
  pets: Map<string, Pet>;
  writes: TransportRequest[];
  itemGets: string[];
  transport: Transport;
} {
  const pets = new Map(initial.map((p) => [String(p['id']), p]));
  const writes: TransportRequest[] = [];
  const itemGets: string[] = [];
  let next = 1;
  const transport: Transport = async (r) => {
    const id = decodeURIComponent(r.url.pathname.split('/')[3] ?? '');
    if (r.method === 'GET' && id) {
      itemGets.push(id);
      const answer = hooks.item?.(id);
      if (answer) return answer;
      const pet = pets.get(id);
      return pet ? response(pet) : response({ error: 'not found' }, 404);
    }
    if (r.method === 'GET')
      return response(
        [...pets.values()].filter(hooks.listed ?? ((): boolean => true)),
      );
    writes.push(r);
    const behaviour = hooks.behave?.(r);
    if (behaviour === 'hang')
      return new Promise<TransportResponse>(() => undefined);
    if (behaviour) return behaviour;
    if (r.method === 'POST') {
      const pet = { ...JSON.parse(r.body ?? '{}'), id: `srv-${next++}` };
      pets.set(pet.id, pet);
      return response(pet, 201);
    }
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
    if (r.method === 'DELETE') {
      pets.delete(id);
      return response(undefined, 204);
    }
    return response({}, 405);
  };
  return { pets, writes, itemGets, transport };
}

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function idle(client: ApiClient): Promise<void> {
  await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
  await settle(5);
}

const rex = { id: '1', name: 'Rex', tag: 'dog' };
const tom = { id: '2', name: 'Tom', tag: 'cat' };

/**
 * A client that synced rex and tom, then queued `edits` updates of rex. The
 * provider answers every write 503 until `unblock()`, so the first edit is
 * between retries (unsent, not in flight) and the others wait behind it.
 * Then rex is dropped from the list. Returns before the next sync.
 * `retryMs` is the backoff before the second attempt.
 */
async function editedThenMissing(
  options: {
    doc?: OpenApiDocument;
    item?: (id: string) => TransportResponse | undefined;
    client?: ApiClientOptions;
    edits?: number;
    retryMs?: number;
  } = {},
): Promise<{
  client: ApiClient;
  storage: CrashableStorage;
  fake: ReturnType<typeof provider>;
  unblock: () => void;
}> {
  let listRex = true;
  let blocked = true;
  const fake = provider([rex, tom], {
    listed: (pet) => listRex || pet['id'] !== '1',
    ...(options.item ? { item: options.item } : {}),
    behave: () => (blocked ? response({ error: 'invented' }, 503) : undefined),
  });
  const storage = new CrashableStorage();
  const client = createApiClient(options.doc ?? crudDocument(), {
    ...options.client,
    storage,
    transport: fake.transport,
    retry: { baseDelayMs: options.retryMs ?? 60_000 },
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
    unblock: (): void => {
      blocked = false;
    },
  };
}

describe('missing records: the 05d70ff regression (an update in flight)', () => {
  for (const second of ['deleted', 'filtered'] as const)
    it(`waits for the in-flight update, then ${second === 'deleted' ? 'fails' : 'sends'} the queued one, keeping failed writes older`, async () => {
      // u1 in flight, u2 queued, then a refresh without the record.
      const storage = new CrashableStorage();
      let answer!: () => void;
      const firstPut = new Promise<void>((resolve) => (answer = resolve));
      let listRex = true;
      let puts = 0;
      const fake = provider([rex, tom], {
        listed: (pet) => listRex || pet['id'] !== '1',
        behave: () => {
          puts += 1;
          return undefined;
        },
      });
      const client = createApiClient(crudDocument(), {
        storage,
        transport: async (r) => {
          if (r.method === 'PUT' && puts === 0) {
            await firstPut;
            // Deleted while u1 was in flight: u1 meets the 404.
            if (second === 'deleted') fake.pets.delete('1');
          }
          return fake.transport(r);
        },
      });
      await client.sync();
      await client.update('/pets', '1', { name: 'B' });
      await vi.waitFor(() =>
        expect(client.pendingWrites()[0]?.attempts).toBe(0),
      );
      await client.update('/pets', '1', { name: 'C' });
      expectFailedOlder(storage);
      listRex = false;
      await client.sync();
      expectFailedOlder(storage);
      // u1 is in flight and untouched; u2 waits; nothing was read yet.
      expect(client.pendingWrites()).toMatchObject([
        { state: 'pending' },
        { state: 'pending', awaitingRefresh: true },
      ]);
      expect(fake.itemGets).toEqual([]);

      answer();
      await vi.waitFor(() =>
        expect(
          client.pendingWrites().filter((w) => w.state === 'pending'),
        ).toHaveLength(1),
      );
      await settle();
      expectFailedOlder(storage);
      // u2 is not sent when u1 settles: it waits for the next sync.
      expect(puts).toBe(1);

      await client.sync();
      await settle();
      expectFailedOlder(storage);
      if (second === 'deleted') {
        // u1 met a 404 (permanent); u2 is failed by the GET's 404.
        expect(client.pendingWrites()).toMatchObject([
          { state: 'failed', lastStatus: 404, attempts: 1 },
          {
            state: 'failed',
            lastStatus: 404,
            attempts: 0,
            missingRecord: 'deleted',
            lastError: expect.stringMatching(/deleted at the provider/),
          },
        ]);
        expect(puts).toBe(1);
        // Both edits stay visible until the app decides.
        expect(await client.get('/pets', '1')).toMatchObject({ name: 'C' });
      } else {
        await idle(client);
        expect(puts).toBe(2);
        expect(fake.pets.get('1')).toMatchObject({ name: 'C', tag: 'dog' });
      }
    });

  it('waits behind an update that is between retries, then fails both in order', async () => {
    const storage = new CrashableStorage();
    let listRex = true;
    const fake = provider([rex], {
      listed: (pet) => listRex || pet['id'] !== '1',
      behave: () => response({ error: 'invented' }, 503),
      item: () => response({ error: 'invented' }, 410),
    });
    const client = createApiClient(crudDocument(), {
      storage,
      transport: fake.transport,
      retry: { baseDelayMs: 60_000 },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'B' });
    await vi.waitFor(() => expect(client.pendingWrites()[0]?.attempts).toBe(1));
    await client.update('/pets', '1', { name: 'C' });
    listRex = false;
    await client.sync();
    expectFailedOlder(storage);
    // The head was waiting to retry, not in flight: it is checked and both
    // fail, oldest first.
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 410 },
      { state: 'failed', missingRecord: 'deleted', lastStatus: 410 },
    ]);
    expect(fake.itemGets).toEqual(['1']);
  });
});

describe('missing records: PUT and PATCH, undeclared collection', () => {
  for (const method of ['put', 'patch'] as const) {
    for (const status of [404, 410])
      it(`fails a ${method.toUpperCase()} update when the GET answers ${status}`, async () => {
        const reports: MissingRecord[] = [];
        const { client, storage, fake } = await editedThenMissing({
          doc: crudDocument({ method }),
          item: () => response({ error: 'gone' }, status),
          client: { onMissingRecord: (r) => reports.push(r) },
          edits: 2,
        });
        await client.sync();
        expectFailedOlder(storage);
        expect(client.pendingWrites()).toMatchObject([
          {
            state: 'failed',
            missingRecord: 'deleted',
            lastStatus: status,
            lastError: expect.stringMatching(
              new RegExp(
                `deleted at the provider \\(GET /api/pets/1 answered ${status}\\)`,
              ),
            ),
          },
          { state: 'failed', missingRecord: 'deleted' },
        ]);
        expect(reports).toEqual([
          {
            resource: 'pets',
            id: '1',
            evidence: 'deleted',
            source: 'read',
            status,
          },
        ]);
        await settle();
        expect(fake.writes).toEqual([]);
        // Nothing is deleted locally: the edits stay visible.
        expect(await client.get('/pets', '1')).toMatchObject({ name: 'Rex 3' });
      });

    it(`keeps a ${method.toUpperCase()} update on the returned record when the GET answers 2xx`, async () => {
      const reports: MissingRecord[] = [];
      const conflicts: string[] = [];
      const { client, fake, unblock } = await editedThenMissing({
        doc: crudDocument({ method }),
        client: {
          onMissingRecord: (r) => reports.push(r),
          onConflict: (c) => conflicts.push(`${c.field}:${String(c.remote)}`),
        },
        // The edit's next attempt comes 300 ms after its first 503.
        retryMs: 300,
      });
      // Someone else renamed it and changed its tag; the list filters it out.
      fake.pets.set('1', { id: '1', name: 'Rexy', tag: 'wolf' });
      await client.sync();
      expect(reports).toMatchObject([
        {
          evidence: 'filtered',
          source: 'read',
          status: 200,
          record: { id: '1', name: 'Rexy', tag: 'wolf' },
        },
      ]);
      // Rebased on the returned copy: the rename is a conflict.
      expect(conflicts).toEqual(['name:Rexy']);
      expect(client.pendingWrites()).toMatchObject([
        { state: 'pending', conflicts: [{ field: 'name' }] },
      ]);
      expect(client.pendingWrites()[0]).not.toHaveProperty('awaitingRefresh');
      unblock();
      await idle(client);
      expect(JSON.parse(fake.writes[0]?.body ?? '{}')).toEqual({
        id: '1',
        name: 'Rex 2',
        tag: 'wolf',
      });
    });
  }

  for (const [label, item] of [
    ['a 503', (): TransportResponse => response({ error: 'invented' }, 503)],
    ['a 403', (): TransportResponse => response({ error: 'invented' }, 403)],
    ['a 2xx without the record', (): TransportResponse => response([rex])],
    ['a 2xx with another record', (): TransportResponse => response(tom)],
  ] as const)
    it(`fails the update as unknown when the GET answers ${label}`, async () => {
      const { client, storage, fake } = await editedThenMissing({ item });
      await client.sync();
      expectFailedOlder(storage);
      expect(client.pendingWrites()).toMatchObject([
        {
          state: 'failed',
          missingRecord: 'unknown',
          lastError: expect.stringMatching(/not in the refreshed collection/),
        },
      ]);
      await settle();
      expect(fake.writes).toEqual([]);
    });

  it('fails the update as unknown when the GET throws', async () => {
    const { client } = await editedThenMissing({
      item: () => {
        throw new Error('network down (invented)');
      },
    });
    await client.sync();
    expect(client.pendingWrites()[0]).toMatchObject({
      state: 'failed',
      missingRecord: 'unknown',
      lastError: expect.stringMatching(/network down/),
    });
    expect(client.pendingWrites()[0]).not.toHaveProperty('lastStatus');
  });

  it('fails the update as unknown without a GET when the document declares none', async () => {
    const reports: MissingRecord[] = [];
    const { client, fake } = await editedThenMissing({
      doc: crudDocument({ itemGet: false }),
      client: { onMissingRecord: (r) => reports.push(r) },
    });
    await client.sync();
    expect(fake.itemGets).toEqual([]);
    expect(reports).toMatchObject([{ evidence: 'unknown', source: 'none' }]);
    expect(client.pendingWrites()[0]).toMatchObject({
      state: 'failed',
      missingRecord: 'unknown',
      lastError: expect.stringMatching(/declares no GET/),
    });
  });

  it("makes no GET with missingRecordChecks 'none'", async () => {
    const { client, fake } = await editedThenMissing({
      client: { missingRecordChecks: 'none' },
    });
    await client.sync();
    expect(fake.itemGets).toEqual([]);
    expect(client.pendingWrites()[0]).toMatchObject({
      state: 'failed',
      missingRecord: 'unknown',
    });
  });

  it('retries a failed update on the last known record, clearing missingRecord', async () => {
    const { client, fake, unblock } = await editedThenMissing({
      item: () => response({}, 404),
      retryMs: 300,
    });
    await client.sync();
    await client.resolveWrite('/pets', '1', { action: 'retry' });
    // Its first resend meets the 503 again; it is pending, without the mark.
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]).toMatchObject({
        state: 'pending',
        attempts: 1,
      }),
    );
    expect(client.pendingWrites()[0]).not.toHaveProperty('missingRecord');
    unblock();
    // The fake still has rex (only the list and the GET hide it).
    await idle(client);
    expect(JSON.parse(fake.writes.at(-1)?.body ?? '{}')).toEqual({
      ...rex,
      name: 'Rex 2',
    });
  });

  it('holds a new update of a record whose update failed as missing, and checks it on the next sync', async () => {
    let gone = true;
    const { client, fake, unblock } = await editedThenMissing({
      item: (id) => (gone ? response({}, 404) : response({ ...rex, id })),
    });
    await client.sync();
    unblock();
    await client.update('/pets', '1', { tag: 'wolf' });
    expect(client.pendingWrites()[1]).toMatchObject({
      state: 'pending',
      awaitingRefresh: true,
    });
    await settle();
    expect(fake.writes).toEqual([]);
    gone = false;
    await client.sync();
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    // Built on the returned record, not on the failed edit's name.
    expect(JSON.parse(fake.writes[0]?.body ?? '{}')).toEqual({
      ...rex,
      tag: 'wolf',
    });
  });

  it('does not touch updates queued behind a create of the same record', async () => {
    const fake = provider([], {
      behave: (r) => (r.method === 'POST' ? response({}, 503) : undefined),
    });
    const client = createApiClient(crudDocument(), {
      transport: fake.transport,
      retry: { baseDelayMs: 60_000 },
    });
    await client.sync();
    const created = await client.create('/pets', { name: 'Milo' });
    const id = String(created['id']);
    await client.update('/pets', id, { tag: 'cat' });
    await client.sync();
    expect(fake.itemGets).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      { type: 'create', state: 'pending' },
      { type: 'update', state: 'pending' },
    ]);
    expect(client.pendingWrites()[1]).not.toHaveProperty('awaitingRefresh');
  });

  it('does not read records without writes unless missingRecordChecks is all', async () => {
    for (const checks of ['pending', 'all'] as const) {
      let listTom = true;
      const reports: MissingRecord[] = [];
      const fake = provider([rex, tom], {
        listed: (pet) => listTom || pet['id'] !== '2',
      });
      const client = createApiClient(crudDocument(), {
        transport: fake.transport,
        missingRecordChecks: checks,
        onMissingRecord: (r) => reports.push(r),
      });
      await client.sync();
      listTom = false;
      await client.sync();
      await client.sync();
      if (checks === 'pending') {
        expect(fake.itemGets).toEqual([]);
        expect(reports).toEqual([]);
      } else {
        // Checked once, in the sync that first missed it.
        expect(fake.itemGets).toEqual(['2']);
        expect(reports).toEqual([
          {
            resource: 'pets',
            id: '2',
            evidence: 'filtered',
            source: 'read',
            status: 200,
            record: tom,
          },
        ]);
      }
      // The existing pruning of the visible copy is unchanged.
      expect(await client.get('/pets', '2')).toBeUndefined();
    }
  });
});

describe('missing records: a blocked update', () => {
  it('holds a blocked update, and checks it only once authRenewed() makes it pending', async () => {
    let listRex = true;
    let refuse = true;
    const fake = provider([rex, tom], {
      listed: (pet) => listRex || pet['id'] !== '1',
      behave: () => (refuse ? response({ error: 'invented' }, 401) : undefined),
      item: () => response({}, 404),
    });
    const client = createApiClient(crudDocument(), {
      transport: fake.transport,
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex 2' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('blocked'),
    );
    listRex = false;
    await client.sync();
    expect(fake.itemGets).toEqual([]);
    expect(client.pendingWrites()[0]).toMatchObject({ state: 'blocked' });
    expect(client.pendingWrites()[0]).not.toHaveProperty('awaitingRefresh');
    refuse = false;
    await client.authRenewed();
    await settle();
    // Pending again, but held: not sent on the last known copy.
    expect(client.pendingWrites()[0]).toMatchObject({
      state: 'pending',
      awaitingRefresh: true,
    });
    expect(fake.writes).toHaveLength(1);
    await client.sync();
    expect(fake.itemGets).toEqual(['1']);
    expect(client.pendingWrites()[0]).toMatchObject({
      state: 'failed',
      missingRecord: 'deleted',
    });
    expect(fake.writes).toHaveLength(1);
  });
});

describe('missing records: declared complete collections', () => {
  for (const onOperation of [false, true])
    it(`treats a missing record as deleted without a GET (x-completeness on the ${onOperation ? 'list operation' : 'collection'})`, async () => {
      const reports: MissingRecord[] = [];
      const { client, storage, fake } = await editedThenMissing({
        doc: crudDocument({
          completeness: { absent: 'deleted' },
          onOperation,
        }),
        client: { onMissingRecord: (r) => reports.push(r) },
        edits: 2,
      });
      await client.sync();
      expectFailedOlder(storage);
      expect(fake.itemGets).toEqual([]);
      expect(reports).toEqual([
        {
          resource: 'pets',
          id: '1',
          evidence: 'deleted',
          source: 'declaration',
        },
      ]);
      expect(client.pendingWrites()).toMatchObject([
        {
          state: 'failed',
          missingRecord: 'deleted',
          lastError: expect.stringMatching(/deleted at the provider/),
        },
        { state: 'failed', missingRecord: 'deleted' },
      ]);
      expect(client.pendingWrites()[0]).not.toHaveProperty('lastStatus');
    });

  it("reads the record when the collection declares absent: 'removed'", async () => {
    const { client, fake } = await editedThenMissing({
      doc: crudDocument({ completeness: { absent: 'removed' } }),
    });
    await client.sync();
    expect(fake.itemGets).toEqual(['1']);
    expect(client.pendingWrites()[0]).toMatchObject({ state: 'pending' });
  });

  it('reads the declaration on a legacy document without crudResources', async () => {
    const doc = prepareDocument({
      ...petsDocument,
      servers: [{ url: 'https://provider.example/api' }],
    });
    doc.paths['/pets']!.get!['x-completeness'] = { absent: 'deleted' };
    const { client, fake } = await editedThenMissing({ doc });
    await client.sync();
    expect(fake.itemGets).toEqual([]);
    expect(client.pendingWrites()[0]).toMatchObject({
      missingRecord: 'deleted',
    });
  });
});

describe('missing records: the read budget', () => {
  it('reads only as many records as the budget allows; the others wait for the next sync', async () => {
    let listed = true;
    const reports: string[] = [];
    const fake = provider([rex, tom], {
      listed: () => listed,
      item: () => response({}, 404),
      // Both edits stay unsent, between retries.
      behave: () => response({ error: 'invented' }, 503),
    });
    const client = createApiClient(crudDocument(), {
      transport: fake.transport,
      retry: { baseDelayMs: 60_000 },
      // One request for the list, one for a record.
      limits: { maxRequests: 2 },
      onMissingRecord: (r) => reports.push(r.id),
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex 2' });
    await client.update('/pets', '2', { name: 'Tom 2' });
    await vi.waitFor(() =>
      expect(client.pendingWrites().map((w) => w.attempts)).toEqual([1, 1]),
    );
    listed = false;
    await client.sync();
    expect(fake.itemGets).toEqual(['1']);
    expect(reports).toEqual(['1']);
    expect(client.pendingWrites()).toMatchObject([
      { id: '1', state: 'failed', missingRecord: 'deleted' },
      { id: '2', state: 'pending', awaitingRefresh: true },
    ]);
    await client.sync();
    expect(fake.itemGets).toEqual(['1', '2']);
    expect(client.pendingWrites()).toMatchObject([
      { id: '1', state: 'failed' },
      { id: '2', state: 'failed', missingRecord: 'deleted' },
    ]);
  });
});

describe('missing records: restarts', () => {
  it('stores and restores missingRecord on a failed update', async () => {
    const { client, storage } = await editedThenMissing({
      item: () => response({}, 410),
    });
    await client.sync();
    expectFailedOlder(storage);
    const restarted = createApiClient(crudDocument(), {
      storage: storage.crash(),
      transport: provider([tom]).transport,
    });
    await restarted.ready();
    expect(restarted.pendingWrites()).toMatchObject([
      {
        state: 'failed',
        missingRecord: 'deleted',
        lastStatus: 410,
        lastError: expect.stringMatching(/deleted at the provider/),
      },
    ]);
  });

  it('checks a restored update whose record the refresh lacks: filtered sends it on the returned record', async () => {
    const { client, storage } = await editedThenMissing({ edits: 2 });
    await settle();
    // Stopped before the sync: both edits are in the outbox, unsent.
    const second = provider([tom, { ...rex, tag: 'wolf' }], {
      listed: (pet) => pet['id'] !== '1',
    });
    const restarted = createApiClient(crudDocument(), {
      storage: storage.crash(),
      transport: second.transport,
    });
    await restarted.ready();
    void client;
    await restarted.sync();
    expect(second.itemGets).toEqual(['1']);
    await idle(restarted);
    expect(second.pets.get('1')).toEqual({
      ...rex,
      name: 'Rex 3',
      tag: 'wolf',
    });
  });

  it('fails every restored update of a record the GET says was deleted, keeping failed writes older', async () => {
    const { storage } = await editedThenMissing({ edits: 2 });
    await settle();
    const crashed = storage.crash();
    const second = provider([tom]);
    const restarted = createApiClient(crudDocument(), {
      storage: crashed,
      transport: second.transport,
    });
    await restarted.ready();
    expectFailedOlder(crashed);
    await restarted.update('/pets', '1', { tag: 'wolf' });
    expectFailedOlder(crashed);
    await restarted.sync();
    expectFailedOlder(crashed);
    // The new edit was queued behind the restored ones and is held with them.
    expect(restarted.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted' },
      { state: 'failed', missingRecord: 'deleted' },
      { state: 'failed', missingRecord: 'deleted' },
    ]);
    await settle();
    expect(second.writes).toEqual([]);
  });
});

describe('missing records: review findings on #324', () => {
  it('reads the record when a selection narrows a collection declared absent: deleted', async () => {
    const { client, fake } = await editedThenMissing({
      doc: crudDocument({ completeness: { absent: 'deleted' } }),
      client: {
        selection: {
          query_overrides: [{ path: '/pets', values: { tag: 'cat' } }],
        },
      },
    });
    await client.sync();
    // Not "deleted" by declaration: the GET finds rex, so the edit is kept.
    expect(fake.itemGets).toEqual(['1']);
    expect(client.pendingWrites()[0]).toMatchObject({ state: 'pending' });
    expect(client.pendingWrites()[0]).not.toHaveProperty('missingRecord');
  });

  it('keeps the declaration when a selection only repeats the fixed x-list-query', async () => {
    const { client, fake } = await editedThenMissing({
      doc: crudDocument({
        completeness: { absent: 'deleted' },
        listQuery: { tag: 'dog' },
      }),
      client: {
        selection: {
          query_overrides: [{ path: '/pets', values: { tag: 'dog' } }],
        },
      },
    });
    await client.sync();
    expect(fake.itemGets).toEqual([]);
    expect(client.pendingWrites()[0]).toMatchObject({
      missingRecord: 'deleted',
    });
  });

  it('ignores an operation-level declaration for a collection with a fixed query', async () => {
    const { client, fake } = await editedThenMissing({
      doc: crudDocument({
        completeness: { absent: 'deleted' },
        onOperation: true,
        listQuery: { tag: 'dog' },
      }),
    });
    await client.sync();
    expect(fake.itemGets).toEqual(['1']);
    expect(client.pendingWrites()[0]).toMatchObject({ state: 'pending' });
  });

  for (const [label, answer] of [
    [
      'a Retry-After past the read deadline',
      (): TransportResponse => ({
        status: 429,
        headers: { 'retry-after': '3600' },
        body: '',
      }),
    ],
    [
      'no usable Retry-After',
      (): TransportResponse => ({ status: 429, headers: {}, body: '' }),
    ],
  ] as const)
    it(`keeps the update held, unchecked, when the GET meets a 429 with ${label}`, async () => {
      const reports: MissingRecord[] = [];
      const { client } = await editedThenMissing({
        item: answer,
        client: {
          limits: { timeoutMs: 60_000 },
          onMissingRecord: (r) => reports.push(r),
        },
      });
      await client.sync();
      expect(reports).toEqual([]);
      expect(client.pendingWrites()[0]).toMatchObject({
        state: 'pending',
        awaitingRefresh: true,
      });
      expect(client.pendingWrites()[0]).not.toHaveProperty('missingRecord');
    });

  it('wakes the drain when a held head in backoff fails after three syncs, so a retry is sent at once', async () => {
    // One request per sync: the list. The record is never checked.
    const { client, fake, unblock } = await editedThenMissing({
      client: { limits: { maxRequests: 1 } },
    });
    for (let i = 0; i < 3; i++) await client.sync();
    expect(client.pendingWrites()[0]).toMatchObject({
      state: 'failed',
      lastError: expect.stringMatching(/Waiting for a complete refresh/),
    });
    unblock();
    await client.resolveWrite('/pets', '1', { action: 'retry' });
    // Well within the 60 s backoff the first attempt was waiting out.
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
  });

  it('wakes the drain when a held head in backoff is discarded, so a new update is sent', async () => {
    const { client, fake, unblock } = await editedThenMissing({
      client: { limits: { maxRequests: 1 } },
    });
    await client.sync();
    expect(client.pendingWrites()[0]).toMatchObject({ awaitingRefresh: true });
    unblock();
    await client.resolveWrite('/pets', '1', { action: 'discard' });
    await client.update('/pets', '1', { tag: 'wolf' });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    expect(JSON.parse(fake.writes[0]?.body ?? '{}')).toMatchObject({
      tag: 'wolf',
    });
  });

  it('holds an in-flight update that the refresh dropped, if its answer is a retry', async () => {
    let listRex = true;
    let answer!: () => void;
    const gate = new Promise<void>((resolve) => (answer = resolve));
    let puts = 0;
    let fail = true;
    const fake = provider([rex, tom], {
      listed: (pet) => listRex || pet['id'] !== '1',
      behave: () => {
        puts += 1;
        return fail ? response({ error: 'invented' }, 503) : undefined;
      },
    });
    const client = createApiClient(crudDocument(), {
      transport: async (r) => {
        if (r.method === 'PUT' && puts === 0) await gate;
        return fake.transport(r);
      },
      retry: { baseDelayMs: 50 },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex 2' });
    await settle();
    listRex = false;
    await client.sync();
    expect(fake.itemGets).toEqual([]);
    answer();
    // Answered 503: held, not resent on the stale copy after the backoff.
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]).toMatchObject({
        attempts: 1,
        awaitingRefresh: true,
      }),
    );
    await settle(200);
    expect(puts).toBe(1);
    fail = false;
    await client.sync();
    expect(fake.itemGets).toEqual(['1']);
    await idle(client);
    expect(puts).toBe(2);
    expect(fake.pets.get('1')).toMatchObject({ name: 'Rex 2' });
  });
});
