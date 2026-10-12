// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  mergePatch,
  prepareDocument,
  type ApiClient,
  type MissingRecord,
  type OpenApiDocument,
  type ParameterObject,
  type Transport,
  type TransportRequest,
  type TransportResponse,
  type WriteConflict,
} from '../../../src/browser.js';
import { petsDocument } from '../../fixtures/pets.js';

// Write Preconditions 0.1.0-draft (`x-write-precondition`) in the client:
// the reads and headers before a send (§4.2-§4.4), the write's own 404/410
// and conflict answers, and a send whose outcome is unknown, resolved by a
// read before anything is sent again (§4.5). The pure functions are
// covered by preconditions.test.ts. Transports and data are invented.

const response = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): TransportResponse => ({
  status,
  headers,
  body: value === undefined ? '' : JSON.stringify(value),
});

type Pet = Record<string, unknown>;

function headerOf(r: TransportRequest, name: string): string | undefined {
  for (const [key, value] of Object.entries(r.headers ?? {}))
    if (key.toLowerCase() === name.toLowerCase()) return value;
  return undefined;
}

/**
 * The pets fixture as a CRUD Causality document, with `put`, `delete` and
 * `post` declaring the given `x-write-precondition`s, and the pets
 * collection the given `x-completeness`.
 */
function document(
  declared: {
    put?: unknown;
    patch?: unknown;
    delete?: unknown;
    post?: unknown;
  } = {},
  completeness?: Record<string, string>,
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
              ...(completeness ? { 'x-completeness': completeness } : {}),
            },
          },
        },
      },
    },
  });
  const item = doc.paths['/pets/{petId}']!;
  if (declared.patch !== undefined) {
    // A JSON Merge Patch update in place of the PUT.
    item.patch = {
      ...structuredClone(item.put!),
      requestBody: {
        content: { 'application/merge-patch+json': { schema: {} } },
      },
      'x-crud': {
        action: 'update',
        mode: 'patch',
        patchFormat: 'jsonMergePatch',
        resource: 'pet',
      },
      'x-write-precondition': declared.patch,
    };
    delete item.put;
  }
  if (declared.put !== undefined)
    item.put!['x-write-precondition'] = declared.put;
  if (declared.delete !== undefined)
    item.delete!['x-write-precondition'] = declared.delete;
  if (declared.post !== undefined)
    doc.paths['/pets']!.post!['x-write-precondition'] = declared.post;
  return doc;
}

/**
 * A fake provider. Each pet carries `version`, which a PUT bumps. `etags`
 * sends it as an `ETag` header on item GETs. A write with `If-Match`
 * answers 412 unless it names the current version. `script` gives the
 * status of the next writes (sent before anything is applied);
 * `applyThenFail` applies the next write and answers it 502.
 */
function provider(initial: Pet[]): {
  pets: Map<string, Pet>;
  etags: boolean;
  script: number[];
  applyThenFail: boolean;
  itemStatus: number | undefined;
  afterWrite: (() => void) | undefined;
  headers: Record<string, string>[];
  log: string[];
  bodies: unknown[];
  transport: Transport;
} {
  const fake = {
    pets: new Map(initial.map((p) => [String(p['id']), structuredClone(p)])),
    etags: false,
    script: [] as number[],
    applyThenFail: false,
    itemStatus: undefined as number | undefined,
    afterWrite: undefined as (() => void) | undefined,
    headers: [] as Record<string, string>[],
    log: [] as string[],
    bodies: [] as unknown[],
    transport: (async (r: TransportRequest) => {
      const id = decodeURIComponent(r.url.pathname.split('/')[3] ?? '');
      const ifMatch = headerOf(r, 'if-match');
      fake.log.push(
        `${r.method} ${id || '/pets'}${ifMatch ? ` if-match ${ifMatch}` : ''}`,
      );
      if (r.method === 'GET' && !id) return response([...fake.pets.values()]);
      if (r.method === 'GET') {
        if (fake.itemStatus) return response({ error: 'x' }, fake.itemStatus);
        const pet = fake.pets.get(id);
        if (!pet) return response({ error: 'not found' }, 404);
        return response(
          pet,
          200,
          fake.etags ? { etag: String(pet['version']) } : {},
        );
      }
      const body: unknown = r.body ? JSON.parse(r.body) : undefined;
      fake.bodies.push(body);
      fake.headers.push({ ...r.headers });
      const scripted = fake.script.shift();
      if (scripted !== undefined) {
        fake.afterWrite?.();
        return response({ error: 'x' }, scripted);
      }
      if (r.method === 'POST') {
        const created = { ...(body as Pet), id: 'new', version: 'v1' };
        fake.pets.set('new', created);
        return response(created, 201);
      }
      const current = fake.pets.get(id);
      if (!current) return response({ error: 'not found' }, 404);
      if (ifMatch !== undefined && ifMatch !== current['version'])
        return response({ error: 'precondition failed' }, 412);
      let answer: TransportResponse;
      if (r.method === 'DELETE') {
        fake.pets.delete(id);
        answer = response(undefined, 204);
      } else {
        const n = Number(String(current['version']).slice(1)) + 1;
        const updated =
          r.method === 'PATCH'
            ? {
                ...(mergePatch(current, body) as Pet),
                id,
                version: `v${n}`,
              }
            : { ...(body as Pet), id, version: `v${n}` };
        fake.pets.set(id, updated);
        answer = response(updated);
      }
      if (fake.applyThenFail) {
        fake.applyThenFail = false;
        return response({ error: 'bad gateway' }, 502);
      }
      return answer;
    }) as Transport,
  };
  return fake;
}

