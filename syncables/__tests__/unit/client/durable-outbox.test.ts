// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  prepareDocument,
  type ApiClient,
  type ApiClientOptions,
  type OpenApiDocument,
  type StorageAdapter,
  type Transport,
  type TransportRequest,
  type TransportResponse,
  type WriteConflict,
} from '../../../src/browser.js';
import { petsDocument } from '../../fixtures/pets.js';

// #260: the durable outbox. A "restart" is a second client built on a copy
// of the first client's storage taken at the moment the process "dies"; the
// first client is left hanging on a request that never answers, so nothing
// it does afterwards can reach the copy. Transports and data are invented.

const OUTBOX = 'syncables:outbox';

/** An in-memory StorageAdapter whose state can be copied, as a crash leaves it. */
class CrashableStorage implements StorageAdapter {
  data = new Map<string, Map<string, Record<string, unknown>>>();
  /** Called after each put, with the namespace and id. */
  afterPut: ((resource: string, id: string) => void) | undefined;
  failOutbox = false;
  /** Fail this many upcoming gets (a transient read error). */
  failGets = 0;
  /** Fail only the outbox put with this 1-based number. */
  failOutboxPut: number | undefined;
  private outboxPuts = 0;

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
    if (this.failGets > 0) {
      this.failGets -= 1;
      throw new Error('storage unavailable (invented)');
    }
    const value = this.ns(resource).get(id);
    return value && structuredClone(value);
  }
  async put(
    resource: string,
    id: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    if (resource === OUTBOX) this.outboxPuts += 1;
    if (
      resource === OUTBOX &&
      (this.failOutbox || this.outboxPuts === this.failOutboxPut)
    )
      throw new Error('disk full (invented)');
    this.ns(resource).set(id, structuredClone(value));
    this.afterPut?.(resource, id);
  }
  async delete(resource: string, id: string): Promise<void> {
    this.ns(resource).delete(id);
  }
  /** The storage as a process that stopped now would leave it. */
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

const document = (): OpenApiDocument =>
  prepareDocument({
    ...petsDocument,
    servers: [{ url: 'https://provider.example/api' }],
  });

type Pet = Record<string, unknown>;

/**
 * A fake provider. `behave` may answer a request itself: 'hang' applies the
 * request and never answers (the process dies with it in flight),
 * 'hang-before' never answers without applying it, or a response.
 */
function provider(
  initial: Pet[] = [],
  behave?: (
    request: TransportRequest,
  ) => TransportResponse | 'hang' | 'hang-before' | undefined,
): {
  pets: Map<string, Pet>;
  requests: TransportRequest[];
  transport: Transport;
} {
  const pets = new Map(initial.map((p) => [String(p['id']), p]));
  const requests: TransportRequest[] = [];
  let next = 1;
  const apply = (r: TransportRequest): TransportResponse => {
    const id = decodeURIComponent(r.url.pathname.split('/')[3] ?? '');
    if (r.method === 'GET') return response([...pets.values()]);
    if (r.method === 'POST') {
      const pet = { ...JSON.parse(r.body ?? '{}'), id: `srv-${next++}` };
      pets.set(pet.id, pet);
      return response(pet, 201);
    }
    if (r.method === 'PUT') {
      if (!pets.has(id)) return response({ error: 'not found' }, 404);
      const pet = { ...JSON.parse(r.body ?? '{}'), id };
      pets.set(id, pet);
      return response(pet);
    }
    if (r.method === 'DELETE') {
      pets.delete(id);
      return response(undefined, 204);
    }
    return response({}, 405);
  };
  const transport: Transport = async (r) => {
    if (r.method !== 'GET') requests.push(r);
    const behaviour = behave?.(r);
    if (behaviour === 'hang' || behaviour === 'hang-before') {
      if (behaviour === 'hang') apply(r);
      return new Promise<TransportResponse>(() => undefined);
    }
    return behaviour ?? apply(r);
  };
  return { pets, requests, transport };
}

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function idle(client: ApiClient): Promise<void> {
  await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
  await settle(5);
}

