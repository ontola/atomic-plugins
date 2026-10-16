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
  /** Outbox puts wait for this before they store (or fail). */
  outboxGate: Promise<void> | undefined;
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
    if (resource === OUTBOX && this.outboxGate) await this.outboxGate;
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

/** A first process that synced record 1 and left an update of it in flight. */
async function restoredUpdate(
  pets: Pet[] = [{ id: '1', name: 'Rex', tag: 'dog' }],
  doc: OpenApiDocument = document(),
): Promise<CrashableStorage> {
  const storage = new CrashableStorage();
  const first = provider(pets, (r) =>
    r.method === 'GET' ? undefined : 'hang-before',
  );
  const a = restart(storage, first.transport, {}, doc);
  await a.sync();
  await a.update('/pets', '1', { name: 'Rex II' });
  await vi.waitFor(() => expect(first.requests).toHaveLength(1));
  await settle();
  return storage.crash();
}

describe('durable outbox: second review on #312', () => {
  it('fails a waiting update after three syncs that could not refresh it', async () => {
    const second = provider([{ id: '1', name: 'Rex', tag: 'dog' }], (r) =>
      r.method === 'GET' ? response({ error: 'invented' }, 500) : undefined,
    );
    const b = restart(await restoredUpdate(), second.transport);
    await b.ready();
    for (let i = 0; i < 2; i++) {
      await expect(b.sync()).rejects.toThrow(/Read incomplete/);
      expect(b.pendingWrites()[0]).toMatchObject({
        state: 'pending',
        awaitingRefresh: true,
      });
    }
    await expect(b.sync()).rejects.toThrow(/Read incomplete/);
    const [entry] = b.pendingWrites();
    expect(entry).toMatchObject({
      type: 'update',
      state: 'failed',
      lastError: expect.stringMatching(
        /Waiting for a complete refresh of \/pets/,
      ),
    });
    expect(entry).not.toHaveProperty('awaitingRefresh');
    expect(second.requests).toEqual([]);
    await b.resolveWrite('/pets', '1', { action: 'retry' });
    await idle(b);
    expect(second.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(
      ['PUT /api/pets/1'],
    );
  });

  it('lets resolveWrite send or drop a waiting update', async () => {
    const crashed = await restoredUpdate();
    const sendNow = provider([{ id: '1', name: 'Rex', tag: 'dog' }]);
    const b = restart(crashed.crash(), sendNow.transport);
    await b.ready();
    await b.resolveWrite('/pets', '1', { action: 'retry' });
    await idle(b);
    expect(sendNow.requests.map((r) => r.method)).toEqual(['PUT']);

    const dropped = provider([{ id: '1', name: 'Rex', tag: 'dog' }]);
    const c = restart(crashed.crash(), dropped.transport);
    await c.ready();
    await c.resolveWrite('/pets', '1', { action: 'discard' });
    expect(c.pendingWrites()).toEqual([]);
    expect(await c.get('/pets', '1')).toEqual({
      id: '1',
      name: 'Rex',
      tag: 'dog',
    });
    await settle();
    expect(dropped.requests).toEqual([]);
  });

  it('does not send a partial record when the refresh lacks the record', async () => {
    const second = provider([{ id: '2', name: 'Tom' }]);
    const b = restart(await restoredUpdate(), second.transport);
    await b.ready();
    await b.sync();
    const [entry] = b.pendingWrites();
    expect(entry).toMatchObject({
      id: '1',
      state: 'failed',
      lastError: expect.stringMatching(/not in the refreshed collection/),
    });
    await settle();
    expect(second.requests).toEqual([]);
    // Retrying sends it on the last confirmed record known.
    second.pets.set('1', { id: '1', name: 'Rex', tag: 'dog' });
    await b.resolveWrite('/pets', '1', { action: 'retry' });
    await idle(b);
    expect(JSON.parse(second.requests[0]?.body ?? '{}')).toEqual({
      id: '1',
      name: 'Rex II',
      tag: 'dog',
    });
  });

  it('never shows a create whose own store failed, even through a sync', async () => {
    const storage = new CrashableStorage();
    let open!: () => void;
    storage.outboxGate = new Promise<void>((resolve) => (open = resolve));
    storage.failOutbox = true;
    const a = restart(storage, provider().transport);
    const created = a.create('/pets', { name: 'Ghost' });
    await settle();
    const syncing = a.sync();
    await settle();
    open();
    await expect(created).rejects.toThrow(/disk full/);
    await syncing;
    await settle();
    expect(await a.list('/pets')).toEqual([]);
    expect(storage.data.get('/pets')?.size ?? 0).toBe(0);
  });

  it('releases a waiting update even when another record of the collection settles during the read', async () => {
    const crashed = await restoredUpdate([
      { id: '1', name: 'Rex', tag: 'dog' },
      { id: '2', name: 'Tom', tag: 'cat' },
    ]);
    const second = provider([
      { id: '1', name: 'Rex', tag: 'wolf' },
      { id: '2', name: 'Tom', tag: 'cat' },
    ]);
    let releaseGet!: () => void;
    const gate = new Promise<void>((resolve) => (releaseGet = resolve));
    const b = restart(crashed, async (r) => {
      if (r.method === 'GET') await gate;
      return second.transport(r);
    });
    await b.ready();
    const syncing = b.sync();
    await b.update('/pets', '2', { tag: 'lion' });
    await vi.waitFor(() => expect(second.requests).toHaveLength(1));
    await settle();
    releaseGet();
    await syncing;
    await idle(b);
    const put = second.requests.find((r) => r.url.pathname === '/api/pets/1');
    expect(JSON.parse(put?.body ?? '{}')).toEqual({
      id: '1',
      name: 'Rex II',
      tag: 'wolf',
    });
  });
});

describe('durable outbox: third review on #312', () => {
  it('holds a queued update behind one in flight when a refresh lacks their record, and sends it once the record is found', async () => {
    // The reviewer's scenario: u1 in flight, u2 queued, a refresh without a.
    // The list filters a out; a GET of the record still finds it (#260).
    const server = new Map<string, Pet>([['a', { id: 'a', name: 'A' }]]);
    let listed = true;
    let answer!: () => void;
    const firstPut = new Promise<void>((resolve) => (answer = resolve));
    let puts = 0;
    const client = createApiClient(document(), {
      transport: async (r) => {
        if (r.method === 'GET' && r.url.pathname === '/api/pets/a')
          return response(server.get('a'));
        if (r.method === 'GET')
          return response(listed ? [...server.values()] : []);
        puts += 1;
        if (puts === 1) await firstPut;
        const pet = JSON.parse(r.body ?? '{}') as Pet;
        server.set('a', pet);
        return response(pet);
      },
    });
    await client.sync();
    await client.update('/pets', 'a', { name: 'B' });
    await vi.waitFor(() => expect(puts).toBe(1));
    await client.update('/pets', 'a', { name: 'C' });
    listed = false;
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'pending' },
      { state: 'pending', awaitingRefresh: true },
    ]);
    answer();
    await vi.waitFor(() => expect(client.pendingWrites()).toHaveLength(1));
    await settle();
    // u2 waits for the next sync, which finds the record with a GET.
    expect(puts).toBe(1);
    await client.sync();
    await idle(client);
    expect(server.get('a')?.['name']).toBe('C');
    expect(await client.get('/pets', 'a')).toMatchObject({ name: 'C' });
  });

  it('does not send the changes of a refresh-failed update through a new update', async () => {
    const storage = new CrashableStorage();
    const first = provider([{ id: '1', name: 'Rex', tag: 'dog' }], (r) =>
      r.method === 'GET' ? undefined : 'hang-before',
    );
    const a = restart(storage, first.transport);
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(first.requests).toHaveLength(1));
    await settle();

    // The list no longer has record 1; a GET of it fails at first, then
    // finds it (filtered out of the list, not deleted).
    let found = false;
    const second = provider([], (r) =>
      r.method === 'GET' && r.url.pathname === '/api/pets/1'
        ? found
          ? response({ id: '1', name: 'Rex', tag: 'dog' })
          : response({ error: 'invented' }, 503)
        : undefined,
    );
    const b = restart(storage.crash(), second.transport);
    await b.ready();
    await b.sync();
    expect(b.pendingWrites()).toMatchObject([{ state: 'failed' }]);
    await b.update('/pets', '1', { tag: 'wolf' });
    // The record is still missing: the new edit waits for a refresh.
    expect(b.pendingWrites()[1]).toMatchObject({ awaitingRefresh: true });
    await settle();
    expect(second.requests).toEqual([]);
    found = true;
    await b.sync();
    await vi.waitFor(() => expect(second.requests).toHaveLength(1));
    // Built on the last confirmed record, without the failed update's name.
    expect(JSON.parse(second.requests[0]?.body ?? '{}')).toEqual({
      id: '1',
      name: 'Rex',
      tag: 'wolf',
    });
    expect(b.pendingWrites()[0]).toMatchObject({
      state: 'failed',
      lastError: expect.stringMatching(/not in the refreshed collection/),
    });
  });

  it('fails a restored PATCH update like a PUT when the refresh lacks its record', async () => {
    // #260: the client's PATCH carries the last known record too, so it is
    // not sent on a record that may be deleted.
    const doc = document();
    const item = doc.paths['/pets/{petId}']!;
    item.patch = item.put!;
    delete item.put;
    const second = provider([], (r) =>
      r.method === 'PATCH' ? response({ id: '1', name: 'Rex II' }) : undefined,
    );
    const b = restart(
      await restoredUpdate(undefined, doc),
      second.transport,
      {},
      doc,
    );
    await b.ready();
    await b.sync();
    await settle();
    expect(b.pendingWrites()).toMatchObject([
      {
        state: 'failed',
        missingRecord: 'unknown',
        lastError: expect.stringMatching(/not in the refreshed collection/),
      },
    ]);
    expect(second.requests).toEqual([]);
  });

  it('keeps the refresh miss count across a restart', async () => {
    const failing = (): ReturnType<typeof provider> =>
      provider([{ id: '1', name: 'Rex', tag: 'dog' }], (r) =>
        r.method === 'GET' ? response({ error: 'invented' }, 500) : undefined,
      );
    const storage = await restoredUpdate();
    const b = restart(storage, failing().transport);
    await b.ready();
    for (let i = 0; i < 2; i++)
      await expect(b.sync()).rejects.toThrow(/Read incomplete/);
    await settle();

    const third = failing();
    const c = restart(storage.crash(), third.transport);
    await c.ready();
    expect(c.pendingWrites()[0]).toMatchObject({ awaitingRefresh: true });
    await expect(c.sync()).rejects.toThrow(/Read incomplete/);
    expect(c.pendingWrites()[0]).toMatchObject({
      state: 'failed',
      lastError: expect.stringMatching(/Waiting for a complete refresh/),
    });
  });
});