const rex: Pet = { id: '1', name: 'Rex', tag: 'dog', version: 'v1' };

/** A synced client over a fake provider holding Rex. */
async function synced(
  doc: OpenApiDocument,
  extra: {
    onMissingRecord?: (r: MissingRecord) => void;
    onConflict?: (c: WriteConflict) => void;
    retryMs?: number;
    pets?: Pet[];
  } = {},
): Promise<{ client: ApiClient; fake: ReturnType<typeof provider> }> {
  const fake = provider(extra.pets ?? [rex]);
  const client = createApiClient(doc, {
    storage: new InMemoryStorageAdapter(),
    transport: fake.transport,
    retry: { baseDelayMs: extra.retryMs ?? 60_000 },
    ...(extra.onMissingRecord
      ? { onMissingRecord: extra.onMissingRecord }
      : {}),
    ...(extra.onConflict ? { onConflict: extra.onConflict } : {}),
  });
  await client.sync();
  fake.log.length = 0;
  return { client, fake };
}

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function idle(client: ApiClient): Promise<void> {
  await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
  await settle(5);
}

/** Waits until the only pending write has stopped (failed). */
async function stopped(client: ApiClient): Promise<void> {
  await vi.waitFor(() =>
    expect(client.pendingWrites()).toMatchObject([{ state: 'failed' }]),
  );
}

const IF_MATCH_BODY = {
  kind: 'ifMatch',
  version: { in: 'body', name: 'version' },
};

describe('write preconditions: ifMatch (§4.3)', () => {
  it('sends the version last read as If-Match, without a read first', async () => {
    const { client, fake } = await synced(document({ put: IF_MATCH_BODY }));
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(fake.log).toEqual(['PUT 1 if-match v1']);
    expect(fake.pets.get('1')).toMatchObject({ name: 'Rex II', version: 'v2' });
  });

  it('stops the write on a conflict status, and does not send it again', async () => {
    const { client, fake } = await synced(document({ put: IF_MATCH_BODY }), {
      retryMs: 1,
    });
    fake.pets.set('1', { ...rex, name: 'Rex (theirs)', version: 'v7' });
    await client.update('/pets', '1', { name: 'Rex II' });
    await stopped(client);
    await settle();
    expect(fake.log).toEqual(['PUT 1 if-match v1']);
    expect(client.pendingWrites()).toMatchObject([
      { type: 'update', state: 'failed', precondition: 'conflict' },
    ]);
    expect(client.pendingWrites()[0]?.lastError).toContain('412');
    expect(fake.pets.get('1')?.['name']).toBe('Rex (theirs)');
  });

  it('honours a declared conflictStatus and header', async () => {
    const doc = document({
      put: { ...IF_MATCH_BODY, header: 'X-If-Version', conflictStatus: [409] },
    });
    const { client, fake } = await synced(doc, { retryMs: 1 });
    fake.script.push(409);
    await client.update('/pets', '1', { name: 'Rex II' });
    await stopped(client);
    expect(fake.headers).toEqual([
      expect.objectContaining({ 'X-If-Version': 'v1' }),
    ]);
    expect(client.pendingWrites()).toMatchObject([
      { precondition: 'conflict' },
    ]);
    expect(fake.bodies).toHaveLength(1);
  });

  it('reads the object first when the version is a response header', async () => {
    const { client, fake } = await synced(
      document({
        put: { kind: 'ifMatch', version: { in: 'header', name: 'ETag' } },
      }),
    );
    fake.etags = true;
    fake.pets.set('1', { ...rex, version: 'v3' });
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(fake.log).toEqual(['GET 1', 'PUT 1 if-match v3']);
  });
});

