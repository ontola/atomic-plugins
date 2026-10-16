import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  apiKeyAuth,
  bearerAuth,
  createApiClient,
  InMemoryStorageAdapter,
  prepareDocument,
  readCollections,
  readPlatform,
  type OpenApiDocument,
  type RawReadResponse,
  type Transport,
  type TransportResponse,
  type Authenticate,
} from '../../../src/browser.js';
import {
  createApiClient as createNodeClient,
  credentialsFromEnv,
} from '../../../src/index.js';
import { petsDocument } from '../../fixtures/pets.js';
import {
  calendar,
  notion,
  notionCrudOverlay,
  notionPaginationOverlay,
} from '../../fixtures/read.js';

const response = (
  value: unknown,
  headers: Record<string, string> = {},
  status = 200,
): TransportResponse => ({
  status,
  headers,
  body: JSON.stringify(value),
});
const document = (): OpenApiDocument =>
  prepareDocument({
    ...petsDocument,
    servers: [{ url: 'https://provider.example/api' }],
  });

async function settled(client: { pendingWrites(): unknown[] }): Promise<void> {
  await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('shared transport and collection reads', () => {
  it('prunes reused storage only after a complete collection read', async () => {
    const storage = new InMemoryStorageAdapter();
    await storage.put('/pets', 'removed', { id: 'removed' });
    await storage.put('/pets', 'kept', { id: 'kept', name: 'old' });
    let complete = false;
    const client = createApiClient(document(), {
      storage,
      transport: async () =>
        complete
          ? response([{ id: 'kept', name: 'fresh' }])
          : response({}, {}, 500),
    });
    await expect(client.sync()).rejects.toThrow('Read incomplete');
    expect(await client.get('/pets', 'removed')).toEqual({ id: 'removed' });
    complete = true;
    await client.sync();
    expect(await client.list('/pets')).toEqual([{ id: 'kept', name: 'fresh' }]);

    const restarted = createApiClient(document(), {
      storage,
      transport: async () => response([]),
    });
    await restarted.sync();
    expect(await restarted.list('/pets')).toEqual([]);
  });

  it('honours shared read budgets without replacing an existing collection', async () => {
    const doc = document();
    doc.components!.paginationSchemes = {
      links: {
        type: 'nextLink',
        response: { headers: { Link: { role: 'nextLink' } } },
      },
    };
    doc.paths['/pets']!.get!['x-pagination'] = [{ scheme: 'links' }];
    let more = false;
    const client = createApiClient(doc, {
      limits: { maxRequests: 1 },
      transport: async () =>
        response(
          [{ id: more ? '2' : '1' }],
          more
            ? { Link: '<https://provider.example/api/pets?page=2>; rel="next"' }
            : {},
        ),
    });
    await client.sync();
    more = true;
    await expect(client.sync()).rejects.toThrow('Read exceeds 1 requests');
    expect(await client.list('/pets')).toEqual([{ id: '1' }]);
  });

  it('uses the reader rate-limit policy and captures each attempt', async () => {
    // The wait is measured from the clock when the client sleeps, so a
    // millisecond between receiving the 429 and sleeping makes it 1999
    // (the retry is still not early). A frozen clock makes it exact.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const saved: RawReadResponse[] = [];
    const sleep = vi.fn(async () => {});
    let attempt = 0;
    const client = createApiClient(document(), {
      sleep,
      transport: async () =>
        ++attempt === 1
          ? response({}, { 'Retry-After': '2' }, 429)
          : response([{ id: '1' }]),
      storeResponse: (r) => {
        saved.push(r);
      },
    });
    await client.sync();
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(saved.map((r) => r.status)).toEqual([429, 200]);
    expect(await client.get('/pets', '1')).toEqual({ id: '1' });
  });

  it('uses a custom transport for reads and every write without global fetch', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('global fetch must not run');
    });
    const transport = vi.fn<Transport>(async (request) => {
      if (request.method === 'GET') return response([{ id: '1', name: 'old' }]);
      if (request.method === 'DELETE')
        return { status: 204, headers: {}, body: '' };
      const body = JSON.parse(request.body ?? '{}');
      return response(
        request.method === 'POST' ? { ...body, id: 'server-id' } : body,
      );
    });
    const client = createApiClient(document(), { transport });
    await client.sync();
    await client.update('/pets', '1', { name: 'new' });
    await settled(client);
    const created = await client.create('/pets', { name: 'another' });
    await settled(client);
    expect(await client.get('/pets', String(created['id']))).toBeUndefined();
    expect(await client.get('/pets', 'server-id')).toMatchObject({
      name: 'another',
    });
    await client.remove('/pets', 'server-id');
    await settled(client);
    expect(transport.mock.calls.map(([r]) => r.method)).toEqual([
      'GET',
      'PUT',
      'POST',
      'DELETE',
    ]);
    expect(transport.mock.calls.map(([r]) => r.url.pathname)).toEqual([
      '/api/pets',
      '/api/pets/1',
      '/api/pets',
      '/api/pets/server-id',
    ]);
  });

  it('shares metadata traversal and isolates identical item IDs in sibling collections', async () => {
    const transport = vi.fn<Transport>(async ({ url }) => {
      if (url.pathname.endsWith('/calendarList'))
        return response({ items: [{ id: 'a' }, { id: 'b' }] });
      return response({
        items: [
          { id: 'shared', summary: url.pathname.includes('/a/') ? 'A' : 'B' },
        ],
      });
    });
    const client = createApiClient(calendar, { transport });
    await client.sync();
    expect(client.resources).toEqual(['calendarList', 'events']);
    expect(
      await client.get('events', 'shared', { calendarId: 'a' }),
    ).toMatchObject({ summary: 'A' });
    expect(
      await client.get('events', 'shared', { calendarId: 'b' }),
    ).toMatchObject({ summary: 'B' });
    await expect(client.list('events')).rejects.toThrow(
      'Missing value for calendarId',
    );
    await expect(
      client.update(
        'events',
        'shared',
        { summary: 'edit' },
        { calendarId: 'a' },
      ),
    ).rejects.toThrow('no update operation');
    const read = await readPlatform(calendar, {
      platform: 'calendar',
      constants: {},
      transport,
    });
    expect(
      read.records
        .filter((r) => r.resource === 'event')
        .map((r) => [r.namespace, r.values['summary']]),
    ).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ]);
  });

  it('binds nested writes and keeps sibling data unchanged', async () => {
    const doc = structuredClone(calendar);
    doc.paths['/calendars/{calendarId}/events/{eventId}'] = {
      patch: { responses: { '200': {} } },
      delete: { responses: { '204': {} } },
    };
    const transport = vi.fn<Transport>(async (r) => {
      if (r.method === 'PATCH') return response(JSON.parse(r.body ?? '{}'));
      if (r.method === 'DELETE') return { status: 204, headers: {}, body: '' };
      if (r.url.pathname.endsWith('/calendarList'))
        return response({ items: [{ id: 'a/b' }, { id: 'b' }] });
      return response({ items: [{ id: 'same', summary: 'old' }] });
    });
    const client = createApiClient(doc, { transport });
    await client.sync();
    await client.update(
      'events',
      'same',
      { summary: 'changed' },
      { calendarId: 'a/b' },
    );
    await settled(client);
    expect(
      transport.mock.calls.find(([r]) => r.method === 'PATCH')?.[0].url
        .pathname,
    ).toBe('/v3/calendars/a%2Fb/events/same');
    expect(
      await client.get('events', 'same', { calendarId: 'b' }),
    ).toMatchObject({ summary: 'old' });
    await client.remove('events', 'same', { calendarId: 'a/b' });
    await settled(client);
    expect(
      await client.get('events', 'same', { calendarId: 'a/b' }),
    ).toBeUndefined();
  });

  it('uses POST-body pagination for both sync and standalone pagination', async () => {
    const doc = prepareDocument(notion, [
      notionPaginationOverlay,
      notionCrudOverlay,
    ]);
    const transport = vi.fn<Transport>(async (r) => {
      const body = JSON.parse(r.body ?? '{}');
      if (r.url.pathname.endsWith('/search'))
        return response({ results: [{ id: 'db' }], next_cursor: null });
      return response({
        results: [
          {
            id: body.start_cursor ? 'row-2' : 'row-1',
            properties: { unknown: 123 },
          },
        ],
        next_cursor: body.start_cursor ? null : 'next',
      });
    });
    const client = createApiClient(doc, { transport });
    await client.sync();
    expect(await client.list('rows', { database_id: 'db' })).toHaveLength(2);
    expect(
      (await client.list('rows', { database_id: 'db' }))[0],
    ).toHaveProperty('properties.unknown', 123);
    await expect(client.create('databases', { name: 'new' })).rejects.toThrow(
      'no create operation',
    );
    const rows = await client.paginate('/v1/databases/{database_id}/query', {
      method: 'POST',
      pathParams: { database_id: 'db' },
    });
    expect(rows.map((r) => r['id'])).toEqual(['row-1', 'row-2']);
    expect(transport.mock.calls.every(([r]) => r.method === 'POST')).toBe(true);
    const calls = transport.mock.calls.length;
    await expect(
      client.paginate('/v1/databases/{database_id}/query', { method: 'POST' }),
    ).rejects.toThrow('Missing value for database_id');
    expect(transport.mock.calls).toHaveLength(calls);
  });

  it('supports explicit CRUD create paths separate from POST-list endpoints', async () => {
    const doc = prepareDocument(notion, [
      notionPaginationOverlay,
      notionCrudOverlay,
    ]);
    doc.paths['/v1/pages'] = {
      post: { 'x-crud': { resource: 'page', action: 'create' }, responses: {} },
    };
    const transport = vi.fn<Transport>(async (r) =>
      response({ ...JSON.parse(r.body ?? '{}'), id: 'created' }, {}, 201),
    );
    const client = createApiClient(doc, { transport });
    await client.create('rows', { properties: {} }, { database_id: 'db' });
    await settled(client);
    expect(transport.mock.calls[0]?.[0].url.pathname).toBe('/v1/pages');
    expect(
      await client.get('rows', 'created', { database_id: 'db' }),
    ).toHaveProperty('properties');
  });

  it('reads more than the legacy 50-page cap and never prunes on an interrupted traversal', async () => {
    const doc = document();
    doc.components!.paginationSchemes = {
      next: {
        type: 'pageToken',
        request: { queryParameters: { cursor: { role: 'cursor' } } },
        response: { bodyFields: { next: { role: 'nextCursor' } } },
      },
    };
    doc.paths['/pets']!.get!['x-pagination'] = [{ scheme: 'next' }];
    let fail = false;
    const transport: Transport = async ({ url }) => {
      const n = Number(url.searchParams.get('cursor') ?? '1');
      if (fail && n === 2) return response({}, {}, 503);
      return response({
        items: [{ id: String(n), name: `record ${n}` }],
        next: n < 55 ? String(n + 1) : null,
      });
    };
    const client = createApiClient(doc, { transport });
    await client.sync();
    expect(await client.list('/pets')).toHaveLength(55);
    fail = true;
    await expect(client.sync()).rejects.toThrow('503');
    expect(await client.list('/pets')).toHaveLength(55);
    const partial = await readCollections(doc, { transport, legacy: {} });
    expect(partial.collections[0]).toMatchObject({
      complete: false,
      items: [{ id: '1' }],
    });
  });

  it('rejects repeated pages and cross-origin links for the local replica too', async () => {
    const doc = document();
    doc.components!.paginationSchemes = {
      links: {
        type: 'nextLink',
        response: { headers: { Link: { role: 'nextLink' } } },
      },
    };
    doc.paths['/pets']!.get!['x-pagination'] = [{ scheme: 'links' }];
    for (const link of [
      'https://other.example/pets',
      'https://provider.example/api/pets',
    ]) {
      const transport = vi.fn<Transport>(async () =>
        response([{ id: '1' }], { Link: `<${link}>; rel="next"` }),
      );
      const client = createApiClient(doc, { transport });
      await expect(client.sync()).rejects.toThrow(/Pagination (left|repeated)/);
      expect(await client.list('/pets')).toEqual([]);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it('does not silently treat an unrecognizable response as an empty collection', async () => {
    let malformed = false;
    const client = createApiClient(document(), {
      transport: async () =>
        response(malformed ? { unexpected: true } : [{ id: '1' }]),
    });
    await client.sync();
    malformed = true;
    await expect(client.sync()).rejects.toThrow(
      'Could not locate the items array',
    );
    expect(await client.get('/pets', '1')).toEqual({ id: '1' });
  });
});

describe('provider observations and pending local intent', () => {
  it('hands remapped writes to an existing worker without resending its in-flight write', async () => {
    const create = deferred<TransportResponse>();
    const update = deferred<TransportResponse>();
    let puts = 0;
    const transport = vi.fn<Transport>(async (request) => {
      if (request.method === 'POST') return create.promise;
      puts += 1;
      return puts === 1
        ? update.promise
        : response(JSON.parse(request.body ?? '{}'));
    });
    const client = createApiClient(document(), { transport });
    const created = await client.create('/pets', { name: 'initial' });
    await client.update('/pets', String(created['id']), { name: 'follow-up' });
    await client.update('/pets', 'resolved', { tag: 'direct edit' });
    create.resolve(response({ id: 'resolved', name: 'initial' }));
    await vi.waitFor(async () =>
      expect(await client.get('/pets', String(created['id']))).toBeUndefined(),
    );
    update.resolve(response({ id: 'resolved', tag: 'direct edit' }));
    await settled(client);
    expect(puts).toBe(2);
    expect(await client.get('/pets', 'resolved')).toEqual({
      id: 'resolved',
      name: 'follow-up',
      tag: 'direct edit',
    });
  });

  it('preserves pending updates, creates and deletes through refresh', async () => {
    const gate = deferred<TransportResponse>();
    let records = [
      { id: '1', name: 'old', extra: 0 },
      { id: '2', name: 'remove', extra: 0 },
    ];
    const client = createApiClient(document(), {
      transport: async (r) =>
        r.method === 'GET' ? response(records) : gate.promise,
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'local' });
    await client.remove('/pets', '2');
    const created = await client.create('/pets', { name: 'pending create' });
    records = [
      { id: '1', name: 'old', extra: 1 },
      { id: '2', name: 'remove', extra: 1 },
    ];
    await client.sync();
    expect(await client.get('/pets', '1')).toMatchObject({
      name: 'local',
      extra: 1,
    });
    expect(await client.get('/pets', '2')).toBeUndefined();
    expect(await client.get('/pets', String(created['id']))).toMatchObject({
      name: 'pending create',
    });
    gate.resolve(response({ id: 'server-id', name: 'confirmed' }));
    await settled(client);
  });

  it('an older update response cannot hide a newer pending edit', async () => {
    const first = deferred<TransportResponse>();
    const second = deferred<TransportResponse>();
    let writes = 0;
    const client = createApiClient(document(), {
      transport: async (r) =>
        r.method === 'GET'
          ? response([{ id: '1', name: 'old' }])
          : ++writes === 1
            ? first.promise
            : second.promise,
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'first' });
    await client.update('/pets', '1', { name: 'second' });
    first.resolve(response({ id: '1', name: 'first', extra: 1 }));
    await vi.waitFor(() => expect(writes).toBe(2));
    expect(await client.get('/pets', '1')).toEqual({
      id: '1',
      name: 'second',
      extra: 1,
    });
    second.resolve(response({ id: '1', name: 'second', extra: 1 }));
    await settled(client);
  });

  it('a create acknowledgement remaps later edits while preserving their local visibility', async () => {
    const first = deferred<TransportResponse>();
    const second = deferred<TransportResponse>();
    const transport = vi.fn<Transport>(async (r) =>
      r.method === 'POST' ? first.promise : second.promise,
    );
    const client = createApiClient(document(), { transport });
    const created = await client.create('/pets', { name: 'first' });
    await client.update('/pets', String(created['id']), { name: 'second' });
    first.resolve(response({ id: 'resolved', name: 'first' }));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    expect(await client.get('/pets', 'resolved')).toMatchObject({
      name: 'second',
    });
    expect(await client.get('/pets', String(created['id']))).toBeUndefined();
    expect(transport.mock.calls[1]?.[0].url.pathname).toBe(
      '/api/pets/resolved',
    );
    second.resolve(response({ id: 'resolved', name: 'second' }));
    await settled(client);
  });

  it('rejects a stale read that arrives after a write acknowledgement', async () => {
    const read = deferred<TransportResponse>();
    let reads = 0;
    const client = createApiClient(document(), {
      transport: async (r) =>
        r.method === 'GET'
          ? ++reads === 1
            ? response([{ id: '1', name: 'old' }])
            : read.promise
          : response({ id: '1', name: 'confirmed' }),
    });
    await client.sync();
    const refreshing = client.sync();
    await client.update('/pets', '1', { name: 'confirmed' });
    await settled(client);
    read.resolve(response([{ id: '1', name: 'old' }]));
    await refreshing;
    expect(await client.get('/pets', '1')).toMatchObject({ name: 'confirmed' });
  });
});

describe('optional raw-response preservation', () => {
  it('stores original response text before interpretation without authentication material', async () => {
    const saved: RawReadResponse[] = [];
    const raw = ' [ { "id": "1", "name": "Rex", "undeclared": "kept" } ]\n';
    const transport = vi.fn<Transport>(async () => ({
      status: 200,
      headers: {
        ETag: 'v1',
        'Set-Cookie': 'private',
        Authorization: 'private',
      },
      body: raw,
    }));
    const client = createApiClient(document(), {
      transport,
      credentials: { apiKey: 'invented-key' },
      authenticate: apiKeyAuth('key', 'query'),
      storeResponse: async (r) => {
        saved.push(r);
      },
    });
    await client.sync();
    expect(saved[0]).toMatchObject({
      body: raw,
      url: 'https://provider.example/api/pets',
      headers: { ETag: 'v1' },
    });
    expect(saved[0]?.url).not.toContain('invented-key');
    expect(transport.mock.calls[0]?.[0].url.searchParams.get('key')).toBe(
      'invented-key',
    );
    expect(await client.get('/pets', '1')).toHaveProperty('undeclared', 'kept');
  });

  it('captures real 304 responses rather than the cached body used for assembly', async () => {
    const saved: RawReadResponse[] = [];
    const transport: Transport = async (r) =>
      r.headers['if-none-match']
        ? { status: 304, headers: {}, body: '' }
        : response([{ id: '1' }], { ETag: 'v1' });
    const client = createApiClient(document(), {
      transport,
      storeResponse: (r) => {
        saved.push(r);
      },
    });
    await client.sync();
    await client.sync();
    expect(saved.map((r) => [r.status, r.body])).toEqual([
      [200, '[{"id":"1"}]'],
      [304, ''],
    ]);
    expect(await client.get('/pets', '1')).toEqual({ id: '1' });
  });

  it('awaits response storage and never replaces a collection when storage fails', async () => {
    let fail = false;
    const client = createApiClient(document(), {
      transport: async () => response([{ id: fail ? '2' : '1' }]),
      storeResponse: async () => {
        if (fail) throw new Error('response store unavailable');
      },
    });
    await client.sync();
    fail = true;
    await expect(client.sync()).rejects.toThrow('response store unavailable');
    expect(await client.list('/pets')).toEqual([{ id: '1' }]);
  });

  it('provides the same hook on readPlatform before timestamp conversion', async () => {
    const doc = prepareDocument({
      ...petsDocument,
      servers: [{ url: 'https://provider.example' }],
      components: {
        ...petsDocument.components,
        crudResources: {
          pet: {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                updated: { type: 'string', format: 'date-time' },
              },
            },
            identity: {
              urlTemplate: '/pets/{id}',
              bindings: { id: { field: 'id' } },
            },
            collections: { pets: { urlTemplate: '/pets' } },
          },
        },
      },
    });
    const saved: RawReadResponse[] = [];
    const body = [{ id: '1', updated: '2026-10-02T00:00:00Z' }];
    const result = await readPlatform(doc, {
      platform: 'pets',
      constants: {},
      transport: async () => response(body),
      storeResponse: (r) => {
        saved.push(r);
      },
    });
    expect(saved[0]?.body).toBe(JSON.stringify(body));
    expect(result.records[0]?.values['updated']).toBe(
      Date.parse(body[0]!.updated),
    );
  });
});

