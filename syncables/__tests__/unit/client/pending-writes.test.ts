// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  prepareDocument,
  type OpenApiDocument,
  type Transport,
  type TransportResponse,
  type WriteConflict,
} from '../../../src/browser.js';
import { petsDocument } from '../../fixtures/pets.js';

// Deterministic fake transports with invented data for #260 gaps 1 and 2.

const response = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: JSON.stringify(value),
});

const document = (): OpenApiDocument =>
  prepareDocument({
    ...petsDocument,
    servers: [{ url: 'https://provider.example/api' }],
  });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** No pending writes, and the storage rebuild after the last one has run. */
async function idle(client: { pendingWrites(): unknown[] }): Promise<void> {
  await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
  await settle(5);
}

describe('refresh while an update is pending (#260 gap 1)', () => {
  it('keeps the unconfirmed local edit visible over a newer remote snapshot', async () => {
    const put = deferred<TransportResponse>();
    let records = [{ id: '1', name: 'old', other: 0 }];
    const client = createApiClient(document(), {
      transport: async (r) =>
        r.method === 'GET' ? response(records) : put.promise,
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'local edit' });
    records = [{ id: '1', name: 'old', other: 1 }];
    await client.sync();
    expect(await client.get('/pets', '1')).toEqual({
      id: '1',
      name: 'local edit',
      other: 1,
    });
    expect(client.pendingWrites()).toMatchObject([
      { id: '1', type: 'update', state: 'pending' },
    ]);
    expect(client.pendingWrites()[0]).not.toHaveProperty('conflicts');
    put.resolve(response({ id: '1', name: 'local edit', other: 1 }));
    await idle(client);
  });
});

describe('same-field conflicts under a pending update', () => {
  it('keeps the local value visible and reports the conflict once', async () => {
    const put = deferred<TransportResponse>();
    let records = [{ id: '1', name: 'old', other: 0 }];
    const conflicts: WriteConflict[] = [];
    const sent: string[] = [];
    const client = createApiClient(document(), {
      onConflict: (c) => conflicts.push(c),
      transport: async (r) => {
        if (r.method === 'GET') return response(records);
        sent.push(r.body ?? '');
        return put.promise;
      },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'local' });
    records = [{ id: '1', name: 'remote', other: 1 }];
    await client.sync();
    expect(await client.get('/pets', '1')).toEqual({
      id: '1',
      name: 'local',
      other: 1,
    });
    const expected = {
      resource: '/pets',
      id: '1',
      field: 'name',
      base: 'old',
      remote: 'remote',
      local: 'local',
    };
    expect(conflicts).toEqual([expected]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'pending', conflicts: [expected] },
    ]);
    // A refresh with no new value for the field reports nothing new.
    records = [{ id: '1', name: 'remote', other: 2 }];
    await client.sync();
    expect(conflicts).toHaveLength(1);
    expect(client.pendingWrites()[0]?.conflicts).toHaveLength(1);
    put.resolve(response({ id: '1', name: 'local', other: 2 }));
    await idle(client);
    // The PUT left before the refreshes; it carries the local value.
    expect(JSON.parse(sent[0] ?? '{}')).toEqual({
      id: '1',
      name: 'local',
      other: 0,
    });
  });

  it('clears a conflict when the remote value converges on the local one', async () => {
    const put = deferred<TransportResponse>();
    let records = [{ id: '1', name: 'old' }];
    const client = createApiClient(document(), {
      transport: async (r) =>
        r.method === 'GET' ? response(records) : put.promise,
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'local' });
    records = [{ id: '1', name: 'remote' }];
    await client.sync();
    expect(client.pendingWrites()[0]?.conflicts).toHaveLength(1);
    records = [{ id: '1', name: 'local' }];
    await client.sync();
    expect(client.pendingWrites()[0]).not.toHaveProperty('conflicts');
    put.resolve(response({ id: '1', name: 'local' }));
    await idle(client);
  });
});

interface SeenRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * A provider that creates a record on every POST, with no deduplication.
 * `fail(n)` shapes the n-th POST: 'lost' creates the record and then throws,
 * a non-2xx response is returned without creating, a 2xx response is
 * returned after creating.
 */
function provider(
  fail: (post: number) => TransportResponse | 'lost' | undefined,
): {
  server: Record<string, unknown>[];
  requests: SeenRequest[];
  transport: Transport;
} {
  const server: Record<string, unknown>[] = [];
  const requests: SeenRequest[] = [];
  let posts = 0;
  const transport: Transport = async (r) => {
    requests.push({
      method: r.method,
      path: r.url.pathname,
      headers: r.headers,
      ...(r.body ? { body: r.body } : {}),
    });
    if (r.method === 'GET') return response(server);
    if (r.method === 'PUT') {
      const body = JSON.parse(r.body ?? '{}');
      server[server.findIndex((x) => x['id'] === body.id)] = body;
      return response(body);
    }
    posts += 1;
    const failure = fail(posts);
    if (failure && failure !== 'lost' && failure.status >= 300) return failure;
    const created = { ...JSON.parse(r.body ?? '{}'), id: `s${posts}` };
    server.push(created);
    if (failure === 'lost') throw new Error('connection reset after send');
    return failure ?? response(created, 201);
  };
  return { server, requests, transport };
}