describe('write preconditions: refuseWhen (§4.4)', () => {
  it('does not send a write the object as last read refuses', async () => {
    const doc = document({
      put: {
        kind: 'none',
        refuseWhen: [
          { field: 'archived', values: [true], description: 'Archived' },
        ],
      },
    });
    const { client, fake } = await synced(doc, {
      pets: [{ ...rex, archived: true }],
    });
    await client.update('/pets', '1', { name: 'Rex II' });
    await stopped(client);
    expect(fake.log).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', precondition: 'refused' },
    ]);
    expect(client.pendingWrites()[0]?.lastError).toContain('Archived');
  });

  it('sends one the object does not refuse', async () => {
    const doc = document({
      put: {
        kind: 'none',
        refuseWhen: [{ field: 'archived', values: [true] }],
      },
    });
    const { client, fake } = await synced(doc);
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(fake.log).toEqual(['PUT 1']);
  });
});

describe('write preconditions: readVerify (§4.2)', () => {
  it('reads first, and stops an update whose written field changed', async () => {
    const conflicts: WriteConflict[] = [];
    const { client, fake } = await synced(
      document({ put: { kind: 'readVerify' } }),
      { onConflict: (c) => conflicts.push(c) },
    );
    fake.pets.set('1', { ...rex, name: 'Rex (theirs)' });
    await client.update('/pets', '1', { name: 'Rex II' });
    await stopped(client);
    expect(fake.log).toEqual(['GET 1']);
    expect(client.pendingWrites()).toMatchObject([
      {
        precondition: 'conflict',
        conflicts: [
          {
            field: 'name',
            base: 'Rex',
            remote: 'Rex (theirs)',
            local: 'Rex II',
          },
        ],
      },
    ]);
    expect(conflicts).toHaveLength(1);
  });

  it('sends the full record built on the read, keeping a field changed elsewhere', async () => {
    const { client, fake } = await synced(
      document({ put: { kind: 'readVerify' } }),
    );
    fake.pets.set('1', { ...rex, tag: 'wolf' });
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(fake.log).toEqual(['GET 1', 'PUT 1']);
    expect(fake.bodies).toEqual([
      expect.objectContaining({ name: 'Rex II', tag: 'wolf' }),
    ]);
  });

  it('compares every field held before a delete', async () => {
    const { client, fake } = await synced(
      document({ delete: { kind: 'readVerify' } }),
    );
    fake.pets.set('1', { ...rex, tag: 'wolf' });
    await client.remove('/pets', '1');
    await stopped(client);
    expect(fake.log).toEqual(['GET 1']);
    expect(client.pendingWrites()).toMatchObject([
      { type: 'delete', precondition: 'conflict' },
    ]);
    expect(fake.pets.has('1')).toBe(true);
  });
});