describe('direct authentication configuration', () => {
  it('passes constructor OAuth application credentials to a custom authentication adapter', async () => {
    const authenticate = vi.fn<Authenticate>((request, credentials) => ({
      ...request,
      headers: {
        ...request.headers,
        authorization: `${credentials.clientId}:${credentials.clientSecret}`,
      },
    }));
    const transport = vi.fn<Transport>(async () => response([]));
    const client = createApiClient(document(), {
      transport,
      credentials: { clientId: 'invented-id', clientSecret: 'invented-secret' },
      authenticate,
    });
    await client.sync();
    expect(authenticate.mock.calls[0]?.[1]).toEqual({
      clientId: 'invented-id',
      clientSecret: 'invented-secret',
    });
    expect(transport.mock.calls[0]?.[0].headers['authorization']).toBe(
      'invented-id:invented-secret',
    );
  });

  it('loads Node credentials from environment with explicit fields taking precedence', async () => {
    vi.stubEnv('SYNCABLES_OAUTH_CLIENT_ID', 'environment-id');
    vi.stubEnv('SYNCABLES_OAUTH_CLIENT_SECRET', 'environment-secret');
    const authenticate = vi.fn<Authenticate>((request) => request);
    const client = createNodeClient(document(), {
      transport: async () => response([]),
      credentials: { clientId: 'explicit-id' },
      authenticate,
    });
    await client.sync();
    expect(authenticate.mock.calls[0]?.[1]).toEqual({
      clientId: 'explicit-id',
      clientSecret: 'environment-secret',
    });
    vi.stubEnv('SECOND_API_KEY', 'second-key');
    expect(credentialsFromEnv({}, 'SECOND_')).toEqual({ apiKey: 'second-key' });
  });

  it('supports direct fetch authentication and lets a Node caller disable environment loading', async () => {
    vi.stubEnv('SYNCABLES_API_KEY', 'ignored');
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('[]'),
    );
    const client = createNodeClient(document(), {
      fetch,
      credentialPrefix: false,
      credentials: { accessToken: 'invented-token' },
      authenticate: bearerAuth,
    });
    await client.sync();
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer invented-token',
    });
  });

  it('does not read process.env in the browser entry, and refuses ambiguous transport configuration', async () => {
    vi.stubEnv('SYNCABLES_API_KEY', 'must-not-load');
    await createApiClient(document(), {
      transport: async () => response([]),
    }).sync();
    expect(() =>
      createApiClient(document(), {
        transport: async () => response([]),
        fetch: globalThis.fetch,
      }),
    ).toThrow('Choose transport or fetch');
    expect(() =>
      createApiClient(document(), { credentials: { clientSecret: 'secret' } }),
    ).toThrow('require an authenticate adapter');
  });
});