const posts = (requests: SeenRequest[]): number =>
  requests.filter((r) => r.method === 'POST').length;

describe('ambiguous creates (#260 gap 2)', () => {
  it('reproduction: a lost POST response is not resent', async () => {
    const { server, requests, transport } = provider((n) =>
      n === 1 ? 'lost' : undefined,
    );
    const client = createApiClient(document(), {
      transport,
      retry: { baseDelayMs: 1 },
    });
    const created = await client.create('/pets', { name: 'Milo' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('uncertain'),
    );
    await settle();
    expect(posts(requests)).toBe(1);
    expect(server).toHaveLength(1);
    expect(client.pendingWrites()).toEqual([
      {
        resource: '/pets',
        id: created['id'],
        type: 'create',
        state: 'uncertain',
        attempts: 1,
        lastError: 'connection reset after send',
      },
    ]);
    expect(await client.get('/pets', String(created['id']))).toEqual(created);
  });

  it('confirm: reconciles against a refresh and remaps queued follow-up writes', async () => {
    const { server, requests, transport } = provider((n) =>
      n === 1 ? 'lost' : undefined,
    );
    const client = createApiClient(document(), { transport });
    const created = await client.create('/pets', { name: 'Milo' });
    const localId = String(created['id']);
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('uncertain'),
    );
    // Queued behind the uncertain create, not sent yet.
    await client.update('/pets', localId, { tag: 'cat' });
    await settle();
    expect(requests.map((r) => r.method)).toEqual(['POST']);
    await client.sync();
    // The refresh shows the server's copy next to the local one.
    const found = (await client.list('/pets')).find(
      (p) => p['id'] !== localId && p['name'] === 'Milo',
    );
    expect(found).toMatchObject({ id: 's1' });
    await client.resolveWrite('/pets', localId, {
      action: 'confirm',
      id: String(found?.['id']),
    });
    await idle(client);
    expect(posts(requests)).toBe(1);
    expect(requests.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/api/pets/s1',
    });
    expect(await client.get('/pets', localId)).toBeUndefined();
    expect(await client.get('/pets', 's1')).toEqual({
      id: 's1',
      name: 'Milo',
      tag: 'cat',
    });
    expect(server).toEqual([{ id: 's1', name: 'Milo', tag: 'cat' }]);
  });

  it('confirm without a refresh keeps the local data under the server id', async () => {
    const { requests, transport } = provider((n) =>
      n === 1 ? 'lost' : undefined,
    );
    const client = createApiClient(document(), { transport });
    const created = await client.create('/pets', { name: 'Milo' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('uncertain'),
    );
    await client.resolveWrite('/pets', String(created['id']), {
      action: 'confirm',
      id: 's1',
    });
    await vi.waitFor(async () =>
      expect(await client.list('/pets')).toEqual([{ name: 'Milo', id: 's1' }]),
    );
    expect(client.pendingWrites()).toEqual([]);
    expect(posts(requests)).toBe(1);
  });

  it('discard drops the create and the writes queued behind it', async () => {
    const { requests, transport } = provider((n) =>
      n === 1 ? 'lost' : undefined,
    );
    const client = createApiClient(document(), { transport });
    const created = await client.create('/pets', { name: 'Milo' });
    const localId = String(created['id']);
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('uncertain'),
    );
    await client.update('/pets', localId, { tag: 'cat' });
    await client.resolveWrite('/pets', localId, { action: 'discard' });
    expect(client.pendingWrites()).toEqual([]);
    expect(await client.get('/pets', localId)).toBeUndefined();
    await settle();
    expect(requests.map((r) => r.method)).toEqual(['POST']);
  });

  it('retry resends when the caller decides to', async () => {
    const { server, transport } = provider((n) =>
      n === 1 ? 'lost' : undefined,
    );
    const client = createApiClient(document(), { transport });
    const created = await client.create('/pets', { name: 'Milo' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('uncertain'),
    );
    await client.resolveWrite('/pets', String(created['id']), {
      action: 'retry',
    });
    await idle(client);
    // This provider does not deduplicate: the duplicate the caller accepted.
    expect(server).toHaveLength(2);
    expect(await client.get('/pets', 's2')).toMatchObject({ name: 'Milo' });
  });

  it.each([
    ['a 502', response({}, 502)],
    ['a 500', response({}, 500)],
    ['a 2xx without a record identity', response({ ok: true }, 200)],
    ['a 2xx that is not JSON', { status: 201, headers: {}, body: 'Created' }],
  ])('treats %s as uncertain', async (_label, failure) => {
    const { requests, transport } = provider((n) =>
      n === 1 ? failure : undefined,
    );
    const client = createApiClient(document(), {
      transport,
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Milo' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('uncertain'),
    );
    await settle();
    expect(posts(requests)).toBe(1);
  });

  it.each([
    ['a 503', response({}, 503)],
    ['a 429', response({}, 429)],
    ['a 400', response({}, 400)],
  ])('keeps retrying %s automatically', async (_label, failure) => {
    const { server, requests, transport } = provider((n) =>
      n === 1 ? failure : undefined,
    );
    const client = createApiClient(document(), {
      transport,
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Milo' });
    await idle(client);
    expect(posts(requests)).toBe(2);
    expect(server).toHaveLength(1);
  });

  it('still retries an update after a lost response', async () => {
    let puts = 0;
    const client = createApiClient(document(), {
      retry: { baseDelayMs: 1 },
      transport: async (r) => {
        if (r.method === 'GET') return response([{ id: '1', name: 'old' }]);
        if (++puts === 1) throw new Error('connection reset after send');
        return response(JSON.parse(r.body ?? '{}'));
      },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'new' });
    await idle(client);
    expect(puts).toBe(2);
  });

  it('retries with the same key when the document declares Idempotency-Key', async () => {
    const doc = document();
    doc.paths['/pets']!.post!.parameters = [
      { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
    ];
    const { requests, transport } = provider((n) =>
      n === 1 ? 'lost' : undefined,
    );
    const client = createApiClient(doc, {
      transport,
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Milo' });
    await idle(client);
    const keys = requests
      .filter((r) => r.method === 'POST')
      .map((r) => r.headers['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('accepts a configured header name, and false turns detection off', async () => {
    const configured = provider((n) => (n === 1 ? 'lost' : undefined));
    const client = createApiClient(document(), {
      transport: configured.transport,
      idempotencyKeyHeader: 'X-Request-Id',
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Milo' });
    await idle(client);
    expect(configured.requests[0]?.headers['X-Request-Id']).toBeTruthy();
    expect(configured.requests[1]?.headers['X-Request-Id']).toBe(
      configured.requests[0]?.headers['X-Request-Id'],
    );

    const doc = document();
    doc.paths['/pets']!.post!.parameters = [
      { name: 'idempotency-key', in: 'header' },
    ];
    const disabled = provider((n) => (n === 1 ? 'lost' : undefined));
    const off = createApiClient(doc, {
      transport: disabled.transport,
      idempotencyKeyHeader: false,
    });
    await off.create('/pets', { name: 'Milo' });
    await vi.waitFor(() =>
      expect(off.pendingWrites()[0]?.state).toBe('uncertain'),
    );
    expect(disabled.requests[0]?.headers).not.toHaveProperty('idempotency-key');
  });
});

describe('resolveWrite on failed and pending writes', () => {
  it('retries or discards a write that exhausted retry.maxAttempts', async () => {
    let fail = true;
    let puts = 0;
    const client = createApiClient(document(), {
      retry: { baseDelayMs: 1, maxAttempts: 2 },
      transport: async (r) => {
        if (r.method === 'GET') return response([{ id: '1', name: 'old' }]);
        puts += 1;
        return fail ? response({}, 400) : response(JSON.parse(r.body ?? '{}'));
      },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'rejected' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('failed'),
    );
    expect(puts).toBe(2);
    await expect(
      client.resolveWrite('/pets', '1', { action: 'confirm', id: '1' }),
    ).rejects.toThrow('Only an uncertain create');
    await client.resolveWrite('/pets', '1', { action: 'discard' });
    expect(client.pendingWrites()).toEqual([]);
    expect(await client.get('/pets', '1')).toEqual({ id: '1', name: 'old' });

    await client.update('/pets', '1', { name: 'accepted' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('failed'),
    );
    fail = false;
    await client.resolveWrite('/pets', '1', { action: 'retry' });
    await idle(client);
    expect(await client.get('/pets', '1')).toEqual({
      id: '1',
      name: 'accepted',
    });
  });

  it('refuses to resolve a write that is still pending', async () => {
    const client = createApiClient(document(), {
      transport: () => new Promise<TransportResponse>(() => {}),
    });
    const created = await client.create('/pets', { name: 'Milo' });
    await expect(
      client.resolveWrite('/pets', String(created['id']), {
        action: 'discard',
      }),
    ).rejects.toThrow('has no uncertain or failed write');
  });
});
