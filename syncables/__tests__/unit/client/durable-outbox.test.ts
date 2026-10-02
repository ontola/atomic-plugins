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
    if (this.failOutbox && resource === OUTBOX)
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

    const second = provider([{ id: '1', name: 'Rex', tag: 'dog' }]);
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
    // The update was replayed on the stored confirmed record, not on nothing.
    const put = second.requests.find((r) => r.url.pathname === '/api/pets/1');
    expect(JSON.parse(put?.body ?? '{}')).toEqual({
      id: '1',
      name: 'Rex II',
      tag: 'dog',
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