/**
 * The ordering invariant: per record, every failed write is older (queued
 * earlier) than every queued one, as stored. A failed write newer than a
 * queued one is dropped silently when that queued write settles.
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

describe('durable outbox: fourth review on #312', () => {
  const rex = { id: '1', name: 'Rex', tag: 'dog', age: '3' };

  it('fails every restored update of a record the refresh lacks, and retries on its last known record', async () => {
    // S1: two offline updates, the first in flight at the stop.
    const storage = new CrashableStorage();
    const first = provider([rex], (r) =>
      r.method === 'GET' ? undefined : 'hang-before',
    );
    const a = restart(storage, first.transport);
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    await a.update('/pets', '1', { tag: 'wolf' });
    await vi.waitFor(() => expect(first.requests).toHaveLength(1));
    await settle();

    const crashed = storage.crash();
    const second = provider([]);
    const b = restart(crashed, second.transport);
    await b.ready();
    await b.sync();
    expectFailedOlder(crashed);
    expect(b.pendingWrites().map((w) => w.state)).toEqual(['failed', 'failed']);
    await settle();
    expect(second.requests).toEqual([]);

    second.pets.set('1', rex);
    await b.resolveWrite('/pets', '1', { action: 'retry' });
    await idle(b);
    expectFailedOlder(crashed);
    expect(JSON.parse(second.requests[0]?.body ?? '{}')).toEqual({
      ...rex,
      name: 'Rex II',
    });
    expect(second.pets.get('1')).toEqual({
      ...rex,
      name: 'Rex II',
      tag: 'wolf',
    });
  });

  it('retries a failed update on the last known record another write kept', async () => {
    // S2: a 400-failed update in front of a waiting one.
    const storage = new CrashableStorage();
    let puts = 0;
    const first = provider([rex], (r) => {
      if (r.method === 'GET') return undefined;
      puts += 1;
      return puts === 1 ? response({ error: 'invented' }, 400) : 'hang-before';
    });
    const a = restart(storage, first.transport, { retry: { maxAttempts: 1 } });
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(a.pendingWrites()[0]?.state).toBe('failed'));
    await a.update('/pets', '1', { tag: 'wolf' });
    await vi.waitFor(() => expect(puts).toBe(2));
    await settle();

    const crashed = storage.crash();
    const second = provider([]);
    const b = restart(crashed, second.transport);
    await b.ready();
    await b.sync();
    expectFailedOlder(crashed);
    expect(b.pendingWrites().map((w) => w.state)).toEqual(['failed', 'failed']);
    await settle();
    expect(second.requests).toEqual([]);

    second.pets.set('1', rex);
    await b.resolveWrite('/pets', '1', { action: 'retry' });
    await idle(b);
    expect(JSON.parse(second.requests[0]?.body ?? '{}')).toEqual({
      ...rex,
      name: 'Rex II',
    });
  });

  it('counts refresh misses only for a waiting update at the head of its queue', async () => {
    // S3: a delete, then an update of the same record, both restored.
    const storage = new CrashableStorage();
    const first = provider([rex], (r) =>
      r.method === 'GET' ? undefined : 'hang-before',
    );
    const a = restart(storage, first.transport);
    await a.sync();
    await a.remove('/pets', '1');
    await a.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(first.requests).toHaveLength(1));
    await settle();

    const crashed = storage.crash();
    let deletes = false;
    const second = provider([rex], (r) => {
      if (r.method === 'GET') return response({ error: 'invented' }, 500);
      if (r.method === 'DELETE' && !deletes) return response({}, 503);
      return undefined;
    });
    const b = restart(crashed, second.transport, {
      retry: { baseDelayMs: 5, maxDelayMs: 20 },
    });
    await b.ready();
    for (let i = 0; i < 4; i++) {
      await expect(b.sync()).rejects.toThrow(/Read incomplete/);
      expectFailedOlder(crashed);
    }
    expect(b.pendingWrites()).toMatchObject([
      { type: 'delete', state: 'pending' },
      { type: 'update', state: 'pending', awaitingRefresh: true },
    ]);
    deletes = true;
    await vi.waitFor(() =>
      expect(b.pendingWrites().map((w) => w.type)).toEqual(['update']),
    );
    expectFailedOlder(crashed);
    expect(b.pendingWrites()[0]).toMatchObject({ awaitingRefresh: true });
  });

  it('resets the miss count when a retry of the record stops the wait', async () => {
    const storage = new CrashableStorage();
    let puts = 0;
    const first = provider([rex], (r) => {
      if (r.method === 'GET') return undefined;
      puts += 1;
      return puts === 1 ? response({ error: 'invented' }, 400) : 'hang-before';
    });
    const a = restart(storage, first.transport, { retry: { maxAttempts: 1 } });
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(a.pendingWrites()[0]?.state).toBe('failed'));
    await a.update('/pets', '1', { tag: 'wolf' });
    await vi.waitFor(() => expect(puts).toBe(2));
    await settle();

    const failingGets = (): ReturnType<typeof provider> =>
      provider([rex], (r) =>
        r.method === 'GET'
          ? response({ error: 'invented' }, 500)
          : 'hang-before',
      );
    const crashed = storage.crash();
    const b = restart(crashed, failingGets().transport);
    await b.ready();
    for (let i = 0; i < 2; i++)
      await expect(b.sync()).rejects.toThrow(/Read incomplete/);
    await b.resolveWrite('/pets', '1', { action: 'retry' });
    await settle();
    expectFailedOlder(crashed);

    const c = restart(crashed.crash(), failingGets().transport);
    await c.ready();
    await expect(c.sync()).rejects.toThrow(/Read incomplete/);
    expect(
      c.pendingWrites().find((w) => w.type === 'update' && w.awaitingRefresh),
    ).toMatchObject({ state: 'pending' });
    expect(c.pendingWrites().every((w) => w.state === 'pending')).toBe(true);
  });
});

describe('durable outbox: fifth review on #312', () => {
  it('keeps the last known record current when a record reappears and vanishes again', async () => {
    const crashed = await restoredUpdate();
    for (const resolve of ['retry', 'update'] as const) {
      let listed: Pet[] = [];
      let found = false;
      const second = provider([], (r) =>
        r.method !== 'GET'
          ? 'hang-before'
          : found && r.url.pathname === '/api/pets/1'
            ? response({ id: '1', name: 'Rex', tag: 'wolf' })
            : response(listed),
      );
      const b = restart(crashed.crash(), second.transport);
      await b.ready();
      await b.sync();
      expect(b.pendingWrites()).toMatchObject([{ state: 'failed' }]);
      // Someone else changes the tag; the record is listed, then filtered out.
      listed = [{ id: '1', name: 'Rex', tag: 'wolf' }];
      await b.sync();
      listed = [];
      await b.sync();
      if (resolve === 'retry') {
        await b.resolveWrite('/pets', '1', { action: 'retry' });
        await vi.waitFor(() => expect(second.requests).toHaveLength(1));
        expect(JSON.parse(second.requests[0]?.body ?? '{}')).toEqual({
          id: '1',
          name: 'Rex II',
          tag: 'wolf',
        });
      } else {
        await b.update('/pets', '1', { age: '4' });
        // Still missing since the last refresh: it waits for the next one,
        // whose GET finds the record (#260).
        found = true;
        await b.sync();
        await vi.waitFor(() => expect(second.requests).toHaveLength(1));
        expect(JSON.parse(second.requests[0]?.body ?? '{}')).toEqual({
          id: '1',
          name: 'Rex',
          tag: 'wolf',
          age: '4',
        });
      }
    }
  });

  it('queues a retried write as the newest, keeping failed writes older', async () => {
    const storage = new CrashableStorage();
    let puts = 0;
    let failSecond!: () => void;
    const second = new Promise<void>((resolve) => (failSecond = resolve));
    const transport = provider([{ id: '1', name: 'Rex', tag: 'dog' }], (r) => {
      if (r.method === 'GET') return undefined;
      puts += 1;
      if (puts === 1) return response({ error: 'invented' }, 400);
      return 'hang-before';
    }).transport;
    const a = restart(
      storage,
      async (r) => {
        if (r.method !== 'GET' && puts === 1) {
          // The second PUT: answered 400 once the test says so.
          puts += 1;
          await second;
          return response({ error: 'invented' }, 400);
        }
        return transport(r);
      },
      { retry: { maxAttempts: 1 } },
    );
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(a.pendingWrites()[0]?.state).toBe('failed'));
    await a.update('/pets', '1', { tag: 'wolf' });
    await vi.waitFor(() => expect(puts).toBe(2));
    await a.resolveWrite('/pets', '1', { action: 'retry' });
    await settle();
    expectFailedOlder(storage);
    failSecond();
    await vi.waitFor(() =>
      expect(a.pendingWrites().map((w) => w.state)).toContain('failed'),
    );
    await settle();
    expectFailedOlder(storage);
  });
});

describe('durable outbox: sixth review on #312', () => {
  it('grows the outbox by the changes per queued update, not by the record', async () => {
    const big = { id: '1', name: 'Rex', notes: 'x'.repeat(10_000) };
    async function outboxSize(updates: number): Promise<number> {
      const storage = new CrashableStorage();
      const p = provider([big], (r) =>
        r.method === 'GET' ? undefined : 'hang-before',
      );
      const a = restart(storage, p.transport);
      await a.sync();
      for (let i = 0; i < updates; i++)
        await a.update('/pets', '1', { name: `Rex ${i}` });
      await vi.waitFor(() => expect(p.requests).toHaveLength(1));
      // A refresh with a remote change while they wait records the newest
      // confirmed copy on the waiting updates.
      p.pets.set('1', { ...big, age: '4' });
      await a.sync();
      await settle();
      return JSON.stringify(storage.data.get(OUTBOX)?.get('outbox')).length;
    }
    const one = await outboxSize(1);
    const twenty = await outboxSize(20);
    // 19 more small updates: a few hundred bytes each at most, not 10 KB.
    expect(twenty - one).toBeLessThan(19 * 400);
    expect(one).toBeLessThan(2 * 10_000 + 2_000);
  });

  it('stores the last known record once per record and restores it', async () => {
    const crashed = await restoredUpdate();
    const second = provider([], (r) =>
      r.method === 'GET' ? response([]) : 'hang-before',
    );
    const b = restart(crashed, second.transport);
    await b.ready();
    await b.sync();
    expect(b.pendingWrites()).toMatchObject([{ state: 'failed' }]);
    await settle();
    const stored = crashed.data.get(OUTBOX)?.get('outbox') as {
      records: { lastKnown?: Pet; failed: Record<string, unknown>[] }[];
    };
    expect(stored.records[0]?.lastKnown).toEqual({
      id: '1',
      name: 'Rex',
      tag: 'dog',
    });
    expect(stored.records[0]?.failed[0]).not.toHaveProperty('lastKnown');

    const third = provider();
    const c = restart(crashed.crash(), third.transport);
    await c.ready();
    await c.resolveWrite('/pets', '1', { action: 'retry' });
    await vi.waitFor(() => expect(third.requests).toHaveLength(1));
    expect(JSON.parse(third.requests[0]?.body ?? '{}')).toEqual({
      id: '1',
      name: 'Rex II',
      tag: 'dog',
    });
  });

  it('merges a partial update response over the record it updated', async () => {
    const sent: TransportRequest[] = [];
    const client = createApiClient(document(), {
      transport: async (r) => {
        if (r.method === 'GET')
          return response([{ id: '1', name: 'Rex', tag: 'dog' }]);
        sent.push(r);
        const body = JSON.parse(r.body ?? '{}') as Pet;
        // The provider answers with the changed field and the id only.
        return response({ id: '1', name: body['name'] });
      },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(await client.get('/pets', '1')).toEqual({
      id: '1',
      name: 'Rex II',
      tag: 'dog',
    });
    await client.update('/pets', '1', { name: 'Rex III' });
    await idle(client);
    expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({
      id: '1',
      name: 'Rex III',
      tag: 'dog',
    });
  });
});

describe('durable outbox: seventh review on #312', () => {
  it('keeps the edit when the update response leaves the changed field out', async () => {
    let remote: Pet[] = [{ id: '1', name: 'Rex', tag: 'dog' }];
    const sent: TransportRequest[] = [];
    const conflicts: WriteConflict[] = [];
    const client = createApiClient(document(), {
      onConflict: (c) => conflicts.push(c),
      transport: async (r) => {
        if (r.method === 'GET') return response(remote);
        sent.push(r);
        const body = JSON.parse(r.body ?? '{}') as Pet;
        remote = [body];
        // The provider answers with bookkeeping only.
        return response({ id: '1', updatedAt: `t${sent.length}` });
      },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(await client.get('/pets', '1')).toMatchObject({
      name: 'Rex II',
      tag: 'dog',
    });
    await client.update('/pets', '1', { tag: 'wolf' });
    await idle(client);
    expect(JSON.parse(sent[1]?.body ?? '{}')).toMatchObject({
      name: 'Rex II',
      tag: 'wolf',
    });
    await client.sync();
    expect(conflicts).toEqual([]);
    expect(await client.get('/pets', '1')).toMatchObject({
      name: 'Rex II',
      tag: 'wolf',
    });
  });

  it('does not report a false conflict for a queued update after a partial response', async () => {
    let remote: Pet[] = [{ id: '1', name: 'Rex', tag: 'dog' }];
    let answer!: () => void;
    const gate = new Promise<void>((resolve) => (answer = resolve));
    let puts = 0;
    const conflicts: WriteConflict[] = [];
    const client = createApiClient(document(), {
      onConflict: (c) => conflicts.push(c),
      transport: async (r) => {
        if (r.method === 'GET') return response(remote);
        puts += 1;
        // The second PUT waits, so a refresh runs while it is pending.
        if (puts === 2) await gate;
        const body = JSON.parse(r.body ?? '{}') as Pet;
        remote = [body];
        return response({ id: '1' });
      },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await client.update('/pets', '1', { name: 'Rex III' });
    await vi.waitFor(() => expect(puts).toBe(2));
    // The refresh shows the first edit applied: not a remote change.
    await client.sync();
    expect(conflicts).toEqual([]);
    answer();
    await idle(client);
    expect(await client.get('/pets', '1')).toMatchObject({ name: 'Rex III' });
  });
});

describe('durable outbox: failure classes (#260)', () => {
  const rex = { id: '1', name: 'Rex', tag: 'dog' };
  const milo = { id: '2', name: 'Milo', tag: 'cat' };
  type Stored = {
    authBlock?: unknown;
    records: {
      id: string;
      failed: Record<string, unknown>[];
      queue: Record<string, unknown>[];
    }[];
  };
  const stored = (storage: CrashableStorage): Stored =>
    storage.data.get(OUTBOX)?.get('outbox') as Stored;

  /** A client blocked by a 401 on an update of Rex, with a delete of Milo queued. */
  async function blockedStorage(): Promise<CrashableStorage> {
    const storage = new CrashableStorage();
    const first = provider([rex, milo], (r) =>
      r.method === 'GET' ? undefined : response({ message: 'expired' }, 401),
    );
    const a = restart(storage, first.transport);
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(a.authBlocked()).toBeDefined());
    await a.remove('/pets', '2');
    await settle();
    expect(first.requests).toHaveLength(1);
    return storage.crash();
  }

  it('keeps an auth block across a restart; writes resume only after authRenewed()', async () => {
    const crashed = await blockedStorage();
    expect(stored(crashed).authBlock).toMatchObject({ status: 401, id: '1' });
    const second = provider([rex, milo]);
    const blocks: unknown[] = [];
    const b = restart(crashed, second.transport, {
      onAuthBlocked: (block) => blocks.push(block),
    });
    await b.ready();
    expect(blocks).toEqual([b.authBlocked()]);
    expect(b.authBlocked()).toMatchObject({ status: 401, id: '1' });
    expect(
      b.pendingWrites().map(({ id, type, state, attempts, lastStatus }) => ({
        id,
        type,
        state,
        attempts,
        lastStatus,
      })),
    ).toEqual([
      {
        id: '1',
        type: 'update',
        state: 'blocked',
        attempts: 0,
        lastStatus: 401,
      },
      {
        id: '2',
        type: 'delete',
        state: 'pending',
        attempts: 0,
        lastStatus: undefined,
      },
    ]);
    // A blocked write is resent by authRenewed(), not by resolveWrite.
    await expect(
      b.resolveWrite('/pets', '1', { action: 'retry' }),
    ).rejects.toThrow(/authRenewed/);
    // Syncs while blocked send nothing and do not count refresh misses.
    for (let i = 0; i < 4; i += 1) await b.sync();
    await settle();
    expect(second.requests).toEqual([]);
    expect(b.pendingWrites()[0]?.state).toBe('blocked');

    await b.authRenewed();
    expect(stored(crashed).authBlock).toBeUndefined();
    // Those syncs read the collection, so the restored update is released
    // and is sent on the record they returned.
    await idle(b);
    expect(second.requests.map((r) => r.method).sort()).toEqual([
      'DELETE',
      'PUT',
    ]);
    expect(second.pets.get('1')).toEqual({ ...rex, name: 'Rex II' });
    expectFailedOlder(crashed);
  });

  it('keeps a blocked restored update waiting for a refresh after authRenewed()', async () => {
    const crashed = await blockedStorage();
    const second = provider([rex, milo]);
    const b = restart(crashed, second.transport);
    await b.authRenewed();
    await vi.waitFor(() =>
      expect(second.requests.map((r) => r.method)).toEqual(['DELETE']),
    );
    expect(b.pendingWrites()).toMatchObject([
      { id: '1', state: 'pending', awaitingRefresh: true },
    ]);
    second.pets.set('1', { ...rex, tag: 'wolf' });
    await b.sync();
    await idle(b);
    expect(second.pets.get('1')).toEqual({
      ...rex,
      name: 'Rex II',
      tag: 'wolf',
    });
  });

  it("drops a stored block when restored with onAuthFailure: 'retry'", async () => {
    const crashed = await blockedStorage();
    const second = provider([rex, milo]);
    const blocks: unknown[] = [];
    const b = restart(crashed, second.transport, {
      onAuthFailure: 'retry',
      onAuthBlocked: (block) => blocks.push(block),
    });
    await b.ready();
    expect(b.authBlocked()).toBeUndefined();
    expect(blocks).toEqual([]);
    expect(b.pendingWrites().map((w) => w.state)).toEqual([
      'pending',
      'pending',
    ]);
    expect(stored(crashed).authBlock).toBeUndefined();
    await b.sync();
    await idle(b);
    expect(second.pets.get('1')).toEqual({ ...rex, name: 'Rex II' });
    expect(second.pets.has('2')).toBe(false);
  });

  it('treats a stored blocked write without a stored block as pending, and a malformed block as a block', async () => {
    const crashed = await blockedStorage();
    const unblocked = crashed.crash();
    delete (unblocked.data.get(OUTBOX)?.get('outbox') as Stored).authBlock;
    const second = provider([rex, milo]);
    const b = restart(unblocked, second.transport);
    await b.ready();
    expect(b.authBlocked()).toBeUndefined();
    expect(b.pendingWrites().map((w) => w.state)).toEqual([
      'pending',
      'pending',
    ]);

    const malformed = crashed.crash();
    (malformed.data.get(OUTBOX)?.get('outbox') as Stored).authBlock = {
      status: 'soon',
    };
    const third = provider([rex, milo]);
    const c = restart(malformed, third.transport);
    await c.ready();
    expect(c.authBlocked()).toMatchObject({ status: 0 });
    expect(c.pendingWrites().map((w) => w.state)).toEqual([
      'blocked',
      'pending',
    ]);
    await settle();
    expect(third.requests).toEqual([]);
  });

  it('stores a permanent failure with its status, older than the writes queued behind it', async () => {
    const storage = new CrashableStorage();
    let refuse!: () => void;
    const gate = new Promise<void>((resolve) => (refuse = resolve));
    const first = provider([rex], (r) =>
      r.method === 'PUT' ? 'hang-before' : undefined,
    );
    let puts = 0;
    const transport: Transport = async (r) => {
      if (r.method === 'PUT' && ++puts === 1) {
        await gate;
        return response({ error: 'invented' }, 422);
      }
      return first.transport(r);
    };
    const a = restart(storage, transport);
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    await a.update('/pets', '1', { tag: 'wolf' });
    refuse();
    await vi.waitFor(() => expect(first.requests).toHaveLength(1));
    await settle();
    expectFailedOlder(storage);
    const crashed = storage.crash();
    const record = stored(crashed).records[0];
    expect(record?.failed).toMatchObject([
      { type: 'update', state: 'failed', attempts: 1, lastStatus: 422 },
    ]);
    expect(record?.queue).toMatchObject([
      { type: 'update', state: 'pending', sending: true },
    ]);

    const b = restart(crashed, provider([rex]).transport);
    await b.ready();
    expect(b.pendingWrites()[0]).toMatchObject({
      state: 'failed',
      lastStatus: 422,
      lastError: expect.stringMatching(/status 422: \{"error":"invented"\}$/),
    });
  });

  it('drops the status of an earlier attempt when the process stopped during a later one', async () => {
    const storage = new CrashableStorage();
    let puts = 0;
    const first = provider([rex], (r) => {
      if (r.method !== 'PUT') return undefined;
      puts += 1;
      return puts === 1 ? response({}, 503) : 'hang-before';
    });
    const a = restart(storage, first.transport, { retry: { baseDelayMs: 1 } });
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(first.requests).toHaveLength(2));
    expect(a.pendingWrites()[0]).toMatchObject({ lastStatus: 503 });
    await settle();

    const b = restart(storage.crash(), provider([rex]).transport);
    await b.ready();
    expect(b.pendingWrites()[0]).toMatchObject({
      attempts: 2,
      lastError: expect.stringMatching(/process stopped/),
    });
    expect(b.pendingWrites()[0]).not.toHaveProperty('lastStatus');
  });

  it('does not send a write whose in-flight mark was being stored when the block began', async () => {
    const storage = new CrashableStorage();
    let refuseRex!: () => void;
    const rexGate = new Promise<void>((resolve) => (refuseRex = resolve));
    let renewed = false;
    const first = provider([rex, milo]);
    const transport: Transport = async (r) => {
      if (r.method === 'GET' || renewed) return first.transport(r);
      first.requests.push(r);
      await rexGate;
      return response({}, 401);
    };
    const a = restart(storage, transport);
    await a.sync();
    await a.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(first.requests).toHaveLength(1));
    // Milo's in-flight mark is held in storage until Rex has been refused.
    let releaseStore!: () => void;
    const storeGate = new Promise<void>((resolve) => (releaseStore = resolve));
    storage.afterPut = (resource, id): void => {
      if (resource === '/pets' && id === '2') {
        storage.afterPut = undefined;
        storage.outboxGate = storeGate;
      }
    };
    await a.update('/pets', '2', { name: 'Milo II' });
    refuseRex();
    await vi.waitFor(() => expect(a.authBlocked()).toBeDefined());
    storage.outboxGate = undefined;
    releaseStore();
    await settle();
    expect(first.requests.map((r) => r.url.pathname)).toEqual(['/api/pets/1']);
    expect(a.pendingWrites()).toMatchObject([
      { id: '1', state: 'blocked', attempts: 0 },
      { id: '2', state: 'pending', attempts: 0 },
    ]);
    const outbox = storage.data.get(OUTBOX)?.get('outbox') as {
      records: { id: string; queue: { sending?: true }[] }[];
    };
    expect(
      outbox.records.find((r) => r.id === '2')?.queue[0],
    ).not.toHaveProperty('sending');

    renewed = true;
    await a.authRenewed();
    await idle(a);
    expect(first.pets.get('1')).toMatchObject({ name: 'Rex II' });
    expect(first.pets.get('2')).toMatchObject({ name: 'Milo II' });
  });

  it('settles a resent delete the server had already applied (404)', async () => {
    const storage = new CrashableStorage();
    const first = provider([rex, milo], (r) =>
      r.method === 'DELETE' ? 'hang' : undefined,
    );
    const a = restart(storage, first.transport);
    await a.sync();
    await a.remove('/pets', '1');
    await vi.waitFor(() => expect(first.requests).toHaveLength(1));
    await settle();

    const crashed = storage.crash();
    const second = provider([milo], (r) =>
      r.method === 'DELETE' ? response({ error: 'not found' }, 404) : undefined,
    );
    const b = restart(crashed, second.transport);
    await b.ready();
    await idle(b);
    expect(second.requests).toHaveLength(1);
    expect(await b.get('/pets', '1')).toBeUndefined();
  });
});