describe('write preconditions: unknown outcomes (§4.5)', () => {
  const NOT_IDEMPOTENT = { ...IF_MATCH_BODY, idempotent: false };

  it('reads before sending again, and settles a write that was applied', async () => {
    const { client, fake } = await synced(document({ put: NOT_IDEMPOTENT }), {
      retryMs: 1,
    });
    fake.applyThenFail = true;
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(fake.log).toEqual(['PUT 1 if-match v1', 'GET 1']);
    expect(await client.get('/pets', '1')).toMatchObject({
      name: 'Rex II',
      version: 'v2',
    });
  });

  it('sends again after a read shows the write was not applied', async () => {
    const { client, fake } = await synced(document({ put: NOT_IDEMPOTENT }), {
      retryMs: 1,
    });
    fake.script.push(502);
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(fake.log).toEqual([
      'PUT 1 if-match v1',
      'GET 1',
      'PUT 1 if-match v1',
    ]);
    expect(fake.pets.get('1')?.['name']).toBe('Rex II');
  });

  it('stops when the read shows another change', async () => {
    const { client, fake } = await synced(document({ put: NOT_IDEMPOTENT }), {
      retryMs: 1,
    });
    fake.script.push(502);
    // Someone else's edit lands between the failed PUT and the read.
    fake.afterWrite = (): void => {
      fake.pets.set('1', { ...rex, name: 'Rex (theirs)', version: 'v5' });
    };
    await client.update('/pets', '1', { name: 'Rex II' });
    await stopped(client);
    expect(fake.log).toEqual(['PUT 1 if-match v1', 'GET 1']);
    expect(client.pendingWrites()).toMatchObject([
      { precondition: 'conflict' },
    ]);
  });

  it('resends an idempotent PUT without a read', async () => {
    const { client, fake } = await synced(document({ put: IF_MATCH_BODY }), {
      retryMs: 1,
    });
    fake.script.push(502);
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(fake.log).toEqual(['PUT 1 if-match v1', 'PUT 1 if-match v1']);
  });

  it('resolves a write in flight at a restart by a read', async () => {
    const storage = new InMemoryStorageAdapter();
    const doc = document({ put: NOT_IDEMPOTENT });
    const fake = provider([rex]);
    let hang = true;
    const client = createApiClient(doc, {
      storage,
      transport: (async (r: TransportRequest) => {
        if (hang && r.method === 'PUT') {
          await fake.transport(r); // applied, but the answer never arrives
          return new Promise<TransportResponse>(() => undefined);
        }
        return fake.transport(r);
      }) as Transport,
      retry: { baseDelayMs: 1 },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(fake.bodies).toHaveLength(1));
    hang = false;
    fake.log.length = 0;
    const again = createApiClient(doc, {
      storage,
      transport: fake.transport,
      retry: { baseDelayMs: 1 },
    });
    await again.ready();
    expect(again.pendingWrites()).toMatchObject([
      { type: 'update', precondition: 'resolving' },
    ]);
    await again.sync();
    await idle(again);
    expect(fake.log).not.toContain('PUT 1 if-match v1');
    expect(fake.bodies).toHaveLength(1);
    expect(await again.get('/pets', '1')).toMatchObject({ name: 'Rex II' });
  });
});

describe("write preconditions: the write's own 404 or 410 (§4.5)", () => {
  const NONE = { kind: 'none' };

  it('keeps a deleted record unavailable when nothing confirms the deletion', async () => {
    const reports: MissingRecord[] = [];
    const { client, fake } = await synced(document({ delete: NONE }), {
      onMissingRecord: (r) => reports.push(r),
    });
    fake.pets.delete('1');
    await client.remove('/pets', '1');
    await idle(client);
    expect(reports).toMatchObject([
      { id: '1', evidence: 'unavailable', source: 'write', status: 404 },
    ]);
  });

  it.each([
    ['notFound: deleted, a 404', { notFound: 'deleted' }, 404],
    ['absent: deleted, a 404', { absent: 'deleted' }, 404],
    ['gone: deleted, a 410', { gone: 'deleted' }, 410],
  ])('ends a delete as applied under %s', async (_label, declared, status) => {
    const reports: MissingRecord[] = [];
    const { client, fake } = await synced(
      document({ delete: NONE }, declared),
      {
        onMissingRecord: (r) => reports.push(r),
      },
    );
    fake.script.push(status);
    await client.remove('/pets', '1');
    await idle(client);
    expect(fake.log).toEqual(['DELETE 1']);
    expect(reports.filter((r) => r.source === 'write')).toEqual([]);
    expect(await client.get('/pets', '1')).toBeUndefined();
  });

  it('lets gone, not notFound, decide a 410', async () => {
    const reports: MissingRecord[] = [];
    const { client, fake } = await synced(
      document({ delete: NONE }, { notFound: 'deleted', gone: 'unavailable' }),
      { onMissingRecord: (r) => reports.push(r) },
    );
    fake.script.push(410);
    await client.remove('/pets', '1');
    await idle(client);
    expect(reports).toMatchObject([
      { id: '1', evidence: 'unavailable', source: 'write', status: 410 },
    ]);
  });

  it('stops an update whose object is gone, and does not send it again', async () => {
    const { client, fake } = await synced(document({ put: NONE }), {
      retryMs: 1,
    });
    fake.pets.delete('1');
    await client.update('/pets', '1', { name: 'Rex II' });
    await stopped(client);
    await settle();
    expect(fake.log).toEqual(['PUT 1']);
    expect(client.pendingWrites()).toMatchObject([{ precondition: 'gone' }]);
  });
});

describe('write preconditions: source objects (§4.4.1)', () => {
  /** Clockify-like: a time entry cannot be created in a locked workspace. */
  function workspaceDocument(): OpenApiDocument {
    const param = (name: string): ParameterObject => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
    const ok = { '200': { description: 'OK' } };
    return prepareDocument({
      openapi: '3.0.3',
      info: { title: 'Time entries', version: '1.0.0' },
      servers: [{ url: 'https://time.example' }],
      paths: {
        '/workspaces': { get: { responses: ok } },
        '/workspaces/{workspaceId}': {
          get: { parameters: [param('workspaceId')], responses: ok },
        },
        '/workspaces/{workspaceId}/entries': {
          get: { parameters: [param('workspaceId')], responses: ok },
          post: {
            parameters: [param('workspaceId')],
            requestBody: { content: { 'application/json': { schema: {} } } },
            responses: { '201': { description: 'Created' } },
            'x-write-precondition': {
              kind: 'none',
              refuseWhen: [
                {
                  field: 'locked',
                  values: [true],
                  source: { resource: 'workspace' },
                  description: 'The workspace is locked',
                },
              ],
            },
          },
        },
        '/workspaces/{workspaceId}/entries/{entryId}': {
          get: {
            parameters: [param('workspaceId'), param('entryId')],
            responses: ok,
          },
        },
      },
      components: {
        crudResources: {
          workspace: {
            identity: {
              urlTemplate: '/workspaces/{workspaceId}',
              bindings: { workspaceId: { field: 'id' } },
            },
            collections: { workspaces: { urlTemplate: '/workspaces' } },
          },
          entry: {
            identity: {
              urlTemplate: '/workspaces/{workspaceId}/entries/{entryId}',
              bindings: { entryId: { field: 'id' } },
            },
            collections: {
              entries: { urlTemplate: '/workspaces/{workspaceId}/entries' },
            },
          },
        },
      },
    } as OpenApiDocument);
  }

  function workspaceProvider(): {
    workspace: { status: number; locked: boolean };
    posts: unknown[];
    transport: Transport;
  } {
    const fake = {
      workspace: { status: 200, locked: false },
      posts: [] as unknown[],
      transport: (async (r: TransportRequest) => {
        const path = r.url.pathname;
        if (path === '/workspaces') return response([{ id: 'W1' }]);
        if (path === '/workspaces/W1')
          return fake.workspace.status === 200
            ? response({ id: 'W1', locked: fake.workspace.locked })
            : response({ error: 'x' }, fake.workspace.status);
        if (path === '/workspaces/W1/entries' && r.method === 'GET')
          return response([]);
        if (path === '/workspaces/W1/entries' && r.method === 'POST') {
          const body = JSON.parse(r.body ?? '{}') as Pet;
          fake.posts.push(body);
          return response({ ...body, id: 'E1' }, 201);
        }
        return response({ error: 'not found' }, 404);
      }) as Transport,
    };
    return fake;
  }

  it('does not send a create the source object refuses', async () => {
    const fake = workspaceProvider();
    fake.workspace.locked = true;
    const client = createApiClient(workspaceDocument(), {
      transport: fake.transport,
      retry: { baseDelayMs: 60_000 },
    });
    await client.create('entries', { hours: '1.5' }, { workspaceId: 'W1' });
    await stopped(client);
    expect(fake.posts).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      { type: 'create', precondition: 'refused' },
    ]);
    expect(client.pendingWrites()[0]?.lastError).toContain(
      'The workspace is locked',
    );
  });

  it('holds a create while the source object cannot be read, and sends it once it can', async () => {
    const fake = workspaceProvider();
    fake.workspace.status = 503;
    const client = createApiClient(workspaceDocument(), {
      transport: fake.transport,
      retry: { baseDelayMs: 5 },
    });
    await client.create('entries', { hours: '1.5' }, { workspaceId: 'W1' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()).toMatchObject([
        { state: 'pending', precondition: 'source-unknown' },
      ]),
    );
    expect(fake.posts).toEqual([]);
    fake.workspace.status = 200;
    await client.sync();
    await idle(client);
    expect(fake.posts).toEqual([expect.objectContaining({ hours: '1.5' })]);
  });
});