function restart(
  storage: CrashableStorage,
  transport: Transport,
  options: ApiClientOptions = {},
  doc: OpenApiDocument = document(),
): ApiClient {
  return createApiClient(doc, { ...options, storage, transport });
}

/** The first process's writes fail with 503 and then wait a minute to retry. */
const slowRetry = { baseDelayMs: 60_000 };

describe('durable outbox: pending writes resume after a restart', () => {
  it('resumes queued writes in order, keeping the local id of an unconfirmed create', async () => {
    const storage = new CrashableStorage();
    const first = provider([{ id: '1', name: 'Rex', tag: 'dog' }], (r) =>
      r.method === 'GET' ? undefined : response({}, 503),
    );
    const a = restart(storage, first.transport, { retry: slowRetry });
    await a.sync();
    const created = await a.create('/pets', { name: 'Milo' });
    const localId = String(created['id']);
    await a.update('/pets', localId, { tag: 'cat' });
    await a.update('/pets', '1', { name: 'Rex II' });
    await a.remove('/pets', '1');
    await vi.waitFor(() =>
      expect(a.pendingWrites().filter((w) => w.attempts === 1).length).toBe(2),
    );
    await settle();

    // Meanwhile another client changed a field this one never touched.
    const second = provider([{ id: '1', name: 'Rex', tag: 'wolf' }]);
    const b = restart(storage.crash(), second.transport);
    await b.ready();
    // Stored state, before anything is resent: same ids, order and attempts.
    expect(
      b.pendingWrites().map(({ id, type, state, attempts }) => ({
        id,
        type,
        state,
        attempts,
      })),
    ).toEqual([
      { id: localId, type: 'create', state: 'pending', attempts: 1 },
      { id: localId, type: 'update', state: 'pending', attempts: 0 },
      { id: '1', type: 'update', state: 'pending', attempts: 1 },
      { id: '1', type: 'delete', state: 'pending', attempts: 0 },
    ]);
    // The restored update of an existing record waits for a refresh; the
    // follow-up of the unconfirmed create does not.
    expect(b.pendingWrites()[2]).toMatchObject({ awaitingRefresh: true });
    expect(b.pendingWrites()[1]).not.toHaveProperty('awaitingRefresh');
    await vi.waitFor(() =>
      expect(
        second.requests.map((r) => `${r.method} ${r.url.pathname}`),
      ).toEqual(['POST /api/pets', 'PUT /api/pets/srv-1']),
    );
    await settle();
    expect(second.requests).toHaveLength(2);
    await b.sync();
    await idle(b);
    expect(second.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(
      expect.arrayContaining([
        'POST /api/pets',
        'PUT /api/pets/srv-1',
        'PUT /api/pets/1',
        'DELETE /api/pets/1',
      ]),
    );
    const order = (method: string, path: string): number =>
      second.requests.findIndex(
        (r) => r.method === method && r.url.pathname === path,
      );
    expect(order('POST', '/api/pets')).toBeLessThan(
      order('PUT', '/api/pets/srv-1'),
    );
    expect(order('PUT', '/api/pets/1')).toBeLessThan(
      order('DELETE', '/api/pets/1'),
    );
    // The update was replayed on the refreshed record, keeping the remote tag.
    const put = second.requests.find((r) => r.url.pathname === '/api/pets/1');
    expect(JSON.parse(put?.body ?? '{}')).toEqual({
      id: '1',
      name: 'Rex II',
      tag: 'wolf',
    });
    expect([...second.pets.values()]).toEqual([
      { id: 'srv-1', name: 'Milo', tag: 'cat' },
    ]);
    expect(await b.list('/pets')).toEqual([
      { id: 'srv-1', name: 'Milo', tag: 'cat' },
    ]);
    expect(storage.crash().data.get(OUTBOX)?.get('outbox')).toBeDefined();
  });

  it('stores the write before the visible record, and rebuilds that record on restart', async () => {
    const storage = new CrashableStorage();
    let crashed: CrashableStorage | undefined;
    storage.afterPut = (resource): void => {
      if (resource === OUTBOX && !crashed) crashed = storage.crash();
    };
    const a = restart(storage, provider([], () => 'hang-before').transport);
    const created = await a.create('/pets', { name: 'Milo' });
    expect(crashed?.data.get('/pets')?.size ?? 0).toBe(0);

    const second = provider();
    const b = restart(crashed as CrashableStorage, second.transport);
    await b.ready();
    expect(await b.get('/pets', String(created['id']))).toEqual(created);
    await idle(b);
    expect([...second.pets.values()]).toEqual([{ id: 'srv-1', name: 'Milo' }]);
  });

  it('finishes an id remap that was stored but not yet made visible', async () => {
    const storage = new CrashableStorage();
    let crashed: CrashableStorage | undefined;
    storage.afterPut = (resource, id): void => {
      const outbox = storage.data.get(OUTBOX)?.get(id) as
        | { rebuild?: unknown[] }
        | undefined;
      if (resource === OUTBOX && outbox?.rebuild?.length && !crashed)
        crashed = storage.crash();
    };
    const a = restart(storage, provider().transport);
    const created = await a.create('/pets', { name: 'Milo' });
    await idle(a);
    // The crash copy still shows the record under its local id.
    expect([...(crashed?.data.get('/pets')?.keys() ?? [])]).toEqual([
      created['id'],
    ]);

    const b = restart(crashed as CrashableStorage, provider().transport);
    await b.ready();
    expect(b.pendingWrites()).toEqual([]);
    expect(await b.list('/pets')).toEqual([{ id: 'srv-1', name: 'Milo' }]);
  });
});

describe('durable outbox: a crash with a request in flight', () => {
  it('makes a create without an idempotency key uncertain, never resent, and confirmable', async () => {
    const storage = new CrashableStorage();
    // The provider applies the POST; the answer never arrives.
    const first = provider([], (r) =>
      r.method === 'POST' ? 'hang' : undefined,
    );
    const a = restart(storage, first.transport);
    const created = await a.create('/pets', { name: 'Milo' });
    const localId = String(created['id']);
    await a.update('/pets', localId, { tag: 'cat' });
    await vi.waitFor(() => expect(first.requests).toHaveLength(1));
    await settle();

    // The second process talks to the same provider, which holds the create.
    const second = provider([...first.pets.values()]);
    const b = restart(storage.crash(), second.transport);
    await b.ready();
    expect(b.pendingWrites()).toMatchObject([
      { id: localId, type: 'create', state: 'uncertain', attempts: 1 },
      { id: localId, type: 'update', state: 'pending', attempts: 0 },
    ]);
    expect(b.pendingWrites()[0]?.lastError).toMatch(/in flight/);
    expect(await b.get('/pets', localId)).toEqual({
      id: localId,
      name: 'Milo',
      tag: 'cat',
    });
    await settle();
    expect(second.requests).toEqual([]);
    expect(second.pets.size).toBe(1);

    await b.resolveWrite('/pets', localId, { action: 'confirm', id: 'srv-1' });
    await idle(b);
    expect(second.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(
      ['PUT /api/pets/srv-1'],
    );
    expect([...second.pets.values()]).toEqual([
      { id: 'srv-1', name: 'Milo', tag: 'cat' },
    ]);
    expect(await b.list('/pets')).toEqual([
      { id: 'srv-1', name: 'Milo', tag: 'cat' },
    ]);
  });

  it('resends a create with its stored idempotency key', async () => {
    const doc = document();
    doc.paths['/pets']!.post!.parameters = [
      { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
    ];
    const storage = new CrashableStorage();
    const first = provider([], () => 'hang-before');
    const a = restart(storage, first.transport, {}, doc);
    await a.create('/pets', { name: 'Milo' });
    await vi.waitFor(() => expect(first.requests).toHaveLength(1));
    await settle();

    const second = provider();
    const b = restart(storage.crash(), second.transport, {}, doc);
    await b.ready();
    expect(b.pendingWrites()).toMatchObject([
      { type: 'create', state: 'pending', attempts: 1 },
    ]);
    await idle(b);
    expect(second.requests).toHaveLength(1);
    expect(second.requests[0]?.headers['Idempotency-Key']).toBe(
      first.requests[0]?.headers['Idempotency-Key'],
    );
  });

  it('resends an update or delete that was in flight', async () => {
    const storage = new CrashableStorage();
    const pets = [
      { id: '1', name: 'Rex', tag: 'dog' },
      { id: '2', name: 'Tom', tag: 'cat' },
    ];
    const first = provider(pets, (r) =>
      r.method === 'GET' ? undefined : 'hang',
    );
    const a = restart(storage, first.transport);
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    await a.remove('/pets', '2');
    await vi.waitFor(() => expect(first.requests).toHaveLength(2));
    await settle();

    const second = provider([...first.pets.values()]);
    const b = restart(storage.crash(), second.transport);
    await b.ready();
    expect(b.pendingWrites()).toMatchObject([
      { id: '1', type: 'update', state: 'pending', attempts: 1 },
      { id: '2', type: 'delete', state: 'pending', attempts: 1 },
    ]);
    // The delete goes out at once; the update waits for a refresh. (A
    // refresh during which a write to the collection settles does not count.)
    await vi.waitFor(() => expect(second.requests).toHaveLength(1));
    await settle();
    expect(second.requests[0]?.method).toBe('DELETE');
    await b.sync();
    await idle(b);
    expect(
      second.requests.map((r) => `${r.method} ${r.url.pathname}`).sort(),
    ).toEqual(['DELETE /api/pets/2', 'PUT /api/pets/1']);
    expect([...second.pets.values()]).toEqual([
      { id: '1', name: 'Rex II', tag: 'dog' },
    ]);
  });
});

describe('durable outbox: failed, uncertain and conflicting writes', () => {
  it('keeps failed and uncertain writes listed and resolvable after a restart', async () => {
    const storage = new CrashableStorage();
    const first = provider([{ id: '1', name: 'Rex' }], (r) => {
      if (r.method === 'PUT') return response({ error: 'invented' }, 400);
      if (r.method === 'POST') return response({ error: 'invented' }, 502);
      return undefined;
    });
    const a = restart(storage, first.transport, {
      retry: { baseDelayMs: 1, maxAttempts: 1 },
    });
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    const created = await a.create('/pets', { name: 'Milo' });
    const localId = String(created['id']);
    await vi.waitFor(() =>
      expect(a.pendingWrites().map((w) => w.state)).toEqual([
        'failed',
        'uncertain',
      ]),
    );
    await settle();

    const second = provider([{ id: '1', name: 'Rex' }]);
    const afterRestart = storage.crash();
    const b = restart(afterRestart, second.transport);
    await b.ready();
    expect(b.pendingWrites()).toMatchObject([
      {
        id: '1',
        type: 'update',
        state: 'failed',
        attempts: 1,
        lastError: expect.stringMatching(/400/),
      },
      {
        id: localId,
        type: 'create',
        state: 'uncertain',
        attempts: 1,
        lastError: expect.stringMatching(/502/),
      },
    ]);
    expect(await b.get('/pets', '1')).toEqual({ id: '1', name: 'Rex II' });
    expect(await b.get('/pets', localId)).toEqual(created);
    await settle();
    expect(second.requests).toEqual([]);

    await b.resolveWrite('/pets', localId, { action: 'discard' });
    await b.resolveWrite('/pets', '1', { action: 'retry' });
    await b.sync();
    await idle(b);
    expect(await b.get('/pets', localId)).toBeUndefined();
    expect(second.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(
      ['PUT /api/pets/1'],
    );
    expect([...second.pets.values()]).toEqual([{ id: '1', name: 'Rex II' }]);

    // Resolutions are stored too: a third process finds nothing to do.
    const c = restart(afterRestart.crash(), provider().transport);
    await c.ready();
    expect(c.pendingWrites()).toEqual([]);
  });

  it('keeps conflicts and conflict bases, so a restart does not report them again', async () => {
    const storage = new CrashableStorage();
    let remote = [{ id: '1', name: 'old', other: 0 }];
    const first = provider([], (r) =>
      r.method === 'GET' ? response(remote) : 'hang-before',
    );
    const a = restart(storage, first.transport);
    await a.sync();
    await a.update('/pets', '1', { name: 'local' });
    remote = [{ id: '1', name: 'remote', other: 1 }];
    await a.sync();
    expect(a.pendingWrites()[0]?.conflicts).toHaveLength(1);
    await settle();

    const seen: WriteConflict[] = [];
    const second = provider([], (r) =>
      r.method === 'GET' ? response(remote) : 'hang-before',
    );
    const b = restart(storage.crash(), second.transport, {
      onConflict: (c) => seen.push(c),
    });
    await b.ready();
    expect(b.pendingWrites()[0]?.conflicts).toEqual([
      {
        resource: '/pets',
        id: '1',
        field: 'name',
        base: 'old',
        remote: 'remote',
        local: 'local',
      },
    ]);
    await b.sync();
    expect(seen).toEqual([]);
    expect(await b.get('/pets', '1')).toEqual({
      id: '1',
      name: 'local',
      other: 1,
    });
    remote = [{ id: '1', name: 'third', other: 1 }];
    await b.sync();
    expect(seen).toMatchObject([{ base: 'remote', remote: 'third' }]);
  });
});

describe('durable outbox: storage format and failures', () => {
  it('starts empty on storage written before the outbox existed', async () => {
    const storage = new CrashableStorage();
    await storage.put('/pets', '1', { id: '1', name: 'Rex' });
    const b = restart(storage, provider().transport);
    await b.ready();
    expect(b.pendingWrites()).toEqual([]);
    expect(await b.list('/pets')).toEqual([{ id: '1', name: 'Rex' }]);
    expect(storage.data.get(OUTBOX)?.size ?? 0).toBe(0);
  });

  it('refuses, and leaves alone, an outbox of an unknown version', async () => {
    const storage = new CrashableStorage();
    const newer = { version: 2, entries: ['invented'] };
    await storage.put(OUTBOX, 'outbox', newer);
    const b = restart(storage, provider().transport);
    await expect(b.ready()).rejects.toThrow(/version 2/);
    await expect(b.create('/pets', { name: 'Milo' })).rejects.toThrow(
      /version 2/,
    );
    expect(await storage.get(OUTBOX, 'outbox')).toEqual(newer);
  });

  it('keeps entries for an unknown collection and writes them back', async () => {
    const storage = new CrashableStorage();
    const orphan = {
      resource: 'gone',
      context: {},
      id: 'x',
      failed: [],
      queue: [{ type: 'delete', attempts: 0, state: 'pending' }],
    };
    await storage.put(OUTBOX, 'outbox', {
      version: 1,
      records: [orphan],
      rebuild: [],
    });
    const second = provider();
    const b = restart(storage, second.transport);
    await b.ready();
    expect(b.pendingWrites()).toEqual([]);
    await b.create('/pets', { name: 'Milo' });
    await idle(b);
    expect((await storage.get(OUTBOX, 'outbox'))?.['unrestorable']).toEqual([
      orphan,
    ]);
  });

  it('rejects a create whose outbox cannot be stored, and sends nothing', async () => {
    const storage = new CrashableStorage();
    storage.failOutbox = true;
    const first = provider();
    const a = restart(storage, first.transport);
    await expect(a.create('/pets', { name: 'Milo' })).rejects.toThrow(
      /disk full/,
    );
    expect(a.pendingWrites()).toEqual([]);
    expect(await a.list('/pets')).toEqual([]);
    await settle();
    expect(first.requests).toEqual([]);
  });

  it('does not send while the outbox cannot record the attempt', async () => {
    const storage = new CrashableStorage();
    const first = provider();
    const a = restart(storage, first.transport, { retry: { baseDelayMs: 5 } });
    storage.afterPut = (resource): void => {
      // Accept the write itself, then refuse to store the "sending" marker.
      if (resource === OUTBOX) storage.failOutbox = true;
    };
    await a.create('/pets', { name: 'Milo' });
    await vi.waitFor(() =>
      expect(a.pendingWrites()[0]?.lastError).toMatch(/Outbox not stored/),
    );
    expect(a.pendingWrites()[0]?.state).toBe('pending');
    expect(first.requests).toEqual([]);
    storage.afterPut = undefined;
    storage.failOutbox = false;
    await idle(a);
    expect(first.requests).toHaveLength(1);
  });

  it('stores nothing with outboxNamespace: false', async () => {
    const storage = new CrashableStorage();
    const a = restart(storage, provider().transport, {
      outboxNamespace: false,
    });
    await a.create('/pets', { name: 'Milo' });
    await idle(a);
    expect(storage.data.has(OUTBOX)).toBe(false);
  });
});

describe('durable outbox: review findings on #312', () => {
  it('makes a restored create uncertain when its key can no longer be sent', async () => {
    const keyed = document();
    keyed.paths['/pets']!.post!.parameters = [
      { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
    ];
    for (const [doc, options] of [
      [document(), {}],
      [keyed, { idempotencyKeyHeader: false as const }],
    ] as const) {
      const storage = new CrashableStorage();
      const first = provider([], () => 'hang-before');
      const a = restart(storage, first.transport, {}, keyed);
      await a.create('/pets', { name: 'Milo' });
      await vi.waitFor(() => expect(first.requests).toHaveLength(1));
      await settle();

      const second = provider();
      const b = restart(storage.crash(), second.transport, options, doc);
      await b.ready();
      expect(b.pendingWrites()).toMatchObject([
        { type: 'create', state: 'uncertain', attempts: 1 },
      ]);
      await settle();
      expect(second.requests).toEqual([]);
    }
  });

  it('retries a restore that failed on a transient storage error', async () => {
    const storage = new CrashableStorage();
    const first = provider([], () => response({}, 503));
    const a = restart(storage, first.transport, { retry: slowRetry });
    await a.create('/pets', { name: 'Milo' });
    await vi.waitFor(() => expect(a.pendingWrites()[0]?.attempts).toBe(1));
    await settle();

    const crashed = storage.crash();
    crashed.failGets = 1;
    const second = provider();
    const b = restart(crashed, second.transport);
    await expect(b.ready()).rejects.toThrow(/storage unavailable/);
    await b.ready();
    expect(b.pendingWrites()).toMatchObject([{ type: 'create' }]);
    await idle(b);
    expect([...second.pets.values()]).toEqual([{ id: 'srv-1', name: 'Milo' }]);
  });

  it('restores even when storing the restored state fails once', async () => {
    const storage = new CrashableStorage();
    const first = provider([], () => 'hang-before');
    const a = restart(storage, first.transport);
    await a.create('/pets', { name: 'Milo' });
    await vi.waitFor(() => expect(first.requests).toHaveLength(1));
    await settle();

    const crashed = storage.crash();
    crashed.failOutbox = true;
    const b = restart(crashed, provider().transport);
    await b.ready();
    expect(b.pendingWrites()).toMatchObject([
      { type: 'create', state: 'uncertain' },
    ]);
  });

  it('does not store a create whose own store failed through another create', async () => {
    const storage = new CrashableStorage();
    // The first outbox put is A's, the second B's.
    storage.failOutboxPut = 2;
    // Every outbox state that reached storage, as a crash would find it.
    const names: string[][] = [];
    storage.afterPut = (resource): void => {
      if (resource !== OUTBOX) return;
      const stored = storage.data.get(OUTBOX)?.get('outbox') as {
        records: { queue: { data?: { name: string } }[] }[];
      };
      names.push(
        stored.records.flatMap((r) => r.queue.map((w) => w.data?.name ?? '')),
      );
    };
    const a = restart(storage, provider([], () => 'hang-before').transport);
    const [first, second] = await Promise.allSettled([
      a.create('/pets', { name: 'A' }),
      a.create('/pets', { name: 'B' }),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    await settle();
    expect(names.length).toBeGreaterThan(0);
    for (const stored of names) expect(stored).toEqual(['A']);
    expect(a.pendingWrites().map((w) => w.type)).toEqual(['create']);
  });

  it('builds a restored update on refreshed remote state and reports conflicts', async () => {
    const storage = new CrashableStorage();
    const first = provider([{ id: '1', name: 'Rex', tag: 'dog' }], (r) =>
      r.method === 'GET' ? undefined : 'hang-before',
    );
    const a = restart(storage, first.transport);
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    await settle();

    const seen: WriteConflict[] = [];
    const second = provider([{ id: '1', name: 'Max', tag: 'wolf' }]);
    const b = restart(storage.crash(), second.transport, {
      onConflict: (c) => seen.push(c),
    });
    await b.ready();
    expect(b.pendingWrites()).toMatchObject([
      { type: 'update', state: 'pending', awaitingRefresh: true },
    ]);
    await settle();
    expect(second.requests).toEqual([]);
    await b.sync();
    expect(seen).toMatchObject([
      { field: 'name', base: 'Rex', remote: 'Max', local: 'Rex II' },
    ]);
    await idle(b);
    expect(JSON.parse(second.requests[0]?.body ?? '{}')).toEqual({
      id: '1',
      name: 'Rex II',
      tag: 'wolf',
    });
  });

  it('keeps rebuild entries for unknown collections and malformed entries', async () => {
    const storage = new CrashableStorage();
    const rebuild = { resource: 'gone', context: {}, id: 'x' };
    const badRecord = { resource: '/pets', queue: 'not a list' };
    const badRebuild = { invented: true };
    await storage.put(OUTBOX, 'outbox', {
      version: 1,
      records: [badRecord],
      rebuild: [rebuild, badRebuild],
    });
    const b = restart(storage, provider().transport);
    await b.ready();
    await b.create('/pets', { name: 'Milo' });
    await idle(b);
    const stored = await storage.get(OUTBOX, 'outbox');
    expect(stored?.['unrestorable']).toEqual(
      expect.arrayContaining([rebuild, badRecord, badRebuild]),
    );
    expect(stored?.['unrestorable']).toHaveLength(3);
  });

  it('applies retry.maxAttempts to a write found in flight', async () => {
    const keyed = document();
    keyed.paths['/pets']!.post!.parameters = [
      { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
    ];
    const storage = new CrashableStorage();
    const first = provider([{ id: '1', name: 'Rex' }], (r) =>
      r.method === 'GET' ? undefined : 'hang-before',
    );
    const a = restart(storage, first.transport, {}, keyed);
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    await a.create('/pets', { name: 'Milo' });
    await vi.waitFor(() => expect(first.requests).toHaveLength(2));
    await settle();

    const second = provider([{ id: '1', name: 'Rex' }]);
    const b = restart(
      storage.crash(),
      second.transport,
      { retry: { maxAttempts: 1 } },
      keyed,
    );
    await b.ready();
    expect(b.pendingWrites()).toMatchObject([
      { id: '1', type: 'update', state: 'failed', attempts: 1 },
      { type: 'create', state: 'failed', attempts: 1 },
    ]);
    await b.sync();
    await settle();
    expect(second.requests).toEqual([]);
  });
});