describe('write preconditions: declarations', () => {
  it('leaves a write under kind none without refusals unchanged', async () => {
    const { client, fake } = await synced(document({ put: { kind: 'none' } }));
    await client.update('/pets', '1', { name: 'Rex II' });
    await idle(client);
    expect(fake.log).toEqual(['PUT 1']);
  });

  it('refuses to queue a write whose declaration this client cannot use', async () => {
    const { client, fake } = await synced(
      document({
        put: { kind: 'compareAndSwap' },
        delete: { kind: 'ifMatch' },
      }),
    );
    await expect(
      client.update('/pets', '1', { name: 'Rex II' }),
    ).rejects.toThrow(/compareAndSwap.*not sent unconditionally/);
    await expect(client.remove('/pets', '1')).rejects.toThrow(
      /no usable version/,
    );
    expect(client.pendingWrites()).toEqual([]);
    expect(fake.log).toEqual([]);
  });

  it('drops an unknown stored precondition state on restore', async () => {
    const storage = new InMemoryStorageAdapter();
    const doc = document({ put: { kind: 'none' } });
    const fake = provider([rex]);
    fake.script.push(500, 500, 500);
    const client = createApiClient(doc, {
      storage,
      transport: fake.transport,
      retry: { baseDelayMs: 60_000 },
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(fake.bodies).toHaveLength(1));
    await settle();
    const outbox = (await storage.get('syncables:outbox', 'outbox')) as {
      records: { queue: Record<string, unknown>[] }[];
    };
    outbox.records[0]!.queue[0]!['precondition'] = 'pondering';
    await storage.put('syncables:outbox', 'outbox', outbox);
    const again = createApiClient(doc, {
      storage,
      transport: fake.transport,
    });
    await again.ready();
    expect(again.pendingWrites()).toHaveLength(1);
    expect(again.pendingWrites()[0]).not.toHaveProperty('precondition');
  });
});

describe('write preconditions: review cases', () => {
  it('fails a write whose object version cannot be sent as a header', async () => {
    const { client, fake } = await synced(document({ put: IF_MATCH_BODY }), {
      pets: [{ ...rex, version: { major: 1 } }],
    });
    await client.update('/pets', '1', { name: 'Rex II' });
    await stopped(client);
    expect(fake.log).toEqual([]);
    expect(client.pendingWrites()[0]?.lastError).toContain(
      'neither a string nor a number',
    );
    expect(client.pendingWrites()[0]).not.toHaveProperty('precondition');
  });

  it('fails a bodiless DELETE closed on a when it cannot evaluate', async () => {
    const doc = document({
      delete: {
        kind: 'none',
        refuseWhen: [
          {
            field: 'locked',
            values: [true],
            when: { field: 'force', values: [false, null] },
          },
        ],
      },
    });
    const { client, fake } = await synced(doc, {
      pets: [{ ...rex, locked: true }],
    });
    await client.remove('/pets', '1');
    await stopped(client);
    expect(fake.log).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      { type: 'delete', precondition: 'refused' },
    ]);
  });

  it('settles an unknown merge-patch update by the values after the patch', async () => {
    const { client, fake } = await synced(
      document({ patch: { ...IF_MATCH_BODY, idempotent: false } }),
      { retryMs: 1, pets: [{ ...rex, meta: { a: '1', b: '2' } }] },
    );
    fake.applyThenFail = true;
    await client.update('/pets', '1', { meta: { a: null } });
    await idle(client);
    // The read shows meta as the patch leaves it ({ b: '2' }): applied.
    expect(fake.log).toEqual(['PATCH 1 if-match v1', 'GET 1']);
    expect(fake.bodies).toEqual([{ meta: { a: null } }]);
  });

  it("refuses a declaration whose source is not one of the document's resources", async () => {
    const { client } = await synced(
      document({
        post: {
          kind: 'none',
          refuseWhen: [
            { source: { resource: 'owner' }, field: 'locked', values: [true] },
          ],
        },
      }),
    );
    await expect(client.create('/pets', { name: 'Kit' })).rejects.toThrow(
      /not a crudResources key/,
    );
  });
});
